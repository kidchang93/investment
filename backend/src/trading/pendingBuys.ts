/**
 * 아직 채워지지 않은 매수 주문을 골라낸다.
 *
 * ── 왜 필요했나 (2026-08-03 모의계좌 장중 실측) ───────────────────────────
 *
 * 러너가 경방(000050)을 **네 회차 연속으로 샀다.** `maxPositions`는 1이었다.
 *
 *   09:47:39 매수 121주 · 주문번호 0000010663
 *   09:48:33 매수 121주 · 주문번호 0000010740
 *   09:49:35 매수 121주 · 주문번호 0000010866
 *   09:50:36 매수 121주 · 주문번호 0000011013
 *
 * 전략은 보유 종목을 제대로 거른다 — 거를 것이 없었을 뿐이다. 보유는 KIS
 * **잔고**로 판단하는데, 접수된 주문이 잔고에 나타나기까지 그날 약 8분이
 * 걸렸다(09:47 접수 → 09:52 잔고 없음 → 09:56 484주). 그 사이 러너에게는
 * "아직 아무것도 안 샀다"로 보인다.
 *
 * 비싼 실수다. 네 건의 평균 체결가가 8,247 → 8,263 → 8,270 → 8,279원으로
 * 계단을 올라갔다. **자기 주문으로 자기 호가를 밀어 올렸다.**
 *
 * ── 시간 창으로 재지 않는다 ──────────────────────────────────────────────
 *
 * "최근 N분 안에 낸 주문"으로 잡으면 N을 정할 근거가 없고, 체결이 그날따라
 * 늦으면 그대로 뚫린다. 대신 KIS에게 **잔량이 남았는지**를 묻는다. 그건 추정이
 * 아니라 상태다.
 *
 * 잔고에 잡힌 뒤에는 여기서 빠지고 잔고 쪽이 이어받는다. 둘 사이에 몇 초쯤
 * 틈이 생길 수 있지만, 네 번 사던 것이 많아야 한 번 더가 된다.
 *
 * ── 판 종목을 막지 않는다 ────────────────────────────────────────────────
 *
 * "오늘 매수 주문을 낸 종목"으로 잡았다면 사고판 종목이 하루 종일 자리를
 * 차지한다. `maxPositions=1`이면 아침에 한 번 사고판 뒤 그날 매수가 통째로
 * 잠긴다 — 아무 기록도 남기지 않고. 잔량으로 재면 그 일이 없다.
 */

import type { BrokerExecution } from '@invest/shared';

/**
 * 아직 채워지지 않은 **매수** 주문의 종목코드.
 *
 * 매도는 세지 않는다. 이 판정이 막는 것은 "또 사는 것"이고, 매도 미체결은
 * 보유 수량으로 이미 잔고에 잡혀 있다.
 */
export function pendingBuySymbols(executions: BrokerExecution[]): Set<string> {
  const symbols = new Set<string>();
  for (const execution of executions) {
    if (execution.side !== 'buy') continue;
    /*
     * 취소·거부는 채워질 일이 없다. 그런데 `status`만 보면 부분체결 뒤 남은
     * 잔량을 놓치므로 **잔량을 함께 본다** — 상태 이름이 아니라 남은 수량이
     * "아직 올 것이 있나"의 답이다.
     */
    if (execution.status === 'canceled' || execution.status === 'rejected') continue;
    if (!(execution.remainQuantity > 0)) continue;
    symbols.add(execution.symbol);
  }
  return symbols;
}


/**
 * 아직 채워지지 않은 **매도** 주문의 종목별 잔량.
 *
 * ── 왜 필요했나 (2026-08-04 실측) ────────────────────────────────────────
 *
 * 매수 쪽은 어제 고쳤는데(`pendingBuySymbols`) **매도 쪽을 안 고쳤다.**
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
 * 매수는 "그 종목을 이미 샀나"만 알면 되지만(자리를 먹는지의 문제), 매도는
 * **얼마나 묶여 있는지**가 중요하다. 100주 중 40주만 매도 주문에 묶였으면
 * 나머지 60주는 아직 팔 수 있다.
 *
 * 부른 쪽이 보유 수량에서 이 값을 빼면 **팔 수 있는 수량**이 나오고, 그것이 0이면
 * `sellablePositions`가 알아서 매도 후보에서 뺀다 — 자리는 그대로 먹은 채로.
 */
export function pendingSellQuantities(executions: BrokerExecution[]): Map<string, number> {
  const bySymbol = new Map<string, number>();
  for (const execution of executions) {
    if (execution.side !== 'sell') continue;
    // 취소·거부는 물량을 묶지 않는다. 매수 쪽과 같은 판정이다.
    if (execution.status === 'canceled' || execution.status === 'rejected') continue;
    if (!(execution.remainQuantity > 0)) continue;
    bySymbol.set(execution.symbol, (bySymbol.get(execution.symbol) ?? 0) + execution.remainQuantity);
  }
  return bySymbol;
}