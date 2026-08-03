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

import { buyQuantityWithinRules, describeBuySizeBound, type BuySizeBound, type BuySizeInput } from './orderSizing.js';

/*
 * 수량과 사유만 본다. `askDepthShare`는 나중에 상한을 실측으로 바꾸려고 남기는
 * 값이라 여기서 못 박으면 시험이 그 기록 형식에 묶인다.
 */
function sized(input: BuySizeInput): { quantity: number; boundBy: BuySizeBound } {
  const { quantity, boundBy } = buyQuantityWithinRules(input);
  return { quantity, boundBy };
}

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
    assert.deepEqual(sized(BLOCKED_CASE), { quantity: 100, boundBy: 'orderNotional' });
  });

  it('현금이 한도보다 적으면 현금이 정한다', () => {
    assert.deepEqual(sized({ ...BLOCKED_CASE, cash: 250_000 }), {
      quantity: 25,
      boundBy: 'cash',
    });
  });

  it('값이 싸면 수량 한도가 정한다', () => {
    // 1회 금액 100만 / 100원이면 10,000주지만 수량 한도가 1,000주다.
    assert.deepEqual(sized({ ...BLOCKED_CASE, price: 100 }), {
      quantity: 1_000,
      boundBy: 'orderQuantity',
    });
  });

  it('오늘 쓴 금액만큼 일일 한도가 줄어든다', () => {
    // 남은 일일 금액 500,000원 → 50주. 1회 금액이 정한 100주보다 좁다.
    assert.deepEqual(sized({ ...BLOCKED_CASE, usedNotional: 4_500_000 }), {
      quantity: 50,
      boundBy: 'dailyNotional',
    });
  });
});

describe('매수 수량 — 못 사는 경우', () => {
  it('일일 한도를 이미 넘겨 썼으면 0주다 · 음수를 나누지 않는다', () => {
    assert.deepEqual(sized({ ...BLOCKED_CASE, usedNotional: 9_000_000 }), {
      quantity: 0,
      boundBy: 'dailyNotional',
    });
  });

  it('현금으로 1주도 못 사면 0주다', () => {
    assert.deepEqual(sized({ ...BLOCKED_CASE, cash: 9_000 }), {
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
        sized({ ...BLOCKED_CASE, price }),
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
    assert.deepEqual(sized({ ...BLOCKED_CASE, cash: 1_000_000 }), {
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
      'askDepth',
      'unknownPrice',
    ];
    for (const bound of bounds) {
      assert.ok(describeBuySizeBound(bound).length > 0, bound);
    }
  });
});

/*
 * 2026-08-03 실측: 경방 매도 1호가에 7주뿐인데 121주를 시장가로 던져 체결가가
 * 판정가보다 0.328% 위에서 나왔다. 돈 잣대 넷은 이것을 못 막는다 — 121주 ×
 * 8,220원 = 99만원이라 1회 100만원 한도 안이다.
 */
describe('매수 수량 — 호가 잔량 상한', () => {
  /** 잔량 상한만 걸리게 돈 잣대를 넉넉히 연 조합 */
  const RICH: BuySizeInput = {
    cash: 100_000_000,
    price: 8_220,
    maxOrderQuantity: 100_000,
    maxOrderNotional: 100_000_000,
    dailyNotionalLimit: 100_000_000,
    usedNotional: 0,
  };

  it('총 매도잔량의 10%를 넘겨 사지 않는다', () => {
    assert.deepEqual(sized({ ...RICH, totalAskQuantity: 2_000 }), {
      quantity: 200,
      boundBy: 'askDepth',
    });
  });

  it('잔량이 아주 얇으면 0주다 — 사지 않는 쪽으로 틀린다', () => {
    // 매도잔량 7주의 10%는 0.7주. 1주도 못 사는 것이 맞다.
    assert.deepEqual(sized({ ...RICH, totalAskQuantity: 7 }), { quantity: 0, boundBy: 'askDepth' });
  });

  /*
   * 단건 시세·해외·선물은 이 값을 안 준다. 모르는 것을 0으로 채우면 수량이 0이
   * 되어 **아무것도 못 산다** — 모르면 이 잣대를 대지 않는다.
   */
  it('잔량을 모르면 이 잣대를 대지 않는다', () => {
    // 현금이 유일하게 좁도록 낮춰 둔다. `RICH` 그대로면 현금과 1회 금액이 같은
    // 값이라 위 규칙대로 한도 쪽이 적히고, 그러면 이 시험이 무엇을 재는지 흐려진다.
    assert.deepEqual(sized({ ...RICH, cash: 50_000_000, totalAskQuantity: undefined }), {
      quantity: 6_082,
      boundBy: 'cash',
    });
  });

  it('돈 잣대가 더 좁으면 그쪽이 이긴다', () => {
    assert.deepEqual(sized({ ...RICH, maxOrderNotional: 1_000_000, totalAskQuantity: 2_000 }), {
      quantity: 121,
      boundBy: 'orderNotional',
    });
  });

  /*
   * 상한을 나중에 실측으로 바꾸려면 **걸리지 않은 주문의 비율도** 있어야 한다.
   * 걸린 것만 모으면 표본이 10%에 몰려 회귀가 안 된다.
   */
  it('상한에 안 걸린 주문도 잔량 대비 비율을 남긴다', () => {
    const result = buyQuantityWithinRules({
      ...RICH,
      maxOrderNotional: 1_000_000,
      totalAskQuantity: 2_000,
    });
    assert.equal(result.boundBy, 'orderNotional');
    assert.equal(result.askDepthShare, 121 / 2_000);
  });
});
