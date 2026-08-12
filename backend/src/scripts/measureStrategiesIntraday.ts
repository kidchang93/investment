/**
 * 전략을 **러너가 실제로 도는 축(1분봉)에서** 잰다.
 *
 * ── 왜 따로 있나 ─────────────────────────────────────────────────────────
 *
 * `measureStrategies.ts`는 **일봉 350개**로 돈다. 그런데 자동매매 러너는
 * **1분봉**을 전략에 넣는다(`RUNNER_CANDLE_AXIS`). 같은 전략도 축이 다르면
 * 판정이 뒤집힌다 — 2026-07-31 측정에서 평균 회귀 승률이 일봉 68.5%, 분봉
 * 19.6%였다. 왕복 비용 0.43%는 축과 무관하게 똑같이 나가는데 분봉 1봉의 값
 * 변화 중앙값은 0.105%뿐이라서다(일봉 1.005%).
 *
 * 그 측정을 스크래치패드 도구로 해서 다시 잴 수 없었다. 이 스크립트가 그
 * 자리를 메운다 — **분봉 축 판정문을 갱신하는 유일한 제품 경로**다.
 *
 * ── 무엇을 재나 ──────────────────────────────────────────────────────────
 *
 * `collectMinuteCandles.ts`가 받아 둔 원자료만 읽는다. KIS를 부르지 않는다.
 * 종목마다 날짜순으로 분봉을 이어 붙이고 세 전략을 각각 태운다.
 *
 * ── 러너와 다른 점 (결과를 읽을 때 반드시 함께 본다) ─────────────────────
 *
 * 1. **러너는 60초마다 깨어나고 여기서는 모든 봉을 본다.** 봉이 촘촘하면 러너가
 *    놓치는 교차가 생긴다 — 실제 매매는 이보다 적을 것이다.
 * 2. **러너는 마지막 120봉만 본다. 여기서는 창이 누적된다.** 세 전략 모두 마지막
 *    20~21봉만 쓰므로 신호는 같아야 하지만, 같은지는 재지 않았다.
 * 3. **러너에는 일일 주문 한도 20건이 있다.** 분봉 축 매매 빈도는 종목 하나로도
 *    그것을 넘긴다 — 즉 여기서 세는 매매를 러너는 다 낼 수 없다.
 * 4. **밤을 넘기는 매매가 섞인다.** 세 전략 모두 청산이 신호 반전뿐이고 장 마감
 *    청산이 없어서, 이어 붙이면 15:30 → 다음 개장의 갭이 한 봉으로 들어간다.
 *    러너도 실제로 포지션을 넘기므로 이어 붙이는 쪽이 러너에 가깝지만, 갭이
 *    결과를 얼마나 흔드는지 알 수 있게 **밤을 넘긴 매매 수를 따로 센다.**
 *
 * **판정을 자동으로 고치지 않는다.** 코드에 적힌 값과 나란히 찍고 어긋난 것만
 * 알린다 — `measureStrategies.ts`와 같은 규약이다.
 *
 *   npx tsx src/scripts/measureStrategiesIntraday.ts [원자료.jsonl]
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { CANDLE_AXIS_LABELS, type Candle, type Instrument } from '@invest/shared';

import { DEFAULT_COSTS, backtest, roundTripCostRate } from '../trading/backtest.js';
import {
  countExcluded,
  countMeasured,
  describeSampleTally,
  emptySampleTally,
  sampleExclusion,
} from '../trading/measurementSample.js';
import { RUNNER_CANDLE_AXIS } from '../trading/runCandles.js';
import { quantile } from '../trading/rangeExpansion.js';
import { getStrategy, listStrategies } from '../trading/strategy.js';
import type { CollectSummary, MinuteDayRecord } from './collectMinuteCandles.js';

const IN = process.argv[2] ?? process.env.MINUTE_OUT ?? '/tmp/minute-candles.jsonl';
const OUT = process.env.MEASURE_INTRADAY_OUT ?? '/tmp/strategy-measurement-intraday.json';

/** 원금. 일봉 측정과 같은 값을 쓴다 — 다르면 비용 비율을 견줄 수 없다. */
const START_CASH = Number(process.argv[3] ?? 50_000);

/** `Candle.time`(UTC epoch 초) → KST 달력 날짜 `YYYYMMDD`. */
function kstDateOf(time: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' })
    .format(new Date(time * 1000))
    .replace(/-/g, '');
}

interface Loaded {
  days: MinuteDayRecord[];
  summary: CollectSummary | null;
}

function load(path: string): Loaded {
  const days: MinuteDayRecord[] = [];
  let summary: CollectSummary | null = null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const parsed = JSON.parse(line) as MinuteDayRecord | CollectSummary;
    if (parsed.kind === 'summary') summary = parsed;
    else days.push(parsed);
  }
  return { days, summary };
}

/** 종목 하나의 전 기간 분봉. 날짜순으로 이어 붙인다. */
interface Series {
  instrument: Instrument;
  candles: Candle[];
  dayCount: number;
}

