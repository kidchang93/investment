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
  /**
   * 그 봉의 거래대금(원). **`undefined`와 0은 다른 사실이다** — 값이 안 온 것과
   * 한 주도 안 거래된 것을 섞지 않으려고 옵셔널로 둔다(`toNumberOrNaN` 참고).
   *
   * 일봉에만 온다(`acml_tr_pbmn`). 분봉 응답에는 이 값이 없어 늘 `undefined`다.
   * 유동성 문턱(`illiquid`)이 보는 축이라 일봉 저장소가 이 값을 함께 담는다.
   */
  turnover?: number;
}

/**
 * 봉의 시간 축. **잰 값에는 이것이 반드시 함께 다닌다.**
 *
 * 같은 전략·같은 종목이라도 축이 다르면 판정이 뒤집힌다 — 2026-07-31 측정에서
 * 평균 회귀 승률이 일봉 68.5%, 1분봉 19.6%였다. 왕복 비용(0.43%)은 축과 무관하게
 * 똑같이 나가는데 분봉의 값 변화 폭이 훨씬 작아서다(1봉 |Δ| 중앙값 일봉 1.005%,
 * 분봉 0.105%). 축이 글 속에만 있으면 화면은 "이 판정이 러너를 설명하는가"를
 * 말할 수 없다.
 */
export type CandleAxis = 'daily' | 'minute';

/** 화면에 적는 축 이름. 내부 식별자를 그대로 찍지 않는다. */
export const CANDLE_AXIS_LABELS: Record<CandleAxis, string> = {
  daily: '일봉',
  minute: '1분봉',
};

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

/**
 * 지수업종 분류 한 단계.
 *
 * 코드는 시장마다 다른 체계다 — 같은 `제조`가 KOSPI에서는 `0027`, KOSDAQ에서는 `1009`다.
 * 그래서 시장을 넘어 묶을 때는 `name`을, 지수 시세를 조회할 때는 `code`를 쓴다.
 */
export interface InstrumentSector {
  /** 지수업종 코드 4자리 */
  code: string;
  /** 지수업종 이름 */
  name: string;
}

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
  /**
   * 지수업종 대분류. 없을 수 있다 — ETF·ETN·해외·KONEX에는 분류가 붙지 않는다.
   * **분류가 없는 것이지 0이 아니다.** 값이 없으면 필드 자체가 없다.
   */
  sectorLarge?: InstrumentSector;
  /** 지수업종 중분류. 대분류만 있고 중분류가 없는 종목이 있다 (KOSPI 금융·유통 등). */
  sectorMid?: InstrumentSector;
}

/**
 * KIS 테마 분류 하나.
 *
 * 지수업종(`InstrumentSector`)과 다른 축이다. 업종에는 `반도체`라는 칸이 아예 없어
 * 삼성전자와 에코프로비엠이 같은 `제조 / 전기·전자`에, 한화에어로스페이스와 한화오션이
 * 같은 `제조 / 운송장비·부품`에 들어간다. 테마는 그 둘을 가른다.
 *
 * **테마는 종목당 여러 개다** — 삼성전자는 16개(HBM·CXL·온디바이스AI·3D낸드·폴더블폰…),
 * 2026-07 실측 평균 2.37개다. 그래서 종목의 속성이 아니라 별도의 N:M 관계다.
 *
 * `sourceDate`·`instrumentCount`가 필드에 있는 이유: 이 목록은 **낡는다.** 마스터
 * 파일은 매일 재포장되지만 내용은 갱신되지 않아, 2026-07-31 실측 시점의 파일이
 * 2025-11-06자였다(`2025 신규 상장주` 테마가 없고 `2024`까지만 있다). 화면이 "지금
 * 반도체 테마"라고 말하면서 9개월 전 목록을 보여주면 거짓말이 되므로, 기준일과
 * "몇 개를 실제로 찾았는지"를 목록과 함께 들고 다닌다.
 */
export interface Theme {
  /** 테마코드 3자리 (`004` 반도체/반도체장비) */
  code: string;
  /** 테마 이름 */
  name: string;
  /**
   * 이 목록의 기준일 (ISO 8601). 마스터 파일이 만들어진 시각이고, 우리가 받아온
   * 시각이 아니다. **오늘 받아도 내용은 이 날짜의 것이다.**
   */
  sourceDate: string;
  /** 마스터가 이 테마에 넣어 둔 종목 수 */
  symbolCount: number;
  /**
   * 그중 지금 종목 마스터에서 찾은 수. `symbolCount`보다 적으면 그 사이에
   * 상장폐지·코드변경이 있었다는 뜻이다. **둘을 하나로 합치지 않는다.**
   */
  instrumentCount: number;
}

/** 테마 하나에 속한 종목들 */
export interface ThemeMembers {
  theme: Theme;
  /** 지금 종목 마스터에서 찾은 종목 */
  instruments: Instrument[];
  /**
   * 마스터에는 있는데 지금 종목 마스터에서 못 찾은 종목코드.
   * 조용히 버리지 않는다 — 이 목록이 낡았다는 증거 자체다.
   */
  missingSymbols: string[];
}

/**
 * 테마 목록 한 벌.
 *
 * **종목을 하나도 못 찾은 테마를 목록에서 지우지 않는다.** 2026-07-31 실측으로
 * 302개 중 셋(`062 와이브로` · `260 2차전지` · `321 건설사(대형)`)이 그렇다.
 * 지우면 "이 목록이 낡았다"는 사실까지 함께 사라지고, 남겨서 섞어 두면
 * `2차전지`(빈 것)와 `2차전지(소재,부품,장비)`(에코프로비엠이 든 진짜)가 나란히
 * 떠서 어느 쪽이 진짜인지 알 수 없다. 그래서 **가르되 버리지 않는다.**
 */
export interface ThemeList {
  /**
   * 이 목록에서 **가장 낡은** 기준일 (ISO 8601). 302개가 한 파일에서 오므로
   * 실제로는 전부 같다. 그래도 최솟값을 적는 이유는, 언젠가 갈렸을 때
   * 낡은 쪽이 "지금 것"으로 보이지 않게 하기 위해서다. 테마가 없으면 `null`.
   */
  sourceDate: string | null;
  /** 지금 종목을 하나 이상 찾은 테마. 등락률을 잴 수 있는 것들 */
  themes: Theme[];
  /** 마스터에는 있는데 지금 종목을 하나도 못 찾은 테마. 잴 수 없다 */
  emptyThemes: Theme[];
  /** 마스터의 테마 수 = `themes.length + emptyThemes.length` */
  themeCount: number;
}

/** 테마 등락률에 들어간 종목 하나 */
export interface ThemePulseMember {
  instrumentId: string;
  symbol: string;
  name: string;
  price: number;
  change: number;
  changeRate: number;
  sign: PriceSign;
  /**
   * 당일 누적 거래대금(원). **없으면 없는 채로 둔다** — `현재가 × 거래량`으로
   * 어림해 채우면 거래대금 가중평균이 어림값에 끌려간다.
   */
  turnover?: number;
}

