import { randomUUID } from 'node:crypto';
import { pool } from './client.js';
import type { BrokerOrderRecord, OrderSide, OrderType } from '@invest/shared';
import type { SubmittedQuantity } from '../trading/layers.js';

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
  stop_price: string | null;
  order_no: string | null;
  order_branch_no: string | null;
  original_order_no: string | null;
  message: string;
  blockers: string[] | null;
  created_at_ms: string;
}

export interface BrokerOrderAttempt {
  accountId: string;
  /**
   * 어느 층의 주문인가(`etf`·`short`·`bet`). **증권사 잔고는 층을 모른다** —
   * 같은 종목을 여러 층에서 사면 수량이 합쳐지므로, 체결을 층에 되돌리려면
   * 주문 시점에 적어 둬야 한다. 없으면 `layerSync`가 층을 물어봐야 한다.
   */
  layer?: string;
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
  /**
   * 스톱가. 스톱지정가로 낸 주문에만 넣는다.
   *
   * `limitPrice`에 합치지 않는다 — **성질이 다른 값이다.** 스톱가는 "언제 나가는가",
   * 지정가는 "얼마에 나가는가"다. 합치면 손절 조건이 붙은 주문과 그냥 지정가
   * 주문이 기록에서 똑같이 보인다.
   */
  stopPrice?: number;
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
     * 스톱가(스톱지정가 주문의 조건가격). 그 주문에만 값이 있다.
     *
     * limit_price와 갈라 둔다 — 스톱가는 "언제 나가는가"이고 지정가는 "얼마에
     * 나가는가"다. 한 칸에 합치면 손절 조건이 붙은 주문과 그냥 지정가 주문이
     * 기록에서 구별되지 않는다. 손절이 걸려 있었는지는 나중에 반드시 물어보게 된다.
     */
    ALTER TABLE trading_broker_orders ADD COLUMN IF NOT EXISTS stop_price numeric(20, 6);
    -- ★ 3층 중 어느 층의 주문인가. 증권사 잔고는 층을 모르므로 여기서 기억한다.
    --   비어 있으면 옛 주문(층 개념이 생기기 전)이다 — 0으로 채우지 않는다.
    ALTER TABLE trading_broker_orders ADD COLUMN IF NOT EXISTS layer text;

    /*
     * ★ **실제로 얼마에 몇 주가 붙었나** (2026-08-22).
     *
     * 그 전까지 이 표에는 **접수한 값만** 있었다 — quantity(주문수량)와
     * limit_price(지정가), 시장가면 estimated_price(판정 시점 추정치).
     * 체결은 증권사에만 있었고 우리 기록은 "냈다"에서 멈췄다.
     *
     * 그래서 실현손익을 이 표로 세면 **낙관 쪽으로 틀린다**(2026-08-03 실측:
     * 4건 전부 유리한 방향 +20,940원 = 시장가 슬리피지가 통째로 빠진 것).
     *
     * ★ **접수값과 체결값의 차이를 전부 슬리피지라고 읽으면 안 된다.** 지정가는
     *   그 값보다 유리하게 붙는 것이 정상이다(2026-08-22 실측: 지정가 8건 중
     *   6건이 유리한 방향, 최대 −0.77%). **슬리피지는 시장가 주문에서
     *   estimated_price 대비로만 뜻이 있다.** 둘을 섞어 평균 내면 매매비용이
     *   실제보다 싸게 나온다.
     *
     * ★ 비어 있는 것은 "체결 0"이 아니라 **"아직 안 받아 왔다"**이다.
     *   0으로 채우지 않는다 — 미체결과 구별되지 않게 된다.
     */
    ALTER TABLE trading_broker_orders ADD COLUMN IF NOT EXISTS filled_quantity numeric(24, 8);
    ALTER TABLE trading_broker_orders ADD COLUMN IF NOT EXISTS filled_price numeric(20, 6);
    -- 체결 시각이 아니라 **우리가 받아 적은 시각**이다. KIS 체결 조회는 체결
    -- 시각을 안 준다(주문시각만 준다) — 이름이 사실과 어긋나지 않게 갈라 둔다.
    ALTER TABLE trading_broker_orders ADD COLUMN IF NOT EXISTS fills_synced_at timestamptz;

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
          order_type, quantity, limit_price, estimated_price, stop_price, order_no, order_branch_no,
          original_order_no, message, blockers, client_order_id, layer
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, $19, $20)
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
        attempt.stopPrice ?? null,
        attempt.orderNo ?? null,
        attempt.orderBranchNo ?? null,
        attempt.originalOrderNo ?? null,
        attempt.message,
        JSON.stringify(attempt.blockers ?? []),
        attempt.clientOrderId ?? null,
        attempt.layer ?? null,
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
        order_type, quantity, limit_price, estimated_price, stop_price,
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
    stopPrice: optionalNumber(row.stop_price),
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

/**
 * 선점해 둔 줄을 결과로 채운다. 실패해도 주문 응답을 깨뜨리지 않는다.
 *
 * ★ **`layer`를 반드시 함께 채운다** (2026-08-21에 빠져 있는 것을 잡았다).
 *   `claimClientOrderId`가 만든 줄에는 층이 없고 여기서도 안 채우고 있어서,
 *   **멱등 키를 쓰는 모든 주문의 층이 사라졌다.** 집행기는 항상 그 키를 쓰므로
 *   자동 매매 전부가 해당한다 — 2026-08-20 티에스이 매수가 유망주 층 대신
 *   **ETF 층으로** 들어갔고 층별 성과가 그만큼 거짓이 됐다.
 *
 *   증권사 잔고는 층을 모른다. 주문 시점에 안 적으면 되돌릴 길이 없다.
 */
