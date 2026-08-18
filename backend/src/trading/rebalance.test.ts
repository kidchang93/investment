/**
 * 비중 복원 계산 검증. **네트워크를 쓰지 않는다.**
 *
 * 여기서 못 박는 것은 2026-08-14에 실제로 어긋난 자리다 — 중복 체결로 두 종목이
 * 목표를 넘고 두 종목은 하나도 못 샀다. 그 상태를 그대로 넣어 계획이 옳게
 * 나오는지 본다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { limitPriceFor, planRebalance, type RebalanceHolding } from './rebalance.js';

/** 2026-08-14 장 마감 무렵 실제 보유. 중복 체결이 그대로 담겨 있다. */
function actualHoldings(): RebalanceHolding[] {
  return [
    { symbol: '329200', name: 'TIGER 리츠부동산인프라', quantity: 6057, price: 4125 },
    { symbol: '360750', name: 'TIGER 미국S&P500', quantity: 714, price: 27345 },
    { symbol: '161510', name: 'PLUS 고배당주', quantity: 712, price: 25600 },
    { symbol: '069500', name: 'KODEX 200', quantity: 96, price: 109870 },
    { symbol: '411060', name: 'ACE KRX금현물', quantity: 254, price: 27575 },
  ];
}

const TARGETS = [
  { symbol: '360750', weight: 0.251 },
  { symbol: '329200', weight: 0.231 },
  { symbol: '069500', weight: 0.199 },
  { symbol: '161510', weight: 0.170 },
  { symbol: '411060', weight: 0.150 },
];

const BASE = {
  targets: TARGETS,
  cash: 16_850_949,
  bucketWeight: 0.80,
  slipRate: 0.002,
  minLegAmount: 100_000,
};

describe('비중 복원 계획', () => {
  it('★ 초과한 것은 팔고 미달한 것은 산다 — 2026-08-14 실제 상태', () => {
    const plan = planRebalance({ ...BASE, holdings: actualHoldings() });
    const bySymbol = new Map(plan.legs.map((l) => [l.symbol, l]));

    // 중복 체결로 넘친 둘
    assert.equal(bySymbol.get('329200')?.side, 'sell', '리츠는 팔아야 한다');
    assert.equal(bySymbol.get('161510')?.side, 'sell', '고배당주는 팔아야 한다');
    // 한 주도 못 산 둘
    assert.equal(bySymbol.get('069500')?.side, 'buy', 'KODEX 200은 사야 한다');
    assert.equal(bySymbol.get('411060')?.side, 'buy', '금현물은 사야 한다');
    // 목표와 거의 맞는 것은 건드리지 않는다
    assert.equal(bySymbol.has('360750'), false, '이미 맞는 종목까지 매매하면 비용만 든다');
  });

  it('집행하면 비중이 목표에 가까워진다', () => {
    const plan = planRebalance({ ...BASE, holdings: actualHoldings() });
    for (const leg of plan.legs) {
      const target = TARGETS.find((t) => t.symbol === leg.symbol)!.weight * BASE.bucketWeight;
      const before = Math.abs(leg.fromWeight - target);
      const after = Math.abs(leg.toWeight - target);
      assert.ok(after < before, `${leg.symbol}: ${before.toFixed(4)} → ${after.toFixed(4)}`);
      assert.ok(after < 0.005, `${leg.symbol}가 목표에서 0.5%p 넘게 떨어져 있다`);
    }
  });

  it('매도 다리가 보유 수량을 넘지 않는다 — 없는 것을 팔 수 없다', () => {
    // 목표가 0인 종목을 통째로 정리하는 극단 상황
    const plan = planRebalance({
      ...BASE,
      holdings: [{ symbol: '329200', name: '리츠', quantity: 100, price: 4125 }],
      targets: [{ symbol: '329200', weight: 0 }],
      cash: 0,
    });
    assert.equal(plan.legs[0].side, 'sell');
    assert.ok(plan.legs[0].quantity <= 100, '보유보다 많이 판다');
  });

  it('차이가 문턱보다 작으면 건드리지 않고 사유를 남긴다', () => {
    // 총자산 12,600,000 × 0.8 = 10,080,000 목표인데 보유가 10,000,000 → 차이 8만원
    const plan = planRebalance({
      ...BASE,
      holdings: [{ symbol: '069500', name: 'KODEX 200', quantity: 100, price: 100_000 }],
      targets: [{ symbol: '069500', weight: 1 }],
      cash: 2_600_000,
      bucketWeight: 0.8,
      minLegAmount: 5_000_000,
    });
    assert.deepEqual(plan.legs, [], '잔돈 매매를 만들면 비용만 든다');
    assert.match(plan.skipped[0]?.reason ?? '', /문턱/);
  });

  it('차이가 아예 없으면 사유도 안 남긴다 — 없는 일을 적지 않는다', () => {
    const plan = planRebalance({
      ...BASE,
      holdings: [{ symbol: '069500', name: 'KODEX 200', quantity: 100, price: 100_000 }],
      targets: [{ symbol: '069500', weight: 1 }],
      cash: 2_500_000,
      bucketWeight: 0.8,
      minLegAmount: 100_000,
    });
    assert.deepEqual(plan.legs, []);
    assert.deepEqual(plan.skipped, []);
  });

  it('현재가를 못 받은 종목은 계획에서 빼고 사유를 남긴다 — 0으로 지어내지 않는다', () => {
    const plan = planRebalance({
      ...BASE,
      holdings: [...actualHoldings(), { symbol: '999999', name: '알수없음', quantity: 10, price: null }],
    });
    assert.ok(plan.skipped.some((s) => s.symbol === '999999' && /현재가/.test(s.reason)));
    assert.ok(!plan.legs.some((l) => l.symbol === '999999'));
  });

  it('목표 비중에 없는 종목은 건드리지 않는다 — 모르는 것을 팔지 않는다', () => {
    const plan = planRebalance({
      ...BASE,
      holdings: [...actualHoldings(), { symbol: '005930', name: '삼성전자', quantity: 10, price: 268_000 }],
    });
    assert.ok(plan.skipped.some((s) => s.symbol === '005930' && /목표 비중에 없는/.test(s.reason)));
    assert.ok(!plan.legs.some((l) => l.symbol === '005930'));
  });

  it('보유가 없으면 계획도 비어 있다', () => {
    const plan = planRebalance({ ...BASE, holdings: [] });
    assert.deepEqual(plan.legs, []);
    assert.equal(plan.bucketNow, 0);
  });
});

