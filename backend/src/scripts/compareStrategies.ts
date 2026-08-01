/**
 * 전략 비교.
 *
 * 실제 캔들에 세 전략을 태워 in-sample / out-of-sample로 나눠 잰다.
 * "어느 전략이 좋은가"에 주장 대신 숫자로 답하기 위한 것이다.
 *
 *   npx tsx src/scripts/compareStrategies.ts 005930 000660 035420
 *   npx tsx src/scripts/compareStrategies.ts --cash=10000000 069500
 *
 * 결과를 읽을 때 유의할 것:
 * - out-of-sample이 실제로 봐야 할 숫자다. in-sample만 좋으면 과거에 맞춘 것이다.
 * - 매매 횟수가 적으면(한 자릿수) 승률·수익률은 우연일 가능성이 크다.
 * - 비용이 수익보다 크면 전략이 아니라 수수료를 낸 것이다.
 */

import { getInstrument } from '../db/instruments.js';
import { getDailyCandleHistory, getInstrumentCandles } from '../kis/rest.js';
import {
  DEFAULT_COSTS,
  backtestSplit,
  backtestWindows,
  type BacktestResult,
} from '../trading/backtest.js';
import { getStrategy, listStrategies } from '../trading/strategy.js';

/*
 * 원금은 전략 비교에서 생각보다 중요하다. 1주 값보다 적으면 신호가 나도 살 수
 * 없어 매매가 0회로 끝난다 — 실제로 5만원으로 삼성전자를 재보니 세 전략 모두
 * 0회였다. 전략의 성질을 보려면 주 단위 제약이 걸리지 않을 만큼은 넣어야 한다.
 */
const DEFAULT_CASH = 10_000_000;

/** in-sample 비율. 나머지가 out-of-sample이다. */
const SPLIT_RATIO = 0.7;

/*
 * 구간이 최소 캔들 수의 몇 배는 돼야 잴 수 있다고 본다.
 *
 * MA(20)은 21봉이 지나야 첫 판단이 선다. 30봉 구간이면 판단 기회가 9번뿐이라
 * 교차가 안 나는 게 정상이고, 그 결과는 `매매 0회`다. 워밍업이 구간의 3분의 1
 * 아래로 내려가야 남은 구간에서 나온 결과를 성적이라 부를 수 있다.
 */
const MEASURABLE_MULTIPLE = 3;

/*
 * 목표 봉 수. 70/30으로 나누면 뒤 구간이 90봉이라 MA(20)의 63봉 기준을 넘는다.
 */
const TARGET_BARS = 300;

/*
 * 이보다 매매가 적으면 수익률·승률이 전략이 아니라 몇 번의 운이다. 구간이
 * 길어져도 신호가 드문 전략은 여기 걸린다 — 이동평균 교차는 105봉에서
 * 1~2회였다. 숫자를 지우지는 않고 단발이라는 사실을 옆에 적는다.
 */
const MIN_TRADES_TO_JUDGE = 10;

/*
 * 평균과 중앙값이 이만큼 벌어지면 소수 종목이 결과를 끌고 있다고 본다.
 * 20종목에서 5%p면 종목 한둘의 큰 수익/손실이 평균을 움직인 정도다.
 */
const OUTLIER_GAP = 0.05;

/*
 * walk-forward 구간 수. 349봉을 셋으로 나누면 구간당 116봉으로, MA(20)의
 * 63봉 기준을 넘긴다. 넷으로 나누면 87봉이라 아슬아슬하다.
 */
const WALK_WINDOWS = 3;

