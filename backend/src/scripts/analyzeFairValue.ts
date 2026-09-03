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

import { spawn } from 'node:child_process';

import '../config.js';

import type { FinancialSnapshot } from '@invest/shared';

import { getKisAccount } from '../config.js';
import { closeDb, pool } from '../db/client.js';
import { getDailyBars } from '../db/dailyBars.js';
import { getKoreanInstrumentBySymbol } from '../db/instruments.js';
import {
  getDomesticQuotes, getDomesticTurnoverRanking, getFinancials, getKisDomesticAccountSnapshot,
} from '../kis/rest.js';
import { getMainNews } from '../naver/finance.js';
import { escapeMrkdwn, sendSlackBot, slackBotConfigured } from '../notify/slack.js';
import {
  ASSET_KIND_LABEL, ASSET_KIND_METHOD,
  NEUTRAL_BAND,
  chartBand, classifyAsset, combine, describe, fundamentalBand,
  type AssetKind, type Bar, type FairValue,
} from '../trading/fairValue.js';

/** 한 회차에 볼 종목 수 상한. 보유 + 인자로 준 것 */
const MAX_SYMBOLS = 12;

/**
 * ── 후보 발굴 (2026-09-03) ───────────────────────────────────────────────
 *
 * 사용자가 정했다 — *"보유하지 않는 종목과 주식에 대해서도 적정가 분석을 하는데
 * 워낙 많을 것이니 적정한 기준을 잡고 그 기준 안에서 추천해주는 것도 있으면
 * 좋을 것 같아."*
 *
 * ★ **기준이 곧 이 상수들이다.** 전 종목 3,900개를 5분마다 잴 수는 없고,
 *   잰다 해도 대부분은 살 수 없는 종목이다(유동성·가격).
 *
 *   ① **거래대금 상위** — 자금이 실제로 도는 곳. 여기 없으면 사도 못 판다
 *   ② **차트 6개월** — 적정가를 낼 수 있어야 후보다(`chartBand`가 없으면 뺀다)
 *   ③ **문턱을 넘게 싸야** 추천한다 — 그냥 목록은 판단자에게 짐이다
 *
 * ★ 개별 주식만 후보로 본다. ETF는 층 배분의 문제이지 "싸서 사는" 것이 아니다.
 */
const CANDIDATE_POOL = 40;
/** 이보다 싸야 **절대 기준**으로 추천한다. 판단자를 부르는 문턱(−7%)보다 엄하게 잡는다 */
const RECOMMEND_GAP = -0.10;
/** 추천을 이만큼만 보여준다. 더 길면 안 읽힌다 */
const RECOMMEND_LIMIT = 5;

/**
 * ── ★★ 두 번째 기준: **오늘 후보 사이의 순위** (2026-09-03) ────────────
 *
 * 처음엔 절대 기준 하나만 두었다. 그날 재보니 **13종목 중 추천 0건**이었고,
 * 가장 싼 것이 −4.4%(삼성전자우), 나머지는 +1.6% ~ +145.1%였다.
 *
 * ★★ **문턱을 잘못 잡은 것이 아니라 잼는 법이 그렇다.** 차트 축은 6개월
 *    분포 대비로 재는데, 시장이 6개월간 올랐으면 **지금 값이 항상 그 위에 있다.**
 *    삼성전자 +43%는 "고평가"가 아니라 "6개월 전보다 많이 올랐다"는 말이다.
 *    이미 빠른 판단자 프롬프트에 적어 둔 경고가 실제로 일어난 것이다.
 *
 * 그래서 **같은 날 후보끼리 줄을 세운다.** 시장 전체의 오르내림은 모두에게
 * 같이 얽혀 있으므로, 서로 빼면 상쇄된다. 이 레포가 21년 측정에서 쓴
 * 분위 나누기와 같은 원리다.
 *
 * ★ **그래도 절대 기준을 안 버린다.** 둘 중 하나라도 맞으면 올리고, **어느
 *   기준으로 올라왔는지를 적는다.** 하락장이 오면 상대 기준은 반대로
 *   고장난다 — 전부 싸다고 할 때 가장 덜 싼 것을 골라 올린다. 두 기준이
 *   서로의 구멍을 메운다.
 */
