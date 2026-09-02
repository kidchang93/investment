/**
 * 자동화 관제 카드. **터미널 없이 켜고 끄고 지금 무엇이 도는지 본다.**
 *
 * ── 왜 이 카드가 있나 (2026-09-02) ───────────────────────────────────────
 *
 * 사용자가 말했다 — *"웹에서 컨트롤하고 싶은데 데몬 이런 게 아니라."*
 *
 * 그전까지 자동화는 터미널 데몬(`scripts/daemon.sh`)이었다. 켜는 것도
 * (`start`), 끄는 것도(`stop`), 지금 무엇이 도는지 보는 것도(`status`)
 * **전부 명령어**였다. 스케줄러가 백엔드로 들어왔으므로 이제 화면에서 한다.
 *
 * ★ **스위치가 둘인 이유.** "자동화"와 "매매"는 다른 것이다. 자동화를 켜도
 *   판단자는 안 돈다 — 검증된 규칙이 설 때까지 새로 사지 않기로 했다
 *   (2026-09-02). 손절·수집·감시는 자동화 스위치만으로 돈다. 하나로 묶으면
 *   "감시를 켜려면 매매도 켜야" 하고, 그건 위험한 쪽으로 사람을 민다.
 *
 * ★ **손절이 매매 스위치에 안 걸린다.** `plan.stopPrice`는 판단자가 사기 전에
 *   스스로 적은 값이라 지키는 것은 새 매매가 아니다.
 */

import { useCallback, useEffect, useState } from 'react';

import { API_BASE } from './config';

interface TaskState {
  name: string;
  label: string;
  window: [number, number];
  trading: boolean;
  daily: boolean;
  everyMinutes?: number;
  doneToday: boolean;
  lastRunAt: string | null;
  running: boolean;
  inWindow: boolean;
  skipped: 'trading-off' | null;
  noHeartbeat?: boolean;
  background?: boolean;
}

interface RecentRun {
  name: string;
  startedAt: number;
  finishedAt: number | null;
  ok: boolean | null;
  output: string;
}

interface AutomationStatus {
  settings: { enabled: boolean; tradingEnabled: boolean };
  ticking: boolean;
  lastTickAt: number | null;
  now: string;
  weekday: number;
  tasks: TaskState[];
  recent: RecentRun[];
}

/** `HHMM` 정수를 `HH:MM`으로 */
function clockLabel(value: number): string {
  return `${String(Math.floor(value / 100)).padStart(2, '0')}:${String(value % 100).padStart(2, '0')}`;
}

function timeLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function Automation(): JSX.Element {
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/automation/status`);
      if (!res.ok) throw new Error(`상태를 불러오지 못했습니다 (HTTP ${res.status})`);
      setStatus((await res.json()) as AutomationStatus);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '상태를 불러오지 못했습니다');
    }
  }, []);

  useEffect(() => {
    void load();
    // 30초마다 새로 본다. 작업은 분 단위라 이 주기면 충분하다.
    const timer = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const toggle = useCallback(async (key: 'enabled' | 'tradingEnabled', value: boolean) => {
    setBusy(key);
    try {
      const res = await fetch(`${API_BASE}/api/automation/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
      if (!res.ok) throw new Error(`바꾸지 못했습니다 (HTTP ${res.status})`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '바꾸지 못했습니다');
    } finally {
      setBusy(null);
    }
  }, [load]);

  const runNow = useCallback(async (task: string) => {
    setBusy(task);
    try {
      const res = await fetch(`${API_BASE}/api/automation/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task }),
      });
      const body = (await res.json()) as { message?: string };
      if (!res.ok) throw new Error(body.message ?? `실행하지 못했습니다 (HTTP ${res.status})`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '실행하지 못했습니다');
    } finally {
      setBusy(null);
    }
  }, [load]);

  if (error && !status) {
    return (
      <section className="automation automation--error" aria-label="자동화">
        <p>{error}</p>
        <p className="automation__hint">백엔드(:4000)가 떠 있는지 확인하세요.</p>
      </section>
    );
  }
  if (!status) return <section className="automation" aria-label="자동화"><p>불러오는 중…</p></section>;

  const { settings, tasks, recent, weekday } = status;
  const weekend = weekday > 5;

  return (
    <section className="automation" aria-label="자동화">
      <header className="automation__head">
        <div className="automation__switches">
          <button
            type="button"
            className="automation__switch"
            data-on={settings.enabled}
            disabled={busy === 'enabled'}
            onClick={() => { void toggle('enabled', !settings.enabled); }}
          >
            <span className="automation__dot" aria-hidden="true" />
            {settings.enabled ? '자동화 켜짐' : '자동화 꺼짐'}
          </button>
          <button
            type="button"
            className="automation__switch automation__switch--trade"
            data-on={settings.tradingEnabled}
            disabled={busy === 'tradingEnabled'}
            onClick={() => { void toggle('tradingEnabled', !settings.tradingEnabled); }}
          >
            <span className="automation__dot" aria-hidden="true" />
            {settings.tradingEnabled ? '매매 켜짐 — 판단자가 산다' : '매매 꺼짐'}
          </button>
        </div>
        <span className="automation__now">
          {status.now} KST{weekend ? ' · 주말이라 아무것도 안 합니다' : ''}
        </span>
      </header>

      {settings.enabled && !settings.tradingEnabled && (
        <p className="automation__note">
          손절·수집·감시는 돕니다. <strong>판단자가 새로 사지 않습니다</strong> —
          검증된 규칙이 설 때까지입니다.
        </p>
      )}
      {!settings.enabled && (
        <p className="automation__note automation__note--warn">
          꺼져 있습니다. <strong>손절도 안 돕니다</strong> — 보유 종목이 있으면 켜 두세요.
        </p>
      )}
      {error && <p className="automation__note automation__note--warn">{error}</p>}

      <ol className="automation__tasks">
        {tasks.map((task) => {
          const state = task.running
            ? '도는 중'
            : task.skipped
              ? '매매 꺼짐'
              : task.doneToday
                ? '오늘 함'
                : task.inWindow
                  ? '대기'
                  : '창 밖';
          return (
            <li key={task.name} className="automation__task" data-state={state} data-window={task.inWindow}>
              <span className="automation__task-time">
                {clockLabel(task.window[0])}
                {task.everyMinutes ? ` · ${task.everyMinutes}분마다` : ''}
              </span>
              <span className="automation__task-label">
                {task.label}
                {task.trading && <em className="automation__tag">매매</em>}
                {task.background && <em className="automation__tag automation__tag--bg">오래 걸림</em>}
              </span>
              <span className="automation__task-state">{state}</span>
              <span className="automation__task-last">{task.lastRunAt ?? '—'}</span>
              <button
                type="button"
                className="automation__run"
                disabled={busy === task.name || task.running || Boolean(task.skipped)}
                onClick={() => { void runNow(task.name); }}
                aria-label={`${task.label} 지금 실행`}
              >
                지금 실행
              </button>
            </li>
          );
        })}
      </ol>

      {recent.length > 0 && (
        <details className="automation__recent">
          <summary>최근 실행 {recent.length}건</summary>
          <ul>
            {recent.map((run) => (
              <li key={`${run.name}-${run.startedAt}`} data-ok={run.ok}>
                <span className="automation__recent-time">{timeLabel(run.startedAt)}</span>
                <span className="automation__recent-name">{run.name}</span>
                <span className="automation__recent-result">
                  {run.finishedAt === null ? '도는 중' : run.ok ? '성공' : '실패'}
                </span>
                {run.output && <pre>{run.output.slice(-600)}</pre>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
