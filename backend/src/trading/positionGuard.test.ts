/**
 * 포지션 관문 검증.
 *
 * ★ 이 시험이 지키는 것은 **"안전장치가 나오는 길을 막지 않는다"**이다.
 * 이번 주에 같은 착각을 네 번 고쳤다 — 일일 건수·일일 금액·종목 목록·1회 한도가
 * 전부 매도까지 막아 종목이 갇혔다. 판단자를 에이전트로 옮기면서 같은 실수를
 * 다섯 번째로 하지 않으려고 시험을 먼저 건다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BrokerExecution } from '@invest/shared';
import { checkPositionGuard, sellableQuantity } from './positionGuard.js';

const MIN = 60_000;
const NOW = 1_785_900_000_000;

/*
 * ★ **`as` 캐스트로 때우지 않는다.** 처음에 `quantity`·`price`·`orderedAt` 같은
 * 없는 필드로 픽스처를 만들고 캐스트로 눌렀는데, 그러면 타입이 바뀌어도 시험이
 * 통과해 **덮고 있다고 착각한다.** 실제 필드로 다 채운다.
 */
function execution(over: Partial<BrokerExecution> = {}): BrokerExecution {
  return {
    id: 'e1',
    orderNo: '1',
    orderDate: '20260805',
    orderTime: '090000',
    symbol: '005930',
    name: '삼성전자',
    side: 'sell',
    orderTypeLabel: '시장가',
    orderQuantity: 10,
    orderPrice: 70_000,
    filledQuantity: 0,
    filledAmount: 0,
    averageFilledPrice: 0,
    remainQuantity: 10,
    rejectedQuantity: 0,
    status: 'open',
    currency: 'KRW',
    ...over,
  };
}

function base(over: Partial<Parameters<typeof checkPositionGuard>[0]> = {}) {
  return {
    symbol: '005930',
    side: 'buy' as const,
    quantity: 10,
    nowMs: NOW,
    positions: [] as Array<{ symbol: string; quantity: number }>,
    executions: [] as BrokerExecution[],
    boughtAtBySymbol: new Map<string, number>(),
    maxPositions: 2,
    minHoldMinutes: 60,
    ...over,
  };
}

describe('포지션 관문 — 미체결 매도가 자리를 먹는다', () => {
  /*
   * 8/4 15:21에 실제로 났다. 매도가 나간 뒤 잔고가 안 줄어 같은 종목을 세 번 더
   * 팔려 했고, `40240000` 세 번에 마감 3분 전 판단자가 죽었다.
   */
  it('이미 전량 매도가 나가 있으면 또 팔지 않는다', () => {
    const verdict = checkPositionGuard(base({
      side: 'sell',
      quantity: 10,
      positions: [{ symbol: '005930', quantity: 10 }],
      executions: [execution({ remainQuantity: 10 })],
      minHoldMinutes: 0,
    }));
    assert.equal(verdict.allowed, false);
    assert.match(verdict.violations.join(' '), /이미 매도 주문이 나가 있습니다/);
  });

  it('일부만 나가 있으면 남은 만큼은 팔 수 있다', () => {
    const positions = [{ symbol: '005930', quantity: 10 }];
    const executions = [execution({ remainQuantity: 4 })];
    assert.equal(sellableQuantity('005930', positions, executions), 6);

    const ok = checkPositionGuard(base({
      side: 'sell', quantity: 6, positions, executions, minHoldMinutes: 0,
    }));
    assert.equal(ok.allowed, true, ok.violations.join(' '));

    const tooMuch = checkPositionGuard(base({
      side: 'sell', quantity: 7, positions, executions, minHoldMinutes: 0,
    }));
    assert.equal(tooMuch.allowed, false);
    assert.match(tooMuch.violations.join(' '), /매도 가능 수량 6주/);
  });

  /* 취소·거절된 주문은 물량을 잡고 있지 않다. 세면 팔 수 있는데 못 팔게 된다. */
  it('취소·거절된 매도는 자리를 안 먹는다', () => {
    const positions = [{ symbol: '005930', quantity: 10 }];
    for (const status of ['canceled', 'rejected'] as const) {
      assert.equal(
        sellableQuantity('005930', positions, [execution({ status, remainQuantity: 10 })]),
        10,
        status,
      );
    }
  });
});

