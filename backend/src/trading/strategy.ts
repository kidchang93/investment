/**
 * 자동매매 전략.
 *
 * 전략은 "무엇을 살지/팔지"만 정한다. 낼 수 있는 주문인지(잔고·한도·장 시간)는
 * 전부 러너와 리스크 룰이 판단한다. 전략이 안전장치를 아는 순간 두 곳에서 같은
 * 판단을 하게 되고, 한쪽만 고치면 조용히 어긋난다.
 *
 * 새 전략은 Strategy를 구현해 STRATEGIES에 등록하면 된다.
 */

import type {
  Candle,
  Instrument,
  StrategyListResponse,
  StrategyMeasurement,
  StrategySignal,
} from '@invest/shared';

import { RUNNER_CANDLE_AXIS } from './runCandles.js';

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
  /**
   * 신호를 하나라도 낼 수 있으려면 필요한 최소 캔들 수.
   *
   * 이게 없으면 짧은 구간을 태워 놓고 `매매 0회 · 수익률 0%`를 결과로 읽게
   * 된다. 실제로 그랬다 — KIS 일봉이 100개인데 70/30으로 나누니 뒤 구간이
   * 30봉이라, MA(20) 교차가 나올 자리가 거의 없었다. 전략이 나쁜 게 아니라
   * 잴 수 없는 조건이었는데 "out-of-sample 성적이 나쁘다"로 기록했다.
   */
  minBars: number;
  /**
   * 백테스트로 확인된 것. 화면에 그대로 보여준다.
   *
   * 드롭다운이 세 전략을 동등한 선택지로 늘어놓고 있었다. 하나는 8종목
   * 표본에서 확정으로 잃는데 그 사실이 화면에 없었다. 숫자만 적으면 시간이
   * 지나 어긋나므로 측정 시점과 조건을 함께 적는다.
   *
   * **러너 축(`RUNNER_CANDLE_AXIS`) 측정을 맨 앞에 둔다.** 예전에는 이 자리가
   * 문장 하나(`backtestNote`)였고 전부 일봉으로 잰 값이었는데 러너는 1분봉으로
   * 돈다. 축이 값이 아니라 글 속에만 있어서 화면이 그 차이를 말할 수 없었고,
   * 평균 회귀의 *"승률 70.8%로 셋 중 압도적 1위"*(일봉)가 시작 버튼 옆에 아무
   * 표시 없이 떠 있었다 — 러너 축에서는 19.6%다.
   *
   * 순서는 `strategyMeasurements()`가 강제하고 시험이 못 박는다.
   */
  measurements: StrategyMeasurement[];
  /**
   * `no_edge` — 표본이 충분한데 우위가 없다.
   * `unproven` — 평균이 몇 종목의 큰 수익에 끌려간 것이라 전형적이라하다고 볼 수 없다.
   *
   * 이 판정을 여러 번 고쳤다. 8종목 → 20종목에서 뒤집혔고, 평균만 보다
   * 중앙값을 넣으니 또 바뀌었고, 구간을 셋으로 나눠 보니 또 달랐다.
   * 마지막 것이 특히 중요하다 — 70/30 out-of-sample은 마지막 구간 하나를
   * 보는 것이라, 그 구간이 나빴던 전략이 모든 기간에서 나쁜 것처럼 보였다.
   * 지금 판정은 세 구간 전부를 근거로 한다.
   */
  verdict: 'no_edge' | 'unproven';
  /** 이번 회차에 낼 신호들. 낼 게 없으면 빈 배열 */
  decide(context: StrategyContext): StrategySignal[];
}

/*
 * ── 아래 measurements에 들어가는 값에 대하여 ──────────────────────────────
 *
 * **숫자를 손으로 고치지 않는다** — 판정은 다시 재서 바꾸는 것이지 추정으로
 * 조정하는 게 아니다. 일봉 축은 `npx tsx src/scripts/measureStrategies.ts 50000 40`
 * 으로 다시 잰다. 그 스크립트는 판정을 자동으로 바꾸지 않고 어긋난 것만 알린다.
 *
 * **분봉 축을 다시 재는 제품 스크립트는 아직 없다.** 2026-07-31 값은 스크래치패드
 * 도구로 잰 것이라 여기 적힌 대로 재현하려면 그 도구를 제품으로 옮겨야 한다.
 * 그때까지 이 축의 숫자는 갱신되지 않는다 — `measuredOn`이 그 사실을 말한다.
 *
 * **승률은 매매 한 건 단위, "플러스 N/8"은 종목 단위다.** 다른 지표라 섞어
 * 읽으면 안 된다.
 *
 * 일봉 축 판정문은 한때 두 겹으로 낡아 있었다 — 세율 0.18%로 쟀고(왕복 0.41%),
 * 백테스트가 **거래별 손익에서 매수 수수료를 안 빼** 승률이 후했다(31b6cd2).
 * 둘 다 고친 뒤 2026-07-29에 다시 잰 값이다.
 */

