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

// ── 봇으로 특정 채널에 보내기 (2026-09-03) ──────────────────────────────
//
// 사용자가 정했다 — *"봇이 브리핑 하게 해야될 것 같아. stock-briefing 으로
// 뉴스만 보내면 될 것 같아."*
//
// ★ **웹훅과 무엇이 다른가.** 웹훅은 URL 하나에 **채널이 박혀 있다** — 만들 때
//   정한 곳으로만 간다. 봇 토큰(`chat:write`)은 채널을 골라 보낼 수 있고,
//   보내는 주체가 `briefingbot`으로 찍힌다. `stock-briefing`에 이미 그 봇이
//   하루 두 번 브리핑을 쓰고 있으므로 **같은 이름으로 이어진다.**
//
// ★ 손절·경보는 **웹훅 그대로** 둔다. 알림 경로를 하나로 합치면 브리핑이
//   시끄러운 날 경보가 그 사이에 묻힌다 — 성격이 다른 것은 채널도 달라야 한다.

const BOT_TOKEN_ENV = 'BOT_TOKEN';
const BRIEFING_CHANNEL_ENV = 'SLACK_BRIEFING_CHANNEL';

/** 봇으로 보낼 수 있나. 토큰과 채널이 둘 다 있어야 한다 */
export function slackBotConfigured(): boolean {
  return botToken() !== null && briefingChannel() !== null;
}

function botToken(): string | null {
  const raw = (process.env[BOT_TOKEN_ENV] ?? '').trim().replace(/^["']|["']$/g, '');
  // `xoxb-`가 봇 토큰이다. `xapp-`(앱 레벨)은 채널에 못 쓴다.
  return raw.startsWith('xoxb-') ? raw : null;
}

function briefingChannel(): string | null {
  const raw = (process.env[BRIEFING_CHANNEL_ENV] ?? '').trim().replace(/^["']|["']$/g, '');
  // 채널 ID는 C(공개)·G(비공개)·D(DM)로 시작한다. 이름(`#stock-briefing`)은 API가 안 받는다.
  return /^[CGD][A-Z0-9]{6,}$/.test(raw) ? raw : null;
}

/**
 * 봇으로 브리핑 채널에 보낸다.
 *
 * @returns 슬랙이 받았으면 true. 설정이 없거나 실패하면 false — **던지지 않는다.**
 *   (`sendSlack`과 같은 원칙: 알림은 전달 수단이지 판정이 아니다)
 */
export async function sendSlackBot(text: string): Promise<boolean> {
  const token = botToken();
  const channel = briefingChannel();
  if (!token || !channel) return false;
  if (!text.trim()) return false;
  try {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel,
        text,
        // 링크 미리보기를 끈다 — 뉴스 5건이면 화면이 미리보기로 뒤덮인다.
        unfurl_links: false,
        unfurl_media: false,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (!body.ok) {
      // ★ 토큰은 로그에 안 찍는다. 오류 코드만 남긴다.
      console.log(`슬랙 봇 전송 실패: ${body.error ?? `HTTP ${res.status}`}`);
      return false;
    }
    return true;
  } catch (error) {
    console.log(`슬랙 봇 전송 실패: ${(error as Error).message.slice(0, 80)}`);
    return false;
  }
}
