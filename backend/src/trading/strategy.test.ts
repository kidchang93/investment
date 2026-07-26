/**
 * 전략 판단 테스트.
 *
 * 자동매매가 무엇을 사고 파는지 정하는 곳이라 눈으로만 보고 넘기지 않는다.
 * 캔들을 직접 만들어 교차가 "일어난 그 봉"에서만 신호가 나는지 확인한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Candle, Instrument } from '@invest/shared';

import { MovingAverageCrossStrategy, movingAverage } from './strategy.js';

const strategy = new MovingAverageCrossStrategy(3, 5);

function candles(closes: number[]): Candle[] {
  return closes.map((close, index) => ({
    time: index,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000,
  }));
}

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

function context(closes: number[], positions: StrategyPositions = []) {
  const list = candles(closes);
  return {
    candidates: [{ instrument, candles: list, price: list[list.length - 1].close }],
    positions,
    maxPositions: 1,
  };
}

type StrategyPositions = Array<{ instrumentId: string; quantity: number; averagePrice: number }>;

describe('movingAverage', () => {
  it('기간보다 캔들이 적으면 undefined', () => {
    assert.equal(movingAverage(candles([1, 2]), 5), undefined);
  });

  it('마지막 n개의 평균', () => {
    assert.equal(movingAverage(candles([1, 2, 3, 10, 20]), 2), 15);
  });
});

describe('이동평균 교차 전략', () => {
  it('골든크로스가 일어난 봉에서 매수 신호', () => {
    // 계속 내려가다 마지막에 급등해 단기선이 장기선을 넘어선다.
    const signals = strategy.decide(context([20, 18, 16, 14, 12, 10, 40]));
    assert.equal(signals.length, 1);
    assert.equal(signals[0].side, 'buy');
    assert.equal(signals[0].instrumentId, instrument.id);
  });

  it('이미 교차한 뒤 계속 위에 있기만 하면 신호를 내지 않는다', () => {
    // 쭉 오르는 중 — 단기선이 장기선 위지만 이번 봉에서 뚫은 것은 아니다.
    const signals = strategy.decide(context([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    assert.deepEqual(signals, []);
  });

  it('보유 중 데드크로스가 나면 매도 신호', () => {
    const positions: StrategyPositions = [
      { instrumentId: instrument.id, quantity: 1, averagePrice: 100 },
    ];
    const signals = strategy.decide(context([10, 12, 14, 16, 18, 20, 1], positions));
    assert.equal(signals.length, 1);
    assert.equal(signals[0].side, 'sell');
  });

  it('이미 들고 있으면 다시 사지 않는다', () => {
    const positions: StrategyPositions = [
      { instrumentId: instrument.id, quantity: 1, averagePrice: 100 },
    ];
    const signals = strategy.decide(context([20, 18, 16, 14, 12, 10, 40], positions));
    assert.deepEqual(signals, []);
  });

  it('캔들이 장기선 기간보다 적으면 아무 신호도 내지 않는다', () => {
    assert.deepEqual(strategy.decide(context([1, 2, 3])), []);
  });

  it('maxPositions를 넘겨 사지 않는다', () => {
    const rise = [20, 18, 16, 14, 12, 10, 40];
    const second: Instrument = { ...instrument, id: 'KR:KOSPI:000002', symbol: '000002' };
    const list = candles(rise);
    const signals = strategy.decide({
      candidates: [
        { instrument, candles: list, price: 40 },
        { instrument: second, candles: list, price: 40 },
      ],
      positions: [],
      maxPositions: 1,
    });
    assert.equal(signals.length, 1);
  });
});
