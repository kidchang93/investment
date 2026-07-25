import Fastify from 'fastify';
import cors from '@fastify/cors';
import { WebSocketServer, WebSocket } from 'ws';
import { config, assertCredentials, getKisAccount, type KisAccountConfig } from './config.js';
import {
  addDefaultWatchlistItem,
  addWatchlistItem,
  createWatchlist,
  deleteWatchlist,
  ensureDomesticAssetTypes,
  ensureInstrumentSchema,
  getCategoryInstruments,
  getDefaultWatchlist,
  getInstrument,
  getInstrumentCategories,
  getTerminalInstruments,
  getWatchlistItems,
  getWatchlists,
  removeDefaultWatchlistItem,
  removeWatchlistItem,
  searchInstruments,
  seedDefaultWatchlist,
} from './db/instruments.js';
import { createOrderIntent, ensureTradingSchema, getFillByOrderId, getTradingOverview } from './db/trading.js';
import { ensureBrokerOrderSchema, getBrokerOrderRecords, recordBrokerOrderAttempt } from './db/brokerOrders.js';
import {
  getDailyCandles,
  getInstrumentCandles,
  getInstrumentIntradayCandles,
  getInstrumentNews,
  getInstrumentQuote,
  amendKisDomesticOrder,
  getKisDomesticAccountSnapshot,
  getKisDomesticAmendableOrders,
  getKisDomesticExecutions,
  getKisDomesticOrderability,
  getKisDomesticReservedOrders,
  getKisDomesticSellability,
  placeKisDomesticOrder,
  getQuote,
  getUsdKrwExchangeRate,
} from './kis/rest.js';
import { KisRealtime } from './kis/realtime.js';
import { WATCHLIST } from './watchlist.js';
import type {
  AmendLiveOrderRequest,
  ClientMessage,
  ClientSubscribeInstrument,
  CreateOrderRequest,
  InstrumentAssetType,
  LiveOrderGate,
  PlaceLiveOrderRequest,
  PlaceLiveOrderResult,
  ServerMessage,
  Trade,
  ConnectionStatus,
  Quote,
} from '@invest/shared';

const BATCH_QUOTE_LIMIT = 360;
const BATCH_QUOTE_DELAY_MS = 120;
const QUOTE_CACHE_TTL_MS = 45_000;
const STREAM_SUBSCRIBE_LIMIT = 80;
/** 매수가능 조회가 성립하는 국내 자산 유형. 지수·선물·야간 프록시는 주문 대상이 아니다. */
const ORDERABLE_DOMESTIC_ASSET_TYPES = new Set<InstrumentAssetType>(['stock', 'etf', 'etn']);
const DEFAULT_EXECUTION_DAYS = 30;
/**
 * 실주문 전송 시 사용자가 그대로 입력해야 하는 확인 문구.
 * UI 체크박스만으로는 오발주를 막지 못하므로 서버가 문구 자체를 검증한다.
 */
const LIVE_ORDER_CONFIRMATION = '실주문 전송';

/** 실주문 게이트. 하나라도 막히면 이유를 그대로 프런트에 알려준다. */
function evaluateLiveOrderGate(): LiveOrderGate {
  const isProdEnv = config.env === 'prod';
  const serverEnabled = config.liveOrderEnabled;
  const blockers: string[] = [];
  if (!serverEnabled) blockers.push('서버에서 실주문이 비활성화되어 있습니다 (KIS_LIVE_ORDER_ENABLED).');
  if (config.kisAccounts.length === 0) blockers.push('등록된 KIS 계좌가 없습니다.');
  return { enabled: blockers.length === 0, isProdEnv, serverEnabled, blockers };
}

/**
 * accountId를 계좌 설정으로 바꾼다.
 * `null`은 "설정된 계좌가 아예 없음"(조회 함수가 `configured:false`로 응답),
 * `'unknown'`은 "요청한 id가 등록된 계좌가 아님"(404)으로 구분한다.
 */
function resolveAccount(accountId?: string): KisAccountConfig | null | 'unknown' {
  const account = getKisAccount(accountId);
  if (accountId && !account) return 'unknown';
  return account;
}

