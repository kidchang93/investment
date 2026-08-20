import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkStops, type StopRule } from './stopLoss.js';
import type { BrokerExecution } from '@invest/shared';

const NO_EXEC: BrokerExecution[] = [];
const pos = (symbol: string, quantity: number, currentPrice?: number) => ({
  symbol, name: symbol, quantity, currentPrice,
});
const rules = (...pairs: Array<[string, number]>): Map<string, StopRule> =>
  new Map(pairs.map(([s, stop]) => [s, { stop, round: 22 }]));

describe('손절 판정 — 규칙이 집행하므로 시험으로 덮는다 (2026-08-20)', () => {
  it('현재가가 손절가 아래면 깬 것이다', () => {
    const r = checkStops([pos('131290', 20, 217_000)], rules(['131290', 218_000]), NO_EXEC);
    assert.equal(r.breaches.length, 1);
    assert.equal(r.breaches[0].quantity, 20);
  });

  it('★ 손절가와 같으면 깬 것으로 본다 — 닿으면 판단이 틀린 값이다', () => {
    const r = checkStops([pos('131290', 20, 218_000)], rules(['131290', 218_000]), NO_EXEC);
    assert.equal(r.breaches.length, 1);
  });

  it('한 호가 위면 팔지 않는다', () => {
    const r = checkStops([pos('131290', 20, 218_500)], rules(['131290', 218_000]), NO_EXEC);
    assert.equal(r.breaches.length, 0);
    assert.equal(r.watched, 1);
  });

  it('★ 손절가가 없는 자리는 대상이 아니다 — ETF 층은 손절을 안 적는다', () => {
    const r = checkStops([pos('069500', 137, 1)], rules(['131290', 218_000]), NO_EXEC);
    assert.equal(r.breaches.length, 0);
    assert.equal(r.watched, 0, '감시 대상으로도 세지 않는다');
  });

  it('★★ 현재가를 못 읽으면 판정하지 않는다 — 0으로 읽으면 전량이 손절로 떨어진다', () => {
    for (const price of [undefined, 0, Number.NaN]) {
      const r = checkStops([pos('131290', 20, price)], rules(['131290', 218_000]), NO_EXEC);
      assert.equal(r.breaches.length, 0, `현재가 ${String(price)}`);
      assert.deepEqual(r.unknownPrice, ['131290']);
    }
  });

  it('★ 미체결 매도가 있으면 그만큼 뺀다 — 없는 물량을 팔지 않는다', () => {
    const pending = [{
      orderNo: '1', orderDate: '20260820', orderTime: '113000',
      symbol: '131290', name: '티에스이', side: 'sell' as const,
      orderTypeLabel: '보통가', orderQuantity: 12, orderPrice: 218_000,
      filledQuantity: 0, filledAmount: 0, averageFilledPrice: 0,
      remainQuantity: 12, rejectedQuantity: 0, status: 'open' as const,
      currency: 'KRW', id: '1',
    }] as unknown as BrokerExecution[];
    const r = checkStops([pos('131290', 20, 217_000)], rules(['131290', 218_000]), pending);
    assert.equal(r.breaches[0].quantity, 8, '20주 중 12주는 이미 매도 중이다');
  });

  it('남은 수량이 0이면 주문하지 않는다', () => {
    const pending = [{
      orderNo: '1', orderDate: '20260820', orderTime: '113000',
      symbol: '131290', name: '티에스이', side: 'sell' as const,
      orderTypeLabel: '보통가', orderQuantity: 20, orderPrice: 218_000,
      filledQuantity: 0, filledAmount: 0, averageFilledPrice: 0,
      remainQuantity: 20, rejectedQuantity: 0, status: 'open' as const,
      currency: 'KRW', id: '1',
    }] as unknown as BrokerExecution[];
    const r = checkStops([pos('131290', 20, 217_000)], rules(['131290', 218_000]), pending);
    assert.equal(r.breaches.length, 0);
  });

  it('여러 자리가 함께 깨지면 전부 낸다', () => {
    const r = checkStops(
      [pos('131290', 20, 217_000), pos('105560', 58, 149_000), pos('069500', 137, 100_000)],
      rules(['131290', 218_000], ['105560', 150_000]),
      NO_EXEC,
    );
    assert.equal(r.breaches.length, 2);
    assert.equal(r.watched, 2);
  });
});
