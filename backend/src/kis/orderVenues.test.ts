/**
 * 주문 거래소 검증.
 *
 * ★ 이 시험이 지키는 것은 하나다: **검증되지 않은 주문 경로가 조용히 열리지 않는다.**
 * 모의 서버는 KRX만 받으므로 `NXT`로 보내면 거절되는데, 그 거절을 "NXT를 못 쓴다"로
 * 읽으면 실전에서도 못 쓴다고 잘못 적게 된다. 보내기 전에 막고 이유를 말한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { config } from '../config.js';
import { assertVenueUsable, DEFAULT_ORDER_VENUE, venueAcceptsMarketOrder } from './orderVenues.js';

describe('주문 거래소 — 모의에서는 KRX만', () => {
  it('기본값은 KRX다 — 지금까지의 동작이 바뀌면 안 된다', () => {
    assert.equal(DEFAULT_ORDER_VENUE, 'KRX');
  });

  it('KRX는 어느 서버에서든 통과한다', () => {
    assert.doesNotThrow(() => assertVenueUsable('KRX'));
  });

  /*
   * 이 시험은 현재 환경을 그대로 읽는다. 모의면 막혀야 하고 실전이면 통과해야 하는데,
   * `config.env`를 갈아끼우면 다른 모듈이 이미 읽어 둔 값과 갈려 거짓 통과가 난다
   * (`verification-gotchas`에 같은 함정이 적혀 있다). 그래서 갈아끼우지 않고
   * **지금 환경에 맞는 쪽만** 확인한다.
   */
  it('NXT는 모의에서 막히고 실전에서 통과한다', () => {
    if (config.env === 'prod') {
      assert.doesNotThrow(() => assertVenueUsable('NXT'));
      return;
    }
    assert.throws(() => assertVenueUsable('NXT'), /모의투자/);
    // 무엇을 해야 하는지까지 말해야 한다 — 코드만 던지면 사람이 원인을 못 찾는다.
    assert.throws(() => assertVenueUsable('NXT'), /실전 계좌/);
  });
});

describe('주문 거래소 — 프리마켓에는 시장가가 없다', () => {
  it('KRX는 연장 세션이어도 시장가를 받는다', () => {
    assert.equal(venueAcceptsMarketOrder('KRX', true), true);
    assert.equal(venueAcceptsMarketOrder('KRX', false), true);
  });

  /*
   * 러너는 지금까지 **늘 시장가**였다. 이 검사가 없으면 프리마켓 주문이 전부
   * 거절되고, 그 거절이 매 회차 쌓여 러너가 연속 실패로 멈춘다 — 2026-08-04에
   * 잔고 지연 거절 세 번으로 실제로 멈췄다.
   */
  it('NXT는 연장 세션에서 시장가를 받지 않는다', () => {
    assert.equal(venueAcceptsMarketOrder('NXT', true), false);
    assert.equal(venueAcceptsMarketOrder('NXT', false), true);
  });
});
