/**
 * 백테스트.
 *
 * "어느 전략이 좋은가"에 답하는 유일한 방법은 재보는 것이다. 여기서 중요한 건
 * 숫자를 크게 만드는 게 아니라 **부풀리지 않는 것**이라, 다음 세 가지를 지킨다.
 *
 * 1. 미래를 보지 않는다. 봉 i의 신호는 봉 i의 종가가 아니라 **봉 i+1의 시가**로
 *    체결한다. 신호를 만든 그 봉의 종가로 체결하면 이미 결과를 알고 사는 셈이라
 *    성과가 실제보다 좋게 나온다.
 * 2. 거래비용을 뺀다. 수수료와 세금은 짧은 보유 기간에서 성과를 좌우한다.
 *    비용을 빼지 않은 백테스트는 대부분 흑자로 나온다.
 * 3. 구간을 나눠 잰다(in-sample / out-of-sample). 앞 구간에서 잘 나온 전략이
 *    뒤 구간에서도 되는지 봐야 한다. 전체를 한 번에 재면 우연히 맞은 것과
 *    실제로 되는 것을 구별할 수 없다.
 *
 * 그래도 백테스트는 과거일 뿐이다. 여기서 좋았다고 앞으로도 된다는 뜻이 아니다.
 */

import { KR_SELL_TAX_RATE, type Candle, type Instrument } from '@invest/shared';

import { getStrategy, type StrategyContext } from './strategy.js';

export interface BacktestCosts {
  /** 매수·매도 각각에 붙는 위탁수수료 비율 (0.00015 = 0.015%) */
  commissionRate: number;
  /** 매도에만 붙는 증권거래세 비율 */
  sellTaxRate: number;
  /**
   * 체결이 원하는 값보다 불리하게 되는 정도(슬리피지) 비율.
   * 시장가로 내면 호가 한 칸 정도는 밀린다고 보는 게 안전하다.
   */
  slippageRate: number;
}

/*
 * 기본값은 "대략 이 정도"일 뿐이다. 증권사·계좌 유형마다 다르고 세율도 바뀌므로
 * 실제로 쓰기 전에 본인 조건으로 바꿔야 한다. 비용을 낮게 잡으면 백테스트가
 * 그만큼 후하게 나온다.
 */
export const DEFAULT_COSTS: BacktestCosts = {
  commissionRate: 0.00015,
  sellTaxRate: KR_SELL_TAX_RATE,
  slippageRate: 0.001,
};

export interface BacktestTrade {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  /** 비용까지 뺀 손익 */
  netPnl: number;
  returnRate: number;
}

export interface BacktestResult {
  strategy: string;
  label: string;
  /** 재기 시작한 시점의 현금 */
  startCash: number;
  endEquity: number;
  returnRate: number;
  trades: BacktestTrade[];
  tradeCount: number;
  winCount: number;
  winRate: number;
  /** 최대 낙폭. 고점 대비 얼마나 내려갔는지 */
  maxDrawdown: number;
  /** 비용으로 나간 총액. 이게 수익보다 크면 전략이 아니라 수수료를 낸 것이다 */
  totalCost: number;
  /*
   * 구간이 끝난 시점에 아직 들고 있던 수량. 0이 아니면 수익률에 팔지 않은
   * 평가이익이 섞여 있다는 뜻이다. 이걸 안 보여주면 "매매 0회인데 수익률 38.99%"
   * 같은 줄이 나와 읽는 사람이 버그로 오해한다 — 실제로 그렇게 나왔다.
   */
  openQuantity: number;
  openValue: number;
}

export interface BacktestSplit {
  inSample: BacktestResult;
  outOfSample: BacktestResult;
}

/**
 * 한 종목 캔들에 전략을 태워 본다.
 *
 * 러너와 달리 종목을 고르지 않는다 — 전략 자체의 성질을 보려는 것이라
 * 종목 선택이 섞이면 무엇 때문에 좋았는지 알 수 없다.
 */
