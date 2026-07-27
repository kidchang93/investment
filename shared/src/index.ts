/**
 * 백엔드 ↔ 프론트엔드가 공유하는 도메인 타입.
 * KIS 원본 필드명(약어)은 backend/src/kis 레이어에서 이 형태로 정규화한 뒤 노출한다.
 * 프론트엔드는 이 타입만 알면 되고 KIS 원본 스펙에 의존하지 않는다.
 */

/** 감시 종목 */
export interface WatchItem {
  /** 6자리 단축종목코드 (예: '005930') */
  code: string;
  /** 종목명 (예: '삼성전자') */
  name: string;
}

/** 캔들 1개. time은 lightweight-charts용 UTC epoch seconds (일봉은 해당일 UTC 자정). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** 일봉 조회 응답 */
export interface CandlesResponse {
  code: string;
  name: string;
  candles: Candle[];
}

export type InstrumentCountry = 'KR' | 'US' | 'CN' | 'JP' | 'HK' | 'VN' | 'GLOBAL';
export type InstrumentAssetType =
  | 'stock'
  | 'etf'
  | 'etn'
  | 'index'
  | 'future'
  | 'future_spread'
  | 'night_proxy'
  | 'commodity'
  | 'other';

/** 국내/해외 통합 종목 마스터 */
export interface Instrument {
  id: string;
  symbol: string;
  name: string;
  englishName?: string;
  market: string;
  country: InstrumentCountry;
  currency: string;
  assetType: InstrumentAssetType;
  provider: 'kis' | 'tradingview';
  providerSymbol: string;
  exchangeCode: string;
  timezone: string;
}

/** 종목 탐색용 추천 카테고리 */
export interface InstrumentCategory {
  id: string;
  label: string;
  description: string;
}

/** 사용자 관심그룹 */
export interface WatchlistGroup {
  id: string;
  name: string;
  itemCount: number;
}

/** 종목 관련 뉴스 제목 */
export interface NewsItem {
  id: string;
  title: string;
  source: string;
  publishedAt?: number;
  symbol?: string;
}

/** 전일대비 부호: 1(상한) 2(상승) 3(보합) 4(하한) 5(하락) */
export type PriceSign = '1' | '2' | '3' | '4' | '5';

/** 실시간 체결 1건 */
export interface Trade {
  /** 단축종목코드 */
  code: string;
  /** 영업일자 YYYYMMDD */
  date: string;
  /** 체결시각 HHMMSS */
  time: string;
  /** 현재가(체결가) */
  price: number;
  /** 전일대비 부호 */
  sign: PriceSign;
  /** 전일대비 */
  change: number;
  /** 전일대비율(%) */
  changeRate: number;
  /** 당일 시가 */
  open: number;
  /** 당일 고가 */
  high: number;
  /** 당일 저가 */
  low: number;
  /** 체결 거래량 */
  volume: number;
  /** 누적 거래량 */
  accVolume: number;
}

/** 단순 현재가 스냅샷 */
export interface Quote {
  code: string;
  price: number;
  change: number;
  changeRate: number;
  sign: PriceSign;
  open: number;
  high: number;
  low: number;
  accVolume: number;
}

/** 호가 한 단계. 같은 층의 팔자(ask)와 사자(bid)를 마주 놓는다. */
export interface OrderBookLevel {
  /** 1이 최우선호가. 국내주식은 10단계까지 온다 */
  step: number;
  askPrice: number;
  askQuantity: number;
  bidPrice: number;
  bidQuantity: number;
}

/**
 * 예상 체결.
 *
 * 동시호가 구간에는 체결이 일어나지 않고 "이 값에 체결될 것 같다"는 값만 온다.
 *
 * 주의: 정규장이 시작돼도 KIS는 이 값을 **0으로 지우지 않고 개장 동시호가
 * 결과를 그대로 들고 있는다**(2026-07-27 09:00 실측 — 09:00:10에 257,000이던
 * 값이 09:00:50에도 257,000). 그래서 값의 유무로 동시호가인지 판단할 수 없다.
 * `OrderBook.sessionPhase`가 `auction`일 때만 채워 보낸다.
 */
export interface ExpectedConclusion {
  price: number;
  change: number;
  changeRate: number;
  sign: PriceSign;
  /** 지금까지 쌓인 예상 거래량 */
  volume: number;
}

