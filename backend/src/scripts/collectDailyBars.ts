/**
 * 전 종목 일봉을 받아 **DB에 쌓는다.** 재는 것은 하지 않는다.
 *
 * ── 왜 (2026-08-11) ──────────────────────────────────────────────────────
 *
 * 사용자가 정했다 — *"종목을 전체 다 봐야되는데 항상 제한을 두더라. 나눠서 봐도
 * 되니까 전 종목 전 주식 다 봐야돼."* 지금까지 판정문의 유니버스는 143~149종목,
 * 국내 활성 주식·ETF의 **3.7%**였다. 그리고 walk-forward 검증(2005~2010에서 찾아
 * 2011에 검증 … 15번)은 21년치가 DB에 있어야 돌아간다.
 *
 * ── 무엇을 견뎌야 하나 ───────────────────────────────────────────────────
 *
 * 오늘 실제로 겪은 것들이 이 스크립트의 모양을 정했다.
 *
 * 1. **KIS가 소켓을 끊는다.** 종목당 4페이지를 연달아 받다 세 번째 종목에서
 *    `TypeError: fetch failed / SocketError: other side closed (UND_ERR_SOCKET)`.
 *    → 페이지마다 재시도한다. `getDailyCandleHistory`를 안 쓰고
 *    `getDailyCandleWindow`로 직접 페이징하는 이유가 이것이다 — 그 함수는 60페이지를
 *    통째로 안고 있어서, 한 번 끊기면 그때까지 받은 것이 전부 버려진다.
 *    60페이지 안에 한 번이라도 끊기는 종목은 **영영 끝나지 않는다.**
 * 2. **밤새 돈다.** 죽어도 다시 실행하면 이어져야 한다 →
 *    `trading_daily_bar_cursor`. `done=true`는 건너뛴다.
 * 3. **유량이 얇다.** 느려도 되고 대신 죽지 않아야 한다 → 종목 사이 간격 기본 1.2초.
 *
 * ── 계약 (`db/dailyBars.ts`에 자세히) ────────────────────────────────────
 *
 * - **한 종목의 21년은 한 세션에서 통째로 받는다.** 나눠 받는 동안 액면분할이
 *   나면 옛 줄과 새 줄이 다른 수정주가 기준으로 섞이고, 값으로는 알아볼 수 없다.
 *   중간에 죽으면 그 종목은 통째로 버리고 다음 실행이 처음부터 받는다.
 * - **오늘 봉은 담지 않는다.** 장중에 받으면 미완성 봉이 완성된 하루로 저장된다
 *   (14:15에 받은 005930 봉이 실제로 그랬다). 하루 늦는 대신 거짓이 없다.
 * - **못 받은 것을 0으로 채우지 않는다.** 거래량·거래대금이 안 오면 `NULL`이다.
 *
 * **주문은 내지 않는다. 조회만 한다.**
 *
 *   npx tsx src/scripts/collectDailyBars.ts [--limit N] [--resume] [--refresh]
 *                                           [--stock] [--etf] [--symbols 005930,000660]
 *                                           [--gap-ms 1200] [--pages 60]
 *                                           [--force]   ← 장중에도 돌린다(기본은 막힘)
 */

import type { Candle, Instrument } from '@invest/shared';

import {
  appendSymbolBars,
  compareDailyBars,
  ensureDailyBarSchema,
  getDailyBarCursors,
  getDailyBars,
  needsFullRefetch,
  recordDailyBarFailure,
  replaceSymbolBars,
  saveDailyBarCursor,
  summarizeDailyBarStore,
  type DailyBar,
  type DailyBarComparison,
  type DailyBarCursor,
} from '../db/dailyBars.js';
import { getDomesticHistoryUniverse } from '../db/instruments.js';
import { marketHoursBlock } from '../trading/session.js';
import { closeDb } from '../db/client.js';
import { config, kisServerLabel } from '../config.js';
import { credentialServer, primaryCredentials } from '../kis/auth.js';
import { isRetriableTransportError } from '../kis/errorCodes.js';
import { DAILY_PAGE_CALENDAR_DAYS, getDailyCandleWindow, isRateLimitedError } from '../kis/rest.js';

