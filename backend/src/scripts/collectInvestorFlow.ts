/**
 * 전 종목 투자자별 순매수를 받아 **DB에 쌓는다.** 재는 것은 하지 않는다.
 *
 * ── 왜 (2026-09-02) ──────────────────────────────────────────────────────
 *
 * 원장 16칸이 전부 가격에서 나온 신호였고 전부 비용을 못 넘었다. 남은 것은
 * 가격 밖의 정보이고 수급이 그 첫째다. `measureFlowEdge`가 2026-08-04에 이미
 * 재봤지만 **표본이 몇 달치**였다 — 21년 패널에 태우려면 저장소가 있어야 한다.
 *
 * 사용자가 **전 종목**으로 정했다(2026-09-02). 1,000종목만 받으면
 * walk-forward의 3,674종목과 **다른 유니버스**가 되어 기존 원장과 나란히 못
 * 놓는다. 그건 시간으로 살 수 없는 것이다.
 *
 * ── ★★ 이 수집기가 일봉 수집기와 갈리는 곳 ──────────────────────────────
 *
 * **응답이 비지 않는다.** 2005-06 삼성전자를 물으면 30일이 정상으로 오고
 * 날짜도 종가도 그 시절 값이 맞은데 **순매수 3열만 전부 0이다.** 수급은
 * 2005년 10월 말부터 있다(`probeFlowDepth.ts` 실측).
 *
 * 일봉 수집기의 종료 조건("빈 페이지가 연속 두 번")을 그대로 베끼면
 * **영영 안 멈추고** 상장 전까지 내려간다. 그래서 여기서는 **전부-0 페이지가
 * 연속 두 번**이면 멈춘다. 빈 응답도 함께 센다(상장 전 종목).
 *
 * 그리고 **전부-0인 날은 저장하지 않는다.** 0으로 넣으면 "그날 아무도
 * 순매수하지 않았다"는 사실이 지어진다 → `db/investorFlow.ts`의 계약 ①.
 *
 * ── 시간 (실측 기반 추정) ────────────────────────────────────────────────
 *
 * 한 번에 **30 거래일**이 오고 거래일 5,412일이므로 종목당 **181회**.
 * 전 종목 3,900이면 705,900회 ≒ **38시간**(21년 일봉이 131,734회에 7시간 9분).
 * 커서가 있으므로 **며칠 밤에 나눠 받아도 된다** — 죽은 자리에서 이어간다.
 *
 * ★ 한 번 채우면 그 뒤는 싸다. 30일 창이라 매일 증분은 종목당 1회 =
 *   3,900회 ≒ 13분이다. 일봉 수집(3시간)보다 가볍다.
 *
 * ── 어느 서버로 돌리나 ───────────────────────────────────────────────────
 *
 * **실전 자격증명을 권한다.** 모의 서버는 이 계열 조회가 느리고 들쭉날쭉하다
 * (2026-08-11 일봉 실측: 한 종목 584초). 38시간짜리 작업에서는 치명적이다.
 *
 *   APP_ENV=prod KIS_PRIMARY_ACCOUNT_ID=<실전 계좌 id> \
 *     npx tsx src/scripts/collectInvestorFlow.ts
 *
 * ★ `crossServerRead`를 쓰지 않는다. 그 표시는 개장일 조회(`chk-holiday`)
 *   하나에만 붙이기로 돼 있다(CLAUDE.md 7-1). **실행 환경 자체를 실전으로**
 *   두는 것이 규칙을 지키는 길이고, 일봉 수집기가 쓰는 방식과 같다.
 *
 * **주문은 내지 않는다. 조회만 한다.**
 *
 *   npx tsx src/scripts/collectInvestorFlow.ts [--limit N] [--refresh]
 *                                              [--stock] [--etf] [--symbols 005930,000660]
 *                                              [--gap-ms 1200] [--pages 200]
 *                                              [--force]   ← 장중에도 돌린다(기본은 막힘)
 */

import type { Instrument } from '@invest/shared';

