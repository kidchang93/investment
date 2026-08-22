/**
 * **같은 경보를 되풀이해 울리지 않는다.** 순수 함수다 — 그물도 DB도 안 탄다.
 *
 * ── 왜 (2026-08-22) ──────────────────────────────────────────────────────
 *
 * 2026-08-21에 `장부와 잔고가 2종목 어긋난다` 경보 **하나**가 하루 **16번**
 * 울렸다. 데몬이 장중 20분마다 `checkAlerts --notify`를 부르고, 그때마다
 * macOS 알림이 소리(Basso)와 함께 떴다. 상태는 내내 그대로였다 — 새 소식은
 * 첫 번째 하나뿐이었고 나머지 열다섯은 같은 말이었다.
 *
 * ★ **그날 사용자가 데몬을 껐다.** `.zshrc`의 자동 시작도 함께 주석 처리했다.
 *   시끄러운 경보가 치른 값은 "짜증"이 아니라 **감시가 통째로 멈춘 것**이다.
 *   `checkAlerts`는 자기 파일에 *"늘 뜨는 알림은 안 읽힌다"*고 적어 두고 정작
 *   자신은 지키지 않고 있었다.
 *
 * ── 규칙 ─────────────────────────────────────────────────────────────────
 *
 * **같은 경보는 하루에 한 번만 알린다.** 내용이 바뀌면 그날 안이라도 다시
 * 알린다 — 어긋난 종목이 하나 늘었다는 것은 새 사실이기 때문이다.
 *
 * ★ 날이 바뀌면 다시 알린다. 어제 넘긴 문제가 오늘도 남아 있다는 것은
 *   **다시 말할 값어치가 있는 소식**이고, 하루 한 번은 사람을 안 지치게 한다.
 *
 * ★ 억제하는 것은 **알림뿐이다.** 경보 자체는 사라지지 않는다 — 부르는 쪽이
 *   보는 종료 코드도, 화면에 남는 줄도 그대로다. 조용해지는 것과 없어지는
 *   것은 다르다.
 */

/** 알림 이력에서 이 경보를 찾는 자리. 경보의 **종류**다 */
export interface AlertIdentity {
  /** 경보 종류. `layer-mismatch` 같은 고정 문자열 */
  key: string;
  /**
   * 내용의 정체성. 이 값이 바뀌면 상태가 달라진 것이라 다시 알린다.
   *
   * ★ **매번 달라지는 숫자를 넣지 않는다.** 중단선 경보에 자산 평가액을 넣으면
   *   시세가 움직일 때마다 digest가 바뀌어 억제가 한 번도 걸리지 않는다.
   *   담을 것은 *무엇이 문제인가*이지 *지금 얼마인가*가 아니다.
   */
  digest: string;
}

/** 마지막으로 알린 기록 */
export interface AlertNotice {
  digest: string;
  /** 알린 날 (`YYYY-MM-DD`, Asia/Seoul) */
  day: string;
}

export interface AlertSplit<T> {
  /** 지금 알릴 것 */
  fresh: T[];
  /** 오늘 이미 같은 내용으로 알린 것 */
  muted: T[];
}

/**
 * 알릴 것과 이미 알린 것을 가른다.
 *
 * @param seen  key → 마지막 알림. 없는 key는 한 번도 안 알린 것이다
 * @param today `YYYY-MM-DD` (Asia/Seoul)
 */
export function splitByNotice<T extends AlertIdentity>(
  alerts: T[],
  seen: Map<string, AlertNotice>,
  today: string,
): AlertSplit<T> {
  const fresh: T[] = [];
  const muted: T[] = [];
  for (const alert of alerts) {
    const last = seen.get(alert.key);
    if (last && last.day === today && last.digest === alert.digest) {
      muted.push(alert);
    } else {
      fresh.push(alert);
    }
  }
  return { fresh, muted };
}