/**
 * 러너 축(1분봉) 측정의 공통 조건. 세 전략을 한 번에 잰 것이라 조건도 하나다.
 *
 * 표본이 얇다는 말을 조건에 함께 박아 둔다. 이 레포는 8종목 → 20종목에서 판정이
 * 뒤집힌 전례가 있어, 이 숫자로 못 박으면 같은 실수를 되풀이한다.
 */
const MINUTE_AXIS_SAMPLE =
  '현금 50,000원 · 가격·유동성·왕복비용 필터를 통과한 앞 8종목 ·'
  + ' 2026-07-27~07-30 4거래일(7,238봉) · 왕복 비용 0.43% 포함.'
  + ' 종목 8·날짜 4는 얇아 못 박을 수 없다 — 이 레포는 8종목에서 20종목으로'
  + ' 늘렸을 때 판정이 뒤집힌 전례가 있다.';

/** 일봉 축 측정의 공통 조건. 러너는 이 축으로 돌지 않는다. */
const DAILY_AXIS_SAMPLE =
  '예수금 50,000원으로 실제 매수 가능한 20종목 · 캔들을 시간순 3구간으로 갈라'
  + ' 잼(3구간이 가장 최근) · 왕복 비용 0.43% 포함(매도 거래세 0.20% · 매수·매도'
  + ' 수수료 각 0.015% · 슬리피지 0.1%).';

/**
 * 세 전략의 분봉 축 성적이 한꺼번에 나쁜 이유. 전략마다 따로 적을 것이 아니라
 * 축의 성질이라 공통으로 붙인다.
 *
 * 왕복 0.43%는 축과 무관하게 똑같이 나가는데 분봉의 값 변화 폭이 훨씬 작다 —
 * 1봉 |Δ| 중앙값이 일봉 1.005%, 분봉 0.105%다. 이 레포 자신의 잣대(비용 ≤ 폭의
 * 50% → 0.860% 필요)를 일봉은 1봉만에 넘기고 분봉은 60봉(약 1시간)이 지나야
 * 겨우 넘긴다.
 */
const MINUTE_AXIS_WHY =
  ' 방향을 못 맞혀서가 아니라 산수다 — 왕복 0.43%는 축과 무관하게 똑같이 나가는데'
  + ' 분봉 1봉의 값 변화 중앙값은 0.105%다(일봉은 1.005%).';

/**
 * 축을 붙이고 **러너 축을 맨 앞에 둔다.**
 *
 * 전략마다 배열을 손으로 쓰면 축을 잘못 적거나 순서가 어긋난다. 그게 이번에 고친
 * 결함의 뿌리라 — 축이 값으로 없어서 아무도 못 봤다 — 자리를 함수가 정한다.
 * `RUNNER_CANDLE_AXIS`가 바뀌면 여기서 순서도 따라 바뀐다.
 */
