/**
 * 수급이 **이어지는가**를 잰다. (사용자 가설 ①)
 *
 * ── 무엇을 묻나 ──────────────────────────────────────────────────────────
 *
 * *"자본이 많이 투입되고 빠져나가고를 반복한다"*가 참이면, 오늘 외국인이 순매수한
 * 종목은 내일도 순매수일 가능성이 높아야 한다. 그게 아니라 매일 부호가 동전
 * 던지기면 **수급을 신호로 쓸 수 없다** — 오늘 값이 내일에 대해 아무 말도 안 한다.
 *
 * 그래서 이것이 **문지기**다. 여기서 지속성이 없으면 ②(가격 예측)를 잴 이유가 없다.
 *
 * ── 어떻게 재나 ──────────────────────────────────────────────────────────
 *
 * 종목마다 일별 순매수 수량 계열을 받아 **1일 시차 자기상관**을 낸다. 그리고
 * 부호가 이어지는 비율(오늘 +면 내일도 +)도 함께 본다 — 상관계수 하나는 큰 값
 * 몇 개에 끌려가므로, 부호 일치율이 그 왜곡을 드러낸다.
 *
 * **수량을 그대로 쓰지 않고 그날 거래량 대비로 정규화한다.** 종목마다 유통주식
 * 수가 달라 100만주가 어떤 종목에는 크고 어떤 종목에는 작다. 정규화 없이 종목을
 * 섞으면 큰 종목의 수급이 전체를 지배한다.
 *
 * ── 이 측정이 말하지 않는 것 ─────────────────────────────────────────────
 *
 * 지속성이 있어도 **돈이 된다는 뜻이 아니다.** 수급 데이터는 공개돼 있고 무료라
 * 이미 값에 반영됐을 수 있다. 그건 ②에서 따로 잰다.
 *
 * 조회 전용이다. 주문을 내지 않는다.
 *
 *   npx tsx src/scripts/measureFlowPersistence.ts [YYYYMMDD]
 */

import { getKisAccount, config } from '../config.js';
import { getDomesticInstrumentsBySymbols } from '../db/instruments.js';
import { getDomesticTurnoverRanking, getInvestorFlowDaily, toCredentials } from '../kis/rest.js';
import { isOrderableForAutoTrader } from '../trading/universe.js';

const endDate = process.argv[2] ?? '20260803';

const prodId = process.env.KIS_OPEN_DAY_CREDENTIAL_ID;
const account = prodId ? getKisAccount(prodId) : null;
const credentials = account ? { ...toCredentials(account), crossServerRead: true } : undefined;

/** 1차 자기상관. 표본이 모자라면 undefined — 0으로 채우지 않는다. */
function lag1Autocorrelation(series: number[]): number | undefined {
  if (series.length < 5) return undefined;
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < series.length; i += 1) {
    const d = series[i] - mean;
    den += d * d;
    if (i > 0) num += d * (series[i - 1] - mean);
  }
  return den > 0 ? num / den : undefined;
}

