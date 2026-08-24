/**
 * **전략을 언제 바꿀 수 있고 언제 되돌려야 하는가.** 순수 함수다 — 그물도 DB도 안 탄다.
 *
 * 규율 전체는 `docs/STRATEGY_DISCIPLINE.md`에 있다. 여기는 그중 **판정** 둘만 맡는다:
 *
 *   canChangeNow()   지금 바꿀 수 있나 (동결 기간)
 *   judgeOutcome()   관찰이 끝났나 · 예측을 넘겼나 · 되돌려야 하나
 *
 * ── 왜 함수로 빼나 (2026-08-24) ──────────────────────────────────────────
 *
 * 이 판정을 스크립트 안에 두면 시험할 수 없고, **시험할 수 없는 판정이 전략을
 * 바꾼다.** 그리고 이 판정은 성격상 어길 유혹이 크다 — 성과가 나쁠 때 "조금만 더
 * 지켜보자"가 늘 그럴듯해 보인다. 값으로 못 박아 둬야 그 유혹이 코드 밖에 남는다.
 */

/** 바꾸기 전에 적는 예측. 없으면 나중에 결과에 맞춰 이야기를 붙이게 된다 */
export interface StrategyPrediction {
  /** 무엇으로 잴 것인가. 예: `단기 층 실현손익` */
  metric: string;
  /** 관찰이 끝났을 때 이 값을 넘겨야 유지된다 */
  expected: number;
  /** 관찰 기간(거래일) */
  horizonDays: number;
}

export interface StrategyVersionState {
  id: number;
  /** 활성화된 날 (`YYYY-MM-DD`, Asia/Seoul) */
  activeFrom: string;
  /** 이 날까지는 못 바꾼다 (`YYYY-MM-DD`). 활성화일 + 동결 거래일 */
  freezeUntil: string;
  prediction: StrategyPrediction;
  /** 되돌릴 대상. 첫 버전은 없다 */
  previousId?: number;
}

/**
 * ★ **동결 기간은 파라미터가 아니다.**
 *
 * 바꿀 수 있게 하면 불리할 때마다 줄이게 되고, 그러면 동결이 없는 것과 같다.
 * 20거래일인 이유는 `docs/STRATEGY_DISCIPLINE.md`에 적었다 — 보유 지평(5~10거래일)이
 * 최소 2회전 돌고, 시장 국면이 크게 바뀌지 않는 길이다.
 */
export const FREEZE_TRADING_DAYS = 20;

export type ChangeVerdict =
  | { ok: true }
  | { ok: false; why: string; unfreezesOn: string };

/**
 * 지금 전략을 바꿀 수 있나.
 *
 * @param current 지금 도는 버전. 없으면(첫 버전) 언제나 바꿀 수 있다
 * @param today   `YYYY-MM-DD` (Asia/Seoul)
 */
export function canChangeNow(
  current: StrategyVersionState | null,
  today: string,
): ChangeVerdict {
  if (!current) return { ok: true };
  if (today > current.freezeUntil) return { ok: true };
  return {
    ok: false,
    why:
      `버전 ${current.id}이 ${current.freezeUntil}까지 동결이다.`
      + ' 관찰이 끝나기 전에 바꾸면 이 전략의 표본이 영영 안 쌓인다 —'
      + ' 오늘 본 것은 기록만 하고 그날 제안한다.',
    unfreezesOn: current.freezeUntil,
  };
}

export type OutcomeVerdict =
  | { state: 'observing'; why: string }
  | { state: 'keep'; why: string }
  | { state: 'revert'; why: string; revertTo?: number };

/**
 * 관찰이 끝났으면 유지할지 되돌릴지 판정한다.
 *
 * ★ **되돌리기는 판단이 아니라 규칙이다.** *"조금만 더 지켜보자"*를 허용하면 진
 *   전략이 영원히 안 죽는다 — 그게 매일 바뀌는 것만큼 나쁘다.
 *
 * @param actual 관찰 기간 동안 실제로 나온 지표값. 아직 못 재면 `null`
 */
export function judgeOutcome(
  current: StrategyVersionState,
  today: string,
  actual: number | null,
): OutcomeVerdict {
  if (today <= current.freezeUntil) {
    return {
      state: 'observing',
      why: `${current.freezeUntil}까지 관찰 중이다. 손대지 않는다.`,
    };
  }
  /*
   * ★ **못 쟀으면 되돌린다.** "판정 불가"를 유지로 읽으면, 지표를 못 재는 상태가
   *   이어질 때 진 전략이 계속 돈다. 안전한 쪽은 직전 버전이다.
   */
  if (actual === null || !Number.isFinite(actual)) {
    return {
      state: 'revert',
      why:
        `${current.prediction.metric}를 재지 못했다.`
        + ' 판정할 수 없으면 유지가 아니라 되돌리기다 — 못 재는 채로 도는 전략이 더 위험하다.',
      revertTo: current.previousId,
    };
  }
  if (actual >= current.prediction.expected) {
    return {
      state: 'keep',
      why:
        `${current.prediction.metric} ${actual} ≥ 예측 ${current.prediction.expected}.`
        + ' 유지하고 다음 제안을 받는다.',
    };
  }
  return {
    state: 'revert',
    why:
      `${current.prediction.metric} ${actual} < 예측 ${current.prediction.expected}.`
      + ' 예측에 못 미쳤으므로 규칙대로 되돌린다.',
    revertTo: current.previousId,
  };
}

/**
 * 활성화일로부터 동결이 끝나는 날.
 *
 * ★ **달력일이 아니라 거래일로 센다.** 달력으로 세면 연휴가 낀 달의 동결이 실제로는
 *   짧아진다 — 표본은 장이 열린 날에만 쌓인다.
 *
 * @param tradingDays 활성화일 **다음** 거래일부터 오름차순. 달력을 만들지 않고
 *                    부르는 쪽이 넘긴다(휴장일은 DB의 일봉이 안다)
 */
export function freezeEndDay(tradingDays: string[], days = FREEZE_TRADING_DAYS): string | null {
  if (days <= 0) return null;
  // 남은 거래일이 모자라면 동결 끝을 정할 수 없다 — 아직 미래를 모르는 것이다.
  if (tradingDays.length < days) return null;
  return tradingDays[days - 1];
}
