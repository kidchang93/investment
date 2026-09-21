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
 * ⚠ **총보수(운용비용)는 아직 안 들어간다.** KIS가 주지 않는다. 연 0.1%와 0.5%의
 *   차이는 배당 4% 안에서 큰 몫이라, 교체를 실제로 정할 때는 사람이 따로 확인해야
 *   한다. 여기 숫자만으로 갈아타면 보수가 비싼 쪽으로 옮길 수 있다.
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
import { dividendYield, trailingDividendPerShare } from '../trading/dividend.js';

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

/** 1년 전 종가 대비 지금 가격의 수익률(%). 1년치 봉이 없으면 `undefined`. */
async function priceReturn(symbol: string, price: number): Promise<number | undefined> {
  const bars = await getDailyBars(symbol, { from: yearAgo }).catch(() => []);
  const first = bars[0];
  /*
   * ★ 가장 오래된 봉이 **창 시작 근처**여야 1년 수익률이다. 상장한 지 얼마 안 된
   *   종목은 3개월치로 "1년 +40%"를 만들어 낸다 — 30일 안에 시작한 것만 인정한다.
   */
  if (!first || !(first.close > 0) || !(price > 0)) return undefined;
  if (first.tradingDay > kstDaysAgo(335)) return undefined;
  return ((price - first.close) / first.close) * 100;
}

type Row = {
  symbol: string; name: string; held: boolean; value: number;
  price: number; divYield: number | undefined; priceRet: number | undefined;
  total: number | undefined;
};

async function measure(symbol: string, name: string, price: number, held: boolean, value: number): Promise<Row> {
  // 2년을 받아 1년 창을 센다 — 1년만 받으면 창 경계의 건이 통째로 빠진다.
  const records = await getKisDividendSchedule(account!, symbol, kstDaysAgo(730), today).catch(() => []);
  const divYield = dividendYield(trailingDividendPerShare(records, today), price);
  const priceRet = await priceReturn(symbol, price);
  return {
    symbol, name, held, value, price, divYield, priceRet,
    // 한쪽이라도 모르면 합을 내지 않는다 — 0으로 메우면 모르는 쪽이 유리해진다.
    total: divYield === undefined || priceRet === undefined ? undefined : divYield + priceRet,
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
console.log('지난 1년 총수익 = 가격수익률 + 배당수익률 (총보수는 안 들어갔다)');
console.log('⚠ 가격 쪽은 지나간 값입니다 — 높다고 앞으로도 높지 않습니다. 배당 쪽이 그나마 이어지는 값입니다.\n');
console.log('   종목                        가격수익   배당수익   지난1년계   보유');
console.log('─'.repeat(78));
for (const r of rows) {
  console.log(
    `${r.held ? ' ●' : '  '} ${r.name.slice(0, 22).padEnd(24)} `
    + `${pct(r.priceRet).padStart(9)} ${pct(r.divYield).padStart(10)} ${pct(r.total).padStart(10)}  `
    + `${r.held ? won(r.value) : ''}`,
  );
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
const byDividend = [...rows].filter((r) => r.divYield !== undefined).sort((a, b) => b.divYield! - a.divYield!);
const bestDiv = byDividend.find((r) => !r.held);
const heldBelow = byDividend.filter((r) => r.held && bestDiv && r.divYield! < bestDiv.divYield!);
console.log();
if (bestDiv && heldBelow.length > 0) {
  console.log(`★ 배당만 보면 후보 최고는 ${bestDiv.name} ${pct(bestDiv.divYield)}이고, 그보다 낮은 보유가 ${heldBelow.length}종목입니다:`);
  for (const r of heldBelow) console.log(`    ${r.name} 배당 ${pct(r.divYield)} · 가격 ${pct(r.priceRet)} · ${won(r.value)}`);
  console.log('  ※ 배당이 높다고 총수익이 높지는 않습니다 — 커버드콜은 배당을 얹는 대신 상승을 깎습니다.');
  console.log('  ※ 총보수·환헤지·괴리율은 이 표에 없습니다. 갈아타기 전에 확인하세요.');
} else {
  console.log('★ 후보 중에 지금 든 것보다 배당수익률이 높은 것이 없습니다.');
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
