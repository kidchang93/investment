import Fastify from 'fastify';
import {
  getStatus as getAutomationStatus,
  runNow as runAutomationTask,
  setSettings as setAutomationSettings,
  startScheduler,
} from './automation/scheduler.js';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import {
  config,
  assertCredentials,
  describeCredentialPairings,
  getKisAccount,
  kisServerLabel,
  marketOpenDayHint,
  readServerMismatch,
  type KisAccountConfig,
} from './config.js';
import {
  addDefaultWatchlistItem,
  addWatchlistItem,
  createWatchlist,
  deleteWatchlist,
  ensureDomesticAssetTypes,
  ensureInstrumentSchema,
  getCategoryInstruments,
  getDefaultWatchlist,
  getDomesticInstrumentsBySymbols,
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
import { ensureThemeSchema, getThemeList, getThemeMembers } from './db/themes.js';
import { QuoteCache } from './quoteCache.js';
import { getThemePulses, THEME_PULSE_MAX_THEMES } from './themes/pulse.js';
import { createOrderIntent, ensureTradingSchema, getFillByOrderId, getTradingOverview } from './db/trading.js';
import { ensureAutoTraderSchema, getAutoTraderRuns } from './db/autoTrader.js';
import { ensureDailySelectionSchema } from './db/dailySelection.js';
import { getLastBuySubmittedAt } from './db/brokerOrders.js';
import { checkPositionGuard } from './trading/positionGuard.js';
import { getLayerPositions, getLayerTradeStats, getRealizedByLayer, getTradeMarks } from './db/layers.js';
import { pool } from './db/client.js';
import { LAYER_LABELS, LAYER_TARGETS, reconcile, summarizeLayers } from './trading/layers.js';
import { ensureMarketSnapshotSchema } from './db/marketSnapshot.js';
import { startDailySnapshot } from './trading/dailySnapshot.js';
import { ensureSignalScoreSchema, getSignalScoreSummary } from './db/signalScores.js';
import {
  claimClientOrderId,
  completeClaimedOrder,
  getOrderByClientOrderId,
} from './db/brokerOrders.js';
import { ensureBrokerOrderSchema, getBrokerOrderRecords, recordBrokerOrderAttempt } from './db/brokerOrders.js';
import {
  getAutoTraderState,
  resumeAutoTraders,
  startAutoTrader,
  stopAutoTrader,
  type AutoTraderDeps,
} from './trading/autoTrader.js';
import { listStrategies } from './trading/strategy.js';
import { isTrUnavailableOnServer } from './kis/errorCodes.js';
import { shareInflight } from './kis/inflight.js';
import { pendingBuySymbols, pendingSellQuantities } from './trading/pendingBuys.js';

/**
 * 모의 서버에 없는 기능을 화면에 어떻게 말할지. 두 라우트가 같은 말을 쓴다.
 * **오류가 아니다** — 설정으로 못 고치고 `APP_ENV=prod`에서만 쓸 수 있다.
 */
/**
 * 러너가 회차마다 쓰는 바깥 세계. **한 벌만 둔다** — 시작 라우트와 부팅 복구가
 * 서로 다른 것을 넘기면 되살아난 러너가 다르게 동작한다.
 */
const AUTO_TRADER_DEPS: AutoTraderDeps = {
  loadCandidates: loadAutoTraderCandidates,
  // 보유 종목은 후보 필터와 무관하게 분봉을 받아야 팔 수 있다.
  loadHeldInstruments: async (symbols) => [
    ...(await getDomesticInstrumentsBySymbols(symbols)).values(),
  ],
  /*
   * 접수했지만 아직 안 채워진 매수. **잔량으로 판단한다** — 시간 창으로
   * 잡으면 그날 체결이 늦을 때 그대로 뚫린다(`pendingBuys.ts`).
   * 조회 구간을 1일로 두는 것은 오늘 낸 주문만 자리를 먹으면 되기 때문이다.
   */
  loadPendingBuySymbols: async (accountId) => {
    const snapshot = await getKisDomesticExecutions(getKisAccount(accountId) ?? null, 1);
    return [...pendingBuySymbols(snapshot.executions)];
  },
  /*
   * 매도 주문에 묶인 물량. 같은 조회를 두 번 하는 셈이지만 러너가 회차마다
   * 한 번씩만 부르고, 두 판정이 같은 스냅샷을 봐야 어긋나지 않는다.
   */
  loadPendingSellQuantities: async (accountId) => {
    const snapshot = await getKisDomesticExecutions(getKisAccount(accountId) ?? null, 1);
    return pendingSellQuantities(snapshot.executions);
  },
};

const TR_UNAVAILABLE_NOTE = '모의투자 서버에는 이 조회 기능이 없습니다 · 실전 계좌에서만 볼 수 있습니다';

/**
 * 화면이 부르는 잔고 조회. **겹치면 하나로 묶는다.**
 *
 * ★ 목표 화면을 한 번 여는 데 같은 계좌 잔고가 네 번 나갔고(계좌 카드 둘 ·
 * 3층 · 자동화), 하나에 5~8초라 브라우저의 동시 연결 여섯 개를 다 먹어 뒤에
 * 선 요청은 시작조차 못 했다 — 화면은 "갱신 중"에서 멈췄는데 같은 API를
 * curl로 부르면 5초에 응답했다(2026-08-18 실측).
 *
 * ★ **주문 라우트는 이것을 쓰지 않는다.** 매수가능금액과 보유수량은 진행 중인
 * 조회를 물려받으면 안 된다 — 그 조회가 시작된 뒤 체결이 있었다면 체결 전
 * 잔고로 주문을 내게 되고, 이미 쓴 돈을 또 쓴다.
 */
const readAccountSnapshot = (account: KisAccountConfig | null): Promise<BrokerAccountSnapshot> =>
  shareInflight(`account:${account?.id ?? ''}`, () => getKisDomesticAccountSnapshot(account));

/**
 * 이 실행에서 그 계좌를 조회할 수 있나. 못 하면 **왜 못 하는지** 문장으로.
 *
 * ★ 실전 앱키는 `APP_ENV=vts`인 실행에서 조회조차 보내지 않는다(`config.ts`의
 * `readServerMismatch` — 계좌 TR 이름이 APP_ENV로 갈리고, 보내면 그 서버의 토큰이
 * 발급돼 캐시된다). 설계된 안전장치인데 화면에는 502와 "조회할 수 없습니다"로만
 * 닿아서, 실계좌 탭을 누른 사람은 **고장인 줄 안다**(2026-08-18).
 *
 * 보내기 전에 갈라내면 오류가 아니라 사실로 전할 수 있다.
 */
const accountReadBlock = (account: KisAccountConfig | null): string | null =>
  account ? readServerMismatch(account.server ?? config.env, config.env) : null;
import { loadAutoTraderCandidates } from './trading/universe.js';
import {
  DEFAULT_SCREENING_LOOKUPS,
  getLastScreening,
  rememberScreening,
  runScreening,
} from './trading/screening.js';
import { checkRiskRules, ensureRiskRuleSchema, getRiskRules, upsertRiskRules } from './db/riskRules.js';
import {
  getDailyCandles,
  getInstrumentCandles,
  getInstrumentIntradayCandles,
  getInstrumentNews,
  getInstrumentQuote,
  getInstrumentQuotes,
  getFinancials,
  getMarketMovers,
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
import { isUnconfirmedDivision, STOP_LIMIT_ORDER_DIVISION } from './kis/orderDivisions.js';
import { KisRealtime } from './kis/realtime.js';
import { WATCHLIST } from './watchlist.js';
import { INSTRUMENT_QUOTE_BATCH } from '@invest/shared';
import type {
  AmendLiveOrderRequest,
  AutoTraderConfig,
  BrokerExecution,
  BrokerPosition,
  BrokerAccountSnapshot,
  ChartTradeMark,
  PortfolioLayerSummary,
  PortfolioLayersSnapshot,
  TradingAlert,
  TradingHealthSnapshot,
  ClientMessage,
  ClientSubscribeInstrument,
  CreateOrderRequest,
  Instrument,
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

/*
 * `/api/instruments/quotes` 한 요청의 종목 수 상한.
 *
 * 예전에는 360이었다 — 뜻은 "시세 조회 12회"인데 숫자로는 종목 수뿐이라 몇 회가
 * 나가는지 아무도 몰랐다. 스크리닝·후보 고르기는 이미 호출 수로 상한을 잡는다
 * (`MAX_SCREENING_CALLS` · `MAX_PRICE_LOOKUP_CALLS`). 여기만 종목 수였다.
 *
 * 상한을 10회로 낮춘 이유: 실측해 본 최대가 10묶음 300종목 1.08초다
 * (`docs/DESIGN.md`). 12회는 재 보지 않은 값이었다.
 *
 * 프런트가 쓰는 값은 `INSTRUMENT_QUOTE_BATCH`(shared)에 함께 두어 갈라지지 않게 한다.
 */
const BATCH_QUOTE_LIMIT = INSTRUMENT_QUOTE_BATCH.limit;
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

/*
 * 캐시가 시각을 다시 찍지 않는다. 나이는 `Quote.fetchedAt` 하나로만 다닌다 —
 * 그래야 캐시에서 나온 값이 45초 묵었다는 사실이 응답에 남는다 (`quoteCache.ts`).
 */
const quoteCache = new QuoteCache();

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
  await ensureThemeSchema();
  await ensureTradingSchema();
  await ensureBrokerOrderSchema();
  await ensureRiskRuleSchema();
  await ensureAutoTraderSchema();
  await ensureDailySelectionSchema();
  await ensureMarketSnapshotSchema();
  /*
   * 그날의 시장 상태를 그날 찍어 둔다. **러너와 따로 돈다** — 러너가 꺼진 날도
   * 자료는 쌓여야 한다. 오늘(2026-08-04) look-ahead가 측정 결론을 통째로
   * 뒤집었고(20일 기준선 +10.3% → −5.7%), 그걸 없애려면 이 자료가 필요하다.
   */
  startDailySnapshot((message) => app.log.info(message));
  /*
   * 프로세스가 죽을 때 돌고 있던 러너를 되살린다. 2026-08-03 장중에 개발 서버가
   * 내려갔고 보유 8종목이 아무도 안 보는 채로 남았다 — 사람이 알아채기 전까지는
   * 매도 신호가 나도 나갈 수 없다.
   *
   * 서버가 뜨는 것을 막지 않는다. 되살리기가 실패해도 앱 자체는 떠야 사람이
   * 들어와서 손을 쓸 수 있다.
   */
  void resumeAutoTraders(AUTO_TRADER_DEPS)
    .then((count) => {
      if (count > 0) app.log.info({ count }, '자동매매 러너를 재시작했습니다');
    })
    .catch((err) => app.log.error({ err }, '자동매매 러너 재시작 실패'));
  await ensureSignalScoreSchema();
  await seedDefaultWatchlist(WATCHLIST);

  // ── REST ────────────────────────────────────────────────
  app.get('/api/health', async () => ({ ok: true, env: config.env }));

  /*
   * ── 자동화 제어 (2026-09-02) ──────────────────────────────────────────
   *
   * 사용자가 *"웹에서 컨트롤하고 싶은데 데몬 이런 게 아니라"*고 했다. 데몬은
   * 터미널에 묶여 있어 켜고 끄는 것도 상태를 보는 것도 명령어를 쳐야 한다.
   * 스케줄러가 이제 백엔드 안에 있으므로 여기서 제어한다.
   *
   * ★ **매매를 켜는 것은 별도 스위치**다. 자동화를 켜도 판단자는 안 돈다 —
   *   검증된 규칙이 설 때까지 새로 사지 않기로 했다(2026-09-02). 손절·수집·
   *   감시는 자동화 스위치만으로 돈다.
   */
  app.get('/api/automation/status', async () => getAutomationStatus());

  app.post('/api/automation/settings', async (req, reply) => {
    const body = (req.body ?? {}) as { enabled?: unknown; tradingEnabled?: unknown };
    const next: { enabled?: boolean; tradingEnabled?: boolean } = {};
    if (typeof body.enabled === 'boolean') next.enabled = body.enabled;
    if (typeof body.tradingEnabled === 'boolean') next.tradingEnabled = body.tradingEnabled;
    if (Object.keys(next).length === 0) {
      return reply.code(400).send({ message: 'enabled 또는 tradingEnabled를 boolean으로 주세요.' });
    }
    const settings = await setAutomationSettings(next);
    req.log.info({ settings }, '자동화 설정 변경');
    return { settings };
  });

  app.post('/api/automation/run', async (req, reply) => {
    const body = (req.body ?? {}) as { task?: unknown };
    if (typeof body.task !== 'string') {
      return reply.code(400).send({ message: 'task를 주세요.' });
    }
    const result = await runAutomationTask(body.task);
    if (!result.ok) return reply.code(409).send({ message: result.message });
    return result;
  });
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
      return await readAccountSnapshot(account);
    } catch (err) {
      req.log.warn({ err, accountId: req.query.accountId }, 'KIS 계좌 조회 실패');
      return reply.code(502).send({ message: 'KIS 계좌를 조회할 수 없습니다.' });
    }
  });

  /**
   * 3층 성과. **어느 층이 목표를 만들고 어느 층이 까먹는지** 한 번에 준다.
   *
   * 계좌 전체 손익만 보면 층이 섞여 보이지 않는다 — 2026-08-14에 평가손익의
   * 98%가 한 종목에서 나왔는데 합계만으로는 분산이 작동하는 것처럼 읽혔다.
   *
   * ★ **장부와 잔고 대조 결과를 함께 준다.** 어긋나면 층별 숫자가 그만큼
   * 거짓이므로, 화면이 그 사실을 값으로 알아야 한다.
   */
  /*
   * ★ **차트에 찍을 우리 매매.** 접수가 아니라 체결만 준다(층 장부를 본다).
   *
   * 계좌 조회를 안 탄다 — DB만 보므로 실계좌 차단(`accountReadBlock`) 상태에서도
   * 내가 언제 무엇을 샀는지는 볼 수 있어야 한다. 그건 우리 기록이지 증권사 값이 아니다.
   */
  app.get<{ Querystring: { accountId?: string; symbol?: string } }>(
    '/api/trading/trade-marks',
    async (req, reply) => {
      const symbol = (req.query.symbol ?? '').trim();
      if (!/^[0-9A-Z]{6}$/.test(symbol)) {
        return reply.code(400).send({ message: '종목코드(6자리)가 필요합니다.' });
      }
      const account = resolveAccount(req.query.accountId);
      if (account === 'unknown') return reply.code(404).send({ message: '등록된 KIS 계좌가 아닙니다.' });
      const accountId = account?.id ?? '';
      if (!accountId) return { accountId: '', symbol, marks: [] as ChartTradeMark[] };

      const rows = await getTradeMarks(accountId, symbol).catch(() => []);
      const marks: ChartTradeMark[] = [];
      for (const row of rows) {
        /*
         * ★ **UTC epoch seconds로 바꾼다.** `Candle.time`과 같은 축이어야 마커가
         *   캔들에 붙는다 — ms로 넣으면 차트가 조용히 안 그린다.
         */
        const [y, m, d] = row.tradedOn.split('-').map(Number);
        if (!y || !m || !d) continue;
        marks.push({
          time: Date.UTC(y, m - 1, d) / 1000,
          side: row.side,
          quantity: row.quantity,
          price: row.price,
          layer: row.layer,
          realizedPnl: row.realizedPnl ?? undefined,
        });
      }
      // 오름차순으로 준다 — 차트 마커는 시간순이어야 한다.
      marks.sort((a, b) => a.time - b.time);
      return { accountId, symbol, marks };
    },
  );

  app.get<{ Querystring: { accountId?: string } }>('/api/trading/layers', async (req, reply) => {
    const account = resolveAccount(req.query.accountId);
    if (account === 'unknown') return reply.code(404).send({ message: '등록된 KIS 계좌가 아닙니다.' });
    const accountId = account?.id ?? '';
    const readBlock = accountReadBlock(account);
    if (readBlock) {
      return {
        configured: false,
        accountId,
        totalAssets: 0,
        cash: 0,
        layers: [],
        mismatches: [],
        unpriced: [],
        fetchedAt: Date.now(),
        message: readBlock,
      } satisfies PortfolioLayersSnapshot;
    }
    try {
      const snapshot = await readAccountSnapshot(account);
      if (!snapshot.configured) {
        return {
          configured: false,
          accountId,
          totalAssets: 0,
          cash: 0,
          layers: [],
          mismatches: [],
          unpriced: [],
          fetchedAt: Date.now(),
          message: snapshot.message ?? 'KIS 계좌가 설정되지 않았습니다.',
        } satisfies PortfolioLayersSnapshot;
      }

      const positions = await getLayerPositions(accountId);
      const prices = new Map<string, number>();
      for (const p of snapshot.positions) {
        if (typeof p.currentPrice === 'number' && p.currentPrice > 0) prices.set(p.symbol, p.currentPrice);
      }
      const realized = await getRealizedByLayer(accountId);
      /*
       * ★ **D+2를 쓴다.** `cashBalance`(D+0)는 오늘 산 것이 아직 안 빠진 값이라
       * 그것으로 비중을 내면 자산이 부풀어 현금이 실제의 두 배로 보인다
       * (2026-08-14 실측: 17.3%가 37.5%로 나왔다).
       */
      const cash = snapshot.settlementCash ?? 0;
      const { summaries, unpriced, totalAssets } = summarizeLayers(positions, prices, realized, cash);
      const stats = new Map((await getLayerTradeStats(accountId)).map((s) => [s.layer, s]));

      const layers: PortfolioLayerSummary[] = summaries.map((s) => {
        const stat = stats.get(s.layer);
        const closedTrades = stat?.closedTrades ?? 0;
        const ratio = stat && stat.avgLoss > 0 ? stat.avgWin / stat.avgLoss : null;
        return {
          layer: s.layer,
          label: LAYER_LABELS[s.layer],
          rationale: LAYER_TARGETS[s.layer].rationale,
          symbols: s.symbols,
          cost: s.cost,
          marketValue: s.marketValue,
          unrealizedPnl: s.unrealizedPnl,
          realizedPnl: s.realizedPnl,
          totalPnl: s.totalPnl,
          weight: s.weight,
          targetWeight: s.targetWeight,
          contribution: totalAssets > 0 ? s.totalPnl / totalAssets : 0,
          closedTrades,
          // 청산이 없으면 승률을 낼 수 없다. 0%로 적으면 "다 졌다"가 지어진다.
          winRate: closedTrades > 0 ? (stat?.wins ?? 0) / closedTrades : null,
          profitFactor: ratio,
          // 손익비 2:1이면 승률 34%면 본전이다. 그 숫자가 판정의 기준선이다.
          breakEvenWinRate: ratio !== null && ratio > 0 ? 1 / (1 + ratio) : null,
        };
      });

      const brokerQty = new Map(snapshot.positions.map((p) => [p.symbol, p.quantity]));
      return {
        configured: true,
        accountId,
        totalAssets,
        cash,
        layers,
        mismatches: reconcile(positions, brokerQty),
        unpriced,
        fetchedAt: Date.now(),
      } satisfies PortfolioLayersSnapshot;
    } catch (err) {
      req.log.warn({ err, accountId }, '3층 성과 조회 실패');
      return reply.code(502).send({ message: '3층 성과를 조회할 수 없습니다.' });
    }
  });

  /**
   * 자동화가 살아 있나 · 지금 사람이 할 일이 있나.
   *
   * ★ **감지한 것을 아무도 안 보면 없는 것과 같다.** 2026-08-07부터 8일간
   * 자동화가 조용히 죽어 있었는데 로그에만 쌓이고 화면에는 없었다.
   */
  app.get<{ Querystring: { accountId?: string } }>('/api/trading/health', async (req, reply) => {
    const account = resolveAccount(req.query.accountId);
    if (account === 'unknown') return reply.code(404).send({ message: '등록된 KIS 계좌가 아닙니다.' });
    const accountId = account?.id ?? '';
    try {
      const beats = await pool.query<{ name: string; ran_at: string; note: string }>(
        `SELECT name, extract(epoch from ran_at) * 1000 AS ran_at, note
           FROM trading_heartbeats
          WHERE (ran_at AT TIME ZONE 'Asia/Seoul')::date = (now() AT TIME ZONE 'Asia/Seoul')::date
          ORDER BY ran_at DESC LIMIT 20`,
      ).catch(() => ({ rows: [] as Array<{ name: string; ran_at: string; note: string }> }));

      const started = await pool.query<{ first: string | null }>(
        `SELECT extract(epoch from min(traded_at)) * 1000 AS first
           FROM trading_layer_trades WHERE account_id = $1`,
        [accountId],
      ).catch(() => ({ rows: [{ first: null }] }));

      /*
       * ★ **볼 수 없는 계좌면 계좌 조회를 건너뛴다.** 하트비트는 계좌와 무관하므로
       * "오늘 자동으로 한 일"은 그대로 보여 줄 수 있다 — 자산만 못 잰다. 여기서
       * 통째로 502를 내면 실계좌 탭에서 자동화 상태까지 사라진다.
       */
      const readBlock = accountReadBlock(account);
      const snapshot = readBlock ? null : await readAccountSnapshot(account);
      const rules = await getRiskRules(accountId);

      /*
       * ★ 자산은 **세 계산 중 가장 작은 값**으로 본다. D+0은 오늘 산 것이 안 빠져
       * 부풀고(실측 +2,850만), 총평가는 모의 서버 정산 타이밍에 절반으로 나온 적이
       * 있다. 중단선은 늦게 잡는 쪽이 더 위험하므로 작은 값을 쓴다.
       */
      const stock = snapshot?.stockEvaluation ?? 0;
      const candidates = [
        (snapshot?.cashBalance ?? 0) + stock,
        (snapshot?.settlementCash ?? 0) + stock,
        snapshot?.totalEvaluation ?? 0,
      ].filter((v) => v > 0);
      const equity = candidates.length > 0 ? Math.min(...candidates) : 0;

      const alerts: TradingAlert[] = [];
      if (readBlock) {
        alerts.push({
          level: 'warn',
          message: '이 계좌는 지금 실행에서 볼 수 없습니다',
          action: readBlock,
        });
      }
      if (rules.stopEquity > 0 && equity > 0 && equity < rules.stopEquity) {
        alerts.push({
          level: 'danger',
          message: `중단선에 닿았습니다 — 자산이 ${Math.round(equity).toLocaleString('ko-KR')}원입니다`,
          action: '새 매수를 멈추고 무엇이 빠졌는지 확인하세요. 자동 집행은 이 상태에서 거부됩니다.',
        });
      }

      // 잔고를 못 받았으면 대조할 것이 없다. 빈 지도로 대조하면 **보유 전부가
      // "장부에만 있다"**로 나와 없는 사고를 지어낸다.
      const positions = snapshot ? await getLayerPositions(accountId) : [];
      const brokerQty = new Map((snapshot?.positions ?? []).map((p) => [p.symbol, p.quantity]));
      const mismatches = snapshot ? reconcile(positions, brokerQty) : [];
      if (mismatches.length > 0) {
        alerts.push({
          level: 'danger',
          message: `장부와 증권사 잔고가 ${mismatches.length}종목 어긋납니다`,
          action: '빠진 체결을 장부에 넣기 전까지 층별 손익을 믿을 수 없습니다.',
        });
      }

      // 평일 개장 뒤인데 오늘 기록이 없으면 자동화가 멈춰 있었다는 뜻이다.
      const seoul = new Date(Date.now() + 9 * 3600 * 1000);
      const dow = seoul.getUTCDay();
      const hhmm = seoul.getUTCHours() * 100 + seoul.getUTCMinutes();
      if (dow >= 1 && dow <= 5 && hhmm > 900 && beats.rows.length === 0) {
        alerts.push({
          level: 'warn',
          message: '평일 개장 뒤인데 오늘 자동 실행 기록이 없습니다',
          action: '터미널에서 zsh scripts/daemon.sh status 로 확인하세요.',
        });
      }

      const firstRaw = started.rows[0]?.first;
      return {
        heartbeats: beats.rows.map((r: { name: string; ran_at: string; note: string }) => ({
          name: r.name,
          ranAt: Number(r.ran_at),
          note: r.note,
        })),
        alerts,
        stopEquity: rules.stopEquity,
        equity,
        // 값이 없으면 `null`이다 — 0으로 채우면 1970년에 시작한 것이 된다.
        startedAt: firstRaw === null || firstRaw === undefined ? null : Number(firstRaw),
        fetchedAt: Date.now(),
      } satisfies TradingHealthSnapshot;
    } catch (err) {
      req.log.warn({ err, accountId }, '자동화 상태 조회 실패');
      return reply.code(502).send({ message: '자동화 상태를 조회할 수 없습니다.' });
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
      return { items: await getKisDomesticAmendableOrders(account) };
    } catch (err) {
      /*
       * **모의 서버에 없는 기능은 장애가 아니다.** 이 TR은 실전에만 있어
       * `APP_ENV=vts`인 동안 늘 `EGW02006`으로 실패한다. 502로 알리면 화면에
       * 빨간 배너가 하루 종일 뜨고, 정작 진짜 장애가 났을 때 구별되지 않는다.
       */
      if (isTrUnavailableOnServer(err)) return { items: [], unavailable: TR_UNAVAILABLE_NOTE };
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
        const items = await getKisDomesticReservedOrders(
          account,
          Number.isFinite(days) ? days : DEFAULT_EXECUTION_DAYS,
        );
        return { items };
      } catch (err) {
        // 위와 같은 이유. 이 TR도 모의 서버에 없다.
        if (isTrUnavailableOnServer(err)) return { items: [], unavailable: TR_UNAVAILABLE_NOTE };
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

    const {
      mode,
      strategy,
      targetEquity,
      stopEquity,
      intervalSeconds,
      maxPositions,
      minHoldMinutes,
      afterHoursExit,
    } = req.body;
    if (mode !== 'dry_run' && mode !== 'live') {
      return reply.code(400).send({ message: "mode는 'dry_run' 또는 'live'여야 합니다." });
    }
    if (!Number.isFinite(targetEquity) || !Number.isFinite(stopEquity)) {
      return reply.code(400).send({ message: '목표 금액과 중단 금액이 필요합니다.' });
    }
    /*
     * 최소 보유 시간. 생략하면 0(끔)이라 지금 동작 그대로다.
     *
     * 값을 조용히 잘라 맞추지 않는다 — 매도를 미루는 설정이라 480을 보냈는데 390으로
     * 깎이면 사용자가 건 것과 러너가 도는 것이 갈린다. 상한은 정규장 하루 길이
     * (09:00~15:30, 390분)로 잡는다. 그보다 길면 그날 안에는 어차피 못 판다.
     */
    const minHold = minHoldMinutes === undefined ? 0 : Number(minHoldMinutes);
    if (!Number.isFinite(minHold) || minHold < 0 || minHold > 390) {
      return reply
        .code(400)
        .send({ message: '최소 보유 시간은 0분부터 390분(정규장 하루 길이) 사이여야 합니다.' });
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
          /*
           * **0은 뜻이 있는 값이다 — 매수만 멈추고 매도는 계속한다.**
           *
           * `strategy.ts`가 매도 신호를 먼저 만들고 그 뒤에 `maxPositions - 보유`로
           * 살 자리를 계산한다. 0이면 자리가 없어 새로 사지 않지만 데드크로스
           * 청산은 그대로 나간다. 러너를 통째로 멈추면 청산도 같이 멈춰
           * **보유 종목이 아무도 안 보는 채로 남는다.**
           *
           * 예전에는 `Number(x) || 1`이라 0이 조용히 1이 됐다. 그러면 "오늘은
           * 사지 말자"는 판단을 넣을 방법이 없다.
           */
          maxPositions: Number.isFinite(Number(maxPositions)) && Number(maxPositions) >= 0
            ? Math.floor(Number(maxPositions))
            : 1,
          minHoldMinutes: Math.floor(minHold),
          /*
           * 장후 시간외 청산. **명시적으로 참일 때만 켠다** — 아직 확인되지 않은
           * 주문구분을 쓰는 경로라 실수로 켜지면 안 된다.
           */
          afterHoursExit: afterHoursExit === true,
        },
        AUTO_TRADER_DEPS,
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
    const { accountId, instrumentId, side, orderType, quantity, limitPrice, stopPrice, clientOrderId } =
      req.body;
    /*
     * ★ 3층 중 어느 층의 주문인가. **증권사 잔고는 층을 모른다** — 주문 시점에
     * 적어 두지 않으면 체결을 층에 되돌릴 수 없다(`layerSync`). 값이 없으면
     * 비워 둔다 — 짐작해서 채우면 그 층의 손익이 거짓이 된다.
     */
    const layerRaw = (req.body as { layer?: unknown }).layer;
    const layer = layerRaw === 'etf' || layerRaw === 'short' || layerRaw === 'bet'
      ? layerRaw
      : undefined;
    const auditBase = {
      accountId: accountId ?? '(미지정)',
      action: 'place' as const,
      layer,
      requestedInstrumentId: instrumentId,
      side: side === 'buy' || side === 'sell' ? side : undefined,
      orderType: orderType === 'market' || orderType === 'limit' ? orderType : undefined,
      quantity: typeof quantity === 'number' && Number.isFinite(quantity) ? quantity : undefined,
      limitPrice: typeof limitPrice === 'number' && Number.isFinite(limitPrice) ? limitPrice : undefined,
      // 스톱가는 지정가와 갈라 남긴다 — 손절이 걸린 주문인지가 기록에서 보여야 한다.
      stopPrice: typeof stopPrice === 'number' && Number.isFinite(stopPrice) ? stopPrice : undefined,
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

    /*
     * ── 스톱지정가 ────────────────────────────────────────────────────────
     *
     * `stopPrice`가 오면 스톱지정가로 접수한다. 현재가가 그 값에 닿는 순간
     * 지정가로 주문이 나가고, **감시는 우리 서버가 아니라 거래소가 한다** —
     * 서버가 꺼져 있어도 손절이 살아 있다는 것이 이 경로의 전부다.
     *
     * 지정가와 함께여야 성립한다. 스톱가만으로는 닿았을 때 얼마에 낼지가 없고,
     * 시장가에는 조건가격 자리가 없다. `kis/orderCash.ts`가 보내기 전에 한 번 더
     * 막지만, 여기서 먼저 걸러야 **왜 막혔는지가 감사 기록에 남는다.**
     */
    const stopLimit = stopPrice !== undefined;
    if (stopLimit && (typeof stopPrice !== 'number' || !Number.isFinite(stopPrice) || stopPrice <= 0)) {
      const message = '스톱가는 0보다 커야 합니다.';
      await block(message, ['스톱가 오류']);
      return reply.code(400).send({ message });
    }
    if (stopLimit && orderType !== 'limit') {
      const message = '스톱지정가는 지정가로만 낼 수 있습니다 — 스톱가에 닿았을 때 얼마에 낼지가 필요합니다.';
      await block(message, ['스톱지정가에 단가 없음']);
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

    /*
     * 시장가는 단가가 없으므로 현재가로 금액을 추정해 한도를 본다.
     *
     * **그 추정가를 기록에도 남긴다**(`estimatedPrice`). 남기지 않으면 이 주문이
     * 일일 금액 한도에 0원으로 쌓여, 시장가만 내는 동안에는 한도가 영원히 차지 않는다.
     * `limitPrice` 자리에 넣지 않는 이유는 그 컬럼이 "지정가 단가"라는 뜻이라서다.
     */
    let estimatedPrice: number | undefined;
    if (orderType === 'market') {
      try {
        const { price } = await getInstrumentQuote(instrument);
        if (Number.isFinite(price) && price > 0) estimatedPrice = price;
      } catch (err) {
        req.log.warn({ err, instrumentId }, '리스크 판정용 현재가 조회 실패');
      }
    }

    const placeAudit = {
      ...auditBase,
      accountId: account.id,
      instrumentId: instrument.id,
      symbol: instrument.providerSymbol,
      estimatedPrice,
    };

    /*
     * 추정가를 못 받았으면 보류한다. 예전에는 경고만 남기고 0으로 계속 갔는데,
     * 0이면 1회 금액 한도도 일일 금액 한도도 그냥 지나간다 — 모르는 것을 0으로
     * 치면 안전장치가 통째로 열린다.
     */
    if (orderType === 'market' && estimatedPrice === undefined) {
      const message = '현재가를 확인할 수 없어 시장가 주문을 보류합니다.';
      await audit({ ...placeAudit, status: 'blocked', message, blockers: ['현재가 확인 실패'] });
      return reply.code(503).send({ message });
    }

    const verdict = await checkRiskRules({
      accountId: account.id,
      symbol: instrument.providerSymbol,
      side,
      orderType,
      quantity,
      price: orderType === 'market' ? estimatedPrice : limitPrice,
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
     * ── 계좌 상태 관문 (2026-08-05) ──────────────────────────────────────
     *
     * `checkRiskRules`는 주문 한 건만 본다. **지금 무엇을 들고 있는지**를 봐야
     * 하는 잣대 — 미체결 매도·최소 보유·자리 수·중단선 — 는 여기서 건다.
     *
     * 원래 이 넷은 러너 안에만 있었다. 판단자가 에이전트로 옮겨가면서 러너를
     * 끄면 함께 사라지는데, 그중 둘은 이번 주에 실제로 돈을 잃은 버그다.
     * **누가 주문하든 같은 바닥을 지나야 한다.**
     *
     * ★ 조회가 실패하면 **막지 않는다.** 계좌 조회 한 번 실패로 매도까지 막히면
     * 종목이 갇힌다 — 못 파는 쪽이 훨씬 위험하다(`minHold.ts`의 ★ 절과 같은 판단).
     * 대신 적용하지 못했다는 사실을 감사 기록에 남긴다.
     */
    const guardRules = verdict.rules;
    const needsGuard =
      guardRules.maxPositions > 0 || guardRules.minHoldMinutes > 0 || guardRules.stopEquity > 0;
    if (needsGuard) {
      let guardState: {
        positions: Array<{ symbol: string; quantity: number }>;
        executions: BrokerExecution[];
        equity: number | undefined;
      } | null = null;
      try {
        const [snapshot, executions] = await Promise.all([
          getKisDomesticAccountSnapshot(account),
          getKisDomesticExecutions(account, 1)
            .then((r) => r.executions)
            .catch((): BrokerExecution[] => []),
        ]);
        guardState = {
          positions: snapshot.positions.map((p: BrokerPosition) => ({
            symbol: p.symbol,
            quantity: p.quantity,
          })),
          executions,
          equity: snapshot.totalEvaluation ?? undefined,
        };
      } catch (err) {
        req.log.warn({ err }, '계좌 상태를 못 읽어 포지션 관문을 적용하지 못했습니다');
        await audit({
          ...placeAudit,
          status: 'submitted',
          message: '계좌 상태를 못 읽어 포지션 관문을 적용하지 않았습니다.',
        });
      }

      if (guardState) {
        /*
         * 매수 시각은 **매도일 때만** 읽는다. 매수에는 쓰이지 않는데 조회는
         * 그대로 나가므로, 안 쓰는 호출로 초당 한도를 먹지 않게 한다.
         */
        let boughtAtBySymbol = new Map<string, number>();
        if (side === 'sell' && guardRules.minHoldMinutes > 0) {
          boughtAtBySymbol = await getLastBuySubmittedAt(
            account.id,
            guardState.positions.map((p) => p.symbol),
          ).catch(() => new Map<string, number>());
        }

        const guard = checkPositionGuard({
          symbol: instrument.providerSymbol,
          side,
          quantity,
          nowMs: Date.now(),
          positions: guardState.positions,
          executions: guardState.executions,
          boughtAtBySymbol,
          maxPositions: guardRules.maxPositions,
          minHoldMinutes: guardRules.minHoldMinutes,
          equity: guardState.equity,
          stopEquity: guardRules.stopEquity > 0 ? guardRules.stopEquity : undefined,
        });
        if (!guard.allowed) {
          await audit({
            ...placeAudit,
            status: 'blocked',
            message: '계좌 상태 관문에 막혔습니다.',
            blockers: guard.violations,
          });
          return reply.code(403).send({
            message: '계좌 상태 관문에 막혔습니다.',
            verdict: { allowed: false, violations: guard.violations, rules: guardRules },
          });
        }
      }
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

    /*
     * 스톱지정가는 **아직 이 레포가 접수시켜 본 적 없는 주문구분**이다
     * (`kis/orderDivisions.ts`). 그 사실을 기록과 응답에 적는다 — 접수됐다는 말만
     * 남으면 나중에 "저 경로는 검증된 것"으로 읽힌다.
     */
    const stopLimitNote =
      stopLimit && isUnconfirmedDivision(STOP_LIMIT_ORDER_DIVISION)
        ? ` · ★ 스톱지정가(주문구분 ${STOP_LIMIT_ORDER_DIVISION})는 아직 접수를 확인하지 못한 경로입니다`
        : '';

    try {
      const result = await placeKisDomesticOrder(account, {
        symbol: instrument.providerSymbol,
        side,
        orderType,
        quantity,
        limitPrice,
        orderDivision: stopLimit ? STOP_LIMIT_ORDER_DIVISION : undefined,
        conditionPrice: stopLimit ? stopPrice : undefined,
      });
      const done = {
        ...placeAudit,
        status: 'submitted' as const,
        message: result.message + stopLimitNote,
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
        message: result.message + stopLimitNote,
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

    const ids = [...new Set(req.body.ids.filter((id) => typeof id === 'string' && id.length > 0))];
    if (ids.length === 0) return [];
    /*
     * 넘치면 잘라내지 않고 거절한다. 예전에는 `.slice(0, BATCH_QUOTE_LIMIT)`이라
     * 상한을 넘긴 요청이 200으로 답하면서 뒤가 사라졌다 — 멀티시세가 31종목을
     * `rt_cd=0`으로 잘라 버리는 것과 같은 함정을 우리 API가 한 겹 더 만든 셈이다.
     */
    if (ids.length > BATCH_QUOTE_LIMIT) {
      return reply.code(400).send({
        message: `한 번에 ${BATCH_QUOTE_LIMIT}종목까지 물을 수 있습니다 (${ids.length}종목을 보냈습니다).`,
      });
    }

    /*
     * 캐시에 없는 것만 모아 한 번에 받는다. 예전에는 종목당 1회씩 때리며
     * 사이에 120ms를 쉬었다 — 관심목록 40종목이면 40회에 5초였다.
     * 멀티시세는 국내 종목 30개가 1회다.
     */
    const { hits, misses } = quoteCache.lookup(ids);
    const byId = new Map<string, Quote>(hits);

    if (misses.length > 0) {
      const found = (await Promise.all(misses.map((id) => getInstrument(id)))).filter(
        (instrument): instrument is Instrument => instrument !== null,
      );
      const batch = await getInstrumentQuotes(found);
      for (const [id, quote] of batch.quotes) {
        // 시각은 quote가 들고 온 것을 그대로 둔다. 여기서 다시 찍으면 나이가 지워진다.
        quoteCache.store(id, quote);
        byId.set(id, quote);
      }
      // 못 받은 것을 조용히 넘기지 않는다. 화면에는 값이 없는 자리로 남는다.
      for (const failure of batch.failed) {
        req.log.warn({ instrumentIds: failure.instrumentIds, message: failure.message }, '종목 현재가 배치 조회 실패');
      }
      if (batch.blank.length > 0) {
        req.log.warn({ instrumentIds: batch.blank }, '종목 현재가가 빈 값으로 왔습니다');
      }
    }

    // 요청 순서를 지킨다. 캐시에 있던 것과 방금 받은 것이 섞여 나가면 안 된다.
    return ids.map((id) => byId.get(id)).filter((quote): quote is Quote => quote !== undefined);
  });

  app.get('/api/instruments/terminal', async () => {
    return getTerminalInstruments();
  });

  /*
   * ── 테마 ─────────────────────────────────────────────
   *
   * 업종에는 `반도체`라는 칸이 없다. 분야별로 돈이 어디로 도는지는 테마로만 볼 수
   * 있다 (`docs/DESIGN.md`의 「테마 분류」).
   *
   * 목록·구성종목은 **DB만 본다 (KIS 호출 0회)**. 등락률만 시세를 부르고, 그
   * 비용을 응답에 담는다.
   */
  app.get('/api/themes', async () => {
    return getThemeList();
  });

  /*
   * 테마 여러 개의 지금 등락률. **누를 때만 돈다.**
   *
   * `/api/themes/:code`보다 먼저 등록해도 Fastify는 고정 경로를 먼저 맞춘다.
   * 그래도 읽는 사람이 헷갈리지 않게 위에 둔다.
   */
  app.get<{ Querystring: { codes?: string } }>('/api/themes/pulse', async (req, reply) => {
    const codes = (req.query.codes ?? '')
      .split(',')
      .map((code) => code.trim())
      .filter((code) => code.length > 0);
    if (codes.length === 0) {
      return reply.code(400).send({
        message: `테마 코드가 필요합니다. codes=004,012 처럼 ${THEME_PULSE_MAX_THEMES}개까지 넣습니다.`,
      });
    }
    try {
      return await getThemePulses(codes);
    } catch (err) {
      req.log.warn({ err, codes }, '테마 등락률 조회 실패');
      return reply.code(502).send({ message: '테마 등락률을 조회하지 못했습니다.' });
    }
  });

  app.get<{ Params: { code: string } }>('/api/themes/:code', async (req, reply) => {
    const members = await getThemeMembers(req.params.code);
    if (!members) return reply.code(404).send({ message: '그런 테마 코드가 없습니다.' });
    return members;
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
  /*
   * 신호 채점 누적 성적.
   *
   * 백테스트는 과거를 말하고 이 숫자는 실제로 낸 신호가 어땠는지를 말한다.
   * 아직 채점된 신호가 없으면 빈 배열이 온다 — 화면은 그걸 0%로 채우지 말고
   * `아직 채점된 신호가 없습니다`로 적어야 한다.
   */
  app.get<{ Querystring: { accountId?: string } }>('/api/trading/signal-scores', async (req, reply) => {
    const account = resolveAccount(req.query.accountId);
    if (account === 'unknown') return reply.code(404).send({ message: '등록된 KIS 계좌가 아닙니다.' });
    if (!account) return reply.code(400).send({ message: '등록된 KIS 계좌가 없습니다.' });
    try {
      return await getSignalScoreSummary(account.id);
    } catch (err) {
      req.log.warn({ err, accountId: account.id }, '신호 채점 성적 조회 실패');
      return reply.code(502).send({ message: '채점 성적을 조회하지 못했습니다.' });
    }
  });

  /*
   * 거래소 등락률 순위. **상위 30만 온다 — 전 종목이 아니다.**
   *
   * `랭킹` 탭은 관심·최근 종목 안에서만 순위를 매겨서, "오늘 시장에서 많이 오른
   * 낯선 종목"을 찾아주지 못했다. 이건 거래소가 전 종목을 대상으로 매긴 값이다.
   * 호출 1회라 탭을 열 때 받아도 된다.
   */
  app.get<{ Querystring: { direction?: string } }>('/api/market/movers', async (req, reply) => {
    const direction = req.query.direction === 'down' ? 'down' : 'up';
    try {
      return await getMarketMovers(direction);
    } catch (err) {
      req.log.warn({ err, direction }, '등락률 순위 조회 실패');
      return reply.code(502).send({ message: '등락률 순위를 조회하지 못했습니다.' });
    }
  });

  /*
   * 자동매매 후보 거르기 결과.
   *
   * 조회는 **마지막에 잰 값**만 준다. 멀티시세로 30종목에 KIS 1회지만, 탭을
   * 열 때마다 다시 돌리면 그만큼 호출이 나간다. 다시 재는 것은 아래 run이 한다.
   * 몇 회가 나갔는지는 결과의 `quoteCalls`에 담겨 있다.
   */
  app.get<{ Querystring: { accountId?: string } }>('/api/trading/screening', async (req, reply) => {
    const account = resolveAccount(req.query.accountId);
    if (account === 'unknown') return reply.code(404).send({ message: '등록된 KIS 계좌가 아닙니다.' });
    if (!account) return reply.code(400).send({ message: '등록된 KIS 계좌가 없습니다.' });
    // 아직 안 돌렸으면 null이다. 빈 결과와 구별되어야 화면이 0으로 채우지 않는다.
    return { result: getLastScreening(account.id) };
  });

  /*
   * 다시 훑는다. **사용자가 누를 때만 돈다.**
   *
   * 예수금은 서버가 계좌에서 직접 읽는다 — 프론트가 보내면 화면에 뜬 값과
   * 실제 계좌가 어긋났을 때 거른 사유가 틀린다.
   */
  app.post<{ Body: { accountId?: string; lookups?: number } }>(
    '/api/trading/screening/run',
    async (req, reply) => {
      const account = resolveAccount(req.body.accountId);
      if (account === 'unknown') return reply.code(404).send({ message: '등록된 KIS 계좌가 아닙니다.' });
      if (!account) return reply.code(400).send({ message: '등록된 KIS 계좌가 없습니다.' });
      try {
        const snapshot = await getKisDomesticAccountSnapshot(account);
        const cash = snapshot.cashBalance ?? 0;
        const result = await runScreening(cash, Number(req.body.lookups) || DEFAULT_SCREENING_LOOKUPS);
        rememberScreening(account.id, result);
        return { result };
      } catch (err) {
        req.log.warn({ err, accountId: account.id }, '후보 스크리닝 실패');
        return reply.code(502).send({ message: '후보를 훑지 못했습니다.' });
      }
    },
  );

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

  /*
   * ── ★★ 화면을 백엔드가 함께 낸다 (2026-09-02) ────────────────────────
   *
   * 사용자가 말했다 — *"백 프론트 두 개를 꼭 둬야 되나? 하나로 서빙할 수 있는
   * 방법이 제일 좋을 것 같다."*
   *
   * 맞다. 띄울 것이 둘이면 **둘 다 떠 있는지 사람이 확인**해야 하고, 그것이
   * 곧 명령어를 치는 일이 된다. `frontend/dist`가 있으면 백엔드가 그대로 낸다 —
   * `http://localhost:4000` 하나로 화면·API·WebSocket이 전부 나온다.
   *
   * ★ **API 라우트를 전부 등록한 뒤에 붙인다.** 정적 서빙이 먼저 오면
   *   `/api/...`까지 파일로 찾으려 든다.
   *
   * ★ dist가 없으면 **조용히 넘어가지 않고 로그로 말한다.** 화면이 안 뜨는데
   *   이유를 모르는 것이 가장 나쁘다 — `npm run build`를 하면 생긴다.
   *
   * ★ 개발 중에는 `npm run dev:web`(:5173)이 그대로 낫다(HMR). 그쪽은
   *   `VITE_API_BASE`로 이 서버를 부르므로 둘이 공존한다.
   */
  const webRoot = resolvePath(process.cwd(), process.cwd().endsWith('backend') ? '../frontend/dist' : 'frontend/dist');
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot });
    /*
     * SPA라 새로고침·딥링크가 서버에 없는 경로로 들어온다. **API가 아닌 404만**
     * `index.html`로 돌린다 — API 404까지 HTML을 주면 화면이 JSON 파싱에서
     * 깨지고 원인이 안 보인다.
     */
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/stream')) {
        return reply.code(404).send({ message: '없는 경로입니다.' });
      }
      return reply.sendFile('index.html');
    });
    app.log.info({ webRoot }, '화면을 함께 낸다 — http://localhost:%d', config.port);
  } else {
    app.log.warn({ webRoot }, '화면 빌드가 없다 — npm run build 를 하면 이 주소에서 화면도 나온다');
  }

  await app.listen({ port: config.port, host: '0.0.0.0' });

  /*
   * ★ 스케줄러를 **백엔드가 들고 있다.** 설정은 DB에서 읽어 이어간다 —
   *   재시작으로 자동화가 조용히 꺼지면 그날이 통째로 빈다(2026-08-07부터
   *   8일간 실제로 그랬다).
   */
  await startScheduler().catch((err: unknown) => {
    app.log.error({ err }, '자동화 스케줄러를 시작하지 못했습니다');
  });

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

  /*
   * ★★ **실시간이 안 떠도 서버는 뜬다** (2026-09-03).
   *
   * 전에는 `await kis.start(...)`가 맨몸이었다. 그래서 KIS **모의 서버가 죽자
   * 백엔드가 통째로 못 떴다** — 승인키(`/oauth2/Approval`) 발급이 실패하면서
   * `main()`이 그 자리에서 죽었고, REST·화면·스케줄러가 전부 함께 멈췄다.
   *
   * ★ 실시간 체결가는 **부가 기능**이다. 없으면 차트가 실시간으로 안 움직일
   *   뿐, 시세 조회·주문·손절 감시·적정가 분석은 REST로 다 된다. 그것들까지
   *   못 쓰게 만드는 것은 값이 맞지 않는다.
   *
   * ★ **조용히 넘기지 않는다.** 경고를 남기고 `status`로도 알린다 — 실시간이
   *   빠진 것을 모르면 "값이 안 변한다"를 시장이 조용한 것으로 읽는다.
   */
  try {
    await kis.start(WATCHLIST.map((w) => w.code));
  } catch (error) {
    app.log.error(
      { err: error },
      '★ KIS 실시간을 시작하지 못했다 — 서버는 뜬다. 실시간 체결가만 빠지고'
      + ' 시세 조회·주문·자동화는 REST로 그대로 돈다.',
    );
    broadcast({
      type: 'status',
      data: {
        kisConnected: false,
        message: '실시간 연결 실패 — 조회는 정상입니다. KIS 서버 상태를 확인하세요.',
      } as ConnectionStatus,
    });
  }

  app.log.info(
    `KIS env=${config.env} · 계좌 ${config.kisAccounts.map((a) => a.id).join(', ') || '없음'}`
    + ` · 시세·실시간은 계좌 ${config.primaryCredentialId}의 앱키를 쓴다`
    + ` · 구독 ${WATCHLIST.length}종목: ${WATCHLIST.map((w) => `${w.name}(${w.code})`).join(', ')}`,
  );
  /*
   * 설정하려 했는데 못 쓴 계좌를 알린다. 예전에는 조용히 빠져서, 넣은 사람이
   * 오타를 낸 줄 모르고 "왜 이 계좌가 화면에 없지"만 남았다.
   */
  for (const skipped of config.skippedKisAccounts) {
    app.log.warn(`KIS 계좌 ${skipped.id}을(를) 쓰지 못했습니다 — ${skipped.reason}`);
  }
  /*
   * **어느 앱키가 어느 서버에 붙는지 계좌마다 적는다.** 조용히 다른 서버에 붙는 일이
   * 없어야 한다 — 2026-08-01에 `APP_ENV=prod` + 모의 앱키로 돌렸더니 멀티시세·일봉이
   * 정상 응답하고 분봉만 `EGW02004`로 막혔다. 반쯤 되니 아무도 눈치채지 못했고
   * `backend/.cache/token-prod-VTS-EXTRAORDINARY.json`까지 생겼다.
   *
   * **명시한 것과 추정한 것을 갈라 적는다.** 코드는 앱키가 어느 서버용인지 알 수 없어서
   * `KIS_<id>_SERVER`가 없으면 `APP_ENV`로 짐작할 뿐이다. 짐작을 사실처럼 적지 않는다.
   */
  if (config.primaryCredentialProblem) app.log.warn(config.primaryCredentialProblem);
  for (const pairing of describeCredentialPairings(config.kisAccounts, config.env)) {
    const source = pairing.declared ? 'KIS_<id>_SERVER에 명시' : 'APP_ENV로 추정';
    const primaryMark = pairing.id === config.primaryCredentialId ? ' · 시세·실시간 기본' : '';
    const line = `자격증명 ${pairing.id} → ${kisServerLabel(pairing.server)} (${source})${primaryMark}`;
    if (pairing.matchesEnv) app.log.info(line);
    else {
      app.log.warn(
        `${line} — 이 실행은 ${kisServerLabel(config.env)}라 짝이 어긋난다.`
        + ' 이 자격증명으로는 조회도 주문도 보내지 않는다.',
      );
    }
  }
  /*
   * 개장일 조회가 어느 서버로 나가는지 반드시 알린다. 조용히 다른 서버에 붙는 것은
   * 안 된다. 모의 서버에는 이 TR이 없어(EGW02006) 설정이 없으면 리스크 룰이 늘
   * 보류로 막히므로, 그 사실도 여기서 말한다.
   */
  const openDay = config.marketOpenDay;
  if (openDay.viaProdServer) {
    app.log.warn(
      `개장일 조회만 ${kisServerLabel(openDay.server)}에 물어본다`
      + ` — 자격증명 ${openDay.credentials.id} (KIS_OPEN_DAY_CREDENTIAL_ID).`
      + ' 조회 전용이며 주문은 이 서버로 나가지 않는다.',
    );
  } else {
    const hint = marketOpenDayHint(openDay);
    if (hint) app.log.warn(`개장일을 확인하지 못하면 실주문이 보류된다 — ${hint}`);
    // 실전에서는 개장일 조회가 그대로 동작한다. 설정을 적어 둔 것만 무시한다고 알린다.
    else if (openDay.problem) app.log.warn(openDay.problem);
  }
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
