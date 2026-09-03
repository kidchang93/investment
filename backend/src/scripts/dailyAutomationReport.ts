/**
 * **오늘 자동화가 무엇을 했나.** 장 끝나고 한 번 슬랙으로 보낸다.
 *
 * ── 왜 (2026-09-03) ──────────────────────────────────────────────────────
 *
 * 사용자가 하루에 두 번 물었다 — *"자동화 켜면 되나?"*, *"자동화 자꾸 꺼지는
 * 것 같은데 브리핑이 또 안 와."*
 *
 * 두 번 다 **자동화는 켜져 있었다.** 한 번은 실제로 굶어 있었고(`watch`가 매 분
 * 실패해 트랙 B를 점유), 한 번은 그냥 **장이 끝난 것**이었다.
 *
 * ★★ **문제는 "조용한 것"의 뜻을 알 수 없다는 것이다.** 브리핑이 안 오는 것이
 *    정상(마감)인지 고장인지 구별할 방법이 없으면, 사람은 매번 물어보거나
 *    — 더 나쁘게 — 묻지 않고 넘어간다.
 *
 * 그래서 **하루가 끝날 때 한 번 말한다.** 무엇이 몇 번 돌았고, 창 안이었는데
 * 못 돈 것이 무엇이고, 다음은 언제인지.
 *
 * ★ 이 리포트가 있으면 오늘 놓친 것도 바로 보였다: 모의 서버가 죽은 14:44~15:20
 *   동안 `open-orders`(미체결 정리)가 한 번도 안 돌았다.
 *
 *   npx tsx src/scripts/dailyAutomationReport.ts [--notify]
 */

import '../config.js';

import { TASKS } from '../automation/tasks.js';
import { closeDb, pool } from '../db/client.js';
import { escapeMrkdwn, sendSlackBot, slackBotConfigured } from '../notify/slack.js';

interface Row { task: string; runs: string; first: string; last: string }

/** `HHMM` 정수를 `09:05`로 */
const hhmm = (c: number): string => `${String(Math.floor(c / 100)).padStart(2, '0')}:${String(c % 100).padStart(2, '0')}`;

async function main(): Promise<void> {
  const notify = process.argv.includes('--notify');

  const { rows } = await pool.query<Row>(
    `SELECT regexp_replace(name, '-[0-9]+$', '') AS task,
            count(*)::text AS runs,
            to_char(min(ran_at) AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS first,
            to_char(max(ran_at) AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS last
       FROM trading_heartbeats
      WHERE (ran_at AT TIME ZONE 'Asia/Seoul')::date = (now() AT TIME ZONE 'Asia/Seoul')::date
      GROUP BY 1 ORDER BY 4`,
  );
  const byTask = new Map(rows.map((r) => [r.task, r]));

  /*
   * ★ **지금 시각**을 `HHMM` 정수로. 창이 아직 안 온 것과 창이 지났는데 안 돈
   *   것은 다른 사실이다 — 섞으면 첫 판에서처럼 "KIS 스펙 확인이 안 돌았다"고
   *   적는다(그 창은 16:30인데 리포트가 16:00에 돈다).
   */
  const nowClock = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date()).replace(':', ''),
  );

  const done: string[] = [];
  const missed: string[] = [];
  const pending: string[] = [];
  for (const t of TASKS) {
    /*
     * ★ 손절은 하트비트를 안 남긴다(`noHeartbeat`) — 매 분 돌면 하루 390건이다.
     *   "안 돌았다"고 적으면 거짓이므로 아예 세지 않는다.
     */
    if (t.noHeartbeat) continue;
    const r = byTask.get(t.name);
    const window = `${hhmm(t.window[0])}~${hhmm(t.window[1])}`;
    if (r) done.push(`• ${t.label} — ${r.runs}회 (${r.first}~${r.last})`);
    else if (nowClock < t.window[1]) pending.push(`• ${t.label} — 창 ${window} (아직)`);
    else missed.push(`• ${t.label} — 창 ${window}`);
  }

  // 오늘 판단·주문
  const { rows: [d] } = await pool.query<{ rounds: string; decisions: string }>(
    `SELECT count(*)::text AS rounds,
            coalesce(sum(jsonb_array_length(decisions)), 0)::text AS decisions
       FROM trading_deliberations
      WHERE trading_day = (now() AT TIME ZONE 'Asia/Seoul')::date`,
  );
  const { rows: [o] } = await pool.query<{ n: string; filled: string }>(
    `SELECT count(*)::text AS n,
            count(*) FILTER (WHERE coalesce(filled_quantity, 0) > 0)::text AS filled
       FROM trading_broker_orders
      WHERE (created_at AT TIME ZONE 'Asia/Seoul')::date = (now() AT TIME ZONE 'Asia/Seoul')::date`,
  );

  const lines = [
    `🌙 *오늘 자동화 정리* — ${new Date().toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}`,
    '',
    `판단 ${d?.rounds ?? 0}회차 · 결정 ${d?.decisions ?? 0}건 · 주문 ${o?.n ?? 0}건(체결 ${o?.filled ?? 0})`,
    '',
    '*돌았다*',
    ...done,
  ];
  if (missed.length > 0) {
    /*
     * ★ **못 돈 것을 반드시 적는다.** 이것이 이 리포트의 핵심이다 — 조용한 것과
     *   고장난 것을 가르는 유일한 줄이다.
     */
    lines.push('', '*★ 창 안이었는데 한 번도 안 돌았다*', ...missed);
  }
  if (pending.length > 0) {
    lines.push('', '*아직 창이 안 왔다*', ...pending);
  }
  lines.push(
    '',
    '_브리핑은 내일 09:05에 다시 시작합니다. 그때까지 조용한 것이 정상입니다._',
  );

  const text = lines.join('\n');
  console.log(text);

  if (notify && slackBotConfigured()) {
    const sent = await sendSlackBot(lines.map(escapeMrkdwn).join('\n'));
    console.log(sent ? '\n슬랙으로 보냈다.' : '\n보내지 못했다.');
  }
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => closeDb());
