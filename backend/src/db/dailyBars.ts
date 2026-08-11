/**
 * 전 종목 일봉 저장소. **한 번 받아 두고 계속 쓴다.**
 *
 * ── 왜 필요한가 (2026-08-11) ─────────────────────────────────────────────
 *
 * 지금까지 잴 때마다 KIS에서 일봉을 다시 받았다. 그래서 두 가지가 굳어졌다.
 *
 *   1. 유니버스가 143~149종목이었다. DB에는 국내 활성 주식·ETF가 3,900종목이
 *      넘는데 **3.7%만 보고** 판정문을 썼다.
 *   2. 재는 각도를 바꿀 때마다 KIS를 다시 두드렸고, 그러다 소켓이 끊겨
 *      측정이 두 번 죽었다.
 *
 * walk-forward 검증(2005~2010에서 찾아 2011에 검증 … 15번)은 21년치가 **DB에
 * 있어야** 돌아간다. 이 표가 그 자리다.
 *
 * ── 지켜야 할 계약 셋 ────────────────────────────────────────────────────
 *
 * **① `vintage` 없이는 한 줄도 안 들어간다.**
 * KIS 수정주가는 **요청 시점 기준**이다. 며칠에 걸쳐 나눠 받는 동안 액면분할이
 * 나면 옛 줄과 새 줄이 다른 기준으로 섞이는데, 값만 보면 알아볼 방법이 없다 —
 * 그래프는 매끄럽고 수익률만 조용히 틀린다. 그래서 **한 종목의 21년은 한
 * 세션에서 통째로 받고**(`replaceSymbolBars`가 지운 뒤 넣는다), 그 날짜를
 * 줄마다 적어 둔다.
 *
 * **② 증분 갱신은 겹치는 구간을 대조하고 나서만 붙인다.**
 * 최근 창을 한 번 더 받아 저장분과 맞춰 본다(`compareDailyBars`). 하나라도
 * 어긋나면 그 종목 전체를 다시 받는다 — 호출 1회로 모든 수정주가 변경을 잡는다.
 * 겹치는 날이 아예 없으면(오래 안 돌렸으면) 대조를 못 한 것이므로 그때도
 * 전체를 다시 받는다. **모르는 것을 맞다고 치지 않는다.**
 *
 * **③ `NULL`을 0으로 채우지 않는다.**
 * 거래량·거래대금이 안 온 것과 0인 것은 다른 사실이다. `Number('')`이 0이 되어
 * "거래가 없었다"가 지어진 전례가 이 레포에 있다.
 *
 * 이 모듈은 조회만 한다. 주문 경로가 아니다.
 */

import type { PoolClient } from 'pg';

import { pool } from './client.js';

/** 저장하는 일봉 한 줄. 날짜는 KST 거래일 `YYYYMMDD`다. */
export interface DailyBar {
  tradingDay: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 거래량(주). **안 온 것은 `null`이다** — 0으로 채우지 않는다 */
  volume: number | null;
  /** 거래대금(원). 유동성 문턱이 보는 축이다. 안 온 것은 `null` */
  turnover: number | null;
}

/** 한 종목을 어디까지 받았나. 밤샘 수집이 죽어도 여기서 이어간다. */
export interface DailyBarCursor {
  symbol: string;
  /** 저장된 가장 오래된 거래일 `YYYYMMDD`. 한 줄도 없으면 null */
  oldestDay: string | null;
  newestDay: string | null;
  barCount: number;
  /**
   * 요청한 만큼 다 받았나. **`false`면 다음 실행이 다시 시도한다.**
   * 실패해서 넘어간 종목도 `false`로 남는다 — 건너뛴 것을 끝난 것으로 세지 않는다.
   */
  done: boolean;
  /** 마지막으로 실패했을 때의 사유. 성공하면 지운다 */
  lastError: string | null;
  lastAttemptAt: number | null;
}

/** 저장분과 새로 받은 것이 어긋난 하루. 수정주가 기준이 바뀌었다는 신호다. */
export interface DailyBarMismatch {
  tradingDay: string;
  field: 'open' | 'high' | 'low' | 'close';
  stored: number;
  fetched: number;
}

