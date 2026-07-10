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

/** 실시간 체결 1건 (KIS H0STCNT0을 정규화) */
export interface Trade {
  /** 단축종목코드 */
  code: string;
  /** 영업일자 YYYYMMDD */
  date: string;
  /** 체결시각 HHMMSS */
  time: string;
  /** 현재가(체결가) */
  price: number;
  /** 전일대비 부호: 1(상한) 2(상승) 3(보합) 4(하한) 5(하락) */
  sign: string;
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

/** 단순 현재가 스냅샷 (REST inquire-price) */
export interface Quote {
  code: string;
  price: number;
  change: number;
  changeRate: number;
  sign: string;
  open: number;
  high: number;
  low: number;
  accVolume: number;
}

/** 백엔드 → 프론트 WebSocket 스트림 메시지 (판별 유니언) */
export type ServerMessage =
  | { type: 'trade'; data: Trade }
  | { type: 'status'; data: ConnectionStatus };

/** KIS 실시간 연결 상태 */
export interface ConnectionStatus {
  kisConnected: boolean;
  message?: string;
}
