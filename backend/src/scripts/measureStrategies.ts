/**
 * 주기 재측정 — 실제 매수 가능 유니버스를 스스로 골라 전략을 다시 잰다.
 *
 * 지금까지는 종목코드를 손으로 넘겨야 했다(`compareStrategies.ts`). 그래서
 * 판정을 낼 때마다 "어느 종목으로 쟀나"가 사람 손에 달렸고, 실제로 한 번
 * 틀렸다 — 이 계좌로 살 수 없는 대형주 20종목으로 재고 있었다.
 *
 * 유니버스를 코드가 고르면 그 실수가 안 난다. 가격·유동성·왕복비용 필터를
 * 그대로 태워 나온 종목으로만 잰다.
 *
 * **판정을 자동으로 고치지 않는다.** 결과를 파일에 남기고, 코드에 적힌 판정과
 * 어긋나면 그 사실만 알린다. 이유:
 *   1. 판정 글에는 숫자만으로 안 나오는 맥락이 들어 있다("승률은 높은데
 *      수익률은 마이너스 — 이기는 횟수는 많고 지는 크기가 크다").
 *   2. 한 주 숫자가 흔들렸다고 no_edge가 조용히 unproven이 되면, 그게 바로
 *      과거에 맞추는 일이다.
 * 재는 것은 자동으로, 판단은 사람이 한다.
 *
 *   npx tsx src/scripts/measureStrategies.ts [현금] [조회수]
 */

import { writeFileSync } from 'node:fs';

import type { Instrument } from '@invest/shared';

import { getCategoryInstruments, getInstrument } from '../db/instruments.js';
import { getDailyCandleHistory, getInstrumentQuote } from '../kis/rest.js';
import { DEFAULT_COSTS, backtestWindows } from '../trading/backtest.js';
import { listStrategies } from '../trading/strategy.js';
import { screenQuote, sessionElapsedRatio } from '../trading/universe.js';

