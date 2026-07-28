/**
 * 기간별 매매손익 "성적" 두 칸의 경계 검증.
 *
 * **실계좌에 확정 매도가 한 건도 없어 값이 있는 쪽을 화면으로 태울 수 없었다**
 * (계좌 21·23 모두 1년 구간에서 rows 0건). 그래서 여기에 못 박는다.
 *
 * 고친 것: KIS는 판 것이 없어도 `tot_rlzt_pfls`·`tot_pftrt`를 둘 다 `0`으로
 * 내려준다. 그대로 그리면 화면이 `손익률 0.00%`라고 적는데, 분모가 없는 값이라
 * "본전이었다"로 읽힌다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  settledProfitRate,
  settledRealized,
  type BrokerTradeProfitRow,
  type BrokerTradeProfitSnapshot,
} from '@invest/shared';

/** 확정 매도 한 줄. 값은 이 시험에서 쓰지 않으니 최소만 채운다. */
function row(): BrokerTradeProfitRow {
  return {
    id: '20260728-005930-0',
    tradeDate: '20260728',
    symbol: '005930',
    name: '삼성전자',
    tradeTypeLabel: '현금매도',
    sellQuantity: 1,
    sellPrice: 70_000,
    sellAmount: 70_000,
    buyQuantity: 1,
    buyPrice: 68_000,
    buyAmount: 68_000,
    realizedProfit: 1_700,
    profitRate: 2.5,
    fee: 10,
    tax: 140,
    loanInterest: 0,
    currency: 'KRW',
  };
}

function snapshot(overrides: Partial<BrokerTradeProfitSnapshot> = {}): BrokerTradeProfitSnapshot {
  return {
    broker: 'kis',
    configured: true,
    accountId: '21',
    from: '20260728',
    to: '20260728',
    rows: [],
    totalRealizedProfit: 0,
    totalProfitRate: 0,
    totalFee: 0,
    totalTax: 0,
    totalTradeAmount: 0,
    ...overrides,
  };
}

describe('settledRealized / settledProfitRate — 확정이 0건일 때', () => {
  it('KIS가 0을 줘도 숫자를 내주지 않는다', () => {
    // 실측한 응답 그대로다 — rows 0건에 합계가 전부 0으로 내려온다.
    const empty = snapshot();
    assert.equal(settledRealized(empty), undefined);
    assert.equal(settledProfitRate(empty), undefined);
  });

  it('0이 아닌 합계가 붙어 와도 확정이 없으면 안 믿는다', () => {
    // 합계만 있고 행이 없는 응답은 근거를 댈 수 없다. 숫자를 내주면
    // 화면이 무엇으로 그 값이 나왔는지 못 보여준 채 성적을 적게 된다.
    const odd = snapshot({ totalRealizedProfit: 5_000, totalProfitRate: 3.2 });
    assert.equal(settledRealized(odd), undefined);
    assert.equal(settledProfitRate(odd), undefined);
  });
});

describe('settledRealized / settledProfitRate — 확정이 있을 때', () => {
  it('합계를 그대로 통과시킨다', () => {
    const filled = snapshot({ rows: [row()], totalRealizedProfit: 1_550, totalProfitRate: 2.28 });
    assert.equal(settledRealized(filled), 1_550);
    assert.equal(settledProfitRate(filled), 2.28);
  });

  it('진짜 본전이면 0을 내준다', () => {
    // 여기서는 `0`이 "잴 것이 없다"가 아니라 "재 보니 0"이다. 판 것이 있으니
    // 0원·0.00%라고 적는 게 맞다. 두 경우를 가르는 것이 이 함수의 전부다.
    const breakeven = snapshot({ rows: [row()], totalRealizedProfit: 0, totalProfitRate: 0 });
    assert.equal(settledRealized(breakeven), 0);
    assert.equal(settledProfitRate(breakeven), 0);
  });

  it('브로커가 합계를 안 준 것과 확정이 없는 것을 겸하지 않는다', () => {
    // 둘 다 undefined로 보이지만 사유가 다르다. 이 함수는 "확정 없음"만
    // 책임지고, 값이 아예 안 온 것은 그대로 흘려보낸다.
    const missing = snapshot({ rows: [row()], totalRealizedProfit: undefined, totalProfitRate: undefined });
    assert.equal(settledRealized(missing), undefined);
    assert.equal(settledProfitRate(missing), undefined);
  });
});
