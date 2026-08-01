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
  estimated_price: string | null;
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
  /**
   * 시장가 주문의 판정 시점 추정 단가. 지정가에는 넣지 않는다.
   * 일일 금액 한도가 이 값으로 쌓인다 — 없으면 그 주문은 한도에 안 잡힌다.
   */
  estimatedPrice?: number;
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
      -- 시장가 주문의 판정 시점 추정 단가 (지정가에는 없다). 아래 ALTER의 주석 참고.
      estimated_price numeric(20, 6),
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
     * 시장가 주문의 판정 시점 추정 단가. 지정가 주문에는 비어 있다.
     *
     * limit_price에 넣지 않는다 — 그 컬럼은 "지정가 단가"라는 뜻이고, 거기 추정치를
     * 넣으면 이 기록을 읽는 사람(화면의 "실계좌 주문 기록" 포함)이 지정가로 낸
     * 주문이라고 오해한다. 리스크 룰의 일일 금액 한도는 이 값으로 센다(orderUsage.ts) —
     * 예전에는 limit_price만 더해서 시장가 주문이 영원히 0원으로 잡혔다.
     */
    ALTER TABLE trading_broker_orders ADD COLUMN IF NOT EXISTS estimated_price numeric(20, 6);

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
          order_type, quantity, limit_price, estimated_price, order_no, order_branch_no, original_order_no,
          message, blockers, client_order_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18)
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
        attempt.estimatedPrice ?? null,
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

/**
 * 주문 기록. 상한을 넘겼는지도 함께 알린다.
 *
 * 예전에는 배열만 돌려줘서, 화면이 `50건`을 보여주면서 그게 전부인지 잘린
 * 것인지 말할 방법이 없었다. 한 건 더 조회해 보고 넘치면 그 사실을 넘긴다 —
 * COUNT를 따로 세는 것보다 싸다.
 */
export async function getBrokerOrderRecords(
  accountId?: string,
  limit = 50,
): Promise<{ records: BrokerOrderRecord[]; hasMore: boolean }> {
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 200) : 50;
  const { rows } = await pool.query<BrokerOrderRow>(
    `
      SELECT
        id, account_id, action, status, side, symbol, requested_instrument_id,
        order_type, quantity, limit_price, estimated_price,
        order_no, order_branch_no, original_order_no, message, blockers,
        (EXTRACT(EPOCH FROM created_at) * 1000)::bigint::text AS created_at_ms
      FROM trading_broker_orders
      WHERE ($1::text IS NULL OR account_id = $1)
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [accountId ?? null, safeLimit + 1],
  );
  const hasMore = rows.length > safeLimit;
  return { records: rows.slice(0, safeLimit).map(rowToBrokerOrderRecord), hasMore };
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
    estimatedPrice: optionalNumber(row.estimated_price),
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
          order_type = $7, quantity = $8, limit_price = $9, estimated_price = $10, order_no = $11,
          order_branch_no = $12, original_order_no = $13, message = $14, blockers = $15::jsonb
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
        attempt.estimatedPrice ?? null,
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

/**
 * 그 계좌·그 종목의 **마지막 매수 접수 시각**(epoch ms). 자동매매의 최소 보유
 * 시간이 이 값으로 잰다.
 *
 * **KIS 잔고(`positions`)에는 매수 시각이 없다.** 그래서 우리가 남긴 감사 기록에서
 * 읽는다 — 러너가 재시작해도 남고, 화면에서 수동으로 산 것도 같은 표에 들어온다.
 *
 * `status='submitted'`인 `place` 매수만 센다. `blocked`·`rejected`는 접수되지
 * 않았으므로 포지션이 된 적이 없고, 그걸 세면 사지도 않은 종목이 못 팔게 된다.
 * 일일 사용량 집계(`db/riskRules.ts`의 `getTodayUsage`)와 같은 잣대다.
 *
 * **여기 없는 매수는 알 수 없다** — 러너를 켜기 전부터 들고 있던 것, 다른 앱으로
 * 산 것. 그 종목은 `undefined`로 나가고 러너는 **막지 않고 판다**(`minHold.ts`의
 * ★ 절). 못 파는 쪽이 훨씬 위험하다.
 *
 * **잰 것은 접수 시각이지 체결 시각이 아니다.** 이 표에 체결 시각이 없다. 러너는
 * 늘 시장가라 둘이 거의 같지만, 사람이 낸 지정가가 한참 뒤에 체결되면 어긋난다 —
 * 그때는 실제보다 이르게 잰 것이라 **더 오래 못 파는 쪽**으로 틀린다.
 */
export async function getLastBuySubmittedAt(
  accountId: string,
  symbols: string[],
): Promise<Map<string, number>> {
  const wanted = [...new Set(symbols.filter((symbol) => symbol.trim() !== ''))];
  if (wanted.length === 0) return new Map();
  const { rows } = await pool.query<{ symbol: string; bought_at_ms: string }>(
    `
      SELECT symbol, (EXTRACT(EPOCH FROM MAX(created_at)) * 1000)::bigint::text AS bought_at_ms
      FROM trading_broker_orders
      WHERE account_id = $1
        AND action = 'place'
        AND status = 'submitted'
        AND side = 'buy'
        AND symbol = ANY($2::text[])
      GROUP BY symbol
    `,
    [accountId, wanted],
  );
  const found = new Map<string, number>();
  for (const row of rows) {
    const at = Number(row.bought_at_ms);
    // 읽을 수 없는 시각은 넣지 않는다. 넣으면 NaN 비교가 조용히 "안 지났다"가 된다.
    if (Number.isFinite(at)) found.set(row.symbol, at);
  }
  return found;
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
