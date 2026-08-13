/**
 * Walk-forward 엔진 검증.
 *
 * ★ 여기서 못 박는 것이 전부 **실제로 틀렸던 자리**다.
 *
 * 1. **진입 basis** — 종가로 점수를 내고 그 종가로 사면 실행할 수 없는 값이다.
 *    익일 시가 진입이 종가 진입과 **다른 값**을 내는지 합성 봉으로 잰다.
 * 2. **강제청산** — 청산봉이 없을 때 옛 하네스는 `continue`로 버렸다. 폐지·정지로
 *    끝난 매매가 통째로 사라지므로 지는 쪽만 골라 안 세는 셈이다.
 * 3. **Newey-West** — 겹치는 선도수익률에서 순진한 t가 √h만큼 부푼다.
 *    iid로 만든 겹침 계열을 태워 NW t가 실제로 그만큼 줄어드는지 잰다.
 * 4. **안티셀렉션** — 학습 최하위를 정말로 고르는가.
 *
 * ★ 2026-08-13에 다섯이 더 붙었다. 전부 그날 잡힌 결함이다.
 *
 * 5. **축 고정** — `fixHorizon`이 정말로 그 축만 고르는가. 축이 자유면
 *    `netIR`의 `√(252/h)`가 비용 상수에 곱해져 짧은 축을 못 박는다.
 * 6. **학습 비용 ≠ 판정 비용** — 다를 때 결과가 그 사실을 값으로 들고 다니는가.
 * 7. **해 군집 t** — iid에서는 순진 t와 비슷하고, 해 단위 상관이 있으면 줄어드는가.
 * 8. **거울** — `runEvalLegMirror`가 **선택을 안 바꾸는가**. 이게 핵심이다.
 *    선택까지 뒤집으면 다른 칸을 고르므로 부호 비교가 성립하지 않는다.
 * 9. **기권 채점** — 쉰 창의 반사실을 맞게 내는가. 못 재면 `undefined`인가.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPanel, buildUniverseMask, type PanelBar, type UniverseMask, type Panel } from './panel.js';
import type { SignalCandidate } from './signals.js';
import {
  blockBootstrapT,
  buildCellSeries,
  clusterMeanSe,
  clusterT,
  excludeUnusableSignals,
  meanOf,
  naiveT,
  neweyWestT,
  nonOverlapT,
  runAntiSelection,
  runBlockA,
  runBottomLegProcedure,
  runEvalLegMirror,
  runWalkForward,
  topShare,
  trimmedMean,
  welchT,
  type CellSeries,
  type WalkForwardSpec,
} from './walkForward.js';

/** 재현 가능한 난수. 시험이 실행마다 다른 답을 내면 시험이 아니다. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scoreOf(pick: (close: number, index: number) => number | undefined): SignalCandidate {
  return {
    key: 'fixed',
    label: '고정 점수',
    rationale: '계산을 재려고 만든 것이다. 실제 후보가 아니며 값에 뜻이 없다.',
    dataRequirement: 'price',
    frozenAt: '2026-08-12',
    minHistory: 0,
    score: (ctx) => pick(ctx.history[ctx.index].close, ctx.index),
  };
}

describe('진입 basis — 종가로 점수를 내고 그 종가에 살 수 없다', () => {
  /*
   * 시가와 종가를 **일부러 다르게** 만든 계열. 익일 시가 진입이면 그 차이가
   * 값에 나타나야 하고, 나타나지 않으면 basis가 실제로 안 바뀐 것이다.
   */
  function panelWithGaps(): Panel {
    const map = new Map<string, PanelBar[]>();
    for (let s = 0; s < 40; s += 1) {
      const bars: PanelBar[] = [];
      let close = 10_000 + s * 100;
      for (let d = 0; d < 60; d += 1) {
        // 시가는 전날 종가에서 종목마다 다른 만큼 갭이 난다. 종가→종가로는 안 보인다.
        const open = close * (1 + ((s % 7) - 3) * 0.004);
        close = open * (1 + ((d + s) % 5) * 0.003 - 0.004);
        bars.push({
          tradingDay: String(20200101 + d),
          open,
          high: Math.max(open, close),
          low: Math.min(open, close),
          close,
          volume: 1_000,
          turnover: 500_000_000 + s * 1_000_000,
        });
      }
      map.set(`S${String(s).padStart(3, '0')}`, bars);
    }
    return buildPanel(map);
  }

  const panel = panelWithGaps();
  const signal = scoreOf((close) => close);
  const universe = buildUniverseMask(panel, {
    minBars: 25,
    activityWindow: 20,
    minActiveDays: 20,
    turnoverWindow: 20,
    minTurnover: 100_000_000,
    turnoverBottomFraction: 0,
    minNamesPerDay: 30,
    scoreGateSignals: [signal],
    eligibleSymbols: new Set(panel.symbols),
  });

  it('익일 시가 진입은 종가 진입과 다른 값을 낸다', () => {
    const nextOpen = buildCellSeries(panel, signal, 5, universe, 'nextOpen', 10, 30);
    const sameClose = buildCellSeries(panel, signal, 5, universe, 'sameClose', 10, 30);
    assert.ok(nextOpen.topLeg.length > 5, `진입일이 ${nextOpen.topLeg.length}개뿐이다`);
    /*
     * 익일 시가 진입은 **마지막 신호일을 못 쓴다** — 살 봉이 없다. 그 하루가 줄어드는
     * 것 자체가 basis의 결과다. 겹치는 구간만 견준다.
     */
    assert.ok(
      nextOpen.topLeg.length < sameClose.topLeg.length,
      '익일 시가인데 진입일 수가 안 줄었다',
    );
    const differs = [...nextOpen.topLeg].some((v, i) => Math.abs(v - sameClose.topLeg[i]) > 1e-9);
    assert.ok(differs, '두 basis가 같은 값을 냈다 — basis가 안 바뀌었다');
  });

  it('basis가 계열에 값으로 남는다 — 표를 섞어 읽지 못하게', () => {
    assert.equal(buildCellSeries(panel, signal, 5, universe, 'nextOpen', 10, 30).entryBasis, 'nextOpen');
    assert.equal(buildCellSeries(panel, signal, 5, universe, 'sameClose', 10, 30).entryBasis, 'sameClose');
  });

  it('신호일 종가는 진입가가 아니다 — 다음 봉 시가로 산다', () => {
    // 종목 하나만 두고 손으로 검산한다. 상위·하위가 같은 종목이라 다리는 0이지만
    // 시장(전체 평균)이 곧 그 종목의 수익률이라 basis 차이가 그대로 드러난다.
    const bars: PanelBar[] = [
      { tradingDay: '20200101', open: 100, high: 100, low: 100, close: 100, volume: 1, turnover: 1 },
      { tradingDay: '20200102', open: 110, high: 130, low: 100, close: 120, volume: 1, turnover: 1 },
      { tradingDay: '20200103', open: 121, high: 140, low: 110, close: 130, volume: 1, turnover: 1 },
    ];
    const one = buildPanel(new Map([['A', bars], ['B', bars]]));
    const mask: UniverseMask = {
      mask: new Uint8Array(one.days.length * one.symbols.length).fill(1),
      dayOffsets: Int32Array.from([0, 2, 4, 4]),
      dayMembers: Int32Array.from([0, 1, 0, 1]),
      usableDays: 2,
      thinDays: 0,
      ineligibleSymbols: 0,
      adjustment: {
        firstUsableLocal: new Int32Array(2), breaks: [], brokenSymbols: 0, droppedBars: 0, droppedShare: 0,
      },
      namesMedian: 2,
      namesMin: 2,
    };
    const nextOpen = buildCellSeries(one, scoreOf((_c, i) => i), 1, mask, 'nextOpen', 1, 2);
    const sameClose = buildCellSeries(one, scoreOf((_c, i) => i), 1, mask, 'sameClose', 1, 2);
    // 0일에 신호 → 1일 시가 110에 사서 2일 시가 121에 판다 = +10%
    assert.equal(Math.round(nextOpen.market[0] * 1000) / 1000, 10);
    // 종가 기준이면 100 → 120 = +20%. 이 값은 **살 수 없는 값**이다.
    assert.equal(Math.round(sameClose.market[0] * 1000) / 1000, 20);
  });
});

