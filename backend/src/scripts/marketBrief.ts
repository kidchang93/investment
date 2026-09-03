/**
 * **장중 시황 브리핑.** 네이버 금융에서 받아 슬랙으로 보낸다.
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
 *   ① 코스피·코스닥 지수와 등락
 *   ② 우리 계좌 — 총평가·손익·오늘 움직인 보유 종목  ← **로컬이라 할 수 있다**
 *   ③ 거래대금 상위 — 자금이 어디로 몰리나
 *   ④ 주요 뉴스 제목 + 본문 요약
 *
 * ★ ②가 이 브리핑의 값어치다. 클라우드 루틴은 계좌를 못 봐서 *"시장이 빠졌다"*
 *   까지만 말할 수 있는데, 로컬은 *"그래서 우리가 얼마 잃었다"*를 말한다.
 *
 * ── 비용 ─────────────────────────────────────────────────────────────────
 *
 * **0원이다.** 네이버 3페이지 + KIS 잔고 1회. 헤드리스 Claude를 부르지 않는다.
 * Firecrawl·Playwright도 안 쓴다 — 네이버 금융이 정적 HTML이라 필요 없었다.
 *
 *   npx tsx src/scripts/marketBrief.ts [계좌id] [--quiet]
 *     --quiet  슬랙으로 안 보내고 화면에만
 */

import { getKisAccount } from '../config.js';
import { closeDb } from '../db/client.js';
import { getKisDomesticAccountSnapshot } from '../kis/rest.js';
import { getIndexQuotes, getMainNews, getTurnoverTop } from '../naver/finance.js';
import { escapeMrkdwn, sendSlack, won } from '../notify/slack.js';

/** 브리핑에 담을 개수 */
const NEWS_COUNT = 5;
const TURNOVER_COUNT = 6;

/** 이만큼 넘게 움직인 보유 종목만 따로 적는다. 조용한 것은 줄이 아깝다 */
const NOTABLE_MOVE_PCT = 1.5;

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
  const accountId = args.find((a) => !a.startsWith('--')) ?? 'VTS-ORDINARY';

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

  // ── ② 우리 계좌 ── **로컬이라 할 수 있는 것**
  const account = getKisAccount(accountId);
  if (account) {
    try {
      const snapshot = await getKisDomesticAccountSnapshot(account);
      const pnl = snapshot.positions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);
      lines.push(
        `\n💼 *내 계좌* ${won(snapshot.totalEvaluation ?? 0)}`
        + `  ·  평가손익 ${pnl >= 0 ? '+' : ''}${won(pnl)}`,
      );
      plain.push(`계좌 ${won(snapshot.totalEvaluation ?? 0)} · 손익 ${won(pnl)}`);

      const movers = snapshot.positions
        .filter((p) => Math.abs(p.unrealizedPnlRate ?? 0) >= NOTABLE_MOVE_PCT)
        .sort((a, b) => (b.unrealizedPnlRate ?? 0) - (a.unrealizedPnlRate ?? 0));
      for (const p of movers) {
        const row = `   ${p.name} ${signed(p.unrealizedPnlRate ?? null)}% (${won(p.unrealizedPnl ?? 0)})`;
        lines.push(row);
        plain.push(row);
      }
    } catch (error) {
      lines.push('\n💼 _계좌를 못 읽었습니다_');
      plain.push(`계좌 실패: ${(error as Error).message.slice(0, 80)}`);
    }
  }

  // ── ③ 거래대금 상위 ──
  try {
    const top = await getTurnoverTop(TURNOVER_COUNT);
    if (top.length > 0) {
      lines.push('\n💰 *거래대금 상위*');
      const row = top
        .map((t) => `${escapeMrkdwn(t.name)} ${signed(t.changeRate, 1)}%`)
        .join(' · ');
      lines.push(`   ${row}`);
      plain.push(`거래대금 상위: ${top.map((t) => t.name).join(', ')}`);
    }
  } catch (error) {
    plain.push(`거래대금 실패: ${(error as Error).message.slice(0, 80)}`);
  }

  // ── ④ 주요 뉴스 ──
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

  console.log(`시황 브리핑 ${kstNow()}`);
  for (const line of plain) console.log(`  ${line}`);

  if (quiet) {
    console.log('\n(--quiet — 슬랙으로 보내지 않았다)');
    return;
  }
  const header = `📊 *시황 브리핑* — ${kstNow()}`;
  const sent = await sendSlack([header, ...lines].join('\n'));
  console.log(sent ? '\n슬랙으로 보냈다.' : '\n슬랙이 설정돼 있지 않다 (SLACK_WEBHOOK_URL).');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
