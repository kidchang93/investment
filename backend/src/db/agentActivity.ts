/**
 * **에이전트가 지금 무엇을 하고 있나.** 화면이 자세를 바꾸는 근거다.
 *
 * ── 왜 생겼나 (2026-09-07) ───────────────────────────────────────────────
 *
 * 사용자가 참조를 줬다 — `pixel-agents-hq/pixel-agents`. 그쪽은 *"파일을 쓸 때
 * 타이핑하고, 검색할 때 읽는다"*처럼 **하는 일에 따라 자세가 갈린다.** 우리는
 * 「일하는 중」 하나뿐이었다.
 *
 * ★ **하트비트로는 못 한다.** 하트비트는 *"그 작업이 끝났다"*를 남기는 것이라
 *   10~15분 걸리는 판단자가 그 안에서 무엇을 하는지는 비어 있다. 회차가 끝나야
 *   한 줄이 찍히므로, 정작 일하는 동안 화면이 조용하다.
 *
 * ★ **에이전트별로 한 줄만 둔다.** 이력이 아니라 **지금 상태**이고, 이력은
 *   하트비트와 회차 기록이 이미 갖고 있다. 덮어쓰기라 표가 자라지 않는다.
 */

import { pool } from './client.js';

/** 무엇을 하는 중인가. 화면의 자세와 1:1로 대응한다. */
export type AgentActivity =
  /** 계좌·시세·보유를 모으는 중 */
  | 'gathering'
  /** 후보를 훑는 중 */
  | 'screening'
  /** 웹에서 뉴스·공시를 찾는 중 */
  | 'researching'
  /** 판단을 적는 중 */
  | 'writing'
  /** 주문을 내는 중 */
  | 'ordering'
  /** 값을 재는 중 */
  | 'measuring'
  /** 일이 끝나 자리를 지키는 중 */
  | 'idle';

export const AGENT_ACTIVITIES: readonly AgentActivity[] = [
  'gathering', 'screening', 'researching', 'writing', 'ordering', 'measuring', 'idle',
];

export function isAgentActivity(value: string): value is AgentActivity {
  return (AGENT_ACTIVITIES as readonly string[]).includes(value);
}

export interface AgentActivityRow {
  /** 화면의 `ROSTER` id와 같은 값 — `analyst` · `judge` · `closeJudge` … */
  agent: string;
  activity: AgentActivity;
  /** 한 줄 설명. 화면 말풍선에 그대로 뜬다 */
  detail: string;
  updatedAt: number;
}

let ready: Promise<void> | null = null;

export function ensureAgentActivitySchema(): Promise<void> {
  ready ??= pool.query(`
    CREATE TABLE IF NOT EXISTS trading_agent_activity (
      agent      TEXT PRIMARY KEY,
      activity   TEXT NOT NULL,
      detail     TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `).then(
    () => undefined,
    // 실패는 기억하지 않는다 — 한 번 끊긴 것이 프로세스가 사는 동안 계속 실패로 남으면 안 된다.
    (err: unknown) => { ready = null; throw err; },
  );
  return ready;
}

export async function markAgentActivity(
  agent: string, activity: AgentActivity, detail = '',
): Promise<void> {
  await ensureAgentActivitySchema();
  await pool.query(
    `INSERT INTO trading_agent_activity (agent, activity, detail, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (agent) DO UPDATE
       SET activity = EXCLUDED.activity, detail = EXCLUDED.detail, updated_at = now()`,
    [agent, activity, detail.slice(0, 200)],
  );
}

/**
 * 지금 살아 있는 활동만.
 *
 * ★ **오래된 줄은 주지 않는다.** 프로세스가 죽으면 `idle`로 되돌릴 사람이 없어
 *   화면이 영영 "조사하는 중"으로 남는다. 판단자 회차가 10~15분이므로 그보다
 *   넉넉한 20분을 문턱으로 둔다 — 그보다 오래됐으면 **모르는 것**이지 활동이 아니다.
 */
const STALE_MS = 20 * 60 * 1000;

export async function getAgentActivities(): Promise<AgentActivityRow[]> {
  await ensureAgentActivitySchema();
  const { rows } = await pool.query<{
    agent: string; activity: string; detail: string; updated_at: string;
  }>(
    `SELECT agent, activity, detail,
            (extract(epoch from updated_at) * 1000)::bigint::text AS updated_at
       FROM trading_agent_activity
      WHERE updated_at > now() - interval '${Math.round(STALE_MS / 1000)} seconds'`,
  );
  return rows
    .filter((r) => isAgentActivity(r.activity))
    .map((r) => ({
      agent: r.agent,
      activity: r.activity as AgentActivity,
      detail: r.detail,
      updatedAt: Number(r.updated_at),
    }));
}