/**
 * 한 종목에 받을 최대 페이지 수. 페이지가 130달력일이라 60쪽 = **21.4년**이다.
 *
 * ⚠ `getDailyCandleHistory`의 기본값(5)은 건드리지 않는다 — 화면 경로
 * (`trading/scoring.ts`)가 그 함수를 부르므로 기본값을 올리면 화면 한 번에
 * KIS 호출이 폭증한다. 여기서만 인자로 넘긴다.
 */
const DEFAULT_MAX_PAGES = 60;

/**
 * 종목 사이 간격. 오늘 1.2초로 8종목이 통과했다.
 *
 * KIS 호출 자체는 `scheduleKisCall`이 서버별 최소 간격(실전 70ms · 모의 1,100ms)을
 * 이미 지킨다. 이 간격은 그 위에 얹는 여유다 — 종목을 연달아 받을 때 그것만으로는
 * 끊겼기 때문이다.
 */
const DEFAULT_SYMBOL_GAP_MS = 1_200;

/**
 * 재시도 간격. 소켓 절단·타임아웃·한도는 **일시적 실패**라 종목을 건너뛰지 않는다.
 * 세 번 다 실패하면 그때 `last_error`에 적고 다음 종목으로 간다(`done=false`로 남는다).
 */
const RETRY_DELAYS_MS = [3_000, 10_000, 30_000];

/**
 * 빈 페이지가 몇 번 연속이면 그만둘까.
 *
 * 하나로 두면 **130일 넘게 거래가 멈춘 종목**(장기 거래정지)의 그 이전 이력이
 * 통째로 잘린다. 잘린 줄 모르면 "이게 이 종목의 전부"로 읽힌다. 종목당 한 번
 * 더 부르는 값으로 그것을 막는다.
 */
const EMPTY_PAGES_TO_STOP = 2;

/** 증분 갱신에서 다시 받아 대조할 창. 130달력일 ≒ 89거래일이라 100건 상한 안이다. */
const REFRESH_WINDOW_DAYS = DAILY_PAGE_CALENDAR_DAYS;

/** 진행 요약을 몇 종목마다 찍을까. 밤새 도는 로그를 아침에 훑을 때 기준이 된다. */
const HEARTBEAT_EVERY = 50;

interface Options {
  limit: number | null;
  refresh: boolean;
  assetTypes: Array<'stock' | 'etf'>;
  symbols: string[];
  symbolGapMs: number;
  maxPages: number;
  /** 장중에도 돌린다. **기본은 막는다** — 이유는 `assertOutsideMarketHours` */
  force: boolean;
}

interface SymbolResult {
  /** 이번에 저장한 봉 수. 증분 갱신에서는 새로 붙인 것만 센다 */
  bars: number;
  calls: number;
  /** 쪽 상한에서 멈췄나. 그렇다면 **더 옛날 봉이 남아 있다** */
  hitPageLimit: boolean;
  /** 저장 뒤의 커서. 다시 조회하지 않으려고 들고 나온다 */
  cursor: DailyBarCursor | null;
  /** 수정주가가 바뀌어 전체를 다시 받았나 (증분 갱신에서만) */
  refetched: boolean;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    limit: null,
    refresh: false,
    assetTypes: [],
    symbols: [],
    symbolGapMs: DEFAULT_SYMBOL_GAP_MS,
    maxPages: DEFAULT_MAX_PAGES,
    force: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => argv[(index += 1)] ?? '';
    switch (arg) {
      case '--limit':
        options.limit = Number(next());
        break;
      case '--resume':
        // 기본 동작이 곧 이어받기다. 명시할 수 있게 받아 두되 아무것도 바꾸지 않는다.
        break;
      case '--refresh':
        options.refresh = true;
        break;
      case '--stock':
        options.assetTypes.push('stock');
        break;
      case '--etf':
        options.assetTypes.push('etf');
        break;
      case '--symbols':
        options.symbols = next().split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case '--force':
        options.force = true;
        break;
      case '--gap-ms':
        options.symbolGapMs = Number(next());
        break;
      case '--pages':
        options.maxPages = Number(next());
        break;
      default:
        throw new Error(`모르는 인자입니다: ${arg}`);
    }
  }
  if (options.assetTypes.length === 0) options.assetTypes = ['stock', 'etf'];
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

