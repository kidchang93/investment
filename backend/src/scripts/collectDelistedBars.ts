/**
 * **상장폐지 종목의 일봉**을 받아 DB에 쌓는다. 재는 것도 주문도 하지 않는다.
 *
 * ── 왜 따로 있나 (2026-08-13) ────────────────────────────────────────────
 *
 * `collectDailyBars.ts`가 못 받는 쪽이다. 그 스크립트는 `getDomesticHistoryUniverse`
 * (`is_active = true`)에서 유니버스를 받는데, 그 표는 **오늘자 마스터 스냅샷**이라
 * 폐지된 회사가 애초에 없다. 그래서 21년 패널에 상장폐지가 사실상 0건이었다.
 *
 * ★★ **TR이 갈린다. 이게 이 스크립트가 따로 있는 진짜 이유다** (2026-08-13 실측).
 *
 *   `FHKST03010100`(기간별시세) — collectDailyBars가 쓰는 것 → 폐지 종목은 **전부 0행**
 *   `FHPST04830000`(일별 시세·공매도) = `getDailyMarketBars` → **전부 나온다**
 *
 * 실측: 005600 중앙제지(2005-01-06 폐지) · 012460 우영(2008-03-13) ·
 * 089480 평산(2012-04-13) · 117930 한진해운(2017-03-07) 모두 2005년까지 온다.
 *
 * ── 이 TR에 대해 확인한 것 ───────────────────────────────────────────────
 *
 * - **한 번에 100거래일.** 요청 구간이 더 길면 **최근 쪽 100일**을 준다
 *   (117930에 2016-01-01~2017-03-07을 물었더니 2016-10-12~2017-03-06이 왔다).
 *   그래서 구간 끝을 뒤로 밀며 페이징한다 — 빈 쪽을 밟지 않는다.
 * - **응답이 역순이다**(최신 → 과거). 저장 전에 오름차순으로 뒤집는다.
 * - **수정주가다.** 005930의 2018-05-04 액면분할(50:1) 구간을 `FHKST03010100`으로
 *   받아 둔 DB 값과 맞춰 보니 열흘이 전부 같았다. **활성 종목과 같은 자로 잰다.**
 * - 날짜가 없는 빈 행 `{}`으로 응답을 채워 준다. 8자리 날짜가 아닌 행은 버린다.
 * - **폐지일 뒤에도 행을 준다.** 012460은 폐지일(2008-03-13) 다음 두 거래일이
 *   3-12 행의 **글자 그대로 복사**였다. 그래서 구간 끝은 반드시 폐지일이다.
 * - **모의 서버에서도 답한다.** `APP_ENV=vts`로 물어도 21년치가 그대로 왔다.
 *   다만 초당 1건이라 한 번에 1.15초가 든다 — 실전이 훨씬 빠르다.
 *
 * ── 계약 (`db/dailyBars.ts`와 같다) ──────────────────────────────────────
 *
 * - **한 종목의 전 구간은 한 세션에서 통째로.** 중간에 죽으면 그 종목은 버리고
 *   다음 실행이 처음부터 받는다(`vintage`가 섞이면 값으로는 알아볼 수 없다).
 * - **재개 가능하다.** 커서는 활성 수집과 같은 표(`trading_daily_bar_cursor`)를 쓴다.
 * - **못 받은 것을 0으로 채우지 않는다.**
 * - **끝에 붙은 거래량 0 봉은 뗀다**(`trimTrailingZeroVolumeBars`). 005600의
 *   마지막 줄은 거래 없이 +200%였다 — 담으면 폐지 손실이 줄어 보이고
 *   `scanAdjustmentBreaks`가 그 종목의 21년을 통째로 버린다.
 *
 * **주문은 내지 않는다. 조회만 한다.**
 *
 *   npx tsx src/scripts/collectDelistedBars.ts [--limit N] [--symbols 005600,012460]
 *                                              [--from 20050101] [--gap-ms 1200]
 *                                              [--pages 60] [--force] [--dry-run]
 */

