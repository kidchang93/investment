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

/** KIS 매도가능수량 조회 결과 */
export interface BrokerSellability {
  broker: 'kis';
  configured: boolean;
  accountId: string;
  symbol: string;
  name: string;
  currency: string;
  /** 매도가능수량 */
  sellableQuantity?: number;
  /** 보유수량 */
  holdingQuantity?: number;
  /** 매도 기준 단가(현재가) */
  price?: number;
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
  remainQuantity: number;
  /** 정정 가능 수량 */
  amendableQuantity: number;
  /** 취소 가능 수량 */
  cancelableQuantity: number;
  orderTime?: string;
  currency: string;
}

/** 예약주문 1건 */
export interface BrokerReservedOrder {
  id: string;
  /** 예약주문순번. 정정·취소 전송 시 필요 */
  reservationSeq: string;
  /** 예약주문 접수 지점번호 */
  reservationBranchNo: string;
  /** 예약주문 주문일자 YYYYMMDD */
  orderDate: string;
  symbol: string;
  name: string;
  side: OrderSide;
  orderQuantity: number;
  orderPrice: number;
  /** 처리 상태 표시용 문자열 */
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
  instrumentId: string;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;
  /** 지정가일 때 필수 */
  limitPrice?: number;
  /** 사용자 2단계 확인. 서버가 값 자체를 검증한다. */
  confirmationPhrase: string;
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
  confirmationPhrase: string;
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