/**
 * 장운영 상태. KIS 장운영 구분 코드를 **실측으로 확인한 값만** 옮긴다.
 *
 * - `auction` — 동시호가. 체결이 아니라 예상 체결가만 나온다
 * - `regular` — 정규장
 * - `unknown` — 확인하지 못한 코드. 이때는 예상 체결을 보내지 않는다
 *
 * 코드표 전체를 확보하지 못해서 모르는 코드를 아는 척하지 않는다. 모르면
 * 예상 체결을 감추는 쪽이 낡은 값을 현재처럼 보여주는 것보다 낫다.
 *
 * **`regular`를 "지금 거래 중"으로 읽지 말 것.** KIS는 마감 뒤에도 정규장과
 * 같은 코드(112)를 돌려준다 — 2026-07-27 15:30:45에 121(마감 동시호가)에서
 * 112로 되돌아갔고 15:33:05까지 그대로였다. 장 마감을 뜻하는 코드가 따로 없다.
 * 장 개폐는 시계(`KRX_SESSION` 09:00~15:30)로 판단하고, 이 값은 **동시호가
 * 구간을 알아내는 데만** 쓴다. 지금은 `auction`일 때 예상 체결을 채우는 데만
 * 쓰이고 있다.
 */
export type MarketSessionPhase = 'auction' | 'regular' | 'unknown';

/** 호가창 한 장. 예상 체결이 있으면 함께 온다. */
export interface OrderBook {
  code: string;
  /** 받아온 시각 (ms). 호가는 금방 낡으므로 화면이 언제 값인지 말해야 한다 */
  fetchedAt: number;
  levels: OrderBookLevel[];
  totalAskQuantity: number;
  totalBidQuantity: number;
  /** 시간외 총 잔량 */
  afterHoursAskQuantity: number;
  afterHoursBidQuantity: number;
  sessionPhase: MarketSessionPhase;
  /** 동시호가 예상 체결. `sessionPhase`가 auction일 때만 채운다 */
  expected: ExpectedConclusion | null;
  /** 변동성완화장치(VI) 발동 중인지 */
  volatilityInterrupted: boolean;
}

/**
 * 재무 지표 한 분기.
 *
 * KIS 재무 API는 값을 안 주는 필드에 **`99.99`를 넣어 보낸다.** 실제 값이
 * 아니다 — 삼성전자(매출 133조)·SK하이닉스(52조)·동화약품(1,306억) 셋 다
 * `depr_cost`·`sell_mang`·`bsop_non_ernn`·`spec_prfi`가 정확히 99.99였다
 * (2026-07-27 실측). 규모가 전혀 다른 회사가 같은 값이면 값이 아니라 표시다.
 * 그대로 읽으면 `감가상각비 99.99억원` 같은 거짓 숫자가 화면에 뜬다.
 * 정규화 단계에서 undefined로 지운다.
 */
export interface FinancialSnapshot {
  /** 결산 연월 YYYYMM */
  period: string;
  /** 자기자본이익률 % */
  roe?: number;
  /** 주당순이익 */
  eps?: number;
  /** 주당순자산 */
  bps?: number;
  /** 부채비율 % */
  debtRatio?: number;
  /** 매출액 증가율 % */
  revenueGrowth?: number;
  /** 순이익률 % */
  netMargin?: number;
  revenue?: number;
  operatingProfit?: number;
  netIncome?: number;
  totalAssets?: number;
  totalLiabilities?: number;
  totalEquity?: number;
}

/**
 * 재무 한 행이 덮는 기간.
 *
 * KIS 재무 API는 분기 단독이 아니라 **연초부터의 누적**으로 준다. 삼성전자
 * 2025년 매출이 79.1조(202503) → 153.7조(202506) → 239.8조(202509) →
 * 333.6조(202512)로 오르다 202603에 133.9조로 떨어지는데, 회사가 3분의 1로
 * 줄어든 게 아니라 창이 1년에서 3개월로 바뀐 것이다(2026-07-27 실측).
 *
 * 창을 안 밝히고 세로로 늘어놓으면 매년 1월에 망하는 회사처럼 보인다.
 * 비율(ROE·순이익률·매출성장률)은 같은 창끼리 계산돼 있어 그대로 읽어도 되지만
 * 금액은 반드시 창과 함께 읽어야 한다.
 *
 * **결산월이 곧 누적 개월 수라는 건 12월 결산을 전제로 한 읽기다.** 3월 결산
 * 회사라면 202603이 1분기가 아니라 1년치일 수 있다. 그래서 이 함수는 창을
 * 단정하지 않고, 실제 값으로 확인하는 일은 `detectCumulativeReporting`에 맡긴다.
 */
