/**
 * 최소 보유 시간 — 산 지 N분이 안 지났으면 매도 신호를 그 회차에 내지 않는다.
 *
 * 네트워크·DB를 타지 않는 순수 계산만 둔다. 여기 판정이 곧 "러너가 언제 팔지
 * 않기로 하는가"라서, 실계좌를 띄우지 않고 시험으로 덮을 수 있어야 한다
 * (`runCandles.ts`·`measurementSample.ts`와 같은 방식). 시각은 인자로 받는다 —
 * 시계를 갈아 끼우지 않고 경계를 잰다.
 *
 * ── 근거는 손익이 아니라 배관이다 ─────────────────────────────────────────
 *
 * 2026-08-01 측정(1분봉 축·15종목·연속 15거래일)에서 최소 보유는 손실을 줄이지만
 * **우위를 만들지 않았다.** 비용을 0으로 놓으면 개선이 사라지고 이익 종목이 오히려
 * 줄었다(7→3 · 6→3 · 10→5). 덜 잃는 법이지 이기는 법이 아니다.
 *
 * 이걸 거는 이유는 **일일 주문 한도**다. 같은 측정에서 종목 하나당 하루 주문 수는
 * 최소 보유 없음이 12.4 / 49.7 / 11.0건, 60분이면 5.0 / 7.6 / 5.3건, 120분이면
 * 3.6 / 4.3 / 3.7건이었다. 한도는 계좌 전체 합산 20건이고, 지금 구조로는 **매수가
 * 한도를 먼저 먹으면 그날 못 판다** — 시뮬에서 매도 65~2,219회가 막혔다.
 *
 * ── ★ 모르면 막지 않는다 ─────────────────────────────────────────────────
 *
 * 매수 기록이 없는 종목(러너를 켜기 전부터 들고 있던 것)은 **그대로 판다.**
 * 이 레포의 다른 안전장치는 모를 때 막힌 쪽에 두는데(게이트·개장일·자동매매 상태)
 * 여기는 **반대 방향**이다. 이유는 하나다 — 이 레포의 원칙이 「나가는 문이 들어오는
 * 문보다 앞」(`runCandles.ts`)이고, 못 파는 쪽이 훨씬 위험하기 때문이다. 막는 쪽에
 * 두면 매수 기록을 못 찾는 종목이 영영 갇힌다.
 *
 * ── 매수는 막지 않는다 ───────────────────────────────────────────────────
 *
 * 최소 보유는 **매도에만** 건다. 매수 신호는 이 판정을 통째로 지나간다.
 */

import type { OrderSide } from '@invest/shared';

/** 왜 팔았거나 왜 미뤘는지. 실행 기록에 남는 문구가 여기서 나온다. */
export type MinHoldReason =
  /** 매수 신호다. 최소 보유는 매도에만 건다 */
  | 'notSell'
  /** 최소 보유가 0분(끔)이다 */
  | 'disabled'
  /**
   * 산 지 얼마나 됐는지 잴 수 없다 — 매수 기록이 없거나 시각을 읽을 수 없다.
   * **막지 않는다** (위 ★ 참고). 이름은 잰 사실까지만 적는다: 기록이 없는 것인지
   * 다른 앱으로 산 것인지는 여기서 알 수 없다
   */
  | 'unknownBuyTime'
  /** 최소 보유를 채웠다 */
  | 'satisfied'
  /** 아직 안 지났다. 이번 회차에는 팔지 않는다 */
  | 'tooSoon';

export interface MinHoldDecision {
  /** true면 이번 회차에 이 매도 신호를 내지 않는다 */
  defer: boolean;
  reason: MinHoldReason;
  /** `tooSoon`일 때만: 산 지 몇 분 지났나 (내림, 음수는 0) */
  heldMinutes?: number;
  /** `tooSoon`일 때만: 몇 분 더 있어야 팔 수 있나 (올림이라 최소 1) */
  remainingMinutes?: number;
}

