/**
 * 하루 변동폭이 장중에 어떻게 벌어지는지 재는 계산 (순수 함수).
 *
 * `screenQuote`의 두 문 중 유동성만 `elapsed`를 곱하고 비용은 안 곱한다.
 * 거래대금은 시간에 선형으로 쌓이지만 고가−저가는 **누적이 아니라 범위**라
 * 같은 방식으로 나눌 수 없기 때문이다. 그런데 나누지 않으면 하루치 잣대가
 * 장 초반에 그대로 걸린다 — 2026-07-31 09:04 실측에서 120종목 중 18종목이
 * `costHeavy`였다.
 *
 * 어느 쪽이 맞는지는 **재야** 안다. 여기 있는 것은 그 측정의 계산부다.
 * 실제로 재는 것은 `scripts/measureRangeExpansion.ts`이고, 이 모듈은
 * 네트워크·DB 없이 시험으로 못 박을 수 있는 부분만 담는다.
 *
 * ── 왜 `aheadRangeRate`가 핵심인가 ────────────────────────────────────────
 *
 * 비용 문턱이 묻는 것은 "이 종목에서 왕복 비용을 이길 만큼 값이 움직이나"다.
 * 그런데 **09:05에 사는 사람에게 중요한 것은 09:00~09:05에 이미 벌어진 폭이
 * 아니라 앞으로 벌어질 폭이다.** 지금 잣대(`rangeRate`)는 지나간 것을 재서
 * 앞을 판정한다. 그게 얼마나 맞는 예측인지를 재려면 같은 시각에 "앞으로
 * 실제로 벌어진 폭"(`aheadRangeRate`)을 함께 계산해 견줘야 한다.
 *
 * 두 값 모두 **그 시각의 값(price)으로 나눈다.** 판정 시점에 알 수 있는 값이
 * 그것뿐이고, 종가로 나누면 미래를 훔쳐 쓰는 셈이 된다.
 */

/**
 * 분봉 하나. KIS 원본 필드가 아니라 이미 정규화된 값만 담는다.
 *
 * `minute`는 **자정부터의 분**이다 (09:00 = 540). 초는 버린다 — 분봉이라
 * 애초에 초가 없고, 그리드도 분 단위로 잡는다.
 */
export interface MinuteBar {
  minute: number;
  high: number;
  low: number;
  close: number;
  /** 그 분의 체결 수량. 없으면 거래대금을 못 쌓는다 — 0으로 치지 않는다 */
  volume?: number;
}

/** 어느 시각에 무엇을 알 수 있었나 / 그 뒤 무슨 일이 있었나. */
export interface RangeSnapshot {
  /** 판정 시각 (자정부터의 분) */
  minute: number;
  /** 그 시각의 값. 두 비율의 분모다 */
  price: number;
  /** 개장~t 누적 고저폭 ÷ price. 지금 `screenQuote`가 보는 값이다 */
  rangeRate: number;
  /** t 이후~마감 고저폭 ÷ price. t에 들어간 사람 앞에 남아 있던 폭이다 */
  aheadRangeRate: number;
  /** t까지의 봉 수 · t 이후의 봉 수. 표본이 몇 개인지 밝히려고 함께 낸다 */
  barsSoFar: number;
  barsAhead: number;
  /**
   * 개장~t 누적 거래대금 **어림**. Σ(그 분 종가 × 그 분 체결량)이다.
   *
   * 분 안의 체결을 그 분 종가 하나로 곱하는 것이라 실제 값과 어긋난다 —
   * `screenQuote`가 KIS의 실제 `turnover`를 쓰는 것과 다르다. 그래도 필요한
   * 이유는, 비용 문턱은 **유동성 문턱을 통과한 종목에만** 적용되기 때문이다.
   * 유동성을 안 걸고 세면 거래가 거의 없는 종목이 `costHeavy` 비율을 부풀린다.
   *
   * 봉에 체결량이 없으면 `undefined`다. 0으로 채우면 "거래가 없었다"가 된다.
   */
  turnoverSoFar: number | undefined;
}

/** 오름차순 정렬 + 같은 분 중복 제거. 창을 여러 번 받아 이어 붙이면 겹친다. */
export function normalizeMinuteBars(bars: MinuteBar[]): MinuteBar[] {
  const byMinute = new Map<number, MinuteBar>();
  for (const bar of bars) {
    if (!Number.isFinite(bar.minute)) continue;
    if (!(bar.high > 0) || !(bar.low > 0) || !(bar.close > 0)) continue;
    byMinute.set(bar.minute, bar);
  }
  return [...byMinute.values()].sort((a, b) => a.minute - b.minute);
}

/**
 * 시각 t에서 본 앞뒤 변동폭.
 *
 * **경계는 `<=` / `>`다.** t분 봉은 t까지의 정보에 넣는다 — 그 봉이 끝나야
 * t시점의 고저가 확정되기 때문이다. 같은 봉을 양쪽에 넣으면 앞뒤가 겹쳐
 * "앞으로 벌어질 폭"이 부풀려진다.
 *
 * t 이전 봉이 하나도 없으면 잴 수 없다 — 값이 0인 것이 아니라 모르는 것이라
 * null이다.
 */
