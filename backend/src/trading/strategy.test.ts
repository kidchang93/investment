/**
 * 전략 판단 테스트.
 *
 * 자동매매가 무엇을 사고 파는지 정하는 곳이라 눈으로만 보고 넘기지 않는다.
 * 캔들을 직접 만들어 교차가 "일어난 그 봉"에서만 신호가 나는지 확인한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Candle, Instrument } from '@invest/shared';

import { RUNNER_CANDLE_AXIS } from './runCandles.js';
import {
  MeanReversionStrategy,
  MovingAverageCrossStrategy,
  VolatilityBreakoutStrategy,
  listStrategies,
  movingAverage,
} from './strategy.js';

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

  /*
   * 미체결 매수는 `quantity: 0`으로 들어온다. 2026-08-03에 이 자리가 비어 있어서
   * 러너가 같은 종목을 네 회차 연속으로 샀다 — 잔고에 잡히기까지 8분이 걸렸다.
   */
  it('주문만 나가 있는 종목(수량 0)은 다시 사지 않는다', () => {
    const positions: StrategyPositions = [
      { instrumentId: instrument.id, quantity: 0, averagePrice: 0 },
    ];
    assert.deepEqual(strategy.decide(context([20, 18, 16, 14, 12, 10, 40], positions)), []);
  });

  /*
   * 자리는 먹되 팔 수는 없어야 한다. 없는 주식을 파는 주문이 나가면 KIS가
   * 거부하고, 그 회차는 매도도 매수도 못 한 채 끝난다.
   */
  it('주문만 나가 있는 종목은 데드크로스가 나도 팔지 않는다', () => {
    const positions: StrategyPositions = [
      { instrumentId: instrument.id, quantity: 0, averagePrice: 0 },
    ];
    assert.deepEqual(strategy.decide(context([10, 12, 14, 16, 18, 20, 1], positions)), []);
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

describe('minBars', () => {
  /*
   * 이 값이 실제 필요 캔들 수와 어긋나면 비교 스크립트가 잴 수 없는 구간을
   * 잴 수 있다고 판단한다. 선언값과 실제 동작을 맞춰 둔다.
   */
  const all = [
    new MovingAverageCrossStrategy(),
    new VolatilityBreakoutStrategy(),
    new MeanReversionStrategy(),
  ];

  it('선언한 최소 캔들 수보다 하나 적으면 어떤 전략도 신호를 내지 않는다', () => {
    for (const item of all) {
      // 크게 오르내리게 채운다 — 캔들만 충분하면 신호가 날 만한 모양이다.
      const closes = Array.from(
        { length: item.minBars - 1 },
        (_, i) => 100 + (i % 2 === 0 ? -15 : 15) + i * 2,
      );
      assert.deepEqual(
        item.decide(context(closes)),
        [],
        `${item.label}: ${item.minBars - 1}봉에서는 신호가 없어야 한다`,
      );
    }
  });

  it('minBars는 양수다', () => {
    for (const item of all) {
      assert.ok(item.minBars > 0, `${item.label}: ${item.minBars}`);
    }
  });
});

/*
 * 화면이 자동매매 시작 버튼 옆에 이 값을 그대로 적는다. 예전에는 판정문이 전부
 * 일봉으로 잰 값이었는데 러너는 1분봉으로 돌았고, 축이 값으로 없어서 화면도
 * 사람도 그 차이를 볼 수 없었다. 평균 회귀의 "승률 70.8%"가 러너 축에서는
 * 19.6%다.
 *
 * 다시 그 상태가 되는 길은 둘이다 — 새 전략을 러너 축 측정 없이 등록하거나,
 * 러너가 축을 바꿨는데 판정문을 그대로 두거나. 둘 다 여기서 걸린다.
 */
describe('전략 판정문의 축', () => {
  const all = [
    new MovingAverageCrossStrategy(),
    new VolatilityBreakoutStrategy(),
    new MeanReversionStrategy(),
  ];

  it('모든 전략이 러너가 도는 축에서 잰 측정을 갖는다', () => {
    for (const item of all) {
      const axes = item.measurements.map((m) => m.axis);
      assert.ok(
        axes.includes(RUNNER_CANDLE_AXIS),
        `${item.label}: 러너는 ${RUNNER_CANDLE_AXIS} 축으로 도는데 그 축의 측정이 없다`
          + ` (있는 축: ${axes.join(', ') || '없음'})`,
      );
    }
  });

  it('러너 축 측정이 맨 앞에 온다 — 화면이 그 순서대로 읽는다', () => {
    for (const item of all) {
      assert.equal(
        item.measurements[0]?.axis,
        RUNNER_CANDLE_AXIS,
        `${item.label}: 맨 앞이 ${item.measurements[0]?.axis}다`,
      );
    }
  });

  it('한 축을 두 번 적지 않는다', () => {
    for (const item of all) {
      const axes = item.measurements.map((m) => m.axis);
      assert.equal(new Set(axes).size, axes.length, `${item.label}: ${axes.join(', ')}`);
    }
  });

  /*
   * 시점과 조건이 빠지면 시간이 지나 조용히 틀린 값이 된다(`docs/CODE_STYLE.md`).
   * 날짜 형식까지 보는 이유는 화면이 그대로 찍기 때문이다.
   */
  it('측정마다 잰 날과 조건이 있다', () => {
    for (const item of all) {
      for (const measurement of item.measurements) {
        assert.match(
          measurement.measuredOn,
          /^\d{4}-\d{2}-\d{2}$/,
          `${item.label}/${measurement.axis}: 잰 날이 YYYY-MM-DD가 아니다`,
        );
        assert.ok(
          measurement.sample.length > 0 && measurement.result.length > 0,
          `${item.label}/${measurement.axis}: 조건이나 결과가 비어 있다`,
        );
      }
    }
  });

  it('목록 응답이 러너 축을 함께 준다 — 프론트가 축을 박아 두지 않게', () => {
    const listed = listStrategies();
    assert.equal(listed.runnerAxis, RUNNER_CANDLE_AXIS);
    assert.equal(listed.strategies.length, all.length);
    for (const strategy of listed.strategies) {
      assert.equal(strategy.measurements[0]?.axis, RUNNER_CANDLE_AXIS, strategy.key);
    }
  });
});

/*
 * 2026-08-04: 퀀트 판정이 "오늘은 새로 사지 마라"였다(거울 검증에서 방향성 우위
 * +0.0019% = 왕복 비용의 1/226). 그때 러너를 통째로 멈추면 데드크로스 청산도
 * 같이 멈춰 **보유 종목이 아무도 안 보는 채로 남는다.**
 *
 * `maxPositions: 0`이 그 자리를 메운다 — 매수만 멈추고 매도는 계속한다.
 */
describe('maxPositions 0 — 매수만 멈춘다', () => {
  it('자리가 0이면 골든크로스가 나도 사지 않는다', () => {
    const list = candles([20, 18, 16, 14, 12, 10, 40]);
    const signals = strategy.decide({
      candidates: [{ instrument, candles: list, price: list[list.length - 1].close }],
      positions: [],
      maxPositions: 0,
    });
    assert.deepEqual(signals, []);
  });

  it('자리가 0이어도 보유 종목의 데드크로스는 판다', () => {
    const list = candles([10, 12, 14, 16, 18, 20, 1]);
    const signals = strategy.decide({
      candidates: [{ instrument, candles: list, price: list[list.length - 1].close }],
      positions: [{ instrumentId: instrument.id, quantity: 1, averagePrice: 100 }],
      maxPositions: 0,
    });
    assert.equal(signals.length, 1);
    assert.equal(signals[0].side, 'sell');
  });
});
