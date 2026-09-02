/**
 * 전 종목 투자자별 순매수 저장소. **한 번 받아 두고 계속 쓴다.**
 *
 * ── 왜 필요한가 (2026-09-02) ─────────────────────────────────────────────
 *
 * 이 레포가 21년 walk-forward에 태운 신호는 **전부 가격에서 나온 것**이다
 * (반전·모멘텀·변동성·돌파·52주 위치). 원장 16칸이 전부 비용을 못 넘었고,
 * 남은 것은 가격 밖의 정보다. 수급이 그 첫째다.
 *
 * `measureFlowEdge`·`measureFlowEdgeWide`가 2026-08-04에 이미 재봤지만
 * **표본이 몇 달치였다.** 21년 패널에 태우려면 저장소가 있어야 한다.
 * 이 표가 그 자리다.
 *
 * ── ★★ 일봉 저장소와 결정적으로 다른 점 ─────────────────────────────────
 *
 * **응답이 비지 않는다.** 2005-06 삼성전자를 물으면 30일이 정상으로 오고
 * 날짜도 종가(수정주가 9,780원)도 그 시절 값이 맞다 — 그런데 **순매수 3열만
 * 전부 0이다.** 수급은 2005년 10월 말부터 있고 그 전은 없다.
 *
 * 그래서 두 가지가 일봉과 갈린다.
 *
 *   ① **셋이 모두 0인 날은 저장하지 않는다.** 0으로 넣으면 "그날 아무도
 *      순매수하지 않았다"는 사실이 지어진다. 없는 것은 없는 채로 둔다 —
 *      받은 구간은 커서(`oldestDay`)가 말한다.
 *   ② **페이징을 "빈 응답"으로 멈출 수 없다.** 응답은 계속 오므로 그대로
 *      두면 상장 전까지 내려간다. 전부-0 페이지가 연속되면 멈춘다.
 *
 * ── 지켜야 할 계약 셋 (일봉과 같다) ──────────────────────────────────────
 *
 * **① `vintage` 없이는 한 줄도 안 들어간다.** KIS 수정주가는 요청 시점
 * 기준이다. 같은 응답의 종가가 그 기준을 타므로, 며칠에 걸쳐 나눠 받는 동안
 * 액면분할이 나면 옛 줄과 새 줄이 다른 기준으로 섞인다. **순매수 수량도 함께
 * 조정되는지는 아직 안 재 봤다** — 그래서 더욱 한 세션에서 통째로 받는다.
 *
 * **② 증분 갱신은 겹치는 구간을 대조하고 나서만 붙인다.** 대조는 **종가**로
 * 한다. 순매수로 대조하지 않는 이유는 그것이 무엇을 뜻하는지 모르기 때문이다 —
 * 종가가 같으면 적어도 수정주가 기준이 같다.
 *
 * **③ 없는 것을 0으로 채우지 않는다.** 위 ①이 그 구현이다.
 *
 * 이 모듈은 조회만 한다. 주문 경로가 아니다.
 */

import type { PoolClient } from 'pg';

import { pool } from './client.js';

/**
 * 저장하는 하루. 날짜는 KST 거래일 `YYYYMMDD`, 순매수는 **수량(주)**이다.
 *
 * ★ 금액이 아니다. 값이 다른 종목끼리 크기를 견주려면 종가를 곱해야 하고,
 *   그 종가는 **같은 응답에 있는 것**을 쓴다 — 다른 경로로 받은 가격과 섞으면
 *   수정주가·거래일 경계에서 어긋난다.
 */
export interface InvestorFlowDayRow {
  tradingDay: string;
  close: number;
  individual: number;
  foreign: number;
  institution: number;
}

/** 한 종목을 어디까지 받았나. 밤샘 수집이 죽어도 여기서 이어간다. */
export interface InvestorFlowCursor {
  symbol: string;
  /** 저장된 가장 오래된 거래일. **여기가 곧 "이 종목 수급이 있는 시작점"이다** */
  oldestDay: string | null;
  newestDay: string | null;
  dayCount: number;
  /**
   * 요청한 만큼 다 받았나. **`false`면 다음 실행이 다시 시도한다.**
   * 실패해서 넘어간 종목도 `false`로 남는다 — 건너뛴 것을 끝난 것으로 세지 않는다.
   */
  done: boolean;
  lastError: string | null;
  lastAttemptAt: number | null;
}

