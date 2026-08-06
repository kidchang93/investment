/**
 * **지금 회의를 열어야 하는가.**
 *
 * ── 왜 (2026-08-06) ──────────────────────────────────────────────────────
 *
 * 정기 회의는 15분마다다. 그런데 15분은 급변에 늦다 — 보유 종목이 3% 빠지는 데
 * 1분이면 충분하고, 다음 회차까지 아무도 안 본다. 그래서 **사건이 나면 기다리지
 * 않고 연다.**
 *
 * ── ★ 기준선이 "직전 회의"인 이유 ────────────────────────────────────────
 *
 * 문턱을 **전일 종가 대비**로 잡으면 한 번 걸린 뒤 종일 걸려 있는다. 아침에
 * −2% 벌어지면 그 뒤로 하루 종일 "사건"이 되어 매 순간 깨우게 되고, 그건
 * 깨우지 않는 것과 같다 — 아무것도 구분하지 못한다.
 *
 * **직전 회의 이후 변화**로 재야 *"지난번 본 뒤로 크게 움직였다"*가 된다.
 * 회의가 열릴 때마다 기준선이 갱신되므로 같은 사건에 두 번 깨지 않는다.
 *
 * ── 순수 함수다 ──────────────────────────────────────────────────────────
 *
 * 그물을 타지 않는다. 부르는 쪽이 지금 값과 기준선을 넘긴다 — 판정에 조회
 * 실패나 시각이 섞이면 시험할 수 없다.
 */

/** 사용자가 정한 문턱 (2026-08-06). 바꾸려면 사용자에게 묻는다 */
export const TRIGGER_THRESHOLDS = {
  /** 보유 종목이 직전 회의 대비 이만큼 움직이면 (%) */
  positionMovePercent: 3,
  /** 지수가 직전 회의 대비 이만큼 움직이면 (%) */
  indexMovePercent: 1.5,
} as const;

export interface TriggerInput {
  /** 직전 회의 시점의 값들. 오늘 첫 회의면 `null` */
  reference: { kospi?: number; kosdaq?: number; prices: Record<string, number> } | null;
  now: {
    kospi?: number;
    kosdaq?: number;
    /** 보유 중인 종목만. 안 가진 것이 움직이는 것은 사건이 아니다 */
    prices: Record<string, number>;
  };
  /**
   * 직전 회의 이후 새로 생긴 체결·거절.
   *
   * 거절이 특히 급하다 — 2026-08-04에 거절 세 번으로 판단자가 멈췄다.
   * 체결도 사건이다: 자리가 찼으니 다음 수를 정해야 한다.
   */
  newFills: Array<{ symbol: string; side: 'buy' | 'sell'; status: string }>;
}

export interface TriggerVerdict {
  /** 지금 회의를 열어야 하나 */
  fire: boolean;
  /** 왜. 여러 개면 전부 적는다 — 하나만 적으면 나머지를 놓친다 */
  reasons: string[];
}

/** 두 값의 변화율(%). 기준이 0이거나 없으면 `undefined` — 0으로 나누지 않는다 */
function movePercent(from: number | undefined, to: number | undefined): number | undefined {
  if (from === undefined || to === undefined) return undefined;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return undefined;
  return (to / from - 1) * 100;
}

export function checkDeliberationTrigger(input: TriggerInput): TriggerVerdict {
  const reasons: string[] = [];

  /*
   * 체결·거절은 **기준선과 무관하게** 사건이다. 값이 안 움직여도 자리가 바뀌었다.
   */
  for (const fill of input.newFills) {
    const label = fill.side === 'buy' ? '매수' : '매도';
    reasons.push(
      fill.status === 'rejected' || fill.status === 'canceled'
        ? `★ ${fill.symbol} ${label} ${fill.status === 'rejected' ? '거절' : '취소'}됨`
        : `${fill.symbol} ${label} 체결됨`,
    );
  }

  /*
   * 오늘 첫 회의면 기준선이 없다. **그렇다고 사건으로 치지 않는다** —
   * 첫 회의는 정기 회차가 연다. 여기서 열면 매 폴링마다 열린다.
   */
  if (input.reference === null) {
    return { fire: reasons.length > 0, reasons };
  }

  for (const [symbol, price] of Object.entries(input.now.prices)) {
    const move = movePercent(input.reference.prices[symbol], price);
    // 기준선에 없는 종목은 직전 회의 때 안 갖고 있던 것이다. 비교할 대상이 없다.
    if (move === undefined) continue;
    if (Math.abs(move) >= TRIGGER_THRESHOLDS.positionMovePercent) {
      reasons.push(`보유 ${symbol} ${move >= 0 ? '+' : ''}${move.toFixed(2)}% (직전 회의 대비)`);
    }
  }

  for (const [key, label] of [['kospi', '코스피'], ['kosdaq', '코스닥']] as const) {
    const move = movePercent(input.reference[key], input.now[key]);
    if (move === undefined) continue;
    if (Math.abs(move) >= TRIGGER_THRESHOLDS.indexMovePercent) {
      reasons.push(`${label} ${move >= 0 ? '+' : ''}${move.toFixed(2)}% (직전 회의 대비)`);
    }
  }

  return { fire: reasons.length > 0, reasons };
}
