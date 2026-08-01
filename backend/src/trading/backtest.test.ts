/**
 * 백테스트가 스스로 맞는지 확인한다.
 *
 * 측정기가 틀리면 전략 비교 전체가 무의미하다. 특히 두 가지를 못 박아 둔다 —
 * 신호를 만든 봉의 종가가 아니라 다음 봉 시가로 체결하는지, 그리고 거래비용이
 * 실제로 빠지는지. 둘 중 하나만 어긋나도 성과가 실제보다 좋게 나온다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Candle, Instrument } from '@invest/shared';

import {
  DEFAULT_COSTS,
  backtest,
  backtestSplit,
  backtestWindowSlices,
  backtestWindows,
  type BacktestCosts,
} from './backtest.js';

const instrument: Instrument = {
  id: 'KR:KOSPI:000001',
  symbol: '000001',
  name: '테스트종목',
  market: 'KOSPI',
  country: 'KR',
  currency: 'KRW',
  assetType: 'stock',
  provider: 'kis',
  providerSymbol: '000001',
  exchangeCode: 'KRX',
  timezone: 'Asia/Seoul',
};

/** 종가만 주면 시가·고가·저가를 같은 값으로 채운다. 체결가 검증이 단순해진다. */
function flatCandles(closes: number[]): Candle[] {
  return closes.map((close, index) => ({
    time: index,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
  }));
}

const NO_COSTS: BacktestCosts = { commissionRate: 0, sellTaxRate: 0, slippageRate: 0 };

/** 내려가다 급등해 골든크로스, 이후 급락해 데드크로스가 나는 값. */
const ROUND_TRIP = [
  20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10,
  40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
];

