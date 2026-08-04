/**
 * 하루 한 번 스냅샷 판정 검증.
 *
 * 이 시각 판정이 틀리면 두 방향으로 아프다. 너무 늦게 찍으면 **그날의 결과가
 * 섞인 순위**를 "아침에 알 수 있었던 것"으로 저장하게 되고(그게 바로 오늘
 * 측정을 뒤집은 look-ahead다), 너무 이르면 거래대금이 0인 종목이 상위에 온다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { kstMinutesOfDay } from './session.js';

/** KST 기준 그날 `HH:MM`. 서버 타임존과 무관하게 같은 값이어야 한다. */
function kst(clock: string): Date {
  return new Date(`2026-08-05T${clock}:00+09:00`);
}

/*
 * `captureDailySnapshotIfDue`는 DB와 KIS를 타므로 시각 판정만 떼어 잰다.
 * 저기를 고치면 여기도 고쳐야 한다 — 두 곳에 두는 것이 마음에 걸리지만
 * 조용히 어긋나는 쪽이 더 위험하다.
 */
const AFTER = 9 * 60 + 5;
const BEFORE = 10 * 60;
const isDue = (clock: string): boolean => {
  const m = kstMinutesOfDay(kst(clock));
  return m >= AFTER && m < BEFORE;
};

describe('스냅샷 시각', () => {
  it('개장 직후 몇 분은 아직 이르다 — 거래대금이 안 쌓였다', () => {
    for (const clock of ['08:59', '09:00', '09:04']) {
      assert.equal(isDue(clock), false, clock);
    }
  });

  it('09:05부터 찍는다', () => {
    for (const clock of ['09:05', '09:30', '09:59']) {
      assert.equal(isDue(clock), true, clock);
    }
  });

  /*
   * 오전에 급등한 종목이 오후 순위 상위에 온다. 그걸 "아침에 알 수 있었던 것"으로
   * 저장하면 look-ahead가 자료 자체에 박힌다 — 나중에 걷어낼 방법이 없다.
   */
  it('10시를 넘기면 안 찍는다 — 그날 결과가 섞인 순위다', () => {
    for (const clock of ['10:00', '13:00', '15:29']) {
      assert.equal(isDue(clock), false, clock);
    }
  });

  it('장 밖에서는 안 찍는다', () => {
    for (const clock of ['03:00', '20:00']) {
      assert.equal(isDue(clock), false, clock);
    }
  });
});
