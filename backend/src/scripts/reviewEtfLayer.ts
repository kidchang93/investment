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
import { getDomesticQuotes, getKisDividendSchedule, getKisDomesticAccountSnapshot, getKisRawDailyBars } from '../kis/rest.js';
import { kstDaysAgo, kstToday } from '../kis/normalize.js';
import { getCategoryInstruments } from '../db/instruments.js';
import { getDailyBars } from '../db/dailyBars.js';
import { getLayerPositions } from '../db/layers.js';
import { getNaverEtfIndicators } from '../naver/finance.js';
import { dividendYield, trailingDividendPerShare } from '../trading/dividend.js';
import { annualizedReturn, CONFIRMED_ETF_TAX, feeDrag, taxDrag, yearsBetween } from '../trading/longHold.js';

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

/** `YYYYMMDD`에 days일 더한 날 */
function ymdPlus(ymd: string, days: number): string {
  const t = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
}

/** 그날부터 열흘 안의 첫 거래일 **원주가** 종가. 못 받으면 `undefined` */
async function rawCloseNear(symbol: string, ymd: string): Promise<{ day: string; close: number } | undefined> {
  const bars = await getKisRawDailyBars(symbol, ymd, ymdPlus(ymd, 10)).catch(() => []);
  return bars[0] ? { day: bars[0].tradingDay, close: bars[0].close } : undefined;
}

/**
 * 수익률 넷 — **총수익**(수정주가)과 **가격만**(원주가), 각각 1년과 가진 기간 전부.
 *
 * ★★★ **수정주가는 ETF 분배금까지 조정한다** (2026-09-21 실측 — `kis/rest.ts`
 *     `getKisRawDailyBars` 주석). 그래서 DB 일봉(수정주가)의 수익률은 **배당을 재투자한
 *     총수익**이고, 가격만의 수익률은 원주가로 따로 낸다. 이 함수의 첫 판은 수정주가
 *     수익률을 "가격"이라 부르고 배당을 또 더했다 — **배당을 두 번 셌다.**
 *
 * ★ 원주가는 두 날짜(1년 전·첫봉)만 KIS에 묻는다. 연환산은 두 점이면 되고, 끝점은
 *   지금 현재가라 원주가와 같다(오늘은 조정될 것이 없다).
 */
async function returnsOf(symbol: string, price: number): Promise<{
  total1y: number | undefined; price1y: number | undefined;
  totalCagr: number | undefined; priceCagr: number | undefined;
  years: number | undefined; splitSuspect: boolean;
}> {
  const none = { total1y: undefined, price1y: undefined, totalCagr: undefined, priceCagr: undefined, years: undefined, splitSuspect: false };
  const bars = await getDailyBars(symbol).catch(() => []);
  if (bars.length === 0 || !(price > 0)) return none;

  /*
   * ★ 1년 전 봉이 **창 시작 근처**여야 1년 수익률이다. 상장한 지 얼마 안 된
   *   종목은 3개월치로 "1년 +40%"를 만들어 낸다 — 30일 안에 시작한 것만 인정한다.
   */
  const yearStart = bars.find((b) => b.tradingDay >= yearAgo);
  const hasYear = !!yearStart && yearStart.tradingDay <= kstDaysAgo(335) && yearStart.close > 0;
  const total1y = hasYear ? ((price - yearStart!.close) / yearStart!.close) * 100 : undefined;
  const raw1y = hasYear ? await rawCloseNear(symbol, yearStart!.tradingDay) : undefined;
  const price1y = raw1y ? ((price - raw1y.close) / raw1y.close) * 100 : undefined;

  const first = bars[0]!;
  const years = yearsBetween(first.tradingDay, today);
  /*
   * ★ **3년 미만은 연환산하지 않는다.** 2년치 +60%를 연환산하면 "연 26%"가 되는데
   *   그건 20년을 말해 주지 않는다 — 신생 커버드콜이 대부분 여기 걸린다.
   */
  if (years < 3) return { ...none, total1y, price1y, years };
  const rawFirst = await rawCloseNear(symbol, first.tradingDay);
  /*
   * ⚠ **액면분할을 지나면 원주가가 이어지지 않는다.** 배당만으로 과거 가격을 3배 넘게
   *   낮추려면 20년 내내 연 5.6%를 넘게 줘야 한다 — 그보다 크면 분할을 의심하고 가격
   *   연환산을 내지 않는다.
   */
  const ratio = rawFirst && first.close > 0 ? rawFirst.close / first.close : undefined;
  const splitSuspect = ratio !== undefined && (ratio > 3 || ratio < 0.9);
  return {
    total1y, price1y, years, splitSuspect,
    totalCagr: annualizedReturn(first.close, price, years),
    priceCagr: rawFirst && !splitSuspect ? annualizedReturn(rawFirst.close, price, years) : undefined,
  };
}

