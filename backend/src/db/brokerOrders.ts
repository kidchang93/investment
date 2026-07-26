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
 * 계좌번호(CANO)·앱키는 **여기에 저장하지 않는다.** 화면용 계좌 id만 남긴다.
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
  /** 멱등성 키. 전송한 주문에만 단다 */
  clientOrderId?: string;
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
    ALTER TABLE trading_broker_orders ADD COLUMN IF NOT EXISTS client_order_id text;

    /*
     * 멱등성 키. 같은 키로 다시 요청하면 새 주문을 내지 않고 앞선 결과를 돌려준다.
     * 네트워크가 끊겨 재시도할 때 같은 주문이 두 번 나가는 것을 막는 유일한 장치라
     * DB 유니크 제약으로 건다 — 애플리케이션에서 조회 후 삽입하면 동시 요청 사이에
     * 틈이 생긴다.
     *
     * 보내지 못한 시도(blocked)에는 키를 달지 않는다. 막힌 주문은 조건을 고쳐
     * 다시 시도하는 게 정상이라 같은 키를 막으면 오히려 방해가 된다.
     */
    CREATE UNIQUE INDEX IF NOT EXISTS trading_broker_orders_client_order_id_key
      ON trading_broker_orders (client_order_id)
      WHERE client_order_id IS NOT NULL;

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
          order_type, quantity, limit_price, order_no, order_branch_no, original_order_no, message, blockers,
          client_order_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17)
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
        attempt.clientOrderId ?? null,
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

/**
 * 멱등성 키를 먼저 선점한다.
 *
 * 순서가 핵심이다 — 주문을 내기 **전에** 키를 잡는다. 주문 후에 잡으면 그 사이
 * 재시도가 들어와 같은 주문이 두 번 나간다. 유니크 제약이 두 번째 삽입을 막으므로
 * 동시 요청이 겹쳐도 하나만 통과한다.
 *
 * - `true`: 이 요청이 키를 잡았다. 주문을 진행한다.
 * - `false`: 이미 같은 키로 처리된 요청이 있다. 주문을 내지 않는다.
 *
 * 키를 잡지 못한 이유가 유니크 충돌이 아니라 DB 오류라면 던진다. 이때는 중복인지
 * 알 수 없으므로 주문을 내면 안 된다 — 모르면 보내지 않는 쪽이 안전하다.
 */
export async function claimClientOrderId(
  accountId: string,
  clientOrderId: string,
  action: BrokerOrderRecord['action'],
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `
      INSERT INTO trading_broker_orders (id, account_id, action, status, message, client_order_id)
      VALUES ($1, $2, $3, 'sending', '전송 중', $4)
      ON CONFLICT (client_order_id) WHERE client_order_id IS NOT NULL DO NOTHING
    `,
    [randomUUID(), accountId, action, clientOrderId],
  );
  return rowCount === 1;
}

/** 선점해 둔 줄을 결과로 채운다. 실패해도 주문 응답을 깨뜨리지 않는다. */
export async function completeClaimedOrder(
  clientOrderId: string,
  attempt: Omit<BrokerOrderAttempt, 'accountId' | 'action' | 'clientOrderId'>,
): Promise<boolean> {
  try {
    await pool.query(
      `
        UPDATE trading_broker_orders SET
          status = $2, side = $3, instrument_id = $4, requested_instrument_id = $5, symbol = $6,
          order_type = $7, quantity = $8, limit_price = $9, order_no = $10, order_branch_no = $11,
          original_order_no = $12, message = $13, blockers = $14::jsonb
        WHERE client_order_id = $1
      `,
      [
        clientOrderId,
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

/** 이미 처리된 키의 결과. 재시도에 그대로 돌려준다. */
export async function getOrderByClientOrderId(
  clientOrderId: string,
): Promise<{ status: string; orderNo: string | null; orderBranchNo: string | null; message: string } | null> {
  const { rows } = await pool.query<{
    status: string;
    order_no: string | null;
    order_branch_no: string | null;
    message: string;
  }>(
    `SELECT status, order_no, order_branch_no, message FROM trading_broker_orders WHERE client_order_id = $1`,
    [clientOrderId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status,
    orderNo: row.order_no,
    orderBranchNo: row.order_branch_no,
    message: row.message,
  };
}
