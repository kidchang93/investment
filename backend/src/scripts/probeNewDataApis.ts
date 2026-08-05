/**
 * 아직 안 써 본 KIS 조회 API가 **무엇을 주는지 찍어 본다.**
 *
 * 필드 이름을 문서에서 베끼면 어긋난다 — 이 레포는 KIS가 값 없는 자리에 빈
 * 문자열을 주고, 문서에 없는 필드를 주고, 문서에 있는 필드를 안 주는 것을
 * 여러 번 겪었다. **먼저 찍고 그 다음 타입을 짓는다.**
 *
 * 조회 전용이다. 주문을 내지 않는다.
 */

import { getKisAccount } from '../config.js';
import { probeRawQuery } from '../kis/rest.js';

const account = getKisAccount(process.env.KIS_OPEN_DAY_CREDENTIAL_ID ?? '21')!;
const cases: Array<[string, string, string, Record<string, string>]> = [
  ['공매도 일별', '/uapi/domestic-stock/v1/quotations/daily-short-sale', 'FHPST04830000',
    { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930', FID_INPUT_DATE_1: '20260201', FID_INPUT_DATE_2: '20260803' }],
  ['신용잔고 일별', '/uapi/domestic-stock/v1/quotations/daily-credit-balance', 'FHPST04760000',
    { FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '20476', FID_INPUT_ISCD: '005930', FID_INPUT_DATE_1: '20260803' }],
  ['대차거래 일별', '/uapi/domestic-stock/v1/quotations/daily-loan-trans', 'HHPST074500C0',
    { MRKT_DIV_CLS_CODE: '1', MKSC_SHRN_ISCD: '005930', START_DATE: '20260701', END_DATE: '20260803', CTS: '' }],
  ['프로그램매매 일별', '/uapi/domestic-stock/v1/quotations/program-trade-by-stock-daily', 'FHPPG04650201',
    { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: '005930', FID_INPUT_DATE_1: '20260803' }],
];
for (const [label, path, trId, params] of cases) {
  try {
    const body = await probeRawQuery(account, path, trId, params);
    console.log(`\n══ ${label} · rt_cd=${body.rt_cd}`);
    /*
     * `output`·`output1`·`output2`를 **전부** 본다. 하나만 보면 요약만 읽고
     * 일별 행을 통째로 놓친다 — 공매도 조회에서 실제로 그럴 뻔했다.
     */
    for (const key of ['output', 'output1', 'output2']) {
      const out = body[key] as unknown;
      if (out === undefined) continue;
      const rows = Array.isArray(out) ? out : [out];
      if (rows.length === 0) { console.log(`   ${key}: 빈 배열`); continue; }
      console.log(`   ${key} (${rows.length}행) 필드: ${Object.keys(rows[0] as object).join(', ')}`);
      console.log(`     첫행: ${JSON.stringify(rows[0]).slice(0, 260)}`);
    }
  } catch (e) {
    console.log(`\n══ ${label} · 실패: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
  }
}
process.exit(0);
