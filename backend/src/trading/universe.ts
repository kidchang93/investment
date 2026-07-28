/**
 * 자동매매 후보 종목 고르기.
 *
 * 전략에 넘기기 전에 "애초에 살 수 없는 것"을 여기서 다 걸러낸다.
 * 전략이 살 수 없는 종목을 고르면 매 회차 보류 기록만 쌓이고 아무 일도 일어나지 않는다.
 *
 * 거르는 기준:
 * 1. 국내 주식·ETF·ETN만 (지수·선물·야간 프록시는 주문 자체가 안 된다)
 * 2. 현금으로 1주라도 살 수 있는 가격
 * 3. 리스크 룰의 허용·차단 목록
 *
 * 2번이 특히 중요하다. 예수금 5만원으로는 삼성전자(1주 약 25만원)를 살 수 없다.
 * 값을 모르고 고르면 후보 전부가 "1주도 못 삼"으로 끝난다.
 */

import type { Instrument, Quote } from '@invest/shared';
import { KRX_SESSION_MINUTES } from '@invest/shared';

import { getKisAccount } from '../config.js';
import { getCategoryInstruments } from '../db/instruments.js';
import { getRiskRules } from '../db/riskRules.js';
import { getInstrumentQuote } from '../kis/rest.js';
import { DEFAULT_COSTS } from './backtest.js';

/*
 * 후보를 뽑아올 카테고리. 국내 주문 가능한 것만 둔다.
 * ETF를 함께 넣는 이유는 값이 싸서다 — 예수금이 적으면 개별주는 1주도 못 사는
 * 경우가 많은데 ETF는 1~4만원대가 많아 실제로 매수 가능한 후보가 남는다.
 */
const SOURCE_CATEGORIES = ['kr-all', 'kr-etf'];

/** 가격을 확인하려고 KIS를 때리는 종목 수 상한. 호출 제한을 태우지 않는다. */
const MAX_PRICE_LOOKUPS = 24;

/*
 * 유동성 문턱 — 하루 거래대금이 이만큼은 돼야 후보로 본다.
 *
 * 백테스트는 원하는 값에 원하는 만큼 체결된다고 가정한다. 실제로는 하루 174주
 * 거래되는 ETF에 시장가를 넣으면 호가를 몇 칸 밀고 들어간다. 실측에서 매수
 * 가능한 47종목 중 거래량 1만주를 넘는 것은 16종목뿐이었고, 나머지는 백테스트
 * 숫자가 나와도 그 값에 살 수 없다.
 *
 * 5천만원은 5만원짜리 주문 하나가 거래대금의 0.1%인 수준이다. 이 계좌 규모에서
 * 호가를 밀지 않고 들어갈 수 있는 최소선으로 잡았다 — 더 큰 계좌면 올려야 한다.
 */
export const MIN_DAILY_TURNOVER = 50_000_000;

/*
 * 왕복 비용이 하루 변동폭에서 차지하는 비중의 상한.
 *
 * 사고파는 데 드는 비용(수수료 2회 + 거래세 + 슬리피지 2회)은 값이 얼마나
 * 움직이든 똑같이 나간다. 하루 0.3% 움직이는 종목에서 왕복 0.43%가 나가면
 * 방향을 맞혀도 진다. 하루 변동폭의 절반을 넘게 비용으로 쓰는 종목은 뺀다.
 *
 * 2026-07-29 재측정에서 변동성 돌파가 백테스트 1회당 매매 13.4회에 비용이
 * 원금의 2.60%였다 — 다른 두 전략(0.58% / 0.60%)의 네 배가 넘는다.
 * 소액 계좌에서 비용은 전략을 고르는 문제가 아니라 후보를 고르는 문제다.
 */
export const MAX_COST_SHARE_OF_RANGE = 0.5;

/** 사고팔 때 한 번씩 드는 비용을 합친 비율. 백테스트가 쓰는 값과 같은 것을 쓴다. */
export const ROUND_TRIP_COST_RATE =
  DEFAULT_COSTS.commissionRate * 2 + DEFAULT_COSTS.sellTaxRate + DEFAULT_COSTS.slippageRate * 2;

/*
 * 정규장 09:00-15:30을 분으로. 장 초반에는 거래대금이 아직 안 쌓인다.
 * 예전에는 여기서 `9 * 60`을 따로 들고 있어 프론트의 장 상태 표시와 갈라질 수
 * 있었다. 같은 사실이니 shared 한 곳에서 가져온다.
 */
