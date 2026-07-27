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
import { ensureAutoTraderSchema, getAutoTraderRuns } from './db/autoTrader.js';
import {
  claimClientOrderId,
  completeClaimedOrder,
  getOrderByClientOrderId,
} from './db/brokerOrders.js';
import { ensureBrokerOrderSchema, getBrokerOrderRecords, recordBrokerOrderAttempt } from './db/brokerOrders.js';
import {
  getAutoTraderState,
  startAutoTrader,
  stopAutoTrader,
} from './trading/autoTrader.js';
import { listStrategies } from './trading/strategy.js';
import { loadAutoTraderCandidates } from './trading/universe.js';
import { checkRiskRules, ensureRiskRuleSchema, getRiskRules, upsertRiskRules } from './db/riskRules.js';
import {
  getDailyCandles,
  getInstrumentCandles,
  getInstrumentIntradayCandles,
  getInstrumentNews,
  getInstrumentQuote,
  getFinancials,
  getOrderBook,
  amendKisDomesticOrder,
  getKisDomesticAccountSnapshot,
  getKisDomesticAmendableOrders,
  getKisDomesticExecutions,
  getKisDomesticOrderability,
  getKisDomesticReservedOrders,
  getKisDomesticSellability,
  getKisDomesticTradeProfit,
  placeKisDomesticReservedOrder,
  cancelKisDomesticReservedOrder,
  placeKisDomesticOrder,
  getQuote,
  getUsdKrwExchangeRate,
} from './kis/rest.js';
import { KisRealtime } from './kis/realtime.js';
import { WATCHLIST } from './watchlist.js';
import type {
  AmendLiveOrderRequest,
  AutoTraderConfig,
  ClientMessage,
  ClientSubscribeInstrument,
  CreateOrderRequest,
  InstrumentAssetType,
  LiveOrderGate,
  RiskRuleSet,
  PlaceLiveOrderRequest,
  PlaceReservedOrderRequest,
  CancelReservedOrderRequest,
  PlaceLiveOrderResult,
  OrderNotice,
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

function normalizeSymbolList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const symbols = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toUpperCase())
    .filter((item) => /^[0-9A-Z]{5,9}$/.test(item));
  return [...new Set(symbols)].slice(0, 200);
}

/** 저장 전에 룰 자체가 말이 되는지 본다. 음수 한도나 뒤집힌 시간대는 받지 않는다. */
function validateRiskRules(rules: RiskRuleSet): string | null {
  const positives: Array<[string, number]> = [
    ['1회 주문 금액 한도', rules.maxOrderNotional],
    ['1회 주문 수량 한도', rules.maxOrderQuantity],
    ['일일 주문 금액 한도', rules.dailyNotionalLimit],
    ['일일 주문 건수 한도', rules.dailyOrderCountLimit],
  ];
  for (const [label, value] of positives) {
    if (!Number.isFinite(value) || value <= 0) return `${label}는 0보다 커야 합니다.`;
  }
  if (rules.maxOrderNotional > rules.dailyNotionalLimit) {
    return '1회 주문 금액 한도가 일일 한도보다 큽니다.';
  }
  const time = /^\d{1,2}:\d{2}$/;
  if (!time.test(rules.sessionStart) || !time.test(rules.sessionEnd)) {
    return '거래 시간은 HH:MM 형식이어야 합니다.';
  }
  if (rules.sessionStart >= rules.sessionEnd) {
    return '거래 시작 시각이 종료 시각보다 늦습니다.';
  }
  return null;
}