describe('포지션 관문 — 나오는 길을 막지 않는다', () => {
  /*
   * ★ 다섯 번째가 되지 않게. 매수 잣대(자리 수·중단선)는 **매도에 걸리면 안 된다.**
   * 걸리면 손실 난 종목에 갇히고, 값이 내려갈수록 더 못 나온다.
   */
  it('보유 한도가 꽉 차 있어도 매도는 통과한다', () => {
    const verdict = checkPositionGuard(base({
      side: 'sell',
      quantity: 5,
      positions: [
        { symbol: '005930', quantity: 10 },
        { symbol: '000660', quantity: 3 },
      ],
      maxPositions: 1,
      minHoldMinutes: 0,
    }));
    assert.equal(verdict.allowed, true, verdict.violations.join(' '));
  });

  it('중단선 아래여도 매도는 통과한다', () => {
    const verdict = checkPositionGuard(base({
      side: 'sell',
      quantity: 5,
      positions: [{ symbol: '005930', quantity: 10 }],
      minHoldMinutes: 0,
      equity: 80_000_000,
      stopEquity: 90_000_000,
    }));
    assert.equal(verdict.allowed, true, verdict.violations.join(' '));
  });
});

describe('포지션 관문 — 들어가는 것을 막는다', () => {
  it('자리가 다 차면 새 종목은 못 산다', () => {
    const positions = [
      { symbol: '000660', quantity: 3 },
      { symbol: '035420', quantity: 5 },
    ];
    const verdict = checkPositionGuard(base({ positions, maxPositions: 2 }));
    assert.equal(verdict.allowed, false);
    assert.match(verdict.violations.join(' '), /보유 종목이 이미 2개/);
  });

  /* 이미 든 종목을 더 사는 것은 자리를 새로 먹지 않는다 — 물타기까지 막을 이유가 없다. */
  it('이미 든 종목은 자리가 차 있어도 더 살 수 있다', () => {
    const positions = [
      { symbol: '005930', quantity: 3 },
      { symbol: '035420', quantity: 5 },
    ];
    const verdict = checkPositionGuard(base({ symbol: '005930', positions, maxPositions: 2 }));
    assert.equal(verdict.allowed, true, verdict.violations.join(' '));
  });

  it('중단선에 닿으면 매수를 막는다 — 같을 때도 막는다', () => {
    for (const equity of [90_000_000, 89_999_999]) {
      const verdict = checkPositionGuard(base({ equity, stopEquity: 90_000_000 }));
      assert.equal(verdict.allowed, false, String(equity));
      assert.match(verdict.violations.join(' '), /중단선/);
    }
    // 한 원이라도 위면 통과한다.
    assert.equal(
      checkPositionGuard(base({ equity: 90_000_001, stopEquity: 90_000_000 })).allowed,
      true,
    );
  });

  /* 모르는 것을 통과로 치지 않는다 — 다만 여기서는 **막지도** 않는다. 값이 없는 것과
   * 바닥에 닿은 것은 다르고, 없다고 매수를 전부 막으면 조회 한 번 실패에 계좌가 선다. */
  it('평가금액이나 중단선이 없으면 하드 스톱은 걸리지 않는다', () => {
    assert.equal(checkPositionGuard(base({ stopEquity: 90_000_000 })).allowed, true);
    assert.equal(checkPositionGuard(base({ equity: 10 })).allowed, true);
  });
});

describe('포지션 관문 — 최소 보유 시간', () => {
  it('산 지 얼마 안 됐으면 매도를 미룬다', () => {
    const verdict = checkPositionGuard(base({
      side: 'sell',
      quantity: 5,
      positions: [{ symbol: '005930', quantity: 10 }],
      boughtAtBySymbol: new Map([['005930', NOW - 30 * MIN]]),
      minHoldMinutes: 60,
    }));
    assert.equal(verdict.allowed, false);
    assert.match(verdict.violations.join(' '), /최소 보유 60분/);
  });

  it('지났으면 통과한다', () => {
    const verdict = checkPositionGuard(base({
      side: 'sell',
      quantity: 5,
      positions: [{ symbol: '005930', quantity: 10 }],
      boughtAtBySymbol: new Map([['005930', NOW - 61 * MIN]]),
      minHoldMinutes: 60,
    }));
    assert.equal(verdict.allowed, true, verdict.violations.join(' '));
  });

  /*
   * **언제 샀는지 모르면 막지 않는다.** 어제 산 종목은 오늘 체결내역에 없어서
   * 매수 시각을 알 수 없는데, 그때 막으면 그 종목은 영영 못 판다.
   */
  it('매수 시각을 모르면 막지 않는다', () => {
    const verdict = checkPositionGuard(base({
      side: 'sell',
      quantity: 5,
      positions: [{ symbol: '005930', quantity: 10 }],
      boughtAtBySymbol: new Map(),
      minHoldMinutes: 60,
    }));
    assert.equal(verdict.allowed, true, verdict.violations.join(' '));
  });
});