/**
 * 테마 하나가 지금 어떻게 움직이는지.
 *
 * ## 대표값을 왜 중앙값으로 뒀는가
 *
 * 셋(중앙값·단순평균·거래대금 가중평균)을 **다 담고** 그중 중앙값을 대표로 쓴다.
 *
 * - **중앙값** — 테마 종목 수가 1~110으로 제각각이라(실측), 작은 테마에서는
 *   한 종목의 상한가(+30%)가 단순평균을 통째로 끌어간다. 중앙값은 "이 테마
 *   종목의 절반이 이보다 위"라는 **셀 수 있는 사실**이다.
 * - **단순평균** — 중앙값과 크게 갈리면 그 자체가 정보다(한 종목 쏠림).
 * - **거래대금 가중평균** — 물음이 "돈이 어디로 도는지"라 돈이 실린 쪽에 무게를
 *   준 값이 따로 필요하다. 다만 **성질이 다른 값이라 대표값과 섞지 않는다** —
 *   삼성전자가 든 테마는 이 값이 사실상 삼성전자 등락률이 된다.
 *
 * ## 표본이 전체가 아니다
 *
 * 마스터가 넣어 둔 수(`theme.symbolCount`) ≥ 지금 찾은 종목 수
 * (`theme.instrumentCount`) ≥ 등락률에 쓴 수(`quotedCount`) ≥ 거래대금까지 온 수
 * (`turnoverCount`)로 줄어든다. 넷을 하나로 합치면 어디서 줄었는지 알 수 없다.
 *
 * `quotedCount`에서 빠지는 자리가 셋이라 각각 따로 담는다 — 종목을 못 찾음
 * (`missingSymbols`), 시세가 빈 값(`blankSymbols`), **호가가 비어 있음**
 * (`noOrderBookSymbols`), 조회가 깨짐(`failedSymbols`).
 *
 * `quotedCount` → `turnoverCount`로 줄어드는 자리도 둘이고, **다른 사실이다** —
 * 거래대금을 못 받음(`turnoverMissingSymbols`), 거래대금이 0원
 * (`turnoverZeroSymbols`). 앞은 우리 쪽 구멍이고 뒤는 그 종목에 대해 잰 사실이다.
 */
export interface ThemePulse {
  theme: Theme;
  /** 시세가 온 종목. 등락률 내림차순 */
  members: ThemePulseMember[];
  /** 마스터에는 있는데 지금 종목 마스터에서 못 찾은 종목코드 */
  missingSymbols: string[];
  /** 종목은 찾았는데 시세가 빈 값으로 온 것. "그런 종목이 없다"에 가깝다 */
  blankSymbols: string[];
  /**
   * 시세는 왔는데 **호가가 양쪽 다 비어 있던** 종목. 거래정지 종목이 이렇게 온다.
   *
   * 등락률 통계(중앙값·단순평균·상승/하락/보합)에서 **뺀다.** 이 종목들은
   * 등락률이 언제나 정확히 0%인데, 그건 "안 움직였다"가 아니라 "오늘 값이
   * 없다"다. 2026-07-31 실측으로 2차전지 테마는 **보합 4종목이 전부 거래
   * 0원**이라 진짜 보합이 0종목이었고, 중앙값이 +0.810 → +1.090으로
   * 0.28%p 움직였다. 가중평균은 예전부터 `turnover > 0`으로 빼고 있었으니
   * 이제 넷이 같은 표본을 본다.
   *
   * **거래대금이 0원이기만 한 종목은 여기 넣지 않는다.** 호가가 살아 있으면
   * 지금 살 수 있는 종목이고, 오늘 아직 체결이 없을 뿐이다(실측 2종목).
   */
  noOrderBookSymbols: string[];
  /** 조회가 깨져서 못 받은 것. **값이 없는 것이 아니라 못 받은 것이다** */
  failedSymbols: string[];
  /** 위 실패의 사유. 같은 사유는 한 번만 담는다 */
  failureMessages: string[];
  /** 등락률 계산에 쓴 종목 수 = `members.length`. 호가가 빈 종목은 빠져 있다 */
  quotedCount: number;
  /** 대표값. 시세가 하나도 없으면 없다 — **0으로 채우지 않는다** */
  changeRateMedian?: number;
  changeRateMean?: number;
  /** 거래대금 가중평균. 거래대금이 0원보다 큰 종목만으로 낸다 */
  changeRateWeighted?: number;
  /**
   * 가중평균에 실제로 들어간 종목 수(거래대금 > 0원). `quotedCount`보다 작을 수 있다.
   *
   * 여기서 빠진 종목은 `turnoverMissingSymbols` + `turnoverZeroSymbols`에 나뉘어
   * 담긴다. 셋을 더하면 `quotedCount`다.
   */
  turnoverCount: number;
  /**
   * 등락률 표본에 있는데 **거래대금 값 자체가 안 온** 종목.
   *
   * 해외·선물·야간 환산가처럼 KIS가 `acml_tr_pbmn`을 주지 않는 경로다. 이건 그
   * 종목에 대해 잰 사실이 아니라 **우리가 모르는 것**이라, 거래대금 합에도
   * 넣지 않는다(0원으로 세면 합이 실제보다 작아진다).
   *
   * 2026-07-31 14:02·14:16 실전 서버 실측(테마 302개 합집합 2,113종목): **0종목**.
   * 테마 명단이 전부 KRX 현금 종목이라 멀티시세로만 오고, 멀티시세는 이 값을
   * 늘 준다. 지금은 비어 있어도 명단에 다른 경로 종목이 섞이면 채워진다.
   */
  turnoverMissingSymbols: string[];
  /**
   * 등락률 표본에 있는데 **거래대금이 0원**인 종목. 호가는 살아 있다.
   *
   * 위와 달리 이건 **잰 사실이다** — 오늘 아직 한 주도 안 거래됐다는 뜻이고,
   * 그래서 거래대금 합에는 0원으로 들어간다. 가중평균에서만 빠진다(0을 곱하면
   * 없는 것과 같다).
   *
   * 2026-07-31 14:02·14:16 실측: **0종목**. 거래대금 0원인 92종목은 전부 호가까지
   * 비어 있어 `noOrderBookSymbols`에서 이미 빠졌다. 다만 장전 동시호가처럼
   * 아직 체결이 없는 시간대는 재지 않았다.
   */
  turnoverZeroSymbols: string[];
  /**
   * 거래대금 합(원). **테마 전체가 아니라 `turnoverMissingSymbols`를 뺀 부분합이다.**
   *
   * 값이 하나도 안 온 경우에만 없다. **합이 0원인 것과 못 받은 것을 겸하지
   * 않는다** — 아무도 안 거래한 테마의 `0원`은 잰 사실이라 그렇게 적는다.
   */
  turnover?: number;
  /** 오른 종목 수 (등락률 > 0) */
  advancing: number;
  /** 내린 종목 수 (등락률 < 0) */
  declining: number;
  /**
   * 보합 (등락률 = 0). 오름·내림에 섞지 않는다.
   *
   * **호가가 빈 종목은 여기 세지 않는다.** 예전에는 섞여 있어서 방위산업
   * 09:15의 `보합 2`가 실제로는 거래정지 1 + 진짜 보합 1이었다(2026-07-31 실측).
   */
  unchanged: number;
}

/**
 * 테마 등락률 한 회차.
 *
 * **호출 비용을 응답에 담는다.** 반도체 101종목이면 시세 조회 4회다. 부르는
 * 쪽이 모르면 탭을 열 때마다 도는 새로고침처럼 쓰이고, 그러면 하루 호출
 * 한도를 여기서 다 태운다.
 */
export interface ThemePulseBatch {
  measuredAt: number;
  /** 이번 요청이 실제로 낸 시세 조회 횟수 */
  quoteCalls: number;
  /** 한 요청이 낼 수 있는 상한 */
  maxQuoteCalls: number;
  pulses: ThemePulse[];
  /**
   * 재지 못한 테마. **반쪽으로 재느니 안 잰다** — 110종목 중 30종목만 보고
   * 낸 값을 "반도체 테마 등락률"이라 부를 수 없다.
   */
  skipped: ThemePulseSkip[];
}

export interface ThemePulseSkip {
  code: string;
  /** 목록에 없는 코드면 이름을 모른다 */
  name?: string;
  reason: string;
}

