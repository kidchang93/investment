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

  /*
   * ★ 2026-08-21에 티에스이 손절이 층 없이 나가 층 장부가 끊겼다. 매도가 어느
   *   층에서 빠지는지는 **파는 순간 함께 나가야** 되돌릴 수 있다.
   */
  it('★ 규칙에 적힌 층을 매도로 그대로 옮긴다 — 층 장부가 여기서 끊겼다', () => {
    const stops = new Map<string, StopRule>([
      ['131290', { stop: 218_000, round: 22, layer: 'short' }],
    ]);
    const r = checkStops([pos('131290', 20, 217_000)], stops, NO_EXEC);
    assert.equal(r.breaches[0].layer, 'short');
  });

  it('층을 모르면 비운 채 낸다 — 짐작해서 채우면 그 층 손익이 거짓이 된다', () => {
    const r = checkStops([pos('131290', 20, 217_000)], rules(['131290', 218_000]), NO_EXEC);
    assert.equal(r.breaches[0].layer, undefined);
  });
});

/*
 * ── 익절가를 넘은 자리 (2026-09-08) ────────────────────────────────────
 *
 * 사용자가 정했다 — *"더 수익을 볼 만하다 싶으면 좀 더 보고, 아니다 싶으면 바로
 * 익절하고 다른 투자처 찾기."* 그래서 **팔지 않고 판단자를 깨운다.**
 *
 * 그 전에는 판정 자체가 없었고, 삼성전자우가 익절가를 넘은 회차가 매도 0건으로
 * 끝났다 — 더 갈 것 같다고 판단한 것이 아니라 넘은 줄 몰랐다.
 */
describe('익절가를 넘은 자리', () => {
  const held = (symbol: string, currentPrice: number) => ([{
    symbol, name: symbol, quantity: 10, currentPrice,
  }]);

  it('넘으면 잡고, 얼마나 더 왔는지 함께 준다', () => {
    const r = checkStops(
      held('005935', 198_400),
      new Map([['005935', { stop: 177_000, target: 196_000, round: 57 }]]),
      [],
    );
    assert.equal(r.targetsHit.length, 1);
    assert.equal(r.targetsHit[0].target, 196_000);
    assert.ok(Math.abs(r.targetsHit[0].overshootRate - (198_400 / 196_000 - 1)) < 1e-9);
    // 익절은 파는 목록이 아니다 — 손절만 판다.
    assert.equal(r.breaches.length, 0);
  });

  it('목표가에 정확히 닿아도 넘은 것으로 본다', () => {
    const r = checkStops(
      held('005935', 196_000),
      new Map([['005935', { stop: 177_000, target: 196_000, round: 57 }]]),
      [],
    );
    assert.equal(r.targetsHit.length, 1);
  });

  it('아직 안 닿았으면 조용하다', () => {
    const r = checkStops(
      held('015760', 34_100),
      new Map([['015760', { stop: 30_300, target: 34_900, round: 103 }]]),
      [],
    );
    assert.equal(r.targetsHit.length, 0);
  });

  it('익절가를 안 적은 자리는 판정하지 않는다', () => {
    const r = checkStops(
      held('069500', 999_999),
      new Map([['069500', { stop: 90_000, round: 1 }]]),
      [],
    );
    assert.equal(r.targetsHit.length, 0, 'ETF처럼 약속이 없는 자리다');
  });

  it('현재가를 모르면 익절도 판정하지 않는다', () => {
    const r = checkStops(
      [{ symbol: '005935', name: '삼성전자우', quantity: 10 }],
      new Map([['005935', { stop: 177_000, target: 196_000, round: 57 }]]),
      [],
    );
    assert.equal(r.targetsHit.length, 0);
    assert.deepEqual(r.unknownPrice, ['005935']);
  });

  it('손절과 익절이 같은 회차에서 갈린다 — 하나는 팔고 하나는 깨운다', () => {
    const r = checkStops(
      [
        { symbol: '005935', name: '삼성전자우', quantity: 10, currentPrice: 198_400 },
        { symbol: '015760', name: '한국전력', quantity: 10, currentPrice: 30_000 },
      ],
      new Map([
        ['005935', { stop: 177_000, target: 196_000, round: 57 }],
        ['015760', { stop: 30_300, target: 34_900, round: 103 }],
      ]),
      [],
    );
    assert.deepEqual(r.targetsHit.map((h) => h.symbol), ['005935']);
    assert.deepEqual(r.breaches.map((b) => b.symbol), ['015760']);
  });
});
