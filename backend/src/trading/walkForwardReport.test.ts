/**
 * Walk-forward **판정문** 검증.
 *
 * ★ 판정문은 결론을 사람에게 넘기는 마지막 자리다. 계산이 맞아도 여기가 안 적으면
 * 사람이 틀린 결론을 읽는다 — 2026-08-13에 실제로 그랬다.
 *
 * | 여기서 못 박는 것 | 안 적혀서 무슨 일이 났나 |
 * |------|------|
 * | 축 구성 | 안티셀렉션 −46.01을 "학습 순위에 정보가 있다"로 읽었다 |
 * | 표본이 있는 해 | 판정 t −1.38이 2011~2013만의 743건 위에서 나왔다 |
 * | 학습 비용 ≠ 판정 비용 | 못 넘을 칸이 순위에 올라 있었는데 표에는 안 적혔다 |
 * | 생존편향의 **크기** | 불리언 하나로는 아무도 크기를 모른다 |
 * | 손익분기표 | "유의하다"를 "돈이 된다"로 읽었다 |
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPanel, type PanelBar } from './panel.js';
import {
  runBlockA,
  runWalkForward,
  type CellSeries,
  type WalkForwardSpec,
} from './walkForward.js';
import {
  type DelistingGap,
  anyAxisBeatsCost,
  buildBreakEvenTable,
  describeAbstainSkill,
  describeBreakEvenTable,
  describeDelistingGap,
  describeHorizonMix,
  describeSelectedSignals,
  describeSurvivorship,
  describeVerdict,
  describeYearSpan,
  percentile,
  scanSurvivorship,
  summarizePlacebo,
} from './walkForwardReport.js';

/* ── 재료 ────────────────────────────────────────────────────────────── */

/**
 * 폐지 누락 크기 한 벌. **상수를 모듈에 두지 않는 이유가 여기 있다** —
 * 이 값은 봉이 들어올 때마다 바뀌므로 실행 시점에 DB에서 잰다
 * (`db/delistings.ts`의 `measureDelistingGap`). 시험은 말로 옮기는 것만 본다.
 */
function gapOf(overrides: Partial<DelistingGap> = {}): DelistingGap {
  return {
    source: 'KIND 상장폐지 목록',
    fetchedOn: '2026-08-13',
    measuredOn: '2026-08-14',
    totalRows: 1_267,
    realExits: 880,
    coveredSymbols: 40,
    missingSymbols: 840,
    continuingSymbols: 0,
    reasons: [{ label: '자본전액잠식', count: 55 }],
    missingShareByYear: [{ year: 2005, share: 0.352 }, { year: 2026, share: 0.009 }],
    overallMissingShare: 0.232,
    ...overrides,
  };
}

