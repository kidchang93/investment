/**
 * 일일 주문 금액 한도가 실제로 쌓이는지 검증.
 *
 * **DB로는 확인할 수 없어 여기로 왔다.** `trading_broker_orders`에 `status='submitted'`인
 * 행이 0건이라(2026-08-01: 17행 전부 blocked·rejected, 전부 지정가) 조회해서는 시장가
 * 주문이 한도에 쌓이는지 볼 수가 없다. 실제로 그 사이에 **시장가 주문은 영원히 0원**으로
 * 잡히고 있었다 — 자동매매 러너는 항상 시장가라 일일 금액 한도가 잣대로 작동하지 않았다.
 *
 * 옛 SQL을 그대로 옮기면 이렇다. 아래 시험들이 이 계산을 거부한다.
 *
 *     SUM(COALESCE(quantity, 0) * COALESCE(limit_price, 0))
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  dailyLimitViolations,
  orderNotional,
  summarizeDailyOrderUsage,
  usageUnitPrice,
  type DailyOrderUsage,
  type DailyOrderUsageRow,
} from './orderUsage.js';

/** 한 줄 만들기. pg가 `numeric`을 문자열로 주는 것까지 그대로 흉내 낸다. */
function marketRow(overrides: Partial<DailyOrderUsageRow> = {}): DailyOrderUsageRow {
  return { orderType: 'market', quantity: '3', limitPrice: null, estimatedPrice: '71300', ...overrides };
}

function limitRow(overrides: Partial<DailyOrderUsageRow> = {}): DailyOrderUsageRow {
  return { orderType: 'limit', quantity: '2', limitPrice: '50000', estimatedPrice: null, ...overrides };
}

describe('일일 사용량 — 시장가 주문', () => {
  it('추정가 × 수량으로 쌓인다', () => {
    const usage = summarizeDailyOrderUsage([marketRow()]);
    assert.equal(usage.notional, 213_900, '3주 × 71,300원');
    assert.equal(usage.unpricedCount, 0);
    assert.equal(usage.count, 1);
  });

  it('단가가 없다고 0원으로 치지 않는다', () => {
    // 옛 SQL(`COALESCE(limit_price, 0)`)이면 여기가 0이 된다. 그게 이 결함이었다.
    const usage = summarizeDailyOrderUsage([marketRow(), marketRow(), marketRow()]);
    assert.notEqual(usage.notional, 0);
    assert.equal(usage.notional, 641_700);
  });

  it('여러 건이면 다 더한다', () => {
    const usage = summarizeDailyOrderUsage([
      marketRow({ quantity: 1, estimatedPrice: 100_000 }),
      marketRow({ quantity: 2, estimatedPrice: 250_000 }),
    ]);
    assert.equal(usage.notional, 600_000);
  });
});

describe('일일 사용량 — 지정가 주문 (회귀 방지)', () => {
  it('단가 × 수량으로 쌓인다', () => {
    const usage = summarizeDailyOrderUsage([limitRow()]);
    assert.equal(usage.notional, 100_000, '2주 × 50,000원');
    assert.equal(usage.unpricedCount, 0);
  });

  it('시장가와 지정가가 섞여 있어도 각자 제 단가로 쌓인다', () => {
    const usage = summarizeDailyOrderUsage([limitRow(), marketRow()]);
    assert.equal(usage.notional, 100_000 + 213_900);
    assert.equal(usage.count, 2);
    assert.equal(usage.unpricedCount, 0);
  });

  it('둘 다 들어 있으면 그 주문 유형이 실제로 쓴 값을 고른다', () => {
    // 있어서는 안 될 행이지만, 섞여도 시장가는 추정가·지정가는 단가로 읽어야 한다.
    assert.equal(usageUnitPrice(marketRow({ limitPrice: '9' })), 71_300);
    assert.equal(usageUnitPrice(limitRow({ estimatedPrice: '9' })), 50_000);
  });
});

