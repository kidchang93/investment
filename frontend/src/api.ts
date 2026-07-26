import { API_BASE } from './config';
import type {
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
  Instrument,
  InstrumentCategory,
  NewsItem,
  OrderType,
  Quote,
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

/** 실계좌 주문 전송 시도 기록. 게이트에 막힌 시도(blocked)도 함께 온다. */
export async function fetchKisOrderLog(accountId?: string): Promise<BrokerOrderRecord[]> {
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

export async function fetchInstrumentQuote(id: string): Promise<Quote> {
  const res = await fetch(`${API_BASE}/api/instruments/${encodeURIComponent(id)}/quote`);
  if (!res.ok) throw new Error(`종목 현재가 조회 실패: ${res.status}`);
  return res.json();
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