export interface FinancialPeriodWindow {
  year: number;
  /** 결산월 (1~12) */
  month: number;
  /** 12월 결산으로 읽었을 때의 누적 개월 수. 3·6·9·12월이 아니면 undefined */
  months?: number;
  /** `2026년 1~3월 누적` */
  label: string;
  /** 표에 짧게 쓸 값. `3개월` / `1년` */
  shortLabel: string;
}

export function financialPeriodWindow(period: string): FinancialPeriodWindow | undefined {
  if (!/^\d{6}$/.test(period)) return undefined;
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(4, 6));
  if (month < 1 || month > 12) return undefined;
  /*
   * 3·6·9·12월만 누적 개월 수가 자명하다. 그 밖의 결산월은 세지 않는다 —
   * 모르는 것을 아는 척하면 화면이 틀린 창을 적는다.
   */
  const months = month % 3 === 0 ? month : undefined;
  return {
    year,
    month,
    months,
    label: months === undefined ? `${year}년 ${month}월 결산` : `${year}년 1~${month}월 누적`,
    shortLabel: months === undefined ? `${month}월` : months === 12 ? '1년' : `${months}개월`,
  };
}

/**
 * 이 회사의 재무가 정말 누적으로 오는지 **값으로 확인한다.**
 *
 * 12월 결산이라고 가정하고 창을 적는 대신, 같은 해 안에서 결산월이 뒤로
 * 갈수록 매출이 커지는지를 본다. 커지면 누적이고, 작아지면 분기 단독이다.
 * 한 해에 두 행이 없으면 판단하지 않는다 — 모르는 것을 단정하지 않는다.
 */
export type FinancialReportingBasis = 'cumulative' | 'standalone' | 'unknown';

export function detectCumulativeReporting(rows: FinancialSnapshot[]): FinancialReportingBasis {
  const byYear = new Map<number, Array<{ month: number; revenue: number }>>();
  for (const row of rows) {
    const window = financialPeriodWindow(row.period);
    if (!window || row.revenue === undefined) continue;
    const list = byYear.get(window.year) ?? [];
    list.push({ month: window.month, revenue: row.revenue });
    byYear.set(window.year, list);
  }

  let compared = 0;
  for (const list of byYear.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.month - b.month);
    for (let i = 1; i < sorted.length; i += 1) {
      compared += 1;
      // 한 쌍이라도 뒤 분기가 더 작으면 누적이 아니다.
      if (sorted[i].revenue < sorted[i - 1].revenue) return 'standalone';
    }
  }
  return compared > 0 ? 'cumulative' : 'unknown';
}

/**
 * 신호 채점 누적 성적.
 *
 * 백테스트는 과거를 말한다. 이 값은 **실제로 낸 신호**가 어땠는지를 말한다.
 * 왕복 비용을 뺀 뒤에 승패를 센다 — 빼지 않으면 이겼다고 착각한다.
 */
export interface SignalScoreSummary {
  /** 며칠 뒤로 쟀는지 (거래일) */
  horizonDays: number;
  count: number;
  winCount: number;
  winRate: number;
  avgNetReturn: number;
  medianNetReturn: number;
}

/** 환율 스냅샷 */
export interface ExchangeRate {
  pair: 'USD/KRW';
  baseCurrency: 'USD';
  quoteCurrency: 'KRW';
  rate: number;
  change: number;
  changeRate: number;
  fetchedAt: number;
}

/** `accepted` 주문·정정·취소·거부 접수 통보 | `filled` 체결 통보 */
export type OrderNoticeKind = 'accepted' | 'filled';

/**
 * 실시간 주문·체결 통보 1건 (H0STCNI0 정규화).
 *
 * 원본 프레임에는 고객ID와 계좌번호가 들어 있다. **둘 다 프런트로 내보내지 않는다.**
 * 계좌는 서버가 화면용 `accountId`로 바꿔서만 알려준다.
 */