const SESSION_OPEN_MINUTES = KRX_SESSION_MINUTES.open;
const SESSION_CLOSE_MINUTES = KRX_SESSION_MINUTES.close;

/**
 * 지금까지 지난 장 시간의 비율 (0~1).
 *
 * 유동성 문턱을 하루치로 걸면 09:05에는 모든 종목이 걸린다 — 아직 5분치만
 * 쌓였기 때문이다. 지난 만큼만 요구한다. 장 시작 전이나 마감 후에는 1로 본다
 * (전일 종가 기준 누적이 이미 하루치다).
 */
export function sessionElapsedRatio(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const minutes = Number(map.hour) * 60 + Number(map.minute);
  if (minutes <= SESSION_OPEN_MINUTES || minutes >= SESSION_CLOSE_MINUTES) return 1;
  return (minutes - SESSION_OPEN_MINUTES) / (SESSION_CLOSE_MINUTES - SESSION_OPEN_MINUTES);
}

/** 후보에서 빠진 이유. 왜 비었는지 실행 기록에 적으려면 세어야 한다. */
export interface UniverseRejections {
  tooExpensive: number;
  illiquid: number;
  costHeavy: number;
}

/**
 * 유동성·비용으로 거른다. 통과하면 null, 걸리면 사유.
 *
 * 두 조건 모두 "백테스트에서는 되는데 실제로는 안 되는" 것을 잡는다.
 * 백테스트는 원하는 값에 원하는 만큼 체결된다고 보지만 실제 시장은 아니다.
 */
export function screenQuote(quote: Quote, elapsed: number): keyof UniverseRejections | null {
  const turnover = quote.price * quote.accVolume;
  if (turnover < MIN_DAILY_TURNOVER * elapsed) return 'illiquid';

  const range = quote.high - quote.low;
  // 고가·저가가 아직 안 잡힌 종목(장 초반·거래 없음)은 이 잣대로 거르지 않는다.
  if (range > 0 && quote.price > 0) {
    const rangeRate = range / quote.price;
    if (ROUND_TRIP_COST_RATE > rangeRate * MAX_COST_SHARE_OF_RANGE) return 'costHeavy';
  }
  return null;
}

function isOrderable(instrument: Instrument): boolean {
  if (instrument.country !== 'KR') return false;
  return instrument.assetType === 'stock' || instrument.assetType === 'etf' || instrument.assetType === 'etn';
}

/**
 * 현금으로 1주라도 살 수 있는 종목만 돌려준다.
 *
 * 허용 목록이 설정돼 있으면 그 안에서만 고른다 — 리스크 룰이 어차피 나머지를
 * 막으므로, 막힐 걸 알면서 후보에 올릴 이유가 없다.
 */
export interface CandidateResult {
  instruments: Instrument[];
  /** 비어 있을 때 왜 비었는지. 그대로 실행 기록에 남는다 */
  note?: string;
}

