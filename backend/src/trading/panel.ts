/**
 * 21년 × 전 종목을 **평탄한 배열 한 벌**로 세운다.
 *
 * ── 왜 필요한가 (2026-08-12) ─────────────────────────────────────────────
 *
 * `signalHarness.ts`가 날짜 루프 안에서 `bars.findIndex(b => b.tradingDay === day)`를
 * 돌고 있었다. 종목 143개·날짜 80개일 때는 보이지 않던 값이지만
 * **5,288일 × 2,700종목 × 평균 3,000봉 ≈ 4.3e10**이다. 셀 35개면 1.5e12 —
 * 하룻밤에 안 끝난다.
 *
 * 자리를 미리 한 번만 계산해 두면 그 전부가 배열 읽기 한 번이 된다.
 *
 * ── 왜 객체 배열이 아닌가 ────────────────────────────────────────────────
 *
 * 봉 하나를 객체로 들면 5.3M개 × (헤더 + 필드 7개)라 640MB가 넘는다. 컬럼마다
 * `Float64Array`를 두면 같은 값이 254MB다. `localIndex`(날짜×종목 Int32)가
 * 여기에 57~82MB 더 붙는다.
 *
 *   node --max-old-space-size=4096 ...   ← 이 크기를 감당하려면 필요하다
 *
 * ── ★ `NaN`은 `NULL`이다. 0으로 채우지 않는다 ────────────────────────────
 *
 * 거래량·거래대금이 안 온 것과 0인 것은 다른 사실이다. 0으로 채우면
 * "그날 한 주도 안 거래됐다"가 지어진다 — 이 레포가 `Number('')`로 이미 당했다.
 *
 * ── 이 모듈은 DB도 KIS도 부르지 않는다 ───────────────────────────────────
 *
 * 봉을 받아 오는 것은 부른 쪽 일이다. 여기는 순수 계산이라 시험이 네트워크 없이
 * 돈다 — `multiQuote.ts`·`quoteCache.ts`와 같은 이유다.
 */

import type { DailyBar as SignalDailyBar, SignalCandidate } from './signals.js';

/**
 * 패널에 넣을 수 있는 봉의 **가장 느슨한 모양**.
 *
 * `db/dailyBars.ts`의 `DailyBar`(volume·turnover가 `number | null`)와
 * `trading/signals.ts`의 `DailyBar`(open·high·low·turnover가 `number | undefined`)가
 * 둘 다 이것에 맞는다. 한쪽에 맞춰 두면 다른 쪽이 못 들어온다.
 */
export interface PanelBar {
  tradingDay: string;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close: number;
  volume?: number | null;
  turnover?: number | null;
}

/**
 * 날짜 × 종목 판. 컬럼마다 종목별 `Float64Array` 하나다.
 *
 *   값 하나 꺼내기:  const i = localAt(panel, dayIndex, symbolIndex);
 *                    if (i >= 0) panel.close[symbolIndex][i]
 */
export interface Panel {
  /** 전 종목 거래일의 합집합, 오름차순 */
  days: string[];
  /** 종목코드 오름차순. 실행마다 순서가 바뀌면 결과가 재현되지 않는다 */
  symbols: string[];
  /**
   * `days.length × symbols.length` 평탄화. **그 종목에 그날 봉이 없으면 −1이다.**
   * 0으로 두면 "첫 봉"을 가리켜 조용히 다른 날 값을 읽는다.
   */
  localIndex: Int32Array;
  open: Float64Array[];
  high: Float64Array[];
  low: Float64Array[];
  close: Float64Array[];
  volume: Float64Array[];
  turnover: Float64Array[];
  /** 종목별 봉의 **전역 날짜 index**. 종목 축으로 훑다가 그날이 언제인지 알 때 쓴다 */
  dayIndexOfBar: Int32Array[];
  /** 종목별 봉 수 */
  barCount: Int32Array;
  dayIndexByDay: Map<string, number>;
  symbolIndexBySymbol: Map<string, number>;
}

