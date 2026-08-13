/**
 * Walk-forward 측정 엔진. **찾는 곳과 재는 곳을 시간으로 가른다.**
 *
 * ── 이 엔진이 고치는 두 결함 (2026-08-12) ────────────────────────────────
 *
 * **(가) 실행 불가능한 진입.** 옛 하네스는 그날 종가로 점수를 내고 **그 종가로
 * 샀다**. 종가를 알 수 있는 시각은 15:30이고 우리가 살 수 있는 가장 이른 시각은
 * 다음 날 09:00이다. 리스크 룰이 시장가·시간외를 막고 있어 종가 동시체결은
 * 불가능하다. 원장 176줄이 전부 그 위에 있다.
 *
 *   → 여기서는 `entry = 익일 시가`, `exit = 그 h일 뒤 시가`가 기본이다.
 *     종가→종가(`sameClose`)도 낼 수 있게 남겨 **차이를 크기로** 본다.
 *
 * **(나) 계산량.** `bars.findIndex(...)`가 날짜 루프 안에 있어 21년 × 3,900종목이면
 * 1.5e12다. 자리를 `Panel.localIndex`로 미리 세우고, **셀마다 한 번만 훑는다.**
 *
 * ── 구현의 열쇠 — 한 번 훑고 캐시한다 ────────────────────────────────────
 *
 * 셀 `(신호, 축)`의 그날 십분위 구성은 **그날 횡단면만으로** 정해진다. 학습 창이
 * 확장이든 이동이든 안 바뀐다. 그러니 창 30개 × 셀 35개를 다시 훑을 이유가 없다 —
 * 진입일별 계열(`CellSeries`)을 한 번 만들어 두고, 학습·검증은 전부 그 계열의
 * **구간 집계**다.
 *
 * ── 판정이 넘어야 할 것 ──────────────────────────────────────────────────
 *
 * | 검정 | 무엇을 잡나 |
 * |------|------|
 * | `tNaive` | 아무것도 안 잡는다. 나머지와 견주는 기준선이다 |
 * | `tNeweyWest` | **겹치는 선도수익률.** 매일 진입하고 h일 들면 관측이 h겹 겹친다 |
 * | `tBlockBootstrap` | 정규성 가정 없이. 꼬리가 두꺼운 계열에서 갈린다 |
 * | `tNonOverlap` | 겹침을 아예 버리고 h일마다 하나만 |
 * | `tMonthCluster` | 같은 **달** 안에서 관측이 함께 움직이는 몫 |
 * | `tYearCluster` | 같은 **해** 안에서 시장이 통째로 한 방향이었던 몫 |
 *
 * `verdictT`는 **여섯 중 |t| 최소**다. 가장 너그러운 검정을 골라 쓰는 것이 이
 * 일에서 가장 흔한 자기기만이라, 고를 수 없게 값으로 못 박는다.
 *
 * ★ **군집 둘이 2026-08-13에 붙었다.** Newey-West는 lag를 `2h−1`까지만 보므로
 * h=1이면 사실상 아무것도 안 잡는다. 실측에서 h=1·비용 0의 순진 t가 10.09,
 * 달군집 10.18인데 **해군집은 5.60**이었다 — 넷만 쓰면 판정 t가 **1.8배 부푼다.**
 *
 * ── 블록 A와 블록 B는 다른 질문이다 (2026-08-13) ─────────────────────────
 *
 * | 블록 | 묻는 것 | 어떻게 |
 * |------|------|------|
 * | A | **정보가 있나** | 비용 0 · 기권 없음 · **축 고정** · 위약 귀무분포로 판정 |
 * | B | **비용을 넘나** | 기권 없음 · 비용 여럿 · **t를 쓰지 않고 손익분기표** |
 *
 * 블록 A는 `runBlockA`로만 돈다. `BlockASpec`이 `abstainIfNegative: false`를
 * **타입으로** 못 박아서 기권을 켤 수가 없다 — 기권 + 비용 0.54%가 15창 중 12창을
 * 현금으로 만들어 **진입 743건이 전부 2011~2013에** 몰려 있었다. 2019년 이후
 * 표본이 0인 채로 판정 t −1.38이 나왔었다.
 *
 * ★ **학습 비용과 판정 비용은 따로 든다**(`selectionCostPct` / `evalCostPct`).
 * 둘이 다르면 결과가 그 사실을 값으로 들고 다니고 판정문이 반드시 찍는다.
 * 학습만 싸게 잡으면 비용을 못 넘는 칸이 순위에 올라온다.
 *
 * ── 반증 셋은 검정 수에 세지 않는다 ──────────────────────────────────────
 *
 * 거울 · 위약 · `runAntiSelection`(학습 최하위 고르기)은 **떨어뜨릴 수만 있다.**
 * 무언가를 찾아낼 수 없으므로 다중검정 부담이 아니다.
 *
 * ★ **`runAntiSelection`이 가장 강한 한 방이다.** 학습 순위에 정보가 있다면
 * 최하위를 고르는 절차는 **크기가 비슷한 음수**여야 한다. 0 근처면 학습 순위가
 * 표본 밖으로 아무것도 안 넘긴다는 뜻이고, 그러면 top1의 양수도 순위가 만든 것이
 * 아니다. ★ **다만 축이 섞이면 읽을 수 없다** — 2026-08-13에 안티셀렉션 −46.01이
 * "학습 순위에 정보가 있다"로 읽혔는데, 15창이 전부 h=1을 골랐고 연알파 −159.28%
 * 중 −136.08%가 **비용 상수**였다. `netIR`의 `√(252/h)`가 h와 무관한 비용에
 * 곱해져 h=1을 못 박은 것이다. 그래서 반증은 **축 고정 + 비용 0**에서 돌리고,
 * 결과가 `selectedHorizons`(고른 칸의 축 구성)를 반드시 들고 다닌다.
 *
 * ── 거울이 둘인 이유 ─────────────────────────────────────────────────────
 *
 * `runBottomLegProcedure`는 **선택에도 평가에도** 하위분위를 쓴다 — "하위분위가
 * 학습에서 제일 좋았던 칸"을 고르므로 본절차와 **다른 칸**을 고른다. 그건 거울이
 * 아니라 **다른 전략**이다. 진짜 거울은 `runEvalLegMirror`로, **선택은 본절차와
 * 똑같이 두고 평가 다리만 뒤집는다.** 둘 다 내되 이름과 해석을 갈라 읽는다.
 *
 * 이 모듈은 DB도 KIS도 부르지 않는다. 순수 계산이라 시험이 네트워크 없이 돈다.
 */

import { buildScoreMatrix, quickSelect, type Panel, type UniverseMask } from './panel.js';
import type { SignalCandidate } from './signals.js';

/**
 * 무엇으로 사고파나.
 *
 *   `nextOpen`   신호일 **다음 봉의 시가**로 사고, h봉 뒤 시가로 판다. **기본값**
 *   `sameClose`  신호일 종가로 사고 h봉 뒤 종가로 판다. **실행 불가능하다** —
 *                옛 값과 견주려고만 남겨 둔다
 */
export type EntryBasis = 'nextOpen' | 'sameClose';

/**
 * 셀 `(신호, 축)`의 **진입일별 계열.** 학습·검증은 전부 이것의 구간 집계다.
 *
 * 배열은 전부 같은 길이이고 `dayIndex` 오름차순이다.
 */
