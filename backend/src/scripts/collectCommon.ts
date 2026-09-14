/**
 * 저장소 수집기(`collectDailyBars`·`collectInvestorFlow`·`collectDelistedBars`)와
 * 검사기가 같이 쓰는 인자·재시도·오류 설명·표기. **실행하는 스크립트가 아니다.**
 *
 * 세 수집기가 같은 본문을 한 벌씩 들고 있었다. 한쪽만 고치면 밤샘 수집이 서로
 * 다르게 죽는다 — 소비자가 둘이 되면 옮긴다(`docs/ARCHITECTURE.md`).
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import { isRetriableTransportError } from '../kis/errorCodes.js';
import { isRateLimitedError } from '../kis/rest.js';
import { toKindDate } from '../krx/kindDelistings.js';

/**
 * 종목 사이 간격. 2026-08-11에 1.2초로 8종목이 통과했다.
 *
 * KIS 호출 자체는 `scheduleKisCall`이 서버별 최소 간격(실전 70ms · 모의 1,100ms)을
 * 이미 지킨다. 이 간격은 그 위에 얹는 여유다 — 종목을 연달아 받을 때 그것만으로는
 * 끊겼기 때문이다. 세 수집기가 같은 서버를 두드리므로 같은 값을 쓴다.
 */
export const DEFAULT_SYMBOL_GAP_MS = 1_200;

/** 활성 종목 수집기(일봉·수급) 인자. 둘은 쪽 상한 기본값만 다르다 */
export interface CollectOptions {
  limit: number | null;
  refresh: boolean;
  assetTypes: Array<'stock' | 'etf'>;
  symbols: string[];
  symbolGapMs: number;
  maxPages: number;
  /** 장중에도 돌린다. **기본은 막는다** — 수집이 KIS 유량을 잔고 조회와 다툰다 */
  force: boolean;
}

/**
 * `[--limit N] [--refresh] [--stock] [--etf] [--symbols 005930,000660]
 *  [--gap-ms 1200] [--pages N] [--force]`. 모르는 인자는 던진다.
 */
export function parseCollectOptions(argv: string[], defaultMaxPages: number): CollectOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      limit: { type: 'string' },
      refresh: { type: 'boolean', default: false },
      stock: { type: 'boolean', default: false },
      etf: { type: 'boolean', default: false },
      symbols: { type: 'string', default: '' },
      force: { type: 'boolean', default: false },
      'gap-ms': { type: 'string' },
      pages: { type: 'string' },
    },
  });
  const assetTypes: Array<'stock' | 'etf'> = [];
  if (values.stock) assetTypes.push('stock');
  if (values.etf) assetTypes.push('etf');
  const options: CollectOptions = {
    limit: values.limit === undefined ? null : Number(values.limit),
    refresh: values.refresh,
    assetTypes: assetTypes.length > 0 ? assetTypes : ['stock', 'etf'],
    symbols: splitSymbols(values.symbols),
    symbolGapMs: values['gap-ms'] === undefined ? DEFAULT_SYMBOL_GAP_MS : Number(values['gap-ms']),
    maxPages: values.pages === undefined ? defaultMaxPages : Number(values.pages),
    force: values.force,
  };
  assertGapAndPages(options.symbolGapMs, options.maxPages);
  return options;
}

export function splitSymbols(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function assertGapAndPages(symbolGapMs: number, maxPages: number): void {
  if (!Number.isFinite(symbolGapMs) || symbolGapMs < 0) {
    throw new Error('--gap-ms는 0 이상의 숫자여야 합니다');
  }
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new Error('--pages는 1 이상의 정수여야 합니다');
  }
}

/**
 * 재시도 간격. 소켓 절단·타임아웃·한도는 **일시적 실패**라 종목을 건너뛰지 않는다.
 * 세 번 다 실패하면 그때 던지고, 부르는 쪽이 `last_error`에 적고 다음 종목으로 간다.
 */
const RETRY_DELAYS_MS = [3_000, 10_000, 30_000];

/**
 * 일시적 실패면 쉬었다 다시. 아니면 그대로 던진다.
 *
 * **가르는 것이 핵심이다.** 소켓 절단으로 종목을 건너뛰면 밤샘 수집이 구멍 뚫린
 * 채 끝나고, 반대로 "그 서버에 없는 기능"을 재시도하면 같은 답을 세 번 듣는다.
 *
 * `stopRequested`는 수집기마다 들고 있는 멈춤 신호(SIGINT)다. 섰으면 다시 부르지 않는다.
 */
export async function withRetry<T>(
  label: string,
  run: () => Promise<T>,
  stopRequested: () => boolean,
): Promise<{ value: T; calls: number }> {
  let calls = 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      calls += 1;
      return { value: await run(), calls };
    } catch (error) {
      const transient = isRetriableTransportError(error) || isRateLimitedError(error);
      if (!transient || attempt >= RETRY_DELAYS_MS.length || stopRequested()) throw error;
      const wait = RETRY_DELAYS_MS[attempt];
      console.log(
        `    ${label} 일시적 실패 (${attempt + 1}/${RETRY_DELAYS_MS.length}) · ${Math.round(wait / 1000)}초 뒤 다시`
        + ` — ${describeError(error)}`,
      );
      await sleep(wait);
    }
  }
}

export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeText = cause instanceof Error ? ` (${cause.message})` : '';
  return `${error.message}${causeText}`.slice(0, 200);
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}분`;
  return `${hours}시간 ${minutes}분`;
}

/** `YYYYMMDD` → `YYYY-MM-DD`. 없으면 `-` */
export function formatDay(day: string | null): string {
  return day ? toKindDate(day) : '-';
}

/** `YYYYMMDD`의 하루 전. 다음 쪽의 끝을 잡을 때 쓴다. */
export function previousDay(day: string): string {
  const date = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8))));
  date.setUTCDate(date.getUTCDate() - 1);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dayOfMonth = String(date.getUTCDate()).padStart(2, '0');
  return `${date.getUTCFullYear()}${month}${dayOfMonth}`;
}
