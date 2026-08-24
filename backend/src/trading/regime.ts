/**
 * 시장 국면 — **추세장인가 횡보장인가.**
 *
 * ── 왜 생겼나 (2026-08-24) ───────────────────────────────────────────────
 *
 * 트레이딩뷰 인기 전략을 훑었더니 1위가 `TrendShift | Supertrend + ADX
 * Regime-Adaptive`였다. **국면에 따라 규칙을 바꾸는 것**이 그 전략의 핵심이고,
 * 이 레포에는 국면이라는 개념이 아예 없다.
 *
 * 그리고 같은 날 실측이 그 질문을 던졌다 — 추세 계열(`donchian20` ·
 * `maCross2060`)이 21년 15창에서 **한 창도 못 뽑혔다.** 가설 둘이 갈린다:
 *
 *   ① 한국 주식 일봉에 추세 우위가 없다
 *   ② 추세장과 횡보장을 **섞어서 쟀다** — 섞으면 서로 상쇄된다
 *
 * ②가 맞다면 국면을 갈라 재는 순간 보여야 한다. 이 모듈이 그 갈래를 만든다.
 *
 * ── ★ ADX가 아니라 효율성 비율인 이유 ───────────────────────────────────
 *
 * ADX는 **고가·저가가 있어야** 계산된다(+DM/−DM이 고저의 차이다). 그런데 시장
 * 국면을 재려면 지수가 필요한데, 이 레포에는 지수 일봉이 없고 **유니버스
 * 동일가중 수익률**로 지수를 세운다 — 거기엔 고가·저가가 없다.
 *
 * 카우프만의 효율성 비율(Efficiency Ratio)은 **종가만으로 같은 것을 묻는다**:
 *
 *     ER = |끝 − 시작| / Σ|하루하루의 움직임|
 *
 * 한 방향으로 쭉 갔으면 분자와 분모가 같아 1에 가깝고, 왔다 갔다 했으면 분자가
 * 작아져 0에 가깝다. ADX가 "방향성 지수"로 재려는 것과 같은 질문이다.
 *
 * ── 이 모듈이 지키는 것 ──────────────────────────────────────────────────
 *
 * ★ **그날까지의 과거만 본다.** 국면 판정이 미래를 보면 그것으로 가른 모든
 *   측정이 거짓이 된다. 문턱도 마찬가지라 고정값을 박지 않고 **전일까지의
 *   중앙값**으로 가른다 — 고정값은 "그 시절 시장이 어땠는지"를 이미 아는
 *   사람만 고를 수 있는 값이다.
 */

import { localAt, type Panel, type UniverseMask } from './panel.js';

/** 국면 둘. `unknown`은 아직 판정할 표본이 모자란 날이다. */
export type Regime = 'trend' | 'chop' | 'unknown';

export interface RegimeSpec {
  /** 효율성 비율을 보는 창(거래일). 기본 20 */
  window: number;
  /**
   * 중앙값을 만들기 시작하는 최소 표본(일).
   *
   * 너무 적으면 처음 몇 종목의 우연이 문턱을 정한다. 250이면 1년치다.
   */
  minHistory: number;
}

export const DEFAULT_REGIME_SPEC: RegimeSpec = { window: 20, minHistory: 250 };

export interface RegimeSeries {
  /** 날짜별 국면. `panel.days`와 같은 길이 */
  regimes: Regime[];
  /** 날짜별 효율성 비율. 못 재면 `NaN` */
  ratios: Float64Array;
  /** 날짜별 문턱(전일까지의 중앙값). 못 만들면 `NaN` */
  thresholds: Float64Array;
  /** 날짜별 유니버스 동일가중 로그수익률. 못 재면 `NaN` */
  returns: Float64Array;
  trendDays: number;
  chopDays: number;
  unknownDays: number;
}

/**
 * 날짜별 유니버스 **동일가중 로그수익률**.
 *
 * ★ 시가총액가중이 아니라 동일가중인 이유는 하네스의 기준선과 같은 것을 써야
 * 하기 때문이다 — `walkForward`의 다리 값이 `상위분위 − 그날 유니버스 EW`다.
 * 여기서 다른 지수를 쓰면 국면과 성과가 서로 다른 시장을 가리킨다.
 *
 * ★ **전일 봉이 그 종목 안에 있어야 센다**(`i < 1`이면 뺀다). 없는 것을 0으로
 * 채우면 상장 첫날이 "안 움직인 날"이 되어 지수를 눌러버린다.
 */
export function buildMarketReturns(panel: Panel, universe: UniverseMask): Float64Array {
  const dayCount = panel.days.length;
  const returns = new Float64Array(dayCount).fill(Number.NaN);
  for (let d = 1; d < dayCount; d += 1) {
    const from = universe.dayOffsets[d];
    const to = universe.dayOffsets[d + 1];
    let sum = 0;
    let count = 0;
    for (let m = from; m < to; m += 1) {
      const symbol = universe.dayMembers[m];
      const i = localAt(panel, d, symbol);
      if (i < 1) continue;
      const prev = panel.close[symbol][i - 1];
      const now = panel.close[symbol][i];
      if (!(prev > 0) || !(now > 0)) continue;
      sum += Math.log(now / prev);
      count += 1;
    }
    if (count > 0) returns[d] = sum / count;
  }
  return returns;
}

