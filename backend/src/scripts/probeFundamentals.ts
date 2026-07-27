/**
 * 매수 신호 재무 확인을 실제 종목으로 태워 본다 (일회성 조사용).
 *
 * 통과·차단 양쪽을 다 확인한다 — 아무도 안 걸러지거나 전부 걸러지면
 * 필터가 있으나 마나다. 실측에서 순손실은 성창기업지주(-4.53%)였다.
 */

import { getInstrument, getCategoryInstruments } from '../db/instruments.js';
import { checkBuyFundamentals } from '../trading/fundamentals.js';

async function main(): Promise<void> {
  const symbols = process.argv.slice(2);
  const pools = await Promise.all(
    ['kr-all', 'kr-etf'].map((c) => getCategoryInstruments(c, 300).catch(() => [])),
  );
  const all = pools.flat();
  for (const symbol of symbols) {
    const instrument = all.find((i) => i.symbol === symbol) ?? (await getInstrument(`KR:KOSPI:${symbol}`));
    if (!instrument) {
      console.log(`${symbol}: 종목을 찾지 못했습니다.`);
      continue;
    }
    const verdict = await checkBuyFundamentals(instrument);
    console.log(
      `${symbol} ${instrument.name.slice(0, 16).padEnd(18)} ${instrument.assetType.padEnd(5)}`
      + ` ${verdict.allowed ? '통과' : '차단'}`
      + (verdict.reason ? ` (${verdict.reason})` : '')
      + `\n    근거: ${verdict.note}`,
    );
    await new Promise((r) => setTimeout(r, 400));
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
