/**
 * 최소 보유 시간 판정 검증.
 *
 * 이 판정이 막는 것은 **매도**라, 틀리면 못 파는 종목이 생긴다 — 이 레포에서 가장
 * 위험한 방향이다. 그래서 세 가지를 값으로 못 박는다.
 *
 *   ① 경계 — 정확히 N분이면 판다
 *   ② 매수 기록이 없으면 판다 (모르면 막지 않는다)
 *   ③ 0분이면 늘 판다 (기본값이 지금 동작을 바꾸지 않는다)
 *
 * 시각은 전부 인자로 넘긴다. `Date`를 갈아 끼우지 않는다 — 그 방식은 페이지를
 * 멈추게 하고, 시험이 도는 시각에 따라 결과가 흔들린다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { minHoldDefersSell, type MinHoldInput } from './minHold.js';

/** 판정 시각. 값 자체는 아무 의미가 없고 경계만 잰다. */
const NOW = new Date('2026-08-03T10:30:00+09:00').getTime();
const MINUTE = 60_000;

function sell(overrides: Partial<MinHoldInput> = {}): MinHoldInput {
  return {
    minHoldMinutes: 60,
    boughtAtMs: NOW - 10 * MINUTE,
    nowMs: NOW,
    ...overrides,
  };
}

describe('최소 보유 — 0분이면 지금 동작 그대로다', () => {
  it('방금 산 종목도 판다', () => {
    assert.equal(minHoldDefersSell(sell({ minHoldMinutes: 0, boughtAtMs: NOW })), false);
  });

  it('음수·NaN도 끈 것으로 본다 — 켠 줄 알고 막히는 일이 없게', () => {
    for (const minHoldMinutes of [-1, Number.NaN, Number.NEGATIVE_INFINITY]) {
      assert.equal(minHoldDefersSell(sell({ minHoldMinutes, boughtAtMs: NOW })), false, `minHoldMinutes=${minHoldMinutes}`);
    }
  });
});

describe('최소 보유 — 경계', () => {
  it('정확히 N분이면 판다', () => {
    assert.equal(minHoldDefersSell(sell({ minHoldMinutes: 60, boughtAtMs: NOW - 60 * MINUTE })), false);
  });

  it('1ms 모자라면 이번에는 안 판다', () => {
    assert.equal(minHoldDefersSell(sell({ minHoldMinutes: 60, boughtAtMs: NOW - 60 * MINUTE + 1 })), true);
  });

  it('N분을 넘겼으면 판다', () => {
    assert.equal(minHoldDefersSell(sell({ minHoldMinutes: 60, boughtAtMs: NOW - 61 * MINUTE })), false);
  });

  it('매수 시각이 미래로 오면(시계 어긋남) 막는다', () => {
    assert.equal(minHoldDefersSell(sell({ minHoldMinutes: 60, boughtAtMs: NOW + 5 * MINUTE })), true);
  });
});

describe('★ 최소 보유 — 산 지 얼마나 됐는지 모르면 판다', () => {
  it('매수 기록이 없는 종목은 그대로 판다', () => {
    assert.equal(minHoldDefersSell(sell({ minHoldMinutes: 120, boughtAtMs: undefined })), false);
  });

  it('읽을 수 없는 시각도 모름으로 본다 — 막는 쪽이 아니라 파는 쪽이다', () => {
    for (const boughtAtMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(minHoldDefersSell(sell({ minHoldMinutes: 120, boughtAtMs })), false, `boughtAtMs=${boughtAtMs}`);
    }
  });

  it('판정 시각을 읽을 수 없어도 막지 않는다 — NaN 비교가 조용히 보류로 떨어지지 않게', () => {
    assert.equal(minHoldDefersSell(sell({ minHoldMinutes: 120, nowMs: Number.NaN })), false);
  });
});
