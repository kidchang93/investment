/**
 * 지금이 러너가 도는 시간대인가.
 *
 * ── 왜 필요했나 (2026-08-03) ──────────────────────────────────────────────
 *
 * 러너는 시간대 밖에서도 회차를 그대로 다 돌았다. 잔고·시세·분봉으로 **KIS를
 * 20여 회** 때리고 나서 마지막 문(리스크 룰)에서 막혔다. 마감(15:30) 뒤 15:31:43
 * 회차가 `후보 12종목`으로 멀쩡히 돌았다 — KIS는 마감 뒤에도 그날 분봉을 계속
 * 준다. 하루를 넘겨 켜 두면 밤새 120초마다 그 호출이 나간다.
 *
 * ── 시간대는 리스크 룰이 정한다 ───────────────────────────────────────────
 *
 * 러너가 자기 시간을 따로 들고 있으면 두 곳이 갈린다. 사용자가 시간대를 늘리면
 * (예: 시간외까지) 러너도 함께 늘어나야 하고, 좁히면 함께 좁아져야 한다.
 * 판정은 여기 하나뿐이고 값은 `RiskRuleSet.sessionStart`·`sessionEnd`가 준다.
 *
 * **이 함수는 "장이 열렸나"를 묻지 않는다.** 휴장일 판정은 KIS에게 묻는 일이고
 * (`chk-holiday`) 리스크 룰이 이미 그것을 본다. 여기는 시계만 본다 — 둘을 섞으면
 * 휴장일에 시계 조건이 통과해 버리거나 그 반대가 된다.
 */

import { KRX_SESSION_MINUTES } from '@invest/shared';

/** `HH:MM`을 자정부터의 분으로. 형식이 깨지면 null. */
export function sessionMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 지금이 KST 기준 몇 분인지. 서버 타임존과 무관해야 하므로 Intl로 뽑는다. */
export function kstMinutesOfDay(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

/**
 * 지금이 `start`~`end` 안인가. **양 끝을 포함한다.**
 *
 * 리스크 룰의 시간 판정(`checkRiskRules`)이 `now < start || now > end`로 막으므로
 * 여기도 같은 경계를 써야 한다. 여기서 한 칸 좁으면 러너가 쉬는 동안 룰은
 * 통과시키는 구간이 생기고, 넓으면 그 반대다.
 *
 * **형식이 깨졌으면 `true`를 돌려준다.** 여기서 막으면 설정 오타 하나로 러너가
 * 조용히 아무것도 안 하게 된다. 잘못된 시간 설정을 실제로 막는 것은 리스크 룰이고
 * (`거래 시간 설정이 올바르지 않습니다`) 그건 사유를 남긴다.
 */
export function withinSession(start: string, end: string, at: Date): boolean {
  const from = sessionMinutes(start);
  const to = sessionMinutes(end);
  if (from === null || to === null) return true;
  const now = kstMinutesOfDay(at);
  /*
   * 끝이 시작보다 앞이면 자정을 넘기는 구간이다. 국내 주식에는 없지만 사용자가
   * 적을 수 있고, 그때 조용히 "언제나 밖"이 되면 러너가 영영 안 돈다.
   */
  if (to < from) return now >= from || now <= to;
  return now >= from && now <= to;
}


/*
 * 장후 시간외 종가매매 창(15:40~16:00). KRX 운영시간이고 `probeSessions.ts`가
 * 같은 표를 들고 있다 — 값이 갈리지 않게 `KRX_SESSION_MINUTES`에서 가져온다.
 */
export function inAfterHoursCloseWindow(at: Date): boolean {
  const now = kstMinutesOfDay(at);
  return now >= KRX_SESSION_MINUTES.postOffHoursOpen && now < KRX_SESSION_MINUTES.singlePriceOpen;
}