/** KST 오늘 `YYYYMMDD`. 오늘 봉을 걸러 내는 잣대다. */
function kstToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()).replace(/-/g, '');
}

/**
 * `Candle.time`(UTC epoch 초) → 거래일 `YYYYMMDD`.
 *
 * 일봉의 `time`은 `Date.UTC(y, m-1, d)/1000`로 만들어졌으므로 UTC 게터로 되돌리면
 * 정확히 그 날짜다. **로컬 게터를 쓰면 시간대에 따라 하루가 밀린다.**
 */
function tradingDayOf(time: number): string {
  const date = new Date(time * 1000);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}${month}${day}`;
}

/**
 * 받은 캔들 → 저장할 줄. **없는 값은 `null`이다.**
 *
 * BIGINT 칸이라 정수로 맞춘다. 거래대금은 조 단위(005930의 하루가 4.85e12)라
 * 배정도 정수 범위(2^53) 안이다.
 */
function toDailyBar(candle: Candle): DailyBar {
  const { volume, turnover } = candle;
  return {
    tradingDay: tradingDayOf(candle.time),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: volume !== undefined && Number.isFinite(volume) ? Math.round(volume) : null,
    turnover: turnover !== undefined && Number.isFinite(turnover) ? Math.round(turnover) : null,
  };
}

let stopRequested = false;

/**
 * 일시적 실패면 쉬었다 다시. 아니면 그대로 던진다.
 *
 * **가르는 것이 핵심이다.** 소켓 절단으로 종목을 건너뛰면 밤샘 수집이 구멍 뚫린
 * 채 끝나고, 반대로 "그 서버에 없는 기능"을 재시도하면 같은 답을 세 번 듣는다.
 */
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

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeText = cause instanceof Error ? ` (${cause.message})` : '';
  return `${error.message}${causeText}`.slice(0, 200);
}

/**
 * 한 종목의 이력을 **한 세션에서 통째로** 받는다.
 *
 * 창을 과거로 옮겨 가며 부르고, 받은 것 중 가장 오래된 날의 하루 전으로 다음 창의
 * 끝을 잡는다. 빈 창이 연속 두 번이면 상장 전이라고 보고 멈춘다.
 */
async function fetchSymbolHistory(
  symbol: string,
  options: Options,
  today: string,
): Promise<{ rows: DailyBar[]; calls: number; hitPageLimit: boolean }> {
  const byDay = new Map<string, DailyBar>();
  let end = new Date();
  let emptyStreak = 0;
  let calls = 0;
  /** 더 옛날이 없어서 멈췄나. 아니면 쪽 상한에 걸린 것이다 */
  let exhausted = false;

  for (let page = 0; page < options.maxPages; page += 1) {
    if (stopRequested) throw new Error('사용자가 멈췄습니다');
    const start = new Date(end);
    start.setDate(start.getDate() - DAILY_PAGE_CALENDAR_DAYS);

    const attempt = await withRetry(`${symbol} ${page + 1}쪽`, () => getDailyCandleWindow(symbol, start, end));
    calls += attempt.calls;
    const candles = attempt.value.candles;

    if (candles.length === 0) {
      emptyStreak += 1;
      if (emptyStreak >= EMPTY_PAGES_TO_STOP) {
        exhausted = true;
        break;
      }
      end = new Date(start);
      end.setDate(end.getDate() - 1);
      continue;
    }
    emptyStreak = 0;

    for (const candle of candles) {
      const bar = toDailyBar(candle);
      // 오늘 봉은 아직 안 끝났다. 미완성 봉을 완성된 하루로 저장하지 않는다.
      if (bar.tradingDay >= today) continue;
      byDay.set(bar.tradingDay, bar);
    }

    end = new Date(candles[0].time * 1000);
    end.setDate(end.getDate() - 1);
  }

  const rows = [...byDay.values()].sort((a, b) => a.tradingDay.localeCompare(b.tradingDay));
  return { rows, calls, hitPageLimit: !exhausted };
}

function cursorFor(symbol: string, rows: DailyBar[], done: boolean, at: number): DailyBarCursor {
  return {
    symbol,
    oldestDay: rows[0]?.tradingDay ?? null,
    newestDay: rows[rows.length - 1]?.tradingDay ?? null,
    barCount: rows.length,
    done,
    lastError: null,
    lastAttemptAt: at,
  };
}

/** 처음부터 다 받아 갈아 끼운다. `vintage`는 받은 날짜다. */
async function collectFull(symbol: string, options: Options, today: string): Promise<SymbolResult> {
  const result = await fetchSymbolHistory(symbol, options, today);
  const now = Date.now();
  const cursor = cursorFor(symbol, result.rows, true, now);
  await replaceSymbolBars(symbol, result.rows, today, now);
  await saveDailyBarCursor(cursor);
  return {
    bars: result.rows.length,
    calls: result.calls,
    hitPageLimit: result.hitPageLimit,
    cursor,
    refetched: false,
  };
}

/** 왜 전체를 다시 받는지. 세 사유는 고쳐야 할 곳이 달라 뭉뚱그리지 않는다. */
function refetchReason(comparison: DailyBarComparison): string {
  if (comparison.mismatches.length > 0) {
    return `수정주가가 ${comparison.mismatches.length}칸 어긋났습니다 (${comparison.mismatches[0].tradingDay})`;
  }
  if (comparison.overlapDays === 0) return '겹치는 날이 없어 대조하지 못했습니다';
  return `저장분에 구멍이 ${comparison.missingDays.length}일 있습니다`;
}

/**
 * 증분 갱신. **최근 창을 한 번 더 받아 저장분과 대조하고 나서만** 덧붙인다.
 *
 * 어긋나면(수정주가 기준이 바뀌었으면) 그 종목 전체를 다시 받는다 — 호출 1회로
 * 모든 수정주가 변경을 잡는다.
 */
async function collectRefresh(symbol: string, options: Options, today: string): Promise<SymbolResult> {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - REFRESH_WINDOW_DAYS);

  const attempt = await withRetry(`${symbol} 대조`, () => getDailyCandleWindow(symbol, start, end));
  const fetched = attempt.value.candles
    .map(toDailyBar)
    .filter((bar) => bar.tradingDay < today)
    .sort((a, b) => a.tradingDay.localeCompare(b.tradingDay));

  if (fetched.length === 0) {
    /*
     * 최근 130일에 봉이 한 건도 없다. 상장폐지·장기 거래정지일 수 있는데 여기서는
     * 가릴 수 없다. **저장분을 건드리지 않고 사유만 남긴다** — 지우면 되돌릴 수 없다.
     */
    await recordDailyBarFailure(symbol, '최근 130일 봉이 0건이라 대조하지 못했습니다', Date.now());
    return { bars: 0, calls: attempt.calls, hitPageLimit: false, cursor: null, refetched: false };
  }

  const stored = await getDailyBars(symbol, { from: fetched[0].tradingDay });
  const comparison = compareDailyBars(stored, fetched);

  if (needsFullRefetch(comparison)) {
    console.log(`    ${symbol} 전체 다시 받습니다 — ${refetchReason(comparison)}`);
    const full = await collectFull(symbol, options, today);
    return { ...full, calls: full.calls + attempt.calls, refetched: true };
  }

  const now = Date.now();
  await appendSymbolBars(symbol, comparison.newBars, today, now);
  const all = await getDailyBars(symbol);
  const cursor = cursorFor(symbol, all, true, now);
  await saveDailyBarCursor(cursor);
  return {
    bars: comparison.newBars.length,
    calls: attempt.calls,
    hitPageLimit: false,
    cursor,
    refetched: false,
  };
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}분`;
  return `${hours}시간 ${minutes}분`;
}

