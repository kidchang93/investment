/**
 * 채점 기간 세기 검증.
 *
 * 여기가 틀리면 성적표 전체가 틀린다. 특히 두 가지를 못 박아 둔다 —
 * 달력이 아니라 실제 거래일로 세는지, 그리고 기간이 아직 안 찼을 때
 * 억지로 최근 값을 쓰지 않는지.
 *
 * 후자가 중요하다. 아직 하루밖에 안 지난 신호를 20일 성적에 넣으면
 * 최근 신호가 유리해져 성적이 부풀거나 꺼진다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { exitCloseAfter } from './scoring.js';

/** 하루 = 86400초. 주말을 건너뛴 일봉을 흉내 낸다. */
const DAY = 86_400;

describe('채점 기간 세기', () => {
  // 금(0) · 월(3) · 화(4) · 수(5) — 주말에는 봉이 없다.
  const candles = [
    { time: 0 * DAY, close: 1000 },
    { time: 3 * DAY, close: 1100 },
    { time: 4 * DAY, close: 1200 },
    { time: 5 * DAY, close: 1300 },
  ];

  it('신호 다음 거래일부터 센다', () => {
    // 금요일 장중에 신호. 1거래일 뒤는 주말을 건너뛴 월요일이다.
    assert.equal(exitCloseAfter(candles, 0 * DAY + 100, 1), 1100);
  });

  it('달력 날짜가 아니라 실제 봉으로 센다', () => {
    // 금요일 신호의 3거래일 뒤는 수요일(달력으로는 5일 뒤)이다.
    assert.equal(exitCloseAfter(candles, 0 * DAY + 100, 3), 1300);
  });

  it('기간이 아직 안 찼으면 채점하지 않는다', () => {
    /*
     * 봉이 3개뿐인데 4거래일 뒤를 물으면 undefined다. 가장 최근 값으로
     * 때우면 하루 지난 신호가 20일 성적에 섞여 성적표가 거짓이 된다.
     */
    assert.equal(exitCloseAfter(candles, 0 * DAY + 100, 4), undefined);
  });

  it('신호와 같은 날 봉은 세지 않는다', () => {
    /*
     * 신호가 난 봉의 종가로 채점하면 미래를 보고 산 셈이 된다.
     * 백테스트가 다음 봉 시가로 체결하는 것과 같은 이유다.
     */
    assert.equal(exitCloseAfter(candles, 0 * DAY, 1), 1100);
  });

  it('신호 이전 봉은 무시한다', () => {
    // 화요일에 신호가 나면 그 앞의 금·월요일 봉은 세지 않는다.
    assert.equal(exitCloseAfter(candles, 4 * DAY, 1), 1300);
  });

  it('봉이 없으면 채점하지 않는다', () => {
    assert.equal(exitCloseAfter([], 0, 1), undefined);
  });

  it('순서가 뒤섞여 와도 시각 순으로 센다', () => {
    const shuffled = [candles[2], candles[0], candles[3], candles[1]];
    assert.equal(exitCloseAfter(shuffled, 0 * DAY + 100, 1), 1100);
    assert.equal(exitCloseAfter(shuffled, 0 * DAY + 100, 3), 1300);
  });
});
