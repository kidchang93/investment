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

/**
 * 장이 열려 있는 동안인가. 열려 있으면 **막을 사유 문장**을, 아니면 null.
 *
 * ── 왜 (2026-08-18 실측) ────────────────────────────────────────────────
 *
 * 장중 13:50에 전 종목 일봉 수집(`collectDailyBars --refresh`)을 돌렸더니 5분
 * 만에 화면이 502를 받기 시작했다:
 *
 *     불러오지 못했습니다 — /api/trading/layers (502) · /api/trading/health (502)
 *
 * 수집이 1.2초마다 KIS를 두드리는데 그 유량을 잔고 조회와 나눠 쓴다. 화면이
 * 못 보는 것보다 나쁜 것은 **경보 확인이 같은 길을 쓴다**는 점이다 — 자동화가
 * 중단선과 장부 불일치를 못 보는 채로 세 시간이 지난다.
 *
 * ★ 구간은 **데몬이 도는 시간**과 같다(08:30 개장 전 준비 ~ 15:40 마감 정리).
 * `withinSession`과 달리 리스크 룰의 값을 받지 않는다 — 이건 매매 판정이 아니라
 * "지금 KIS 유량을 다투면 안 되는 시간인가"이고, 러너가 멈춰도 데몬은 돈다.
 *
 * ★ **휴장일은 보지 않는다.** 그날 장이 실제로 열렸는지는 KIS에게 물어야 알고
 * (`chk-holiday`), 여기서 섞으면 조회 하나 때문에 수집이 못 뜬다. 휴장일에
 * 하루 늦게 수집하는 쪽이 장중에 경보를 잃는 것보다 싸다.
 */
export function marketHoursBlock(at: Date): string | null {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'short' })
    .format(at);
  if (weekday === 'Sat' || weekday === 'Sun') return null;
  const now = kstMinutesOfDay(at);
  if (now < 8 * 60 + 30 || now >= 15 * 60 + 40) return null;
  const hh = String(Math.floor(now / 60)).padStart(2, '0');
  const mm = String(now % 60).padStart(2, '0');
  return `지금은 ${hh}:${mm} — 장이 열려 있는 동안입니다.`;
}