describe('일일 사용량 — 모르는 것은 0이 아니다', () => {
  it('추정가를 모르는 시장가 주문은 합에 안 넣고 따로 센다', () => {
    const usage = summarizeDailyOrderUsage([
      limitRow(),
      marketRow({ estimatedPrice: null }),
      marketRow(),
    ]);
    assert.equal(usage.notional, 100_000 + 213_900, '아는 것만 더한다');
    assert.equal(usage.unpricedCount, 1);
    assert.equal(usage.count, 3, '건수는 금액을 몰라도 전부 센다');
  });

  it('빈 문자열을 0으로 읽지 않는다', () => {
    // `Number('')`은 NaN이 아니라 0이다. 그대로 읽으면 "값 없음"이 "0원"이 된다.
    const usage = summarizeDailyOrderUsage([marketRow({ estimatedPrice: '' })]);
    assert.equal(usage.notional, 0);
    assert.equal(usage.unpricedCount, 1, '0원 한 건이 아니라 모르는 한 건이다');
  });

  it('수량을 모르면 금액도 모른다', () => {
    const usage = summarizeDailyOrderUsage([marketRow({ quantity: null })]);
    assert.equal(usage.unpricedCount, 1);
    assert.equal(usage.notional, 0);
  });

  it('0원·음수 단가는 값이 아니라 모름으로 본다', () => {
    assert.equal(usageUnitPrice(marketRow({ estimatedPrice: '0' })), undefined);
    assert.equal(usageUnitPrice(limitRow({ limitPrice: '-1' })), undefined);
    assert.equal(usageUnitPrice(marketRow({ estimatedPrice: 'abc' })), undefined);
  });

  it('모르는 건이 섞여도 아는 것의 합은 하한으로 남는다', () => {
    const usage = summarizeDailyOrderUsage([
      marketRow({ estimatedPrice: null }),
      marketRow({ quantity: '', limitPrice: '', estimatedPrice: '' }),
      limitRow(),
    ]);
    assert.deepEqual(usage, { count: 3, notional: 100_000, unpricedCount: 2 });
  });
});

describe('일일 사용량 — 건수', () => {
  it('접수 건수는 금액과 무관하게 행 수 그대로다', () => {
    // 건수 한도(COUNT(*))는 원래 동작했다. 금액 쪽을 고치면서 깨지지 않아야 한다.
    const rows = Array.from({ length: 21 }, (_, index) =>
      index % 2 === 0 ? marketRow({ estimatedPrice: null }) : limitRow(),
    );
    assert.equal(summarizeDailyOrderUsage(rows).count, 21);
  });

  it('오늘 아무것도 없으면 0건 0원이고 모르는 건도 없다', () => {
    assert.deepEqual(summarizeDailyOrderUsage([]), { count: 0, notional: 0, unpricedCount: 0 });
  });
});

/** 기본 한도는 리스크 룰 기본값과 같다. 시험마다 필요한 것만 덮어쓴다. */
const LIMITS = { dailyOrderCountLimit: 20, dailyNotionalLimit: 5_000_000 };

function usage(overrides: Partial<DailyOrderUsage> = {}): DailyOrderUsage {
  return { count: 0, notional: 0, unpricedCount: 0, ...overrides };
}

describe('일일 한도 판정 — 시장가가 실제로 한도에 걸린다', () => {
  it('오늘 쌓인 것과 이번 주문을 더해 한도를 넘으면 막는다', () => {
    // 시장가 20주 × 240,000원을 이미 냈고(4,800,000원) 또 1주를 내려는 상황.
    const today = summarizeDailyOrderUsage([
      { orderType: 'market', quantity: '20', limitPrice: null, estimatedPrice: '240000' },
    ]);
    assert.equal(today.notional, 4_800_000);

    const blocked = dailyLimitViolations({ rules: LIMITS, usage: today, notional: 240_000 });
    assert.equal(blocked.length, 1, blocked.join(' / '));
    assert.match(blocked[0], /일일 주문 금액 한도 5,000,000원을 초과합니다 \(오늘 4,800,000원\)/);
  });

  it('예전 계산(시장가 0원)이었다면 통과했을 주문을 막는다', () => {
    // `COALESCE(limit_price, 0)`이면 오늘 누적이 0원이라 무엇을 내도 통과했다.
    const today = summarizeDailyOrderUsage([
      { orderType: 'market', quantity: '20', limitPrice: null, estimatedPrice: '240000' },
    ]);
    assert.deepEqual(dailyLimitViolations({ rules: LIMITS, usage: usage(), notional: 240_000 }), []);
    assert.equal(dailyLimitViolations({ rules: LIMITS, usage: today, notional: 240_000 }).length, 1);
  });

  it('경계에서 같으면 통과, 1원이라도 넘으면 막는다', () => {
    const today = usage({ count: 1, notional: 4_000_000 });
    assert.deepEqual(dailyLimitViolations({ rules: LIMITS, usage: today, notional: 1_000_000 }), []);
    assert.equal(dailyLimitViolations({ rules: LIMITS, usage: today, notional: 1_000_001 }).length, 1);
  });
});

