/**
 * 해외주식 주문의 **보내기 전 규칙** — 어느 거래소로 · 지금 열려 있나 · 원화로 얼마인가.
 *
 * ── 왜 따로 두나 (2026-09-11) ────────────────────────────────────────────
 *
 * 국내 경로의 잣대(`checkRiskRules`)는 **전부 한국 전제**다:
 *
 *   · 장시간이 KST 09:00~15:30이다 — 미국 정규장은 KST 밤이라 **늘 "허용 시간
 *     밖"으로 막힌다.** 반대로 그 잣대를 끄면 아무 시각에나 나간다
 *   · 개장일을 **국내 증시**로 묻는다 — 한국 휴일에 미국은 열려 있고, 그 반대도 있다
 *   · 금액이 **원화**다 — 달러 단가(190.25)를 그대로 넣으면 원화 한도에
 *     **1,300분의 1로 잡혀** 한도가 통째로 샌다
 *
 * 그래서 해외는 이 모듈이 먼저 거른다. **순수 계산이라 시험에 그대로 태운다** —
 * `server.ts`는 연결만 한다(`docs/REVIEW.md` "server.ts에 wiring만").
 *
 * ── 지금 여는 범위: 미국 정규장만 ───────────────────────────────────────
 *
 * 모의에서 확인된 것이 거기까지다(`docs/TRADING_API.md` 4절). 다른 시장은 TR이
 * 있어도 **모의로 접수를 본 적이 없어** 열지 않는다 — 스톱지정가에서 "될 줄 알고
 * 만든" 경로가 검증 못 하는 코드로 남은 것을 되풀이하지 않는다.
 */

/** 미국 정규장 주문의 KIS 거래소 코드(`OVRS_EXCG_CD`) */
export type UsOrderExchange = 'NASD' | 'NYSE' | 'AMEX';

/**
 * 종목 마스터의 시장 → 주문 거래소 코드.
 *
 * ★ **마스터와 주문이 다른 이름을 쓴다** — 마스터는 `NAS`·`NYS`·`AMS`, 주문은
 *   `NASD`·`NYSE`·`AMEX`다. 마스터 값을 그대로 보내면 KIS가 거절한다.
 */
const REGULAR_MARKET_EXCHANGE: Record<string, UsOrderExchange> = {
  NAS: 'NASD',
  NYS: 'NYSE',
  AMS: 'AMEX',
};

/**
 * 미국 **주간거래** 마스터(`BAQ`·`BAY`·`BAA`).
 *
 * ★ 같은 AAPL이 `NAS`와 `BAQ` 두 줄로 들어 있다. 주간거래는 주문 TR 자체가 다르고
 *   (`/daytime-order`, `TTTS6036U`·`TTTS6037U`) KIS 공식 예제에 **모의 TR이 없다**
 *   (2026-09-11 확인). 정규장 TR로 보내면 틀린 시장에 가고, 주간 TR로 보내면 모의로
 *   검증할 길이 없다 — 그래서 막고, 정규장 줄로 주문하라고 말한다.
 */
const DAYTIME_MARKETS = new Set(['BAQ', 'BAY', 'BAA']);

export type ExchangeVerdict =
  | { ok: true; exchange: UsOrderExchange }
  | { ok: false; reason: string };

export function usOrderExchange(
  instrument: { country: string; market: string; currency: string },
): ExchangeVerdict {
  if (instrument.country !== 'US' || instrument.currency !== 'USD') {
    return { ok: false, reason: '해외주식은 지금 미국 종목(달러 결제)만 주문합니다.' };
  }
  if (DAYTIME_MARKETS.has(instrument.market)) {
    return {
      ok: false,
      reason: `${instrument.market}는 미국 주간거래 시장입니다 — 주문 TR이 따로 있고 모의 TR이`
        + ' 없어 열지 않았습니다. 같은 종목의 정규장(NAS·NYS·AMS) 줄로 주문하세요.',
    };
  }
  const exchange = REGULAR_MARKET_EXCHANGE[instrument.market];
  if (!exchange) {
    return { ok: false, reason: `모르는 미국 시장입니다: ${instrument.market}` };
  }
  return { ok: true, exchange };
}

