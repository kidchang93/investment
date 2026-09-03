/**
 * **장중 뉴스 브리핑.** 네이버 금융에서 받아 `stock-briefing` 채널에 보낸다.
 *
 * ── 왜 (2026-09-03) ──────────────────────────────────────────────────────
 *
 * 사용자가 정했다 — *"로컬 켜있으면 지속적으로 브리핑하도록 하자."*
 *
 * 슬랙 `stock-briefing`은 클라우드 Claude가 하루 두 번(08:20·18:15) 쓴다.
 * 좋은 재료지만 **그 사이 장이 도는 6시간 반은 비어 있다.** 이 스크립트가
 * 그 자리를 메운다.
 *
 * ★ **`newsWatch.ts`와 역할이 다르다.** 그쪽은 *"보유 종목에 무슨 일이 났나"*
 *   (사건 알림, 새 기사가 있을 때만). 이쪽은 *"시장이 지금 어떤가"*(정기 요약,
 *   매번 보낸다). 둘 다 있어야 한다 — 내 종목이 조용해도 시장은 움직인다.
 *
 * ── 무엇을 담나 ──────────────────────────────────────────────────────────
 *
 *   ① 코스피·코스닥 지수 한 줄 — 뉴스를 읽을 배경이다
 *   ② 주요 뉴스 제목 + **본문 요약** (KIS에는 제목만 온다)
 *
 * ★ **계좌·거래대금은 빼기로 했다** (2026-09-03, 사용자가 정했다 —
 *   *"stock-briefing 으로 뉴스만 보내면 될 것 같아"*). 계좌는 화면에서 보고,
 *   손절·경보는 웹훅으로 따로 간다. **채널마다 성격을 하나로** 두는 편이
 *   읽힌다 — 브리핑이 시끄러운 날 경보가 그 사이에 묻히면 안 된다.
 *
 * ── 어디로 보내나 ────────────────────────────────────────────────────────
 *
 * **봇(`briefingbot`)으로 `stock-briefing`에 보낸다** — 웹훅이 아니다.
 * 그 채널에는 클라우드 Claude가 하루 두 번 쓰는 브리핑이 이미 쌓이고 있어서,
 * 같은 봇 이름으로 이어 붙는 편이 읽기 좋다.
 *
 * 손절·경보는 **웹훅 그대로** 둔다(`sendSlack`). 성격이 다른 것은 채널도 다르다.
 *
 * ── 비용 ─────────────────────────────────────────────────────────────────
 *
 * **0원이다.** 네이버 2페이지가 전부다 — KIS도, 헤드리스 Claude도 안 부른다.
 * Firecrawl·Playwright도 안 쓴다(네이버 금융이 정적 HTML이라 필요 없었다).
 *
 *   npx tsx src/scripts/marketBrief.ts [--quiet]
 *     --quiet  슬랙으로 안 보내고 화면에만
 */

/*
 * ★ **`config.js`를 값 때문이 아니라 `.env`를 읽히려고 들여온다.**
 *   이 스크립트는 계좌를 안 보므로 config가 필요 없어 보이지만, dotenv를 로드하는
 *   곳이 거기다. 빼자마자 `BOT_TOKEN`이 안 읽혀 "봇이 설정돼 있지 않다"가 나왔다
 *   (2026-09-03). 스크립트를 새로 쓸 때 반복하기 쉬운 실수다.
 */
import '../config.js';
import { getIndexQuotes, getMainNews } from '../naver/finance.js';
import { escapeMrkdwn, sendSlackBot, slackBotConfigured } from '../notify/slack.js';

/** 브리핑에 담을 뉴스 개수 */
const NEWS_COUNT = 6;

function signed(value: number | null, digits = 2): string {
  if (value === null) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function kstNow(): string {
  return new Date().toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');

  const lines: string[] = [];
  const plain: string[] = [];

  // ── ① 지수 ──
  try {
    const indices = await getIndexQuotes();
    const parts = indices
      .filter((i) => i.value !== null)
      .map((i) => `*${i.name}* ${i.value!.toLocaleString('ko-KR')} (${signed(i.changeRate)}%)`);
    if (parts.length > 0) {
      lines.push(parts.join('  ·  '));
      plain.push(parts.join('  ·  ').replace(/\*/g, ''));
    }
  } catch (error) {
    // ★ 한 조각이 실패해도 나머지는 보낸다. 다만 **빠졌다고 적는다** —
    //   조용히 빠지면 "오늘은 조용했나 보다"로 읽힌다.
    lines.push('_지수를 못 읽었습니다_');
    plain.push(`지수 실패: ${(error as Error).message.slice(0, 80)}`);
  }

  // ── ② 주요 뉴스 ──
  try {
    const news = await getMainNews(NEWS_COUNT);
    if (news.length > 0) {
      lines.push('\n📰 *주요 뉴스*');
      for (const n of news) {
        lines.push(`   • <${n.url}|${escapeMrkdwn(n.title)}>`);
        if (n.summary) lines.push(`     _${escapeMrkdwn(n.summary.slice(0, 110))}_`);
        plain.push(`· ${n.title}`);
      }
    }
  } catch (error) {
    lines.push('\n📰 _뉴스를 못 읽었습니다_');
    plain.push(`뉴스 실패: ${(error as Error).message.slice(0, 80)}`);
  }

  console.log(`뉴스 브리핑 ${kstNow()}`);
  for (const line of plain) console.log(`  ${line}`);

  if (quiet) {
    console.log('\n(--quiet — 슬랙으로 보내지 않았다)');
    return;
  }
  if (!slackBotConfigured()) {
    console.log('\n봇이 설정돼 있지 않다 — BOT_TOKEN(xoxb-)과 SLACK_BRIEFING_CHANNEL(C…)이 필요하다.');
    return;
  }
  const header = `📰 *장중 뉴스* — ${kstNow()}`;
  const sent = await sendSlackBot([header, ...lines].join('\n'));
  console.log(sent ? '\nstock-briefing 채널로 보냈다.' : '\n보내지 못했다 (위 오류 참고).');
}

// ★ DB를 안 쓴다 — 네이버 3페이지가 전부다. `closeDb`가 필요 없다.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
