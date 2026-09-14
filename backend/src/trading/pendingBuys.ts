/**
 * 아직 채워지지 않은 주문이 묶고 있는 물량을 센다.
 *
 * ── 시간 창으로 재지 않는다 ──────────────────────────────────────────────
 *
 * "최근 N분 안에 낸 주문"으로 잡으면 N을 정할 근거가 없고, 체결이 그날따라
 * 늦으면 그대로 뚫린다. 대신 KIS에게 **잔량이 남았는지**를 묻는다. 그건 추정이
 * 아니라 상태다. 잔고에 반영된 뒤에는 여기서 빠지고 잔고 쪽이 이어받는다.
 */

import type { BrokerExecution } from '@invest/shared';

/**
 * 아직 채워지지 않은 **매도** 주문의 종목별 잔량.
 *
 * ── 왜 필요했나 (2026-08-04 실측) ────────────────────────────────────────
 *
 * 매수 쪽(같은 종목을 네 번 산 사고)은 어제 고쳤는데 **매도 쪽을 안 고쳤다.**
 * 그래서 거울 같은 사고가 그대로 났다.
 *
 *   15:21:41  SK텔레콤 매도 143주 접수
 *   15:22:59  회차 실패(1/3): 모의투자 잔고내역이 없습니다 (40240000)
 *   15:25:12  회차 실패(2/3)
 *   15:27:38  회차 실패(3/3) → 정지
 *
 * 매도가 나간 뒤 잔고가 아직 143주로 보여서 전략이 또 매도 신호를 냈고, KIS는
 * 그 물량이 이미 매도 주문에 묶여 있어 거절했다. **마감 3분 전에 러너가 죽었다.**
 *
 * ── 수량으로 돌려준다 ────────────────────────────────────────────────────
 *
 * 매도는 **얼마나 묶여 있는지**가 중요하다. 100주 중 40주만 매도 주문에
 * 묶였으면 나머지 60주는 아직 팔 수 있다.
 *
 * 부른 쪽(`positionGuard.ts`의 `sellableQuantity`)이 보유 수량에서 이 값을 빼면
 * **팔 수 있는 수량**이 나온다.
 */
export function pendingSellQuantities(executions: BrokerExecution[]): Map<string, number> {
  const bySymbol = new Map<string, number>();
  for (const execution of executions) {
    if (execution.side !== 'sell') continue;
    /*
     * 취소·거부는 물량을 묶지 않는다. 그런데 `status`만 보면 부분체결 뒤 남은
     * 잔량을 놓치므로 **잔량을 함께 본다** — 상태 이름이 아니라 남은 수량이
     * "아직 올 것이 있나"의 답이다.
     */
    if (execution.status === 'canceled' || execution.status === 'rejected') continue;
    if (!(execution.remainQuantity > 0)) continue;
    bySymbol.set(execution.symbol, (bySymbol.get(execution.symbol) ?? 0) + execution.remainQuantity);
  }
  return bySymbol;
}