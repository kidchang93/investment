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

    /*
     * **돌아야 할 상태**를 적어 둔다. 지금 도는 러너는 메모리에만 있어서
     * 프로세스가 죽으면 함께 사라진다 — 2026-08-03 장중에 개발 서버가 내려갔고
     * 보유 8종목이 아무도 안 보는 채로 남았다. 사람이 알아채기 전까지는
     * 매도 신호가 나도 나갈 수 없다.
     *
     * 한 달을 무인으로 돌리려면 프로세스가 다시 떴을 때 스스로 돌아와야 한다.
     */
    CREATE TABLE IF NOT EXISTS trading_auto_desired (
      account_id TEXT PRIMARY KEY,
      config JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

/**
 * "이 계좌는 돌아야 한다"를 적는다. 시작할 때 부르고, 멈출 때 지운다.
 *
 * **스스로 멈춘 것(목표 도달·중단선·연속 실패)도 지운다.** 그건 판단이 내려진
 * 것이라 다시 살리면 그 판단을 무시하는 셈이다. 지워지지 않고 남는 경우는
 * 하나뿐이다 — 프로세스가 그 일을 할 새도 없이 죽은 것.
 */
export async function setDesiredAutoTrader(accountId: string, config: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO trading_auto_desired (account_id, config, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (account_id) DO UPDATE SET config = EXCLUDED.config, updated_at = now()`,
    [accountId, JSON.stringify(config)],
  );
}

export async function clearDesiredAutoTrader(accountId: string): Promise<void> {
  await pool.query(`DELETE FROM trading_auto_desired WHERE account_id = $1`, [accountId]);
}

/** 프로세스가 죽을 때 돌고 있던 계좌들. 부팅 때 이것으로 되살린다. */
export async function listDesiredAutoTraders(): Promise<Array<{ accountId: string; config: unknown }>> {
  const { rows } = await pool.query<{ account_id: string; config: unknown }>(
    `SELECT account_id, config FROM trading_auto_desired`,
  );
  return rows.map((row) => ({ accountId: row.account_id, config: row.config }));
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

/** 실행 로그. 주문 기록과 같은 이유로 상한 초과 여부도 함께 준다. */
export async function getAutoTraderRuns(
  accountId: string,
  limit = 50,
): Promise<{ runs: AutoTraderRun[]; hasMore: boolean }> {
  const { rows } = await pool.query<AutoTraderRunRow>(
    `
      SELECT id, created_at, status, message, instrument_id, side, quantity, price, equity
      FROM trading_auto_runs
      WHERE account_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [accountId, limit + 1],
  );
  const hasMore = rows.length > limit;
  return {
    hasMore,
    runs: rows.slice(0, limit).map((row) => ({
      id: Number(row.id),
      createdAt: row.created_at.getTime(),
      status: row.status as AutoTraderStatus,
      message: row.message,
      instrumentId: row.instrument_id ?? undefined,
      side: (row.side as OrderSide | null) ?? undefined,
      quantity: row.quantity === null ? undefined : Number(row.quantity),
      price: row.price === null ? undefined : Number(row.price),
      equity: row.equity === null ? undefined : Number(row.equity),
    })),
  };
}
