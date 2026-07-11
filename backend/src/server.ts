import Fastify from 'fastify';
import cors from '@fastify/cors';
import { WebSocketServer, WebSocket } from 'ws';
import { config, assertCredentials } from './config.js';
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
  getWatchlistItems,
  getWatchlists,
  removeDefaultWatchlistItem,
  removeWatchlistItem,
  searchInstruments,
  seedDefaultWatchlist,
} from './db/instruments.js';
import { createOrderIntent, ensureTradingSchema, getFillByOrderId, getTradingOverview } from './db/trading.js';
import {
  getDailyCandles,
  getInstrumentCandles,
  getInstrumentIntradayCandles,
  getInstrumentNews,
  getInstrumentQuote,
  getKisDomesticAccountSnapshot,
  getQuote,
} from './kis/rest.js';
import { KisRealtime } from './kis/realtime.js';
import { WATCHLIST } from './watchlist.js';
import type {
  ClientMessage,
  ClientSubscribeInstrument,
  CreateOrderRequest,
  ServerMessage,
  Trade,
  ConnectionStatus,
  Quote,
} from '@invest/shared';

const BATCH_QUOTE_LIMIT = 360;
const BATCH_QUOTE_DELAY_MS = 120;
const QUOTE_CACHE_TTL_MS = 45_000;
const STREAM_SUBSCRIBE_LIMIT = 80;

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
  await seedDefaultWatchlist(WATCHLIST);

  // ── REST ────────────────────────────────────────────────
  app.get('/api/health', async () => ({ ok: true, env: config.env }));
  app.get('/api/watchlist', async () => WATCHLIST);

  app.get('/api/trading/overview', async () => {
    return getTradingOverview();
  });

  app.get('/api/broker/kis/account', async () => {
    return getKisDomesticAccountSnapshot();
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