export interface CellSeries {
  signalKey: string;
  horizon: number;
  entryBasis: EntryBasis;
  /** 신호를 낸 날의 **패널 날짜 index**. 진입은 그 다음 봉이다 */
  dayIndex: Int32Array;
  /** (상위분위 EW − 그날 유니버스 EW) h일 초과(%). **비용 전** */
  topLeg: Float64Array;
  /**
   * ★ **거울.** 하위분위로 같은 것을 잰다. 지금 없어서 두 다리 부호를 못 봤다.
   * 진짜 우위면 부호가 갈리고, 아니면 둘이 같은 값이 나온다.
   */
  botLeg: Float64Array;
  /** 그날 유니버스 EW의 h일 수익(%) */
  market: Float64Array;
  /** 그날 줄 세운 종목 수 */
  names: Int32Array;
  /** 상위분위 안에서 점수가 겹치는 정도 (0~1). 1에 가까우면 십분위가 임의다 */
  tieShare: Float64Array;
  /** ★ 청산봉이 없어 마지막 봉으로 나간 건수. **지금은 그냥 버린다** */
  truncated: Int32Array;
  /** 진입할 봉 자체가 없어 못 산 건수(폐지·장기정지). 버리는 것과 다르다 */
  noEntry: Int32Array;
  /** 진입 뒤 종목이 모자라 통째로 버린 날짜 수 */
  daysDroppedAfterEntry: number;
}

/** 한 종목·한 자리의 h일 성과. */
export interface Leg {
  ok: boolean;
  value: number;
  truncated: boolean;
}

/**
 * 진입·청산 가격을 고르고 수익률을 낸다.
 *
 * ★ **청산봉이 없으면 버리지 않고 마지막 봉으로 나간다.** 옛 하네스는 `continue`로
 * 버렸는데, 그러면 상장폐지·장기정지로 끝난 매매가 통째로 사라진다 — 지는 쪽만
 * 골라 안 세는 셈이다. 강제청산하고 몇 건인지 센다.
 */
export function legReturn(
  panel: Panel,
  symbolIndex: number,
  localIndex: number,
  horizon: number,
  entryBasis: EntryBasis,
): Leg {
  const n = panel.barCount[symbolIndex];
  const prices = entryBasis === 'nextOpen' ? panel.open[symbolIndex] : panel.close[symbolIndex];
  const entryLocal = entryBasis === 'nextOpen' ? localIndex + 1 : localIndex;
  if (entryLocal >= n) return { ok: false, value: 0, truncated: false };

  let exitLocal = entryLocal + horizon;
  let truncated = false;
  if (exitLocal >= n) {
    exitLocal = n - 1;
    truncated = true;
  }
  // 사자마자 계열이 끝나면 잴 수가 없다. 0으로 채우면 "본전이었다"는 거짓이다.
  if (exitLocal <= entryLocal) return { ok: false, value: 0, truncated: false };

  const entry = prices[entryLocal];
  const exit = prices[exitLocal];
  if (!(entry > 0) || !(exit > 0)) return { ok: false, value: 0, truncated: false };
  return { ok: true, value: (exit / entry - 1) * 100, truncated };
}

/** 상위분위 안에서 점수가 겹치는 정도. 1에 가까우면 그 십분위는 사실상 임의다. */
function tieShareOf(values: Float64Array, count: number): number {
  if (count <= 1) return 0;
  const sorted = values.slice(0, count).sort();
  let distinct = 1;
  for (let i = 1; i < count; i += 1) if (sorted[i] !== sorted[i - 1]) distinct += 1;
  return 1 - distinct / count;
}

/**
 * 점수판 하나로 한 축의 계열을 만든다. **셀당 한 번 훑는다.**
 *
 * 점수는 축과 무관하므로 축이 여럿이면 `buildCellSeriesSet`이 낫다 —
 * 점수판을 한 번만 만든다.
 */
export function buildCellSeriesFromScores(
  panel: Panel,
  scores: Float64Array,
  signalKey: string,
  horizon: number,
  universe: UniverseMask,
  entryBasis: EntryBasis,
  buckets: number,
  minNamesPerDay: number,
): CellSeries {
  const symbolCount = panel.symbols.length;
  const dayCount = panel.days.length;

  const dayIndex: number[] = [];
  const topLeg: number[] = [];
  const botLeg: number[] = [];
  const market: number[] = [];
  const names: number[] = [];
  const tieShare: number[] = [];
  const truncated: number[] = [];
  const noEntry: number[] = [];
  let daysDroppedAfterEntry = 0;

  // 하루치 작업 버퍼. 날마다 새로 만들면 5,288번 할당한다.
  const dayScores = new Float64Array(symbolCount);
  const dayForward = new Float64Array(symbolCount);
  const scratch = new Float64Array(symbolCount);
  const topScores = new Float64Array(symbolCount);

  for (let d = 0; d < dayCount; d += 1) {
    const from = universe.dayOffsets[d];
    const to = universe.dayOffsets[d + 1];
    if (to <= from) continue;

    let count = 0;
    let missedEntries = 0;
    let truncatedHere = 0;
    for (let m = from; m < to; m += 1) {
      const s = universe.dayMembers[m];
      const score = scores[d * symbolCount + s];
      if (!Number.isFinite(score)) {
        missedEntries += 1;
        continue;
      }
      const local = panel.localIndex[d * symbolCount + s];
      if (local < 0) {
        missedEntries += 1;
        continue;
      }
      const leg = legReturn(panel, s, local, horizon, entryBasis);
      if (!leg.ok) {
        missedEntries += 1;
        continue;
      }
      dayScores[count] = score;
      dayForward[count] = leg.value;
      if (leg.truncated) truncatedHere += 1;
      count += 1;
    }

    if (count < minNamesPerDay || count < buckets * 2) {
      if (count > 0) daysDroppedAfterEntry += 1;
      continue;
    }

    const cut = Math.max(1, Math.floor(count / buckets));
    scratch.set(dayScores.subarray(0, count));
    const topThreshold = quickSelect(scratch, count, count - cut);
    scratch.set(dayScores.subarray(0, count));
    const botThreshold = quickSelect(scratch, count, cut - 1);

    let topSum = 0;
    let topCount = 0;
    let botSum = 0;
    let botCount = 0;
    let allSum = 0;
    for (let i = 0; i < count; i += 1) {
      allSum += dayForward[i];
      // 동점이 경계에 걸리면 앞에서부터 자리를 채운다 — 종목코드 순이라 재현된다.
      if (dayScores[i] >= topThreshold && topCount < cut) {
        topScores[topCount] = dayScores[i];
        topSum += dayForward[i];
        topCount += 1;
      }
      if (dayScores[i] <= botThreshold && botCount < cut) {
        botSum += dayForward[i];
        botCount += 1;
      }
    }
    if (topCount === 0 || botCount === 0) {
      daysDroppedAfterEntry += 1;
      continue;
    }

    const marketMean = allSum / count;
    dayIndex.push(d);
    topLeg.push(topSum / topCount - marketMean);
    botLeg.push(botSum / botCount - marketMean);
    market.push(marketMean);
    names.push(count);
    tieShare.push(tieShareOf(topScores, topCount));
    truncated.push(truncatedHere);
    noEntry.push(missedEntries);
  }

  return {
    signalKey,
    horizon,
    entryBasis,
    dayIndex: Int32Array.from(dayIndex),
    topLeg: Float64Array.from(topLeg),
    botLeg: Float64Array.from(botLeg),
    market: Float64Array.from(market),
    names: Int32Array.from(names),
    tieShare: Float64Array.from(tieShare),
    truncated: Int32Array.from(truncated),
    noEntry: Int32Array.from(noEntry),
    daysDroppedAfterEntry,
  };
}

/** 신호 하나·축 하나. 점수판을 그 자리에서 만든다. */
export function buildCellSeries(
  panel: Panel,
  signal: SignalCandidate,
  horizon: number,
  universe: UniverseMask,
  entryBasis: EntryBasis,
  buckets = 10,
  minNamesPerDay = 200,
): CellSeries {
  const scores = buildScoreMatrix(panel, signal);
  return buildCellSeriesFromScores(
    panel, scores, signal.key, horizon, universe, entryBasis, buckets, minNamesPerDay,
  );
}

/**
 * 신호 하나 · 축 여럿. **점수판을 한 번만 만든다** — 점수는 축과 무관하다.
 *
 * 점수판 하나가 5,288 × 3,900 × 8B ≈ 165MB라 신호를 한 번에 하나만 살려 둔다.
 */
