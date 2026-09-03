/**
 * **장중 뉴스 감시.** 보유 종목에 새 소식이 나면 알린다.
 *
 * ── 왜 (2026-09-03) ──────────────────────────────────────────────────────
 *
 * 사용자가 정했다 — *"클라우드는 1시간 단위로 설정하고 로컬 켜있으면 지속적으로
 * 브리핑하도록 하자."*
 *
 * 슬랙의 `stock-briefing`은 하루 두 번(08:20·18:15) 클라우드 Claude가 쓴다.
 * 그 사이 **6시간 반 동안 장이 도는데 아무도 안 본다.** 이 스크립트가 그 자리다.
 *
 * ★ **클라우드 루틴으로는 못 한다** — 최소 간격이 1시간이고(30분도 거부된다),
 *   무엇보다 클라우드는 이 맥의 계좌·DB에 접근하지 못한다. *"우리가 뭘 들고
 *   있나"*를 모르는 감시는 절반짜리다.
 *
 * ── ★★ 비용을 어떻게 눌렀나 ─────────────────────────────────────────────
 *
 * 10분마다 장중 6.5시간이면 **하루 39회**다. 매번 헤드리스 Claude를 부르면
 * 판단자(하루 1~3회)보다 훨씬 비싸진다. 그래서 두 단계로 나눴다:
 *
 *   ① **감지는 공짜다** — KIS 뉴스 제목 조회(`getInstrumentNews`)로 새 기사가
 *      있는지만 본다. 조용한 회차는 여기서 끝난다.
 *   ② **브리핑은 새 기사가 있을 때만** — 그때만 슬랙으로 보낸다.
 *
 * ★ **이 레포는 "뉴스가 알파를 주는가"를 아직 안 쟀다.** 그래서 본 것을 전부
 *   DB에 남긴다 — 나중에 *"그 뉴스 뒤에 값이 어떻게 됐나"*를 되짚을 수 있어야
 *   한다. 안 쌓으면 영영 못 잰다.
 *
 * ── 무엇을 안 하나 ───────────────────────────────────────────────────────
 *
 * **주문을 내지 않는다.** 판단자를 부르지도 않는다 — 사용자가 *"설정이 다 되면
 * 그때 매매 시퀀스 넣을거야"*라고 했다. 지금은 **알리는 데까지**다.
 *
 *   npx tsx src/scripts/newsWatch.ts [계좌id] [--quiet] [--all]
 *     --quiet  슬랙으로 안 보내고 화면에만 (시험용)
 *     --all    처음 본 것으로 치지 않고 전부 다시 알린다 (시험용)
 */

import type { Instrument, NewsItem } from '@invest/shared';

import { getKisAccount } from '../config.js';
import { closeDb, pool } from '../db/client.js';
import { getKoreanInstrumentBySymbol } from '../db/instruments.js';
import { getInstrumentNews, getKisDomesticAccountSnapshot } from '../kis/rest.js';
import { escapeMrkdwn, sendSlack } from '../notify/slack.js';
import { WATCHLIST } from '../watchlist.js';

/**
 * 한 회차에 볼 종목 수 상한. 보유 + 감시목록을 합쳐 이만큼만 본다.
 *
 * KIS 호출이 종목당 1회이고 10분마다 도므로, 20종목이면 하루 780회다.
 * 일봉 수집이 하루 4,000회인 것에 비하면 가볍다.
 */
const MAX_SYMBOLS = 20;

/** 이보다 오래된 기사는 "새것"으로 안 친다. 처음 켠 날 옛 기사가 쏟아지는 것을 막는다 */
const MAX_AGE_HOURS = 12;

/**
 * 종목 사이 간격(ms). **없으면 초당 유량에 걸린다** — 첫 시험에서 12종목 중
 * 2종목이 `초당 거래건수 초과`로 실패했다(2026-09-03).
 */
const SYMBOL_GAP_MS = 250;

/**
 * ★★ **한 회차에 슬랙으로 보낼 최대 건수.**
 *
 * 첫 시험에서 새 기사가 **35건**이었다. 그대로 보내면 2026-08-21의 알림 피로가
 * 그대로 재현된다 — 그때 경보 하나가 하루 16번 울려 **감시를 통째로 멈추게
 * 했다.** 넘치면 앞의 몇 건만 보내고 "그 밖 N건"으로 적는다.
 */
const MAX_SLACK_ITEMS = 8;