const OUT = process.env.MEASURE_OUT ?? '/tmp/strategy-measurement.json';
const WINDOW_COUNT = 3;
const TARGET_BARS = 350;
const GAP_MS = 150;

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function pickUniverse(cash: number, lookups: number): Promise<Instrument[]> {
  const pools = await Promise.all(
    ['kr-all', 'kr-etf'].map((category) => getCategoryInstruments(category, 300).catch(() => [])),
  );
  const pool: Instrument[] = [];
  const seen = new Set<string>();
  for (let index = 0; pool.length < lookups * 3; index += 1) {
    let added = false;
    for (const list of pools) {
      const item = list[index];
      if (!item || item.country !== 'KR' || seen.has(item.id)) continue;
      if (item.assetType !== 'stock' && item.assetType !== 'etf' && item.assetType !== 'etn') continue;
      seen.add(item.id);
      pool.push(item);
      added = true;
    }
    if (!added) break;
  }

  const elapsed = sessionElapsedRatio();
  const passed: Instrument[] = [];
  for (const instrument of pool.slice(0, lookups)) {
    try {
      const quote = await getInstrumentQuote(instrument);
      if (quote.price > 0 && quote.price <= cash && screenQuote(quote, elapsed) === null) {
        passed.push(instrument);
      }
    } catch {
      // 개별 실패는 건너뛴다.
    }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  return passed;
}

async function main(): Promise<void> {
  const cash = Number(process.argv[2] ?? 49_751);
  const lookups = Number(process.argv[3] ?? 60);

  const universe = await pickUniverse(cash, lookups);
  console.log(`유니버스 ${universe.length}종목 (가격·유동성·왕복비용 필터 통과) · 현금 ${cash.toLocaleString('ko-KR')}원\n`);
  if (universe.length === 0) {
    console.log('잴 종목이 없습니다. 필터 문턱이나 예수금을 확인하세요.');
    return;
  }

  // 전략별 · 구간별 종목 수익률
  const byStrategy = new Map<string, number[][]>();
  const tradeCounts = new Map<string, number>();
  const costTotals = new Map<string, number>();
  /*
   * 이긴 매매 수. 승률을 수익률과 **함께** 내기 위해 센다.
   *
   * 이걸 안 세는 바람에 판정문의 "승률은 높은데 수익률은 마이너스 — 이기는
   * 횟수는 많고 지는 크기가 크다"를 다시 잴 수 없었다. 그 문장이 이 전략에서
   * 가장 중요한 관찰인데 갱신할 근거가 없어 그대로 두거나 지워야 했다.
   *
   * **종목 단위 "플러스 N/20"과 다른 지표다.** 이건 매매 한 건 단위다 — 섞어
   * 쓰면 "승률 65%"와 "플러스 7/20"이 같은 말인 줄 알게 된다.
   */
  const winCounts = new Map<string, number>();
  const { strategies } = listStrategies();
  for (const strategy of strategies) {
    byStrategy.set(strategy.key, Array.from({ length: WINDOW_COUNT }, () => []));
    tradeCounts.set(strategy.key, 0);
    costTotals.set(strategy.key, 0);
    winCounts.set(strategy.key, 0);
  }

  let measured = 0;
  for (const instrument of universe) {
    let candles;
    try {
      const response = await getDailyCandleHistory(instrument.providerSymbol, TARGET_BARS);
      candles = response.candles;
    } catch {
      continue;
    }
    if (candles.length < 60) continue;
    measured += 1;

    const resolved = (await getInstrument(instrument.id)) ?? instrument;
    for (const strategy of strategies) {
      const windows = backtestWindows(strategy.key, resolved, candles, cash, DEFAULT_COSTS, WINDOW_COUNT);
      windows.forEach((window, index) => {
        byStrategy.get(strategy.key)?.[index]?.push(window.returnRate * 100);
        tradeCounts.set(strategy.key, (tradeCounts.get(strategy.key) ?? 0) + window.tradeCount);
        costTotals.set(strategy.key, (costTotals.get(strategy.key) ?? 0) + window.totalCost);
        winCounts.set(strategy.key, (winCounts.get(strategy.key) ?? 0) + window.winCount);
      });
    }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }

  console.log(`잰 종목 ${measured}개 · 구간 ${WINDOW_COUNT}개\n`);
  const report = {
    measuredAt: new Date().toISOString(),
    cash,
    universeSize: universe.length,
    measuredCount: measured,
    windowCount: WINDOW_COUNT,
    strategies: [] as Array<Record<string, unknown>>,
  };

  for (const strategy of strategies) {
    const windows = byStrategy.get(strategy.key) ?? [];
    const medians = windows.map((values) => median(values));
    const positives = windows.map((values) => values.filter((v) => v > 0).length);
    const trades = tradeCounts.get(strategy.key) ?? 0;
    const cost = costTotals.get(strategy.key) ?? 0;
    const wins = winCounts.get(strategy.key) ?? 0;
    const allNegative = medians.every((m) => Number.isFinite(m) && m < 0);

    console.log(`${strategy.label} (코드 판정: ${strategy.verdict})`);
    medians.forEach((m, index) => {
      console.log(
        `  ${index + 1}구간 중앙값 ${m.toFixed(2).padStart(7)}%`
        + ` · 플러스 ${positives[index]}/${windows[index].length}종목`,
      );
    });
    /*
     * 비용 합계는 (종목 × 구간)번의 독립 백테스트를 더한 값이다. 각 백테스트가
     * 원금 전액으로 따로 시작하므로, 투입 원금도 그만큼 곱해야 비율이 맞는다.
     * cost / cash로 적었더니 변동성 돌파가 `원금 대비 146.3%`로 나왔다 —
     * 60배 부풀린 값이었다. 한 번의 매매 주기가 원금의 몇 %를 쓰는지가 알고
     * 싶은 값이므로 백테스트 1회 기준으로 나눈다.
     */
    const runCount = measured * WINDOW_COUNT;
    const costShare = runCount > 0 ? (cost / (runCount * cash)) * 100 : 0;
    /*
     * 매매가 없으면 승률은 0%가 아니라 **없는 값**이다. 분모가 0인데 0%라고
     * 적으면 "다 졌다"로 읽힌다.
     */
    const winRate = trades > 0 ? (wins / trades) * 100 : undefined;
    console.log(
      `  매매 ${trades}회(백테스트 1회당 ${(trades / Math.max(1, runCount)).toFixed(1)}회)`
      + ` · 승률 ${winRate === undefined ? '—' : `${winRate.toFixed(1)}%`}`
      + ` · 비용 합계 ${Math.round(cost).toLocaleString('ko-KR')}원`
      + ` · 백테스트 1회 원금 대비 ${costShare.toFixed(2)}%`,
    );

    /*
     * 판정을 고치지 않고 어긋난 사실만 알린다. 사람이 보고 정한다.
     */
    const suggests = allNegative ? 'no_edge' : 'unproven';
    if (suggests !== strategy.verdict) {
      console.log(`  ⚠ 이번 측정은 ${suggests}에 가깝습니다 (코드에는 ${strategy.verdict}). 사람이 확인하세요.`);
    }
    console.log();

    report.strategies.push({
      key: strategy.key,
      label: strategy.label,
      codeVerdict: strategy.verdict,
      windowMedians: medians,
      windowPositives: positives,
      windowSizes: windows.map((w) => w.length),
      tradeCount: trades,
      winCount: wins,
      winRate: winRate === undefined ? null : Number(winRate.toFixed(2)),
      totalCost: Math.round(cost),
      costSharePerRun: Number(costShare.toFixed(3)),
      tradesPerRun: Number((trades / Math.max(1, measured * WINDOW_COUNT)).toFixed(2)),
      suggestsVerdict: suggests,
      disagrees: suggests !== strategy.verdict,
    });
  }

  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`결과를 ${OUT}에 남겼습니다. **판정은 자동으로 고치지 않습니다** — 어긋난 것만 위에 표시했습니다.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
