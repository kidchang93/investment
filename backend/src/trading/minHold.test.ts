/**
 * 최소 보유 시간 판정 검증.
 *
 * 이 판정이 막는 것은 **매도**라, 틀리면 못 파는 종목이 생긴다 — 이 레포에서 가장
 * 위험한 방향이다. 그래서 네 가지를 값으로 못 박는다.
 *
 *   ① 경계 — 정확히 N분이면 판다
 *   ② 매수 기록이 없으면 판다 (모르면 막지 않는다)
 *   ③ 0분이면 늘 판다 (기본값이 지금 동작을 바꾸지 않는다)
 *   ④ 매수 신호는 어떤 값에서도 안 막힌다
 *
 * 시각은 전부 인자로 넘긴다. `Date`를 갈아 끼우지 않는다 — 그 방식은 페이지를
 * 멈추게 하고, 시험이 도는 시각에 따라 결과가 흔들린다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkMinHold,
  describeMinHoldDefer,
  describeMinHoldSetting,
  type MinHoldInput,
} from './minHold.js';

/** 판정 시각. 값 자체는 아무 의미가 없고 경계만 잰다. */
const NOW = new Date('2026-08-03T10:30:00+09:00').getTime();
const MINUTE = 60_000;

/** 산 지 `minutes`분 지난 상태. */
function boughtMinutesAgo(minutes: number): number {
  return NOW - minutes * MINUTE;
}

function sell(overrides: Partial<MinHoldInput> = {}): MinHoldInput {
  return {
    side: 'sell',
    minHoldMinutes: 60,
    boughtAtMs: boughtMinutesAgo(10),
    nowMs: NOW,
    ...overrides,
  };
}

describe('최소 보유 — 매수는 막지 않는다', () => {
  it('매수 신호는 방금 산 종목이어도 통과한다', () => {
    const decision = checkMinHold({
      side: 'buy',
      minHoldMinutes: 120,
      boughtAtMs: NOW,
      nowMs: NOW,
    });
    assert.equal(decision.defer, false);
    assert.equal(decision.reason, 'notSell');
  });

  it('매수 확인이 맨 앞이라 매수 기록이 있든 없든 같다', () => {
    for (const boughtAtMs of [undefined, NOW, boughtMinutesAgo(1000)]) {
      const decision = checkMinHold({ side: 'buy', minHoldMinutes: 390, boughtAtMs, nowMs: NOW });
      assert.equal(decision.defer, false, `boughtAtMs=${String(boughtAtMs)}`);
    }
  });
});

describe('최소 보유 — 0분이면 지금 동작 그대로다', () => {
  it('방금 산 종목도 판다', () => {
    const decision = checkMinHold(sell({ minHoldMinutes: 0, boughtAtMs: NOW }));
    assert.equal(decision.defer, false);
    assert.equal(decision.reason, 'disabled');
  });

  it('음수·NaN도 끈 것으로 본다 — 켠 줄 알고 막히는 일이 없게', () => {
    for (const minHoldMinutes of [-1, Number.NaN, Number.NEGATIVE_INFINITY]) {
      const decision = checkMinHold(sell({ minHoldMinutes, boughtAtMs: NOW }));
      assert.equal(decision.defer, false, `minHoldMinutes=${minHoldMinutes}`);
      assert.equal(decision.reason, 'disabled');
    }
  });
});

describe('최소 보유 — 경계', () => {
  it('정확히 N분이면 판다', () => {
    const decision = checkMinHold(sell({ minHoldMinutes: 60, boughtAtMs: NOW - 60 * MINUTE }));
    assert.equal(decision.defer, false);
    assert.equal(decision.reason, 'satisfied');
  });

  it('1ms 모자라면 이번 회차에는 안 판다', () => {
    const decision = checkMinHold(sell({ minHoldMinutes: 60, boughtAtMs: NOW - 60 * MINUTE + 1 }));
    assert.equal(decision.defer, true);
    assert.equal(decision.reason, 'tooSoon');
    // 올림이라 "0분 남음"이 나오지 않는다 — 0분 남았다고 적으면 팔 수 있다는 말로 읽힌다.
    assert.equal(decision.remainingMinutes, 1);
    assert.equal(decision.heldMinutes, 59);
  });

  it('N분을 넘겼으면 판다', () => {
    const decision = checkMinHold(sell({ minHoldMinutes: 60, boughtAtMs: boughtMinutesAgo(61) }));
    assert.equal(decision.defer, false);
    assert.equal(decision.reason, 'satisfied');
  });

  it('경과는 내림, 남은 시간은 올림이다', () => {
    const decision = checkMinHold(
      sell({ minHoldMinutes: 120, boughtAtMs: NOW - (30 * MINUTE + 30_000) }),
    );
    assert.equal(decision.heldMinutes, 30);
    assert.equal(decision.remainingMinutes, 90);
  });

  it('매수 시각이 미래로 오면(시계 어긋남) 경과 0분으로 적고 막는다', () => {
    const decision = checkMinHold(sell({ minHoldMinutes: 60, boughtAtMs: NOW + 5 * MINUTE }));
    assert.equal(decision.defer, true);
    assert.equal(decision.heldMinutes, 0);
    assert.equal(decision.remainingMinutes, 65);
  });
});

describe('★ 최소 보유 — 산 지 얼마나 됐는지 모르면 판다', () => {
  it('러너를 켜기 전부터 들고 있던 종목은 그대로 판다', () => {
    const decision = checkMinHold(sell({ minHoldMinutes: 120, boughtAtMs: undefined }));
    assert.equal(decision.defer, false);
    assert.equal(decision.reason, 'unknownBuyTime');
  });

  it('읽을 수 없는 시각도 모름으로 본다 — 막는 쪽이 아니라 파는 쪽이다', () => {
    for (const boughtAtMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const decision = checkMinHold(sell({ minHoldMinutes: 120, boughtAtMs }));
      assert.equal(decision.defer, false, `boughtAtMs=${boughtAtMs}`);
      assert.equal(decision.reason, 'unknownBuyTime');
    }
  });

  it('판정 시각을 읽을 수 없어도 막지 않는다 — NaN 비교가 조용히 보류로 떨어지지 않게', () => {
    const decision = checkMinHold(sell({ minHoldMinutes: 120, nowMs: Number.NaN }));
    assert.equal(decision.defer, false);
    assert.equal(decision.reason, 'unknownBuyTime');
  });
});

describe('최소 보유 — 실행 기록 문구', () => {
  it('보류 사유에 남은 시간과 경과가 함께 남는다', () => {
    const decision = checkMinHold(sell({ minHoldMinutes: 60, boughtAtMs: boughtMinutesAgo(12) }));
    assert.equal(
      describeMinHoldDefer(decision, 60),
      '최소 보유 60분을 채우지 못해 이번 회차에는 팔지 않습니다 · 산 지 12분 · 남은 시간 48분',
    );
  });

  it('보류가 아니면 적지 않는다 — 판 회차에 보류 문구가 섞이지 않게', () => {
    const sold = checkMinHold(sell({ minHoldMinutes: 60, boughtAtMs: boughtMinutesAgo(90) }));
    assert.equal(describeMinHoldDefer(sold, 60), '');
    assert.equal(describeMinHoldDefer(checkMinHold(sell({ minHoldMinutes: 0 })), 0), '');
  });

  it('설정값은 켠 것과 끈 것을 다르게 적는다', () => {
    assert.equal(describeMinHoldSetting(0), '최소 보유 없음');
    assert.equal(describeMinHoldSetting(-5), '최소 보유 없음');
    assert.equal(describeMinHoldSetting(120), '최소 보유 120분');
  });
});
