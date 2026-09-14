import { API_BASE } from './config';
import type {
  BrokerAccountRef,
  BrokerAccountSnapshot,
  BrokerOrderRecord,
  BrokerTradeProfitSnapshot,
  LiveOrderGate,
  RiskRuleSet,
  BrokerExecutionSnapshot,
  CandlesResponse,
  ChartTradeMark,
  ExchangeRate,
  FinancialSnapshot,
  Instrument,
  InstrumentCategory,
  MarketMoversSnapshot,
  NewsItem,
  Quote,
  ScreeningResult,
  ThemeList,
  ThemePulseBatch,
  WatchlistGroup,
} from '@invest/shared';

interface RequestOptions {
  init?: RequestInit;
  /** 실패하면 서버가 보낸 `message`를 먼저 쓴다. 없으면 `failure(status)` */
  serverMessage?: boolean;
}

/**
 * fetch → 실패면 던진다. 화면이 부르는 REST는 전부 이 길을 탄다.
 *
 * 실패 문구는 부르는 쪽이 상태 코드로 짓는다(`failure`). 자리마다 문구 형식이
 * 달라(`…: 502` · `… (HTTP 502)` · `… (502)`) 하나로 묶으면 화면 글이 바뀐다.
 * `serverMessage`도 같은 이유로 원래 서버 message를 읽던 자리에서만 켠다.
 */
export async function request(
  path: string,
  failure: (status: number) => string,
  { init, serverMessage = false }: RequestOptions = {},
): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (res.ok) return res;
  const message = serverMessage
    ? ((await res.json().catch(() => ({}))) as { message?: string }).message
    : undefined;
  throw new Error(message ?? failure(res.status));
}

export async function getJson<T>(
  path: string,
  failure: (status: number) => string,
  options?: RequestOptions,
): Promise<T> {
  return (await request(path, failure, options)).json() as Promise<T>;
}

/** JSON 본문을 싣는 요청 */
export function jsonBody(body: unknown, method = 'POST'): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** accountId를 생략하면 서버 기본 계좌를 쓴다. */
function accountQuery(accountId?: string): string {
  return accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
}

/**
 * 그 종목에서 **우리가 실제로 사고판 자리.** 차트에 마커로 찍는다.
 *
 * 접수가 아니라 체결만 온다 — 걸어 두고 안 붙은 주문은 매매가 아니다.
 * 실패해도 차트를 깨뜨리지 않는다(부르는 쪽이 빈 배열로 받는다).
 */
export async function fetchTradeMarks(
  symbol: string,
  accountId?: string,
): Promise<ChartTradeMark[]> {
  const query = new URLSearchParams({ symbol });
  if (accountId) query.set('accountId', accountId);
  const body = await getJson<{ marks?: ChartTradeMark[] }>(
    `/api/trading/trade-marks?${query.toString()}`,
    (status) => `매매 표시 조회 실패: ${status}`,
  );
  return body.marks ?? [];
}

export function fetchKisAccounts(): Promise<BrokerAccountRef[]> {
  return getJson('/api/broker/kis/accounts', (status) => `KIS 계좌 목록 조회 실패: ${status}`);
}

export function fetchKisAccountSnapshot(accountId?: string): Promise<BrokerAccountSnapshot> {
  return getJson(`/api/broker/kis/account${accountQuery(accountId)}`, (status) => `KIS 계좌 조회 실패: ${status}`);
}

export function fetchKisExecutions(days?: number, accountId?: string): Promise<BrokerExecutionSnapshot> {
  const params = new URLSearchParams();
  if (days !== undefined && Number.isFinite(days)) params.set('days', String(days));
  if (accountId) params.set('accountId', accountId);
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return getJson(`/api/broker/kis/executions${suffix}`, (status) => `KIS 체결내역 조회 실패: ${status}`);
}

/**
 * 실계좌 주문 전송 시도 기록. 게이트에 막힌 시도(blocked)도 함께 온다.
 *
 * `hasMore`는 서버 상한을 넘겨 더 오래된 기록이 남아 있다는 뜻이다. 예전에는
 * 배열만 와서, 화면이 `50건`을 보여주면서 그게 전부인지 잘린 것인지 말할
 * 방법이 없었다.
 */