export interface OrderNotice {
  kind: OrderNoticeKind;
  /** 화면용 계좌 id. 매칭되는 계좌가 없으면 빈 문자열 */
  accountId: string;
  orderNo: string;
  originalOrderNo?: string;
  /** 지점번호. 정정·취소 전송에 필요하다 */
  branchNo: string;
  symbol: string;
  name: string;
  side: OrderSide;
  /** 접수 통보면 주문수량, 체결 통보면 체결수량 */
  quantity: number;
  /** 접수 통보면 주문단가, 체결 통보면 체결단가 */
  price: number;
  orderQuantity: number;
  /** 체결시각 HHMMSS */
  time: string;
  /** 거부 통보 여부 */
  rejected: boolean;
  receivedAt: number;
}

/** 백엔드 → 프론트 WebSocket 스트림 메시지 (판별 유니언) */
export type ServerMessage =
  | { type: 'trade'; data: Trade }
  | { type: 'orderNotice'; data: OrderNotice }
  | { type: 'status'; data: ConnectionStatus };

export interface ClientSubscribeInstrument {
  code: string;
  market: string;
  assetType: InstrumentAssetType;
}

/** 프론트 → 백엔드 WebSocket 제어 메시지 */
export type ClientMessage = { type: 'subscribe'; codes?: string[]; instruments?: ClientSubscribeInstrument[] };

/** KIS 실시간 연결 상태 */
export interface ConnectionStatus {
  kisConnected: boolean;
  message?: string;
}

export type TradingMode = 'paper' | 'live_disabled' | 'live';
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';
export type OrderTimeInForce = 'day' | 'ioc';
export type OrderStatus = 'blocked' | 'accepted' | 'submitted' | 'filled' | 'canceled' | 'rejected';

/** 매매 계정. 실계좌 정보는 프론트로 노출하지 않고 화면용 별칭과 모드만 제공한다. */
export interface TradingAccount {
  id: string;
  label: string;
  broker: 'paper' | 'kis';
  mode: TradingMode;
  baseCurrency: string;
  cashBalance: number;
  buyingPower: number;
  maxOrderNotional: number;
  liveEnabled: boolean;
}

/** 보유 포지션 스냅샷 */
export interface Position {
  id: string;
  accountId: string;
  instrument: Instrument;
  quantity: number;
  averagePrice: number;
  currency: string;
  marketValue?: number;
  unrealizedPnl?: number;
  unrealizedPnlRate?: number;
}

/** 서버에 저장된 주문 의도. 브로커 전송 전후 모두 같은 감사 단위로 관리한다. */
export interface OrderIntent {
  id: string;
  accountId: string;
  instrument: Instrument;
  side: OrderSide;
  orderType: OrderType;
  timeInForce: OrderTimeInForce;
  quantity: number;
  limitPrice?: number;
  estimatedPrice: number;
  estimatedNotional: number;
  currency: string;
  status: OrderStatus;
  riskMessages: string[];
  createdAt: number;
}

/** paper/live 공통 체결 기록 */
export interface TradingFill {
  id: string;
  orderId: string;
  accountId: string;
  instrument: Instrument;
  side: OrderSide;
  quantity: number;
  price: number;
  notional: number;
  currency: string;
  createdAt: number;
}

/** 현금 증감 원장 */
export interface CashLedgerEntry {
  id: string;
  accountId: string;
  orderId?: string;
  amount: number;
  balanceAfter: number;
  currency: string;
  reason: 'paper_buy' | 'paper_sell' | 'adjustment';
  createdAt: number;
}

export interface TradingOverview {
  accounts: TradingAccount[];
  positions: Position[];
  recentOrders: OrderIntent[];
  recentFills: TradingFill[];
}

/**
 * 조회 가능한 KIS 계좌 하나. KIS는 앱키에 등록된 계좌만 허용하므로
 * 서버가 자격증명과 짝지어 둔 계좌 목록만 프런트에 내려준다.
 */
export interface BrokerAccountRef {
  id: string;
  label: string;
  /** 기본 계좌 여부. 시세·실시간 호출도 이 계좌의 자격증명을 쓴다. */
  primary: boolean;
}

/** KIS 실계좌 조회 상태. 계좌번호 원문은 서버 밖으로 내보내지 않는다. */
export interface BrokerAccountSnapshot {
  broker: 'kis';
  configured: boolean;
  /** 어느 계좌의 스냅샷인지. 미설정이면 빈 문자열 */
  accountId: string;
  accountLabel: string;
  baseCurrency: string;
  cashBalance?: number;
  totalEvaluation?: number;
  stockEvaluation?: number;
  purchaseAmount?: number;
  unrealizedPnl?: number;
  unrealizedPnlRate?: number;
  positions: BrokerPosition[];
  updatedAt?: number;
  message?: string;
}

