import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from './client.js';
import type {
  CreateOrderRequest,
  Instrument,
  OrderIntent,
  OrderStatus,
  Position,
  TradingFill,
  TradingAccount,
  TradingOverview,
} from '@invest/shared';

/**
 * 매매 계정과 주문 의도 저장소.
 * 실주문 전송 전에도 모든 주문 입력을 감사 가능한 이벤트로 남기기 위해 시세/관심종목 DB와 분리한다.
 */

interface TradingAccountRow {
  id: string;
  label: string;
  broker: TradingAccount['broker'];
  mode: TradingAccount['mode'];
  base_currency: string;
  cash_balance: string;
  buying_power: string;
  max_order_notional: string;
  live_enabled: boolean;
}

interface InstrumentRow {
  id: string;
  symbol: string;
  name: string;
  english_name: string | null;
  market: string;
  country: Instrument['country'];
  currency: string;
  asset_type: Instrument['assetType'];
  provider: 'kis';
  provider_symbol: string;
  exchange_code: string;
  timezone: string;
}

interface PositionRow extends InstrumentRow {
  position_id: string;
  account_id: string;
  quantity: string;
  average_price: string;
  position_currency: string;
}

interface OrderIntentRow extends InstrumentRow {
  order_id: string;
  account_id: string;
  side: OrderIntent['side'];
  order_type: OrderIntent['orderType'];
  time_in_force: OrderIntent['timeInForce'];
  quantity: string;
  limit_price: string | null;
  estimated_price: string;
  estimated_notional: string;
  order_currency: string;
  status: OrderStatus;
  risk_summary: string[] | null;
  created_at_ms: string;
}

interface TradingFillRow extends InstrumentRow {
  fill_id: string;
  order_id: string;
  account_id: string;
  side: TradingFill['side'];
  quantity: string;
  price: string;
  notional: string;
  fill_currency: string;
  created_at_ms: string;
}

const PAPER_ACCOUNT_ID = 'paper-default';

