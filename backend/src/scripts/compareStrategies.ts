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
import { getInstrumentCandles } from '../kis/rest.js';
import { DEFAULT_COSTS, backtestSplit, type BacktestResult } from '../trading/backtest.js';
import { listStrategies } from '../trading/strategy.js';

/*
 * 원금은 전략 비교에서 생각보다 중요하다. 1주 값보다 적으면 신호가 나도 살 수
 * 없어 매매가 0회로 끝난다 — 실제로 5만원으로 삼성전자를 재보니 세 전략 모두
 * 0회였다. 전략의 성질을 보려면 주 단위 제약이 걸리지 않을 만큼은 넣어야 한다.
 */
const DEFAULT_CASH = 10_000_000;

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

  for (const symbol of symbols) {
    const instrument = await getInstrument(`KR:KOSPI:${symbol}`) ?? await getInstrument(`KR:KOSDAQ:${symbol}`);
    if (!instrument) {
      console.log(`\n${symbol}: 종목을 찾지 못했습니다.`);
      continue;
    }
    const response = await getInstrumentCandles(instrument);
    const candles = response.candles;
    console.log(`\n■ ${instrument.name} (${symbol}) · 일봉 ${candles.length}개`);
    if (candles.length < 60) {
      console.log('  캔들이 너무 적어 비교하지 않습니다.');
      continue;
    }

    for (const { key, label } of listStrategies()) {
      const split = backtestSplit(key, instrument, candles, startCash, DEFAULT_COSTS, 0.7);
      console.log(`  ${label}`);
      console.log(`    ${line('  앞 구간', split.inSample)}`);
      console.log(`    ${line('  뒤 구간', split.outOfSample)}   ← 실제로 봐야 할 숫자`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