export function fetchKisOrderLog(
  accountId?: string,
): Promise<{ records: BrokerOrderRecord[]; hasMore: boolean }> {
  return getJson(`/api/broker/kis/order-log${accountQuery(accountId)}`, (status) => `실주문 기록 조회 실패: ${status}`);
}

export function fetchKisTradeProfit(accountId?: string, days?: number): Promise<BrokerTradeProfitSnapshot> {
  const params = new URLSearchParams();
  if (accountId) params.set('accountId', accountId);
  if (days !== undefined && Number.isFinite(days)) params.set('days', String(days));
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return getJson(`/api/broker/kis/trade-profit${suffix}`, (status) => `기간별 매매손익 조회 실패: ${status}`);
}

export function fetchKisRiskRules(accountId?: string): Promise<RiskRuleSet> {
  return getJson(`/api/broker/kis/risk-rules${accountQuery(accountId)}`, (status) => `리스크 룰 조회 실패: ${status}`);
}

/** 부분 수정. 서버가 현재 값과 병합한 뒤 유효성을 다시 본다. */
export function updateKisRiskRules(rules: Partial<RiskRuleSet>, accountId?: string): Promise<RiskRuleSet> {
  return getJson(`/api/broker/kis/risk-rules${accountQuery(accountId)}`, (status) => `리스크 룰 저장 실패: ${status}`, {
    init: jsonBody(rules, 'PUT'),
    serverMessage: true,
  });
}

export function fetchKisLiveOrderGate(): Promise<LiveOrderGate> {
  return getJson('/api/broker/kis/live-order-gate', (status) => `실주문 게이트 조회 실패: ${status}`);
}

export function fetchUsdKrwExchangeRate(): Promise<ExchangeRate> {
  return getJson('/api/exchange-rates/usd-krw', (status) => `USD/KRW 환율 조회 실패: ${status}`);
}

export function searchInstruments(query: string): Promise<Instrument[]> {
  const params = new URLSearchParams({ q: query });
  return getJson(`/api/instruments/search?${params.toString()}`, (status) => `종목 검색 실패: ${status}`);
}

export function fetchInstrumentCandles(id: string): Promise<CandlesResponse> {
  return getJson(`/api/instruments/${encodeURIComponent(id)}/candles`, (status) => `종목 차트 조회 실패: ${status}`);
}

/**
 * 마지막으로 훑은 후보 거르기 결과. 아직 안 훑었으면 null이다.
 *
 * 조회만 한다 — 종목 하나에 KIS 시세 1회라 화면을 열 때마다 다시 훑을 수 없다.
 * `null`(안 훑음)과 빈 결과(훑었는데 아무것도 안 남음)는 다른 상태라 화면이
 * 구별해야 한다.
 */
export async function fetchScreening(accountId?: string): Promise<ScreeningResult | null> {
  const body = await getJson<{ result: ScreeningResult | null }>(
    `/api/trading/screening${accountQuery(accountId)}`,
    (status) => `후보 거르기 조회 실패: ${status}`,
    { serverMessage: true },
  );
  return body.result;
}

/**
 * 테마 목록. **시세 조회가 나가지 않는다** (서버가 DB만 본다).
 *
 * 종목을 하나도 못 찾은 테마는 `emptyThemes`로 갈라져 온다. 지워서 오지 않는
 * 이유는 이 목록이 낡았다는 사실 자체이기 때문이다.
 */
export function fetchThemes(): Promise<ThemeList> {
  return getJson('/api/themes', (status) => `테마 목록 조회 실패: ${status}`);
}

/**
 * 테마들의 지금 등락률. **사용자가 누를 때만 부를 것** — 30종목마다 시세 조회
 * 1회가 나간다. 실제로 몇 회가 나갔는지는 응답의 `quoteCalls`에 온다.
 */
export function fetchThemePulses(codes: string[]): Promise<ThemePulseBatch> {
  return getJson(
    `/api/themes/pulse?codes=${encodeURIComponent(codes.join(','))}`,
    (status) => `테마 등락률 조회 실패: ${status}`,
    { serverMessage: true },
  );
}

