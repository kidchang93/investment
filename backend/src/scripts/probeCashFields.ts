/**
 * 잔고 조회가 주는 **현금 관련 필드를 전부** 찍어 본다.
 *
 * 러너는 `cashBalance`(= `dnca_tot_amt` 예수금총액)로 살 수 있는 돈을 판단하는데,
 * 그 값은 D+2 결제 전까지 줄지 않는다. 2026-08-03에 6,250만원어치를 사고도
 * 1억 그대로였다 — 러너에게는 하루 종일 현금이 안 준 것으로 보인다.
 *
 * 어느 필드가 오늘 산 것을 반영하는지 **짐작하지 않고 찍어서 고른다.**
 * 조회 전용이고 주문을 내지 않는다.
 */

import { getKisAccount } from '../config.js';
import { getKisDomesticAccountSnapshot } from '../kis/rest.js';

const accountId = process.argv[2] ?? 'VTS-ORDINARY';
const account = getKisAccount(accountId);
if (!account) {
  console.error(`등록된 계좌가 아닙니다: ${accountId}`);
  process.exit(1);
}

const snapshot = await getKisDomesticAccountSnapshot(account);
console.log('정규화된 값');
console.log(`  cashBalance      ${snapshot.cashBalance?.toLocaleString() ?? '-'}  (D+0 · 오늘 산 것이 안 빠짐)`);
console.log(`  settlementCash   ${snapshot.settlementCash?.toLocaleString() ?? '없음'}  (D+2 · 오늘 주문 반영)`);
console.log(`  stockEvaluation  ${snapshot.stockEvaluation?.toLocaleString() ?? '-'}`);
console.log(`  purchaseAmount   ${snapshot.purchaseAmount?.toLocaleString() ?? '-'}`);
console.log(`  totalEvaluation  ${snapshot.totalEvaluation?.toLocaleString() ?? '-'}`);

/*
 * 원본 요약(output2)을 그대로 본다. KIS 원본 필드명은 여기(scripts)에서만
 * 읽는다 — 프론트로 나가는 경로가 아니다.
 */
const raw = (snapshot as unknown as { raw?: Record<string, string> }).raw;
if (!raw) {
  console.log('\n원본 요약이 스냅샷에 담겨 있지 않다 — rest.ts가 정규화하고 버린다.');
  process.exit(0);
}
console.log('\n원본 요약 중 금액으로 보이는 것');
for (const [key, value] of Object.entries(raw)) {
  if (/amt|excc|cash|psbl/i.test(key)) console.log(`  ${key.padEnd(24)} ${value}`);
}
process.exit(0);
