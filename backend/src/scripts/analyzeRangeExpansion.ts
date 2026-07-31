/**
 * `measureRangeExpansion.ts`가 모은 표본을 읽어 잣대를 견준다 (KIS 호출 0회).
 *
 * 재는 것과 해석하는 것을 갈라 둔다 — 표본을 다시 받으려면 종목·하루당 KIS를
 * 5회 때려야 하는데, 보는 각도를 바꿀 때마다 다시 받을 이유가 없다.
 *
 * 답하려는 것은 하나다. **비용 문턱에도 `elapsed`를 곱해야 하나?**
 * 유동성 문턱은 곱하고 비용 문턱은 안 곱하는데, 거래대금은 시간에 쌓이지만
 * 고가−저가는 범위라 같은 방식으로 나눌 수 없다. 그래서 실제로 재서 본다.
 *
 *   npx tsx src/scripts/analyzeRangeExpansion.ts [원자료경로]
 */

import { readFileSync } from 'node:fs';

import { quantile, spearman } from '../trading/rangeExpansion.js';
import { MAX_COST_SHARE_OF_RANGE, ROUND_TRIP_COST_RATE } from '../trading/universe.js';

/** `measureRangeExpansion.ts`가 한 줄에 하나씩 적는 표본. */
interface Sample {
  date: string;
  symbol: string;
  clock: string;
  elapsed: number;
  rangeRate: number;
  aheadRangeRate: number;
  fullDayRangeRate: number;
  turnoverSoFar: number | undefined;
  liquid: boolean;
}

/** 왕복 비용을 이기려면 필요한 변동폭. 0.43% ÷ 0.5 = 0.860% */
const REQUIRED_RANGE_RATE = ROUND_TRIP_COST_RATE / MAX_COST_SHARE_OF_RANGE;

type Rule = (row: Sample) => boolean;

/** 세 잣대. 참이면 `costHeavy`로 버린다. */
const RULES: Array<[label: string, reject: Rule]> = [
  ['지금', (row) => row.rangeRate * MAX_COST_SHARE_OF_RANGE < ROUND_TRIP_COST_RATE],
  ['시간비례', (row) => row.rangeRate * MAX_COST_SHARE_OF_RANGE < ROUND_TRIP_COST_RATE * row.elapsed],
  ['√t', (row) => row.rangeRate * MAX_COST_SHARE_OF_RANGE < ROUND_TRIP_COST_RATE * Math.sqrt(row.elapsed)],
];

/** t에 들어간 사람 앞에 왕복 비용을 이길 폭이 남아 있었나. */
function worthEntering(row: Sample): boolean {
  return row.aheadRangeRate >= REQUIRED_RANGE_RATE;
}

function pct(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '  -   ';
}

function share(rows: Sample[], predicate: (row: Sample) => boolean): number {
  if (rows.length === 0) return NaN;
  return rows.filter(predicate).length / rows.length;
}

