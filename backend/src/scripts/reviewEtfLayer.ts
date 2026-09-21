/**
 * **ETF 층 재평가** — 배당까지 넣어 지금 든 것과 대안을 같은 자로 잰다.
 *
 * ── 왜 생겼나 (2026-09-21) ───────────────────────────────────────────────
 *
 * 사용자가 정했다 — *"etf에서는 배당주들도 있으니 배당까지 계산을 해서 어떤 종목들을
 * 사고 파는게 좋을지 산정해줘야돼 무작정 사놓고 기다리기만하면 안될 것 같아."*
 * 운용 방식도 함께 정했다: **분기 재평가 + 교체**(익절·손절로 굴리지 않는다 —
 * 배당주를 목표가에 팔면 배당락 전후로 이상하게 행동한다).
 *
 * 그전에는 ETF 층이 **감시 밖**이었다. 익절·손절 계획이 없으니 `enforceStops`가
 * 보지 않았고(2026-09-21 보유 12 중 감시 7), 가격만 보면 "−0.79%p짜리 짐"으로
 * 읽혔다. 배당을 넣으니 층이 연 3.29%를 따로 내고 있었고 순서도 뒤집혔다 —
 * 리츠가 평가손 −1.16%에 배당 +9.74%다.
 *
 * ★ **판단하지 않는다.** 줄을 세워 보여 줄 뿐이고 무엇을 팔지는 사람·분석가가 정한다.
 *   이 레포의 다른 계산기들과 같은 자리다(`showFairValues`도 "사라"가 아니다).
 *
 * ★ **총수익 = 12개월 가격수익률 + 12개월 배당수익률.** 둘 중 하나만 보면
 *   고배당·저성장과 무배당·고성장을 견줄 수 없다.
 *
 * ⚠⚠ **둘은 성질이 다르다 — 합을 미래로 읽으면 안 된다.** 배당수익률은 정책이라
 *    어느 정도 이어지지만 **가격수익률은 지나간 것**이다. 2026-09-21 첫 실행에서
 *    KODEX 200이 +134.67%로 1등이었는데(1년 전 47,222원 → 110,820원, 일봉으로 확인한
 *    사실이다) 그것을 "그러니 지수 ETF로 갈아타라"로 읽으면 **폭등 뒤에 추격 매수**가
 *    된다. 이 표가 답하는 것은 *"무엇이 잘했나"*이지 *"무엇이 잘할까"*가 아니다.
 *    ★ 나는 첫 실행에서 이 +134%를 "계산이 틀렸다"고 의심했다 — 틀린 것은 내 감각이었다.
 *
 * ★★ **총보수는 과거 수익률에서 빼지 않는다** (2026-09-21에 바로잡았다). 총보수는
 *    매일 NAV에서 차감되므로 **가격수익률에 이미 들어가 있다** — 또 빼면 이중 차감이다.
 *    그래서 표에 따로 세워 *"앞으로 매년 이만큼 깎인다"*로 읽는다. 같은 지수를 따라가는
 *    두 ETF 중 고를 때가 이 값이 일하는 자리다(보유 중 TIGER 미국S&P500이 0.0068%,
 *    PLUS 고배당주가 0.23%로 34배 차이다).
 *
 * ★ 총보수·괴리율은 **네이버 모바일**에서 온다 — KIS는 주지 않는다(ETF TR 6개와
 *   상품기본조회를 다 뒤졌다). 같은 응답의 배당수익률이 우리 KIS 계산과 다섯 종목
 *   소수점까지 맞아 출처를 믿을 근거가 됐다(`naver/finance.ts`).
 *
 * ★ **분기에 한 번만 실제로 돈다.** 스케줄러는 매일 부르지만 마지막 실행이 90일
 *   안이면 스스로 비킨다(`--force`로 무시). 분기 단위 일정을 스케줄러에 새로 만드는
 *   대신 스크립트가 스스로 아는 쪽을 골랐다 — 날짜 규칙이 두 곳에 갈리지 않는다.
 *
 * 쓰는 법:  cd backend && npx tsx src/scripts/reviewEtfLayer.ts [계좌id] [후보수] [--force] [--notify]
 */
