/**
 * 매수 수량을 **리스크 룰 안에서** 정한다.
 *
 * ── 왜 필요했나 (2026-08-03 모의계좌 장중 실측) ───────────────────────────
 *
 * 러너는 매수 수량을 `Math.floor(cash / price)`로 정했다. 늘 전액이다. 그런데
 * 리스크 룰은 1회 100만원·일일 500만원이라, 예수금 1억인 계좌에서는 **신호가
 * 날 때마다 자기 안전장치에 100% 걸렸다.**
 *
 *   09:36:53 RISE 바이오TOP10액티브 매수 차단
 *     · 1회 주문 수량 한도 1,000주를 초과합니다
 *     · 1회 주문 금액 한도 1,000,000원을 초과합니다
 *     · 일일 주문 금액 한도 5,000,000원을 초과합니다 (오늘 0원)
 *
 * 세 잣대에 동시에 걸린다. 즉 이 계좌에서 러너는 **주문을 낼 수 없는 구조**였다.
 * 그날 처음 난 신호가 그대로 증거다.
 *
 * ── 고치는 방향: 룰을 키우지 않고 러너를 맞춘다 ───────────────────────────
 *
 * 룰을 계좌 규모에 맞춰 올리는 길도 있지만 방향이 거꾸로다. 룰은 안전장치이고,
 * 안전장치에 맞춰 러너가 움직여야 한다. 반대로 하면 러너가 하려는 것에 맞춰
 * 한도가 계속 밀려나고 한도는 이름만 남는다.
 *
 * 여기서 정한 수량은 **한도를 넘지 않을 뿐 통과를 보장하지 않는다.** 일일 건수
 * 한도·시장가 금지·휴장일처럼 수량과 무관한 잣대는 그대로 `checkRiskRules`가
 * 판정한다. 같은 판정을 두 곳에 두지 않는다.
 */

/** 수량을 무엇이 정했는지. 실행 기록에 그대로 적는다. */
export type BuySizeBound =
  | 'cash'
  | 'orderQuantity'
  | 'orderNotional'
  | 'dailyNotional'
  | 'unknownPrice';

export interface BuySizeInput {
  /** 살 수 있는 현금 */
  cash: number;
  /** 1주 값. 시장가라 어림이지만 한도를 재는 잣대도 같은 값이다 */
  price: number;
  /** 리스크 룰: 1회 주문 수량 한도 */
  maxOrderQuantity: number;
  /** 리스크 룰: 1회 주문 금액 한도 */
  maxOrderNotional: number;
  /** 리스크 룰: 일일 주문 금액 한도 */
  dailyNotionalLimit: number;
  /** 오늘 이미 쓴 주문 금액 */
  usedNotional: number;
}

export interface BuySize {
  quantity: number;
  boundBy: BuySizeBound;
}

/*
 * 값이 같을 때 무엇이 정했다고 적을지.
 *
 * 현금을 **맨 뒤**에 둔다. 현금과 한도가 똑같이 걸렸는데 "현금이 정했다"고
 * 적으면 룰은 관계없다는 뜻으로 읽히고, 그러면 한도를 손볼 생각을 못 한다.
 * 반대는 그렇지 않다 — 한도라고 적어 두면 현금도 함께 확인하게 된다.
 */
const BOUND_PRIORITY: BuySizeBound[] = ['orderQuantity', 'orderNotional', 'dailyNotional', 'cash'];

export function buyQuantityWithinRules(input: BuySizeInput): BuySize {
  const { cash, price } = input;
  /*
   * 값을 모르면 수량도 없다. 예전 식은 `price`가 0이면 `Infinity`가 나왔고,
   * 그 값이 그대로 한도 검사로 넘어갔다.
   */
  if (!Number.isFinite(price) || price <= 0) return { quantity: 0, boundBy: 'unknownPrice' };

  // 이미 한도를 넘겨 썼으면 남은 금액은 0이다. 음수를 그대로 나누지 않는다.
  const remainingDaily = Math.max(0, input.dailyNotionalLimit - input.usedNotional);

  const byBound: Record<Exclude<BuySizeBound, 'unknownPrice'>, number> = {
    cash: Math.floor(cash / price),
    orderQuantity: Math.floor(input.maxOrderQuantity),
    orderNotional: Math.floor(input.maxOrderNotional / price),
    dailyNotional: Math.floor(remainingDaily / price),
  };

  const quantity = Math.max(0, Math.min(...Object.values(byBound)));
  const boundBy = BOUND_PRIORITY.find((bound) => byBound[bound as keyof typeof byBound] === quantity);
  return { quantity, boundBy: boundBy ?? 'cash' };
}

/** 수량을 무엇이 정했는지 사람이 읽을 한 조각. 실행 기록에 붙는다. */
export function describeBuySizeBound(bound: BuySizeBound): string {
  switch (bound) {
    case 'cash':
      return '현금이 정한 수량';
    case 'orderQuantity':
      return '1회 주문 수량 한도가 정한 수량';
    case 'orderNotional':
      return '1회 주문 금액 한도가 정한 수량';
    case 'dailyNotional':
      return '남은 일일 주문 금액이 정한 수량';
    case 'unknownPrice':
      return '값을 알 수 없어 수량을 정하지 못함';
  }
}
