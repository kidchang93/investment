/**
 * 측정 표본을 고르고 세는 계산. **재는 쪽만 쓴다 — 러너는 부르지 않는다.**
 *
 * ── 왜 떼어 놓았나 ───────────────────────────────────────────────────────
 *
 * 이 계산이 측정 스크립트 안에 인라인으로 있는 동안 **같은 결함이 두 축에서
 * 따로 났다.** 분봉 쪽에서 먼저 드러났다 — 현금으로 1주도 못 사는 종목이
 * `매매 0건 · 수익률 정확히 0.00%`로 남아, 전부 마이너스인 분포의 중앙값을
 * 끌어올렸다. 그걸로 판정문이 실제보다 1.4~1.9배 좋게 적혀 있었다(2026-08-01).
 * 그때 분봉 쪽만 고쳤고 일봉 쪽에는 그대로 남아 있었다.
 *
 * 소비자가 둘이 되면 옮긴다 — `docs/ARCHITECTURE.md`의 규약이다. 여기 있으면
 * KIS도 DB도 없이 시험에 태울 수 있다.
 *
 * ── 세 가지를 가른다 ─────────────────────────────────────────────────────
 *
 * | 무엇 | 어떻게 | 왜 |
 * |------|------|------|
 * | 봉이 모자람 | 표본에서 **뺀다** | 신호가 날 수 없다. 성적이 아니라 잴 수 없는 조건이다 |
 * | 현금으로 1주도 못 삼 | 표본에서 **뺀다** | 러너 자신의 후보 필터(`tooExpensive`)가 거르는 종목이다 |
 * | 매매 0건 · 미청산 | **세기만 한다** | 뺄지는 판단이 갈린다. 몇 건인지 안 보이는 것이 제일 나쁘다 |
 *
 * 뺀 것도 센다. 표본이 전체가 아니면 몇 개를 봤는지 밝혀야 그 중앙값을 읽을 수 있다.
 */

import type { Candle } from '@invest/shared';

/** 표본에서 뺀 사유. `null`이면 잴 수 있는 표본이다. */
export type SampleExclusion = 'tooFewBars' | 'unaffordable' | 'noUsablePrice';

/** 표본 하나가 성적으로 남았는지 세는 데 필요한 것만. `BacktestResult`가 이 모양을 만족한다. */
export interface MeasuredSample {
  tradeCount: number;
  /** 구간이 끝난 시점에 아직 들고 있던 수량 */
  openQuantity: number;
}

/**
 * 표본 집계. 단위(종목이냐 종목·구간이냐)는 세는 쪽이 정하고 여기서는 개수만 든다.
 */
export interface SampleTally {
  /** 재려고 집어든 표본 수. 아래 전부의 합이다 */
  considered: number;
  tooFewBars: number;
  unaffordable: number;
  noUsablePrice: number;
  /** 실제로 성적에 넣은 표본 수 */
  measured: number;
  /** 넣었지만 매매가 한 건도 없던 표본 수 (뺀 것이 아니다) */
  noTrade: number;
  /** 미청산으로 끝난 표본 수 (뺀 것이 아니다) */
  openEnded: number;
}

export function emptySampleTally(): SampleTally {
  return {
    considered: 0,
    tooFewBars: 0,
    unaffordable: 0,
    noUsablePrice: 0,
    measured: 0,
    noTrade: 0,
    openEnded: 0,
  };
}

/**
 * 이 캔들 계열을 성적으로 쓸 수 있나. 못 쓰면 사유, 쓸 수 있으면 `null`.
 *
 * `minBars`는 전략이 요구하는 봉 수(`Strategy.minBars`)를 그대로 넘긴다.
 * **여기서 하나를 더한다** — `backtest()`는 마지막 봉에서 신호를 만들지 않고
 * 다음 봉 시가로 체결하므로, 신호 한 번이 나려면 체결할 봉이 하나 더 필요하다.
 * 부르는 쪽이 `+ 1`을 직접 적으면 두 스크립트가 서로 다른 값을 쓰게 된다.
 *
 * 값이 없는 것과 비싼 것을 가른다. 쓸 수 있는 저가가 하나도 없는 계열은
 * `noUsablePrice`다 — "비싸서 못 산다"고 적으면 안 잰 사실을 지어내는 셈이다.
 * (KIS 정규화가 이미 걸러 실제 원자료에서는 거의 안 나오지만, 나면 알아야 한다.)
 */
