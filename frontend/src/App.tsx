import { useEffect, useMemo, useRef, useState } from 'react';
import {
  addWatchlistItem,
  createWatchlist,
  deleteWatchlist,
  fetchCategoryInstruments,
  fetchInstrumentCandles,
  fetchInstrumentCategories,
  fetchInstrumentIntradayCandles,
  fetchInstrumentNews,
  fetchInstrumentQuote,
  fetchInstrumentQuotes,
  fetchWatchlistItems,
  fetchWatchlists,
  removeWatchlistItem,
  searchInstruments,
} from './api';
import { useStream } from './useStream';
import { Chart, type ChartCommand, type ChartCommandType, type ChartReadout } from './Chart';
import type {
  Candle,
  CandlesResponse,
  Instrument,
  InstrumentCategory,
  NewsItem,
  PriceSign,
  Quote,
  Trade,
  WatchlistGroup,
} from '@invest/shared';

type RangeKey = '1M' | '3M' | '6M' | '1Y' | 'ALL';
type TimeframeKey = '1' | '5' | '15' | '1D';
type ChartTool = 'cursor' | 'crosshair' | 'trend' | 'measure' | 'text' | 'lock';
type MoveFilter = 'all' | 'up' | 'down';
type WatchSortKey = 'custom' | 'rate' | 'volume' | 'name';
type SessionTone = 'open' | 'pre' | 'closed';
type WatchGroup = 'all' | 'kr' | 'global' | 'fund';
type BottomDockTab = 'volume' | 'trades' | 'news';
type BottomDockMode = 'hidden' | 'normal' | 'expanded';

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

interface MarketSession {
  tone: SessionTone;
  label: string;
  detail: string;
  hours: string;
  localTime: string;
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

const WATCH_GROUP_OPTIONS: Array<{ key: WatchGroup; label: string }> = [
  { key: 'all', label: '전체' },
  { key: 'kr', label: '국내' },
  { key: 'global', label: '해외' },
  { key: 'fund', label: 'ETF/ETN' },
];

const BOTTOM_DOCK_MODE_OPTIONS: Array<{ key: BottomDockMode; label: string }> = [
  { key: 'hidden', label: '숨김' },
  { key: 'normal', label: '기본' },
  { key: 'expanded', label: '확장' },
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
const STORAGE_PREFIX = 'investment-monitor:';

function readStoredValue<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  const value = window.localStorage.getItem(`${STORAGE_PREFIX}${key}`);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  const value = window.localStorage.getItem(`${STORAGE_PREFIX}${key}`);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function writeStoredValue(key: string, value: string | boolean): void {
  window.localStorage.setItem(`${STORAGE_PREFIX}${key}`, String(value));
}

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

function formatCandleDate(seconds: number, withTime: boolean): string {
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
    timeZone: 'Asia/Seoul',
  }).format(new Date(seconds * 1000));
}

function formatNewsTime(seconds: number | undefined): string {
  if (!seconds) return '-';
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Seoul',
  }).format(new Date(seconds * 1000));
}

function newsSearchUrl(item: NewsItem): string {
  const query = [item.symbol, item.title].filter(Boolean).join(' ');
  return `https://www.google.com/search?tbm=nws&q=${encodeURIComponent(query)}`;
}

function formatNumber(n: number | undefined): string {
  return n !== undefined && Number.isFinite(n) ? n.toLocaleString('ko-KR') : '-';
}

function assetTypeLabel(assetType: Instrument['assetType']): string {
  switch (assetType) {
    case 'stock':
      return '주식';
    case 'etf':
      return 'ETF';
    case 'etn':
      return 'ETN';
    case 'index':
      return '지수';
    case 'other':
      return '기타';
  }
}

function countryLabel(country: Instrument['country']): string {
  switch (country) {
    case 'KR':
      return '한국';
    case 'US':
      return '미국';
    case 'CN':
      return '중국';
    case 'JP':
      return '일본';
    case 'HK':
      return '홍콩';
    case 'VN':
      return '베트남';
  }
}

