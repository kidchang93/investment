/**
 * 3층 성과 카드. **어느 층이 목표를 만들고 어느 층이 까먹는지** 한 화면에 적는다.
 *
 * ── 왜 이 카드가 있나 (2026-08-18) ───────────────────────────────────────
 *
 * 잔고 카드는 계좌 전체 손익만 보여준다. 그러면 층이 섞여 보이지 않는다 —
 * 2026-08-14에 평가손익의 **98%가 한 종목**(KODEX 200)에서 나왔는데 합계만으로는
 * 분산이 작동하는 것처럼 읽혔다. 목표(연 15~20%)까지 무엇이 비어 있는지도
 * 숫자로 보이지 않았다.
 *
 * ★ **비어 있는 층도 줄로 남긴다.** 0원인 것이 사실이고, 그 사실이 보여야
 * "단기 30%가 아직 0%"라는 것을 안다. 목록에서 빼면 없는 층처럼 읽힌다.
 */

import { useCallback, useEffect, useState } from 'react';

import type { PortfolioLayerSummary, PortfolioLayersSnapshot } from '@invest/shared';

import { API_BASE } from './config';

function formatWon(value: number): string {
  return `${Math.round(value).toLocaleString('ko-KR')}원`;
}

function formatSigned(value: number): string {
  return `${value >= 0 ? '+' : ''}${Math.round(value).toLocaleString('ko-KR')}원`;
}

function formatPercent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/** 손익 부호. **색은 판정에만 쓴다** — 층을 색으로 가르지 않는다 */
function pnlSign(value: number): 'up' | 'down' | 'flat' {
  if (value > 0) return 'up';
  if (value < 0) return 'down';
  return 'flat';
}

function LayerRow({ layer, isEmpty }: { layer: PortfolioLayerSummary; isEmpty: boolean }): JSX.Element {
  const gap = layer.weight - layer.targetWeight;
  return (
    <tr data-empty={isEmpty ? '' : undefined}>
      <th scope="row">
        <b>{layer.label}</b>
        <small title={layer.rationale}>{layer.rationale}</small>
      </th>
      <td className="num">
        {formatPercent(layer.weight)}
        <small>
          목표 {formatPercent(layer.targetWeight)}
          {/* 이탈이 0.5%p를 넘을 때만 적는다. 늘 뜨는 표시는 안 읽힌다. */}
          {Math.abs(gap) >= 0.005 && (
            <em data-gap={gap > 0 ? 'over' : 'under'}>
              {' '}
              {gap > 0 ? '+' : ''}
              {(gap * 100).toFixed(1)}%p
            </em>
          )}
        </small>
      </td>
      <td className="num">{isEmpty ? '—' : formatWon(layer.marketValue)}</td>
      <td className="num" data-pnl={isEmpty ? undefined : pnlSign(layer.unrealizedPnl)}>
        {isEmpty ? '—' : formatSigned(layer.unrealizedPnl)}
      </td>
      <td className="num" data-pnl={layer.closedTrades === 0 ? undefined : pnlSign(layer.realizedPnl)}>
        {/* 청산이 없으면 0원이 아니라 "아직 없음"이다 — 0으로 적으면 본전으로 읽힌다 */}
        {layer.closedTrades === 0 ? '—' : formatSigned(layer.realizedPnl)}
      </td>
      <td className="num" data-pnl={isEmpty ? undefined : pnlSign(layer.contribution)}>
        {isEmpty ? '—' : `${(layer.contribution * 100).toFixed(2)}%p`}
      </td>
    </tr>
  );
}