import { getKisAccount } from '../config.js';
import { pool } from '../db/client.js';
import { sendSlack } from '../notify/slack.js';
import { getDomesticQuotes, getKisDividendSchedule, getKisDomesticAccountSnapshot } from '../kis/rest.js';
import { kstDaysAgo, kstToday } from '../kis/normalize.js';
import { getCategoryInstruments } from '../db/instruments.js';
import { getDailyBars } from '../db/dailyBars.js';
import { getLayerPositions } from '../db/layers.js';
import { getNaverEtfIndicators } from '../naver/finance.js';
import { dividendYield, trailingDividendPerShare } from '../trading/dividend.js';
import { annualizedReturn, feeDrag, yearsBetween } from '../trading/longHold.js';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const positional = args.filter((a) => !a.startsWith('--'));
const accountId = positional[0] ?? 'VTS-ORDINARY';
const candidateCount = Number(positional[1]) || 12;
const force = flags.includes('--force');
const notify = flags.includes('--notify');

/*
 * ★ 분기 가드. 하트비트 하나로 판정한다 — 별도 표를 만들지 않는다.
 *   `daily: true`로 매일 걸려도 90일에 한 번만 실제로 돈다.
 */
const HEARTBEAT = 'etf-review';
if (!force) {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM trading_heartbeats
      WHERE name = $1 AND status = 'ok' AND ran_at > now() - interval '90 days'`,
    [HEARTBEAT],
  );
  if (Number(rows[0]?.n ?? 0) > 0) {
    console.log('ETF 층 재평가는 90일 안에 이미 돌았다 — 비킨다 (--force로 무시)');
    process.exit(0);
  }
}
const account = getKisAccount(accountId);
if (!account) {
  console.error(`등록된 계좌가 아닙니다: ${accountId}`);
  process.exit(1);
}

const today = kstToday();
const yearAgo = kstDaysAgo(365);

/**
 * 가격 수익률 둘 — **1년**과 **가진 봉 전부**.
 *
 * ★ 일봉은 수정주가다(`FID_ORG_ADJ_PRC: '0'`) — 액면분할·병합이 이어져 있어 20년을
 *   곧장 나눌 수 있다. 한국 수정주가는 **배당을 조정하지 않으므로** 여기 값에 배당을
 *   더해도 이중 계산이 아니다.
 */
async function priceReturns(symbol: string, price: number): Promise<{
  oneYear: number | undefined; longCagr: number | undefined; longYears: number | undefined; firstDay: string | undefined;
}> {
  const bars = await getDailyBars(symbol).catch(() => []);
  const none = { oneYear: undefined, longCagr: undefined, longYears: undefined, firstDay: undefined };
  if (bars.length === 0 || !(price > 0)) return none;

  /*
   * ★ 1년 전 봉이 **창 시작 근처**여야 1년 수익률이다. 상장한 지 얼마 안 된
   *   종목은 3개월치로 "1년 +40%"를 만들어 낸다 — 30일 안에 시작한 것만 인정한다.
   */
  const yearStart = bars.find((b) => b.tradingDay >= yearAgo);
  const oneYear = yearStart && yearStart.tradingDay <= kstDaysAgo(335) && yearStart.close > 0
    ? ((price - yearStart.close) / yearStart.close) * 100
    : undefined;

  const first = bars[0]!;
  const years = yearsBetween(first.tradingDay, today);
  /*
   * ★ **3년 미만은 연환산하지 않는다.** 2년치 +60%를 연환산하면 "연 26%"가 되는데
   *   그건 20년을 말해 주지 않는다 — 신생 커버드콜이 대부분 여기 걸린다.
   */
  return {
    oneYear,
    longCagr: years >= 3 ? annualizedReturn(first.close, price, years) : undefined,
    longYears: years,
    firstDay: first.tradingDay,
  };
}

type Row = {
  symbol: string; name: string; held: boolean; value: number;
  price: number; divYield: number | undefined; priceRet: number | undefined;
  total: number | undefined;
  /** 가진 봉 전부의 가격 연환산(%). 3년 미만이면 `undefined` */
  longCagr: number | undefined;
  longYears: number | undefined;
  feePct: number | undefined;
  /** 배당을 KIS가 아니라 네이버에서 가져왔나 — KIS 빈 응답을 메운 자리다 */
  divFromNaver: boolean;
  /** 두 출처의 배당이 0.5%p 넘게 갈렸다. 어느 쪽이 맞는지 모르므로 알리기만 한다 */
  divMismatch: number | undefined;
};

async function measure(symbol: string, name: string, price: number, held: boolean, value: number): Promise<Row> {
  // 2년을 받아 1년 창을 센다 — 1년만 받으면 창 경계의 건이 통째로 빠진다.
  const records = await getKisDividendSchedule(account!, symbol, kstDaysAgo(730), today).catch(() => []);
  const kisYield = dividendYield(trailingDividendPerShare(records, today), price);
  const naver = await getNaverEtfIndicators(symbol);
  const returns = await priceReturns(symbol, price);
  const priceRet = returns.oneYear;

  /*
   * ★ **KIS를 먼저 쓰고, 없을 때만 네이버로 메운다.** KIS 배당일정은 정상 응답의
   *   모습으로 비어 올 때가 있다(`kis/rest.ts`) — 그때 종목이 통째로 `—`가 되면
   *   무배당으로 오해된다. 대신 **어느 출처인지 표에 적는다.**
   */
  const divYield = kisYield ?? naver?.dividendYieldTtm;
  const mismatch = kisYield !== undefined && naver?.dividendYieldTtm !== undefined
    && Math.abs(kisYield - naver.dividendYieldTtm) >= 0.5
    ? naver.dividendYieldTtm : undefined;

  return {
    symbol, name, held, value, price, divYield, priceRet,
    // 한쪽이라도 모르면 합을 내지 않는다 — 0으로 메우면 모르는 쪽이 유리해진다.
    total: divYield === undefined || priceRet === undefined ? undefined : divYield + priceRet,
    longCagr: returns.longCagr,
    longYears: returns.longYears,
    feePct: naver?.totalFeePct,
    divFromNaver: kisYield === undefined && naver?.dividendYieldTtm !== undefined,
    divMismatch: mismatch,
  };
}

// ── 지금 든 것 ─────────────────────────────────────────────────────────
const snapshot = await getKisDomesticAccountSnapshot(account);
const etfSymbols = new Set(
  (await getLayerPositions(accountId)).filter((p) => p.layer === 'etf').map((p) => p.symbol),
);
const rows: Row[] = [];
for (const p of snapshot.positions) {
  if (!etfSymbols.has(p.symbol)) continue;
  const price = p.currentPrice ?? 0;
  rows.push(await measure(p.symbol, p.name ?? p.symbol, price, true, price * (p.quantity ?? 0)));
}

// ── 대안 후보 — 배당/커버드콜 ETF 중 거래대금 상위 ──────────────────────
const candidates = (await getCategoryInstruments('kr-etf-income', 60)).filter((i) => !etfSymbols.has(i.symbol));
const quotes = await getDomesticQuotes(candidates.slice(0, 60).map((i) => i.symbol));
const liquid = candidates
  .map((i) => ({ i, q: quotes.quotes.get(i.symbol) }))
  .filter((x) => x.q && (x.q.turnover ?? 0) > 0)
  .sort((a, b) => (b.q!.turnover ?? 0) - (a.q!.turnover ?? 0))
  .slice(0, candidateCount);
for (const { i, q } of liquid) {
  rows.push(await measure(i.symbol, i.name, q!.price ?? 0, false, 0));
}

// ── 표 ─────────────────────────────────────────────────────────────────
const pct = (n: number | undefined): string => (n === undefined ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`);
const won = (n: number): string => `${Math.round(n).toLocaleString('ko-KR')}원`;
rows.sort((a, b) => (b.total ?? -999) - (a.total ?? -999));