describe('지정가 — 호가단위 5원', () => {
  it('매수는 올리고 매도는 내린다 — 체결을 우선한다', () => {
    assert.ok(limitPriceFor(27_345, 'buy', 0.002) > 27_345);
    assert.ok(limitPriceFor(27_345, 'sell', 0.002) < 27_345);
  });

  it('언제나 5원의 배수다 — ETF 호가단위는 값과 무관하게 5원이다', () => {
    for (const p of [4125, 25_600, 27_345, 109_870, 7]) {
      assert.equal(limitPriceFor(p, 'buy', 0.002) % 5, 0, `매수 ${p}`);
      assert.equal(limitPriceFor(p, 'sell', 0.002) % 5, 0, `매도 ${p}`);
    }
  });

  it('0원 이하로 내려가지 않는다', () => {
    assert.ok(limitPriceFor(5, 'sell', 0.9) >= 5);
  });
});

describe('적립 매수 — 팔지 않고 미달한 것만 산다', () => {
  /*
   * 매달 넣는 돈으로 비중을 맞추는 방식. 초기 몇 년은 수익률보다 납입이 자산을
   * 좌우하므로(자산 6천만~1억이 되기 전까지 연 납입액 > 연 수익) 이 경로가
   * 실제로 목표를 만든다.
   */
  const holdings = [
    { symbol: '360750', name: 'S&P500', quantity: 100, price: 27_000 },   // 270만
    { symbol: '069500', name: 'KODEX200', quantity: 10, price: 110_000 }, // 110만
  ];
  const targets = [
    { symbol: '360750', weight: 0.5 },
    { symbol: '069500', weight: 0.5 },
  ];

  it('★ 초과한 것을 팔지 않는다 — 판 뒤 다시 사면 수수료와 세금만 든다', () => {
    const plan = planRebalance({
      holdings, targets, cash: 1_000_000, bucketWeight: 1,
      slipRate: 0.002, minLegAmount: 100_000, buyOnly: true,
    });
    assert.ok(plan.legs.every((l) => l.side === 'buy'), '적립인데 매도가 있다');
    assert.ok(plan.legs.some((l) => l.symbol === '069500'), '미달한 쪽을 사야 한다');
  });

  it('예산을 넘겨 사지 않는다', () => {
    const plan = planRebalance({
      holdings, targets, cash: 10_000_000, bucketWeight: 1,
      slipRate: 0.002, minLegAmount: 100_000, buyOnly: true, buyBudget: 500_000,
    });
    assert.ok(plan.buyAmount <= 500_000, `예산 50만인데 ${plan.buyAmount}원어치를 산다`);
    assert.ok(plan.buyAmount > 0, '살 수 있는데 아무것도 안 샀다');
  });

  it('예산이 문턱보다 작으면 아무것도 사지 않고 사유를 남긴다', () => {
    const plan = planRebalance({
      holdings, targets, cash: 10_000_000, bucketWeight: 1,
      slipRate: 0.002, minLegAmount: 500_000, buyOnly: true, buyBudget: 200_000,
    });
    assert.deepEqual(plan.legs, [], '잔돈으로 사면 수수료만 든다');
    assert.ok(plan.skipped.some((s) => /예산/.test(s.reason)), plan.skipped.map((s) => s.reason).join(' / '));
  });

  it('미달이 큰 쪽부터 채운다 — 예산이 모자라면 뒤엣것은 안 산다', () => {
    const three = [
      { symbol: 'A', name: 'A', quantity: 100, price: 10_000 },  // 100만 (목표 33% → 초과)
      { symbol: 'B', name: 'B', quantity: 10, price: 10_000 },   // 10만  (크게 미달)
      { symbol: 'C', name: 'C', quantity: 50, price: 10_000 },   // 50만  (조금 미달)
    ];
    const plan = planRebalance({
      holdings: three,
      targets: [{ symbol: 'A', weight: 1 / 3 }, { symbol: 'B', weight: 1 / 3 }, { symbol: 'C', weight: 1 / 3 }],
      cash: 5_000_000, bucketWeight: 1,
      slipRate: 0.002, minLegAmount: 100_000, buyOnly: true, buyBudget: 600_000,
    });
    assert.ok(plan.legs.length > 0);
    assert.equal(plan.legs[0].symbol, 'B', '가장 미달한 것을 먼저 채워야 한다');
    assert.ok(plan.buyAmount <= 600_000);
  });

  it('적립 모드가 아니면 예전처럼 팔기도 한다 — 기본 동작을 안 바꾼다', () => {
    const plan = planRebalance({
      holdings, targets, cash: 0, bucketWeight: 1,
      slipRate: 0.002, minLegAmount: 100_000,
    });
    assert.ok(plan.legs.some((l) => l.side === 'sell'), '복원 모드에서는 팔아야 한다');
  });
});
