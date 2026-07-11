import { useEffect, useMemo, useState } from 'react';
import {
  addDefaultWatchlistItem,
  fetchCategoryInstruments,
  fetchDefaultWatchlist,
  fetchInstrumentCandles,
  fetchInstrumentCategories,
  fetchInstrumentQuote,
  fetchInstrumentQuotes,
  removeDefaultWatchlistItem,
  searchInstruments,
} from './api';
import { useStream } from './useStream';
import { Chart } from './Chart';
import type {
  Candle,
  CandlesResponse,
  Instrument,
  InstrumentCategory,
  PriceSign,
  Quote,
  Trade,
} from '@invest/shared';

type RangeKey = '1M' | '3M' | '6M' | '1Y' | 'ALL';
type ChartTool = 'cursor' | 'crosshair' | 'trend' | 'measure' | 'text' | 'lock';

interface PriceSnapshot {
  price: number;
  change: number;
  changeRate: number;
  sign: PriceSign;
  open: number;
  high: number;
  low: number;
  accVolume: number;
  time?: string;
}

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string; days?: number }> = [
  { key: '1M', label: '1개월', days: 31 },
  { key: '3M', label: '3개월', days: 93 },
  { key: '6M', label: '6개월', days: 186 },
  { key: '1Y', label: '1년', days: 366 },
  { key: 'ALL', label: '전체' },
];

const TOOL_OPTIONS: Array<{ key: ChartTool; label: string; title: string }> = [
  { key: 'cursor', label: '+', title: '커서' },
  { key: 'crosshair', label: 'X', title: '십자선' },
  { key: 'trend', label: '/', title: '추세선' },
  { key: 'measure', label: '<>', title: '측정' },
  { key: 'text', label: 'T', title: '텍스트' },
  { key: 'lock', label: '#', title: '도구 잠금' },
];

const OVERSEAS_REFRESH_MS = 5_000;
const LIST_QUOTE_REFRESH_MS = 15_000;
const MAX_LIST_QUOTE_TARGETS = 30;
const CATEGORY_QUOTE_TARGETS = 20;
const SEARCH_QUOTE_TARGETS = 10;

function signColor(sign?: PriceSign): string {
  if (sign === '1' || sign === '2') return '#e5484d';
  if (sign === '4' || sign === '5') return '#3b82f6';
  return '#c7ccd6';
}

function formatPrice(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('ko-KR') : '-';
}

