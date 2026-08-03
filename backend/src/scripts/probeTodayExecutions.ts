/**
 * 오늘 접수한 주문이 KIS 쪽에 실제로 남아 있는지 묻는다.
 *
 * 2026-08-03 모의계좌에서 러너가 시장가 매수 4건을 냈고 KIS가 `rt_cd=0`에
 * 주문번호까지 돌려줬는데, 잔고는 예수금 1억 그대로에 보유 0종목이었다.
 * 접수와 체결 사이 어디서 사라졌는지 잔고만으로는 알 수 없어서 체결 조회로 묻는다.
 *
 * 조회 전용이다. 주문을 내지 않는다.
 */

import { getKisAccount } from '../config.js';
import { getKisDomesticExecutions } from '../kis/rest.js';

const accountId = process.argv[2] ?? 'VTS-ORDINARY';
const account = getKisAccount(accountId);

if (!account) {
  console.error(`등록된 계좌가 아닙니다: ${accountId}`);
  process.exit(1);
}

console.log(`계좌 ${account.id} · CANO ${account.cano}-${account.productCode} · 서버 ${account.server ?? '(미표기)'}`);

const snapshot = await getKisDomesticExecutions(account, 1);
console.log(`조회 구간 ${snapshot.from} ~ ${snapshot.to} · ${snapshot.executions.length}건`);
if (snapshot.message) console.log(`메시지: ${snapshot.message}`);

for (const execution of snapshot.executions) {
  console.log(
    [
      execution.orderNo,
      execution.symbol,
      execution.name,
      execution.side,
      `주문 ${execution.orderQuantity}주`,
      `체결 ${execution.filledQuantity}주`,
      `평균체결가 ${execution.averageFilledPrice}`,
      `잔량 ${execution.remainQuantity}주`,
      `거부 ${execution.rejectedQuantity}주`,
      execution.status,
    ].join(' · '),
  );
}

process.exit(0);
