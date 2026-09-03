/**
 * **자동화 스케줄러 — 백엔드 안에서 돈다.**
 *
 * 데몬(`scripts/daemon.sh`)이 하던 "시각을 보고 스크립트를 부르는" 일을 여기서
 * 한다. 백엔드는 이미 상주하므로 **별도 프로세스가 필요 없고**, 웹에서 REST로
 * 켜고 끌 수 있다 → `docs/OPERATIONS.md`.
 *
 * ── 데몬에서 가져온 안전장치 ─────────────────────────────────────────────
 *
 * 데몬이 한 달 넘게 돌며 겪은 것들을 그대로 옮겼다. 새로 짜면 같은 것을 다시
 * 겪는다:
 *
 * **① 하트비트가 유일한 근거다.** "오늘 했나"를 메모리에 두면 백엔드가 재시작될
 *    때 잊고 다시 한다. DB(`trading_heartbeats`)만 본다.
 * **② DB가 없으면 아무것도 하지 않는다.** `did_today`가 DB를 못 읽으면 "아직 안
 *    했다"를 돌려주므로, 그대로 두면 매 분 판단자를 다시 부른다(헤드리스 Claude라
 *    부를 때마다 실제 비용이 나간다).
 * **③ 실패하면 하트비트를 남기지 않는다.** 2026-08-21에 판단자가 아무것도 안
 *    남기고 죽었는데 종료 코드가 0이라 "했다"고 기록됐다. **그날 판단이 통째로
 *    사라졌고 아무도 몰랐다.**
 * **④ 한 회차에 하나씩만.** 여러 작업이 동시에 KIS를 두드리면 유량을 다툰다.
 * **⑤ 평일만.** 주말·공휴일에는 루프가 돌지만 아무 일도 하지 않는다.
 */

import { exec, execFile } from 'node:child_process';
import path from 'node:path';

import { pool } from '../db/client.js';
import {
  TASKS,
  heartbeatName,
  isInWindow,
  type Clock,
  type TaskSpec,
} from './tasks.js';

/** 레포 루트. 스크립트가 거기서 도는 것을 전제한다 */
const REPO_ROOT = path.resolve(process.cwd(), process.cwd().endsWith('backend') ? '..' : '.');

export interface AutomationSettings {
  /** 스케줄러가 돌고 있나 */
  enabled: boolean;
  /**
   * 새로 사고파는 것을 허용하나. `false`면 `trading: true`인 작업을 건너뛴다.
   *
   * ★ 2026-09-02 사용자가 정했다 — *"전략도 없이 자동매매는 좀 맞지 않는다."*
   *   검증된 규칙이 설 때까지 판단자가 새로 사지 않는다. 손절은 계속 돈다.
   */
  tradingEnabled: boolean;
}

export interface TaskState extends TaskSpec {
  /** 오늘 이미 했나 */
  doneToday: boolean;
  /** 오늘 마지막으로 한 시각 `HH:MM` */
  lastRunAt: string | null;
  /** 지금 돌고 있나 */
  running: boolean;
  /** 지금 창 안인가 */
  inWindow: boolean;
  /** 지금 모드에서 이 작업이 꺼져 있나 */
  skipped: 'trading-off' | null;
}

interface RunLog {
  name: string;
  startedAt: number;
  finishedAt: number | null;
  ok: boolean | null;
  output: string;
}

/** 최근 실행 기록. 화면이 "방금 무슨 일이 있었나"를 보여준다 */
const recentRuns: RunLog[] = [];
const RECENT_LIMIT = 40;

const running = new Set<string>();
let timer: NodeJS.Timeout | null = null;
let settings: AutomationSettings = { enabled: false, tradingEnabled: false };
let lastTickAt: number | null = null;

// ── 설정 저장 ────────────────────────────────────────────────────────────