import { closeDb } from '../db/client.js';
import { config, getKisAccount, kisServerLabel } from '../config.js';
import { credentialServer, type KisCredentials } from '../kis/auth.js';
import { isRetriableTransportError } from '../kis/errorCodes.js';
import { getDailyMarketBars, isRateLimitedError, toCredentials, type DailyMarketBar } from '../kis/rest.js';
import {
  getDailyBarCursors,
  recordDailyBarFailure,
  replaceSymbolBars,
  saveDailyBarCursor,
  summarizeDailyBarStore,
  type DailyBar,
  type DailyBarCursor,
} from '../db/dailyBars.js';
import {
  ensureDelistingSchema,
  getDelistedCandidates,
  planDelistedCollection,
  summarizeDelistings,
  trimTrailingZeroVolumeBars,
  type DelistedCollectionTarget,
} from '../db/delistings.js';

/**
 * 일봉 저장소가 덮는 구간의 시작. 더 옛날은 활성 종목도 안 받아 두었다
 * (`collectDailyBars.ts`가 60쪽 × 130달력일 = 21.4년이라 여기쯤에서 끝난다).
 *
 * ★ **`--from`을 이보다 앞으로 당기지 마라.** 폐지 목록도 2005-01-01부터라, 그
 * 전에 폐지된 회사가 같은 코드를 쓰고 있었다면 그 사실이 목록에 없다. 당기는 만큼
 * **다른 회사의 봉이 한 계열에 섞일 수 있다.**
 */
const DEFAULT_FROM_DAY = '20050101';

/** 한 번에 오는 최대 거래일. 이만큼 왔으면 **더 있을 수 있다**는 뜻이다. */
const ROWS_PER_CALL = 100;

/** 종목당 최대 쪽. 100거래일 × 60쪽 = 6,000거래일 ≒ 24년이라 2005년까지 닿는다. */
const DEFAULT_MAX_PAGES = 60;

/** 종목 사이 간격. `collectDailyBars.ts`와 같은 값이다 — 같은 서버를 두드린다. */
const DEFAULT_SYMBOL_GAP_MS = 1_200;

/** 소켓 절단·한도는 일시적 실패라 종목을 건너뛰지 않는다. */
const RETRY_DELAYS_MS = [3_000, 10_000, 30_000];

const HEARTBEAT_EVERY = 50;

interface Options {
  limit: number | null;
  symbols: string[];
  fromDay: string;
  symbolGapMs: number;
  maxPages: number;
  /** 이미 끝난 종목도 다시 받는다 */
  force: boolean;
  /** 대상만 세어 보고 KIS를 부르지 않는다 */
  dryRun: boolean;
  /** 어느 자격증명으로 조회할까. 생략하면 `KIS_OPEN_DAY_CREDENTIAL_ID` */
  credentialId: string | null;
}

interface SymbolResult {
  bars: number;
  calls: number;
  /** 쪽 상한에서 멈췄나. 그렇다면 더 옛날 봉이 남아 있다 */
  hitPageLimit: boolean;
  /** 끝에서 떼어 낸 거래량 0 봉 수 */
  trimmed: number;
  cursor: DailyBarCursor;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    limit: null,
    symbols: [],
    fromDay: DEFAULT_FROM_DAY,
    symbolGapMs: DEFAULT_SYMBOL_GAP_MS,
    maxPages: DEFAULT_MAX_PAGES,
    force: false,
    dryRun: false,
    credentialId: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const next = (): string => argv[(index += 1)] ?? '';
    switch (argv[index]) {
      case '--limit':
        options.limit = Number(next());
        break;
      case '--symbols':
        options.symbols = next().split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--from':
        options.fromDay = next();
        break;
      case '--gap-ms':
        options.symbolGapMs = Number(next());
        break;
      case '--pages':
        options.maxPages = Number(next());
        break;
      case '--credential':
        options.credentialId = next();
        break;
      case '--force':
        options.force = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        throw new Error(`모르는 인자입니다: ${argv[index]}`);
    }
  }
  if (!/^\d{8}$/.test(options.fromDay)) throw new Error(`--from은 YYYYMMDD입니다: ${options.fromDay}`);
  if (!Number.isFinite(options.symbolGapMs) || options.symbolGapMs < 0) {
    throw new Error('--gap-ms는 0 이상의 숫자여야 합니다');
  }
  if (!Number.isInteger(options.maxPages) || options.maxPages < 1) {
    throw new Error('--pages는 1 이상의 정수여야 합니다');
  }
  return options;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function kstToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()).replace(/-/g, '');
}

