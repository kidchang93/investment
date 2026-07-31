/**
 * `turnoverCount`에서 빠지는 종목은 지금 몇이고, 왜 빠지는가 (일회성 조사용).
 *
 * `ThemePulse.turnoverCount`는 거래대금 가중평균에 실제로 들어간 종목 수인데,
 * 빠지는 이유가 둘인데 한 칸에 합쳐 있었다.
 *   1. **거래대금 필드가 안 왔다** (`turnover === undefined`)
 *   2. **거래대금이 0원이다** (`turnover === 0`)
 * 둘이 각각 몇 종목인지 재려고 만들었다. 0이면 가르는 것이 화면을 바꾸지
 * 않는다는 뜻이고, 그것도 결론이다.
 *
 * ── 잰 결과: 2026-07-31 14:02·14:16 KST 실전 서버, 정규장 (두 번 같은 값) ──
 *
 *   테마 302개 합집합 2,113종목 · 멀티시세 71회 · 받음 2,112 · 빈 값 1 · 실패 0
 *     호가가 양쪽 다 빔 (집계에서 이미 빠짐)  92
 *     호가 잔량을 못 받음(모름)                0
 *     거래대금 필드 없음                       0
 *     거래대금 0원                             0
 *     가중평균에 들어감                    2,020
 *   `quotedCount ≠ turnoverCount`인 테마: 302개 중 **0개**
 *
 * **둘 다 0이라 지금 화면 값은 달라지지 않는다.** 거래대금 0원인 92종목이
 * 전부 호가까지 비어 앞 단계에서 빠졌기 때문이다. 그래도 갈라 둔 이유는 잰
 * 시간대가 정규장 한낮(14:02·14:16)뿐이라서다 — 장전 동시호가·개장 직후는 재지
 * 않았고, 그때는 「호가 있음 + 0원」이 실제로 생긴다.
 *
 *   npx tsx src/scripts/probeThemeTurnover.ts          # 테마 전체(299개)의 합집합
 *   npx tsx src/scripts/probeThemeTurnover.ts 004 989  # 테마 몇 개만
 */

import { hasEmptyOrderBook } from '@invest/shared';
import type { Instrument, Quote } from '@invest/shared';

import { config } from '../config.js';
import { getThemeMembers, listThemes } from '../db/themes.js';
import { getInstrumentQuotes } from '../kis/rest.js';

async function main(): Promise<void> {
  const given = process.argv.slice(2);
  const codes = given.length > 0 ? given : (await listThemes()).map((theme) => theme.code);
  console.log(`env=${config.env} now=${new Date().toISOString()} 테마 ${codes.length}개`);

  const members = [];
  const byId = new Map<string, Instrument>();
  for (const code of codes) {
    const loaded = await getThemeMembers(code);
    if (!loaded) continue;
    members.push(loaded);
    for (const instrument of loaded.instruments) byId.set(instrument.id, instrument);
  }
  const instruments = [...byId.values()];
  console.log(`고유 종목 ${instruments.length}개 — 시세를 받는다`);

  const batch = await getInstrumentQuotes(instruments);
  console.log(
    `조회 ${batch.calls}회 · 받음 ${batch.quotes.size} · 빈 값 ${batch.blank.length} · 실패 ${batch.failed.length}`,
  );
  for (const failure of batch.failed) console.log(`  실패: ${failure.message}`);

  /** 합집합 기준 교차표. `turnoverCount`가 세는 조건은 `turnover !== undefined && > 0`이다. */
  const buckets = {
    bookEmpty: [] as Array<[Instrument, Quote]>,
    bookUnknown: [] as Array<[Instrument, Quote]>,
    turnoverMissing: [] as Array<[Instrument, Quote]>,
    turnoverZero: [] as Array<[Instrument, Quote]>,
    counted: 0,
  };
  for (const instrument of instruments) {
    const quote = batch.quotes.get(instrument.id);
    if (!quote) continue;
    const empty = hasEmptyOrderBook(quote);
    if (empty === true) {
      buckets.bookEmpty.push([instrument, quote]);
      continue; // 집계에서 이미 빠진 종목이라 turnover를 따지지 않는다
    }
    if (empty === undefined) buckets.bookUnknown.push([instrument, quote]);
    if (quote.turnover === undefined) buckets.turnoverMissing.push([instrument, quote]);
    else if (quote.turnover === 0) buckets.turnoverZero.push([instrument, quote]);
    else buckets.counted += 1;
  }

  const show = (label: string, list: Array<[Instrument, Quote]>): void => {
    console.log(`\n  ${label}: ${list.length}종목`);
    for (const [instrument, quote] of list) {
      console.log(
        `    ${instrument.symbol} ${instrument.name.padEnd(18)} 현재가=${String(quote.price).padStart(9)} 등락=${String(quote.changeRate).padStart(7)} 거래량=${String(quote.accVolume).padStart(10)} 거래대금=${quote.turnover ?? '없음'} 총매도=${quote.totalAskQuantity ?? '없음'} 총매수=${quote.totalBidQuantity ?? '없음'}`,
      );
    }
  };

  console.log(`\n=== 합집합 ${instruments.length}종목 ===`);
  console.log(`  호가가 양쪽 다 빔 (집계에서 이미 빠짐): ${buckets.bookEmpty.length}`);
  console.log(`  호가 잔량을 못 받음 (모름): ${buckets.bookUnknown.length}`);
  console.log(`  거래대금 필드 없음: ${buckets.turnoverMissing.length}`);
  console.log(`  거래대금 0원: ${buckets.turnoverZero.length}`);
  console.log(`  가중평균에 들어감: ${buckets.counted}`);
  show('호가가 양쪽 다 빔', buckets.bookEmpty);
  show('거래대금 필드 없음', buckets.turnoverMissing);
  show('거래대금 0원', buckets.turnoverZero);

  // 테마별로 turnoverCount와 quotedCount가 갈리는 곳만 찍는다.
  console.log('\n=== 테마별 (quotedCount ≠ turnoverCount인 것만) ===');
  let split = 0;
  for (const loaded of members) {
    let quoted = 0;
    let missing = 0;
    let zero = 0;
    for (const instrument of loaded.instruments) {
      const quote = batch.quotes.get(instrument.id);
      if (!quote || hasEmptyOrderBook(quote) === true) continue;
      quoted += 1;
      if (quote.turnover === undefined) missing += 1;
      else if (quote.turnover === 0) zero += 1;
    }
    if (missing === 0 && zero === 0) continue;
    split += 1;
    console.log(
      `  ${loaded.theme.code} ${loaded.theme.name}: 등락률 ${quoted} · 필드없음 ${missing} · 0원 ${zero} → turnoverCount ${quoted - missing - zero}`,
    );
  }
  console.log(`  갈리는 테마 ${split}/${members.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
