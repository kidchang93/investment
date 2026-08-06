/**
 * **주문 하나가 계좌 상태에 비추어 나가도 되는가.**
 *
 * ── 왜 생겼나 (2026-08-05) ───────────────────────────────────────────────
 *
 * 판단자가 러너(알고리즘)에서 **에이전트**로 옮겨간다. 그런데 러너를 끄면
 * **러너 안에만 있던 보호 넷이 함께 사라진다.** 그중 둘은 이번 주에 실제로
 * 돈을 잃은 버그다.
 *
 *   미체결 매도 추적   8/4 15:21 매도 뒤 잔고가 안 줄어 같은 종목을 세 번 더
 *                      팔려 했고 `40240000` 세 번에 **마감 3분 전 러너가 죽었다**
 *   매수 수량 산정     8/3 현금 전액을 한 종목에 넣었다
 *   최소 보유 시간     사자마자 팔아 비용만 쌓인다
 *   최대 보유 종목 수  자리 개념이 사라진다
 *
 * `checkRiskRules`는 이것들을 못 본다 — DB의 룰과 주문 한 건만 보고, **지금
 * 무엇을 들고 있는지**를 모른다. 그래서 계좌 상태가 필요한 판정을 여기 모은다.
 *
 * ── 이 모듈이 지키는 것 ──────────────────────────────────────────────────
 *
 * **순수 함수다.** 그물을 타지 않는다 — 부르는 쪽이 상태를 넘긴다. 판정 로직에
 * 조회 실패나 시각 의존이 섞이면 시험할 수 없고, 시험할 수 없는 안전장치는
 * 안전장치가 아니다.
 *
 * **누가 부르든 같은 답이어야 한다.** 러너든 에이전트든 사람이든 같은 관문을
 * 지난다. 경로마다 따로 구현하면 한쪽만 고치는 일이 반드시 생긴다 — 이번 주에
 * 같은 착각을 네 번 고쳤다.
 *
 * ── 규칙 하나 ────────────────────────────────────────────────────────────
 *
 * **안전장치는 들어가는 것을 막지 나오는 것을 막지 않는다.** 매도를 막으면
 * 종목이 갇히고 위험이 줄지 않는다. 여기서 매도를 막는 경우는 둘뿐이고 둘 다
 * "팔 수 없어서"다 — 물량이 없거나, 이미 그 물량에 매도가 나가 있거나.
 */

import type { BrokerExecution, OrderSide } from '@invest/shared';

import { checkMinHold } from './minHold.js';
import { pendingSellQuantities } from './pendingBuys.js';

export interface PositionGuardInput {
  symbol: string;
  side: OrderSide;
  quantity: number;
  /** 판정 시각. 최소 보유 시간에 쓴다 */
  nowMs: number;

  /** 지금 보유. 수량이 0인 종목은 넣지 않는다 */
  positions: Array<{ symbol: string; quantity: number }>;
  /** 오늘 체결·미체결 내역. **미체결 매도**를 여기서 센다 */
  executions: BrokerExecution[];
  /** 종목별 매수 시각(ms). 모르면 넣지 않는다 — 모르는 것을 0으로 채우지 않는다 */
  boughtAtBySymbol: Map<string, number>;

  /** 동시에 들 수 있는 종목 수. 0 이하면 검사하지 않는다 */
  maxPositions: number;
  /** 산 지 이만큼 안 지났으면 매도를 미룬다. 0이면 끔 */
  minHoldMinutes: number;

  /**
   * 지금 평가금액과 **중단선**. 둘 다 있을 때만 하드 스톱이 걸린다.
   *
   * 러너를 끄면 중단선도 함께 사라진다. 무인으로 도는 계좌에 바닥이 없으면
   * 아무도 안 보는 사이 얼마든지 내려간다 — 그래서 관문으로 옮긴다.
   */
  equity?: number;
  stopEquity?: number;
}

export interface PositionGuardVerdict {
  allowed: boolean;
  violations: string[];
}

/**
 * 팔 수 있는 수량 — 보유에서 **이미 매도가 나가 있는 물량**을 뺀 것.
 *
 * 잔고는 체결이 반영될 때까지 안 줄어든다. 그 사이 잔고만 보고 또 팔면 KIS가
 * `40240000`(잔고 없음)으로 거절하고, 그게 쌓이면 판단자가 죽는다.
 */
export function sellableQuantity(
  symbol: string,
  positions: Array<{ symbol: string; quantity: number }>,
  executions: BrokerExecution[],
): number {
  const held = positions.find((p) => p.symbol === symbol)?.quantity ?? 0;
  const pending = pendingSellQuantities(executions).get(symbol) ?? 0;
  return Math.max(0, held - pending);
}

export function checkPositionGuard(input: PositionGuardInput): PositionGuardVerdict {
  const violations: string[] = [];

  if (input.side === 'sell') {
    const sellable = sellableQuantity(input.symbol, input.positions, input.executions);
    if (sellable <= 0) {
      const held = input.positions.find((p) => p.symbol === input.symbol)?.quantity ?? 0;
      violations.push(
        held > 0
          ? `이미 매도 주문이 나가 있습니다 (보유 ${held}주, 남은 매도 가능 0주).`
          : '보유 수량이 없습니다.',
      );
    } else if (input.quantity > sellable) {
      violations.push(`매도 가능 수량 ${sellable}주를 초과합니다 (요청 ${input.quantity}주).`);
    }

    const hold = checkMinHold({
      side: 'sell',
      minHoldMinutes: input.minHoldMinutes,
      boughtAtMs: input.boughtAtBySymbol.get(input.symbol),
      nowMs: input.nowMs,
    });
    if (hold.defer) {
      violations.push(`최소 보유 ${input.minHoldMinutes}분이 안 지났습니다.`);
    }

    return { allowed: violations.length === 0, violations };
  }

  /*
   * ── 여기부터 매수 ────────────────────────────────────────────────────
   * 나오는 길은 위에서 끝났다. 아래 잣대는 **들어가는 것에만** 건다.
   */

  if (input.maxPositions > 0) {
    const holding = new Set(input.positions.filter((p) => p.quantity > 0).map((p) => p.symbol));
    // 이미 들고 있는 종목을 더 사는 것은 자리를 새로 먹지 않는다.
    if (!holding.has(input.symbol) && holding.size >= input.maxPositions) {
      violations.push(`보유 종목이 이미 ${holding.size}개입니다 (한도 ${input.maxPositions}개).`);
    }
  }

  /*
   * 하드 스톱. **정확히 같을 때도 막는다** — 중단선은 "여기까지"이지
   * "여기를 지나서"가 아니다. 경계에서 한 번 더 사면 그 한 번이 넘긴다.
   */
  if (
    input.stopEquity !== undefined
    && input.equity !== undefined
    && Number.isFinite(input.stopEquity)
    && Number.isFinite(input.equity)
    && input.equity <= input.stopEquity
  ) {
    violations.push(
      `중단선 ${input.stopEquity.toLocaleString('ko-KR')}원에 도달했습니다`
      + ` (현재 ${input.equity.toLocaleString('ko-KR')}원) — 매수를 막습니다.`,
    );
  }

  return { allowed: violations.length === 0, violations };
}