/** 중앙값. 짝수 개면 가운데 둘의 평균. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function line(label: string, result: BacktestResult): string {
  return [
    label.padEnd(12),
    `수익률 ${pct(result.returnRate).padStart(8)}`,
    `매매 ${String(result.tradeCount).padStart(3)}회`,
    `승률 ${pct(result.winRate).padStart(7)}`,
    `최대낙폭 ${pct(result.maxDrawdown).padStart(7)}`,
    `비용 ${Math.round(result.totalCost).toLocaleString().padStart(7)}원`,
    result.openQuantity > 0
      ? `· 미청산 ${result.openQuantity}주(평가 ${Math.round(result.openValue).toLocaleString()}원 포함)`
      : '',
    result.tradeCount < MIN_TRADES_TO_JUDGE
      ? `· 매매가 ${result.tradeCount}회뿐이라 성적이라 부를 수 없다`
      : '',
  ]
    .filter(Boolean)
    .join('  ');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cashArg = args.find((arg) => arg.startsWith('--cash='));
  const startCash = cashArg ? Number(cashArg.slice('--cash='.length)) : DEFAULT_CASH;
  const symbols = args.filter((arg) => !arg.startsWith('--'));
  if (symbols.length === 0 || !Number.isFinite(startCash) || startCash <= 0) {
    console.log('종목코드를 넘기세요. 예: npx tsx src/scripts/compareStrategies.ts 005930 000660');
    console.log('원금은 --cash=10000000 처럼 넘긴다. 1주 값보다 적으면 매매가 0회로 끝난다.');
    return;
  }

  console.log(`원금 ${startCash.toLocaleString()}원 · 비용 가정 수수료 ${pct(DEFAULT_COSTS.commissionRate)} /`
    + ` 거래세 ${pct(DEFAULT_COSTS.sellTaxRate)} / 슬리피지 ${pct(DEFAULT_COSTS.slippageRate)}`);

  /*
   * 종목별 결과만 늘어놓으면 판정이 안 된다. 이동평균 교차는 한 종목에서
   * 매매가 1~2회라 +112%든 -17%든 운이다. 뒤 구간 결과를 전략별로 모아
   * 매매 표본을 합쳐야 승률을 말할 수 있다.
   */
  const pooled = new Map<string, {
    label: string;
    returns: number[];
    trades: number;
    wins: number;
    cost: number;
    unmeasurable: number;
  }>();

  /*
   * walk-forward. 전략별 · 구간별로 종목 수익률을 모은다.
   * 한 구간에서만 좋았던 것인지, 기간이 바뀌어도 유지되는지 보려는 것이다.
   */
  const walk = new Map<string, Array<{ returns: number[]; trades: number }>>();

  for (const symbol of symbols) {
    const instrument = await getInstrument(`KR:KOSPI:${symbol}`) ?? await getInstrument(`KR:KOSDAQ:${symbol}`);
    if (!instrument) {
      console.log(`\n${symbol}: 종목을 찾지 못했습니다.`);
      continue;
    }
    /*
     * 국내 종목은 페이징으로 길게 받는다. 한 번 호출은 100건이 상한인데,
     * 100봉으로는 in/out-of-sample을 나눠 잴 수 없다. 종목당 KIS 호출이
     * 최대 5회 나가지만 이건 손으로 돌리는 비교 도구라 화면 경로와 무관하다.
     *
     * 예전에는 `assetType === 'stock'`만 페이징했다. 그래서 ETF는 100봉만 받아
     * 뒤 구간이 통째로 `잴 수 없음`으로 떨어졌다 — 실제로 매수 가능한 유니버스는
     * 값싼 ETF가 많은데, 16종목을 재니 10종목이 그렇게 빠졌다. ETF도 같은
     * 일봉 API가 먹는지 먼저 찍어 확인했다(probeEtfHistory.ts):
     * 단일조회 100봉 / 페이징 348봉. 되는데 안 쓰고 있었다.
     */
    const isPagedDomestic =
      instrument.country === 'KR'
      && (instrument.assetType === 'stock' || instrument.assetType === 'etf' || instrument.assetType === 'etn');
    const response = isPagedDomestic
      ? await getDailyCandleHistory(instrument.providerSymbol, TARGET_BARS)
      : await getInstrumentCandles(instrument);
    const candles = response.candles;
    console.log(`\n■ ${instrument.name} (${symbol}) · 일봉 ${candles.length}개`);
    if (candles.length < 60) {
      console.log('  캔들이 너무 적어 비교하지 않습니다.');
      continue;
    }

    /*
     * 구간이 전략의 최소 캔들 수보다 짧으면 신호가 날 자리가 없다. 그런데도
     * 태우면 `매매 0회 · 수익률 0%`가 나오고, 그게 "전략이 나빴다"로 읽힌다.
     * 실제로 그렇게 읽고 기록했다 — 페이징 전에는 뒤 구간이 30봉이었고,
     * MA(20) 교차는 21봉이 지나야 첫 판단이 선다.
     */
    const cut = Math.floor(candles.length * SPLIT_RATIO);
    const windows = { 앞: cut, 뒤: candles.length - cut };
    console.log(`  구간 나눔 ${SPLIT_RATIO * 100}% — 앞 ${windows.앞}봉 / 뒤 ${windows.뒤}봉`);

    for (const { key, label } of listStrategies().strategies) {
      const walkResults = backtestWindows(key, instrument, candles, startCash, DEFAULT_COSTS, WALK_WINDOWS);
      const slot = walk.get(key) ?? Array.from({ length: WALK_WINDOWS }, () => ({ returns: [], trades: 0 }));
      walk.set(key, slot);
      walkResults.forEach((result, index) => {
        if (!slot[index]) return;
        slot[index].returns.push(result.returnRate);
        slot[index].trades += result.tradeCount;
      });

      const minBars = getStrategy(key)?.minBars ?? 0;
      const need = minBars * MEASURABLE_MULTIPLE;
      console.log(`  ${label} (최소 ${minBars}봉 필요)`);

      const split = backtestSplit(key, instrument, candles, startCash, DEFAULT_COSTS, SPLIT_RATIO);
      for (const [name, bars, result] of [
        ['  앞 구간', windows.앞, split.inSample],
        ['  뒤 구간', windows.뒤, split.outOfSample],
      ] as const) {
        const entry = pooled.get(key) ?? {
          label,
          returns: [],
          trades: 0,
          wins: 0,
          cost: 0,
          unmeasurable: 0,
        };
        pooled.set(key, entry);

        if (bars < need) {
          console.log(
            `    ${name.padEnd(12)}잴 수 없음 — ${bars}봉으로는 판단 기회가`
            + ` ${Math.max(0, bars - minBars)}번뿐이다 (${need}봉 이상 필요).`
            + ' 이 구간 숫자는 전략 성적이 아니다.',
          );
          if (name.includes('뒤')) entry.unmeasurable += 1;
          continue;
        }
        if (name.includes('뒤')) {
          entry.returns.push(result.returnRate);
          entry.trades += result.tradeCount;
          entry.wins += result.winCount;
          entry.cost += result.totalCost;
        }
        console.log(`    ${line(name, result)}${name.includes('뒤') ? '   ← 실제로 봐야 할 숫자' : ''}`);
      }
    }
  }

  console.log('\n\n═══ 뒤 구간 합산 ═══');
  console.log(`종목 ${symbols.length}개 · 전략별로 out-of-sample 결과만 모았다.`);
  for (const [, entry] of pooled) {
    if (entry.returns.length === 0) {
      console.log(`  ${entry.label.padEnd(10)} 잴 수 있는 종목이 없었다`
        + (entry.unmeasurable ? ` (${entry.unmeasurable}종목 구간 부족)` : ''));
      continue;
    }
    const mean = entry.returns.reduce((a, b) => a + b, 0) / entry.returns.length;
    const mid = median(entry.returns);
    const sorted = [...entry.returns].sort((a, b) => a - b);
    const positive = entry.returns.filter((r) => r > 0).length;
    const winRate = entry.trades > 0 ? entry.wins / entry.trades : 0;
    /*
     * 종목별 수익률은 같은 비중으로 평균한다. 매매는 합쳐서 세야 승률이
     * 표본다워진다 — 한 종목에서 2회면 승률 50%가 아무 뜻이 없다.
     */
    console.log(
      `  ${entry.label.padEnd(10)}`
      + ` 평균 ${pct(mean).padStart(8)}`
      + ` · 중앙값 ${pct(mid).padStart(8)}`
      + ` · 플러스 ${positive}/${entry.returns.length}종목`
      + ` · 매매 ${String(entry.trades).padStart(3)}회`
      + ` · 승률 ${pct(winRate).padStart(7)}`
      + ` · 비용 ${Math.round(entry.cost).toLocaleString()}원`
      + (entry.trades < MIN_TRADES_TO_JUDGE ? '  · 합쳐도 표본이 부족하다' : ''),
    );
    /*
     * 평균과 중앙값이 벌어지면 몇 종목이 결과를 끌고 간다는 뜻이다. 8종목으로
     * 재고 판정을 확정했다가 20종목에서 뒤집힌 적이 있는데, 그때 평균만 보고
     * 있었다. 최저·최고까지 적어 폭을 함께 보게 한다.
     */
    const gap = mean - mid;
    console.log(
      `    ${' '.repeat(8)}최저 ${pct(sorted[0])} · 최고 ${pct(sorted[sorted.length - 1])}`
      + (Math.abs(gap) > OUTLIER_GAP
        ? `  ← 평균이 중앙값보다 ${pct(Math.abs(gap))} ${gap > 0 ? '높다' : '낮다'}.`
          + ' 소수 종목이 평균을 끌고 있다'
        : ''),
    );
  }

  console.log(`\n═══ 구간을 옮겨 가며 (${WALK_WINDOWS}구간) ═══`);
  console.log('전체 기간을 셋으로 잘라 각각 따로 쟀다. 한 시점의 장세에 맞은 결과인지 본다.');
  for (const [key, slots] of walk) {
    const label = listStrategies().strategies.find((item) => item.key === key)?.label ?? key;
    const parts = slots.map((slot, index) => {
      if (slot.returns.length === 0) return `${index + 1}구간 —`;
      const mid = median(slot.returns);
      const positive = slot.returns.filter((r) => r > 0).length;
      return `${index + 1}구간 중앙값 ${pct(mid).padStart(8)} (플러스 ${positive}/${slot.returns.length}·매매 ${slot.trades}회)`;
    });
    console.log(`  ${label.padEnd(10)} ${parts.join(' · ')}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
