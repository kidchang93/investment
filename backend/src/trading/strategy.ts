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
  /**
   * 이미 자리를 차지한 종목.
   *
   * **`quantity`가 0일 수 있다.** 매수 주문을 냈는데 아직 잔고에 안 잡힌
   * 종목이다(`pendingBuys.ts`). 자리는 먹지만 **팔 수는 없다** — 없는 주식을
   * 파는 주문이 나가면 KIS가 거부한다. 그래서 매도 후보는 `sellablePositions`로
   * 거르고, 자리 계산(`maxPositions`)은 이 목록 전체로 한다.
   */
  positions: Array<{ instrumentId: string; quantity: number; averagePrice: number }>;
  /** 동시에 들고 갈 수 있는 종목 수 */
  maxPositions: number;
}

/**
 * 팔 수 있는 것만. **수량 0은 매도 후보가 아니다.**
 *
 * 세 전략이 각자 `context.positions`를 돌며 매도를 판단하는데, 그 목록에
 * 미체결 매수가 섞이면서 "아직 없는 주식"에 매도 신호가 날 수 있게 됐다.
 * 같은 규칙을 세 곳에 두면 한 곳만 고쳤을 때 조용히 갈라지므로 한 함수로 둔다.
 */
export function sellablePositions(context: StrategyContext): StrategyContext['positions'] {
  return context.positions.filter((position) => position.quantity > 0);
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
   * 표시 없이 떠 있었다 — 러너 축에서는 19.00%다.
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
 * 조정하는 게 아니다. 일봉 축은 `npx tsx src/scripts/measureStrategies.ts 50000 200`
 * (현금 · 표본 종목 수)으로 다시 잰다. 그 스크립트는 판정을 자동으로 바꾸지 않고
 * 어긋난 것만 알린다.
 *
 * **두 번째 인자는 표본 종목 수다. 예전에는 시세 조회 횟수였다.** 그때는 종목코드
 * 오름차순 앞쪽만 봤기 때문에 그 둘이 같은 말이었는데, 지금은 표집틀 전체를 훑고
 * 거래대금 층에서 뽑는다 — 자세한 것은 `scripts/measureStrategies.ts` 머리말.
 *
 분봉 축은 `scripts/collectMinuteCandles.ts`(받는다) →
 * `scripts/measureStrategiesIntraday.ts`(잰다) 두 단계로 다시 잰다.
 *
 * **표본을 이어 붙여 백테스트하려면 `contiguous`로 받아야 한다.** 기본값
 * `spread`는 구간 전체에 날을 흩뿌리는데, 그건 분포를 재는 데 맞고 이어 붙이면
 * 날 사이 갭이 왕복 비용의 몇 배가 된다 — 2026-08-01에 그걸로 한 번 틀렸다.
 *
 * **승률은 매매 한 건 단위, "플러스 N/15"는 종목 단위다.** 다른 지표라 섞어
 * 읽으면 안 된다. 그리고 **그 승률에는 청산된 매매만 들어간다** — 구간이 끝날 때
 * 들고 있던 표본은 분모에도 분자에도 없다(`BacktestResult.winRate` 주석).
 *
 * 일봉 축 판정문은 세 겹으로 낡았던 적이 있다.
 *   1. 세율 0.18%로 쟀다(왕복 0.41%)
 *   2. 백테스트가 **거래별 손익에서 매수 수수료를 안 빼** 승률이 후했다(31b6cd2)
 *   3. **표본이 종목코드 오름차순 앞쪽 20종목이었다** — 시장을 대표하지 않는다
 * 1·2는 2026-07-29에, 3은 2026-08-01에 고치고 다시 쟀다.
 */

/**
 * 러너 축(1분봉) 측정의 공통 조건. 세 전략을 한 번에 잰 것이라 조건도 하나다.
 *
 * **표본을 8종목 × 4거래일 → 20종목 × 15거래일로 늘려도 판정이 안 뒤집혔다.**
 * 이 레포는 8 → 20종목에서 뒤집힌 전례가 있어 경계해 왔는데 이번엔 그대로였다.
 *
 * ★ 이 값은 2026-08-01 저녁에 **두 결함을 고치고 다시 잰 것**이다.
 *
 *   1. 현금 50,000원으로 1주도 못 사는 종목 5개가 매매 0건 → 수익률 0.00%로
 *      중앙값에 섞여 있었다. 전부 마이너스인 분포에서 0은 맨 위라 중앙값을
 *      끌어올린다. 게다가 러너 자신의 필터가 거르는 종목이다
 *   2. 날을 3개월에 흩뿌려 받은 표본을 이어 붙여 백테스트하고 있었다. 날 사이
 *      간격이 중앙값 7일이라 그 갭이 왕복 비용의 7.7배였다
 *
 * 고치기 전 값은 -10.95% / -24.68% / -13.25%였다. **실제보다 1.4~1.9배 좋게
 * 적혀 있었다.** 연속 표본으로 다시 재도 크게 나아지지 않았다 — 갭을 없애도
 * 비용이 남기 때문이다(비용이 손실의 73~87%).
 */
const MINUTE_AXIS_SAMPLE =
  '현금 50,000원 · 스크리닝과 같은 순서의 앞 20종목 중 그 현금으로 실제 살 수 있는'
  + ' 15종목 · 2026-07-10~07-31 연속 15거래일 · 일봉 고가·저가와 대조해 통과한'
  + ' 240종목·날(49,284봉) · 왕복 비용 0.43% 포함.'
  + ' 표본을 8종목 4거래일에서 여기까지 늘리는 동안 판정은 한 번도 뒤집히지 않았다.';

/**
 * 일봉 축 측정의 공통 조건. 러너는 이 축으로 돌지 않는다.
 *
 * ★ 2026-08-01에 **표본을 다시 골라** 잰 값이다. 그전까지는 종목코드 오름차순
 * 앞 60종목을 훑어 통과한 20종목으로 쟀다 — DB 조회가 검색어가 없으면
 * `ORDER BY symbol`이라, `000020 동화약품`으로 시작하는 앞쪽만 보고 있었다.
 * 시장을 대표하지 않는 표본이다.
 *
 * 같은 날 같은 절차로 두 표본을 나란히 재서 크기를 확인했다. 갈리는 것은 오직
 * "누구를 쟀나"다 — 가장 최근 구간이 세 전략 모두에서 더 나쁘다.
 *
 *   이동평균 교차  앞 35종목 -4.20%  →  거래대금 5층 195종목 -6.35%
 *   변동성 돌파    앞 35종목 -7.79%  →  거래대금 5층 195종목 -7.92%
 *   평균 회귀      앞 35종목 -2.89%  →  거래대금 5층 195종목 -5.33% (승률 72.5% → 67.4%)
 */
const DAILY_AXIS_SAMPLE =
  '현금 50,000원 · 국내 활성 종목 4,032개를 전부 훑어(멀티시세 135회) 러너와 같은'
  + ' 필터를 통과한 2,694종목을 거래대금 내림차순 5층으로 나누고 층마다 등간격으로'
  + ' 40종목씩 뽑은 200종목(일봉 350봉을 받은 195종목) · 캔들을 시간순 3구간으로'
  + ' 갈라 잼(3구간이 가장 최근) · 왕복 비용 0.43% 포함(매도 거래세 0.20% · 매수·매도'
  + ' 수수료 각 0.015% · 슬리피지 0.1%).'
  + ' 층의 기준을 거래대금으로 잡은 것은 그것이 러너 자신이 보는 축이라서다 —'
  + ' 유동성 문턱도, 체결 비용이 갈리는 축도 거래대금이다.';

/**
 * 일봉 축 세 전략에 공통으로 붙는 단서. 승률을 읽는 사람이 반드시 알아야 한다.
 *
 * `backtest()`의 `trades[]`에는 **청산된 매매만** 들어간다. 구간이 끝날 때 아직
 * 들고 있던 포지션은 승률의 분모에도 분자에도 없다. 이번 표본에서 그것이
 * 576~578개 중 107~252개다 — 적은 수가 아니다.
 */
const DAILY_AXIS_WIN_RATE_CAVEAT =
  ' 승률은 판 매매만의 값이다 — 구간이 끝날 때 들고 있던 표본의 손익은 이 승률에'
  + ' 들어 있지 않다.';

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
  + ' 분봉 1봉의 값 변화 중앙값은 0.105%다(일봉은 1.005%).'
  + ' 다만 비용만의 문제도 아니다: 비용을 전부 0으로 놓고 다시 재도 중앙값이 0 이하이고'
  + ' 플러스는 5~8/20종목이다. 이 축에서 세 전략은 동전 던지기에 가깝다.';

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
      measuredOn: '2026-08-01',
      sample: MINUTE_AXIS_SAMPLE,
      result:
        '매매 1,125회 · 승률 12.27% · 종목 수익률 중앙값 -18.53% · 플러스 0/15종목 ·'
        + ' 비용이 원금의 6.12%(중앙값) · 보유 중앙값 14분.'
        + ' 매수→매도 사이 값 변화가 왕복 비용에 못 미친 매매가 51.4%다.'
        + ' 15종목 전부에서 잃었다.'
        + MINUTE_AXIS_WHY,
    },
    {
      measuredOn: '2026-08-01',
      sample: DAILY_AXIS_SAMPLE,
      result:
        '구간별 중앙값 -0.52% / -1.28% / -6.35%, 플러스 종목 78/191 · 78/190 · 37/195로'
        + ' 세 구간 모두 절반을 못 넘겼고 가장 최근 구간이 가장 나쁘다. 승률은'
        + ' 26.0%(1,702회 중 443회)로 셋 중 가장 낮은데 중앙값은 변동성 돌파보다 낫다 —'
        + ' 드물게 이기고 그때 크게 버는 추세추종의 모양이다. 그래서 승률만 보고 버리면'
        + ' 안 되고, 반대로 몇 번의 큰 이익에 기대는 만큼 구간을 잘못 만나면 오래 잃는다.'
        + ' 매매는 백테스트 1회당 3.0회로 잦지 않아 비용은 원금의 0.60%였다.'
        + ' 표본 585종목·구간 중 9개를 뺐고(봉 부족 2 · 현금으로 1주도 못 삼 7),'
        + ' 남은 576개 중 매매가 한 건도 없던 것이 52개, 들고 끝난 것이 225개다.'
        + DAILY_AXIS_WIN_RATE_CAVEAT,
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
    for (const position of sellablePositions(context)) {
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
      measuredOn: '2026-08-01',
      sample: MINUTE_AXIS_SAMPLE,
      result:
        '매매 3,378회 · 승률 5.68% · 종목 수익률 중앙값 -36.86% · 플러스 0/15종목 ·'
        + ' 비용이 원금의 26.34%(중앙값) · 보유 중앙값 1분.'
        + ' 매수→매도 사이 값 변화가 왕복 비용에 못 미친 매매가 82.6%다 —'
        + ' 15종목 전부에서 잃었고, 매매가 셋 중 가장 잦아 비용이 두 번 깎는다.'
        + MINUTE_AXIS_WHY,
    },
    {
      measuredOn: '2026-08-01',
      sample: DAILY_AXIS_SAMPLE,
      result:
        '구간별 중앙값 -3.11% / -3.70% / -7.92%로 세 구간 모두 마이너스이고'
        + ' 가장 최근 구간이 가장 나쁘다. 플러스 종목도 67/191 → 60/190 → 44/195로 줄었다.'
        + ' 비용이 무겁다 — 백테스트 1회당 매매 14.1회로 셋 중 다섯 배 가까이'
        + ' 잦고, 비용이 원금의 2.87%다(나머지 둘은 0.6%). 승률 36.8%(8,101회 중'
        + ' 2,983회)로 자주 지는데 매매까지 잦아 비용이 두 번 깎는다.'
        + ' 소액 계좌에서 거래가 잦은 전략은 수수료·세금이 성과를 깎는 폭이 크다.'
        + ' 표본 585종목·구간 중 9개를 뺐고(봉 부족 2 · 현금으로 1주도 못 삼 7),'
        + ' 남은 576개 중 매매가 한 건도 없던 것이 19개, 들고 끝난 것이 107개다.'
        + DAILY_AXIS_WIN_RATE_CAVEAT,
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

    for (const position of sellablePositions(context)) {
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
      measuredOn: '2026-08-01',
      sample: MINUTE_AXIS_SAMPLE,
      result:
        '매매 984회 · 승률 19.00% · 종목 수익률 중앙값 -14.08% · 플러스 1/15종목 ·'
        + ' 비용이 원금의 6.78%(중앙값) · 보유 중앙값 12분.'
        + ' 매수→매도 사이 값 변화가 왕복 비용에 못 미친 매매가 68.8%다.'
        + ' 일봉 축의 승률 67.4%가 이 축에서 19.00%로 내려앉는다 —'
        + ' 승률이 높다는 말은 축을 빼고는 성립하지 않는다.'
        + MINUTE_AXIS_WHY,
    },
    {
      measuredOn: '2026-08-01',
      sample: DAILY_AXIS_SAMPLE,
      result:
        '구간별 중앙값 +2.91% / +1.70% / -5.33%, 플러스 종목 116/192 · 111/191 · 64/195로'
        + ' 최근으로 올수록 나빠진다. 승률은 67.4%(1,517회 중 1,022회)로 이 축에서는'
        + ' 셋 중 가장 높은데 가장 최근 구간 중앙값은 -5.33%다 — 이기는 횟수는'
        + ' 많고 지는 크기가 크다. 승률만 보고 고르면 안 되는 전형적인 모양이고,'
        + ' 표본을 시장이 대표되게 다시 고른 뒤에도 이 모양은 그대로였다'
        + '(종목코드 앞쪽 35종목으로 재면 같은 날 -2.89%에 승률 72.5%로 나온다).'
        + ' 표본 585종목·구간 중 7개를 뺐고(현금으로 1주도 못 삼 7),'
        + ' 남은 578개 중 매매가 한 건도 없던 것이 36개, 들고 끝난 것이 252개다 —'
        + ' 이 전략은 회복해야 파는 규칙이라 들고 끝난 표본이 특히 많다.'
        + DAILY_AXIS_WIN_RATE_CAVEAT,
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

    for (const position of sellablePositions(context)) {
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
