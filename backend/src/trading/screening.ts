/**
 * 자동매매 후보 거르기를 화면에서 볼 수 있게 한 벌로 묶는다.
 *
 * 지금까지 이 판정은 `loadAutoTraderCandidates` 안에서만 돌았고, 밖으로는
 * "후보 없음 — 거래대금 부족 17종목" 같은 한 줄 요약만 나왔다. 그러면 **무엇이**
 * 걸렸는지, 문턱에서 얼마나 모자랐는지는 알 수 없다. 문턱을 조정하려면
 * 분포를 봐야 한다.
 *
 * **거른 것도 함께 돌려준다.** 통과한 것만 보이면 왜 이것뿐인지 모른다.
 *
 * **호출 비용**: 종목 하나에 KIS 시세 1회다. 화면을 열 때마다 자동으로 돌리면
 * 탭을 누를 때마다 수십 회가 나간다. 그래서 이 함수는 사용자가 명시적으로
 * 부를 때만 돌고, 결과는 언제 잰 값인지와 함께 보관한다.
 */

import { getCategoryInstruments } from '../db/instruments.js';
import { getInstrumentQuote } from '../kis/rest.js';
import {
  MAX_COST_SHARE_OF_RANGE,
  MIN_DAILY_TURNOVER,
  ROUND_TRIP_COST_RATE,
  screenQuote,
  sessionElapsedRatio,
} from './universe.js';
import type { Instrument, ScreeningResult, ScreeningRow } from '@invest/shared';

const SOURCE_CATEGORIES = ['kr-all', 'kr-etf'];
/** KIS 호출 제한(EGW00201)을 태우지 않도록 조회 간격을 둔다. */
const LOOKUP_GAP_MS = 120;
/** 한 번에 훑을 수 있는 상한. 넘기면 호출 제한에 걸린다. */
export const MAX_SCREENING_LOOKUPS = 80;
export const DEFAULT_SCREENING_LOOKUPS = 40;

function isOrderable(instrument: Instrument): boolean {
  if (instrument.country !== 'KR') return false;
  return instrument.assetType === 'stock' || instrument.assetType === 'etf' || instrument.assetType === 'etn';
}

/**
 * 카테고리를 번갈아 뽑는다.
 *
 * 앞 카테고리를 통째로 먼저 쓰면 조회 상한을 거기서 다 태운다 — 국내 전체
 * 목록은 시총 순이라 앞쪽이 전부 대형주고, 예수금 5만원으로는 하나도 살 수
 * 없어 매번 "후보 없음"으로 끝났다. `loadAutoTraderCandidates`가 겪은 일이다.
 */
async function buildPool(size: number): Promise<Instrument[]> {
  const pools = await Promise.all(
    SOURCE_CATEGORIES.map((category) => getCategoryInstruments(category, 300).catch(() => [])),
  );
  const pool: Instrument[] = [];
  const seen = new Set<string>();
  for (let index = 0; pool.length < size; index += 1) {
    let added = false;
    for (const list of pools) {
      const instrument = list[index];
      if (!instrument || !isOrderable(instrument) || seen.has(instrument.id)) continue;
      seen.add(instrument.id);
      pool.push(instrument);
      added = true;
    }
    if (!added) break;
  }
  return pool;
}

export async function runScreening(cash: number, lookups: number): Promise<ScreeningResult> {
  const limit = Math.max(1, Math.min(MAX_SCREENING_LOOKUPS, Math.floor(lookups)));
  // 통과한 것만 세면 안 되므로 조회 수만큼만 풀을 만든다 — 안 물어본 종목을
  // 후보에서 빠진 것처럼 세면 거절 사유가 부풀려진다.
  const pool = await buildPool(limit);
  const elapsed = sessionElapsedRatio();
  const rows: ScreeningRow[] = [];
  let unresolved = 0;

  for (const instrument of pool) {
    try {
      const quote = await getInstrumentQuote(instrument);
      if (!Number.isFinite(quote.price) || quote.price <= 0) {
        unresolved += 1;
        continue;
      }
      const range = quote.high - quote.low;
      rows.push({
        instrumentId: instrument.id,
        symbol: instrument.symbol,
        name: instrument.name,
        price: quote.price,
        changeRate: quote.changeRate,
        turnover: quote.price * quote.accVolume,
        rangeRate: range > 0 ? (range / quote.price) * 100 : undefined,
        // 값비싸서 못 사는 것이 먼저다. 살 수도 없는 종목을 유동성으로 거르면
        // 사유가 뒤바뀐다 — 자동매매도 이 순서로 본다.
        verdict: quote.price > cash ? 'tooExpensive' : (screenQuote(quote, elapsed) ?? 'pass'),
      });
    } catch {
      // 하나가 실패해도 나머지는 살린다. 다만 없던 일로 하지 않고 센다.
      unresolved += 1;
    }
    await new Promise((resolve) => setTimeout(resolve, LOOKUP_GAP_MS));
  }

  return {
    scannedAt: Date.now(),
    cash,
    elapsed,
    poolSize: pool.length,
    lookups: limit,
    unresolved,
    rows: rows.sort((a, b) => b.changeRate - a.changeRate),
    thresholds: {
      minDailyTurnover: MIN_DAILY_TURNOVER,
      roundTripCostRate: ROUND_TRIP_COST_RATE,
      maxCostShareOfRange: MAX_COST_SHARE_OF_RANGE,
    },
  };
}

/**
 * 마지막 결과를 계좌별로 들고 있는다.
 *
 * 화면을 열 때마다 다시 돌리면 탭을 누를 때마다 수십 회 호출이 나간다.
 * 대신 마지막 값을 **언제 잰 것인지와 함께** 보여 주고, 다시 재는 건
 * 사용자가 누를 때만 한다. 서버가 재시작하면 사라진다 — 그건 "아직 안
 * 돌렸습니다"와 같은 상태라 따로 구별하지 않는다.
 */
const lastResultByAccount = new Map<string, ScreeningResult>();

export function getLastScreening(accountId: string): ScreeningResult | null {
  return lastResultByAccount.get(accountId) ?? null;
}

export function rememberScreening(accountId: string, result: ScreeningResult): void {
  lastResultByAccount.set(accountId, result);
}