import {
  appendSymbolFlow,
  compareInvestorFlow,
  ensureInvestorFlowSchema,
  getInvestorFlow,
  getInvestorFlowCursors,
  isEmptyFlowDay,
  needsFullFlowRefetch,
  recordInvestorFlowFailure,
  replaceSymbolFlow,
  saveInvestorFlowCursor,
  summarizeInvestorFlowStore,
  type InvestorFlowComparison,
  type InvestorFlowCursor,
  type InvestorFlowDayRow,
} from '../db/investorFlow.js';
import { getDomesticHistoryUniverse } from '../db/instruments.js';
import { marketHoursBlock } from '../trading/session.js';
import { closeDb } from '../db/client.js';
import { config, kisServerLabel } from '../config.js';
import { credentialServer, primaryCredentials } from '../kis/auth.js';
import { isRetriableTransportError } from '../kis/errorCodes.js';
import { getInvestorFlowDaily, isRateLimitedError } from '../kis/rest.js';

/**
 * 한 종목에 받을 최대 페이지 수. 한 쪽이 30거래일이라 **200쪽 = 24.4년**이다.
 * 수급이 있는 21년(2005-10~)을 넉넉히 덮는다.
 */
const DEFAULT_MAX_PAGES = 200;

/** 종목 사이 간격. 일봉 수집기가 1.2초로 안정된 값을 그대로 쓴다. */
const DEFAULT_SYMBOL_GAP_MS = 1_200;

/** 재시도 간격. 소켓 절단·타임아웃·한도는 일시적 실패라 종목을 건너뛰지 않는다. */
const RETRY_DELAYS_MS = [3_000, 10_000, 30_000];

/**
 * **전부-0 페이지가 몇 번 연속이면 그만둘까.**
 *
 * ★ 일봉의 `EMPTY_PAGES_TO_STOP`과 이름은 닮았지만 **재는 것이 다르다.**
 *   일봉은 "응답이 비었나"이고 여기는 "응답은 왔는데 값이 전부 0인가"다.
 *   수급은 2005-10 이전에 그 모양으로 계속 오므로, 이 조건이 없으면 종목마다
 *   200쪽을 끝까지 다 부른다(종목당 30분).
 *
 *   둘로 두는 이유도 일봉과 같다 — 30거래일 넘게 거래가 멈춘 종목의 그 이전
 *   이력이 통째로 잘리는 것을 막는다. 종목당 한 번 더 부르는 값이다.
 */
const BLANK_PAGES_TO_STOP = 2;

/** 증분 갱신에서 다시 받아 대조할 창. 한 쪽(30거래일)이면 충분하다. */
const REFRESH_PAGES = 1;

/** 진행 요약을 몇 종목마다 찍을까. 밤새 도는 로그를 아침에 훑을 때 기준이 된다. */
const HEARTBEAT_EVERY = 50;

interface Options {
  limit: number | null;
  refresh: boolean;
  assetTypes: Array<'stock' | 'etf'>;
  symbols: string[];
  symbolGapMs: number;
  maxPages: number;
  force: boolean;
}

interface SymbolResult {
  /** 이번에 저장한 날 수. 증분 갱신에서는 새로 붙인 것만 센다 */
  days: number;
  calls: number;
  /** 쪽 상한에서 멈췄나. 그렇다면 **더 옛날이 남아 있다** */
  hitPageLimit: boolean;
  /** 전부-0이라 버린 날 수. 그 종목의 수급 시작점을 말해 준다 */
  blankDays: number;
  cursor: InvestorFlowCursor | null;
  /** 종가가 어긋나 전체를 다시 받았나 (증분 갱신에서만) */
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

/** KST 오늘 `YYYYMMDD`. 오늘치를 걸러 내는 잣대다. */
function kstToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()).replace(/-/g, '');
}