/** 오늘 부호가 내일에도 이어지는 비율. */
function signPersistence(series: number[]): { rate: number; pairs: number } | undefined {
  let same = 0;
  let pairs = 0;
  for (let i = 1; i < series.length; i += 1) {
    // 0은 방향이 아니다. 부호가 있는 짝만 센다.
    if (series[i - 1] === 0 || series[i] === 0) continue;
    pairs += 1;
    if (Math.sign(series[i - 1]) === Math.sign(series[i])) same += 1;
  }
  return pairs >= 5 ? { rate: same / pairs, pairs } : undefined;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const symbols = await getDomesticTurnoverRanking(30);
const found = await getDomesticInstrumentsBySymbols(symbols);
const targets = symbols.filter((symbol) => {
  const instrument = found.get(symbol);
  return instrument !== undefined && isOrderableForAutoTrader(instrument);
});

console.log(`기준일 ${endDate} · 자격증명 ${account?.id ?? `기본(${config.env})`}`);
console.log(`표본: 오늘 거래대금 상위 30 중 주문 가능 ${targets.length}종목`);
console.log('★ 오늘 순위로 골랐다 — 과거를 오늘의 눈으로 본 것이라 선정에 look-ahead가 있다.');
console.log('  다만 여기서 재는 것은 수익률이 아니라 **계열의 성질**이라 그 영향이 작다.\n');

interface Row {
  symbol: string;
  name: string;
  days: number;
  foreign?: number;
  institution?: number;
  individual?: number;
  foreignSign?: { rate: number; pairs: number };
}

const rows: Row[] = [];
for (const symbol of targets) {
  const flows = await getInvestorFlowDaily(symbol, endDate, credentials);
  if (flows.length < 6) {
    rows.push({ symbol, name: found.get(symbol)?.name ?? symbol, days: flows.length });
    continue;
  }
  /*
   * 그날 셋의 절대값 합으로 나눈다. 거래량을 따로 안 받아도 그 종목·그날의
   * 매매 규모에 견준 값이 되고, 종목 간 비교가 가능해진다.
   */
  const scale = flows.map((f) => Math.abs(f.individual) + Math.abs(f.foreign) + Math.abs(f.institution));
  const norm = (pick: (f: (typeof flows)[number]) => number): number[] =>
    flows.map((f, i) => (scale[i] > 0 ? pick(f) / scale[i] : 0)).reverse();

  const foreign = norm((f) => f.foreign);
  rows.push({
    symbol,
    name: found.get(symbol)?.name ?? symbol,
    days: flows.length,
    foreign: lag1Autocorrelation(foreign),
    institution: lag1Autocorrelation(norm((f) => f.institution)),
    individual: lag1Autocorrelation(norm((f) => f.individual)),
    foreignSign: signPersistence(foreign),
  });
}

console.log('종목                        일수    외국인ρ    기관ρ    개인ρ   외국인 부호이어짐');
console.log('─'.repeat(82));
for (const row of rows) {
  const fmt = (v?: number): string => (v === undefined ? '     -' : `${v >= 0 ? '+' : ''}${v.toFixed(3)}`);
  const sign = row.foreignSign
    ? `${(row.foreignSign.rate * 100).toFixed(0)}% (${row.foreignSign.pairs}쌍)`
    : '-';
  console.log(
    `${row.name.slice(0, 24).padEnd(26)}${String(row.days).padStart(4)}`
    + `   ${fmt(row.foreign).padStart(7)}  ${fmt(row.institution).padStart(7)}  ${fmt(row.individual).padStart(7)}`
    + `   ${sign}`,
  );
}

const withValue = (pick: (r: Row) => number | undefined): number[] =>
  rows.map(pick).filter((v): v is number => v !== undefined);

const foreignRhos = withValue((r) => r.foreign);
const institutionRhos = withValue((r) => r.institution);
const individualRhos = withValue((r) => r.individual);
const signRates = rows.map((r) => r.foreignSign?.rate).filter((v): v is number => v !== undefined);

console.log('\n── 요약 (종목별 중앙값) ' + '─'.repeat(40));
console.log(`외국인 자기상관  ${median(foreignRhos) >= 0 ? '+' : ''}${median(foreignRhos).toFixed(3)}  (${foreignRhos.length}종목)`);
console.log(`기관   자기상관  ${median(institutionRhos) >= 0 ? '+' : ''}${median(institutionRhos).toFixed(3)}  (${institutionRhos.length}종목)`);
console.log(`개인   자기상관  ${median(individualRhos) >= 0 ? '+' : ''}${median(individualRhos).toFixed(3)}  (${individualRhos.length}종목)`);
console.log(`외국인 부호 이어짐 ${(median(signRates) * 100).toFixed(1)}%  (동전 던지기면 50%)`);
console.log(`양(+)의 자기상관을 보인 종목: 외국인 ${foreignRhos.filter((v) => v > 0).length}/${foreignRhos.length}`);

process.exit(0);
