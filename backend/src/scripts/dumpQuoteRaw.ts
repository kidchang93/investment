/**
 * 현재가 응답 원문 덤프 (일회성 조사용).
 *
 * 동시호가 구간에 KIS가 무엇을 주는지 눈으로 확인하려고 만들었다. 정규장 필드
 * (stck_prpr 등)만 읽고 있는데, 예상체결 필드가 응답에 실제로 오는지 확인해야
 * 프리마켓을 붙일 수 있다. 추측하지 않고 원문을 본다.
 *
 *   npx tsx src/scripts/dumpQuoteRaw.ts 005930
 */

import { config } from '../config.js';
import { getAccessToken, primaryCredentials } from '../kis/auth.js';

async function main(): Promise<void> {
  const code = process.argv[2] ?? '005930';
  const credentials = primaryCredentials;
  const token = await getAccessToken(credentials);

  /*
   * 두 엔드포인트를 나란히 본다. 현재가(FHKST01010100)에는 예상체결 필드가
   * 아예 없고, 호가/예상체결(FHKST01010200)에만 antc_* 가 온다 — 동시호가
   * 구간에 화면이 비는 이유가 여기 있는지 확인한다.
   */
  const targets: Array<{ label: string; path: string; trId: string; outputKeys: string[] }> = [
    {
      label: '현재가 FHKST01010100',
      path: '/uapi/domestic-stock/v1/quotations/inquire-price',
      trId: 'FHKST01010100',
      outputKeys: ['output'],
    },
    {
      label: '호가·예상체결 FHKST01010200',
      path: '/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn',
      trId: 'FHKST01010200',
      outputKeys: ['output1', 'output2'],
    },
  ];

  for (const target of targets) {
    const url = new URL(target.path, config.restBase);
    url.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J');
    url.searchParams.set('FID_INPUT_ISCD', code);

    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        appkey: credentials.appKey,
        appsecret: credentials.appSecret,
        tr_id: target.trId,
        custtype: 'P',
      },
    });
    const json = (await res.json()) as Record<string, unknown> & { msg1?: string };
    console.log(`\n[${new Date().toLocaleTimeString('ko-KR')}] ${target.label} · HTTP ${res.status} · ${json.msg1 ?? ''}`);

    for (const key of target.outputKeys) {
      const output = (json[key] ?? {}) as Record<string, string>;
      const entries = Object.entries(output);
      if (entries.length === 0) continue;
      // output2는 13개뿐이라 전부 찍는다. output1(호가 71개)만 걸러서 본다.
      const interesting = key === 'output2'
        ? entries
        : entries.filter(([k]) => /askp1$|bidp1$|rsqn1$|total_/.test(k));
      console.log(`  ${key} (필드 ${entries.length}개)`);
      for (const [k, v] of interesting) console.log(`    ${k} = ${v}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
