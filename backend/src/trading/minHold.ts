/**
 * 최소 보유 시간 — 산 지 N분이 안 지났으면 매도를 미룬다.
 *
 * 서버 주문 경로의 포지션 관문(`positionGuard.ts`)이 **매도일 때만** 부른다.
 * 네트워크·DB를 타지 않는 순수 계산이고 시각은 인자로 받는다 — 시계를 갈아
 * 끼우지 않고 경계를 잰다.
 *
 * ── 근거는 손익이 아니라 배관이다 ─────────────────────────────────────────
 *
 * 2026-08-01 측정(1분봉 축·15종목·연속 15거래일)에서 최소 보유는 손실을 줄이지만
 * **우위를 만들지 않았다.** 비용을 0으로 놓으면 개선이 사라지고 이익 종목이 오히려
 * 줄었다(7→3 · 6→3 · 10→5). 덜 잃는 법이지 이기는 법이 아니다.
 *
 * 이걸 거는 이유는 **일일 주문 한도**다. 같은 측정에서 종목 하나당 하루 주문 수는
 * 최소 보유 없음이 12.4 / 49.7 / 11.0건, 60분이면 5.0 / 7.6 / 5.3건, 120분이면
 * 3.6 / 4.3 / 3.7건이었다. 한도는 계좌 전체 합산이고, 지금 구조로는 **매수가
 * 한도를 먼저 먹으면 그날 못 판다** — 시뮬에서 매도 65~2,219회가 막혔다.
 *
 * ── ★ 모르면 막지 않는다 ─────────────────────────────────────────────────
 *
 * 매수 기록이 없는 종목(주문 기록에 없는 매수, 다른 앱으로 산 것)은 **그대로 판다.**
 * 이 레포의 다른 안전장치는 모를 때 막힌 쪽에 두는데(게이트·개장일) 여기는
 * **반대 방향**이다. 나가는 문이 들어오는 문보다 앞이고, 못 파는 쪽이 훨씬
 * 위험하기 때문이다. 막는 쪽에 두면 매수 기록을 못 찾는 종목이 영영 갇힌다.
 */

export interface MinHoldInput {
  /** 계좌 룰의 `minHoldMinutes`. 0·음수·NaN이면 끈 것으로 본다 */
  minHoldMinutes: number;
  /**
   * 그 계좌·그 종목의 **마지막 매수 접수 시각**(epoch ms). 모르면 `undefined`다.
   *
   * KIS 잔고에는 매수 시각이 없어 `trading_broker_orders`에서 온다. 접수 시각이지
   * 체결 시각이 아니다.
   */
  boughtAtMs: number | undefined;
  /** 판정 시각(epoch ms) */
  nowMs: number;
}

const MS_PER_MINUTE = 60_000;

/**
 * true면 아직 N분이 안 지나 **이번에는 팔지 않는다.**
 *
 * 경계는 통과다 — 정확히 N분이 지났으면 판다. 시계가 어긋나 매수 시각이 미래로
 * 오면 경과가 음수라 막는다 — "모른다"가 아니라 "방금 샀다"에 가깝다.
 */
export function minHoldDefersSell(input: MinHoldInput): boolean {
  const { minHoldMinutes, boughtAtMs, nowMs } = input;
  if (!Number.isFinite(minHoldMinutes) || minHoldMinutes <= 0) return false;
  if (boughtAtMs === undefined || !Number.isFinite(boughtAtMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - boughtAtMs < minHoldMinutes * MS_PER_MINUTE;
}
