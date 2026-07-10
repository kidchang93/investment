import { useEffect, useMemo, useState } from 'react';
import { fetchWatchlist, fetchCandles } from './api';
import { useStream } from './useStream';
import { Chart } from './Chart';
import type { CandlesResponse, PriceSign, Trade, WatchItem } from '@invest/shared';

/** 전일대비 부호 → 표시 색상 (1/2 상승계열, 4/5 하락계열, 3 보합) */
function signColor(sign: PriceSign): string {
  if (sign === '1' || sign === '2') return '#e5484d';
  if (sign === '4' || sign === '5') return '#3b82f6';
  return '#c7ccd6';
}

function formatPrice(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('ko-KR') : '-';
}

/** 감시 종목 한 줄 (좌측 리스트 아이템) */
function WatchRow({
  item,
  trade,
  active,
  onSelect,
}: {
  item: WatchItem;
  trade?: Trade;
  active: boolean;
  onSelect: (code: string) => void;
}): JSX.Element {
  const color = trade ? signColor(trade.sign) : '#c7ccd6';
  return (
    <button
      className={`watch-row${active ? ' active' : ''}`}
      onClick={() => onSelect(item.code)}
      type="button"
    >
      <div className="watch-row__name">
        <strong>{item.name}</strong>
        <span className="watch-row__code">{item.code}</span>
      </div>
      <div className="watch-row__price" style={{ color }}>
        <span>{trade ? formatPrice(trade.price) : '—'}</span>
        {trade && (
          <span className="watch-row__rate">
            {trade.change > 0 ? '+' : ''}
            {formatPrice(trade.change)} ({trade.changeRate.toFixed(2)}%)
          </span>
        )}
      </div>
    </button>
  );
}

export function App(): JSX.Element {
  const [watchlist, setWatchlist] = useState<WatchItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [candlesByCode, setCandlesByCode] = useState<Record<string, CandlesResponse>>({});
  const [error, setError] = useState<string | null>(null);
  const stream = useStream();

  // 감시 종목 로드 → 첫 종목 자동 선택
  useEffect(() => {
    fetchWatchlist()
      .then((items) => {
        setWatchlist(items);
        if (items.length) setSelected((cur) => cur ?? items[0].code);
      })
      .catch((e) => setError(String(e)));
  }, []);

  // 선택 종목의 일봉 로드 (한 번 받은 종목은 캐시)
  useEffect(() => {
    if (!selected || candlesByCode[selected]) return;
    fetchCandles(selected)
      .then((res) => setCandlesByCode((m) => ({ ...m, [selected]: res })))
      .catch((e) => setError(String(e)));
  }, [selected, candlesByCode]);

  const selectedCandles = selected ? candlesByCode[selected] : undefined;
  const selectedName = useMemo(
    () => watchlist.find((w) => w.code === selected)?.name ?? selected ?? '',
    [watchlist, selected],
  );

  return (
    <div className="app">
      <header className="app__header">
        <h1>실시간 시세 모니터</h1>
        <span
          className="status-dot"
          data-connected={stream.kisConnected}
          title={stream.message ?? ''}
        >
          {stream.kisConnected ? '실시간 시세 연결됨' : stream.socketOpen ? '시세 연결 대기' : '서버 연결 끊김'}
        </span>
      </header>

      {error && <div className="app__error">{error}</div>}

      <div className="app__body">
        <aside className="watchlist">
          {watchlist.map((item) => (
            <WatchRow
              key={item.code}
              item={item}
              trade={stream.trades[item.code]}
              active={item.code === selected}
              onSelect={setSelected}
            />
          ))}
        </aside>

        <main className="chart-panel">
          <div className="chart-panel__title">
            {selectedName && <h2>{selectedName}</h2>}
            {selected && stream.trades[selected] && (
              <span style={{ color: signColor(stream.trades[selected].sign) }}>
                {formatPrice(stream.trades[selected].price)}
              </span>
            )}
          </div>
          {selectedCandles ? (
            <Chart
              candles={selectedCandles.candles}
              liveTrade={selected ? stream.trades[selected] : undefined}
            />
          ) : (
            <div className="chart-panel__empty">종목을 선택하세요</div>
          )}
        </main>
      </div>
    </div>
  );
}
