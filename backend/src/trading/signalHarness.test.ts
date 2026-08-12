/**
 * 하네스 검증 — 특히 **시장을 빼는 계산**.
 *
 * 2026-08-04 첫 실행에서 저변동성이 20일 축 우위 +5.807%(t 10.68)로 살아남았다.
 * 그런데 그 구간은 평범한 종목이 20일에 −5.7% 빠지던 장이었고, 시장이 빠지면
 * 고변동 종목이 더 크게 빠지므로 **"저변동이 이긴다"가 자동으로 나온다.**
 *
 * 그건 우위가 아니라 노출이다. 이 시험이 그 둘을 가르는 계산을 못 박는다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bonferroniThreshold, runSignalHarness } from './signalHarness.js';
import type { DailyBar, SignalCandidate } from './signals.js';

/**
 * ★ **`open`을 채운다.** 하네스가 2026-08-12부터 **익일 시가**로 진입하므로,
 * 시가가 없으면 표본이 0건이 되고 그 사실이 `noEntry`로 세어진다. 여기서는
 * 시가=종가로 두어 갭 없이 하루만 밀린 계열을 만든다 — 이 시험이 재는 것은
 * 시장 노출이지 진입 basis가 아니다.
 */
function bars(closes: number[]): DailyBar[] {
  return closes.map((close, i) => ({
    tradingDay: String(20260101 + i),
    close,
    individual: -100,
    foreign: 60,
    institution: 40,
    open: close,
    high: close,
    low: close,
  }));
}

/** 점수를 미리 정해 주는 신호. 계산만 재려는 것이라 내용은 중요하지 않다. */
function fixedScore(scoreBySymbolIndex: (index: number) => number): SignalCandidate {
  return {
    key: 'fixed',
    label: '고정 점수',
    rationale: '계산을 재려고 만든 것이다. 실제 후보가 아니며 값에 뜻이 없다.',
    dataRequirement: 'price',
    frozenAt: '2026-08-04',
    minHistory: 0,
    score: (ctx) => scoreBySymbolIndex(ctx.history[0].close),
  };
}

describe('본페로니 문턱', () => {
  it('칸이 늘면 문턱이 올라간다', () => {
    assert.ok(bonferroniThreshold(40) > bonferroniThreshold(4));
    assert.ok(bonferroniThreshold(4) > bonferroniThreshold(1));
  });

  it('40칸이면 3.2 근처다 — 순진한 1.96보다 훨씬 높다', () => {
    const t = bonferroniThreshold(40);
    assert.ok(t > 3.0 && t < 3.5, String(t));
  });
});

describe('시장을 빼면 노출과 우위가 갈린다', () => {
  /*
   * 상위 버킷이 시장의 2배로 움직이고 고유한 몫은 0인 경우.
   * 원시 우위는 시장이 오르내린 만큼 나오지만 **알파는 0이어야 한다.**
   */
  it('시장 배수만 다르면 알파가 0에 가깝다', () => {
    const market = [2, -3, 4, -1, 5, -2, 3, -4, 1, -5, 2, 3];
    const barsBySymbol = new Map<string, DailyBar[]>();
    // 종목 30개: 절반은 시장의 2배, 절반은 1배. 고유 수익은 없다.
    for (let i = 0; i < 30; i += 1) {
      const multiple = i < 15 ? 2 : 1;
      let price = 10_000;
      const closes = [price];
      for (const m of market) {
        price *= 1 + (m * multiple) / 100;
        closes.push(price);
      }
      // 점수를 배수로 준다 — 상위 버킷이 곧 고배수 종목이 된다.
      barsBySymbol.set(`S${i}`, bars(closes).map((b, j) => (j === 0 ? { ...b, close: multiple } : b)));
    }
    // 첫 봉의 close를 점수 통로로 쓴 것이라 실제 가격은 두 번째 봉부터다.
    for (const [key, list] of barsBySymbol) {
      barsBySymbol.set(key, list.slice(1));
    }

    const result = runSignalHarness({
      barsBySymbol,
      signals: [
        {
          key: 'beta',
          label: '시장 배수',
          rationale: '고유 수익 없이 시장 배수만 다른 경우를 만들어 알파가 0인지 본다.',
          dataRequirement: 'price',
          frozenAt: '2026-08-04',
          minHistory: 1,
          // 앞 두 봉의 변화 크기가 곧 그 종목의 배수다.
          score: (ctx) => Math.abs(ctx.history[1].close / ctx.history[0].close - 1),
        },
      ],
      horizons: [1],
      minNamesPerDay: 30,
      buckets: 2,
    });

    const cell = result.cells[0];
    // 베타가 뚜렷해야 이 시험이 뜻이 있다 — 배수 차이를 실제로 잡았는가.
    assert.ok(Math.abs(cell.beta) > 0.2, `베타가 너무 작다: ${cell.beta}`);
    // 고유 수익이 없으므로 알파는 원시 우위보다 훨씬 작아야 한다.
    assert.ok(
      Math.abs(cell.alpha) < Math.abs(cell.spreadMean),
      `알파 ${cell.alpha}가 원시 ${cell.spreadMean}보다 작지 않다`,
    );
  });

  it('날짜가 모자라면 회귀를 하지 않는다 — 0으로 채우지 않고 0을 돌려준다', () => {
    const barsBySymbol = new Map<string, DailyBar[]>();
    for (let i = 0; i < 30; i += 1) barsBySymbol.set(`S${i}`, bars([100, 101]));
    const result = runSignalHarness({
      barsBySymbol,
      signals: [fixedScore((c) => c)],
      horizons: [1],
      minNamesPerDay: 30,
      buckets: 2,
    });
    assert.equal(result.cells[0].alphaT, 0);
  });
});