function formatRate(n: number): string {
  if (!Number.isFinite(n)) return '-';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function formatSignedPrice(n: number): string {
  if (!Number.isFinite(n)) return '-';
  return `${n > 0 ? '+' : ''}${formatPrice(n)}`;
}

function formatVolume(n: number): string {
  if (!Number.isFinite(n)) return '-';
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}억`;
  if (n >= 10_000) return `${Math.floor(n / 10_000).toLocaleString('ko-KR')}만`;
  return n.toLocaleString('ko-KR');
}

function formatTradeTime(time: string | undefined): string {
  if (!time || !/^\d{6}$/.test(time)) return '실시간 대기';
  return `${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
}

function formatClock(ms: number | null): string {
  if (!ms) return '시세 연결 대기';
  return new Intl.DateTimeFormat('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

function toSnapshot(trade: Trade | undefined, quote: Quote | undefined): PriceSnapshot | undefined {
  if (trade) return trade;
  if (quote) return quote;
  return undefined;
}

function filterCandles(candles: Candle[], range: RangeKey): Candle[] {
  const option = RANGE_OPTIONS.find((item) => item.key === range);
  if (!option?.days || candles.length === 0) return candles;
  const lastTime = candles[candles.length - 1].time;
  const cutoff = lastTime - option.days * 86_400;
  return candles.filter((candle) => candle.time >= cutoff);
}

function marketLabel(instrument: Instrument): string {
  return `${instrument.market} · ${instrument.currency}`;
}

/** 감시 종목 한 줄 */
function InstrumentRow({
  instrument,
  trade,
  quote,
  active,
  watched,
  onSelect,
  onToggleWatch,
}: {
  instrument: Instrument;
  trade?: Trade;
  quote?: Quote;
  active: boolean;
  watched: boolean;
  onSelect: (instrument: Instrument) => void;
  onToggleWatch: (instrument: Instrument) => void;
}): JSX.Element {
  const snapshot = toSnapshot(trade, quote);
  const color = signColor(snapshot?.sign);
  return (
    <button
      className={`instrument-row${active ? ' active' : ''}`}
      onClick={() => onSelect(instrument)}
      type="button"
    >
      <div className="instrument-row__name">
        <strong>{instrument.name}</strong>
        <span className="instrument-row__code">
          {instrument.symbol} · {marketLabel(instrument)}
        </span>
      </div>
      <div className="instrument-row__price" style={{ color }}>
        <span>{snapshot ? formatPrice(snapshot.price) : '-'}</span>
        {snapshot && (
          <span className="instrument-row__rate">
            {formatSignedPrice(snapshot.change)} ({formatRate(snapshot.changeRate)})
          </span>
        )}
      </div>
      <span
        className="instrument-row__watch"
        onClick={(event) => {
          event.stopPropagation();
          onToggleWatch(instrument);
        }}
        role="button"
        tabIndex={0}
        title={watched ? '관심종목에서 제거' : '관심종목에 추가'}
      >
        {watched ? '−' : '+'}
      </span>
    </button>
  );
}

export function App(): JSX.Element {
  const [watchlist, setWatchlist] = useState<Instrument[]>([]);
  const [categories, setCategories] = useState<InstrumentCategory[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>('kr-major');
  const [categoryItems, setCategoryItems] = useState<Instrument[]>([]);
  const [selectedInstrument, setSelectedInstrument] = useState<Instrument | null>(null);
  const [candlesByCode, setCandlesByCode] = useState<Record<string, CandlesResponse>>({});
  const [quotesByCode, setQuotesByCode] = useState<Record<string, Quote>>({});
  const [query, setQuery] = useState('');
  const [symbolQuery, setSymbolQuery] = useState('');
  const [symbolResults, setSymbolResults] = useState<Instrument[]>([]);
  const [range, setRange] = useState<RangeKey>('3M');
  const [activeTool, setActiveTool] = useState<ChartTool>('crosshair');
  const [error, setError] = useState<string | null>(null);
  const [quoteRefreshAt, setQuoteRefreshAt] = useState<number | null>(null);
  const stream = useStream();

  // 관심종목 로드 → 첫 종목 자동 선택
  useEffect(() => {
    fetchDefaultWatchlist()
      .then((items) => {
        setWatchlist(items);
        if (items.length) setSelectedInstrument((cur) => cur ?? items[0]);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    fetchInstrumentCategories()
      .then(setCategories)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    fetchCategoryInstruments(activeCategory)
      .then(setCategoryItems)
      .catch((e) => setError(String(e)));
  }, [activeCategory]);

  // 선택 종목의 일봉 로드 (한 번 받은 종목은 캐시)
  useEffect(() => {
    if (!selectedInstrument || candlesByCode[selectedInstrument.id]) return;
    fetchInstrumentCandles(selectedInstrument.id)
      .then((res) => setCandlesByCode((m) => ({ ...m, [selectedInstrument.id]: res })))
      .catch((e) => setError(String(e)));
  }, [selectedInstrument, candlesByCode]);

  // 선택 종목의 현재가 스냅샷. 실시간 체결이 오기 전 가격 헤더를 채운다.
  useEffect(() => {
    if (!selectedInstrument) return;
    fetchInstrumentQuote(selectedInstrument.id)
      .then((res) => setQuotesByCode((m) => ({ ...m, [selectedInstrument.id]: res })))
      .catch((e) => setError(String(e)));
  }, [selectedInstrument]);

  // 해외 실시간 WS는 별도 TR이라, 우선 선택 해외 종목은 짧은 폴링으로 차트와 헤더를 갱신한다.
  useEffect(() => {
    if (!selectedInstrument || selectedInstrument.country === 'KR') return;
    const refresh = (): void => {
      void fetchInstrumentQuote(selectedInstrument.id)
        .then((res) => setQuotesByCode((m) => ({ ...m, [selectedInstrument.id]: res })))
        .catch((e) => setError(String(e)));
      void fetchInstrumentCandles(selectedInstrument.id)
        .then((res) => setCandlesByCode((m) => ({ ...m, [selectedInstrument.id]: res })))
        .catch((e) => setError(String(e)));
    };
    const timer = window.setInterval(refresh, OVERSEAS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [selectedInstrument]);

  useEffect(() => {
    const q = symbolQuery.trim();
    if (q.length < 2) {
      setSymbolResults([]);
      return;
    }
    const timer = window.setTimeout(() => {
      searchInstruments(q)
        .then(setSymbolResults)
        .catch((e) => setError(String(e)));
    }, 200);
    return () => window.clearTimeout(timer);
  }, [symbolQuery]);

  const quoteTargetIds = useMemo(() => {
    const ids = new Set<string>();
    const selectedOverseasId = selectedInstrument?.country !== 'KR' ? selectedInstrument?.id : undefined;

    function add(instrument: Instrument): void {
      if (instrument.id === selectedOverseasId) return;
      ids.add(instrument.id);
    }

    if (selectedInstrument?.country === 'KR') add(selectedInstrument);
    for (const instrument of watchlist) add(instrument);
    for (const instrument of categoryItems.slice(0, CATEGORY_QUOTE_TARGETS)) add(instrument);
    for (const instrument of symbolResults.slice(0, SEARCH_QUOTE_TARGETS)) add(instrument);
    return [...ids].slice(0, MAX_LIST_QUOTE_TARGETS);
  }, [categoryItems, selectedInstrument, symbolResults, watchlist]);
  const quoteTargetKey = quoteTargetIds.join('|');

  // 화면에 보이는 종목들의 REST 현재가를 유지해 클릭 전에도 리스트 가격이 채워지게 한다.
  useEffect(() => {
    if (quoteTargetIds.length === 0) return;

    let disposed = false;
    const refresh = (): void => {
      if (document.hidden) return;
      void fetchInstrumentQuotes(quoteTargetIds)
        .then((quotes) => {
          if (disposed) return;
          setQuotesByCode((items) => {
            const next = { ...items };
            for (const quote of quotes) next[quote.code] = quote;
            return next;
          });
          setQuoteRefreshAt(Date.now());
        })
        .catch((e) => {
          if (!disposed) setError(String(e));
        });
    };

    refresh();
    const timer = window.setInterval(refresh, LIST_QUOTE_REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [quoteTargetKey]);

  const selectedCandles = selectedInstrument ? candlesByCode[selectedInstrument.id] : undefined;
  const visibleCandles = useMemo(
    () => (selectedCandles ? filterCandles(selectedCandles.candles, range) : []),
    [range, selectedCandles],
  );
  const selectedName = selectedInstrument?.name ?? '';
  const filteredWatchlist = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return watchlist;
    return watchlist.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.symbol.toLowerCase().includes(q) ||
        (item.englishName?.toLowerCase().includes(q) ?? false),
    );
  }, [query, watchlist]);
  const selectedTrade =
    selectedInstrument?.country === 'KR' ? stream.trades[selectedInstrument.providerSymbol] : undefined;
  const selectedQuote = selectedInstrument ? quotesByCode[selectedInstrument.id] : undefined;
  const snapshot = toSnapshot(selectedTrade, selectedQuote);
  const selectedColor = signColor(snapshot?.sign);
  const watchedIds = useMemo(() => new Set(watchlist.map((item) => item.id)), [watchlist]);

  function selectInstrument(instrument: Instrument): void {
    setSelectedInstrument(instrument);
  }

  function toggleWatch(instrument: Instrument): void {
    if (watchedIds.has(instrument.id)) {
      removeDefaultWatchlistItem(instrument.id)
        .then(() => setWatchlist((items) => items.filter((item) => item.id !== instrument.id)))
        .catch((e) => setError(String(e)));
      return;
    }
    addDefaultWatchlistItem(instrument.id)
      .then((item) => setWatchlist((items) => (items.some((cur) => cur.id === item.id) ? items : [...items, item])))
      .catch((e) => setError(String(e)));
  }

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <span className="app__eyebrow">조회 전용</span>
          <h1>실시간 시세</h1>
        </div>
        <div className="app__status">
          <span className="mode-chip">실전</span>
          <span
            className="status-dot"
            data-connected={stream.kisConnected}
            title={stream.message ?? ''}
          >
            {stream.kisConnected
              ? '실시간 시세 연결됨'
              : stream.socketOpen
                ? '시세 연결 대기'
                : '서버 연결 끊김'}
          </span>
        </div>
      </header>

      {error && <div className="app__error">{error}</div>}

      <div className="app__body">
        <nav className="tool-rail" aria-label="차트 도구">
          {TOOL_OPTIONS.map((tool) => (
            <button
              aria-label={tool.title}
              aria-pressed={tool.key === activeTool}
              className="tool-rail__button"
              key={tool.key}
              onClick={() => setActiveTool(tool.key)}
              title={tool.title}
              type="button"
            >
              {tool.label}
            </button>
          ))}
        </nav>

        <main className="chart-panel">
          <div className="chart-commandbar">
            <div className="chart-commandbar__symbol">
              <span>{selectedInstrument?.country ?? '-'}</span>
              <strong>{selectedName || '-'}</strong>
              <small>{selectedInstrument ? marketLabel(selectedInstrument) : '-'}</small>
            </div>
            <div className="symbol-search">
              <input
                aria-label="국내/해외 종목 검색"
                onChange={(event) => setSymbolQuery(event.target.value)}
                placeholder="종목 검색: 삼성전자, AAPL, TSLA"
                type="search"
                value={symbolQuery}
              />
              {symbolResults.length > 0 && (
                <div className="symbol-search__results">
                  {symbolResults.map((instrument) => (
                    <button
                      key={instrument.id}
                      onClick={() => {
                        setSelectedInstrument(instrument);
                        setSymbolQuery('');
                        setSymbolResults([]);
                      }}
                      type="button"
                    >
                      <strong>{instrument.symbol}</strong>
                      <span>{instrument.name}</span>
                      <small>{marketLabel(instrument)}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="chart-commandbar__actions">
              <button type="button">지표</button>
              <button type="button">비교</button>
              <button type="button">알림</button>
              <button type="button">설정</button>
            </div>
          </div>

          <section className="quote-header">
            <div className="quote-header__identity">
              <span className="quote-header__code">{selectedInstrument?.symbol ?? '-'}</span>
              <h2>{selectedName || '종목을 선택하세요'}</h2>
              <span className="quote-header__time">{formatTradeTime(snapshot?.time)}</span>
            </div>
            <div className="quote-header__price" style={{ color: selectedColor }}>
              <strong>{snapshot ? formatPrice(snapshot.price) : '-'}</strong>
              {snapshot && (
                <span>
                  {formatSignedPrice(snapshot.change)} ({formatRate(snapshot.changeRate)})
                </span>
              )}
            </div>
            <div className="quote-stats">
              <div>
                <span>시가</span>
                <strong>{snapshot ? formatPrice(snapshot.open) : '-'}</strong>
              </div>
              <div>
                <span>고가</span>
                <strong>{snapshot ? formatPrice(snapshot.high) : '-'}</strong>
              </div>
              <div>
                <span>저가</span>
                <strong>{snapshot ? formatPrice(snapshot.low) : '-'}</strong>
              </div>
              <div>
                <span>거래량</span>
                <strong>{snapshot ? formatVolume(snapshot.accVolume) : '-'}</strong>
              </div>
            </div>
          </section>

          <div className="chart-toolbar">
            <div className="range-tabs" role="tablist" aria-label="차트 기간">
              {RANGE_OPTIONS.map((item) => (
                <button
                  aria-selected={item.key === range}
                  className="range-tabs__button"
                  key={item.key}
                  onClick={() => setRange(item.key)}
                  role="tab"
                  type="button"
                >
                  {item.label}
                </button>
              ))}
            </div>
            <span className="chart-toolbar__meta">
              {visibleCandles.length ? `${visibleCandles.length}개 일봉` : '데이터 대기'}
            </span>
          </div>

          <div className="chart-frame">
            <div className="chart-readout">
              <strong>{selectedName || '-'}</strong>
              <span>O {snapshot ? formatPrice(snapshot.open) : '-'}</span>
              <span>H {snapshot ? formatPrice(snapshot.high) : '-'}</span>
              <span>L {snapshot ? formatPrice(snapshot.low) : '-'}</span>
              <span>C {snapshot ? formatPrice(snapshot.price) : '-'}</span>
              <span>{TOOL_OPTIONS.find((tool) => tool.key === activeTool)?.title}</span>
            </div>
            {selectedCandles ? (
              <Chart
                candles={visibleCandles}
                liveTrade={selectedTrade}
              />
            ) : (
              <div className="chart-panel__empty">
                {selectedInstrument ? '차트 로딩 중' : '종목을 선택하세요'}
              </div>
            )}
          </div>

          <div className="bottom-dock">
            <button aria-selected="true" type="button">거래량</button>
            <button aria-selected="false" type="button">체결</button>
            <button aria-selected="false" type="button">뉴스</button>
            <span>조회 전용 세션 · 시세 갱신 {formatClock(quoteRefreshAt)}</span>
          </div>
        </main>

        <aside className="watchlist">
          <div className="watchlist__header">
            <strong>관심종목</strong>
            <span>{watchlist.length}</span>
          </div>
          <input
            aria-label="종목 검색"
            className="watchlist__search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="종목명 또는 코드"
            type="search"
            value={query}
          />
          <div className="watchlist__rows watchlist__rows--saved">
            {filteredWatchlist.map((instrument) => (
              <InstrumentRow
                key={instrument.id}
                instrument={instrument}
                trade={instrument.country === 'KR' ? stream.trades[instrument.providerSymbol] : undefined}
                quote={quotesByCode[instrument.id]}
                active={instrument.id === selectedInstrument?.id}
                watched={watchedIds.has(instrument.id)}
                onSelect={selectInstrument}
                onToggleWatch={toggleWatch}
              />
            ))}
            {filteredWatchlist.length === 0 && (
              <div className="watchlist__empty">관심종목이 없습니다</div>
            )}
          </div>
          <div className="discover">
            <div className="discover__header">
              <strong>추천 리스트</strong>
              <span>탐색 후 + 추가</span>
            </div>
            <div className="category-tabs">
              {categories.map((category) => (
                <button
                  aria-selected={category.id === activeCategory}
                  key={category.id}
                  onClick={() => setActiveCategory(category.id)}
                  title={category.description}
                  type="button"
                >
                  {category.label}
                </button>
              ))}
            </div>
            <div className="watchlist__rows">
              {categoryItems.map((instrument) => (
                <InstrumentRow
                  key={instrument.id}
                  instrument={instrument}
                  trade={instrument.country === 'KR' ? stream.trades[instrument.providerSymbol] : undefined}
                  quote={quotesByCode[instrument.id]}
                  active={instrument.id === selectedInstrument?.id}
                  watched={watchedIds.has(instrument.id)}
                  onSelect={selectInstrument}
                  onToggleWatch={toggleWatch}
                />
              ))}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
