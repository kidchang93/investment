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
  explainMismatches,
  resolveFillLayer,
  resolveSellLayer,
  tradeStampFor,
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

/*
 * ★ 체결을 어느 층에 넣을 것인가 (2026-08-22).
 *
 * 예전 `layerSync`는 기본값이 `--layer etf`였고 데몬은 인자 없이 부른다 —
 * **자동 경로가 모르는 것을 ETF라고 단정하는 구조**였다. 잘못 들어간 체결은
 * 잔고 대조로도 안 걸린다(합계는 맞으므로).
 */
describe('체결의 층 판정 — 모르면 넣지 않는다', () => {
  it('주문에 층이 적혀 있으면 그것이 맞다', () => {
    const d = resolveFillLayer('bet', 'etf');
    assert.deepEqual(d, { kind: 'use', layer: 'bet', fromOrder: true });
  });

  it('주문에 없고 사람이 정해 줬으면 그 값으로 넣는다', () => {
    const d = resolveFillLayer(undefined, 'short');
    assert.deepEqual(d, { kind: 'use', layer: 'short', fromOrder: false });
  });

  it('★★ 둘 다 없으면 건너뛴다 — 예전에는 조용히 ETF로 들어갔다', () => {
    const d = resolveFillLayer(undefined, undefined);
    assert.equal(d.kind, 'skip');
    assert.match(d.kind === 'skip' ? d.why : '', /--layer/, '무엇을 해야 하는지 말해야 한다');
  });
});

/*
 * ★★ 장중 체결은 어긋나 보이는 것이 정상이다 (2026-09-02).
 *
 * 장부는 **체결이 확인된 것만** 담고 그 확인은 마감 정리에서 한다. 그래서
 * 장중에 체결되면 15:40까지 반드시 어긋나 보이고, 그것이 20분마다 경보로
 * 나갔다. 이 경보는 2026-08-21에 하루 16번 울려 감시를 멈추게 한 전력이 있다.
 *
 * **매일 울리는 경보는 읽히지 않는다** — 그러면 8/25 삼성전자처럼 진짜로 빠진
 * 것을 8일간 못 본다.
 */
describe('어긋남 — 오늘 낸 주문으로 설명되나', () => {
  const mismatch = (symbol: string, ledger: number, broker: number) => ({ symbol, ledger, broker });

  it('오늘 매도한 만큼 잔고가 줄었으면 설명된다', () => {
    // 2026-09-02 실제 값: KB금융 장부 58주 · 잔고 54주 · 오늘 매도 4주
    const [m] = explainMismatches(
      [mismatch('105560', 58, 54)],
      [{ symbol: '105560', side: 'sell', quantity: 4 }],
    );
    assert.equal(m.explained, true);
  });

  it('오늘 매수한 만큼 잔고가 늘었으면 설명된다', () => {
    const [m] = explainMismatches(
      [mismatch('010950', 0, 30)],
      [{ symbol: '010950', side: 'buy', quantity: 30 }],
    );
    assert.equal(m.explained, true);
  });

  it('부분체결이면 차이가 접수량보다 작다 — 여전히 설명된다', () => {
    const [m] = explainMismatches(
      [mismatch('105560', 58, 56)],
      [{ symbol: '105560', side: 'sell', quantity: 4 }],
    );
    assert.equal(m.explained, true, '접수량은 상한이다');
  });

  it('★ 차이가 접수량을 넘으면 설명이 안 된다 — 우리 주문 밖의 일이 있었다', () => {
    const [m] = explainMismatches(
      [mismatch('105560', 58, 50)],
      [{ symbol: '105560', side: 'sell', quantity: 4 }],
    );
    assert.equal(m.explained, false);
  });

  it('★ 방향이 반대면 설명이 안 된다 — 팔았는데 잔고가 늘 수는 없다', () => {
    const [m] = explainMismatches(
      [mismatch('105560', 58, 62)],
      [{ symbol: '105560', side: 'sell', quantity: 10 }],
    );
    assert.equal(m.explained, false);
  });

  it('★★ 오늘 주문이 없으면 무엇도 설명되지 않는다 — 손으로 낸 매매는 알려야 한다', () => {
    const [m] = explainMismatches([mismatch('005930', 34, 0)], []);
    assert.equal(m.explained, false, '8/25 삼성전자가 정확히 이 모양이었다');
  });

  it('한 종목에 매수와 매도가 다 있으면 각각을 상한으로 본다', () => {
    const orders = [
      { symbol: '069500', side: 'buy' as const, quantity: 10 },
      { symbol: '069500', side: 'sell' as const, quantity: 5 },
    ];
    assert.equal(explainMismatches([mismatch('069500', 100, 108)], orders)[0].explained, true);
    assert.equal(explainMismatches([mismatch('069500', 100, 96)], orders)[0].explained, true);
    assert.equal(explainMismatches([mismatch('069500', 100, 94)], orders)[0].explained, false);
  });
});