function formatDay(day: string | null): string {
  if (!day) return '-';
  return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
}

function count(value: number): string {
  return value.toLocaleString('ko-KR');
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}분`;
  return `${hours}시간 ${minutes}분`;
}

/** `YYYYMMDD`의 하루 전. 다음 쪽의 끝을 잡는 데 쓴다. */
function previousDay(day: string): string {
  const date = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8))));
  date.setUTCDate(date.getUTCDate() - 1);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dayOfMonth = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}${month}${dayOfMonth}`;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeText = cause instanceof Error ? ` (${cause.message})` : '';
  return `${error.message}${causeText}`.slice(0, 200);
}

let stopRequested = false;

async function withRetry<T>(label: string, run: () => Promise<T>): Promise<{ value: T; calls: number }> {
  let calls = 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      calls += 1;
      return { value: await run(), calls };
    } catch (error) {
      const transient = isRetriableTransportError(error) || isRateLimitedError(error);
      if (!transient || attempt >= RETRY_DELAYS_MS.length || stopRequested) throw error;
      const wait = RETRY_DELAYS_MS[attempt];
      console.log(
        `    ${label} 일시적 실패 (${attempt + 1}/${RETRY_DELAYS_MS.length}) · ${Math.round(wait / 1000)}초 뒤 다시`
        + ` — ${describeError(error)}`,
      );
      await delay(wait);
    }
  }
}

/**
 * 받은 하루 → 저장할 줄.
 *
 * **0을 그대로 담는다.** 이 TR은 값이 없는 자리에 빈 문자열이 아니라 `'0'`을 주고
 * (2026-08-13 실측: 빈 문자열이 온 필드가 없었다), 거래정지일의 거래량 0은 **사실**이다.
 * 다만 가격이 0이면 그날은 값이 없는 것이라 담지 않는다 — 부르는 쪽이 거른다.
 */
function toDailyBar(bar: DailyMarketBar): DailyBar {
  return {
    tradingDay: bar.tradingDay,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: Number.isFinite(bar.volume) ? Math.round(bar.volume) : null,
    turnover: Number.isFinite(bar.turnover) ? Math.round(bar.turnover) : null,
  };
}

/**
 * 한 종목의 전 구간을 **한 세션에서 통째로** 받는다.
 *
 * 끝(`to`)을 과거로 밀며 100거래일씩 가져온다. 100건 미만이 오면 그 앞에는 없다는
 * 뜻이라 멈춘다 — 요청 구간이 100거래일보다 길 때 이 TR은 **최근 쪽 100일**을 주므로
 * 덜 온 것은 구간이 바닥났다는 신호다.
 */
async function fetchDelistedHistory(
  target: DelistedCollectionTarget,
  options: Options,
  credentials: KisCredentials,
): Promise<{ rows: DailyBar[]; calls: number; hitPageLimit: boolean }> {
  const byDay = new Map<string, DailyBar>();
  let to = target.to;
  let calls = 0;
  let exhausted = false;

  for (let page = 0; page < options.maxPages; page += 1) {
    if (stopRequested) throw new Error('사용자가 멈췄습니다');
    if (to < target.from) {
      exhausted = true;
      break;
    }
    const attempt = await withRetry(
      `${target.symbol} ${page + 1}쪽`,
      () => getDailyMarketBars(target.symbol, target.from, to, credentials),
    );
    calls += attempt.calls;
    const bars = attempt.value;

    if (bars.length === 0) {
      exhausted = true;
      break;
    }
    for (const bar of bars) {
      // 가격이 0인 줄은 그날 값이 없다는 뜻이다. 0원짜리 봉을 지어내지 않는다.
      if (!(bar.close > 0) || !(bar.open > 0) || !(bar.high > 0) || !(bar.low > 0)) continue;
      byDay.set(bar.tradingDay, toDailyBar(bar));
    }

    // 응답은 최신 → 과거 순이다. 가장 오래된 날의 하루 전이 다음 쪽의 끝이다.
    const oldest = bars.reduce((min, bar) => (bar.tradingDay < min ? bar.tradingDay : min), bars[0].tradingDay);
    if (bars.length < ROWS_PER_CALL || oldest <= target.from) {
      exhausted = true;
      break;
    }
    to = previousDay(oldest);
  }

  const rows = [...byDay.values()].sort((a, b) => a.tradingDay.localeCompare(b.tradingDay));
  return { rows, calls, hitPageLimit: !exhausted };
}