export function backtest(
  strategyKey: string,
  instrument: Instrument,
  candles: Candle[],
  startCash: number,
  costs: BacktestCosts = DEFAULT_COSTS,
): BacktestResult {
  const strategy = getStrategy(strategyKey);
  if (!strategy) throw new Error(`알 수 없는 전략입니다: ${strategyKey}`);

  let cash = startCash;
  let quantity = 0;
  let entryPrice = 0;
  let entryTime = 0;
  let totalCost = 0;
  let peakEquity = startCash;
  let maxDrawdown = 0;
  const trades: BacktestTrade[] = [];

  /*
   * 마지막 봉에서는 신호를 만들지 않는다. 다음 봉 시가로 체결하는데
   * 그 다음 봉이 없기 때문이다.
   */
  for (let i = 0; i < candles.length - 1; i += 1) {
    const window = candles.slice(0, i + 1);
    const price = window[window.length - 1].close;
    const fill = candles[i + 1].open;
    if (!Number.isFinite(fill) || fill <= 0) continue;

    const context: StrategyContext = {
      candidates: [{ instrument, candles: window, price }],
      positions: quantity > 0 ? [{ instrumentId: instrument.id, quantity, averagePrice: entryPrice }] : [],
      maxPositions: 1,
    };
    const signals = strategy.decide(context);

    for (const signal of signals) {
      if (signal.side === 'buy' && quantity === 0) {
        const buyPrice = fill * (1 + costs.slippageRate);
        const size = Math.floor(cash / (buyPrice * (1 + costs.commissionRate)));
        if (size <= 0) continue;
        const gross = size * buyPrice;
        const fee = gross * costs.commissionRate;
        cash -= gross + fee;
        totalCost += fee;
        quantity = size;
        entryPrice = buyPrice;
        entryTime = candles[i + 1].time;
      } else if (signal.side === 'sell' && quantity > 0) {
        const sellPrice = fill * (1 - costs.slippageRate);
        const gross = quantity * sellPrice;
        const fee = gross * costs.commissionRate + gross * costs.sellTaxRate;
        cash += gross - fee;
        totalCost += fee;
        const netPnl = gross - fee - quantity * entryPrice;
        trades.push({
          entryTime,
          exitTime: candles[i + 1].time,
          entryPrice,
          exitPrice: sellPrice,
          quantity,
          netPnl,
          returnRate: netPnl / (quantity * entryPrice),
        });
        quantity = 0;
        entryPrice = 0;
      }
    }

    const equity = cash + quantity * price;
    peakEquity = Math.max(peakEquity, equity);
    if (peakEquity > 0) maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);
  }

  // 남은 보유는 마지막 종가로 평가만 한다. 팔지 않았으므로 매도 비용은 넣지 않는다.
  const lastClose = candles[candles.length - 1]?.close ?? 0;
  const endEquity = cash + quantity * lastClose;
  const winCount = trades.filter((trade) => trade.netPnl > 0).length;

  return {
    openQuantity: quantity,
    openValue: quantity * lastClose,
    strategy: strategyKey,
    label: strategy.label,
    startCash,
    endEquity,
    returnRate: startCash > 0 ? (endEquity - startCash) / startCash : 0,
    trades,
    tradeCount: trades.length,
    winCount,
    winRate: trades.length > 0 ? winCount / trades.length : 0,
    maxDrawdown,
    totalCost,
  };
}

/**
 * 구간을 이어 붙여 여러 번 잰다 (walk-forward).
 *
 * in/out-of-sample 한 번으로는 그 한 시점의 장세에 맞은 결과인지 알 수 없다.
 * 이 전략들은 학습하는 파라미터가 없으므로 walk-forward는 "같은 규칙을 서로
 * 다른 기간에 걸어 보고 결과가 유지되는지" 보는 것이 된다.
 *
 * 각 구간은 독립이다 — 앞 구간에서 들고 있던 것을 다음으로 넘기지 않는다.
 * 넘기면 구간별 성적이 아니라 누적 성적이 되어, 어느 기간이 좋았는지가 흐려진다.
 */
export function backtestWindows(
  strategyKey: string,
  instrument: Instrument,
  candles: Candle[],
  startCash: number,
  costs: BacktestCosts = DEFAULT_COSTS,
  windowCount = 3,
): BacktestResult[] {
  if (windowCount < 1) return [];
  const size = Math.floor(candles.length / windowCount);
  if (size === 0) return [];

  const results: BacktestResult[] = [];
  for (let i = 0; i < windowCount; i += 1) {
    // 마지막 구간은 나머지를 모두 가져간다. 버리면 최근 데이터가 사라진다.
    const end = i === windowCount - 1 ? candles.length : (i + 1) * size;
    results.push(backtest(strategyKey, instrument, candles.slice(i * size, end), startCash, costs));
  }
  return results;
}

/**
 * 앞뒤로 갈라 잰다.
 *
 * 앞 구간에서만 좋고 뒤 구간에서 무너지면 그 전략은 과거에 맞춘 것이지
 * 시장을 읽은 게 아니다. 두 구간을 함께 봐야 그 차이가 보인다.
 */
export function backtestSplit(
  strategyKey: string,
  instrument: Instrument,
  candles: Candle[],
  startCash: number,
  costs: BacktestCosts = DEFAULT_COSTS,
  inSampleRatio = 0.7,
): BacktestSplit {
  const cut = Math.floor(candles.length * inSampleRatio);
  return {
    inSample: backtest(strategyKey, instrument, candles.slice(0, cut), startCash, costs),
    outOfSample: backtest(strategyKey, instrument, candles.slice(cut), startCash, costs),
  };
}