describe('강제청산 — 청산봉이 없다고 버리지 않는다', () => {
  it('마지막 봉으로 나가고 truncated가 센다', () => {
    const map = new Map<string, PanelBar[]>();
    for (let s = 0; s < 30; s += 1) {
      const bars: PanelBar[] = [];
      // 절반은 3봉에서 끝난다(폐지·장기정지). 축이 5일이라 청산봉이 없다.
      const length = s < 15 ? 12 : 40;
      for (let d = 0; d < length; d += 1) {
        const price = 1_000 + s + d * 3;
        bars.push({
          tradingDay: String(20200101 + d),
          open: price, high: price, low: price, close: price,
          volume: 1_000, turnover: 500_000_000,
        });
      }
      map.set(`S${String(s).padStart(3, '0')}`, bars);
    }
    const panel = buildPanel(map);
    const signal = scoreOf((close) => close);
    const universe = buildUniverseMask(panel, {
      minBars: 3,
      activityWindow: 3,
      minActiveDays: 3,
      turnoverWindow: 3,
      minTurnover: 100_000_000,
      turnoverBottomFraction: 0,
      minNamesPerDay: 20,
      scoreGateSignals: [signal],
      eligibleSymbols: new Set(panel.symbols),
    });
    const series = buildCellSeries(panel, signal, 5, universe, 'nextOpen', 10, 20);
    const truncated = [...series.truncated].reduce((a, b) => a + b, 0);
    assert.ok(truncated > 0, '강제청산이 한 건도 안 세어졌다');
  });

  it('진입할 봉조차 없으면 noEntry로 센다 — 0으로 채우지 않는다', () => {
    const bars = (length: number): PanelBar[] =>
      Array.from({ length }, (_, d) => ({
        tradingDay: String(20200101 + d),
        open: 1_000 + d, high: 1_000 + d, low: 1_000 + d, close: 1_000 + d,
        volume: 1_000, turnover: 500_000_000,
      }));
    const map = new Map<string, PanelBar[]>();
    for (let s = 0; s < 30; s += 1) map.set(`S${String(s).padStart(3, '0')}`, bars(s < 10 ? 5 : 20));
    const panel = buildPanel(map);
    const signal = scoreOf((close) => close);
    const universe = buildUniverseMask(panel, {
      minBars: 3, activityWindow: 3, minActiveDays: 3, turnoverWindow: 3,
      minTurnover: 100_000_000, turnoverBottomFraction: 0, minNamesPerDay: 20,
      scoreGateSignals: [signal], eligibleSymbols: new Set(panel.symbols),
    });
    const series = buildCellSeries(panel, signal, 1, universe, 'nextOpen', 10, 20);
    const missed = [...series.noEntry].reduce((a, b) => a + b, 0);
    assert.ok(missed > 0, '진입 못 한 자리가 한 건도 안 세어졌다');
  });
});

