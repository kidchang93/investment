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

/** 백엔드 → 프론트 WebSocket 스트림 메시지 (판별 유니언) */
export type ServerMessage =
  | { type: 'trade'; data: Trade }
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

/** KIS 실계좌 조회 상태. 계좌번호 원문은 서버 밖으로 내보내지 않는다. */
export interface BrokerAccountSnapshot {
  broker: 'kis';
  configured: boolean;
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
