/**
 * **슬랙 `stock-briefing`을 읽어 판단자에게 준다.**
 *
 * ── 왜 (2026-09-03) ──────────────────────────────────────────────────────
 *
 * 사용자가 정했다 — *"판단자는 계속 슬랙 브리핑을 감시하고 있어야돼. 그래야
 * 시장 상황을 바로 읽고 매매를 진행하지."*
 *
 * 그 채널에는 두 가지가 쌓인다:
 *
 *   ① **클라우드 Claude의 하루 두 번 브리핑**(08:20·18:15) — 미·한 지수,
 *      금리·유가·환율, 주요 뉴스, **오늘의 Action List**까지. 스레드에 ETF
 *      후보와 "피할 구간"이 이어진다
 *   ② **우리 장중 뉴스 브리핑**(30분마다, `marketBrief.ts`)
 *
 * ★ 판단자가 지금 보는 것은 **시세와 계좌뿐**이다. 원장 22개 신호가 전부
 *   가격에서 나온 것이었던 것과 같은 구멍이다 — **가격 밖의 정보**가 판단에
 *   들어가는 첫 경로가 이것이다.
 *
 * ── 왜 프롬프트에 안 박고 스크립트로 두나 ────────────────────────────────
 *
 * `deliberationState.ts`·`screenCandidates.ts`와 같은 자리다. 프롬프트에 박으면
 * **소집 시점의 것만** 보게 되고, 판단자가 "더 앞을 보자"고 못 한다.
 * 스크립트면 인자로 범위를 넓힐 수 있다.
 *
 * ★ **판단자에게 슬랙 MCP를 주지 않는다.** 도구를 늘리면 시간 예산(회차 10~15분)을
 *   그만큼 쓴다 — 2026-08-21에 판단자가 리서처를 띄웠다가 600초 한도에 걸려
 *   **회차가 통째로 사라졌다.** 읽는 것은 우리가 해서 넘긴다.
 *
 * ── 스레드를 함께 읽는다 ─────────────────────────────────────────────────
 *
 * 클라우드 브리핑은 **본문에 요약, 스레드에 알맹이**를 둔다 — ETF 후보·피할
 * 구간·Action List가 전부 스레드다. 본문만 읽으면 *"스레드 참고"*라는 글자만
 * 보게 된다.
 *
 * 조회 전용이다. 주문을 내지 않는다.
 *
 *   npx tsx src/scripts/readBriefing.ts [--hours 24] [--limit 5] [--no-thread]
 */

import '../config.js';

const TOKEN = (process.env.BOT_TOKEN ?? '').trim();
const CHANNEL = (process.env.SLACK_BRIEFING_CHANNEL ?? '').trim();

interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  reply_count?: number;
}

async function slackGet(method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json()) as Record<string, unknown>;
  if (body.ok !== true) throw new Error(`슬랙 ${method} 실패: ${String(body.error ?? res.status)}`);
  return body;
}