describe('Newey-West — 겹치는 선도수익률', () => {
  /**
   * iid 하루치를 h일 겹치게 합친 계열. 참 표준오차는 순진한 것의 **√h배**다
   * (겹침 때문에 평균이 사실상 h배 규모의 같은 합을 반복해 센다).
   */
  function overlapping(n: number, h: number, seed: number): Float64Array {
    const random = seeded(seed);
    const daily = new Float64Array(n + h);
    for (let i = 0; i < daily.length; i += 1) {
      // 박스-뮬러 없이 12개 합의 중심극한 근사. 시험에는 충분하다.
      let sum = 0;
      for (let k = 0; k < 12; k += 1) sum += random();
      daily[i] = sum - 6;
    }
    const out = new Float64Array(n);
    for (let t = 0; t < n; t += 1) {
      let sum = 0;
      for (let i = 0; i < h; i += 1) sum += daily[t + i];
      out[t] = sum + 0.05; // 작은 양의 평균을 얹어 t가 0이 아니게 한다
    }
    return out;
  }

  it('겹침 계열에서 NW t가 naive의 1/√h 근처로 줄어든다', () => {
    for (const h of [5, 10, 20]) {
      const values = overlapping(6_000, h, 20260812 + h);
      const naive = naiveT(values);
      const nw = neweyWestT(values, 2 * h - 1);
      const ratio = nw / naive;
      const expected = 1 / Math.sqrt(h);
      assert.ok(
        ratio > expected * 0.75 && ratio < expected * 1.35,
        `h=${h}: naive ${naive.toFixed(2)} · NW ${nw.toFixed(2)} · 비 ${ratio.toFixed(3)}`
        + ` (기대 ${expected.toFixed(3)})`,
      );
    }
  });

  it('겹치지 않는 iid 계열에서는 NW가 naive와 크게 다르지 않다', () => {
    const values = overlapping(6_000, 1, 7);
    const ratio = neweyWestT(values, 1) / naiveT(values);
    assert.ok(ratio > 0.85 && ratio < 1.15, String(ratio));
  });

  it('표본이 모자라면 0이다 — 못 잰 것을 큰 t로 바꾸지 않는다', () => {
    assert.equal(neweyWestT([1, 2], 3), 0);
    assert.equal(naiveT([1]), 0);
  });

  it('비겹침 t도 겹침 계열에서 naive보다 작다', () => {
    const values = overlapping(6_000, 10, 99);
    assert.ok(Math.abs(nonOverlapT(values, 10)) < Math.abs(naiveT(values)));
  });

  it('블록 부트스트랩은 시드가 같으면 같은 값을 낸다', () => {
    const values = overlapping(1_000, 5, 3);
    assert.equal(blockBootstrapT(values, 10, 300, 42), blockBootstrapT(values, 10, 300, 42));
  });
});

describe('꼬리 계산', () => {
  it('10% 절사가 꼬리를 잘라낸다', () => {
    const values = [...Array.from({ length: 18 }, () => 1), -100, 100];
    assert.equal(Math.round(trimmedMean(values, 0.1) * 100) / 100, 1);
  });

  it('합이 0 근처면 몫을 물을 수 없다 — undefined다', () => {
    assert.equal(topShare([5, -5, 5, -5], 0.5), undefined);
  });
});

/* ── 절차 ────────────────────────────────────────────────────────────── */

/** 계열을 손으로 짜서 절차만 잰다. 패널을 태우지 않으므로 무엇을 고르는지가 뚜렷하다. */
function fakeSeries(
  signalKey: string,
  horizon: number,
  value: (dayIndex: number) => number,
  days: number,
): CellSeries {
  const dayIndex = Int32Array.from({ length: days }, (_, i) => i);
  const topLeg = Float64Array.from(dayIndex, (d) => value(d));
  return {
    signalKey,
    horizon,
    entryBasis: 'nextOpen',
    dayIndex,
    topLeg,
    // 거울은 부호만 뒤집는다 — 우위가 없는 표본을 흉내 내는 가장 단순한 모양이다.
    botLeg: Float64Array.from(topLeg, (v) => -v),
    market: new Float64Array(days),
    names: Int32Array.from({ length: days }, () => 300),
    tieShare: new Float64Array(days),
    truncated: new Int32Array(days),
    noEntry: new Int32Array(days),
    daysDroppedAfterEntry: 0,
  };
}