function buildSeries(days: MinuteDayRecord[]): Series[] {
  const byInstrument = new Map<string, MinuteDayRecord[]>();
  for (const day of days) {
    const list = byInstrument.get(day.instrumentId) ?? [];
    list.push(day);
    byInstrument.set(day.instrumentId, list);
  }

  const series: Series[] = [];
  for (const [instrumentId, records] of byInstrument) {
    records.sort((a, b) => a.date.localeCompare(b.date));
    const candles = records.flatMap((record) => record.candles).sort((a, b) => a.time - b.time);
    /*
     * 백테스트에 넘길 `Instrument`. 원자료에 담아 둔 것만 쓴다 — DB를 다시 읽으면
     * 원자료를 받은 뒤 바뀐 값이 섞인다. `backtest()`가 쓰는 것은 id·name뿐이다.
     */
    const first = records[0];
    series.push({
      instrument: {
        id: instrumentId,
        symbol: first.symbol,
        name: first.name,
        market: 'KOSPI',
        country: 'KR',
        currency: 'KRW',
        assetType: 'stock',
        provider: 'kis',
        providerSymbol: first.symbol,
        exchangeCode: 'KRX',
        timezone: 'Asia/Seoul',
      },
      candles,
      dayCount: records.length,
    });
  }
  return series.sort((a, b) => a.instrument.symbol.localeCompare(b.instrument.symbol));
}