async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_automation_settings (
      id              INT PRIMARY KEY DEFAULT 1,
      enabled         BOOLEAN NOT NULL DEFAULT false,
      trading_enabled BOOLEAN NOT NULL DEFAULT false,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT one_row CHECK (id = 1)
    );
    INSERT INTO trading_automation_settings (id) VALUES (1) ON CONFLICT DO NOTHING;
  `);
}

export async function loadSettings(): Promise<AutomationSettings> {
  await ensureSchema();
  const { rows } = await pool.query<{ enabled: boolean; trading_enabled: boolean }>(
    'SELECT enabled, trading_enabled FROM trading_automation_settings WHERE id = 1',
  );
  const row = rows[0];
  return {
    enabled: row?.enabled ?? false,
    tradingEnabled: row?.trading_enabled ?? false,
  };
}

async function saveSettings(next: AutomationSettings): Promise<void> {
  await ensureSchema();
  await pool.query(
    `UPDATE trading_automation_settings
        SET enabled = $1, trading_enabled = $2, updated_at = now()
      WHERE id = 1`,
    [next.enabled, next.tradingEnabled],
  );
}

// ── 시각 ─────────────────────────────────────────────────────────────────

/** KST 지금. `clock`은 `HHMM`, `weekday`는 1=월 … 7=일 */
function kstNow(): { clock: Clock; weekday: number; hhmm: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const names: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    clock: hour * 100 + minute,
    weekday: names[String(parts.weekday)] ?? 1,
    hhmm: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

// ── 하트비트 ─────────────────────────────────────────────────────────────

/**
 * 오늘 이 이름으로 성공 기록이 있나. **DB를 못 읽으면 `null`**을 돌려준다 —
 * `false`(아직 안 함)로 두면 매 분 다시 부른다.
 */
async function doneToday(name: string): Promise<boolean | null> {
  try {
    const { rows } = await pool.query<{ n: string; at: string | null }>(
      `SELECT count(*)::text AS n,
              to_char(max(ran_at) AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS at
         FROM trading_heartbeats
        WHERE name = $1 AND status = 'ok'
          AND (ran_at AT TIME ZONE 'Asia/Seoul')::date = (now() AT TIME ZONE 'Asia/Seoul')::date`,
      [name],
    );
    return Number(rows[0]?.n ?? 0) > 0;
  } catch {
    return null;
  }
}

async function lastRunAt(name: string): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ at: string | null }>(
      `SELECT to_char(max(ran_at) AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS at
         FROM trading_heartbeats
        WHERE name LIKE $1 AND status = 'ok'
          AND (ran_at AT TIME ZONE 'Asia/Seoul')::date = (now() AT TIME ZONE 'Asia/Seoul')::date`,
      [`${name}%`],
    );
    return rows[0]?.at ?? null;
  } catch {
    return null;
  }
}

async function mark(name: string, note: string): Promise<void> {
  await pool.query(
    `INSERT INTO trading_heartbeats (name, status, note) VALUES ($1, 'ok', $2)`,
    [name, note],
  ).catch(() => undefined);
}

// ── 실행 ─────────────────────────────────────────────────────────────────

function runShell(command: string, timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd: REPO_ROOT, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: '/bin/zsh' },
      (error, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim().slice(-4000);
        resolve({ ok: !error, output });
      },
    );
  });
}

/**
 * 밖에서 같은 일이 이미 돌고 있나. **스케줄러의 `running`은 자기 것만 안다** —
 * 사람이 손으로 돌린 것과 이전 인스턴스가 남긴 것은 프로세스를 봐야 알 수 있다.
 *
 * ★ 2026-09-03에 판단자가 두 벌 떴다. 사람이 08:46에 손으로 소집했고 그것이
 *   하트비트를 남기기 전에 스케줄러가 08:49에 또 불렀다.
 *
 * ★ **모르면 "돌고 있다"고 답한다.** `pgrep`이 실패했을 때 없다고 치면 겹치는
 *   쪽으로 틀리고, 그 대가가 크다(주문이 두 번 나간다). 한 회차 쉬는 쪽이 싸다.
 */
function isRunningOutside(pattern: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('pgrep', ['-f', pattern], (error, stdout) => {
      // pgrep은 못 찾으면 종료 코드 1이다 — 그건 오류가 아니라 "없다"이다.
      if (error && (error as NodeJS.ErrnoException & { code?: number }).code === 1) {
        resolve(false);
        return;
      }
      if (error) { resolve(true); return; }
      resolve(stdout.trim().length > 0);
    });
  });
}

/**
 * ★★ **연속 실패한 슬롯을 세어 둔다** (2026-09-03).
 *
 * 실패하면 하트비트를 안 남기므로 다음 회차가 **같은 것을 또 시도한다.** 그
 * 자체는 옳다(고쳐지면 이어서 해야 한다). 그런데 트랙 B는 **하나를 돌리고
 * `return`**하므로, 위쪽 작업이 계속 실패하면 **그 아래가 영영 굶는다.**
 *
 * 그날 실제로 그랬다: 매도가 많아 D+0 자산이 3,700만원 적게 잡히자 중단선
 * 경보가 떴고, `checkAlerts`가 종료코드 1을 내 `watch`가 매 분 실패했다.
 * **`fair-value`가 2시간 반 동안 한 번도 못 돌았다.**
 *
 * ★ 아침에 고친 "손절이 모든 작업을 굶긴다"와 **같은 구조**다. 그때는 우선순위가
 *   높은 작업이 항상 먼저 잡혀서였고, 이번엔 실패가 반복돼서다.
 *
 * ★ **포기하지는 않는다.** 문턱을 넘으면 그 슬롯을 건너뛰어 **아래에 차례를
 *   주고**, 다음 슬롯이 오면 다시 시도한다(슬롯 이름에 시각이 들어간다).
 */
const failures = new Map<string, number>();
/** 한 슬롯에서 이만큼 연속 실패하면 아래에 차례를 준다 */
const MAX_SLOT_FAILURES = 2;

async function runTask(task: TaskSpec, clock: Clock, hhmm: string): Promise<void> {
  const name = heartbeatName(task, clock);
  if (running.has(task.name)) return;
  running.add(task.name);

  const log: RunLog = { name, startedAt: Date.now(), finishedAt: null, ok: null, output: '' };
  recentRuns.unshift(log);
  if (recentRuns.length > RECENT_LIMIT) recentRuns.length = RECENT_LIMIT;

  /*
   * 백그라운드 작업은 결과를 기다리지 않는다(일봉 3시간·단일가 13분). 대신
   * **시작했다는 하트비트를 먼저** 남긴다 — 시작만 하고 죽은 것을 "했다"고
   * 읽으면 며칠째 낡은 데이터로 재고 있어도 모른다.
   */
  const timeout = task.background ? 4 * 60 * 60 * 1000 : 20 * 60 * 1000;
  if (task.background) await mark(name, `${hhmm} 시작`);

  const result = await runShell(task.command, timeout);
  log.finishedAt = Date.now();
  log.ok = result.ok;
  log.output = result.output;

  /*
   * ★ **실패하면 하트비트를 남기지 않는다.** 남기면 다음 회차가 "오늘 했다"로
   *   읽고 영영 다시 시도하지 않는다 — 2026-08-21에 판단자가 그렇게 통째로
   *   사라졌다. 백그라운드는 이미 시작 기록을 남겼으므로 완료만 더한다.
   */
  if (result.ok && !task.noHeartbeat) {
    await mark(task.background ? `${name}-done` : name, hhmm);
  }
  if (result.ok) {
    failures.delete(name);
  } else {
    const n = (failures.get(name) ?? 0) + 1;
    failures.set(name, n);
    if (n === MAX_SLOT_FAILURES) {
      console.warn(
        `[automation] ${task.name} 슬롯 ${name}이 ${n}번 연속 실패했다`
        + ' — 이 슬롯은 건너뛰고 아래 작업에 차례를 준다',
      );
    }
  }
  running.delete(task.name);
}

// ── 루프 ─────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  lastTickAt = Date.now();
  if (!settings.enabled) return;

  const { clock, weekday, hhmm } = kstNow();
  if (weekday > 5) return;   // 주말에는 아무 일도 하지 않는다

  /*
   * ★★ **두 트랙으로 나눈다** (2026-09-03에 고쳤다).
   *
   * 처음에는 "한 회차에 하나씩"으로 `TASKS`를 훑다가 첫 후보를 띄우고 `return`
   * 했다. 그런데 **손절 감시는 `noHeartbeat`라 매 분 무조건 후보가 된다** —
   * 목록 위쪽에 있으니 매번 그것이 뽑히고 `return`으로 끝나, **그 아래 작업이
   * 영영 차례를 못 받았다.**
   *
   * 실제로 그랬다: 10:14 이후 적정가 분석·시황 브리핑·뉴스 감시가 통째로 멈췄고
   * 손절만 매 분 돌았다. 사용자가 *"10시14분 이후로 브리핑이 안 오는데"*로 발견했다.
   *
   * ★ 데몬에는 없던 문제다 — 셸 루프는 순차라 손절 뒤에 나머지도 다 했다.
   *   "하나씩"을 옮기며 **매 분 도는 것과 가끔 도는 것을 같은 줄에 세운 것**이
   *   원인이다.
   *
   *   트랙 A  하트비트를 안 남기는 짧은 작업(손절) — **막지 않고 다 띄운다**
   *   트랙 B  나머지 — 한 회차에 하나씩(KIS 유량을 다투지 않게)
   */

  // ── 트랙 A: 손절처럼 매 분 도는 것 ──
  for (const task of TASKS) {
    if (!task.noHeartbeat) continue;
    if (!isInWindow(task, clock)) continue;
    if (task.trading && !settings.tradingEnabled) continue;
    if (running.has(task.name)) continue;
    if (task.guard && (await isRunningOutside(task.guard))) continue;
    void runTask(task, clock, hhmm);
  }

  // ── 트랙 B: 나머지 중 하나 ──
  for (const task of TASKS) {
    if (task.noHeartbeat) continue;
    if (!isInWindow(task, clock)) continue;
    if (task.trading && !settings.tradingEnabled) continue;
    if (running.has(task.name)) continue;

    const name = heartbeatName(task, clock);
    const done = await doneToday(name);
    // ★ DB를 못 읽으면 이 회차는 **아무것도 하지 않는다**(위 계약 ②).
    if (done === null) return;
    if (done) continue;

    /*
     * ★★ 이 슬롯이 연달아 실패했으면 **아래에 차례를 준다.** 안 그러면 고장난
     *    작업 하나가 그 아래 전부를 굶긴다(`failures` 주석 참고).
     */
    if ((failures.get(name) ?? 0) >= MAX_SLOT_FAILURES) continue;

    /*
     * ★★ 밖에서 같은 일이 돌고 있으면 건너뛴다. 하트비트는 **끝난 뒤에** 남으므로
     *    도는 중인 것을 못 본다 — 그 창에서 겹친다.
     */
    if (task.guard && (await isRunningOutside(task.guard))) continue;

    // ★ 한 회차에 하나씩. 여럿이 동시에 KIS를 두드리면 유량을 다툰다.
    void runTask(task, clock, hhmm);
    return;
  }
}

// ── 공개 API ─────────────────────────────────────────────────────────────

export function getSettings(): AutomationSettings {
  return { ...settings };
}

export async function setSettings(next: Partial<AutomationSettings>): Promise<AutomationSettings> {
  settings = { ...settings, ...next };
  await saveSettings(settings);
  return getSettings();
}

export interface AutomationStatus {
  settings: AutomationSettings;
  /** 스케줄러 루프가 살아 있나 */
  ticking: boolean;
  lastTickAt: number | null;
  /** KST 지금 */
  now: string;
  weekday: number;
  tasks: TaskState[];
  recent: Array<{ name: string; startedAt: number; finishedAt: number | null; ok: boolean | null; output: string }>;
}

export async function getStatus(): Promise<AutomationStatus> {
  const { clock, weekday, hhmm } = kstNow();
  const tasks: TaskState[] = [];
  for (const task of TASKS) {
    const name = heartbeatName(task, clock);
    tasks.push({
      ...task,
      doneToday: task.noHeartbeat ? false : ((await doneToday(name)) ?? false),
      lastRunAt: await lastRunAt(task.name),
      running: running.has(task.name),
      inWindow: isInWindow(task, clock),
      skipped: task.trading && !settings.tradingEnabled ? 'trading-off' : null,
    });
  }
  return {
    settings: getSettings(),
    ticking: timer !== null,
    lastTickAt,
    now: hhmm,
    weekday,
    tasks,
    recent: recentRuns.slice(0, 12),
  };
}

/** 사람이 화면에서 "지금 실행"을 누른 것. 창·하트비트를 무시한다 */
export async function runNow(taskName: string): Promise<{ ok: boolean; message: string }> {
  const task = TASKS.find((t) => t.name === taskName);
  if (!task) return { ok: false, message: `모르는 작업입니다: ${taskName}` };
  if (running.has(task.name)) return { ok: false, message: '이미 돌고 있습니다' };
  if (task.trading && !settings.tradingEnabled) {
    return { ok: false, message: '매매가 꺼져 있습니다 — 먼저 매매를 켜야 합니다' };
  }
  if (task.guard && (await isRunningOutside(task.guard))) {
    return { ok: false, message: '같은 일이 이미 돌고 있습니다 (터미널에서 띄운 것일 수 있습니다)' };
  }
  const { clock, hhmm } = kstNow();
  void runTask(task, clock, hhmm);
  return { ok: true, message: `${task.label}을(를) 시작했습니다` };
}

/**
 * 백엔드가 뜰 때 한 번 부른다. **설정은 DB에서 읽어 이어간다** — 재시작으로
 * 자동화가 조용히 꺼지면 그날이 통째로 빈다.
 */
export async function startScheduler(): Promise<void> {
  settings = await loadSettings();
  if (timer) clearInterval(timer);
  timer = setInterval(() => { void tick(); }, 60_000);
  // 뜨자마자 한 번 본다 — 창 안이면 바로 시작한다.
  void tick();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
