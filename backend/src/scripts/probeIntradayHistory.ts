/**
 * 과거 분봉을 실제로 얼마나 받을 수 있나 (일회성 조사용).
 *
 * `costHeavy` 문턱(왕복 비용 ÷ 하루 변동폭)이 장 초반에도 하루치 잣대로
 * 걸린다는 것이 실측으로 나왔다. 고칠지 말지를 정하려면 **변동폭이 시간에
 * 따라 어떻게 벌어지는지**를 여러 날·여러 종목에서 봐야 하는데, 지금 있는
 * 것으로 과거를 재구성할 수 있는지부터 확인해야 한다.
 *
 * 일봉에는 하루치 고저만 있어 시간축이 없다. `getInstrumentIntradayCandles`는
 * 오늘 날짜가 박혀 있고(`FID_INPUT_DATE_1: kstToday()`) 한 번에 120봉만 준다.
 * 그래서 여기서 직접 물어본다 — **과거 날짜를 받나, 시각을 지정해 앞 구간도
 * 받을 수 있나, 한 번에 몇 봉인가.** 추측하지 않고 원문을 센다.
 *
 *   npx tsx src/scripts/probeIntradayHistory.ts 005930 20260730
 */

import { config } from '../config.js';
import { getAccessToken, primaryCredentials } from '../kis/auth.js';

/** 한 번에 받은 봉을 시각으로 요약한다. 몇 봉인지·어디부터 어디까지인지만 본다. */
interface Window {
  hour: string;
  rows: number;
  first?: string;
  last?: string;
  date?: string;
  msg: string;
}

async function fetchWindow(code: string, date: string, hour: string, token: string): Promise<Window> {
  const url = new URL('/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice', config.restBase);
  url.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J');
  url.searchParams.set('FID_INPUT_ISCD', code);
  url.searchParams.set('FID_INPUT_HOUR_1', hour);
  url.searchParams.set('FID_INPUT_DATE_1', date);
  url.searchParams.set('FID_PW_DATA_INCU_YN', 'N');
  url.searchParams.set('FID_FAKE_TICK_INCU_YN', '');

  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      appkey: primaryCredentials.appKey,
      appsecret: primaryCredentials.appSecret,
      tr_id: 'FHKST03010230',
      custtype: config.custType,
    },
  });
  const json = (await res.json()) as {
    msg_cd?: string;
    msg1?: string;
    output2?: Array<Record<string, string>>;
  };
  const rows = (json.output2 ?? []).filter((r) => /^\d{6}$/.test(r.stck_cntg_hour ?? ''));
  return {
    hour,
    rows: rows.length,
    first: rows[0]?.stck_cntg_hour,
    last: rows[rows.length - 1]?.stck_cntg_hour,
    date: rows[0]?.stck_bsop_date,
    msg: `${json.msg_cd ?? ''} ${json.msg1 ?? ''}`.trim(),
  };
}

async function main(): Promise<void> {
  const code = process.argv[2] ?? '005930';
  const date = process.argv[3] ?? '20260730';
  const token = await getAccessToken(primaryCredentials);

  console.log(`종목 ${code} · 날짜 ${date} · 서버 ${config.env}\n`);
  // 정규장 390분을 덮으려면 창을 몇 개 붙여야 하는지 세려고 4개를 나눠 물어본다.
  for (const hour of ['235959', '153000', '130000', '110000', '093000']) {
    const win = await fetchWindow(code, date, hour, token);
    console.log(
      `HOUR_1=${win.hour} → ${String(win.rows).padStart(4)}봉`
      + ` · ${win.first ?? '-'} ~ ${win.last ?? '-'}`
      + ` · 날짜 ${win.date ?? '-'}`
      + (win.msg ? ` · ${win.msg}` : ''),
    );
    await new Promise((r) => setTimeout(r, 200));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