describe('일일 한도 판정 — 건수 (회귀 방지)', () => {
  it('한도만큼 찼으면 다음 한 건을 막는다', () => {
    // 건수는 원래 동작하던 잣대다. 금액 쪽을 고치면서 깨지지 않아야 한다.
    assert.deepEqual(dailyLimitViolations({ rules: LIMITS, usage: usage({ count: 19 }), notional: 1 }), []);
    const full = dailyLimitViolations({ rules: LIMITS, usage: usage({ count: 20 }), notional: 1 });
    assert.equal(full.length, 1);
    assert.match(full[0], /일일 주문 건수 한도 20건을 초과합니다 \(오늘 20건\)/);
  });

  it('금액을 몰라도 건수 잣대는 그대로 센다', () => {
    const unknown = dailyLimitViolations({
      rules: LIMITS,
      usage: usage({ count: 20, unpricedCount: 20 }),
      notional: undefined,
    });
    assert.equal(unknown.length, 2, unknown.join(' / '));
    assert.match(unknown[0], /건수 한도/);
    assert.match(unknown[1], /금액을 알 수 없는 건/);
  });
});

describe('일일 한도 판정 — 모르면 막힌 쪽', () => {
  it('오늘 접수분 중 금액을 모르는 건이 있으면 한도를 확인할 수 없다고 막는다', () => {
    const blocked = dailyLimitViolations({
      rules: LIMITS,
      usage: usage({ count: 3, notional: 100_000, unpricedCount: 2 }),
      notional: 10_000,
    });
    assert.equal(blocked.length, 1);
    assert.match(blocked[0], /확인할 수 없습니다 \(2건\)/);
  });

  it('이번 주문 금액을 모르면 금액 한도로 통과시키지 않는다', () => {
    // 0으로 치면 `0 > 한도`가 거짓이라 조용히 지나간다. 그래서 undefined로 온다.
    const usageNearLimit = usage({ count: 1, notional: 4_999_999 });
    assert.deepEqual(
      dailyLimitViolations({ rules: LIMITS, usage: usageNearLimit, notional: undefined }),
      [],
      '금액 한도로는 막지 않는다 — 그 판정은 1회 한도 쪽 `단가를 알 수 없어` 사유가 맡는다',
    );
    assert.equal(orderNotional(1, undefined), undefined, '모르는 값이 0으로 새어 들어오지 않는다');
  });

  it('아무것도 안 걸리면 빈 배열이다', () => {
    assert.deepEqual(dailyLimitViolations({ rules: LIMITS, usage: usage(), notional: 1_000 }), []);
  });
});

describe('orderNotional — 판정 대상 주문 1건', () => {
  it('수량 × 단가', () => {
    assert.equal(orderNotional(3, 71_300), 213_900);
  });

  it('단가를 모르면 0이 아니라 undefined다', () => {
    // 0을 돌려주면 금액 한도를 무조건 통과한다. 모르면 통과가 아니라 보류여야 한다.
    assert.equal(orderNotional(3, undefined), undefined);
    assert.equal(orderNotional(3, 0), undefined);
    assert.equal(orderNotional(3, Number.NaN), undefined);
    assert.equal(orderNotional(0, 71_300), undefined);
  });
});
