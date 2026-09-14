/**
 * KST 시계 계산. 리스크 룰의 거래 시간 판정(`db/riskRules.ts`)과 장중 수집 가드가
 * 같이 쓴다.
 *
 * **여기는 "장이 열렸나"를 묻지 않는다.** 휴장일 판정은 KIS에게 묻는 일이고
 * (`chk-holiday`) 리스크 룰이 이미 그것을 본다. 여기는 시계만 본다 — 둘을 섞으면
 * 휴장일에 시계 조건이 통과해 버리거나 그 반대가 된다.
 */

/** `HH:MM`을 자정부터의 분으로. 형식이 깨지면 null. */
export function sessionMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 지금이 KST 기준 자정부터 몇 초인지. 서버 타임존과 무관해야 하므로 Intl로 뽑는다. */
export function kstSecondsOfDay(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(values.hour) * 3600 + Number(values.minute) * 60 + Number(values.second);
}

/** 지금이 KST 기준 몇 분인지. */
export function kstMinutesOfDay(at: Date): number {
  return Math.floor(kstSecondsOfDay(at) / 60);
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
 * 리스크 룰의 값을 받지 않는다 — 이건 매매 판정이 아니라 "지금 KIS 유량을
 * 다투면 안 되는 시간인가"다.
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
