/**
 * 예약주문 조회가 왜 실패하는지 **원래 오류를 그대로** 본다.
 *
 * 화면에는 `KIS 예약주문 조회 실패: 502`만 뜬다. 라우트가 어떤 예외든 502로
 * 뭉개서 KIS가 뭐라고 했는지가 사라진다 — 모의 서버에 그 기능이 없는 것(EGW02006)과
 * 진짜 장애는 고치는 방법이 전혀 다른데 화면에서 같아 보인다.
 *
 * 조회 전용이다. 주문을 내지 않는다.
 */

import { getKisAccount } from '../config.js';
import { getKisDomesticAmendableOrders, getKisDomesticReservedOrders } from '../kis/rest.js';

const accountId = process.argv[2] ?? 'VTS-ORDINARY';
const account = getKisAccount(accountId);
if (!account) {
  console.error(`등록된 계좌가 아닙니다: ${accountId}`);
  process.exit(1);
}

console.log(`계좌 ${account.id} · 서버 ${account.server ?? '(미표기)'}`);
for (const [label, run] of [
  ['예약주문', () => getKisDomesticReservedOrders(account, 30)],
  ['정정취소가능주문', () => getKisDomesticAmendableOrders(account)],
] as const) {
  try {
    await run();
    console.log(`${label}: 성공`);
  } catch (e) {
    console.log(`${label}: 실패 — ${e instanceof Error ? e.message : String(e)}`);
  }
}
process.exit(0);
