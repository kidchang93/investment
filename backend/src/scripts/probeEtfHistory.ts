/**
 * ETF도 일봉 페이징이 되는지 확인 (일회성 조사용).
 *
 * 전략 비교 스크립트가 `assetType === 'stock'`일 때만 페이징을 쓴다. 그래서
 * ETF는 100봉만 받고 out-of-sample 구간을 잴 수 없었다 — 16종목 중 10종목이
 * 그랬다. ETF에도 같은 API가 먹는지 바꾸기 전에 찍어 본다.
 *
 *   npx tsx src/scripts/probeEtfHistory.ts 0008T0 069500
 */

import { getDailyCandleHistory, getInstrumentCandles } from '../kis/rest.js';
import { getInstrument } from '../db/instruments.js';
import { getCategoryInstruments } from '../db/instruments.js';

async function main(): Promise<void> {
  const symbols = process.argv.slice(2);
  if (symbols.length === 0) {
    console.log('종목코드를 넘기세요.');
    return;
  }

  const pool = await getCategoryInstruments('kr-etf', 300).catch(() => []);
  for (const symbol of symbols) {
    const instrument =
      pool.find((item) => item.symbol === symbol) ?? (await getInstrument(`KR:KOSPI:${symbol}`));
    if (!instrument) {
      console.log(`${symbol}: 종목을 찾지 못했습니다.`);
      continue;
    }
    const single = await getInstrumentCandles(instrument);
    const paged = await getDailyCandleHistory(instrument.providerSymbol, 300);
    console.log(
      `${symbol} ${instrument.name.slice(0, 20).padEnd(22)} assetType=${instrument.assetType.padEnd(5)}`
      + ` 단일조회 ${String(single.candles.length).padStart(3)}봉 · 페이징 ${String(paged.candles.length).padStart(3)}봉`,
    );
    await new Promise((r) => setTimeout(r, 400));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