async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_news_seen (
      symbol        TEXT NOT NULL,
      news_id       TEXT NOT NULL,
      title         TEXT NOT NULL,
      source        TEXT NOT NULL DEFAULT '',
      /* KIS가 주는 발행 시각(초). 없을 수 있다 */
      published_at  BIGINT,
      /* 우리가 처음 본 시각. **알림을 보냈나의 기준이 이것이다** */
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      /* 그때 그 종목을 들고 있었나 — 나중에 "보유 중 뉴스"만 따로 보려면 필요하다 */
      held          BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (symbol, news_id)
    );
    CREATE INDEX IF NOT EXISTS trading_news_seen_time_idx
      ON trading_news_seen (first_seen_at DESC);
  `);
}

interface Target {
  instrument: Instrument;
  held: boolean;
}

/** 볼 종목: **보유가 먼저다.** 남는 자리에 감시목록을 채운다 */
async function collectTargets(accountId: string): Promise<Target[]> {
  const targets: Target[] = [];
  const seen = new Set<string>();

  const account = getKisAccount(accountId);
  if (account) {
    try {
      const snapshot = await getKisDomesticAccountSnapshot(account);
      for (const position of snapshot.positions) {
        if (position.quantity <= 0 || seen.has(position.symbol)) continue;
        const instrument = await getKoreanInstrumentBySymbol(position.symbol);
        if (!instrument) continue;
        seen.add(position.symbol);
        targets.push({ instrument, held: true });
      }
    } catch (error) {
      // 계좌를 못 읽어도 감시목록은 본다 — 조용히 아무것도 안 하는 것보다 낫다.
      console.log(`계좌를 못 읽었다 — 감시목록만 본다 (${(error as Error).message.slice(0, 60)})`);
    }
  }

  for (const item of WATCHLIST) {
    if (targets.length >= MAX_SYMBOLS) break;
    if (seen.has(item.code)) continue;
    const instrument = await getKoreanInstrumentBySymbol(item.code);
    if (!instrument) continue;
    seen.add(item.code);
    targets.push({ instrument, held: false });
  }
  return targets.slice(0, MAX_SYMBOLS);
}

/** 이미 본 기사인가. `(symbol, news_id)`가 열쇠다 */
async function filterNew(symbol: string, items: NewsItem[]): Promise<NewsItem[]> {
  if (items.length === 0) return [];
  const { rows } = await pool.query<{ news_id: string }>(
    'SELECT news_id FROM trading_news_seen WHERE symbol = $1 AND news_id = ANY($2)',
    [symbol, items.map((i) => i.id)],
  );
  const known = new Set(rows.map((r) => r.news_id));
  return items.filter((i) => !known.has(i.id));
}

async function remember(symbol: string, item: NewsItem, held: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO trading_news_seen (symbol, news_id, title, source, published_at, held)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (symbol, news_id) DO NOTHING`,
    [symbol, item.id, item.title, item.source, item.publishedAt ?? null, held],
  );
}

/**
 * 너무 오래된 기사인가.
 *
 * ★ **처음 켠 날을 위한 것이다.** DB가 비어 있으면 KIS가 주는 과거 기사가 전부
 *   "새것"이 되어 슬랙이 도배된다 — 2026-08-21에 경보 하나가 16번 울려 감시를
 *   통째로 멈추게 한 전례가 있다. 시끄러운 알림은 안 읽힌다.
 *
 * ★ 발행 시각이 없으면(`publishedAt`이 없는 기사) **새것으로 친다** — 모르는
 *   것을 버리지 않는다. 어차피 한 번만 알린다.
 */
function tooOld(item: NewsItem, nowSec: number): boolean {
  if (item.publishedAt === undefined) return false;
  return nowSec - item.publishedAt > MAX_AGE_HOURS * 3600;
}

/**
 * ★ **알릴 값어치가 없는 기사인가.**
 *
 * KIS 뉴스에는 기사가 아니라 **시세 나열**이 섞여 온다:
 *
 *   "KB금융(105560) +2.84%, 신한지주 +1.99%, 하나금융지주 +1.85%, …"
 *   "오늘의 이슈&테마 스케줄"
 *
 * 이런 것은 우리가 이미 시세로 아는 것이라 새 정보가 아니다. 10분마다 이걸
 * 보내면 진짜 재료가 그 사이에 묻힌다.
 *
 * ★ **DB에는 그대로 남긴다.** 거르는 것은 **알림뿐**이다 — 나중에 "뉴스가
 *   알파를 주는가"를 잴 때 무엇을 걸렀는지도 표본의 일부다.
 */
function isNoise(title: string): boolean {
  // 등락률이 셋 이상 나열되면 기사가 아니라 시세 요약이다.
  const percents = (title.match(/[+-]?\d+\.\d+%/g) ?? []).length;
  if (percents >= 3) return true;
  return /이슈&테마 스케줄|증시 캘린더|특징주 정리|주요 일정/.test(title);
}

