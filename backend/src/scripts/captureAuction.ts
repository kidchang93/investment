/**
 * 동시호가 구간 예상체결 스냅샷 수집 (일회성 조사용).
 *
 * 장전 동시호가는 08:30~09:00뿐이라 놓치면 다음 기회는 마감 동시호가(15:20)다.
 * 개장 전후로 KIS가 무엇을 주는지 실제로 찍어 두고, 그걸 기준으로 화면을
 * 만든다. 추측한 필드로 만들면 장이 열린 뒤에야 틀린 걸 안다.
 *
 *   npx tsx src/scripts/captureAuction.ts 005930 20 20000
 *   (종목, 반복 횟수, 간격 ms)
 */

import { appendFileSync } from 'node:fs';

import { config } from '../config.js';
import { getAccessToken, primaryCredentials } from '../kis/auth.js';

const OUT = process.env.AUCTION_OUT ?? '/tmp/auction-capture.jsonl';

async function snapshot(code: string, token: string): Promise<Record<string, unknown>> {
  const url = new URL('/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn', config.restBase);
  url.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J');
  url.searchParams.set('FID_INPUT_ISCD', code);
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      appkey: primaryCredentials.appKey,
      appsecret: primaryCredentials.appSecret,
      tr_id: 'FHKST01010200',
      custtype: 'P',
    },
  });
  const json = (await res.json()) as { output2?: Record<string, string>; msg_cd?: string };
  return { at: new Date().toISOString(), clock: new Date().toLocaleTimeString('ko-KR'), code, msg: json.msg_cd, ...json.output2 };
}

async function main(): Promise<void> {
  const code = process.argv[2] ?? '005930';
  const times = Number(process.argv[3] ?? 20);
  const gap = Number(process.argv[4] ?? 20_000);
  const token = await getAccessToken(primaryCredentials);

  for (let i = 0; i < times; i += 1) {
    try {
      const row = await snapshot(code, token);
      appendFileSync(OUT, `${JSON.stringify(row)}\n`);
      console.log(`${row.clock} 구분=${row.antc_mkop_cls_code} 예상가=${row.antc_cnpr} 대비율=${row.antc_cntg_prdy_ctrt} 예상량=${row.antc_vol} 현재가=${row.stck_prpr}`);
    } catch (err) {
      console.error('스냅샷 실패', err);
    }
    if (i < times - 1) await new Promise((r) => setTimeout(r, gap));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