describe('백테스트', () => {
  it('캔들이 없으면 매매 없이 원금 그대로', () => {
    const result = backtest('ma_cross', instrument, [], 50_000, NO_COSTS);
    assert.equal(result.endEquity, 50_000);
    assert.equal(result.tradeCount, 0);
    assert.equal(result.returnRate, 0);
  });

  it('신호가 없으면 매매도 없고 원금이 유지된다', () => {
    // 값이 전혀 움직이지 않으면 교차가 일어나지 않는다.
    const result = backtest('ma_cross', instrument, flatCandles(Array(60).fill(100)), 50_000, NO_COSTS);
    assert.equal(result.tradeCount, 0);
    assert.equal(result.endEquity, 50_000);
  });

  it('신호가 난 봉의 종가가 아니라 다음 봉 시가로 체결한다', () => {
    /*
     * 신호가 나는 봉의 종가와 다음 봉 시가를 다르게 만들어, 어느 쪽으로
     * 체결됐는지 값으로 구분한다. 종가로 체결하면 미래를 보고 사는 셈이다.
     */
    const closes = [...ROUND_TRIP];
    const candles = flatCandles(closes);
    const signalBar = 20; // 40으로 급등해 골든크로스가 나는 봉
    candles[signalBar + 1] = { ...candles[signalBar + 1], open: 999 };

    const result = backtest('ma_cross', instrument, candles, 50_000, NO_COSTS);
    assert.ok(result.trades.length > 0, '매매가 한 번은 나와야 한다');
    assert.equal(result.trades[0].entryPrice, 999, '다음 봉 시가로 체결해야 한다');
  });

  it('거래비용이 실제로 빠진다', () => {
    const candles = flatCandles(ROUND_TRIP);
    const free = backtest('ma_cross', instrument, candles, 50_000, NO_COSTS);
    const paid = backtest('ma_cross', instrument, candles, 50_000, DEFAULT_COSTS);
    assert.ok(free.tradeCount > 0);
    assert.ok(paid.totalCost > 0, '비용이 0보다 커야 한다');
    assert.ok(paid.endEquity < free.endEquity, '비용을 뺀 쪽이 더 적어야 한다');
  });

  it('거래별 손익의 합이 실제 현금 변화와 맞는다', () => {
    /*
     * `netPnl`은 "비용까지 뺀 손익"이다. 다 팔고 끝난 백테스트라면 그 합이
     * 실제로 늘거나 준 돈과 같아야 한다.
     *
     * **이게 어긋나 있었다.** 매도 수수료·거래세만 빼고 **매수 수수료를 안
     * 뺐다** — 왕복 1회짜리에서 합계가 7.4982원(= 매수 수수료) 컸다. `cash`는
     * 살 때 제대로 뺐으니 총수익률은 맞았고, 틀린 것은 거래별 손익과 승률이라
     * 눈에 잘 안 띄었다.
     *
     * 위의 승률 시험이 `NO_COSTS`로 도는 바람에 못 잡았다. 여기서는 반드시
     * 비용을 켜고 잰다.
     */
    const result = backtest('ma_cross', instrument, flatCandles(ROUND_TRIP), 50_000, DEFAULT_COSTS);
    assert.ok(result.tradeCount > 0, '매매가 있어야 잴 수 있다');
    assert.equal(result.openQuantity, 0, '다 팔고 끝나야 합이 맞는다');

    const summed = result.trades.reduce((total, trade) => total + trade.netPnl, 0);
    const actual = result.endEquity - result.startCash;
    assert.ok(
      Math.abs(summed - actual) < 1e-6,
      `거래별 손익 합 ${summed} 과 실제 현금 변화 ${actual} 이 다르다`,
    );
  });

  it('비용을 켜면 승률이 공짜일 때보다 높지 않다', () => {
    // 간신히 이긴 매매는 비용을 물리면 진 매매가 된다. 반대는 있을 수 없다.
    const candles = flatCandles(ROUND_TRIP);
    const free = backtest('ma_cross', instrument, candles, 50_000, NO_COSTS);
    const paid = backtest('ma_cross', instrument, candles, 50_000, DEFAULT_COSTS);
    assert.ok(paid.winRate <= free.winRate, `${paid.winRate} > ${free.winRate}`);
  });

  it('한 주도 못 사는 원금이면 매매하지 않는다', () => {
    const result = backtest('ma_cross', instrument, flatCandles(ROUND_TRIP), 10, NO_COSTS);
    assert.equal(result.tradeCount, 0);
  });

  it('승률과 매매 수가 실제 매매와 맞는다', () => {
    const result = backtest('ma_cross', instrument, flatCandles(ROUND_TRIP), 50_000, NO_COSTS);
    assert.equal(result.tradeCount, result.trades.length);
    assert.equal(result.winCount, result.trades.filter((trade) => trade.netPnl > 0).length);
    if (result.tradeCount > 0) {
      assert.equal(result.winRate, result.winCount / result.tradeCount);
    }
  });

  it('구간 끝에 들고 있으면 승률에 안 들어간다 — winRate는 판 것들만의 값이다', () => {
    /*
     * `trades[]`에는 청산된 매매만 들어간다. 이 성질이 조용히 바뀌면 "회복하면
     * 판다"는 전략의 승률이 실제보다 높게 나온다 — 회복 못 한 매매가 통째로
     * 빠지기 때문이다. 비용을 **켜고** 잰다: 켜야 드러나는 것을 끄고 재면 안 된다.
     */
    const openEnd = [...new Array(20).fill(10), 12, 14, 16, 18, 20, 22, 24, 26, 28, 30];
    const result = backtest('ma_cross', instrument, flatCandles(openEnd), 50_000, DEFAULT_COSTS);

    assert.ok(result.openQuantity > 0, '들고 끝나야 이 시험이 성립한다');
    assert.equal(result.tradeCount, 0, '판 것이 없으므로 매매도 0건이다');
    assert.deepEqual(result.trades, []);
    assert.equal(result.winRate, 0, '분모가 0이면 0 — 「다 졌다」가 아니라 「판 게 없다」다');
    assert.ok(result.returnRate > 0, '수익률에는 미청산 평가액이 들어간다. 승률과 다른 것을 센다');
  });

  it('최대 낙폭은 0 이상 1 이하', () => {
    const result = backtest('ma_cross', instrument, flatCandles(ROUND_TRIP), 50_000, DEFAULT_COSTS);
    assert.ok(result.maxDrawdown >= 0 && result.maxDrawdown <= 1, String(result.maxDrawdown));
  });

  it('구간을 나누면 두 결과가 따로 나온다', () => {
    const split = backtestSplit('ma_cross', instrument, flatCandles(ROUND_TRIP), 50_000, NO_COSTS, 0.7);
    assert.equal(split.inSample.startCash, 50_000);
    assert.equal(split.outOfSample.startCash, 50_000);
  });

  it('없는 전략은 거부한다', () => {
    assert.throws(() => backtest('없는전략', instrument, flatCandles([1, 2, 3]), 1000));
  });
});