/** `(날짜, 종목)`의 그 종목 안 자리. 없으면 −1. */
export function localAt(panel: Panel, dayIndex: number, symbolIndex: number): number {
  return panel.localIndex[dayIndex * panel.symbols.length + symbolIndex];
}

/** `null`·`undefined`를 **`NaN`으로** 옮긴다. 0으로 바꾸지 않는다. */
function toValue(value: number | null | undefined): number {
  return value === null || value === undefined ? Number.NaN : value;
}

/**
 * 종목별 봉 목록을 판으로 세운다.
 *
 * 봉은 **날짜 오름차순**이어야 한다(`getDailyBars`가 그렇게 준다). 같은 날이 두 번
 * 오면 뒤엣것이 이긴다 — 여기서 던지지 않는 이유는, 저장소의 기본키가
 * `(symbol, trading_day)`라 그런 줄이 애초에 들어갈 수 없기 때문이다.
 */
export function buildPanel(barsBySymbol: Map<string, PanelBar[]>): Panel {
  const symbols = [...barsBySymbol.keys()].sort();
  const daySet = new Set<string>();
  for (const bars of barsBySymbol.values()) for (const bar of bars) daySet.add(bar.tradingDay);
  const days = [...daySet].sort();

  const dayIndexByDay = new Map<string, number>();
  days.forEach((day, index) => dayIndexByDay.set(day, index));
  const symbolIndexBySymbol = new Map<string, number>();
  symbols.forEach((symbol, index) => symbolIndexBySymbol.set(symbol, index));

  const localIndex = new Int32Array(days.length * symbols.length).fill(-1);
  const open: Float64Array[] = [];
  const high: Float64Array[] = [];
  const low: Float64Array[] = [];
  const close: Float64Array[] = [];
  const volume: Float64Array[] = [];
  const turnover: Float64Array[] = [];
  const dayIndexOfBar: Int32Array[] = [];
  const barCount = new Int32Array(symbols.length);

  for (let s = 0; s < symbols.length; s += 1) {
    const bars = barsBySymbol.get(symbols[s]) ?? [];
    const n = bars.length;
    barCount[s] = n;
    const o = new Float64Array(n);
    const h = new Float64Array(n);
    const l = new Float64Array(n);
    const c = new Float64Array(n);
    const v = new Float64Array(n);
    const t = new Float64Array(n);
    const d = new Int32Array(n);
    for (let i = 0; i < n; i += 1) {
      const bar = bars[i];
      o[i] = toValue(bar.open);
      h[i] = toValue(bar.high);
      l[i] = toValue(bar.low);
      c[i] = toValue(bar.close);
      v[i] = toValue(bar.volume);
      t[i] = toValue(bar.turnover);
      const dayIndex = dayIndexByDay.get(bar.tradingDay) ?? -1;
      d[i] = dayIndex;
      if (dayIndex >= 0) localIndex[dayIndex * symbols.length + s] = i;
    }
    open.push(o);
    high.push(h);
    low.push(l);
    close.push(c);
    volume.push(v);
    turnover.push(t);
    dayIndexOfBar.push(d);
  }

  return {
    days,
    symbols,
    localIndex,
    open,
    high,
    low,
    close,
    volume,
    turnover,
    dayIndexOfBar,
    barCount,
    dayIndexByDay,
    symbolIndexBySymbol,
  };
}

/**
 * 한 종목의 계열을 신호가 먹을 수 있는 모양으로 되돌린다.
 *
 * ★ **수급 셋은 `NaN`이다.** 일봉 저장소에 그 값이 없다. 0으로 채우면
 * `tradeScale`이 0이 되어 수급 신호가 `undefined`를 내는데, 그건 "매매가 없던 날"
 * 이라는 **다른 사실**을 지어내는 것이다. `NaN`이면 곱셈이 `NaN`으로 번져
 * `Number.isFinite` 검사에서 걸린다 — 어느 쪽이든 그 신호는 빠지지만,
 * 이유를 지어내지는 않는다. 애초에 `dataRequirement`가 미리 뺀다.
 *
 * 한 종목 분량(≤5,300개)만 살아 있다가 버려진다. 전 종목을 동시에 세우지 않는다.
 */