/** 저장분과 새로 받은 것이 어긋난 하루. 수정주가 기준이 바뀌었다는 신호다. */
export interface InvestorFlowMismatch {
  tradingDay: string;
  storedClose: number;
  fetchedClose: number;
}

export interface InvestorFlowComparison {
  /** 겹치는 날 중 종가가 다른 것. **하나라도 있으면 전체를 다시 받는다** */
  mismatches: InvestorFlowMismatch[];
  /** 겹쳐서 대조한 날 수. **0이면 대조를 못 한 것이다** */
  overlapDays: number;
  /** 저장분에 없던 새 거래일 */
  newDays: InvestorFlowDayRow[];
  /** 새로 받은 창 안에 있는데 저장분에는 없는 날. 구멍이 났다는 뜻 */
  missingDays: string[];
}

export async function ensureInvestorFlowSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_investor_flow (
      symbol      TEXT   NOT NULL,
      trading_day TEXT   NOT NULL,
      close       DOUBLE PRECISION NOT NULL,
      /* ★ 컬럼 이름이 foreign_net인 것은 FOREIGN이 SQL 예약어이기 때문이다. */
      individual  BIGINT NOT NULL,
      foreign_net BIGINT NOT NULL,
      institution BIGINT NOT NULL,
      vintage     TEXT   NOT NULL,
      fetched_at  BIGINT NOT NULL,
      PRIMARY KEY (symbol, trading_day)
    );

    /* 하루를 가로질러 전 종목을 줄 세우는 것이 측정의 읽기 모양이다. */
    CREATE INDEX IF NOT EXISTS trading_investor_flow_day_idx
      ON trading_investor_flow (trading_day);

    CREATE TABLE IF NOT EXISTS trading_investor_flow_cursor (
      symbol          TEXT PRIMARY KEY,
      oldest_day      TEXT,
      newest_day      TEXT,
      day_count       INTEGER NOT NULL DEFAULT 0,
      done            BOOLEAN NOT NULL DEFAULT false,
      last_error      TEXT,
      last_attempt_at BIGINT
    );
  `);
}

interface FlowRow {
  trading_day: string;
  close: string | number;
  individual: string;
  foreign_net: string;
  institution: string;
}

function rowToFlow(row: FlowRow): InvestorFlowDayRow {
  return {
    tradingDay: row.trading_day,
    close: Number(row.close),
    individual: Number(row.individual),
    foreign: Number(row.foreign_net),
    institution: Number(row.institution),
  };
}

/**
 * 한 종목을 **통째로 갈아 끼운다.** 지우고 넣는 것이 한 트랜잭션이다.
 *
 * 이어 붙이지 않는 이유가 계약 ①이다. 수정주가 기준이 다른 줄이 한 종목 안에
 * 섞이면 되돌릴 수 없고, 섞였다는 사실조차 값으로는 보이지 않는다.
 */
export async function replaceSymbolFlow(
  symbol: string,
  days: InvestorFlowDayRow[],
  vintage: string,
  fetchedAt: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM trading_investor_flow WHERE symbol = $1', [symbol]);
    await insertFlow(client, symbol, days, vintage, fetchedAt);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** 새 거래일만 덧붙인다. **대조를 통과한 뒤에만 부른다**(계약 ②). */
export async function appendSymbolFlow(
  symbol: string,
  days: InvestorFlowDayRow[],
  vintage: string,
  fetchedAt: number,
): Promise<void> {
  if (days.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertFlow(client, symbol, days, vintage, fetchedAt);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** 한 번에 여러 줄. 21년치는 5,000줄이라 한 줄씩 왕복하면 느리다. */
async function insertFlow(
  client: PoolClient,
  symbol: string,
  days: InvestorFlowDayRow[],
  vintage: string,
  fetchedAt: number,
): Promise<void> {
  const CHUNK = 500;
  for (let offset = 0; offset < days.length; offset += CHUNK) {
    const slice = days.slice(offset, offset + CHUNK);
    const values: unknown[] = [];
    const tuples = slice.map((day, index) => {
      const base = index * 7;
      values.push(
        symbol,
        day.tradingDay,
        day.close,
        day.individual,
        day.foreign,
        day.institution,
        vintage,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4},`
        + ` $${base + 5}, $${base + 6}, $${base + 7}, $${slice.length * 7 + 1})`;
    });
    values.push(fetchedAt);
    await client.query(
      `INSERT INTO trading_investor_flow
         (symbol, trading_day, close, individual, foreign_net, institution, vintage, fetched_at)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (symbol, trading_day) DO NOTHING`,
      values,
    );
  }
}