export function buildCellSeriesSet(
  panel: Panel,
  signal: SignalCandidate,
  horizons: number[],
  universe: UniverseMask,
  entryBasis: EntryBasis,
  buckets = 10,
  minNamesPerDay = 200,
): CellSeries[] {
  const scores = buildScoreMatrix(panel, signal);
  return horizons.map((horizon) =>
    buildCellSeriesFromScores(
      panel, scores, signal.key, horizon, universe, entryBasis, buckets, minNamesPerDay,
    ));
}

/* ── 통계 ────────────────────────────────────────────────────────────── */

export function meanOf(values: ArrayLike<number>): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < values.length; i += 1) total += values[i];
  return total / values.length;
}

/** 표본 표준편차(n−1). 표본이 둘 미만이면 0 — 0으로 나누지 않는다. */
export function sdOf(values: ArrayLike<number>): number {
  if (values.length < 2) return 0;
  const m = meanOf(values);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) sum += (values[i] - m) ** 2;
  return Math.sqrt(sum / (values.length - 1));
}

/** 순진한 t. **아무것도 안 잡는다** — 나머지와 견주는 기준선이다. */
export function naiveT(values: ArrayLike<number>): number {
  if (values.length < 3) return 0;
  const sd = sdOf(values);
  if (!(sd > 0)) return 0;
  return meanOf(values) / (sd / Math.sqrt(values.length));
}

/**
 * Newey-West t. **겹치는 선도수익률을 잡는다.**
 *
 * 매일 진입하고 h일 들고 있으면 이웃한 관측이 h−1일을 공유한다. 순진한 t는
 * 그 겹침을 못 봐서 **√h만큼 부풀어** 있다.
 *
 * ★ **대역폭은 `2h−1`이다.** Bartlett 커널은 잘라 낸 만큼 분산을 덜 세는데,
 * `h−1`에서 자르면 h=5일 때 참값의 68%만 잡는다(계산해 보면 `h + (h−1)(2h−1)/3`
 * 대 `h²`). `2h−1`로 늘리면 84%까지 온다 — 그래도 **조금 덜 세는 쪽**이라
 * 이 t는 여전히 너그러운 편이다.
 *
 * 분산 추정이 음수로 나오면 0을 준다. 못 잰 것을 큰 t로 바꾸지 않는다.
 */
export function neweyWestT(values: ArrayLike<number>, bandwidth: number): number {
  const n = values.length;
  if (n < 3) return 0;
  const m = meanOf(values);
  let s = 0;
  for (let i = 0; i < n; i += 1) s += (values[i] - m) ** 2;
  s /= n;
  const maxLag = Math.min(Math.max(0, Math.floor(bandwidth)), n - 1);
  for (let lag = 1; lag <= maxLag; lag += 1) {
    let gamma = 0;
    for (let t = lag; t < n; t += 1) gamma += (values[t] - m) * (values[t - lag] - m);
    gamma /= n;
    s += 2 * (1 - lag / (maxLag + 1)) * gamma;
  }
  if (!(s > 0)) return 0;
  return m / Math.sqrt(s / n);
}

/** 재현 가능한 난수. 시드가 같으면 언제나 같은 순서다. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 원형 블록 부트스트랩 t. **정규성을 가정하지 않는다.**
 *
 * 블록째 다시 뽑아 평균의 분포를 만들고, 그 분포의 표준편차를 표준오차로 쓴다.
 * 꼬리가 두꺼운 계열에서 순진한 t와 갈린다.
 */
export function blockBootstrapT(
  values: ArrayLike<number>,
  blockLength: number,
  draws = 2_000,
  seed = 20260812,
): number {
  const n = values.length;
  if (n < 3) return 0;
  const block = Math.max(1, Math.min(Math.floor(blockLength), n));
  const random = mulberry32(seed);
  const observed = meanOf(values);
  const blocksPerDraw = Math.ceil(n / block);
  const means = new Float64Array(draws);
  for (let d = 0; d < draws; d += 1) {
    let total = 0;
    let taken = 0;
    for (let b = 0; b < blocksPerDraw && taken < n; b += 1) {
      const start = Math.floor(random() * n);
      for (let i = 0; i < block && taken < n; i += 1) {
        total += values[(start + i) % n];
        taken += 1;
      }
    }
    means[d] = total / taken;
  }
  const se = sdOf(means);
  if (!(se > 0)) return 0;
  return observed / se;
}

/**
 * 겹침을 아예 버린 t. `stride`마다 하나씩만 본다.
 *
 * 시작 자리마다 부표본이 다르므로 **전부 재서 평균**한다. 하나만 쓰면 어느
 * 자리에서 시작했느냐가 결과를 흔들고, 가장 좋은 자리를 고르면 그게 곧 뒤지기다.
 */
export function nonOverlapT(values: ArrayLike<number>, stride: number): number {
  const step = Math.max(1, Math.floor(stride));
  if (values.length < step * 3) return 0;
  const ts: number[] = [];
  for (let offset = 0; offset < step; offset += 1) {
    const sub: number[] = [];
    for (let i = offset; i < values.length; i += step) sub.push(values[i]);
    if (sub.length >= 3) ts.push(naiveT(sub));
  }
  return ts.length === 0 ? 0 : meanOf(ts);
}

/**
 * **군집 표준오차.** 같은 군집 안 관측이 서로 얽혀 있을 때 쓴다.
 *
 * ★ **왜 필요한가 (2026-08-13).** 겹치는 선도수익률은 Newey-West가 잡지만,
 * **같은 해에 시장이 통째로 한 방향이었던 것**은 못 잡는다 — 대역폭이 `2h−1`이라
 * h=1이면 lag 1까지밖에 안 본다. 그 상관은 수백 거래일까지 간다. 해 단위로 묶어
 * 재면 그 몫이 드러난다(실측: 순진 10.09 · 달군집 10.18 · **해군집 5.60**).
 *
 * 군집 합의 제곱을 더하는 표준적인 군집 강건 분산이고, 군집 수가 적을 때 분산을
 * 덜 세지 않도록 `G/(G−1)`을 곱한다.
 *
 * ★ **군집이 셋 미만이면 표준오차 0을 준다.** 군집이 하나면 `Σ(y−ȳ)=0`이라
 * 표준오차가 0이 되어 t가 무한대로 튄다 — 못 잰 것을 큰 t로 바꾸지 않는다.
 * 부른 쪽은 `clusters`를 보고 "못 쟀다"와 "0이다"를 가를 수 있다.
 */
export function clusterMeanSe(
  values: ArrayLike<number>,
  clusterIds: ArrayLike<number>,
): { mean: number; se: number; clusters: number } {
  const n = Math.min(values.length, clusterIds.length);
  if (n < 3) return { mean: 0, se: 0, clusters: 0 };
  let total = 0;
  for (let i = 0; i < n; i += 1) total += values[i];
  const mean = total / n;

  const sums = new Map<number, number>();
  for (let i = 0; i < n; i += 1) {
    const id = clusterIds[i];
    sums.set(id, (sums.get(id) ?? 0) + (values[i] - mean));
  }
  const clusters = sums.size;
  if (clusters < 3) return { mean, se: 0, clusters };

  let squared = 0;
  for (const sum of sums.values()) squared += sum * sum;
  const variance = (squared * clusters) / ((clusters - 1) * n * n);
  if (!(variance > 0)) return { mean, se: 0, clusters };
  return { mean, se: Math.sqrt(variance), clusters };
}

/** 군집 강건 t. 못 재면 0이다 — 큰 t로 바꾸지 않는다. */
export function clusterT(values: ArrayLike<number>, clusterIds: ArrayLike<number>): number {
  const { mean, se } = clusterMeanSe(values, clusterIds);
  return se > 0 ? mean / se : 0;
}

/**
 * 두 집단 평균 차의 t (Welch).
 *
 * ★ **겹침을 안 잡으므로 너그러운 쪽이다.** 기권 채점에만 쓴다 — 거기서 나온 값이
 * 이미 작으면(실측 0.12) 제대로 잡아도 더 작아질 뿐이라 결론이 안 바뀐다.
 * 판정 t 자리에는 쓰지 않는다.
 */