export function symbolHistory(panel: Panel, symbolIndex: number): SignalDailyBar[] {
  const n = panel.barCount[symbolIndex];
  const o = panel.open[symbolIndex];
  const h = panel.high[symbolIndex];
  const l = panel.low[symbolIndex];
  const c = panel.close[symbolIndex];
  const t = panel.turnover[symbolIndex];
  const d = panel.dayIndexOfBar[symbolIndex];
  const history: SignalDailyBar[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    history[i] = {
      tradingDay: panel.days[d[i]],
      close: c[i],
      individual: Number.NaN,
      foreign: Number.NaN,
      institution: Number.NaN,
      open: o[i],
      high: h[i],
      low: l[i],
      turnover: t[i],
    };
  }
  return history;
}

/**
 * `(날짜, 종목)` 점수판. **없는 자리는 `NaN`이다.**
 *
 * 신호 하나에 165MB(5,288 × 3,900 × 8B)라 **한 번에 하나만 살려 둔다.** 축이 여럿일
 * 때 축마다 다시 재지 않는 것이 이 판의 존재 이유다 — 점수는 축과 무관하다.
 */
export function buildScoreMatrix(panel: Panel, signal: SignalCandidate): Float64Array {
  const symbolCount = panel.symbols.length;
  const scores = new Float64Array(panel.days.length * symbolCount).fill(Number.NaN);
  for (let s = 0; s < symbolCount; s += 1) {
    const n = panel.barCount[s];
    if (n === 0) continue;
    const history = symbolHistory(panel, s);
    const symbol = panel.symbols[s];
    const dayOfBar = panel.dayIndexOfBar[s];
    for (let i = signal.minHistory; i < n; i += 1) {
      const value = signal.score({ history, index: i, symbol });
      if (value === undefined || !Number.isFinite(value)) continue;
      scores[dayOfBar[i] * symbolCount + s] = value;
    }
  }
  return scores;
}

/*
 * ── 수정주가 파탄 ────────────────────────────────────────────────────────
 *
 * KIS 수정주가가 옛 구간에서 깨져 있다. 370종목 표본에서 이미 11건이 나왔다 —
 * `005070` 2008-01-22 `1,124 → 2,881(+156.3%)`, `000680` 2007-09-03 `+130.0%`,
 * `002760` 2008-02-12 `−80.7%`. 그날 가격제한폭이 ±15%였으므로 **시장에서 일어날
 * 수 없는 값**이고, 분할·병합이 한쪽에만 반영됐다는 뜻이다.
 *
 * ★ **봉 하나만 빼면 안 된다.** 그 앞뒤가 다른 자로 잰 값이라 이어 붙는 순간
 * 수익률이 조용히 틀린다. 그 봉 **이전을 통째로 버린다.**
 */

/** 그 시기의 가격제한폭. 넘으면 시장에서 일어날 수 없는 값이다. */
interface PriceLimitEra {
  /** 이 날짜까지(포함) */
  until: string;
  /** 하루 변동 한계. 여유를 조금 얹은 값이다 */
  limit: number;
}

/**
 * ★ KRX 가격제한폭은 **2015-06-15**에 ±15% → ±30%로 바뀌었다. 여기 경계를
 * 2015-01-01로 둔 것은 2015 상반기를 **느슨하게** 보겠다는 뜻이다 — 그 반년은
 * 실제 한계(15%)보다 넉넉히 재므로 파탄을 덜 잡을 수는 있어도 멀쩡한 봉을
 * 파탄으로 몰지는 않는다. 어느 쪽으로 틀릴지를 정해 둔 것이다.
 */
