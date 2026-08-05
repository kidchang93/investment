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

function bars(closes: number[]): DailyBar[] {
  return closes.map((close, i) => ({
    tradingDay: String(20260101 + i),
    close,
    individual: -100,
    foreign: 60,
    institution: 40,
  }));
}

/** 점수를 미리 정해 주는 신호. 계산만 재려는 것이라 내용은 중요하지 않다. */
function fixedScore(scoreBySymbolIndex: (index: number) => number): SignalCandidate {
  return {
    key: 'fixed',
    label: '고정 점수',
    rationale: '계산을 재려고 만든 것이다. 실제 후보가 아니며 값에 뜻이 없다.',
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