export function welchT(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length < 3 || b.length < 3) return 0;
  const va = sdOf(a) ** 2 / a.length;
  const vb = sdOf(b) ** 2 / b.length;
  const se = Math.sqrt(va + vb);
  if (!(se > 0)) return 0;
  return (meanOf(a) - meanOf(b)) / se;
}

/** 위아래 `fraction`씩 잘라낸 평균. 꼬리 몇 개가 만든 값인지 가른다. */
export function trimmedMean(values: ArrayLike<number>, fraction: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const cut = Math.floor(n * fraction);
  if (cut === 0) return meanOf(values);
  const sorted = Float64Array.from(values).sort();
  return meanOf(sorted.subarray(cut, n - cut));
}

/**
 * 절대값 상위 `fraction`이 합계에서 차지하는 몫.
 *
 * ★ **합이 0에 가까우면 `undefined`다.** 작은 분모로 나누면 비율이 폭발해
 * 4201% 같은 값이 나오고 "꼬리가 심하다"로 읽힌다. 실제로는 **몫을 물을 수
 * 없는 것**이다(하네스가 같은 함정을 이미 겪었다).
 */
export function topShare(values: ArrayLike<number>, fraction: number): number | undefined {
  const n = values.length;
  if (n === 0) return undefined;
  let total = 0;
  let scale = 0;
  for (let i = 0; i < n; i += 1) {
    total += values[i];
    scale += Math.abs(values[i]);
  }
  scale /= n;
  if (!(scale > 0) || Math.abs(total) < scale) return undefined;
  const count = Math.max(1, Math.floor(n * fraction));
  const sorted = Array.from(values).sort((a, b) => Math.abs(b) - Math.abs(a));
  let top = 0;
  for (let i = 0; i < count; i += 1) top += sorted[i];
  return top / total;
}

/* ── 절차 ────────────────────────────────────────────────────────────── */

/** 거래일 기준 1년. 창 길이를 날짜가 아니라 자리 수로 잡는 데 쓴다. */
const TRADING_DAYS_PER_YEAR = 252;

export interface WalkForwardSpec {
  panel: Panel;
  cellSeries: CellSeries[];
  universe: UniverseMask;
  trainMode: 'expanding' | 'rolling';
  /** `rolling`일 때 학습 창 길이(년) */
  rollingYears?: number;
  /** 검증 창이 시작하는 날들 `YYYYMMDD`. 오름차순 */
  validationStarts: string[];
  /**
   * 학습과 검증 사이에 비우는 거래일.
   *
   * ★ **전 축 고정이다.** 축마다 다르면 셀마다 학습 구간이 달라져 나란히 읽을 수
   * 없다. 60이면 가장 긴 축(20일)의 청산이 검증 구간에 닿지 않는다.
   */
  embargoDays: number;
  selection: {
    rule: 'top1';
    objective: 'netIR';
    abstainIfNegative: boolean;
  };
  /**
   * ★ **축 고정.** 있으면 이 축의 칸만 순위에 올린다.
   *
   * 축이 자유로우면 `netIR`의 `√(252/h)`가 h와 무관한 비용 상수에 곱해져 **짧은
   * 축을 못 박는다** — 실측에서 15창이 전부 h=1을 골랐고, 그 결과를 "학습 순위에
   * 정보가 있다"로 읽을 뻔했다. 블록 A의 기본 실행 단위다.
   */
  fixHorizon?: number;
  /**
   * 왕복 비용(%)의 기본값.
   *
   * `selectionCostPct`·`evalCostPct`를 안 주면 **둘 다 이 값**이다. 학습만 싸게
   * 잡는 자기기만이 기본으로는 일어날 수 없게 이 방향으로 뒀다.
   */
  costRoundTripPct: number;
  /** 학습(순위) 때 뺄 왕복 비용(%). 생략하면 `costRoundTripPct` */
  selectionCostPct?: number;
  /** 판정(검증) 때 뺄 왕복 비용(%). 생략하면 `costRoundTripPct` */
  evalCostPct?: number;
  /**
   * 기권한 창의 **반사실**까지 모을 것인가.
   *
   * 켜면 "고르지 않기로 한 창에서 골랐더라면 얼마였나"를 함께 재서 기권 자체를
   * 채점한다(`abstainSkillT`). 기권이 실력이면 반사실이 참여 구간보다 나빠야 한다.
   */
  collectAbstained?: boolean;
  /** 분위 수. 10이면 십분위 */
  buckets: number;
  /** 학습 구간에 진입이 이만큼은 있어야 순위에 올린다. 기본 250 */
  minTrainEntries?: number;
  /** 있으면 선택된 칸의 쏠림(`topSymbolShare`·`unbuyableAt1M`)까지 잰다 */
  signalsByKey?: Map<string, SignalCandidate>;
  /** 그날 최소 종목 수. 계열을 만들 때 쓴 값과 같아야 한다 */
  minNamesPerDay: number;
  /** 1주도 못 사는지 보는 기준 금액(원). 기본 1,000,000 */
  cashPerPosition?: number;
  /**
   * 표본이 **오늘 살아 있는 종목만**인가. 오늘 마스터로 종목을 고르면 참이다.
   * 감추면 판정문이 거짓말을 한다.
   */
  survivorshipExposed: boolean;
}

export interface WalkForwardWindow {
  trainFrom: string;
  trainTo: string;
  validFrom: string;
  validTo: string;
  trainFromIndex: number;
  trainToIndex: number;
  validFromIndex: number;
  validToIndex: number;
  /** 학습 순위. ★ **`--show-training` 없이는 찍지 않는다** — 찍히면 결론으로 읽힌다 */
  ranked: Array<{ signalKey: string; horizon: number; trainNetIR: number; trainEntries: number }>;
  selected: { signalKey: string; horizon: number } | 'cash';
  oosEntries: number;
}

/** 창들이 실제로 고른 축의 구성. **이게 없으면 안티셀렉션 −46.01을 오독한다** */
export interface HorizonMix {
  horizon: number;
  windows: number;
  entries: number;
}

