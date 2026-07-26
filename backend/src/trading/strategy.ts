/**
 * 자동매매 전략.
 *
 * 전략은 "무엇을 살지/팔지"만 정한다. 낼 수 있는 주문인지(잔고·한도·장 시간)는
 * 전부 러너와 리스크 룰이 판단한다. 전략이 안전장치를 아는 순간 두 곳에서 같은
 * 판단을 하게 되고, 한쪽만 고치면 조용히 어긋난다.
 *
 * 새 전략은 Strategy를 구현해 STRATEGIES에 등록하면 된다.
 */

import type { Candle, Instrument, StrategySignal } from '@invest/shared';

/** 전략이 판단에 쓰는 재료. 러너가 채워서 넘긴다. */
export interface StrategyContext {
  /** 후보 종목. 이미 "살 수 있는 것"만 걸러져 있다 */
  candidates: Array<{ instrument: Instrument; candles: Candle[]; price: number }>;
  /** 지금 들고 있는 종목 */
  positions: Array<{ instrumentId: string; quantity: number; averagePrice: number }>;
  /** 동시에 들고 갈 수 있는 종목 수 */
  maxPositions: number;
}

export interface Strategy {
  key: string;
  label: string;
  /** 이번 회차에 낼 신호들. 낼 게 없으면 빈 배열 */
  decide(context: StrategyContext): StrategySignal[];
}

/** 단순 이동평균. 캔들이 모자라면 undefined. */
export function movingAverage(candles: Candle[], period: number): number | undefined {
  if (candles.length < period) return undefined;
  const slice = candles.slice(-period);
  return slice.reduce((total, candle) => total + candle.close, 0) / period;
}

/**
 * 이동평균 교차.
 *
 * 단기선이 장기선을 아래에서 위로 뚫은 그 순간에만 사고, 위에서 아래로 뚫으면
 * 전량 판다. "지금 단기선이 위에 있다"가 아니라 "직전 봉에서는 아래였는데 이번
 * 봉에서 위가 됐다"를 본다. 그렇지 않으면 이미 오른 뒤에도 계속 매수 신호가 난다.
 */
export class MovingAverageCrossStrategy implements Strategy {
  readonly key = 'ma_cross';
  readonly label = '이동평균 교차';

  constructor(
    private readonly shortPeriod = 5,
    private readonly longPeriod = 20,
  ) {}

  decide(context: StrategyContext): StrategySignal[] {
    const signals: StrategySignal[] = [];
    const heldIds = new Set(context.positions.map((position) => position.instrumentId));

    // 먼저 매도. 자리를 비워야 새로 살 수 있다.
    for (const position of context.positions) {
      const candidate = context.candidates.find((item) => item.instrument.id === position.instrumentId);
      if (!candidate) continue;
      const cross = this.crossOf(candidate.candles);
      if (cross === 'dead') {
        signals.push({
          instrumentId: position.instrumentId,
          side: 'sell',
          reason: `MA${this.shortPeriod}가 MA${this.longPeriod}를 아래로 뚫음`,
        });
        heldIds.delete(position.instrumentId);
      }
    }

    const room = context.maxPositions - heldIds.size;
    if (room <= 0) return signals;

    /*
     * 골든크로스가 여러 종목에서 동시에 나면 어느 것부터 살지 정해야 한다.
     * 교차 폭(단기선이 장기선보다 얼마나 위인지)이 큰 쪽을 앞에 둔다 —
     * 추세가 더 뚜렷하다는 뜻이다.
     */
    const buys = context.candidates
      .filter((item) => !heldIds.has(item.instrument.id) && this.crossOf(item.candles) === 'golden')
      .map((item) => ({ item, strength: this.crossStrength(item.candles) }))
      .sort((a, b) => b.strength - a.strength)
      .slice(0, room);

    for (const { item, strength } of buys) {
      signals.push({
        instrumentId: item.instrument.id,
        side: 'buy',
        reason: `MA${this.shortPeriod}가 MA${this.longPeriod}를 위로 뚫음 (괴리 ${(strength * 100).toFixed(2)}%)`,
      });
    }
    return signals;
  }