/** 다시 훑는다. **사용자가 누를 때만 부를 것** — 종목 수만큼 KIS 호출이 나간다. */
export async function runScreening(accountId?: string, lookups?: number): Promise<ScreeningResult> {
  const body = await getJson<{ result: ScreeningResult }>(
    '/api/trading/screening/run',
    (status) => `후보 거르기 실행 실패: ${status}`,
    { init: jsonBody({ accountId, lookups }), serverMessage: true },
  );
  return body.result;
}

/**
 * 거래소가 매긴 등락률 순위 상위 30.
 *
 * `랭킹` 탭의 기존 목록은 관심·최근 종목 안에서만 순위를 매긴다 — 이건 전
 * 종목이 대상이다. 다만 **상위 30만 온다.** 화면이 "시장 전체를 봤다"고
 * 읽히지 않게 몇 개를 받은 값인지 밝혀야 한다.
 */
export function fetchMarketMovers(direction: 'up' | 'down'): Promise<MarketMoversSnapshot> {
  return getJson(`/api/market/movers?direction=${direction}`, (status) => `등락률 순위 조회 실패: ${status}`, {
    serverMessage: true,
  });
}

export function fetchInstrumentQuote(id: string): Promise<Quote> {
  return getJson(`/api/instruments/${encodeURIComponent(id)}/quote`, (status) => `종목 현재가 조회 실패: ${status}`);
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

export function fetchInstrumentIntradayCandles(id: string): Promise<CandlesResponse> {
  return getJson(`/api/instruments/${encodeURIComponent(id)}/intraday-candles`, (status) => `종목 분봉 조회 실패: ${status}`);
}

export function fetchInstrumentNews(id: string): Promise<NewsItem[]> {
  return getJson(`/api/instruments/${encodeURIComponent(id)}/news`, (status) => `종목 뉴스 조회 실패: ${status}`);
}

export function fetchInstrumentQuotes(ids: string[]): Promise<Quote[]> {
  return getJson('/api/instruments/quotes', (status) => `종목 현재가 배치 조회 실패: ${status}`, {
    init: jsonBody({ ids }),
  });
}

export function fetchInstrumentCategories(): Promise<InstrumentCategory[]> {
  return getJson('/api/instruments/categories', (status) => `종목 카테고리 조회 실패: ${status}`);
}

export function fetchCategoryInstruments(id: string, query = ''): Promise<Instrument[]> {
  const params = new URLSearchParams();
  if (query.trim()) params.set('q', query.trim());
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  return getJson(`/api/instruments/categories/${encodeURIComponent(id)}${suffix}`, (status) => `종목 리스트 조회 실패: ${status}`);
}

export function fetchTerminalInstruments(): Promise<Instrument[]> {
  return getJson('/api/instruments/terminal', (status) => `터미널 종목 조회 실패: ${status}`);
}

export function fetchWatchlists(): Promise<WatchlistGroup[]> {
  return getJson('/api/watchlists', (status) => `관심그룹 조회 실패: ${status}`);
}

export function createWatchlist(name: string): Promise<WatchlistGroup> {
  return getJson('/api/watchlists', (status) => `관심그룹 생성 실패: ${status}`, { init: jsonBody({ name }) });
}

export async function deleteWatchlist(watchlistId: string): Promise<void> {
  await request(`/api/watchlists/${encodeURIComponent(watchlistId)}`, (status) => `관심그룹 삭제 실패: ${status}`, {
    init: { method: 'DELETE' },
  });
}

export function fetchWatchlistItems(watchlistId: string): Promise<Instrument[]> {
  return getJson(`/api/watchlists/${encodeURIComponent(watchlistId)}/items`, (status) => `관심그룹 종목 조회 실패: ${status}`);
}

export function addWatchlistItem(watchlistId: string, instrumentId: string): Promise<Instrument> {
  return getJson(`/api/watchlists/${encodeURIComponent(watchlistId)}/items`, (status) => `관심그룹 종목 추가 실패: ${status}`, {
    init: jsonBody({ instrumentId }),
  });
}

export async function removeWatchlistItem(watchlistId: string, instrumentId: string): Promise<void> {
  await request(
    `/api/watchlists/${encodeURIComponent(watchlistId)}/items/${encodeURIComponent(instrumentId)}`,
    (status) => `관심그룹 종목 삭제 실패: ${status}`,
    { init: { method: 'DELETE' } },
  );
}
