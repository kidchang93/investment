/**
 * 목표 화면. **이 앱이 무엇을 하려는지 한 화면에 적는다.**
 *
 * ── 왜 이 화면이 생겼나 (2026-08-18) ─────────────────────────────────────
 *
 * 화면에 정보가 너무 많아 "지금 목표까지 어디쯤인가"를 알 수 없었다. 잔고·
 * 체결·손익·자동매매가 나란히 있었지만 **목표(연 15~20%를 3층으로)와 이어지는
 * 것이 하나도 없었다.**
 *
 * 여기 있는 것은 셋뿐이다:
 *
 *   ① 목표까지 어디쯤인가   3층 비중과 손익
 *   ② 지금 할 일           경보와 이탈. **없으면 없다고 적는다**
 *   ③ 자동화가 살아 있나    오늘 무엇이 돌았나
 *
 * ★ **연환산 수익률을 적지 않는다.** 시작한 지 며칠이라 연으로 늘리면 터무니없는
 * 숫자가 된다 — 재지 않은 값을 실제처럼 보여주지 않는다. 대신 **며칠째인지**를
 * 함께 적어 지금 숫자가 얼마나 짧은 표본인지 보이게 한다.
 */

import { useCallback, useEffect, useState } from 'react';

import type { PortfolioLayersSnapshot, TradingHealthSnapshot } from '@invest/shared';

import { API_BASE } from './config';

const won = (v: number): string => `${Math.round(v).toLocaleString('ko-KR')}원`;
const signed = (v: number): string => `${v >= 0 ? '+' : ''}${Math.round(v).toLocaleString('ko-KR')}원`;
const pct = (v: number, d = 1): string => `${(v * 100).toFixed(d)}%`;
const pnl = (v: number): 'up' | 'down' | 'flat' => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

