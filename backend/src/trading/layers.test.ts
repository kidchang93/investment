/**
 * 3층 장부 검증. **네트워크를 쓰지 않는다.**
 *
 * 여기서 못 박는 것은 장부가 거짓말할 수 있는 자리들이다 — 없는 수량을 팔거나,
 * 현재가를 못 받은 종목을 0원으로 세거나, 증권사 잔고와 어긋난 것을 조용히
 * 넘기는 것. 셋 다 그대로 두면 층별 손익이 통째로 거짓이 된다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyTrade,
  averageCost,
  reconcile,
  summarizeLayers,
  type Layer,
  type LayerPosition,
} from './layers.js';

const empty = (layer: Layer, symbol: string): LayerPosition => ({ layer, symbol, quantity: 0, cost: 0 });

describe('층 장부 — 평균원가법', () => {
  it('사면 수량과 원가가 함께 는다. 수수료는 취득원가에 얹는다', () => {
    const r = applyTrade(empty('etf', '069500'), {
      layer: 'etf', symbol: '069500', side: 'buy', quantity: 10, price: 100_000, fee: 1_500,
    });
    assert.equal(r.position.quantity, 10);
    assert.equal(r.position.cost, 1_001_500);
    assert.equal(averageCost(r.position), 100_150);
    assert.equal(r.realizedPnl, null, '매수에는 실현손익이 없다');
  });

  it('두 번 사면 평균단가가 섞인다', () => {
    let p = applyTrade(empty('etf', '069500'), {
      layer: 'etf', symbol: '069500', side: 'buy', quantity: 10, price: 100_000, fee: 0,
    }).position;
    p = applyTrade(p, {
      layer: 'etf', symbol: '069500', side: 'buy', quantity: 10, price: 120_000, fee: 0,
    }).position;
    assert.equal(p.quantity, 20);
    assert.equal(averageCost(p), 110_000);
  });

  it('팔면 그 시점 평균원가로 실현손익이 난다', () => {
    const bought = applyTrade(empty('short', '005930'), {
      layer: 'short', symbol: '005930', side: 'buy', quantity: 10, price: 100_000, fee: 0,
    }).position;
    const sold = applyTrade(bought, {
      layer: 'short', symbol: '005930', side: 'sell', quantity: 4, price: 110_000, fee: 1_000,
    });
    // 4주 × (110,000 − 100,000) − 수수료 1,000
    assert.equal(sold.realizedPnl, 39_000);
    assert.equal(sold.position.quantity, 6);
    assert.equal(sold.position.cost, 600_000, '남은 6주의 원가만 남는다');
  });

  it('★ 장부에 없는 수량은 팔지 않는다 — 음수 수량을 만들면 이후 손익이 전부 거짓이 된다', () => {
    const p = applyTrade(empty('bet', '005930'), {
      layer: 'bet', symbol: '005930', side: 'buy', quantity: 5, price: 100_000, fee: 0,
    }).position;
    const r = applyTrade(p, {
      layer: 'bet', symbol: '005930', side: 'sell', quantity: 8, price: 110_000, fee: 0,
    });
    assert.equal(r.position.quantity, 0);
    assert.equal(r.shortfall, 3, '못 판 3주가 값으로 남아야 한다');
    assert.equal(r.realizedPnl, 50_000, '있는 5주만 판 손익');
  });

  it('다 팔면 원가가 정확히 0이다 — 부동소수 찌꺼기를 남기지 않는다', () => {
    let p = applyTrade(empty('etf', '360750'), {
      layer: 'etf', symbol: '360750', side: 'buy', quantity: 3, price: 27_345, fee: 137,
    }).position;
    p = applyTrade(p, {
      layer: 'etf', symbol: '360750', side: 'sell', quantity: 3, price: 27_500, fee: 140,
    }).position;
    assert.equal(p.quantity, 0);
    assert.equal(p.cost, 0);
  });

  it('다른 층·종목의 체결은 받지 않는다', () => {
    assert.throws(() => applyTrade(empty('etf', '069500'), {
      layer: 'short', symbol: '069500', side: 'buy', quantity: 1, price: 100, fee: 0,
    }));
    assert.throws(() => applyTrade(empty('etf', '069500'), {
      layer: 'etf', symbol: '005930', side: 'buy', quantity: 1, price: 100, fee: 0,
    }));
  });
});

describe('층별 집계', () => {
  const positions: LayerPosition[] = [
    { layer: 'etf', symbol: '069500', quantity: 96, cost: 9_494_265 },
    { layer: 'etf', symbol: '360750', quantity: 714, cost: 19_467_210 },
    { layer: 'short', symbol: '005930', quantity: 10, cost: 2_700_000 },
  ];
  const prices = new Map([['069500', 109_870], ['360750', 27_345], ['005930', 268_000]]);

  it('층마다 평가액·손익·비중을 따로 낸다', () => {
    const { summaries, totalAssets } = summarizeLayers(
      positions, prices, new Map([['short', 150_000]]), 10_000_000,
    );
    const etf = summaries.find((s) => s.layer === 'etf')!;
    const short = summaries.find((s) => s.layer === 'short')!;
    const bet = summaries.find((s) => s.layer === 'bet')!;

    assert.equal(etf.symbols, 2);
    assert.equal(etf.marketValue, 96 * 109_870 + 714 * 27_345);
    assert.ok(etf.unrealizedPnl > 0);
    assert.equal(short.realizedPnl, 150_000, '실현손익은 밖에서 들여온다');
    assert.equal(short.totalPnl, short.unrealizedPnl + 150_000);
    assert.equal(bet.symbols, 0, '아무것도 없는 층도 표에 남는다 — 0원인 사실이 보여야 한다');
    assert.equal(bet.targetWeight, 0.20);
    assert.ok(Math.abs(totalAssets - (etf.marketValue + short.marketValue + 10_000_000)) < 1);
  });

  it('★ 현재가를 못 받은 종목은 평가액에 0으로 넣지 않고 이름을 돌려준다', () => {
    const { summaries, unpriced } = summarizeLayers(
      [...positions, { layer: 'bet', symbol: '999999', quantity: 5, cost: 1_000_000 }],
      prices, new Map(), 0,
    );
    assert.deepEqual(unpriced, ['bet:999999']);
    const bet = summaries.find((s) => s.layer === 'bet')!;
    assert.equal(bet.marketValue, 0);
    assert.equal(bet.cost, 1_000_000, '원가는 남는다 — 산 것은 사실이다');
  });

  it('수량이 0인 자리는 세지 않는다', () => {
    const { summaries } = summarizeLayers(
      [{ layer: 'etf', symbol: '069500', quantity: 0, cost: 0 }], prices, new Map(), 0,
    );
    assert.equal(summaries.find((s) => s.layer === 'etf')!.symbols, 0);
  });
});

describe('★ 증권사 잔고 대조 — 2026-08-14에 중복 체결을 잡은 방식', () => {
  it('장부와 잔고가 다르면 종목과 두 수량을 함께 돌려준다', () => {
    const positions: LayerPosition[] = [
      { layer: 'etf', symbol: '329200', quantity: 4364, cost: 18_000_000 },
      { layer: 'etf', symbol: '069500', quantity: 96, cost: 9_494_265 },
    ];
    // 중복 체결로 실제 잔고가 1,693주 더 많다
    const broker = new Map([['329200', 6057], ['069500', 96]]);
    const m = reconcile(positions, broker);
    assert.equal(m.length, 1);
    assert.deepEqual(m[0], { symbol: '329200', ledger: 4364, broker: 6057 });
  });

  it('장부에만 있는 종목도 잡는다 — 팔렸는데 기록을 못 한 경우', () => {
    const m = reconcile([{ layer: 'bet', symbol: '005930', quantity: 10, cost: 1 }], new Map());
    assert.deepEqual(m, [{ symbol: '005930', ledger: 10, broker: 0 }]);
  });

  it('맞으면 빈 배열이다', () => {
    const m = reconcile(
      [{ layer: 'etf', symbol: '069500', quantity: 96, cost: 1 }],
      new Map([['069500', 96]]),
    );
    assert.deepEqual(m, []);
  });
});
