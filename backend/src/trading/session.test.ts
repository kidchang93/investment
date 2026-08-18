/**
 * 러너 가동 시간대 판정 검증.
 *
 * 틀리면 두 방향 다 아프다 — 좁으면 장중에 러너가 쉬고, 넓으면 밤새 KIS를
 * 때린다(2026-08-03에 뒤엣것이 났다). 그리고 **리스크 룰과 경계가 같아야 한다.**
 * 어긋나면 러너는 쉬는데 룰은 통과시키는 구간이 생긴다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { inAfterHoursCloseWindow, kstMinutesOfDay, marketHoursBlock, sessionMinutes, withinSession } from './session.js';

/** KST 기준 그날 `HH:MM`. 서버 타임존과 무관하게 같은 값이어야 한다. */
function kst(clock: string): Date {
  return new Date(`2026-08-03T${clock}:00+09:00`);
}

describe('시각 문자열 읽기', () => {
  it('HH:MM을 분으로 바꾼다', () => {
    assert.equal(sessionMinutes('09:00'), 540);
    assert.equal(sessionMinutes('15:30'), 930);
    assert.equal(sessionMinutes('00:00'), 0);
    assert.equal(sessionMinutes('9:05'), 545, '한 자리 시도 읽는다');
  });

  it('형식이 깨졌으면 null이다', () => {
    for (const bad of ['', '9', '25:00', '09:60', 'abc', '09-00']) {
      assert.equal(sessionMinutes(bad), null, bad);
    }
  });
});

describe('KST 분 계산', () => {
  it('서버 타임존과 무관하게 KST로 읽는다', () => {
    assert.equal(kstMinutesOfDay(kst('09:00')), 540);
    assert.equal(kstMinutesOfDay(kst('15:30')), 930);
  });
});

describe('가동 시간대 판정', () => {
  /* 리스크 룰이 `now < start || now > end`로 막으므로 양 끝을 포함한다. */
  it('양 끝을 포함한다 — 리스크 룰과 같은 경계', () => {
    assert.equal(withinSession('09:00', '15:30', kst('09:00')), true);
    assert.equal(withinSession('09:00', '15:30', kst('15:30')), true);
  });

  it('바깥은 거짓이다', () => {
    assert.equal(withinSession('09:00', '15:30', kst('08:59')), false);
    assert.equal(withinSession('09:00', '15:30', kst('15:31')), false);
    // 2026-08-03에 이 시각 회차가 KIS를 20여 회 때렸다.
    assert.equal(withinSession('09:00', '15:30', kst('15:31')), false);
    assert.equal(withinSession('09:00', '15:30', kst('03:00')), false);
  });

  /* 시간외까지 늘리면 러너도 함께 늘어나야 한다 — 사용자가 값을 바꾸면 그만이다. */
  it('시간대를 늘리면 그만큼 돈다', () => {
    assert.equal(withinSession('09:00', '18:00', kst('16:30')), true);
    assert.equal(withinSession('08:30', '15:30', kst('08:40')), true);
  });

  /*
   * 오타 하나로 러너가 조용히 아무것도 안 하면 한 달을 켜 두고 빈손이 된다.
   * 잘못된 설정을 막는 것은 리스크 룰이고 그건 사유를 남긴다.
   */
  it('형식이 깨졌으면 막지 않는다 — 조용히 멎는 것이 더 나쁘다', () => {
    assert.equal(withinSession('', '15:30', kst('12:00')), true);
    assert.equal(withinSession('09:00', '25:00', kst('12:00')), true);
  });

  it('자정을 넘기는 구간도 다룬다 — 조용히 영영 안 도는 일이 없게', () => {
    assert.equal(withinSession('22:00', '02:00', kst('23:00')), true);
    assert.equal(withinSession('22:00', '02:00', kst('01:00')), true);
    assert.equal(withinSession('22:00', '02:00', kst('12:00')), false);
  });
});

/*
 * 장후 시간외 청산이 도는 창. 여기가 틀리면 정규장에 청산 주문이 나가거나
 * (그건 시장가로 나가야 할 것이 종가주문으로 나가는 것) 창을 통째로 놓친다.
 */
