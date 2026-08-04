/**
 * 후보 신호 검증.
 *
 * ★ **가장 중요한 것은 "미래를 안 보는가"다.** 신호 하나가 `index` 뒤를 보면
 * 하네스가 내놓는 모든 값이 거짓이 되고, 그 거짓은 **좋아 보이는 쪽으로** 나온다 —
 * 알아채기 가장 어려운 종류의 오류다.
 *
 * 그래서 미래 값을 아무렇게나 바꿔 가며 점수가 흔들리지 않는지 잰다. 신호를
 * 새로 넣을 때 이 시험이 자동으로 그것도 검사한다(목록을 통째로 돈다).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SIGNAL_CANDIDATES, type DailyBar, type SignalContext } from './signals.js';

function bar(day: number, close: number, foreign = 100, institution = 50, individual = -150): DailyBar {
  return {
    tradingDay: `2026070${day % 10}`,
    close,
    foreign,
    institution,
    individual,
  };
}

/** 30봉짜리 계열. 값이 서로 달라야 신호가 실제로 계산된다. */
function series(): DailyBar[] {
  return Array.from({ length: 30 }, (_, i) =>
    bar(i, 10_000 + i * 137 - (i % 3) * 400, 100 + (i % 7) * 30, 50 - (i % 5) * 20, -150 + (i % 4) * 60),
  );
}

describe('신호 — 미래를 보지 않는다', () => {
  /*
   * 판정하는 날 뒤의 값을 통째로 바꿔도 점수가 같아야 한다. 다르면 그 신호는
   * 미래를 보고 있고, 그것으로 잰 우위는 전부 가짜다.
   */
  it('index 뒤를 바꿔도 점수가 같다', () => {
    const base = series();
    const index = 25;
    for (const signal of SIGNAL_CANDIDATES) {
      const before = signal.score({ history: base, index });
      const tampered = base.map((b, i) =>
        i <= index ? b : { ...b, close: b.close * 3, foreign: -99_999, institution: 42, individual: 7 },
      );
      const after = signal.score({ history: tampered, index });
      assert.deepEqual(after, before, `${signal.key}: 미래를 보고 있다`);
    }
  });

  /* 마지막 자리에서도 점수가 나와야 한다 — 뒤가 없다고 undefined면 실전에서 못 쓴다. */
  it('마지막 봉에서도 점수가 나온다', () => {
    const bars = series();
    for (const signal of SIGNAL_CANDIDATES) {
      const score = signal.score({ history: bars, index: bars.length - 1 });
      assert.notEqual(score, undefined, `${signal.key}: 마지막 봉에서 undefined다`);
    }
  });
});

describe('신호 — 모르는 것을 0으로 채우지 않는다', () => {
  it('앞 봉이 모자라면 undefined다', () => {
    const bars = series();
    for (const signal of SIGNAL_CANDIDATES) {
      // 오늘 하루만 보는 신호는 첫 봉부터 값이 나온다. 잴 앞자리가 없다.
      if (signal.minHistory === 0) continue;
      const score = signal.score({ history: bars, index: signal.minHistory - 1 });
      assert.equal(score, undefined, `${signal.key}: 앞이 모자란데 값을 냈다`);
    }
  });

  /*
   * 매매가 한 건도 없던 날은 순매수 **비중**을 만들 수 없다. 0으로 채우면
   * "중립"이 되는데 그건 거짓이다 — 모르는 것과 중립은 다르다.
   */
  it('매매가 없던 날이 섞이면 수급 신호는 undefined다', () => {
    const bars = series().map((b, i) =>
      i === 27 ? { ...b, foreign: 0, institution: 0, individual: 0 } : b,
    );
    /*
     * `foreign1`은 뺀다 — 그날 하루만 보므로 27일이 비어도 28일 점수에 안 닿는다.
     * 여기 넣으면 시험이 "안 보는 날까지 봐야 한다"고 요구하는 셈이다.
     */
    const flowKeys = ['foreign5', 'institution5', 'individualContrarian5', 'smartMoney5'];
    for (const key of flowKeys) {
      const signal = SIGNAL_CANDIDATES.find((s) => s.key === key);
      assert.ok(signal, key);
      assert.equal(signal.score({ history: bars, index: 28 }), undefined, `${key}: 0으로 채웠다`);
    }
  });
});

describe('신호 — 목록이 규율을 지킨다', () => {
  /*
   * 후보 하나가 늘면 모든 후보의 본페로니 문턱이 함께 올라간다. 그래서
   * "혹시 몰라서" 넣는 것을 막아야 하고, 가설을 적을 수 있는지가 그 잣대다.
   */
  it('모든 후보가 왜 우위가 있을 수 있는지를 적어 두었다', () => {
    for (const signal of SIGNAL_CANDIDATES) {
      assert.ok(signal.rationale.length > 30, `${signal.key}: 가설이 비었거나 너무 짧다`);
      assert.ok(signal.label.length > 0, signal.key);
    }
  });

  it('key가 겹치지 않는다', () => {
    const keys = SIGNAL_CANDIDATES.map((s) => s.key);
    assert.equal(new Set(keys).size, keys.length, keys.join(', '));
  });

  it('minHistory가 실제로 필요한 만큼이다', () => {
    const bars = series();
    for (const signal of SIGNAL_CANDIDATES) {
      // 선언한 자리에서는 값이 나와야 한다. 더 필요하면 선언이 거짓이다.
      const ctx: SignalContext = { history: bars, index: signal.minHistory };
      assert.notEqual(
        signal.score(ctx),
        undefined,
        `${signal.key}: minHistory ${signal.minHistory}인데 그 자리에서 값이 안 나온다`,
      );
    }
  });
});