console.log(`\nETF 층 재평가 · ${accountId} · ${today}`);
console.log('지난 1년 총수익 = 가격수익률 + 배당수익률 · 총보수는 가격 쪽에 이미 들어가 있다');
console.log('⚠ 가격 쪽은 지나간 값입니다 — 높다고 앞으로도 높지 않습니다. 배당 쪽이 그나마 이어지는 값입니다.\n');
console.log('   종목                        가격수익   배당수익   지난1년계    총보수   보유');
console.log('─'.repeat(88));
for (const r of rows) {
  console.log(
    `${r.held ? ' ●' : '  '} ${r.name.slice(0, 22).padEnd(24)} `
    + `${pct(r.priceRet).padStart(9)} ${(pct(r.divYield) + (r.divFromNaver ? '*' : '')).padStart(10)} `
    + `${pct(r.total).padStart(10)} ${(r.feePct === undefined ? '—' : `${r.feePct}%`).padStart(9)}  `
    + `${r.held ? won(r.value) : ''}`,
  );
}
if (rows.some((r) => r.divFromNaver)) console.log('  * 배당은 네이버 값입니다 — KIS 배당일정이 비어 왔습니다.');
console.log('  ※ 총보수는 매일 NAV에서 빠지므로 위 가격수익에 이미 들어가 있습니다. 앞으로 매년 깎이는 몫으로 보세요.');
const mismatched = rows.filter((r) => r.divMismatch !== undefined);
for (const r of mismatched) {
  console.log(`  ★ ${r.name} 배당이 출처마다 다릅니다 — KIS ${pct(r.divYield)} vs 네이버 ${pct(r.divMismatch)}. 어느 쪽인지 확인하세요.`);
}