/*
 * ★★ 매도 주문에 어느 층을 실어 보낼 것인가 (2026-09-02).
 *
 * 집행기가 **매수에만** 층을 요구하고 있었다. 매도는 층 없이 나갔고, 체결이
 * 돌아오면 `resolveFillLayer`가 `skip`을 돌려줘 **장부에 안 들어가고 사람이
 * 손으로 넣어야** 했다. 무인 운영이 목적인데 팔 때마다 사람 손이 필요했다.
 *
 * 판단자에게 적으라고 하지 않는 이유: **매도는 이미 가진 것을 파는 것이라
 * 층이 장부에 있다.** 다시 묻으면 틀릴 여지만 는다.
 */
describe('매도의 층 — 판단자에게 묻지 않고 장부에서 읽는다', () => {
  it('한 층에만 있으면 그 층으로 보낸다', () => {
    assert.deepEqual(
      resolveSellLayer(undefined, ['etf']),
      { kind: 'use', layer: 'etf', from: 'position' },
    );
  });

  it('판단자가 적었고 장부와 같으면 그대로 쓴다', () => {
    assert.deepEqual(
      resolveSellLayer('bet', ['bet']),
      { kind: 'use', layer: 'bet', from: 'decision' },
    );
  });

  it('★ 판단자와 장부가 어긋나면 내지 않는다 — 둘 중 하나가 틀렸다', () => {
    const d = resolveSellLayer('bet', ['etf']);
    assert.equal(d.kind, 'block');
    assert.match(d.kind === 'block' ? d.why : '', /장부/);
  });

  it('★★ 두 층에 걸쳐 있으면 짐작하지 않고 막는다', () => {
    const d = resolveSellLayer(undefined, ['etf', 'short']);
    assert.equal(d.kind, 'block');
    assert.match(d.kind === 'block' ? d.why : '', /layer/, '무엇을 해야 하는지 말해야 한다');
  });

  it('두 층에 걸쳐 있어도 판단자가 그중 하나를 골랐으면 따른다', () => {
    assert.deepEqual(
      resolveSellLayer('short', ['etf', 'short']),
      { kind: 'use', layer: 'short', from: 'decision' },
    );
  });

  it('장부가 모르는 물량은 층 없이 낸다 — 판단자가 적었어도 믿지 않는다', () => {
    const d = resolveSellLayer('etf', []);
    assert.equal(d.kind, 'none', '없는 수량을 빼면 음수 포지션이 된다');
  });
});

/*
 * ★ 체결일 도장 (2026-08-22). `traded_at`이 **기록한 시각**이라 하루 늦게 메우면
 *   "언제 판 자리인가"가 거짓이 됐다 — 8/21 티에스이 손절이 8/22로 적혔다.
 */
describe('체결일 도장 — 기록한 날이 아니라 판 날', () => {
  it('YYYYMMDD를 그날 장 마감 시각으로 바꾼다', () => {
    assert.equal(tradeStampFor('20260821'), '2026-08-21 15:30:00+09');
  });

  it('★ 자정이 아니라 15:30이다 — 시간대 변환에서 하루가 밀릴 여지를 없앤다', () => {
    assert.match(tradeStampFor('20260821') ?? '', /15:30:00\+09$/);
  });

  it('형식이 아니면 null — 부르는 쪽이 now()로 적는다', () => {
    for (const bad of [undefined, '', '2026-08-21', '2026082', '오늘']) {
      assert.equal(tradeStampFor(bad), null, `입력 ${String(bad)}`);
    }
  });

  it('있을 수 없는 달·일은 적지 않는다 — DB가 던지느니 now()가 낫다', () => {
    assert.equal(tradeStampFor('20261301'), null);
    assert.equal(tradeStampFor('20260800'), null);
  });
});
