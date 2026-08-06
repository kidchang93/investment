/**
 * 조회할 **거래소**를 고른다 (`FID_COND_MRKT_DIV_CODE`).
 *
 * ── 왜 생겼나 (2026-08-05) ───────────────────────────────────────────────
 *
 * 이 레포는 이 값을 어디서나 `'J'`로 박아 뒀다. 그래서 **NXT 프리마켓
 * 08:00~08:50에 실제로 체결되는 값을 한 번도 본 적이 없다.** 그 시각 KRX는
 * 닫혀 있어 `getQuote`가 **전일 종가**를 준다 — 그 값으로 지정가를 걸면
 * 어제 가격에 주문을 내는 것이다.
 *
 * ── 실측으로 가른 것 (2026-08-05 10:06, 대조군 포함) ─────────────────────
 *
 * 없는 코드 `ZZ`는 `rt_cd=2 · ERROR INVALID FID_COND_MRKT_DIV_CODE`로 거절됐다.
 * KIS가 이 필드를 **실제로 검사한다**는 뜻이라, 아래 값들이 통과한 것은 진짜다.
 *
 * ★ **`UNIFIED`는 "통합 가격"이 아니다.** 거래량·거래대금·공매도는 KRX+NXT로
 * 합쳐 주지만 **OHLC는 NXT 것을 그대로** 준다(005930 8/4: J 시가 244,500 /
 * UN 시가 239,000 = NX 시가). NXT의 하루는 08:00~20:00이라 고저 범위도 다르다.
 *
 * 그래서 쓰는 곳이 갈린다.
 *
 *   가격(시가·고가·저가·종가)  → `KRX`. **우리가 체결할 수 있는 유일한 시장**이고,
 *                                갭은 09:00 동시호가 기준이라 NXT 08:00 시가와 다르다
 *   거래량·거래대금            → `UNIFIED`. 정확히 가법적이다(J+NX 검산 완료)
 *   공매도 비중                → `UNIFIED`. KRX만 보면 분모가 KRX 거래량뿐이라
 *                                **종목마다 다른 비율로 부풀려진다**(005930 7.76% vs 실제 4.59%)
 *   개장 전 가격                → `NXT`. 08:00~08:50에 값이 있는 유일한 곳
 */

/** 우리가 고를 수 있는 거래소. KIS 코드가 아니라 **뜻**으로 적는다. */
export type KisExchange = 'KRX' | 'NXT' | 'UNIFIED';

/**
 * `FID_COND_MRKT_DIV_CODE`에 실제로 들어가는 값.
 *
 * 삼항 사슬 대신 표로 둔다(`docs/CODE_STYLE.md`). 호출부가 `'J'`를 직접 쓰지 않게
 * 하려는 것이 목적이라 **여기 없는 코드는 만들지 않는다** — 확인된 셋뿐이다.
 */
const MARKET_DIV_CODE: Record<KisExchange, string> = {
  KRX: 'J',
  NXT: 'NX',
  UNIFIED: 'UN',
};

/** 기본값. **바꾸지 마라** — 이 값이 바뀌면 레포의 모든 과거 측정과 기준이 어긋난다. */
export const DEFAULT_EXCHANGE: KisExchange = 'KRX';

export function marketDivCode(exchange: KisExchange = DEFAULT_EXCHANGE): string {
  return MARKET_DIV_CODE[exchange];
}

/**
 * 사람에게 보일 이름. 기록에 **어느 시장의 값인지** 남기려고 둔다.
 *
 * 개장 전 지정가는 값의 출처가 셋으로 갈리는데(NXT 체결가·KRX 예상체결가·전일 종가),
 * 어느 것이었는지 안 남기면 나중에 체결가가 이상해도 원인을 못 찾는다.
 */
export function exchangeLabel(exchange: KisExchange): string {
  return { KRX: 'KRX', NXT: 'NXT', UNIFIED: 'KRX+NXT 통합' }[exchange];
}
