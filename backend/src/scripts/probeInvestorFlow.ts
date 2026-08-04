/**
 * 수급(투자자별 매매동향)이 실제로 오는지, 과거 며칠까지 오는지 본다.
 *
 * ── 이 스크립트가 답해야 할 것 ────────────────────────────────────────────
 *
 * 1. 모의 서버에 이 TR이 있나 (없으면 `EGW02006`)
 * 2. 한 번 부르면 **며칠치**가 오나 — 지속성을 재려면 며칠이 필요한지 정해야 한다
 * 3. 순매수 합이 0에 가까운가 — 개인 + 외국인 + 기관이 서로의 반대편이므로
 *    합이 0에서 크게 벗어나면 **내가 필드를 잘못 읽은 것**이다
 *
 * 3번이 검산이다. 값을 받아 놓고 맞는지 모르면 그 위에 쌓는 측정이 전부 헛것이 된다.
 *
 * 조회 전용이다. 주문을 내지 않는다.
 *
 *   npx tsx src/scripts/probeInvestorFlow.ts [symbol] [YYYYMMDD]
 */

import { getKisAccount, config } from '../config.js';
import { getInvestorFlowDaily, toCredentials } from '../kis/rest.js';

const symbol = process.argv[2] ?? '005930';
const endDate = process.argv[3] ?? '20260803';

/*
 * 모의 서버에 없는 TR일 수 있으므로 실전 자격증명이 있으면 그것으로 묻는다.
 * 조회 전용이고 주문에는 절대 쓰지 않는다 — 개장일 조회와 같은 취급이다.
 */
const prodId = process.env.KIS_OPEN_DAY_CREDENTIAL_ID;
const account = prodId ? getKisAccount(prodId) : null;
const credentials = account ? { ...toCredentials(account), crossServerRead: true } : undefined;
console.log(`종목 ${symbol} · 기준일 ${endDate} · 자격증명 ${account?.id ?? `기본(${config.env})`}\n`);

try {
  const days = await getInvestorFlowDaily(symbol, endDate, credentials);
  console.log(`받은 거래일 ${days.length}일\n`);
  if (days.length === 0) {
    console.log('빈 응답이다 — 필드 이름이 다르거나 이 종목·날짜에 자료가 없다.');
    process.exit(0);
  }

  console.log('거래일       종가        개인       외국인        기관     합(검산)');
  console.log('─'.repeat(72));
  let worstImbalance = 0;
  for (const day of days) {
    const sum = day.individual + day.foreign + day.institution;
    // 셋의 합이 0에서 얼마나 벗어나는가. 거래량 대비로 봐야 크기를 안다.
    const scale = Math.max(Math.abs(day.individual), Math.abs(day.foreign), Math.abs(day.institution), 1);
    worstImbalance = Math.max(worstImbalance, Math.abs(sum) / scale);
    console.log(
      `${day.tradingDay}  ${day.close.toLocaleString().padStart(9)}`
      + `  ${day.individual.toLocaleString().padStart(10)}`
      + `  ${day.foreign.toLocaleString().padStart(10)}`
      + `  ${day.institution.toLocaleString().padStart(10)}`
      + `  ${sum.toLocaleString().padStart(11)}`,
    );
  }
  console.log();
  console.log(`합의 최대 불균형(가장 큰 항 대비): ${(worstImbalance * 100).toFixed(1)}%`);
  console.log(
    worstImbalance < 0.5
      ? '→ 셋이 서로의 반대편으로 보인다. 필드를 맞게 읽고 있다.'
      : '→ ★ 합이 크게 남는다. 기타법인·국가 같은 주체가 더 있거나 필드를 잘못 읽었다.',
  );
} catch (e) {
  console.log(`실패: ${e instanceof Error ? e.message : String(e)}`);
}

process.exit(0);