/** 대조 결과. 무엇이 어긋났고 무엇이 새것인지 갈라서 준다. */
export interface DailyBarComparison {
  /** 겹치는 날 중 값이 다른 것. **하나라도 있으면 전체를 다시 받는다** */
  mismatches: DailyBarMismatch[];
  /** 겹쳐서 대조한 날 수. **0이면 대조를 못 한 것이다** */
  overlapDays: number;
  /** 저장분에 없던 새 거래일 */
  newBars: DailyBar[];
  /** 새로 받은 창 안에 있는데 저장분에는 없는 날. 구멍이 났다는 뜻 */
  missingDays: string[];
}

export async function ensureDailyBarSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_daily_bars (
      symbol      TEXT   NOT NULL,
      trading_day TEXT   NOT NULL,
      open        DOUBLE PRECISION NOT NULL,
      high        DOUBLE PRECISION NOT NULL,
      low         DOUBLE PRECISION NOT NULL,
      close       DOUBLE PRECISION NOT NULL,
      volume      BIGINT,
      turnover    BIGINT,
      vintage     TEXT   NOT NULL,
      fetched_at  BIGINT NOT NULL,
      PRIMARY KEY (symbol, trading_day)
    );

    /* 종목 하나를 날짜순으로 훑는 것이 이 표의 유일한 읽기 모양이다. */
    CREATE INDEX IF NOT EXISTS trading_daily_bars_day_idx
      ON trading_daily_bars (trading_day);

    CREATE TABLE IF NOT EXISTS trading_daily_bar_cursor (
      symbol          TEXT PRIMARY KEY,
      oldest_day      TEXT,
      newest_day      TEXT,
      bar_count       INTEGER NOT NULL DEFAULT 0,
      done            BOOLEAN NOT NULL DEFAULT false,
      last_error      TEXT,
      last_attempt_at BIGINT
    );
  `);
}

interface BarRow {
  trading_day: string;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume: string | null;
  turnover: string | null;
}

/** pg는 `bigint`·`numeric`을 문자열로 준다. **빈 값은 0이 아니라 null이다** */
function toBigNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rowToBar(row: BarRow): DailyBar {
  return {
    tradingDay: row.trading_day,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: toBigNumber(row.volume),
    turnover: toBigNumber(row.turnover),
  };
}

/**
 * 한 종목의 봉을 **통째로 갈아 끼운다.** 지우고 넣는 것이 한 트랜잭션이다.
 *
 * 이어 붙이지 않는 이유가 계약 ①이다. 수정주가 기준이 다른 줄이 한 종목 안에
 * 섞이면 되돌릴 수 없고, 섞였다는 사실조차 값으로는 보이지 않는다.
 */
export async function replaceSymbolBars(
  symbol: string,
  bars: DailyBar[],
  vintage: string,
  fetchedAt: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM trading_daily_bars WHERE symbol = $1', [symbol]);
    await insertBars(client, symbol, bars, vintage, fetchedAt);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 새 거래일만 덧붙인다. **대조를 통과한 뒤에만 부른다**(계약 ②).
 *
 * 겹치는 구간이 한 줄도 안 틀렸다는 것은 지금 기준으로도 옛 줄이 맞다는 뜻이라,
 * 여기 붙는 줄의 `vintage`가 옛 줄과 달라도 기준은 같다. **덮어쓰지 않는다** —
 * 이미 있는 날이 오면 그건 대조를 통과한 날이므로 그대로 둔다.
 */
export async function appendSymbolBars(
  symbol: string,
  bars: DailyBar[],
  vintage: string,
  fetchedAt: number,
): Promise<void> {
  if (bars.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertBars(client, symbol, bars, vintage, fetchedAt);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** 한 번에 여러 줄. 21년치는 5,300줄이라 한 줄씩 왕복하면 느리다. */
async function insertBars(
  client: PoolClient,
  symbol: string,
  bars: DailyBar[],
  vintage: string,
  fetchedAt: number,
): Promise<void> {
  const CHUNK = 500;
  for (let offset = 0; offset < bars.length; offset += CHUNK) {
    const slice = bars.slice(offset, offset + CHUNK);
    const values: unknown[] = [];
    const tuples = slice.map((bar, index) => {
      const base = index * 9;
      values.push(
        symbol,
        bar.tradingDay,
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        bar.volume,
        bar.turnover,
        vintage,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5},`
        + ` $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${slice.length * 9 + 1})`;
    });
    values.push(fetchedAt);
    await client.query(
      `INSERT INTO trading_daily_bars
         (symbol, trading_day, open, high, low, close, volume, turnover, vintage, fetched_at)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (symbol, trading_day) DO NOTHING`,
      values,
    );
  }
}

