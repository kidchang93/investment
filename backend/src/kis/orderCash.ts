/**
 * 현금 주문(`/uapi/domestic-stock/v1/trading/order-cash`) 요청 본문 조립.
 *
 * `rest.ts`에서 떼어 둔 이유는 `multiQuote.ts`와 같다 — **보내기 전에 막아야 하는
 * 계산**이라 시험으로 못 박아야 하고, 그 시험이 네트워크 없이 돌아야 한다.
 * 조회는 틀리면 다시 부르면 되지만 주문은 한 번 나가면 되돌릴 수 없어서,
 * 조립 결과 자체를 시험에 태운다. `rest.ts`는 HTTP만 친다.
 *
 * ## 여기서 던지는 것들 — 왜 조용히 넘기지 않는가
 *
 * 스톱지정가(`22`)는 조건가격(`CNDT_PRIC`)이 있어야 성립하고, 조건가격은 `22`가
 * 아니면 쓰이는 자리가 없다. 둘이 어긋난 채 나가면 두 가지가 일어날 수 있는데
 * **둘째가 훨씬 나쁘다**:
 *
 * 1. KIS가 거절한다 — 주문이 안 나간 것이라 사람이 안다
 * 2. **조건 없이 그냥 지정가로 접수된다** — 손절을 걸었다고 믿는 주문이 손절
 *    없이 시장에 남는다. 그 사실은 값이 크게 움직인 뒤에야 드러난다
 *
 * 반대 방향(조건가격만 오고 주문구분이 `22`가 아닌 것)도 같은 이유로 던진다.
 * 조용히 무시하면 부르는 쪽은 스톱을 걸었다고 믿는다.
 *
 * ## 단가를 비우는 자리는 빈 문자열이 아니라 `'0'`이다
 *
 * 공식 예제 715행: *"장전 시간외, 장후 시간외, 시장가의 경우 1주당 가격을 공란으로
 * 비우지 않음 `0`으로 입력 권고"*. 판정은 `usesZeroPrice`가 한다.
 */

import type { OrderSide } from '@invest/shared';

import { needsConditionPrice, STOP_LIMIT_ORDER_DIVISION, usesZeroPrice } from './orderDivisions.js';
import { venueAcceptsStopLimit, type OrderVenue } from './orderVenues.js';

export interface OrderCashInput {
  /** 계좌번호 앞 8자리 */
  cano: string;
  /** 상품코드 2자리 */
  productCode: string;
  symbol: string;
  side: OrderSide;
  /** `ORD_DVSN`. 호출부가 이미 정해서 넘긴다 */
  division: string;
  quantity: number;
  /** 지정가. 단가를 비우는 주문구분에는 쓰이지 않는다 */
  limitPrice?: number;
  venue: OrderVenue;
  /** 스톱가(`CNDT_PRIC`). **스톱지정가일 때만** 온다 */
  conditionPrice?: number;
}

/** 못 보내는 이유를 말할 때 앞에 붙인다. 보내기 전에 멈췄다는 사실이 먼저다. */
const NOT_SENT = '주문을 보내지 않았습니다:';

/**
 * 스톱지정가의 짝이 맞는가. 안 맞으면 **보내기 전에** 던진다.
 *
 * 던지는 자리가 중요하다 — 보낸 뒤에 거절을 읽으면 이미 그 서버에 흔적이 남고,
 * 접수돼 버리면 되돌릴 방법이 주문 취소밖에 없다(`assertVenueUsable`과 같은 이유다).
 */
export function assertStopLimitPair(input: {
  division: string;
  conditionPrice?: number;
  limitPrice?: number;
  venue: OrderVenue;
}): void {
  const isStopLimit = needsConditionPrice(input.division);

  if (!isStopLimit) {
    if (input.conditionPrice !== undefined) {
      throw new Error(
        `${NOT_SENT} 조건가격은 스톱지정가(주문구분 ${STOP_LIMIT_ORDER_DIVISION})에만 쓰입니다`
        + ` — 주문구분 ${input.division}으로는 그 값이 사라집니다.`
        + ' 스톱을 걸려면 주문구분을 바꾸고, 아니면 조건가격을 빼세요.',
      );
    }
    return;
  }

  /*
   * SOR은 `OrderVenue` 타입에 아직 없지만 표는 그 값도 알고 있다. 타입이 넓어지는
   * 날에도 이 검사가 남아 있어야 스톱지정가가 함께 새어 나가지 않는다.
   */
  if (!venueAcceptsStopLimit(input.venue)) {
    throw new Error(
      `${NOT_SENT} ${input.venue}는 스톱지정가(주문구분 ${STOP_LIMIT_ORDER_DIVISION})를 받지 않습니다.`
      + ' KRX 또는 NXT로 보내세요.',
    );
  }
  if (!isPositivePrice(input.conditionPrice)) {
    throw new Error(
      `${NOT_SENT} 스톱지정가(주문구분 ${STOP_LIMIT_ORDER_DIVISION})에는 조건가격이 필요합니다`
      + ' — 값이 없으면 거래소가 거절합니다.',
    );
  }
  /*
   * 스톱가에 닿았을 때 **얼마에** 낼지가 지정가다. 없으면 `ORD_UNPR`이 `'0'`으로
   * 나가는데, 그건 스톱지정가가 아니라 값이 빠진 주문이다.
   */
  if (!isPositivePrice(input.limitPrice)) {
    throw new Error(
      `${NOT_SENT} 스톱지정가(주문구분 ${STOP_LIMIT_ORDER_DIVISION})에는 지정가도 필요합니다`
      + ' — 스톱가에 닿았을 때 얼마에 낼지가 정해지지 않습니다.',
    );
  }
}

/**
 * 현금 주문 본문. 값이 어긋나면 조립하지 않고 던진다.
 *
 * 반환값의 키는 KIS 스펙 그대로다 — 이 모듈이 `kis/` 안에 있는 이유이고,
 * 바깥으로는 이 모양이 나가지 않는다.
 */
export function orderCashPayload(input: OrderCashInput): Record<string, string> {
  assertStopLimitPair(input);

  const isBuy = input.side === 'buy';
  return {
    CANO: input.cano,
    ACNT_PRDT_CD: input.productCode,
    PDNO: input.symbol,
    ORD_DVSN: input.division,
    ORD_QTY: String(Math.floor(input.quantity)),
    ORD_UNPR: usesZeroPrice(input.division) ? '0' : String(Math.floor(input.limitPrice ?? 0)),
    EXCG_ID_DVSN_CD: input.venue,
    // 매도에만 매도유형(01 일반매도)이 붙는다. 매수에는 빈 값이다.
    SLL_TYPE: isBuy ? '' : '01',
    /*
     * 조건가격. 스톱지정가가 아니면 **자리는 있고 값이 없다** — 필수 필드라
     * 빼면 안 되고, 값을 넣으면 위 가드가 이미 던졌다.
     */
    CNDT_PRIC: needsConditionPrice(input.division)
      ? String(Math.floor(input.conditionPrice ?? 0))
      : '',
  };
}

/** 가격으로 쓸 수 있는 값인가. `undefined`·`NaN`·0·음수를 한자리에서 거른다. */
function isPositivePrice(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
