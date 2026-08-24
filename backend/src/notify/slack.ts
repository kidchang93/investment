/**
 * 슬랙 Incoming Webhook으로 알린다. **맥 앞에 없어도 받는 유일한 길이다.**
 *
 * ── 왜 (2026-08-24) ──────────────────────────────────────────────────────
 *
 * 지금까지 알림은 `osascript`(macOS 알림 센터) 하나뿐이었다. 그런데 이 시스템은
 * **사용자의 맥에서만** 돈다 — 맥 앞에 없으면 손절이 나가도, 경보가 떠도 아무도
 * 모른다. 사용자가 개장 시간에 다른 일을 하려고 이 앱을 만들었다는 것을 생각하면
 * 알림이 맥에 갇혀 있는 것은 목적과 정면으로 어긋난다.
 *
 * ── 규칙 ─────────────────────────────────────────────────────────────────
 *
 * ★ **알림은 전달 수단이지 판정이 아니다.** 실패해도 던지지 않고 `false`만
 *   돌려준다. 슬랙이 죽었다고 손절이 안 나가면 안 된다 — `checkAlerts`의
 *   macOS 알림이 처음부터 그 원칙으로 짜여 있고 여기도 같다.
 *
 * ★ **설정 안 했으면 조용히 넘어간다.** URL이 없는 것은 고장이 아니라 "안 쓴다"다.
 *
 * ★ **URL을 로그에 찍지 않는다.** webhook URL은 그 자체가 자격증명이다 —
 *   가진 사람은 누구나 그 채널에 글을 쓸 수 있다. 오류를 적을 때도 URL은 빼고
 *   상태 코드만 남긴다.
 *
 * ★ **슬랙은 mrkdwn이다.** `*굵게*`·`_기울임_`·`` `코드` `` — 표준 마크다운의
 *   `**굵게**`가 아니다. 별 두 개를 쓰면 화면에 별이 그대로 보인다.
 */

const WEBHOOK_ENV = 'SLACK_WEBHOOK_URL';

/** 슬랙으로 보낼 수 있는 상태인가. 부르는 쪽이 "안 보냈다"와 "못 보냈다"를 가르는 데 쓴다 */
export function slackConfigured(): boolean {
  return webhookUrl() !== null;
}

/**
 * 설정된 webhook URL. 형식이 아니면 `null`이다.
 *
 * ★ 형식을 보는 이유: `.env`에 따옴표째 붙여 넣거나 주석이 섞여 들어오는 일이
 *   실제로 있다. 그대로 fetch하면 던지는데, 알림 때문에 손절이 깨지면 안 된다.
 */
function webhookUrl(): string | null {
  const raw = (process.env[WEBHOOK_ENV] ?? '').trim().replace(/^["']|["']$/g, '');
  if (!raw.startsWith('https://hooks.slack.com/')) return null;
  return raw;
}

/**
 * 한 줄(또는 여러 줄) 보낸다.
 *
 * @returns 슬랙이 받았으면 true. 설정이 없거나 실패하면 false — **던지지 않는다.**
 */
export async function sendSlack(text: string): Promise<boolean> {
  const url = webhookUrl();
  if (!url) return false;
  if (!text.trim()) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      // 슬랙이 느리다고 손절 검사가 매 분 멎으면 안 된다.
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      // ★ URL은 절대 찍지 않는다. 상태 코드와 슬랙이 준 짧은 사유만 남긴다.
      const why = await res.text().catch(() => '');
      console.log(`  (슬랙 알림 실패 — HTTP ${res.status}${why ? ` ${why.slice(0, 60)}` : ''})`);
      return false;
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  (슬랙 알림 실패 — ${message.slice(0, 80)})`);
    return false;
  }
}

/** 원화 표기. 알림마다 다시 짜지 않게 여기 둔다 */
export function won(n: number): string {
  return `${Math.round(n).toLocaleString('ko-KR')}원`;
}

/** 부호를 붙인 원화. 손익은 방향이 먼저 읽혀야 한다 */
export function signedWon(n: number): string {
  return `${n >= 0 ? '+' : ''}${Math.round(n).toLocaleString('ko-KR')}원`;
}

/**
 * 슬랙 mrkdwn에서 뜻을 갖는 글자를 막는다.
 *
 * 종목명에 `&`가 들어가는 일이 실제로 있다(`S&T모티브`). 슬랙은 `&`·`<`·`>`를
 * HTML 엔티티로 읽으므로 그대로 보내면 이름이 깨진다.
 */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