/** 미국 정규장 — 뉴욕 시각 09:30~16:00 */
export const US_REGULAR_OPEN_MINUTE = 9 * 60 + 30;
export const US_REGULAR_CLOSE_MINUTE = 16 * 60;

export interface UsSessionVerdict {
  open: boolean;
  /** 사람에게 보일 뉴욕 시각. 막혔을 때 **왜 지금이 아닌지**를 그 자리에서 보이려고 */
  newYorkTime: string;
  reason?: string;
}

/**
 * 지금 미국 정규장이 열려 있나.
 *
 * ★★ **KST로 계산하지 않는다.** 미국은 서머타임이 있어 KST로는 개장이 22:30이었다
 *    23:30이었다 한다(3월·11월에 바뀐다). 뉴욕 시각으로 판정하면 그 이동을
 *    `Intl`이 알아서 한다 — 표를 두 벌 두지 않는다.
 *
 * ★ `hourCycle: 'h23'` — 기본값이면 자정이 `24`로 나오는 환경이 있다.
 *
 * ★ **미국 휴장일은 여기서 보지 않는다.** 국내는 개장일을 KIS에 묻고 모르면
 *   보류하지만, 해외 휴장일을 묻는 경로를 아직 확인하지 않았다. 휴장일 주문은
 *   KIS가 거절하므로 돈이 새지는 않는다 — 대신 이 판정이 "열려 있다"고 한 날
 *   거절이 오면 그것이 휴장일일 수 있다는 것을 사유에 남긴다(호출부 몫).
 */
export function usRegularSession(now: Date): UsSessionVerdict {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now).map((p) => [p.type, p.value]),
  );
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const newYorkTime = `뉴욕 ${parts.weekday} ${parts.hour}:${parts.minute}`;

  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') {
    return { open: false, newYorkTime, reason: `미국 주말입니다 (${newYorkTime}).` };
  }
  if (minute < US_REGULAR_OPEN_MINUTE || minute >= US_REGULAR_CLOSE_MINUTE) {
    return {
      open: false,
      newYorkTime,
      reason: `미국 정규장(뉴욕 09:30~16:00) 밖입니다 — 지금 ${newYorkTime}.`,
    };
  }
  return { open: true, newYorkTime };
}

/**
 * 환율을 이만큼 넘게 묵었으면 **모르는 것으로 친다.**
 *
 * 한도 판정에만 쓰는 값이라 초 단위로 맞을 필요는 없지만, 하루 묵은 값은
 * 원화가 1%만 움직여도 한도를 그만큼 틀리게 본다. 30분이면 넉넉하다.
 */
export const FX_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * 달러 주문의 **원화 금액**. 모르면 `undefined`다 — **0으로 치지 않는다.**
 *
 * ★ 국내 경로가 같은 자리에서 한 번 크게 샜다: 시장가 현재가 조회가 실패하면
 *   0을 넘겼고, `0 > 한도`는 거짓이라 금액 잣대를 전부 그냥 지나갔다
 *   (`riskRules.ts` `RiskCheckInput.price`). **모르는 것은 통과가 아니라 보류다.**
 *   환율도 똑같다 — 못 받았거나 묵었으면 금액을 모르는 것이다.
 */
export function krwNotional(
  quantity: number,
  usdPrice: number,
  fx: { rate: number; fetchedAt: number } | undefined,
  nowMs: number,
): number | undefined {
  if (!(quantity > 0) || !Number.isFinite(usdPrice) || !(usdPrice > 0)) return undefined;
  if (!fx || !Number.isFinite(fx.rate) || !(fx.rate > 0)) return undefined;
  if (!(nowMs - fx.fetchedAt <= FX_MAX_AGE_MS)) return undefined;
  return quantity * usdPrice * fx.rate;
}