describe('walk-forward 구간 나누기', () => {
  /*
   * 구간을 잘못 나누면 성적이 아니라 나눈 방식을 재게 된다. 데이터가 빠지거나
   * 겹치지 않는지, 마지막 구간이 나머지를 가져가는지를 못 박아 둔다.
   */
  it('구간 수만큼 결과가 나온다', () => {
    const result = backtestWindows('ma_cross', instrument, flatCandles(ROUND_TRIP), 50_000, NO_COSTS, 3);
    assert.equal(result.length, 3);
  });

  it('나눈 구간이 원본을 빠짐없이 덮고 겹치지 않는다', () => {
    /*
     * 예전에는 이 시험이 경계를 **직접 다시 계산해** 비교했다. 같은 식을 두 번
     * 쓴 것이라 함수가 바뀌어도 안 걸린다. 이제 함수가 자른 것을 그대로 본다.
     */
    const candles = flatCandles(Array.from({ length: 100 }, (_, index) => index + 1));
    for (const count of [1, 2, 3, 4, 7]) {
      const slices = backtestWindowSlices(candles, count);
      assert.equal(slices.length, count, `${count}구간: 구간 수`);
      assert.deepEqual(slices.flat(), candles, `${count}구간: 이어 붙이면 원본`);
    }
  });

  it('자른 구간과 잰 구간이 같다 — 재는 쪽이 구간마다 표본을 판정할 수 있어야 한다', () => {
    const candles = flatCandles(ROUND_TRIP);
    const slices = backtestWindowSlices(candles, 3);
    const windows = backtestWindows('ma_cross', instrument, candles, 50_000, NO_COSTS, 3);
    assert.equal(slices.length, windows.length);
    slices.forEach((slice, index) => {
      const alone = backtest('ma_cross', instrument, slice, 50_000, NO_COSTS);
      assert.equal(alone.endEquity, windows[index].endEquity, `${index + 1}구간 자산`);
      assert.equal(alone.tradeCount, windows[index].tradeCount, `${index + 1}구간 매매 수`);
    });
  });

  it('구간 수가 1이면 전체를 한 번 잰 것과 같다', () => {
    const candles = flatCandles(ROUND_TRIP);
    const whole = backtest('ma_cross', instrument, candles, 50_000, NO_COSTS);
    const [only] = backtestWindows('ma_cross', instrument, candles, 50_000, NO_COSTS, 1);
    assert.equal(only.endEquity, whole.endEquity);
    assert.equal(only.tradeCount, whole.tradeCount);
  });

  it('구간마다 원금이 새로 시작한다', () => {
    // 앞 구간 손익이 다음으로 넘어가면 구간별 성적이 아니라 누적이 된다.
    const result = backtestWindows('ma_cross', instrument, flatCandles(ROUND_TRIP), 50_000, NO_COSTS, 3);
    for (const window of result) assert.equal(window.startCash, 50_000);
  });

  it('구간 수가 0 이하면 빈 배열', () => {
    assert.deepEqual(backtestWindows('ma_cross', instrument, flatCandles(ROUND_TRIP), 50_000, NO_COSTS, 0), []);
  });
});
