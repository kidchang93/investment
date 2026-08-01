/**
 * 오늘(KST) 접수된 실주문의 건수·금액 집계 — **순수 계산이라 DB를 부르지 않는다.**
 *
 * 질의(`riskRules.ts`)에서 떼어 둔 이유는 시험이다. `trading_broker_orders`에
 * `status='submitted'`인 행이 **0건**이라(2026-08-01 확인: 17행 전부 blocked·rejected)
 * DB를 조회해서는 이 계산이 맞는지 확인할 방법이 없다. `runCandles.ts`·`quoteCache.ts`와
 * 같은 방식으로, 재료를 인자로 받아 값으로 못 박는다.
 *
 * 여기서 못 박는 두 가지:
 *
 * 1. **시장가 주문에도 금액이 쌓인다.** 시장가에는 단가(`limit_price`)가 없다.
 *    예전에는 SQL이 `SUM(quantity * COALESCE(limit_price, 0))`이라 시장가 주문이
 *    **영원히 0원**으로 잡혔다 — 자동매매 러너는 항상 시장가라 일일 금액 한도에
 *    한 푼도 쌓이지 않았고, 잣대가 아예 작동하지 않았다. 건수 한도만 `COUNT(*)`라
 *    살아 있었다. 판정에 쓴 추정 단가(`estimated_price`)를 함께 남기고 그것으로 센다.
 * 2. **모르는 것은 0이 아니다.** 단가도 추정가도 없는 행은 합에서 빼고 건수로 따로
 *    센다. 0으로 더하면 "오늘 그만큼 안 썼다"는 사실이 지어지고 한도가 헐거워진다.
 *    이 레포는 `Number('')`이 0이 되어 "거래가 없었다"가 지어진 전례가 있다.
 */

import type { OrderType, RiskRuleSet } from '@invest/shared';

/** `numeric` 컬럼은 pg가 문자열로 준다. 계산 전에 한 곳에서 좁힌다. */
export type NumericLike = string | number | null | undefined;

/**
 * 금액 계산에 쓸 수 있는 양수만 통과시킨다.
 *
 * 빈 문자열을 그냥 `Number()`에 넣지 않는다 — `Number('')`은 `NaN`이 아니라 **0**이라
 * "값 없음"이 "0원"이 된다. 0·음수도 단가로 성립하지 않으므로 모름으로 본다.
 */
function positiveNumber(value: NumericLike): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/**
 * 주문 1건의 금액. **모르면 `undefined`다** — 0을 돌려주지 않는다.
 * 한도 판정은 이 값이 없으면 "확인할 수 없다"로 가야지 "0원 썼다"로 가면 안 된다.
 */
export function orderNotional(quantity: NumericLike, price: NumericLike): number | undefined {
  const shares = positiveNumber(quantity);
  const unitPrice = positiveNumber(price);
  if (shares === undefined || unitPrice === undefined) return undefined;
  return shares * unitPrice;
}

/** 일일 한도 집계에 넣을 주문 한 줄. `trading_broker_orders`에서 오늘 접수분만 골라 온다. */
export interface DailyOrderUsageRow {
  orderType: OrderType | null;
  quantity: NumericLike;
  /** 지정가 단가 */
  limitPrice: NumericLike;
  /** 시장가 주문의 판정 시점 추정 단가 */
  estimatedPrice: NumericLike;
}

export interface DailyOrderUsage {
  /** 오늘 접수된 건수. 금액을 몰라도 건수는 전부 센다 */
  count: number;
  /** 그중 금액을 아는 것들의 합 */
  notional: number;
  /** 금액을 알 수 없어 합에서 빠진 건수. 이 값이 0이 아니면 합은 **하한**일 뿐이다 */
  unpricedCount: number;
}

/**
 * 한도 판정에 쓸 단가.
 *
 * 시장가는 추정가, 지정가는 단가다. 한 행에 둘 다 있는 일은 없어야 하지만, 있으면
 * 그 주문 유형이 실제로 쓴 값을 우선한다.
 */
export function usageUnitPrice(row: DailyOrderUsageRow): number | undefined {
  const limitPrice = positiveNumber(row.limitPrice);
  const estimatedPrice = positiveNumber(row.estimatedPrice);
  return row.orderType === 'market' ? estimatedPrice ?? limitPrice : limitPrice ?? estimatedPrice;
}

export function summarizeDailyOrderUsage(rows: DailyOrderUsageRow[]): DailyOrderUsage {
  let notional = 0;
  let unpricedCount = 0;
  for (const row of rows) {
    const amount = orderNotional(row.quantity, usageUnitPrice(row));
    if (amount === undefined) unpricedCount += 1;
    else notional += amount;
  }
  return { count: rows.length, notional, unpricedCount };
}

/**
 * 일일 한도 판정. 오늘 쌓인 것에 이번 주문을 얹어 본다.
 *
 * `checkRiskRules`가 이 결과를 자기 사유 목록에 그대로 붙인다. 판정을 떼어 둔 이유는
 * 집계와 같다 — 오늘 얼마나 썼는지는 화면으로도 DB로도 태울 수 없어 시험으로만 잰다.
 */
export function dailyLimitViolations(input: {
  rules: Pick<RiskRuleSet, 'dailyOrderCountLimit' | 'dailyNotionalLimit'>;
  usage: DailyOrderUsage;
  /** 지금 내려는 주문의 금액. 모르면 `undefined` — 0으로 채우지 않는다 */
  notional: number | undefined;
}): string[] {
  const { rules, usage, notional } = input;
  const violations: string[] = [];

  if (usage.count + 1 > rules.dailyOrderCountLimit) {
    violations.push(`일일 주문 건수 한도 ${rules.dailyOrderCountLimit}건을 초과합니다 (오늘 ${usage.count}건).`);
  }
  if (notional !== undefined && usage.notional + notional > rules.dailyNotionalLimit) {
    violations.push(
      `일일 주문 금액 한도 ${rules.dailyNotionalLimit.toLocaleString('ko-KR')}원을 초과합니다 ` +
        `(오늘 ${usage.notional.toLocaleString('ko-KR')}원).`,
    );
  }
  /*
   * 금액을 알 수 없는 접수 건이 있으면 위 합은 **하한**일 뿐이다. 0으로 세면 한도가
   * 조용히 헐거워지므로 모르는 동안에는 막힌 쪽에 둔다 — 개장일을 확인 못 했을 때와 같다.
   */
  if (usage.unpricedCount > 0) {
    violations.push(
      '오늘 접수된 주문 중 금액을 알 수 없는 건이 있어 일일 금액 한도를 확인할 수 없습니다 ' +
        `(${usage.unpricedCount}건).`,
    );
  }
  return violations;
}
