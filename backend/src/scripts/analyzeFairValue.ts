/**
 * **적정가 분석 → 슬랙.** KIS 재무 · 차트 · 뉴스 셋을 합쳐 5분마다 보낸다.
 *
 * ── 왜 (2026-09-03) ──────────────────────────────────────────────────────
 *
 * 사용자가 정했다 — *"분석가는 KIS와 차트분석 및 웹 뉴스 이 세가지를 분석해서
 * 적정가를 슬랙으로 5분마다 메세지 보내줘"*, 그리고 그 앞에 —
 * *"판단자가 그 가격을 보고 매수할지 매도할지 정해서 집행하는 시퀀스."*
 *
 * 그래서 이 스크립트는 **판단하지 않는다.** 적정가만 낸다. 사고파는 결정은
 * 판단자가 이 표를 보고 한다.
 *
 * ── 세 재료 ──────────────────────────────────────────────────────────────
 *
 *   ① KIS      현재가 + 재무(BPS·EPS·ROE) — `getDomesticQuotes`·`getFinancials`
 *   ② 차트     21년 일봉 저장소 — 60일 이동평균 ± 변동성 띠, 과거 배수
 *   ③ 웹 뉴스  네이버 주요 뉴스 — 종목 이름이 걸리면 붙인다
 *
 * ★ **셋을 평균 내지 않는다.** 갈리면 그 자체가 정보다(`trading/fairValue.ts`).
 *
 * ── ★★ 비용을 어떻게 눌렀나 ─────────────────────────────────────────────
 *
 * 5분마다 장중 6.5시간이면 **하루 78회**다. 매번 헤드리스 Claude를 부르면
 * 판단자(하루 1~3회)의 **수십 배**가 된다. 그래서 **Claude를 안 부른다** —
 * 적정가는 재무·차트로 **계산**하고, 뉴스는 제목을 그대로 붙인다.
 *
 * 해석은 판단자가 한다. 그것이 판단자의 일이고, 여기서 또 하면 같은 판단을
 * 두 번 사는 것이다.
 *
 *   비용: KIS 시세 1회 + 종목별 재무 1회(캐시) + 네이버 1페이지. **Claude 0회.**
 *
 * ── 무엇을 안 하나 ───────────────────────────────────────────────────────
 *
 * **주문을 내지 않는다. 판단하지 않는다.** 적정가와 뉴스를 나란히 놓을 뿐이다.
 *
 *   npx tsx src/scripts/analyzeFairValue.ts [계좌id] [--quiet] [--symbols 005930,000660]
 */

import '../config.js';

import type { FinancialSnapshot } from '@invest/shared';

import { getKisAccount } from '../config.js';
import { closeDb, pool } from '../db/client.js';
import { getDailyBars } from '../db/dailyBars.js';
import { getKoreanInstrumentBySymbol } from '../db/instruments.js';
import { getDomesticQuotes, getFinancials, getKisDomesticAccountSnapshot } from '../kis/rest.js';
import { getMainNews } from '../naver/finance.js';
import { escapeMrkdwn, sendSlackBot, slackBotConfigured } from '../notify/slack.js';
import {
  chartBand, combine, describe, fundamentalBand,
  type Bar, type FairValue,
} from '../trading/fairValue.js';

/** 한 회차에 볼 종목 수 상한. 보유 + 인자로 준 것 */
const MAX_SYMBOLS = 12;

/**
 * 재무는 분기마다 바뀐다. 5분마다 다시 받을 이유가 없다.
 * ★ 프로세스가 매번 새로 뜨므로 **DB에 캐시한다** — 메모리 캐시는 소용없다.
 */
const FINANCIAL_TTL_HOURS = 12;

