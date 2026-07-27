/**
 * 낸 신호를 나중에 채점한다.
 *
 * 백테스트는 과거만 말한다. "지금 이 전략이 되는가"는 실제로 낸 신호를 며칠
 * 뒤 가격과 견줘 봐야 안다. 주문이 나갔는지와는 별개다 — 모의 실행 신호도
 * 채점한다. 그래야 게이트를 열기 전에 성적을 쌓을 수 있다.
 *
 * **비용을 뺀 값을 함께 낸다.** 왕복 0.41%(수수료 2회 + 거래세 + 슬리피지 2회)를
 * 빼지 않으면 이겼다고 착각한다. 변동성 돌파가 승률 27%에 원금의 29.6%를
 * 비용으로 쓴 것을 백테스트에서 봤다.
 */

import { getInstrument } from '../db/instruments.js';
import {
  getBuySignalsToScore,
  getScoredKeys,
  recordSignalScore,
  type PendingSignal,
} from '../db/signalScores.js';
import { getDailyCandleHistory, getInstrumentCandles } from '../kis/rest.js';
import { DEFAULT_COSTS } from './backtest.js';

/**
 * 채점 기간(거래일).
 *
 * 하나로만 재면 전략마다 다른 보유 기간을 하나의 잣대로 판정하게 된다.
 * 이동평균 교차를 하루 성적으로 재는 건 그 전략을 재는 게 아니다.
 */
export const SCORE_HORIZONS = [1, 5, 20] as const;

/** 사고팔 때 드는 비용을 합친 비율. 백테스트·후보 거르기와 같은 값을 쓴다. */
const ROUND_TRIP_COST_RATE =
  DEFAULT_COSTS.commissionRate * 2 + DEFAULT_COSTS.sellTaxRate + DEFAULT_COSTS.slippageRate * 2;

export interface ScoreRunResult {
  scanned: number;
  scored: number;
  /** 아직 기간이 안 찬 신호. 다음에 다시 본다 */
  tooEarly: number;
  /** 가격을 못 구한 신호 */
  unresolved: number;
}

/**
 * 신호 시각의 다음 거래일부터 세어 n번째 거래일 종가.
 *
 * 달력 날짜로 세면 주말·공휴일에 걸려 틀린다. 실제로 온 일봉만 센다.
 * 아직 그만큼 지나지 않았으면 undefined — 억지로 가장 최근 값을 쓰면
 * 기간이 짧은 신호가 유리해진다.
 */
export function exitCloseAfter(
  candles: Array<{ time: number; close: number }>,
  signalAtSeconds: number,
  horizonDays: number,
): number | undefined {
  const after = candles.filter((candle) => candle.time > signalAtSeconds).sort((a, b) => a.time - b.time);
  if (after.length < horizonDays) return undefined;
  return after[horizonDays - 1].close;
}

export async function scoreAccountSignals(accountId: string): Promise<ScoreRunResult> {
  const signals = await getBuySignalsToScore(accountId);
  const scored = await getScoredKeys(accountId);
  const result: ScoreRunResult = { scanned: signals.length, scored: 0, tooEarly: 0, unresolved: 0 };

  // 같은 종목이 여러 번 신호를 냈으면 일봉은 한 번만 받는다.
  const candlesByInstrument = new Map<string, Array<{ time: number; close: number }>>();

  for (const signal of signals) {
    const pending = SCORE_HORIZONS.filter((h) => !scored.has(`${signal.runId}:${h}`));
    if (pending.length === 0) continue;

    let candles = candlesByInstrument.get(signal.instrumentId);
    if (!candles) {
      candles = await loadCandles(signal);
      candlesByInstrument.set(signal.instrumentId, candles);
    }
    if (candles.length === 0) {
      result.unresolved += pending.length;
      continue;
    }

    const signalSeconds = Math.floor(signal.signalAt.getTime() / 1000);
    for (const horizon of pending) {
      const exitPrice = exitCloseAfter(candles, signalSeconds, horizon);
      if (exitPrice === undefined) {
        result.tooEarly += 1;
        continue;
      }
      const grossReturn = ((exitPrice - signal.signalPrice) / signal.signalPrice) * 100;
      const netReturn = grossReturn - ROUND_TRIP_COST_RATE * 100;
      const ok = await recordSignalScore({
        runId: signal.runId,
        accountId: signal.accountId,
        instrumentId: signal.instrumentId,
        signalAt: signal.signalAt,
        signalPrice: signal.signalPrice,
        horizonDays: horizon,
        exitPrice,
        grossReturn: Number(grossReturn.toFixed(4)),
        netReturn: Number(netReturn.toFixed(4)),
      });
      if (ok) result.scored += 1;
    }
  }

  return result;
}

async function loadCandles(signal: PendingSignal): Promise<Array<{ time: number; close: number }>> {
  try {
    const instrument = await getInstrument(signal.instrumentId);
    if (!instrument) return [];
    /*
     * 국내 종목은 페이징으로 길게 받는다. 20거래일 뒤를 보려면 신호 이후
     * 봉이 그만큼 있어야 하는데, 한 번 호출은 100건이 상한이라 오래된 신호는
     * 창 밖으로 밀린다.
     */
    const paged =
      instrument.country === 'KR'
      && (instrument.assetType === 'stock' || instrument.assetType === 'etf' || instrument.assetType === 'etn');
    const response = paged
      ? await getDailyCandleHistory(instrument.providerSymbol, 120)
      : await getInstrumentCandles(instrument);
    return response.candles.map((candle) => ({ time: candle.time, close: candle.close }));
  } catch {
    return [];
  }
}
