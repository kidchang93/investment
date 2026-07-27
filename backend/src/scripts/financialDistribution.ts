/**
 * 재무 지표 분포 — 문턱을 정하기 전에 실제 값이 어떻게 흩어져 있는지 본다.
 *
 * `ROE 10% 이상`처럼 그럴듯한 숫자를 먼저 정하고 걸면, 통과 종목이 0개가
 * 되거나 아무도 안 걸러진다. 어느 쪽인지 모른 채 두면 필터가 있으나 마나다.
 * 유니버스의 실제 분포를 보고 정한다.
 *
 * **조회만 한다.** 주문도 리스크 룰도 건드리지 않는다.
 *
 *   npx tsx src/scripts/financialDistribution.ts [현금] [조회수]
 */

import type { Instrument } from '@invest/shared';

import { getCategoryInstruments } from '../db/instruments.js';
import { getFinancials, getInstrumentQuote } from '../kis/rest.js';
import { screenQuote, sessionElapsedRatio } from '../trading/universe.js';

const LOOKUP_GAP_MS = 150;

function pct(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function describe(label: string, values: number[], unit: string): void {
  const usable = values.filter((v) => Number.isFinite(v));
  if (usable.length === 0) {
    console.log(`  ${label.padEnd(12)} 값 있는 종목 없음`);
    return;
  }
  console.log(
    `  ${label.padEnd(12)} n=${String(usable.length).padStart(2)}`
    + ` 최저 ${usable.reduce((a, b) => Math.min(a, b)).toFixed(2).padStart(9)}${unit}`
    + ` · 25% ${pct(usable, 0.25).toFixed(2).padStart(8)}${unit}`
    + ` · 중앙 ${pct(usable, 0.5).toFixed(2).padStart(8)}${unit}`
    + ` · 75% ${pct(usable, 0.75).toFixed(2).padStart(8)}${unit}`
    + ` · 최고 ${usable.reduce((a, b) => Math.max(a, b)).toFixed(2).padStart(9)}${unit}`,
  );
}

async function main(): Promise<void> {
  const cash = Number(process.argv[2] ?? 49_751);
  const lookups = Number(process.argv[3] ?? 60);

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
      // 개별 실패는 넘어간다.
    }
    await new Promise((r) => setTimeout(r, LOOKUP_GAP_MS));
  }

  const stocks = passed.filter((item) => item.assetType === 'stock');
  const etfs = passed.filter((item) => item.assetType !== 'stock');
  console.log(`유니버스 통과 ${passed.length}종목 = 주식 ${stocks.length} + ETF·ETN ${etfs.length}`);
  console.log('재무제표는 주식만 있다. ETF에 재무 문턱을 걸면 없는 것을 나쁜 것으로 읽게 된다.\n');

  const roe: number[] = [];
  const debt: number[] = [];
  const margin: number[] = [];
  const growth: number[] = [];
  let noData = 0;

  for (const instrument of stocks) {
    try {
      const rows = await getFinancials(instrument.providerSymbol, 1);
      const latest = rows[0];
      if (!latest) {
        noData += 1;
        continue;
      }
      if (latest.roe !== undefined) roe.push(latest.roe);
      if (latest.debtRatio !== undefined) debt.push(latest.debtRatio);
      if (latest.netMargin !== undefined) margin.push(latest.netMargin);
      if (latest.revenueGrowth !== undefined) growth.push(latest.revenueGrowth);
      console.log(
        `  ${instrument.symbol} ${instrument.name.slice(0, 14).padEnd(16)} ${latest.period}`
        + ` ROE ${String(latest.roe ?? '-').padStart(7)}`
        + ` 부채 ${String(latest.debtRatio ?? '-').padStart(8)}`
        + ` 순이익률 ${String(latest.netMargin ?? '-').padStart(7)}`
        + ` 매출성장 ${String(latest.revenueGrowth ?? '-').padStart(8)}`,
      );
    } catch {
      noData += 1;
    }
    await new Promise((r) => setTimeout(r, LOOKUP_GAP_MS));
  }

  console.log(`\n재무를 못 받은 종목 ${noData}개\n분포:`);
  describe('ROE', roe, '%');
  describe('부채비율', debt, '%');
  describe('순이익률', margin, '%');
  describe('매출성장률', growth, '%');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
