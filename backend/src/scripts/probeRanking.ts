/**
 * KIS 순위분석 API가 실제로 무엇을 주는지 찍어 본다 (일회성 조사용).
 *
 * "오늘 시장에서 많이 오른 종목"을 앱이 못 보여준다(docs/USER_FINDINGS.md #4).
 * 지금 있는 재료는 스크리닝 40종목인데, 그건 **종목코드 오름차순 앞 40개**라
 * 시장 표본이 아니다 — 그걸 등락률로 정렬해 "시장 상위"라고 부르면 거짓말이 된다.
 *
 * 거래소가 직접 매긴 순위를 받아올 수 있으면 한 번의 호출로 진짜 답이 나온다.
 * 되는지 안 되는지는 추측하지 말고 원문을 찍어 본다.
 *
 *   npx tsx src/scripts/probeRanking.ts
 */

import { config } from '../config.js';
import { getAccessToken, primaryCredentials } from '../kis/auth.js';

async function probe(
  label: string,
  path: string,
  trId: string,
  params: Record<string, string>,
): Promise<void> {
  const token = await getAccessToken(primaryCredentials);
  const url = new URL(path, config.restBase);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  console.log(`\n=== ${label} ===`);
  console.log(`${trId} ${path}`);
  try {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        appkey: primaryCredentials.appKey,
        appsecret: primaryCredentials.appSecret,
        tr_id: trId,
        custtype: 'P',
      },
    });
    const json = (await res.json()) as Record<string, unknown>;
    console.log(`HTTP ${res.status} · rt_cd=${json.rt_cd} · msg_cd=${json.msg_cd} · ${json.msg1}`);
    const rows = (json.output ?? json.output1 ?? json.output2) as Array<Record<string, string>> | undefined;
    if (!Array.isArray(rows) || rows.length === 0) {
      console.log('  행 없음. 원문 키:', Object.keys(json).join(', '));
      return;
    }
    console.log(`  ${rows.length}행. 첫 행 필드:`, Object.keys(rows[0]).join(' '));
    for (const row of rows.slice(0, 8)) {
      console.log('   ', JSON.stringify(row).slice(0, 200));
    }
  } catch (err) {
    console.log('  실패:', err instanceof Error ? err.message : String(err));
  }
}

async function main(): Promise<void> {
  console.log(`env=${config.env} restBase=${config.restBase}`);

  // 등락률 순위
  await probe('등락률 순위 (전체)', '/uapi/domestic-stock/v1/ranking/fluctuation', 'FHPST01700000', {
    fid_cond_mrkt_div_code: 'J',
    fid_cond_scr_div_code: '20170',
    fid_input_iscd: '0000',
    fid_rank_sort_cls_code: '0',
    fid_input_cnt_1: '0',
    fid_prc_cls_code: '0',
    fid_input_price_1: '',
    fid_input_price_2: '',
    fid_vol_cnt: '',
    fid_trgt_cls_code: '0',
    fid_trgt_exls_cls_code: '0',
    fid_div_cls_code: '0',
    fid_rsfl_rate1: '',
    fid_rsfl_rate2: '',
  });

  // 거래량 순위 — 등락률이 막히면 이쪽이 대안이 되는지 본다
  await probe('거래량 순위', '/uapi/domestic-stock/v1/quotations/volume-rank', 'FHPST01710000', {
    fid_cond_mrkt_div_code: 'J',
    fid_cond_scr_div_code: '20171',
    fid_input_iscd: '0000',
    fid_div_cls_code: '0',
    fid_blng_cls_code: '0',
    fid_trgt_cls_code: '111111111',
    fid_trgt_exls_cls_code: '000000',
    fid_input_price_1: '',
    fid_input_price_2: '',
    fid_vol_cnt: '',
    fid_input_date_1: '',
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
