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

/*
 * ── 호가 잔량 상한 (2026-08-03에 붙였다) ─────────────────────────────────
 *
 * 위 네 잣대는 전부 **돈**을 본다. 그런데 오늘 실측에서 진짜로 손해를 낸 것은
 * 돈이 아니라 **호가**였다. 경방 매도 1호가에 7주뿐인데 121주를 시장가로 던져
 * 체결가가 판정가보다 0.328% 위에서 나왔다.
 *
 * 예수금을 다 쓰려고 한도만 올리면 이 값이 그대로 커진다 — 1억을 8종목에
 * 나누면 종목당 1,250만원이고 경방이면 1,520주다.
 *
 * ★ **이 비율은 아직 안 쟀다.** 시장충격은 보통 주문/유동성의 제곱근에 비례한다고
 * 알려져 있지만 이 계좌·이 종목군에서 재 본 적이 없다. 10%는 "적게 사는 쪽으로
 * 틀리자"는 출발점이지 측정값이 아니다.
 *
 * 재려면 두 값이 함께 남아야 한다 — 주문 수량과 **그때의 총매도잔량**. 그래서
 * 러너가 그 둘을 회차 기록에 적는다. 몇 건 쌓이면 체결가 괴리와 맞춰 회귀할 수
 * 있고, 그때 이 상수를 잰 값으로 바꾼다. **그 전까지는 잰 값인 척하지 않는다.**
 */
export const MAX_ASK_DEPTH_SHARE = 0.1;

/** 수량을 무엇이 정했는지. 실행 기록에 그대로 적는다. */
export type BuySizeBound =
  | 'cash'
  | 'orderQuantity'
  | 'orderNotional'
  | 'dailyNotional'
  | 'askDepth'
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
  /**
   * 지금 쌓여 있는 총 매도잔량(주). **모르면 `undefined`다.**
   *
   * 멀티시세만 이 값을 준다(`totalAskQuantity`). 단건 시세·해외·선물로 받은
   * 종목은 값이 없는데, **모르는 것을 0으로 채우면 수량이 0이 되어 아무것도 못
   * 산다.** 모르면 이 잣대를 대지 않고 나머지 넷으로만 정한다 —
   * `knownRangeRate`·`hasEmptyOrderBook`이 모르는 값을 다루는 방식과 같다.
   */
  totalAskQuantity?: number;
}

export interface BuySize {
  quantity: number;
  boundBy: BuySizeBound;
  /**
   * 이 수량이 그때 총매도잔량의 몇 퍼센트였나. 모르면 `undefined`.
   * 상한을 나중에 실측으로 바꾸려면 이 값이 기록에 남아 있어야 한다.
   */
  askDepthShare?: number;
}

/*
 * 값이 같을 때 무엇이 정했다고 적을지.
 *
 * 현금을 **맨 뒤**에 둔다. 현금과 한도가 똑같이 걸렸는데 "현금이 정했다"고
 * 적으면 룰은 관계없다는 뜻으로 읽히고, 그러면 한도를 손볼 생각을 못 한다.
 * 반대는 그렇지 않다 — 한도라고 적어 두면 현금도 함께 확인하게 된다.
 */
const BOUND_PRIORITY: BuySizeBound[] = [
  'askDepth',
  'orderQuantity',
  'orderNotional',
  'dailyNotional',
  'cash',
];

export function buyQuantityWithinRules(input: BuySizeInput): BuySize {
  const { cash, price, totalAskQuantity } = input;
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
    /*
     * 잔량을 모르면 이 잣대를 대지 않는다. `Infinity`는 "상한 없음"이지
     * "무한히 살 수 있다"가 아니다 — 아래 `Math.min`에서 조용히 빠진다.
     */
    askDepth:
      totalAskQuantity !== undefined && Number.isFinite(totalAskQuantity) && totalAskQuantity >= 0
        ? Math.floor(totalAskQuantity * MAX_ASK_DEPTH_SHARE)
        : Number.POSITIVE_INFINITY,
  };

  const quantity = Math.max(0, Math.min(...Object.values(byBound)));
  const boundBy = BOUND_PRIORITY.find((bound) => byBound[bound as keyof typeof byBound] === quantity);
  /*
   * 상한이 걸렸든 아니든 **실제 비율을 남긴다.** 상한을 나중에 실측으로 바꾸려면
   * 걸리지 않은 주문의 비율도 있어야 한다 — 걸린 것만 모으면 표본이 10%에
   * 몰려 회귀가 안 된다.
   */
  const askDepthShare =
    totalAskQuantity !== undefined && totalAskQuantity > 0 ? quantity / totalAskQuantity : undefined;
  return { quantity, boundBy: boundBy ?? 'cash', askDepthShare };
}

/**
 * 지금 더 쓸 수 있는 현금.
 *
 * ── 왜 예수금을 그대로 쓰면 안 되나 (2026-08-03 실측) ────────────────────
 *
 * `cashBalance`는 예수금 총액(`dnca_tot_amt`, D+0)이라 **결제 전까지 줄지 않는다.**
 * 그날 6,862만원어치를 사고도 1억 그대로였다 — 러너에게는 하루 종일 현금이 안 준
 * 것으로 보이고, 그 값으로 수량을 정하면 있지도 않은 돈만큼 계속 살 수 있다고 믿는다.
 *
 * `settlementCash`(가수도정산금액, D+2)는 오늘 낸 주문이 빠진 값이다. 같은 시각
 * 실측에서 31,362,295원으로 `1억 − 매입 6,862만`과 맞았다.
 *
 * **모르면 예수금으로 내려간다.** 이 값을 안 주는 계좌·경로가 있는데 거기서 0으로
 * 두면 아무것도 못 산다. 내려갈 때 덜 정확해지는 것은 사실이고, 그건
 * `maxPositions`와 1회 금액 한도가 함께 막는다.
 */
export function spendableCash(snapshot: {
  cashBalance?: number;
  settlementCash?: number;
}): number {
  const settled = snapshot.settlementCash;
  // 음수는 이미 한도를 넘겨 쓴 것이다. 그대로 나누면 수량이 음수가 된다.
  if (settled !== undefined && Number.isFinite(settled)) return Math.max(0, settled);
  return Math.max(0, snapshot.cashBalance ?? 0);
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
    case 'askDepth':
      return `매도호가 잔량의 ${Math.round(MAX_ASK_DEPTH_SHARE * 100)}%가 정한 수량`;
    case 'unknownPrice':
      return '값을 알 수 없어 수량을 정하지 못함';
  }
}