function getZonedParts(timeZone: string): { weekday: string; hour: number; minute: number; label: string } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((part) => [part.type, part.value]));
  return {
    weekday: parts.weekday,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    label: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
  };
}

function getMarketSession(instrument: Instrument | null): MarketSession {
  if (!instrument) {
    return { tone: 'closed', label: '-', detail: '종목 미선택', hours: '-', localTime: '-' };
  }

  const sessions: Record<Instrument['country'], { open: number; close: number; hours: string; pre?: number }> = {
    KR: { open: 9 * 60, close: 15 * 60 + 30, hours: '09:00-15:30' },
    US: { pre: 4 * 60, open: 9 * 60 + 30, close: 16 * 60, hours: '09:30-16:00' },
    CN: { open: 9 * 60 + 30, close: 15 * 60, hours: '09:30-15:00' },
    JP: { open: 9 * 60, close: 15 * 60 + 30, hours: '09:00-15:30' },
    HK: { open: 9 * 60 + 30, close: 16 * 60, hours: '09:30-16:00' },
    VN: { open: 9 * 60, close: 15 * 60, hours: '09:00-15:00' },
  };
  const parts = getZonedParts(instrument.timezone);
  const weekdayClosed = parts.weekday === 'Sat' || parts.weekday === 'Sun';
  const now = parts.hour * 60 + parts.minute;
  const session = sessions[instrument.country];
  const localTime = `${parts.label} ${instrument.timezone}`;

  if (weekdayClosed) return { tone: 'closed', label: '휴장', detail: '주말', hours: session.hours, localTime };
  if (session.pre !== undefined && now >= session.pre && now < session.open) {
    return { tone: 'pre', label: '프리마켓', detail: '정규장 전', hours: session.hours, localTime };
  }
  if (now >= session.open && now <= session.close) {
    return { tone: 'open', label: '정규장', detail: '거래 중', hours: session.hours, localTime };
  }
  return { tone: 'closed', label: '장외', detail: now < session.open ? '개장 전' : '마감 후', hours: session.hours, localTime };
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

function matchesWatchGroup(instrument: Instrument, group: WatchGroup): boolean {
  if (group === 'all') return true;
  if (group === 'kr') return instrument.country === 'KR';
  if (group === 'global') return instrument.country !== 'KR';
  return instrument.assetType === 'etf' || instrument.assetType === 'etn';
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
  const [savedWatchlists, setSavedWatchlists] = useState<WatchlistGroup[]>([]);
  const [activeSavedWatchlistId, setActiveSavedWatchlistId] = useState(
    () => window.localStorage.getItem(`${STORAGE_PREFIX}activeSavedWatchlistId`) ?? 'default',
  );
  const [categories, setCategories] = useState<InstrumentCategory[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>('kr-major');
  const [categoryItems, setCategoryItems] = useState<Instrument[]>([]);
  const [selectedInstrument, setSelectedInstrument] = useState<Instrument | null>(null);
  const [candlesByCode, setCandlesByCode] = useState<Record<string, CandlesResponse>>({});
  const [quotesByCode, setQuotesByCode] = useState<Record<string, Quote>>({});
  const [newsByCode, setNewsByCode] = useState<Record<string, NewsItem[]>>({});
  const [query, setQuery] = useState('');
  const [symbolQuery, setSymbolQuery] = useState('');
  const [symbolResults, setSymbolResults] = useState<Instrument[]>([]);
  const [range, setRange] = useState<RangeKey>(() =>
    readStoredValue('range', '3M', RANGE_OPTIONS.map((option) => option.key)),
  );
  const [timeframe, setTimeframe] = useState<TimeframeKey>(() =>
    readStoredValue('timeframe', '1D', TIMEFRAME_OPTIONS.map((option) => option.key)),
  );
  const [watchGroup, setWatchGroup] = useState<WatchGroup>(() =>
    readStoredValue('watchGroup', 'all', WATCH_GROUP_OPTIONS.map((option) => option.key)),
  );
  const [moveFilter, setMoveFilter] = useState<MoveFilter>(() =>
    readStoredValue('moveFilter', 'all', MOVE_FILTER_OPTIONS.map((option) => option.key)),
  );
  const [watchSort, setWatchSort] = useState<WatchSortKey>(() =>
    readStoredValue('watchSort', 'custom', WATCH_SORT_OPTIONS.map((option) => option.key)),
  );
  const [activeTool, setActiveTool] = useState<ChartTool>('crosshair');
  const [chartCommand, setChartCommand] = useState<ChartCommand | undefined>(undefined);
  const [showMovingAverage, setShowMovingAverage] = useState(() => readStoredBoolean('showMovingAverage', false));
  const [showRsi, setShowRsi] = useState(() => readStoredBoolean('showRsi', false));
  const [isFocusMode, setIsFocusMode] = useState(() => readStoredBoolean('focusMode', false));
  const [isWatchlistCollapsed, setIsWatchlistCollapsed] = useState(() =>
    readStoredBoolean('watchlistCollapsed', false),
  );
  const [hoveredChartReadout, setHoveredChartReadout] = useState<ChartReadout | null>(null);
  const [bottomDockTab, setBottomDockTab] = useState<BottomDockTab>(() =>
    readStoredValue('bottomDockTab', 'volume', ['volume', 'trades', 'news']),
  );
  const [bottomDockMode, setBottomDockMode] = useState<BottomDockMode>(() =>
    readStoredValue('bottomDockMode', 'normal', BOTTOM_DOCK_MODE_OPTIONS.map((option) => option.key)),
  );
  const [error, setError] = useState<string | null>(null);
  const [quoteRefreshAt, setQuoteRefreshAt] = useState<number | null>(null);
  const [intradayCandlesByCode, setIntradayCandlesByCode] = useState<Record<string, Candle[]>>({});
  const stream = useStream();
  const selectedTrade =
    selectedInstrument?.country === 'KR' ? stream.trades[selectedInstrument.providerSymbol] : undefined;

  useEffect(() => writeStoredValue('range', range), [range]);
  useEffect(() => writeStoredValue('timeframe', timeframe), [timeframe]);
  useEffect(() => writeStoredValue('watchGroup', watchGroup), [watchGroup]);
  useEffect(() => writeStoredValue('moveFilter', moveFilter), [moveFilter]);
  useEffect(() => writeStoredValue('watchSort', watchSort), [watchSort]);
  useEffect(() => writeStoredValue('showMovingAverage', showMovingAverage), [showMovingAverage]);
  useEffect(() => writeStoredValue('showRsi', showRsi), [showRsi]);
  useEffect(() => writeStoredValue('focusMode', isFocusMode), [isFocusMode]);
  useEffect(() => writeStoredValue('watchlistCollapsed', isWatchlistCollapsed), [isWatchlistCollapsed]);
  useEffect(() => writeStoredValue('bottomDockTab', bottomDockTab), [bottomDockTab]);
  useEffect(() => writeStoredValue('bottomDockMode', bottomDockMode), [bottomDockMode]);
  useEffect(() => writeStoredValue('activeSavedWatchlistId', activeSavedWatchlistId), [activeSavedWatchlistId]);
  useEffect(() => setHoveredChartReadout(null), [range, selectedInstrument?.id, timeframe]);

  useEffect(() => {
    fetchWatchlists()
      .then((groups) => {
        setSavedWatchlists(groups);
        if (!groups.some((group) => group.id === activeSavedWatchlistId)) {
          setActiveSavedWatchlistId(groups[0]?.id ?? 'default');
        }
      })
      .catch((e) => setError(String(e)));
  }, [activeSavedWatchlistId]);

  useEffect(() => {
    fetchWatchlistItems(activeSavedWatchlistId)
      .then((items) => {
        setWatchlist(items);
        if (items.length) setSelectedInstrument((current) => current ?? items[0]);
      })
      .catch((e) => setError(String(e)));
  }, [activeSavedWatchlistId]);

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
    if (!selectedInstrument || timeframe === '1D') return;
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

  useEffect(() => {
    if (!selectedInstrument || bottomDockTab !== 'news' || newsByCode[selectedInstrument.id]) return;
    fetchInstrumentNews(selectedInstrument.id)
      .then((items) => setNewsByCode((current) => ({ ...current, [selectedInstrument.id]: items })))
      .catch((e) => setError(String(e)));
  }, [bottomDockTab, newsByCode, selectedInstrument]);

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
  const volumeSummary = useMemo(() => {
    const candlesWithVolume = chartCandles.filter((candle) => Number.isFinite(candle.volume ?? NaN));
    const total = candlesWithVolume.reduce((sum, candle) => sum + (candle.volume ?? 0), 0);
    const max = candlesWithVolume.reduce<Candle | undefined>(
      (winner, candle) => (!winner || (candle.volume ?? 0) > (winner.volume ?? 0) ? candle : winner),
      undefined,
    );
    return {
      count: candlesWithVolume.length,
      total,
      average: candlesWithVolume.length ? total / candlesWithVolume.length : undefined,
      max,
    };
  }, [chartCandles]);
  const selectedName = selectedInstrument?.name ?? '';
  const selectedQuote = selectedInstrument ? quotesByCode[selectedInstrument.id] : undefined;
  const snapshot = toSnapshot(selectedTrade, selectedQuote);
  const selectedColor = signColor(snapshot?.sign);
  const activeChartReadout = hoveredChartReadout ?? (
    snapshot
      ? {
          date: formatTradeTime(snapshot.time),
          open: snapshot.open,
          high: snapshot.high,
          low: snapshot.low,
          close: snapshot.price,
          volume: snapshot.accVolume,
          color: selectedColor,
        }
      : null
  );
  const marketSession = useMemo(() => getMarketSession(selectedInstrument), [quoteRefreshAt, selectedInstrument]);
  const previousClose = snapshot ? snapshot.price - snapshot.change : undefined;
  const dayRangePosition =
    snapshot && snapshot.high > snapshot.low
      ? Math.min(100, Math.max(0, ((snapshot.price - snapshot.low) / (snapshot.high - snapshot.low)) * 100))
      : 50;
  const watchedIds = useMemo(() => new Set(watchlist.map((item) => item.id)), [watchlist]);
  const bottomPanelClass = `bottom-panel bottom-panel--${bottomDockMode}`;
  const watchlistSummary = useMemo(() => {
    const summary: {
      up: number;
      down: number;
      flat: number;
      waiting: number;
      topMover?: { instrument: Instrument; snapshot: PriceSnapshot };
    } = {
      up: 0,
      down: 0,
      flat: 0,
      waiting: 0,
    };
    let topMoveRate = -1;

    for (const instrument of watchlist) {
      const itemSnapshot = toSnapshot(
        instrument.country === 'KR' ? stream.trades[instrument.providerSymbol] : undefined,
        quotesByCode[instrument.id],
      );

      if (!itemSnapshot) {
        summary.waiting += 1;
        continue;
      }

      const tone = moveTone(itemSnapshot.sign);
      if (tone === 'up') summary.up += 1;
      else if (tone === 'down') summary.down += 1;
      else summary.flat += 1;

      const moveRate = Math.abs(itemSnapshot.changeRate);
      if (moveRate > topMoveRate) {
        topMoveRate = moveRate;
        summary.topMover = { instrument, snapshot: itemSnapshot };
      }
    }

    return summary;
  }, [quotesByCode, stream.trades, watchlist]);
  const getSnapshotForInstrument = (instrument: Instrument): PriceSnapshot | undefined =>
    toSnapshot(
      instrument.country === 'KR' ? stream.trades[instrument.providerSymbol] : undefined,
      quotesByCode[instrument.id],
    );
  const filteredWatchlist = useMemo(() => {
    const q = query.trim().toLowerCase();
    const grouped = watchlist.filter((item) => matchesWatchGroup(item, watchGroup));
    const matched = q
      ? grouped.filter(
          (item) =>
            item.name.toLowerCase().includes(q) ||
            item.symbol.toLowerCase().includes(q) ||
            (item.englishName?.toLowerCase().includes(q) ?? false),
        )
      : grouped;
    return sortBySnapshot(
      filterByMove(matched, moveFilter, getSnapshotForInstrument),
      watchSort,
      getSnapshotForInstrument,
    );
  }, [moveFilter, query, quotesByCode, stream.trades, watchGroup, watchSort, watchlist]);
  const visibleCategoryItems = useMemo(
    () =>
      sortBySnapshot(
        filterByMove(categoryItems, moveFilter, getSnapshotForInstrument),
        watchSort === 'custom' ? 'rate' : watchSort,
        getSnapshotForInstrument,
      ),
    [categoryItems, moveFilter, quotesByCode, stream.trades, watchSort],
  );
  const tapeTrades = useMemo(
    () =>
      selectedInstrument?.country === 'KR'
        ? stream.recentTrades.filter((trade) => trade.code === selectedInstrument.providerSymbol).slice(0, 16)
        : stream.recentTrades.slice(0, 16),
    [selectedInstrument, stream.recentTrades],
  );
  const instrumentNameByProviderSymbol = useMemo(() => {
    const names = new Map<string, string>();
    for (const instrument of [...watchlist, ...categoryItems]) {
      names.set(instrument.providerSymbol, instrument.name);
    }
    if (selectedInstrument) names.set(selectedInstrument.providerSymbol, selectedInstrument.name);
    return names;
  }, [categoryItems, selectedInstrument, watchlist]);
  const selectedNews = selectedInstrument ? (newsByCode[selectedInstrument.id] ?? []) : [];

  function selectInstrument(instrument: Instrument): void {
    setSelectedInstrument(instrument);
  }

  function updateActiveGroupCount(delta: number): void {
    setSavedWatchlists((groups) =>
      groups.map((group) =>
        group.id === activeSavedWatchlistId
          ? { ...group, itemCount: Math.max(0, group.itemCount + delta) }
          : group,
      ),
    );
  }

  function toggleWatch(instrument: Instrument): void {
    if (watchedIds.has(instrument.id)) {
      removeWatchlistItem(activeSavedWatchlistId, instrument.id)
        .then(() => {
          setWatchlist((items) => items.filter((item) => item.id !== instrument.id));
          updateActiveGroupCount(-1);
        })
        .catch((e) => setError(String(e)));
      return;
    }
    addWatchlistItem(activeSavedWatchlistId, instrument.id)
      .then((item) =>
        setWatchlist((items) => {
          if (items.some((cur) => cur.id === item.id)) return items;
          updateActiveGroupCount(1);
          return [...items, item];
        }),
      )
      .catch((e) => setError(String(e)));
  }

  function createSavedWatchlist(): void {
    const name = window.prompt('새 관심그룹 이름');
    if (!name?.trim()) return;
    createWatchlist(name.trim())
      .then((group) => {
        setSavedWatchlists((groups) => [...groups, group]);
        setActiveSavedWatchlistId(group.id);
      })
      .catch((e) => setError(String(e)));
  }

  function deleteSavedWatchlist(id: string): void {
    if (id === 'default') return;
    deleteWatchlist(id)
      .then(() => {
        setSavedWatchlists((groups) => groups.filter((group) => group.id !== id));
        if (activeSavedWatchlistId === id) setActiveSavedWatchlistId('default');
      })
      .catch((e) => setError(String(e)));
  }

  function runChartCommand(type: ChartCommandType): void {
    setChartCommand({ type, nonce: Date.now() });
  }

  function selectBottomDockTab(tab: BottomDockTab): void {
    setBottomDockTab(tab);
    if (bottomDockMode === 'hidden') setBottomDockMode('normal');
  }

  return (
    <div className={`app${isFocusMode ? ' is-focus-mode' : ''}`}>
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
                  {symbolResults.map((instrument) => {
                    const resultSnapshot = toSnapshot(undefined, quotesByCode[instrument.id]);
                    return (
                      <div className="symbol-search__result" key={instrument.id}>
                        <button
                          className="symbol-search__select"
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
                          <em style={{ color: signColor(resultSnapshot?.sign) }}>
                            {resultSnapshot
                              ? `${formatPrice(resultSnapshot.price)} · ${formatRate(resultSnapshot.changeRate)}`
                              : '-'}
                          </em>
                        </button>
                        <button
                          aria-label={watchedIds.has(instrument.id) ? '관심종목에서 제거' : '관심종목에 추가'}
                          className="symbol-search__watch"
                          onClick={() => toggleWatch(instrument)}
                          title={watchedIds.has(instrument.id) ? '관심종목에서 제거' : '관심종목에 추가'}
                          type="button"
                        >
                          {watchedIds.has(instrument.id) ? '−' : '+'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="chart-commandbar__actions">
              <button onClick={() => runChartCommand('fit')} title="전체 차트 맞춤" type="button">맞춤</button>
              <button onClick={() => runChartCommand('zoomIn')} title="차트 확대" type="button">+</button>
              <button onClick={() => runChartCommand('zoomOut')} title="차트 축소" type="button">−</button>
              <button
                aria-pressed={showMovingAverage}
                onClick={() => setShowMovingAverage((value) => !value)}
                title="이동평균선 표시"
                type="button"
              >
                MA
              </button>
              <button
                aria-pressed={showRsi}
                onClick={() => setShowRsi((value) => !value)}
                title="RSI 보조지표 표시"
                type="button"
              >
                RSI
              </button>
              <button
                aria-pressed={isFocusMode}
                onClick={() => setIsFocusMode((value) => !value)}
                title={isFocusMode ? '집중 모드 해제' : '집중 모드'}
                type="button"
              >
                집중
              </button>
              <button type="button">비교</button>
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

          <section className="market-strip" aria-label="종목 상세 정보">
            <div className="market-strip__status" data-tone={marketSession.tone}>
              <span>장 상태</span>
              <strong>{marketSession.label}</strong>
              <small>{marketSession.detail}</small>
            </div>
            <div className="market-strip__item">
              <span>거래소</span>
              <strong>{selectedInstrument ? selectedInstrument.market : '-'}</strong>
              <small>{selectedInstrument ? `${countryLabel(selectedInstrument.country)} · ${selectedInstrument.currency}` : '-'}</small>
            </div>
            <div className="market-strip__item">
              <span>종류</span>
              <strong>{selectedInstrument ? assetTypeLabel(selectedInstrument.assetType) : '-'}</strong>
              <small>{selectedInstrument?.providerSymbol ?? '-'}</small>
            </div>
            <div className="market-strip__item">
              <span>전일종가</span>
              <strong>{formatNumber(previousClose)}</strong>
              <small>정규장 {marketSession.hours}</small>
            </div>
            <div className="market-strip__range">
              <div>
                <span>당일 범위</span>
                <strong>
                  {snapshot ? `${formatPrice(snapshot.low)} - ${formatPrice(snapshot.high)}` : '-'}
                </strong>
              </div>
              <div className="market-strip__range-track">
                <span style={{ left: `${dayRangePosition}%` }} />
              </div>
            </div>
            <div className="market-strip__item">
              <span>현지시간</span>
              <strong>{marketSession.localTime}</strong>
              <small>{quoteRefreshAt ? `갱신 ${formatClock(quoteRefreshAt)}` : '갱신 대기'}</small>
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
              <span>{activeChartReadout ? activeChartReadout.date : '-'}</span>
              <span>O {activeChartReadout ? formatPrice(activeChartReadout.open) : '-'}</span>
              <span>H {activeChartReadout ? formatPrice(activeChartReadout.high) : '-'}</span>
              <span>L {activeChartReadout ? formatPrice(activeChartReadout.low) : '-'}</span>
              <span style={{ color: activeChartReadout?.color }}>
                C {activeChartReadout ? formatPrice(activeChartReadout.close) : '-'}
              </span>
              <span>V {activeChartReadout ? formatVolume(activeChartReadout.volume) : '-'}</span>
              <span>{TOOL_OPTIONS.find((tool) => tool.key === activeTool)?.title}</span>
            </div>
            {selectedInstrument && chartCandles.length > 0 ? (
              <Chart
                candles={chartCandles}
                latestPrice={snapshot}
                liveTrade={timeframe === '1D' ? selectedTrade : undefined}
                timeVisible={timeframe !== '1D'}
                updateLastCandle={timeframe === '1D'}
                command={chartCommand}
                showMovingAverage={showMovingAverage}
                showRsi={showRsi}
                onReadoutChange={setHoveredChartReadout}
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

          {bottomDockMode !== 'hidden' && bottomDockTab === 'volume' && (
            <section className={`volume-panel ${bottomPanelClass}`} aria-label="거래량 요약">
              <div>
                <span>표시 캔들</span>
                <strong>{volumeSummary.count ? `${volumeSummary.count}개` : '-'}</strong>
              </div>
              <div>
                <span>총 거래량</span>
                <strong>{volumeSummary.count ? formatVolume(volumeSummary.total) : '-'}</strong>
              </div>
              <div>
                <span>평균 거래량</span>
                <strong>{volumeSummary.average !== undefined ? formatVolume(volumeSummary.average) : '-'}</strong>
              </div>
              <div>
                <span>최대 거래량</span>
                <strong>{volumeSummary.max ? formatVolume(volumeSummary.max.volume ?? 0) : '-'}</strong>
              </div>
              <div>
                <span>최대 거래량 시점</span>
                <strong>{volumeSummary.max ? formatCandleDate(volumeSummary.max.time, timeframe !== '1D') : '-'}</strong>
              </div>
            </section>
          )}

          {bottomDockMode !== 'hidden' && bottomDockTab === 'trades' && (
            <section className={`trade-tape ${bottomPanelClass}`} aria-label="최근 체결">
              <div className="trade-tape__header">
                <strong>최근 체결</strong>
                <span>{selectedInstrument?.country === 'KR' ? selectedName : '국내 구독 종목'}</span>
              </div>
              <div className="trade-tape__rows">
                {tapeTrades.map((trade, index) => (
                  <div
                    className="trade-tape__row"
                    data-move={moveTone(trade.sign)}
                    key={`${trade.code}-${trade.date}-${trade.time}-${index}`}
                  >
                    <span className="trade-tape__time">{formatTradeTime(trade.time)}</span>
                    <span className="trade-tape__move">{moveTone(trade.sign) === 'up' ? '상승' : moveTone(trade.sign) === 'down' ? '하락' : '보합'}</span>
                    <strong>{instrumentNameByProviderSymbol.get(trade.code) ?? trade.code}</strong>
                    <em style={{ color: signColor(trade.sign) }}>{formatPrice(trade.price)}</em>
                    <span>{formatSignedPrice(trade.change)}</span>
                    <span>{formatRate(trade.changeRate)}</span>
                    <span>{formatVolume(trade.volume)}</span>
                    <span>{formatVolume(trade.accVolume)}</span>
                  </div>
                ))}
                {tapeTrades.length === 0 && (
                  <div className="trade-tape__empty">체결 수신 대기</div>
                )}
              </div>
            </section>
          )}

          {bottomDockMode !== 'hidden' && bottomDockTab === 'news' && (
            <section className={`news-panel ${bottomPanelClass}`} aria-label="종목 뉴스">
              <div className="news-panel__header">
                <strong>뉴스</strong>
                <span>{selectedInstrument ? selectedInstrument.name : '종목 미선택'}</span>
                <em>{selectedNews.length ? `${selectedNews.length}건` : '대기'}</em>
              </div>
              <div className="news-panel__rows">
                {selectedNews.map((item) => (
                  <a
                    className="news-panel__row"
                    href={newsSearchUrl(item)}
                    key={item.id}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <span>{formatNewsTime(item.publishedAt)}</span>
                    <strong>{item.title}</strong>
                    <em>{item.source}</em>
                    <small>검색</small>
                  </a>
                ))}
                {selectedInstrument && selectedNews.length === 0 && (
                  <div className="news-panel__empty">뉴스 조회 결과 없음</div>
                )}
                {!selectedInstrument && <div className="news-panel__empty">종목을 선택하세요</div>}
              </div>
            </section>
          )}

          <div className="bottom-dock">
            <button
              aria-selected={bottomDockTab === 'volume' && bottomDockMode !== 'hidden'}
              onClick={() => selectBottomDockTab('volume')}
              type="button"
            >
              거래량 <small>{volumeSummary.count || '-'}</small>
            </button>
            <button
              aria-selected={bottomDockTab === 'trades' && bottomDockMode !== 'hidden'}
              onClick={() => selectBottomDockTab('trades')}
              type="button"
            >
              체결 <small>{tapeTrades.length}</small>
            </button>
            <button
              aria-selected={bottomDockTab === 'news' && bottomDockMode !== 'hidden'}
              onClick={() => selectBottomDockTab('news')}
              type="button"
            >
              뉴스 <small>{selectedNews.length}</small>
            </button>
            <div className="bottom-dock__modes" role="tablist" aria-label="하단 패널 높이">
              {BOTTOM_DOCK_MODE_OPTIONS.map((option) => (
                <button
                  aria-selected={bottomDockMode === option.key}
                  key={option.key}
                  onClick={() => setBottomDockMode(option.key)}
                  role="tab"
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
            <span className="bottom-dock__status">조회 전용 세션 · 시세 갱신 {formatClock(quoteRefreshAt)}</span>
          </div>
        </main>

        <aside className={`watchlist${isWatchlistCollapsed ? ' is-collapsed' : ''}`}>
          <div className="watchlist__header">
            <strong>관심종목</strong>
            <span>{watchlist.length}</span>
            <button
              aria-label={isWatchlistCollapsed ? '관심종목 펼치기' : '관심종목 접기'}
              className="watchlist__collapse"
              onClick={() => setIsWatchlistCollapsed((value) => !value)}
              title={isWatchlistCollapsed ? '관심종목 펼치기' : '관심종목 접기'}
              type="button"
            >
              {isWatchlistCollapsed ? '‹' : '›'}
            </button>
          </div>
          <div className="watchlist__summary" aria-label="관심종목 요약">
            <div className="watchlist__summary-counts">
              <span data-tone="up">상승 {watchlistSummary.up}</span>
              <span data-tone="down">하락 {watchlistSummary.down}</span>
              <span>보합 {watchlistSummary.flat}</span>
              <span>대기 {watchlistSummary.waiting}</span>
            </div>
            <div className="watchlist__summary-top">
              <span>최대 변동</span>
              {watchlistSummary.topMover ? (
                <strong style={{ color: signColor(watchlistSummary.topMover.snapshot.sign) }}>
                  {watchlistSummary.topMover.instrument.name} {formatRate(watchlistSummary.topMover.snapshot.changeRate)}
                </strong>
              ) : (
                <strong>-</strong>
              )}
            </div>
          </div>
          <div className="watchlist__saved-groups" role="tablist" aria-label="저장 관심그룹">
            {savedWatchlists.map((group) => (
              <div className="watchlist__saved-group" data-active={group.id === activeSavedWatchlistId} key={group.id}>
                <button
                  aria-selected={group.id === activeSavedWatchlistId}
                  onClick={() => setActiveSavedWatchlistId(group.id)}
                  role="tab"
                  title={`${group.name} ${group.itemCount}개`}
                  type="button"
                >
                  <span>{group.name}</span>
                  <em>{group.itemCount}</em>
                </button>
                {group.id !== 'default' && (
                  <button
                    aria-label={`${group.name} 삭제`}
                    className="watchlist__saved-group-delete"
                    onClick={() => deleteSavedWatchlist(group.id)}
                    title="관심그룹 삭제"
                    type="button"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button
              aria-label="관심그룹 추가"
              className="watchlist__group-add"
              onClick={createSavedWatchlist}
              title="관심그룹 추가"
              type="button"
            >
              +
            </button>
          </div>
          <div className="watchlist__groups" role="tablist" aria-label="관심종목 필터">
            {WATCH_GROUP_OPTIONS.map((option) => (
              <button
                aria-selected={option.key === watchGroup}
                key={option.key}
                onClick={() => setWatchGroup(option.key)}
                role="tab"
                type="button"
              >
                {option.label}
              </button>
            ))}
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