function pct(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(2)}%` : '—';
}

async function main(): Promise<void> {
  const { days, summary } = load(IN);
  if (days.length === 0) {
    console.error(`${IN}에 쓸 수 있는 종목·날이 없습니다. 먼저 collectMinuteCandles.ts를 돌리세요.`);
    process.exit(1);
  }

  const series = buildSeries(days);
  const { runnerAxis, strategies } = listStrategies();
  const axisLabel = CANDLE_AXIS_LABELS[RUNNER_CANDLE_AXIS];

  // 왕복 비용은 한 값이 아니다 — ETF는 매도 거래세가 면제라 주식보다 싸다.
  console.log(`축 ${axisLabel} · 원금 ${START_CASH.toLocaleString('ko-KR')}원`
    + ` · 왕복 비용 주식 ${pct(roundTripCostRate(null, DEFAULT_COSTS) * 100)}`
    + ` / ETF ${pct(roundTripCostRate({ assetType: 'etf' }, DEFAULT_COSTS) * 100)}`);
  console.log(
    `표본 ${series.length}종목 · 종목·날 ${days.length}건 · 봉 ${days.reduce((n, d) => n + d.candles.length, 0)}개`
    + (summary ? ` (받은 날 ${summary.dates[0]}~${summary.dates[summary.dates.length - 1]})` : ''),
  );
  if (summary) {
    const dropped = summary.noBarDays + summary.unverifiedDays + summary.mismatchedDays;
    console.log(
      `버린 종목·날 ${dropped}건 (봉 없음 ${summary.noBarDays} · 일봉 없어 검산 못 함 ${summary.unverifiedDays}`
      + ` · 고저 불일치 ${summary.mismatchedDays})`,
    );
  }
  console.log();

  const report = {
    measuredAt: new Date().toISOString(),
    axis: RUNNER_CANDLE_AXIS,
    source: IN,
    startCash: START_CASH,
    instrumentCount: series.length,
    dayRecordCount: days.length,
    collect: summary,
    strategies: [] as Array<Record<string, unknown>>,
  };

  for (const strategy of strategies) {
    const returnRates: number[] = [];
    const holdMinutes: number[] = [];
    const costShares: number[] = [];
    let trades = 0;
    let wins = 0;
    let overnightTrades = 0;
    let belowCostTrades = 0;

    /*
     * 무엇을 빼고 무엇을 셌는지. 판정은 `trading/measurementSample.ts`가 한다 —
     * 일봉 측정기와 **같은 규칙**이어야 두 축의 숫자를 견줄 수 있고, 시험도
     * 거기 한 곳에 붙는다. 예전에는 이 계산이 두 스크립트에 각각 인라인으로
     * 있어서 분봉 쪽만 고쳐졌다.
     *
     * 신호를 낼 수 없는 표본은 성적이 아니라 잴 수 없는 조건이다. 섞으면
     * `매매 0회 · 수익률 0%`가 결과로 읽힌다 — 이 레포가 실제로 겪은 실수라
     * `Strategy.minBars`가 생겼다. 그런데 `backtest()`도 러너도 이 값을 읽지
     * 않으므로(`docs/USER_FINDINGS.md`) 재는 쪽에서 본다.
     */
    const tally = emptySampleTally();
    const minBars = getStrategy(strategy.key)?.minBars ?? 0;

    for (const item of series) {
      const excluded = sampleExclusion(item.candles, START_CASH, minBars);
      if (excluded) {
        countExcluded(tally, excluded);
        continue;
      }

      const result = backtest(strategy.key, item.instrument, item.candles, START_CASH, DEFAULT_COSTS);
      countMeasured(tally, result);

      returnRates.push(result.returnRate * 100);
      trades += result.tradeCount;
      wins += result.winCount;
      costShares.push((result.totalCost / START_CASH) * 100);

      for (const trade of result.trades) {
        holdMinutes.push((trade.exitTime - trade.entryTime) / 60);
        if (kstDateOf(trade.entryTime) !== kstDateOf(trade.exitTime)) overnightTrades += 1;
        // 매수→매도 값 변화가 왕복 비용에도 못 미친 매매. 방향이 아니라 산수 문제다.
        // 비용은 종목마다 다르다 — ETF는 매도 거래세가 면제라 문턱이 더 낮다.
        const move = Math.abs(trade.exitPrice - trade.entryPrice) / trade.entryPrice;
        if (move < roundTripCostRate(item.instrument, DEFAULT_COSTS)) belowCostTrades += 1;
      }
    }

    const medianReturn = quantile(returnRates, 0.5);
    const positives = returnRates.filter((value) => value > 0).length;
    // 매매가 없으면 승률은 0%가 아니라 **없는 값**이다. 0%라고 적으면 "다 졌다"로 읽힌다.
    const winRate = trades > 0 ? (wins / trades) * 100 : undefined;
    const medianHold = quantile(holdMinutes, 0.5);
    const medianCostShare = quantile(costShares, 0.5);

    const coded = strategy.measurements.find((item) => item.axis === runnerAxis);

    console.log(`${strategy.label} (코드 판정: ${strategy.verdict})`);
    console.log(
      `  매매 ${trades}회 · 승률 ${winRate === undefined ? '—' : pct(winRate)}`
      + ` · 종목 수익률 중앙값 ${pct(medianReturn)}`
      + ` · 플러스 ${positives}/${returnRates.length}종목`,
    );
    console.log(
      `  비용이 원금의 ${pct(medianCostShare)}(중앙값)`
      + ` · 보유 중앙값 ${Number.isFinite(medianHold) ? `${medianHold.toFixed(0)}분` : '—'}`
      + (trades > 0 ? ` · 값 변화가 왕복 비용에 못 미친 매매 ${pct((belowCostTrades / trades) * 100)}` : ''),
    );
    console.log(
      `  밤을 넘긴 매매 ${overnightTrades}회`
      + (trades > 0 ? ` (${pct((overnightTrades / trades) * 100)})` : ''),
    );
    /*
     * 표본에서 뺀 것과 0%로 남은 것을 **반드시 적는다.** 안 보이면 중앙값이 무엇의
     * 중앙값인지 알 수 없다 — 실제로 이것 때문에 판정문이 1.4~1.9배 좋게 적혔다.
     */
    console.log(`  ${describeSampleTally(tally, '종목')}`);
    if (tally.openEnded > 0) {
      console.log('  승률은 청산된 매매만의 값이다 — 위 미청산 표본의 매매는 분모에도 분자에도 없다.');
    }
    if (coded) {
      console.log(`  코드(${coded.measuredOn} 측정): ${coded.result}`);
    } else {
      console.log(`  ⚠ 코드에 ${axisLabel} 측정이 없습니다.`);
    }

    /*
     * 판정을 고치지 않고 어긋난 사실만 알린다. 사람이 보고 정한다.
     *
     * **이 축의 결과로 `verdict`를 바로 뒤집지 않는다.** `verdict`는 일봉 축에서
     * 정한 것이고 두 축은 아직 하나로 맞춰지지 않았다. 여기서 말할 수 있는 것은
     * "러너가 도는 축에서는 이렇다"까지다.
     */
    const allNegative = returnRates.length > 0 && medianReturn < 0 && positives === 0;
    if (allNegative && strategy.verdict !== 'no_edge') {
      console.log(
        `  ⚠ ${axisLabel} 축에서는 플러스 종목이 없습니다 (코드 판정은 ${strategy.verdict},`
        + ` 일봉 축에서 정한 값). 축을 하나로 맞추기 전에는 판정을 바꾸지 않습니다.`,
      );
    }
    console.log();

    report.strategies.push({
      key: strategy.key,
      label: strategy.label,
      codeVerdict: strategy.verdict,
      codedMeasuredOn: coded?.measuredOn ?? null,
      tradeCount: trades,
      winCount: wins,
      winRate: winRate === undefined ? null : Number(winRate.toFixed(2)),
      medianReturnRate: Number(medianReturn.toFixed(2)),
      positiveCount: positives,
      measuredCount: returnRates.length,
      medianHoldMinutes: Number.isFinite(medianHold) ? Number(medianHold.toFixed(1)) : null,
      medianCostShare: Number(medianCostShare.toFixed(2)),
      overnightTrades,
      belowCostTrades,
      sample: tally,
    });
  }

  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`결과를 ${OUT}에 남겼습니다. **판정은 자동으로 고치지 않습니다.**`);
  console.log(
    '이 숫자를 `strategy.ts`의 분봉 축 measurement에 옮길 때는 표본(종목 수·날짜 폭)도 함께 고칩니다 —'
    + ' 조건 없는 숫자는 시간이 지나면 조용히 틀린 값이 됩니다.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