export const PRICE_LIMIT_ERAS: PriceLimitEra[] = [
  { until: '20141231', limit: 0.155 },
  { until: '99999999', limit: 0.31 },
];

export function priceLimitFor(tradingDay: string): number {
  for (const era of PRICE_LIMIT_ERAS) if (tradingDay <= era.until) return era.limit;
  return PRICE_LIMIT_ERAS[PRICE_LIMIT_ERAS.length - 1].limit;
}

/** 파탄 한 건. 사람이 눈으로 확인할 수 있게 앞뒤 종가를 그대로 들고 나온다. */
export interface PriceLimitBreak {
  symbol: string;
  tradingDay: string;
  previousClose: number;
  close: number;
  changeRate: number;
  limit: number;
}

export interface AdjustmentBreakScan {
  /** 종목별 **쓸 수 있는 첫 자리**. 파탄이 없으면 0 */
  firstUsableLocal: Int32Array;
  breaks: PriceLimitBreak[];
  /** 파탄이 있어 앞을 버린 종목 수 */
  brokenSymbols: number;
  /** 버린 봉 수 */
  droppedBars: number;
  /** 전체 봉 대비 버린 비율 */
  droppedShare: number;
}

/**
 * 종목마다 가격제한폭을 넘는 봉을 찾고, **마지막 파탄 이후만 쓴다.**
 *
 * 파탄이 여럿이면 가장 뒤엣것 기준이다 — 그 앞은 어느 자로 쟀는지 모른다.
 */
export function scanAdjustmentBreaks(panel: Panel): AdjustmentBreakScan {
  const firstUsableLocal = new Int32Array(panel.symbols.length);
  const breaks: PriceLimitBreak[] = [];
  let brokenSymbols = 0;
  let droppedBars = 0;
  let totalBars = 0;

  for (let s = 0; s < panel.symbols.length; s += 1) {
    const n = panel.barCount[s];
    totalBars += n;
    const close = panel.close[s];
    const dayOfBar = panel.dayIndexOfBar[s];
    let lastBreak = 0;
    for (let i = 1; i < n; i += 1) {
      const previous = close[i - 1];
      const current = close[i];
      if (!(previous > 0) || !(current > 0)) continue;
      const day = panel.days[dayOfBar[i]];
      const limit = priceLimitFor(day);
      const change = current / previous - 1;
      if (Math.abs(change) <= limit) continue;
      breaks.push({
        symbol: panel.symbols[s],
        tradingDay: day,
        previousClose: previous,
        close: current,
        changeRate: change,
        limit,
      });
      lastBreak = i;
    }
    firstUsableLocal[s] = lastBreak;
    if (lastBreak > 0) {
      brokenSymbols += 1;
      droppedBars += lastBreak;
    }
  }

  return {
    firstUsableLocal,
    breaks,
    brokenSymbols,
    droppedBars,
    droppedShare: totalBars > 0 ? droppedBars / totalBars : 0,
  };
}

/*
 * ── 유니버스 ─────────────────────────────────────────────────────────────
 *
 * **전부 as-of-date다 — 오늘 값으로 과거를 고르지 않는다.** 단 하나 예외가
 * 종목 자격(주식·시장·우선주)인데, 그건 오늘 마스터에만 있다. 그래서 결과에
 * `survivorshipExposed`로 그 사실을 적어 둔다. 감추면 판정문이 거짓말을 한다.
 */