/** 큰 돈은 조·억으로 줄여 읽기 쉽게. 정확한 값은 옆에 그대로 둔다 */
function short(v: number): string {
  if (Math.abs(v) >= 1e12) return `${(v / 1e12).toFixed(2)}조`;
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)}억`;
  return `${Math.round(v / 1e4).toLocaleString('ko-KR')}만`;
}

export function Dashboard({ accountId }: { accountId: string | null }): JSX.Element {
  const [layers, setLayers] = useState<PortfolioLayersSnapshot | null>(null);
  const [health, setHealth] = useState<TradingHealthSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    const q = `accountId=${encodeURIComponent(accountId)}`;
    /*
     * ★ **둘을 따로 기다린다.** `Promise.all`로 묶었더니 층 조회(KIS를 부르므로
     * 모의 서버에서 30초 넘게 걸릴 때가 있다)가 자동화 상태까지 붙잡아, 이미 온
     * 값도 화면에 못 그렸다. 하나가 늦어도 다른 하나는 보여야 한다.
     */
    const load = async <T,>(path: string, apply: (v: T) => void): Promise<string | null> => {
      try {
        const res = await fetch(`${API_BASE}${path}?${q}`);
        if (!res.ok) return `${path} (${res.status})`;
        apply((await res.json()) as T);
        return null;
      } catch (err) {
        // 받아 둔 값은 그대로 두고 사유만 돌려준다 — 빈 값으로 바꾸면 "아무것도 없다"가 지어진다.
        return err instanceof Error ? err.message : String(err);
      }
    };
    const results = await Promise.all([
      load<PortfolioLayersSnapshot>('/api/trading/layers', setLayers),
      load<TradingHealthSnapshot>('/api/trading/health', setHealth),
    ]);
    const failed = results.filter((r): r is string => r !== null);
    setError(failed.length === 0 ? null : `불러오지 못했습니다 — ${failed.join(' · ')}`);
    setLoading(false);
  }, [accountId]);

  useEffect(() => {
    void refresh();
    // 60초마다 스스로 갱신한다. 사람이 새로고침을 눌러야만 사실을 아는 화면은 늦는다.
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const rows = layers?.layers ?? [];
  const invested = rows.reduce((a, l) => a + l.marketValue, 0);
  const totalPnl = rows.reduce((a, l) => a + l.totalPnl, 0);
  const cost = rows.reduce((a, l) => a + l.cost, 0);
  const alerts = health?.alerts ?? [];
  const ready = layers?.configured === true && layers.totalAssets > 0;

  /* 시작한 지 며칠인가. **연환산하지 않는다** — 표본이 짧다는 사실이 보여야 한다. */
  const days = health?.startedAt
    ? Math.max(1, Math.round((Date.now() - health.startedAt) / 86_400_000))
    : null;

  /* 목표에서 얼마나 벗어났나. 가장 큰 이탈 하나만 말한다 — 다 적으면 안 읽힌다. */
  const worstGap = rows.reduce<{ label: string; gap: number } | null>((worst, l) => {
    const gap = l.weight - l.targetWeight;
    if (worst === null || Math.abs(gap) > Math.abs(worst.gap)) return { label: l.label, gap };
    return worst;
  }, null);

  return (
    <section className="dash" aria-label="목표">
      <header className="dash__head">
        <div>
          <h2>목표 연 15~20%</h2>
          <p>ETF 50% · 단기 30% · 유망주 20%로 나눠 담고, 비중을 지킨다</p>
        </div>
        <button
          aria-label={isLoading ? '갱신 중' : '새로고침'}
          className="dash__refresh"
          disabled={isLoading || !accountId}
          onClick={() => void refresh()}
          type="button"
        >
          {isLoading ? '갱신 중' : '새로고침'}
        </button>
      </header>

      {error && <p className="dash__alert" data-level="warn" role="alert">{error}</p>}

      {/* ── ② 지금 할 일 — 맨 위에 둔다. 아래 숫자를 읽기 전에 알아야 한다 ── */}
      <div className="dash__todo">
        {alerts.length === 0 ? (
          <p className="dash__ok">지금 할 일이 없습니다. 자동화가 알아서 돌고 있습니다.</p>
        ) : (
          alerts.map((a) => (
            <p className="dash__alert" data-level={a.level} key={a.message} role="alert">
              <b>{a.message}</b>
              <span>{a.action}</span>
            </p>
          ))
        )}
        {/* 경보는 아니지만 손볼 것 — 비중이 크게 벌어졌을 때만 적는다 */}
        {ready && worstGap !== null && Math.abs(worstGap.gap) >= 0.05 && (
          <p className="dash__alert" data-level="warn">
            <b>
              {worstGap.label}가 목표에서 {worstGap.gap > 0 ? '+' : ''}
              {(worstGap.gap * 100).toFixed(1)}%p 벗어나 있습니다
            </b>
            <span>터미널에서 npx tsx src/scripts/rebalance.ts 로 계획을 먼저 보세요.</span>
          </p>
        )}
      </div>

      {/* ── ① 목표까지 어디쯤인가 ───────────────────────────────────────── */}
      {ready ? (
        <>
          <div className="dash__stats">
            <div>
              <span>총자산</span>
              <strong>{short(layers.totalAssets)}</strong>
              <small>{won(layers.totalAssets)}</small>
            </div>
            <div>
              <span>손익</span>
              <strong data-pnl={pnl(totalPnl)}>{signed(totalPnl)}</strong>
              <small>
                {cost > 0 ? `원가 대비 ${pct(totalPnl / cost, 2)}` : '—'}
                {days !== null && ` · ${days}일째`}
              </small>
            </div>
            <div>
              <span>시장에 넣은 몫</span>
              <strong>{pct(invested / layers.totalAssets)}</strong>
              <small>현금 {short(layers.cash)}원 (D+2)</small>
            </div>
          </div>

          <table className="dash__layers">
            <caption>층별 — 목표 비중을 지키는 것이 이 앱이 하는 일이다</caption>
            <tbody>
              {rows.map((l) => {
                const gap = l.weight - l.targetWeight;
                const empty = l.symbols === 0 && l.closedTrades === 0;
                return (
                  <tr data-empty={empty ? '' : undefined} key={l.layer}>
                    <th scope="row">{l.label}</th>
                    <td className="dash__bar">
                      {/* 목표를 눈금으로 두고 지금을 막대로 그린다 — 숫자보다 빨리 읽힌다 */}
                      <div className="dash__track">
                        <div className="dash__fill" style={{ width: `${Math.min(100, l.weight * 100)}%` }} />
                        <div className="dash__target" style={{ left: `${l.targetWeight * 100}%` }} />
                      </div>
                    </td>
                    <td className="dash__num">
                      <b>{pct(l.weight)}</b>
                      <small>
                        목표 {pct(l.targetWeight)}
                        {Math.abs(gap) >= 0.005 && (
                          <em data-gap={gap > 0 ? 'over' : 'under'}>
                            {' '}{gap > 0 ? '+' : ''}{(gap * 100).toFixed(1)}%p
                          </em>
                        )}
                      </small>
                    </td>
                    <td className="dash__num" data-pnl={empty ? undefined : pnl(l.totalPnl)}>
                      {empty ? '아직 없음' : signed(l.totalPnl)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="dash__note">
            ★ 시작한 지 {days ?? '—'}일이라 <b>연환산 수익률을 적지 않습니다</b>. 며칠치를 연으로 늘리면
            실제로 재지 않은 숫자가 됩니다.
          </p>
        </>
      ) : (
        <p className="dash__note">
          {layers?.message ?? '계좌를 고르면 3층 현황이 여기 나옵니다. 위에서 KIS VTS 주식을 선택하세요.'}
        </p>
      )}

      {/* ── ③ 자동화가 살아 있나 ────────────────────────────────────────── */}
      <div className="dash__auto">
        <h3>오늘 자동으로 한 일</h3>
        {health === null ? (
          <p className="dash__note">확인 중</p>
        ) : health.heartbeats.length === 0 ? (
          <p className="dash__note">아직 없습니다. 평일 08:12·장중 20분마다·15:40에 돕니다.</p>
        ) : (
          <ul>
            {health.heartbeats.slice(0, 6).map((b) => (
              <li key={`${b.name}-${b.ranAt}`}>
                <time>{new Date(b.ranAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</time>
                <span>{b.name}</span>
              </li>
            ))}
          </ul>
        )}
        {health !== null && health.stopEquity > 0 && (
          <p className="dash__note">
            중단선 {short(health.stopEquity)}원 · 지금 {short(health.equity)}원.
            자산이 중단선 아래로 가면 자동 집행이 거부됩니다.
          </p>
        )}
      </div>
    </section>
  );
}