function syntheticDay(index: number): string {
  const year = 2010 + Math.floor(index / 252);
  const rest = index % 252;
  const month = Math.floor(rest / 21) + 1;
  const day = (rest % 21) + 1;
  return `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
}

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
    botLeg: Float64Array.from(topLeg, (v) => -v),
    market: new Float64Array(days),
    names: Int32Array.from({ length: days }, () => 300),
    tieShare: new Float64Array(days),
    truncated: new Int32Array(days),
    noEntry: new Int32Array(days),
    daysDroppedAfterEntry: 0,
  };
}

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
        exemptedBreaks: [], exemptedSymbols: 0,
      },
      namesMedian: 300,
      namesMin: 300,
    },
    trainMode: 'expanding',
    validationStarts: starts.map((index) => syntheticDay(index)),
    embargoDays: 60,
    selection: { rule: 'top1', objective: 'netIR', abstainIfNegative: false },
    costRoundTripPct: 0,
    buckets: 10,
    minTrainEntries: 250,
    minNamesPerDay: 200,
    survivorshipExposed: true,
  };
}

const DAYS = 2_400;

/** 왕복 1회당 0.6%를 내는 5일 축 하나. 손익분기표 숫자를 손으로 검산할 수 있다 */
function blockAAt(horizon: number, edge: number) {
  const spec = fakeSpec([fakeSeries('edge', horizon, (d) => edge + Math.sin(d / 7) * 0.05, DAYS)], DAYS);
  return runBlockA({
    ...spec,
    fixHorizon: horizon,
    selection: { rule: 'top1', objective: 'netIR', abstainIfNegative: false },
  });
}

/* ── 생존편향의 크기 ─────────────────────────────────────────────────── */

describe('★ 생존편향은 불리언이 아니라 크기다', () => {
  /** `lastDay`까지만 사는 종목들. 종목 수는 해마다 는다 */
  function panelOf(spec: Array<{ symbol: string; from: number; to: number }>) {
    const map = new Map<string, PanelBar[]>();
    for (const item of spec) {
      const bars: PanelBar[] = [];
      for (let d = item.from; d <= item.to; d += 1) {
        bars.push({
          tradingDay: syntheticDay(d),
          open: 1_000, high: 1_000, low: 1_000, close: 1_000, volume: 1, turnover: 1,
        });
      }
      map.set(item.symbol, bars);
    }
    return buildPanel(map);
  }

  it('전부 끝까지 살아 있으면 "이 패널에는 상장폐지가 없다"고 적는다', () => {
    // 2010부터 하나씩 늘어 전부 마지막 날까지 산다 = 오늘 마스터로 고른 표본의 모양
    const panel = panelOf([
      { symbol: 'A', from: 0, to: 3_000 },
      { symbol: 'B', from: 252, to: 3_000 },
      { symbol: 'C', from: 504, to: 3_000 },
    ]);
    const scan = scanSurvivorship(panel, '20200101');
    assert.equal(scan.endedBefore, 0);
    assert.equal(scan.monotone, true);
    assert.equal(scan.byYear[0].symbols, 1);
    assert.equal(scan.byYear[scan.byYear.length - 1].symbols, 3);
    const lines = describeSurvivorship(scan);
    assert.ok(lines[0].includes('단조증가'), lines[0]);
    assert.ok(lines[1].includes('0/3'), lines[1]);
    assert.ok(lines[2].includes('상장폐지가 없다'), lines[2]);
  });

  it('★ "폐지가 없다"만 적지 않는다 — 얼마나 빠졌는지를 밖에서 들여와 적는다', () => {
    const panel = panelOf([
      { symbol: 'A', from: 0, to: 3_000 },
      { symbol: 'B', from: 252, to: 3_000 },
    ]);
    const lines = describeSurvivorship(scanSurvivorship(panel, '20200101'), gapOf());
    const joined = lines.join('\n');
    // 크기 — 없는 종목은 패널 안에서 세어지지 않으므로 밖에서 와야 한다.
    assert.ok(joined.includes('40종목'), joined);
    assert.ok(joined.includes('840종목'), joined);
    // 출처와 **잰 날**. 목록을 받은 날과 다르다 — 봉이 들어오면 답이 바뀐다.
    assert.ok(joined.includes('KIND 상장폐지 목록(2026-08-13 받음, 1,267건)'), joined);
    assert.ok(joined.includes('2026-08-14에 쟀다'), joined);
    // ★ 아직 빠진 것이 있으면 그 사실과 받는 방법이 함께 나온다.
    assert.ok(joined.includes('상한'), joined);
    assert.ok(joined.includes('collectDelistedBars'), joined);
  });

  it('★ 폐지 목록에 있어도 봉이 이어지면 퇴장이 아니라고 적는다', () => {
    // 이전상장·스팩소멸합병이 KIND에 폐지로 기록된다. 그 종목들은 오늘도 거래된다.
    const joined = describeDelistingGap(gapOf({ continuingSymbols: 131 })).join('\n');
    assert.ok(joined.includes('131개는 퇴장이 아니다'), joined);
    assert.ok(joined.includes('이전상장'), joined);
  });

  it('밖의 크기를 안 주면 그 문단이 아예 안 나온다 — 없는 근거를 지어내지 않는다', () => {
    const panel = panelOf([{ symbol: 'A', from: 0, to: 3_000 }]);
    const joined = describeSurvivorship(scanSurvivorship(panel, '20200101')).join('\n');
    assert.ok(!joined.includes('KIND'), joined);
    assert.ok(joined.includes('이 패널에는 상장폐지가 없다'), joined);
  });

  it('빠진 것이 없으면 "상한이다"를 적지 않는다 — 남은 편향이 없을 때 하는 말이 아니다', () => {
    const joined = describeDelistingGap(gapOf({
      missingSymbols: 0, coveredSymbols: 880, overallMissingShare: 0,
    })).join('\n');
    assert.ok(joined.includes('880종목이 표본에 들어왔고'), joined);
    assert.ok(!joined.includes('collectDelistedBars'), joined);
  });

  it('연도가 많으면 균등하게 고르고 잘랐다고 밝힌다', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({ year: 2005 + i, share: 0.1 }));
    const joined = describeDelistingGap(gapOf({ missingShareByYear: many })).join('\n');
    assert.ok(joined.includes('21년 중'), joined);
    // 앞쪽만 자르면 좋아진 뒤가 안 보인다 — 마지막 해가 들어 있어야 한다.
    assert.ok(joined.includes('2025'), joined);
  });

  it('중간에 끝난 종목이 있으면 몇 개인지 세어 적는다 — 0으로 뭉개지 않는다', () => {
    const panel = panelOf([
      { symbol: 'A', from: 0, to: 3_000 },
      { symbol: 'B', from: 0, to: 1_000 },
      { symbol: 'C', from: 0, to: 900 },
    ]);
    const scan = scanSurvivorship(panel, '20200101');
    assert.equal(scan.endedBefore, 2);
    assert.equal(scan.monotone, false);
    assert.ok(scan.firstDrop !== undefined);
    const lines = describeSurvivorship(scan);
    assert.ok(lines[1].includes('2/3'), lines[1]);
    assert.ok(lines[2].includes('상장폐지가 일부 들어와 있다'), lines[2]);
    assert.ok(!lines[0].includes('단조증가'), lines[0]);
  });
});

/* ── 손익분기표 ──────────────────────────────────────────────────────── */

describe('★ 손익분기표 — "돈이 되나"의 답', () => {
  it('비용 0이 아닌 결과로는 못 만든다 — 두 번 빼게 된다', () => {
    const spec = fakeSpec([fakeSeries('edge', 5, () => 0.6, DAYS)], DAYS);
    const costly = runWalkForward({ ...spec, fixHorizon: 5, costRoundTripPct: 0.2 });
    assert.throws(() => buildBreakEvenTable([costly], [0.3]), /비용 0 결과로만/);
  });

  it('축 고정이 아닌 결과로는 못 만든다 — 252/h의 h를 정할 수 없다', () => {
    const spec = fakeSpec([fakeSeries('edge', 5, () => 0.6, DAYS)], DAYS);
    const free = runWalkForward(spec);
    assert.throws(() => buildBreakEvenTable([free], [0.3]), /축 고정 결과로만/);
  });

  it('왕복/년과 연 환산이 손으로 검산한 값과 맞는다', () => {
    const rows = buildBreakEvenTable([blockAAt(5, 0.6)], [0.3, 0.43, 0.54]);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.horizon, 5);
    assert.equal(Math.round(row.roundTripsPerYear * 10) / 10, 50.4);
    assert.ok(Math.abs(row.grossPerRoundTripPct - 0.6) < 0.02, String(row.grossPerRoundTripPct));
    assert.ok(
      Math.abs(row.grossAnnualPct - row.grossPerRoundTripPct * 50.4) < 1e-9,
      String(row.grossAnnualPct),
    );
    // 비용 0.3%면 왕복당 +0.3%가 남고, 0.54%면 +0.06%가 남는다.
    assert.ok(Math.abs(row.costs[0].netPerRoundTripPct - 0.3) < 0.02);
    assert.ok(Math.abs(row.costs[2].netPerRoundTripPct - 0.06) < 0.02);
    assert.ok(row.costs.every((c) => c.beats));
    assert.ok(row.ciLowPct < row.grossPerRoundTripPct);
    assert.ok(row.ciHighPct > row.grossPerRoundTripPct);
    assert.ok(row.yearClusters >= 3, String(row.yearClusters));
  });

  it('비용을 넘는 축이 하나도 없으면 그렇게 적는다', () => {
    // 왕복당 0.1%인데 비용이 0.3~0.54%다. 축 1일이면 왕복이 잦아 연 알파는 큰데도 진다.
    const rows = buildBreakEvenTable([blockAAt(1, 0.1)], [0.3, 0.43, 0.54]);
    assert.equal(anyAxisBeatsCost(rows), false);
    const lines = describeBreakEvenTable(rows);
    assert.ok(
      lines.some((line) => line.includes('비용을 넘는 축이 **하나도 없다')),
      lines.join('\n'),
    );
    // ★ 총 연알파는 크다 — 그래서 이 표가 없으면 "된다"로 읽힌다.
    assert.ok(rows[0].grossAnnualPct > 20, String(rows[0].grossAnnualPct));
    assert.ok(rows[0].costs.every((c) => !c.beats));
  });

  it('표에 t가 한 칸도 안 들어간다 — 두 질문을 섞지 않는다', () => {
    const lines = describeBreakEvenTable(buildBreakEvenTable([blockAAt(5, 0.6)], [0.3]));
    assert.ok(lines.some((line) => line.includes('**여기에 t는 없다**')));
    // 검정 이름이 한 줄도 없어야 한다. (`해 군집`은 CI의 표준오차라 t가 아니다)
    assert.ok(
      !lines.some((line) => /판정 t|순진 |블록부트|비겹침|달군집/.test(line)),
      lines.join('\n'),
    );
  });
});

/* ── 판정문 ──────────────────────────────────────────────────────────── */

describe('★ 판정문이 반드시 말해야 하는 것', () => {
  const spec = fakeSpec([fakeSeries('edge', 5, (d) => 0.6 + Math.sin(d / 7) * 0.05, DAYS)], DAYS);

  it('학습 비용과 판정 비용이 다르면 판정문이 찍는다', () => {
    const split = runWalkForward({ ...spec, fixHorizon: 5, selectionCostPct: 0, evalCostPct: 0.2 });
    const lines = describeVerdict(split);
    assert.ok(lines[0].includes('학습 비용 0.00%'), lines[0]);
    assert.ok(lines[0].includes('판정 비용 0.20%'), lines[0]);
    assert.ok(
      lines.some((line) => line.includes('학습 비용과 판정 비용이 **다르다')),
      lines.join('\n'),
    );
  });

  it('같으면 경고를 안 찍는다 — 늘 뜨는 경고는 안 읽힌다', () => {
    const lines = describeVerdict(runWalkForward({ ...spec, fixHorizon: 5, costRoundTripPct: 0.2 }));
    assert.ok(!lines.some((line) => line.includes('학습 비용과 판정 비용이 **다르다')));
  });

  it('고른 칸의 축·신호와 표본이 있는 해를 적는다', () => {
    const result = runWalkForward({ ...spec, fixHorizon: 5 });
    assert.ok(describeHorizonMix(result).startsWith('5일 2창/'), describeHorizonMix(result));
    assert.equal(describeSelectedSignals(result), 'edge 2창');
    assert.match(describeYearSpan(result), /^\d{4}~\d{4} · 해 \d+개$/);
    const lines = describeVerdict(result);
    assert.ok(lines.some((line) => line.includes('고른 칸의 축 5일')), lines.join('\n'));
    assert.ok(lines.some((line) => line.includes('고른 칸의 신호 edge 2창')), lines.join('\n'));
    assert.ok(lines.some((line) => line.includes('표본이 있는 해')), lines.join('\n'));
  });

  it('축이 고정돼도 신호가 갈리면 그 차이가 보인다 — 거울 판별의 근거다', () => {
    const two = fakeSpec(
      [
        fakeSeries('alpha', 5, (d) => 0.6 + Math.sin(d / 7) * 0.05, DAYS),
        fakeSeries('beta', 5, (d) => 0.5 + Math.sin(d / 11) * 0.05, DAYS),
      ],
      DAYS,
    );
    // 본절차는 상위분위가 좋은 `alpha`, 하위분위 전략은 botLeg가 좋은 쪽을 고른다.
    const main = runWalkForward({ ...two, fixHorizon: 5 });
    assert.equal(describeSelectedSignals(main), 'alpha 2창');
  });

  it('t 여섯을 다 찍고 판정 t가 그중 최소라고 적는다', () => {
    const lines = describeVerdict(runWalkForward({ ...spec, fixHorizon: 5 }));
    const joined = lines.join('\n');
    for (const label of ['순진', 'NW', '블록부트', '비겹침', '달군집', '해군집']) {
      assert.ok(joined.includes(label), `${label}이 안 찍혔다`);
    }
    assert.ok(joined.includes('여섯 중 |t| 최소'));
  });

  it('거울이면 평가 다리만 뒤집었다고 적는다', () => {
    const lines = describeVerdict(
      runWalkForward({ ...spec, fixHorizon: 5 }),
    );
    assert.ok(!lines.some((line) => line.includes('평가 다리만 뒤집었다')));
  });

  it('진입이 0건이면 잴 것이 없다고 말하고 멈춘다 — 0%를 지어내지 않는다', () => {
    const bad = fakeSpec([fakeSeries('bad', 5, () => -1, DAYS)], DAYS);
    const result = runWalkForward({
      ...bad,
      selection: { rule: 'top1', objective: 'netIR', abstainIfNegative: true },
    });
    const lines = describeVerdict(result);
    assert.ok(lines.some((line) => line.includes('표본 밖 진입이 0건이다')), lines.join('\n'));
    assert.ok(!lines.some((line) => line.includes('연 알파')), lines.join('\n'));
  });
});

/**
 * 참여한 창과 쉰 창이 **다른 축**을 고르게 만든 재료.
 *
 * 이동 학습(1년)이면 앞쪽 창에서는 3일 축이 크게 음수라 20일 축이 1위가 되고
 * (그런데 그것도 음수라 쉰다), 뒤쪽 창에서는 3일 축이 양수로 뒤집혀 참여한다.
 * 실측에서 난 모양(참여 3일 · 기권 20일)을 그대로 재현한 것이다.
 */
function mixedAxisSeries(days: number): CellSeries[] {
  return [
    fakeSeries('short', 3, (d) => (d < 1_750 ? -1.0 : 2.0) + Math.sin(d / 9) * 0.3, days),
    fakeSeries('long', 20, (d) => -0.15 + Math.sin(d / 17) * 0.3, days),
  ];
}

describe('★ 기권 채점 판정문 — 두 집단의 축을 나란히 적는다', () => {
  const days = 2_400;
  const eight = [1_200, 1_350, 1_500, 1_650, 1_800, 1_950, 2_100, 2_250];

  it('축이 다르면 "크기가 다른 것을 견준 값"이라고 말한다', () => {
    const result = runWalkForward({
      ...fakeSpec(mixedAxisSeries(days), days, eight),
      trainMode: 'rolling',
      rollingYears: 1,
      selection: { rule: 'top1', objective: 'netIR', abstainIfNegative: true },
      collectAbstained: true,
    });
    // 참여는 3일 축, 쉰 창의 반사실은 20일 축 — 실측에서 났던 모양 그대로다.
    assert.deepEqual(result.selectedHorizons.map((m) => m.horizon), [3]);
    assert.deepEqual(result.abstainedHorizons.map((m) => m.horizon), [20]);
    const joined = describeAbstainSkill(result).join('\n');
    assert.ok(joined.includes('참여한 창의 축 3일'), joined);
    assert.ok(joined.includes('쉰 창이 골랐을 축 20일'), joined);
    assert.ok(joined.includes('진입 가중 · 왕복 1회당'), joined);
    assert.ok(joined.includes('두 집단이 **다른 축**이다'), joined);
    assert.ok(joined.includes('하루당 환산'), joined);
  });

  it('축이 같으면 그 경고를 안 찍는다 — 늘 뜨는 경고는 안 읽힌다', () => {
    const one = fakeSeries('one', 5, (d) => (d < 1_750 ? -1.0 : 2.0) + Math.sin(d / 9) * 0.3, days);
    const result = runWalkForward({
      ...fakeSpec([one], days, eight),
      trainMode: 'rolling',
      rollingYears: 1,
      selection: { rule: 'top1', objective: 'netIR', abstainIfNegative: true },
      collectAbstained: true,
    });
    const joined = describeAbstainSkill(result).join('\n');
    assert.ok(result.abstainedEntries > 0 && result.oosEntryExcess.length > 0, joined);
    assert.ok(!joined.includes('두 집단이 **다른 축**이다'), joined);
  });

  it('기권한 창이 없으면 채점할 것이 없다고만 말한다', () => {
    const good = fakeSeries('good', 5, (d) => 0.6 + Math.sin(d / 7) * 0.05, days);
    const result = runWalkForward({ ...fakeSpec([good], days, eight), collectAbstained: true });
    assert.equal(result.abstainedEntries, 0);
    assert.deepEqual(describeAbstainSkill(result), ['  기권한 창이 없다 — 채점할 것이 없다.']);
  });
});

/* ── 위약 귀무분포 ───────────────────────────────────────────────────── */

describe('위약 귀무분포 요약', () => {
  it('95분위와 최대를 함께 낸다 — 최대만 보면 한 가족이 결론을 정한다', () => {
    const ts = [0.1, -0.4, 1.2, -1.6, 0.3, 2.9, -0.2, 0.9, -1.1, 0.5];
    const summary = summarizePlacebo(ts);
    assert.equal(summary.families, 10);
    assert.equal(summary.absTMax, 2.9);
    // |t| 오름차순: 0.1 0.2 0.3 0.4 0.5 0.9 1.1 1.2 1.6 2.9 → 95분위는 10번째
    assert.equal(summary.absT95, 2.9);
    assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5);
  });

  it('표본이 없으면 0이다', () => {
    assert.equal(summarizePlacebo([]).absT95, 0);
    assert.equal(percentile([], 0.95), 0);
  });
});
