/**
 * 그날의 시장 상태를 **그날 그대로** 저장한다.
 *
 * ── 왜 필요한가 (2026-08-04에 값으로 확인했다) ───────────────────────────
 *
 * 수급이 가격을 예측하는지 재면서 **오늘 거래대금 순위로 과거 116일을 골랐다.**
 * 그 표본에서는 우위가 있어 보였다 — 20일 축 한쪽 우위 +0.861%.
 *
 * 표본을 코드순 등간격(수익률과 무관한 순서)으로 바꾸자 그 값이 통째로 사라졌다.
 *
 *   기준선 20일 수익:  거래대금순 표본 +10.3%  →  코드순 표본 −5.7%   (16%p)
 *   한쪽 우위 20일:    +0.861%  →  −0.249%                        (부호 반전)
 *
 * 16%p는 시장 수익이 아니라 **"오늘 잘나가는 종목만 봤다"는 인공물**이다.
 * `docs/TRADING_ROADMAP.md`가 적어 둔 *"순서가 반대면 검증할 방법이 영영
 * 없어진다"*가 정확히 이것이다.
 *
 * **이 표가 그 "영영"을 막는다.** 매일 그날의 순위·수급을 그날 저장해 두면,
 * 한 달 뒤에는 *"그날 알 수 있었던 것"*만으로 재구성한 표본이 생긴다.
 * 오늘 시작하면 한 달 뒤에 있고, 안 하면 한 달 뒤에도 지금과 같은 오염된
 * 측정만 가능하다.
 *
 * ── 무엇을 저장하나 ──────────────────────────────────────────────────────
 *
 * **그날 조회해야만 알 수 있는 것**만 담는다. 가격·일봉처럼 나중에 언제든
 * 과거로 받을 수 있는 것은 저장하지 않는다 — 중복이고, 어긋날 여지만 는다.
 *
 * 순위는 그날 그 시각의 것이고 나중에 재현할 수 없다. 수급은 과거로 받을 수
 * 있지만 **순위와 짝지어진 상태**는 그날만 안다.
 */

import { pool } from './client.js';

export interface MarketSnapshotRow {
  /** KST 거래일 `YYYY-MM-DD` */
  tradingDay: string;
  /** 무엇을 찍었나. 나중에 종류가 늘어도 표를 안 늘리게 */
  kind: 'turnoverRanking';
  /** 순위 그대로의 종목코드 배열 */
  symbols: string[];
  /** 찍은 시각과 조건. 같은 날 여러 번 찍을 수 있다 */
  note: string;
}

export async function ensureMarketSnapshotSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS market_snapshot (
      id BIGSERIAL PRIMARY KEY,
      trading_day DATE NOT NULL,
      kind TEXT NOT NULL,
      symbols JSONB NOT NULL,
      note TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    /*
     * 같은 날 같은 종류를 여러 번 찍을 수 있다 — 장중에 순위가 바뀌기 때문이다.
     * 덮어쓰지 않고 쌓는다: **언제 찍은 것인지가 그 값의 일부다.**
     */
    CREATE INDEX IF NOT EXISTS market_snapshot_day_kind_idx
      ON market_snapshot (trading_day DESC, kind);
  `);
}

export async function recordMarketSnapshot(row: MarketSnapshotRow): Promise<void> {
  await pool.query(
    `INSERT INTO market_snapshot (trading_day, kind, symbols, note)
     VALUES ($1::date, $2, $3::jsonb, $4)`,
    [row.tradingDay, row.kind, JSON.stringify(row.symbols), row.note],
  );
}

/**
 * 그날 처음 찍은 것. 측정에 쓸 때는 **가장 이른 것**을 써야 한다 —
 * 장중 늦게 찍은 순위에는 그날의 결과가 이미 섞여 있다.
 */
export async function getEarliestSnapshot(
  tradingDay: string,
  kind: MarketSnapshotRow['kind'],
): Promise<MarketSnapshotRow | null> {
  const { rows } = await pool.query<{ symbols: string[]; note: string }>(
    `SELECT symbols, note FROM market_snapshot
     WHERE trading_day = $1::date AND kind = $2
     ORDER BY created_at ASC LIMIT 1`,
    [tradingDay, kind],
  );
  const row = rows[0];
  return row ? { tradingDay, kind, symbols: row.symbols, note: row.note } : null;
}

/** 며칠치를 찍어 뒀나. 측정을 시작할 수 있는지 판단하는 값이다. */
export async function countSnapshotDays(kind: MarketSnapshotRow['kind']): Promise<number> {
  const { rows } = await pool.query<{ days: string }>(
    `SELECT count(DISTINCT trading_day) AS days FROM market_snapshot WHERE kind = $1`,
    [kind],
  );
  return Number(rows[0]?.days ?? 0);
}
