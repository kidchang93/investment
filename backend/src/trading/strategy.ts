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

const STRATEGIES = new Map<string, Strategy>([['ma_cross', new MovingAverageCrossStrategy()]]);

export function getStrategy(key: string): Strategy | undefined {
  return STRATEGIES.get(key);
}

export function listStrategies(): Array<{ key: string; label: string }> {
  return [...STRATEGIES.values()].map((strategy) => ({ key: strategy.key, label: strategy.label }));
}