export function snapshotAt(bars: MinuteBar[], minute: number): RangeSnapshot | null {
  let high = -Infinity;
  let low = Infinity;
  let price = 0;
  let barsSoFar = 0;
  let aheadHigh = -Infinity;
  let aheadLow = Infinity;
  let barsAhead = 0;
  let turnover = 0;
  let hasVolume = false;

  for (const bar of bars) {
    if (bar.minute <= minute) {
      high = Math.max(high, bar.high);
      low = Math.min(low, bar.low);
      price = bar.close;
      barsSoFar += 1;
      if (Number.isFinite(bar.volume)) {
        turnover += bar.close * (bar.volume as number);
        hasVolume = true;
      }
    } else {
      aheadHigh = Math.max(aheadHigh, bar.high);
      aheadLow = Math.min(aheadLow, bar.low);
      barsAhead += 1;
    }
  }

  if (barsSoFar === 0 || !(price > 0)) return null;
  return {
    minute,
    price,
    rangeRate: (high - low) / price,
    // 뒤에 봉이 없으면 앞으로 벌어질 폭도 0이다. 모르는 것이 아니라 마감이다.
    aheadRangeRate: barsAhead === 0 ? 0 : (aheadHigh - aheadLow) / price,
    barsSoFar,
    barsAhead,
    turnoverSoFar: hasVolume ? turnover : undefined,
  };
}

/** 하루 전체 고저폭 ÷ 종가. 마감 시점의 `screenQuote`가 보는 값과 같다. */
export function fullDayRangeRate(bars: MinuteBar[]): number | null {
  if (bars.length === 0) return null;
  let high = -Infinity;
  let low = Infinity;
  for (const bar of bars) {
    high = Math.max(high, bar.high);
    low = Math.min(low, bar.low);
  }
  const close = bars[bars.length - 1].close;
  if (!(close > 0)) return null;
  return (high - low) / close;
}

/**
 * 목록 전체에 고르게 흩뿌려 n개를 고른다. 양 끝(가장 오래된 것·가장 최근 것)은 넣는다.
 *
 * 표본 날짜를 뒤에서 n개 자르면 **이어 붙은 며칠**이 된다. 같은 장세라 표본이
 * 늘어도 새로 아는 것이 별로 없다. 그래서 받아 온 구간 전체에 퍼뜨린다.
 *
 * `n = 1`을 따로 두는 이유: 예전에 `(len-1) × i / (n-1)`로 자리를 잡아 **n이 1일
 * 때 0/0 = NaN**이 됐고 `items[NaN]`이 `undefined`로 흘러 들어갔다. 조회는 정상
 * 종료되고 표본만 0건이라 **오류 없이 조용히 빈 결과**가 나왔다.
 */
export function spreadEvenly<T>(items: T[], n: number): T[] {
  if (n <= 0) return [];
  if (items.length <= n) return [...items];
  // 하나만 고를 때는 가장 최근 것. 과거 한 점보다 지금과 가까운 쪽이 쓸모 있다.
  if (n === 1) return [items[items.length - 1]];
  const picked: T[] = [];
  for (let i = 0; i < n; i += 1) {
    picked.push(items[Math.round(((items.length - 1) * i) / (n - 1))]);
  }
  return [...new Set(picked)];
}

/**
 * 순위 상관 (스피어만).
 *
 * 피어슨을 쓰지 않는다 — 상·하한가를 오간 종목 하나가 계수를 통째로 끌고
 * 간다. 여기서 묻는 것은 "지나간 폭이 큰 종목이 앞으로도 큰가"라는 순서
 * 문제라 순위로 재는 것이 맞다.
 *
 * 표본이 2개 미만이거나 한쪽이 전부 같은 값이면 NaN이다 — 0(무관)이 아니다.
 * 같은 값이 늘어서면 순서를 물을 수 없다.
 */
export function spearman(xs: number[], ys: number[]): number {
  const pairs = xs
    .map((x, index) => [x, ys[index]] as const)
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 2) return NaN;

  const rank = (values: number[]): number[] => {
    const order = values.map((value, index) => [value, index] as const).sort((a, b) => a[0] - b[0]);
    const ranks = new Array<number>(values.length);
    let i = 0;
    while (i < order.length) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
      // 같은 값은 평균 순위를 나눠 갖는다. 안 그러면 배열 순서가 순위가 된다.
      const shared = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) ranks[order[k][1]] = shared;
      i = j + 1;
    }
    return ranks;
  };

  const rx = rank(pairs.map(([x]) => x));
  const ry = rank(pairs.map(([, y]) => y));
  const mean = (values: number[]): number => values.reduce((sum, v) => sum + v, 0) / values.length;
  const mx = mean(rx);
  const my = mean(ry);
  let numerator = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < rx.length; i += 1) {
    numerator += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return NaN;
  return numerator / Math.sqrt(dx * dy);
}

/**
 * 분위수 (선형 보간).
 *
 * 평균을 쓰지 않는다 — 상·하한가를 오간 종목 하나가 전체를 끌고 간다.
 * 이 레포의 테마 등락률도 같은 이유로 중앙값을 대표값으로 쓴다.
 */
export function quantile(values: number[], q: number): number {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * Math.min(Math.max(q, 0), 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