/**
 * `/api/instruments/quotes`의 묶음 규약.
 *
 * 서버는 이 요청 하나를 **`chunk`종목마다 시세 조회 1회**로 처리한다. 그래서
 * 프런트가 `chunk`보다 작게 잘라 보내면 조회 횟수가 그만큼 늘어난다 — 8종목씩
 * 보내던 때 120종목 목록이 15요청 15조회였고, 30종목씩이면 4요청 4조회다.
 *
 * 여기 두는 이유는 `KRX_SESSION_MINUTES`와 같다. 프런트와 백엔드가 각자 숫자를
 * 들고 있으면 한쪽만 고쳤을 때 조용히 갈라진다. **KIS 스펙이 아니라 우리 API의
 * 계약이다** — 프런트는 이 뒤에 무엇이 있는지 몰라도 된다.
 */
export const INSTRUMENT_QUOTE_BATCH = {
  /** 서버가 한 번의 조회로 처리하는 종목 수. 이 배수로 보내는 것이 가장 싸다 */
  chunk: 30,
  /** 한 요청에 넣을 수 있는 종목 수 (= `chunk` × 조회 10회). 넘으면 서버가 거절한다 */
  limit: 300,
} as const;

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
  /**
   * 이 값을 **받은 시각** (ms).
   *
   * **KIS는 시세에 시각을 주지 않는다.** 현재가(`inquire-price`) 응답 80필드,
   * 멀티시세 29필드 어디에도 "이 값이 언제 것인지"가 없다 (2026-07-31 실전
   * 실측 — 날짜가 들어간 필드는 `w52_hgpr_date` 같은 52주 최고가 날짜뿐이다).
   * 그래서 이건 거래소가 값을 만든 시각이 아니라 우리가 응답을 받은 시각이고,
   * 값의 실제 나이는 `now - fetchedAt` **이상**이다. 하한이지 정확한 나이가 아니다.
   *
   * **다시 쓸 때 새로 찍지 않는다.** 서버가 같은 값을 캐시에서 꺼내 줄 때
   * 지금 시각을 넣으면 묵은 값이 방금 것으로 보인다 — 2026-07-31 장중 실측에서
   * `/api/instruments/quotes`가 45초까지 같은 값을 돌려줬고, 그 45초 동안
   * 000660이 1,601,000 → 1,588,000원(−0.81%) 움직였다. 그때 화면은
   * `갱신 3초 전`이라고 적고 있었다.
   *
   * 이름은 `OrderBook.fetchedAt`·`MarketMoversSnapshot.fetchedAt`과 맞췄다.
   * `ScreeningResult.scannedAt`·`ThemePulseBatch.measuredAt`이 다른 말인 것은
   * 갈라진 게 아니라 대상이 달라서다 — 그쪽은 **한 회차**의 시각이고 이건
   * **값 하나**의 시각이다.
   */
  fetchedAt: number;
  price: number;
  change: number;
  changeRate: number;
  sign: PriceSign;
  open: number;
  high: number;
  low: number;
  accVolume: number;
  /**
   * 당일 누적 거래대금(원). **없을 수 있다.**
   *
   * 국내 주식·ETF는 KIS가 실제 값을 준다(단건·멀티시세 둘 다 `acml_tr_pbmn`).
   * 해외·선물·야간 환산가처럼 이 값을 주지 않는 경로는 필드 자체를 비운다 —
   * `현재가 × 누적거래량`으로 어림하면 어긋나는데(2026-07-30 113종목 실측:
   * 중앙값 +0.28%, 범위 −6.68% ~ +6.24%) 그 차이가 값처럼 보인다.
   * 어림한 값을 쓸 자리라면 어림한 쪽에서 그렇게 밝힌다.
   */
  turnover?: number;
  /**
   * 지금 쌓여 있는 **총 매도잔량 / 총 매수잔량**(주). 둘은 한 사실이라 **함께
   * 오거나 함께 없다.**
   *
   * 멀티시세(`intstock-multprice`)가 `total_askp_rsqn`·`total_bidp_rsqn`으로
   * 준다 — 호출이 늘지 않는다. **단건 현재가(`inquire-price`)에는 없다**
   * (2026-07-31 실측: 80필드 중 `rsqn`·`askp`·`bidp`가 이름에 든 필드가 0개).
   * 그래서 단건으로 받은 시세와 해외·선물·야간 환산가는 이 값이 없다.
   *
   * **무엇에 쓰는가** — 둘 다 0이면 지금 어떤 값에도 체결될 수 없다.
   * `hasEmptyOrderBook()`이 그 판정이고, 거래정지 종목이 실제로 이렇게 온다.
   * 0으로 채워 넣지 않는다: 값이 없는 것과 잔량이 0인 것은 정반대의 사실이다.
   */
  totalAskQuantity?: number;
  totalBidQuantity?: number;
}

/**
 * 호가창이 **양쪽 다** 비었나. 모르면 `undefined`다.
 *
 * 양쪽 잔량이 0이면 사자도 팔자도 없다는 뜻이라, 지금은 어떤 값에도 체결되지
 * 않는다. "거래대금이 적다"와는 다른 사실이다 — 앞은 얇은 것이고 이건 없는 것이다.
 *
 * ── 2026-07-31 11:35 KST 실전 서버, 정규장 300종목 실측 ───────────────────
 *
 * | 무엇 | 몇 종목 | 단건의 종목상태(`iscd_stat_cls_code`) |
 * |------|------|------|
 * | 양쪽 잔량 0 | **6** (000300·000880·00088K·001470·001570·001840) | **6종목 전부 거래정지** |
 * | 한쪽만 0 | 1 (002070 비비안 +29.83% 상한가 잠김) | 정상 |
 * | 거래대금 0원인데 호가는 있음 | 2 (0000Y0·001067) | 정상 (오늘 아직 체결이 없을 뿐) |
 * | 호가가 있는 종목 표본 15 | — | 거래정지 0건 |
 *
 * 여기서 세 가지가 정해졌다.
 *
 * 1. **양쪽을 모두 봐야 한다.** 한쪽만 0인 것을 걸면 상한가 잠김 종목
 *    (`002070`: 총매도 0 · 총매수 25,424 · 거래대금 14.7억)이 같이 걸린다.
 *    하한가 잠김은 반대쪽이 0이다.
 * 2. **거래대금 0원으로는 못 가른다.** 거래대금이 0인 8종목 중 2종목은
 *    호가가 살아 있는 멀쩡한 종목이었다.
 * 3. **이름을 "거래정지"로 짓지 않는다.** 위 대응은 정규장에서만 쟀다.
 *    장전 주문 접수(08:30) 전이나 휴장일에는 정상 종목도 호가가 비어 있을
 *    텐데 **그건 재지 않았다.** 잰 사실은 "지금 호가가 없다"까지다.
 *
 * 거래정지 자체를 정확히 알려면 단건 현재가의 `iscd_stat_cls_code = 58`을 봐야
 * 하는데 **종목당 1회**가 더 나간다(120종목 스크리닝이 4회 → 124회). 그래서
 * 안 쓴다.
 */
export function hasEmptyOrderBook(quote: Quote): boolean | undefined {
  const ask = quote.totalAskQuantity;
  const bid = quote.totalBidQuantity;
  // 값을 못 받은 경로(단건·해외·선물)를 "호가가 없다"로 단정하지 않는다.
  if (ask === undefined || bid === undefined) return undefined;
  if (!Number.isFinite(ask) || !Number.isFinite(bid)) return undefined;
  return ask === 0 && bid === 0;
}