/** 한 종목의 봉. 날짜 오름차순이다 — 백테스트가 그대로 먹는다. */
export async function getDailyBars(
  symbol: string,
  range: { from?: string; to?: string } = {},
): Promise<DailyBar[]> {
  const conditions = ['symbol = $1'];
  const values: unknown[] = [symbol];
  if (range.from) {
    values.push(range.from);
    conditions.push(`trading_day >= $${values.length}`);
  }
  if (range.to) {
    values.push(range.to);
    conditions.push(`trading_day <= $${values.length}`);
  }
  const { rows } = await pool.query<BarRow>(
    `SELECT trading_day, open, high, low, close, volume, turnover
     FROM trading_daily_bars
     WHERE ${conditions.join(' AND ')}
     ORDER BY trading_day`,
    values,
  );
  return rows.map(rowToBar);
}

/** 이 종목이 어느 기준일로 받은 것들인가. 둘 이상이면 섞여 있다는 뜻이다. */
export async function getSymbolVintages(symbol: string): Promise<string[]> {
  const { rows } = await pool.query<{ vintage: string }>(
    `SELECT DISTINCT vintage FROM trading_daily_bars WHERE symbol = $1 ORDER BY vintage`,
    [symbol],
  );
  return rows.map((row) => row.vintage);
}

export async function getDailyBarCursors(): Promise<Map<string, DailyBarCursor>> {
  const { rows } = await pool.query<{
    symbol: string;
    oldest_day: string | null;
    newest_day: string | null;
    bar_count: number;
    done: boolean;
    last_error: string | null;
    last_attempt_at: string | null;
  }>(
    `SELECT symbol, oldest_day, newest_day, bar_count, done, last_error, last_attempt_at
     FROM trading_daily_bar_cursor`,
  );
  return new Map(
    rows.map((row) => [
      row.symbol,
      {
        symbol: row.symbol,
        oldestDay: row.oldest_day,
        newestDay: row.newest_day,
        barCount: Number(row.bar_count),
        done: row.done,
        lastError: row.last_error,
        lastAttemptAt: toBigNumber(row.last_attempt_at),
      },
    ]),
  );
}

export async function saveDailyBarCursor(cursor: DailyBarCursor): Promise<void> {
  await pool.query(
    `INSERT INTO trading_daily_bar_cursor
       (symbol, oldest_day, newest_day, bar_count, done, last_error, last_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (symbol) DO UPDATE SET
       oldest_day = EXCLUDED.oldest_day,
       newest_day = EXCLUDED.newest_day,
       bar_count = EXCLUDED.bar_count,
       done = EXCLUDED.done,
       last_error = EXCLUDED.last_error,
       last_attempt_at = EXCLUDED.last_attempt_at`,
    [
      cursor.symbol,
      cursor.oldestDay,
      cursor.newestDay,
      cursor.barCount,
      cursor.done,
      cursor.lastError,
      cursor.lastAttemptAt,
    ],
  );
}

/**
 * 실패를 실패라고 적는다. **`done`은 건드리지 않는다** — 세 번 실패해 넘어간
 * 종목이 `done=true`가 되면 다음 실행이 영영 건너뛴다.
 */
