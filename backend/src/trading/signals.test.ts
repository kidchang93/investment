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

import {
  SIGNAL_CANDIDATES,
  makePlaceboSignals,
  placeboSignal,
  type DailyBar,
  type SignalContext,
} from './signals.js';

function bar(day: number, close: number, foreign = 100, institution = 50, individual = -150): DailyBar {
  return {
    tradingDay: `2026070${day % 10}`,
    close,
    foreign,
    institution,
    individual,
    /*
     * 시세 쪽도 채운다. 안 채우면 그 필드를 쓰는 신호가 늘 `undefined`가 되어
     * **미래를 보는지 검사하지 못한 채 통과한다** — 있으나 마나 한 시험이 된다.
     */
    open: close * 0.99,
    high: close * (1.02 + (day % 3) * 0.01),
    low: close * (0.97 - (day % 4) * 0.005),
    turnover: 1_000_000_000 + (day % 6) * 300_000_000,
    shortRatio: 1 + (day % 5) * 0.8,
  };
}

/**
 * 300봉짜리 계열. 값이 서로 달라야 신호가 실제로 계산된다.
 *
 * ★ **30봉이었다가 늘렸다**(2026-08-24). 12-1 모멘텀·52주 신고가처럼 1년 축을
 *   보는 후보가 생겼는데, 짧은 계열에서는 그것들이 늘 `undefined`라 **미래를
 *   보는지 검사하지 못한 채 통과**했다. 시험 데이터가 후보의 축을 못 따라가면
 *   이 파일의 시험 전체가 있으나 마나 해진다.
 *
 *   규칙을 약하게 만든 것이 아니라 **재는 범위를 후보에 맞춘 것**이다.
 */
