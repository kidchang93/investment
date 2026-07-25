import { randomUUID } from 'node:crypto';
import { pool } from './client.js';
import type { BrokerOrderRecord, OrderSide, OrderType } from '@invest/shared';

/**
 * 실계좌 주문 전송 감사 기록.
 *
 * paper 주문(`trading_order_intents`)과 분리한다. 저장 단위가 다르고, 실계좌는
 * "보내지 못한 시도"까지 남겨야 하기 때문이다. 게이트에 막힌 주문도 버리지 않고
 * `blocked`로 남겨 왜 막혔는지 추적한다.
 *
 * 계좌번호(CANO)·앱키·확인 문구는 **여기에 저장하지 않는다.** 화면용 계좌 id만 남긴다.
 */

interface BrokerOrderRow {
  id: string;
  account_id: string;
  action: BrokerOrderRecord['action'];
  status: BrokerOrderRecord['status'];
  side: OrderSide | null;
  symbol: string | null;
  requested_instrument_id: string | null;
  order_type: OrderType | null;
  quantity: string | null;
  limit_price: string | null;
  order_no: string | null;
  order_branch_no: string | null;
  original_order_no: string | null;
  message: string;
  blockers: string[] | null;
  created_at_ms: string;
}

export interface BrokerOrderAttempt {
  accountId: string;
  action: BrokerOrderRecord['action'];
  status: BrokerOrderRecord['status'];
  message: string;
  side?: OrderSide;
  /** 마스터에서 확인된 종목 id (FK) */
  instrumentId?: string;
  /** 사용자가 보낸 종목 id 원문. 확인 전 단계에서 막혀도 남긴다 */
  requestedInstrumentId?: string;
  symbol?: string;
  orderType?: OrderType;
  quantity?: number;
  limitPrice?: number;
  orderNo?: string;
  orderBranchNo?: string;
  originalOrderNo?: string;
  blockers?: string[];
}

export async function ensureBrokerOrderSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_broker_orders (
      id text PRIMARY KEY,
      broker text NOT NULL DEFAULT 'kis',
      account_id text NOT NULL,
      action text NOT NULL,
      status text NOT NULL,
      side text,
      instrument_id text REFERENCES instruments(id) ON DELETE SET NULL,
      -- 게이트에 먼저 막히면 종목을 조회하기 전이라 instrument_id가 비는데,
      -- "무엇을 주문하려 했는지"는 남아야 하므로 요청 원문을 FK 없이 따로 적는다.
      requested_instrument_id text,
      symbol text,
      order_type text,
      quantity numeric(24, 8),
      limit_price numeric(20, 6),
      order_no text,
      order_branch_no text,
      original_order_no text,
      message text NOT NULL,
      blockers jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE trading_broker_orders ADD COLUMN IF NOT EXISTS requested_instrument_id text;

    CREATE INDEX IF NOT EXISTS trading_broker_orders_account_created_idx
      ON trading_broker_orders (account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS trading_broker_orders_order_no_idx
      ON trading_broker_orders (order_no);
  `);
}

/**
 * 전송 시도를 그대로 남긴다.
 * 기록 실패가 주문 응답 자체를 깨뜨리면 안 되므로 예외를 밖으로 던지지 않고 false를 돌려준다.
 * 호출부(`server.ts`)가 false를 보고 경고 로그를 남긴다.
 */
export async function recordBrokerOrderAttempt(attempt: BrokerOrderAttempt): Promise<boolean> {
  try {
    await pool.query(
      `
        INSERT INTO trading_broker_orders (
          id, account_id, action, status, side, instrument_id, requested_instrument_id, symbol,
          order_type, quantity, limit_price, order_no, order_branch_no, original_order_no, message, blockers
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
      `,
      [
        randomUUID(),
        attempt.accountId,
        attempt.action,
        attempt.status,
        attempt.side ?? null,
        attempt.instrumentId ?? null,
        attempt.requestedInstrumentId ?? attempt.instrumentId ?? null,
        attempt.symbol ?? null,
        attempt.orderType ?? null,
        attempt.quantity ?? null,
        attempt.limitPrice ?? null,
        attempt.orderNo ?? null,
        attempt.orderBranchNo ?? null,
        attempt.originalOrderNo ?? null,
        attempt.message,
        JSON.stringify(attempt.blockers ?? []),
      ],
    );
    return true;
  } catch {
    return false;
  }
}

export async function getBrokerOrderRecords(accountId?: string, limit = 50): Promise<BrokerOrderRecord[]> {
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 200) : 50;
  const { rows } = await pool.query<BrokerOrderRow>(
    `
      SELECT
        id, account_id, action, status, side, symbol, requested_instrument_id,
        order_type, quantity, limit_price,
        order_no, order_branch_no, original_order_no, message, blockers,
        (EXTRACT(EPOCH FROM created_at) * 1000)::bigint::text AS created_at_ms
      FROM trading_broker_orders
      WHERE ($1::text IS NULL OR account_id = $1)
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [accountId ?? null, safeLimit],
  );
  return rows.map(rowToBrokerOrderRecord);
}

function optionalNumber(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rowToBrokerOrderRecord(row: BrokerOrderRow): BrokerOrderRecord {
  return {
    id: row.id,
    broker: 'kis',
    accountId: row.account_id,
    action: row.action,
    status: row.status,
    side: row.side ?? undefined,
    symbol: row.symbol ?? undefined,
    requestedInstrumentId: row.requested_instrument_id ?? undefined,
    orderType: row.order_type ?? undefined,
    quantity: optionalNumber(row.quantity),
    limitPrice: optionalNumber(row.limit_price),
    orderNo: row.order_no ?? undefined,
    orderBranchNo: row.order_branch_no ?? undefined,
    originalOrderNo: row.original_order_no ?? undefined,
    message: row.message,
    blockers: row.blockers ?? [],
    createdAt: Number(row.created_at_ms),
  };
}