/**
 * 합성 거래일 `YYYYMMDD`. 해마다 252일(12달 × 21일)로 센다.
 *
 * ★ `20100000 + i`로 만들면 **전부 2010년**이 되어 해 군집이 하나가 되고, 군집 t가
 * "못 잰 것"으로 0이 된다. 절차 시험이 군집 검정을 지나가려면 날짜가 진짜
 * 날짜여야 한다. 자리마다 0을 채워 문자열 정렬이 곧 시간순이다.
 */
function syntheticDay(index: number): string {
  const year = 2010 + Math.floor(index / 252);
  const rest = index % 252;
  const month = Math.floor(rest / 21) + 1;
  const day = (rest % 21) + 1;
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

/**
 * `starts`를 주면 검증 창을 그만큼 만든다. 기본은 둘이다.
 *
 * ★ 창 수가 필요한 시험이 있다 — 기권 채점은 표본 단위가 **창**이라 양쪽에 셋씩은
 * 있어야 t가 나온다. 창이 둘이면 못 잰다(그리고 그때는 `undefined`여야 한다).
 */
function fakeSpec(
  cellSeries: CellSeries[],
  days: number,
  starts: number[] = [1_200, 1_800],
): WalkForwardSpec {
  const panelDays = Array.from({ length: days }, (_, i) => syntheticDay(i));
  return {
    panel: {
      days: panelDays,
      symbols: [],
      localIndex: new Int32Array(0),
      open: [], high: [], low: [], close: [], volume: [], turnover: [],
      dayIndexOfBar: [],
      barCount: new Int32Array(0),
      dayIndexByDay: new Map(panelDays.map((d, i) => [d, i])),
      symbolIndexBySymbol: new Map(),
    },
    cellSeries,
    universe: {
      mask: new Uint8Array(0),
      dayOffsets: new Int32Array(days + 1),
      dayMembers: new Int32Array(0),
      usableDays: days,
      thinDays: 0,
      ineligibleSymbols: 0,
      adjustment: {
        firstUsableLocal: new Int32Array(0), breaks: [], brokenSymbols: 0, droppedBars: 0, droppedShare: 0,
      },
      namesMedian: 300,
      namesMin: 300,
    },
    trainMode: 'expanding',
    validationStarts: starts.map((index) => syntheticDay(index)),
    embargoDays: 60,
    selection: { rule: 'top1', objective: 'netIR', abstainIfNegative: true },
    costRoundTripPct: 0,
    buckets: 10,
    minTrainEntries: 250,
    minNamesPerDay: 200,
    survivorshipExposed: true,
  };
}

describe('walk-forward 절차', () => {
  const days = 2_400;
  // `good`은 학습·검증 내내 양수, `bad`는 내내 음수. 순위가 뚜렷하다.
  const good = fakeSeries('good', 5, (d) => 0.5 + Math.sin(d / 7) * 0.2, days);
  const bad = fakeSeries('bad', 5, (d) => -0.5 + Math.sin(d / 11) * 0.2, days);
  const spec = fakeSpec([good, bad], days);

  it('학습 1위를 고르고 검증 관측을 이어 붙인다', () => {
    const result = runWalkForward(spec);
    assert.equal(result.windows.length, 2);
    for (const window of result.windows) {
      assert.notEqual(window.selected, 'cash');
      assert.deepEqual(window.selected, { signalKey: 'good', horizon: 5 });
    }
    assert.ok(result.oosEntryExcess.length > 500, String(result.oosEntryExcess.length));
    assert.ok(result.tNaive > 0);
  });

  it('학습이 끝나는 자리와 검증이 시작하는 자리 사이가 embargo만큼 비어 있다', () => {
    const result = runWalkForward(spec);
    for (const window of result.windows) {
      assert.equal(window.validFromIndex - window.trainToIndex - 1, spec.embargoDays);
    }
  });

  it('★ 안티셀렉션은 학습 최하위를 고른다', () => {
    const result = runAntiSelection(spec);
    for (const window of result.windows) {
      assert.deepEqual(window.selected, { signalKey: 'bad', horizon: 5 });
    }
    // 학습 순위에 정보가 있으면 최하위를 고른 절차는 음수여야 한다.
    assert.ok(result.tNaive < 0, String(result.tNaive));
  });

  /*
   * ★ **이것이 2026-08-13에 잡힌 결함의 핵심이다.** 옛 `runMirror`는 하위분위를
   * **선택에도** 써서 본절차와 다른 칸을 골랐다(실측: 본절차 `turnoverSurge 1일`
   * vs 뒤집은 쪽 `reversal5 20일`). 다른 칸끼리 부호를 견주는 것은 거울이 아니다.
   */
  it('★ 거울(evalLeg)은 선택을 안 바꾼다 — 같은 칸에서 부호만 갈린다', () => {
    const main = runWalkForward(spec);
    const mirror = runEvalLegMirror(spec);
    assert.deepEqual(
      mirror.windows.map((w) => w.selected),
      main.windows.map((w) => w.selected),
      '거울이 다른 칸을 골랐다 — 그러면 거울이 아니다',
    );
    assert.equal(mirror.selectionLeg, 'top');
    assert.equal(mirror.evalLeg, 'bottom');
    // 이 계열은 botLeg가 topLeg의 부호 반대라 같은 칸에서 부호가 갈린다.
    assert.ok(main.tNaive > 0, String(main.tNaive));
    assert.ok(mirror.tNaive < 0, String(mirror.tNaive));
  });

  it('하위분위 전략은 거울이 아니다 — **다른 칸**을 고른다', () => {
    const main = runWalkForward(spec);
    const bottom = runBottomLegProcedure(spec);
    // 하위분위를 선택에도 쓰면 `bad`가 1위가 된다. 본절차는 `good`을 골랐다.
    assert.deepEqual(bottom.windows[0].selected, { signalKey: 'bad', horizon: 5 });
    assert.notDeepEqual(bottom.windows[0].selected, main.windows[0].selected);
    assert.equal(bottom.selectionLeg, 'bottom');
    assert.equal(bottom.evalLeg, 'bottom');
  });

  it('학습이 전부 음수면 쉰다 — 현금 창은 관측을 만들지 않는다', () => {
    const onlyBad = fakeSpec([bad], days);
    const result = runWalkForward(onlyBad);
    assert.equal(result.cashWindows, result.windows.length);
    assert.equal(result.oosEntryExcess.length, 0);
    for (const window of result.windows) assert.equal(window.selected, 'cash');
  });

  it('비용은 기본으로 학습과 검증에 같은 값이 들어간다', () => {
    // 우위(평균 0.5%)보다 작은 비용이라 고르는 칸은 그대로다. 값만 그만큼 내려간다.
    const withCost = runWalkForward({ ...spec, costRoundTripPct: 0.2 });
    const free = runWalkForward(spec);
    assert.equal(withCost.selectionCostPct, 0.2);
    assert.equal(withCost.evalCostPct, 0.2);
    assert.equal(withCost.costsDiffer, false);
    assert.equal(withCost.oosEntryExcess.length, free.oosEntryExcess.length);
    for (let i = 0; i < free.oosEntryExcess.length; i += 1) {
      assert.ok(Math.abs(withCost.oosEntryExcess[i] - (free.oosEntryExcess[i] - 0.2)) < 1e-9);
    }
  });

  /*
   * ★ 비용이 우위보다 크면 **아무것도 고르지 않아야 한다.** 이 시험이 없으면
   * 비용을 넣고도 계속 고르는 결함을 못 잡는다 — 이 레포는 `NO_COSTS`로만 도는
   * 시험 때문에 비용 계산 버그를 같은 커밋에서 놓친 적이 있다.
   */
  it('비용이 우위보다 크면 쉰다', () => {
    const result = runWalkForward({ ...spec, costRoundTripPct: 5 });
    assert.equal(result.cashWindows, result.windows.length);
    assert.equal(result.oosEntryExcess.length, 0);
  });

  it('verdictT는 여섯 중 |t| 최소다 — 너그러운 검정을 고를 수 없게', () => {
    const result = runWalkForward(spec);
    const six = [
      result.tNaive, result.tNeweyWest, result.tBlockBootstrap, result.tNonOverlap,
      result.tMonthCluster, result.tYearCluster,
    ];
    assert.equal(
      Math.abs(result.verdictT),
      Math.min(...six.map(Math.abs)),
    );
    // 군집 둘이 실제로 재어졌는지 확인한다 — 0이면 "못 잰 것"이라 최소가 그냥 0이다.
    assert.notEqual(result.tMonthCluster, 0);
    assert.notEqual(result.tYearCluster, 0);
  });

  it('이동 학습은 확장 학습보다 학습 창이 짧다', () => {
    const rolling = runWalkForward({ ...spec, trainMode: 'rolling', rollingYears: 2 });
    const expanding = runWalkForward(spec);
    assert.ok(rolling.windows[0].trainFromIndex > expanding.windows[0].trainFromIndex);
  });

  it('모르는 것을 0으로 채우지 않는다 — 쏠림은 재료가 없으면 undefined다', () => {
    const result = runWalkForward(spec);
    assert.equal(result.topSymbolShare, undefined);
    assert.equal(result.unbuyableAt1M, undefined);
    assert.equal(result.survivorshipExposed, true);
  });
});

describe('★ 축 고정 — 판정이 축을 섞지 않게', () => {
  const days = 2_400;
  /*
   * 축 20일 칸이 축 5일 칸보다 학습 점수가 높게 만든다. 축이 자유면 20일이
   * 뽑히므로, 고정이 실제로 걸리는지 이 대비로 잰다.
   */
  const short5 = fakeSeries('short', 5, (d) => 0.4 + Math.sin(d / 7) * 0.2, days);
  const long20 = fakeSeries('long', 20, (d) => 2.0 + Math.sin(d / 11) * 0.2, days);
  const spec = fakeSpec([short5, long20], days);

  it('축이 자유면 긴 축이 뽑힌다 (고정이 없을 때의 기준선)', () => {
    const free = runWalkForward(spec);
    assert.equal(free.fixHorizon, undefined);
    assert.deepEqual(free.selectedHorizons.map((m) => m.horizon), [20]);
  });

  it('축을 고정하면 그 축만 고른다', () => {
    const fixed = runWalkForward({ ...spec, fixHorizon: 5 });
    assert.equal(fixed.fixHorizon, 5);
    assert.deepEqual(fixed.selectedHorizons.map((m) => m.horizon), [5]);
    for (const window of fixed.windows) {
      assert.notEqual(window.selected, 'cash');
      assert.deepEqual(window.selected, { signalKey: 'short', horizon: 5 });
      // 순위 자체에 다른 축이 아예 안 올라와야 한다 — 올라오면 다음 번에 뽑힌다.
      assert.deepEqual([...new Set(window.ranked.map((r) => r.horizon))], [5]);
    }
    assert.ok(fixed.procedure.endsWith('@h5'), fixed.procedure);
  });

  it('고른 칸의 축 구성이 값으로 남는다 — 이게 없으면 −46.01을 오독한다', () => {
    const fixed = runWalkForward({ ...spec, fixHorizon: 20 });
    assert.equal(fixed.selectedHorizons.length, 1);
    assert.equal(fixed.selectedHorizons[0].horizon, 20);
    assert.equal(fixed.selectedHorizons[0].windows, fixed.windows.length);
    assert.equal(
      fixed.selectedHorizons[0].entries,
      fixed.oosEntryExcess.length,
      '축별 진입 수의 합이 전체 진입 수와 다르다',
    );
  });

  it('블록 A는 기권을 켤 수 없고 비용이 0으로 못 박힌다', () => {
    /*
     * ★ 여기 `abstainIfNegative`에 `true`를 적으면 **컴파일이 안 된다.**
     * `BlockASpec`이 `false` 리터럴만 받는다 — 블록 A에서 기권이 켜져 표본의
     * 절반이 비었던 것이 2026-08-13의 결함이라 타입으로 막아 뒀다.
     * 비용도 마찬가지다 — `costRoundTripPct`를 여기 적으면 컴파일이 안 된다.
     */
    const costly: WalkForwardSpec = { ...spec, costRoundTripPct: 9 };
    const result = runBlockA({
      ...costly,
      fixHorizon: 5,
      selection: { rule: 'top1', objective: 'netIR', abstainIfNegative: false },
    });
    assert.equal(result.selectionCostPct, 0);
    assert.equal(result.evalCostPct, 0);
    assert.equal(result.costsDiffer, false);
    assert.equal(result.cashWindows, 0, '블록 A에서 기권이 일어났다');
    assert.equal(result.fixHorizon, 5);
  });
});

describe('★ 학습 비용과 판정 비용은 따로 든다', () => {
  const days = 2_400;
  const good = fakeSeries('good', 5, (d) => 0.5 + Math.sin(d / 7) * 0.2, days);
  const spec = fakeSpec([good], days);

  it('둘이 다르면 결과가 그 사실을 값으로 들고 다닌다', () => {
    const split = runWalkForward({ ...spec, selectionCostPct: 0, evalCostPct: 0.2 });
    assert.equal(split.selectionCostPct, 0);
    assert.equal(split.evalCostPct, 0.2);
    assert.equal(split.costsDiffer, true);
  });

  it('학습만 싸게 잡으면 비용을 못 넘는 칸이 순위에 올라온다', () => {
    // 우위 평균 0.5%. 양쪽 다 1.0%면 아무것도 안 고르고, 학습만 0%면 고른다.
    const honest = runWalkForward({ ...spec, costRoundTripPct: 1.0 });
    assert.equal(honest.cashWindows, honest.windows.length);

    const cheatingSelection = runWalkForward({
      ...spec, costRoundTripPct: 1.0, selectionCostPct: 0,
    });
    assert.equal(cheatingSelection.cashWindows, 0);
    assert.equal(cheatingSelection.costsDiffer, true);
    // 그렇게 고른 칸은 판정 비용에서 손실이다 — 그래서 이 사실을 찍어야 한다.
    assert.ok(meanOf(cheatingSelection.oosEntryExcess) < 0);
  });

  it('안 주면 둘 다 costRoundTripPct다 — 기본값이 자기기만 쪽으로 안 기운다', () => {
    const plain = runWalkForward({ ...spec, costRoundTripPct: 0.3 });
    assert.equal(plain.selectionCostPct, 0.3);
    assert.equal(plain.evalCostPct, 0.3);
    assert.equal(plain.costsDiffer, false);
  });
});

describe('★ 군집 t — 겹침이 아니라 같은 해에 함께 움직인 몫', () => {
  /** 해마다 252개씩 묶은 군집 id. 값과 길이가 같다 */
  function yearIds(n: number): Int32Array {
    return Int32Array.from({ length: n }, (_, i) => 2010 + Math.floor(i / 252));
  }

  function noise(n: number, seed: number): Float64Array {
    const random = seeded(seed);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      let sum = 0;
      for (let k = 0; k < 12; k += 1) sum += random();
      out[i] = sum - 6 + 0.08;
    }
    return out;
  }

  it('iid 계열에서는 해군집 t가 순진 t와 비슷하다', () => {
    const n = 252 * 15;
    const values = noise(n, 20260813);
    const ratio = clusterT(values, yearIds(n)) / naiveT(values);
    assert.ok(ratio > 0.8 && ratio < 1.25, `비 ${ratio.toFixed(3)}`);
  });

  it('해 단위 상관이 있으면 해군집 t가 줄어든다', () => {
    const n = 252 * 15;
    const base = noise(n, 7);
    const yearShock = seeded(99);
    const shocks = Array.from({ length: 15 }, () => (yearShock() - 0.5) * 4);
    const values = Float64Array.from(base, (v, i) => v + shocks[Math.floor(i / 252)]);
    const naive = naiveT(values);
    const clustered = clusterT(values, yearIds(n));
    assert.ok(
      Math.abs(clustered) < Math.abs(naive) * 0.6,
      `순진 ${naive.toFixed(2)} · 해군집 ${clustered.toFixed(2)}`,
    );
  });

  it('군집이 셋 미만이면 0이다 — 못 잰 것을 큰 t로 바꾸지 않는다', () => {
    const values = Float64Array.from({ length: 300 }, (_, i) => 1 + Math.sin(i));
    const oneCluster = new Int32Array(300).fill(2010);
    assert.equal(clusterT(values, oneCluster), 0);
    assert.equal(clusterMeanSe(values, oneCluster).clusters, 1);
    assert.equal(clusterMeanSe(values, oneCluster).se, 0);
  });

  it('Welch t는 표본이 모자라면 0이다', () => {
    assert.equal(welchT([1, 2], [3, 4, 5]), 0);
    assert.ok(welchT([2, 2.1, 1.9, 2.05], [1, 1.1, 0.9, 1.05]) > 2);
  });
});

