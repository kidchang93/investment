/**
 * 실계좌 주문 버튼을 여는 판정 검증.
 *
 * 이 함수가 빈 배열을 돌려주면 화면의 `매수 주문하기`가 눌린다. 실제 돈이
 * 오가는 자리라, 서버 쪽 비슷한 판정들(`screenQuote`, `krxSessionKind`)처럼
 * 경계를 못 박아 둔다.
 *
 * **서버가 최종 판정자다.** 이건 화면이 미리 걸러 보는 부분집합이고, 거래
 * 시간대·휴장일·오늘 누적 한도는 일부러 보지 않는다. 그 사실도 시험으로 남긴다 —
 * 나중에 "빠졌다"고 채우면 서버와 어긋난 순간 화면이 거짓말을 한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { riskRuleBlockers, type RiskRuleSet } from '@invest/shared';

/** 아무 데도 안 걸리는 기본값. 시험마다 필요한 것만 덮어쓴다. */
function rules(overrides: Partial<RiskRuleSet> = {}): RiskRuleSet {
  return {
    accountId: '21',
    enabled: true,
    maxOrderQuantity: 1_000,
    maxOrderNotional: 1_000_000,
    dailyOrderCountLimit: 20,
    dailyNotionalLimit: 5_000_000,
    allowMarketOrder: true,
    sessionStart: '09:00',
    sessionEnd: '15:30',
    symbolAllowlist: [],
    symbolBlocklist: [],
    ...overrides,
  } as RiskRuleSet;
}

/** 통과하는 주문 한 건. */
function order(overrides: Record<string, unknown> = {}) {
  return {
    rules: rules(),
    error: null,
    symbol: '005930',
    orderType: 'limit' as const,
    quantity: 1,
    price: 50_000,
    ...overrides,
  };
}

describe('riskRuleBlockers — 룰을 모를 때', () => {
  it('아직 안 왔으면 막는다', () => {
    const blockers = riskRuleBlockers(order({ rules: null }));
    assert.equal(blockers.length, 1);
    assert.match(blockers[0], /확인하는 중/);
  });

  it('조회가 실패했으면 막고 사유를 적는다', () => {
    // 값이 있어도 마지막 조회가 실패했으면 아는 것이 아니다.
    const blockers = riskRuleBlockers(order({ error: '502' }));
    assert.equal(blockers.length, 1);
    assert.match(blockers[0], /확인하지 못했습니다/);
    assert.match(blockers[0], /502/);
  });

  it('실패는 값이 있어도 막는다', () => {
    // 그 사이 룰이 조여졌으면 낡은 값으로 "괜찮습니다"라고 말하게 된다.
    assert.equal(riskRuleBlockers(order({ rules: rules(), error: 'x' })).length, 1);
  });
});

describe('riskRuleBlockers — 통과', () => {
  it('아무 데도 안 걸리면 빈 배열이다', () => {
    assert.deepEqual(riskRuleBlockers(order()), []);
  });

  it('허용 목록이 비어 있으면 전체 허용이다', () => {
    assert.deepEqual(riskRuleBlockers(order({ symbol: '000660' })), []);
  });
});

describe('riskRuleBlockers — 경계', () => {
  it('수량 한도는 같으면 통과, 넘으면 막는다', () => {
    assert.deepEqual(riskRuleBlockers(order({ quantity: 1_000, price: 1 })), []);
    const over = riskRuleBlockers(order({ quantity: 1_001, price: 1 }));
    assert.equal(over.length, 1);
    assert.match(over[0], /수량 한도 1,000주/);
  });

  it('금액 한도는 같으면 통과, 넘으면 막는다', () => {
    assert.deepEqual(riskRuleBlockers(order({ quantity: 10, price: 100_000 })), []);
    const over = riskRuleBlockers(order({ quantity: 10, price: 100_001 }));
    assert.equal(over.length, 1);
    assert.match(over[0], /금액 한도 1,000,000원/);
  });

  it('수량이 숫자가 아니면 그 잣대로 막지 않는다', () => {
    // 빈 칸은 여기서 막을 일이 아니다 — `수량은 0보다 커야 합니다`가 따로 있다.
    assert.deepEqual(riskRuleBlockers(order({ quantity: Number.NaN, price: 1 })), []);
  });
});