export interface UniverseSpec {
  /** 그날까지 이만큼 봉이 있어야 한다 (그 종목 안 자리 번호 기준) */
  minBars: number;
  /** 거래 실질을 보는 창(거래일) */
  activityWindow: number;
  /** 그 창에서 `volume > 0`인 날이 이만큼 */
  minActiveDays: number;
  /** 평균 거래대금을 보는 창(거래일) */
  turnoverWindow: number;
  /** 그 평균의 하한(원) */
  minTurnover: number;
  /** 그날 살아남은 종목 중 거래대금 하위 이 비율을 뺀다 */
  turnoverBottomFraction: number;
  /** 그날 이만큼 없으면 그 날짜를 통째로 버린다 */
  minNamesPerDay: number;
  /**
   * ★ **공통 점수 게이트.** 이 신호들이 그날 **전부** 유한한 점수를 내는 종목만
   * 남긴다. 신호마다 쓰는 종목·날짜가 다르면 칸을 나란히 읽을 수 없다 —
   * 2026-08-10에 수급 신호가 조용히 `undefined`로 흘러 날짜 수만 줄던 것이
   * 그 결함이었다.
   */
  scoreGateSignals: SignalCandidate[];
  /** 종목 자격. 여기 없는 종목은 통째로 뺀다 (오늘 마스터 기준) */
  eligibleSymbols: Set<string>;
}

export interface UniverseMask {
  /** `days.length × symbols.length`. 1이면 그날 그 종목을 쓴다 */
  mask: Uint8Array;
  /** 날짜별 구성원 시작 자리 (`days.length + 1`) */
  dayOffsets: Int32Array;
  /** 날짜별 종목 index, 오름차순 */
  dayMembers: Int32Array;
  /** 쓸 수 있는 날짜 수 */
  usableDays: number;
  /** 종목이 모자라 통째로 버린 날짜 수 */
  thinDays: number;
  /** 자격 밖이라 아예 안 본 종목 수 */
  ineligibleSymbols: number;
  /** 수정주가 파탄으로 앞을 버린 결과 */
  adjustment: AdjustmentBreakScan;
  /** 날짜별 종목 수의 중앙값·최소 (쓸 수 있는 날짜만) */
  namesMedian: number;
  namesMin: number;
}

/** `k`번째로 작은 값. 정렬하지 않고 자리만 고른다 (Hoare 분할). */
export function quickSelect(values: Float64Array, length: number, k: number): number {
  let left = 0;
  let right = length - 1;
  while (left < right) {
    const pivot = values[(left + right) >> 1];
    let i = left;
    let j = right;
    while (i <= j) {
      while (values[i] < pivot) i += 1;
      while (values[j] > pivot) j -= 1;
      if (i <= j) {
        const tmp = values[i];
        values[i] = values[j];
        values[j] = tmp;
        i += 1;
        j -= 1;
      }
    }
    if (k <= j) right = j;
    else if (k >= i) left = i;
    else break;
  }
  return values[k];
}

/**
 * 유니버스 마스크를 만든다. **점수 게이트 때문에 신호를 한 번씩 훑는다.**
 *
 * 점수판을 들고 있지 않고 세는 것만 남기는 이유는 메모리다 — 신호 7개 점수판을
 * 동시에 들면 1.1GB다. 여기서는 `Uint8Array` 하나(20MB)에 "몇 개가 유한했나"만
 * 쌓고, 실제 점수는 칸을 만들 때 다시 낸다.
 */