export function sampleExclusion(candles: Candle[], cash: number, minBars: number): SampleExclusion | null {
  if (candles.length < minBars + 1) return 'tooFewBars';

  let cheapest = Number.POSITIVE_INFINITY;
  for (const candle of candles) {
    if (Number.isFinite(candle.low) && candle.low > 0) cheapest = Math.min(cheapest, candle.low);
  }
  if (!Number.isFinite(cheapest)) return 'noUsablePrice';
  /*
   * 구간 내내 1주 값이 현금보다 비싸면 `backtest()`가 `size <= 0`으로 매수를
   * 건너뛰어 매매 0건 · 수익률 정확히 0.00%가 된다. 전부 마이너스인 분포에서
   * 0은 맨 위라 중앙값을 끌어올린다.
   */
  if (cheapest > cash) return 'unaffordable';
  return null;
}

/** 뺀 표본 하나를 센다. */
export function countExcluded(tally: SampleTally, reason: SampleExclusion): void {
  tally.considered += 1;
  tally[reason] += 1;
}

/** 성적에 넣은 표본 하나를 센다. 매매 0건·미청산은 빼지 않고 따로 센다. */
export function countMeasured(tally: SampleTally, result: MeasuredSample): void {
  tally.considered += 1;
  tally.measured += 1;
  if (result.tradeCount === 0) tally.noTrade += 1;
  if (result.openQuantity > 0) tally.openEnded += 1;
}

/**
 * 집계를 한 줄로 적는다. `unit`은 세는 단위 이름이다 — 일봉 측정은 캔들을 세
 * 구간으로 갈라 재므로 `종목·구간`, 분봉 측정은 이어 붙여 한 번 재므로 `종목`.
 *
 * 0인 사유도 적는다. 안 적으면 "그 사유가 없었다"와 "그 사유를 안 봤다"가
 * 같은 모양이 된다.
 */
export function describeSampleTally(tally: SampleTally, unit: string): string {
  return (
    `표본 ${tally.considered}${unit} 중 ${tally.measured}개를 쟀다`
    + ` (뺌: 봉 부족 ${tally.tooFewBars} · 현금으로 1주도 못 삼 ${tally.unaffordable}`
    + ` · 쓸 수 있는 값이 없음 ${tally.noUsablePrice})`
    + ` · 쟀지만 매매 0건 ${tally.noTrade}개 · 미청산으로 끝남 ${tally.openEnded}개`
  );
}

/**
 * 정렬된 목록을 개수가 (거의) 같은 층으로 가른다. 층화 표집의 앞 절반이다.
 *
 * 나머지는 앞 층부터 하나씩 준다 — 뒤 층에 몰아주면 마지막 층만 커진다.
 * `strata`가 목록보다 많으면 빈 층이 생기지 않게 목록 길이로 줄인다.
 *
 * **무엇으로 정렬해 넘겼는지는 부르는 쪽이 결과에 적어야 한다.** 층의 기준을
 * 모르면 층별 숫자를 읽을 수 없다.
 */
export function stratify<T>(sorted: T[], strata: number): T[][] {
  if (strata < 1 || sorted.length === 0) return [];
  const count = Math.min(strata, sorted.length);
  const base = Math.floor(sorted.length / count);
  const remainder = sorted.length % count;

  const layers: T[][] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    layers.push(sorted.slice(cursor, cursor + size));
    cursor += size;
  }
  return layers;
}