export async function completeClaimedOrder(
  clientOrderId: string,
  attempt: Omit<BrokerOrderAttempt, 'accountId' | 'action' | 'clientOrderId'>,
): Promise<boolean> {
  try {
    await pool.query(
      `
        UPDATE trading_broker_orders SET
          status = $2, side = $3, instrument_id = $4, requested_instrument_id = $5, symbol = $6,
          order_type = $7, quantity = $8, limit_price = $9, estimated_price = $10, stop_price = $11,
          order_no = $12, order_branch_no = $13, original_order_no = $14, message = $15,
          blockers = $16::jsonb, layer = $17
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
        attempt.stopPrice ?? null,
        attempt.orderNo ?? null,
        attempt.orderBranchNo ?? null,
        attempt.originalOrderNo ?? null,
        attempt.message,
        JSON.stringify(attempt.blockers ?? []),
        attempt.layer ?? null,
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

/**
 * **체결을 주문 기록에 되채운다.** 증권사 체결 조회로 받은 값이다.
 *
 * ── 왜 되채우나 (2026-08-22) ─────────────────────────────────────────────
 *
 * 주문 기록은 "냈다"에서 멈춰 있었다. 실제 체결단가는 증권사에만 있어서,
 * 슬리피지를 재려면 사람이 손으로 체결 조회를 열어 봐야 했다.
 *
 * ★ **접수값을 덮어쓰지 않는다.** `quantity`·`limit_price`·`estimated_price`는
 *   그대로 두고 체결 칸만 채운다 — 둘이 얼마나 벌어졌는지가 슬리피지다.
 *   덮어쓰면 그 질문을 영영 못 묻는다.
 *
 * ★ **부분체결이면 그 시점의 값**이다. 다음에 다시 부르면 늘어난 값으로 덮인다.
 *   `fills_synced_at`이 언제 기준인지 말해 준다.
 *
 * @returns 실제로 바뀐 행 수. 0이면 그 주문번호가 우리 기록에 없다 —
 *          사람이 HTS로 낸 주문이거나 우리가 기록에 실패한 것이다.
 */
export async function applyOrderFill(
  accountId: string,
  orderNo: string,
  filledQuantity: number,
  filledPrice: number,
): Promise<number> {
  if (!orderNo || !Number.isFinite(filledQuantity) || filledQuantity <= 0) return 0;
  if (!Number.isFinite(filledPrice) || filledPrice <= 0) return 0;
  const { rowCount } = await pool.query(
    `UPDATE trading_broker_orders
        SET filled_quantity = $3, filled_price = $4, fills_synced_at = now()
      WHERE account_id = $1 AND order_no = $2`,
    [accountId, orderNo, filledQuantity, filledPrice],
  );
  return rowCount ?? 0;
}

/** 이미 처리된 키의 결과. 재시도에 그대로 돌려준다. */
export async function getOrderByClientOrderId(
  clientOrderId: string,
): Promise<{
  status: string;
  orderNo: string | null;
  orderBranchNo: string | null;
  message: string;
  /** 3층 중 어디. 멱등 재요청이 층까지 되돌려줘야 집행기가 되짚을 수 있다 */
  layer: string | null;
} | null> {
  const { rows } = await pool.query<{
    status: string;
    order_no: string | null;
    order_branch_no: string | null;
    message: string;
    layer: string | null;
  }>(
    `SELECT status, order_no, order_branch_no, message, layer FROM trading_broker_orders WHERE client_order_id = $1`,
    [clientOrderId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    status: row.status,
    orderNo: row.order_no,
    orderBranchNo: row.order_branch_no,
    message: row.message,
    layer: row.layer,
  };
}

/**
 * 오늘 **실제로 증권사에 나간** 신규 주문의 수량. 잔고 대조가 쓴다.
 *
 * ── 왜 필요한가 (2026-09-02) ─────────────────────────────────────────────
 *
 * 장부는 체결이 확인된 것만 담고 그 확인은 마감 정리에서 한다. 그래서 장중에
 * 체결되면 15:40까지 **반드시** 장부와 잔고가 어긋나 보이고, 그 사이 경보가
 * "장부와 잔고가 어긋난다"를 울린다. 오늘 우리가 낸 주문으로 설명되는 차이는
 * 알릴 것이 아니다 → `trading/layers.ts`의 `explainMismatches`.
 *
 * ★ `action='place'` · `status='submitted'`만이다. 막히거나 거부된 것은 잔고를
 *   바꾸지 않고, `cancel`은 오히려 미체결을 되돌린다. **접수된 신규 주문만**
 *   잔고를 움직일 수 있다.
 *
 * ★ 날짜는 **KST 기준**이다. `created_at::date`로 자르면 UTC로 판정해 개장 전
 *   주문이 어제로 밀린다 — 이 레포가 하트비트에서 이미 겪은 함정이다.
 */
export async function getTodaySubmittedQuantities(
  accountId: string,
): Promise<SubmittedQuantity[]> {
  const { rows } = await pool.query<{ symbol: string; side: string; quantity: string }>(
    `SELECT symbol, side, quantity::text
       FROM trading_broker_orders
      WHERE account_id = $1
        AND action = 'place'
        AND status = 'submitted'
        AND side IS NOT NULL
        AND symbol IS NOT NULL
        AND quantity IS NOT NULL
        AND (created_at AT TIME ZONE 'Asia/Seoul')::date
            = (now() AT TIME ZONE 'Asia/Seoul')::date`,
    [accountId],
  );
  return rows
    .filter((row) => row.side === 'buy' || row.side === 'sell')
    .map((row) => ({
      symbol: row.symbol,
      side: row.side as 'buy' | 'sell',
      quantity: Number(row.quantity),
    }));
}