/** 한 종목의 수급. 날짜 오름차순이다 — 측정이 그대로 먹는다. */
export async function getInvestorFlow(
  symbol: string,
  range: { from?: string; to?: string } = {},
): Promise<InvestorFlowDayRow[]> {
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
  const { rows } = await pool.query<FlowRow>(
    `SELECT trading_day, close, individual, foreign_net, institution
     FROM trading_investor_flow
     WHERE ${conditions.join(' AND ')}
     ORDER BY trading_day`,
    values,
  );
  return rows.map(rowToFlow);
}

export async function getInvestorFlowCursors(): Promise<Map<string, InvestorFlowCursor>> {
  const { rows } = await pool.query<{
    symbol: string;
    oldest_day: string | null;
    newest_day: string | null;
    day_count: number;
    done: boolean;
    last_error: string | null;
    last_attempt_at: string | null;
  }>(
    `SELECT symbol, oldest_day, newest_day, day_count, done, last_error, last_attempt_at
     FROM trading_investor_flow_cursor`,
  );
  return new Map(
    rows.map((row) => [
      row.symbol,
      {
        symbol: row.symbol,
        oldestDay: row.oldest_day,
        newestDay: row.newest_day,
        dayCount: Number(row.day_count),
        done: row.done,
        lastError: row.last_error,
        lastAttemptAt: row.last_attempt_at === null ? null : Number(row.last_attempt_at),
      },
    ]),
  );
}