/** 실주문 게이트. 하나라도 막히면 이유를 그대로 프런트에 알려준다. */
function evaluateLiveOrderGate(): LiveOrderGate {
  const isProdEnv = config.env === 'prod';
  const serverEnabled = config.liveOrderEnabled;
  const blockers: string[] = [];
  /*
   * 막힌 이유는 화면에 그대로 나간다. 무엇 때문에 막혔는지만 적으면 처음 보는
   * 사람은 다음에 뭘 해야 할지 알 수 없으므로 고치는 방법까지 한 문장에 담는다.
   */
  if (!serverEnabled) {
    blockers.push('실주문이 꺼져 있습니다. .env에 KIS_LIVE_ORDER_ENABLED=true를 넣고 서버를 다시 시작하세요.');
  }
  if (config.kisAccounts.length === 0) {
    blockers.push('연결된 계좌가 없습니다. .env에 KIS_<번호>_ACCOUNT_NO / KIS_APP_KEY_<번호> / KIS_APP_SECRET_<번호>를 넣으세요.');
  }
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
  await ensureRiskRuleSchema();
  await ensureAutoTraderSchema();
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

  app.get<{ Querystring: { accountId?: string; days?: string } }>(
    '/api/broker/kis/trade-profit',
    async (req, reply) => {
      const account = resolveAccount(req.query.accountId);
      if (account === 'unknown') return reply.code(404).send({ message: '등록된 KIS 계좌가 아닙니다.' });
      const days = Number(req.query.days ?? DEFAULT_EXECUTION_DAYS);
      try {
        return await getKisDomesticTradeProfit(account, Number.isFinite(days) ? days : DEFAULT_EXECUTION_DAYS);
      } catch (err) {
        req.log.warn({ err, accountId: req.query.accountId }, 'KIS 기간별 매매손익 조회 실패');
        return reply.code(502).send({ message: 'KIS 기간별 매매손익을 조회할 수 없습니다.' });
      }
    },
  );

  /*
   * 예약주문 등록. 접수 가능 시간이 15:40~다음 영업일 07:30이라 장이 닫혀 있어도 들어간다.
   * 그래서 리스크 룰의 시간대·개장일 검사만 건너뛰고 금액·수량·종목 제한은 그대로 적용한다.
   */
  app.post<{ Body: Partial<PlaceReservedOrderRequest> }>(
    '/api/broker/kis/reserved-orders',
    async (req, reply) => {
      const { accountId, instrumentId, side, quantity, limitPrice, endDate } = req.body;
      const auditBase = {
        accountId: accountId ?? '(미지정)',
        action: 'place' as const,
        requestedInstrumentId: instrumentId,
        side: side === 'buy' || side === 'sell' ? side : undefined,
        orderType: 'limit' as const,
        quantity: typeof quantity === 'number' && Number.isFinite(quantity) ? quantity : undefined,
        limitPrice: typeof limitPrice === 'number' && Number.isFinite(limitPrice) ? limitPrice : undefined,
      };
      const block = async (message: string, blockers: string[], extra: Record<string, unknown> = {}) => {
        await recordBrokerOrderAttempt({ ...auditBase, ...extra, status: 'blocked', message, blockers });
      };

      const gate = evaluateLiveOrderGate();
      if (!gate.enabled) {
        await block('실주문이 차단되어 있습니다.', gate.blockers);
        return reply.code(403).send({ message: '실주문이 차단되어 있습니다.', gate });
      }
      if (!instrumentId || (side !== 'buy' && side !== 'sell')) {
        const message = '종목과 주문 방향이 필요합니다.';
        await block(message, ['주문 방향 오류']);
        return reply.code(400).send({ message });
      }
      if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
        await block('수량은 0보다 커야 합니다.', ['수량 오류']);
        return reply.code(400).send({ message: '수량은 0보다 커야 합니다.' });
      }
      if (typeof limitPrice !== 'number' || !Number.isFinite(limitPrice) || limitPrice <= 0) {
        await block('예약주문은 지정가만 지원합니다. 단가가 필요합니다.', ['단가 누락']);
        return reply.code(400).send({ message: '예약주문은 지정가만 지원합니다. 단가가 필요합니다.' });
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
        const message = '국내주식·ETF·ETN만 예약주문할 수 있습니다.';
        await block(message, ['주문 불가 종목'], { accountId: account.id, instrumentId: instrument.id });
        return reply.code(400).send({ message });
      }

      const audit = {
        ...auditBase,
        accountId: account.id,
        instrumentId: instrument.id,
        symbol: instrument.providerSymbol,
      };

      const verdict = await checkRiskRules({
        accountId: account.id,
        symbol: instrument.providerSymbol,
        side,
        orderType: 'limit',
        quantity,
        price: limitPrice,
        skipSessionCheck: true,
      });
      if (!verdict.allowed) {
        await recordBrokerOrderAttempt({
          ...audit,
          status: 'blocked',
          message: '리스크 룰에 막혔습니다.',
          blockers: verdict.violations,
        });
        return reply.code(403).send({ message: '리스크 룰에 막혔습니다.', verdict });
      }

      try {
        const result = await placeKisDomesticReservedOrder(account, {
          symbol: instrument.providerSymbol,
          side,
          quantity,
          limitPrice,
          endDate,
        });
        await recordBrokerOrderAttempt({
          ...audit,
          status: 'submitted',
          message: `예약주문 · ${result.message}`,
          orderNo: result.reservationSeq,
        });
        req.log.info(
          { accountId: account.id, symbol: instrument.providerSymbol, seq: result.reservationSeq },
          '예약주문 등록',
        );
        return { accepted: true, reservationSeq: result.reservationSeq, message: result.message };
      } catch (err) {
        const message = String(err instanceof Error ? err.message : err);
        await recordBrokerOrderAttempt({ ...audit, status: 'rejected', message });
        req.log.error({ err, accountId: account.id, instrumentId }, '예약주문 등록 실패');
        return reply.code(502).send({ message });
      }
    },
  );

  app.post<{ Body: Partial<CancelReservedOrderRequest> }>(
    '/api/broker/kis/reserved-orders/cancel',
    async (req, reply) => {
      const { accountId, reservationSeq, reservationOrderDate, reservationOrgNo } = req.body;
      const gate = evaluateLiveOrderGate();
      if (!gate.enabled) return reply.code(403).send({ message: '실주문이 차단되어 있습니다.', gate });
      if (!reservationSeq || !reservationOrderDate) {
        return reply.code(400).send({ message: '예약주문순번과 주문일자가 필요합니다.' });
      }

      const account = resolveAccount(accountId);
      if (account === 'unknown') return reply.code(404).send({ message: '등록된 KIS 계좌가 아닙니다.' });
      if (!account) return reply.code(400).send({ message: '등록된 KIS 계좌가 없습니다.' });

      const audit = {
        accountId: account.id,
        action: 'cancel' as const,
        originalOrderNo: reservationSeq,
      };

      try {
        const result = await cancelKisDomesticReservedOrder(account, {
          reservationSeq,
          reservationOrderDate,
          reservationOrgNo,
        });
        await recordBrokerOrderAttempt({
          ...audit,
          status: 'submitted',
          message: `예약주문 취소 · ${result.message}`,
        });
        return { accepted: true, ...result };
      } catch (err) {
        const message = String(err instanceof Error ? err.message : err);
        await recordBrokerOrderAttempt({ ...audit, status: 'rejected', message });
        req.log.error({ err, accountId: account.id, reservationSeq }, '예약주문 취소 실패');
        return reply.code(502).send({ message });
      }
    },
  );

  app.get('/api/broker/kis/live-order-gate', async () => evaluateLiveOrderGate());

  /*
   * 자동매매.
   *
   * 러너는 서버 메모리에 산다. 서버가 재시작되면 멈춘 상태로 시작한다 —
   * 사람이 모르는 사이에 되살아나 주문을 내는 쪽이 더 위험하다.
   * 실행 기록만 DB에 남아 재시작 뒤에도 무슨 일이 있었는지 볼 수 있다.
   */
  app.get('/api/broker/kis/auto-trader/strategies', async () => listStrategies());

  app.get<{ Querystring: { accountId?: string } }>('/api/broker/kis/auto-trader', async (req, reply) => {
    const account = resolveAccount(req.query.accountId);
    if (account === 'unknown') return reply.code(404).send({ message: '등록된 KIS 계좌가 아닙니다.' });
    if (!account) return reply.code(400).send({ message: '등록된 KIS 계좌가 없습니다.' });
    const state = getAutoTraderState(account.id);
    const { runs: recentRuns, hasMore: recentRunsHasMore } = await getAutoTraderRuns(account.id, 40);
    if (!state) return { status: 'stopped', recentRuns, recentRunsHasMore };
    return { ...state, recentRuns, recentRunsHasMore };
  });

  app.post<{ Body: Partial<AutoTraderConfig> }>('/api/broker/kis/auto-trader/start', async (req, reply) => {
    const account = resolveAccount(req.body.accountId);
    if (account === 'unknown') return reply.code(404).send({ message: '등록된 KIS 계좌가 아닙니다.' });
    if (!account) return reply.code(400).send({ message: '등록된 KIS 계좌가 없습니다.' });

    const { mode, strategy, targetEquity, stopEquity, intervalSeconds, maxPositions } = req.body;
    if (mode !== 'dry_run' && mode !== 'live') {
      return reply.code(400).send({ message: "mode는 'dry_run' 또는 'live'여야 합니다." });
    }
    if (!Number.isFinite(targetEquity) || !Number.isFinite(stopEquity)) {
      return reply.code(400).send({ message: '목표 금액과 중단 금액이 필요합니다.' });
    }
    /*
     * 실주문 모드는 서버 게이트가 열려 있을 때만 시작할 수 있다. 게이트가 닫힌 채로
     * 시작하면 매 회차 주문이 거부되며 기록만 쌓인다 — 켜졌다고 착각하기 쉽다.
     */
    if (mode === 'live') {
      const gate = evaluateLiveOrderGate();
      if (!gate.enabled) {
        return reply.code(403).send({ message: '실주문이 차단되어 있어 실주문 모드로 시작할 수 없습니다.', gate });
      }
    }

    try {
      const state = await startAutoTrader(
        {
          accountId: account.id,
          mode,
          strategy: strategy || 'ma_cross',
          targetEquity: Number(targetEquity),
          stopEquity: Number(stopEquity),
          intervalSeconds: Number(intervalSeconds) || 60,
          maxPositions: Number(maxPositions) || 1,
        },
        { loadCandidates: loadAutoTraderCandidates },
      );
      return state;
    } catch (e) {
      return reply.code(400).send({ message: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post<{ Body: { accountId?: string } }>('/api/broker/kis/auto-trader/stop', async (req, reply) => {
    const account = resolveAccount(req.body.accountId);
    if (account === 'unknown') return reply.code(404).send({ message: '등록된 KIS 계좌가 아닙니다.' });
    if (!account) return reply.code(400).send({ message: '등록된 KIS 계좌가 없습니다.' });
    const state = await stopAutoTrader(account.id, 'stopped', '사용자 정지');
    return state ?? { status: 'stopped' };
  });

  app.get<{ Querystring: { accountId?: string } }>('/api/broker/kis/risk-rules', async (req, reply) => {
    const account = resolveAccount(req.query.accountId);
    if (account === 'unknown') return reply.code(404).send({ message: '등록된 KIS 계좌가 아닙니다.' });
    if (!account) return reply.code(400).send({ message: '등록된 KIS 계좌가 없습니다.' });
    return getRiskRules(account.id);
  });

  app.put<{ Body: Partial<RiskRuleSet>; Querystring: { accountId?: string } }>(
    '/api/broker/kis/risk-rules',
    async (req, reply) => {
      const account = resolveAccount(req.query.accountId ?? req.body.accountId);
      if (account === 'unknown') return reply.code(404).send({ message: '등록된 KIS 계좌가 아닙니다.' });
      if (!account) return reply.code(400).send({ message: '등록된 KIS 계좌가 없습니다.' });

      const current = await getRiskRules(account.id);
      const merged: RiskRuleSet = {
        ...current,
        ...req.body,
        accountId: account.id,
        symbolAllowlist: normalizeSymbolList(req.body.symbolAllowlist ?? current.symbolAllowlist),
        symbolBlocklist: normalizeSymbolList(req.body.symbolBlocklist ?? current.symbolBlocklist),
      };

      const invalid = validateRiskRules(merged);
      if (invalid) return reply.code(400).send({ message: invalid });
      return upsertRiskRules(merged);
    },
  );

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
    const { accountId, instrumentId, side, orderType, quantity, limitPrice, clientOrderId } = req.body;
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

    // 시장가는 단가가 없으므로 현재가로 금액을 추정해 한도를 본다.
    let riskPrice = limitPrice ?? 0;
    if (orderType === 'market') {
      try {
        riskPrice = (await getInstrumentQuote(instrument)).price;
      } catch (err) {
        req.log.warn({ err, instrumentId }, '리스크 판정용 현재가 조회 실패');
      }
    }

    const verdict = await checkRiskRules({
      accountId: account.id,
      symbol: instrument.providerSymbol,
      side,
      orderType,
      quantity,
      price: riskPrice,
    });
    if (!verdict.allowed) {
      await audit({
        ...placeAudit,
        status: 'blocked',
        message: '리스크 룰에 막혔습니다.',
        blockers: verdict.violations,
      });
      return reply.code(403).send({ message: '리스크 룰에 막혔습니다.', verdict });
    }

    /*
      * 멱등성 키를 주문 **전에** 선점한다. 주문 후에 잡으면 그 사이 재시도가 들어와
      * 같은 주문이 두 번 나간다. 잡지 못했다면 이미 처리된 요청이므로 앞선 결과를
      * 그대로 돌려주고 새로 보내지 않는다.
      *
      * 선점 자체가 DB 오류로 실패하면 중복인지 알 수 없으므로 보내지 않는다 —
      * 모르면 보내지 않는 쪽이 안전하다.
      */
    if (clientOrderId) {
      let claimed: boolean;
      try {
        claimed = await claimClientOrderId(account.id, clientOrderId, 'place');
      } catch (err) {
        req.log.error({ err, clientOrderId }, '멱등성 키 선점 실패');
        return reply.code(503).send({ message: '주문 중복 여부를 확인할 수 없어 보내지 않았습니다. 잠시 후 같은 요청을 다시 보내세요.' });
      }
      if (!claimed) {
        const previous = await getOrderByClientOrderId(clientOrderId);
        req.log.warn({ clientOrderId }, '같은 주문 키로 재요청 — 새로 보내지 않음');
        return {
          accepted: previous?.status === 'submitted',
          accountId: account.id,
          symbol: instrument.providerSymbol,
          side,
          quantity,
          orderNo: previous?.orderNo ?? '',
          orderBranchNo: previous?.orderBranchNo ?? '',
          acceptedAt: '',
          message: `이미 처리된 주문입니다 · ${previous?.message ?? '앞선 결과를 확인하세요'}`,
        } satisfies PlaceLiveOrderResult;
      }
    }

    try {
      const result = await placeKisDomesticOrder(account, {
        symbol: instrument.providerSymbol,
        side,
        orderType,
        quantity,
        limitPrice,
      });
      const done = {
        ...placeAudit,
        status: 'submitted' as const,
        message: result.message,
        orderNo: result.orderNo,
        orderBranchNo: result.orderBranchNo,
      };
      if (clientOrderId) await completeClaimedOrder(clientOrderId, done);
      else await audit(done);
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
      const failed = { ...placeAudit, status: 'rejected' as const, message };
      if (clientOrderId) await completeClaimedOrder(clientOrderId, failed);
      else await audit(failed);
      req.log.error({ err, accountId: account.id, instrumentId }, '실주문 전송 실패');
      return reply.code(502).send({ message });
    }
  });

  app.post<{ Body: Partial<AmendLiveOrderRequest> }>('/api/broker/kis/orders/amend', async (req, reply) => {
    const { accountId, action, orderNo, orderBranchNo, orderTypeCode, quantity, limitPrice, quantityAll } = req.body;
    const auditBase = {
      accountId: accountId ?? '(미지정)',
      // action이 잘못 와도 임의로 cancel로 적으면 기록이 사실과 달라진다. amend로 두고
      // 아래 검증에서 'action 오류'로 차단된 사실을 blockers에 남긴다.
      action: action === 'amend' || action === 'cancel' ? action : ('amend' as const),
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

  /*
   * 호가와 예상 체결. 국내 현금 종목만 해당한다 — 야간 환산가·원자재·선물은
   * KRX 호가 대상이 아니라 404로 돌려주고, 화면이 "없음"과 "안 되는 종목"을
   * 구별할 수 있게 사유를 함께 준다.
   */
  /*
   * 분기별 재무 지표. 국내 주식만 해당한다 — ETF·ETN은 재무제표가 없고,
   * 해외는 KIS 재무 API 대상이 아니다. 없는 것을 빈 배열로 주면 "재무가
   * 나쁘다"로 읽히므로 사유와 함께 404로 돌려준다.
   */
  app.get<{ Params: { id: string } }>('/api/instruments/:id/financials', async (req, reply) => {
    const instrument = await getInstrument(req.params.id);
    if (!instrument) return reply.code(404).send({ message: '종목을 찾을 수 없습니다.' });
    if (instrument.country !== 'KR' || instrument.assetType !== 'stock') {
      return reply.code(404).send({ message: '국내 주식만 재무 지표를 조회할 수 있습니다.' });
    }
    try {
      return await getFinancials(instrument.providerSymbol);
    } catch (err) {
      req.log.warn({ err, instrumentId: instrument.id }, '재무 지표 조회 실패');
      return reply.code(502).send({ message: '재무 지표를 조회하지 못했습니다.' });
    }
  });

  app.get<{ Params: { id: string } }>('/api/instruments/:id/order-book', async (req, reply) => {
    const instrument = await getInstrument(req.params.id);
    if (!instrument) return reply.code(404).send({ message: '종목을 찾을 수 없습니다.' });
    if (instrument.country !== 'KR' || !ORDERABLE_DOMESTIC_ASSET_TYPES.has(instrument.assetType)) {
      return reply.code(404).send({ message: '국내 주식·ETF만 호가를 조회할 수 있습니다.' });
    }
    try {
      // 다른 조회와 같이 화면이 쓰는 종목 id로 맞춘다. KIS 종목코드가 아니다.
      const book = await getOrderBook(instrument.providerSymbol);
      return { ...book, code: instrument.id };
    } catch (err) {
      req.log.warn({ err, instrumentId: instrument.id }, '호가 조회 실패');
      return reply.code(502).send({ message: '호가를 조회하지 못했습니다.' });
    }
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
  kis.on('noticeReady', () => app.log.info('주문·체결 통보 복호화 키 수신'));
  kis.on('orderNotice', (notice: OrderNotice) => {
    app.log.info(
      { accountId: notice.accountId, orderNo: notice.orderNo, kind: notice.kind, symbol: notice.symbol },
      '실시간 주문·체결 통보',
    );
    broadcast({ type: 'orderNotice', data: notice });
  });
  kis.on('status', (s: ConnectionStatus) => {
    // 구독 실패 같은 메시지는 접속 중인 프런트가 없으면 그대로 사라진다. 서버에도 남긴다.
    if (s.message) app.log.warn({ kisConnected: s.kisConnected }, `KIS 실시간: ${s.message}`);
    broadcast({ type: 'status', data: s });
  });

  await kis.start(WATCHLIST.map((w) => w.code));

  app.log.info(
    `KIS env=${config.env} · 구독 ${WATCHLIST.length}종목: ${WATCHLIST.map((w) => `${w.name}(${w.code})`).join(', ')}`,
  );
  app.log.info(
    kis.isOrderNoticeEnabled
      ? '실시간 주문·체결 통보 구독함'
      : '실시간 주문·체결 통보 미구독 (KIS_HTS_ID 또는 KIS_<id>_HTS_ID 미설정)',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