/**
 * 카우프만 효율성 비율 — `at`에서 뒤로 `window`일.
 *
 * 로그수익률의 누적이 지수이므로 분자는 그 구간 로그수익률의 **합의 절대값**,
 * 분모는 **절대값의 합**이다. 구간에 못 잰 날이 하나라도 있으면 `undefined`다 —
 * 빼고 계산하면 날 수가 다른 구간끼리 비교하게 된다.
 */
export function efficiencyRatio(
  returns: Float64Array,
  at: number,
  window: number,
): number | undefined {
  const from = at - window + 1;
  if (from < 0 || at >= returns.length) return undefined;
  let net = 0;
  let gross = 0;
  for (let i = from; i <= at; i += 1) {
    const value = returns[i];
    if (!Number.isFinite(value)) return undefined;
    net += value;
    gross += Math.abs(value);
  }
  // 20일 내내 한 발짝도 안 움직였으면 비를 만들 수 없다(0으로 나눈다).
  if (!(gross > 0)) return undefined;
  return Math.abs(net) / gross;
}

/**
 * 정렬을 유지하는 삽입. 중앙값을 매일 다시 정렬해서 구하지 않으려고 쓴다.
 *
 * 5,000일이면 삽입 총비용이 O(n²)=2,500만인데, 매일 전체를 정렬하면
 * O(n² log n)이다. 이 규모에서는 삽입 쪽이 충분히 빠르다.
 */
function insertSorted(sorted: number[], value: number): void {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  sorted.splice(lo, 0, value);
}

/** 정렬된 배열의 중앙값. 짝수면 가운데 둘의 평균. */
function medianOfSorted(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 날짜별 국면을 정한다.
 *
 * ★ **문턱은 전일까지의 중앙값이다.** 오늘 값을 문턱에 넣으면 자기 자신과
 * 비교하는 셈이고(한 점이라 영향은 작지만 순환은 순환이다), 무엇보다 "재기 전에
 * 정한 규칙"이라고 말할 수 없게 된다.
 *
 * ★ 중앙값이라 **표본이 자동으로 절반씩 갈린다.** 고정값(예: ER > 0.3)으로
 * 가르면 한쪽이 텅 비는 시기가 생기고, 그러면 국면별 비교가 표본 크기 차이를
 * 보는 일이 된다.
 */
export function buildRegimeSeries(
  panel: Panel,
  universe: UniverseMask,
  spec: RegimeSpec = DEFAULT_REGIME_SPEC,
): RegimeSeries {
  const returns = buildMarketReturns(panel, universe);
  const dayCount = panel.days.length;
  const ratios = new Float64Array(dayCount).fill(Number.NaN);
  const thresholds = new Float64Array(dayCount).fill(Number.NaN);
  const regimes: Regime[] = new Array(dayCount).fill('unknown');

  const seen: number[] = [];
  let trendDays = 0;
  let chopDays = 0;
  let unknownDays = 0;

  for (let d = 0; d < dayCount; d += 1) {
    const ratio = efficiencyRatio(returns, d, spec.window);
    if (ratio === undefined) {
      unknownDays += 1;
      continue;
    }
    ratios[d] = ratio;
    // ★ 문턱을 먼저 읽고 나서 오늘 값을 넣는다. 순서가 뒤바뀌면 오늘이 문턱에 든다.
    if (seen.length >= spec.minHistory) {
      const threshold = medianOfSorted(seen);
      thresholds[d] = threshold;
      if (ratio >= threshold) {
        regimes[d] = 'trend';
        trendDays += 1;
      } else {
        regimes[d] = 'chop';
        chopDays += 1;
      }
    } else {
      unknownDays += 1;
    }
    insertSorted(seen, ratio);
  }

  return { regimes, ratios, thresholds, returns, trendDays, chopDays, unknownDays };
}

/**
 * 국면 하나만 1인 마스크. `walkForward`가 학습·검증 양쪽에서 이걸로 날을 거른다.
 *
 * `unknown`은 **어느 쪽에도 안 들어간다** — 판정할 수 없는 날을 한쪽에 몰아넣으면
 * 그 국면의 표본에 성질이 다른 날이 섞인다.
 */
export function regimeMaskOf(series: RegimeSeries, keep: 'trend' | 'chop'): Uint8Array {
  const mask = new Uint8Array(series.regimes.length);
  for (let d = 0; d < series.regimes.length; d += 1) {
    mask[d] = series.regimes[d] === keep ? 1 : 0;
  }
  return mask;
}
