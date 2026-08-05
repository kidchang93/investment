/**
 * 후보 신호를 **같은 잣대로 한꺼번에** 잰다.
 *
 * ── 이 하네스가 지키는 것 (전부 이 레포가 당해 본 함정이다) ──────────────
 *
 * 1. **거울** — 상위 십분위를 사는 것과 하위 십분위를 사는 것을 나란히 잰다.
 *    진짜 우위면 부호가 갈리고, 아니면 같은 값이 나온다. 2026-08-04에
 *    `ma_cross`가 정확히 이렇게 무너졌다(신호 −0.0554%, 거울 −0.0592%).
 * 2. **날짜 군집** — 같은 날 종목들은 시장이 함께 움직여 독립이 아니다.
 *    날짜별 상위−하위 하나를 관측으로 센다. 순진한 t는 2배 넘게 부풀어 있었다.
 * 3. **전체 칸에 본페로니** — 신호 × 축 전부를 세어 문턱을 올린다. 하나씩 재면
 *    열 개 중 하나가 우연히 유의하고 그걸 "찾았다"고 믿는다.
 * 4. **비용을 나란히** — 우위가 왕복 0.43%를 넘는지가 진짜 질문이다.
 *    유의해도 비용에 못 미치면 매매 근거가 아니다.
 * 5. **평균과 중앙값 둘 다** — 평균만 크면 꼬리 몇 개가 만든 값이다.
 *    2026-08-04 수급 20일 축이 그랬다(평균 +1.722%, 중앙 +0.022%).
 *
 * ── 이 하네스가 **못** 지키는 것 ─────────────────────────────────────────
 *
 * - **표본 선정** — 어떤 종목을 넣을지는 부른 쪽이 정한다. 그게 오늘 결론을
 *   통째로 뒤집은 자리다(거래대금순 vs 코드순). 부른 쪽이 밝혀야 한다.
 * - **겹치는 선도수익률** — N일 축의 관측은 서로 겹친다. 날짜 군집 t도
 *   **부풀려진 쪽**이다. 여기서 못 넘기면 볼 것이 없다는 뜻이지, 넘겼다고
 *   확정된 것은 아니다.
 * - **생존 편향** — 상장폐지된 종목은 마스터에 없다.
 */

import type { DailyBar, SignalCandidate, SignalContext } from './signals.js';

export interface HarnessInput {
  /** 종목코드 → 날짜 오름차순 계열 */
  barsBySymbol: Map<string, DailyBar[]>;
  signals: SignalCandidate[];
  /** 잴 보유 기간(거래일) */
  horizons: number[];
  /** 줄을 세우려면 그날 이만큼은 있어야 한다 */
  minNamesPerDay: number;
  /** 상·하위 몇 분위로 자를지. 10이면 십분위 */
  buckets: number;
}

export interface HarnessCell {
  signalKey: string;
  horizon: number;
  /** 상위 − 하위 평균(%). 방향성 우위는 이 값의 절반이다 */
  spreadMean: number;
  spreadMedian: number;
  /** 날짜 군집 t */
  t: number;
  /** 관측에 쓴 날짜 수 */
  days: number;
  /** 상위 버킷 표본 수 */
  samples: number;
  /**
   * **시장을 뺀 뒤의** 상위−하위 평균(%)과 그 t.
   *
   * ── 왜 필요한가 (2026-08-04 결과를 보고) ────────────────────────────────
   *
   * 첫 실행에서 저변동성이 20일 축 우위 +5.807%(t 10.68)로 살아남았다. 그런데
   * 그 구간은 **평범한 종목이 20일에 −5.7% 빠지던 장**이었다. 시장이 빠지면
   * 고변동 종목이 더 크게 빠지므로 "저변동이 이긴다"가 **자동으로** 나온다.
   *
   * 그건 우위가 아니라 **노출**이다. 사고팔아서 번 것이 아니라 덜 위험한 것을
   * 들고 있어서 덜 잃은 것이고, 시장이 오르는 구간에서는 반대로 뒤집힌다.
   *
   * ── 어떻게 빼나 ──────────────────────────────────────────────────────────
   *
   * 날짜별 상위−하위(`spread`)를 같은 날 **전체 평균 수익**(시장 대용)에 회귀하고
   * **절편**을 본다. 기울기가 그 신호의 시장 민감도이고, 절편이 시장이 제자리일 때
   * 남는 몫이다.
   *
   * 전체 평균을 시장 대용으로 쓰는 것은 **어림**이다 — 진짜 시장 지수가 아니라
   * 이 표본의 동일가중 평균이다. 다만 같은 표본에서 나온 값이라 상위·하위가
   * 공유하는 것을 걷어내는 데는 그쪽이 오히려 맞다.
   */
  alpha: number;
  alphaT: number;
  /** 시장 민감도(기울기). 1에 가까우면 그 신호는 시장 방향에 얹혀 있다 */
  beta: number;
}

export interface HarnessResult {
  cells: HarnessCell[];
  /** 신호 × 축. 본페로니 문턱을 정하는 값 */
  cellCount: number;
  /** 이 칸 수에서의 |t| 문턱 (양측 5%) */
  bonferroniT: number;
}

const mean = (v: number[]): number => (v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length);

function median(v: number[]): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

/**
 * 본페로니 보정된 |t| 문턱 (양측 5%).
 *
 * 정규 근사를 쓴다 — 날짜가 100개 안팎이면 t분포와 큰 차이가 없고, 여기서 몇 %
 * 어긋나는 것보다 **문턱을 아예 안 올리는 것**이 훨씬 위험하다.
 */