function clocksOf(samples: Sample[]): string[] {
  const seen = new Map<string, number>();
  for (const row of samples) seen.set(row.clock, row.elapsed);
  return [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([clock]) => clock);
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(2, 76 - title.length))}`);
}

function main(): void {
  const path = process.argv[2] ?? process.env.RANGE_OUT ?? '/tmp/range-expansion.jsonl';
  const samples: Sample[] = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Sample);

  const dates = [...new Set(samples.map((row) => row.date))].sort();
  const symbols = [...new Set(samples.map((row) => row.symbol))];
  const clocks = clocksOf(samples);
  console.log(`표본 ${samples.length}건 · 종목 ${symbols.length} · 거래일 ${dates.length}(${dates[0]}~${dates[dates.length - 1]})`);
  console.log(`필요한 변동폭 ${pct(REQUIRED_RANGE_RATE)} (왕복 비용 ${pct(ROUND_TRIP_COST_RATE)} ÷ ${MAX_COST_SHARE_OF_RANGE})`);

  /*
   * 비용 문턱은 **유동성 문을 통과한 종목에만** 걸린다(`screenQuote`가 그 순서다).
   * 전체로 세면 거래가 거의 없는 종목이 `costHeavy` 비율을 부풀린다.
   */
  const liquid = samples.filter((row) => row.liquid);
  console.log(`그중 유동성 문 통과 ${liquid.length}건 (${pct(liquid.length / samples.length)})`);

  report('유동성 문 통과분', liquid, clocks);
  report('전체 표본', samples, clocks);
  stability(liquid, clocks, dates);
}

function report(title: string, rows: Sample[], clocks: string[]): void {
  console.log(`\n${'='.repeat(80)}\n■ ${title} (${rows.length}건)`);

  section('변동폭이 시각별로 얼마나 벌어져 있나');
  console.log('시각    표본  elapsed  누적폭(25/50/75%)              하루치 대비  앞에 남은 폭');
  for (const clock of clocks) {
    const at = rows.filter((row) => row.clock === clock);
    if (at.length === 0) continue;
    const opened = at.filter((row) => row.fullDayRangeRate > 0).map((row) => row.rangeRate / row.fullDayRangeRate);
    const ranges = at.map((row) => row.rangeRate);
    console.log(
      `${clock}  ${String(at.length).padStart(5)}`
      + `  ${pct(at[0].elapsed).padStart(7)}`
      + `  ${pct(quantile(ranges, 0.25)).padStart(7)} ${pct(quantile(ranges, 0.5)).padStart(7)} ${pct(quantile(ranges, 0.75)).padStart(7)}`
      + `        ${pct(quantile(opened, 0.5)).padStart(8)}`
      + `     ${pct(quantile(at.map((row) => row.aheadRangeRate), 0.5)).padStart(8)}`,
    );
  }

  section('시각 사이에 폭이 몇 배로 벌어지나 (중앙값 비)');
  console.log('시간비례면 elapsed 배, 랜덤워크 통념이면 √elapsed 배여야 한다.');
  let previous: { clock: string; median: number; elapsed: number } | null = null;
  for (const clock of clocks) {
    const at = rows.filter((row) => row.clock === clock);
    if (at.length === 0) continue;
    const median = quantile(at.map((row) => row.rangeRate), 0.5);
    if (previous && previous.median > 0) {
      const ratio = at[0].elapsed / previous.elapsed;
      console.log(
        `${previous.clock} → ${clock}: elapsed ${ratio.toFixed(2)}배`
        + ` · √elapsed ${Math.sqrt(ratio).toFixed(2)}배`
        + ` · 실제 ${(median / previous.median).toFixed(2)}배`,
      );
    }
    previous = { clock, median, elapsed: at[0].elapsed };
  }

  section('지나간 폭이 앞으로 남을 폭을 맞히나');
  console.log('버린 것과 통과시킨 것의 "앞에 남은 폭"이 실제로 갈리는지 본다.');
  console.log('시각   앞이 넉넉  순위상관 | 잣대      탈락    버린 것의 앞  통과한 것의 앞   놓침   헛탈락');
  for (const clock of clocks) {
    const at = rows.filter((row) => row.clock === clock);
    if (at.length === 0) continue;
    const rho = spearman(at.map((row) => row.rangeRate), at.map((row) => row.aheadRangeRate));
    console.log(
      `${clock}  ${pct(share(at, worthEntering)).padStart(8)}`
      + `  ${Number.isFinite(rho) ? rho.toFixed(3).padStart(7) : '   -   '}`,
    );
    for (const [label, reject] of RULES) {
      const rejected = at.filter(reject);
      const passed = at.filter((row) => !reject(row));
      console.log(
        `                          | ${label.padEnd(8)}`
        + ` ${pct(rejected.length / at.length).padStart(7)}`
        + `  ${pct(quantile(rejected.map((row) => row.aheadRangeRate), 0.5)).padStart(11)}`
        + `  ${pct(quantile(passed.map((row) => row.aheadRangeRate), 0.5)).padStart(13)}`
        + `  ${pct(share(at, (row) => !reject(row) && !worthEntering(row))).padStart(6)}`
        + `  ${pct(share(at, (row) => reject(row) && worthEntering(row))).padStart(7)}`,
      );
    }
  }

  section('아직 한 값에 머문 종목 (고가 = 저가)');
  console.log('지금 코드는 `range > 0` 가드로 이 종목들의 비용 검사를 통째로 건너뛴다.');
  console.log('시각   해당 표본   그중 앞이 넉넉   (같은 시각 전체의 앞이 넉넉)');
  for (const clock of clocks) {
    const at = rows.filter((row) => row.clock === clock);
    const flat = at.filter((row) => row.rangeRate === 0);
    if (at.length === 0) continue;
    console.log(
      `${clock}  ${String(flat.length).padStart(6)}건`
      + `  ${flat.length > 0 ? pct(share(flat, worthEntering)).padStart(13) : '            -'}`
      + `   ${pct(share(at, worthEntering)).padStart(8)}`,
    );
  }
}

/**
 * 하루치로 상수를 정하지 않으려면 **날마다 얼마나 흔들리는지**를 봐야 한다.
 * 중앙값 하나만 보면 어느 날에나 그런 줄 알게 된다.
 */
function stability(rows: Sample[], clocks: string[], dates: string[]): void {
  console.log(`\n${'='.repeat(80)}\n■ 날짜별로 얼마나 흔들리나 (유동성 문 통과분)`);
  section('그 시각에 지금 잣대로 탈락하는 비율 — 날짜별 분포');
  console.log('시각    날 수   최소     25%     중앙     75%     최대');
  const [, rejectNow] = RULES[0];
  for (const clock of clocks) {
    const perDate = dates
      .map((date) => rows.filter((row) => row.clock === clock && row.date === date))
      .filter((group) => group.length >= 5)
      .map((group) => group.filter(rejectNow).length / group.length);
    if (perDate.length === 0) continue;
    console.log(
      `${clock}  ${String(perDate.length).padStart(5)}`
      + `  ${pct(quantile(perDate, 0)).padStart(6)}  ${pct(quantile(perDate, 0.25)).padStart(6)}`
      + `  ${pct(quantile(perDate, 0.5)).padStart(6)}  ${pct(quantile(perDate, 0.75)).padStart(6)}`
      + `  ${pct(quantile(perDate, 1)).padStart(6)}`,
    );
  }
}

main();
