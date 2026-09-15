import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkBuy, type BuyGuardInput } from './buyGuard.js';

const base: BuyGuardInput = {
  quantity: 10,
  limitPrice: 100_000,
  stopPrice: 95_000,
  layer: 'short',
  equity: 100_000_000,
  buyingPower: 50_000_000,
  heldValue: 0,
  layerValue: 0,
  currentPrice: 100_000,
};

describe('분석가 제안서 매수 한도', () => {
  it('한도 안이면 그대로 낸다', () => {
    assert.deepEqual(checkBuy(base), { kind: 'ok', quantity: 10, trimmed: [] });
  });

  it('종목 10%를 넘으면 줄인다 — 이미 든 것도 센다', () => {
    const v = checkBuy({ ...base, quantity: 200, heldValue: 4_000_000 });
    // 10% = 1,000만 − 이미 400만 = 600만 → 60주
    assert.equal(v.kind === 'ok' && v.quantity, 60);
  });

  it('위험 2%로 줄인다 — (지정가 − 손절) × 수량 ≤ 총자산 2%', () => {
    const v = checkBuy({ ...base, quantity: 100, stopPrice: 50_000 });
    // 200만 ÷ 5만 = 40주 (종목 10%는 100주라 위험이 먼저 걸린다)
    assert.equal(v.kind === 'ok' && v.quantity, 40);
  });

  it('매수여력·층 50%로도 줄인다', () => {
    assert.equal((checkBuy({ ...base, buyingPower: 350_000 }) as { quantity: number }).quantity, 3);
    assert.equal((checkBuy({ ...base, layer: 'etf', quantity: 100, layerValue: 49_500_000 }) as { quantity: number }).quantity, 5);
  });

  it('ETF 층에는 종목 10%·위험 2%를 걸지 않는다', () => {
    const v = checkBuy({ ...base, layer: 'etf', quantity: 300, stopPrice: 10_000 });
    assert.equal(v.kind === 'ok' && v.quantity, 300);
  });

  it('1주도 안 남으면 막는다', () => {
    assert.equal(checkBuy({ ...base, buyingPower: 50_000 }).kind, 'block');
  });

  it('현재가가 지정가에서 2% 넘게 벗어났으면 막는다 — 2%까지는 낸다', () => {
    assert.equal(checkBuy({ ...base, currentPrice: 102_000 }).kind, 'ok');
    assert.equal(checkBuy({ ...base, currentPrice: 102_100 }).kind, 'block');
    assert.equal(checkBuy({ ...base, currentPrice: 97_900 }).kind, 'block');
  });

  it('손절가가 지정가 이상이거나 총자산을 못 읽었으면 막는다', () => {
    assert.equal(checkBuy({ ...base, stopPrice: 100_000 }).kind, 'block');
    assert.equal(checkBuy({ ...base, equity: 0 }).kind, 'block');
  });
});