export function bonferroniThreshold(cellCount: number): number {
  if (cellCount <= 1) return 1.96;
  // 역정규 근사(Beasley-Springer-Moro의 간단형). p = 0.05 / (2 * cells)
  const p = 0.05 / (2 * cellCount);
  const t = Math.sqrt(-2 * Math.log(p));
  return t - (2.30753 + 0.27061 * t) / (1 + 0.99229 * t + 0.04481 * t * t);
}

/**
 * 한 신호·한 축을 잰다.
 *
 * 그날 신호로 종목을 줄 세워 상·하위 버킷의 **선도수익률**을 모으고, 날짜마다
 * 상위−하위 하나를 남긴다. 그 날짜별 값들이 군집 t의 재료다.
 */
function evaluateCell(
  input: HarnessInput,
  signal: SignalCandidate,
  horizon: number,
): HarnessCell {
  const top: number[] = [];
  const bottom: number[] = [];
  const dailySpread: number[] = [];
  const dailyMarket: number[] = [];

  const days = new Set<string>();
  for (const bars of input.barsBySymbol.values()) for (const b of bars) days.add(b.tradingDay);

  for (const day of [...days].sort()) {
    const snapshot: Array<{ score: number; forward: number }> = [];
    for (const bars of input.barsBySymbol.values()) {
      const index = bars.findIndex((b) => b.tradingDay === day);
      if (index < 0) continue;
      // 점수를 내는 데 필요한 앞 봉이 모자라면 그 종목은 그날 빠진다.
      if (index < signal.minHistory) continue;
      // 선도수익률을 낼 뒤 봉이 없으면 뺀다. 없는 것을 0으로 채우지 않는다.
      if (index + horizon >= bars.length) continue;
      const ctx: SignalContext = { history: bars, index };
      const score = signal.score(ctx);
      if (score === undefined || !Number.isFinite(score)) continue;
      const entry = bars[index].close;
      const exit = bars[index + horizon].close;
      if (!(entry > 0) || !(exit > 0)) continue;
      snapshot.push({ score, forward: exit / entry - 1 });
    }
    if (snapshot.length < input.minNamesPerDay) continue;

    snapshot.sort((a, b) => b.score - a.score);
    const cut = Math.max(1, Math.floor(snapshot.length / input.buckets));
    const dayTop: number[] = [];
    const dayBottom: number[] = [];
    for (let i = 0; i < snapshot.length; i += 1) {
      if (i < cut) { top.push(snapshot[i].forward); dayTop.push(snapshot[i].forward); }
      else if (i >= snapshot.length - cut) { bottom.push(snapshot[i].forward); dayBottom.push(snapshot[i].forward); }
    }
    dailySpread.push((mean(dayTop) - mean(dayBottom)) * 100);
    // 같은 날 전체 평균. 시장 대용이다 — 상위·하위가 함께 타는 것을 걷어낼 재료다.
    dailyMarket.push(mean(snapshot.map((s) => s.forward)) * 100);
  }

  const dm = mean(dailySpread);
  const variance =
    dailySpread.length > 1
      ? dailySpread.reduce((a, v) => a + (v - dm) ** 2, 0) / (dailySpread.length - 1)
      : 0;
  const se = variance > 0 ? Math.sqrt(variance / dailySpread.length) : 0;

  const { alpha, alphaT, beta } = regressOnMarket(dailySpread, dailyMarket);

  return {
    signalKey: signal.key,
    horizon,
    spreadMean: (mean(top) - mean(bottom)) * 100,
    spreadMedian: (median(top) - median(bottom)) * 100,
    t: se > 0 ? dm / se : 0,
    days: dailySpread.length,
    samples: top.length,
    alpha,
    alphaT,
    beta,
  };
}

/**
 * 날짜별 상위−하위를 같은 날 시장 수익에 회귀한다.
 *
 * 절편(`alpha`)이 **시장이 제자리일 때 남는 몫**이고, 기울기(`beta`)가 시장
 * 방향에 얼마나 얹혀 있는지다. 신호가 진짜 우위면 `alpha`가 살아남고,
 * 노출일 뿐이면 `alpha`가 0으로 무너지면서 `beta`만 남는다.
 *
 * **이 t도 부풀려진 쪽이다** — 겹치는 선도수익률은 여기서도 안 없어진다.
 */
function regressOnMarket(
  spread: number[],
  market: number[],
): { alpha: number; alphaT: number; beta: number } {
  const n = Math.min(spread.length, market.length);
  if (n < 3) return { alpha: 0, alphaT: 0, beta: 0 };
  const my = mean(spread.slice(0, n));
  const mx = mean(market.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (market[i] - mx) * (spread[i] - my);
    sxx += (market[i] - mx) ** 2;
  }
  const beta = sxx > 0 ? sxy / sxx : 0;
  const alpha = my - beta * mx;
  // 잔차로 절편의 표준오차를 낸다.
  let sse = 0;
  for (let i = 0; i < n; i += 1) sse += (spread[i] - (alpha + beta * market[i])) ** 2;
  const mse = n > 2 ? sse / (n - 2) : 0;
  const seAlpha = mse > 0 && sxx > 0 ? Math.sqrt(mse * (1 / n + (mx * mx) / sxx)) : 0;
  return { alpha, alphaT: seAlpha > 0 ? alpha / seAlpha : 0, beta };
}

export function runSignalHarness(input: HarnessInput): HarnessResult {
  const cells: HarnessCell[] = [];
  for (const signal of input.signals) {
    for (const horizon of input.horizons) {
      cells.push(evaluateCell(input, signal, horizon));
    }
  }
  return {
    cells,
    cellCount: cells.length,
    bonferroniT: bonferroniThreshold(cells.length),
  };
}