describe('riskRuleBlockers — 종목·유형', () => {
  it('차단 종목은 막는다', () => {
    const blockers = riskRuleBlockers(order({ rules: rules({ symbolBlocklist: ['005930'] }) }));
    assert.equal(blockers.length, 1);
    assert.match(blockers[0], /차단 종목/);
  });

  it('허용 목록 밖이면 막고, 무엇이 허용인지 적는다', () => {
    const blockers = riskRuleBlockers(
      order({ symbol: '000660', rules: rules({ symbolAllowlist: ['005930'] }) }),
    );
    assert.equal(blockers.length, 1);
    assert.match(blockers[0], /허용 종목 목록에 없습니다 \(000660\)/);
    assert.match(blockers[0], /허용: 005930/);
  });

  it('종목을 아직 모르면 종목 잣대로 막지 않는다', () => {
    assert.deepEqual(riskRuleBlockers(order({ symbol: undefined, rules: rules({ symbolAllowlist: ['005930'] }) })), []);
  });

  /*
   * **시나리오를 이 시험이 직접 만든다.** 예전에는 `rules()` 기본값이 마침
   * `allowMarketOrder: false`인 것에 기대고 있었는데, 기본값이 바뀌자 시험 이름과
   * 실제로 재는 것이 어긋났다 — "막혀 있으면"을 검사한다면서 안 막힌 룰을 태웠다.
   * 기본값이 무엇이든 이 시험은 같은 것을 재야 한다.
   */
  it('시장가가 막혀 있으면 시장가만 막고 지정가는 통과시킨다', () => {
    const blocked = rules({ allowMarketOrder: false });
    assert.deepEqual(riskRuleBlockers(order({ rules: blocked, orderType: 'limit' })), []);
    const market = riskRuleBlockers(order({ rules: blocked, orderType: 'market' }));
    assert.equal(market.length, 1);
    assert.match(market[0], /시장가 주문이 막혀/);
  });

  it('시장가가 허용돼 있으면 시장가도 통과시킨다', () => {
    const allowed = rules({ allowMarketOrder: true });
    assert.deepEqual(riskRuleBlockers(order({ rules: allowed, orderType: 'market' })), []);
  });

  it('실주문이 꺼져 있으면 막는다', () => {
    const blockers = riskRuleBlockers(order({ rules: rules({ enabled: false }) }));
    assert.match(blockers[0], /실주문이 꺼져 있습니다/);
  });

  it('걸리는 것이 여럿이면 전부 모아 준다', () => {
    // 화면은 사유를 한 번에 보여준다 — 하나 고치고 눌러 봐야 다음을 아는 건 아니다.
    // 넷을 세려면 시장가 차단도 걸려야 하므로 그 조건을 여기서 명시한다.
    const blockers = riskRuleBlockers(
      order({
        orderType: 'market',
        quantity: 2_000,
        price: 1_000,
        rules: rules({ symbolBlocklist: ['005930'], allowMarketOrder: false }),
      }),
    );
    assert.equal(blockers.length, 4, blockers.join(' / '));
  });
});

describe('riskRuleBlockers — 서버만 아는 것은 보지 않는다', () => {
  it('거래 시간대를 보지 않는다', () => {
    // 화면이 흉내 내면 서버와 어긋난 순간 거짓말이 된다(docs/CODE_STYLE.md).
    // 시간대를 좁혀도 이 함수의 판정은 달라지지 않아야 한다.
    const narrow = rules({ sessionStart: '00:00', sessionEnd: '00:01' });
    assert.deepEqual(riskRuleBlockers(order({ rules: narrow })), []);
  });

  it('일일 한도를 보지 않는다', () => {
    // 오늘 얼마나 썼는지는 서버만 안다. 0으로 두어도 여기서는 막지 않는다.
    const zero = rules({ dailyOrderCountLimit: 0, dailyNotionalLimit: 0 });
    assert.deepEqual(riskRuleBlockers(order({ rules: zero })), []);
  });
});