  /** 직전 봉 대비 이번 봉에서 교차가 일어났는지. */
  private crossOf(candles: Candle[]): 'golden' | 'dead' | null {
    if (candles.length < this.longPeriod + 1) return null;
    const previous = candles.slice(0, -1);
    const shortNow = movingAverage(candles, this.shortPeriod);
    const longNow = movingAverage(candles, this.longPeriod);
    const shortPrev = movingAverage(previous, this.shortPeriod);
    const longPrev = movingAverage(previous, this.longPeriod);
    if (
      shortNow === undefined ||
      longNow === undefined ||
      shortPrev === undefined ||
      longPrev === undefined
    ) {
      return null;
    }
    if (shortPrev <= longPrev && shortNow > longNow) return 'golden';
    if (shortPrev >= longPrev && shortNow < longNow) return 'dead';
    return null;
  }

  /** 단기선이 장기선보다 얼마나 위인지. 비율이라 종목 가격대와 무관하게 비교된다. */
  private crossStrength(candles: Candle[]): number {
    const shortNow = movingAverage(candles, this.shortPeriod);
    const longNow = movingAverage(candles, this.longPeriod);
    if (shortNow === undefined || longNow === undefined || longNow === 0) return 0;
    return (shortNow - longNow) / longNow;
  }
}