/*
 * ── ★ 진입 basis (2026-08-12) ────────────────────────────────────────────
 *
 * 옛 하네스는 그날 종가로 점수를 내고 **그 종가로 샀다.** 종가를 알 수 있는
 * 시각은 15:30이고 우리가 살 수 있는 가장 이른 시각은 다음 날 09:00이다.
 * 원장에 남은 176줄이 전부 그 위에 있다.
 */
describe('하네스 — 진입 basis', () => {
  function marketBars(gap: number): Map<string, DailyBar[]> {
    const map = new Map<string, DailyBar[]>();
    for (let s = 0; s < 40; s += 1) {
      const list: DailyBar[] = [];
      let close = 10_000 + s * 50;
      for (let d = 0; d < 40; d += 1) {
        const open = close * (1 + ((s % 5) - 2) * gap);
        close = open * (1 + ((d + s) % 4) * 0.004 - 0.005);
        list.push({
          tradingDay: String(20260101 + d),
          close,
          individual: -100,
          foreign: 60,
          institution: 40,
          open,
          high: Math.max(open, close),
          low: Math.min(open, close),
        });
      }
      map.set(`S${String(s).padStart(2, '0')}`, list);
    }
    return map;
  }

  const signal: SignalCandidate = {
    key: 'reversal',
    label: '전날 하락폭',
    rationale: '많이 떨어진 것이 되돌아온다는 통념. 여기서는 basis 차이를 드러낼 재료로만 쓴다.',
    dataRequirement: 'price',
    frozenAt: '2026-08-12',
    minHistory: 1,
    score: (ctx) => -(ctx.history[ctx.index].close / ctx.history[ctx.index - 1].close - 1),
  };

  it('기본값이 익일 시가다 — 결과에 값으로 남는다', () => {
    const result = runSignalHarness({
      barsBySymbol: marketBars(0.006),
      signals: [signal],
      horizons: [5],
      minNamesPerDay: 30,
      buckets: 10,
    });
    assert.equal(result.entryBasis, 'nextOpen');
  });

  it('익일 시가와 종가 진입이 다른 값을 낸다', () => {
    const barsBySymbol = marketBars(0.006);
    const run = (entryBasis: 'nextOpen' | 'sameClose'): number =>
      runSignalHarness({
        barsBySymbol, signals: [signal], horizons: [5], minNamesPerDay: 30, buckets: 10, entryBasis,
      }).cells[0].topLegMean;
    assert.notEqual(run('nextOpen'), run('sameClose'));
  });

  /*
   * ★ 시가가 없는 계열(수급 TR만 받은 경우)에서 표본이 조용히 0이 되면 안 된다.
   * **몇 건을 못 샀는지가 값으로 남아야** 그 표를 읽는 사람이 속지 않는다.
   */
  it('시가가 없으면 못 산 건수를 센다 — 조용히 사라지지 않는다', () => {
    const flowOnly = new Map<string, DailyBar[]>();
    for (const [key, list] of marketBars(0.006)) {
      flowOnly.set(key, list.map(({ tradingDay, close, individual, foreign, institution }) => ({
        tradingDay, close, individual, foreign, institution,
      })));
    }
    const cell = runSignalHarness({
      barsBySymbol: flowOnly, signals: [signal], horizons: [5], minNamesPerDay: 30, buckets: 10,
    }).cells[0];
    assert.equal(cell.days, 0);
    assert.ok(cell.noEntry > 0, '시가가 없는데 못 산 건수가 0이다');
  });

  it('청산봉이 없으면 마지막 봉으로 나가고 센다', () => {
    const barsBySymbol = new Map<string, DailyBar[]>();
    for (const [key, list] of marketBars(0.002)) {
      // 절반을 12봉에서 끊는다(폐지·장기정지). 축 20일이라 청산봉이 없다.
      barsBySymbol.set(key, key < 'S20' ? list.slice(0, 12) : list);
    }
    const cell = runSignalHarness({
      barsBySymbol, signals: [signal], horizons: [20], minNamesPerDay: 30, buckets: 10,
    }).cells[0];
    assert.ok(cell.truncatedExits > 0, '강제청산이 한 건도 안 세어졌다');
  });

  it('두 다리를 나란히 낸다 — 부호가 갈리는지 볼 수 있게', () => {
    const cell = runSignalHarness({
      barsBySymbol: marketBars(0.006),
      signals: [signal],
      horizons: [5],
      minNamesPerDay: 30,
      buckets: 10,
    }).cells[0];
    // 상위−하위가 두 다리의 차이와 맞아야 계산이 어긋나지 않은 것이다.
    assert.ok(Math.abs((cell.topLegMean - cell.botLegMean) - cell.spreadMean) < 1e-6);
  });

  it('겹치는 선도수익률용 t를 나란히 낸다', () => {
    const cell = runSignalHarness({
      barsBySymbol: marketBars(0.006),
      signals: [signal],
      horizons: [5],
      minNamesPerDay: 30,
      buckets: 10,
    }).cells[0];
    assert.ok(Number.isFinite(cell.tNeweyWest));
    assert.ok(cell.namesPerDayMin > 0 && cell.namesPerDayMedian >= cell.namesPerDayMin);
  });
});