function formatDay(day: string | null): string {
  if (!day) return '-';
  return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const today = kstToday();

  const block = options.force ? null : marketHoursBlock(new Date());
  if (block) {
    console.error(
      `${block}\n`
      + '\n★ 지금 수집하면 KIS 유량을 잔고 조회와 나눠 쓰게 되어 화면과 **경보 확인이**\n'
      + '  502를 받습니다(2026-08-18 실측). 자동화가 중단선을 못 보는 채로 몇 시간이\n'
      + '  지납니다. 수집은 하루 늦어도 되지만 경보는 그날 안에 봐야 합니다.\n'
      + '\n15:40 이후에 다시 돌리세요. 그래도 지금 해야 한다면 --force 를 붙입니다.',
    );
    process.exitCode = 1;
    return;
  }

  process.on('SIGINT', () => {
    if (stopRequested) process.exit(130);
    stopRequested = true;
    console.log('\n멈추라는 신호를 받았습니다. 지금 종목은 버리고 정리합니다 (다음 실행이 이어받습니다).');
  });

  await ensureDailyBarSchema();

  const universe = await getDomesticHistoryUniverse(options.assetTypes);
  const bySymbolFilter = options.symbols.length > 0
    ? universe.filter((instrument) => options.symbols.includes(instrument.symbol))
    : universe;
  /*
   * 찾지 못한 종목코드를 조용히 버리지 않는다. 오타·KONEX·상장폐지 중 무엇인지는
   * 여기서 가릴 수 없지만, **몇 개를 못 찾았는지는 말할 수 있다.**
   */
  if (options.symbols.length > 0 && bySymbolFilter.length < options.symbols.length) {
    const found = new Set(bySymbolFilter.map((instrument) => instrument.symbol));
    const missing = options.symbols.filter((symbol) => !found.has(symbol));
    console.log(`DB의 국내 활성 목록에 없는 종목코드 ${missing.length}개는 뺐습니다: ${missing.join(', ')}`);
  }
  const targets: Instrument[] = options.limit === null ? bySymbolFilter : bySymbolFilter.slice(0, options.limit);

  const cursors = await getDailyBarCursors();
  const pending = targets.filter((instrument) => options.refresh || !cursors.get(instrument.symbol)?.done);
  const skipped = targets.length - pending.length;

  const server = credentialServer(primaryCredentials);
  console.log(
    `일봉 수집 · ${kisServerLabel(server)} · 자격증명 ${primaryCredentials.id}`
    + ` · APP_ENV=${config.env}`,
  );
  if (server === 'vts') {
    /*
     * **어느 서버에 붙었는지가 소요 시간을 통째로 바꾼다** (2026-08-11 실측).
     *
     *   모의 서버   같은 조회 3회가 0.7초일 때도 13초일 때도 있다. 실제로
     *               000020 한 종목(62회)에 **584초**가 걸렸다 → 전 종목 26일
     *   실전 서버   3회에 0.5초로 일정했다 → 종목당 15초 안팎
     *
     * 초당 한도(모의 1건/초 · 실전 18건/초)만의 차이가 아니다. 응답 자체가
     * 느리고 들쭉날쭉하다. 밤새 돌려도 전 종목은 못 끝낸다.
     */
    console.log(
      '  ⚠ 모의 서버는 이 조회가 느리고 들쭉날쭉하다 (2026-08-11 실측: 한 종목 584초).'
      + ' 전 종목이면 26일이 걸린다.',
    );
    console.log(
      '    실전 자격증명으로 돌리는 것을 권한다:'
      + ' APP_ENV=prod KIS_PRIMARY_ACCOUNT_ID=<실전 계좌 id> npx tsx src/scripts/collectDailyBars.ts',
    );
  }
  console.log(
    `종목 ${targets.length}개 (DB 국내 활성 ${options.assetTypes.join('·')} ${universe.length}개 중`
    + `${options.limit === null ? '' : ` 앞 ${options.limit}개`}, KONEX 제외)`,
  );
  if (options.limit !== null) {
    console.log('  ★ --limit은 종목코드 오름차순 앞쪽이다. 시장을 대표하지 않으므로 측정에 그대로 쓰지 않는다.');
  }
  console.log(
    `받을 것 ${pending.length}개 · 이미 끝난 것 ${skipped}개 건너뜀`
    + ` · 종목당 최대 ${options.maxPages}쪽(${(options.maxPages * DAILY_PAGE_CALENDAR_DAYS / 365.25).toFixed(1)}년)`
    + ` · 종목 사이 ${options.symbolGapMs}ms`,
  );
  console.log(`오늘(${formatDay(today)}) 봉은 담지 않는다 — 장중이면 미완성이다\n`);

  const startedAt = Date.now();
  let processed = 0;
  let failed = 0;
  let totalBars = 0;
  let totalCalls = 0;
  let pageLimited = 0;
  let refetched = 0;
  const failures: Array<{ symbol: string; message: string }> = [];

  for (const instrument of pending) {
    if (stopRequested) break;
    const symbolStartedAt = Date.now();
    const label = `${instrument.symbol} ${instrument.name.slice(0, 12).padEnd(14)}`;

    try {
      const result = options.refresh
        ? await collectRefresh(instrument.symbol, options, today)
        : await collectFull(instrument.symbol, options, today);
      processed += 1;
      totalBars += result.bars;
      totalCalls += result.calls;
      if (result.hitPageLimit) pageLimited += 1;
      if (result.refetched) refetched += 1;

      const cursor = result.cursor;
      const elapsed = Date.now() - symbolStartedAt;
      const done = processed + failed;
      const remaining = pending.length - done;
      const eta = remaining > 0 ? ((Date.now() - startedAt) / done) * remaining : 0;
      console.log(
        `[${String(done).padStart(String(pending.length).length)}/${pending.length}] ${label}`
        + ` ${String(result.bars).padStart(5)}봉`
        + ` ${formatDay(cursor?.oldestDay ?? null)}~${formatDay(cursor?.newestDay ?? null)}`
        + ` · KIS ${result.calls}회 · ${(elapsed / 1000).toFixed(1)}초`
        + (remaining > 0 ? ` · 남은 예상 ${formatDuration(eta)}` : ''),
      );
    } catch (error) {
      failed += 1;
      const message = describeError(error);
      failures.push({ symbol: instrument.symbol, message });
      await recordDailyBarFailure(instrument.symbol, message, Date.now());
      console.log(`[!] ${label} 실패 — ${message}`);
    }

    const done = processed + failed;
    if (done % HEARTBEAT_EVERY === 0) {
      const elapsed = Date.now() - startedAt;
      const eta = ((elapsed / done) * (pending.length - done));
      console.log(
        `── 진행 ${done}/${pending.length} (${((done / pending.length) * 100).toFixed(1)}%)`
        + ` · 경과 ${formatDuration(elapsed)} · 남은 예상 ${formatDuration(eta)}`
        + ` · 실패 ${failed} · 봉 ${totalBars.toLocaleString('ko-KR')} · KIS ${totalCalls.toLocaleString('ko-KR')}회`
        + ` · ${new Date().toLocaleTimeString('ko-KR')}`,
      );
    }

    if (options.symbolGapMs > 0 && !stopRequested) await delay(options.symbolGapMs);
  }

  const elapsed = Date.now() - startedAt;
  const summary = await summarizeDailyBarStore();
  console.log(
    `\n끝 · ${formatDuration(elapsed)} · 받은 종목 ${processed} · 실패 ${failed}`
    + `${stopRequested ? ' · 사용자가 멈춤' : ''}`,
  );
  console.log(
    `이번에 넣은 봉 ${totalBars.toLocaleString('ko-KR')} · KIS ${totalCalls.toLocaleString('ko-KR')}회`
    + (pageLimited > 0 ? ` · 쪽 상한에서 멈춘 종목 ${pageLimited}개(더 옛날 봉이 남아 있다)` : '')
    + (refetched > 0 ? ` · 수정주가가 바뀌어 다시 받은 종목 ${refetched}개` : ''),
  );
  console.log(
    `저장소 전체: 종목 ${summary.symbols.toLocaleString('ko-KR')} · 봉`
    + ` ${summary.bars.toLocaleString('ko-KR')} · ${formatDay(summary.oldestDay)}~${formatDay(summary.newestDay)}`
    + ` · 끝난 종목 ${summary.doneSymbols} · 사유가 남은 종목 ${summary.failedSymbols}`,
  );
  if (failures.length > 0) {
    console.log('\n실패한 종목 (다음 실행이 다시 시도한다):');
    for (const failure of failures.slice(0, 20)) {
      console.log(`  ${failure.symbol} — ${failure.message}`);
    }
    if (failures.length > 20) console.log(`  … 그리고 ${failures.length - 20}개 더`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
