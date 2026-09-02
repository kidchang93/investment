/**
 * 수급(투자자별 매매동향)이 **어느 해부터 실제 값으로 오나**를 잰다.
 *
 * ── 왜 따로 필요한가 (2026-09-02) ────────────────────────────────────────
 *
 * `probeInvestorFlow`로 2005년을 물었더니 **30일이 정상으로 왔다** — 날짜도
 * 종가(수정주가 9,780원)도 그 시절 값이 맞다. 그런데 순매수 3열이 **전부 0**이다.
 *
 * ★★ 그런데 그 스크립트의 검산은 **통과했다**. "개인+외국인+기관의 합이 0에
 *    가까우면 필드를 맞게 읽고 있다"인데, **전부 0이면 합도 0**이다. 검산이
 *    *데이터가 없는 것*과 *맞게 읽는 것*을 구별하지 못한다. 그 상태로 21년치를
 *    받아 측정에 넣었으면 **없는 구간을 "순매수 0"이라는 사실로 읽었을 것**이다.
 *
 * 그래서 여기서는 합이 아니라 **0이 아닌 날의 비율**을 센다. 그것이 진짜
 * 가용 구간이고, 수급 축을 walk-forward에 태울 수 있는지가 여기서 갈린다.
 *
 * ── 무엇을 답하나 ────────────────────────────────────────────────────────
 *
 * 1. 실제 값이 오는 **가장 이른 해**
 * 2. 그 구간에서 종목당 몇 번 불러야 하나 → 21년 일봉이 131,734회에 7시간
 *    9분이었으므로 그 비율로 예상 시간이 나온다
 *
 * 조회 전용이다. 주문을 내지 않는다.
 *
 *   npx tsx src/scripts/probeFlowDepth.ts [종목...]
 */

import { config, getKisAccount } from '../config.js';
import { getInvestorFlowDaily, toCredentials } from '../kis/rest.js';

/*
 * 모의 서버에 없을 수 있는 TR이라 실전 자격증명이 있으면 그것으로 묻는다.
 * 조회 전용이고 주문에는 절대 쓰지 않는다 — 개장일 조회와 같은 취급이다.
 */
const prodId = process.env.KIS_OPEN_DAY_CREDENTIAL_ID;
const account = prodId ? getKisAccount(prodId) : null;
const credentials = account ? { ...toCredentials(account), crossServerRead: true } : undefined;

const args = process.argv.slice(2);

/**
 * 기준일. `--dates 20060101,20060401` 로 주면 그것만 본다 — 연 단위로 훑어
 * 경계를 찾은 뒤 그 안을 좁힐 때 쓴다.
 */
const dateArg = args.indexOf('--dates');
const CUSTOM_DATES = dateArg >= 0 ? (args[dateArg + 1] ?? '').split(',').filter(Boolean) : [];

/**
 * 잴 종목. **한 종목만 보고 판정하지 않는다** — 그 종목이 그 시절 상장 전이거나
 * 거래가 없었을 수 있다. 오래 상장돼 있던 대형주를 섞는다.
 */
const symbolArgs = dateArg >= 0 ? args.slice(0, dateArg) : args;
const SYMBOLS = symbolArgs.length > 0
  ? symbolArgs
  : ['005930', '000660', '005490', '015760'];

/** 2005년부터 두 해씩. 경계는 `--dates`로 좁혀서 다시 본다. */
const YEARS = [2005, 2007, 2009, 2011, 2013, 2015, 2017, 2019, 2021, 2023, 2025];
const DATES = CUSTOM_DATES.length > 0 ? CUSTOM_DATES : YEARS.map((y) => `${y}0601`);

type Probe = { date: string; symbol: string; days: number; nonZero: number };

const results: Probe[] = [];

console.log(`수급 가용 구간 조사 · 자격증명 ${account?.id ?? `기본(${config.env})`}`);
console.log(`종목 ${SYMBOLS.join(', ')}\n`);
console.log('  기준일     종목      받은날   값이 있는 날   비율');
console.log('─'.repeat(56));

for (const date of DATES) {
  for (const symbol of SYMBOLS) {
    try {
      const days = await getInvestorFlowDaily(symbol, date, credentials);
      // ★ 셋이 **모두** 0인 날만 "없음"으로 센다. 한 주체만 0인 날은 정상이다.
      const nonZero = days.filter(
        (d) => d.individual !== 0 || d.foreign !== 0 || d.institution !== 0,
      ).length;
      results.push({ date, symbol, days: days.length, nonZero });
      const ratio = days.length > 0 ? (nonZero / days.length) * 100 : 0;
      console.log(
        `  ${date}  ${symbol}  ${String(days.length).padStart(8)}`
        + `  ${String(nonZero).padStart(11)}  ${ratio.toFixed(0).padStart(5)}%`,
      );
    } catch (error) {
      console.log(`  ${date}  ${symbol}  ${(error as Error).message}`);
    }
    // KIS 유량을 아낀다. 장중에 돌 수 있으므로 화면·감시와 다투지 않게 한다.
    await new Promise((r) => setTimeout(r, 250));
  }
}

console.log();

const byDate = new Map<string, { days: number; nonZero: number }>();
for (const r of results) {
  const acc = byDate.get(r.date) ?? { days: 0, nonZero: 0 };
  acc.days += r.days;
  acc.nonZero += r.nonZero;
  byDate.set(r.date, acc);
}

const firstUsable = [...byDate.entries()]
  .sort((a, b) => a[0].localeCompare(b[0]))
  .find(([, v]) => v.days > 0 && v.nonZero / v.days > 0.5);

if (!firstUsable) {
  console.log('★ 어느 해에도 값이 절반 넘게 오지 않는다 — 이 TR로는 과거 수급을 못 받는다.');
  process.exit(0);
}

const [startDate] = firstUsable;
const startYear = Number(startDate.slice(0, 4));
const thisYear = new Date().getFullYear();
const years = thisYear - startYear + 1;
const tradingDays = Math.round(years * 246);
const callsPerSymbol = Math.ceil(tradingDays / 30);

console.log(`★ 값이 실제로 오는 가장 이른 기준일: ${startDate} (조사한 것 중)`);
console.log(`   → ${years}년 · 거래일 약 ${tradingDays.toLocaleString()}일`);
console.log(`   → 한 번에 30일이므로 종목당 ${callsPerSymbol}회`);
console.log();
console.log('   유니버스 크기별 예상 (21년 일봉이 131,734회에 7시간 9분이었다)');
for (const n of [300, 1000, 2000, 3900]) {
  const calls = n * callsPerSymbol;
  const hours = (calls / 131734) * 7.15;
  console.log(
    `     ${String(n).padStart(5)}종목  ${calls.toLocaleString().padStart(9)}회`
    + `  약 ${hours.toFixed(1)}시간`,
  );
}