export function PortfolioLayers({ accountId }: { accountId: string | null }): JSX.Element {
  const [snapshot, setSnapshot] = useState<PortfolioLayersSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/trading/layers?accountId=${encodeURIComponent(accountId)}`);
      if (!response.ok) throw new Error(`3층 성과를 불러오지 못했습니다 (${response.status})`);
      setSnapshot((await response.json()) as PortfolioLayersSnapshot);
      // 성공하면 오류를 지운다 — 일시적 실패가 저절로 낫는다.
      setError(null);
    } catch (err) {
      /*
       * ★ 받아 둔 값은 그대로 두고 오류만 올린다. 빈 값으로 바꾸면 "층이 없다"가
       * 지어지고, 그건 조회 실패와 전혀 다른 사실이다.
       */
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const layers = snapshot?.layers ?? [];
  const totalPnl = layers.reduce((sum, l) => sum + l.totalPnl, 0);
  const invested = layers.reduce((sum, l) => sum + l.marketValue, 0);
  const mismatches = snapshot?.mismatches ?? [];

  return (
    <section className="portfolio-card portfolio-card--wide" aria-label="3층 성과">
      <div className="portfolio-card__header">
        <div>
          <strong>3층 성과</strong>
          <span>
            {snapshot
              ? `총자산 ${formatWon(snapshot.totalAssets)} · 갱신 ${new Date(snapshot.fetchedAt).toLocaleTimeString('ko-KR')}`
              : error
                ? '조회 실패'
                : '조회 대기'}
          </span>
        </div>
        <div className="portfolio-card__actions">
          <button
            aria-label={isLoading ? '3층 성과 조회 중' : '3층 성과 새로고침'}
            className="portfolio-card__refresh"
            disabled={isLoading || !accountId}
            onClick={() => void refresh()}
            type="button"
          >
            {isLoading ? '조회 중' : '새로고침'}
          </button>
        </div>
      </div>

      {/*
        ★★ 장부와 잔고가 어긋나면 **아래 숫자를 믿으면 안 된다.** 그 사실을 표
        위에 둔다 — 아래 각주로 두면 다 읽은 뒤에 만나게 된다.
      */}
      {mismatches.length > 0 && (
        <p className="layer-alert" role="alert">
          <b>장부와 증권사 잔고가 {mismatches.length}종목 어긋납니다.</b> 아래 층별 숫자는 그만큼
          사실과 다릅니다 ({mismatches.map((m) => `${m.symbol} 장부 ${m.ledger} vs 증권사 ${m.broker}`).join(' · ')}).
          빠진 체결을 장부에 넣어야 합니다.
        </p>
      )}
      {error && <p className="layer-alert" role="alert">{error}</p>}
      {snapshot && !snapshot.configured && (
        <p className="layer-empty">{snapshot.message ?? 'KIS 계좌가 설정되지 않았습니다.'}</p>
      )}

      {/*
        ★ 총자산이 0이면 표를 그리지 않는다. 0원짜리 표는 "다 잃었다"로 읽히는데
        실제로는 **다른 계좌를 보고 있거나 아직 못 받은 것**이다(선물옵션 계좌를
        고르면 주식 보유가 0으로 온다).
      */}
      {snapshot?.configured && snapshot.totalAssets <= 0 && (
        <p className="layer-empty">
          이 계좌에는 보유도 현금도 없습니다. 위에서 <b>KIS VTS 주식</b> 계좌를 고르셨는지 확인해 주세요.
        </p>
      )}

      {layers.length > 0 && snapshot !== null && snapshot.totalAssets > 0 && (
        <>
          <table className="layer-table">
            <thead>
              <tr>
                <th scope="col">층</th>
                <th scope="col">비중</th>
                <th scope="col">평가액</th>
                <th scope="col">평가손익</th>
                <th scope="col">실현손익</th>
                <th scope="col" title="총자산 대비 이 층이 만든 손익. 크기가 다른 층을 견주는 자">
                  목표 기여
                </th>
              </tr>
            </thead>
            <tbody>
              {layers.map((layer) => (
                <LayerRow isEmpty={layer.symbols === 0 && layer.closedTrades === 0} key={layer.layer} layer={layer} />
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">합계</th>
                <td className="num">
                  {snapshot && snapshot.totalAssets > 0 ? formatPercent(invested / snapshot.totalAssets) : '—'}
                </td>
                <td className="num">{formatWon(invested)}</td>
                <td className="num" colSpan={2} data-pnl={pnlSign(totalPnl)}>
                  {formatSigned(totalPnl)}
                </td>
                <td className="num" data-pnl={pnlSign(totalPnl)}>
                  {snapshot && snapshot.totalAssets > 0
                    ? `${((totalPnl / snapshot.totalAssets) * 100).toFixed(2)}%p`
                    : '—'}
                </td>
              </tr>
            </tfoot>
          </table>

          {/*
            승률은 **청산된 매매에서만** 나온다. 보유 중인 것은 아직 결과가 아니다.
            손익비에서 본전 승률을 함께 적는 이유 — 2026-08-03 실주행이 승률 33.3%·
            손익비 0.44라 **승률 70%를 요구하는 구조**였고 그래서 졌다.
          */}
          <div className="layer-trades">
            {layers.filter((l) => l.closedTrades > 0).length === 0 ? (
              <p className="layer-empty">
                청산된 매매가 아직 없습니다. 승률·손익비는 판 뒤에야 나옵니다 — 보유 중인 것은 결과가 아닙니다.
              </p>
            ) : (
              layers
                .filter((l) => l.closedTrades > 0)
                .map((l) => (
                  <p key={l.layer}>
                    <b>{l.label}</b> 청산 {l.closedTrades}건 · 승률{' '}
                    {l.winRate === null ? '—' : formatPercent(l.winRate)}
                    {l.profitFactor !== null && ` · 손익비 ${l.profitFactor.toFixed(2)}`}
                    {l.breakEvenWinRate !== null && (
                      <>
                        {' '}
                        → 본전 승률 <b>{formatPercent(l.breakEvenWinRate)}</b>
                      </>
                    )}
                  </p>
                ))
            )}
          </div>

          {snapshot && snapshot.unpriced.length > 0 && (
            <p className="layer-empty">
              현재가를 못 받아 평가액에서 뺀 자리: {snapshot.unpriced.join(' ')} (원가는 남아 있습니다)
            </p>
          )}
          <p className="layer-note">
            비중은 <b>D+2 현금 {snapshot ? formatWon(snapshot.cash) : '—'}</b>을 포함한 총자산 기준입니다. 예수금(D+0)은
            오늘 산 것이 아직 안 빠진 값이라 그것으로 재면 자산이 부풀어 보입니다.
          </p>
        </>
      )}
    </section>
  );
}