export async function loadAutoTraderCandidates(accountId: string, cash: number): Promise<CandidateResult> {
  const account = getKisAccount(accountId);
  if (!account) return { instruments: [], note: '등록된 계좌가 아닙니다' };
  if (cash <= 0) return { instruments: [], note: '현금이 없습니다' };

  const rules = await getRiskRules(accountId);
  const blocked = new Set(rules.symbolBlocklist);
  const allowed = rules.symbolAllowlist.length > 0 ? new Set(rules.symbolAllowlist) : null;

  const pools = await Promise.all(
    SOURCE_CATEGORIES.map((category) => getCategoryInstruments(category, 200).catch(() => [])),
  );
  const usable = pools.map((pool) =>
    pool
      .filter(isOrderable)
      .filter((instrument) => !blocked.has(instrument.symbol))
      .filter((instrument) => (allowed ? allowed.has(instrument.symbol) : true)),
  );

  /*
   * 카테고리를 번갈아 뽑는다. 앞 카테고리를 통째로 먼저 쓰면 조회 상한을 거기서
   * 다 태운다 — 국내 전체 목록은 시총 순이라 앞쪽이 전부 대형주고, 예수금 5만원으로는
   * 하나도 살 수 없어 매 회차 "후보 없음"으로 끝났다. 실제로 그렇게 돌아갔다.
   */
  const pool: Instrument[] = [];
  const seen = new Set<string>();
  for (let index = 0; pool.length < MAX_PRICE_LOOKUPS * 4; index += 1) {
    let added = false;
    for (const list of usable) {
      const instrument = list[index];
      if (!instrument || seen.has(instrument.id)) continue;
      seen.add(instrument.id);
      pool.push(instrument);
      added = true;
    }
    if (!added) break;
  }

  if (pool.length === 0) {
    return {
      instruments: [],
      note: allowed
        ? `리스크 룰의 허용 종목(${rules.symbolAllowlist.join(', ')}) 중 주문 가능한 국내 종목이 없습니다`
        : '주문 가능한 국내 종목을 찾지 못했습니다',
    };
  }

  /*
   * 가격은 하나씩 조회해야 알 수 있다. 전 종목을 훑을 수는 없으니 앞에서
   * 잘라 확인한다. 여기서 통과한 것만 전략에게 넘어간다.
   */
  const prices: number[] = [];
  const rejections: UniverseRejections = { tooExpensive: 0, illiquid: 0, costHeavy: 0 };
  const elapsed = sessionElapsedRatio();
  const checked = await Promise.all(
    pool.slice(0, MAX_PRICE_LOOKUPS).map(async (instrument) => {
      try {
        const quote = await getInstrumentQuote(instrument);
        const price = quote.price;
        if (!Number.isFinite(price) || price <= 0) return null;
        prices.push(price);
        if (price > cash) {
          rejections.tooExpensive += 1;
          return null;
        }
        /*
         * 살 수 있다고 다 후보는 아니다. 백테스트에서 나온 숫자를 실제로
         * 거둘 수 있는 종목만 남긴다 — 물량이 있어야 그 값에 체결되고,
         * 하루 변동폭이 왕복 비용보다 넉넉해야 방향을 맞혔을 때 남는다.
         */
        const rejected = screenQuote(quote, elapsed);
        if (rejected) {
          rejections[rejected] += 1;
          return null;
        }
        return instrument;
      } catch {
        return null;
      }
    }),
  );
  const instruments = checked.filter((instrument): instrument is Instrument => instrument !== null);
  if (instruments.length > 0) return { instruments };

  /*
   * 후보가 하나도 안 남는 이유는 대부분 둘 중 하나다 — 허용 종목이 좁게 잡혀
   * 있거나, 예수금으로 1주도 살 수 없는 값비싼 종목만 남았거나. 어느 쪽인지
   * 적어주지 않으면 매 회차 "후보 없음"만 쌓이고 무엇을 고쳐야 할지 알 수 없다.
   */
  const cheapest = Math.min(...prices.filter((price) => Number.isFinite(price) && price > 0));
  const priceHint = Number.isFinite(cheapest)
    ? `확인한 종목 중 가장 싼 것이 ${Math.round(cheapest).toLocaleString()}원입니다`
    : '가격을 확인하지 못했습니다';

  /*
   * 어느 문에서 걸렸는지 세어 적는다. `후보 없음`만 쌓이면 값을 올려야 할지
   * 필터를 낮춰야 할지 알 수 없다.
   */
  const filtered = rejections.illiquid + rejections.costHeavy;
  if (filtered > 0) {
    const parts: string[] = [];
    if (rejections.tooExpensive > 0) parts.push(`가격 초과 ${rejections.tooExpensive}종목`);
    if (rejections.illiquid > 0) parts.push(`거래대금 부족 ${rejections.illiquid}종목`);
    if (rejections.costHeavy > 0) parts.push(`왕복 비용이 하루 변동폭의 절반을 넘음 ${rejections.costHeavy}종목`);
    return {
      instruments: [],
      note: `살 수 있는 종목은 있었지만 모두 걸러졌습니다 — ${parts.join(' · ')}. ${priceHint}`,
    };
  }

  return {
    instruments: [],
    note: allowed
      ? `허용 종목(${rules.symbolAllowlist.join(', ')})을 현금 ${Math.floor(cash).toLocaleString()}원으로 1주도 살 수 없습니다 · ${priceHint}`
      : `현금 ${Math.floor(cash).toLocaleString()}원으로 1주라도 살 수 있는 종목이 없습니다 · ${priceHint}`,
  };
}