function timeLabel(sec: number | undefined): string {
  if (sec === undefined) return '시각 미상';
  return new Date(sec * 1000).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const quiet = args.includes('--quiet');
  const all = args.includes('--all');
  const accountId = args.find((a) => !a.startsWith('--')) ?? 'VTS-ORDINARY';

  await ensureSchema();
  const targets = await collectTargets(accountId);
  if (targets.length === 0) {
    console.log('볼 종목이 없다.');
    return;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const fresh: Array<{ target: Target; item: NewsItem }> = [];
  let scanned = 0;
  let skippedOld = 0;

  for (const target of targets) {
    let items: NewsItem[] = [];
    try {
      items = await getInstrumentNews(target.instrument);
    } catch (error) {
      // 한 종목이 실패해도 나머지는 본다. 조용히 넘기지 않고 적는다.
      console.log(`  ${target.instrument.symbol} 뉴스 실패 — ${(error as Error).message.slice(0, 60)}`);
      continue;
    }
    scanned += 1;
    // 유량을 아낀다. KIS는 초당 건수를 센다.
    await new Promise((r) => { setTimeout(r, SYMBOL_GAP_MS); });
    const unseen = all ? items : await filterNew(target.instrument.symbol, items);
    for (const item of unseen) {
      if (tooOld(item, nowSec)) { skippedOld += 1; continue; }
      fresh.push({ target, item });
      if (!all) await remember(target.instrument.symbol, item, target.held);
    }
  }

  console.log(
    `종목 ${scanned}/${targets.length} · 새 기사 ${fresh.length}`
    + (skippedOld > 0 ? ` · ${MAX_AGE_HOURS}시간 넘어 뺀 것 ${skippedOld}` : ''),
  );

  if (fresh.length === 0) {
    // ★ 조용한 회차가 정상이다. 아무것도 보내지 않는다.
    return;
  }

  // 보유 종목을 먼저, 그 안에서 최신순.
  fresh.sort((a, b) => {
    if (a.target.held !== b.target.held) return a.target.held ? -1 : 1;
    return (b.item.publishedAt ?? 0) - (a.item.publishedAt ?? 0);
  });

  /*
   * ★★ 알림은 **거른 뒤에** 나간다. DB에는 위에서 이미 전부 들어갔다.
   *
   *   ① 노이즈(시세 나열·일정표)를 뺀다
   *   ② **같은 제목은 한 번만** — 시황 기사 하나가 KB금융·우리금융 양쪽에
   *      달려 오므로 종목별로 보내면 같은 줄이 두 번 간다
   *   ③ 상한을 넘으면 앞에서 자르고 몇 건 더 있는지 적는다
   */
  const titlesSent = new Set<string>();
  const notable = fresh.filter(({ item }) => {
    if (isNoise(item.title)) return false;
    if (titlesSent.has(item.title)) return false;
    titlesSent.add(item.title);
    return true;
  });

  const lines: string[] = [];
  for (const { target, item } of notable) {
    const mark = target.held ? '📌' : '·';
    console.log(`  ${mark} ${target.instrument.name} · ${timeLabel(item.publishedAt)} · ${item.title}`);
    if (lines.length >= MAX_SLACK_ITEMS) continue;
    lines.push(
      `${mark} *${escapeMrkdwn(target.instrument.name)}* · ${timeLabel(item.publishedAt)}`
      + `\n   ${escapeMrkdwn(item.title)}`,
    );
  }
  const dropped = fresh.length - notable.length;
  console.log(`알릴 것 ${notable.length}건 (노이즈·중복 ${dropped}건 뺐다)`);

  if (notable.length === 0) {
    console.log('알릴 것이 없다 — 전부 시세 나열이거나 중복이었다.');
    return;
  }
  if (quiet) {
    console.log('\n(--quiet — 슬랙으로 보내지 않았다)');
    return;
  }

  const heldCount = notable.filter((f) => f.target.held).length;
  const more = notable.length - lines.length;
  const header = `📰 *장중 뉴스* — ${notable.length}건`
    + (heldCount > 0 ? ` (보유 종목 ${heldCount}건 📌)` : '');
  const footer = more > 0 ? [`_그 밖 ${more}건은 화면·DB에만 남겼습니다._`] : [];
  const sent = await sendSlack([header, ...lines, ...footer].join('\n'));
  console.log(sent ? '슬랙으로 보냈다.' : '슬랙이 설정돼 있지 않다 (SLACK_WEBHOOK_URL).');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