/**
 * 받은 시세를 화면 저장소에 반영할지.
 *
 * 한 종목의 시세가 두 길로 온다 — 선택 종목은 단건(`/api/instruments/:id/quote`,
 * 캐시 없음)으로, 목록은 묶음(`/api/instruments/quotes`, 45초 캐시)으로. 늦게
 * 도착한 쪽이 무조건 이기면 **방금 받은 값이 캐시에서 나온 묵은 값에 덮인다.**
 * 시각이 없던 때는 그 일이 나도 알 방법이 없었다.
 *
 * 같은 시각이면 덮는다 — 같은 나이의 값이라 어느 쪽을 써도 같고, 안 덮으면
 * 첫 값이 영영 남는다.
 */
export function shouldReplaceQuote(current: Quote | undefined, incoming: Quote): boolean {
  if (!current) return true;
  return incoming.fetchedAt >= current.fetchedAt;
}

/**
 * 여러 시세 중 **가장 묵은** 시각. 화면이 "적어도 이때 것"이라고 말할 수 있게 한다.
 *
 * 가장 새 값을 쓰면 한 종목만 방금 왔어도 목록 전체가 새것처럼 보인다. 빈
 * 목록은 `undefined`다 — `Math.min()`은 인자가 없으면 `Infinity`라 그대로 쓰면
 * 나이가 음수가 된다.
 */
export function oldestFetchedAt(quotes: Quote[]): number | undefined {
  let oldest: number | undefined;
  for (const quote of quotes) {
    if (!Number.isFinite(quote.fetchedAt)) continue;
    if (oldest === undefined || quote.fetchedAt < oldest) oldest = quote.fetchedAt;
  }
  return oldest;
}

/**
 * 시세 나이를 화면이 어떻게 말할지. `fresh`·`stale`은 나이를 말할 수 있는
 * 상태고, `waiting`·`failed`는 말할 값 자체가 없는 상태다.
 */
export type QuoteFreshnessKind = 'fresh' | 'stale' | 'waiting' | 'failed';

export interface QuoteFreshnessState {
  kind: QuoteFreshnessKind;
  /** 가장 묵은 값의 나이(ms). 받아 둔 값이 하나도 없으면 null */
  ageMs: number | null;
}

/**
 * 시세가 지금 어떤 상태인지 한 곳에서 정한다.
 *
 * **`아직 안 옴`과 `못 받음`을 겸하지 않는다.** 예전에는 받아 둔 값이 없으면
 * 무조건 `갱신 대기`였다 — 조회가 502로 깨진 뒤에도 헤더 칩·종목 정보 띠·하단
 * 도크가 모두 기다리는 중이라고 적었고, 오류 배너는 8초 뒤 걷혀서 60초 중
 * 52초는 사유가 화면에 없었다(2026-07-31 장중 실측, 시세 조회를 502로 막고 잼).
 * 실주문 게이트가 `확인 중` / `확인 실패` 두 마디로 가른 것과 같은 자리다.
 *
 * **마지막 조회가 실패했으면 받아 둔 값이 방금 것이어도 `fresh`가 아니다.**
 * 값은 있지만 그게 지금 값인지는 더 이상 아는 것이 아니다.
 *
 * 프런트에는 시험 러너가 없어 `shouldReplaceQuote`·`oldestFetchedAt`과 같은
 * 이유로 여기 둔다. 화면은 이 판정에 말만 붙인다.
 */