export interface WalkForwardResult {
  procedure: string;
  entryBasis: EntryBasis;
  /** 학습(순위)에 뺀 왕복 비용(%) */
  selectionCostPct: number;
  /** 판정(검증)에 뺀 왕복 비용(%) */
  evalCostPct: number;
  /**
   * ★ 둘이 다른가. **다르면 판정문이 반드시 찍는다** — 학습만 싸게 잡아 놓고
   * 판정만 비싸게 하면 순위에 오를 수 없는 칸이 오른다.
   */
  costsDiffer: boolean;
  /** 축을 고정하고 돌았나. `undefined`면 축이 자유였다 */
  fixHorizon: number | undefined;
  /** 학습 순위를 매길 때 본 다리 */
  selectionLeg: 'top' | 'bottom';
  /** 검증에서 실제로 산 다리. `selectionLeg`와 다르면 **거울**이다 */
  evalLeg: 'top' | 'bottom';
  windows: WalkForwardWindow[];
  /** ★ **판정의 재료.** 창을 이어 붙인 하나. 진입별 순초과(%), 비용 차감 후 */
  oosEntryExcess: Float64Array;
  /** 각 진입의 축(거래일) */
  oosHorizon: Int32Array;
  /** 각 진입 신호일의 패널 날짜 index */
  oosDayIndex: Int32Array;
  /**
   * 하루당으로 환산한 순초과(%). **검정은 이것으로 한다** — 창마다 축이 다를 수
   * 있어 진입별 값을 그대로 섞으면 크기가 다른 것을 한 표본에 넣게 된다.
   */
  oosDaily: Float64Array;
  /** 같은 진입일의 유니버스 EW 수익(하루당 환산, %) */
  oosMarket: Float64Array;
  /** 각 진입의 **해**(`2011`). 군집 t와 손익분기 CI가 이것으로 묶는다 */
  oosYearCluster: Int32Array;
  /** 각 진입의 **달**(`201103`) */
  oosMonthCluster: Int32Array;
  /**
   * 표본 밖 초과를 시장에 회귀한 기울기.
   *
   * 다리 값은 `상위분위 − 그날 유니버스 EW`라 **구조상 이미 시장 수준이 빠져
   * 있다.** 그런데도 이 기울기가 크면, 남은 것은 상위분위가 시장 움직임에
   * **다르게 반응하는 몫**이다 — 우위가 아니라 노출이다(저변동성이 그 자리였다).
   */
  marketBeta: number;
  tNaive: number;
  tNeweyWest: number;
  tBlockBootstrap: number;
  tNonOverlap: number;
  /** 달 군집 강건 t. 군집이 셋 미만이면 0(못 잰 것) */
  tMonthCluster: number;
  /** ★ 해 군집 강건 t. **넷만 쓰면 부풀던 몫이 여기서 드러난다** */
  tYearCluster: number;
  /** 여섯 중 |t| 최소. **고를 수 없게 값으로 못 박는다** */
  verdictT: number;
  alphaAnnual: number;
  irAnnual: number;
  /** 2011~2018 / 2019~ 의 부호(−1·0·+1). 반쪽에서만 나오면 그건 그 시절이다 */
  halfSigns: [number, number];
  selectionTurnover: number;
  trimmed10: number;
  top1PctDayShare: number | undefined;
  /** 한 종목이 차지한 자리의 최대 몫. **모르면 `undefined`다 — 0으로 채우지 않는다** */
  topSymbolShare: number | undefined;
  /** 기준 금액으로 1주도 못 사는 자리의 몫. 모르면 `undefined` */
  unbuyableAt1M: number | undefined;
  survivorshipExposed: boolean;
  /** 청산봉이 없어 마지막 봉으로 나간 건수(검증 구간) */
  truncatedExits: number;
  /** 아무것도 안 고른 창 수 */
  cashWindows: number;
  /** ★ 고른 칸의 **축 구성.** 한 축에 몰려 있으면 그 결과는 그 축의 이야기다 */
  selectedHorizons: HorizonMix[];

  /* ── 기권 채점 (`collectAbstained`일 때만 찬다) ─────────────────────── */

  /**
   * 기권한 창에서 **골랐더라면** 얻었을 진입별 순초과(%). 비용은 `evalCostPct`다.
   * `collectAbstained`가 꺼져 있으면 길이 0이다.
   */
  abstainedExcess: Float64Array;
  /** 기권으로 버린 진입 건수 */
  abstainedEntries: number;
  /**
   * ★ **쉰 창이 골랐을 칸의 축 구성.** 참여한 창(`selectedHorizons`)과 견주라.
   *
   * 둘이 다르면 "피한 값"은 **크기가 다른 것을 견준 값**이다 — 실측에서 참여는
   * 3일 축, 쉰 창의 반사실은 20일 축이었다. 왕복 1회당 +0.600%p처럼 보이던 것이
   * 하루당으로 환산하니 t 0.00이었다(2026-08-13).
   */
  abstainedHorizons: HorizonMix[];
  /**
   * 참여 평균 − 기권 반사실 평균(%p, 진입 1건당). **양수면 기권이 나쁜 것을 피했다.**
   * 잴 수 없으면 `undefined` — 0으로 채우면 "기권이 아무 값도 없었다"가 지어진다.
   */
  abstainAvoidedPct: number | undefined;
  /**
   * ★ 그 차이의 t(Welch). **표본 단위는 창이다 — 진입이 아니다.**
   *
   * 기권 판단은 **창마다 한 번** 내린다. 진입 3,836건으로 t를 내면 겹치는 일별
   * 관측을 독립으로 세는 셈이라 값이 통째로 부푼다 — 실측에서 진입 단위 7.94 대
   * 창 단위 0.35였다(2026-08-13). 이 모듈이 t 여섯을 두고 |t| 최소를 쓰는 이유와
   * 같은 이야기다.
   *
   * ★ 값은 **하루당 환산**한 창 평균으로 낸다. 참여한 창과 쉰 창이 다른 축을
   * 골랐을 수 있어, 왕복 1회당 값을 그대로 견주면 크기가 다른 것을 섞는다.
   *
   * 양쪽 창이 셋 미만이면 `undefined`. **0으로 채우지 않는다.**
   */
  abstainSkillT: number | undefined;
  /** 그 t가 몇 창 대 몇 창에서 나왔나. 이게 없으면 표본 크기를 알 수 없다 */
  abstainSkillWindows: { taken: number; abstained: number };
}

/** `y`를 `x`에 회귀한 기울기. 재료가 모자라면 0 — 지어내지 않는다. */
function slopeOn(y: ArrayLike<number>, x: ArrayLike<number>): number {
  const n = Math.min(y.length, x.length);
  if (n < 3) return 0;
  const my = meanOf(Array.from({ length: n }, (_, i) => y[i]));
  const mx = meanOf(Array.from({ length: n }, (_, i) => x[i]));
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
  }
  return sxx > 0 ? sxy / sxx : 0;
}