export async function saveInvestorFlowCursor(cursor: InvestorFlowCursor): Promise<void> {
  await pool.query(
    `INSERT INTO trading_investor_flow_cursor
       (symbol, oldest_day, newest_day, day_count, done, last_error, last_attempt_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (symbol) DO UPDATE SET
       oldest_day = EXCLUDED.oldest_day,
       newest_day = EXCLUDED.newest_day,
       day_count = EXCLUDED.day_count,
       done = EXCLUDED.done,
       last_error = EXCLUDED.last_error,
       last_attempt_at = EXCLUDED.last_attempt_at`,
    [
      cursor.symbol,
      cursor.oldestDay,
      cursor.newestDay,
      cursor.dayCount,
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
export async function recordInvestorFlowFailure(
  symbol: string,
  message: string,
  at: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO trading_investor_flow_cursor (symbol, done, last_error, last_attempt_at)
     VALUES ($1, false, $2, $3)
     ON CONFLICT (symbol) DO UPDATE SET
       last_error = EXCLUDED.last_error,
       last_attempt_at = EXCLUDED.last_attempt_at`,
    [symbol, message, at],
  );
}

/** 저장소 요약. 밤새 돌린 뒤 아침에 이것만 보면 상태를 안다. */
export interface InvestorFlowStoreSummary {
  symbols: number;
  doneSymbols: number;
  failedSymbols: number;
  days: number;
  oldestDay: string | null;
  newestDay: string | null;
}

export async function summarizeInvestorFlowStore(): Promise<InvestorFlowStoreSummary> {
  const flow = await pool.query<{
    symbols: string; days: string; oldest: string | null; newest: string | null;
  }>(
    `SELECT count(DISTINCT symbol)::text AS symbols,
            count(*)::text              AS days,
            min(trading_day)            AS oldest,
            max(trading_day)            AS newest
     FROM trading_investor_flow`,
  );
  const cursors = await pool.query<{ done: string; failed: string }>(
    `SELECT count(*) FILTER (WHERE done)::text                                AS done,
            count(*) FILTER (WHERE NOT done AND last_error IS NOT NULL)::text AS failed
     FROM trading_investor_flow_cursor`,
  );
  const row = flow.rows[0];
  return {
    symbols: Number(row?.symbols ?? 0),
    doneSymbols: Number(cursors.rows[0]?.done ?? 0),
    failedSymbols: Number(cursors.rows[0]?.failed ?? 0),
    days: Number(row?.days ?? 0),
    oldestDay: row?.oldest ?? null,
    newestDay: row?.newest ?? null,
  };
}

/**
 * 값이 없는 날인가. **그 날은 저장하지 않는다** — 계약 ①의 잣대다.
 *
 * 두 가지를 함께 막는다.
 *
 * **① 순매수 셋이 모두 0** — 수급이 시작되기 전(2005-10 이전) 구간이 그 모양으로
 * 온다. 진짜로 하루 종일 아무 순매수도 없었던 날(장기 거래정지)과 구별되지
 * 않지만, 구별할 방법이 응답 안에 없고 그런 날은 어차피 거래대금 문턱에 걸려
 * 후보가 되지 못한다. **가릴 수 없는 것을 사실로 적지 않는 쪽**을 택한다.
 *
 * **② 종가가 0 이하** — 상장 전 날짜를 물으면 **종가도 0**으로 온다
 * (2026-09-02 실측: 408470 한패스의 상장 2026-03-25 이전 71일). 순매수만 보고
 * 걸러도 지금은 함께 잡히지만, **여기서 직접 막는다.** 순매수는 수량이라
 * 금액으로 바꾸려면 이 종가를 곱해야 하고, 0이 섞이면 그 종목의 그날 유입이
 * 통째로 0원이 된다.
 *
 * ★ 이 레포는 **`0원`이라는 시세가 정상 응답으로 지나가는 것**에 이미 당했다
 *   (2026-08-14, 폐지 종목). 그때 배운 것이 *"아는 함정을 호출부에 맡기면
 *   지켜지지 않는다"*였다 — 그래서 저장소가 직접 막는다.
 */
export function isEmptyFlowDay(day: InvestorFlowDayRow): boolean {
  if (day.close <= 0) return true;
  return day.individual === 0 && day.foreign === 0 && day.institution === 0;
}

/**
 * 저장분과 새로 받은 창을 맞춰 본다. **순수 함수라 DB 없이 시험에 태운다.**
 *
 * ★ 대조는 **종가로만** 한다. 순매수로 대조하지 않는 이유는, 액면분할 때 그 수량이
 *   함께 조정되는지 이 레포가 아직 안 재 봤기 때문이다 — 확인 안 한 것으로
 *   종목 전체를 다시 받게 하면 밤샘 수집이 늘어난다. 기준이 바뀌면 **종가가
 *   먼저 말한다**(같은 응답에서 온 값이라 같은 기준을 탄다).
 */
export function compareInvestorFlow(
  stored: InvestorFlowDayRow[],
  fetched: InvestorFlowDayRow[],
): InvestorFlowComparison {
  const storedByDay = new Map(stored.map((day) => [day.tradingDay, day]));
  const newestStored = stored.length > 0 ? stored[stored.length - 1].tradingDay : null;
  const oldestFetched = fetched.length > 0 ? fetched[0].tradingDay : null;

  const mismatches: InvestorFlowMismatch[] = [];
  const newDays: InvestorFlowDayRow[] = [];
  const missingDays: string[] = [];
  let overlapDays = 0;

  for (const day of fetched) {
    const previous = storedByDay.get(day.tradingDay);
    if (previous) {
      overlapDays += 1;
      if (previous.close !== day.close) {
        mismatches.push({
          tradingDay: day.tradingDay,
          storedClose: previous.close,
          fetchedClose: day.close,
        });
      }
      continue;
    }
    /*
     * 저장분에 없는 날. **저장분의 끝보다 뒤면 새 거래일**이고, 사이에 있으면
     * 구멍이다 — 그때는 붙이지 말고 전체를 다시 받아야 한다.
     */
    if (newestStored && day.tradingDay <= newestStored) missingDays.push(day.tradingDay);
    else newDays.push(day);
  }

  // 받아 온 창이 저장분보다 뒤에서 시작하면 겹치는 날이 없다 — 대조를 못 한 것이다.
  if (oldestFetched && newestStored && oldestFetched > newestStored) overlapDays = 0;

  return { mismatches, overlapDays, newDays, missingDays };
}

/**
 * 대조 결과가 **전체를 다시 받으라**고 말하는가.
 *
 * 셋 중 하나면 그렇다: 종가가 어긋났다 · 겹치는 날이 없어 대조를 못 했다 ·
 * 사이에 구멍이 있다. **모를 때 그냥 붙이는 쪽으로 두지 않는다.**
 */
export function needsFullFlowRefetch(comparison: InvestorFlowComparison): boolean {
  return comparison.mismatches.length > 0
    || comparison.overlapDays === 0
    || comparison.missingDays.length > 0;
}
