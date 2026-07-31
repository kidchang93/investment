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
 * **호출 비용**: 멀티시세로 **30종목에 KIS 1회**다(예전에는 종목당 1회였다).
 * 그래도 화면을 열 때마다 자동으로 돌리면 탭을 누를 때마다 호출이 나가므로,
 * 이 함수는 사용자가 명시적으로 부를 때만 돌고 결과는 언제 잰 값인지와 함께 보관한다.
 */

import { getCategoryInstruments } from '../db/instruments.js';
import { getInstrumentQuotes, MULTI_QUOTE_MAX_CODES } from '../kis/rest.js';
import {
  knownRangeRate,
  MAX_COST_SHARE_OF_RANGE,
  MIN_DAILY_TURNOVER,
  ROUND_TRIP_COST_RATE,
  sessionElapsedRatio,
  verdictFor,
} from './universe.js';
import type { Instrument, ScreeningResult, ScreeningRow } from '@invest/shared';

const SOURCE_CATEGORIES = ['kr-all', 'kr-etf'];

/*
 * 한 번에 훑을 수 있는 상한. 호출 수로 잡는다 — 종목 수를 그냥 늘리면
 * 몇 회가 나가는지 알 수 없다.
 *
 * 예전에는 종목당 1회라 80종목이 80회였고 조회 사이에 120ms를 더 쉬어야 했다
 * (80종목에 약 6초). 멀티시세는 30종목이 1회다.
 *
 * 2026-07-31 실측(실전 서버, 장 마감 후): 10묶음 300종목을 **1.08초**에 받았고
 * `EGW00201` 0건, 빈 자리 0건이었다. 상한을 그 실측치인 10묶음에 맞춘다 —
 * **그보다 많이는 재 보지 않았으므로 올리기 전에 다시 재라.**
 */
const MAX_SCREENING_CALLS = 10;
const DEFAULT_SCREENING_CALLS = 4;
/** 300종목 = 10회 */
export const MAX_SCREENING_LOOKUPS = MULTI_QUOTE_MAX_CODES * MAX_SCREENING_CALLS;
/** 120종목 = 4회 */
export const DEFAULT_SCREENING_LOOKUPS = MULTI_QUOTE_MAX_CODES * DEFAULT_SCREENING_CALLS;

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

  /*
   * 한 묶음이 실패해도 나머지는 살린다. 다만 없던 일로 하지 않고 센다 —
   * 못 받은 것과 걸러진 것은 다른 사실이고, 화면이 그 둘을 구별해야 한다.
   */
  const batch = await getInstrumentQuotes(pool);

  for (const instrument of pool) {
    const quote = batch.quotes.get(instrument.id);
    if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) {
      unresolved += 1;
      continue;
    }
    /*
     * 판정과 **같은 함수**로 잰다. 예전에는 여기서 `range > 0 ? … : undefined`를
     * 따로 계산해서, 한 값에만 체결된 종목이 화면에는 `없음`으로 뜨는데 판정은
     * `pass`였다 — 두 자리가 서로 다른 규칙을 들고 있었다.
     */
    const rangeRate = knownRangeRate(quote);
    rows.push({
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      name: instrument.name,
      price: quote.price,
      changeRate: quote.changeRate,
      // KIS가 준 실제 누적 거래대금. 값이 없는 경로만 현재가 × 거래량으로 어림한다.
      turnover: quote.turnover ?? quote.price * quote.accVolume,
      // 모르면 `undefined`, 한 값에만 체결됐으면 `0`이다. 둘은 다른 사실이다.
      rangeRate: rangeRate === undefined ? undefined : rangeRate * 100,
      /*
       * 사유의 순서는 `verdictFor` 한 곳에서 정한다. 예전에는 여기서 가격 검사를
       * 따로 앞에 두고 있어 `loadAutoTraderCandidates`와 같은 규칙을 두 곳이
       * 들고 있었다 — 한쪽만 고치면 화면과 실행 기록이 조용히 갈라진다.
       */
      verdict: verdictFor(quote, elapsed, cash),
    });
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
