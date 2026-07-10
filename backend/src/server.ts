import Fastify from 'fastify';
import cors from '@fastify/cors';
import { WebSocketServer, WebSocket } from 'ws';
import { config, assertCredentials } from './config.js';
import { getDailyCandles, getQuote } from './kis/rest.js';
import { KisRealtime } from './kis/realtime.js';
import { WATCHLIST } from './watchlist.js';
import type { ServerMessage, Trade, ConnectionStatus } from '@invest/shared';

async function main(): Promise<void> {
  assertCredentials();

  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });

  // ── REST ────────────────────────────────────────────────
  app.get('/api/health', async () => ({ ok: true, env: config.env }));
  app.get('/api/watchlist', async () => WATCHLIST);

  app.get<{ Params: { code: string } }>('/api/candles/:code', async (req) => {
    return getDailyCandles(req.params.code);
  });

  app.get<{ Params: { code: string } }>('/api/quote/:code', async (req) => {
    return getQuote(req.params.code);
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
