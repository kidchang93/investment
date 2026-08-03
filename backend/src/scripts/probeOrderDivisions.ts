/**
 * `ORD_DVSN`(주문구분) 코드 중 **어느 것이 실제로 받아들여지는지** 묻는다.
 *
 * ── 왜 필요한가 ───────────────────────────────────────────────────────────
 *
 * 시간외 매도를 만들려면 그 주문구분 코드를 알아야 하는데, 이 레포가 실측으로
 * 아는 것은 `00`(지정가)·`01`(시장가) 둘뿐이다. 공식 GitHub 예제(`order_cash.py`)는
 * 값을 열거하지 않고 "[필수] 주문구분"이라고만 적혀 있다. 웹 검색으로 나오는
 * 표는 옛 eFriend API 것이라 **이 레포가 실제로 검증한 값과 어긋난다**
 * (검색 결과: `01:시장가, 02:지정가` — 우리는 `00`이 지정가인 것을 오늘 주문으로 확인했다).
 *
 * ── 주문을 내지 않고 묻는 법 ──────────────────────────────────────────────
 *
 * 매수가능조회(`inquire-psbl-order`)가 `ORD_DVSN`을 인자로 받는다. **조회다.**
 * 모르는 코드를 넣었을 때 KIS가 거절하면 그 코드는 없는 것이고, 정상 응답하면
 * 적어도 그 자리에서는 유효한 값이다.
 *
 * 이것으로 **알 수 있는 것**: 그 코드가 존재하는가.
 * 이것으로 **알 수 없는 것**: 그 코드로 지금 주문이 나가는가. 시간대·종목 상태에
 * 따라 주문은 따로 거절될 수 있다. 그건 실제 주문으로만 확인된다.
 *
 * 조회 전용이다. 주문을 내지 않는다.
 *
 *   npx tsx src/scripts/probeOrderDivisions.ts [accountId] [symbol]
 */

import { config, getKisAccount } from '../config.js';
import { probeOrderDivision } from '../kis/rest.js';

/** 물어볼 후보. 이름은 흔히 알려진 것이고 **참인지가 이 스크립트의 질문이다**. */
const CANDIDATES: Array<[string, string]> = [
  ['00', '지정가 (이 레포가 실측으로 아는 값)'],
  ['01', '시장가 (이 레포가 실측으로 아는 값)'],
  ['02', '조건부지정가?'],
  ['03', '최유리지정가?'],
  ['04', '최우선지정가?'],
  ['05', '장전 시간외?'],
  ['06', '장후 시간외?'],
  ['07', '시간외 단일가?'],
  ['11', 'IOC 지정가?'],
  ['12', 'FOK 지정가?'],
  ['99', '없는 코드 (대조군 — 이게 통과하면 이 시험은 아무것도 못 가른다)'],
];

const accountId = process.argv[2] ?? 'VTS-ORDINARY';
const symbol = process.argv[3] ?? '005930';
const account = getKisAccount(accountId);
if (!account) {
  console.error(`등록된 계좌가 아닙니다: ${accountId}`);
  process.exit(1);
}

const trId = config.env === 'prod' ? 'TTTC8908R' : 'VTTC8908R';
console.log(`계좌 ${account.id} · 종목 ${symbol} · tr_id ${trId}\n`);
console.log('코드  결과      설명');
console.log('─'.repeat(72));

for (const [code, label] of CANDIDATES) {
  const { accepted, message } = await probeOrderDivision(account, symbol, code, 70_000);
  console.log(`${code}    ${accepted ? '받아들임' : '거절    '}  ${label}${accepted ? '' : ` — ${message}`}`);
}

process.exit(0);
