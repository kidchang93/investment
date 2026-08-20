/**
 * 전 종목 스크리닝 — 판단자와 화면이 쓰는 것과 **같은 코드**로 후보를 훑는다.
 *
 * ★ 2026-08-20까지 이 스크립트는 **자기만의 구현**을 들고 있었다. 그래서 8/19에
 *   `trading/screening.ts`의 `buildPool`을 거래대금 상위로 고쳤을 때(`711577d`)
 *   여기는 안 고쳐졌다. 하필 판단자 프롬프트가 부르는 것이 이쪽이라, 회차 21은
 *   **코드 오름차순 풀**과 **현금 49,751원 하드코딩**(실제 예수금 19,649,294원)을
 *   받아 갔다. 회차 21이 스스로 알아채고 API로 다시 훑어 판단은 살았지만,
 *   다음 회차가 그러리라는 보장이 없다.
 *
 *   같은 규칙을 두 곳에 두면 한쪽만 고쳤을 때 조용히 갈라진다 — `universe.ts`가
 *   이미 같은 교훈을 적어 두었는데 이 파일이 그 예가 됐다. `runScreening`을
 *   그대로 부른다.
 *
 * ★ 예수금도 인자로 받지 않고 **계좌에서 직접 읽는다.** 손으로 적은 값과 실제
 *   계좌가 어긋나면 "1주가 예수금보다 비쌈" 판정이 통째로 거짓이 된다.
 *   서버(`POST /api/trading/screening/run`)와 같은 값을 같은 방식으로 쓴다.
 *   `cashBalance`는 D+0이라 오늘 산 것이 아직 안 빠져 있다.
 *
 * **주문은 내지 않는다.** 리스크 룰도 바꾸지 않는다. 읽기만 한다.
 *
 *   npx tsx src/scripts/screenCandidates.ts [계좌id] [조회수]
 *   npx tsx src/scripts/screenCandidates.ts VTS-ORDINARY 300
 */

import { getKisAccount } from '../config.js';
import { getKisDomesticAccountSnapshot } from '../kis/rest.js';
import { DEFAULT_SCREENING_LOOKUPS, MAX_SCREENING_LOOKUPS, runScreening } from '../trading/screening.js';
import type { ScreeningRow, ScreeningVerdict } from '@invest/shared';

const VERDICT_LABEL: Record<ScreeningVerdict, string> = {
  pass: '통과',
  tooExpensive: '1주가 예수금보다 비쌈',
  noOrderBook: '호가 없음',
  illiquid: '거래대금 부족',
  costHeavy: '왕복 비용이 하루 변동폭의 절반 초과',
};

function formatRow(row: ScreeningRow): string {
  const range = row.rangeRate === undefined ? '   —  ' : `${row.rangeRate.toFixed(2)}%`.padStart(6);
  return (
    `  ${row.symbol.padEnd(8)}${row.name.slice(0, 18).padEnd(20)}`
    + `${row.price.toLocaleString('ko-KR').padStart(10)}원`
    + ` ${(row.changeRate > 0 ? '+' : '') + row.changeRate.toFixed(2)}%`.padStart(9)
    + ` 거래대금 ${Math.round(row.turnover / 100_000_000).toLocaleString('ko-KR').padStart(6)}억`
    + ` 변동폭 ${range}`
  );
}

async function main(): Promise<void> {
  const accountId = process.argv[2] ?? 'VTS-ORDINARY';
  const account = getKisAccount(accountId);
  if (!account) {
    console.error(`등록되지 않은 계좌: ${accountId}`);
    process.exit(1);
  }

  const lookups = Number(process.argv[3]) || DEFAULT_SCREENING_LOOKUPS;
  if (lookups > MAX_SCREENING_LOOKUPS) {
    // 상한은 실측치(10묶음 300종목)다. 넘겨 부르면 runScreening이 깎지만, 깎였다는
    // 사실을 말해 주지 않으면 "300위까지 봤다"고 잘못 적게 된다.
    console.log(`조회 요청 ${lookups}종목은 상한 ${MAX_SCREENING_LOOKUPS}종목으로 깎인다\n`);
  }

  const snapshot = await getKisDomesticAccountSnapshot(account);
  const cash = snapshot.cashBalance ?? 0;
  const result = await runScreening(cash, lookups);

  const counts = new Map<ScreeningVerdict, number>();
  for (const row of result.rows) counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);
  const passed = result.rows.filter((row) => row.verdict === 'pass');

  console.log(
    `계좌 ${account.id} · 예수금(D+0) ${cash.toLocaleString('ko-KR')}원`
    + ` · 풀 ${result.poolSize}종목 · 시세 조회 ${result.quoteCalls}회`
    + ` · 장 경과 ${(result.elapsed * 100).toFixed(0)}%`,
  );
  console.log(
    `응답 ${result.rows.length}종목 · 못 받음 ${result.unresolved}`
    + ` · 문턱: 거래대금 ${(result.thresholds.minDailyTurnover / 100_000_000).toLocaleString('ko-KR')}억`
    + ` · 왕복비용 주식 ${(result.thresholds.roundTripCostRate * 100).toFixed(2)}%`
    + ` / ETF ${(result.thresholds.etfRoundTripCostRate * 100).toFixed(2)}%\n`,
  );

  // 거른 것도 함께 센다 — 통과한 것만 보이면 왜 이것뿐인지 알 수 없다.
  for (const verdict of Object.keys(VERDICT_LABEL) as ScreeningVerdict[]) {
    console.log(`  ${VERDICT_LABEL[verdict].padEnd(34)} ${(counts.get(verdict) ?? 0).toString().padStart(4)}`);
  }
  console.log();

  if (passed.length === 0) {
    console.log('통과한 종목이 없다.');
    if (result.rows.length > 0) {
      const cheapest = Math.min(...result.rows.map((row) => row.price));
      console.log(`(확인한 것 중 가장 싼 종목이 ${cheapest.toLocaleString('ko-KR')}원)`);
    }
    return;
  }

  console.log(`필터를 통과한 종목 ${passed.length} (등락률 순)`);
  for (const row of passed) console.log(formatRow(row));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