export interface MinHoldInput {
  side: OrderSide;
  /** `AutoTraderConfig.minHoldMinutes`. 0·음수·NaN이면 끈 것으로 본다 */
  minHoldMinutes: number;
  /**
   * 그 계좌·그 종목의 **마지막 매수 접수 시각**(epoch ms). 모르면 `undefined`다.
   *
   * KIS 잔고에는 매수 시각이 없어 `trading_broker_orders.created_at`에서 온다.
   * 러너가 재시작해도 남고 수동으로 산 것도 잡힌다. 대신 그 표에 없는 매수
   * (러너를 켜기 전부터 들고 있던 것, 다른 앱으로 산 것)는 알 수 없다.
   */
  boughtAtMs: number | undefined;
  /** 판정 시각(epoch ms). 인자로 받아 시계를 갈아 끼우지 않는다 */
  nowMs: number;
}

const MS_PER_MINUTE = 60_000;

/** 최소 보유가 켜져 있는 값인지. 0·음수·NaN은 전부 끈 것이다. */
function holdMinutes(minHoldMinutes: number): number {
  if (!Number.isFinite(minHoldMinutes) || minHoldMinutes <= 0) return 0;
  return minHoldMinutes;
}

/**
 * 이번 회차에 이 신호를 낼 수 있는지.
 *
 * 순서가 계약이다 — **매수 확인이 맨 앞**이라 다른 어떤 값이 와도 매수는 막히지
 * 않는다. 그다음이 끔(0), 그다음이 "잴 수 없음"이다.
 */
export function checkMinHold(input: MinHoldInput): MinHoldDecision {
  if (input.side !== 'sell') return { defer: false, reason: 'notSell' };

  const required = holdMinutes(input.minHoldMinutes);
  if (required === 0) return { defer: false, reason: 'disabled' };

  const boughtAt = input.boughtAtMs;
  if (boughtAt === undefined || !Number.isFinite(boughtAt) || !Number.isFinite(input.nowMs)) {
    return { defer: false, reason: 'unknownBuyTime' };
  }

  const elapsedMs = input.nowMs - boughtAt;
  const requiredMs = required * MS_PER_MINUTE;
  // 경계는 통과다 — 정확히 N분이 지났으면 팔 수 있다.
  if (elapsedMs >= requiredMs) return { defer: false, reason: 'satisfied' };

  return {
    defer: true,
    reason: 'tooSoon',
    // 시계가 어긋나 매수 시각이 미래로 오면 경과는 음수다. 0으로 적되 막는 쪽에 둔다 —
    // 이 경우는 "방금 샀다"에 가깝지 "모른다"가 아니다.
    heldMinutes: Math.max(0, Math.floor(elapsedMs / MS_PER_MINUTE)),
    remainingMinutes: Math.ceil((requiredMs - elapsedMs) / MS_PER_MINUTE),
  };
}

/**
 * 보류를 실행 기록 한 줄로 적는다. `tooSoon`이 아니면 빈 문자열이다.
 *
 * 보간한 값 바로 뒤에 조사를 붙이지 않는다(`docs/CODE_STYLE.md`) — 숫자 뒤에는 늘
 * `분`이 오므로 그다음 조사가 값에 따라 흔들리지 않는다. 종목명은 호출부가 앞에
 * 붙인다 — 이름은 무엇으로 끝날지 알 수 없어 문장 안에 넣지 않는다.
 */
export function describeMinHoldDefer(decision: MinHoldDecision, minHoldMinutes: number): string {
  if (decision.reason !== 'tooSoon') return '';
  const required = holdMinutes(minHoldMinutes);
  return (
    `최소 보유 ${required}분을 채우지 못해 이번 회차에는 팔지 않습니다`
    + ` · 산 지 ${decision.heldMinutes ?? 0}분 · 남은 시간 ${decision.remainingMinutes ?? 0}분`
  );
}

/** 설정값을 사람이 읽는 말로. 시작 기록과 화면이 같은 말을 쓴다. */
export function describeMinHoldSetting(minHoldMinutes: number): string {
  const required = holdMinutes(minHoldMinutes);
  return required === 0 ? '최소 보유 없음' : `최소 보유 ${required}분`;
}