describe('장후 시간외 종가 창 (15:40~16:00)', () => {
  it('창 안이면 참이다', () => {
    for (const clock of ['15:40', '15:50', '15:59']) {
      assert.equal(inAfterHoursCloseWindow(kst(clock)), true, clock);
    }
  });

  it('정규장과 마감 동시호가는 창이 아니다', () => {
    for (const clock of ['09:00', '15:20', '15:30', '15:39']) {
      assert.equal(inAfterHoursCloseWindow(kst(clock)), false, clock);
    }
  });

  /* 16:00부터는 시간외 단일가라 주문구분이 또 다르다 — 아직 코드값을 모른다. */
  it('16:00부터는 창이 아니다 — 거기부터는 단일가다', () => {
    assert.equal(inAfterHoursCloseWindow(kst('16:00')), false);
    assert.equal(inAfterHoursCloseWindow(kst('17:00')), false);
  });
});

/**
 * 장중 수집 가드. 2026-08-18에 장중 수집이 화면과 경보를 502로 만든 뒤 생겼다.
 * 시간 판정은 조용히 틀리는 자리라(데몬 하트비트가 UTC `current_date`로 비교해
 * 개장 전 브리핑을 영영 건너뛸 뻔했다) 경계를 값으로 못 박는다.
 */
describe('장중 수집 가드', () => {
  /** KST 표기를 그대로 Date로. `13:54 KST` = `04:54Z` */
  const kst = (iso: string): Date => new Date(`${iso}+09:00`);

  it('★ 장중에는 막는다 — 유량을 잔고 조회와 나눠 쓰면 경보가 502를 받는다', () => {
    // 2026-08-18은 화요일
    assert.match(marketHoursBlock(kst('2026-08-18T13:54')) ?? '', /장이 열려 있는/);
    assert.match(marketHoursBlock(kst('2026-08-18T09:00')) ?? '', /09:00/);
  });

  it('경계를 정확히 지킨다 — 08:30에 막히고 15:40에 풀린다', () => {
    assert.equal(marketHoursBlock(kst('2026-08-18T08:29')), null, '08:29는 데몬이 뜨기 전이다');
    assert.notEqual(marketHoursBlock(kst('2026-08-18T08:30')), null, '08:30부터 개장 전 준비가 돈다');
    assert.notEqual(marketHoursBlock(kst('2026-08-18T15:39')), null, '15:39는 아직 마감 정리 전이다');
    assert.equal(marketHoursBlock(kst('2026-08-18T15:40')), null, '15:40이면 마감 정리가 시작된다');
  });

  it('밤과 새벽에는 안 막는다 — 밤새 도는 것이 원래 쓰임이다', () => {
    assert.equal(marketHoursBlock(kst('2026-08-18T16:00')), null);
    assert.equal(marketHoursBlock(kst('2026-08-19T03:00')), null);
  });

  it('주말에는 안 막는다 — 장이 없으면 유량을 다투지 않는다', () => {
    assert.equal(marketHoursBlock(kst('2026-08-22T13:00')), null, '토요일');
    assert.equal(marketHoursBlock(kst('2026-08-23T13:00')), null, '일요일');
  });

  it('★ UTC로 재지 않는다 — 한국 낮 13:00은 UTC 04:00이라 밤으로 읽힌다', () => {
    /*
     * 서버가 UTC로 도는 환경에서 `getHours()`를 그냥 쓰면 한국 장중이 새벽으로
     * 읽혀 가드가 통째로 뚫린다. 같은 순간을 UTC 표기로 넣어 확인한다.
     */
    assert.notEqual(marketHoursBlock(new Date('2026-08-18T04:00:00Z')), null, 'UTC 04:00은 한국 장중이다');
    // 요일도 KST로 재야 한다 — 토요일 아침 KST는 금요일 UTC다
    assert.equal(marketHoursBlock(new Date('2026-08-22T04:00:00Z')), null, 'UTC 금요일 밤 = KST 토요일 낮');
  });
});
