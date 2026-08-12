/**
 * Walk-forward 엔진 검증.
 *
 * ★ 여기서 못 박는 것 넷이 전부 **실제로 틀렸던 자리**다.
 *
 * 1. **진입 basis** — 종가로 점수를 내고 그 종가로 사면 실행할 수 없는 값이다.
 *    익일 시가 진입이 종가 진입과 **다른 값**을 내는지 합성 봉으로 잰다.
 * 2. **강제청산** — 청산봉이 없을 때 옛 하네스는 `continue`로 버렸다. 폐지·정지로
 *    끝난 매매가 통째로 사라지므로 지는 쪽만 골라 안 세는 셈이다.
 * 3. **Newey-West** — 겹치는 선도수익률에서 순진한 t가 √h만큼 부푼다.
 *    iid로 만든 겹침 계열을 태워 NW t가 실제로 그만큼 줄어드는지 잰다.
 * 4. **안티셀렉션** — 학습 최하위를 정말로 고르는가.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPanel, buildUniverseMask, type PanelBar, type UniverseMask, type Panel } from './panel.js';
import type { SignalCandidate } from './signals.js';
import {
  blockBootstrapT,
  buildCellSeries,
  excludeUnusableSignals,
  naiveT,
  neweyWestT,
  nonOverlapT,
  runAntiSelection,
  runMirror,
  runWalkForward,
  topShare,
  trimmedMean,
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

function fakeSpec(cellSeries: CellSeries[], days: number): WalkForwardSpec {
  const panelDays = Array.from({ length: days }, (_, i) => String(20100000 + i));
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
    validationStarts: [String(20100000 + 1_200), String(20100000 + 1_800)],
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

  it('★ 거울은 하위분위를 산다 — 부호가 갈린다', () => {
    const result = runMirror(spec);
    // 여기 계열은 botLeg가 topLeg의 부호 반대라 거울에서는 `bad`가 1위다.
    assert.deepEqual(result.windows[0].selected, { signalKey: 'bad', horizon: 5 });
    assert.ok(runWalkForward(spec).tNaive > 0 && result.tNaive > 0);
  });

  it('학습이 전부 음수면 쉰다 — 현금 창은 관측을 만들지 않는다', () => {
    const onlyBad = fakeSpec([bad], days);
    const result = runWalkForward(onlyBad);
    assert.equal(result.cashWindows, result.windows.length);
    assert.equal(result.oosEntryExcess.length, 0);
    for (const window of result.windows) assert.equal(window.selected, 'cash');
  });

  it('비용은 학습과 검증에 같은 값이 들어간다', () => {
    // 우위(평균 0.5%)보다 작은 비용이라 고르는 칸은 그대로다. 값만 그만큼 내려간다.
    const withCost = runWalkForward({ ...spec, costRoundTripPct: 0.2 });
    const free = runWalkForward(spec);
    assert.equal(withCost.costRoundTripPct, 0.2);
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

  it('verdictT는 넷 중 |t| 최소다 — 너그러운 검정을 고를 수 없게', () => {
    const result = runWalkForward(spec);
    const four = [result.tNaive, result.tNeweyWest, result.tBlockBootstrap, result.tNonOverlap];
    assert.equal(
      Math.abs(result.verdictT),
      Math.min(...four.map(Math.abs)),
    );
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
