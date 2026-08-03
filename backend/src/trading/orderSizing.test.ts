/**
 * 매수 수량 산정 검증.
 *
 * 이 판정이 틀리면 러너가 **주문을 아예 못 내거나**(너무 좁게 잡아 0주) 자기
 * 안전장치에 걸린다(너무 넓게 잡아 한도 초과). 2026-08-03에 실제로 뒤엣것이
 * 났고, 그날 처음 난 신호가 세 잣대에 동시에 걸렸다.
 *
 * 그래서 네 가지를 값으로 못 박는다.
 *
 *   ① 그날 막혔던 조합이 이제 한도 안에서 정해진다
 *   ② 네 잣대 각각이 가장 좁을 때 그것이 이긴다
 *   ③ 모르는 값(`price` 0·NaN·Infinity)은 0주이고 사유가 따로 남는다
 *   ④ 값이 같으면 현금이 아니라 **한도** 쪽을 적는다
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buyQuantityWithinRules, describeBuySizeBound, type BuySizeBound } from './orderSizing.js';

/*
 * 2026-08-03 모의계좌에서 실제로 막혔던 값. 예수금 1억에 1회 100만원 룰이다.
 * 예전 식(`floor(cash / price)`)은 여기서 10,000주를 냈다.
 */
const BLOCKED_CASE = {
  cash: 100_000_000,
  price: 10_000,
  maxOrderQuantity: 1_000,
  maxOrderNotional: 1_000_000,
  dailyNotionalLimit: 5_000_000,
  usedNotional: 0,
};

describe('매수 수량 — 한도 안에서 정한다', () => {
  it('세 잣대에 동시에 걸리던 조합이 가장 좁은 한도로 정해진다', () => {
    // 1회 금액 100만 / 1주 1만 = 100주. 수량 한도 1,000주보다 좁다.
    assert.deepEqual(buyQuantityWithinRules(BLOCKED_CASE), { quantity: 100, boundBy: 'orderNotional' });
  });

  it('현금이 한도보다 적으면 현금이 정한다', () => {
    assert.deepEqual(buyQuantityWithinRules({ ...BLOCKED_CASE, cash: 250_000 }), {
      quantity: 25,
      boundBy: 'cash',
    });
  });

  it('값이 싸면 수량 한도가 정한다', () => {
    // 1회 금액 100만 / 100원이면 10,000주지만 수량 한도가 1,000주다.
    assert.deepEqual(buyQuantityWithinRules({ ...BLOCKED_CASE, price: 100 }), {
      quantity: 1_000,
      boundBy: 'orderQuantity',
    });
  });

  it('오늘 쓴 금액만큼 일일 한도가 줄어든다', () => {
    // 남은 일일 금액 500,000원 → 50주. 1회 금액이 정한 100주보다 좁다.
    assert.deepEqual(buyQuantityWithinRules({ ...BLOCKED_CASE, usedNotional: 4_500_000 }), {
      quantity: 50,
      boundBy: 'dailyNotional',
    });
  });
});

describe('매수 수량 — 못 사는 경우', () => {
  it('일일 한도를 이미 넘겨 썼으면 0주다 · 음수를 나누지 않는다', () => {
    assert.deepEqual(buyQuantityWithinRules({ ...BLOCKED_CASE, usedNotional: 9_000_000 }), {
      quantity: 0,
      boundBy: 'dailyNotional',
    });
  });

  it('현금으로 1주도 못 사면 0주다', () => {
    assert.deepEqual(buyQuantityWithinRules({ ...BLOCKED_CASE, cash: 9_000 }), {
      quantity: 0,
      boundBy: 'cash',
    });
  });

  /*
   * 예전 식은 `price`가 0이면 `Infinity`가 나왔고 그 값이 그대로 한도 검사로
   * 넘어갔다. 모르는 값은 수량이 없는 것이지 무한한 것이 아니다.
   */
  it('값을 모르면 0주이고 사유가 현금·한도와 갈린다', () => {
    for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(
        buyQuantityWithinRules({ ...BLOCKED_CASE, price }),
        { quantity: 0, boundBy: 'unknownPrice' },
        `price=${price}`,
      );
    }
  });
});

describe('매수 수량 — 무엇이 정했는지 적기', () => {
  /*
   * 현금과 한도가 똑같이 걸렸을 때 "현금이 정했다"고 적으면 룰은 관계없다는
   * 뜻으로 읽히고, 그러면 한도를 손볼 생각을 못 한다.
   */
  it('현금과 한도가 같은 값이면 한도 쪽을 적는다', () => {
    assert.deepEqual(buyQuantityWithinRules({ ...BLOCKED_CASE, cash: 1_000_000 }), {
      quantity: 100,
      boundBy: 'orderNotional',
    });
  });

  it('사유마다 읽을 말이 있다', () => {
    const bounds: BuySizeBound[] = [
      'cash',
      'orderQuantity',
      'orderNotional',
      'dailyNotional',
      'unknownPrice',
    ];
    for (const bound of bounds) {
      assert.ok(describeBuySizeBound(bound).length > 0, bound);
    }
  });
});