/**
 * KIS 실계좌 매수가능 조회 결과. 종목·단가 기준으로 서버가 산출하며
 * 계좌번호는 여기에도 담기지 않는다.
 */
export interface BrokerOrderability {
  broker: 'kis';
  configured: boolean;
  /** 어느 계좌 기준인지. 미설정이면 빈 문자열 */
  accountId: string;
  symbol: string;
  currency: string;
  orderType: OrderType;
  /** 조회에 사용한 주문 단가. 시장가 조회는 0 */
  requestedPrice: number;
  /** 주문가능현금 */
  cashAvailable?: number;
  /** 재사용가능금액 */
  reusableAmount?: number;
  /** 미수 없는 매수금액 */
  cashBuyAmount?: number;
  /** 미수 없는 매수수량 */
  cashBuyQuantity?: number;
  /** 최대 매수금액 (미수 포함) */
  maxBuyAmount?: number;
  /** 최대 매수수량 (미수 포함) */
  maxBuyQuantity?: number;
  /** 브로커가 가능수량 계산에 사용한 단가 */
  calculatedUnitPrice?: number;
  fetchedAt?: number;
  message?: string;
}

/** KIS 실계좌 보유 종목. 원본 KIS 필드는 backend/src/kis에서만 해석한다. */
export interface BrokerPosition {
  symbol: string;
  name: string;
  quantity: number;
  averagePrice: number;
  currentPrice?: number;
  purchaseAmount?: number;
  marketValue?: number;
  unrealizedPnl?: number;
  unrealizedPnlRate?: number;
  currency: string;
}

/** KIS 실계좌 주문 1건의 체결 진행 상태 */
export type BrokerExecutionStatus = 'filled' | 'partial' | 'open' | 'canceled' | 'rejected';

/**
 * KIS 실계좌 주문·체결 1건. 감사 기록이므로 미체결·취소·거부도 버리지 않고 함께 담는다.
 * 원본 KIS 필드는 backend/src/kis에서만 해석한다.
 */
export interface BrokerExecution {
  id: string;
  /** 브로커 주문번호 */
  orderNo: string;
  /** 정정·취소 주문이면 원주문번호 */
  originalOrderNo?: string;
  /** 주문일자 YYYYMMDD */
  orderDate: string;
  /** 주문시각 HHMMSS */
  orderTime?: string;
  symbol: string;
  name: string;
  side: OrderSide;
  /** 브로커가 내려주는 주문구분 명칭 (지정가/시장가 등) */
  orderTypeLabel: string;
  orderQuantity: number;
  orderPrice: number;
  filledQuantity: number;
  filledAmount: number;
  averageFilledPrice: number;
  remainQuantity: number;
  rejectedQuantity: number;
  status: BrokerExecutionStatus;
  currency: string;
}

/** KIS 실계좌 체결 내역 스냅샷. 계좌번호 원문은 서버 밖으로 내보내지 않는다. */
export interface BrokerExecutionSnapshot {
  broker: 'kis';
  configured: boolean;
  /** 어느 계좌의 기록인지. 미설정이면 빈 문자열 */
  accountId: string;
  accountLabel: string;
  /** 조회 시작일 YYYYMMDD */
  from: string;
  /** 조회 종료일 YYYYMMDD */
  to: string;
  executions: BrokerExecution[];
  totalOrderQuantity?: number;
  totalFilledQuantity?: number;
  totalFilledAmount?: number;
  updatedAt?: number;
  message?: string;
}

/** 기간별 매매손익 1건. 매도 체결 기준으로 실현손익이 확정된 건이다. */
export interface BrokerTradeProfitRow {
  id: string;
  /** 매매일자 YYYYMMDD */
  tradeDate: string;
  symbol: string;
  name: string;
  /** 매매구분 명칭 (현금매도 등) */
  tradeTypeLabel: string;
  sellQuantity: number;
  sellPrice: number;
  sellAmount: number;
  buyQuantity: number;
  /** 매입단가 */
  buyPrice: number;
  buyAmount: number;
  /** 실현손익 (수수료·세금 반영) */
  realizedProfit: number;
  /** 손익률(%) */
  profitRate: number;
  fee: number;
  tax: number;
  loanInterest: number;
  currency: string;
}