function series(): DailyBar[] {
  return Array.from({ length: 300 }, (_, i) =>
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
        i <= index
          ? b
          : {
              ...b,
              close: b.close * 3,
              foreign: -99_999,
              institution: 42,
              individual: 7,
              open: b.close * 3,
              high: b.close * 9,
              low: b.close * 0.1,
              turnover: 987_654_321_000,
              shortRatio: 44.4,
            },
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

  /*
   * 수급 TR만 받고 돌리는 호출부가 있어 시세 필드가 통째로 빌 수 있다. 그때
   * 0으로 채우면 **모든 종목이 같은 점수**가 되어 십분위가 사실상 무작위가 된다 —
   * 그러고도 하네스는 정상으로 보이는 표를 찍는다. 그게 제일 나쁜 실패다.
   */
  it('시세 필드가 없으면 시세 기반 신호는 undefined다', () => {
    const flowOnly = series().map(({ tradingDay, close, foreign, institution, individual }) => ({
      tradingDay,
      close,
      foreign,
      institution,
      individual,
    }));
    for (const key of ['turnoverSurge', 'surgeMomentum', 'shortRatioLow', 'parkinsonVol']) {
      const signal = SIGNAL_CANDIDATES.find((s) => s.key === key);
      assert.ok(signal, key);
      assert.equal(
        signal.score({ history: flowOnly, index: 28 }),
        undefined,
        `${key}: 시세가 없는데 값을 냈다`,
      );
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

  /*
   * 일봉 저장소에는 시세만 있다. 수급·공매도 신호를 그대로 태우면 오류가 아니라
   * **조용히 `undefined`**가 되고 날짜 수만 줄어든 표가 정상처럼 찍힌다.
   * 표시가 값으로 있어야 부른 쪽이 "무엇이 왜 빠졌는지"를 적을 수 있다.
   */
  it('모든 후보가 요구 데이터와 가설을 못 박은 날을 적어 두었다', () => {
    for (const signal of SIGNAL_CANDIDATES) {
      assert.ok(
        ['price', 'flow', 'short'].includes(signal.dataRequirement),
        `${signal.key}: dataRequirement가 없다`,
      );
      assert.match(signal.frozenAt, /^\d{4}-\d{2}-\d{2}$/, `${signal.key}: frozenAt이 날짜가 아니다`);
    }
  });

  it('수급을 쓰는 신호는 flow로, 공매도를 쓰는 신호는 short로 표시돼 있다', () => {
    const requirementOf = (key: string): string =>
      SIGNAL_CANDIDATES.find((s) => s.key === key)?.dataRequirement ?? '(없음)';
    for (const key of [
      'foreign1', 'foreign5', 'institution5', 'individualContrarian5', 'smartMoney5', 'flowMomentum',
    ]) {
      assert.equal(requirementOf(key), 'flow', key);
    }
    assert.equal(requirementOf('shortRatioLow'), 'short');
    for (const key of [
      'momentum20', 'reversal1', 'reversal5', 'lowVolatility', 'parkinsonVol',
      'turnoverSurge', 'surgeMomentum', 'squeezeWidth', 'squeezeRelease',
    ]) {
      assert.equal(requirementOf(key), 'price', key);
    }
  });

  /*
   * ★ 표시가 실제와 어긋나면 표시가 있으나 마나다. **시세만 있는 계열**을 태워
   * `price`라고 적은 신호가 정말 점수를 내는지 잰다 — 일봉 저장소가 주는 것이
   * 정확히 이 모양이다(수급 셋이 NaN).
   */
  it("price라고 적은 신호는 수급이 NaN이어도 점수를 낸다", () => {
    const priceOnly = series().map((b) => ({
      ...b,
      individual: Number.NaN,
      foreign: Number.NaN,
      institution: Number.NaN,
      shortRatio: undefined,
    }));
    /*
     * ★ 자리는 **신호마다 그 축에 맞춰** 준다. 28로 못 박으면 1년 축 후보가
     *   "수급이 없어서"가 아니라 "앞자리가 모자라서" undefined가 되고, 시험이
     *   재려던 것과 다른 것을 재게 된다.
     */
    const at = (signal: { minHistory: number }): number => Math.max(28, signal.minHistory);
    for (const signal of SIGNAL_CANDIDATES.filter((s) => s.dataRequirement === 'price')) {
      const score = signal.score({ history: priceOnly, index: at(signal) });
      assert.notEqual(score, undefined, `${signal.key}: price라는데 값이 안 나온다`);
      assert.ok(Number.isFinite(score as number), `${signal.key}: ${score}`);
    }
    for (const signal of SIGNAL_CANDIDATES.filter((s) => s.dataRequirement !== 'price')) {
      const score = signal.score({ history: priceOnly, index: at(signal) });
      const usable = score !== undefined && Number.isFinite(score);
      assert.equal(usable, false, `${signal.key}: 수급이 없는데 쓸 수 있는 점수를 냈다`);
    }
  });
});

/*
 * ── 변동성 압축·확장 ─────────────────────────────────────────────────────
 *
 * 위의 시험들은 **목록을 통째로 도는** 것이라 "미래를 보나 / 0으로 채우나"만 잰다.
 * 값이 실제로 맞는지는 손으로 셀 수 있는 계열을 만들어 따로 재야 한다 — 부호가
 * 뒤집혀 있어도 저 시험들은 전부 통과하기 때문이다.
 */
describe('변동성 압축·확장', () => {
  function signalOf(key: string): (ctx: SignalContext) => number | undefined {
    const found = SIGNAL_CANDIDATES.find((s) => s.key === key);
    assert.ok(found, `${key}가 목록에 없다`);
    return (ctx) => found.score(ctx);
  }

  /** 매일 같은 폭으로 움직이는 계열. 종가는 `closes`가 정한다. */
  function flat(length: number, halfRange: number, closeOf: (i: number) => number): DailyBar[] {
    return Array.from({ length }, (_, i) => {
      const close = closeOf(i);
      return {
        tradingDay: `2026${String(700 + i).padStart(4, '0')}`,
        close,
        foreign: 1,
        institution: 1,
        individual: -2,
        open: close,
        high: close + halfRange,
        low: close - halfRange,
      };
    });
  }

  it('squeezeRelease — 오늘 진폭이 평소의 네 배면 log 4다', () => {
    const bars = flat(30, 1, () => 100);
    // 앞 20일은 고−저 = 2로 고정이고, 오늘만 8이다.
    bars[29] = { ...bars[29], high: 104, low: 96 };
    const score = signalOf('squeezeRelease')({ history: bars, index: 29 });
    assert.ok(
      Math.abs((score as number) - Math.log(4)) < 1e-9,
      `${score} (log4 = ${Math.log(4)})`,
    );
  });

  it('squeezeRelease — 평소와 같은 날이면 0이다', () => {
    const bars = flat(30, 1, () => 100);
    const score = signalOf('squeezeRelease')({ history: bars, index: 29 });
    assert.ok(Math.abs(score as number) < 1e-12, String(score));
  });

  /*
   * ★ 국내 시장에서 이것이 실제로 있는 일이다 — 상한가 직행은 고가와 저가가 같아
   * **고−저로 재면 진폭 0**, 즉 "가장 조용한 날"이 된다. 트루 레인지는 전일 종가를
   * 보므로 그 날을 가장 큰 날로 잡는다. 이 시험이 그 차이를 지킨다.
   */
  it('squeezeRelease — 고가와 저가가 같아도 갭이 있으면 진폭으로 잡는다', () => {
    const bars = flat(30, 1, () => 100);
    // 전일 종가 100에서 130으로 뛰어 그대로 굳었다. 고−저는 0이고 트루 레인지는 30이다.
    bars[29] = { ...bars[29], close: 130, open: 130, high: 130, low: 130 };
    const score = signalOf('squeezeRelease')({ history: bars, index: 29 });
    assert.ok(
      Math.abs((score as number) - Math.log(15)) < 1e-9,
      `${score} (log15 = ${Math.log(15)})`,
    );
  });

  it('squeezeWidth — 종가 산포가 같아도 장중 진폭이 크면 더 압축으로 본다', () => {
    const closeOf = (i: number): number => 100 + (i % 2) * 2;
    const narrow = signalOf('squeezeWidth')({ history: flat(30, 1, closeOf), index: 29 }) as number;
    const wide = signalOf('squeezeWidth')({ history: flat(30, 5, closeOf), index: 29 }) as number;
    // 켈트너가 넓어지면 볼린저÷켈트너가 작아지고, 역방향이라 점수는 올라간다.
    assert.ok(wide > narrow, `장중이 넓은 쪽이 더 높아야 한다: ${wide} vs ${narrow}`);
  });

  it('squeezeWidth — 종가가 20일 내내 같으면 점수를 내지 않는다', () => {
    const bars = flat(30, 1, () => 100);
    const score = signalOf('squeezeWidth')({ history: bars, index: 29 });
    // 산포가 0이면 볼린저 폭이 0이라 비를 만들 수 없다. 0으로 채우지 않는다.
    assert.equal(score, undefined);
  });
});

/*
 * ── 위약 ─────────────────────────────────────────────────────────────────
 *
 * 우위가 없는 것이 확실한 신호를 같은 절차에 태워, 절차 자체가 무언가를
 * "찾아내는지"를 잰다. 그러려면 두 가지가 성립해야 한다 —
 * **같은 시드는 언제나 같은 점수**(실행 재현), **시드가 다르면 다른 점수**(표본이 여럿).
 */
describe('위약 신호', () => {
  const bars = series();

  it('같은 시드·같은 종목·같은 날이면 언제나 같은 점수다', () => {
    const a = placeboSignal(7).score({ history: bars, index: 12, symbol: '005930' });
    const b = placeboSignal(7).score({ history: bars, index: 12, symbol: '005930' });
    assert.equal(a, b);
    assert.ok(a !== undefined && a >= 0 && a < 1, String(a));
  });

  it('시드가 다르면 점수가 다르다', () => {
    const a = placeboSignal(1).score({ history: bars, index: 12, symbol: '005930' });
    const b = placeboSignal(2).score({ history: bars, index: 12, symbol: '005930' });
    assert.notEqual(a, b);
  });

  it('종목이 다르면 점수가 다르다 — 아니면 십분위가 뜻을 잃는다', () => {
    const a = placeboSignal(1).score({ history: bars, index: 12, symbol: '005930' });
    const b = placeboSignal(1).score({ history: bars, index: 12, symbol: '000660' });
    assert.notEqual(a, b);
  });

  it('종목을 모르면 점수를 내지 않는다 — 전 종목 같은 값으로 채우지 않는다', () => {
    assert.equal(placeboSignal(1).score({ history: bars, index: 12 }), undefined);
  });

  it('미래를 보지 않는다', () => {
    const index = 20;
    const before = placeboSignal(3).score({ history: bars, index, symbol: 'A' });
    const tampered = bars.map((b, i) => (i <= index ? b : { ...b, close: b.close * 5 }));
    assert.equal(placeboSignal(3).score({ history: tampered, index, symbol: 'A' }), before);
  });

  it('여러 개를 시드 범위로 만든다 — 양끝을 포함한다', () => {
    const signals = makePlaceboSignals(1, 20);
    assert.equal(signals.length, 20);
    assert.equal(new Set(signals.map((s) => s.key)).size, 20);
    for (const signal of signals) {
      assert.equal(signal.dataRequirement, 'price');
      assert.ok(signal.rationale.length > 30, signal.key);
    }
  });

  /*
   * 값이 [0,1)에 고르게 퍼져야 십분위가 실제로 십분위다. 한쪽으로 쏠리면
   * 위약이 "우위 없음"이 아니라 다른 무언가를 재게 된다.
   */
  it('점수가 [0,1)에 고르게 퍼진다', () => {
    const signal = placeboSignal(42);
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 10_000; i += 1) {
      const score = signal.score({
        history: [{ tradingDay: String(20200101 + i), close: 1, individual: 0, foreign: 0, institution: 0 }],
        index: 0,
        symbol: `S${i % 97}`,
      });
      assert.ok(score !== undefined);
      buckets[Math.min(9, Math.floor(score * 10))] += 1;
    }
    for (const count of buckets) assert.ok(count > 800 && count < 1_200, buckets.join(','));
  });
});
