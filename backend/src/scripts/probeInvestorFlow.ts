/**
 * 수급(투자자별 매매동향)이 실제로 오는지, 과거 며칠까지 오는지 본다.
 *
 * ── 이 스크립트가 답해야 할 것 ────────────────────────────────────────────
 *
 * 1. 모의 서버에 이 TR이 있나 (없으면 `EGW02006`)
 * 2. 한 번 부르면 **며칠치**가 오나 — 지속성을 재려면 며칠이 필요한지 정해야 한다
 * 3. **값이 실제로 들어 있나** — 셋이 모두 0인 날을 센다
 *
 * ── ★★ 3번이 원래 검산이 아니었다 (2026-09-02에 바꿨다) ──────────────────
 *
 * 원래 3번은 *"순매수 합이 0에 가까운가 — 아니면 필드를 잘못 읽은 것"*이었다.
 * **그 검산이 두 군데서 틀렸다.**
 *
 * ① **전부 0이면 합도 0이라 늘 통과한다.** 2005-08 삼성전자를 물었더니 30일이
 *    전부 0인데 *"필드를 맞게 읽고 있다"*가 찍혔다. 날짜도 종가도 정상으로
 *    오므로 응답만 보고는 **"그 시절엔 순매수가 0이었다"로 읽힌다.** 그대로
 *    받아 측정에 넣었으면 없는 구간을 사실로 읽었을 것이다.
 * ② **애초에 합은 0이 아니다.** 005930 최근 30일 실측 불균형 **103.3%** —
 *    KRX 분류에는 기타법인·기타외국인이 더 있어 셋만으로는 안 닫힌다.
 *
 * 지금은 ①을 판정하고 ②는 크기만 보여준다. 가용 구간 전체는
 * `probeFlowDepth.ts`가 잰다 — **2005년 10월 말부터 온다**(그 전은 전부 0).
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
  // ★★ **값이 없는 날을 따로 센다** (2026-09-02에 더했다). 아래 불균형 검산은
  //    셋이 **전부 0일 때도 통과한다** — 합이 0이니까. 2005-08 삼성전자를 물었을
  //    때 30일이 전부 0인데 "필드를 맞게 읽고 있다"가 찍혔다. 그 상태로 과거를
  //    받아 측정에 넣으면 **없는 구간을 "순매수 0"이라는 사실로 읽는다.**
  //    가용 구간 전체를 재려면 `probeFlowDepth.ts`를 쓴다.
  let allZeroDays = 0;
  for (const day of days) {
    const sum = day.individual + day.foreign + day.institution;
    if (day.individual === 0 && day.foreign === 0 && day.institution === 0) {
      allZeroDays += 1;
      // 값이 없는 날을 불균형 검산에 넣지 않는다 — 넣으면 검산이 늘 통과한다.
      console.log(
        `${day.tradingDay}  ${day.close.toLocaleString().padStart(9)}`
        + `${'—'.padStart(12)}${'—'.padStart(12)}${'—'.padStart(12)}   (값 없음)`,
      );
      continue;
    }
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
  // ★ 값이 없는 날을 **먼저** 말한다. 이것이 참이면 아래 검산은 뜻이 없다.
  if (allZeroDays > 0) {
    console.log(`★ 셋이 모두 0인 날 ${allZeroDays}/${days.length}일`);
    if (allZeroDays === days.length) {
      console.log('→ ★★ 이 구간에는 수급이 **없다.** 날짜와 종가는 정상으로 오므로');
      console.log('   응답만 보고는 "순매수 0"으로 읽힌다 — 측정에 넣으면 거짓이 된다.');
      console.log('   가용 구간은 probeFlowDepth.ts 로 잰다.');
      process.exit(0);
    }
  }
  // ★★ **"합이 0이어야 한다"는 전제가 틀렸다** (2026-09-02 실측). 005930의 최근
  //    30일에서 최대 불균형이 **103.3%**로 나온다. KRX 분류는 개인·외국인·기관계
  //    말고도 **기타법인·기타외국인**이 있어서 셋만으로는 안 닫힌다. 그러니 이 값이
  //    크다고 필드를 잘못 읽은 것이 아니다 — **이 검산으로는 그것을 못 가른다.**
  //    남겨 두는 이유는 크기를 눈으로 보기 위해서다. 판정은 하지 않는다.
  console.log(`합의 최대 불균형(가장 큰 항 대비): ${(worstImbalance * 100).toFixed(1)}%`);
  console.log('→ 셋(개인·외국인·기관)만으로는 안 닫힌다 — 기타법인·기타외국인이 빠져 있다.');
  console.log('   005930 최근 30일 실측 103.3%. **이 값이 크다고 잘못 읽은 것이 아니다.**');
} catch (e) {
  console.log(`실패: ${e instanceof Error ? e.message : String(e)}`);
}

process.exit(0);