export function quoteFreshnessState(
  // 이름을 `oldestFetchedAt`으로 두면 바로 위 함수와 가려진다. 값은 그 함수가 낸 것이다.
  oldestQuoteFetchedAt: number | null,
  nowMs: number,
  staleMs: number,
  failed: boolean,
): QuoteFreshnessState {
  if (oldestQuoteFetchedAt === null || !Number.isFinite(oldestQuoteFetchedAt)) {
    return { kind: failed ? 'failed' : 'waiting', ageMs: null };
  }
  const ageMs = Math.max(0, nowMs - oldestQuoteFetchedAt);
  if (failed || ageMs > staleMs) return { kind: 'stale', ageMs };
  return { kind: 'fresh', ageMs };
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

/**
 * KRX 정규장 시각. **분 단위, Asia/Seoul 기준.**
 *
 * 같은 사실을 프론트(장 상태 표시)와 백엔드(유동성 문턱의 경과 비율)가 함께
 * 쓴다. 예전에는 각자 `9 * 60`을 들고 있어서 한쪽만 고치면 갈라졌다.
 *
 * 리스크 룰의 `sessionStart`/`sessionEnd`는 여기에 맞추지 않는다 — 그건
 * 거래소 시각이 아니라 **사용자가 정하는 매매 허용 시간**이라 일부러 따로 둔다.
 */
export const KRX_SESSION_MINUTES = {
  /**
   * 장전 단일가(동시호가) 시작. **KRX 규정에서 가져온 값이고 실측이 아니다.**
   * 2026-07-27 관측은 08:53부터라 그 앞은 보지 못했다.
   */
  preAuctionOpen: 8 * 60 + 30,
  open: 9 * 60,
  /**
   * 마감 단일가 시작. **실측이다.** 같은 날 15:20:03에 KIS 장운영 구분이
   * 112(정규장) → 121(마감 동시호가)로 바뀌었다.
   */
  closeAuctionOpen: 15 * 60 + 20,
  /** 마감. 15:30:45에 121 → 112로 돌아간 것을 봤다. */
  close: 15 * 60 + 30,
  /**
   * 장후 시간외 종가 15:40~16:00, 시간외 단일가 16:00~18:00.
   *
   * **KRX 규정값이고 실측이 아니다.** 이 구간에 KIS가 무엇을 주는지는 아직 찍어
   * 보지 못했다 — 장이 닫힌 뒤에 만들었다. 내일 16:00~18:00에 재야 한다.
   */
  postOffHoursOpen: 15 * 60 + 40,
  singlePriceOpen: 16 * 60,
  singlePriceClose: 18 * 60,
} as const;

/**
 * 주문을 내기 전에 **화면이 미리 걸러 보는** 리스크 룰.
 *
 * **서버가 최종 판정자다**(`backend/src/db/riskRules.ts`의 `checkRiskRules`).
 * 이건 오발주를 줄이려고 같은 항목을 화면에서도 먼저 보는 것이고, 여기를
 * 통과했다고 주문이 나간다는 뜻이 아니다.
 *
 * **서버만 아는 것은 일부러 안 본다** — 거래 시간대·휴장일·오늘 누적 한도.
 * 화면이 흉내 내면 서버와 어긋난 순간 거짓말이 된다(`docs/CODE_STYLE.md`).
 * 그래서 이 함수는 서버 검사의 **부분집합**이다. 나중에 "빠졌다"고 채우지 말 것.
 *
 * 룰을 모르면 막힌 쪽에 둔다. 받아 둔 값이 있어도 마지막 조회가 실패했으면
 * 아는 것이 아니다 — 그 사이 룰이 조여졌으면 낡은 값으로 "괜찮습니다"라고
 * 말하게 된다.
 *
 * 수동 주문과 예약주문이 각자 따로 검사하다 예약주문 쪽이 통째로 빠져 있었다.
 * (자동매매도 자기 것을 따로 갖고 있는데, 그쪽은 검사 대상이 룰 자체라 다르다.)
 * 한 곳에서 만들어 둘 다 쓴다. 네 번째가 생겨도 여기만 부르면 된다.
 */
export function riskRuleBlockers({
  rules,
  error,
  symbol,
  orderType,
  quantity,
  price,
}: {
  rules: RiskRuleSet | null;
  error: string | null;
  symbol: string | undefined;
  /** 예약주문은 언제나 지정가다 */
  orderType: OrderType;
  quantity: number;
  /** 금액 한도를 재는 데 쓸 단가. 시장가면 현재가로 어림한다(서버와 같은 방식) */
  price: number;
}): string[] {
  if (!rules || error) {
    return [
      error
        ? `리스크 룰을 확인하지 못했습니다. 확인 전에는 주문이 나가지 않습니다 (${error})`
        : '리스크 룰을 확인하는 중입니다.',
    ];
  }

  const blockers: string[] = [];
  if (!rules.enabled) blockers.push('이 계좌는 리스크 룰에서 실주문이 꺼져 있습니다.');
  if (orderType === 'market' && !rules.allowMarketOrder) {
    blockers.push('이 계좌는 시장가 주문이 막혀 있습니다. 지정가로 내거나 리스크 룰을 고치세요.');
  }
  if (symbol) {
    if (rules.symbolBlocklist.includes(symbol)) blockers.push(`차단 종목입니다 (${symbol}).`);
    if (rules.symbolAllowlist.length > 0 && !rules.symbolAllowlist.includes(symbol)) {
      blockers.push(`허용 종목 목록에 없습니다 (${symbol}). 허용: ${rules.symbolAllowlist.join(', ')}`);
    }
  }
  if (Number.isFinite(quantity) && quantity > rules.maxOrderQuantity) {
    blockers.push(`1회 주문 수량 한도 ${rules.maxOrderQuantity.toLocaleString('ko-KR')}주를 넘습니다.`);
  }
  const notional = price * quantity;
  if (Number.isFinite(notional) && notional > rules.maxOrderNotional) {
    blockers.push(`1회 주문 금액 한도 ${rules.maxOrderNotional.toLocaleString('ko-KR')}원을 넘습니다.`);
  }
  return blockers;
}

/**
 * KRX 하루 운영 구간.
 *
 * 예전에는 정규장(09:00~15:30)과 동시호가만 알았고 나머지는 전부 `장외`였다.
 * 그런데 **15:40~18:00에는 실제로 거래가 일어난다** — 장후 시간외 종가와
 * 시간외 단일가다. 화면이 그 시간을 `마감 후`라고 부르면 거래가 없는 줄 안다.
 *
 * 08:30~08:40은 장전 시간외 종가와 장전 동시호가가 겹치지만 따로 두지 않는다 —
 * 우리 앱은 어느 쪽으로도 주문을 못 내고, 사용자에게 중요한 것은 "연속 체결이
 * 아니다"라는 사실이라 `preAuction`으로 묶는다.
 */
export type KrxSessionKind =
  | 'closed'
  | 'preAuction'
  | 'regular'
  | 'closeAuction'
  | 'postOffHours'
  | 'singlePrice';

export function krxSessionKind(minutesOfDay: number): KrxSessionKind {
  const s = KRX_SESSION_MINUTES;
  if (minutesOfDay >= s.preAuctionOpen && minutesOfDay < s.open) return 'preAuction';
  if (minutesOfDay >= s.open && minutesOfDay < s.closeAuctionOpen) return 'regular';
  if (minutesOfDay >= s.closeAuctionOpen && minutesOfDay <= s.close) return 'closeAuction';
  if (minutesOfDay >= s.postOffHoursOpen && minutesOfDay < s.singlePriceOpen) return 'postOffHours';
  if (minutesOfDay >= s.singlePriceOpen && minutesOfDay < s.singlePriceClose) return 'singlePrice';
  return 'closed';
}

/** 동시호가 구간 종류. 정규장·장외면 null. */
export type KrxAuctionWindow = 'pre' | 'close';

/**
 * 지금이 동시호가 구간인지 **시계로** 판단한다.
 *
 * KIS 장운영 구분 코드가 더 정확하지만 호가를 받아야 알 수 있고, 호가는 주문
 * 패널이 열려 있을 때만 받는다(종목당 호출 1회). 장 상태 한 줄을 적자고
 * 관심목록 전체에 호출을 붙이면 `EGW00201`에 걸린다. 그래서 이 판정은 시계로
 * 하고, 호가를 이미 받아 둔 자리에서는 그 값을 쓴다.
 *
 * **왜 이걸 봐야 하는가**: 동시호가에는 연속 체결이 없어 현재가가 굳는다.
 * 2026-07-27 15:26:18에 `000660` 큰 글씨가 1,820,000원(+3.47%, 15:19:59에
 * 멈춤)인 동안 동시호가는 1,836,000원(+4.38%)에 지시되고 있었다 —
 * 16,000원 차이를 화면이 `정규장 거래 중`이라고만 적었다.
 */
export function krxAuctionWindow(minutesOfDay: number): KrxAuctionWindow | null {
  // 판정은 krxSessionKind 한 곳에서만 한다. 두 함수가 각자 경계를 들면 갈라진다.
  const kind = krxSessionKind(minutesOfDay);
  if (kind === 'preAuction') return 'pre';
  if (kind === 'closeAuction') return 'close';
  return null;
}

/**
 * 자동매매 후보 거르기 한 종목.
 *
 * **거른 것도 함께 온다.** 통과한 것만 보이면 왜 이것뿐인지 알 수 없다.
 */
export type ScreeningVerdict = 'pass' | 'tooExpensive' | 'noOrderBook' | 'illiquid' | 'costHeavy';

export interface ScreeningRow {
  instrumentId: string;
  symbol: string;
  name: string;
  price: number;
  changeRate: number;
  /** 오늘 거래대금 (원). 유동성 문턱이 보는 값 */
  turnover: number;
  /**
   * 오늘 고가-저가를 현재가로 나눈 비율 (%).
   * 고가·저가가 아직 안 잡혔으면 undefined — 0으로 채우지 않는다.
   */
  rangeRate?: number;
  verdict: ScreeningVerdict;
}

/**
 * 후보 거르기 한 회차.
 *
 * 멀티시세로 **30종목에 KIS 1회**다(예전에는 종목당 1회였다). 그래도 화면을 열
 * 때마다 돌리면 탭을 누를 때마다 호출이 나가므로, **언제 잰 값인지**(`scannedAt`)와
 * **무슨 값으로 걸렀는지**(`thresholds`, `cash`, `elapsed`)를 함께 보낸다 —
 * 값만 보면 지금 것인지 아침 것인지 알 수 없다.
 *
 * **호출 비용도 담는다**(`quoteCalls`). `ThemePulseBatch`와 같은 규칙이다 —
 * 부르는 쪽이 모르면 새로고침처럼 눌린다.
 */
export interface ScreeningResult {
  scannedAt: number;
  /**
   * 이 회차가 실제로 낸 KIS 시세 조회 횟수.
   *
   * 종목 수로 세면 안 된다 — 30종목이 1회고, 실패한 묶음도 호출은 이미 나갔다.
   */
  quoteCalls: number;
  /** 예수금. 이 값으로 1주도 못 사면 `tooExpensive` */
  cash: number;
  /**
   * 장 경과 비율 (0~1). 유동성 문턱은 이 비율만큼만 요구한다 —
   * 09:05에 하루치 거래대금을 요구하면 전부 걸린다. 장 밖이면 1이다.
   */
  elapsed: number;
  poolSize: number;
  lookups: number;
  /** 시세를 못 받은 수. 빈 값으로 넘기지 않고 화면이 말한다 */
  unresolved: number;
  rows: ScreeningRow[];
  thresholds: {
    minDailyTurnover: number;
    /** 왕복 비용 — **일반 주식 기준**. 이 비율이 하루 변동폭의 일정 비중을 넘으면 제외 */
    roundTripCostRate: number;
    /**
     * 왕복 비용 — ETF 기준. 국내 상장 ETF는 매도 거래세가 면제라 주식보다 싸다.
     * 한 값만 적으면 화면이 "0.43%로 걸렀다"고 말하는데 ETF는 그 값으로 안 걸렀다.
     */
    etfRoundTripCostRate: number;
    maxCostShareOfRange: number;
  };
}

/**
 * 거래소가 매긴 등락률 순위 한 종목.
 *
 * 앱의 `랭킹` 탭은 관심·최근 종목 안에서만 순위를 매긴다 — "오늘 시장에서 많이
 * 오른 **낯선** 종목"은 거기서 나올 수 없다. 스크리닝 결과로 대신하려 했지만
 * 그건 종목코드 오름차순 앞 40개라 시장 표본이 아니다(2026-07-27 확인).
 * 이 값은 KIS 순위분석이 전 종목을 대상으로 준 것이다.
 */
export interface MarketMover {
  /** 거래소가 매긴 순위. 1이 가장 위 */
  rank: number;
  symbol: string;
  name: string;
  price: number;
  change: number;
  changeRate: number;
  sign: PriceSign;
  accVolume: number;
  /**
   * 우리 마스터에서 찾은 종목. 없으면 undefined — 화면이 이 종목으로 옮겨 갈
   * 수 없다는 뜻이고, 그 사실을 적어야 한다. id만 주면 화면이 다시 찾아야 하는데
   * 순위에 오르는 종목은 대개 관심목록 밖이라 화면에 찾을 재료가 없다.
   */
  instrument?: Instrument;
}

/** 등락률 순위 한 회차. 언제 잰 값인지 함께 온다. */
export interface MarketMoversSnapshot {
  direction: 'up' | 'down';
  fetchedAt: number;
  /** 거래소가 한 번에 주는 수. 전 종목이 아니라 상위 N이다 */
  rows: MarketMover[];
}

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
  /**
   * 예수금 총액(D+0). **오늘 산 것이 빠져 있지 않다.**
   *
   * 결제가 D+2라 오늘 매수한 금액만큼 줄지 않는다 — 2026-08-03에 6,860만원어치를
   * 사고도 1억 그대로였다. "지금 더 살 수 있는 돈"으로 쓰면 안 된다.
   * 그 값은 `settlementCash`다.
   */
  cashBalance?: number;
  /**
   * 오늘 낸 주문까지 반영한 정산 기준 현금(KIS 가수도정산금액, D+2).
   * **모르면 `undefined`다** — 0으로 채우지 않는다. 이 값을 안 주는 계좌·경로에서
   * 0을 쓰면 살 수 있는 돈이 없는 것으로 보여 아무것도 못 산다.
   */
  settlementCash?: number;
  totalEvaluation?: number;
  stockEvaluation?: number;
  purchaseAmount?: number;
  unrealizedPnl?: number;
  /**
   * 평가손익률(%). **매입금액 대비 평가손익**이고 서버가 계산한다
   * (`unrealizedPnl / purchaseAmount × 100`).
   *
   * ── 예전에는 다른 값이 이 이름에 들어 있었다 (2026-08-12 실측) ─────────
   *
   * KIS 주식잔고조회 output2의 `asst_icdc_erng_rt`(자산증감수익률)를 그대로
   * 담고 있었다. 그건 **전일 총자산 대비 오늘 자산이 얼마나 변했나**여서
   * 평가손익률이 아니다 — 09:03 실측에서
   *   자산증감수익률 0.17474202 = (96,154,944 − 95,987,214) / 95,987,214
   *   실제 평가손익률 +0.1769% = 84,570 / 47,797,070
   * 로 소수점까지 갈렸다. 그날은 둘 다 ~0.17%라 안 들켰을 뿐이다.
   *
   * **개장 전에는 자산이 안 움직여 `asst_icdc_erng_rt`가 0으로 온다.** 실제
   * 평가손익률이 −0.174%인 동안 화면이 `0%`라고 적게 된다. 자산증감수익률이
   * 필요하면 `assetChangeRate`를 쓴다.
   *
   * 매입금액이 없거나 0이면 `undefined`다 — 0으로 채우지 않는다.
   */
  unrealizedPnlRate?: number;
  /**
   * 전일 총자산 대비 오늘 자산 증감률(%). KIS `asst_icdc_erng_rt`를 그대로 옮긴 값.
   *
   * 평가손익률이 아니다. 입출금·당일 매매·수수료까지 섞인 **계좌 전체의 하루
   * 변동**이라 개장 전에는 0이다. 이름을 사실대로 붙여 둔다.
   */
  assetChangeRate?: number;
  positions: BrokerPosition[];
  updatedAt?: number;
  message?: string;
}