async function collectSymbol(
  target: DelistedCollectionTarget,
  options: Options,
  credentials: KisCredentials,
  vintage: string,
): Promise<SymbolResult> {
  const fetched = await fetchDelistedHistory(target, options, credentials);
  const trimmed = trimTrailingZeroVolumeBars(fetched.rows);
  const now = Date.now();
  /*
   * 한 건도 안 남은 이유를 뭉뚱그리지 않는다. **아무것도 안 온 것**과 **온 것이
   * 전부 거래량 0이었던 것**은 다른 사실이다 — 뒤엣것은 그 구간 내내 거래가
   * 멈춰 있었다는 뜻이고(000110은 2005-01-03~04-22 75봉이 전부 그랬다), 다시
   * 받아도 같은 답이 온다.
   */
  const emptyReason = fetched.rows.length === 0
    ? `봉이 한 건도 오지 않았습니다 (${formatDay(target.from)}~${formatDay(target.to)})`
    : `받은 ${fetched.rows.length}봉이 전부 거래량 0이라 담지 않았습니다`;
  const cursor: DailyBarCursor = {
    symbol: target.symbol,
    oldestDay: trimmed.bars[0]?.tradingDay ?? null,
    newestDay: trimmed.bars[trimmed.bars.length - 1]?.tradingDay ?? null,
    barCount: trimmed.bars.length,
    done: trimmed.bars.length > 0,
    lastError: trimmed.bars.length > 0 ? null : emptyReason,
    lastAttemptAt: now,
  };
  /*
   * 한 건도 못 받았으면 **저장분을 건드리지 않는다.** 빈 배열로 갈아 끼우면
   * 지난 실행이 받아 둔 것까지 지워지고, 되돌릴 수 없다.
   */
  if (trimmed.bars.length > 0) await replaceSymbolBars(target.symbol, trimmed.bars, vintage, now);
  await saveDailyBarCursor(cursor);
  return {
    bars: trimmed.bars.length,
    calls: fetched.calls,
    hitPageLimit: fetched.hitPageLimit,
    trimmed: trimmed.trimmed,
    cursor,
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const vintage = kstToday();

  process.on('SIGINT', () => {
    if (stopRequested) process.exit(130);
    stopRequested = true;
    console.log('\n멈추라는 신호를 받았습니다. 지금 종목은 버리고 정리합니다 (다음 실행이 이어받습니다).');
  });

  /*
   * ★ 조회 자격증명. **`crossServerRead`를 쓰지 않는다** — 이 TR은 지금 서버에서
   * 그대로 답한다(2026-08-13 실측: `APP_ENV=vts`로 모의 서버에 물어 005600·117930·
   * 012210의 21년치가 왔다). 다른 서버로 넘어가는 예외는 개장일 조회 하나뿐이고,
   * 그 표시를 다른 TR에 옮겨 붙이지 않는다(CLAUDE.md 7-1).
   *
   * **조회 전용이다. 주문에는 쓰지 않는다.**
   */
  const credentialId = options.credentialId ?? process.env.KIS_OPEN_DAY_CREDENTIAL_ID ?? '';
  const account = credentialId ? getKisAccount(credentialId) : null;
  if (!account) {
    throw new Error(
      `조회 자격증명을 찾지 못했습니다 (${credentialId || '지정 없음'}).`
      + ' .env의 KIS_OPEN_DAY_CREDENTIAL_ID를 채우거나 --credential <계좌 id>로 지정하세요.',
    );
  }
  const credentials: KisCredentials = toCredentials(account);
  const server = credentialServer(credentials);
  console.log(
    `폐지 종목 일봉 수집 · ${kisServerLabel(server)} · 자격증명 ${account.id} · APP_ENV=${config.env}`,
  );
  if (server === 'vts') {
    /*
     * 모의 서버는 초당 1건이라 **한 번 부르는 데 1.15초**가 든다(2026-08-13 실측:
     * 5회 5.73초, 가장 느린 1회 1.15초). 종목당 최대 60쪽이므로 시간이 그만큼 늘어난다.
     * `collectDailyBars.ts`가 겪은 것처럼 들쭉날쭉하기도 하다(한 종목 584초).
     */
    console.log('  ⚠ 모의 서버는 초당 1건이라 한 번 부르는 데 1.15초다 (2026-08-13 실측).');
    console.log('    실전으로 돌리려면: APP_ENV=prod npx tsx src/scripts/collectDelistedBars.ts');
  }

  await ensureDelistingSchema();
  const delistings = await summarizeDelistings();
  const candidates = await getDelistedCandidates();
  const plan = planDelistedCollection(candidates, options.fromDay);
  if (delistings.records === 0) {
    throw new Error(
      '폐지 기록이 한 건도 없습니다. 먼저 목록을 받으세요:'
      + ' npx tsx src/scripts/collectDelistings.ts',
    );
  }
  console.log(
    `\n폐지 기록 ${count(delistings.records)}건 · 코드 ${count(delistings.symbols)}개`
    + ` (${formatDay(delistings.oldestDay)} ~ ${formatDay(delistings.newestDay)}, 받은 날 기준)`,
  );

  const bySymbolFilter = options.symbols.length > 0
    ? plan.targets.filter((target) => options.symbols.includes(target.symbol))
    : plan.targets;
  if (options.symbols.length > 0 && bySymbolFilter.length < options.symbols.length) {
    const found = new Set(bySymbolFilter.map((target) => target.symbol));
    const missing = options.symbols.filter((symbol) => !found.has(symbol));
    const reasons = new Map(plan.skipped.map((row) => [row.symbol, `${row.reason} — ${row.detail}`]));
    console.log(`\n대상에 없는 종목코드 ${missing.length}개는 뺐습니다:`);
    for (const symbol of missing) console.log(`  ${symbol} — ${reasons.get(symbol) ?? '폐지 기록이 없습니다'}`);
  }

  const skipCounts = new Map<string, number>();
  for (const row of plan.skipped) skipCounts.set(row.reason, (skipCounts.get(row.reason) ?? 0) + 1);
  console.log(
    `폐지 기록이 붙은 국내 주식·ETF ${count(candidates.length)}개`
    + ` → 받을 대상 ${count(plan.targets.length)}개`
    + (skipCounts.size > 0
      ? ` · 뺀 것 ${[...skipCounts].map(([reason, n]) => `${reason} ${n}`).join(' · ')}`
      : ''),
  );
  console.log('  (KONEX 제외 · 살아 있는 코드는 collectDailyBars가 받는다 · 재상장 코드는 가를 수 없어 뺀다)');

  const cursors = await getDailyBarCursors();
  const targets = options.limit === null ? bySymbolFilter : bySymbolFilter.slice(0, options.limit);
  const pending = targets.filter((target) => options.force || !cursors.get(target.symbol)?.done);
  const skipped = targets.length - pending.length;

  console.log(
    `받을 것 ${count(pending.length)}개 · 이미 끝난 것 ${count(skipped)}개 건너뜀`
    + ` · 구간 ${formatDay(options.fromDay)} ~ 폐지일`
    + ` · 종목당 최대 ${options.maxPages}쪽(${options.maxPages * ROWS_PER_CALL}거래일)`,
  );
  if (options.limit !== null) {
    console.log('  ★ --limit은 종목코드 오름차순 앞쪽이다. 시장을 대표하지 않으므로 측정에 그대로 쓰지 않는다.');
  }
  console.log(`기준일(vintage) ${formatDay(vintage)} — 한 종목의 전 구간은 한 세션에서 통째로 받는다\n`);

  if (options.dryRun) {
    for (const target of pending.slice(0, 20)) {
      console.log(`  ${target.symbol}  ${formatDay(target.from)} ~ ${formatDay(target.to)}`);
    }
    if (pending.length > 20) console.log(`  … 그리고 ${count(pending.length - 20)}개 더`);
    console.log('\n--dry-run이라 KIS를 부르지 않았다.');
    return;
  }

  const startedAt = Date.now();
  let processed = 0;
  let failed = 0;
  let empty = 0;
  let totalBars = 0;
  let totalCalls = 0;
  let totalTrimmed = 0;
  let pageLimited = 0;
  const failures: Array<{ symbol: string; message: string }> = [];

  for (const target of pending) {
    if (stopRequested) break;
    const symbolStartedAt = Date.now();
    const label = `${target.symbol} ~${formatDay(target.to)}`;

    try {
      const result = await collectSymbol(target, options, credentials, vintage);
      processed += 1;
      totalBars += result.bars;
      totalCalls += result.calls;
      totalTrimmed += result.trimmed;
      if (result.hitPageLimit) pageLimited += 1;
      if (result.bars === 0) empty += 1;

      const done = processed + failed;
      const remaining = pending.length - done;
      const eta = remaining > 0 ? ((Date.now() - startedAt) / done) * remaining : 0;
      console.log(
        `[${String(done).padStart(String(pending.length).length)}/${pending.length}] ${label}`
        + ` ${String(result.bars).padStart(5)}봉`
        + ` ${formatDay(result.cursor.oldestDay)}~${formatDay(result.cursor.newestDay)}`
        + (result.trimmed > 0 ? ` · 끝 거래량0 ${result.trimmed}봉 뗌` : '')
        + ` · KIS ${result.calls}회 · ${((Date.now() - symbolStartedAt) / 1000).toFixed(1)}초`
        + (remaining > 0 ? ` · 남은 예상 ${formatDuration(eta)}` : ''),
      );
    } catch (error) {
      failed += 1;
      const message = describeError(error);
      failures.push({ symbol: target.symbol, message });
      await recordDailyBarFailure(target.symbol, message, Date.now());
      console.log(`[!] ${label} 실패 — ${message}`);
    }

    const done = processed + failed;
    if (done % HEARTBEAT_EVERY === 0) {
      const elapsed = Date.now() - startedAt;
      console.log(
        `── 진행 ${done}/${pending.length} (${((done / pending.length) * 100).toFixed(1)}%)`
        + ` · 경과 ${formatDuration(elapsed)} · 남은 예상 ${formatDuration((elapsed / done) * (pending.length - done))}`
        + ` · 실패 ${failed} · 봉 0건 ${empty} · 봉 ${count(totalBars)} · KIS ${count(totalCalls)}회`
        + ` · ${new Date().toLocaleTimeString('ko-KR')}`,
      );
    }

    if (options.symbolGapMs > 0 && !stopRequested) await delay(options.symbolGapMs);
  }

  const elapsed = Date.now() - startedAt;
  console.log(
    `\n끝 · ${formatDuration(elapsed)} · 받은 종목 ${count(processed)} · 실패 ${count(failed)}`
    + `${stopRequested ? ' · 사용자가 멈춤' : ''}`,
  );
  console.log(
    `이번에 넣은 봉 ${count(totalBars)} · KIS ${count(totalCalls)}회`
    + (empty > 0 ? ` · 봉이 0건인 종목 ${count(empty)}개(저장분은 건드리지 않았다)` : '')
    + (totalTrimmed > 0 ? ` · 끝에서 뗀 거래량 0 봉 ${count(totalTrimmed)}개` : '')
    + (pageLimited > 0 ? ` · 쪽 상한에서 멈춘 종목 ${count(pageLimited)}개(더 옛날 봉이 남아 있다)` : ''),
  );

  const summary = await summarizeDailyBarStore();
  console.log(
    `저장소 전체: 종목 ${count(summary.symbols)} · 봉 ${count(summary.bars)}`
    + ` · ${formatDay(summary.oldestDay)}~${formatDay(summary.newestDay)}`
    + ` · 끝난 종목 ${count(summary.doneSymbols)} · 사유가 남은 종목 ${count(summary.failedSymbols)}`,
  );
  if (failures.length > 0) {
    console.log('\n실패한 종목 (다음 실행이 다시 시도한다):');
    for (const failure of failures.slice(0, 20)) console.log(`  ${failure.symbol} — ${failure.message}`);
    if (failures.length > 20) console.log(`  … 그리고 ${count(failures.length - 20)}개 더`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