/** `YYYYMMDD`의 하루 전. 다음 쪽의 끝을 잡을 때 쓴다. */
function previousDay(day: string): string {
  const date = new Date(Date.UTC(
    Number(day.slice(0, 4)),
    Number(day.slice(4, 6)) - 1,
    Number(day.slice(6, 8)),
  ));
  date.setUTCDate(date.getUTCDate() - 1);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dayOfMonth = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}${month}${dayOfMonth}`;
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
 * ★★ **오늘 날짜로 물으면 빈 응답이 온다** (2026-09-02 실측).
 *
 *   20260902(장중) → 0일 · 20260901 → 30일
 *
 * 일봉 TR은 창(start~end)을 받으므로 오늘이 비어도 과거가 함께 오는데, 이 TR은
 * **기준일 하나**만 받아 거기서 과거로 30일을 준다. 그래서 오늘로 시작하면
 * 첫 쪽이 비고, 그것을 "상장 전"으로 읽으면 **한 건도 못 받고 끝난다.**
 * 실제로 첫 시험에서 삼성전자가 0일로 끝나고 `done=true`까지 찍혔다.
 *
 * 어차피 오늘치는 담지 않으므로(미완성) **어제부터 시작한다.**
 */
function startDayFor(today: string): string {
  return previousDay(today);
}

interface PageFetch {
  /** 값이 있는 날만. 전부-0인 날은 여기 없다 */
  rows: InvestorFlowDayRow[];
  /** 이 쪽에서 버린 전부-0 날 수 */
  blank: number;
  /** 이 쪽이 돌려준 날 수(0이면 상장 전이다) */
  received: number;
  /** 다음 쪽의 끝. 더 갈 곳이 없으면 null */
  nextEnd: string | null;
  calls: number;
}

/** 한 쪽(30거래일)을 받아 갈라 놓는다. */
async function fetchPage(symbol: string, endDate: string, today: string, label: string): Promise<PageFetch> {
  const attempt = await withRetry(label, () => getInvestorFlowDaily(symbol, endDate));
  const days = attempt.value;
  if (days.length === 0) {
    return { rows: [], blank: 0, received: 0, nextEnd: null, calls: attempt.calls };
  }

  const rows: InvestorFlowDayRow[] = [];
  let blank = 0;
  let oldest = days[0].tradingDay;
  for (const day of days) {
    if (day.tradingDay < oldest) oldest = day.tradingDay;
    const row: InvestorFlowDayRow = {
      tradingDay: day.tradingDay,
      close: day.close,
      individual: day.individual,
      foreign: day.foreign,
      institution: day.institution,
    };
    // 오늘치는 아직 안 끝났다. 장중에 받으면 미완성이 완성된 하루로 저장된다.
    if (row.tradingDay >= today) continue;
    if (isEmptyFlowDay(row)) {
      blank += 1;
      continue;
    }
    rows.push(row);
  }
  return {
    rows,
    blank,
    received: days.length,
    nextEnd: previousDay(oldest),
    calls: attempt.calls,
  };
}

/**
 * 한 종목의 이력을 **한 세션에서 통째로** 받는다.
 *
 * 창을 과거로 옮겨 가며 부르고, 받은 것 중 가장 오래된 날의 하루 전으로 다음 쪽의
 * 끝을 잡는다. **전부-0 쪽이 연속 두 번**이면 수급이 시작되기 전이라고 보고 멈춘다.
 */
async function fetchSymbolHistory(
  symbol: string,
  options: Options,
  today: string,
): Promise<{
  rows: InvestorFlowDayRow[];
  calls: number;
  hitPageLimit: boolean;
  blankDays: number;
  /** 응답이 **한 번이라도** 왔나. 한 번도 없으면 받지 못한 것이지 상장 전이 아니다 */
  answered: boolean;
}> {
  const byDay = new Map<string, InvestorFlowDayRow>();
  let end = startDayFor(today);
  let blankStreak = 0;
  let calls = 0;
  let blankDays = 0;
  let answered = false;
  /** 더 옛날이 없어서 멈췄나. 아니면 쪽 상한에 걸린 것이다 */
  let exhausted = false;

  for (let page = 0; page < options.maxPages; page += 1) {
    if (stopRequested) throw new Error('사용자가 멈췄습니다');

    const fetched = await fetchPage(symbol, end, today, `${symbol} ${page + 1}쪽`);
    calls += fetched.calls;
    blankDays += fetched.blank;

    // 응답 자체가 비었다 — 여기까지 왔으면 상장 전이다.
    if (fetched.received === 0) {
      exhausted = true;
      break;
    }
    answered = true;

    if (fetched.rows.length === 0) {
      blankStreak += 1;
      if (blankStreak >= BLANK_PAGES_TO_STOP) {
        exhausted = true;
        break;
      }
    } else {
      blankStreak = 0;
      for (const row of fetched.rows) byDay.set(row.tradingDay, row);
    }

    if (!fetched.nextEnd) {
      exhausted = true;
      break;
    }
    end = fetched.nextEnd;
  }

  const rows = [...byDay.values()].sort((a, b) => a.tradingDay.localeCompare(b.tradingDay));
  return { rows, calls, hitPageLimit: !exhausted, blankDays, answered };
}

function cursorFor(
  symbol: string,
  rows: InvestorFlowDayRow[],
  done: boolean,
  at: number,
): InvestorFlowCursor {
  return {
    symbol,
    oldestDay: rows[0]?.tradingDay ?? null,
    newestDay: rows[rows.length - 1]?.tradingDay ?? null,
    dayCount: rows.length,
    done,
    lastError: null,
    lastAttemptAt: at,
  };
}

/** 처음부터 다 받아 갈아 끼운다. `vintage`는 받은 날짜다. */
async function collectFull(symbol: string, options: Options, today: string): Promise<SymbolResult> {
  const result = await fetchSymbolHistory(symbol, options, today);
  const now = Date.now();

  /*
   * ★★ **한 건도 못 받았는데 "끝났다"고 적지 않는다.**
   *
   * 첫 시험에서 정확히 그렇게 됐다 — 오늘 날짜로 물어 빈 응답을 받고,
   * 그것을 상장 전으로 읽어 `done=true`를 찍었다. 전 종목을 그 상태로 돌리면
   * **3,900종목이 전부 "끝남"으로 남고 데이터는 0**이며, 원인을 고쳐 다시
   * 돌려도 전부 건너뛴다. 조용히 비어 있는 저장소가 가장 나쁘다.
   *
   * 응답이 **왔는데** 값이 전부 0인 것은 다른 이야기다 — 그건 그 종목에
   * 수급이 없다는 사실이므로 끝난 것으로 센다.
   */
  if (!result.answered) {
    await recordInvestorFlowFailure(symbol, '응답이 한 번도 오지 않았습니다 (기준일·서버를 확인한다)', now);
    return {
      days: 0,
      calls: result.calls,
      hitPageLimit: result.hitPageLimit,
      blankDays: result.blankDays,
      cursor: null,
      refetched: false,
    };
  }

  const cursor = cursorFor(symbol, result.rows, true, now);
  await replaceSymbolFlow(symbol, result.rows, today, now);
  await saveInvestorFlowCursor(cursor);
  return {
    days: result.rows.length,
    calls: result.calls,
    hitPageLimit: result.hitPageLimit,
    blankDays: result.blankDays,
    cursor,
    refetched: false,
  };
}

/** 왜 전체를 다시 받는지. 세 사유는 고쳐야 할 곳이 달라 뭉뚱그리지 않는다. */
function refetchReason(comparison: InvestorFlowComparison): string {
  if (comparison.mismatches.length > 0) {
    const first = comparison.mismatches[0];
    return `종가가 ${comparison.mismatches.length}칸 어긋났습니다`
      + ` (${first.tradingDay}: 저장 ${first.storedClose} vs 받음 ${first.fetchedClose})`;
  }
  if (comparison.overlapDays === 0) return '겹치는 날이 없어 대조하지 못했습니다';
  return `저장분에 구멍이 ${comparison.missingDays.length}일 있습니다`;
}

/**
 * 증분 갱신. **최근 한 쪽을 다시 받아 저장분과 대조하고 나서만** 덧붙인다.
 *
 * 어긋나면(수정주가 기준이 바뀌었으면) 그 종목 전체를 다시 받는다 — 호출 1회로
 * 모든 기준 변경을 잡는다.
 */
async function collectRefresh(symbol: string, options: Options, today: string): Promise<SymbolResult> {
  let calls = 0;
  let blankDays = 0;
  const fetchedRows: InvestorFlowDayRow[] = [];
  let end = startDayFor(today);

  for (let page = 0; page < REFRESH_PAGES; page += 1) {
    const fetched = await fetchPage(symbol, end, today, `${symbol} 대조`);
    calls += fetched.calls;
    blankDays += fetched.blank;
    fetchedRows.push(...fetched.rows);
    if (!fetched.nextEnd) break;
    end = fetched.nextEnd;
  }
  fetchedRows.sort((a, b) => a.tradingDay.localeCompare(b.tradingDay));

  if (fetchedRows.length === 0) {
    /*
     * 최근 한 쪽에 값이 한 건도 없다. 상장폐지·장기 거래정지·수급이 없는 종목일
     * 수 있는데 여기서는 가릴 수 없다. **저장분을 건드리지 않고 사유만 남긴다** —
     * 지우면 되돌릴 수 없다.
     */
    await recordInvestorFlowFailure(symbol, '최근 30거래일에 값이 0건이라 대조하지 못했습니다', Date.now());
    return { days: 0, calls, hitPageLimit: false, blankDays, cursor: null, refetched: false };
  }

  const stored = await getInvestorFlow(symbol, { from: fetchedRows[0].tradingDay });
  const comparison = compareInvestorFlow(stored, fetchedRows);

  if (needsFullFlowRefetch(comparison)) {
    console.log(`    ${symbol} 전체 다시 받습니다 — ${refetchReason(comparison)}`);
    const full = await collectFull(symbol, options, today);
    return { ...full, calls: full.calls + calls, refetched: true };
  }

  const now = Date.now();
  await appendSymbolFlow(symbol, comparison.newDays, today, now);
  const all = await getInvestorFlow(symbol);
  const cursor = cursorFor(symbol, all, true, now);
  await saveInvestorFlowCursor(cursor);
  return {
    days: comparison.newDays.length,
    calls,
    hitPageLimit: false,
    blankDays,
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
      + '  502를 받습니다(2026-08-18 일봉에서 실측). 자동화가 중단선을 못 보는 채로\n'
      + '  몇 시간이 지납니다. 수집은 하루 늦어도 되지만 경보는 그날 안에 봐야 합니다.\n'
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

  await ensureInvestorFlowSchema();

  const universe = await getDomesticHistoryUniverse(options.assetTypes);
  const bySymbolFilter = options.symbols.length > 0
    ? universe.filter((instrument) => options.symbols.includes(instrument.symbol))
    : universe;
  if (options.symbols.length > 0 && bySymbolFilter.length < options.symbols.length) {
    const found = new Set(bySymbolFilter.map((instrument) => instrument.symbol));
    const missing = options.symbols.filter((symbol) => !found.has(symbol));
    console.log(`DB의 국내 활성 목록에 없는 종목코드 ${missing.length}개는 뺐습니다: ${missing.join(', ')}`);
  }
  const targets: Instrument[] = options.limit === null ? bySymbolFilter : bySymbolFilter.slice(0, options.limit);

  const cursors = await getInvestorFlowCursors();
  const pending = targets.filter((instrument) => options.refresh || !cursors.get(instrument.symbol)?.done);
  const skipped = targets.length - pending.length;

  const server = credentialServer(primaryCredentials);
  console.log(
    `수급 수집 · ${kisServerLabel(server)} · 자격증명 ${primaryCredentials.id}`
    + ` · APP_ENV=${config.env}`,
  );
  if (server === 'vts') {
    /*
     * 어느 서버에 붙었는지가 소요 시간을 통째로 바꾼다 (2026-08-11 일봉 실측:
     * 모의에서 한 종목 584초 · 실전은 종목당 15초 안팎). 38시간짜리 작업에서는
     * 그 차이가 며칠이 된다.
     */
    console.log(
      '  ⚠ 모의 서버는 이 계열 조회가 느리고 들쭉날쭉하다 (2026-08-11 일봉 실측: 한 종목 584초).',
    );
    console.log(
      '    실전 자격증명으로 돌리는 것을 권한다:'
      + ' APP_ENV=prod KIS_PRIMARY_ACCOUNT_ID=<실전 계좌 id> npx tsx src/scripts/collectInvestorFlow.ts',
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
    + ` · 종목당 최대 ${options.maxPages}쪽(${((options.maxPages * 30) / 246).toFixed(1)}년)`
    + ` · 종목 사이 ${options.symbolGapMs}ms`,
  );
  console.log('수급은 2005년 10월 말부터 있다 — 그 전은 전부 0으로 와서 저장하지 않는다');
  if (!options.force) console.log('★ 장이 열리면 스스로 멈춘다 — 저녁에 다시 돌리면 이어받는다');
  console.log(`오늘(${formatDay(today)})치는 담지 않는다 — 장중이면 미완성이다\n`);

  const startedAt = Date.now();
  let processed = 0;
  let failed = 0;
  let totalDays = 0;
  let totalCalls = 0;
  let totalBlank = 0;
  let pageLimited = 0;
  let refetched = 0;
  const failures: Array<{ symbol: string; message: string }> = [];

  for (const instrument of pending) {
    if (stopRequested) break;
    /*
     * ★★ **장이 열리면 스스로 멈춘다.** 시작할 때만 보는 것으로는 모자란다 —
     *   이 수집은 전 종목이면 38시간이라 **밤에 걸면 아침 개장을 그대로 넘어간다.**
     *   그러면 감시·잔고 조회와 KIS 유량을 다투고 화면이 502를 받는다
     *   (2026-08-18에 일봉 수집으로 실측했다. 그건 3시간짜리라 안 겪었을 뿐이다).
     *
     *   커서가 있으므로 여기서 끊어도 **잃는 것은 지금 종목 하나**고, 저녁에
     *   다시 돌리면 이어받는다.
     */
    if (!options.force) {
      const nowBlock = marketHoursBlock(new Date());
      if (nowBlock) {
        console.log(`\n★ 장이 열렸다 — 여기서 멈춘다 (다음 실행이 이어받는다).\n  ${nowBlock}`);
        break;
      }
    }
    const symbolStartedAt = Date.now();
    const label = `${instrument.symbol} ${instrument.name.slice(0, 12).padEnd(14)}`;

    try {
      const result = options.refresh
        ? await collectRefresh(instrument.symbol, options, today)
        : await collectFull(instrument.symbol, options, today);
      processed += 1;
      totalDays += result.days;
      totalCalls += result.calls;
      totalBlank += result.blankDays;
      if (result.hitPageLimit) pageLimited += 1;
      if (result.refetched) refetched += 1;

      const cursor = result.cursor;
      const elapsed = Date.now() - symbolStartedAt;
      const done = processed + failed;
      const remaining = pending.length - done;
      const eta = remaining > 0 ? ((Date.now() - startedAt) / done) * remaining : 0;
      console.log(
        `[${String(done).padStart(String(pending.length).length)}/${pending.length}] ${label}`
        + ` ${String(result.days).padStart(5)}일`
        + ` ${formatDay(cursor?.oldestDay ?? null)}~${formatDay(cursor?.newestDay ?? null)}`
        + ` · KIS ${result.calls}회 · ${(elapsed / 1000).toFixed(1)}초`
        + (result.blankDays > 0 ? ` · 값 없는 날 ${result.blankDays}` : '')
        + (remaining > 0 ? ` · 남은 예상 ${formatDuration(eta)}` : ''),
      );
    } catch (error) {
      failed += 1;
      const message = describeError(error);
      failures.push({ symbol: instrument.symbol, message });
      await recordInvestorFlowFailure(instrument.symbol, message, Date.now());
      console.log(`[!] ${label} 실패 — ${message}`);
    }

    const done = processed + failed;
    if (done % HEARTBEAT_EVERY === 0) {
      const elapsed = Date.now() - startedAt;
      const eta = ((elapsed / done) * (pending.length - done));
      console.log(
        `── 진행 ${done}/${pending.length} (${((done / pending.length) * 100).toFixed(1)}%)`
        + ` · 경과 ${formatDuration(elapsed)} · 남은 예상 ${formatDuration(eta)}`
        + ` · 실패 ${failed} · 날 ${totalDays.toLocaleString('ko-KR')} · KIS ${totalCalls.toLocaleString('ko-KR')}회`
        + ` · ${new Date().toLocaleTimeString('ko-KR')}`,
      );
    }

    if (options.symbolGapMs > 0 && !stopRequested) await delay(options.symbolGapMs);
  }

  const elapsed = Date.now() - startedAt;
  const summary = await summarizeInvestorFlowStore();
  console.log(
    `\n끝 · ${formatDuration(elapsed)} · 받은 종목 ${processed} · 실패 ${failed}`
    + `${stopRequested ? ' · 사용자가 멈춤' : ''}`,
  );
  console.log(
    `이번에 넣은 날 ${totalDays.toLocaleString('ko-KR')} · KIS ${totalCalls.toLocaleString('ko-KR')}회`
    + ` · 값이 없어 버린 날 ${totalBlank.toLocaleString('ko-KR')}`
    + (pageLimited > 0 ? ` · 쪽 상한에서 멈춘 종목 ${pageLimited}개(더 옛날이 남아 있다)` : '')
    + (refetched > 0 ? ` · 종가가 바뀌어 다시 받은 종목 ${refetched}개` : ''),
  );
  console.log(
    `저장소 전체: 종목 ${summary.symbols.toLocaleString('ko-KR')} · 날`
    + ` ${summary.days.toLocaleString('ko-KR')} · ${formatDay(summary.oldestDay)}~${formatDay(summary.newestDay)}`
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
