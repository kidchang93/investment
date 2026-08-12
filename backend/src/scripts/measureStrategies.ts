/**
 * 주기 재측정 — 일봉 축에서 전략을 다시 잰다.
 *
 * 지금까지는 종목코드를 손으로 넘겨야 했다(`compareStrategies.ts`). 그래서
 * 판정을 낼 때마다 "어느 종목으로 쟀나"가 사람 손에 달렸고, 실제로 한 번
 * 틀렸다 — 이 계좌로 살 수 없는 대형주 20종목으로 재고 있었다.
 *
 * 유니버스를 코드가 고르면 그 실수가 안 난다. 가격·유동성·왕복비용 필터를
 * 그대로 태워 나온 종목으로만 잰다.
 *
 * ── 유니버스를 어떻게 고르나 (2026-08-01에 고친 것) ──────────────────────
 *
 * 예전에는 `getCategoryInstruments(...)`가 준 목록의 **앞쪽 60종목**을 봤다.
 * 그런데 그 조회는 검색어가 없으면 `ORDER BY symbol`이다. 즉 **종목코드가
 * 작은 순으로 앞 60개**를 보고 통과한 20종목으로 판정문을 만들고 있었다.
 * `000020 동화약품`으로 시작하는 그 60종목은 시장을 대표하지 않는다.
 *
 * 크기를 쟀다. 같은 절차(`backtestWindows` · 현금 5만원 · 왕복 0.43%)를
 * 389종목에 걸면 3구간 중앙값이 이렇게 갈린다.
 *
 *   평균 회귀   판정문 -0.60% 승률 70.8%  →  389종목 -12.20% 승률 44.4%
 *   이동평균    판정문 -3.75% 승률 23.3%  →  389종목  -5.33% 승률  5.2%
 *
 * 그래서 지금은 **거래대금 순위로 층을 나눠 뽑는다(층화 표집).**
 *
 *   1. 표집틀: DB의 활성 국내 주문 가능 종목 전부 (주식 + ETF·ETN)
 *   2. 시세를 물어 러너 자신의 필터(`verdictFor`)를 통과한 것만 남긴다
 *   3. 남은 것을 **거래대금 내림차순**으로 세워 5층으로 가르고 층마다 등간격으로 뽑는다
 *
 * 거래대금을 층의 기준으로 삼은 이유는 그것이 **러너 자신이 보는 축**이라서다 —
 * `screenQuote`의 `illiquid` 문턱이 거래대금이고, 체결 비용(스프레드 한 칸)이
 * 갈리는 축도 유동성이다(`docs/USER_FINDINGS.md` 2026-08-01 밤). 시가총액이나
 * 업종으로 나누면 그 축과 무관한 표본이 된다.
 *
 * **상한은 종목 수가 아니라 KIS 호출 수로 잡는다** — 이 레포의 규약이다.
 *
 * ── 판정을 자동으로 고치지 않는다 ────────────────────────────────────────
 *
 * 결과를 파일에 남기고, 코드에 적힌 판정과 어긋나면 그 사실만 알린다. 이유:
 *   1. 판정 글에는 숫자만으로 안 나오는 맥락이 들어 있다("승률은 높은데
 *      수익률은 마이너스 — 이기는 횟수는 많고 지는 크기가 크다").
 *   2. 한 주 숫자가 흔들렸다고 no_edge가 조용히 unproven이 되면, 그게 바로
 *      과거에 맞추는 일이다.
 * 재는 것은 자동으로, 판단은 사람이 한다.
 *
 *   npx tsx src/scripts/measureStrategies.ts [현금] [표본종목수]
 */

import { writeFileSync } from 'node:fs';

import type { Instrument, Quote, ScreeningVerdict } from '@invest/shared';

import { getCategoryInstruments } from '../db/instruments.js';
import { MULTI_QUOTE_MAX_CODES, getDailyCandleHistory, getInstrumentQuotes } from '../kis/rest.js';
import { DEFAULT_COSTS, backtestWindowSlices, backtestWindows } from '../trading/backtest.js';
import {
  countExcluded,
  countMeasured,
  describeSampleTally,
  emptySampleTally,
  sampleExclusion,
  stratify,
  type SampleTally,
} from '../trading/measurementSample.js';
import { spreadEvenly } from '../trading/rangeExpansion.js';
import { getStrategy, listStrategies } from '../trading/strategy.js';
import { sessionElapsedRatio, verdictFor } from '../trading/universe.js';

