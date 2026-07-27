/**
 * KRX 동시호가 구간 판정 검증.
 *
 * 이 판정이 틀리면 화면이 `정규장 거래 중`이라고 적는 동안 큰 글씨 가격은
 * 멈춰 있다. 2026-07-27 15:26:18에 실제로 그랬다 — `000660` 화면이
 * 1,820,000원(15:19:59에 멈춤)인데 동시호가는 1,836,000원에 지시되고 있었다.
 *
 * 경계는 한 칸 차이로 뒤집히니 양쪽을 다 태운다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { KRX_SESSION_MINUTES, krxAuctionWindow } from '@invest/shared';

/** `HH:MM` → 자정부터의 분. 시험을 읽을 때 시각으로 보이게 한다. */
function at(clock: string): number {
  const [hour, minute] = clock.split(':').map(Number);
  return hour * 60 + minute;
}

describe('krxAuctionWindow — 장전', () => {
  it('08:29는 아직 아니다', () => {
    assert.equal(krxAuctionWindow(at('08:29')), null);
  });

  it('08:30부터 08:59까지가 장전 동시호가다', () => {
    assert.equal(krxAuctionWindow(at('08:30')), 'pre');
    assert.equal(krxAuctionWindow(at('08:53')), 'pre'); // 311을 실측한 시각
    assert.equal(krxAuctionWindow(at('08:59')), 'pre');
  });

  it('09:00은 정규장이라 동시호가가 아니다', () => {
    assert.equal(krxAuctionWindow(at('09:00')), null);
  });
});

describe('krxAuctionWindow — 마감', () => {
  it('15:19는 아직 연속 체결 중이다', () => {
    assert.equal(krxAuctionWindow(at('15:19')), null);
  });

  it('15:20부터 15:30까지가 마감 동시호가다', () => {
    // 실측: 15:20:03에 KIS 장운영 구분이 112 → 121로 바뀌었다.
    assert.equal(krxAuctionWindow(at('15:20')), 'close');
    assert.equal(krxAuctionWindow(at('15:26')), 'close'); // 16,000원 차이를 본 시각
    assert.equal(krxAuctionWindow(at('15:30')), 'close');
  });

  it('15:31은 장외다', () => {
    // 실측: 15:30:45에 121 → 112로 돌아갔다. 분 단위로는 15:30까지 동시호가로 본다.
    assert.equal(krxAuctionWindow(at('15:31')), null);
  });
});

describe('krxAuctionWindow — 그 밖', () => {
  it('정규장 한복판과 한밤중은 동시호가가 아니다', () => {
    assert.equal(krxAuctionWindow(at('12:04')), null);
    assert.equal(krxAuctionWindow(at('00:00')), null);
    assert.equal(krxAuctionWindow(at('23:59')), null);
  });

  it('두 구간이 겹치지 않고, 정규장 시간 안에 마감 동시호가가 들어 있다', () => {
    const { preAuctionOpen, open, closeAuctionOpen, close } = KRX_SESSION_MINUTES;
    assert.ok(preAuctionOpen < open, '장전 동시호가는 개장보다 앞선다');
    assert.ok(open < closeAuctionOpen, '마감 동시호가는 개장보다 뒤다');
    assert.ok(closeAuctionOpen < close, '마감 동시호가는 마감보다 앞서 시작한다');
  });

  it('하루 전체를 훑어도 구간이 끊기거나 겹치지 않는다', () => {
    let preCount = 0;
    let closeCount = 0;
    for (let minute = 0; minute < 24 * 60; minute += 1) {
      const window = krxAuctionWindow(minute);
      if (window === 'pre') preCount += 1;
      if (window === 'close') closeCount += 1;
    }
    assert.equal(preCount, 30, '장전 동시호가는 30분(08:30~08:59)');
    assert.equal(closeCount, 11, '마감 동시호가는 15:20~15:30 포함 11분');
  });
});