/** 기간별 매매손익 스냅샷. 합계는 브로커가 계산해 준 값을 그대로 쓴다. */
export interface BrokerTradeProfitSnapshot {
  broker: 'kis';
  configured: boolean;
  accountId: string;
  /** 조회 시작일 YYYYMMDD */
  from: string;
  /** 조회 종료일 YYYYMMDD */
  to: string;
  rows: BrokerTradeProfitRow[];
  totalRealizedProfit?: number;
  /** 총 손익률(%) */
  totalProfitRate?: number;
  totalFee?: number;
  totalTax?: number;
  totalTradeAmount?: number;
  updatedAt?: number;
  message?: string;
}

/**
 * KIS 매도가능수량 조회 결과.
 * 이 응답에는 종목명이 없다(상품번호만 온다). 이름은 화면이 이미 아는 `Instrument`를 쓴다.
 */
export interface BrokerSellability {
  broker: 'kis';
  configured: boolean;
  accountId: string;
  symbol: string;
  currency: string;
  /** 매도가능수량 */
  sellableQuantity?: number;
  /** 잔고수량 */
  holdingQuantity?: number;
  /** 미수 수량. 결제 전이라 매도가 막힐 수 있는 양 */
  unsettledQuantity?: number;
  /** 현재가 */
  price?: number;
  /** 매입평균가 */
  averagePrice?: number;
  fetchedAt?: number;
  message?: string;
}

/** 정정·취소가 가능한 미체결 주문 1건 */
export interface BrokerAmendableOrder {
  id: string;
  orderNo: string;
  originalOrderNo?: string;
  /** 정정취소 전송 시 필요한 주문채번지점번호 */
  orderBranchNo: string;
  symbol: string;
  name: string;
  side: OrderSide;
  orderTypeLabel: string;
  /** KIS 주문구분 코드. 정정 전송 시 그대로 되돌려준다. */
  orderTypeCode: string;
  orderQuantity: number;
  orderPrice: number;
  filledQuantity: number;
  /**
   * 정정·취소 대상 수량(KIS `psbl_qty`).
   * 이 응답에는 잔여수량 필드가 따로 없어 이 값이 사실상 잔량이다.
   */
  amendableQuantity: number;
  orderTime?: string;
  currency: string;
}

/**
 * 예약주문 1건.
 * 정정·취소 전송에 필요한 예약주문 지점번호(`RSVN_ORD_ORGNO`)는 이 조회 응답에 없다.
 * 예약주문 정정·취소를 구현할 때 별도 경로로 확보해야 한다.
 */
export interface BrokerReservedOrder {
  id: string;
  /** 예약주문순번. 정정·취소 전송 시 필요 */
  reservationSeq: string;
  /** 예약주문 주문일자 YYYYMMDD */
  orderDate: string;
  /** 예약 종료일자 YYYYMMDD */
  endDate?: string;
  symbol: string;
  name: string;
  side: OrderSide;
  orderQuantity: number;
  orderPrice: number;
  filledQuantity: number;
  /** 처리 결과 표시용 문자열 */
  statusLabel: string;
  canceled: boolean;
  currency: string;
}

/** 실주문 전송 가능 여부. 게이트가 왜 닫혀 있는지 프런트가 그대로 보여줄 수 있게 이유를 담는다. */
export interface LiveOrderGate {
  /** 전송 가능 여부 (모든 조건 통과) */
  enabled: boolean;
  /** `prod` 환경인지 */
  isProdEnv: boolean;
  /** 서버 환경 변수로 실주문을 허용했는지 */
  serverEnabled: boolean;
  /** 닫혀 있는 이유. enabled=true면 빈 배열 */
  blockers: string[];
}

/** 실주문 전송 요청. paper 주문(`CreateOrderRequest`)과 의도적으로 분리한다. */
export interface PlaceLiveOrderRequest {
  accountId: string;
  /*
   * 멱등성 키. 같은 값으로 다시 보내면 새 주문을 내지 않고 앞선 결과를 돌려준다.
   * 네트워크가 끊겨 재시도할 때 같은 주문이 두 번 나가는 것을 막는다.
   * 생략하면 매 요청이 별개 주문이 된다.
   */
  clientOrderId?: string;
  instrumentId: string;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;
  /** 지정가일 때 필수 */
  limitPrice?: number;
  /** 사용자 2단계 확인. 서버가 값 자체를 검증한다. */
}

