/**
 * 그날의 종목 선정을 **누가 왜 골랐는지와 함께** 남긴다.
 *
 * ── 왜 필요한가 (2026-08-04) ──────────────────────────────────────────────
 *
 * 사용자가 매일 아침 에이전트(뉴스 리서치 → 분석 → 퀀트)로 그날 종목을 정하고
 * 러너를 돌리는 구조를 원한다. 그런데 `docs/TRADING_ROADMAP.md`가 정한 순서는
 * 이렇다.
 *
 *   1. 종목 선정을 숫자로 먼저 (과거로 백테스트되는 것)
 *   2. **뉴스의 값어치를 과거로 잰다** — 우위가 안 나오면 실시간에 넣을 이유가 없다
 *   3. 우위가 확인되면 후보 좁히기에만
 *
 * 지금 하려는 것은 2번을 건너뛰고 3번을 하는 것이다. 문서는 *"순서가 반대면
 * 검증할 방법이 영영 없어진다"*고 적어 뒀다.
 *
 * **이 표가 그 "영영"을 막는다.** 고른 것을 그날그날 남겨 두면, 나중에 같은 날의
 * 숫자 기준선과 견줘 **에이전트 선정이 값어치가 있었는지 되짚어 잴 수 있다.**
 * 순서를 앞당기더라도 검증 가능성은 잃지 않는다.
 *
 * ── 무엇을 남기나 ────────────────────────────────────────────────────────
 *
 * 고른 종목만 남기면 안 된다. **왜 골랐는지와 그때 무엇을 알고 있었는지**가
 * 함께 있어야 나중에 판단을 재구성할 수 있다. 특히 뉴스는 사후에 다시 찾기
 * 어렵다 — 기사가 내려가거나 검색 순위에서 사라진다.
 *
 * 이 표는 **주문 경로가 아니다.** 여기 적힌 것이 곧바로 매수로 이어지지 않고,
 * 리스크 룰과 러너의 필터를 그대로 통과해야 한다.
 */

import { pool } from './client.js';

/** 누가 고른 선정인가. 나중에 서로 견주려면 갈라 둬야 한다. */
export type SelectionSource =
  /** 에이전트(뉴스·분석·퀀트)가 고른 것 */
  | 'agent'
  /** 러너 자신의 숫자 규칙(거래대금 순)이 고른 것. 기준선이다 */
  | 'numeric';

export interface DailySelection {
  /** KST 거래일 `YYYY-MM-DD` */
  tradingDay: string;
  accountId: string;
  source: SelectionSource;
  /** 고른 종목코드 */
  symbols: string[];
  /**
   * 왜 이것을 골랐나. 사람이 읽을 글이다.
   *
   * 나중에 이 선정이 좋았는지 되짚을 때 숫자만으로는 알 수 없다 — 무엇을 보고
   * 골랐는지가 있어야 "그 근거가 실제로 작동했나"를 물을 수 있다.
   */
  rationale: string;
  /** 그때 참고한 출처(뉴스 URL 등). 기사는 나중에 사라진다 */
  sources?: string[];
}

export async function ensureDailySelectionSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_daily_selection (
      id BIGSERIAL PRIMARY KEY,
      trading_day DATE NOT NULL,
      account_id TEXT NOT NULL,
      source TEXT NOT NULL,
      symbols JSONB NOT NULL,
      rationale TEXT NOT NULL,
      sources JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    /*
     * 같은 날 같은 출처로 여러 번 적을 수 있다 — 장중에 다시 고를 수 있기
     * 때문이다. 덮어쓰지 않고 쌓는다: **바뀌었다는 사실 자체가 기록이다.**
     */
    CREATE INDEX IF NOT EXISTS trading_daily_selection_day_idx
      ON trading_daily_selection (trading_day DESC, account_id, source);
  `);
}

export async function recordDailySelection(selection: DailySelection): Promise<void> {
  await pool.query(
    `INSERT INTO trading_daily_selection (trading_day, account_id, source, symbols, rationale, sources)
     VALUES ($1::date, $2, $3, $4::jsonb, $5, $6::jsonb)`,
    [
      selection.tradingDay,
      selection.accountId,
      selection.source,
      JSON.stringify(selection.symbols),
      selection.rationale,
      JSON.stringify(selection.sources ?? []),
    ],
  );
}

/** 그날의 선정들. 같은 날 여러 건이면 나중 것이 앞이다. */
export async function getDailySelections(
  accountId: string,
  tradingDay: string,
): Promise<DailySelection[]> {
  const { rows } = await pool.query<{
    trading_day: Date;
    account_id: string;
    source: SelectionSource;
    symbols: string[];
    rationale: string;
    sources: string[];
  }>(
    `SELECT trading_day, account_id, source, symbols, rationale, sources
     FROM trading_daily_selection
     WHERE account_id = $1 AND trading_day = $2::date
     ORDER BY created_at DESC`,
    [accountId, tradingDay],
  );
  return rows.map((row) => ({
    tradingDay,
    accountId: row.account_id,
    source: row.source,
    symbols: row.symbols,
    rationale: row.rationale,
    sources: row.sources,
  }));
}