export async function recordDailyBarFailure(
  symbol: string,
  message: string,
  at: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO trading_daily_bar_cursor (symbol, done, last_error, last_attempt_at)
     VALUES ($1, false, $2, $3)
     ON CONFLICT (symbol) DO UPDATE SET
       last_error = EXCLUDED.last_error,
       last_attempt_at = EXCLUDED.last_attempt_at`,
    [symbol, message, at],
  );
}

/** 저장소 요약. 밤새 돌린 뒤 아침에 이것만 보면 상태를 안다. */
export interface DailyBarStoreSummary {
  symbols: number;
  doneSymbols: number;
  failedSymbols: number;
  bars: number;
  oldestDay: string | null;
  newestDay: string | null;
}

export async function summarizeDailyBarStore(): Promise<DailyBarStoreSummary> {
  const bars = await pool.query<{ symbols: string; bars: string; oldest: string | null; newest: string | null }>(
    `SELECT count(DISTINCT symbol)::text AS symbols,
            count(*)::text              AS bars,
            min(trading_day)            AS oldest,
            max(trading_day)            AS newest
     FROM trading_daily_bars`,
  );
  const cursors = await pool.query<{ done: string; failed: string }>(
    `SELECT count(*) FILTER (WHERE done)::text                             AS done,
            count(*) FILTER (WHERE NOT done AND last_error IS NOT NULL)::text AS failed
     FROM trading_daily_bar_cursor`,
  );
  const row = bars.rows[0];
  return {
    symbols: Number(row?.symbols ?? 0),
    doneSymbols: Number(cursors.rows[0]?.done ?? 0),
    failedSymbols: Number(cursors.rows[0]?.failed ?? 0),
    bars: Number(row?.bars ?? 0),
    oldestDay: row?.oldest ?? null,
    newestDay: row?.newest ?? null,
  };
}

/**
 * 저장분과 새로 받은 창을 맞춰 본다. **순수 함수라 DB 없이 시험에 태운다.**
 *
 * 값 비교는 정확히 같은지로 본다. 국내 주식·ETF의 체결가는 정수라 부동소수
 * 반올림이 낄 자리가 없고, 액면분할이 나면 값이 배수로 달라지므로 근사 비교로
 * 느슨하게 둘 이유가 없다. **어림으로 넘기면 기준이 바뀐 것을 놓친다.**
 *
 * 거래량은 비교하지 않는다 — 분할 시 거래량도 조정되는지 아직 안 재 봤고,
 * 확인 안 한 것으로 종목 전체를 다시 받게 하면 밤샘 수집이 늘어난다.
 * 값(가격)이 바뀌면 어차피 여기서 잡힌다.
 */
export function compareDailyBars(stored: DailyBar[], fetched: DailyBar[]): DailyBarComparison {
  const storedByDay = new Map(stored.map((bar) => [bar.tradingDay, bar]));
  const newestStored = stored.length > 0 ? stored[stored.length - 1].tradingDay : null;
  const oldestFetched = fetched.length > 0 ? fetched[0].tradingDay : null;

  const mismatches: DailyBarMismatch[] = [];
  const newBars: DailyBar[] = [];
  const missingDays: string[] = [];
  let overlapDays = 0;

  for (const bar of fetched) {
    const previous = storedByDay.get(bar.tradingDay);
    if (previous) {
      overlapDays += 1;
      for (const field of ['open', 'high', 'low', 'close'] as const) {
        if (previous[field] !== bar[field]) {
          mismatches.push({
            tradingDay: bar.tradingDay,
            field,
            stored: previous[field],
            fetched: bar[field],
          });
        }
      }
      continue;
    }
    /*
     * 저장분에 없는 날. **저장분의 끝보다 뒤면 새 거래일**이고, 사이에 있으면
     * 구멍이다 — 그때는 붙이지 말고 전체를 다시 받아야 한다.
     */
    if (newestStored && bar.tradingDay <= newestStored) missingDays.push(bar.tradingDay);
    else newBars.push(bar);
  }

  // 받아 온 창이 저장분보다 뒤에서 시작하면 겹치는 날이 없다 — 대조를 못 한 것이다.
  if (oldestFetched && newestStored && oldestFetched > newestStored) overlapDays = 0;

  return { mismatches, overlapDays, newBars, missingDays };
}

/**
 * 대조 결과가 **전체를 다시 받으라**고 말하는가.
 *
 * 셋 중 하나면 그렇다: 값이 어긋났다 · 겹치는 날이 없어 대조를 못 했다 ·
 * 사이에 구멍이 있다. **모를 때 그냥 붙이는 쪽으로 두지 않는다** — 기준이
 * 섞인 21년치는 값으로는 알아볼 수 없다.
 */
export function needsFullRefetch(comparison: DailyBarComparison): boolean {
  return comparison.mismatches.length > 0 || comparison.overlapDays === 0 || comparison.missingDays.length > 0;
}