export function buildUniverseMask(panel: Panel, spec: UniverseSpec): UniverseMask {
  const dayCount = panel.days.length;
  const symbolCount = panel.symbols.length;
  const cells = dayCount * symbolCount;

  const adjustment = scanAdjustmentBreaks(panel);

  // ① 공통 점수 게이트 — 몇 개 신호가 그 자리에서 유한했나
  const finiteCount = new Uint8Array(cells);
  for (const signal of spec.scoreGateSignals) {
    const scores = buildScoreMatrix(panel, signal);
    for (let i = 0; i < cells; i += 1) if (Number.isFinite(scores[i])) finiteCount[i] += 1;
  }
  const gateNeeded = spec.scoreGateSignals.length;

  // ② 종목 축 필터 + 살아남은 자리의 거래대금 평균을 남긴다 (횡단면 컷의 재료)
  const mask = new Uint8Array(cells);
  const turnoverMean = new Float64Array(cells).fill(Number.NaN);
  let ineligibleSymbols = 0;

  for (let s = 0; s < symbolCount; s += 1) {
    if (!spec.eligibleSymbols.has(panel.symbols[s])) {
      ineligibleSymbols += 1;
      continue;
    }
    const n = panel.barCount[s];
    const volume = panel.volume[s];
    const turnover = panel.turnover[s];
    const dayOfBar = panel.dayIndexOfBar[s];
    const from = adjustment.firstUsableLocal[s];

    for (let i = from; i < n; i += 1) {
      // 그날까지 봉이 모자라면 신호가 설 자리가 없다. 파탄 이후만 세므로 `i - from`이다.
      if (i - from < spec.minBars) continue;
      if (i < spec.activityWindow - 1 || i < spec.turnoverWindow - 1) continue;

      let active = 0;
      for (let j = i - spec.activityWindow + 1; j <= i; j += 1) if (volume[j] > 0) active += 1;
      if (active < spec.minActiveDays) continue;

      let total = 0;
      let ok = true;
      for (let j = i - spec.turnoverWindow + 1; j <= i; j += 1) {
        const value = turnover[j];
        // 안 온 값을 0으로 세면 "거래가 없었다"가 지어진다. 그 창은 통째로 못 쓴다.
        if (!Number.isFinite(value)) {
          ok = false;
          break;
        }
        total += value;
      }
      if (!ok) continue;
      const average = total / spec.turnoverWindow;
      if (!(average >= spec.minTurnover)) continue;

      const cell = dayOfBar[i] * symbolCount + s;
      if (finiteCount[cell] < gateNeeded) continue;
      mask[cell] = 1;
      turnoverMean[cell] = average;
    }
  }

  // ③ 그날 거래대금 하위 몫을 뺀다 — 횡단면이라 날짜 축으로 다시 본다
  const scratch = new Float64Array(symbolCount);
  const dayOffsets = new Int32Array(dayCount + 1);
  const members: number[] = [];
  const namesPerDay: number[] = [];
  let thinDays = 0;
  let usableDays = 0;

  for (let d = 0; d < dayCount; d += 1) {
    dayOffsets[d] = members.length;
    const base = d * symbolCount;
    let count = 0;
    for (let s = 0; s < symbolCount; s += 1) if (mask[base + s] === 1) scratch[count++] = turnoverMean[base + s];
    if (count === 0) continue;

    const cut = Math.floor(count * spec.turnoverBottomFraction);
    const threshold = cut > 0 ? quickSelect(scratch, count, cut - 1) : Number.NEGATIVE_INFINITY;

    const dayStart = members.length;
    for (let s = 0; s < symbolCount; s += 1) {
      if (mask[base + s] !== 1) continue;
      if (cut > 0 && turnoverMean[base + s] <= threshold) {
        mask[base + s] = 0;
        continue;
      }
      members.push(s);
    }
    const names = members.length - dayStart;
    if (names < spec.minNamesPerDay) {
      // 줄을 세울 수 없는 날이다. 그날은 통째로 버린다 — 반쪽으로 세지 않는다.
      members.length = dayStart;
      for (let s = 0; s < symbolCount; s += 1) mask[base + s] = 0;
      thinDays += 1;
      continue;
    }
    usableDays += 1;
    namesPerDay.push(names);
  }
  dayOffsets[dayCount] = members.length;

  const sortedNames = [...namesPerDay].sort((a, b) => a - b);
  const namesMedian = sortedNames.length === 0
    ? 0
    : sortedNames.length % 2 === 0
      ? (sortedNames[sortedNames.length / 2 - 1] + sortedNames[sortedNames.length / 2]) / 2
      : sortedNames[(sortedNames.length - 1) / 2];

  return {
    mask,
    dayOffsets,
    dayMembers: Int32Array.from(members),
    usableDays,
    thinDays,
    ineligibleSymbols,
    adjustment,
    namesMedian,
    namesMin: sortedNames[0] ?? 0,
  };
}
