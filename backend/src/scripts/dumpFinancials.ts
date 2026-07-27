/**
 * KIS 재무 API 원문 덤프 (일회성 조사용).
 *
 * 퀀트 팩터를 붙이기 전에 **무엇이 실제로 오는지부터 본다.** 재무비율·손익계산서·
 * 대차대조표 세 엔드포인트를 같은 종목으로 찔러 필드 이름과 값을 그대로 찍는다.
 * 추측한 필드로 만들면 장 끝나고야 틀린 걸 안다 — 예상체결(antc_cnpr)이 그랬다.
 *
 *   npx tsx src/scripts/dumpFinancials.ts 005930
 */

import { config } from '../config.js';
import { getAccessToken, primaryCredentials } from '../kis/auth.js';

interface Target {
  label: string;
  path: string;
  trId: string;
  /** 분기(0) / 연간(1) 등 추가 파라미터 */
  extra?: Record<string, string>;
}

const TARGETS: Target[] = [
  {
    label: '재무비율',
    path: '/uapi/domestic-stock/v1/finance/financial-ratio',
    trId: 'FHKST66430300',
    extra: { FID_DIV_CLS_CODE: '1' },
  },
  {
    label: '손익계산서',
    path: '/uapi/domestic-stock/v1/finance/income-statement',
    trId: 'FHKST66430200',
    extra: { FID_DIV_CLS_CODE: '1' },
  },
  {
    label: '대차대조표',
    path: '/uapi/domestic-stock/v1/finance/balance-sheet',
    trId: 'FHKST66430100',
    extra: { FID_DIV_CLS_CODE: '1' },
  },
  {
    label: '수익성비율',
    path: '/uapi/domestic-stock/v1/finance/profit-ratio',
    trId: 'FHKST66430400',
    extra: { FID_DIV_CLS_CODE: '1' },
  },
];

async function main(): Promise<void> {
  const code = process.argv[2] ?? '005930';
  const token = await getAccessToken(primaryCredentials);

  for (const target of TARGETS) {
    const url = new URL(target.path, config.restBase);
    url.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J');
    url.searchParams.set('FID_INPUT_ISCD', code);
    for (const [key, value] of Object.entries(target.extra ?? {})) url.searchParams.set(key, value);

    try {
      const res = await fetch(url, {
        headers: {
          authorization: `Bearer ${token}`,
          appkey: primaryCredentials.appKey,
          appsecret: primaryCredentials.appSecret,
          tr_id: target.trId,
          custtype: 'P',
        },
      });
      const json = (await res.json()) as {
        rt_cd?: string;
        msg1?: string;
        msg_cd?: string;
        output?: Array<Record<string, string>>;
      };
      console.log(`\n═══ ${target.label} (${target.trId}) · HTTP ${res.status} · rt_cd=${json.rt_cd} · ${json.msg1?.trim() ?? ''}`);
      const rows = json.output ?? [];
      if (rows.length === 0) {
        console.log('  output 비어 있음');
        continue;
      }
      console.log(`  ${rows.length}행 · 첫 행 필드 ${Object.keys(rows[0]).length}개`);
      for (const [key, value] of Object.entries(rows[0])) console.log(`    ${key} = ${value}`);
    } catch (err) {
      console.log(`\n═══ ${target.label} (${target.trId}) · 호출 실패: ${String(err)}`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