type Row = {
  symbol: string; name: string; held: boolean; value: number;
  price: number; divYield: number | undefined;
  /** 1년 가격 수익률(%) — **원주가**. 배당이 빠져 있다 */
  priceRet: number | undefined;
  /** 1년 총수익(%) — **수정주가**. 배당을 재투자한 값이다. 배당을 더하지 않는다 */
  total: number | undefined;
  /** 가진 기간 전부의 총수익 연환산(%) — 수정주가. 3년 미만이면 `undefined` */
  totalCagr: number | undefined;
  /** 가진 기간 전부의 가격 연환산(%) — 원주가. 분할이 의심되면 `undefined` */
  priceCagr: number | undefined;
  longYears: number | undefined;
  splitSuspect: boolean;
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
  const returns = await returnsOf(symbol, price);
  const priceRet = returns.price1y;

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
    // ★ 총수익은 수정주가 그대로다 — 배당을 더하면 두 번 센다(첫 판이 그랬다).
    total: returns.total1y,
    totalCagr: returns.totalCagr,
    priceCagr: returns.priceCagr,
    longYears: returns.years,
    splitSuspect: returns.splitSuspect,
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
console.log('지난 1년 · 가격은 원주가, 총수익은 수정주가(배당 재투자) · 총보수는 둘 다에 이미 들어가 있다');
console.log('⚠ 가격 쪽은 지나간 값입니다 — 높다고 앞으로도 높지 않습니다. 배당 쪽이 그나마 이어지는 값입니다.\n');
console.log('   종목                        가격수익   배당수익     총수익    총보수   보유');
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
console.log(`\n── ${TWENTY}년 지평 · 가진 기간 전부로 연환산, 기간을 함께 본다 ──\n`);
console.log('   종목                        총수익 연환산  가격 연환산    기간   보수 20년 누적   세금 연 깎임  과세');
console.log('─'.repeat(110));
const byLong = [...rows].sort((a, b) => (b.totalCagr ?? -999) - (a.totalCagr ?? -999));
/*
 * ★ 판 해에 차익이 몰리는 종목을 모은다. 기타형(보유기간 과세)은 20년치 차익이
 *   **판 해 한 번에** 배당소득으로 잡혀, 그해 금융소득이 2천만원을 넘으면 넘는 몫이
 *   다른 소득과 합산돼 누진세율로 과세된다. 그 누진은 다른 소득에 달려 있어 계산에
 *   넣지 못하므로 크기만 보인다.
 */
const lumpSale: Array<{ name: string; value: number }> = [];
for (const r of byLong) {
  const drag = feeDrag(r.feePct, TWENTY);
  const tax = CONFIRMED_ETF_TAX[r.symbol];
  /*
   * ★★ 세금 시뮬레이션에는 **가격(원주가)과 배당 몫을 갈라서** 넣는다. 배당 몫은
   *    총수익과 가격의 차 — 그 기간에 실제로 재투자된 배당의 평균 효과다.
   *    첫 판은 총수익(수정주가)을 "가격"으로 넣고 현재 배당률을 또 재투자해 두 번 셌다.
   */
  const divShare = r.totalCagr !== undefined && r.priceCagr !== undefined
    ? ((1 + r.totalCagr / 100) / (1 + r.priceCagr / 100) - 1) * 100 : undefined;
  const t = tax && r.priceCagr !== undefined && divShare !== undefined
    ? taxDrag(r.priceCagr, divShare, TWENTY, tax.type) : undefined;
  if (tax?.type === 'holdingPeriod' && r.held && r.value > 0) lumpSale.push({ name: r.name, value: r.value });
  console.log(
    `${r.held ? ' ●' : '  '} ${r.name.slice(0, 22).padEnd(24)} `
    + `${pct(r.totalCagr).padStart(12)} ${(pct(r.priceCagr) + (r.splitSuspect ? '?' : '')).padStart(11)} `
    + `${(r.longYears === undefined ? '—' : `${r.longYears.toFixed(1)}년`).padStart(7)} `
    + `${(drag === undefined ? '—' : `−${drag.toFixed(2)}%`).padStart(14)} `
    + `${(t === undefined ? '—' : `−${t.dragPct.toFixed(2)}%p`).padStart(13)}  `
    + `${tax === undefined ? '모름' : tax.type === 'domestic' ? '차익 비과세' : '보유기간과세'}`,
  );
}
console.log('  ※ 총수익−가격 = 그 기간 배당이 보탠 몫입니다. 둘의 차가 크면 배당형, 작으면 차익형입니다.');
if (rows.some((r) => r.splitSuspect)) console.log('  ※ ?는 액면분할이 의심돼 원주가가 안 이어지는 종목입니다 — 가격 연환산을 내지 않았습니다.');
console.log('  ※ 세금 연 깎임 = 가격과 배당 몫을 갈라 배당을 세후로 재투자하며 20년 들고 판 결과의 세전−세후 차이입니다.');
console.log('    기타형은 매매차익 **전액**을 과세 대상으로 봤습니다(실제는 Min(차익, 과표증분)) — 상한입니다.');
console.log('  ※ 과세 "모름"은 운용사 원문으로 확인하지 않은 종목입니다. 이름으로 짐작하지 않습니다.');
/*
 * ★★ **"차익이 X억"이 아니라 "연 몇 %만 넘어도"로 적는다.** 첫 판은 과거 연환산으로
 *    20년 차익을 투영해 "4.8억 원"이라고 적었는데, 그건 금현물 4.8년치 연 23%를
 *    20년 늘린 것(67배)이라 과장이다. 알고 싶은 것은 **2천만원 문턱을 넘느냐**이고,
 *    그 문턱 수익률은 보유 금액만으로 정확히 나온다 — 가정이 필요 없다.
 *      value × ((1+g)^20 − 1) = 2천만  →  g = (1 + 2천만/value)^(1/20) − 1
 *    배당은 뺐다(두 기타형 모두 0~1%라 문턱을 거의 안 움직인다).
 */
const LUMP_THRESHOLD = 20_000_000;
if (lumpSale.length > 0) {
  console.log('\n  ★ 기타형은 20년치 차익이 **판 해 한 번에** 금융소득으로 잡힙니다:');
  for (const l of lumpSale) {
    const hurdle = ((1 + LUMP_THRESHOLD / l.value) ** (1 / TWENTY) - 1) * 100;
    console.log(`    ${l.name} 지금 보유분(${won(l.value)})은 20년 연 ${hurdle.toFixed(1)}%만 넘어도 판 해 금융소득 2천만원을 넘어 **종합과세** 대상입니다`);
  }
  console.log('    나눠 팔거나(해마다 2천만원 안쪽) 차익 비과세형으로 옮기면 피합니다. 누진세율은 다른 소득에 달려 있어 계산에 넣지 않았습니다.');
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