function kstLabel(ts: string): string {
  return new Date(Number(ts) * 1000).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/**
 * 슬랙 mrkdwn을 읽기 좋게 편다. **판단자가 읽을 글이라 장식은 방해다.**
 *
 * - `<url|글자>` → `글자` (URL은 길고 판단에 안 쓴다)
 * - `:emoji:` → 지운다
 * - `&amp;` 같은 것을 되돌린다
 */
function flatten(text: string): string {
  return text
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/:[a-z0-9_+-]+:/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const num = (flag: string, fallback: number): number => {
    const i = args.indexOf(flag);
    if (i < 0) return fallback;
    const v = Number(args[i + 1]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const hours = num('--hours', 24);
  const limit = num('--limit', 5);
  const withThread = !args.includes('--no-thread');

  if (!TOKEN.startsWith('xoxb-') || !/^[CGD][A-Z0-9]{6,}$/.test(CHANNEL)) {
    /*
     * ★ **설정이 없으면 조용히 끝내지 않고 말한다.** 판단자가 이것을 부르는데
     *   아무 출력이 없으면 "브리핑이 없나 보다"로 읽고 지나간다 — 그게 가장
     *   나쁜 실패다(2026-08-21에 `deliberationState`가 "뉴스는 여기 없다"고
     *   적어 둔 탓에 회차 셋이 헛돌았다).
     */
    console.log('브리핑을 읽을 수 없습니다 — BOT_TOKEN(xoxb-)과 SLACK_BRIEFING_CHANNEL(C…)이 필요합니다.');
    console.log('이 회차는 브리핑 없이 판단해야 하고, 그 사실을 unknowns에 적으세요.');
    process.exitCode = 0;
    return;
  }

  const oldest = String(Math.floor(Date.now() / 1000) - hours * 3600);
  let messages: SlackMessage[];
  try {
    const body = await slackGet('conversations.history', {
      channel: CHANNEL,
      oldest,
      limit: String(Math.max(limit * 3, 20)),
    });
    messages = (body.messages as SlackMessage[] | undefined) ?? [];
  } catch (error) {
    console.log(`브리핑을 못 읽었습니다: ${(error as Error).message}`);
    console.log('이 회차는 브리핑 없이 판단해야 하고, 그 사실을 unknowns에 적으세요.');
    return;
  }

  // 사람이 채널에 들어왔다는 알림 같은 것은 뺀다.
  const real = messages.filter((m) => (m.text ?? '').trim().length > 80);

  /*
   * ★★ **두 종류를 갈라서 보여준다.**
   *
   * 이 채널에는 성격이 다른 둘이 섞인다:
   *
   *   ① 클라우드 Claude의 하루 두 번 브리핑 — 거시·Action List·ETF 후보까지
   *      담긴 **진짜 재료**
   *   ② 우리 장중 뉴스(30분마다) — 최신 시황
   *
   * 그냥 최신순으로 자르면 **②가 ①을 밀어낸다.** 하루면 ②가 13건 쌓여
   * 오늘 아침 브리핑이 목록 밖으로 나간다 — 첫 시험에서 실제로 그랬다.
   * 그러면 판단자는 가장 값어치 있는 것을 못 보고 시황만 되풀이해 읽는다.
   */
  const isIntraday = (m: SlackMessage): boolean => /장중 뉴스/.test(m.text ?? '');
  const cloudBriefs = real.filter((m) => !isIntraday(m)).slice(0, limit);
  const intraday = real.filter(isIntraday).slice(0, 1);
  const briefs = [...cloudBriefs, ...intraday]
    .sort((a, b) => Number(b.ts) - Number(a.ts));

  console.log(`=== 슬랙 브리핑 (최근 ${hours}시간) ===`);
  console.log(`정기 브리핑 ${cloudBriefs.length}건 · 장중 시황 ${intraday.length}건(최신만)`);
  console.log('★ 이것은 정보 제공이지 매매 지시가 아닙니다. 판단은 당신이 합니다.\n');

  if (briefs.length === 0) {
    console.log('최근 브리핑이 없습니다. 그 사실을 unknowns에 적으세요.');
    return;
  }

  for (const m of briefs) {
    console.log(`\n────── ${kstLabel(m.ts)} ──────`);
    console.log(flatten(m.text ?? ''));

    if (withThread && (m.reply_count ?? 0) > 0) {
      try {
        const body = await slackGet('conversations.replies', {
          channel: CHANNEL, ts: m.ts, limit: '10',
        });
        const replies = ((body.messages as SlackMessage[] | undefined) ?? []).slice(1);
        for (const r of replies) {
          console.log(`\n  --- 스레드 ---`);
          console.log(flatten(r.text ?? '').split('\n').map((l) => `  ${l}`).join('\n'));
        }
      } catch (error) {
        console.log(`  (스레드를 못 읽었습니다: ${(error as Error).message.slice(0, 60)})`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