describe('★ 기권 채점 — 쉰 창의 반사실을 잰다', () => {
  const days = 2_400;
  /*
   * 앞 800일은 −1, 그 뒤는 +1.0, 1800일부터는 +1.4. 확장 학습이라 앞쪽 창은
   * 학습 평균이 음수라 **쉬고**, 뒤쪽 창은 양수라 **참여한다.** 창 여덟이면
   * 기권 4 · 참여 4가 되어 **창 단위**로 t를 낼 수 있다.
   */
  const exact = (d: number): number => (d < 800 ? -1 : d >= 1_800 ? 1.4 : 1.0);
  const noisy = (d: number): number => exact(d) + Math.sin(d / 60) * 0.3;
  const eightWindows = [1_200, 1_350, 1_500, 1_650, 1_800, 1_950, 2_100, 2_250];
  const base = fakeSpec([fakeSeries('lateBloomer', 5, noisy, days)], days, eightWindows);

  it('기권한 창의 반사실이 실제 관측에 섞이지 않는다', () => {
    const result = runWalkForward({ ...base, collectAbstained: true });
    const { taken, abstained } = result.abstainSkillWindows;
    assert.ok(taken >= 3 && abstained >= 3, `참여 ${taken}창 · 기권 ${abstained}창`);
    assert.equal(taken + abstained, result.windows.length);
    assert.equal(result.cashWindows, abstained);
    // 창마다 150건씩. 두 배열이 한 곳에 섞이면 창 수 × 150이 한쪽에 몰린다.
    assert.equal(result.oosEntryExcess.length, taken * 150);
    assert.equal(result.abstainedExcess.length, abstained * 150);
    assert.equal(result.abstainedEntries, abstained * 150);
  });

  it('반사실 평균과 참여 평균의 차를 맞게 낸다', () => {
    // 잡음 없는 계열이라 손으로 검산된다 — 기권 창은 +1.0, 참여 창은 +1.4다.
    const result = runWalkForward({
      ...fakeSpec([fakeSeries('lateBloomer', 5, exact, days)], days),
      collectAbstained: true,
    });
    assert.equal(result.cashWindows, 1);
    assert.equal(Math.round(meanOf(result.abstainedExcess) * 1e6) / 1e6, 1);
    assert.equal(Math.round(meanOf(result.oosEntryExcess) * 1e6) / 1e6, 1.4);
    assert.equal(Math.round((result.abstainAvoidedPct ?? 0) * 1e6) / 1e6, 0.4);
  });

  /*
   * ★ **2026-08-13에 이걸로 한 번 틀렸다.** 진입 단위 Welch를 쓰고 있었고
   * 실측에서 t 7.94가 나왔다 — 창 단위로는 0.35였다. 기권 판단은 창마다 한 번
   * 내리므로 시도 횟수는 창 수다.
   */
  it('★ t의 표본 단위는 창이다 — 진입으로 세면 통째로 부푼다', () => {
    const result = runWalkForward({ ...base, collectAbstained: true });
    assert.ok(result.abstainSkillT !== undefined);
    const entryUnitT = welchT(result.oosEntryExcess, result.abstainedExcess);
    assert.ok(
      Math.abs(result.abstainSkillT ?? 0) < Math.abs(entryUnitT) * 0.5,
      `창 단위 ${result.abstainSkillT} · 진입 단위 ${entryUnitT}`,
    );
  });

  /*
   * ★ **실측에서 이것이 결론을 뒤집었다(2026-08-13).** 참여한 창은 3일 축,
   * 쉰 창의 반사실은 20일 축이라 "왕복 1회당 +0.600%p를 피했다"가 크기가 다른
   * 것을 견준 값이었다. 하루당으로 환산하니 t 0.00이었다.
   */
  it('★ 쉰 창이 골랐을 축도 값으로 남는다 — 참여한 축과 다르면 견줄 수 없다', () => {
    /*
     * 이동 학습(1년)이면 앞쪽 창은 3일 축이 크게 음수라 20일 축이 1위가 되고
     * (그것도 음수라 쉰다), 뒤쪽 창은 3일 축이 양수로 뒤집혀 참여한다.
     * 실측에서 난 모양(참여 3일 · 기권 20일) 그대로다.
     */
    const short = fakeSeries('short', 3, (d) => (d < 1_750 ? -1.0 : 2.0) + Math.sin(d / 9) * 0.3, days);
    const long = fakeSeries('long', 20, (d) => -0.15 + Math.sin(d / 17) * 0.3, days);
    const result = runWalkForward({
      ...fakeSpec([short, long], days, eightWindows),
      trainMode: 'rolling',
      rollingYears: 1,
      collectAbstained: true,
    });
    assert.deepEqual(result.selectedHorizons.map((m) => m.horizon), [3]);
    assert.deepEqual(result.abstainedHorizons.map((m) => m.horizon), [20]);
    assert.equal(
      result.abstainedHorizons.reduce((a, m) => a + m.entries, 0),
      result.abstainedExcess.length,
      '쉰 창 축별 진입 수의 합이 반사실 관측 수와 다르다',
    );
    assert.equal(
      result.selectedHorizons.reduce((a, m) => a + m.entries, 0),
      result.oosEntryExcess.length,
    );
  });

  it('창이 셋 미만이면 t는 undefined다 — 크기는 재도 유의성은 못 잰다', () => {
    // 창 둘짜리 기본 spec이면 기권 1 · 참여 1이라 t를 낼 수 없다.
    const twoWindows = fakeSpec([fakeSeries('lateBloomer', 5, noisy, days)], days);
    const result = runWalkForward({ ...twoWindows, collectAbstained: true });
    assert.equal(result.cashWindows, 1);
    assert.equal(result.abstainSkillWindows.taken, 1);
    assert.equal(result.abstainSkillWindows.abstained, 1);
    // 크기(진입 가중)는 잴 수 있다. 유의성은 못 잰다 — 둘을 갈라 둔다.
    assert.ok(result.abstainAvoidedPct !== undefined);
    assert.equal(result.abstainSkillT, undefined);
  });

  it('안 켜면 반사실을 아예 안 모은다 — 기본 실행이 무거워지지 않게', () => {
    const result = runWalkForward(base);
    assert.equal(result.abstainedExcess.length, 0);
    assert.equal(result.abstainedEntries, 0);
    assert.equal(result.abstainAvoidedPct, undefined);
    assert.equal(result.abstainSkillT, undefined);
    assert.equal(result.abstainSkillWindows.abstained, 0);
  });

  it('한쪽 표본이 비면 undefined다 — 0으로 채우지 않는다', () => {
    // 내내 음수라 전 창이 기권한다. 참여 표본이 0이면 견줄 수가 없다.
    const allBad = fakeSeries('bad', 5, (d) => -0.5 + Math.sin(d / 11) * 0.2, days);
    const result = runWalkForward({
      ...fakeSpec([allBad], days, eightWindows),
      collectAbstained: true,
    });
    assert.equal(result.oosEntryExcess.length, 0);
    assert.ok(result.abstainedEntries > 0);
    assert.equal(result.abstainAvoidedPct, undefined);
    assert.equal(result.abstainSkillT, undefined);
    assert.equal(result.abstainSkillWindows.taken, 0);
  });
});

describe('쓸 수 없는 신호는 사유와 함께 뺀다', () => {
  it('일봉만 있는 실행에서 수급·공매도 신호가 왜 빠지는지 말한다', () => {
    const price = scoreOf((c) => c);
    const flow: SignalCandidate = { ...price, key: 'flow', dataRequirement: 'flow' };
    const short: SignalCandidate = { ...price, key: 'short', dataRequirement: 'short' };
    const { usable, excluded } = excludeUnusableSignals(
      [price, flow, short],
      new Set<'price' | 'flow' | 'short'>(['price']),
    );
    assert.deepEqual(usable.map((s) => s.key), ['fixed']);
    assert.equal(excluded.length, 2);
    for (const item of excluded) assert.ok(item.reason.length > 10, item.signal.key);
  });
});