async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_financial_cache (
      symbol     TEXT PRIMARY KEY,
      payload    JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    /*
     * 적정가를 남긴다. **나중에 채점하려면 그때 무엇이라고 했는지가 있어야 한다** —
     * 30일 뒤 실제 주가와 대조해 "이 적정가가 값어치가 있었나"를 답한다.
     */
    CREATE TABLE IF NOT EXISTS trading_fair_values (
      symbol       TEXT NOT NULL,
      measured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      price        DOUBLE PRECISION NOT NULL,
      chart_mid    DOUBLE PRECISION,
      fundamental_mid DOUBLE PRECISION,
      gap          DOUBLE PRECISION,
      basis        TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (symbol, measured_at)
    );
    CREATE INDEX IF NOT EXISTS trading_fair_values_time_idx
      ON trading_fair_values (measured_at DESC);
  `);
}

async function cachedFinancials(symbol: string): Promise<FinancialSnapshot[]> {
  const { rows } = await pool.query<{ payload: FinancialSnapshot[] }>(
    `SELECT payload FROM trading_financial_cache
      WHERE symbol = $1 AND fetched_at > now() - ($2 || ' hours')::interval`,
    [symbol, String(FINANCIAL_TTL_HOURS)],
  );
  if (rows[0]) return rows[0].payload;
  const fresh = await getFinancials(symbol, 8).catch(() => [] as FinancialSnapshot[]);
  await pool.query(
    `INSERT INTO trading_financial_cache (symbol, payload, fetched_at) VALUES ($1, $2, now())
     ON CONFLICT (symbol) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
    [symbol, JSON.stringify(fresh)],
  );
  return fresh;
}

/**
 * **그 종목 자신의 과거 배수**를 일봉과 BPS·EPS로 낸다.
 *
 * ★ 업종 평균을 쓰지 않는 이유는 `trading/fairValue.ts`에 적었다.
 * ★ 과거 재무는 분기 시점의 것인데 우리는 **최신 BPS 하나**만 쓴다 —
 *   그래서 이 배수는 **근사**다. 그 사실을 `basis`에 적어 판단자가 알게 한다.
 */
function pastMultiples(bars: Bar[], value: number | undefined):
{ low: number; mid: number; high: number } | null {
  if (value === undefined || !(value > 0) || bars.length < 120) return null;
  // 최근 2년(약 492거래일)의 배수 분포. 그보다 옛날은 회사가 다른 회사다.
  const recent = bars.slice(-492).map((b) => b.close / value).filter((r) => r > 0);
  if (recent.length < 120) return null;
  const sorted = [...recent].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.floor((sorted.length - 1) * q)];
  return { low: at(0.25), mid: at(0.5), high: at(0.75) };
}

