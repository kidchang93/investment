/**
 * 거래소 거래대금 순위가 실제로 오는지, 우리 마스터와 맞는지 본다.
 *
 * 조회 전용이다. 주문을 내지 않는다.
 *
 *   npx tsx src/scripts/probeTurnoverRanking.ts
 */

import { getDomesticInstrumentsBySymbols } from '../db/instruments.js';
import { getDomesticTurnoverRanking } from '../kis/rest.js';
import { isOrderableForAutoTrader } from '../trading/universe.js';

const symbols = await getDomesticTurnoverRanking(30);
console.log(`거래소 거래대금 순위 ${symbols.length}종목`);

const found = await getDomesticInstrumentsBySymbols(symbols);
console.log(`마스터에서 찾은 것 ${found.size}종목 · 못 찾은 것 ${symbols.length - found.size}종목\n`);

console.log('순위  코드      종목명                          주문가능');
console.log('─'.repeat(64));
symbols.forEach((symbol, index) => {
  const instrument = found.get(symbol);
  if (!instrument) {
    console.log(`${String(index + 1).padStart(4)}  ${symbol}    (마스터에 없음)`);
    return;
  }
  const orderable = isOrderableForAutoTrader(instrument);
  console.log(
    `${String(index + 1).padStart(4)}  ${symbol}  ${instrument.name.slice(0, 28).padEnd(30)}${orderable ? '○' : '✗ 제외'}`,
  );
});

process.exit(0);
