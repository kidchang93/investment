import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addDefaultWatchlistItem,
  fetchCategoryInstruments,
  fetchDefaultWatchlist,
  fetchInstrumentCandles,
  fetchInstrumentCategories,
  fetchInstrumentIntradayCandles,
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
type TimeframeKey = '1' | '5' | '15' | '1D';
type ChartTool = 'cursor' | 'crosshair' | 'trend' | 'measure' | 'text' | 'lock';
type MoveFilter = 'all' | 'up' | 'down';
type WatchSortKey = 'custom' | 'rate' | 'volume' | 'name';

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

const TIMEFRAME_OPTIONS: Array<{ key: TimeframeKey; label: string; minutes?: number }> = [
  { key: '1', label: '1분', minutes: 1 },
  { key: '5', label: '5분', minutes: 5 },
  { key: '15', label: '15분', minutes: 15 },
  { key: '1D', label: '일봉' },
];

const MOVE_FILTER_OPTIONS: Array<{ key: MoveFilter; label: string }> = [
  { key: 'all', label: '전체' },
  { key: 'up', label: '상승' },
  { key: 'down', label: '하락' },
];

const WATCH_SORT_OPTIONS: Array<{ key: WatchSortKey; label: string }> = [
  { key: 'custom', label: '기본순' },
  { key: 'rate', label: '등락률순' },
  { key: 'volume', label: '거래량순' },
  { key: 'name', label: '이름순' },
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

function moveTone(sign?: PriceSign): 'up' | 'down' | 'flat' {
  if (sign === '1' || sign === '2') return 'up';
  if (sign === '4' || sign === '5') return 'down';
  return 'flat';
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

function sortBySnapshot(
  items: Instrument[],
  sortKey: WatchSortKey,
  getSnapshot: (instrument: Instrument) => PriceSnapshot | undefined,
): Instrument[] {
  if (sortKey === 'custom') return items;
  return [...items].sort((a, b) => {
    const aSnapshot = getSnapshot(a);
    const bSnapshot = getSnapshot(b);
    if (sortKey === 'name') return a.name.localeCompare(b.name, 'ko-KR');
    if (sortKey === 'rate') return (bSnapshot?.changeRate ?? -Infinity) - (aSnapshot?.changeRate ?? -Infinity);
    return (bSnapshot?.accVolume ?? -Infinity) - (aSnapshot?.accVolume ?? -Infinity);
  });
}

function filterByMove(
  items: Instrument[],
  filter: MoveFilter,
  getSnapshot: (instrument: Instrument) => PriceSnapshot | undefined,
): Instrument[] {
  if (filter === 'all') return items;
  return items.filter((item) => moveTone(getSnapshot(item)?.sign) === filter);
}

function filterCandles(candles: Candle[], range: RangeKey): Candle[] {
  const option = RANGE_OPTIONS.find((item) => item.key === range);
  if (!option?.days || candles.length === 0) return candles;
  const lastTime = candles[candles.length - 1].time;
  const cutoff = lastTime - option.days * 86_400;
  return candles.filter((candle) => candle.time >= cutoff);
}

function tradeToMinuteCandle(trade: Trade): Candle | null {
  if (!/^\d{8}$/.test(trade.date) || !/^\d{6}$/.test(trade.time)) return null;
  const y = Number(trade.date.slice(0, 4));
  const m = Number(trade.date.slice(4, 6));
  const d = Number(trade.date.slice(6, 8));
  const hh = Number(trade.time.slice(0, 2));
  const mm = Number(trade.time.slice(2, 4));
  const bucket = Math.floor(Date.UTC(y, m - 1, d, hh - 9, mm, 0) / 1000);
  return {
    time: bucket,
    open: trade.price,
    high: trade.price,
    low: trade.price,
    close: trade.price,
    volume: trade.volume,
  };
}

function upsertMinuteCandle(candles: Candle[], trade: Trade): Candle[] {
  const nextCandle = tradeToMinuteCandle(trade);
  if (!nextCandle) return candles;
  const last = candles[candles.length - 1];
  if (!last || nextCandle.time > last.time) return [...candles, nextCandle].slice(-360);
  if (nextCandle.time < last.time) return candles;
  return [
    ...candles.slice(0, -1),
    {
      time: last.time,
      open: last.open,
      high: Math.max(last.high, trade.price),
      low: Math.min(last.low, trade.price),
      close: trade.price,
      volume: (last.volume ?? 0) + trade.volume,
    },
  ];
}

function aggregateCandles(candles: Candle[], minutes: number): Candle[] {
  if (minutes <= 1) return candles;
  const bucketSeconds = minutes * 60;
  const aggregated: Candle[] = [];

  for (const candle of candles) {
    const bucketTime = Math.floor(candle.time / bucketSeconds) * bucketSeconds;
    const last = aggregated[aggregated.length - 1];
    if (!last || last.time !== bucketTime) {
      aggregated.push({ ...candle, time: bucketTime });
      continue;
    }
    last.high = Math.max(last.high, candle.high);
    last.low = Math.min(last.low, candle.low);
    last.close = candle.close;
    last.volume = (last.volume ?? 0) + (candle.volume ?? 0);
  }

  return aggregated;
}

function mergeCandles(base: Candle[], overlay: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const candle of base) byTime.set(candle.time, candle);
  for (const candle of overlay) byTime.set(candle.time, candle);
  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-360);
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
  const tone = moveTone(snapshot?.sign);
  const prevPriceRef = useRef<number | undefined>(snapshot?.price);
  const [flashing, setFlashing] = useState(false);

  useEffect(() => {
    const price = snapshot?.price;
    if (price === undefined) return;
    if (prevPriceRef.current !== undefined && prevPriceRef.current !== price) {
      setFlashing(true);
      const timer = window.setTimeout(() => setFlashing(false), 520);
      prevPriceRef.current = price;
      return () => window.clearTimeout(timer);
    }
    prevPriceRef.current = price;
    return undefined;
  }, [snapshot?.price]);

  return (
    <button
      className={`instrument-row${active ? ' active' : ''}${flashing ? ' is-flashing' : ''}`}
      onClick={() => onSelect(instrument)}
      data-move={tone}
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
  const [timeframe, setTimeframe] = useState<TimeframeKey>('1D');
  const [moveFilter, setMoveFilter] = useState<MoveFilter>('all');
  const [watchSort, setWatchSort] = useState<WatchSortKey>('custom');
  const [activeTool, setActiveTool] = useState<ChartTool>('crosshair');
  const [error, setError] = useState<string | null>(null);
  const [quoteRefreshAt, setQuoteRefreshAt] = useState<number | null>(null);
  const [intradayCandlesByCode, setIntradayCandlesByCode] = useState<Record<string, Candle[]>>({});
  const stream = useStream();
  const selectedTrade =
    selectedInstrument?.country === 'KR' ? stream.trades[selectedInstrument.providerSymbol] : undefined;

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

  useEffect(() => {
    if (!selectedInstrument || selectedInstrument.country !== 'KR' || !selectedTrade) return;
    setIntradayCandlesByCode((items) => ({
      ...items,
      [selectedInstrument.id]: upsertMinuteCandle(items[selectedInstrument.id] ?? [], selectedTrade),
    }));
  }, [selectedInstrument, selectedTrade]);

  useEffect(() => {
    if (!selectedInstrument || selectedInstrument.country !== 'KR' || timeframe === '1D') return;
    let disposed = false;

    const refresh = (): void => {
      void fetchInstrumentIntradayCandles(selectedInstrument.id)
        .then((res) => {
          if (disposed) return;
          setIntradayCandlesByCode((items) => ({
            ...items,
            [selectedInstrument.id]: mergeCandles(res.candles, items[selectedInstrument.id] ?? []),
          }));
        })
        .catch((e) => {
          if (!disposed) setError(String(e));
        });
    };

    refresh();
    const timer = window.setInterval(refresh, LIST_QUOTE_REFRESH_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [selectedInstrument, timeframe]);

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
  const selectedIntradayCandles = useMemo(
    () => (selectedInstrument ? (intradayCandlesByCode[selectedInstrument.id] ?? []) : []),
    [intradayCandlesByCode, selectedInstrument],
  );
  const activeTimeframe = TIMEFRAME_OPTIONS.find((option) => option.key === timeframe) ?? TIMEFRAME_OPTIONS[3];
  const chartCandles = useMemo(
    () =>
      timeframe === '1D'
        ? visibleCandles
        : aggregateCandles(selectedIntradayCandles, activeTimeframe.minutes ?? 1),
    [activeTimeframe.minutes, timeframe, selectedIntradayCandles, visibleCandles],
  );
  const selectedName = selectedInstrument?.name ?? '';
  const selectedQuote = selectedInstrument ? quotesByCode[selectedInstrument.id] : undefined;
  const snapshot = toSnapshot(selectedTrade, selectedQuote);
  const selectedColor = signColor(snapshot?.sign);
  const watchedIds = useMemo(() => new Set(watchlist.map((item) => item.id)), [watchlist]);
  const getSnapshotForInstrument = (instrument: Instrument): PriceSnapshot | undefined =>
    toSnapshot(
      instrument.country === 'KR' ? stream.trades[instrument.providerSymbol] : undefined,
      quotesByCode[instrument.id],
    );
  const filteredWatchlist = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? watchlist.filter(
          (item) =>
            item.name.toLowerCase().includes(q) ||
            item.symbol.toLowerCase().includes(q) ||
            (item.englishName?.toLowerCase().includes(q) ?? false),
        )
      : watchlist;
    return sortBySnapshot(
      filterByMove(matched, moveFilter, getSnapshotForInstrument),
      watchSort,
      getSnapshotForInstrument,
    );
  }, [moveFilter, query, quotesByCode, stream.trades, watchSort, watchlist]);
  const visibleCategoryItems = useMemo(
    () =>
      sortBySnapshot(
        filterByMove(categoryItems, moveFilter, getSnapshotForInstrument),
        watchSort === 'custom' ? 'rate' : watchSort,
        getSnapshotForInstrument,
      ),
    [categoryItems, moveFilter, quotesByCode, stream.trades, watchSort],
  );

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
            <div className="chart-toolbar__group">
              <div className="timeframe-tabs" role="tablist" aria-label="봉 종류">
                {TIMEFRAME_OPTIONS.map((item) => (
                  <button
                    aria-selected={item.key === timeframe}
                    className="timeframe-tabs__button"
                    key={item.key}
                    onClick={() => setTimeframe(item.key)}
                    role="tab"
                    type="button"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              {timeframe === '1D' && RANGE_OPTIONS.map((item) => (
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
              {chartCandles.length
                ? `${chartCandles.length}개 ${activeTimeframe.label}`
                : timeframe === '1D'
                  ? '데이터 대기'
                  : '실시간 분봉 대기'}
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
            {selectedInstrument && chartCandles.length > 0 ? (
              <Chart
                candles={chartCandles}
                latestPrice={snapshot}
                liveTrade={timeframe === '1D' ? selectedTrade : undefined}
                timeVisible={timeframe !== '1D'}
                updateLastCandle={timeframe === '1D'}
              />
            ) : (
              <div className="chart-panel__empty">
                {selectedInstrument
                  ? timeframe === '1D'
                    ? '차트 로딩 중'
                    : '실시간 분봉 대기'
                  : '종목을 선택하세요'}
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
          <div className="watchlist__tools">
            <div className="watchlist__segments" role="tablist" aria-label="등락 필터">
              {MOVE_FILTER_OPTIONS.map((option) => (
                <button
                  aria-selected={option.key === moveFilter}
                  key={option.key}
                  onClick={() => setMoveFilter(option.key)}
                  role="tab"
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
            <select
              aria-label="종목 정렬"
              onChange={(event) => setWatchSort(event.target.value as WatchSortKey)}
              value={watchSort}
            >
              {WATCH_SORT_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
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
              {visibleCategoryItems.map((instrument) => (
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