/*
 * ★ **"보유가 후보보다 낮다"만 적는다.** 얼마를 팔고 무엇을 사라고는 적지 않는다 —
 *   총보수·환·괴리율이 여기 없고, 교체는 왕복 비용을 무는 결정이라 사람이 본다.
 */
/*
 * ★★ **배당만으로 견준다.** 지난 1년 가격으로 줄 세워 "이보다 낮은 보유"를 적으면
 *    그것은 **폭등한 것을 추격하라**는 말이 된다(첫 실행에서 1등이 +134%짜리 지수
 *    ETF였다). 배당수익률은 정책이라 어느 정도 이어지는 값이라 견줄 만하고,
 *    가격 쪽은 위 표에서 사람이 눈으로 본다.
 */
/*
 * ★ 보수를 뺀 값으로 견준다. 배당은 받는 것이고 보수는 나가는 것이라 둘 다 연율 %다 —
 *   보수를 모르면 0으로 치지 않고 배당만으로 둔다(모르는 쪽이 유리해지지 않게).
 */
const netOf = (r: Row): number => r.divYield! - (r.feePct ?? 0);
const byDividend = [...rows].filter((r) => r.divYield !== undefined).sort((a, b) => netOf(b) - netOf(a));
const bestDiv = byDividend.find((r) => !r.held);
const heldBelow = byDividend.filter((r) => r.held && bestDiv && netOf(r) < netOf(bestDiv));
console.log();
if (bestDiv && heldBelow.length > 0) {
  console.log(`★ 배당−보수로 보면 후보 최고는 ${bestDiv.name} ${pct(netOf(bestDiv))}이고, 그보다 낮은 보유가 ${heldBelow.length}종목입니다:`);
  for (const r of heldBelow) {
    console.log(`    ${r.name} 배당−보수 ${pct(netOf(r))} (배당 ${pct(r.divYield)} − 보수 ${r.feePct ?? 0}%) · 가격 ${pct(r.priceRet)} · ${won(r.value)}`);
  }
  console.log('  ※ 배당이 높다고 총수익이 높지는 않습니다 — 커버드콜은 배당을 얹는 대신 상승을 깎습니다.');
  console.log('  ※ 환헤지 여부와 기초자산이 다르면 같은 자로 견줄 수 없습니다. 갈아타기 전에 확인하세요.');
} else {
  console.log('★ 후보 중에 지금 든 것보다 배당−보수가 높은 것이 없습니다.');
}
/*
 * ── 20년 지평 ────────────────────────────────────────────────────────────
 *
 * ★★ 위 표는 **분기 교체**를 보고 이 표는 **20년 보유**를 본다 — 질문이 다르다.
 *    사용자 기준은 *"배당도 많이 주면서 20년 뒤 시세차익도 충분한"*이다.
 *    가격 연환산은 **가진 봉 전부**(최대 21년)로 내고, 기간을 옆에 적는다 —
 *    6년치 연 18%와 21년치 연 12%는 같은 무게가 아니다.
 */