const quoteCache = new Map<string, { quote: Quote; fetchedAt: number }>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeSubscribeInstruments(msg: ClientMessage): ClientSubscribeInstrument[] {
  const legacy = (msg.codes ?? []).map((code) => ({ code, market: 'KOSPI', assetType: 'stock' as const }));
  const instruments = [...legacy, ...(msg.instruments ?? [])];
  const seen = new Set<string>();
  const result: ClientSubscribeInstrument[] = [];

  for (const instrument of instruments) {
    const code = instrument.code.trim().toUpperCase();
    if (!/^[0-9A-Z]{6,9}$/.test(code) || seen.has(code)) continue;
    seen.add(code);
    result.push({ ...instrument, code });
    if (result.length >= STREAM_SUBSCRIBE_LIMIT) break;
  }

  return result;
}

async function main(): Promise<void> {
  assertCredentials();

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await ensureInstrumentSchema();
  await ensureDomesticAssetTypes();
  await ensureTradingSchema();
  await ensureBrokerOrderSchema();
  await seedDefaultWatchlist(WATCHLIST);

  // ── REST ────────────────────────────────────────────────
  app.get('/api/health', async () => ({ ok: true, env: config.env }));
  app.get('/api/watchlist', async () => WATCHLIST);

  app.get('/api/trading/overview', async () => {
    return getTradingOverview();
  });

  app.get('/api/broker/kis/accounts', async () => {
    return config.kisAccounts.map((account) => ({
      id: account.id,
      label: account.label,
      primary: account.id === config.primaryCredentialId,
    }));
  });

  app.get<{ Querystring: { accountId?: string } }>('/api/broker/kis/account', async (req, reply) => {
    const account = resolveAccount(req.query.accountId);
    if (account === 'unknown') return reply.code(404).send({ message: '등록된 KIS 계좌가 아닙니다.' });
    try {
      return await getKisDomesticAccountSnapshot(account);
    } catch (err) {
      req.log.warn({ err, accountId: req.query.accountId }, 'KIS 계좌 조회 실패');
      return reply.code(502).send({ message: 'KIS 계좌를 조회할 수 없습니다.' });
    }
  });

  app.get<{ Querystring: { days?: string; accountId?: string } }>(
    '/api/broker/kis/executions',
    async (req, reply) => {
      const account = resolveAccount(req.query.accountId);
      if (account === 'unknown') return reply.code(404).send({ message: '등록된 KIS 계좌가 아닙니다.' });

      const days = Number(req.query.days ?? DEFAULT_EXECUTION_DAYS);
      try {
        return await getKisDomesticExecutions(account, Number.isFinite(days) ? days : DEFAULT_EXECUTION_DAYS);
      } catch (err) {
        req.log.warn({ err, accountId: req.query.accountId }, 'KIS 체결내역 조회 실패');
        return reply.code(502).send({ message: 'KIS 체결내역을 조회할 수 없습니다.' });
      }
    },
  );

  app.get<{ Querystring: { instrumentId?: string; orderType?: string; price?: string; accountId?: string } }>(
    '/api/broker/kis/orderability',
    async (req, reply) => {
      const { instrumentId, orderType, price, accountId } = req.query;
      if (!instrumentId) return reply.code(400).send({ message: 'instrumentId가 필요합니다.' });
      if (orderType !== undefined && orderType !== 'market' && orderType !== 'limit') {
        return reply.code(400).send({ message: '주문 유형이 올바르지 않습니다.' });
      }

      const account = resolveAccount(accountId);
      if (account === 'unknown') return reply.code(404).send({ message: '등록된 KIS 계좌가 아닙니다.' });

      const instrument = await getInstrument(instrumentId);
      if (!instrument) return reply.code(404).send({ message: '종목을 찾을 수 없습니다.' });
      if (!ORDERABLE_DOMESTIC_ASSET_TYPES.has(instrument.assetType) || instrument.country !== 'KR') {
        return reply.code(400).send({ message: '국내주식·ETF·ETN만 매수가능금액을 조회할 수 있습니다.' });
      }

      try {
        return await getKisDomesticOrderability(
          account,
          instrument.providerSymbol,
          orderType === 'limit' ? 'limit' : 'market',
          Number(price ?? 0),
        );
      } catch (err) {
        req.log.warn({ err, instrumentId, accountId }, 'KIS 매수가능금액 조회 실패');
        return reply.code(502).send({ message: 'KIS 매수가능금액을 조회할 수 없습니다.' });
      }
    },
  );

  app.get<{ Querystring: { instrumentId?: string; accountId?: string } }>(
    '/api/broker/kis/sellability',
    async (req, reply) => {
      const { instrumentId, accountId } = req.query;
      if (!instrumentId) return reply.code(400).send({ message: 'instrumentId가 필요합니다.' });

      const account = resolveAccount(accountId);
      if (account === 'unknown') return reply.code(404).send({ message: '등록된 KIS 계좌가 아닙니다.' });

      const instrument = await getInstrument(instrumentId);
      if (!instrument) return reply.code(404).send({ message: '종목을 찾을 수 없습니다.' });
      if (!ORDERABLE_DOMESTIC_ASSET_TYPES.has(instrument.assetType) || instrument.country !== 'KR') {
        return reply.code(400).send({ message: '국내주식·ETF·ETN만 매도가능수량을 조회할 수 있습니다.' });
      }

      try {
        return await getKisDomesticSellability(account, instrument.providerSymbol);
      } catch (err) {
        req.log.warn({ err, instrumentId, accountId }, 'KIS 매도가능수량 조회 실패');
        return reply.code(502).send({ message: 'KIS 매도가능수량을 조회할 수 없습니다.' });
      }
    },
  );

  app.get<{ Querystring: { accountId?: string } }>('/api/broker/kis/open-orders', async (req, reply) => {
    const account = resolveAccount(req.query.accountId);
    if (account === 'unknown') return reply.code(404).send({ message: '등록된 KIS 계좌가 아닙니다.' });
    try {
      return await getKisDomesticAmendableOrders(account);
    } catch (err) {
      req.log.warn({ err, accountId: req.query.accountId }, 'KIS 정정취소가능주문 조회 실패');
      return reply.code(502).send({ message: 'KIS 정정취소가능주문을 조회할 수 없습니다.' });
    }
  });

  app.get<{ Querystring: { accountId?: string; days?: string } }>(
    '/api/broker/kis/reserved-orders',
    async (req, reply) => {
      const account = resolveAccount(req.query.accountId);
      if (account === 'unknown') return reply.code(404).send({ message: '등록된 KIS 계좌가 아닙니다.' });
      const days = Number(req.query.days ?? DEFAULT_EXECUTION_DAYS);
      try {
        return await getKisDomesticReservedOrders(account, Number.isFinite(days) ? days : DEFAULT_EXECUTION_DAYS);
      } catch (err) {
        req.log.warn({ err, accountId: req.query.accountId }, 'KIS 예약주문 조회 실패');
        return reply.code(502).send({ message: 'KIS 예약주문을 조회할 수 없습니다.' });
      }
    },
  );

  app.get('/api/broker/kis/live-order-gate', async () => evaluateLiveOrderGate());

  app.get<{ Querystring: { accountId?: string; limit?: string } }>(
    '/api/broker/kis/order-log',
    async (req, reply) => {
      // accountId를 생략하면 전체를 준다. 미등록 계좌로 시도한 기록도 감사 대상이라
      // 기본 계좌로 좁히면 그 기록에 영영 접근할 수 없다.
      const { accountId } = req.query;
      if (accountId && resolveAccount(accountId) === 'unknown') {
        return reply.code(404).send({ message: '등록된 KIS 계좌가 아닙니다.' });
      }
      const limit = Number(req.query.limit ?? 50);
      return getBrokerOrderRecords(accountId, Number.isFinite(limit) ? limit : 50);
    },
  );

  // ── 실주문 전송 ─────────────────────────────────────────
  // 게이트가 열려 있어야만 동작한다. 기본값은 항상 차단이다.
  // 보내지 못한 시도도 trading_broker_orders에 blocked로 남긴다.
  app.post<{ Body: Partial<PlaceLiveOrderRequest> }>('/api/broker/kis/orders', async (req, reply) => {
    const { accountId, instrumentId, side, orderType, quantity, limitPrice, confirmationPhrase } = req.body;
    const auditBase = {
      accountId: accountId ?? '(미지정)',
      action: 'place' as const,
      requestedInstrumentId: instrumentId,
      side: side === 'buy' || side === 'sell' ? side : undefined,
      orderType: orderType === 'market' || orderType === 'limit' ? orderType : undefined,
      quantity: typeof quantity === 'number' && Number.isFinite(quantity) ? quantity : undefined,
      limitPrice: typeof limitPrice === 'number' && Number.isFinite(limitPrice) ? limitPrice : undefined,
    };

    async function audit(attempt: Parameters<typeof recordBrokerOrderAttempt>[0]): Promise<void> {
      if (!(await recordBrokerOrderAttempt(attempt))) {
        req.log.warn({ attempt }, '실주문 감사 기록 저장 실패');
      }
    }

    async function block(message: string, blockers: string[], extra: Record<string, unknown> = {}) {
      await audit({ ...auditBase, ...extra, status: 'blocked', message, blockers });
    }

    const gate = evaluateLiveOrderGate();
    if (!gate.enabled) {
      await block('실주문이 차단되어 있습니다.', gate.blockers);
      return reply.code(403).send({ message: '실주문이 차단되어 있습니다.', gate });
    }
    if (confirmationPhrase !== LIVE_ORDER_CONFIRMATION) {
      const message = `확인 문구가 일치하지 않습니다. '${LIVE_ORDER_CONFIRMATION}'을 입력하세요.`;
      await block(message, ['확인 문구 불일치']);
      return reply.code(400).send({ message });
    }
    if (!instrumentId || (side !== 'buy' && side !== 'sell') || (orderType !== 'market' && orderType !== 'limit')) {
      const message = '주문 방향 또는 주문 유형이 올바르지 않습니다.';
      await block(message, ['주문 방향·유형 오류']);
      return reply.code(400).send({ message });
    }
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
      const message = '수량은 0보다 커야 합니다.';
      await block(message, ['수량 오류']);
      return reply.code(400).send({ message });
    }
    if (orderType === 'limit' && (typeof limitPrice !== 'number' || !Number.isFinite(limitPrice) || limitPrice <= 0)) {
      const message = '지정가 주문은 단가가 필요합니다.';
      await block(message, ['지정가 단가 누락']);
      return reply.code(400).send({ message });
    }

    const account = resolveAccount(accountId);
    if (account === 'unknown' || !account) {
      const message = account === 'unknown' ? '등록된 KIS 계좌가 아닙니다.' : '등록된 KIS 계좌가 없습니다.';
      await block(message, ['계좌 확인 실패']);
      return reply.code(account === 'unknown' ? 404 : 400).send({ message });
    }

    const instrument = await getInstrument(instrumentId);
    if (!instrument) {
      await block('종목을 찾을 수 없습니다.', ['종목 없음'], { accountId: account.id });
      return reply.code(404).send({ message: '종목을 찾을 수 없습니다.' });
    }
    if (!ORDERABLE_DOMESTIC_ASSET_TYPES.has(instrument.assetType) || instrument.country !== 'KR') {
      const message = '국내주식·ETF·ETN만 주문할 수 있습니다.';
      await block(message, ['주문 불가 종목'], {
        accountId: account.id,
        instrumentId: instrument.id,
        symbol: instrument.providerSymbol,
      });
      return reply.code(400).send({ message });
    }

    const placeAudit = {
      ...auditBase,
      accountId: account.id,
      instrumentId: instrument.id,
      symbol: instrument.providerSymbol,
    };

    try {
      const result = await placeKisDomesticOrder(account, {
        symbol: instrument.providerSymbol,
        side,
        orderType,
        quantity,
        limitPrice,
      });
      await audit({
        ...placeAudit,
        status: 'submitted',
        message: result.message,
        orderNo: result.orderNo,
        orderBranchNo: result.orderBranchNo,
      });
      req.log.info(
        { accountId: account.id, symbol: instrument.providerSymbol, side, quantity, orderNo: result.orderNo },
        '실주문 접수',
      );
      return {
        accepted: true,
        accountId: account.id,
        symbol: instrument.providerSymbol,
        side,
        quantity,
        orderNo: result.orderNo,
        orderBranchNo: result.orderBranchNo,
        acceptedAt: result.acceptedAt,
        message: result.message,
      } satisfies PlaceLiveOrderResult;
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      await audit({ ...placeAudit, status: 'rejected', message });
      req.log.error({ err, accountId: account.id, instrumentId }, '실주문 전송 실패');
      return reply.code(502).send({ message });
    }
  });

  app.post<{ Body: Partial<AmendLiveOrderRequest> }>('/api/broker/kis/orders/amend', async (req, reply) => {
    const { accountId, action, orderNo, orderBranchNo, orderTypeCode, quantity, limitPrice, quantityAll } = req.body;
    const auditBase = {
      accountId: accountId ?? '(미지정)',
      action: action === 'amend' || action === 'cancel' ? action : ('cancel' as const),
      originalOrderNo: orderNo,
      orderBranchNo,
      quantity: typeof quantity === 'number' && Number.isFinite(quantity) ? quantity : undefined,
      limitPrice: typeof limitPrice === 'number' && Number.isFinite(limitPrice) ? limitPrice : undefined,
    };

    async function block(message: string, blockers: string[]) {
      await recordBrokerOrderAttempt({ ...auditBase, status: 'blocked', message, blockers });
    }

    const gate = evaluateLiveOrderGate();
    if (!gate.enabled) {
      await block('실주문이 차단되어 있습니다.', gate.blockers);
      return reply.code(403).send({ message: '실주문이 차단되어 있습니다.', gate });
    }
    if (req.body.confirmationPhrase !== LIVE_ORDER_CONFIRMATION) {
      const message = `확인 문구가 일치하지 않습니다. '${LIVE_ORDER_CONFIRMATION}'을 입력하세요.`;
      await block(message, ['확인 문구 불일치']);
      return reply.code(400).send({ message });
    }
    if (action !== 'amend' && action !== 'cancel') {
      const message = 'action은 amend 또는 cancel이어야 합니다.';
      await block(message, ['action 오류']);
      return reply.code(400).send({ message });
    }
    if (!orderNo || !orderBranchNo || !orderTypeCode) {
      const message = '주문번호·주문채번지점번호·주문구분코드가 모두 필요합니다.';
      await block(message, ['주문 식별자 누락']);
      return reply.code(400).send({ message });
    }
    if (action === 'amend' && (typeof limitPrice !== 'number' || !Number.isFinite(limitPrice) || limitPrice <= 0)) {
      const message = '정정에는 새 단가가 필요합니다.';
      await block(message, ['정정 단가 누락']);
      return reply.code(400).send({ message });
    }

    const account = resolveAccount(accountId);
    if (account === 'unknown' || !account) {
      const message = account === 'unknown' ? '등록된 KIS 계좌가 아닙니다.' : '등록된 KIS 계좌가 없습니다.';
      await block(message, ['계좌 확인 실패']);
      return reply.code(account === 'unknown' ? 404 : 400).send({ message });
    }

    const audit = { ...auditBase, accountId: account.id, action };

    try {
      const result = await amendKisDomesticOrder(account, {
        action,
        orderNo,
        orderBranchNo,
        orderTypeCode,
        quantity,
        limitPrice,
        quantityAll: quantityAll === true,
      });
      await recordBrokerOrderAttempt({
        ...audit,
        status: 'submitted',
        message: result.message,
        orderNo: result.orderNo,
      });
      req.log.info({ accountId: account.id, action, orderNo }, '실주문 정정·취소 접수');
      return { accepted: true, ...result };
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err);
      await recordBrokerOrderAttempt({ ...audit, status: 'rejected', message });
      req.log.error({ err, accountId: account.id, action, orderNo }, '실주문 정정·취소 실패');
      return reply.code(502).send({ message });
    }
  });

  app.get('/api/exchange-rates/usd-krw', async (_req, reply) => {
    try {
      return await getUsdKrwExchangeRate();
    } catch (err) {
      app.log.warn({ err }, 'USD/KRW 환율 조회 실패');
      return reply.code(502).send({ message: 'USD/KRW 환율을 조회할 수 없습니다.' });
    }
  });

  app.post<{ Body: Partial<CreateOrderRequest> }>('/api/trading/orders', async (req, reply) => {
    const {
      accountId,
      instrumentId,
      side,
      orderType,
      timeInForce,
      quantity,
      limitPrice,
      userAcknowledged,
    } = req.body;

    if (!accountId || !instrumentId || !side || !orderType || !timeInForce || typeof quantity !== 'number') {
      return reply.code(400).send({ message: '주문 필수 값이 부족합니다.' });
    }
    if ((side !== 'buy' && side !== 'sell') || (orderType !== 'market' && orderType !== 'limit')) {
      return reply.code(400).send({ message: '주문 방향 또는 주문 유형이 올바르지 않습니다.' });
    }
    if (timeInForce !== 'day' && timeInForce !== 'ioc') {
      return reply.code(400).send({ message: '주문 유효기간이 올바르지 않습니다.' });
    }

    const instrument = await getInstrument(instrumentId);
    if (!instrument) return reply.code(404).send({ message: '종목을 찾을 수 없습니다.' });

    const quote = await getInstrumentQuote(instrument);
    const order = await createOrderIntent({
      accountId,
      instrumentId,
      side,
      orderType,
      timeInForce,
      quantity,
      limitPrice,
      estimatedPrice: quote.price,
      userAcknowledged: userAcknowledged === true,
    });

    if (!order) return reply.code(404).send({ message: '매매 계정 또는 종목을 찾을 수 없습니다.' });
    const fill = await getFillByOrderId(order.id);
    return fill ? { order, fill } : { order };
  });

  app.get<{ Querystring: { q?: string } }>('/api/instruments/search', async (req) => {
    return searchInstruments(req.query.q ?? '');
  });

  app.get('/api/instruments/categories', async () => {
    return getInstrumentCategories();
  });

  app.get<{ Params: { id: string }; Querystring: { q?: string } }>('/api/instruments/categories/:id', async (req) => {
    return getCategoryInstruments(req.params.id, 300, req.query.q ?? '');
  });

  app.get('/api/watchlists/default', async () => {
    return getDefaultWatchlist();
  });

  app.get('/api/watchlists', async () => {
    return getWatchlists();
  });

  app.post<{ Body: { name?: string } }>('/api/watchlists', async (req, reply) => {
    if (!req.body.name?.trim()) return reply.code(400).send({ message: '관심그룹 이름이 필요합니다.' });
    return createWatchlist(req.body.name);
  });

  app.delete<{ Params: { id: string } }>('/api/watchlists/:id', async (req, reply) => {
    const deleted = await deleteWatchlist(req.params.id);
    if (!deleted) return reply.code(400).send({ message: '관심그룹을 삭제할 수 없습니다.' });
    return { ok: true };
  });

  app.post<{ Body: { instrumentId?: string } }>('/api/watchlists/default/items', async (req, reply) => {
    if (!req.body.instrumentId) return reply.code(400).send({ message: 'instrumentId가 필요합니다.' });
    const instrument = await addDefaultWatchlistItem(req.body.instrumentId);
    if (!instrument) return reply.code(404).send({ message: '종목을 찾을 수 없습니다.' });
    return instrument;
  });

  app.delete<{ Params: { id: string } }>('/api/watchlists/default/items/:id', async (req) => {
    await removeDefaultWatchlistItem(req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/watchlists/:id/items', async (req) => {
    return getWatchlistItems(req.params.id);
  });

  app.post<{ Params: { id: string }; Body: { instrumentId?: string } }>(
    '/api/watchlists/:id/items',
    async (req, reply) => {
      if (!req.body.instrumentId) return reply.code(400).send({ message: 'instrumentId가 필요합니다.' });
      const instrument = await addWatchlistItem(req.params.id, req.body.instrumentId);
      if (!instrument) return reply.code(404).send({ message: '종목을 찾을 수 없습니다.' });
      return instrument;
    },
  );

  app.delete<{ Params: { id: string; instrumentId: string } }>('/api/watchlists/:id/items/:instrumentId', async (req) => {
    await removeWatchlistItem(req.params.id, req.params.instrumentId);
    return { ok: true };
  });

  app.get<{ Params: { code: string } }>('/api/candles/:code', async (req) => {
    return getDailyCandles(req.params.code);
  });

  app.get<{ Params: { code: string } }>('/api/quote/:code', async (req) => {
    return getQuote(req.params.code);
  });

  app.post<{ Body: { ids?: string[] } }>('/api/instruments/quotes', async (req, reply) => {
    if (!Array.isArray(req.body.ids)) return reply.code(400).send({ message: 'ids 배열이 필요합니다.' });

    const ids = [...new Set(req.body.ids.filter((id) => typeof id === 'string' && id.length > 0))].slice(
      0,
      BATCH_QUOTE_LIMIT,
    );
    if (ids.length === 0) return [];

    const quotes: Quote[] = [];
    let remoteCallCount = 0;
    for (const id of ids) {
      const cached = quoteCache.get(id);
      if (cached && Date.now() - cached.fetchedAt < QUOTE_CACHE_TTL_MS) {
        quotes.push(cached.quote);
        continue;
      }

      if (remoteCallCount > 0) await sleep(BATCH_QUOTE_DELAY_MS);
      const instrument = await getInstrument(id);
      if (!instrument) continue;

      try {
        const quote = await getInstrumentQuote(instrument);
        quoteCache.set(id, { quote, fetchedAt: Date.now() });
        quotes.push(quote);
        remoteCallCount += 1;
      } catch (err) {
        req.log.warn({ err, instrumentId: id }, '종목 현재가 배치 조회 실패');
      }
    }

    return quotes;
  });

  app.get('/api/instruments/terminal', async () => {
    return getTerminalInstruments();
  });

  app.get<{ Params: { id: string } }>('/api/instruments/:id/candles', async (req, reply) => {
    const instrument = await getInstrument(req.params.id);
    if (!instrument) return reply.code(404).send({ message: '종목을 찾을 수 없습니다.' });
    return getInstrumentCandles(instrument);
  });

  app.get<{ Params: { id: string } }>('/api/instruments/:id/intraday-candles', async (req, reply) => {
    const instrument = await getInstrument(req.params.id);
    if (!instrument) return reply.code(404).send({ message: '종목을 찾을 수 없습니다.' });
    return getInstrumentIntradayCandles(instrument);
  });

  app.get<{ Params: { id: string } }>('/api/instruments/:id/news', async (req, reply) => {
    const instrument = await getInstrument(req.params.id);
    if (!instrument) return reply.code(404).send({ message: '종목을 찾을 수 없습니다.' });
    try {
      return await getInstrumentNews(instrument);
    } catch (err) {
      req.log.warn({ err, instrumentId: instrument.id }, '종목 뉴스 조회 실패');
      return [];
    }
  });

  app.get<{ Params: { id: string } }>('/api/instruments/:id/quote', async (req, reply) => {
    const instrument = await getInstrument(req.params.id);
    if (!instrument) return reply.code(404).send({ message: '종목을 찾을 수 없습니다.' });
    return getInstrumentQuote(instrument);
  });

  await app.listen({ port: config.port, host: '0.0.0.0' });

  // ── 프론트로 실시간 중계하는 WebSocket 서버 (/stream) ────
  const kis = new KisRealtime();
  const clients = new Set<WebSocket>();

  function broadcast(msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  const wss = new WebSocketServer({ server: app.server, path: '/stream' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    // 접속 즉시 현재 KIS 연결 상태를 알려준다.
    ws.send(
      JSON.stringify({
        type: 'status',
        data: { kisConnected: kis.isConnected },
      } satisfies ServerMessage),
    );
    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return;
      }
      if (msg.type !== 'subscribe') return;
      for (const instrument of normalizeSubscribeInstruments(msg)) kis.subscribeInstrument(instrument);
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
  });

  kis.on('trade', (t: Trade) => broadcast({ type: 'trade', data: t }));
  kis.on('status', (s: ConnectionStatus) => broadcast({ type: 'status', data: s }));

  await kis.start(WATCHLIST.map((w) => w.code));

  app.log.info(
    `KIS env=${config.env} · 구독 ${WATCHLIST.length}종목: ${WATCHLIST.map((w) => `${w.name}(${w.code})`).join(', ')}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