/** 오늘 후보 중 싸기 하위 이만큼을 상대 기준으로 올린다 */
const RECOMMEND_PERCENTILE = 0.2;
/** 분포가 이보다 적으면 "하위 20%"가 뜻이 없다 — 상대 기준을 안 쓴다 */
const MIN_CANDIDATES_FOR_RANK = 8;
/**
 * ★ 상대 기준에도 **천장**이 있다. 첫 판에서 알테오젠이 **+2.2%(비싸다)**인데
 *   하위 20%라는 이유로 ⭐를 달고 올라왔다 — 줄에는 "비싸다"고 적혀 있는데
 *   추천이라 부르면 그 둘 중 하나는 거짓말이다.
 *
 * ★★ **순위가 아무리 낮아도 비싼 것은 추천하지 않는다.** 후보 전부가 비싼
 *    날에는 추천이 0건인 것이 맞다 — 그것이 그날의 사실이다. `describe()`가
 *    "비싸다"를 붙이는 문턱 그 자체(`NEUTRAL_BAND`)를 가져다 쓴다 — 숫자를
 *    베껴 적었더니 5% vs 2%로 어긋나 같은 종목이 "비싸다"이면서 추천이었다.
 */
const RELATIVE_CEILING = NEUTRAL_BAND;

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
  /** 들고 있는 것인가. 브리핑에서 보유와 후보를 갈라 보여준다 */
  held: boolean;
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
  const held = new Set(symbols);
  const targets = symbols.slice(0, MAX_SYMBOLS);

  /*
   * ── 후보: 거래대금 상위 중 **안 들고 있는 개별 주식** ──
   *
   * ★ 자금이 실제로 도는 곳만 본다. 거래대금 순위 밖이면 사도 못 파는 종목이라
   *   적정가가 싸도 쓸모가 없다 — `universe.ts`가 유동성 문을 두는 것과 같은 이유다.
   *
   * ★ ETF는 후보에서 뺀다. ETF는 **층 배분**의 문제이지 "싸서 사는" 것이 아니다
   *   (오늘 판단자도 KODEX 200이 −10%인데 ETF 층이 60.9%라 안 샀다).
   */
  const candidates: string[] = [];
  if (!args.includes('--no-candidates')) {
    try {
      const ranked = await getDomesticTurnoverRanking(CANDIDATE_POOL);
      for (const code of ranked) {
        if (held.has(code) || candidates.length >= CANDIDATE_POOL) continue;
        const inst = await getKoreanInstrumentBySymbol(code);
        if (!inst || classifyAsset(inst.name, inst.assetType) !== 'stock') continue;
        candidates.push(code);
      }
      console.log(`후보 ${candidates.length}종목 (거래대금 상위 ${CANDIDATE_POOL} 중 개별주식, 보유 제외)`);
    } catch (error) {
      console.log(`후보를 못 뽑았다 — 보유만 본다 (${(error as Error).message.slice(0, 50)})`);
    }
  }

  if (targets.length === 0 && candidates.length === 0) {
    console.log('볼 종목이 없다.');
    return;
  }

  // ── ① KIS 시세 (한 번에) ──
  const quotes = new Map<string, number>();
  try {
    // ★ `quotes`는 배열이 아니라 **Map<종목코드, Quote>**다. 배열로 알고 돌리면
    //   `[code, quote]` 튜플이 와서 `q.price`가 undefined가 된다(2026-09-03에 그랬다).
    const batch = await getDomesticQuotes([...targets, ...candidates]);
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
  for (const symbol of [...targets, ...candidates]) {
    const instrument = await getKoreanInstrumentBySymbol(symbol);
    const name = instrument?.name ?? symbol;
    const kind = classifyAsset(name, instrument?.assetType);
    const price = quotes.get(symbol) ?? 0;
    const missing: string[] = [];
    if (price <= 0) missing.push('현재가 없음');

    // ── ② 차트 ──
    const bars = (await getDailyBars(symbol)).map((b) => ({
      tradingDay: b.tradingDay, close: b.close, high: b.high, low: b.low,
    }));
    const chart = chartBand(bars);
    if (!chart) missing.push(`차트(봉 ${bars.length})`);

    /*
     * ── ① 재무 — **개별 주식에만 묻는다** ──
     *
     * ★ ETF에 BPS·PER은 뜻이 없다. 그전에는 전 종목에 물어 KODEX 200에
     *   "재무 없음"이 붙었는데, 그건 **빠진 것이 아니라 애초에 없는 것**이다.
     *   둘을 섞으면 판단자가 "자료가 모자란다"로 읽는다.
     */
    let fundamental = null;
    if (kind === 'stock') {
      const fins = await cachedFinancials(symbol);
      const latest = fins[0];
      fundamental = latest
        ? fundamentalBand(
          { bps: latest.bps, eps: latest.eps, roe: latest.roe },
          pastMultiples(bars, latest.bps),
          pastMultiples(bars, latest.eps),
        )
        : null;
      if (!fundamental) missing.push(latest ? '재무 배수 부족' : '재무 없음');
    }

    // ── ③ 이 종목 뉴스 ──
    const hit = news
      .filter((n) => n.title.includes(name) || n.summary.includes(name))
      .slice(0, 2)
      .map((n) => n.title);

    const fv = combine(symbol, kind, price, chart, fundamental, missing);
    rows.push({ symbol, name, fv, news: hit, held: held.has(symbol) });

    await pool.query(
      `INSERT INTO trading_fair_values (symbol, price, chart_mid, fundamental_mid, gap, basis)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        symbol, price, chart?.mid ?? null, fundamental?.mid ?? null, fv.gap,
        [chart?.basis, fundamental?.basis].filter(Boolean).join(' | '),
      ],
    );
  }

  /*
   * ── 출력 — **갈래로 묶는다** ──
   *
   * 사용자가 짚었다 (2026-09-03) — *"지금은 무슨 기준으로 한지 모르겠어."*
   * 한 줄로 죽 늘어놓으면 KODEX 200과 KB금융이 같은 잣대로 재진 것처럼 보인다.
   * 갈래마다 **무엇으로 냈는지를 머리에 적어** 그 오해를 없앤다.
   */
  const ORDER: AssetKind[] = ['stock', 'indexEtf', 'sectorEtf', 'commodityEtf', 'leveraged'];
  const lines: string[] = [];

  /*
   * ── ★ 추천을 **먼저** 보여준다 ──
   *
   * 보유 현황은 매번 비슷하지만 추천은 바뀐다. 뒤에 두면 안 읽힌다.
   *
   * ★ **문턱을 넘는 것만** 올린다. 그냥 목록은 판단자에게 짐이고, 사람에게는
   *   소음이다 — 40종목을 5분마다 나열하면 아무도 안 본다.
   *
   * ★★ **문턱이 둘이다** — 절대(`RECOMMEND_GAP`)와 상대(`RECOMMEND_PERCENTILE`).
   *    하나만 두면 추세장에서 영영 0건이 된다(2026-09-03 실측). 둘 중 하나라도
   *    맞으면 올리고, **어느 쪽으로 올라왔는지를 줄에 적는다.**
   *
   * ★ **이것은 "사라"가 아니다.** 층 상한·매수여력·`plan`을 세울 수 있는지는
   *   판단자가 본다. 여기서는 *"기준 안에서 싼 것이 이만큼 있다"*까지다.
   */
  const scored = rows.filter((r) => !r.held && r.fv.gap !== null);
  const gapOf = (r: Row): number => r.fv.gap ?? 0;

  /* ① 절대 기준 — 그 종목 자신의 최근 궤적 대비 싸다 */
  const byAbsolute = new Set(scored.filter((r) => gapOf(r) <= RECOMMEND_GAP).map((r) => r.symbol));

  /*
   * ② 상대 기준 — 오늘 후보 중 싸기 하위 RECOMMEND_PERCENTILE
   *
   * ★ 후보가 MIN_CANDIDATES_FOR_RANK보다 적으면 **쓰지 않는다.** 셋 중 하나를
   *   "하위 20%"라고 부르는 것은 순위가 아니라 그냥 최솟값이다.
   */
  const byRelative = new Set<string>();
  let cutoff: number | null = null;
  if (scored.length >= MIN_CANDIDATES_FOR_RANK) {
    const ascending = [...scored].sort((a, b) => gapOf(a) - gapOf(b));
    const k = Math.max(1, Math.floor(ascending.length * RECOMMEND_PERCENTILE));
    cutoff = gapOf(ascending[k - 1]);
    for (const r of ascending.slice(0, k)) {
      if (gapOf(r) < RELATIVE_CEILING) byRelative.add(r.symbol);
    }
  }

  const picks = scored
    .filter((r) => byAbsolute.has(r.symbol) || byRelative.has(r.symbol))
    .sort((a, b) => gapOf(a) - gapOf(b))
    .slice(0, RECOMMEND_LIMIT);

  /* ★ 어느 기준으로 올라왔는지 — 없으면 판단자가 둘을 같게 읽는다 */
  const standardOf = (symbol: string): string => [
    byAbsolute.has(symbol) ? '절대' : null,
    byRelative.has(symbol) ? '상대' : null,
  ].filter(Boolean).join('+');

  const rule = [
    `절대 ${(RECOMMEND_GAP * 100).toFixed(0)}% 이하`,
    cutoff === null
      ? `상대 순위 미사용(후보 ${scored.length} < ${MIN_CANDIDATES_FOR_RANK})`
      : `상대 하위 ${(RECOMMEND_PERCENTILE * 100).toFixed(0)}%(컷 ${(cutoff * 100).toFixed(1)}%, `
        + `천장 +${(RELATIVE_CEILING * 100).toFixed(0)}%)`,
  ].join(' · ');

  if (picks.length > 0) {
    const head = `⭐ *추천* — 거래대금 상위 ${CANDIDATE_POOL} 중 개별주식 ${scored.length}종목에서`;
    console.log(`\n${head}\n   기준: ${rule}`);
    lines.push(head);
    lines.push(`_기준: ${escapeMrkdwn(rule)}_`);
    for (const r of picks) {
      const text = `[${standardOf(r.symbol)}] ${describe(r.fv, r.name)}`;
      console.log(`  ⭐ ${text}`);
      lines.push(`⭐ ${escapeMrkdwn(text)}`);
      for (const n of r.news) lines.push(`     _${escapeMrkdwn(n)}_`);
    }
    /*
     * ★★ **상대 기준의 뜻을 반드시 적는다.** "하위 20%"는 *싸다*가 아니라
     *    *오늘 후보 중 덜 비싸다*이다. 이 줄이 없으면 판단자가 ⭐를 매수
     *    신호로 읽는다 — 시장 전체가 비싸면 그중 가장 덜 비싼 것도 비싸다.
     */
    if (byRelative.size > 0) {
      lines.push('_★ `상대`는 "오늘 후보 중 덜 비싸다"입니다 — 절대적으로 싸다는 뜻이 아닙니다._');
    }
    lines.push('_층 상한·매수여력·계획은 판단자가 봅니다. 이 목록은 "사라"가 아닙니다._');
  } else if (scored.length > 0) {
    console.log(`\n추천 없음 — ${rule}`);
    lines.push(`⭐ _추천 없음 — ${escapeMrkdwn(rule)}_`);
  } else if (rows.some((r) => !r.held)) {
    /*
     * ★ 후보는 있는데 gap을 하나도 못 냈다. **"살 것이 없다"와 다른 사실이다** —
     *   조용히 "추천 없음"으로 적으면 자료가 없는 것을 판단으로 읽는다.
     */
    console.log('\n★ 후보의 적정가를 하나도 못 냈다 — 추천을 낼 수 없다.');
    lines.push('⭐ _★ 후보의 적정가를 하나도 못 냈습니다 — 살 것이 없다는 뜻이 아닙니다._');
  }

  // ── 보유 종목만 갈래별로 ──
  for (const kind of ORDER) {
    const group = rows.filter((r) => r.held && r.fv.kind === kind);
    if (group.length === 0) continue;
    group.sort((a, b) => (a.fv.gap ?? 99) - (b.fv.gap ?? 99));

    console.log(`\n[보유 · ${ASSET_KIND_LABEL[kind]}] ${ASSET_KIND_METHOD[kind]}`);
    lines.push(`\n*보유 · ${ASSET_KIND_LABEL[kind]}*  _${escapeMrkdwn(ASSET_KIND_METHOD[kind])}_`);

    for (const r of group) {
      const text = describe(r.fv, r.name);
      console.log(`  ${text}`);
      const mark = r.fv.gap === null ? '·' : r.fv.gap < -0.05 ? '🟢' : r.fv.gap > 0.05 ? '🔴' : '⚪';
      lines.push(`${mark} ${escapeMrkdwn(text)}`);
      for (const n of r.news) {
        console.log(`      · ${n}`);
        lines.push(`     _${escapeMrkdwn(n)}_`);
      }
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
  const header = `💹 *적정가 분석* — ${now}`
    + `\n_지금 값이 **그 종목의 최근 궤적** 대비 어디쯤인가. 예측이 아니라 기준선이다._`
    + `\n_🟢 −5% 이하(싸다) · ⚪ 그 사이 · 🔴 +5% 이상(비싸다)_`;
  const sent = await sendSlackBot([header, ...lines].join('\n'));
  console.log(sent ? '\nstock-briefing 채널로 보냈다.' : '\n보내지 못했다.');

  if (!args.includes('--no-judge')) await maybeCallJudge(rows, accountId);
}

/**
 * ★★ **분석 뒤에 판단자를 부른다** — 다만 **부를 이유가 있을 때만.**
 *
 * 사용자가 정했다 — *"분석가가 메세지 보낸 후 판단자를 바로 부르면 돼."*
 * 그런데 5분마다 무조건 부르면 **하루 78회**다. 빠른 회차가 2~3분이어도
 * 장중 내내 헤드리스 Claude가 도는 것이고, 대부분은 **5분 전과 같은 상황**이라
 * 같은 판단을 되풀이해 산다.
 *
 * 그래서 문턱을 둔다. 아래 중 하나면 부른다:
 *
 *   ① 적정가가 **문턱을 넘은 종목이 있다** (−7% 이하로 싸거나 +15% 이상 비싸다)
 *   ② 그 종목이 **직전 회차 이후 새로 넘었다** — 같은 신호로 다시 부르지 않는다
 *
 * ★ ②가 없으면 문턱을 넘은 종목이 하나라도 있는 한 5분마다 계속 부른다.
 *   신호가 바뀔 때만 부르는 것이 이 게이트의 핵심이다.
 */
const CHEAP_GATE = -0.07;
const RICH_GATE = 0.15;

async function maybeCallJudge(rows: Row[], accountId: string): Promise<void> {
  const crossed = rows.filter((r) => r.fv.gap !== null && (r.fv.gap <= CHEAP_GATE || r.fv.gap >= RICH_GATE));
  if (crossed.length === 0) {
    console.log('판단자를 부르지 않는다 — 문턱을 넘은 종목이 없다.');
    return;
  }

  /*
   * ★ **같은 신호로 다시 부르지 않는다.** 직전 호출 때 넘어 있던 종목 묶음과
   *   같으면 새 정보가 아니다 — 5분 전과 상황이 같다는 뜻이다.
   */
  const signature = crossed.map((r) => `${r.symbol}:${(r.fv.gap! * 100).toFixed(0)}`).sort().join(',');
  const { rows: last } = await pool.query<{ note: string }>(
    `SELECT note FROM trading_heartbeats
      WHERE name = 'fair-value-judge'
        AND (ran_at AT TIME ZONE 'Asia/Seoul')::date = (now() AT TIME ZONE 'Asia/Seoul')::date
      ORDER BY id DESC LIMIT 1`,
  );
  if (last[0]?.note === signature) {
    console.log(`판단자를 부르지 않는다 — 직전과 같은 신호(${crossed.length}종목).`);
    return;
  }

  console.log(`★ 판단자를 부른다 — 문턱을 넘은 ${crossed.length}종목: ${crossed.map((r) => r.name).join(', ')}`);
  await pool.query(
    `INSERT INTO trading_heartbeats (name, status, note) VALUES ('fair-value-judge', 'ok', $1)`,
    [signature],
  );

  /*
   * ★ 백그라운드로 띄우고 **기다리지 않는다.** 이 스크립트는 5분마다 도는데
   *   판단자는 2~3분 걸린다 — 기다리면 다음 분석이 밀린다.
   *   중복은 스케줄러의 `guard`(pgrep)와 `deliberate.sh`가 막는다.
   */
  const child = spawn('zsh', ['scripts/deliberate.sh', '--quick', accountId], {
    cwd: process.cwd().endsWith('backend') ? '..' : '.',
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