/** `dayIndex`(오름차순)에서 `[from, to]` 구간의 자리. 이진탐색이다. */
function rangeBounds(dayIndex: Int32Array, from: number, to: number): [number, number] {
  const lower = (target: number): number => {
    let lo = 0;
    let hi = dayIndex.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dayIndex[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return [lower(from), lower(to + 1)];
}

/** 학습·검증에 쓰는 다리. 거울은 하위분위를 산다. */
function legOf(series: CellSeries, leg: 'top' | 'bottom'): Float64Array {
  return leg === 'top' ? series.topLeg : series.botLeg;
}

/**
 * 연 정보비율. 축이 다른 칸을 나란히 줄 세우려면 축을 지워야 한다.
 *
 * h일 관측의 `평균/표준편차`에 `√(252/h)`를 곱한다. **겹치는 관측이라 신뢰구간은
 * 이보다 넓다** — 그건 뒤의 t 넷이 본다. 여기서는 순위를 매기는 데만 쓴다.
 */
function netIR(values: Float64Array, cost: number, horizon: number): number {
  if (values.length < 3) return 0;
  const sd = sdOf(values);
  if (!(sd > 0)) return 0;
  return ((meanOf(values) - cost) / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR / horizon);
}

interface ProcedureOptions {
  procedure: string;
  /** `top1`이면 학습 1위, `bottom1`이면 학습 꼴찌 */
  rule: 'top1' | 'bottom1';
  /** **학습 순위를 매길 때** 보는 다리 */
  selectionLeg: 'top' | 'bottom';
  /**
   * **검증에서 실제로 사는** 다리.
   *
   * ★ `selectionLeg`와 다르면 그것이 **거울**이다 — 고르는 칸은 본절차와 같고
   * 사는 다리만 뒤집는다. 둘을 함께 뒤집으면 거울이 아니라 다른 전략이 된다.
   */
  evalLeg: 'top' | 'bottom';
  /** 학습이 음수면 쉬나. 안티셀렉션은 일부러 음수를 고르므로 끈다 */
  abstain: boolean;
}

/** `YYYYMMDD`에서 해·달 군집 id. 자리로 자르므로 파싱 실패가 없다. */
function yearOf(day: string): number {
  return Number(day.slice(0, 4));
}

function monthOf(day: string): number {
  return Number(day.slice(0, 6));
}

function firstDayAtOrAfter(days: string[], target: string): number {
  let lo = 0;
  let hi = days.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (days[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function runProcedure(spec: WalkForwardSpec, options: ProcedureOptions): WalkForwardResult {
  const { panel, cellSeries } = spec;
  const entryBasis = cellSeries[0]?.entryBasis ?? 'nextOpen';
  const minTrainEntries = spec.minTrainEntries ?? 250;
  const rollingDays = Math.round((spec.rollingYears ?? 10) * TRADING_DAYS_PER_YEAR);
  /*
   * ★ 안 주면 **둘 다** `costRoundTripPct`다. 기본값이 "학습만 싸게"로 기울지
   * 않도록 이 방향으로 뒀다 — 반대로 두면 아무도 모르게 자기기만이 켜진다.
   */
  const selectionCostPct = spec.selectionCostPct ?? spec.costRoundTripPct;
  const evalCostPct = spec.evalCostPct ?? spec.costRoundTripPct;

  const windows: WalkForwardWindow[] = [];
  const excess: number[] = [];
  const horizons: number[] = [];
  const dayIndexes: number[] = [];
  const markets: number[] = [];
  /** 기권한 창의 반사실. `collectAbstained`가 꺼져 있으면 비어 있다 */
  const abstained: number[] = [];
  let abstainedEntries = 0;
  /*
   * ★ **창 단위 · 하루당 환산 표본.** 둘 다 이유가 있다.
   *
   *   창 단위   기권 판단은 창마다 한 번이다. 진입으로 세면 겹치는 관측을
   *             독립으로 세어 t가 통째로 부푼다(실측 7.94 대 0.35).
   *   하루당    참여한 창과 쉰 창이 **다른 축을 골랐을 수 있다.** 왕복 1회당
   *             값을 그대로 견주면 크기가 다른 것을 한 표본에 넣는다 —
   *             이 모듈이 t를 `oosDaily`로 내는 것과 같은 이유다.
   */
  const takenWindowMeans: number[] = [];
  const abstainedWindowMeans: number[] = [];
  let truncatedExits = 0;
  let cashWindows = 0;
  let selectionChanges = 0;
  let previousSelection = '';
  const horizonWindows = new Map<number, number>();
  const horizonEntries = new Map<number, number>();
  const abstainedHorizonWindows = new Map<number, number>();
  const abstainedHorizonEntries = new Map<number, number>();

  for (let w = 0; w < spec.validationStarts.length; w += 1) {
    const validFromIndex = firstDayAtOrAfter(panel.days, spec.validationStarts[w]);
    if (validFromIndex >= panel.days.length) continue;
    const validToIndex = w + 1 < spec.validationStarts.length
      ? Math.min(panel.days.length - 1, firstDayAtOrAfter(panel.days, spec.validationStarts[w + 1]) - 1)
      : panel.days.length - 1;
    if (validToIndex < validFromIndex) continue;

    const trainToIndex = validFromIndex - spec.embargoDays - 1;
    if (trainToIndex < 0) continue;
    const trainFromIndex = spec.trainMode === 'expanding'
      ? 0
      : Math.max(0, trainToIndex - rollingDays + 1);

    const ranked: WalkForwardWindow['ranked'] = [];
    for (const series of cellSeries) {
      // ★ 축 고정. 이 한 줄이 "짧은 축을 못 박는 비용 상수"를 절차에서 걷어낸다.
      if (spec.fixHorizon !== undefined && series.horizon !== spec.fixHorizon) continue;
      const [start, end] = rangeBounds(series.dayIndex, trainFromIndex, trainToIndex);
      const values = legOf(series, options.selectionLeg).subarray(start, end);
      if (values.length < minTrainEntries) continue;
      ranked.push({
        signalKey: series.signalKey,
        horizon: series.horizon,
        trainNetIR: netIR(values, selectionCostPct, series.horizon),
        trainEntries: values.length,
      });
    }
    ranked.sort((a, b) => b.trainNetIR - a.trainNetIR);

    const pick = options.rule === 'top1' ? ranked[0] : ranked[ranked.length - 1];
    const seriesOf = (key: string, horizon: number): CellSeries | undefined =>
      cellSeries.find((c) => c.signalKey === key && c.horizon === horizon);
    let selected: WalkForwardWindow['selected'] = 'cash';
    let oosEntries = 0;
    if (pick && (!options.abstain || pick.trainNetIR > 0)) {
      selected = { signalKey: pick.signalKey, horizon: pick.horizon };
      const series = seriesOf(pick.signalKey, pick.horizon);
      if (series) {
        const [start, end] = rangeBounds(series.dayIndex, validFromIndex, validToIndex);
        const values = legOf(series, options.evalLeg);
        let windowTotal = 0;
        for (let i = start; i < end; i += 1) {
          const value = values[i] - evalCostPct;
          excess.push(value);
          windowTotal += value;
          horizons.push(series.horizon);
          dayIndexes.push(series.dayIndex[i]);
          markets.push(series.market[i] / series.horizon);
          truncatedExits += series.truncated[i];
        }
        oosEntries = end - start;
        if (oosEntries > 0) takenWindowMeans.push(windowTotal / oosEntries / series.horizon);
        horizonWindows.set(series.horizon, (horizonWindows.get(series.horizon) ?? 0) + 1);
        horizonEntries.set(series.horizon, (horizonEntries.get(series.horizon) ?? 0) + oosEntries);
      }
    } else {
      cashWindows += 1;
      /*
       * ★ **기권을 채점하려면 반사실이 있어야 한다.** 여기서 안 모으면 "쉬어서
       * 좋았다"를 확인할 길이 없다 — 기권한 창은 관측을 안 만들기 때문이다.
       * 이 값은 `oosEntryExcess`에 **섞이지 않는다.** 실제로 하지 않은 매매다.
       */
      if (spec.collectAbstained && pick) {
        const series = seriesOf(pick.signalKey, pick.horizon);
        if (series) {
          const [start, end] = rangeBounds(series.dayIndex, validFromIndex, validToIndex);
          const values = legOf(series, options.evalLeg);
          let windowTotal = 0;
          for (let i = start; i < end; i += 1) {
            const value = values[i] - evalCostPct;
            abstained.push(value);
            windowTotal += value;
          }
          abstainedEntries += end - start;
          if (end > start) {
            abstainedWindowMeans.push(windowTotal / (end - start) / series.horizon);
            const h = series.horizon;
            abstainedHorizonWindows.set(h, (abstainedHorizonWindows.get(h) ?? 0) + 1);
            abstainedHorizonEntries.set(h, (abstainedHorizonEntries.get(h) ?? 0) + (end - start));
          }
        }
      }
    }

    /*
     * ★ **현금 창은 관측을 만들지 않는다.** 0을 채우면 "0%를 냈다"는 관측이 생겨
     * t의 분모를 키운다 — 아무것도 안 한 것과 본전을 낸 것은 다른 사실이다.
     */
    const signature = selected === 'cash' ? 'cash' : `${selected.signalKey}:${selected.horizon}`;
    if (windows.length > 0 && signature !== previousSelection) selectionChanges += 1;
    previousSelection = signature;

    windows.push({
      trainFrom: panel.days[trainFromIndex],
      trainTo: panel.days[trainToIndex],
      validFrom: panel.days[validFromIndex],
      validTo: panel.days[validToIndex],
      trainFromIndex,
      trainToIndex,
      validFromIndex,
      validToIndex,
      ranked,
      selected,
      oosEntries,
    });
  }

  const oosEntryExcess = Float64Array.from(excess);
  const oosHorizon = Int32Array.from(horizons);
  const oosDayIndex = Int32Array.from(dayIndexes);
  const oosMarket = Float64Array.from(markets);
  const oosYearCluster = Int32Array.from(dayIndexes, (d) => yearOf(panel.days[d]));
  const oosMonthCluster = Int32Array.from(dayIndexes, (d) => monthOf(panel.days[d]));
  const oosDaily = new Float64Array(oosEntryExcess.length);
  for (let i = 0; i < oosEntryExcess.length; i += 1) oosDaily[i] = oosEntryExcess[i] / oosHorizon[i];
  const marketBeta = slopeOn(oosDaily, oosMarket);

  const maxHorizon = oosHorizon.length === 0 ? 1 : Math.max(...oosHorizon);
  const tNaive = naiveT(oosDaily);
  const tNeweyWest = neweyWestT(oosDaily, 2 * maxHorizon - 1);
  const tBlockBootstrap = blockBootstrapT(oosDaily, 2 * maxHorizon);
  const tNonOverlap = nonOverlapT(oosDaily, maxHorizon);
  const tMonthCluster = clusterT(oosDaily, oosMonthCluster);
  const tYearCluster = clusterT(oosDaily, oosYearCluster);
  const verdictT = [
    tNaive, tNeweyWest, tBlockBootstrap, tNonOverlap, tMonthCluster, tYearCluster,
  ].reduce((a, t) => (Math.abs(t) < Math.abs(a) ? t : a), tNaive);

  const dailyMean = meanOf(oosDaily);
  const dailySd = sdOf(oosDaily);
  const alphaAnnual = dailyMean * TRADING_DAYS_PER_YEAR;
  const irAnnual = dailySd > 0 ? (dailyMean / dailySd) * Math.sqrt(TRADING_DAYS_PER_YEAR) : 0;

  const firstHalf: number[] = [];
  const secondHalf: number[] = [];
  for (let i = 0; i < oosDaily.length; i += 1) {
    (panel.days[oosDayIndex[i]] < '20190101' ? firstHalf : secondHalf).push(oosDaily[i]);
  }
  const signOf = (values: number[]): number => {
    if (values.length === 0) return 0;
    const m = meanOf(values);
    return m > 0 ? 1 : m < 0 ? -1 : 0;
  };

  let topSymbolShare: number | undefined;
  let unbuyableAt1M: number | undefined;
  if (spec.signalsByKey) {
    const detail = measureSelectionDetail(spec, windows, options.evalLeg);
    topSymbolShare = detail.topSymbolShare;
    unbuyableAt1M = detail.unbuyableAt1M;
  }

  const abstainedExcess = Float64Array.from(abstained);
  /*
   * ★ 기권 채점은 **양쪽에 표본이 있을 때만** 낼 수 있다. 한쪽이 비면
   * `undefined`다 — 0으로 채우면 "기권에 실력이 없었다"는 판정이 지어진다.
   *
   * ★ **크기와 유의성의 표본 단위가 다르다.**
   *   - 피한 값(`abstainAvoidedPct`)은 **진입 가중 · 왕복 1회당**이다. 사람이
   *     읽는 크기라서 그렇다. ★ 두 집단의 축이 다르면 크기가 다른 것을 견주는
   *     값이므로, 판정문이 축 구성을 함께 찍는다.
   *   - t(`abstainSkillT`)는 **창 단위 · 하루당 환산**이다. 판단을 창마다 한 번
   *     내렸으므로 시도 횟수가 창 수이고, 축이 갈려도 견줄 수 있어야 한다.
   */
  const abstainAvoidedPct = oosEntryExcess.length >= 3 && abstainedExcess.length >= 3
    ? meanOf(oosEntryExcess) - meanOf(abstainedExcess)
    : undefined;
  const abstainSkillT = takenWindowMeans.length >= 3 && abstainedWindowMeans.length >= 3
    ? welchT(takenWindowMeans, abstainedWindowMeans)
    : undefined;

  const horizonMix = (
    windowsBy: Map<number, number>,
    entriesBy: Map<number, number>,
  ): HorizonMix[] => [...windowsBy.keys()]
    .sort((a, b) => a - b)
    .map((horizon) => ({
      horizon,
      windows: windowsBy.get(horizon) ?? 0,
      entries: entriesBy.get(horizon) ?? 0,
    }));
  const selectedHorizons = horizonMix(horizonWindows, horizonEntries);

  return {
    procedure: options.procedure,
    entryBasis,
    selectionCostPct,
    evalCostPct,
    costsDiffer: selectionCostPct !== evalCostPct,
    fixHorizon: spec.fixHorizon,
    selectionLeg: options.selectionLeg,
    evalLeg: options.evalLeg,
    windows,
    oosEntryExcess,
    oosHorizon,
    oosDayIndex,
    oosDaily,
    oosMarket,
    oosYearCluster,
    oosMonthCluster,
    marketBeta,
    tNaive,
    tNeweyWest,
    tBlockBootstrap,
    tNonOverlap,
    tMonthCluster,
    tYearCluster,
    verdictT,
    alphaAnnual,
    irAnnual,
    halfSigns: [signOf(firstHalf), signOf(secondHalf)],
    selectionTurnover: windows.length > 1 ? selectionChanges / (windows.length - 1) : 0,
    trimmed10: trimmedMean(oosDaily, 0.1),
    top1PctDayShare: topShare(oosDaily, 0.01),
    topSymbolShare,
    unbuyableAt1M,
    survivorshipExposed: spec.survivorshipExposed,
    truncatedExits,
    cashWindows,
    selectedHorizons,
    abstainedExcess,
    abstainedEntries,
    abstainedHorizons: horizonMix(abstainedHorizonWindows, abstainedHorizonEntries),
    abstainAvoidedPct,
    abstainSkillT,
    abstainSkillWindows: {
      taken: takenWindowMeans.length,
      abstained: abstainedWindowMeans.length,
    },
  };
}

/** 축을 고정했으면 절차 이름에 적는다. 표를 섞어 읽지 못하게. */
function procedureName(spec: WalkForwardSpec, suffix: string): string {
  const axis = spec.fixHorizon === undefined ? '' : `@h${spec.fixHorizon}`;
  return `${spec.trainMode}/${suffix}${axis}`;
}

/** 학습 1위를 고른다. 이것이 본 절차다. */
export function runWalkForward(spec: WalkForwardSpec): WalkForwardResult {
  return runProcedure(spec, {
    procedure: procedureName(spec, 'top1'),
    rule: 'top1',
    selectionLeg: 'top',
    evalLeg: 'top',
    abstain: spec.selection.abstainIfNegative,
  });
}

/**
 * ★ **블록 A — "정보가 있나"만 묻는다.**
 *
 * 비용 0 · 기권 없음 · **축 고정**. 셋 다 타입으로 못 박혀 있어 실수로 켤 수 없다.
 *
 * 왜 이렇게까지 하나:
 *
 * - **비용 0** — `netIR`의 `√(252/h)`가 h와 무관한 비용 상수에 곱해져 짧은 축을
 *   못 박는다. 비용을 넣은 채 축을 자유롭게 두면 학습 순위는 "정보"가 아니라
 *   "비용 상수"를 줄 세운다.
 * - **기권 없음** — 비용 0.54%에서 기권이 15창 중 12창을 현금으로 만들어
 *   **판정 표본의 절반이 비어** 있었다(2019년 이후 진입 0건).
 * - **축 고정** — 축이 섞이면 크기가 다른 관측을 한 표본에 넣는다.
 *
 * 비용이 돈을 다 먹는지는 **여기서 묻지 않는다.** 그건 블록 B의 손익분기표다.
 */
export type BlockASpec = Omit<
  WalkForwardSpec,
  'selection' | 'fixHorizon' | 'costRoundTripPct' | 'selectionCostPct' | 'evalCostPct'
> & {
  /** ★ 축 고정은 선택이 아니다. 블록 A의 실행 단위가 축 하나다 */
  fixHorizon: number;
  /** ★ `false`만 받는다 — 블록 A에서는 기권을 **켤 수가 없다** */
  selection: { rule: 'top1'; objective: 'netIR'; abstainIfNegative: false };
};

export function runBlockA(spec: BlockASpec): WalkForwardResult {
  const full: WalkForwardSpec = {
    ...spec,
    costRoundTripPct: 0,
    selectionCostPct: 0,
    evalCostPct: 0,
  };
  return runProcedure(full, {
    procedure: procedureName(full, 'blockA'),
    rule: 'top1',
    selectionLeg: 'top',
    evalLeg: 'top',
    abstain: false,
  });
}

/**
 * ★ **학습 최하위를 고른다. 반증 전용이고 검정 수에 세지 않는다.**
 *
 * 학습 순위에 정보가 있다면 이 절차는 **크기가 비슷한 음수**를 내야 한다.
 * 0 근처면 학습 순위가 표본 밖으로 아무것도 안 넘긴다는 뜻이고, 그러면
 * `runWalkForward`의 양수도 순위가 만든 것이 아니다.
 *
 * ★ **축을 고정하고 비용 0에서 돌려라.** 안 그러면 이 값은 학습 순위가 아니라
 * 비용 상수를 재게 된다 — 2026-08-13의 −46.01이 그랬고, 결과의
 * `selectedHorizons`가 `{1일: 15창/3,836진입}`이라고 말하고 있었는데 아무도
 * 그걸 볼 수 없었다.
 */
export function runAntiSelection(spec: WalkForwardSpec): WalkForwardResult {
  return runProcedure(spec, {
    procedure: procedureName(spec, 'anti'),
    rule: 'bottom1',
    selectionLeg: 'top',
    evalLeg: 'top',
    // 일부러 음수를 고르는 절차다. 쉬게 두면 아무것도 안 고른다.
    abstain: false,
  });
}

/**
 * ★ **거울 — 선택은 본절차와 똑같이 두고 평가 다리만 뒤집는다.**
 *
 * 진짜 우위면 여기서 부호가 갈린다. 둘이 같은 부호면 그건 신호가 아니라 표본이
 * 통째로 가진 성질이다 — 2026-08-04에 `ma_cross`가 정확히 이렇게 무너졌다.
 *
 * ★ **선택을 바꾸지 않는 것이 핵심이다.** 선택까지 뒤집으면 본절차와 **다른 칸**을
 * 고르게 되어(실측: 본절차 `turnoverSurge 1일` vs 뒤집은 쪽 `reversal5 20일`)
 * 거울이 아니라 다른 전략을 재는 것이 된다. 그쪽은 `runBottomLegProcedure`다.
 */
export function runEvalLegMirror(spec: WalkForwardSpec): WalkForwardResult {
  return runProcedure(spec, {
    procedure: procedureName(spec, 'mirror-eval'),
    rule: 'top1',
    selectionLeg: 'top',
    evalLeg: 'bottom',
    abstain: spec.selection.abstainIfNegative,
  });
}

/**
 * ★ **하위분위를 학습에도 평가에도 쓴다. 이것은 거울이 아니라 다른 전략이다.**
 *
 * "하위분위가 학습에서 제일 좋았던 칸"을 고르므로 본절차와 다른 칸이 뽑힌다.
 * 2026-08-12까지 이 함수가 `runMirror`라는 이름으로 거울 자리에 있었고, 그래서
 * 부호 비교가 성립하지 않는 두 값을 나란히 읽고 있었다.
 *
 * 값 자체는 여전히 쓸모가 있다 — "반대로 사는 전략은 되나"라는 **별개 질문**의
 * 답이다. 이름과 해석을 갈라 적는 조건에서만 읽는다.
 */
export function runBottomLegProcedure(spec: WalkForwardSpec): WalkForwardResult {
  return runProcedure(spec, {
    procedure: procedureName(spec, 'bottomleg'),
    rule: 'top1',
    selectionLeg: 'bottom',
    evalLeg: 'bottom',
    abstain: spec.selection.abstainIfNegative,
  });
}

/* ── 선택된 칸의 쏠림 ─────────────────────────────────────────────────── */

export interface SelectionDetail {
  /** 한 종목이 차지한 자리의 최대 몫 */
  topSymbolShare: number | undefined;
  /** 기준 금액으로 1주도 못 사는 자리의 몫 */
  unbuyableAt1M: number | undefined;
  positions: number;
}

/**
 * **선택된 칸만 다시 훑어** 쏠림을 잰다.
 *
 * 계열에 종목별 몫을 담아 두면 셀마다 수백 MB가 더 붙는다. 창마다 실제로 고른
 * 칸은 하나뿐이고 서로 다른 신호는 보통 두셋이라, 그것만 점수판을 다시 만들어
 * 세는 쪽이 싸다.
 *
 * `topSymbolShare`를 **금액이 아니라 자리 수**로 세는 이유는 분모가 0에 가까워질
 * 수 없어서다. 수익 합으로 나누면 합이 0 근처일 때 비율이 폭발한다.
 */
export function measureSelectionDetail(
  spec: WalkForwardSpec,
  windows: WalkForwardWindow[],
  leg: 'top' | 'bottom',
): SelectionDetail {
  const signalsByKey = spec.signalsByKey;
  if (!signalsByKey) return { topSymbolShare: undefined, unbuyableAt1M: undefined, positions: 0 };

  const { panel, universe } = spec;
  const symbolCount = panel.symbols.length;
  const cashPerPosition = spec.cashPerPosition ?? 1_000_000;

  const byKey = new Map<string, Array<{ from: number; to: number }>>();
  for (const window of windows) {
    if (window.selected === 'cash') continue;
    const key = window.selected.signalKey;
    const list = byKey.get(key) ?? [];
    list.push({ from: window.validFromIndex, to: window.validToIndex });
    byKey.set(key, list);
  }

  const positionsBySymbol = new Int32Array(symbolCount);
  let positions = 0;
  let unbuyable = 0;
  const dayScores = new Float64Array(symbolCount);
  const dayMembers = new Int32Array(symbolCount);
  const scratch = new Float64Array(symbolCount);

  for (const [key, ranges] of byKey) {
    const signal = signalsByKey.get(key);
    if (!signal) continue;
    const scores = buildScoreMatrix(panel, signal);
    for (const range of ranges) {
      for (let d = range.from; d <= range.to; d += 1) {
        const from = universe.dayOffsets[d];
        const to = universe.dayOffsets[d + 1];
        if (to <= from) continue;
        let count = 0;
        for (let m = from; m < to; m += 1) {
          const s = universe.dayMembers[m];
          const score = scores[d * symbolCount + s];
          if (!Number.isFinite(score)) continue;
          const local = panel.localIndex[d * symbolCount + s];
          if (local < 0) continue;
          dayScores[count] = score;
          dayMembers[count] = s;
          count += 1;
        }
        if (count < spec.buckets * 2) continue;
        const cut = Math.max(1, Math.floor(count / spec.buckets));
        scratch.set(dayScores.subarray(0, count));
        const threshold = leg === 'top'
          ? quickSelect(scratch, count, count - cut)
          : quickSelect(scratch, count, cut - 1);
        let taken = 0;
        for (let i = 0; i < count && taken < cut; i += 1) {
          const inside = leg === 'top' ? dayScores[i] >= threshold : dayScores[i] <= threshold;
          if (!inside) continue;
          taken += 1;
          const s = dayMembers[i];
          positionsBySymbol[s] += 1;
          positions += 1;
          const local = panel.localIndex[d * symbolCount + s];
          const entryLocal = local + 1;
          const price = entryLocal < panel.barCount[s] ? panel.open[s][entryLocal] : Number.NaN;
          if (Number.isFinite(price) && price > cashPerPosition) unbuyable += 1;
        }
      }
    }
  }

  if (positions === 0) return { topSymbolShare: undefined, unbuyableAt1M: undefined, positions: 0 };
  let most = 0;
  for (let s = 0; s < symbolCount; s += 1) if (positionsBySymbol[s] > most) most = positionsBySymbol[s];
  return {
    topSymbolShare: most / positions,
    unbuyableAt1M: unbuyable / positions,
    positions,
  };
}

/** 그 신호를 이 데이터로 잴 수 있나. 못 재면 **왜 못 재는지**를 함께 준다. */
export function excludeUnusableSignals(
  signals: SignalCandidate[],
  available: Set<'price' | 'flow' | 'short'>,
): { usable: SignalCandidate[]; excluded: Array<{ signal: SignalCandidate; reason: string }> } {
  const reasons: Record<'price' | 'flow' | 'short', string> = {
    price: '시세(시·고·저·종·거래대금)가 있어야 한다',
    flow: '수급(개인·외국인·기관 순매수)이 있어야 하는데 일봉 저장소에 없다',
    short: '공매도 비중이 있어야 하는데 일봉 저장소에 없다',
  };
  const usable: SignalCandidate[] = [];
  const excluded: Array<{ signal: SignalCandidate; reason: string }> = [];
  for (const signal of signals) {
    if (available.has(signal.dataRequirement)) usable.push(signal);
    else excluded.push({ signal, reason: reasons[signal.dataRequirement] });
  }
  return { usable, excluded };
}