export async function ensureTradingSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_accounts (
      id text PRIMARY KEY,
      label text NOT NULL,
      broker text NOT NULL,
      mode text NOT NULL,
      base_currency text NOT NULL,
      cash_balance numeric(20, 4) NOT NULL DEFAULT 0,
      buying_power numeric(20, 4) NOT NULL DEFAULT 0,
      max_order_notional numeric(20, 4) NOT NULL DEFAULT 1000000,
      live_enabled boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS trading_positions (
      id text PRIMARY KEY,
      account_id text NOT NULL REFERENCES trading_accounts(id) ON DELETE CASCADE,
      instrument_id text NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      quantity numeric(24, 8) NOT NULL DEFAULT 0,
      average_price numeric(20, 6) NOT NULL DEFAULT 0,
      currency text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (account_id, instrument_id)
    );

    CREATE TABLE IF NOT EXISTS trading_order_intents (
      id text PRIMARY KEY,
      account_id text NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
      instrument_id text NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      side text NOT NULL,
      order_type text NOT NULL,
      time_in_force text NOT NULL,
      quantity numeric(24, 8) NOT NULL,
      limit_price numeric(20, 6),
      estimated_price numeric(20, 6) NOT NULL,
      estimated_notional numeric(20, 4) NOT NULL,
      currency text NOT NULL,
      status text NOT NULL,
      risk_summary jsonb NOT NULL DEFAULT '[]'::jsonb,
      user_acknowledged boolean NOT NULL DEFAULT false,
      broker_order_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS trading_positions_account_idx ON trading_positions (account_id);
    CREATE INDEX IF NOT EXISTS trading_order_intents_account_created_idx
      ON trading_order_intents (account_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS trading_order_events (
      id text PRIMARY KEY,
      order_intent_id text NOT NULL REFERENCES trading_order_intents(id) ON DELETE CASCADE,
      event_type text NOT NULL,
      message text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS trading_fills (
      id text PRIMARY KEY,
      order_intent_id text NOT NULL REFERENCES trading_order_intents(id) ON DELETE CASCADE,
      account_id text NOT NULL REFERENCES trading_accounts(id) ON DELETE RESTRICT,
      instrument_id text NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
      side text NOT NULL,
      quantity numeric(24, 8) NOT NULL,
      price numeric(20, 6) NOT NULL,
      notional numeric(20, 4) NOT NULL,
      currency text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS trading_cash_ledger (
      id text PRIMARY KEY,
      account_id text NOT NULL REFERENCES trading_accounts(id) ON DELETE CASCADE,
      order_intent_id text REFERENCES trading_order_intents(id) ON DELETE SET NULL,
      amount numeric(20, 4) NOT NULL,
      balance_after numeric(20, 4) NOT NULL,
      currency text NOT NULL,
      reason text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS trading_fills_account_created_idx ON trading_fills (account_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS trading_cash_ledger_account_created_idx
      ON trading_cash_ledger (account_id, created_at DESC);
  `);

  await pool.query(
    `
      INSERT INTO trading_accounts (
        id, label, broker, mode, base_currency, cash_balance, buying_power, max_order_notional, live_enabled
      )
      VALUES ($1, 'Paper KRW', 'paper', 'paper', 'KRW', 10000000, 10000000, 1000000, false)
      ON CONFLICT (id) DO NOTHING
    `,
    [PAPER_ACCOUNT_ID],
  );
}

export async function getTradingOverview(): Promise<TradingOverview> {
  const [accounts, positions, recentOrders, recentFills] = await Promise.all([
    getTradingAccounts(),
    getPositions(),
    getRecentOrders(),
    getRecentFills(),
  ]);
  return { accounts, positions, recentOrders, recentFills };
}

export async function createOrderIntent(request: CreateOrderRequest): Promise<OrderIntent | null> {
  const account = (await getTradingAccounts()).find((item) => item.id === request.accountId);
  if (!account) return null;

  const instrument = await getInstrumentById(request.instrumentId);
  if (!instrument) return null;

  const riskMessages = await validateOrderRequest(request, account, instrument);
  const status: OrderStatus = riskMessages.length > 0 ? 'blocked' : 'accepted';
  const quantity = roundQuantity(request.quantity);
  const estimatedPrice = roundMoney(request.estimatedPrice);
  const limitPrice =
    request.orderType === 'limit' && request.limitPrice !== undefined ? roundMoney(request.limitPrice) : undefined;
  const estimatedNotional = roundMoney(quantity * (limitPrice ?? estimatedPrice));
  const id = `ord_${randomUUID()}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `
        INSERT INTO trading_order_intents (
          id, account_id, instrument_id, side, order_type, time_in_force, quantity,
          limit_price, estimated_price, estimated_notional, currency, status, risk_summary, user_acknowledged
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
      `,
      [
        id,
        account.id,
        instrument.id,
        request.side,
        request.orderType,
        request.timeInForce,
        quantity,
        limitPrice ?? null,
        estimatedPrice,
        estimatedNotional,
        instrument.currency,
        status,
        JSON.stringify(riskMessages),
        request.userAcknowledged,
      ],
    );

    await insertOrderEvent(
      client,
      id,
      status,
      status === 'accepted' ? 'paper 주문 의도가 접수되었습니다.' : '리스크 검증으로 주문이 차단되었습니다.',
      { riskMessages },
    );

    if (status === 'accepted' && request.orderType === 'market') {
      await executePaperMarketFill(client, id, account, instrument, request.side, quantity, estimatedPrice);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return getOrderIntent(id);
}

export async function getFillByOrderId(orderId: string): Promise<TradingFill | null> {
  const result = await pool.query<TradingFillRow>(
    `
      SELECT f.id AS fill_id, f.order_intent_id AS order_id, f.account_id, f.side, f.quantity,
             f.price, f.notional, f.currency AS fill_currency,
             (extract(epoch from f.created_at) * 1000)::bigint::text AS created_at_ms,
             i.id, i.symbol, i.name, i.english_name, i.market, i.country, i.currency, i.asset_type,
             i.provider, i.provider_symbol, i.exchange_code, i.timezone
      FROM trading_fills f
      JOIN instruments i ON i.id = f.instrument_id
      WHERE f.order_intent_id = $1
      ORDER BY f.created_at DESC
      LIMIT 1
    `,
    [orderId],
  );
  return result.rows[0] ? rowToTradingFill(result.rows[0]) : null;
}

async function validateOrderRequest(
  request: CreateOrderRequest,
  account: TradingAccount,
  instrument: Instrument,
): Promise<string[]> {
  const messages: string[] = [];

  if (!request.userAcknowledged) messages.push('주문 확인 체크가 필요합니다.');
  if (!Number.isFinite(request.quantity) || request.quantity <= 0) messages.push('수량은 0보다 커야 합니다.');
  if (!Number.isFinite(request.estimatedPrice) || request.estimatedPrice <= 0) {
    messages.push('현재가를 확인할 수 없어 주문할 수 없습니다.');
  }
  if (request.orderType === 'limit' && (!Number.isFinite(request.limitPrice) || Number(request.limitPrice) <= 0)) {
    messages.push('지정가 주문에는 0보다 큰 지정가가 필요합니다.');
  }
  if (account.mode !== 'paper') messages.push('실주문은 아직 비활성화되어 있습니다.');
  if (account.liveEnabled) messages.push('라이브 계정은 별도 2단계 확인 플로우가 필요합니다.');
  if (instrument.provider !== 'kis') messages.push('KIS 종목만 주문할 수 있습니다.');
  if (instrument.currency !== account.baseCurrency) {
    messages.push(`계정 통화(${account.baseCurrency})와 종목 통화(${instrument.currency})가 달라 아직 주문할 수 없습니다.`);
  }

  const estimatedNotional = request.quantity * (request.limitPrice ?? request.estimatedPrice);
  if (Number.isFinite(estimatedNotional) && estimatedNotional > account.maxOrderNotional) {
    messages.push(`1회 주문 한도 ${formatKrw(account.maxOrderNotional)}를 초과했습니다.`);
  }
  if (request.side === 'buy' && Number.isFinite(estimatedNotional) && estimatedNotional > account.buyingPower) {
    messages.push('주문 가능 금액을 초과했습니다.');
  }
  if (request.side === 'sell') {
    const position = await getPositionQuantity(account.id, instrument.id);
    if (position < request.quantity) messages.push('보유 수량보다 많은 매도 주문입니다.');
  }

  return messages;
}

async function getTradingAccounts(): Promise<TradingAccount[]> {
  const result = await pool.query<TradingAccountRow>(`
    SELECT id, label, broker, mode, base_currency, cash_balance, buying_power, max_order_notional, live_enabled
    FROM trading_accounts
    ORDER BY created_at, id
  `);
  return result.rows.map(rowToTradingAccount);
}

async function getPositions(): Promise<Position[]> {
  const result = await pool.query<PositionRow>(`
    SELECT p.id AS position_id, p.account_id, p.quantity, p.average_price, p.currency AS position_currency,
           i.id, i.symbol, i.name, i.english_name, i.market, i.country, i.currency, i.asset_type,
           i.provider, i.provider_symbol, i.exchange_code, i.timezone
    FROM trading_positions p
    JOIN instruments i ON i.id = p.instrument_id
    WHERE p.quantity <> 0
    ORDER BY p.updated_at DESC, i.symbol
  `);
  return result.rows.map((row) => ({
    id: row.position_id,
    accountId: row.account_id,
    instrument: rowToInstrument(row),
    quantity: Number(row.quantity),
    averagePrice: Number(row.average_price),
    currency: row.position_currency,
  }));
}

async function getRecentOrders(limit = 20): Promise<OrderIntent[]> {
  const result = await pool.query<OrderIntentRow>(
    `
      SELECT o.id AS order_id, o.account_id, o.side, o.order_type, o.time_in_force, o.quantity,
             o.limit_price, o.estimated_price, o.estimated_notional, o.currency AS order_currency,
             o.status, o.risk_summary::jsonb AS risk_summary,
             (extract(epoch from o.created_at) * 1000)::bigint::text AS created_at_ms,
             i.id, i.symbol, i.name, i.english_name, i.market, i.country, i.currency, i.asset_type,
             i.provider, i.provider_symbol, i.exchange_code, i.timezone
      FROM trading_order_intents o
      JOIN instruments i ON i.id = o.instrument_id
      ORDER BY o.created_at DESC
      LIMIT $1
    `,
    [limit],
  );
  return result.rows.map(rowToOrderIntent);
}

async function getRecentFills(limit = 20): Promise<TradingFill[]> {
  const result = await pool.query<TradingFillRow>(
    `
      SELECT f.id AS fill_id, f.order_intent_id AS order_id, f.account_id, f.side, f.quantity,
             f.price, f.notional, f.currency AS fill_currency,
             (extract(epoch from f.created_at) * 1000)::bigint::text AS created_at_ms,
             i.id, i.symbol, i.name, i.english_name, i.market, i.country, i.currency, i.asset_type,
             i.provider, i.provider_symbol, i.exchange_code, i.timezone
      FROM trading_fills f
      JOIN instruments i ON i.id = f.instrument_id
      ORDER BY f.created_at DESC
      LIMIT $1
    `,
    [limit],
  );
  return result.rows.map(rowToTradingFill);
}

async function getOrderIntent(id: string): Promise<OrderIntent | null> {
  const result = await pool.query<OrderIntentRow>(
    `
      SELECT o.id AS order_id, o.account_id, o.side, o.order_type, o.time_in_force, o.quantity,
             o.limit_price, o.estimated_price, o.estimated_notional, o.currency AS order_currency,
             o.status, o.risk_summary::jsonb AS risk_summary,
             (extract(epoch from o.created_at) * 1000)::bigint::text AS created_at_ms,
             i.id, i.symbol, i.name, i.english_name, i.market, i.country, i.currency, i.asset_type,
             i.provider, i.provider_symbol, i.exchange_code, i.timezone
      FROM trading_order_intents o
      JOIN instruments i ON i.id = o.instrument_id
      WHERE o.id = $1
    `,
    [id],
  );
  return result.rows[0] ? rowToOrderIntent(result.rows[0]) : null;
}

async function getInstrumentById(id: string): Promise<Instrument | null> {
  const result = await pool.query<InstrumentRow>(
    `
      SELECT id, symbol, name, english_name, market, country, currency, asset_type,
             provider, provider_symbol, exchange_code, timezone
      FROM instruments
      WHERE id = $1 AND is_active = true
    `,
    [id],
  );
  return result.rows[0] ? rowToInstrument(result.rows[0]) : null;
}

async function getPositionQuantity(accountId: string, instrumentId: string): Promise<number> {
  const result = await pool.query<{ quantity: string }>(
    'SELECT quantity FROM trading_positions WHERE account_id = $1 AND instrument_id = $2',
    [accountId, instrumentId],
  );
  return Number(result.rows[0]?.quantity ?? 0);
}

async function executePaperMarketFill(
  client: PoolClient,
  orderId: string,
  account: TradingAccount,
  instrument: Instrument,
  side: TradingFill['side'],
  quantity: number,
  price: number,
): Promise<string> {
  const notional = roundMoney(quantity * price);
  const signedCashAmount = side === 'buy' ? -notional : notional;
  const fillId = `fill_${randomUUID()}`;
  const ledgerId = `cash_${randomUUID()}`;

  const accountResult = await client.query<{ cash_balance: string }>(
    `
      UPDATE trading_accounts
      SET
        cash_balance = cash_balance + $2,
        buying_power = buying_power + $2,
        updated_at = now()
      WHERE id = $1
      RETURNING cash_balance
    `,
    [account.id, signedCashAmount],
  );
  const balanceAfter = Number(accountResult.rows[0]?.cash_balance ?? account.cashBalance + signedCashAmount);

  await client.query(
    `
      INSERT INTO trading_fills (
        id, order_intent_id, account_id, instrument_id, side, quantity, price, notional, currency
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [fillId, orderId, account.id, instrument.id, side, quantity, price, notional, instrument.currency],
  );

  await client.query(
    `
      INSERT INTO trading_cash_ledger (
        id, account_id, order_intent_id, amount, balance_after, currency, reason
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `,
    [
      ledgerId,
      account.id,
      orderId,
      signedCashAmount,
      balanceAfter,
      instrument.currency,
      side === 'buy' ? 'paper_buy' : 'paper_sell',
    ],
  );

  if (side === 'buy') {
    await upsertBuyPosition(client, account.id, instrument, quantity, price);
  } else {
    await applySellPosition(client, account.id, instrument.id, quantity);
  }

  await client.query(
    `
      UPDATE trading_order_intents
      SET status = 'filled', updated_at = now()
      WHERE id = $1
    `,
    [orderId],
  );

  await insertOrderEvent(client, orderId, 'filled', 'paper 시장가 주문이 즉시 체결되었습니다.', {
    fillId,
    quantity,
    price,
    notional,
  });

  return fillId;
}

async function upsertBuyPosition(
  client: PoolClient,
  accountId: string,
  instrument: Instrument,
  quantity: number,
  price: number,
): Promise<void> {
  await client.query(
    `
      INSERT INTO trading_positions (id, account_id, instrument_id, quantity, average_price, currency)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (account_id, instrument_id)
      DO UPDATE SET
        average_price =
          CASE
            WHEN trading_positions.quantity + EXCLUDED.quantity = 0 THEN 0
            ELSE (
              (trading_positions.quantity * trading_positions.average_price)
              + (EXCLUDED.quantity * EXCLUDED.average_price)
            ) / (trading_positions.quantity + EXCLUDED.quantity)
          END,
        quantity = trading_positions.quantity + EXCLUDED.quantity,
        updated_at = now()
    `,
    [`pos_${randomUUID()}`, accountId, instrument.id, quantity, price, instrument.currency],
  );
}

async function applySellPosition(
  client: PoolClient,
  accountId: string,
  instrumentId: string,
  quantity: number,
): Promise<void> {
  await client.query(
    `
      UPDATE trading_positions
      SET
        quantity = quantity - $3,
        average_price = CASE WHEN quantity - $3 = 0 THEN 0 ELSE average_price END,
        updated_at = now()
      WHERE account_id = $1 AND instrument_id = $2
    `,
    [accountId, instrumentId, quantity],
  );
}

async function insertOrderEvent(
  client: PoolClient,
  orderId: string,
  eventType: string,
  message: string,
  payload: unknown,
): Promise<void> {
  await client.query(
    `
      INSERT INTO trading_order_events (id, order_intent_id, event_type, message, payload)
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `,
    [`oev_${randomUUID()}`, orderId, eventType, message, JSON.stringify(payload)],
  );
}

function rowToTradingAccount(row: TradingAccountRow): TradingAccount {
  return {
    id: row.id,
    label: row.label,
    broker: row.broker,
    mode: row.mode,
    baseCurrency: row.base_currency,
    cashBalance: Number(row.cash_balance),
    buyingPower: Number(row.buying_power),
    maxOrderNotional: Number(row.max_order_notional),
    liveEnabled: row.live_enabled,
  };
}

function rowToOrderIntent(row: OrderIntentRow): OrderIntent {
  return {
    id: row.order_id,
    accountId: row.account_id,
    instrument: rowToInstrument(row),
    side: row.side,
    orderType: row.order_type,
    timeInForce: row.time_in_force,
    quantity: Number(row.quantity),
    limitPrice: row.limit_price === null ? undefined : Number(row.limit_price),
    estimatedPrice: Number(row.estimated_price),
    estimatedNotional: Number(row.estimated_notional),
    currency: row.order_currency,
    status: row.status,
    riskMessages: Array.isArray(row.risk_summary) ? row.risk_summary : [],
    createdAt: Number(row.created_at_ms),
  };
}

function rowToTradingFill(row: TradingFillRow): TradingFill {
  return {
    id: row.fill_id,
    orderId: row.order_id,
    accountId: row.account_id,
    instrument: rowToInstrument(row),
    side: row.side,
    quantity: Number(row.quantity),
    price: Number(row.price),
    notional: Number(row.notional),
    currency: row.fill_currency,
    createdAt: Number(row.created_at_ms),
  };
}

function rowToInstrument(row: InstrumentRow): Instrument {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    englishName: row.english_name ?? undefined,
    market: row.market,
    country: row.country,
    currency: row.currency,
    assetType: row.asset_type,
    provider: row.provider,
    providerSymbol: row.provider_symbol,
    exchangeCode: row.exchange_code,
    timezone: row.timezone,
  };
}

function roundQuantity(value: number): number {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function roundMoney(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function formatKrw(value: number): string {
  return `${Math.floor(value).toLocaleString('ko-KR')}원`;
}
