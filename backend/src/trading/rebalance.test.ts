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