const OUT = process.env.MEASURE_OUT ?? '/tmp/strategy-measurement.json';
const WINDOW_COUNT = 3;
const TARGET_BARS = 350;
const GAP_MS = 150;

/** 표집틀로 쓸 카테고리. 러너의 `SOURCE_CATEGORIES`와 같은 둘이다. */
const FRAME_CATEGORIES = ['kr-all', 'kr-etf'];

/**
 * DB에서 표집틀로 가져올 카테고리당 종목 수 상한.
 *
 * 2026-08-01 기준 국내 활성 종목은 주식 2,879 + ETF·ETN 1,153이다. 4,000이면
 * 두 카테고리 모두 통째로 덮으므로 `ORDER BY symbol` 자르기가 일어나지 않는다.
 * (KIS 호출이 아니라 DB 조회라 여기는 값이 커도 비용이 안 든다.)
 */
const FRAME_LIMIT = 4_000;

/**
 * 시세를 물어보는 KIS 호출 수 상한. 멀티시세는 30종목이 1회다.
 *
 * 140회 = 4,200종목이라 지금 표집틀 전체가 들어간다. 표집틀이 이보다 커지면
 * **앞에서 자르지 않고 전체에 고르게 흩뿌려** 줄인다 — 앞에서 자르면 이번에
 * 고친 그 결함(종목코드 오름차순 편향)이 그대로 돌아온다.
 */
const MAX_SCREEN_CALLS = 140;

/**
 * 일봉을 받는 KIS 호출 수 상한.
 *
 * `getDailyCandleHistory`는 한 종목을 **여러 페이지로** 받는다(130달력일씩,
 * 최대 5페이지). 350봉이면 보통 4페이지다. 그래서 종목 수가 곧 호출 수가
 * 아니고, 상한도 종목 수가 아니라 호출 수로 잡아야 몇 회가 나가는지 알 수 있다.
 */
const DAILY_CALLS_PER_INSTRUMENT = 5;
const MAX_HISTORY_CALLS = 1_000;
const MAX_SAMPLE_INSTRUMENTS = Math.floor(MAX_HISTORY_CALLS / DAILY_CALLS_PER_INSTRUMENT);

/**
 * 층 수. 거래대금 순위를 다섯 등분한다.
 *
 * 다섯인 이유는 층마다 표본이 남아야 해서다 — 200종목을 10층으로 나누면 층당
 * 20종목이라, 한 종목이 층 중앙값을 통째로 흔든다.
 */
const STRATUM_COUNT = 5;

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function won(value: number): string {
  return `${Math.round(value).toLocaleString('ko-KR')}원`;
}

/** 억 단위로 줄여 적는다. 거래대금은 자릿수가 커서 그대로 적으면 층끼리 견주기 어렵다. */
function eok(value: number): string {
  return `${(value / 100_000_000).toFixed(1)}억`;
}

function isOrderable(instrument: Instrument): boolean {
  if (instrument.country !== 'KR') return false;
  return instrument.assetType === 'stock' || instrument.assetType === 'etf' || instrument.assetType === 'etn';
}

/**
 * 거래대금. `screenQuote`가 유동성 문턱에 쓰는 것과 **같은 식**이어야 한다.
 * 다른 값으로 층을 나누면 "러너가 보는 축으로 나눴다"는 말이 성립하지 않는다.
 */
function turnoverOf(quote: Quote): number {
  return quote.turnover ?? quote.price * quote.accVolume;
}

interface StratumReport {
  /** 1이 거래대금 상위 층 */
  rank: number;
  poolCount: number;
  pickedCount: number;
  turnoverHigh: number;
  turnoverLow: number;
  stockCount: number;
  etfCount: number;
}