/** 표준편차. 모집단 기준이면 충분하다 — 봉 개수가 고정이라 표본 보정이 의미 없다. */
function stdev(values: number[], mean: number): number {
  if (values.length === 0) return 0;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * 변동성 돌파.
 *
 * 오늘 시가에 직전 봉들의 변동폭 x k를 더한 값을 넘어서면 산다. 추세를 따라가는
 * 쪽이라 거래가 잦지 않고, 그만큼 수수료 부담이 덜하다. 짧은 보유 기간에서는
 * 거래비용이 성과를 좌우하므로 이 점이 중요하다.
 *
 * 파는 조건은 러너가 아니라 여기서 정한다 — 돌파가 무너지면(기준선 아래로 내려오면)
 * 나온다. 보유를 다음 날로 넘기지 않으려면 러너 쪽에서 장 마감 청산을 걸면 된다.
 */
export class VolatilityBreakoutStrategy implements Strategy {
  readonly key = 'volatility_breakout';
  readonly label = '변동성 돌파';

  constructor(
    private readonly k = 0.5,
    private readonly lookback = 20,
  ) {}

  decide(context: StrategyContext): StrategySignal[] {
    const signals: StrategySignal[] = [];
    const heldIds = new Set(context.positions.map((position) => position.instrumentId));

    for (const position of context.positions) {
      const candidate = context.candidates.find((item) => item.instrument.id === position.instrumentId);
      if (!candidate) continue;
      const target = this.targetPrice(candidate.candles);
      if (target !== undefined && candidate.price < target) {
        signals.push({
          instrumentId: position.instrumentId,
          side: 'sell',
          reason: `돌파 기준선(${Math.round(target).toLocaleString()}원) 아래로 내려옴`,
        });
        heldIds.delete(position.instrumentId);
      }
    }

    const room = context.maxPositions - heldIds.size;
    if (room <= 0) return signals;

    const buys = context.candidates
      .filter((item) => !heldIds.has(item.instrument.id))
      .map((item) => ({ item, target: this.targetPrice(item.candles) }))
      .filter((entry): entry is { item: (typeof context.candidates)[number]; target: number } => {
        return entry.target !== undefined && entry.item.price >= entry.target;
      })
      // 기준선을 더 크게 넘어선 쪽이 돌파가 뚜렷하다.
      .sort((a, b) => (b.item.price - b.target) / b.target - (a.item.price - a.target) / a.target)
      .slice(0, room);

    for (const { item, target } of buys) {
      signals.push({
        instrumentId: item.instrument.id,
        side: 'buy',
        reason: `돌파 기준선 ${Math.round(target).toLocaleString()}원 상향 돌파`,
      });
    }
    return signals;
  }

  /** 기준선 = 이번 봉 시가 + 직전 lookback개 봉의 평균 변동폭 x k */
  private targetPrice(candles: Candle[]): number | undefined {
    if (candles.length < this.lookback + 1) return undefined;
    const current = candles[candles.length - 1];
    const past = candles.slice(-this.lookback - 1, -1);
    const range = past.reduce((total, candle) => total + (candle.high - candle.low), 0) / past.length;
    if (!Number.isFinite(range) || range <= 0) return undefined;
    return current.open + range * this.k;
  }
}

/**
 * 평균 회귀.
 *
 * 값이 최근 평균에서 아래로 크게 벌어졌을 때 사고, 평균으로 돌아오면 판다.
 * 횡보장에서 유리하지만 거래가 잦아 수수료가 더 든다 — 돌파 전략과 정반대의
 * 성질이라, 어느 쪽이 지금 시장에 맞는지는 백테스트로 재야 한다.
 */
export class MeanReversionStrategy implements Strategy {
  readonly key = 'mean_reversion';
  readonly label = '평균 회귀';

  constructor(
    private readonly period = 20,
    private readonly entryZ = -1.5,
    private readonly exitZ = 0,
  ) {}

  decide(context: StrategyContext): StrategySignal[] {
    const signals: StrategySignal[] = [];
    const heldIds = new Set(context.positions.map((position) => position.instrumentId));

    for (const position of context.positions) {
      const candidate = context.candidates.find((item) => item.instrument.id === position.instrumentId);
      if (!candidate) continue;
      const z = this.zScore(candidate.candles);
      if (z !== undefined && z >= this.exitZ) {
        signals.push({
          instrumentId: position.instrumentId,
          side: 'sell',
          reason: `평균선까지 회복 (z ${z.toFixed(2)})`,
        });
        heldIds.delete(position.instrumentId);
      }
    }

    const room = context.maxPositions - heldIds.size;
    if (room <= 0) return signals;

    const buys = context.candidates
      .filter((item) => !heldIds.has(item.instrument.id))
      .map((item) => ({ item, z: this.zScore(item.candles) }))
      .filter((entry): entry is { item: (typeof context.candidates)[number]; z: number } => {
        return entry.z !== undefined && entry.z <= this.entryZ;
      })
      // 더 많이 벌어진 쪽부터.
      .sort((a, b) => a.z - b.z)
      .slice(0, room);

    for (const { item, z } of buys) {
      signals.push({
        instrumentId: item.instrument.id,
        side: 'buy',
        reason: `평균 대비 ${z.toFixed(2)} 표준편차 아래`,
      });
    }
    return signals;
  }

  private zScore(candles: Candle[]): number | undefined {
    if (candles.length < this.period) return undefined;
    const closes = candles.slice(-this.period).map((candle) => candle.close);
    const mean = closes.reduce((total, value) => total + value, 0) / closes.length;
    const sd = stdev(closes, mean);
    if (sd === 0) return undefined;
    return (closes[closes.length - 1] - mean) / sd;
  }
}

const STRATEGIES = new Map<string, Strategy>([
  ['ma_cross', new MovingAverageCrossStrategy()],
  ['volatility_breakout', new VolatilityBreakoutStrategy()],
  ['mean_reversion', new MeanReversionStrategy()],
]);

export function getStrategy(key: string): Strategy | undefined {
  return STRATEGIES.get(key);
}

export function listStrategies(): Array<{ key: string; label: string }> {
  return [...STRATEGIES.values()].map((strategy) => ({ key: strategy.key, label: strategy.label }));
}