function strategyMeasurements(
  minute: Omit<StrategyMeasurement, 'axis'>,
  daily: Omit<StrategyMeasurement, 'axis'>,
): StrategyMeasurement[] {
  const measured: StrategyMeasurement[] = [
    { axis: 'minute', ...minute },
    { axis: 'daily', ...daily },
  ];
  return [
    ...measured.filter((item) => item.axis === RUNNER_CANDLE_AXIS),
    ...measured.filter((item) => item.axis !== RUNNER_CANDLE_AXIS),
  ];
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
  readonly verdict = 'unproven' as const;
  readonly measurements = strategyMeasurements(
    {
      measuredOn: '2026-07-31',
      sample: MINUTE_AXIS_SAMPLE,
      result:
        '매매 242회 · 승률 11.6% · 종목 수익률 중앙값 -11.97% · 플러스 0/8종목 ·'
        + ' 비용이 원금의 4.97%(중앙값) · 보유 중앙값 12분.'
        + ' 매수→매도 사이 값 변화가 왕복 비용에 못 미친 매매가 88.4%다.'
        + MINUTE_AXIS_WHY,
    },
    {
      measuredOn: '2026-07-29',
      sample: DAILY_AXIS_SAMPLE,
      result:
        '구간별 중앙값 -3.87% / +0.02% / -3.75%, 플러스 종목 6 / 10 / 8개로'
        + ' 세 구간 모두 절반을 못 넘겼다. 승률은 23.3%(172회 중 40회)로 셋 중'
        + ' 가장 낮은데 중앙값은 변동성 돌파보다 낫다 — 드물게 이기고 그때 크게'
        + ' 버는 추세추종의 모양이다. 그래서 승률만 보고 버리면 안 되고, 반대로'
        + ' 몇 번의 큰 이익에 기대는 만큼 구간을 잘못 만나면 오래 잃는다.'
        + ' 매매는 백테스트 1회당 2.9회로 잦지 않아 비용은 원금의 0.58%였다.',
    },
  );

  constructor(
    private readonly shortPeriod = 5,
    private readonly longPeriod = 20,
  ) {}

  /** 직전 봉과 비교해야 교차를 알 수 있으므로 장기선 기간 + 1. */
  get minBars(): number {
    return this.longPeriod + 1;
  }

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
  readonly verdict = 'no_edge' as const;
  readonly measurements = strategyMeasurements(
    {
      measuredOn: '2026-07-31',
      sample: MINUTE_AXIS_SAMPLE,
      result:
        '매매 1,059회 · 승률 6.4% · 종목 수익률 중앙값 -35.12% · 플러스 0/8종목 ·'
        + ' 비용이 원금의 22.79%(중앙값) · 보유 중앙값 1분.'
        + ' 매수→매도 사이 값 변화가 왕복 비용에 못 미친 매매가 93.6%이고 그'
        + ' 값 변화의 중앙값은 0.000%다 — 동전 던지기에 0.43%를 내고 있다.'
        + MINUTE_AXIS_WHY,
    },
    {
      measuredOn: '2026-07-29',
      sample: DAILY_AXIS_SAMPLE,
      result:
        '구간별 중앙값 -4.85% / -2.78% / -9.39%로 세 구간 모두 마이너스이고'
        + ' 가장 최근 구간이 가장 나쁘다. 플러스 종목도 4 → 5 → 2개로 줄었다.'
        + ' 비용이 무겁다 — 백테스트 1회당 매매 13.4회로 셋 중 다섯 배 가까이'
        + ' 잦고, 비용이 원금의 2.60%다(나머지 둘은 0.6%). 승률 34.5%(803회 중'
        + ' 277회)로 자주 지는데 매매까지 잦아 비용이 두 번 깎는다.'
        + ' 소액 계좌에서 거래가 잦은 전략은 수수료·세금이 성과를 깎는 폭이 크다.',
    },
  );

  constructor(
    private readonly k = 0.5,
    private readonly lookback = 20,
  ) {}

  /** 기준선을 만들려면 직전 lookback개 봉 + 이번 봉. */
  get minBars(): number {
    return this.lookback + 1;
  }

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
  readonly verdict = 'unproven' as const;
  readonly measurements = strategyMeasurements(
    {
      measuredOn: '2026-07-31',
      sample: MINUTE_AXIS_SAMPLE,
      result:
        '매매 209회 · 승률 19.6% · 종목 수익률 중앙값 -10.00% · 플러스 1/8종목 ·'
        + ' 비용이 원금의 5.44%(중앙값) · 보유 중앙값 12분.'
        + ' 매수→매도 사이 값 변화가 왕복 비용에 못 미친 매매가 80.4%다.'
        + ' 일봉 축의 승률 70.8%가 이 축에서 19.6%로 내려앉는다 —'
        + ' 승률이 높다는 말은 축을 빼고는 성립하지 않는다.'
        + MINUTE_AXIS_WHY,
    },
    {
      measuredOn: '2026-07-29',
      sample: DAILY_AXIS_SAMPLE,
      result:
        '구간별 중앙값 +4.70% / +1.30% / -0.60%, 플러스 종목 13 / 12 / 7개로'
        + ' 최근으로 올수록 나빠진다. 승률은 70.8%(168회 중 119회)로 이 축에서는'
        + ' 셋 중 가장 높은데 가장 최근 구간 중앙값은 -0.60%다 — 이기는 횟수는'
        + ' 많고 지는 크기가 크다. 승률만 보고 고르면 안 되는 전형적인 모양이고,'
        + ' 세율을 고치고 매수 수수료까지 제대로 뺀 뒤에도 이 모양은 그대로였다'
        + '(직전 측정에서도 승률 65.71%에 중앙값 -1.30%였다).',
    },
  );

  constructor(
    private readonly period = 20,
    private readonly entryZ = -1.5,
    private readonly exitZ = 0,
  ) {}

  get minBars(): number {
    return this.period;
  }

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

/**
 * 화면에 내보낼 전략 목록.
 *
 * **러너가 도는 축을 함께 준다.** 화면은 판정문이 그 축에서 잰 것인지 스스로
 * 판단할 수 없다 — 판정의 주인은 서버다. 프론트가 `'minute'`을 박아 두면 러너가
 * 축을 바꿨을 때 화면만 조용히 틀린 말을 하게 된다.
 */
export function listStrategies(): StrategyListResponse {
  return {
    runnerAxis: RUNNER_CANDLE_AXIS,
    strategies: [...STRATEGIES.values()].map((strategy) => ({
      key: strategy.key,
      label: strategy.label,
      measurements: strategy.measurements,
      verdict: strategy.verdict,
    })),
  };
}