interface Row {
  symbol: string;
  name: string;
  fv: FairValue;
  news: string[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');
  const symArg = args.indexOf('--symbols');
  const extra = symArg >= 0 ? (args[symArg + 1] ?? '').split(',').filter(Boolean) : [];
  const accountId = args.find((a) => !a.startsWith('--') && !extra.includes(a)) ?? 'VTS-ORDINARY';

  await ensureSchema();

  // ── 대상: 보유 + 인자 ──
  const symbols: string[] = [];
  const account = getKisAccount(accountId);
  if (account) {
    try {
      const snap = await getKisDomesticAccountSnapshot(account);
      for (const p of snap.positions) if (p.quantity > 0) symbols.push(p.symbol);
    } catch (error) {
      console.log(`계좌를 못 읽었다 — 인자로 준 종목만 본다 (${(error as Error).message.slice(0, 50)})`);
    }
  }
  for (const s of extra) if (!symbols.includes(s)) symbols.push(s);
  const targets = symbols.slice(0, MAX_SYMBOLS);
  if (targets.length === 0) {
    console.log('볼 종목이 없다.');
    return;
  }

  // ── ① KIS 시세 (한 번에) ──
  const quotes = new Map<string, number>();
  try {
    // ★ `quotes`는 배열이 아니라 **Map<종목코드, Quote>**다. 배열로 알고 돌리면
    //   `[code, quote]` 튜플이 와서 `q.price`가 undefined가 된다(2026-09-03에 그랬다).
    const batch = await getDomesticQuotes(targets);
    for (const [code, q] of batch.quotes) if (q.price > 0) quotes.set(code, q.price);
    if (batch.blank.length > 0) console.log(`  시세가 빈 종목: ${batch.blank.join(' ')}`);
  } catch (error) {
    console.log(`시세를 못 받았다: ${(error as Error).message.slice(0, 60)}`);
  }

  // ── ③ 뉴스 (한 번에) ──
  let news: Array<{ title: string; summary: string }> = [];
  try {
    news = await getMainNews(12);
  } catch {
    // 뉴스가 없어도 적정가는 낸다.
  }

  const rows: Row[] = [];
  for (const symbol of targets) {
    const instrument = await getKoreanInstrumentBySymbol(symbol);
    const name = instrument?.name ?? symbol;
    const price = quotes.get(symbol) ?? 0;
    const missing: string[] = [];
    if (price <= 0) missing.push('현재가 없음');

    // ── ② 차트 ──
    const bars = (await getDailyBars(symbol)).map((b) => ({
      tradingDay: b.tradingDay, close: b.close, high: b.high, low: b.low,
    }));
    const chart = chartBand(bars);
    if (!chart) missing.push(`차트(봉 ${bars.length})`);

    // ── ① 재무 ──
    const fins = await cachedFinancials(symbol);
    const latest = fins[0];
    const fundamental = latest
      ? fundamentalBand(
        { bps: latest.bps, eps: latest.eps, roe: latest.roe },
        pastMultiples(bars, latest.bps),
        pastMultiples(bars, latest.eps),
      )
      : null;
    if (!fundamental) missing.push(latest ? '재무 배수 부족' : '재무 없음');

    // ── ③ 이 종목 뉴스 ──
    const hit = news
      .filter((n) => n.title.includes(name) || n.summary.includes(name))
      .slice(0, 2)
      .map((n) => n.title);

    const fv = combine(symbol, price, chart, fundamental, missing);
    rows.push({ symbol, name, fv, news: hit });

    await pool.query(
      `INSERT INTO trading_fair_values (symbol, price, chart_mid, fundamental_mid, gap, basis)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        symbol, price, chart?.mid ?? null, fundamental?.mid ?? null, fv.gap,
        [chart?.basis, fundamental?.basis].filter(Boolean).join(' | '),
      ],
    );
  }

  // ── 출력 ──
  rows.sort((a, b) => (a.fv.gap ?? 99) - (b.fv.gap ?? 99));
  const lines: string[] = [];
  for (const r of rows) {
    const text = describe(r.fv, r.name);
    console.log(`  ${text}`);
    const mark = r.fv.gap === null ? '·' : r.fv.gap < -0.05 ? '🟢' : r.fv.gap > 0.05 ? '🔴' : '⚪';
    lines.push(`${mark} ${escapeMrkdwn(text)}`);
    for (const n of r.news) {
      console.log(`      · ${n}`);
      lines.push(`     _${escapeMrkdwn(n)}_`);
    }
  }

  if (quiet) { console.log('\n(--quiet — 슬랙으로 보내지 않았다)'); return; }
  if (!slackBotConfigured()) {
    console.log('\n봇이 설정돼 있지 않다 — BOT_TOKEN·SLACK_BRIEFING_CHANNEL이 필요하다.');
    return;
  }
  const now = new Date().toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const header = `💹 *적정가 분석* — ${now}\n_지금 값이 그 종목의 차트·재무 궤적 대비 어디쯤인가. 🟢 −5% 이하 · 🔴 +5% 이상_`;
  const sent = await sendSlackBot([header, ...lines].join('\n'));
  console.log(sent ? '\nstock-briefing 채널로 보냈다.' : '\n보내지 못했다.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
