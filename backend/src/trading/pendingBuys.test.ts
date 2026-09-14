/**
 * 미체결 매도 물량 판정 검증.
 *
 * 이 판정이 헐거우면 이미 매도가 나간 물량을 또 판다 — KIS가 `40240000`으로
 * 거절한다. 너무 빡빡하면 팔 수 있는 물량을 못 판다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BrokerExecution, BrokerExecutionStatus, OrderSide } from '@invest/shared';

import { pendingSellQuantities } from './pendingBuys.js';

function execution(overrides: {
  symbol: string;
  side?: OrderSide;
  status?: BrokerExecutionStatus;
  orderQuantity?: number;
  filledQuantity?: number;
  remainQuantity?: number;
}): BrokerExecution {
  const orderQuantity = overrides.orderQuantity ?? 121;
  const filledQuantity = overrides.filledQuantity ?? 0;
  return {
    id: `${overrides.symbol}-${overrides.status ?? 'open'}`,
    orderNo: '0000010663',
    orderDate: '20260803',
    symbol: overrides.symbol,
    name: overrides.symbol,
    side: overrides.side ?? 'buy',
    orderTypeLabel: '시장가',
    orderQuantity,
    orderPrice: 0,
    filledQuantity,
    filledAmount: 0,
    averageFilledPrice: 0,
    remainQuantity: overrides.remainQuantity ?? orderQuantity - filledQuantity,
    rejectedQuantity: 0,
    status: overrides.status ?? 'open',
    currency: 'KRW',
  };
}

/*
 * 2026-08-04 실측: 매도가 나간 뒤 잔고가 안 줄어 같은 종목을 또 팔려 했고,
 * `40240000`(잔고 없음) 세 번에 **러너가 마감 3분 전 멈췄다.**
 * 매수 쪽은 어제 고쳤는데 매도 쪽을 안 고친 결과다.
 */
describe('미체결 매도 — 얼마나 묶여 있나', () => {
  it('잔량이 남은 매도가 그만큼 묶는다', () => {
    const pending = pendingSellQuantities([
      execution({ symbol: '017670', side: 'sell', status: 'open', orderQuantity: 143 }),
    ]);
    assert.equal(pending.get('017670'), 143);
  });

  /* 매수는 "샀나"만 알면 되지만 매도는 **얼마나** 묶였는지가 중요하다. */
  it('부분 체결이면 남은 잔량만 묶는다 — 나머지는 아직 팔 수 있다', () => {
    const pending = pendingSellQuantities([
      execution({ symbol: '017670', side: 'sell', status: 'partial', orderQuantity: 100, filledQuantity: 40 }),
    ]);
    assert.equal(pending.get('017670'), 60);
  });

  it('같은 종목 매도가 여럿이면 합친다', () => {
    const pending = pendingSellQuantities([
      execution({ symbol: '017670', side: 'sell', status: 'open', orderQuantity: 50 }),
      execution({ symbol: '017670', side: 'sell', status: 'open', orderQuantity: 30 }),
    ]);
    assert.equal(pending.get('017670'), 80);
  });

  it('다 채워졌거나 취소·거부면 묶지 않는다', () => {
    for (const [status, filled, remain] of [
      ['filled', 143, 0],
      ['canceled', 0, 143],
      ['rejected', 0, 143],
    ] as const) {
      const pending = pendingSellQuantities([
        execution({ symbol: '017670', side: 'sell', status, orderQuantity: 143, filledQuantity: filled, remainQuantity: remain }),
      ]);
      assert.equal(pending.size, 0, status);
    }
  });

  it('매수 미체결은 매도 물량을 묶지 않는다', () => {
    const pending = pendingSellQuantities([
      execution({ symbol: '017670', side: 'buy', status: 'open', orderQuantity: 143 }),
    ]);
    assert.equal(pending.size, 0);
  });
});
