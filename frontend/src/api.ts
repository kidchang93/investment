import { API_BASE } from './config';
import type {
  AutoTraderConfig,
  AutoTraderState,
  AmendLiveOrderRequest,
  CancelReservedOrderRequest,
  PlaceReservedOrderRequest,
  BrokerAccountRef,
  BrokerAccountSnapshot,
  BrokerAmendableOrder,
  BrokerOrderRecord,
  BrokerReservedOrder,
  BrokerSellability,
  BrokerTradeProfitSnapshot,
  LiveOrderGate,
  PlaceLiveOrderRequest,
  PlaceLiveOrderResult,
  RiskRuleSet,
  BrokerExecutionSnapshot,
  BrokerOrderability,
  CandlesResponse,
  CreateOrderRequest,
  CreateOrderResponse,
  ExchangeRate,
  FinancialSnapshot,
  Instrument,
  InstrumentCategory,
  MarketMoversSnapshot,
  NewsItem,
  OrderBook,
  OrderType,
  SignalScoreSummary,
  Quote,
  ScreeningResult,
  StrategyListResponse,
  ThemeList,
  ThemePulseBatch,
  TradingOverview,
  WatchItem,
  WatchlistGroup,
} from '@invest/shared';

export async function fetchWatchlist(): Promise<WatchItem[]> {
  const res = await fetch(`${API_BASE}/api/watchlist`);
  if (!res.ok) throw new Error(`watchlist 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchCandles(code: string): Promise<CandlesResponse> {
  const res = await fetch(`${API_BASE}/api/candles/${code}`);
  if (!res.ok) throw new Error(`candles 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchQuote(code: string): Promise<Quote> {
  const res = await fetch(`${API_BASE}/api/quote/${code}`);
  if (!res.ok) throw new Error(`quote 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchTradingOverview(): Promise<TradingOverview> {
  const res = await fetch(`${API_BASE}/api/trading/overview`);
  if (!res.ok) throw new Error(`매매 개요 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchKisAccounts(): Promise<BrokerAccountRef[]> {
  const res = await fetch(`${API_BASE}/api/broker/kis/accounts`);
  if (!res.ok) throw new Error(`KIS 계좌 목록 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchKisAccountSnapshot(accountId?: string): Promise<BrokerAccountSnapshot> {
  const res = await fetch(`${API_BASE}/api/broker/kis/account${accountQuery(accountId)}`);
  if (!res.ok) throw new Error(`KIS 계좌 조회 실패: ${res.status}`);
  return res.json();
}

/** accountId를 생략하면 서버 기본 계좌를 쓴다. */
function accountQuery(accountId?: string): string {
  return accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
}

export async function fetchKisExecutions(days?: number, accountId?: string): Promise<BrokerExecutionSnapshot> {
  const params = new URLSearchParams();
  if (days !== undefined && Number.isFinite(days)) params.set('days', String(days));
  if (accountId) params.set('accountId', accountId);
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const res = await fetch(`${API_BASE}/api/broker/kis/executions${suffix}`);
  if (!res.ok) throw new Error(`KIS 체결내역 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchKisOrderability(
  instrumentId: string,
  orderType: OrderType,
  price?: number,
  accountId?: string,
): Promise<BrokerOrderability> {
  const params = new URLSearchParams({ instrumentId, orderType });
  // 시장가는 단가 없이 조회해야 브로커가 최대 수량을 제대로 계산한다.
  if (orderType === 'limit' && price !== undefined && Number.isFinite(price) && price > 0) {
    params.set('price', String(Math.floor(price)));
  }
  if (accountId) params.set('accountId', accountId);
  const res = await fetch(`${API_BASE}/api/broker/kis/orderability?${params.toString()}`);
  if (!res.ok) throw new Error(`KIS 매수가능금액 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchKisSellability(
  instrumentId: string,
  accountId?: string,
): Promise<BrokerSellability> {
  const params = new URLSearchParams({ instrumentId });
  if (accountId) params.set('accountId', accountId);
  const res = await fetch(`${API_BASE}/api/broker/kis/sellability?${params.toString()}`);
  if (!res.ok) throw new Error(`KIS 매도가능수량 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchKisOpenOrders(accountId?: string): Promise<BrokerAmendableOrder[]> {
  const res = await fetch(`${API_BASE}/api/broker/kis/open-orders${accountQuery(accountId)}`);
  if (!res.ok) throw new Error(`KIS 미체결 주문 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchKisReservedOrders(accountId?: string): Promise<BrokerReservedOrder[]> {
  const res = await fetch(`${API_BASE}/api/broker/kis/reserved-orders${accountQuery(accountId)}`);
  if (!res.ok) throw new Error(`KIS 예약주문 조회 실패: ${res.status}`);
  return res.json();
}

/**
 * 실계좌 주문 전송 시도 기록. 게이트에 막힌 시도(blocked)도 함께 온다.
 *
 * `hasMore`는 서버 상한을 넘겨 더 오래된 기록이 남아 있다는 뜻이다. 예전에는
 * 배열만 와서, 화면이 `50건`을 보여주면서 그게 전부인지 잘린 것인지 말할
 * 방법이 없었다.
 */
export async function fetchKisOrderLog(
  accountId?: string,
): Promise<{ records: BrokerOrderRecord[]; hasMore: boolean }> {
  const res = await fetch(`${API_BASE}/api/broker/kis/order-log${accountQuery(accountId)}`);
  if (!res.ok) throw new Error(`실주문 기록 조회 실패: ${res.status}`);
  return res.json();
}

/**
 * 예약주문 취소. KIS가 요구하는 예약주문조직번호는 등록·조회 응답에 없어 비워 보낸다.
 * 실패하면 KIS HTS/MTS 앱에서 직접 취소해야 한다.
 */
export async function cancelKisReservedOrder(
  request: CancelReservedOrderRequest,
): Promise<{ accepted: boolean; processed: boolean; message: string }> {
  const res = await fetch(`${API_BASE}/api/broker/kis/reserved-orders/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String((body as { message?: string }).message ?? `예약주문 취소 실패: ${res.status}`));
  return body as { accepted: boolean; processed: boolean; message: string };
}

export async function placeKisReservedOrder(
  request: PlaceReservedOrderRequest,
): Promise<{ accepted: boolean; reservationSeq: string; message: string }> {
  const res = await fetch(`${API_BASE}/api/broker/kis/reserved-orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String((body as { message?: string }).message ?? `예약주문 등록 실패: ${res.status}`));
  return body as { accepted: boolean; reservationSeq: string; message: string };
}

export async function fetchKisTradeProfit(accountId?: string, days?: number): Promise<BrokerTradeProfitSnapshot> {
  const params = new URLSearchParams();
  if (accountId) params.set('accountId', accountId);
  if (days !== undefined && Number.isFinite(days)) params.set('days', String(days));
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const res = await fetch(`${API_BASE}/api/broker/kis/trade-profit${suffix}`);
  if (!res.ok) throw new Error(`기간별 매매손익 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchKisRiskRules(accountId?: string): Promise<RiskRuleSet> {
  const res = await fetch(`${API_BASE}/api/broker/kis/risk-rules${accountQuery(accountId)}`);
  if (!res.ok) throw new Error(`리스크 룰 조회 실패: ${res.status}`);
  return res.json();
}

/** 부분 수정. 서버가 현재 값과 병합한 뒤 유효성을 다시 본다. */
export async function updateKisRiskRules(
  rules: Partial<RiskRuleSet>,
  accountId?: string,
): Promise<RiskRuleSet> {
  const res = await fetch(`${API_BASE}/api/broker/kis/risk-rules${accountQuery(accountId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rules),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String((body as { message?: string }).message ?? `리스크 룰 저장 실패: ${res.status}`));
  return body as RiskRuleSet;
}

export async function fetchKisLiveOrderGate(): Promise<LiveOrderGate> {
  const res = await fetch(`${API_BASE}/api/broker/kis/live-order-gate`);
  if (!res.ok) throw new Error(`실주문 게이트 조회 실패: ${res.status}`);
  return res.json();
}

/**
 * 실계좌 주문 전송. 서버 게이트가 열려 있고 리스크 룰을 통과해야 접수된다.
 * paper 주문(`createOrder`)과 의도적으로 분리된 경로다.
 */
export async function placeKisLiveOrder(request: PlaceLiveOrderRequest): Promise<PlaceLiveOrderResult> {
  const res = await fetch(`${API_BASE}/api/broker/kis/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String((body as { message?: string }).message ?? `실주문 전송 실패: ${res.status}`));
  return body as PlaceLiveOrderResult;
}

export async function amendKisLiveOrder(request: AmendLiveOrderRequest): Promise<{ accepted: boolean; message: string }> {
  const res = await fetch(`${API_BASE}/api/broker/kis/orders/amend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String((body as { message?: string }).message ?? `정정·취소 실패: ${res.status}`));
  return body as { accepted: boolean; message: string };
}

export async function fetchUsdKrwExchangeRate(): Promise<ExchangeRate> {
  const res = await fetch(`${API_BASE}/api/exchange-rates/usd-krw`);
  if (!res.ok) throw new Error(`USD/KRW 환율 조회 실패: ${res.status}`);
  return res.json();
}

export async function createOrder(request: CreateOrderRequest): Promise<CreateOrderResponse> {
  const res = await fetch(`${API_BASE}/api/trading/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw new Error(`주문 생성 실패: ${res.status}`);
  return res.json();
}

export async function searchInstruments(query: string): Promise<Instrument[]> {
  const params = new URLSearchParams({ q: query });
  const res = await fetch(`${API_BASE}/api/instruments/search?${params.toString()}`);
  if (!res.ok) throw new Error(`종목 검색 실패: ${res.status}`);
  return res.json();
}

export async function fetchInstrumentCandles(id: string): Promise<CandlesResponse> {
  const res = await fetch(`${API_BASE}/api/instruments/${encodeURIComponent(id)}/candles`);
  if (!res.ok) throw new Error(`종목 차트 조회 실패: ${res.status}`);
  return res.json();
}

/**
 * 자동매매 신호 채점 성적.
 *
 * 아직 채점된 신호가 없으면 빈 배열이 온다. 화면은 그걸 0%로 채우지 말고
 * 아직 없다고 적어야 한다 — 빈 성적표와 0점은 다르다.
 */
export async function fetchSignalScores(accountId?: string): Promise<SignalScoreSummary[]> {
  const res = await fetch(`${API_BASE}/api/trading/signal-scores${accountQuery(accountId)}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `채점 성적 조회 실패: ${res.status}`);
  }
  return res.json();
}

/**
 * 마지막으로 훑은 후보 거르기 결과. 아직 안 훑었으면 null이다.
 *
 * 조회만 한다 — 종목 하나에 KIS 시세 1회라 화면을 열 때마다 다시 훑을 수 없다.
 * `null`(안 훑음)과 빈 결과(훑었는데 아무것도 안 남음)는 다른 상태라 화면이
 * 구별해야 한다.
 */
export async function fetchScreening(accountId?: string): Promise<ScreeningResult | null> {
  const res = await fetch(`${API_BASE}/api/trading/screening${accountQuery(accountId)}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `후보 거르기 조회 실패: ${res.status}`);
  }
  return ((await res.json()) as { result: ScreeningResult | null }).result;
}

/**
 * 테마 목록. **시세 조회가 나가지 않는다** (서버가 DB만 본다).
 *
 * 종목을 하나도 못 찾은 테마는 `emptyThemes`로 갈라져 온다. 지워서 오지 않는
 * 이유는 이 목록이 낡았다는 사실 자체이기 때문이다.
 */
export async function fetchThemes(): Promise<ThemeList> {
  const res = await fetch(`${API_BASE}/api/themes`);
  if (!res.ok) throw new Error(`테마 목록 조회 실패: ${res.status}`);
  return res.json();
}

/**
 * 테마들의 지금 등락률. **사용자가 누를 때만 부를 것** — 30종목마다 시세 조회
 * 1회가 나간다. 실제로 몇 회가 나갔는지는 응답의 `quoteCalls`에 온다.
 */
export async function fetchThemePulses(codes: string[]): Promise<ThemePulseBatch> {
  const res = await fetch(`${API_BASE}/api/themes/pulse?codes=${encodeURIComponent(codes.join(','))}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `테마 등락률 조회 실패: ${res.status}`);
  }
  return res.json();
}

/** 다시 훑는다. **사용자가 누를 때만 부를 것** — 종목 수만큼 KIS 호출이 나간다. */
export async function runScreening(accountId?: string, lookups?: number): Promise<ScreeningResult> {
  const res = await fetch(`${API_BASE}/api/trading/screening/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId, lookups }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `후보 거르기 실행 실패: ${res.status}`);
  }
  return ((await res.json()) as { result: ScreeningResult }).result;
}

/**
 * 거래소가 매긴 등락률 순위 상위 30.
 *
 * `랭킹` 탭의 기존 목록은 관심·최근 종목 안에서만 순위를 매긴다 — 이건 전
 * 종목이 대상이다. 다만 **상위 30만 온다.** 화면이 "시장 전체를 봤다"고
 * 읽히지 않게 몇 개를 받은 값인지 밝혀야 한다.
 */
export async function fetchMarketMovers(direction: 'up' | 'down'): Promise<MarketMoversSnapshot> {
  const res = await fetch(`${API_BASE}/api/market/movers?direction=${direction}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `등락률 순위 조회 실패: ${res.status}`);
  }
  return res.json();
}

export async function fetchInstrumentQuote(id: string): Promise<Quote> {
  const res = await fetch(`${API_BASE}/api/instruments/${encodeURIComponent(id)}/quote`);
  if (!res.ok) throw new Error(`종목 현재가 조회 실패: ${res.status}`);
  return res.json();
}

/**
 * 호가 10단계와 동시호가 예상 체결.
 *
 * 국내 주식·ETF만 대상이라 그 밖의 종목은 서버가 404에 사유를 담아 준다.
 * "없다"와 "이 종목은 대상이 아니다"를 구별해야 하므로 상태 코드를 함께 던진다.
 */
export async function fetchOrderBook(id: string): Promise<OrderBook> {
  const res = await fetch(`${API_BASE}/api/instruments/${encodeURIComponent(id)}/order-book`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? `호가 조회 실패: ${res.status}`);
  }
  return res.json();
}

/**
 * 분기별 재무 지표.
 *
 * ETF·ETN·해외 종목은 서버가 404로 거른다. 그건 조회가 **실패**한 게 아니라
 * 애초에 **해당이 없는** 것이다 — 재무제표가 없는 상품을 "재무가 나쁘다"로
 * 읽으면 안 된다. 그래서 세 상태를 타입에서 갈라 둔다. 하나의 문자열 오류로
 * 합치면 화면이 둘을 같은 빨간 글씨로 적게 된다.
 */
export type FinancialsResult =
  | { kind: 'ok'; rows: FinancialSnapshot[] }
  | { kind: 'not-applicable'; reason: string }
  | { kind: 'failed'; reason: string };

export async function fetchInstrumentFinancials(id: string): Promise<FinancialsResult> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/instruments/${encodeURIComponent(id)}/financials`);
  } catch (err) {
    return { kind: 'failed', reason: err instanceof Error ? err.message : '네트워크 오류' };
  }
  if (res.status === 404) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    return { kind: 'not-applicable', reason: body.message ?? '재무 지표 대상이 아닙니다.' };
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    return { kind: 'failed', reason: body.message ?? `재무 지표 조회 실패: ${res.status}` };
  }
  return { kind: 'ok', rows: (await res.json()) as FinancialSnapshot[] };
}

export async function fetchInstrumentIntradayCandles(id: string): Promise<CandlesResponse> {
  const res = await fetch(`${API_BASE}/api/instruments/${encodeURIComponent(id)}/intraday-candles`);
  if (!res.ok) throw new Error(`종목 분봉 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchInstrumentNews(id: string): Promise<NewsItem[]> {
  const res = await fetch(`${API_BASE}/api/instruments/${encodeURIComponent(id)}/news`);
  if (!res.ok) throw new Error(`종목 뉴스 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchInstrumentQuotes(ids: string[]): Promise<Quote[]> {
  const res = await fetch(`${API_BASE}/api/instruments/quotes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error(`종목 현재가 배치 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchInstrumentCategories(): Promise<InstrumentCategory[]> {
  const res = await fetch(`${API_BASE}/api/instruments/categories`);
  if (!res.ok) throw new Error(`종목 카테고리 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchCategoryInstruments(id: string, query = ''): Promise<Instrument[]> {
  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query.trim());
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const res = await fetch(`${API_BASE}/api/instruments/categories/${encodeURIComponent(id)}${suffix}`);
  if (!res.ok) throw new Error(`종목 리스트 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchTerminalInstruments(): Promise<Instrument[]> {
  const res = await fetch(`${API_BASE}/api/instruments/terminal`);
  if (!res.ok) throw new Error(`터미널 종목 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchDefaultWatchlist(): Promise<Instrument[]> {
  const res = await fetch(`${API_BASE}/api/watchlists/default`);
  if (!res.ok) throw new Error(`관심종목 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchWatchlists(): Promise<WatchlistGroup[]> {
  const res = await fetch(`${API_BASE}/api/watchlists`);
  if (!res.ok) throw new Error(`관심그룹 조회 실패: ${res.status}`);
  return res.json();
}

export async function createWatchlist(name: string): Promise<WatchlistGroup> {
  const res = await fetch(`${API_BASE}/api/watchlists`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`관심그룹 생성 실패: ${res.status}`);
  return res.json();
}

export async function deleteWatchlist(watchlistId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/watchlists/${encodeURIComponent(watchlistId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`관심그룹 삭제 실패: ${res.status}`);
}

export async function fetchWatchlistItems(watchlistId: string): Promise<Instrument[]> {
  const res = await fetch(`${API_BASE}/api/watchlists/${encodeURIComponent(watchlistId)}/items`);
  if (!res.ok) throw new Error(`관심그룹 종목 조회 실패: ${res.status}`);
  return res.json();
}

export async function addDefaultWatchlistItem(instrumentId: string): Promise<Instrument> {
  const res = await fetch(`${API_BASE}/api/watchlists/default/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instrumentId }),
  });
  if (!res.ok) throw new Error(`관심종목 추가 실패: ${res.status}`);
  return res.json();
}

export async function addWatchlistItem(watchlistId: string, instrumentId: string): Promise<Instrument> {
  const res = await fetch(`${API_BASE}/api/watchlists/${encodeURIComponent(watchlistId)}/items`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instrumentId }),
  });
  if (!res.ok) throw new Error(`관심그룹 종목 추가 실패: ${res.status}`);
  return res.json();
}

export async function removeDefaultWatchlistItem(instrumentId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/watchlists/default/items/${encodeURIComponent(instrumentId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`관심종목 삭제 실패: ${res.status}`);
}

export async function removeWatchlistItem(watchlistId: string, instrumentId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/watchlists/${encodeURIComponent(watchlistId)}/items/${encodeURIComponent(instrumentId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error(`관심그룹 종목 삭제 실패: ${res.status}`);
}

/* ── 자동매매 ─────────────────────────────────────────────────────────── */

export async function fetchAutoTraderStrategies(): Promise<StrategyListResponse> {
  const res = await fetch(`${API_BASE}/api/broker/kis/auto-trader/strategies`);
  if (!res.ok) throw new Error(`전략 목록 조회 실패: ${res.status}`);
  return res.json();
}

export async function fetchAutoTraderState(accountId: string): Promise<AutoTraderState> {
  const res = await fetch(
    `${API_BASE}/api/broker/kis/auto-trader?accountId=${encodeURIComponent(accountId)}`,
  );
  if (!res.ok) throw new Error(`자동매매 상태 조회 실패: ${res.status}`);
  return res.json();
}

/**
 * 자동매매 시작.
 *
 * 서버가 거절하면 그 이유를 그대로 올린다 — 실주문 모드인데 게이트가 닫혀
 * 있으면 여기서 막힌다. 이유를 삼키면 화면에서 왜 시작이 안 되는지 알 수 없다.
 */
export async function startAutoTrader(config: AutoTraderConfig): Promise<AutoTraderState> {
  const res = await fetch(`${API_BASE}/api/broker/kis/auto-trader/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(config),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message ?? `자동매매 시작 실패: ${res.status}`);
  return body;
}

export async function stopAutoTrader(accountId: string): Promise<AutoTraderState> {
  const res = await fetch(`${API_BASE}/api/broker/kis/auto-trader/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message ?? `자동매매 정지 실패: ${res.status}`);
  return body;
}