const TWENTY = 20;
console.log(`\n── ${TWENTY}년 지평 · 가격 연환산은 가진 봉 전부, 기간을 함께 본다 ──\n`);
console.log('   종목                        가격 연환산    기간     배당   보수 20년 누적');
console.log('─'.repeat(80));
const byLong = [...rows].sort((a, b) => (b.longCagr ?? -999) - (a.longCagr ?? -999));
for (const r of byLong) {
  const drag = feeDrag(r.feePct, TWENTY);
  console.log(
    `${r.held ? ' ●' : '  '} ${r.name.slice(0, 22).padEnd(24)} `
    + `${pct(r.longCagr).padStart(11)} ${(r.longYears === undefined ? '—' : `${r.longYears.toFixed(1)}년`).padStart(7)} `
    + `${pct(r.divYield).padStart(8)} ${(drag === undefined ? '—' : `−${drag.toFixed(2)}%`).padStart(14)}`,
  );
}
console.log('  ※ 3년 미만은 연환산하지 않았습니다 — 짧은 기간을 연으로 늘리면 20년을 말해 주지 않습니다.');
console.log('  ※ 지난 수익률은 다음 20년을 보장하지 않습니다. 20년을 실제로 잰 것은 21년치가 있는 종목뿐입니다.');
const tooShort = rows.filter((r) => r.longYears !== undefined && r.longYears < 10);
if (tooShort.length > 0) {
  console.log(`  ★ 10년이 안 되는 ${tooShort.length}종목은 20년 판단 재료가 부족합니다 — 기초자산(지수)의 역사로 따로 봐야 합니다.`);
}

const unknown = rows.filter((r) => r.total === undefined);
if (unknown.length > 0) {
  console.log(`\n★ 총수익을 못 낸 ${unknown.length}종목(배당이나 1년치 봉이 없다): ${unknown.map((r) => r.name).join(' · ')}`);
}

/*
 * ★ 알림은 **보유만** 싣는다. 후보까지 넣으면 슬랙에서 표가 접히고, 무엇보다
 *   "이걸 사라"로 읽힌다. 자세한 것은 사람이 터미널에서 본다.
 */
if (notify) {
  const held = rows.filter((r) => r.held);
  const lines = held.map((r) => `• ${r.name} — 배당 ${pct(r.divYield)} · 가격 ${pct(r.priceRet)} · ${won(r.value)}`);
  await sendSlack(
    `*ETF 층 분기 재평가* (${today})\n지난 1년 성적입니다. 가격 쪽은 지나간 값이니 추격하지 마세요.\n`
    + lines.join('\n')
    + (bestDiv ? `\n\n후보 중 배당 최고: ${bestDiv.name} ${pct(bestDiv.divYield)}` : '')
    + '\n자세한 것: `cd backend && npx tsx src/scripts/reviewEtfLayer.ts`',
  ).catch(() => false);
}
await pool.query(
  `INSERT INTO trading_heartbeats (name, status, note) VALUES ($1, 'ok', $2)`,
  [HEARTBEAT, `보유 ${rows.filter((r) => r.held).length}종목 · 후보 ${rows.filter((r) => !r.held).length}종목`],
);
process.exit(0);
