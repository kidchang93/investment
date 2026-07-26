import { pool } from './client.js';
import type { AutoTraderRun, AutoTraderStatus, OrderSide } from '@invest/shared';

/**
 * 자동매매 실행 기록.
 *
 * 러너가 한 번 돌 때마다 무엇을 했는지(또는 왜 아무것도 안 했는지) 한 줄씩 남긴다.
 * 주문을 낸 회차만 남기면 "왜 안 샀는지"를 나중에 알 수 없어서, 신호가 없던
 * 회차도 남긴다. 사고가 났을 때 되짚을 수 있는 유일한 근거다.
 *
 * 계좌번호·앱키는 담지 않는다. 화면용 계좌 id만 남긴다.
 */

export interface AutoTraderRunInput {
  accountId: string;
  status: AutoTraderStatus;
  message: string;
  instrumentId?: string;
  side?: OrderSide;
  quantity?: number;
  price?: number;
  equity?: number;
}

interface AutoTraderRunRow {
  id: string;
  created_at: Date;
  status: string;
  message: string;
  instrument_id: string | null;
  side: string | null;
  quantity: string | null;
  price: string | null;
  equity: string | null;
}

export async function ensureAutoTraderSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_auto_runs (
      id BIGSERIAL PRIMARY KEY,
      account_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      instrument_id TEXT,
      side TEXT,
      quantity NUMERIC,
      price NUMERIC,
      equity NUMERIC
    );

    CREATE INDEX IF NOT EXISTS trading_auto_runs_account_created_idx
      ON trading_auto_runs (account_id, created_at DESC);
  `);
}

/**
 * 실행 기록 한 줄. 기록이 실패해도 러너를 멈추지 않는다 —
 * 기록 때문에 매매가 끊기면 더 곤란하다. 대신 false를 돌려 호출자가 알 수 있게 한다.
 */
export async function recordAutoTraderRun(input: AutoTraderRunInput): Promise<boolean> {
  try {
    await pool.query(
      `
        INSERT INTO trading_auto_runs
          (account_id, status, message, instrument_id, side, quantity, price, equity)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        input.accountId,
        input.status,
        input.message,
        input.instrumentId ?? null,
        input.side ?? null,
        input.quantity ?? null,
        input.price ?? null,
        input.equity ?? null,
      ],
    );
    return true;
  } catch {
    return false;
  }
}

export async function getAutoTraderRuns(accountId: string, limit = 50): Promise<AutoTraderRun[]> {
  const { rows } = await pool.query<AutoTraderRunRow>(
    `
      SELECT id, created_at, status, message, instrument_id, side, quantity, price, equity
      FROM trading_auto_runs
      WHERE account_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [accountId, limit],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    createdAt: row.created_at.getTime(),
    status: row.status as AutoTraderStatus,
    message: row.message,
    instrumentId: row.instrument_id ?? undefined,
    side: (row.side as OrderSide | null) ?? undefined,
    quantity: row.quantity === null ? undefined : Number(row.quantity),
    price: row.price === null ? undefined : Number(row.price),
    equity: row.equity === null ? undefined : Number(row.equity),
  }));
}