interface UniverseReport {
  /** 층을 무엇으로 갈랐나. 결과를 읽는 사람이 표본을 알 수 있게 값으로 남긴다 */
  stratifiedBy: 'turnover';
  stratumCount: number;
  frameCount: number;
  screenedCount: number;
  quoteCalls: number;
  quotesReceived: number;
  blankCount: number;
  failedCount: number;
  passedCount: number;
  rejections: Record<Exclude<ScreeningVerdict, 'pass'>, number>;
  strata: StratumReport[];
  pickedCount: number;
  historyCallCeiling: number;
  sessionElapsed: number;
}

interface Universe {
  instruments: Instrument[];
  report: UniverseReport;
}

/**
 * 표집틀 → 시세 확인 → 층화 표집.
 *
 * 러너 자신의 필터(`verdictFor`)를 그대로 태운다. 러너가 만질 수 없는 종목으로
 * 러너의 전략을 재면 그 숫자는 러너를 설명하지 않는다.
 */
async function pickUniverse(cash: number, sampleSize: number): Promise<Universe> {
  const pools = await Promise.all(
    FRAME_CATEGORIES.map((category) => getCategoryInstruments(category, FRAME_LIMIT).catch(() => [])),
  );
  const frame: Instrument[] = [];
  const seen = new Set<string>();
  for (const list of pools) {
    for (const instrument of list) {
      if (!isOrderable(instrument) || seen.has(instrument.id)) continue;
      seen.add(instrument.id);
      frame.push(instrument);
    }
  }

  const screenLimit = MULTI_QUOTE_MAX_CODES * MAX_SCREEN_CALLS;
  const targets = frame.length <= screenLimit ? frame : spreadEvenly(frame, screenLimit);

  const batch = await getInstrumentQuotes(targets);
  const elapsed = sessionElapsedRatio();
  const rejections: UniverseReport['rejections'] = {
    tooExpensive: 0,
    noOrderBook: 0,
    illiquid: 0,
    costHeavy: 0,
  };

  const passed: Array<{ instrument: Instrument; turnover: number }> = [];
  for (const instrument of targets) {
    const quote = batch.quotes.get(instrument.id);
    if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) continue;
    // 종목을 함께 넘긴다 — ETF는 매도 거래세가 면제라 왕복 비용 문턱이 다르다.
    const verdict = verdictFor(quote, elapsed, cash, instrument);
    if (verdict !== 'pass') {
      rejections[verdict] += 1;
      continue;
    }
    passed.push({ instrument, turnover: turnoverOf(quote) });
  }

  // 거래대금 내림차순. 1층이 가장 많이 거래되는 층이다.
  passed.sort((a, b) => b.turnover - a.turnover);
  const layers = stratify(passed, STRATUM_COUNT);
  const perStratum = Math.max(1, Math.floor(Math.min(sampleSize, MAX_SAMPLE_INSTRUMENTS) / STRATUM_COUNT));

  const instruments: Instrument[] = [];
  const strata: StratumReport[] = [];
  layers.forEach((layer, index) => {
    const picked = spreadEvenly(layer, perStratum);
    instruments.push(...picked.map((entry) => entry.instrument));
    strata.push({
      rank: index + 1,
      poolCount: layer.length,
      pickedCount: picked.length,
      turnoverHigh: layer[0]?.turnover ?? NaN,
      turnoverLow: layer[layer.length - 1]?.turnover ?? NaN,
      stockCount: picked.filter((entry) => entry.instrument.assetType === 'stock').length,
      etfCount: picked.filter((entry) => entry.instrument.assetType !== 'stock').length,
    });
  });

  const failedCount = batch.failed.reduce((total, failure) => total + failure.instrumentIds.length, 0);
  return {
    instruments,
    report: {
      stratifiedBy: 'turnover',
      stratumCount: STRATUM_COUNT,
      frameCount: frame.length,
      screenedCount: targets.length,
      quoteCalls: batch.calls,
      quotesReceived: batch.quotes.size,
      blankCount: batch.blank.length,
      failedCount,
      passedCount: passed.length,
      rejections,
      strata,
      pickedCount: instruments.length,
      historyCallCeiling: instruments.length * DAILY_CALLS_PER_INSTRUMENT,
      sessionElapsed: elapsed,
    },
  };
}

