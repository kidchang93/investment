/**
 * 전 종목 스크리닝 — 지금 현금으로 살 수 있는 후보를 값과 함께 훑어본다.
 *
 * 자동매매 후보 선정(`loadAutoTraderCandidates`)은 호출 제한 때문에 24종목만
 * 가격을 확인한다. 그것만 보면 "왜 후보가 없는지"는 알아도 "무엇을 살 수
 * 있는지"는 알 수 없다. 이 스크립트는 조회 전용으로 더 넓게 훑어, 예수금으로
 * 실제로 1주라도 살 수 있는 종목이 무엇인지 값으로 보여 준다.
 *
 * **주문은 내지 않는다.** 리스크 룰도 바꾸지 않는다. 읽기만 한다.
 *
 *   npx tsx src/scripts/screenCandidates.ts [현금] [조회수]
 *   npx tsx src/scripts/screenCandidates.ts 49751 60
 */

import { getCategoryInstruments } from '../db/instruments.js';
import { getInstrumentQuote } from '../kis/rest.js';
import type { Instrument } from '@invest/shared';

const SOURCE_CATEGORIES = ['kr-all', 'kr-etf'];
/** KIS 호출 제한(EGW00201)을 태우지 않도록 조회 간격을 둔다. */
const LOOKUP_GAP_MS = 120;

function isOrderable(instrument: Instrument): boolean {
  if (instrument.country !== 'KR') return false;
  return instrument.assetType === 'stock' || instrument.assetType === 'etf' || instrument.assetType === 'etn';
}

async function main(): Promise<void> {
  const cash = Number(process.argv[2] ?? 49_751);
  const lookups = Number(process.argv[3] ?? 60);

  const pools = await Promise.all(
    SOURCE_CATEGORIES.map((category) => getCategoryInstruments(category, 300).catch(() => [])),
  );
  // 카테고리를 번갈아 뽑는다. 국내 전체는 시총 순이라 앞쪽이 전부 대형주다.
  const pool: Instrument[] = [];
  const seen = new Set<string>();
  for (let index = 0; pool.length < lookups * 3; index += 1) {
    let added = false;
    for (const list of pools) {
      const instrument = list[index];
      if (!instrument || !isOrderable(instrument) || seen.has(instrument.id)) continue;
      seen.add(instrument.id);
      pool.push(instrument);
      added = true;
    }
    if (!added) break;
  }

  console.log(`후보 풀 ${pool.length}종목 · 현금 ${cash.toLocaleString('ko-KR')}원 · ${lookups}종목 시세 조회\n`);

  const rows: Array<{ name: string; symbol: string; price: number; rate: number; volume: number }> = [];
  for (const instrument of pool.slice(0, lookups)) {
    try {
      const quote = await getInstrumentQuote(instrument);
      if (Number.isFinite(quote.price) && quote.price > 0) {
        rows.push({
          name: instrument.name,
          symbol: instrument.symbol,
          price: quote.price,
          rate: quote.changeRate,
          volume: quote.accVolume,
        });
      }
    } catch {
      // 개별 실패는 건너뛴다. 전체를 멈출 이유가 없다.
    }
    await new Promise((r) => setTimeout(r, LOOKUP_GAP_MS));
  }

  const affordable = rows.filter((row) => row.price <= cash).sort((a, b) => b.rate - a.rate);
  const tooExpensive = rows.length - affordable.length;

  console.log(`조회 성공 ${rows.length} · 살 수 있음 ${affordable.length} · 1주가 예수금보다 비쌈 ${tooExpensive}\n`);
  console.log('살 수 있는 종목 (등락률 순)');
  console.log('종목명'.padEnd(22), '코드'.padEnd(8), '현재가'.padStart(10), '등락률'.padStart(9), '거래량'.padStart(12));
  for (const row of affordable) {
    console.log(
      row.name.slice(0, 20).padEnd(22),
      row.symbol.padEnd(8),
      `${row.price.toLocaleString('ko-KR')}원`.padStart(10),
      `${row.rate > 0 ? '+' : ''}${row.rate.toFixed(2)}%`.padStart(9),
      row.volume.toLocaleString('ko-KR').padStart(12),
    );
  }
  if (affordable.length === 0) {
    const cheapest = Math.min(...rows.map((row) => row.price));
    console.log(`(없음) 확인한 것 중 가장 싼 종목이 ${cheapest.toLocaleString('ko-KR')}원입니다`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