/**
 * 평가손익률(%)을 매입금액 대비로 계산한다.
 *
 * KIS 주식잔고조회 output2에는 "매입 대비 평가손익률" 칸이 없다 — 있는 것은
 * 자산증감수익률(`asst_icdc_erng_rt`)뿐이라 우리가 계산해야 한다.
 *
 * **분모가 없거나 0이면 `undefined`다.** 0으로 채우면 "본전이었다"로 읽히는데
 * 실제로는 잴 것이 없는 것이다 — `settledRealized`와 같은 규칙이다.
 * 여기(shared)에 두는 이유도 같다: 계좌가 비었거나 개장 전이라 값이 있는 쪽을
 * 화면으로 태울 수 없을 때가 많아, 경계를 시험으로 못 박는다.
 */
export function unrealizedPnlRateOf(
  unrealizedPnl: number | undefined,
  purchaseAmount: number | undefined,
): number | undefined {
  if (unrealizedPnl === undefined || purchaseAmount === undefined) return undefined;
  if (!Number.isFinite(unrealizedPnl) || !Number.isFinite(purchaseAmount)) return undefined;
  if (purchaseAmount === 0) return undefined;
  return (unrealizedPnl / purchaseAmount) * 100;
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
/**
 * 목록 하나와 **왜 비었는지**.
 *
 * ── 왜 배열로 안 주나 (2026-08-03) ────────────────────────────────────────
 *
 * 예약주문·정정취소가능주문은 성공하면 배열, 실패하면 `{message}` 객체를 줬다.
 * 모양이 갈리니 읽는 쪽이 실패를 빈 목록으로 착각한다 — 실제로 그렇게 읽어서
 * **조회가 실패한 것을 "미체결 0건"으로 적을 뻔했다.** 없는 것과 못 본 것은
 * 다른 사실이고, 한 모양으로 오면 그 둘을 필드로 가를 수 있다.
 *
 * `unavailable`이 있으면 **이 환경에 그 기능이 없다**는 뜻이다(모의 서버의
 * `EGW02006`). 장애가 아니라서 다시 시도할 것이 없고, 화면은 오류가 아니라
 * 안내로 보여야 한다.
 */
export interface BrokerListSnapshot<T> {
  items: T[];
  /** 이 환경에서 못 쓰는 기능이면 그 이유. 장애와 구분된다 */
  unavailable?: string;
}

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

/*
 * 기간별 매매손익의 "성적" 두 칸 — 매도 확정이 0건이면 숫자를 내주지 않는다.
 *
 * KIS는 이 기간에 판 것이 없어도 `tot_rlzt_pfls`·`tot_pftrt`를 **둘 다 `0`으로**
 * 내려준다(실측: rows 0건에 totalRealizedProfit=0, totalProfitRate=0). 그대로
 * 그리면 화면이 `실현손익 0원 · 손익률 0.00%`라고 적는데, **손익률은 분모가
 * 없는 값**이라 이건 "본전이었다"로 읽힌다. 잰 결과가 0인 게 아니라 잴 것이
 * 없는 것이다.
 *
 * `undefined`를 돌려주면 화면의 `formatMoney`/`formatPercent`가 `-`를,
 * `profitTone`이 `flat`을 준다 — 없는 값에 빨강·파랑이 붙지 않는다.
 *
 * **수수료·세금·거래대금에는 쓰지 않는다.** 거래가 없었으면 그 셋은 정말로
 * 0원이다. 성질이 다르니 같이 지우지 않는다.
 *
 * 화면(App.tsx)이 아니라 여기 있는 이유는 `riskRuleBlockers`와 같다 — 시험으로
 * 경계를 못 박기 위해서다. 실계좌에 확정 매도가 한 건도 없어 **값이 있는 쪽을
 * 화면으로는 태울 수 없었다.**
 */
export function settledRealized(profit: BrokerTradeProfitSnapshot): number | undefined {
  return profit.rows.length > 0 ? profit.totalRealizedProfit : undefined;
}

export function settledProfitRate(profit: BrokerTradeProfitSnapshot): number | undefined {
  return profit.rows.length > 0 ? profit.totalProfitRate : undefined;
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
  /**
   * 스톱가. **이 값이 오면 스톱지정가로 접수한다** — 현재가가 여기 닿는 순간
   * `limitPrice`로 주문이 나간다.
   *
   * 감시하는 주체가 **우리가 아니라 거래소**라는 것이 이 값의 전부다. 서버가
   * 꺼져 있어도, 사람이 화면을 안 보고 있어도 손절이 살아 있다.
   *
   * 지정가와 **함께** 온다(`orderType: 'limit'` + `limitPrice`). 스톱가만으로는
   * 닿았을 때 얼마에 낼지가 정해지지 않는다.
   */
  stopPrice?: number;
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

  /*
   * ── 여기부터는 **계좌 상태**를 봐야 하는 잣대다 (2026-08-05) ──────────
   *
   * 위 항목들은 주문 한 건만 보고 판정하지만, 아래 셋은 "지금 무엇을 들고
   * 있는가"를 알아야 한다. 판정은 `backend/src/trading/positionGuard.ts`가 한다.
   *
   * 원래 러너 설정(`AutoTraderConfig`)에 있었다. 판단자가 알고리즘에서
   * 에이전트로 옮겨가면서 **러너를 끄면 값이 갈 곳이 없어져** 계좌 룰로 올렸다.
   * 누가 주문하든 같은 바닥을 지나야 한다.
   */

  /** 동시에 들 수 있는 종목 수. 0이면 검사하지 않는다 */
  maxPositions: number;
  /** 산 지 이만큼 안 지났으면 매도를 미룬다(분). 0이면 끔 */
  minHoldMinutes: number;
  /**
   * 평가금액이 이 값 **이하**면 매수를 전면 차단한다. 0이면 끔.
   *
   * 매도는 막지 않는다 — 바닥에 닿았다고 못 나가게 하면 위험이 줄지 않는다.
   */
  stopEquity: number;
}

/**
 * 국내 업종/지수 현재값 (KOSPI·KOSDAQ 등).
 *
 * ★ **종목 시세가 아니다.** 조회 TR도 시장 구분 코드도 다르다 —
 * 종목은 `FID_COND_MRKT_DIV_CODE='J'`, 업종은 **`'U'`**다. 섞으면 응답이 비어 온다.
 *
 * 이 레포는 2026-08-05까지 지수를 **한 번도 못 재고 있었다.** 에이전트가 시장
 * 맥락을 판단해야 하는데 언론 값을 인용할 수밖에 없었다 — 우리가 잰 값이 아니었다.
 * ETF 대용(069500)과 지수는 다르다. 섞으면 안 된다.
 */
export interface DomesticIndexQuote {
  /** 업종코드. 0001 코스피 · 1001 코스닥 · 2001 코스피200 */
  code: string;
  name: string;
  value: number;
  change: number;
  changeRate: number;
  sign: PriceSign;
  /** 오른 종목 수 / 내린 종목 수. 지수보다 장의 폭을 잘 말해 준다 */
  advancing: number;
  declining: number;
  unchanged: number;
  /** 누적 거래대금(원) */
  turnover: number;
  fetchedAt: number;
}

/** 주문 1건에 대한 리스크 판정 결과 */
export interface RiskVerdict {
  allowed: boolean;
  /** 위반 사유 전부. 하나씩 알려주면 고칠 때마다 새 사유를 만난다 */
  violations: string[];
  rules: RiskRuleSet;
  /** 오늘(KST) 접수된 주문 건수 */
  todayOrderCount?: number;
  /** 오늘(KST) 접수된 주문 중 **금액을 아는 것**의 합. 아래 건수만큼은 빠져 있다 */
  todayNotional?: number;
  /**
   * 금액을 알 수 없어 위 합에서 빠진 건수.
   * 0으로 치면 "오늘 그만큼 안 썼다"가 되어 일일 금액 한도가 헐거워진다.
   */
  todayUnpricedCount?: number;
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
  /**
   * 시장가 주문의 **판정 시점 추정 단가**. 지정가 주문에는 없다.
   *
   * `limitPrice`와 갈라 둔다 — 시장가에는 단가가 없고, 추정치를 단가 자리에 넣으면
   * 기록을 읽는 사람이 지정가로 낸 주문이라고 오해한다. 리스크 룰의 금액 한도는
   * 이 값으로 재므로 어림값이라는 사실과 함께 남긴다.
   */
  estimatedPrice?: number;
  /**
   * 스톱가. 스톱지정가로 낸 주문에만 있다.
   *
   * `limitPrice`와 갈라 둔다 — **성질이 다른 값이다.** 스톱가는 "언제 나가는가"이고
   * 지정가는 "얼마에 나가는가"다. 합쳐 적으면 손절 조건이 붙은 주문과 그냥 지정가
   * 주문이 기록에서 똑같이 보인다.
   */
  stopPrice?: number;
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

/**
 * 전략을 한 번 재고 남긴 것.
 *
 * 축·시점·조건을 **필드로** 가른다. 예전에는 이 전부가 문장 하나(`backtestNote`)
 * 였고, 그 문장이 일봉으로 잰 값인데 러너는 1분봉으로 돌았다. 화면은 축이 다르다는
 * 사실을 말할 수 없었고 *"승률 70.8%로 셋 중 압도적 1위"*가 자동매매 시작 버튼 옆에
 * 그대로 떠 있었다 — 러너 축에서는 19.6%다.
 *
 * 여러 건을 들고 다니는 것은 축을 골라 보여주기 위해서가 아니라, **어느 축을 아직
 * 재지 않았는지가 드러나게** 하기 위해서다.
 */
export interface StrategyMeasurement {
  axis: CandleAxis;
  /** 잰 날. `2026-07-31` */
  measuredOn: string;
  /** 무엇으로 쟀나 — 종목 수·기간·비용 가정 */
  sample: string;
  /** 무엇이 나왔나. 숫자만이 아니라 그 숫자를 어떻게 읽어야 하는지까지 */
  result: string;
}

/** 자동매매 전략 목록 응답. 러너가 도는 축을 함께 준다 — 판정의 주인은 서버다. */
export interface StrategyListResponse {
  /** 러너가 실제로 전략에 넣는 봉. 이 축의 측정이 없는 전략은 화면이 그렇게 말한다 */
  runnerAxis: CandleAxis;
  strategies: Array<{
    key: string;
    label: string;
    /** 러너 축 측정이 먼저 온다 */
    measurements: StrategyMeasurement[];
    verdict: 'no_edge' | 'unproven';
  }>;
}

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
  /**
   * 장후 시간외 종가(15:40~16:00)에 **남은 포지션을 정리**할지. 기본은 끔.
   *
   * ── 왜 매도만인가 ────────────────────────────────────────────────────────
   *
   * 그 시간대에는 모든 체결이 **종가 하나**라 값이 안 움직인다. 이동평균이
   * 나란히 평평해져 교차가 영원히 안 나므로 **전략은 신호를 낼 수 없다.**
   * 그래서 매수는 의미가 없고, 의미가 있는 것은 정규장에 못 판 것을 종가로
   * 내보내는 길뿐이다.
   *
   * ★ **이 경로는 아직 확인되지 않은 주문구분을 쓴다**(`kis/orderDivisions.ts`의
   * `AFTER_HOURS_CLOSE_CANDIDATE`). 접수되는지 거절되는지는 실제 주문 한 건으로만
   * 알 수 있고, 회차 기록이 그 사실을 함께 적는다.
   */
  afterHoursExit?: boolean;
  /**
   * 최소 보유 시간(분). 산 지 이만큼 지나지 않았으면 **매도 신호가 나도 그 회차에는
   * 팔지 않는다.** `0`이면 끈 것이고 기본값이다.
   *
   * ── 근거는 손익이 아니라 배관이다 ────────────────────────────────────────
   *
   * 2026-08-01 측정(1분봉 축·15종목·연속 15거래일)에서 최소 보유는 **손실을 줄이지만
   * 우위를 만들지 않았다.** 비용을 0으로 놓으면 개선이 사라지고 이익 종목이 오히려
   * 줄었다(7→3 · 6→3 · 10→5). 덜 잃는 법이지 이기는 법이 아니다 — 수익 기능으로
   * 읽히게 적으면 안 된다.
   *
   * 실제 근거는 **일일 주문 한도**다. 같은 측정에서 종목 하나당 하루 주문 수
   * (왕복이라 1회전에 2건):
   *
   *   최소 보유    이동평균 교차   변동성 돌파   평균 회귀
   *   없음            12.4건        49.7건       11.0건
   *   60분             5.0건         7.6건        5.3건
   *   120분            3.6건         4.3건        3.7건
   *
   * 일일 건수 한도는 **계좌 전체 합산 20건**이다(`maxPositions=3`이면 3배가 나간다).
   * 지금 구조로는 **매수가 한도를 먼저 먹으면 그날 못 판다** — 시뮬에서 매도
   * 65~2,219회가 막혔다. 리스크 룰은 손실을 줄이려고 있는데 여기서는 출구를 잠근다.
   *
   * ── 왜 리스크 룰이 아니라 여기 있나 ──────────────────────────────────────
   *
   * 리스크 룰에 넣으면 **수동 매도까지 막힌다.** 이건 자동매매가 자기 신호를
   * 보류하는 것이지 주문을 금지하는 것이 아니다. 판단도 러너가 한다 — 전략이
   * 알면 두 곳에서 같은 판단을 하게 되고 한쪽만 고치면 조용히 어긋난다.
   *
   * ── 위험 ────────────────────────────────────────────────────────────────
   *
   * 값이 급락해도 이 시간 동안은 자동매매가 팔지 않는다. 지금 손절은 없다.
   */
  minHoldMinutes: number;
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
 * 국내 주식 매도에 붙는 세금 비율 (증권거래세 + 농어촌특별세).
 *
 * **2026-07-27에 출처를 확인했다.** 2026-01-02 양도분부터 코스피·코스닥 모두
 * 합계 **0.20%**다. 세 곳이 같은 합계를 말했다(증권사 공지 · 뉴스 · 정부 발표
 * 정리). 시장별 구성은 출처마다 조금 다르게 적혀 있지만(코스피는 거래세
 * 0.05% + 농특세 0.15%, 코스닥은 0.20% 단독이라는 곳과 0.05%+0.15%라는 곳)
 * **합계는 셋 다 0.20%로 같고, 우리가 쓰는 것은 합계뿐이다.**
 *
 * 예전에는 확인된 값이 아니었다 — 백테스트가 0.0018, 수수료 계산기가 0.002를
 * 따로 들고 있었고 둘 다 출처가 없어 백테스트 쪽으로 통일했다. **그때 고른
 * 쪽이 틀렸다.** 수수료 계산기가 쓰던 0.002가 지금 맞는 값이다. 출처 없이
 * 두 값 중 하나를 고르면 반은 틀린다는 걸 이 자리가 보여준다.
 *
 * 세율은 법으로 바뀐다. 바뀌면 이 값 하나만 고치면 주문 티켓·수수료 계산기·
 * 백테스트·신호 채점이 함께 따라온다.
 */
export const KR_SELL_TAX_RATE = 0.002;

/**
 * 코넥스는 다르다. 2026년 인상에서 **제외돼 0.10%가 유지**됐다(같은 출처들).
 */
export const KR_KONEX_SELL_TAX_RATE = 0.001;

/**
 * 이 종목을 팔 때 증권거래세가 면제되는가.
 *
 * **국내 상장 ETF는 매도 시 증권거래세가 면제다. 종류와 무관하다.**
 * 2026-08-11에 두 출처를 교차 확인했다 — 한국투자증권 공식 안내("거래수수료는
 * 주식거래수수료와 동일하나, 매도시 세금은 면제"), 한국금융투자자교육협의회
 * ("해외주식형 ETF도 매도할 때 증권거래세를 면제받는 것은 동일합니다").
 * 두 출처가 적은 세율 숫자(0.3%/0.25%)는 낡았으므로 **면제라는 사실만 취하고
 * 숫자는 `KR_SELL_TAX_RATE`를 쓴다.**
 *
 * ── `assetType === 'etf'`에서 멈추는 이유 ────────────────────────────────
 *
 * 종류별로 갈리는 것은 **거래세가 아니라 다른 세금**이다. 국내주식형은
 * 매매차익이 비과세지만 해외지수·채권·원자재·파생형(커버드콜)·레버리지/인버스는
 * 매매차익에 배당소득세 15.4%가 붙는다. 그건 **보유기간 과세**라
 * `Min(매매차익, 과표증분)` 구조인데 **과표증분을 우리가 모른다** — 지금 넣으면
 * 틀린 값이 들어가므로 넣지 않는다. 그래서 그 종류들에 대해 이 앱의 비용은
 * **과소계상**이다(거래세는 정확히 0이 맞고, 빠진 것은 차익과세다).
 *
 * "국내주식형인가"를 판별하려 들지도 않는다 — `Instrument`에 그 정보가 없다.
 *
 * ETN은 여기 넣지 않았다. 면제라는 확인된 출처를 이 레포가 아직 갖고 있지
 * 않아서다. `KR_SELL_TAX_RATE` 주석이 적어 둔 대로, 출처 없이 고르면 반은 틀린다.
 */
export function isKrSellTaxExempt(instrument: Pick<Instrument, 'assetType'>): boolean {
  return instrument.assetType === 'etf';
}

/**
 * 이 종목을 팔 때 실제로 붙는 매도 세율.
 *
 * 주문 티켓·백테스트·후보 거르기가 같은 판단을 쓰도록 한 곳에 둔다.
 * 종목을 모르면(`undefined`) 면제를 가정하지 않고 일반 주식 세율로 둔다 —
 * 모르는 쪽은 비용이 큰 쪽에 둔다.
 */
export function krSellTaxRate(
  instrument: Pick<Instrument, 'assetType' | 'market'> | null | undefined,
): number {
  if (!instrument) return KR_SELL_TAX_RATE;
  if (isKrSellTaxExempt(instrument)) return 0;
  if (instrument.market === 'KONEX') return KR_KONEX_SELL_TAX_RATE;
  return KR_SELL_TAX_RATE;
}