function printUniverse(report: UniverseReport, cash: number): void {
  console.log(`현금 ${won(cash)} · 장 경과 비율 ${report.sessionElapsed.toFixed(4)}`);
  console.log(
    `표집틀 ${report.frameCount}종목 (DB 활성 국내 주식·ETF·ETN 전부)`
    + ` → 시세 확인 ${report.screenedCount}종목 · KIS ${report.quoteCalls}회`
    + ` (받음 ${report.quotesReceived} · 빈 자리 ${report.blankCount} · 묶음째 실패 ${report.failedCount})`,
  );
  console.log(
    `러너 필터 통과 ${report.passedCount}종목`
    + ` (가격 초과 ${report.rejections.tooExpensive} · 호가 없음 ${report.rejections.noOrderBook}`
    + ` · 거래대금 부족 ${report.rejections.illiquid} · 왕복 비용 과다 ${report.rejections.costHeavy})`,
  );
  console.log(
    `층화 표집: 거래대금 내림차순 ${report.stratumCount}층 → ${report.pickedCount}종목`
    + ` · 일봉 KIS 최대 ${report.historyCallCeiling}회 (종목당 최대 ${DAILY_CALLS_PER_INSTRUMENT}회)`,
  );
  for (const stratum of report.strata) {
    console.log(
      `  ${stratum.rank}층  거래대금 ${eok(stratum.turnoverHigh).padStart(9)} ~ ${eok(stratum.turnoverLow).padStart(9)}`
      + ` · 층 ${String(stratum.poolCount).padStart(3)}종목 중 ${String(stratum.pickedCount).padStart(2)}종목`
      + ` (주식 ${stratum.stockCount} · ETF·ETN ${stratum.etfCount})`,
    );
  }
  console.log();
}

