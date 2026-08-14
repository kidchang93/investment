/**
 * 현재가 응답 원문 덤프 (조사용).
 *
 * 동시호가 구간에 KIS가 무엇을 주는지 눈으로 확인하려고 만들었다. 정규장 필드
 * (stck_prpr 등)만 읽고 있는데, 예상체결 필드가 응답에 실제로 오는지 확인해야
 * 프리마켓을 붙일 수 있다. 추측하지 않고 원문을 본다.
 *
 *   npx tsx src/scripts/dumpQuoteRaw.ts 005930 [000060 ...]
 *
 * ── ★ 빈 칸 요약을 함께 찍는다 (2026-08-14) ─────────────────────────────
 *
 * `rest.ts`의 `requireNumber`가 `toNumber`를 쓴다. **`Number('')`은 0이라 빈 칸이
 * 조용히 0으로 통과한다** — 이름이 `require`인데 아무것도 요구하지 않는다.
 * `optionalNumber`가 똑같은 결함이었고 41군데가 빈 칸을 0으로 읽고 있었다(8/13).
 *
 * 그런데 고치는 순간 **빈 칸이 정상인 경로는 통째로 던진다.** 그래서 먼저
 * "어느 필드가 실제로 비어서 오는가"를 봐야 한다. 종목마다·시간대마다 다르므로
 * 이 스크립트가 그 답을 재는 자리다. **정규장·동시호가·거래정지 종목을 각각 본다.**
 */

import { config } from '../config.js';
import { getAccessToken, primaryCredentials } from '../kis/auth.js';

/** `rest.ts`가 `requireNumber`로 읽는 필드들. 여기가 비면 값이 0으로 지어진다. */
const REQUIRED_FIELDS = [
  'stck_prpr', 'prdy_vrss', 'prdy_ctrt', 'stck_oprc', 'stck_hgpr', 'stck_lwpr', 'acml_vol',
];

async function main(): Promise<void> {
  const codes = process.argv.slice(2);
  const credentials = primaryCredentials;
  const token = await getAccessToken(credentials);
  for (const code of codes.length > 0 ? codes : ['005930']) {
    console.log(`\n${'━'.repeat(70)}\n${code}`);
    await dumpOne(code, credentials, token);
  }
}

async function dumpOne(
  code: string,
  credentials: typeof primaryCredentials,
  token: string,
): Promise<void> {

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
      /*
       * ★ **빈 칸을 먼저 센다.** `Number('')`이 0이라 이 자리들이 값 없이
       * 0으로 통과한다. `'0'`(KIS가 실제로 0이라고 말한 것)과 구별해 적는다 —
       * 둘을 뭉치면 "고쳐야 하나"에 답할 수 없다.
       */
      const blank = entries.filter(([, v]) => typeof v === 'string' && v.trim() === '');
      const zero = entries.filter(([, v]) => typeof v === 'string' && v.trim() === '0');
      console.log(
        `  ${key} (필드 ${entries.length}개 · 빈 칸 ${blank.length} · '0' ${zero.length})`,
      );
      if (blank.length > 0) console.log(`    빈: ${blank.map(([k]) => k).join(' ')}`);
      // ★ 이 자리가 비면 시세 값이 지어진다. 비었는지를 이름과 함께 못 박아 둔다.
      const risky = REQUIRED_FIELDS.filter((f) => f in output && String(output[f]).trim() === '');
      if (risky.length > 0) {
        console.log(`    ★ requireNumber가 읽는 자리가 비었다: ${risky.join(' ')}`);
      }
      // output2는 13개뿐이라 전부 찍는다. output1(호가 71개)만 걸러서 본다.
      const interesting = key === 'output2'
        ? entries
        : entries.filter(([k]) => /askp1$|bidp1$|rsqn1$|total_/.test(k) || REQUIRED_FIELDS.includes(k));
      for (const [k, v] of interesting) console.log(`    ${k} = ${JSON.stringify(v)}`);
    }
    // 모의 서버는 초당 1건이라 250ms로는 500이 난다(2026-08-14 실측).
    await new Promise((r) => setTimeout(r, 1_200));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
