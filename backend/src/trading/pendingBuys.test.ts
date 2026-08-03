/**
 * 미체결 매수 판정 검증.
 *
 * 이 판정이 헐거우면 같은 종목을 매 회차 다시 산다 — 2026-08-03에 경방을 네 번
 * 샀고 자기 주문이 호가를 밀어 체결가가 계단을 올라갔다. 반대로 너무 빡빡하면
 * 살 수 있는 회차를 놓친다.
 *
 * 그래서 네 가지를 값으로 못 박는다.
 *
 *   ① 잔량이 남은 매수는 자리를 먹는다
 *   ② 다 채워진 매수는 자리를 비운다 (잔고가 이어받는다)
 *   ③ 취소·거부는 채워질 일이 없으므로 자리를 먹지 않는다
 *   ④ 매도 미체결은 세지 않는다 — 막는 것은 "또 사는 것"이다
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BrokerExecution, BrokerExecutionStatus, OrderSide } from '@invest/shared';

import { pendingBuySymbols } from './pendingBuys.js';

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

describe('미체결 매수 — 자리를 먹는 것', () => {
  /* 2026-08-03 09:48~09:50에 실제로 이 모양이었다. 잔고는 비어 있는데 잔량이 121주였다. */
  it('접수만 되고 아직 안 채워진 매수는 자리를 먹는다', () => {
    const symbols = pendingBuySymbols([execution({ symbol: '000050', status: 'open' })]);
    assert.deepEqual([...symbols], ['000050']);
  });

  it('부분 체결이면 남은 잔량만큼 아직 올 것이 있다', () => {
    const symbols = pendingBuySymbols([
      execution({ symbol: '000050', status: 'partial', filledQuantity: 100 }),
    ]);
    assert.deepEqual([...symbols], ['000050']);
  });

  it('같은 종목 주문이 여럿이어도 한 번만 센다', () => {
    const symbols = pendingBuySymbols([
      execution({ symbol: '000050', status: 'open' }),
      execution({ symbol: '000050', status: 'open' }),
    ]);
    assert.equal(symbols.size, 1);
  });
});

describe('미체결 매수 — 자리를 비우는 것', () => {
  /*
   * 다 채워지면 잔고가 이어받는다. 여기서도 자리를 먹으면 하루 종일 두 번
   * 세는 셈이고, 사고판 종목이 그날 매수를 통째로 잠근다.
   */
  it('다 채워진 매수는 세지 않는다', () => {
    const symbols = pendingBuySymbols([
      execution({ symbol: '000050', status: 'filled', filledQuantity: 121, remainQuantity: 0 }),
    ]);
    assert.equal(symbols.size, 0);
  });

  it('취소·거부는 채워질 일이 없으므로 세지 않는다', () => {
    for (const status of ['canceled', 'rejected'] as const) {
      const symbols = pendingBuySymbols([execution({ symbol: '000050', status })]);
      assert.equal(symbols.size, 0, status);
    }
  });

  /* 막는 것은 "또 사는 것"이다. 매도 미체결분은 보유 수량으로 잔고에 이미 있다. */
  it('매도 미체결은 세지 않는다', () => {
    const symbols = pendingBuySymbols([execution({ symbol: '000050', side: 'sell', status: 'open' })]);
    assert.equal(symbols.size, 0);
  });

  it('아무 주문도 없으면 빈 집합이다', () => {
    assert.equal(pendingBuySymbols([]).size, 0);
  });
});