async function main(): Promise<void> {
  const cash = Number(process.argv[2] ?? 49_751);
  const requested = Number(process.argv[3] ?? 200);
  const sampleSize = Math.min(requested, MAX_SAMPLE_INSTRUMENTS);
  if (requested > MAX_SAMPLE_INSTRUMENTS) {
    console.log(
      `표본을 ${MAX_SAMPLE_INSTRUMENTS}종목으로 줄였습니다 —`
      + ` 일봉 호출 상한 ${MAX_HISTORY_CALLS}회 ÷ 종목당 ${DAILY_CALLS_PER_INSTRUMENT}회입니다.`,
    );
  }

  const universe = await pickUniverse(cash, sampleSize);
  printUniverse(universe.report, cash);
  if (universe.instruments.length === 0) {
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
   *
   * 그리고 이 승률에는 **청산된 매매만** 들어간다. 미청산으로 끝난 표본이 몇
   * 개였는지 아래 `tallies`가 함께 적는다 — 근거는 `BacktestResult.winRate` 주석.
   */
  const winCounts = new Map<string, number>();
  /** 전략별 표본 집계. 무엇을 빼고 무엇을 셌는지가 결과에 남아야 한다 */
  const tallies = new Map<string, SampleTally>();
  const { strategies } = listStrategies();
  for (const strategy of strategies) {
    byStrategy.set(strategy.key, Array.from({ length: WINDOW_COUNT }, () => []));
    tradeCounts.set(strategy.key, 0);
    costTotals.set(strategy.key, 0);
    winCounts.set(strategy.key, 0);
    tallies.set(strategy.key, emptySampleTally());
  }

  let measured = 0;
  let historyFailed = 0;
  let tooShort = 0;
  for (const instrument of universe.instruments) {
    let candles;
    try {
      const response = await getDailyCandleHistory(instrument.providerSymbol, TARGET_BARS);
      candles = response.candles;
    } catch {
      historyFailed += 1;
      continue;
    }
    if (candles.length < 60) {
      tooShort += 1;
      continue;
    }
    measured += 1;

    /*
     * 구간을 자르는 규칙은 `backtest.ts`가 갖고 있다. 여기서 다시 자르면 두 곳이
     * 갈라진다 — 마지막 구간이 나머지를 다 가져간다는 규칙이 특히 그렇다.
     */
    const slices = backtestWindowSlices(candles, WINDOW_COUNT);
    for (const strategy of strategies) {
      const tally = tallies.get(strategy.key);
      const minBars = getStrategy(strategy.key)?.minBars ?? 0;
      const windows = backtestWindows(strategy.key, instrument, candles, cash, DEFAULT_COSTS, WINDOW_COUNT);
      windows.forEach((window, index) => {
        /*
         * 신호를 낼 수 없거나 한 번도 살 수 없었던 구간은 성적이 아니라 **잴 수
         * 없는 조건**이다. 섞으면 `매매 0건 · 수익률 정확히 0.00%`가 결과로
         * 읽히는데, 전부 마이너스인 분포에서 0은 맨 위라 중앙값을 끌어올린다.
         * 게다가 러너 자신의 필터(`tooExpensive`)가 거르는 종목이다.
         *
         * 2026-08-01 실측: ma_cross 3구간에서 매매 0건이 350종목 중 115종목이었고,
         * 그걸 0.00%로 섞으면 중앙값이 -9.64% → -5.33%로 4.3pp 좋아 보였다.
         */
        const excluded = sampleExclusion(slices[index] ?? [], cash, minBars);
        if (excluded) {
          if (tally) countExcluded(tally, excluded);
          return;
        }
        if (tally) countMeasured(tally, window);
        byStrategy.get(strategy.key)?.[index]?.push(window.returnRate * 100);
        tradeCounts.set(strategy.key, (tradeCounts.get(strategy.key) ?? 0) + window.tradeCount);
        costTotals.set(strategy.key, (costTotals.get(strategy.key) ?? 0) + window.totalCost);
        winCounts.set(strategy.key, (winCounts.get(strategy.key) ?? 0) + window.winCount);
      });
    }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }

  console.log(
    `일봉을 받은 종목 ${measured}개 · 구간 ${WINDOW_COUNT}개`
    + ` (조회 실패 ${historyFailed} · 60봉 미만 ${tooShort})\n`,
  );
  const report = {
    measuredAt: new Date().toISOString(),
    cash,
    universe: universe.report,
    universeSize: universe.instruments.length,
    measuredCount: measured,
    historyFailedCount: historyFailed,
    tooShortCount: tooShort,
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
    const tally = tallies.get(strategy.key) ?? emptySampleTally();
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
     *
     * **분모는 잰 표본 수다.** 뺀 표본까지 세면 비용 비율이 그만큼 작아진다.
     */
    const runCount = tally.measured;
    const costShare = runCount > 0 ? (cost / (runCount * cash)) * 100 : 0;
    /*
     * 매매가 없으면 승률은 0%가 아니라 **없는 값**이다. 분모가 0인데 0%라고
     * 적으면 "다 졌다"로 읽힌다.
     */
    const winRate = trades > 0 ? (wins / trades) * 100 : undefined;
    console.log(
      `  매매 ${trades}회(백테스트 1회당 ${(trades / Math.max(1, runCount)).toFixed(1)}회)`
      + ` · 승률 ${winRate === undefined ? '—' : `${winRate.toFixed(1)}%`}`
      + ` · 비용 합계 ${won(cost)}`
      + ` · 백테스트 1회 원금 대비 ${costShare.toFixed(2)}%`,
    );
    /*
     * 표본에서 뺀 것과 0%로 남은 것을 반드시 적는다. 안 보이면 중앙값이 무엇의
     * 중앙값인지 알 수 없다.
     */
    console.log(`  ${describeSampleTally(tally, '종목·구간')}`);
    if (tally.openEnded > 0) {
      console.log(
        '  승률은 청산된 매매만의 값이다 — 위 미청산 표본의 매매는 분모에도 분자에도 없다.',
      );
    }

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
      tradesPerRun: Number((trades / Math.max(1, runCount)).toFixed(2)),
      sample: tally,
      suggestsVerdict: suggests,
      disagrees: suggests !== strategy.verdict,
    });
  }

  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`결과를 ${OUT}에 남겼습니다. 판정은 자동으로 고치지 않습니다 — 어긋난 것만 위에 표시했습니다.`);
  console.log(
    '이 숫자를 strategy.ts의 일봉 축 measurement로 옮길 때는 표본(층 기준·층 수·종목 수)도 함께 적습니다 —'
    + ' 조건 없는 숫자는 시간이 지나면 조용히 틀린 값이 됩니다.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