/** 실주문 전송 결과 */
export interface PlaceLiveOrderResult {
  accepted: boolean;
  accountId: string;
  symbol: string;
  side: OrderSide;
  quantity: number;
  /** 브로커가 부여한 주문번호 */
  orderNo?: string;
  /** 주문채번지점번호. 정정·취소에 필요 */
  orderBranchNo?: string;
  /** 브로커 접수 시각 HHMMSS */
  acceptedAt?: string;
  message: string;
}

/** 정정·취소 전송 요청 */
export interface AmendLiveOrderRequest {
  accountId: string;
  /** 'amend' 정정 | 'cancel' 취소 */
  action: 'amend' | 'cancel';
  orderNo: string;
  orderBranchNo: string;
  /** KIS 주문구분 코드. 정정취소가능주문조회 결과를 그대로 넘긴다. */
  orderTypeCode: string;
  /** 정정 시 새 수량. 전량이면 quantityAll=true로 두고 생략 가능 */
  quantity?: number;
  /** 정정 시 새 단가. 취소는 무시된다 */
  limitPrice?: number;
  quantityAll: boolean;
}

/**
 * 계좌별 실주문 리스크 룰.
 * 게이트가 "실주문을 켰는가"라면, 이쪽은 "이 주문을 내도 되는가"를 본다.
 */
export interface RiskRuleSet {
  accountId: string;
  /** false면 이 계좌의 실주문을 전부 막는다 */
  enabled: boolean;
  /** 1회 주문 금액 한도 */
  maxOrderNotional: number;
  /** 1회 주문 수량 한도 */
  maxOrderQuantity: number;
  /** 일일 누적 주문 금액 한도 */
  dailyNotionalLimit: number;
  /** 일일 주문 건수 한도 */
  dailyOrderCountLimit: number;
  /** 시장가 주문 허용 여부 */
  allowMarketOrder: boolean;
  /** 주문 허용 시작 시각 'HH:MM' (KST) */
  sessionStart: string;
  /** 주문 허용 종료 시각 'HH:MM' (KST) */
  sessionEnd: string;
  /** 비어 있지 않으면 이 목록의 종목만 주문할 수 있다 */
  symbolAllowlist: string[];
  /** 항상 차단할 종목 */
  symbolBlocklist: string[];
}

/** 주문 1건에 대한 리스크 판정 결과 */
export interface RiskVerdict {
  allowed: boolean;
  /** 위반 사유 전부. 하나씩 알려주면 고칠 때마다 새 사유를 만난다 */
  violations: string[];
  rules: RiskRuleSet;
  /** 오늘(KST) 접수된 주문 건수 */
  todayOrderCount?: number;
  /** 오늘(KST) 접수된 주문 금액 합 */
  todayNotional?: number;
}

export type BrokerOrderAction = 'place' | 'amend' | 'cancel';
/** `blocked` 게이트·검증에 막힘 | `submitted` 브로커 접수됨 | `rejected` 브로커가 거부 */
export type BrokerOrderRecordStatus = 'blocked' | 'submitted' | 'rejected';

/**
 * 실계좌 주문 전송 시도 1건의 감사 기록.
 * 보내지 못한 시도(`blocked`)도 같은 목록에 남는다. 계좌번호는 담기지 않는다.
 */
export interface BrokerOrderRecord {
  id: string;
  broker: 'kis';
  accountId: string;
  action: BrokerOrderAction;
  status: BrokerOrderRecordStatus;
  side?: OrderSide;
  symbol?: string;
  /** 사용자가 보낸 종목 id 원문. 게이트에 먼저 막혀 종목을 확인하기 전이어도 남는다 */
  requestedInstrumentId?: string;
  orderType?: OrderType;
  quantity?: number;
  limitPrice?: number;
  orderNo?: string;
  orderBranchNo?: string;
  /** 정정·취소 대상 원주문번호 */
  originalOrderNo?: string;
  message: string;
  /** `blocked`일 때 막힌 이유 */
  blockers: string[];
  createdAt: number;
}

/** 예약주문 등록 요청. 지정가만 지원한다. */
export interface PlaceReservedOrderRequest {
  accountId: string;
  instrumentId: string;
  side: OrderSide;
  quantity: number;
  limitPrice: number;
  /** 예약 종료일자 YYYYMMDD. 생략하면 익영업일 1회 */
  endDate?: string;
}

/**
 * 예약주문 취소 요청.
 * `reservationOrgNo`는 KIS가 필수로 요구하지만 등록·조회 응답 어디에도 없다.
 * 비워서 보내고, 실패하면 KIS 앱에서 직접 취소해야 한다.
 */
export interface CancelReservedOrderRequest {
  accountId: string;
  reservationSeq: string;
  /** 예약주문 주문일자 YYYYMMDD */
  reservationOrderDate: string;
  reservationOrgNo?: string;
}

export interface CreateOrderRequest {
  accountId: string;
  instrumentId: string;
  side: OrderSide;
  orderType: OrderType;
  timeInForce: OrderTimeInForce;
  quantity: number;
  limitPrice?: number;
  estimatedPrice: number;
  userAcknowledged: boolean;
}

export interface CreateOrderResponse {
  order: OrderIntent;
  fill?: TradingFill;
}

/* ── 자동매매 ─────────────────────────────────────────────────────────── */

/** 자동매매 실행 모드. `dry_run`은 주문을 만들되 KIS로 보내지 않는다. */
export type AutoTraderMode = 'dry_run' | 'live';

/** 자동매매 상태. `stopped` 외에는 러너가 살아 있다. */
export type AutoTraderStatus =
  | 'stopped'
  | 'running'
  | 'target_reached'
  | 'stopped_out'
  | 'error';

/** 전략이 내는 신호. 종목까지 전략이 고른다. */
export interface StrategySignal {
  instrumentId: string;
  side: OrderSide;
  /** 왜 이 신호가 나왔는지. 실행 기록에 그대로 남는다. */
  reason: string;
}

export interface AutoTraderConfig {
  accountId: string;
  mode: AutoTraderMode;
  /** 전략 키. 지금은 'ma_cross' 하나 */
  strategy: string;
  /** 목표 평가금액. 도달하면 정지한다 */
  targetEquity: number;
  /** 이 금액 아래로 내려가면 정지한다 */
  stopEquity: number;
  /** 러너를 깨우는 주기(초) */
  intervalSeconds: number;
  /** 한 번에 들고 갈 종목 수 */
  maxPositions: number;
}

/** 러너가 한 번 돌 때마다 남기는 기록. 왜 샀고 왜 안 샀는지가 다 남는다. */
export interface AutoTraderRun {
  id: number;
  createdAt: number;
  status: AutoTraderStatus;
  /** 이번 회차에 무엇을 했는지 한 줄 */
  message: string;
  /** 주문을 냈다면 그 내용 */
  instrumentId?: string;
  side?: OrderSide;
  quantity?: number;
  price?: number;
  /** 이번 회차 시점의 평가금액 */
  equity?: number;
}

export interface AutoTraderState {
  config: AutoTraderConfig;
  status: AutoTraderStatus;
  /** 시작 시점 평가금액. 수익률 계산 기준 */
  startEquity?: number;
  /** 마지막으로 확인한 평가금액 */
  currentEquity?: number;
  startedAt?: number;
  stoppedAt?: number;
  /** 정지했다면 그 이유 */
  stopReason?: string;
  recentRuns: AutoTraderRun[];
  /** 서버 상한을 넘겨 더 오래된 기록이 남아 있는지. 화면이 "이게 전부"라고 말하지 않게 한다. */
  recentRunsHasMore: boolean;
}

/**
 * 국내 주식 매도에 붙는 세금 비율. **확인된 값이 아니다.**
 *
 * 백테스트는 0.0018, 수수료 계산기는 0.002를 쓰고 있었다 — 같은 세금인데 두
 * 숫자가 앱 안에 따로 있었고 둘 다 출처가 없었다. 어느 쪽이 맞는지 여기서는
 * 확인할 수 없어, 값을 정하는 대신 한 곳으로 모았다. 실제 세율은 법으로
 * 정해지고 바뀌므로, 쓰기 전에 확인해서 이 값을 고치면 두 곳이 함께 따라온다.
 *
 * 지금 값은 백테스트가 쓰던 쪽이다(이미 기록해 둔 백테스트 숫자와 맞추려고).
 */
export const KR_SELL_TAX_RATE_ASSUMPTION = 0.0018;

/** 코넥스는 위와 다른 비율을 쓰고 있었다. 이것도 확인된 값이 아니다. */
export const KR_KONEX_SELL_TAX_RATE_ASSUMPTION = 0.001;
