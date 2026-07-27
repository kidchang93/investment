import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addWatchlistItem,
  fetchAutoTraderState,
  fetchAutoTraderStrategies,
  startAutoTrader,
  stopAutoTrader,
  cancelKisReservedOrder,
  placeKisReservedOrder,
  createWatchlist,
  deleteWatchlist,
  amendKisLiveOrder,
  fetchKisAccounts,
  fetchKisAccountSnapshot,
  fetchKisExecutions,
  fetchKisLiveOrderGate,
  fetchKisOpenOrders,
  fetchKisOrderLog,
  fetchKisOrderability,
  fetchKisReservedOrders,
  fetchKisRiskRules,
  fetchKisSellability,
  fetchKisTradeProfit,
  placeKisLiveOrder,
  updateKisRiskRules,
  fetchCategoryInstruments,
  fetchInstrumentCandles,
  fetchInstrumentCategories,
  fetchInstrumentIntradayCandles,
  fetchInstrumentNews,
  fetchInstrumentQuote,
  fetchOrderBook,
  fetchInstrumentQuotes,
  fetchTerminalInstruments,
  fetchUsdKrwExchangeRate,
  fetchWatchlistItems,
  fetchWatchlists,
  removeWatchlistItem,
  searchInstruments,
} from './api';
import { useStream } from './useStream';
import { Chart, type ChartCommand, type ChartCommandType, type ChartReadout } from './Chart';
import {
  KR_KONEX_SELL_TAX_RATE_ASSUMPTION,
  KR_SELL_TAX_RATE_ASSUMPTION,
} from '@invest/shared';
import type {
  AutoTraderMode,
  AutoTraderState,
  BrokerAccountRef,
  BrokerAccountSnapshot,
  BrokerAmendableOrder,
  BrokerExecutionSnapshot,
  BrokerExecutionStatus,
  BrokerOrderRecord,
  BrokerOrderability,
  BrokerReservedOrder,
  BrokerSellability,
  BrokerTradeProfitSnapshot,
  Candle,
  LiveOrderGate,
  RiskRuleSet,
  CandlesResponse,
  ClientSubscribeInstrument,
  ExchangeRate,
  Instrument,
  InstrumentCategory,
  NewsItem,
  OrderSide,
  OrderTimeInForce,
  OrderBook,
  OrderType,
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
type LayoutPreset = 'balanced' | 'chart' | 'reading';
/*
 * 화면은 셋뿐이다. 예전엔 'trade'가 더 있었는데 상단 네비에 버튼이 없어
 * 포트폴리오 표의 행을 눌러야만 닿았고, 보유 종목도 주문 이력도 없으면
 * 영영 갈 수 없었다. 새로고침하면 저장값 검증에서 걸러져 터미널로 돌아가기도
 * 했다. 주문은 종목 화면(오른쪽 패널)으로 들어왔다.
 */
type AppPage = 'terminal' | 'market' | 'portfolio';
type SidePanelTab = 'order' | 'watch' | 'discover';
type TerminalTab =
  | 'overview'
  | 'news'
  | 'macro'
  | 'calendar'
  | 'reports'
  | 'heatmap'
  | 'ranking'
  | 'themes'
  | 'fees'
  | 'lounge'
  | 'chat'
  | 'simulation';
type NewsFilter = 'all' | 'macro' | 'stocks' | 'commodities' | 'crypto' | 'policy';
type MacroFilter = 'all' | 'energy' | 'metals' | 'agriculture' | 'rates' | 'fx' | 'indices' | 'crypto';
type CalendarRegionFilter = 'all' | 'domestic' | 'global';
type CalendarImpactFilter = 'all' | '최고' | '높음' | '보통';
type FeeMarket = 'kospi' | 'kosdaq' | 'konex' | 'us_stock' | 'kospi200_future' | 'kospi200_option';
type ChatPanelMode = 'compact' | 'wide';

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

interface MoveSummary {
  up: number;
  down: number;
  flat: number;
  waiting: number;
  topMover?: { instrument: Instrument; snapshot: PriceSnapshot };
}

interface TerminalNewsCard {
  id: string;
  title: string;
  source: string;
  publishedAt?: number;
  filters: NewsFilter[];
  url: string;
}

interface MacroBoardItem {
  key: string;
  label: string;
  detail: string;
  filter: MacroFilter;
  instrumentId?: string;
  fallback?: string;
}

interface EconomicEvent {
  date: string;
  time: string;
  region: string;
  title: string;
  impact: '최고' | '높음' | '보통';
  scope: CalendarRegionFilter;
}

interface ThemeFlowItem {
  name: string;
  /** 이 테마의 등락률을 계산할 구성 종목. 히트맵과 같은 12종목을 나눠 쓴다. */
  symbols: string[];
  tags: string[];
}

interface FeeBroker {
  name: string;
  product: string;
  commissionRate: number;
  institutionRate: number;
  supportsDerivatives: boolean;
}

interface HeatmapItem {
  symbol: string;
  name: string;
  sector: string;
  /** 타일 크기 비율. 시총이 아니라 화면을 채우는 값이다. */
  weight: number;
}

interface LoungePost {
  id: string;
  author: string;
  title: string;
  body: string;
  tag: string;
  replies: number;
  likes: number;
}

interface ChatMessage {
  id: string;
  author: string;
  message: string;
  time: string;
  tone: 'normal' | 'alert' | 'macro';
}

interface SimulationPosition {
  instrumentId: string;
  symbol: string;
  name: string;
  quantity: number;
  averagePrice: number;
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

const LAYOUT_PRESET_OPTIONS: Array<{ key: LayoutPreset; label: string; title: string }> = [
  { key: 'balanced', label: '균형', title: '기본 균형 레이아웃' },
  { key: 'chart', label: '차트', title: '차트 중심 레이아웃' },
  { key: 'reading', label: '리딩', title: '뉴스/체결 리딩 레이아웃' },
];

const TOOL_OPTIONS: Array<{ key: ChartTool; label: string; title: string }> = [
  { key: 'cursor', label: '+', title: '커서' },
  { key: 'crosshair', label: 'X', title: '십자선' },
  { key: 'trend', label: '/', title: '추세선' },
  { key: 'measure', label: '<>', title: '측정' },
  { key: 'text', label: 'T', title: '텍스트' },
  { key: 'lock', label: '#', title: '도구 잠금' },
];

/*
 * 이름만 보고 무엇이 있는지 알 수 있게 적는다. `터미널`은 안에 뉴스·매크로·
 * 캘린더가 들어 있다는 걸 이름이 전혀 알려주지 못했고, `차트`는 차트만 있고
 * 주문은 다른 곳에 있어 실제 쓰임과 어긋났다.
 */
const APP_PAGE_OPTIONS: Array<{ key: AppPage; label: string; title: string }> = [
  { key: 'market', label: '종목', title: '차트와 주문을 한 화면에서' },
  { key: 'portfolio', label: '내 계좌', title: '잔고·주문내역·손익·리스크 룰' },
  { key: 'terminal', label: '발견', title: '뉴스·매크로·캘린더·랭킹' },
];

const SIDE_PANEL_OPTIONS: Array<{ key: SidePanelTab; label: string }> = [
  { key: 'order', label: '주문' },
  { key: 'watch', label: '관심' },
  { key: 'discover', label: '탐색' },
];

/** 자동매매 상태를 사람 말로. 코드값을 그대로 보여주면 무슨 뜻인지 알 수 없다. */
/*
 * 전문용어 사전.
 *
 * 처음 보는 사람은 `예수금`이 어떤 돈인지, `미체결`이 무슨 상태인지 알 수 없다.
 * 그렇다고 설명을 라벨 옆에 다 적으면 화면이 빽빽해진다 — 줄이려는 것과 반대다.
 * 점선 밑줄로 "설명이 있다"는 것만 보이게 하고 뜻은 툴팁에 둔다.
 */
const GLOSSARY: Record<string, string> = {
  예수금: '계좌에 들어 있는 현금입니다. 주식을 살 때 이 돈을 씁니다.',
  '총 평가': '현금과 보유 주식을 지금 값으로 합친 금액입니다.',
  '주식 평가': '보유 주식만 지금 값으로 계산한 금액입니다.',
  '평가 손익': '지금 팔면 생기는 이익이나 손실입니다. 팔기 전까지는 확정된 값이 아닙니다.',
  미체결: '주문은 냈지만 아직 사거나 팔리지 않은 것입니다. 값을 고치거나 취소할 수 있습니다.',
  지정가: '살(팔) 값을 직접 정하는 주문입니다. 그 값이 와야 체결됩니다.',
  시장가: '지금 시장에 나와 있는 값으로 바로 사고파는 주문입니다. 즉시 체결되지만 값을 고를 수 없습니다.',
  예약주문: '장이 닫혀 있을 때 미리 넣어 두는 주문입니다. 다음 개장일에 나갑니다.',
};

/** 사전에 있는 말이면 뜻을 달아 준다. 없으면 그냥 글자 그대로 둔다. */
function Term({ children }: { children: string }): JSX.Element {
  const meaning = GLOSSARY[children];
  if (!meaning) return <>{children}</>;
  return (
    <abbr className="term" title={meaning}>
      {children}
    </abbr>
  );
}

const AUTO_TRADER_STATUS_LABEL: Record<string, string> = {
  stopped: '멈춤',
  running: '돌고 있음',
  target_reached: '목표 도달로 정지',
  stopped_out: '중단선 도달로 정지',
  error: '오류로 정지',
};

const SIDE_PANEL_TITLE: Record<SidePanelTab, string> = {
  order: '주문',
  watch: '관심종목',
  discover: '종목 탐색',
};

const TERMINAL_CATEGORY_SHORTCUTS = [
  { id: 'kr-night-proxies', label: '야간 환산가', detail: 'GDR·환율 기반' },
  { id: 'kr-night-futures', label: '국내 야간선물', detail: 'KRX 야간 단일 선물' },
  { id: 'global-commodities', label: '원자재', detail: '금·은·원유·가스' },
  { id: 'overseas-futures', label: '해외선물', detail: '글로벌 선물' },
] as const;

interface TerminalTabOption {
  key: TerminalTab;
  label: string;
  title: string;
}

/*
 * 탭 12개를 한 줄에 평평하게 늘어놓으면 무엇이 어디 있는지 알 수 없다. 라벨만
 * 봐서는 히트맵·랭킹·테마가 서로 어떻게 다른지도 구분되지 않는다. 찾는 것이
 * 무엇이냐로 묶어 준다 — 지금 시장이 어떤지, 무슨 일이 있었는지, 남들은 뭐라
 * 하는지, 계산해 볼 것.
 *
 * 줄을 늘리지 않고 한 줄 안에서 묶는다. 버튼 합계가 720px인데 줄 폭이 1484px라
 * 여유가 충분하다.
 */
const TERMINAL_TAB_GROUPS: Array<{ label: string; options: TerminalTabOption[] }> = [
  {
    label: '시세',
    options: [
      { key: 'overview', label: '대시보드', title: '핵심 지표와 출처' },
      { key: 'heatmap', label: '히트맵', title: '시총 상위 종목 등락 지도' },
      { key: 'ranking', label: '랭킹', title: '많이 움직인 종목' },
      { key: 'themes', label: '테마', title: '도미넌스와 테마 흐름' },
      { key: 'macro', label: '매크로', title: '원자재·환율·금리·지수' },
    ],
  },
  {
    label: '뉴스·일정',
    options: [
      { key: 'news', label: '뉴스룸', title: '속보와 종목별 뉴스' },
      { key: 'calendar', label: '캘린더', title: '경제 지표 발표 일정' },
      { key: 'reports', label: '리포트', title: '고른 종목의 오늘 수치' },
    ],
  },
  {
    label: '커뮤니티',
    options: [
      { key: 'lounge', label: '라운지', title: '커뮤니티 화면 구성 미리보기' },
      { key: 'chat', label: '채팅', title: '채팅 화면 구성 미리보기' },
    ],
  },
  {
    label: '도구',
    options: [
      { key: 'fees', label: '수수료', title: '증권사 비용 계산' },
      { key: 'simulation', label: '모의투자', title: '모의계좌로 연습 매매' },
    ],
  },
];

/** 저장값 검증처럼 그룹이 필요 없는 곳에서 쓰는 평탄한 목록. */
const TERMINAL_TAB_OPTIONS: TerminalTabOption[] = TERMINAL_TAB_GROUPS.flatMap((group) => group.options);

const NEWS_FILTER_OPTIONS: Array<{ key: NewsFilter; label: string }> = [
  { key: 'all', label: '전체' },
  { key: 'macro', label: '거시' },
  { key: 'stocks', label: '주식' },
  { key: 'commodities', label: '원자재' },
  { key: 'crypto', label: '코인' },
  { key: 'policy', label: '정책' },
];

const MACRO_FILTER_OPTIONS: Array<{ key: MacroFilter; label: string }> = [
  { key: 'all', label: '전체' },
  { key: 'energy', label: '에너지' },
  { key: 'metals', label: '금속' },
  { key: 'agriculture', label: '농산물' },
  { key: 'rates', label: '금리' },
  { key: 'fx', label: '환율' },
  { key: 'indices', label: '지수' },
  { key: 'crypto', label: '코인' },
];

const CALENDAR_REGION_OPTIONS: Array<{ key: CalendarRegionFilter; label: string }> = [
  { key: 'all', label: '전체' },
  { key: 'domestic', label: '국내' },
  { key: 'global', label: '해외' },
];

const CALENDAR_IMPACT_OPTIONS: Array<{ key: CalendarImpactFilter; label: string }> = [
  { key: 'all', label: '전체' },
  { key: '최고', label: '최고' },
  { key: '높음', label: '높음' },
  { key: '보통', label: '보통' },
];

/*
 * 세율은 @invest/shared에서 가져온다. 여기 0.002, 백테스트에 0.0018이 따로
 * 박혀 있어 같은 세금을 앱이 두 값으로 들고 있었다. 둘 다 출처가 없었다.
 */
const FEE_MARKET_OPTIONS: Array<{ key: FeeMarket; label: string; taxRate: number; unit: string }> = [
  { key: 'kospi', label: '코스피', taxRate: KR_SELL_TAX_RATE_ASSUMPTION, unit: 'KRW' },
  { key: 'kosdaq', label: '코스닥', taxRate: KR_SELL_TAX_RATE_ASSUMPTION, unit: 'KRW' },
  { key: 'konex', label: '코넥스', taxRate: KR_KONEX_SELL_TAX_RATE_ASSUMPTION, unit: 'KRW' },
  { key: 'us_stock', label: '미국주식', taxRate: 0, unit: 'USD' },
  { key: 'kospi200_future', label: 'KOSPI200 선물', taxRate: 0, unit: 'KRW' },
  { key: 'kospi200_option', label: 'KOSPI200 옵션', taxRate: 0, unit: 'KRW' },
];

const CHAT_PANEL_MODE_OPTIONS: Array<{ key: ChatPanelMode; label: string }> = [
  { key: 'compact', label: '좁게' },
  { key: 'wide', label: '넓게' },
];

const FALLBACK_TERMINAL_NEWS: TerminalNewsCard[] = [
  {
    id: 'fallback-policy',
    title: '반도체·AI 공급망 이슈 점검',
    source: '검색',
    filters: ['stocks', 'policy'],
    url: topicNewsUrl('반도체 AI 공급망 증시 뉴스'),
  },
  {
    id: 'fallback-macro',
    title: '미국 금리·달러 흐름과 야간선물 영향',
    source: '검색',
    filters: ['macro', 'policy'],
    url: topicNewsUrl('미국 금리 달러 야간선물 뉴스'),
  },
  {
    id: 'fallback-commodity',
    title: '원유·금 가격 변동과 원자재 섹터',
    source: '검색',
    filters: ['commodities', 'macro'],
    url: topicNewsUrl('원유 금 원자재 시장 뉴스'),
  },
  {
    id: 'fallback-crypto',
    title: '비트코인과 위험자산 선호 변화',
    source: '검색',
    filters: ['crypto', 'macro'],
    url: topicNewsUrl('비트코인 위험자산 선호 뉴스'),
  },
];

const MACRO_BOARD_GROUPS: Array<{ label: string; items: MacroBoardItem[] }> = [
  {
    label: '핵심 지표',
    items: [
      { key: 'night-samsung', label: '삼성전자 야간', detail: 'GDR 환산가', filter: 'indices', instrumentId: 'KR:NIGHT_PROXY:005930' },
      { key: 'kospi-night', label: 'KOSPI200 야간', detail: 'KRX 야간선물', filter: 'indices', instrumentId: 'KR:KRX_NIGHT:A01609' },
      { key: 'gold', label: '금', detail: 'COMEX 연속선물', filter: 'metals', instrumentId: 'GLOBAL:TV_COMMODITY:GOLD' },
      { key: 'wti', label: 'WTI', detail: 'NYMEX 연속선물', filter: 'energy', instrumentId: 'GLOBAL:TV_COMMODITY:WTI' },
    ],
  },
  {
    label: '원자재',
    items: [
      { key: 'silver', label: '은', detail: 'COMEX 연속선물', filter: 'metals', instrumentId: 'GLOBAL:TV_COMMODITY:SILVER' },
      { key: 'natgas', label: '천연가스', detail: 'NYMEX 연속선물', filter: 'energy', instrumentId: 'GLOBAL:TV_COMMODITY:NATGAS' },
      { key: 'brent', label: '브렌트유', detail: '권한 연동 대기', filter: 'energy', fallback: '-' },
      { key: 'copper', label: '구리', detail: '권한 연동 대기', filter: 'metals', fallback: '-' },
      { key: 'corn', label: '옥수수', detail: '농산물 지표 예정', filter: 'agriculture', fallback: '-' },
      { key: 'soybean', label: '대두', detail: '농산물 지표 예정', filter: 'agriculture', fallback: '-' },
    ],
  },
  {
    label: '환율·금리',
    items: [
      { key: 'usdkrw', label: 'USD/KRW', detail: '환율 시세 대기', filter: 'fx', fallback: '-' },
      { key: 'eurusd', label: 'EUR/USD', detail: '환율 지표 예정', filter: 'fx', fallback: '-' },
      { key: 'dxy', label: '달러인덱스', detail: '글로벌 지표 예정', filter: 'fx', fallback: '-' },
      { key: 'us10y', label: '미10년금리', detail: '금리 지표 예정', filter: 'rates', fallback: '-' },
      { key: 'us2y', label: '미2년금리', detail: '금리 지표 예정', filter: 'rates', fallback: '-' },
      { key: 'vix', label: 'VIX', detail: '변동성 지수 예정', filter: 'indices', fallback: '-' },
    ],
  },
  {
    label: '글로벌',
    items: [
      { key: 'nasdaq-future', label: '나스닥100F', detail: '해외선물 탐색 연동', filter: 'indices', fallback: '-' },
      { key: 'kospi-index', label: '코스피 지수', detail: '국내 지수 API 예정', filter: 'indices', fallback: '-' },
      { key: 'kosdaq-index', label: '코스닥 지수', detail: '국내 지수 API 예정', filter: 'indices', fallback: '-' },
      { key: 'kosdaq150-night', label: '코스닥150 야간', detail: '야간선물 마스터 미수신', filter: 'indices', fallback: '-' },
      { key: 'skhynix-night', label: 'SK하이닉스 야간', detail: 'GDR 환산 소스 확인 대기', filter: 'indices', fallback: '-' },
      { key: 'sp500', label: 'S&P500', detail: '지수 지표 예정', filter: 'indices', fallback: '-' },
      { key: 'ewy', label: 'MSCI Korea', detail: '한국 ETF 지표 예정', filter: 'indices', fallback: '-' },
      { key: 'btc', label: '비트코인', detail: '코인 지표 예정', filter: 'crypto', fallback: '-' },
      { key: 'eth', label: '이더리움', detail: '코인 지표 예정', filter: 'crypto', fallback: '-' },
    ],
  },
];

const ECONOMIC_EVENTS: EconomicEvent[] = [
  { date: '2026-07-13', time: '08:50', region: '일본', title: '생산자물가지수', impact: '보통', scope: 'global' },
  { date: '2026-07-14', time: '21:30', region: '미국', title: '소비자물가지수 CPI', impact: '최고', scope: 'global' },
  { date: '2026-07-15', time: '10:00', region: '한국', title: '수출입물가지수', impact: '보통', scope: 'domestic' },
  { date: '2026-07-15', time: '21:30', region: '미국', title: '생산자물가지수 PPI', impact: '높음', scope: 'global' },
  { date: '2026-07-16', time: '10:00', region: '한국', title: '금융통화위원회 의사록', impact: '높음', scope: 'domestic' },
  { date: '2026-07-16', time: '21:30', region: '미국', title: '소매판매', impact: '높음', scope: 'global' },
  { date: '2026-07-17', time: '23:00', region: '미국', title: '미시간대 소비심리', impact: '보통', scope: 'global' },
  { date: '2026-07-23', time: '08:00', region: '한국', title: '2분기 GDP 속보치', impact: '최고', scope: 'domestic' },
  { date: '2026-07-29', time: '03:00', region: '미국', title: 'FOMC 금리 결정', impact: '최고', scope: 'global' },
  { date: '2026-07-31', time: '21:30', region: '미국', title: 'PCE 물가지수', impact: '최고', scope: 'global' },
];

/*
 * 테마 보드.
 *
 * 예전에는 `score`(92·81·76…)와 `change`(+18.4%…)가 박혀 있었다. score는
 * 무엇을 잰 값인지 정의가 없었고 change는 지어낸 등락률이었다. score는
 * 지우고, 등락률은 구성 종목의 실제 등락률 평균으로 계산한다.
 *
 * 구성 종목은 히트맵과 같은 12개다 — 이미 조회가 되는 것을 확인한 종목이라
 * 새로 해석할 위험이 없고, 두 탭이 같은 종목을 본다는 점도 말이 된다.
 */
const THEME_FLOW_ITEMS: ThemeFlowItem[] = [
  { name: '반도체', symbols: ['005930', '000660'], tags: ['HBM', 'AI'] },
  { name: '2차전지', symbols: ['373220', '051910'], tags: ['IRA', '소재'] },
  { name: '바이오', symbols: ['207940', '068270'], tags: ['CDMO', '실적'] },
  { name: '자동차', symbols: ['005380', '000270'], tags: ['수출', '전기차'] },
  { name: '조선·방산', symbols: ['329180', '012450'], tags: ['수주', '정책'] },
  { name: '플랫폼', symbols: ['035420', '035720'], tags: ['광고', 'AI'] },
];

/*
 * 히트맵에 올릴 종목.
 *
 * 예전에는 `change`에 지어낸 등락률이 박혀 있었다 — 실존 종목에 가짜 숫자를
 * 붙여 색까지 입히고 있었다. 이제 등락률은 시세에서 받아온다.
 *
 * `weight`는 타일 크기일 뿐이다. 시총 비중을 재서 넣은 값이 아니라 화면을
 * 채우는 비율이라, 이건 그대로 둔다(화면에도 그렇게 적는다).
 */
const HEATMAP_ITEMS: HeatmapItem[] = [
  { symbol: '005930', name: '삼성전자', sector: 'semiconductor', weight: 18 },
  { symbol: '000660', name: 'SK하이닉스', sector: 'semiconductor', weight: 14 },
  { symbol: '373220', name: 'LG에너지솔루션', sector: 'battery', weight: 8 },
  { symbol: '207940', name: '삼성바이오로직스', sector: 'bio', weight: 7 },
  { symbol: '012450', name: '한화에어로스페이스', sector: 'defense', weight: 6 },
  { symbol: '329180', name: 'HD현대중공업', sector: 'shipbuilding', weight: 5 },
  { symbol: '005380', name: '현대차', sector: 'auto', weight: 5 },
  { symbol: '035420', name: 'NAVER', sector: 'platform', weight: 4 },
  { symbol: '035720', name: '카카오', sector: 'platform', weight: 3 },
  { symbol: '051910', name: 'LG화학', sector: 'battery', weight: 3 },
  { symbol: '068270', name: '셀트리온', sector: 'bio', weight: 3 },
  { symbol: '000270', name: '기아', sector: 'auto', weight: 3 },
];

/** 히트맵 종목의 시세 조회용 id. 전부 KOSPI다. */
const HEATMAP_INSTRUMENT_IDS = HEATMAP_ITEMS.map((item) => `KR:KOSPI:${item.symbol}`);

const LOUNGE_POSTS: LoungePost[] = [
  {
    id: 'lounge-1',
    author: 'macro-note',
    title: 'CPI 전 야간선물 베이시스 체크',
    body: 'KOSPI200 야간선물과 환율 움직임이 엇갈릴 때는 개장 전 현물 괴리를 먼저 봅니다.',
    tag: '야간선물',
    replies: 8,
    likes: 24,
  },
  {
    id: 'lounge-2',
    author: 'oil-watch',
    title: 'WTI 하락 때 정유·항공 반응 분리',
    body: '원유 단기 급락은 비용주보다 수요 둔화 신호로 읽히는 구간이 있습니다.',
    tag: '원자재',
    replies: 5,
    likes: 19,
  },
  {
    id: 'lounge-3',
    author: 'semi-cycle',
    title: '삼닉 쏠림이 과열인지 확인하는 방법',
    body: '반도체 거래대금 비중이 커질 때는 방산·전력기기 같은 2순위 테마의 상대강도도 같이 봅니다.',
    tag: '테마',
    replies: 11,
    likes: 31,
  },
];

/*
 * 채팅 피드.
 *
 * 지어낸 메시지다. 라운지 게시글에는 표시를 붙였는데 여기만 빠져 있었다 —
 * 사용자명도 시각도 고정이라 언제 열어도 08:41이 최신으로 뜬다. `실시간
 * 채팅`이라는 제목 아래 그렇게 놓이면 지금 오가는 대화로 읽힌다.
 */
const CHAT_MESSAGES: ChatMessage[] = [
  { id: 'chat-1', author: 'open-watch', message: '개장 전 환율이 먼저 튀면 야간 환산가 괴리를 같이 보세요.', time: '08:41', tone: 'macro' },
  { id: 'chat-2', author: 'semi-bid', message: '삼전 GDR 프리미엄은 둔한데 KOSPI200 야간선물은 강합니다.', time: '08:43', tone: 'normal' },
  { id: 'chat-3', author: 'risk-alert', message: 'CPI 발표 전후 뉴스 링크는 출처 확인 후 공유합니다.', time: '08:44', tone: 'alert' },
  { id: 'chat-4', author: 'oil-desk', message: 'WTI 하락은 정유보다 항공/운송 쪽 반응도 같이 체크 중입니다.', time: '08:45', tone: 'normal' },
];

/*
 * 증권사 수수료율.
 *
 * 확인된 값이 아니다. 어디서 언제 가져왔다는 기록 없이 들어와 있었고, 실제
 * 요율은 상품·이벤트·계좌 개설 경로에 따라 다르고 수시로 바뀐다. 그런데
 * 화면은 실존 증권사 이름 옆에 소수 넷째 자리까지 적고 `BEST`까지 붙여
 * 추천처럼 보였다 — 초보자가 이걸 보고 계좌를 열 수 있는 자리다.
 *
 * 지우지는 않는다. 계산기 자체는 쓸모가 있고, 값을 바꿔 가며 비교하는 데
 * 출발점이 필요하다. 대신 화면에서 확인된 값이 아니라고 밝힌다.
 */
const FEE_BROKERS: FeeBroker[] = [
  { name: '대신증권', product: '표준', commissionRate: 0.00008, institutionRate: 0.00003, supportsDerivatives: true },
  { name: '미래에셋증권', product: '온라인', commissionRate: 0.00014, institutionRate: 0.00003, supportsDerivatives: true },
  { name: '한국투자증권', product: '온라인', commissionRate: 0.00014, institutionRate: 0.00003, supportsDerivatives: true },
  { name: 'NH투자증권', product: '나무', commissionRate: 0.00014, institutionRate: 0.00003, supportsDerivatives: true },
  { name: '키움증권', product: '영웅문', commissionRate: 0.00015, institutionRate: 0.00003, supportsDerivatives: true },
  { name: '삼성증권', product: 'mPOP', commissionRate: 0.00015, institutionRate: 0.00003, supportsDerivatives: true },
  { name: 'KB증권', product: 'M-able', commissionRate: 0.00015, institutionRate: 0.00003, supportsDerivatives: true },
  { name: '토스증권', product: '모바일', commissionRate: 0.00015, institutionRate: 0.00003, supportsDerivatives: false },
];

const OVERSEAS_REFRESH_MS = 5_000;
const LIST_QUOTE_REFRESH_MS = 60_000;
const FX_REFRESH_MS = 60_000;
const QUOTE_STALE_MS = LIST_QUOTE_REFRESH_MS * 2;
const TRADE_STALE_MS = 10_000;
// 탐색 리스트는 전체 현재가를 선조회하지 않는다. 첫 화면과 스크롤로 보인 종목만 점진적으로 채운다.
const LIST_QUOTE_REQUEST_CHUNK_SIZE = 8;
const DISCOVER_INITIAL_QUOTE_TARGETS = 24;
const SEARCH_QUOTE_TARGETS = 10;
const RECENT_INSTRUMENT_LIMIT = 8;
// 매수가능 조회는 실계좌 API라 지정가를 타이핑하는 동안 매 글자마다 호출하지 않는다.
const ORDERABILITY_DEBOUNCE_MS = 700;
const ORDERABLE_DOMESTIC_ASSET_TYPES = new Set<Instrument['assetType']>(['stock', 'etf', 'etn']);
const STORAGE_PREFIX = 'investment-monitor:';

/**
 * KIS 계좌 전환 탭. 계좌가 하나뿐이면 아무것도 그리지 않아 단일 계좌 화면은 그대로 유지된다.
 * KIS는 앱키에 등록된 계좌만 조회를 허용하므로 목록은 서버가 짝지어 준 것만 온다.
 */
function BrokerAccountPicker({
  accounts,
  value,
  onChange,
}: {
  accounts: BrokerAccountRef[];
  value: string | null;
  onChange: (accountId: string) => void;
}): JSX.Element | null {
  if (accounts.length < 2) return null;
  return (
    <div className="broker-account-picker" role="tablist" aria-label="KIS 계좌 선택">
      {accounts.map((account) => (
        <button
          aria-selected={value === account.id}
          key={account.id}
          onClick={() => onChange(account.id)}
          role="tab"
          type="button"
        >
          {account.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 표 행을 기본 몇 줄까지만 보여주고 나머지는 펼쳐서 본다.
 * 기록이 쌓이는 카드 하나가 화면을 독점하면 옆 카드를 못 본다.
 * 카드마다 따로 자르면 기준이 갈리므로 한 곳에서 처리한다.
 */
/**
 * 주문 기록의 종목 칸에 찍을 값. 언제나 종목코드 한 가지 형태로 맞춘다.
 *
 * 이 칸에 세 가지가 섞여 있었다.
 * - `005930` — 정상
 * - `KR:KOSPI:005930` — symbol이 없는 줄(종목을 해석하기 전에 차단된 시도)이
 *   `requestedInstrumentId`를 그대로 찍었다. 내부 식별자다.
 * - `LSE:BC94` — 야간 환산가 주문. 저장된 symbol이 GDR 원본 코드라
 *   사용자가 주문한 종목과 다르게 읽힌다.
 *
 * 콜론이 없는 값만 종목코드로 보고, 아니면 instrumentId의 마지막 조각을 쓴다.
 * 원본 식별자는 title에 남아 있어 잃는 정보는 없다.
 */
function orderLogSymbolLabel(symbol?: string, requestedInstrumentId?: string): string {
  if (symbol && !symbol.includes(':')) return symbol;
  const tail = requestedInstrumentId?.split(':').pop();
  if (tail) return tail;
  return symbol || '-';
}

/**
 * 이 종목으로는 주문이 되지 않는다는 안내.
 *
 * 주문 티켓과 예약주문 카드 두 곳에서 쓴다. 티켓만 고쳤더니 예약주문 쪽은
 * 같은 사실이 10px 잔글씨로 버튼 아래에 남아 두 화면이 어긋났다. 한 곳에
 * 묶어 두면 다음에 문구를 고칠 때 같이 따라온다.
 */
function UnorderableInstrumentNotice({ action, where }: { action: string; where: string }): JSX.Element {
  return (
    <div className="order-ticket__unavailable" role="note">
      <strong>{action}할 수 없는 종목입니다</strong>
      <span>
        지수·선물·야간 환산가는 값을 보라고 둔 참고 지표입니다.
        국내 주식·ETF·ETN 중에서 골라 주세요 — {where}에 있습니다.
      </span>
    </div>
  );
}

/**
 * 이 숫자는 실제 시세가 아니라는 표시.
 *
 * 화면 구성을 보려고 넣어 둔 상수가 몇 군데 있는데, 종목명이 진짜라서
 * 등락률·점수도 진짜로 읽힌다. 실제로 히트맵은 `삼성전자 +0.22%`처럼
 * 실존 종목에 지어낸 값을 붙여 보여주고 있었다. 값을 지우면 화면 구성을
 * 볼 수 없으니, 지우는 대신 어디까지가 예시인지 밝힌다.
 */
function SampleBadge({ note }: { note: string }): JSX.Element {
  return (
    <span className="sample-badge" title={note}>
      예시 데이터
    </span>
  );
}

function CollapsibleRows({
  rows,
  limit = 8,
  /* 접힌 줄이 무엇인지 부르는 쪽이 정할 수 있게 한다. `N건 더 보기`로는
     "아직 조회할 수 없는 항목"인지 그냥 나머지인지 구별되지 않는다. */
  moreLabel,
}: {
  rows: JSX.Element[];
  limit?: number;
  moreLabel?: (hidden: number) => string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  if (rows.length <= limit) return <>{rows}</>;

  return (
    <>
      {expanded ? rows : rows.slice(0, limit)}
      <button className="portfolio-table__more" onClick={() => setExpanded((v) => !v)} type="button">
        {expanded ? '접기' : (moreLabel ?? ((hidden: number) => `${hidden}건 더 보기`))(rows.length - limit)}
      </button>
    </>
  );
}

/**
 * 호가창.
 *
 * 얼마에 낼지 정하는 자리라 주문 폼 바로 위에 둔다. 값을 누르면 지정가로
 * 채워 준다 — 손으로 옮겨 적으면 자릿수를 틀린다.
 *
 * 매도(팔자)를 위, 매수(사자)를 아래에 둔다. 국내 증권사 호가창의 배치라
 * 이 순서를 바꾸면 익숙한 사람이 반대로 읽는다.
 */
function OrderBookPanel({
  book,
  error,
  nowMs,
  onPickPrice,
  visible,
}: {
  book: OrderBook | null;
  error: string | null;
  nowMs: number;
  onPickPrice: (price: number) => void;
  visible: boolean;
}): JSX.Element | null {
  if (!visible) return null;

  const asks = book ? [...book.levels].filter((l) => l.askPrice > 0).sort((a, b) => b.step - a.step) : [];
  const bids = book ? book.levels.filter((l) => l.bidPrice > 0) : [];
  // 막대 길이는 실제 비율이라야 한다. 이 호가창 안에서 가장 큰 잔량을 100%로 잡는다.
  const maxQuantity = Math.max(
    1,
    ...asks.map((l) => l.askQuantity),
    ...bids.map((l) => l.bidQuantity),
  );

  const row = (
    key: string,
    side: 'ask' | 'bid',
    price: number,
    quantity: number,
  ): JSX.Element => (
    <button
      aria-label={`${formatNumber(price)}원 ${side === 'ask' ? '매도' : '매수'} 잔량 ${formatNumber(quantity)}주 · 지정가로 넣기`}
      className="order-book__row"
      data-side={side}
      key={key}
      onClick={() => onPickPrice(price)}
      type="button"
    >
      <span className="order-book__bar" style={{ width: `${(quantity / maxQuantity) * 100}%` }} />
      <em>{formatNumber(price)}</em>
      <i>{formatNumber(quantity)}</i>
    </button>
  );

  return (
    <section className="order-book" aria-label="호가">
      <div className="order-book__header">
        <strong>호가</strong>
        {book ? (
          <span>
            {formatClock(book.fetchedAt)} 기준 · {Math.max(0, Math.round((nowMs - book.fetchedAt) / 1000))}초 전
          </span>
        ) : (
          <span>{error ? '조회 실패' : '조회 중'}</span>
        )}
      </div>

      {/*
        동시호가에는 체결이 없고 예상 체결가만 나온다. 정규장이 시작돼도 KIS는
        이 값을 지우지 않고 개장 결과를 들고 있어서, 서버가 장운영 구분으로
        걸러 auction일 때만 채워 보낸다.
      */}
      {book?.expected && (
        <p className="order-book__expected">
          <strong>동시호가 예상 체결 {formatNumber(book.expected.price)}원</strong>
          <span data-tone={moveTone(book.expected.sign)}>
            {formatSignedPrice(book.expected.change)} ({formatRate(book.expected.changeRate)})
          </span>
          <small>예상 거래량 {formatNumber(book.expected.volume)}주 · 아직 체결된 값이 아닙니다</small>
        </p>
      )}

      {book?.volatilityInterrupted && (
        <p className="order-book__vi">변동성완화장치(VI)가 걸려 있습니다. 체결이 잠시 멈춥니다.</p>
      )}

      {error && <p className="order-book__error">호가를 갱신하지 못했습니다 — {error}</p>}

      {book && asks.length + bids.length === 0 && (
        <p className="order-book__empty">호가에 남은 물량이 없습니다</p>
      )}

      {book && asks.length + bids.length > 0 && (
        <div className="order-book__list">
          {asks.map((l) => row(`ask-${l.step}`, 'ask', l.askPrice, l.askQuantity))}
          {bids.map((l) => row(`bid-${l.step}`, 'bid', l.bidPrice, l.bidQuantity))}
        </div>
      )}

      {book && (
        <div className="order-book__totals">
          <span>총 매도 잔량 {formatNumber(book.totalAskQuantity)}</span>
          <span>총 매수 잔량 {formatNumber(book.totalBidQuantity)}</span>
        </div>
      )}
    </section>
  );
}

/*
 * 주문 한 건에 붙는 비용 어림.
 *
 * 예상 주문액이 단가×수량뿐이라, 10주를 사려는 사람이 수수료·세금을 0으로
 * 여기게 된다. 매도는 특히 커서 — 증권거래세가 수수료의 열 배가 넘는다.
 *
 * **요율도 세율도 확인된 값이 아니다.** 이 계좌는 한국투자증권인데, 같은
 * 증권사여도 상품·이벤트·개설 경로에 따라 요율이 다르고 세율은 법으로 바뀐다.
 * 발견>수수료 탭이 쓰는 값을 그대로 가져다 쓰고, 화면에도 어림이라고 적는다.
 * 안 보여 주는 것보다는 낫지만 정확한 값인 척하면 안 된다.
 */
const KIS_COMMISSION_RATE_ASSUMPTION = 0.00014;
const KR_INSTITUTION_FEE_RATE_ASSUMPTION = 0.00003;

interface OrderCostEstimate {
  commission: number;
  institutionFee: number;
  /** 매도에만 붙는 증권거래세. 매수는 0 */
  tax: number;
  total: number;
  /** 매수는 총액 + 비용, 매도는 총액 − 비용 */
  settlement: number;
  taxRate: number;
}

function estimateOrderCost(
  notional: number,
  side: OrderSide,
  market: string | undefined,
): OrderCostEstimate | null {
  if (!Number.isFinite(notional) || notional <= 0) return null;
  const taxRate =
    side === 'sell'
      ? market === 'KONEX'
        ? KR_KONEX_SELL_TAX_RATE_ASSUMPTION
        : KR_SELL_TAX_RATE_ASSUMPTION
      : 0;
  const commission = notional * KIS_COMMISSION_RATE_ASSUMPTION;
  const institutionFee = notional * KR_INSTITUTION_FEE_RATE_ASSUMPTION;
  const tax = notional * taxRate;
  const total = commission + institutionFee + tax;
  return {
    commission,
    institutionFee,
    tax,
    total,
    settlement: side === 'buy' ? notional + total : notional - total,
    taxRate,
  };
}

/**
 * 리스크 룰로 미리 거를 수 있는 사유.
 *
 * 서버가 판정의 주인이다. 여기서는 화면이 미리 말해 주는 것뿐이고, 서버만 아는
 * 것(당일 누적 한도·휴장일·거래 시간)은 흉내 내지 않는다 — 흉내 낸 값이 서버와
 * 어긋나면 그게 더 나쁘다.
 *
 * 수동 주문과 예약주문이 각자 따로 검사하다 예약주문 쪽이 통째로 빠져 있었다.
 * (자동매매도 자기 것을 따로 갖고 있는데, 그쪽은 검사 대상이 룰 자체라 다르다.)
 * 한 곳에서 만들어 둘 다 쓴다. 네 번째가 생겨도 여기만 부르면 된다.
 */
function riskRuleBlockers({
  rules,
  error,
  symbol,
  orderType,
  quantity,
  price,
}: {
  rules: RiskRuleSet | null;
  error: string | null;
  symbol: string | undefined;
  /** 예약주문은 언제나 지정가다 */
  orderType: OrderType;
  quantity: number;
  /** 금액 한도를 재는 데 쓸 단가. 시장가면 현재가로 어림한다(서버와 같은 방식) */
  price: number;
}): string[] {
  /*
   * 룰을 모르면 막힌 쪽에 둔다. 받아 둔 값이 있어도 마지막 조회가 실패했으면
   * 아는 것이 아니다 — 그 사이 룰이 조여졌으면 낡은 값으로 `괜찮습니다`라고
   * 말하게 된다. 어차피 룰 조회가 실패할 정도면 서버도 판정하지 못한다.
   */
  if (!rules || error) {
    return [
      error
        ? `리스크 룰을 확인하지 못했습니다. 확인 전에는 주문이 나가지 않습니다 (${error})`
        : '리스크 룰을 확인하는 중입니다.',
    ];
  }

  const blockers: string[] = [];
  if (!rules.enabled) blockers.push('이 계좌는 리스크 룰에서 실주문이 꺼져 있습니다.');
  if (orderType === 'market' && !rules.allowMarketOrder) {
    blockers.push('이 계좌는 시장가 주문이 막혀 있습니다. 지정가로 내거나 리스크 룰을 고치세요.');
  }
  if (symbol) {
    if (rules.symbolBlocklist.includes(symbol)) blockers.push(`차단 종목입니다 (${symbol}).`);
    if (rules.symbolAllowlist.length > 0 && !rules.symbolAllowlist.includes(symbol)) {
      blockers.push(`허용 종목 목록에 없습니다 (${symbol}). 허용: ${rules.symbolAllowlist.join(', ')}`);
    }
  }
  if (Number.isFinite(quantity) && quantity > rules.maxOrderQuantity) {
    blockers.push(`1회 주문 수량 한도 ${formatNumber(rules.maxOrderQuantity)}주를 넘습니다.`);
  }
  const notional = price * quantity;
  if (Number.isFinite(notional) && notional > rules.maxOrderNotional) {
    blockers.push(`1회 주문 금액 한도 ${formatNumber(rules.maxOrderNotional)}원을 넘습니다.`);
  }
  return blockers;
}

/** 국내 현금 주문이 성립하는 종목인지. 지수·선물·야간 프록시는 매수가능 조회 대상이 아니다. */
function isOrderableDomesticInstrument(instrument: Instrument | null): boolean {
  return Boolean(
    instrument && instrument.country === 'KR' && ORDERABLE_DOMESTIC_ASSET_TYPES.has(instrument.assetType),
  );
}

function readStoredValue<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  const value = window.localStorage.getItem(`${STORAGE_PREFIX}${key}`);
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** 모의투자 시드머니. 손익은 이 값을 기준으로 잰다. */
const SIMULATION_SEED_CASH = 1_000_000;

function readStoredBoolean(key: string, fallback: boolean): boolean {
  const value = window.localStorage.getItem(`${STORAGE_PREFIX}${key}`);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/**
 * 저장된 숫자. 없으면 fallback.
 *
 * `Number(localStorage.getItem(...))`로 쓰면 안 된다. 키가 없을 때
 * `getItem`은 null을 주고 `Number(null)`은 NaN이 아니라 **0**이다.
 * 그래서 `Number.isFinite(value) && value >= 0` 같은 검사를 통과해 버린다.
 * 모의투자 시드머니가 그랬다 — 처음 여는 사람은 현금 0에 손익 -100만원으로
 * 시작했고, 살 돈이 없어 아무것도 못 했다.
 */
function readStoredNumber(key: string, fallback: number, isValid: (value: number) => boolean): number {
  const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${key}`);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && isValid(value) ? value : fallback;
}

function writeStoredValue(key: string, value: string | boolean): void {
  window.localStorage.setItem(`${STORAGE_PREFIX}${key}`, String(value));
}

function isStoredInstrument(value: unknown): value is Instrument {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    typeof item.symbol === 'string' &&
    typeof item.name === 'string' &&
    typeof item.market === 'string' &&
    typeof item.country === 'string' &&
    typeof item.currency === 'string' &&
    typeof item.assetType === 'string' &&
    item.provider === 'kis' &&
    typeof item.providerSymbol === 'string' &&
    typeof item.exchangeCode === 'string' &&
    typeof item.timezone === 'string'
  );
}

function readStoredInstruments(key: string): Instrument[] {
  const value = window.localStorage.getItem(`${STORAGE_PREFIX}${key}`);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isStoredInstrument).slice(0, RECENT_INSTRUMENT_LIMIT) : [];
  } catch {
    return [];
  }
}

function writeStoredJson(key: string, value: unknown): void {
  window.localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(value));
}

function isSimulationPosition(value: unknown): value is SimulationPosition {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.instrumentId === 'string' &&
    typeof item.symbol === 'string' &&
    typeof item.name === 'string' &&
    typeof item.quantity === 'number' &&
    Number.isFinite(item.quantity) &&
    typeof item.averagePrice === 'number' &&
    Number.isFinite(item.averagePrice)
  );
}

function readStoredSimulationPositions(): SimulationPosition[] {
  const value = window.localStorage.getItem(`${STORAGE_PREFIX}simulationPositions`);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isSimulationPosition) : [];
  } catch {
    return [];
  }
}

function areStringArraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === 'input' || tagName === 'textarea' || tagName === 'select';
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

function summarizeInstrumentMoves(
  instruments: Instrument[],
  getSnapshot: (instrument: Instrument) => PriceSnapshot | undefined,
): MoveSummary {
  const summary: MoveSummary = {
    up: 0,
    down: 0,
    flat: 0,
    waiting: 0,
  };
  let topMoveRate = -1;

  for (const instrument of instruments) {
    const itemSnapshot = getSnapshot(instrument);

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
}

function getRangePosition(price: number, low: number, high: number): number | null {
  if (!Number.isFinite(price) || !Number.isFinite(low) || !Number.isFinite(high) || high <= low) return null;
  return Math.min(100, Math.max(0, ((price - low) / (high - low)) * 100));
}

function movingAverageLatest(candles: Candle[], period: number): number | undefined {
  if (candles.length < period) return undefined;
  const slice = candles.slice(-period);
  const sum = slice.reduce((total, candle) => total + candle.close, 0);
  return sum / period;
}

function quoteSourceForInstrument(instrument: Instrument, trade?: Trade, quote?: Quote): '실시간' | '조회' | '대기' {
  if (instrument.country === 'KR' && trade) return '실시간';
  if (quote) return '조회';
  return '대기';
}

function isRealtimeChartInstrument(instrument: Instrument | null): boolean {
  return Boolean(instrument && instrument.market === 'KRX_NIGHT' && (instrument.assetType === 'future' || instrument.assetType === 'future_spread'));
}

function realtimeChartStatusLabel(instrument: Instrument | null, trade: Trade | undefined): string {
  if (!isRealtimeChartInstrument(instrument)) return '';
  return trade ? '실시간 차트 수신중' : '실시간 차트 대기';
}

function formatPrice(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('ko-KR') : '-';
}

function formatCurrencyPrice(n: number | undefined, currency = 'KRW'): string {
  if (n === undefined || !Number.isFinite(n)) return '-';
  if (currency === 'KRW') {
    return `${n.toLocaleString('ko-KR', { maximumFractionDigits: 0 })}원`;
  }
  if (currency === 'USD') {
    return `$${n.toLocaleString('ko-KR', {
      minimumFractionDigits: n < 100 ? 2 : 0,
      maximumFractionDigits: 2,
    })}`;
  }
  return `${n.toLocaleString('ko-KR', { maximumFractionDigits: 2 })} ${currency}`;
}

function formatSignedCurrencyPrice(n: number, currency = 'KRW'): string {
  if (!Number.isFinite(n)) return '-';
  return `${n > 0 ? '+' : ''}${formatCurrencyPrice(n, currency)}`;
}

function formatExchangeRate(rate: number | undefined): string {
  if (rate === undefined || !Number.isFinite(rate)) return '-';
  return `${rate.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}원`;
}

function formatConvertedKrw(value: number | undefined, currency: string | undefined, exchangeRate: ExchangeRate | null): string | undefined {
  if (value === undefined || !Number.isFinite(value) || currency !== 'USD' || !exchangeRate) return undefined;
  return `약 ${formatCurrencyPrice(Math.round(value * exchangeRate.rate), 'KRW')}`;
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
  /*
   * 거래량은 주식 수라 소수점이 의미 없다. 평균 거래량처럼 나눗셈으로 나온 값이
   * 1만 미만이면 `4,573.842`처럼 소수점 세 자리가 그대로 찍혔다 — 옆 칸들이
   * `54만`, `5만`인데 혼자만 형식이 달랐다.
   */
  return Math.round(n).toLocaleString('ko-KR');
}

function formatTradeTime(time: string | undefined): string {
  if (!time || !/^\d{6}$/.test(time)) return '실시간 대기';
  return `${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
}

/*
 * 시각만 찍는다. 예전엔 값이 없을 때 `시세 연결 대기`라는 상태 문구를
 * 돌려줬는데, 부르는 쪽이 `시세 갱신 ${formatClock(...)}`처럼 문장에 끼워
 * 쓰면 "시세 갱신 시세 연결 대기"가 됐다. 포맷 함수가 상태를 지어내지 않게
 * 중립 자리표시자만 준다. 없을 때 뭐라고 적을지는 부르는 쪽이 정한다.
 */
/**
 * 화면 위쪽 오류 배너에 쓸 문구.
 *
 * fetch가 실패하면 브라우저는 `TypeError: Failed to fetch`만 준다. 무엇이
 * 잘못됐는지 알려주지 못하니 사람이 읽을 문장으로 바꾼다. 그 밖의 오류는
 * 서버가 보낸 메시지가 그대로 유용하므로 손대지 않는다.
 */
function toErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/Failed to fetch|NetworkError|ERR_NETWORK|ERR_CONNECTION/i.test(raw)) {
    return '서버에 연결하지 못했습니다. 백엔드가 실행 중인지 확인하세요.';
  }
  return raw;
}

function formatClock(ms: number | null): string {
  if (!ms) return '-';
  return new Intl.DateTimeFormat('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}일 ${hours}시간`;
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  return `${minutes}분`;
}

function getKoreanMarketCountdown(nowMs: number): { label: string; detail: string; target: string } {
  const now = new Date(nowMs);
  const target = new Date(now);
  target.setHours(8, 45, 0, 0);

  const day = now.getDay();
  const isWeekend = day === 0 || day === 6;
  const afterOpen = !isWeekend && now.getTime() >= target.getTime();
  if (isWeekend || afterOpen) {
    const daysUntilMonday = day === 6 ? 2 : day === 0 ? 1 : 1;
    target.setDate(now.getDate() + daysUntilMonday);
    target.setHours(8, 45, 0, 0);
    if (target.getDay() === 6) target.setDate(target.getDate() + 2);
    if (target.getDay() === 0) target.setDate(target.getDate() + 1);
  }

  const targetLabel = new Intl.DateTimeFormat('ko-KR', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(target);

  return {
    label: isWeekend ? '주말 모드' : afterOpen ? '정규장 이후' : '개장 전',
    detail: `다음 기준 시각까지 ${formatDuration(target.getTime() - nowMs)}`,
    target: targetLabel,
  };
}

function tradeTimestampMs(trade: Trade | undefined): number | null {
  if (!trade || !/^\d{8}$/.test(trade.date) || !/^\d{6}$/.test(trade.time)) return null;
  const y = Number(trade.date.slice(0, 4));
  const m = Number(trade.date.slice(4, 6));
  const d = Number(trade.date.slice(6, 8));
  const hh = Number(trade.time.slice(0, 2));
  const mm = Number(trade.time.slice(2, 4));
  const ss = Number(trade.time.slice(4, 6));
  return new Date(y, m - 1, d, hh, mm, ss).getTime();
}

/**
 * 로그용 시각. 오늘이면 시각만, 다른 날이면 날짜까지.
 *
 * 실행 로그는 하루를 넘겨 쌓이는데 `11:58:34`만 적으면 어제 것과 오늘 것이
 * 똑같아 보인다. 오늘 것에까지 날짜를 붙이면 대부분의 줄이 같은 날짜를
 * 반복하므로, 넘어간 줄에만 붙인다.
 */
function formatLogTime(ms: number, nowMs: number): string {
  const at = new Date(ms);
  const now = new Date(nowMs);
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (sameDay) return formatClock(ms);
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${month}-${day} ${formatClock(ms)}`;
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

function cleanNewsSearchText(text: string): string {
  return text
    .replace(/\b(?:ICH|NEWS|CNTT|DATA)[A-Z0-9_-]+\b/gi, ' ')
    .replace(/\b[A-Z]{2,}\d{3,}\b/g, ' ')
    .replace(/\b\d{6,}\b/g, ' ')
    .replace(/[$#][A-Za-z0-9가-힣._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function newsSearchUrl(item: NewsItem): string {
  const query = cleanNewsSearchText(item.title) || item.source || '경제 뉴스';
  return `https://www.google.com/search?tbm=nws&q=${encodeURIComponent(query)}`;
}

function topicNewsUrl(query: string): string {
  return `https://www.google.com/search?tbm=nws&q=${encodeURIComponent(cleanNewsSearchText(query) || query)}`;
}

function newsFiltersForTitle(title: string): NewsFilter[] {
  const filters = new Set<NewsFilter>();
  const text = title.toLowerCase();
  if (/금리|fed|fomc|cpi|ppi|물가|환율|달러|거시|경기/i.test(title)) filters.add('macro');
  if (/삼성|하이닉스|현대|lg|주식|증시|코스피|코스닥|실적|공시/i.test(title)) filters.add('stocks');
  if (/원유|wti|금|은|천연가스|원자재|유가/i.test(title)) filters.add('commodities');
  if (/비트코인|이더|코인|crypto|bitcoin|ethereum/.test(text)) filters.add('crypto');
  if (/정책|관세|규제|선거|정부|무역|중앙은행/i.test(title)) filters.add('policy');
  if (filters.size === 0) filters.add('stocks');
  return [...filters];
}

function terminalNewsCardFromItem(item: NewsItem): TerminalNewsCard {
  const cleanTitle = cleanNewsSearchText(item.title) || item.title;
  return {
    id: item.id,
    title: cleanTitle,
    source: item.source,
    publishedAt: item.publishedAt,
    filters: newsFiltersForTitle(cleanTitle),
    url: newsSearchUrl(item),
  };
}

function formatEventDay(date: string): string {
  const parsed = new Date(`${date}T00:00:00+09:00`);
  return new Intl.DateTimeFormat('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    timeZone: 'Asia/Seoul',
  }).format(parsed);
}

function parseAmountInput(value: string, fallback: number): number {
  const parsed = Number(value.replaceAll(',', ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function feeImpactTone(value: number): 'up' | 'down' | 'flat' {
  if (value > 0) return 'up';
  if (value < 0) return 'down';
  return 'flat';
}

function heatmapTone(change: number): 'up' | 'down' | 'flat' {
  if (change > 0.1) return 'up';
  if (change < -0.1) return 'down';
  return 'flat';
}

function heatmapArea(weight: number): string {
  return `${Math.max(0.75, Math.min(2.5, weight / 6))}fr`;
}

function formatNumber(n: number | undefined): string {
  return n !== undefined && Number.isFinite(n) ? n.toLocaleString('ko-KR') : '-';
}

function formatMoney(n: number | undefined, currency = 'KRW'): string {
  return formatCurrencyPrice(n, currency);
}

function brokerExecutionStatusLabel(status: BrokerExecutionStatus): string {
  switch (status) {
    case 'filled':
      return '체결';
    case 'partial':
      return '부분체결';
    case 'open':
      return '미체결';
    case 'canceled':
      return '취소';
    case 'rejected':
      return '거부';
  }
}

function brokerOrderActionLabel(action: BrokerOrderRecord['action']): string {
  switch (action) {
    case 'place':
      return '전송';
    case 'amend':
      return '정정';
    case 'cancel':
      return '취소';
  }
}

function brokerOrderRecordStatusLabel(status: BrokerOrderRecord['status']): string {
  switch (status) {
    case 'submitted':
      return '접수';
    case 'blocked':
      return '차단';
    case 'rejected':
      return '거부';
  }
}

const TRADE_PROFIT_RANGES = [
  { days: 30, label: '1개월' },
  { days: 90, label: '3개월' },
  { days: 365, label: '1년' },
] as const;

/** 손익 색상. 한국 관례대로 이익이 빨강, 손실이 파랑이다. */
function profitTone(value: number | undefined): 'up' | 'down' | 'flat' {
  if (value === undefined || !Number.isFinite(value) || value === 0) return 'flat';
  return value > 0 ? 'up' : 'down';
}

function formatPercent(value: number | undefined): string {
  return value !== undefined && Number.isFinite(value) ? `${value.toFixed(2)}%` : '-';
}

/**
 * 조회 구간 표시용 'YY.MM.DD'.
 * 행 단위는 MM-DD로 충분하지만, 구간은 연도를 버리면 1년 범위가
 * '07-25 ~ 07-25'처럼 하루로 보인다.
 */
function formatBrokerDate(date: string): string {
  if (!/^\d{8}$/.test(date)) return '-';
  return `${date.slice(2, 4)}.${date.slice(4, 6)}.${date.slice(6, 8)}`;
}

/**
 * 경과 시간을 사람이 읽는 단위로. 초로만 쓰면 '1223초 전'처럼 감이 안 온다.
 * 갱신 여부를 훑어보는 용도라 한 단위까지만 보여준다.
 */
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}초 전`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

/** 브로커 통보의 HHMMSS를 'HH:MM:SS'로. 형식이 아니면 null이라 호출부가 대체값을 쓴다. */
function formatBrokerClock(time: string | undefined): string | null {
  if (!time || !/^\d{6}$/.test(time)) return null;
  return `${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
}

/** 브로커가 내려주는 YYYYMMDD·HHMMSS를 화면용 'MM-DD HH:MM'으로. */
function formatBrokerOrderTime(date: string, time?: string): string {
  if (!/^\d{8}$/.test(date)) return '-';
  const day = `${date.slice(4, 6)}-${date.slice(6, 8)}`;
  if (!time || !/^\d{6}$/.test(time)) return day;
  return `${day} ${time.slice(0, 2)}:${time.slice(2, 4)}`;
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
    case 'future':
      return '선물';
    case 'future_spread':
      return '스프레드';
    case 'night_proxy':
      return '야간 환산가';
    case 'commodity':
      return '원자재';
    case 'other':
      return '기타';
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

  if (instrument.assetType === 'night_proxy') {
    const parts = getZonedParts(instrument.timezone);
    const now = parts.hour * 60 + parts.minute;
    const open = 8 * 60;
    const close = 16 * 60 + 30;
    const localTime = `${parts.label} ${instrument.timezone}`;
    if (parts.weekday === 'Sat' || parts.weekday === 'Sun') {
      return { tone: 'closed', label: '휴장', detail: 'GDR 기준 주말', hours: '08:00-16:30', localTime };
    }
    if (now >= open && now <= close) {
      return { tone: 'open', label: 'GDR 장', detail: '환산가 갱신', hours: '08:00-16:30', localTime };
    }
    return { tone: 'closed', label: 'GDR 장마감', detail: '최근 환산가', hours: '08:00-16:30', localTime };
  }

  if (instrument.assetType === 'commodity') {
    const parts = getZonedParts(instrument.timezone);
    const localTime = `${parts.label} ${instrument.timezone}`;
    if (parts.weekday === 'Sat' || parts.weekday === 'Sun') {
      return { tone: 'closed', label: '휴장', detail: '원자재 선물 주말', hours: '거의 24시간', localTime };
    }
    return { tone: 'open', label: '글로벌 장', detail: '외부 지표 갱신', hours: '거의 24시간', localTime };
  }

  const sessions: Record<Instrument['country'], { open: number; close: number; hours: string; pre?: number }> = {
    KR: { open: 9 * 60, close: 15 * 60 + 30, hours: '09:00-15:30' },
    US: { pre: 4 * 60, open: 9 * 60 + 30, close: 16 * 60, hours: '09:30-16:00' },
    CN: { open: 9 * 60 + 30, close: 15 * 60, hours: '09:30-15:00' },
    JP: { open: 9 * 60, close: 15 * 60 + 30, hours: '09:00-15:30' },
    HK: { open: 9 * 60 + 30, close: 16 * 60, hours: '09:30-16:00' },
    VN: { open: 9 * 60, close: 15 * 60, hours: '09:00-15:00' },
    GLOBAL: { open: 0, close: 23 * 60 + 59, hours: '거래소별 상이' },
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

/**
 * 장이 닫혀 있으면 그 사유(`휴장`, `장외`, `GDR 장마감`)를, 열려 있으면 null.
 *
 * 값이 비어 있는 칸에 `대기`라고만 적으면 곧 채워질 상황과, 기다려도 오지 않는
 * 상황이 구별되지 않는다. 장 상태는 이미 getMarketSession이 알고 있으니 쓴다.
 */
function closedSessionLabel(instrument: Instrument | null | undefined): string | null {
  if (!instrument) return null;
  const session = getMarketSession(instrument);
  return session.tone === 'closed' ? session.label : null;
}

/** 시세 칸이 비어 있을 때 무엇을 기다리는지 적는다. */
function pendingQuoteLabel(instrument: Instrument): string {
  return closedSessionLabel(instrument) ?? '시세 대기';
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

/*
 * 화면에 보일 시장 이름.
 *
 * `instrument.market`을 그대로 찍으면 우리 내부 코드가 그대로 나온다 —
 * 탐색 목록에 `005930-NIGHT · NIGHT_PROXY · KRW`처럼 떴다. KOSPI·KOSDAQ·NAS
 * 같은 실제 시장 이름은 그대로 두고, 우리가 만든 구성만 한국어로 바꾼다.
 */
const MARKET_LABELS: Record<string, string> = {
  NIGHT_PROXY: '야간 환산가',
  KRX_NIGHT: 'KRX 야간선물',
  TV_COMMODITY: '원자재',
  OV_FUT: '해외선물',
};

function marketLabel(instrument: Instrument): string {
  return `${MARKET_LABELS[instrument.market] ?? instrument.market} · ${instrument.currency}`;
}

interface DataSourceLink {
  label: string;
  detail: string;
  url: string;
}

function tradingViewSymbolUrl(symbol: string): string {
  return `https://www.tradingview.com/symbols/${symbol.replace(':', '-')}/`;
}

function dataSourceLinksForInstrument(instrument: Instrument | null): DataSourceLink[] {
  if (!instrument) {
    return [
      {
        label: 'KIS API',
        detail: '국내 주식·선물 현재가',
        url: 'https://apiportal.koreainvestment.com/apiservice',
      },
      {
        label: '뉴스 검색',
        detail: '야간선물·원자재 뉴스',
        url: topicNewsUrl('야간선물 원자재 뉴스'),
      },
    ];
  }

  if (instrument.assetType === 'night_proxy') {
    return [
      { label: 'GDR 원본', detail: instrument.providerSymbol, url: tradingViewSymbolUrl(instrument.providerSymbol) },
      { label: '환율 원본', detail: 'FX_IDC:USDKRW', url: tradingViewSymbolUrl('FX_IDC:USDKRW') },
      { label: '국내 기준가', detail: 'KIS 삼성전자 현재가', url: 'https://apiportal.koreainvestment.com/apiservice' },
      { label: '뉴스 검색', detail: `${instrument.name} 뉴스`, url: topicNewsUrl(`${instrument.name} 뉴스`) },
    ];
  }

  if (instrument.assetType === 'commodity') {
    return [
      { label: '원본 시세', detail: instrument.providerSymbol, url: tradingViewSymbolUrl(instrument.providerSymbol) },
      { label: '뉴스 검색', detail: `${instrument.name} 원자재 뉴스`, url: topicNewsUrl(`${instrument.name} 원자재`) },
    ];
  }

  if (instrument.market === 'KRX_NIGHT') {
    return [
      { label: 'KIS 시세', detail: '국내 선물옵션 API', url: 'https://apiportal.koreainvestment.com/apiservice' },
      { label: '뉴스 검색', detail: `${instrument.name} 야간선물`, url: topicNewsUrl(`${instrument.name} 야간선물`) },
    ];
  }

  return [
    { label: 'KIS 시세', detail: `${instrument.market} ${instrument.providerSymbol}`, url: 'https://apiportal.koreainvestment.com/apiservice' },
    { label: '뉴스 검색', detail: instrument.name, url: topicNewsUrl(instrument.name) },
  ];
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
  const rangePosition = snapshot ? getRangePosition(snapshot.price, snapshot.low, snapshot.high) : null;
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

  /*
   * 예전엔 행 전체가 <button>이고 그 안에 <span role="button" tabIndex={0}>인
   * 관심 토글이 들어 있었다. 버튼 안의 버튼이라 HTML로 성립하지 않고, span에는
   * onKeyDown이 없어 키보드로는 관심종목을 켜고 끌 수 없었다 — 포커스는 가는데
   * Enter도 Space도 아무 일도 하지 않았다(브라우저에서 눌러 확인). 마우스로만
   * 됐다. 행을 <div>로 두고 선택과 관심 토글을 각각 진짜 <button>으로 나란히
   * 둔다. 토글이 선택 버튼 밖으로 나왔으므로 stopPropagation도 필요 없다.
   */
  return (
    <div
      className={`instrument-row${active ? ' active' : ''}${flashing ? ' is-flashing' : ''}`}
      data-move={tone}
    >
      <button
        className="instrument-row__select"
        onClick={() => onSelect(instrument)}
        /* 좁은 사이드바라 이름도 부제도 말줄임된다. 전체는 여기서 본다. */
        title={`${instrument.name} · ${instrument.symbol} · ${marketLabel(instrument)}`}
        type="button"
      >
        <div className="instrument-row__name">
          <div className="instrument-row__title">
            <strong>{instrument.name}</strong>
            {active && <em>선택</em>}
          </div>
          <span className="instrument-row__code">
            {instrument.symbol} · {marketLabel(instrument)}
          </span>
        </div>
        <div className="instrument-row__price" style={{ color }}>
          <span>{snapshot ? formatCurrencyPrice(snapshot.price, instrument.currency) : '-'}</span>
          {snapshot ? (
            <span className="instrument-row__rate">
              {formatSignedCurrencyPrice(snapshot.change, instrument.currency)} ({formatRate(snapshot.changeRate)})
            </span>
          ) : (
            /* 값이 왜 비었는지 적는다. `-`만 두면 로딩인지 휴장인지 알 수 없다. */
            <span className="instrument-row__pending">{pendingQuoteLabel(instrument)}</span>
          )}
          {snapshot && rangePosition !== null && (
            <span
              aria-label={`당일 저가 ${formatCurrencyPrice(snapshot.low, instrument.currency)}, 고가 ${formatCurrencyPrice(snapshot.high, instrument.currency)} 범위 내 ${Math.round(rangePosition)}% 위치`}
              className="instrument-row__range"
              title={`저가 ${formatCurrencyPrice(snapshot.low, instrument.currency)} · 고가 ${formatCurrencyPrice(snapshot.high, instrument.currency)}`}
            >
              <span style={{ left: `${rangePosition}%` }} />
            </span>
          )}
        </div>
      </button>
      {/*
        이름이 `+`·`−`뿐이라 낭독기에는 `더하기 버튼`으로만 들렸다. 어느 종목의
        무엇인지 aria-label에 적는다. 화면에 보이는 글자는 그대로 둔다.
      */}
      <button
        aria-label={`${instrument.name} ${watched ? '관심종목에서 제거' : '관심종목에 추가'}`}
        className="instrument-row__watch"
        onClick={() => onToggleWatch(instrument)}
        title={watched ? '관심종목에서 제거' : '관심종목에 추가'}
        type="button"
      >
        {watched ? '−' : '+'}
      </button>
    </div>
  );
}

export function App(): JSX.Element {
  const [watchlist, setWatchlist] = useState<Instrument[]>([]);
  const [savedWatchlists, setSavedWatchlists] = useState<WatchlistGroup[]>([]);
  const [activeSavedWatchlistId, setActiveSavedWatchlistId] = useState(
    () => window.localStorage.getItem(`${STORAGE_PREFIX}activeSavedWatchlistId`) ?? 'default',
  );
  const [categories, setCategories] = useState<InstrumentCategory[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>('kr-night-proxies');
  const [categoryItems, setCategoryItems] = useState<Instrument[]>([]);
  const [terminalItems, setTerminalItems] = useState<Instrument[]>([]);
  /** 터미널 지표 fetch가 끝났는지. 초기 종목을 고를 때 순서를 정하는 데 쓴다. */
  const [isTerminalLoaded, setIsTerminalLoaded] = useState(false);
  /** 관심목록도 도착했는지. 첫 종목을 두 목록을 다 보고 고르기 위해 필요하다. */
  const [isWatchlistLoaded, setIsWatchlistLoaded] = useState(false);
  const [discoverQuery, setDiscoverQuery] = useState('');
  const [selectedInstrument, setSelectedInstrument] = useState<Instrument | null>(null);
  const [visibleCategoryQuoteIds, setVisibleCategoryQuoteIds] = useState<string[]>([]);
  const [recentInstruments, setRecentInstruments] = useState<Instrument[]>(() =>
    readStoredInstruments('recentInstruments'),
  );
  const [candlesByCode, setCandlesByCode] = useState<Record<string, CandlesResponse>>({});
  const [quotesByCode, setQuotesByCode] = useState<Record<string, Quote>>({});
  const [newsByCode, setNewsByCode] = useState<Record<string, NewsItem[]>>({});
  const [query, setQuery] = useState('');
  const [symbolQuery, setSymbolQuery] = useState('');
  const [symbolResults, setSymbolResults] = useState<Instrument[]>([]);
  const [activeSymbolResultIndex, setActiveSymbolResultIndex] = useState(0);
  const [isSymbolSearching, setIsSymbolSearching] = useState(false);
  const [hasSymbolSearchCompleted, setHasSymbolSearchCompleted] = useState(false);
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
  const [showPriceLevels, setShowPriceLevels] = useState(() => readStoredBoolean('showPriceLevels', false));
  const [showComparePanel, setShowComparePanel] = useState(() => readStoredBoolean('showComparePanel', false));
  const [isFocusMode, setIsFocusMode] = useState(() => readStoredBoolean('focusMode', false));
  const [isCompactList, setIsCompactList] = useState(() => readStoredBoolean('compactList', false));
  const [layoutPreset, setLayoutPreset] = useState<LayoutPreset>(() =>
    readStoredValue('layoutPreset', 'balanced', LAYOUT_PRESET_OPTIONS.map((option) => option.key)),
  );
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
  const [activePage, setActivePage] = useState<AppPage>(() =>
    readStoredValue('activePage', 'terminal', APP_PAGE_OPTIONS.map((option) => option.key)),
  );
  const terminalTabsRef = useRef<HTMLElement | null>(null);
  const [terminalTab, setTerminalTab] = useState<TerminalTab>(() =>
    readStoredValue('terminalTab', 'overview', TERMINAL_TAB_OPTIONS.map((option) => option.key)),
  );
  const [newsFilter, setNewsFilter] = useState<NewsFilter>('all');
  const [macroFilter, setMacroFilter] = useState<MacroFilter>('all');
  const [calendarRegionFilter, setCalendarRegionFilter] = useState<CalendarRegionFilter>('all');
  const [calendarImpactFilter, setCalendarImpactFilter] = useState<CalendarImpactFilter>('all');
  const [feeMarket, setFeeMarket] = useState<FeeMarket>('kospi');
  const [chatPanelMode, setChatPanelMode] = useState<ChatPanelMode>('compact');
  const [feeAmount, setFeeAmount] = useState('1000000');
  const [feeExpectedReturn, setFeeExpectedReturn] = useState('5');
  const [sidePanelTab, setSidePanelTab] = useState<SidePanelTab>(() =>
    readStoredValue('sidePanelTab', 'discover', SIDE_PANEL_OPTIONS.map((option) => option.key)),
  );
  const [kisAccounts, setKisAccounts] = useState<BrokerAccountRef[]>([]);
  const [kisAccountId, setKisAccountId] = useState<string | null>(null);
  const [kisAccountSnapshot, setKisAccountSnapshot] = useState<BrokerAccountSnapshot | null>(null);
  const [usdKrwRate, setUsdKrwRate] = useState<ExchangeRate | null>(null);
  const [isKisAccountRefreshing, setIsKisAccountRefreshing] = useState(false);
  const [kisOrderability, setKisOrderability] = useState<BrokerOrderability | null>(null);
  const [isKisOrderabilityLoading, setIsKisOrderabilityLoading] = useState(false);
  const [kisSellability, setKisSellability] = useState<BrokerSellability | null>(null);
  const [isKisSellabilityLoading, setIsKisSellabilityLoading] = useState(false);
  const [kisOpenOrders, setKisOpenOrders] = useState<BrokerAmendableOrder[]>([]);
  const [isKisOpenOrdersRefreshing, setIsKisOpenOrdersRefreshing] = useState(false);
  /*
   * 호가 10단계와 동시호가 예상 체결.
   *
   * 얼마에 낼지 정하는 자리에 잔량이 없으면 값을 짐작으로 넣게 된다. 현재가만
   * 보고 지정가를 넣으면 그 값에 물량이 있는지 알 수 없다.
   *
   * 조회 실패를 빈 호가로 바꾸지 않는다 — 사유를 따로 들고 있는다.
   */
  const [orderBook, setOrderBook] = useState<OrderBook | null>(null);
  const [orderBookError, setOrderBookError] = useState<string | null>(null);
  const [kisReservedOrders, setKisReservedOrders] = useState<BrokerReservedOrder[]>([]);
  /*
   * 언제 받아온 값인지. 잔고 카드만 `갱신 07:27:39`를 적고 나머지는 아무것도
   * 적지 않았다. 그래서 새로고침을 눌러도 내용이 같으면 화면이 한 픽셀도
   * 바뀌지 않는다 — 실제로 눌러 보고 카드 innerHTML이 그대로인 걸 확인했다.
   * 눌린 건지 아닌지 알 방법이 없다. 서버가 주는 값이 있으면 그것을 쓰고
   * (체결내역), 없으면 받은 시각을 적는다.
   */
  const [kisOpenOrdersUpdatedAt, setKisOpenOrdersUpdatedAt] = useState<number | null>(null);
  const [kisReservedOrdersUpdatedAt, setKisReservedOrdersUpdatedAt] = useState<number | null>(null);
  const [isReservedCancelling, setIsReservedCancelling] = useState(false);
  const [reservedSide, setReservedSide] = useState<OrderSide>('buy');
  const [reservedQuantity, setReservedQuantity] = useState('1');
  const [reservedPrice, setReservedPrice] = useState('');
  const [reservedCancelMessage, setReservedCancelMessage] = useState<string | null>(null);
  const [kisOrderLog, setKisOrderLog] = useState<BrokerOrderRecord[]>([]);
  const [kisOrderLogUpdatedAt, setKisOrderLogUpdatedAt] = useState<number | null>(null);
  /** 서버 상한을 넘겨 더 오래된 기록이 남아 있는지. */
  const [kisOrderLogHasMore, setKisOrderLogHasMore] = useState(false);
  const [kisTradeProfit, setKisTradeProfit] = useState<BrokerTradeProfitSnapshot | null>(null);
  const [tradeProfitDays, setTradeProfitDays] = useState(30);
  /** 서버에 저장된 리스크 룰과, 편집 중인 사본. 저장 성공 시에만 둘을 맞춘다. */
  const [riskRules, setRiskRules] = useState<RiskRuleSet | null>(null);
  /** 리스크 룰 조회 실패 사유. 게이트와 같은 이유로 null과 따로 둔다. */
  const [riskRulesError, setRiskRulesError] = useState<string | null>(null);
  const [riskDraft, setRiskDraft] = useState<RiskRuleSet | null>(null);
  const [riskSymbolText, setRiskSymbolText] = useState({ allow: '', block: '' });
  const [isRiskSaving, setIsRiskSaving] = useState(false);
  const [riskMessage, setRiskMessage] = useState<string | null>(null);
  const [liveOrderGate, setLiveOrderGate] = useState<LiveOrderGate | null>(null);
  /** 게이트 조회가 실패했을 때의 사유. null이 `아직 안 옴`과 `못 받음`을 겸하지 않게 한다. */
  const [liveOrderGateError, setLiveOrderGateError] = useState<string | null>(null);
  /* 주문 확인 단계를 보여주는 중인지. 실제 증권사 주문 화면과 같은 흐름이다. */
  const [liveOrderConfirming, setLiveOrderConfirming] = useState(false);
  /*
   * 실계좌로 나가는 다른 두 자리도 한 번 확인받는다.
   *
   * 매수·매도만 `주문 확인` 단계가 있었고, 예약주문 등록과 정정·취소는 누르는
   * 즉시 전송됐다. 단가를 한 자리 잘못 치고 `확정`을 누르면 그대로 나간다.
   * 실계좌로 나가는 자리는 다 같은 대접을 받아야 한다.
   *
   * 정정·취소는 줄 안에서 확인하므로 어느 주문의 무슨 동작인지 키로 들고 있는다.
   */
  const [reservedConfirming, setReservedConfirming] = useState(false);
  const [amendConfirmKey, setAmendConfirmKey] = useState<string | null>(null);
  /*
   * 이번 주문의 멱등성 키. 확인 단계에 들어갈 때 한 번 만들고 그동안 유지한다.
   * 전송 버튼을 두 번 누르거나 네트워크가 끊겨 재시도해도 서버가 같은 키를 보고
   * 한 주문만 접수한다.
   */
  const [liveOrderKey, setLiveOrderKey] = useState<string | null>(null);

  /*
   * 자동매매. 러너는 서버에 살고 화면은 상태를 받아 보여줄 뿐이다.
   * 돌고 있는 동안에는 주기적으로 다시 받아 실행 기록이 쌓이는 걸 보여준다.
   */
  const [autoTrader, setAutoTrader] = useState<AutoTraderState | null>(null);
  /** 상태를 못 받아온 사유. 게이트(liveOrderGateError)와 같은 방식이다. */
  const [autoTraderError, setAutoTraderError] = useState<string | null>(null);
  const [autoStrategies, setAutoStrategies] = useState<
    Array<{ key: string; label: string; backtestNote?: string; verdict?: 'no_edge' | 'unproven' }>
  >([]);
  const [autoStrategy, setAutoStrategy] = useState('ma_cross');
  const [autoMode, setAutoMode] = useState<AutoTraderMode>('dry_run');
  const [autoTarget, setAutoTarget] = useState('100000');
  const [autoStop, setAutoStop] = useState('40000');
  const [autoMessage, setAutoMessage] = useState<string | null>(null);
  const [isAutoSubmitting, setIsAutoSubmitting] = useState(false);
  const [isLiveOrderSubmitting, setIsLiveOrderSubmitting] = useState(false);
  const [liveOrderMessage, setLiveOrderMessage] = useState<string | null>(null);
  /** 정정 중인 주문 id와 새 단가. 취소는 입력이 필요 없다. */
  const [amendingOrderId, setAmendingOrderId] = useState<string | null>(null);
  const [amendPrice, setAmendPrice] = useState('');
  const [kisExecutionSnapshot, setKisExecutionSnapshot] = useState<BrokerExecutionSnapshot | null>(null);
  const [isKisExecutionRefreshing, setIsKisExecutionRefreshing] = useState(false);
  const [orderSide, setOrderSide] = useState<OrderSide>('buy');
  const [orderType, setOrderType] = useState<OrderType>('market');
  const [orderTimeInForce, setOrderTimeInForce] = useState<OrderTimeInForce>('day');
  const [orderQuantity, setOrderQuantity] = useState('1');
  const [orderLimitPrice, setOrderLimitPrice] = useState('');
  const [simulationCash, setSimulationCash] = useState(() =>
    readStoredNumber('simulationCash', SIMULATION_SEED_CASH, (value) => value >= 0),
  );
  const [simulationPositions, setSimulationPositions] = useState<SimulationPosition[]>(readStoredSimulationPositions);
  const [simulationQuantity, setSimulationQuantity] = useState('1');
  const [error, setError] = useState<string | null>(null);

  /*
   * 오류 배너를 스스로 걷는다. 지우는 코드가 아예 없어서 한 번 실패하면
   * `TypeError: Failed to fetch`가 화면 맨 위에 영구히 붙어 있었다. 서버가
   * 돌아온 뒤에도 고장 난 것처럼 보인다.
   */
  useEffect(() => {
    if (!error) return undefined;
    const timer = window.setTimeout(() => setError(null), 8000);
    return () => window.clearTimeout(timer);
  }, [error]);
  const [quoteRefreshAt, setQuoteRefreshAt] = useState<number | null>(null);
  const [isQuoteRefreshing, setIsQuoteRefreshing] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [intradayCandlesByCode, setIntradayCandlesByCode] = useState<Record<string, Candle[]>>({});
  const discoverRowsRef = useRef<HTMLDivElement | null>(null);
  const selectedPriceRef = useRef<{ id?: string; price?: number }>({});
  const [isSelectedPriceFlashing, setIsSelectedPriceFlashing] = useState(false);
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
  useEffect(() => writeStoredValue('showPriceLevels', showPriceLevels), [showPriceLevels]);
  useEffect(() => writeStoredValue('showComparePanel', showComparePanel), [showComparePanel]);
  useEffect(() => writeStoredValue('focusMode', isFocusMode), [isFocusMode]);
  useEffect(() => writeStoredValue('compactList', isCompactList), [isCompactList]);
  useEffect(() => writeStoredValue('layoutPreset', layoutPreset), [layoutPreset]);
  useEffect(() => writeStoredValue('watchlistCollapsed', isWatchlistCollapsed), [isWatchlistCollapsed]);
  useEffect(() => writeStoredValue('bottomDockTab', bottomDockTab), [bottomDockTab]);
  useEffect(() => writeStoredValue('bottomDockMode', bottomDockMode), [bottomDockMode]);
  useEffect(() => writeStoredValue('activePage', activePage), [activePage]);
  useEffect(() => writeStoredValue('terminalTab', terminalTab), [terminalTab]);
  useEffect(() => writeStoredValue('sidePanelTab', sidePanelTab), [sidePanelTab]);

  useEffect(() => {
    fetchAutoTraderStrategies()
      .then(setAutoStrategies)
      .catch(() => setAutoStrategies([]));
  }, []);

  /*
   * 조회 실패를 `멈춤`으로 바꾸지 않는다.
   *
   * 예전에는 `.catch(() => setAutoTrader(null))`이었고 화면은
   * `autoTrader?.status ?? 'stopped'`를 읽었다. 그래서 상태 조회가 502로
   * 떨어지면 카드가 `멈춤`이라고 적고 시작 버튼까지 켜졌다 — 실제로 돌고
   * 있는데도 멈춘 것으로 보인다. 502를 흉내 내 브라우저에서 재현했다.
   * 예약주문·주문기록이 이미 쓰는 방식대로, 받아 둔 값은 그대로 두고
   * 모른다는 사실을 따로 들고 있는다.
   */
  const refreshAutoTrader = useCallback(() => {
    if (!kisAccountId) return;
    fetchAutoTraderState(kisAccountId)
      .then((state) => {
        setAutoTrader(state);
        setAutoTraderError(null);
      })
      .catch((e) => setAutoTraderError(toErrorMessage(e)));
  }, [kisAccountId]);

  useEffect(() => {
    if (activePage !== 'portfolio') return undefined;
    refreshAutoTrader();
    /*
     * 돌고 있을 때만 주기 조회한다. 멈춰 있으면 기록이 늘지 않으므로
     * 계속 물어볼 이유가 없다.
     */
    if (autoTrader?.status !== 'running') return undefined;
    const timer = window.setInterval(refreshAutoTrader, 10000);
    return () => window.clearInterval(timer);
  }, [activePage, autoTrader?.status, refreshAutoTrader]);

  /*
   * 주문 패널이 실제로 열려 있는지. 매수가능금액·매도가능수량·미체결처럼
   * KIS를 때리는 조회를 여기에 묶는다. 예전엔 전용 화면(`trade`)이 조건이었는데
   * 주문이 종목 화면의 오른쪽 탭으로 들어왔다. 차트만 보는 동안에도 계좌 조회가
   * 나가면 KIS 호출 제한을 그냥 태운다.
   */
  const isOrderPanelOpen = activePage === 'market' && sidePanelTab === 'order';
  useEffect(() => writeStoredValue('activeSavedWatchlistId', activeSavedWatchlistId), [activeSavedWatchlistId]);
  useEffect(() => writeStoredJson('recentInstruments', recentInstruments), [recentInstruments]);
  useEffect(() => writeStoredValue('simulationCash', String(simulationCash)), [simulationCash]);
  useEffect(() => writeStoredJson('simulationPositions', simulationPositions), [simulationPositions]);
  useEffect(() => setHoveredChartReadout(null), [range, selectedInstrument?.id, timeframe]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) return;

      const key = event.key.toLowerCase();
      if (key === 'f') {
        event.preventDefault();
        runChartCommand('fit');
        return;
      }
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        runChartCommand('zoomIn');
        return;
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        runChartCommand('zoomOut');
        return;
      }
      if (key === 'c') {
        event.preventDefault();
        setShowComparePanel((value) => !value);
        return;
      }
      if (key === 'b') {
        event.preventDefault();
        setBottomDockMode((mode) => (mode === 'hidden' ? 'normal' : 'hidden'));
        return;
      }
      if (key === 'w') {
        event.preventDefault();
        setIsWatchlistCollapsed((value) => !value);
        return;
      }
      if (event.key === 'Escape') {
        setIsFocusMode(false);
        setShowComparePanel(false);
        setBottomDockMode((mode) => (mode === 'hidden' ? 'normal' : mode));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!selectedInstrument) return;
    setRecentInstruments((items) => {
      const next = [
        selectedInstrument,
        ...items.filter((instrument) => instrument.id !== selectedInstrument.id),
      ].slice(0, RECENT_INSTRUMENT_LIMIT);
      return next.every((instrument, index) => instrument.id === items[index]?.id) ? items : next;
    });
  }, [selectedInstrument]);

  useEffect(() => {
    fetchWatchlists()
      .then((groups) => {
        setSavedWatchlists(groups);
        if (!groups.some((group) => group.id === activeSavedWatchlistId)) {
          setActiveSavedWatchlistId(groups[0]?.id ?? 'default');
        }
      })
      .catch((e) => setError(toErrorMessage(e)));
  }, [activeSavedWatchlistId]);

  useEffect(() => {
    fetchWatchlistItems(activeSavedWatchlistId)
      .then(setWatchlist)
      .catch((e) => setError(toErrorMessage(e)))
      // 실패해도 표시한다. 아래 첫 종목 고르기가 둘 다 온 뒤에 결정하기 때문이다.
      .finally(() => setIsWatchlistLoaded(true));
  }, [activeSavedWatchlistId]);

  useEffect(() => {
    fetchTerminalInstruments()
      .then(setTerminalItems)
      .catch((e) => setError(toErrorMessage(e)))
      // 실패해도 표시해야 아래에서 관심목록으로 넘어간다.
      .finally(() => setIsTerminalLoaded(true));
  }, []);

  /*
   * 처음 열었을 때 고를 종목.
   *
   * 예전에는 관심목록 fetch와 터미널 fetch가 각자 `current ?? items[0]`으로
   * 같은 자리를 채웠다. 먼저 도착한 쪽이 이기니 매번 같은 종목이 잡힌다는
   * 보장이 없었다. 순서를 여기 한 곳에서 정한다.
   *
   * **주문할 수 있는 종목을 먼저 고른다.** 예전에는 터미널 지표가 우선이라
   * 앱을 열면 `삼성전자 야간 환산가`가 잡혔는데, 이건 GDR 환산 참고가라
   * 주문이 안 되고 값도 실제 삼성전자와 다르다(246,206원 vs 253,000원).
   * 처음 온 사람이 큰 글씨 가격을 보고 사려고 하면 주문 패널이 `주문 대상이
   * 아닙니다`로 맞는다. 지표는 발견 화면과 탐색 탭에 그대로 있다.
   *
   * 두 목록이 **다 온 뒤에** 고른다. 관심목록이 늦게 오면 터미널 지표로
   * 떨어지고, 한 번 정해지면 이 효과는 다시 돌지 않아 그날 내내 그 상태다.
   * (사용자 관점 점검에서 `탭을 옮기니 야간 환산가로 돌아갔다`는 보고가
   * 있었는데 재현되지 않았다. 이 경합이 원인일 수 있으나 확인하지는 못했다.)
   *
   * 사용자가 한 번 고르면 이 효과는 아무것도 하지 않는다.
   */
  useEffect(() => {
    if (selectedInstrument || !isTerminalLoaded || !isWatchlistLoaded) return;
    const candidates = [...watchlist, ...terminalItems];
    const first = candidates.find(isOrderableDomesticInstrument) ?? candidates[0];
    if (first) setSelectedInstrument(first);
  }, [isTerminalLoaded, isWatchlistLoaded, selectedInstrument, terminalItems, watchlist]);

  useEffect(() => {
    fetchInstrumentCategories()
      .then(setCategories)
      .catch((e) => setError(toErrorMessage(e)));
  }, []);

  // 계좌 목록을 먼저 받아 기본 계좌(시세 앱키와 같은 계좌)를 선택해 둔다.
  useEffect(() => {
    fetchKisAccounts()
      .then((accounts) => {
        setKisAccounts(accounts);
        setKisAccountId((current) => current ?? accounts.find((a) => a.primary)?.id ?? accounts[0]?.id ?? null);
      })
      .catch((e) => setError(toErrorMessage(e)));
  }, []);

  const refreshKisAccountSnapshot = useCallback((): void => {
    setIsKisAccountRefreshing(true);
    fetchKisAccountSnapshot(kisAccountId ?? undefined)
      .then(setKisAccountSnapshot)
      .catch((e) => setError(toErrorMessage(e)))
      .finally(() => setIsKisAccountRefreshing(false));
  }, [kisAccountId]);

  useEffect(() => {
    refreshKisAccountSnapshot();
  }, [refreshKisAccountSnapshot]);

  const refreshKisExecutions = useCallback((): void => {
    setIsKisExecutionRefreshing(true);
    fetchKisExecutions(undefined, kisAccountId ?? undefined)
      .then(setKisExecutionSnapshot)
      .catch((e) => setError(toErrorMessage(e)))
      .finally(() => setIsKisExecutionRefreshing(false));
  }, [kisAccountId]);

  /*
   * 체결내역은 포트폴리오를 열 때마다 다시 받는다.
   * 계좌별로 한 번만 받게 두면 실주문을 넣고 돌아와도 옛 목록이 그대로 남아
   * 감사 기록이 사실과 어긋난다. 실계좌 호출 1회보다 최신성이 중요하다.
   */
  useEffect(() => {
    if (activePage !== 'portfolio') return;
    refreshKisExecutions();
  }, [activePage, refreshKisExecutions]);

  // 매수가능금액은 종목·단가에 따라 달라지므로 매수 탭에서 국내 주문 가능 종목일 때만 조회한다.
  useEffect(() => {
    const instrument = selectedInstrument;
    const limitPrice = Number(orderLimitPrice);
    const needsLimitPrice = orderType === 'limit' && (!Number.isFinite(limitPrice) || limitPrice <= 0);
    if (
      !instrument ||
      !isOrderPanelOpen ||
      orderSide !== 'buy' ||
      needsLimitPrice ||
      !isOrderableDomesticInstrument(instrument)
    ) {
      setKisOrderability(null);
      setIsKisOrderabilityLoading(false);
      return;
    }

    let disposed = false;
    setIsKisOrderabilityLoading(true);
    const timer = window.setTimeout(() => {
      fetchKisOrderability(
        instrument.id,
        orderType,
        orderType === 'limit' ? limitPrice : undefined,
        kisAccountId ?? undefined,
      )
        .then((result) => {
          if (!disposed) setKisOrderability(result);
        })
        .catch(() => {
          if (!disposed) setKisOrderability(null);
        })
        .finally(() => {
          if (!disposed) setIsKisOrderabilityLoading(false);
        });
    }, ORDERABILITY_DEBOUNCE_MS);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [isOrderPanelOpen, kisAccountId, orderLimitPrice, orderSide, orderType, selectedInstrument]);

  // 매도가능수량은 종목만 있으면 되지만 매도 탭에서만 의미가 있다.
  useEffect(() => {
    const instrument = selectedInstrument;
    if (!instrument || !isOrderPanelOpen || orderSide !== 'sell' || !isOrderableDomesticInstrument(instrument)) {
      setKisSellability(null);
      setIsKisSellabilityLoading(false);
      return;
    }

    let disposed = false;
    setIsKisSellabilityLoading(true);
    const timer = window.setTimeout(() => {
      fetchKisSellability(instrument.id, kisAccountId ?? undefined)
        .then((result) => {
          if (!disposed) setKisSellability(result);
        })
        .catch(() => {
          if (!disposed) setKisSellability(null);
        })
        .finally(() => {
          if (!disposed) setIsKisSellabilityLoading(false);
        });
    }, ORDERABILITY_DEBOUNCE_MS);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [isOrderPanelOpen, kisAccountId, orderSide, selectedInstrument]);

  /*
   * 실패를 빈 배열로 바꾸지 않는다.
   *
   * 예전에는 `.catch(() => set…([]))`이라 백엔드가 죽으면 화면이
   * `예약주문이 없습니다` · `실계좌 주문 시도 없음` · `아직 체결되지 않은
   * 주문이 없습니다`로 바뀌었다. 못 받아온 것과 없는 것은 전혀 다른데
   * 화면은 후자로 말했다 — 다음 개장일에 나갈 예약주문을 취소된 것으로
   * 읽을 수 있다. 받아 둔 값은 그대로 두고 오류만 띄운다(체결내역이 쓰는 방식).
   */
  const refreshKisOpenOrders = useCallback((): void => {
    setIsKisOpenOrdersRefreshing(true);
    fetchKisOpenOrders(kisAccountId ?? undefined)
      .then((orders) => {
        setKisOpenOrders(orders);
        setKisOpenOrdersUpdatedAt(Date.now());
      })
      .catch((e) => setError(toErrorMessage(e)))
      .finally(() => setIsKisOpenOrdersRefreshing(false));
  }, [kisAccountId]);

  /*
   * 호가는 주문 패널이 열려 있는 동안, 보고 있는 종목 하나만 받는다.
   * 종목당 KIS 호출이 1회 더 늘어나므로 관심목록 전체에는 붙이지 않는다.
   * 3초 간격은 호가가 움직이는 속도와 호출 제한 사이에서 잡은 값이다.
   */
  const ORDER_BOOK_REFRESH_MS = 3_000;
  useEffect(() => {
    const instrument = selectedInstrument;
    if (!isOrderPanelOpen || !instrument || !isOrderableDomesticInstrument(instrument)) {
      setOrderBook(null);
      setOrderBookError(null);
      return undefined;
    }
    let disposed = false;
    const load = (): void => {
      fetchOrderBook(instrument.id)
        .then((book) => {
          if (disposed) return;
          setOrderBook(book);
          setOrderBookError(null);
        })
        .catch((e) => {
          if (disposed) return;
          // 받아 둔 호가는 그대로 두고 사유만 띄운다. 빈 호가로 바꾸면 물량이
          // 없는 것처럼 보인다.
          setOrderBookError(toErrorMessage(e));
        });
    };
    load();
    const timer = window.setInterval(load, ORDER_BOOK_REFRESH_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [isOrderPanelOpen, selectedInstrument]);

  // 미체결 주문은 매매 화면에서 계좌를 바꿀 때마다 다시 받는다.
  useEffect(() => {
    if (!isOrderPanelOpen) return;
    refreshKisOpenOrders();
  }, [isOrderPanelOpen, refreshKisOpenOrders]);

  const refreshKisReservedOrders = useCallback((): void => {
    fetchKisReservedOrders(kisAccountId ?? undefined)
      .then((orders) => {
        setKisReservedOrders(orders);
        setKisReservedOrdersUpdatedAt(Date.now());
      })
      .catch((e) => setError(toErrorMessage(e)));
  }, [kisAccountId]);

  // 예약주문은 포트폴리오에서만 쓴다.
  useEffect(() => {
    if (activePage !== 'portfolio') return;
    refreshKisReservedOrders();
  }, [activePage, refreshKisReservedOrders]);

  // 기간별 매매손익은 포트폴리오에서 계좌·구간별로 받는다.
  useEffect(() => {
    if (activePage !== 'portfolio') return;
    let disposed = false;
    fetchKisTradeProfit(kisAccountId ?? undefined, tradeProfitDays)
      .then((snapshot) => {
        if (!disposed) setKisTradeProfit(snapshot);
      })
      .catch(() => {
        if (!disposed) setKisTradeProfit(null);
      });
    return () => {
      disposed = true;
    };
  }, [activePage, kisAccountId, tradeProfitDays]);

  /*
   * 리스크 룰은 서버 DB 조회라 KIS 호출이 없다. 계좌별로 받는다.
   *
   * 예전엔 포트폴리오 화면에서만 받았다. 그런데 주문 티켓은 종목 화면에 있어서,
   * 주문을 내려는 자리에서는 룰을 손에 쥐고 있지 않았다 — 그래서 시장가가
   * 막혀 있는데도 화면이 그 사실을 모른 채 `주문하기`를 열어 뒀다.
   */
  useEffect(() => {
    if (activePage !== 'portfolio' && !isOrderPanelOpen) return;
    let disposed = false;
    fetchKisRiskRules(kisAccountId ?? undefined)
      .then((rules) => {
        if (disposed) return;
        setRiskRules(rules);
        setRiskDraft(rules);
        setRiskSymbolText({ allow: rules.symbolAllowlist.join(', '), block: rules.symbolBlocklist.join(', ') });
        setRiskMessage(null);
        setRiskRulesError(null);
      })
      // 게이트와 같다 — 못 받은 것을 `불러오는 중`으로 두면 오지 않을 답을 기다린다.
      .catch((e) => {
        if (!disposed) setRiskRulesError(toErrorMessage(e));
      });
    return () => {
      disposed = true;
    };
  }, [activePage, isOrderPanelOpen, kisAccountId]);

  /*
   * 탭이 12개라 좁은 폭에서는 가로로 스크롤된다. 스크롤 위치는 0으로 돌아오는데
   * 선택 탭이 오른쪽 끝에 있으면 화면 밖이라 지금 어느 탭인지 알 수 없다.
   * 페이지 안에서만 움직이도록 스트립 자체의 스크롤만 옮긴다.
   */
  useEffect(() => {
    if (activePage !== 'terminal') return;
    const strip = terminalTabsRef.current;
    const selected = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!strip || !selected) return;
    // 사용자가 굴린 스크롤이 아니라 위치 보정이라 애니메이션을 쓰지 않는다.
    // behavior:'smooth'는 탭이 백그라운드일 때 아예 동작하지 않아 보정이 조용히 실패한다.
    const target = selected.offsetLeft - (strip.clientWidth - selected.offsetWidth) / 2;
    strip.scrollLeft = Math.max(0, target);
  }, [activePage, terminalTab]);

  const refreshKisOrderLog = useCallback((): void => {
    fetchKisOrderLog(kisAccountId ?? undefined)
      .then((result) => {
        setKisOrderLog(result.records);
        setKisOrderLogHasMore(result.hasMore);
        setKisOrderLogUpdatedAt(Date.now());
      })
      .catch((e) => setError(toErrorMessage(e)));
  }, [kisAccountId]);

  // 주문 로그는 DB 조회라 KIS 호출이 없다. 매매·포트폴리오 양쪽에서 본다.
  useEffect(() => {
    if (activePage !== 'portfolio' && !isOrderPanelOpen) return;
    refreshKisOrderLog();
  }, [activePage, isOrderPanelOpen, refreshKisOrderLog]);

  /*
   * 실주문 게이트는 서버 설정이라 KIS 호출이 없다.
   * 서버를 KIS_LIVE_ORDER_ENABLED와 함께 재시작해도 화면이 옛 상태로 남지 않도록
   * 화면을 옮길 때마다 다시 확인한다.
   *
   * 예전엔 매매 화면에서만 조회했다. 게이트 상태를 알리는 배지가 헤더로
   * 올라와 모든 화면에 보이므로, 첫 진입에도 조회해야 터미널·차트에서
   * `게이트 확인 중`에 머물지 않는다.
   */
  useEffect(() => {
    fetchKisLiveOrderGate()
      .then((gate) => {
        setLiveOrderGate(gate);
        setLiveOrderGateError(null);
      })
      /*
       * 받아 둔 값은 지우지 않는다. 지우면 `확인 중`으로 되돌아가 실패가
       * 로딩처럼 보인다 — 실제로 조회가 깨진 뒤 헤더·주문 패널·차단 사유
       * 세 곳이 오지 않을 답을 기다리는 문구로 굳어 있었다.
       */
      .catch((e) => setLiveOrderGateError(toErrorMessage(e)));
  }, [activePage]);

  useEffect(() => {
    let disposed = false;
    const refresh = (): void => {
      void fetchUsdKrwExchangeRate()
        .then((rate) => {
          if (!disposed) setUsdKrwRate(rate);
        })
        .catch(() => {
          if (!disposed) setUsdKrwRate(null);
        });
    };
    refresh();
    const timer = window.setInterval(refresh, FX_REFRESH_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const q = discoverQuery.trim();
    const serverQuery = q.length >= 2 ? q : '';
    let disposed = false;
    const timer = window.setTimeout(() => {
      fetchCategoryInstruments(activeCategory, serverQuery)
        .then((items) => {
          if (!disposed) setCategoryItems(items);
        })
        .catch((e) => {
          if (!disposed) setError(toErrorMessage(e));
        });
    }, serverQuery ? 180 : 0);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [activeCategory, discoverQuery]);

  useEffect(() => {
    setVisibleCategoryQuoteIds([]);
  }, [activeCategory, discoverQuery]);

  // 선택 종목의 일봉 로드 (한 번 받은 종목은 캐시)
  useEffect(() => {
    if (!selectedInstrument || candlesByCode[selectedInstrument.id]) return;
    fetchInstrumentCandles(selectedInstrument.id)
      .then((res) => setCandlesByCode((m) => ({ ...m, [selectedInstrument.id]: res })))
      .catch((e) => setError(toErrorMessage(e)));
  }, [selectedInstrument, candlesByCode]);

  // 선택 종목의 현재가 스냅샷. 실시간 체결이 오기 전 가격 헤더를 채운다.
  useEffect(() => {
    if (!selectedInstrument) return;
    fetchInstrumentQuote(selectedInstrument.id)
      .then((res) => setQuotesByCode((m) => ({ ...m, [selectedInstrument.id]: res })))
      .catch((e) => setError(toErrorMessage(e)));
  }, [selectedInstrument]);

  // 해외 실시간 WS는 별도 TR이라, 우선 선택 해외 종목은 짧은 폴링으로 차트와 헤더를 갱신한다.
  useEffect(() => {
    if (!selectedInstrument || selectedInstrument.country === 'KR') return;
    const refresh = (): void => {
      void fetchInstrumentQuote(selectedInstrument.id)
        .then((res) => setQuotesByCode((m) => ({ ...m, [selectedInstrument.id]: res })))
        .catch((e) => setError(toErrorMessage(e)));
      void fetchInstrumentCandles(selectedInstrument.id)
        .then((res) => setCandlesByCode((m) => ({ ...m, [selectedInstrument.id]: res })))
        .catch((e) => setError(toErrorMessage(e)));
    };
    const timer = window.setInterval(refresh, OVERSEAS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [selectedInstrument]);

  useEffect(() => {
    const q = symbolQuery.trim();
    if (q.length < 2) {
      setSymbolResults([]);
      setActiveSymbolResultIndex(0);
      setIsSymbolSearching(false);
      setHasSymbolSearchCompleted(false);
      return;
    }
    setIsSymbolSearching(true);
    setHasSymbolSearchCompleted(false);
    setSymbolResults([]);
    setActiveSymbolResultIndex(0);
    let disposed = false;
    const timer = window.setTimeout(() => {
      searchInstruments(q)
        .then((items) => {
          if (disposed) return;
          setSymbolResults(items);
          setActiveSymbolResultIndex(0);
          setHasSymbolSearchCompleted(true);
        })
        .catch((e) => {
          if (!disposed) setError(toErrorMessage(e));
        })
        .finally(() => {
          if (!disposed) setIsSymbolSearching(false);
        });
    }, 200);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
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
          if (!disposed) setError(toErrorMessage(e));
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
    const shouldLoadNews = activePage === 'terminal' || bottomDockTab === 'news';
    if (!selectedInstrument || !shouldLoadNews || newsByCode[selectedInstrument.id]) return;
    fetchInstrumentNews(selectedInstrument.id)
      .then((items) => setNewsByCode((current) => ({ ...current, [selectedInstrument.id]: items })))
      .catch((e) => setError(toErrorMessage(e)));
  }, [activePage, bottomDockTab, newsByCode, selectedInstrument]);

  const discoverFilteredCategoryItems = useMemo(() => {
    const q = discoverQuery.trim().toLowerCase();
    if (!q) return categoryItems;
    return categoryItems.filter(
      (instrument) =>
        instrument.name.toLowerCase().includes(q) ||
        instrument.symbol.toLowerCase().includes(q) ||
        (instrument.englishName?.toLowerCase().includes(q) ?? false),
    );
  }, [categoryItems, discoverQuery]);

  const quoteTargetIds = useMemo(() => {
    const ids = new Set<string>();
    const selectedOverseasId = selectedInstrument?.country !== 'KR' ? selectedInstrument?.id : undefined;

    function addId(id: string): void {
      if (id === selectedOverseasId) return;
      ids.add(id);
    }

    function add(instrument: Instrument): void {
      addId(instrument.id);
    }

    if (selectedInstrument?.country === 'KR') add(selectedInstrument);
    if (activePage === 'terminal') {
      for (const instrument of terminalItems) add(instrument);
      /*
       * 히트맵 12종목. 그 탭이 열려 있을 때만 넣는다 — 발견 화면에 머무는
       * 동안 계속 12건을 더 부르면 KIS 조회 한도를 그만큼 빨리 쓴다.
       */
      /* 히트맵과 테마 보드가 같은 12종목을 쓴다. 둘 중 하나가 열려 있을 때만 부른다. */
      if (terminalTab === 'heatmap' || terminalTab === 'themes') {
        for (const id of HEATMAP_INSTRUMENT_IDS) addId(id);
      }
    }
    for (const instrument of recentInstruments) add(instrument);
    for (const instrument of watchlist) add(instrument);
    if (sidePanelTab === 'discover') {
      for (const instrument of discoverFilteredCategoryItems.slice(0, DISCOVER_INITIAL_QUOTE_TARGETS)) {
        add(instrument);
      }
      for (const id of visibleCategoryQuoteIds) addId(id);
    }
    for (const instrument of symbolResults.slice(0, SEARCH_QUOTE_TARGETS)) add(instrument);
    return [...ids];
  }, [
    discoverFilteredCategoryItems,
    activePage,
    recentInstruments,
    selectedInstrument,
    sidePanelTab,
    symbolResults,
    terminalItems,
    terminalTab,
    visibleCategoryQuoteIds,
    watchlist,
  ]);
  const quoteTargetKey = quoteTargetIds.join('|');
  const refreshVisibleQuotes = useCallback(
    (respectVisibility = true, shouldApply: () => boolean = () => true): void => {
      if (quoteTargetIds.length === 0 || (respectVisibility && document.hidden)) return;
      setIsQuoteRefreshing(true);
      void (async () => {
        try {
          for (let index = 0; index < quoteTargetIds.length; index += LIST_QUOTE_REQUEST_CHUNK_SIZE) {
            if (!shouldApply()) return;
            const chunk = quoteTargetIds.slice(index, index + LIST_QUOTE_REQUEST_CHUNK_SIZE);
            const quotes = await fetchInstrumentQuotes(chunk);
            if (!shouldApply()) return;
            setQuotesByCode((items) => {
              const next = { ...items };
              for (const quote of quotes) next[quote.code] = quote;
              return next;
            });
            setQuoteRefreshAt(Date.now());
          }
        } catch (e) {
          if (shouldApply()) setError(toErrorMessage(e));
        } finally {
          setIsQuoteRefreshing(false);
        }
      })();
    },
    [quoteTargetKey],
  );

  // 화면에 보이는 종목들의 조회 현재가를 유지해 클릭 전에도 리스트 가격이 채워지게 한다.
  useEffect(() => {
    if (quoteTargetIds.length === 0) return;

    let disposed = false;
    const refresh = (): void => {
      if (disposed) return;
      refreshVisibleQuotes(true, () => !disposed);
    };

    refresh();
    const timer = window.setInterval(refresh, LIST_QUOTE_REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [quoteTargetIds.length, quoteTargetKey, refreshVisibleQuotes]);

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
    () => {
      if (timeframe === '1D') return visibleCandles;
      if (selectedInstrument?.assetType === 'commodity' && selectedIntradayCandles.length === 0) return visibleCandles;
      return aggregateCandles(selectedIntradayCandles, activeTimeframe.minutes ?? 1);
    },
    [activeTimeframe.minutes, timeframe, selectedInstrument?.assetType, selectedIntradayCandles, visibleCandles],
  );
  const volumeSummary = useMemo(() => {
    const candlesWithVolume = chartCandles.filter((candle) => Number.isFinite(candle.volume ?? NaN));
    const total = candlesWithVolume.reduce((sum, candle) => sum + (candle.volume ?? 0), 0);
    const upVolume = candlesWithVolume.reduce(
      (sum, candle) => sum + (candle.close > candle.open ? candle.volume ?? 0 : 0),
      0,
    );
    const downVolume = candlesWithVolume.reduce(
      (sum, candle) => sum + (candle.close < candle.open ? candle.volume ?? 0 : 0),
      0,
    );
    const flatVolume = Math.max(0, total - upVolume - downVolume);
    const max = candlesWithVolume.reduce<Candle | undefined>(
      (winner, candle) => (!winner || (candle.volume ?? 0) > (winner.volume ?? 0) ? candle : winner),
      undefined,
    );
    return {
      count: candlesWithVolume.length,
      total,
      average: candlesWithVolume.length ? total / candlesWithVolume.length : undefined,
      upVolume,
      downVolume,
      flatVolume,
      max,
    };
  }, [chartCandles]);
  const volumeUpRatio = volumeSummary.total > 0 ? (volumeSummary.upVolume / volumeSummary.total) * 100 : 0;
  const volumeDownRatio = volumeSummary.total > 0 ? (volumeSummary.downVolume / volumeSummary.total) * 100 : 0;
  const chartMovingAverages = useMemo(
    () => ({
      ma5: movingAverageLatest(chartCandles, 5),
      ma20: movingAverageLatest(chartCandles, 20),
    }),
    [chartCandles],
  );
  const selectedName = selectedInstrument?.name ?? '';
  const selectedQuote = selectedInstrument ? quotesByCode[selectedInstrument.id] : undefined;
  const snapshot = toSnapshot(selectedTrade, selectedQuote);
  const selectedColor = signColor(snapshot?.sign);
  const selectedTone = moveTone(snapshot?.sign);
  const selectedCurrency = selectedInstrument?.currency ?? 'KRW';
  const selectedKrwConversion = formatConvertedKrw(snapshot?.price, selectedInstrument?.currency, usdKrwRate);
  const realtimeChartLabel = realtimeChartStatusLabel(selectedInstrument, selectedTrade);
  const activeToolOption = TOOL_OPTIONS.find((tool) => tool.key === activeTool) ?? TOOL_OPTIONS[1];
  const quoteLagMs = quoteRefreshAt ? Math.max(0, nowMs - quoteRefreshAt) : null;
  const quoteFreshnessTone = quoteLagMs === null ? 'waiting' : quoteLagMs > QUOTE_STALE_MS ? 'stale' : 'fresh';
  const quoteFreshnessLabel = quoteLagMs === null ? '갱신 대기' : `갱신 ${formatElapsed(quoteLagMs)}`;
  const latestTradeMs = tradeTimestampMs(stream.recentTrades[0]);
  const tradeLagMs = latestTradeMs ? Math.max(0, nowMs - latestTradeMs) : null;
  const tradeFreshnessTone =
    tradeLagMs === null ? 'waiting' : tradeLagMs > TRADE_STALE_MS ? 'stale' : 'fresh';
  /*
   * 체결이 없을 때 `체결 대기`라고만 두면 장이 닫힌 주말·야간에도 곧 들어올
   * 것처럼 읽힌다. 헤더에서 장 상태를 알려주는 곳이 여기밖에 없기도 해서,
   * 닫혀 있으면 사유를 그대로 띄운다.
   */
  const selectedSessionClosedLabel = closedSessionLabel(selectedInstrument);
  const tradeFreshnessLabel =
    tradeLagMs === null
      ? selectedSessionClosedLabel ?? '체결 대기'
      : `체결 ${formatElapsed(tradeLagMs)}`;
  const tradeFreshnessTitle =
    tradeLagMs === null
      ? selectedSessionClosedLabel
        ? `장이 닫혀 있어 체결이 들어오지 않습니다 (${getMarketSession(selectedInstrument).hours})`
        : '아직 체결이 들어오지 않았습니다'
      : `마지막 체결 ${formatClock(latestTradeMs as number)}`;
  const quoteFreshnessTitle = quoteRefreshAt
    ? `마지막 갱신 ${formatClock(quoteRefreshAt)}`
    : '아직 시세를 조회하지 않았습니다';

  /*
   * 이전에는 `조회 전용`이 하드코딩이라 게이트가 열려도 그대로였다. 매매 앱에서
   * 상단 배지가 사실과 어긋나면 안 된다. 게이트가 열린 쪽이 위험한 상태이므로
   * 경고 색은 그쪽에 준다(styles.css의 data-armed).
   *
   * 문구는 `주문 가능` / `주문 잠김` / `확인 중` 세 개로 고정한다. 같은
   * liveOrderGate.enabled를 헤더는 `조회 전용`, 하단 도크는 `조회 전용 세션`,
   * 주문 패널은 `전송 잠김`이라고 불러 한 화면에 세 이름이 떠 있었다.
   */
  const liveOrderArmed = liveOrderGate?.enabled === true;
  const modeChipState = liveOrderGate ? (liveOrderArmed ? 'true' : 'false') : 'unknown';
  /*
   * 게이트를 모르는 상태는 두 가지다 — 아직 안 왔거나, 조회가 실패했거나.
   * 한 마디를 여기서 만들어 헤더·하단 도크·주문 패널이 같이 쓴다. 예전에는
   * 세 곳이 각자 `!liveOrderGate ? '확인 중'`이라 실패해도 셋 다 기다리는
   * 문구를 계속 띄웠다.
   */
  const gateUnknownLabel = liveOrderGateError ? '확인 실패' : '확인 중';
  /*
   * 자동매매 상태도 같은 두 가지로 모른다. 게이트와 같은 말을 쓴다.
   *
   * 받아 둔 값이 있어도 마지막 조회가 실패했으면 `아는` 것이 아니다. 2초 전
   * 값으로 `멈춤`이라고 단정하면, 그 사이 돌기 시작한 경우를 멈춘 것으로
   * 읽는다. 성공하면 error가 지워지므로 일시적 실패는 저절로 낫는다.
   */
  const autoTraderUnknownLabel = autoTraderError ? '확인 실패' : '확인 중';
  const isAutoTraderKnown = autoTrader !== null && autoTraderError === null;
  const modeChipLabel = !liveOrderGate
    ? gateUnknownLabel
    : liveOrderArmed
      ? `주문 가능 · ${liveOrderGate.isProdEnv ? '실전 서버' : '모의 서버'}`
      : '주문 잠김';
  /* 하단 도크용. 헤더 배지와 달리 환경 표기는 빼고 짧게 쓴다. */
  const sessionModeLabel = !liveOrderGate
    ? gateUnknownLabel
    : liveOrderArmed
      ? '주문 가능'
      : '주문 잠김';
  const modeChipTitle = !liveOrderGate
    ? (liveOrderGateError
        ? `실주문을 보낼 수 있는지 확인하지 못했습니다 — ${liveOrderGateError}`
        : '실주문을 보낼 수 있는지 확인하는 중입니다')
    : liveOrderArmed
      ? `실주문이 열려 있습니다 · ${liveOrderGate.isProdEnv ? 'KIS 실전 서버' : 'KIS 모의 서버'}`
      : `실주문 차단됨 — ${liveOrderGate.blockers.join(' / ')}`;
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
  const activeChartReadoutStats = activeChartReadout
    ? {
        change: activeChartReadout.close - activeChartReadout.open,
        changeRate:
          activeChartReadout.open !== 0
            ? ((activeChartReadout.close - activeChartReadout.open) / activeChartReadout.open) * 100
            : 0,
        range: activeChartReadout.high - activeChartReadout.low,
        rangeRate:
          activeChartReadout.low !== 0
            ? ((activeChartReadout.high - activeChartReadout.low) / activeChartReadout.low) * 100
            : 0,
        tone:
          activeChartReadout.close > activeChartReadout.open
            ? 'up'
            : activeChartReadout.close < activeChartReadout.open
              ? 'down'
              : 'flat',
      }
    : null;

  useEffect(() => {
    if (!selectedInstrument || !snapshot) {
      selectedPriceRef.current = {};
      setIsSelectedPriceFlashing(false);
      return;
    }

    const previous = selectedPriceRef.current;
    if (previous.id !== selectedInstrument.id) {
      selectedPriceRef.current = { id: selectedInstrument.id, price: snapshot.price };
      setIsSelectedPriceFlashing(false);
      return;
    }

    if (previous.price !== undefined && previous.price !== snapshot.price) {
      setIsSelectedPriceFlashing(true);
      const timer = window.setTimeout(() => setIsSelectedPriceFlashing(false), 420);
      selectedPriceRef.current = { id: selectedInstrument.id, price: snapshot.price };
      return () => window.clearTimeout(timer);
    }

    selectedPriceRef.current = { id: selectedInstrument.id, price: snapshot.price };
  }, [selectedInstrument?.id, snapshot?.price]);
  const marketSession = useMemo(() => getMarketSession(selectedInstrument), [quoteRefreshAt, selectedInstrument]);
  const previousClose = snapshot ? snapshot.price - snapshot.change : undefined;
  const dayRangePosition = snapshot ? getRangePosition(snapshot.price, snapshot.low, snapshot.high) : null;
  const openChange = snapshot ? snapshot.price - snapshot.open : undefined;
  const openChangeRate =
    snapshot && snapshot.open !== 0 && openChange !== undefined ? (openChange / snapshot.open) * 100 : undefined;
  const watchedIds = useMemo(() => new Set(watchlist.map((item) => item.id)), [watchlist]);
  const bottomPanelClass = `bottom-panel bottom-panel--${bottomDockMode}`;
  /*
   * 종목 바로가기 줄에 넣을 목록. 최근 본 것이 먼저 오고, 비교를 켜면 관심종목이
   * 뒤에 이어 붙는다. 중복은 여기서 걸러 같은 종목이 두 번 나오지 않게 한다.
   */
  const chipInstruments = useMemo(() => {
    const seen = new Set<string>();
    const list: Instrument[] = [];
    const add = (instrument: Instrument): void => {
      if (seen.has(instrument.id)) return;
      seen.add(instrument.id);
      list.push(instrument);
    };
    for (const instrument of recentInstruments) add(instrument);
    if (showComparePanel) for (const instrument of watchlist) add(instrument);
    return list.slice(0, 10);
  }, [recentInstruments, showComparePanel, watchlist]);

  const layoutStateBadges = useMemo(() => {
    const badges: string[] = [];
    if (isFocusMode) badges.push('집중');
    if (isWatchlistCollapsed && !isFocusMode) badges.push('관심 접힘');
    if (bottomDockMode === 'hidden') badges.push('하단 숨김');
    if (bottomDockMode === 'expanded') badges.push('하단 확장');
    if (showComparePanel) badges.push('관심 함께');
    return badges;
  }, [bottomDockMode, isFocusMode, isWatchlistCollapsed, showComparePanel]);
  const chartOverlayBadges = useMemo(() => {
    const badges: string[] = [];
    if (showMovingAverage) badges.push('MA');
    if (showRsi) badges.push('RSI');
    if (showPriceLevels) badges.push('레벨');
    return badges;
  }, [showMovingAverage, showPriceLevels, showRsi]);
  const getSnapshotForInstrument = (instrument: Instrument): PriceSnapshot | undefined =>
    toSnapshot(
      instrument.country === 'KR' ? stream.trades[instrument.providerSymbol] : undefined,
      quotesByCode[instrument.id],
    );
  const terminalInstrumentById = useMemo(
    () => new Map(terminalItems.map((instrument) => [instrument.id, instrument])),
    [terminalItems],
  );
  /*
   * 히트맵에 올릴 값. 등락률은 시세에서 가져온다.
   * 아직 안 온 종목은 숫자를 만들지 않고 비운 채로 둔다 — 예전에는 여기에
   * 지어낸 값이 박혀 있었고, 색까지 입혀 진짜처럼 보였다.
   */
  const heatmapRows = useMemo(
    () =>
      HEATMAP_ITEMS.map((item) => {
        const snapshot = toSnapshot(undefined, quotesByCode[`KR:KOSPI:${item.symbol}`]);
        return { ...item, changeRate: snapshot?.changeRate };
      }),
    [quotesByCode],
  );

  const macroBoardGroups = useMemo(
    () =>
      MACRO_BOARD_GROUPS.map((group) => ({
        ...group,
        items: group.items
          .filter((item) => macroFilter === 'all' || item.filter === macroFilter)
          .map((item) => {
            const instrument = item.instrumentId ? terminalInstrumentById.get(item.instrumentId) : undefined;
            const itemSnapshot = instrument ? getSnapshotForInstrument(instrument) : undefined;
            const exchangeRate = item.key === 'usdkrw' ? usdKrwRate : undefined;
            return { ...item, instrument, snapshot: itemSnapshot, exchangeRate };
          }),
      })).filter((group) => group.items.length > 0),
    [macroFilter, quotesByCode, stream.trades, terminalInstrumentById, usdKrwRate],
  );
  /*
   * `다가오는 일정 N건` 라벨에만 쓴다. 목록은 calendarEvents가 그린다.
   * 여기 `.slice(0, 6)`이 붙어 있어서 8건이 남아도 라벨이 6건에서 멈췄다 —
   * 세는 값에 상한을 걸면 개수가 개수가 아니게 된다.
   */
  const upcomingEvents = useMemo(
    () =>
      ECONOMIC_EVENTS.filter((event) => new Date(`${event.date}T23:59:59+09:00`).getTime() >= nowMs)
        .filter((event) => calendarRegionFilter === 'all' || event.scope === calendarRegionFilter)
        .filter((event) => calendarImpactFilter === 'all' || event.impact === calendarImpactFilter),
    [calendarImpactFilter, calendarRegionFilter, nowMs],
  );
  const calendarEvents = useMemo(
    () =>
      ECONOMIC_EVENTS.filter((event) => calendarRegionFilter === 'all' || event.scope === calendarRegionFilter)
        .filter((event) => calendarImpactFilter === 'all' || event.impact === calendarImpactFilter),
    [calendarImpactFilter, calendarRegionFilter],
  );
  /*
   * 테마 등락률 = 구성 종목 등락률의 평균. 한 종목이라도 시세가 안 왔으면
   * 평균을 내지 않는다 — 반쪽만으로 낸 값을 테마 등락률이라 부를 수 없다.
   */
  const themeRows = useMemo(
    () =>
      THEME_FLOW_ITEMS.map((item) => {
        const rates = item.symbols.map(
          (symbol) => toSnapshot(undefined, quotesByCode[`KR:KOSPI:${symbol}`])?.changeRate,
        );
        const ready = rates.every((rate) => rate !== undefined);
        return {
          ...item,
          changeRate: ready
            ? (rates as number[]).reduce((sum, rate) => sum + rate, 0) / rates.length
            : undefined,
        };
      }),
    [quotesByCode],
  );

  /** 가장 많이 오른 테마. 시세가 없으면 고르지 않는다. */
  const themeTop = useMemo(() => {
    const measured = themeRows.filter((item) => item.changeRate !== undefined);
    if (measured.length === 0) return undefined;
    return measured.reduce((best, item) =>
      (item.changeRate as number) > (best.changeRate as number) ? item : best,
    );
  }, [themeRows]);

  /** 가장 많이 내린 테마. 상위만 보여주면 오른 쪽만 눈에 남는다. */
  const themeBottom = useMemo(() => {
    const measured = themeRows.filter((item) => item.changeRate !== undefined);
    if (measured.length === 0) return undefined;
    return measured.reduce((worst, item) =>
      (item.changeRate as number) < (worst.changeRate as number) ? item : worst,
    );
  }, [themeRows]);

  const themeBreadth = useMemo(() => {
    const measured = themeRows.filter((item) => item.changeRate !== undefined);
    return {
      up: measured.filter((item) => (item.changeRate as number) > 0).length,
      down: measured.filter((item) => (item.changeRate as number) < 0).length,
      measured: measured.length,
      total: themeRows.length,
    };
  }, [themeRows]);
  const marketCountdown = useMemo(() => getKoreanMarketCountdown(nowMs), [nowMs]);
  const moversBoard = useMemo(() => {
    const seen = new Set<string>();
    const candidates = [...terminalItems, ...recentInstruments, ...watchlist, ...categoryItems].filter((instrument) => {
      if (seen.has(instrument.id)) return false;
      seen.add(instrument.id);
      return true;
    });

    const scored = candidates.map((instrument) => ({
      instrument,
      snapshot: getSnapshotForInstrument(instrument),
    }));

    /*
     * 시세가 없는 종목은 순위에서 뺀다. 예전에는 정렬 키가
     * `Math.abs(b.snapshot?.changeRate ?? 0)`이라 값이 없는 쪽이 전부 0으로 묶여
     * 배열에 꽂힌 순서대로 #2~#10을 받았다. 휴장이면 열 중 아홉이 그 상태라
     * "삼성전자 9위" 같은 줄이 나오는데, 순위가 아니라 그냥 자리였다.
     */
    const ranked = scored
      .filter((item): item is { instrument: Instrument; snapshot: PriceSnapshot } => Boolean(item.snapshot))
      .sort((a, b) => Math.abs(b.snapshot.changeRate) - Math.abs(a.snapshot.changeRate))
      .slice(0, 10);

    return { ranked, pending: scored.filter((item) => !item.snapshot) };
  }, [categoryItems, quotesByCode, recentInstruments, stream.trades, terminalItems, watchlist]);
  /*
   * 종목 요약.
   *
   * 예전에는 `마법공식 82 · 그레이엄 76 · DCF 69 · 다모다란 71`이었다. 이름은
   * 실제 가치평가 방법인데 계산은 그 방법이 아니었다 — 넷 다
   * `고정 기본값 + 거래량항 - 등락률항 - 순번`이라 같은 값에 상수만 달랐고
   * 순서가 절대 바뀌지 않았다. 재무제표가 없으면 그 모델들은 계산할 수 없다.
   *
   * 지금 가진 것으로 계산되는 값만 둔다. 막대 길이도 실제 비율이 있는 값
   * (당일 범위 위치)에만 준다 — 등락률·거래량은 0~100 스케일이 아니다.
   */
  const selectedReportRows = useMemo(() => {
    if (!snapshot) return [];
    const rangePosition = getRangePosition(snapshot.price, snapshot.low, snapshot.high);
    return [
      {
        key: 'changeRate',
        label: '전일 대비',
        value: formatRate(snapshot.changeRate),
        detail: `전일 종가 대비 ${formatSignedCurrencyPrice(snapshot.change, selectedCurrency)}`,
        bar: undefined,
      },
      {
        key: 'range',
        label: '당일 범위 위치',
        value: rangePosition === null ? '-' : `${Math.round(rangePosition)}%`,
        detail:
          rangePosition === null
            ? '고가와 저가가 같아 위치를 낼 수 없습니다'
            : `저가 ${formatCurrencyPrice(snapshot.low, selectedCurrency)} · 고가 ${formatCurrencyPrice(snapshot.high, selectedCurrency)}`,
        bar: rangePosition ?? undefined,
      },
      {
        key: 'volume',
        label: '누적 거래량',
        value: formatVolume(snapshot.accVolume),
        detail: '오늘 지금까지 체결된 수량',
        bar: undefined,
      },
    ];
  }, [selectedCurrency, snapshot]);
  const feeAmountNumber = parseAmountInput(feeAmount, 1_000_000);
  const feeExpectedReturnNumber = Number(feeExpectedReturn);
  const feeMarketOption = FEE_MARKET_OPTIONS.find((option) => option.key === feeMarket) ?? FEE_MARKET_OPTIONS[0];
  const feeRows = useMemo(() => {
    const returnRate = Number.isFinite(feeExpectedReturnNumber) ? feeExpectedReturnNumber / 100 : 0;
    const grossSellAmount = feeAmountNumber * (1 + returnRate);
    const isDerivative = feeMarket === 'kospi200_future' || feeMarket === 'kospi200_option';
    return FEE_BROKERS.filter((broker) => !isDerivative || broker.supportsDerivatives).map((broker) => {
      /*
       * 국내 주식 요율에 곱하는 배수. 어디서 온 값인지 기록이 없다 — 해외주식과
       * 옵션은 요율 체계가 아예 달라서 국내 요율에 배수를 곱하는 것 자체가
       * 근사다. 화면에도 그렇게 적는다.
       */
      const marketMultiplier = feeMarket === 'us_stock' ? 10 : feeMarket === 'kospi200_option' ? 1.4 : 1;
      const buyCommission = feeAmountNumber * broker.commissionRate * marketMultiplier;
      const sellCommission = grossSellAmount * broker.commissionRate * marketMultiplier;
      const institutionFee = (feeAmountNumber + grossSellAmount) * broker.institutionRate;
      const transactionTax = grossSellAmount * feeMarketOption.taxRate;
      const totalFee = buyCommission + sellCommission + institutionFee + transactionTax;
      const netPnl = grossSellAmount - feeAmountNumber - totalFee;
      return { broker, totalFee, netPnl };
    }).sort((a, b) => a.totalFee - b.totalFee);
  }, [feeAmountNumber, feeExpectedReturnNumber, feeMarket, feeMarketOption.taxRate]);
  const bestFeeRow = feeRows[0];
  const worstFeeRow = feeRows[feeRows.length - 1];
  const simulationQuantityNumber = Number(simulationQuantity);
  const simulationMarketValue = useMemo(
    () =>
      simulationPositions.reduce((total, position) => {
        const instrument =
          [...terminalItems, ...recentInstruments, ...watchlist, ...categoryItems].find(
            (item) => item.id === position.instrumentId,
          );
        const positionSnapshot = instrument ? getSnapshotForInstrument(instrument) : undefined;
        return total + position.quantity * (positionSnapshot?.price ?? position.averagePrice);
      }, 0),
    [categoryItems, quotesByCode, recentInstruments, simulationPositions, stream.trades, terminalItems, watchlist],
  );
  const simulationCostBasis = simulationPositions.reduce(
    (total, position) => total + position.quantity * position.averagePrice,
    0,
  );
  const simulationEquity = simulationCash + simulationMarketValue;
  const simulationPnl = simulationEquity - SIMULATION_SEED_CASH;
  const simulationSelectedPosition = selectedInstrument
    ? simulationPositions.find((position) => position.instrumentId === selectedInstrument.id)
    : undefined;
  const watchlistSummary = useMemo(
    () => summarizeInstrumentMoves(watchlist, getSnapshotForInstrument),
    [quotesByCode, stream.trades, watchlist],
  );
  const watchlistBreadthTotal = watchlistSummary.up + watchlistSummary.down + watchlistSummary.flat;
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
  /*
   * 지금 걸린 조건만 모은다. 기본값(`전체`, `기본순`)은 넣지 않는다 — 바로 위
   * 버튼줄에 강조로 이미 보이는 데다, 아무것도 안 걸었는데 `전체 · 기본순`이
   * 떠 있으면 뭔가 걸린 것처럼 읽힌다.
   */
  const watchFilterChips = useMemo(() => {
    const groupLabel = WATCH_GROUP_OPTIONS.find((option) => option.key === watchGroup)?.label;
    const moveLabel = MOVE_FILTER_OPTIONS.find((option) => option.key === moveFilter)?.label;
    const sortLabel = WATCH_SORT_OPTIONS.find((option) => option.key === watchSort)?.label;
    return [
      watchGroup === 'all' ? undefined : groupLabel,
      moveFilter === 'all' ? undefined : moveLabel,
      watchSort === 'custom' ? undefined : sortLabel,
      query.trim() ? `검색 ${query.trim()}` : undefined,
      isCompactList ? '촘촘' : undefined,
    ].filter((item): item is string => Boolean(item));
  }, [isCompactList, moveFilter, query, watchGroup, watchSort]);
  const activeSavedWatchlist = savedWatchlists.find((group) => group.id === activeSavedWatchlistId);
  const visibleCategoryItems = useMemo(
    () =>
      sortBySnapshot(
        filterByMove(discoverFilteredCategoryItems, moveFilter, getSnapshotForInstrument),
        watchSort === 'custom' ? 'rate' : watchSort,
        getSnapshotForInstrument,
      ),
    [discoverFilteredCategoryItems, moveFilter, quotesByCode, stream.trades, watchSort],
  );

  useEffect(() => {
    if (sidePanelTab !== 'discover') {
      setVisibleCategoryQuoteIds([]);
      return undefined;
    }

    const root = discoverRowsRef.current;
    if (!root) return undefined;

    const visibleIds = new Set<string>();
    let frame = 0;

    const publish = (): void => {
      frame = 0;
      const orderedIds = visibleCategoryItems
        .filter((instrument) => visibleIds.has(instrument.id))
        .map((instrument) => instrument.id);
      setVisibleCategoryQuoteIds((current) => (areStringArraysEqual(current, orderedIds) ? current : orderedIds));
    };

    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.discoverInstrumentId;
          if (!id) continue;
          if (entry.isIntersecting) {
            if (!visibleIds.has(id)) {
              visibleIds.add(id);
              changed = true;
            }
            continue;
          }
          if (visibleIds.delete(id)) changed = true;
        }
        if (changed && frame === 0) frame = window.requestAnimationFrame(publish);
      },
      { root, rootMargin: '320px 0px', threshold: 0 },
    );

    const rows = root.querySelectorAll<HTMLElement>('[data-discover-instrument-id]');
    rows.forEach((row) => observer.observe(row));

    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [sidePanelTab, visibleCategoryItems]);

  const categorySummary = useMemo(
    () => summarizeInstrumentMoves(visibleCategoryItems, getSnapshotForInstrument),
    [quotesByCode, stream.trades, visibleCategoryItems],
  );
  const categoryQuoteProgress = useMemo(() => {
    const requestedIds = new Set([
      ...discoverFilteredCategoryItems.slice(0, DISCOVER_INITIAL_QUOTE_TARGETS).map((instrument) => instrument.id),
      ...visibleCategoryQuoteIds,
    ]);
    return {
      loaded: visibleCategoryItems.filter((instrument) => getSnapshotForInstrument(instrument)).length,
      requested: visibleCategoryItems.filter((instrument) => requestedIds.has(instrument.id)).length,
      total: visibleCategoryItems.length,
    };
  }, [discoverFilteredCategoryItems, quotesByCode, stream.trades, visibleCategoryItems, visibleCategoryQuoteIds]);
  /*
   * 탐색 목록 위에 적을 한 마디.
   *
   * `시세 0/7`만 적으면 휴장 중에는 영원히 0이라 멈춘 진행률처럼 보인다. 지금
   * 행들은 값 자리에 `-`만 있고 사유가 없어서, 이 줄이 유일한 설명이다.
   * 보이는 종목이 전부 장이 닫혀 있으면 진행률 대신 그 사실을 적는다.
   */
  const discoverQuoteNote = useMemo((): string | null => {
    if (isQuoteRefreshing) return '갱신 중';
    const { loaded, total } = categoryQuoteProgress;
    if (total === 0 || loaded >= total) return null;
    const allClosed = visibleCategoryItems.every((instrument) => closedSessionLabel(instrument));
    return allClosed ? '장이 닫혀 시세가 없습니다' : `시세 ${loaded}/${total}`;
  }, [categoryQuoteProgress, isQuoteRefreshing, visibleCategoryItems]);
  const realtimeSubscriptionInstruments = useMemo(() => {
    const instruments = new Map<string, ClientSubscribeInstrument>();
    const visibleIds = new Set(visibleCategoryQuoteIds);

    function add(instrument: Instrument | null | undefined): void {
      if (!instrument || instrument.country !== 'KR') return;
      if (!/^[0-9A-Z]{6,9}$/.test(instrument.providerSymbol)) return;
      instruments.set(instrument.providerSymbol, {
        code: instrument.providerSymbol,
        market: instrument.market,
        assetType: instrument.assetType,
      });
    }

    add(selectedInstrument);
    if (activePage === 'terminal') {
      for (const instrument of terminalItems) add(instrument);
    }
    for (const instrument of recentInstruments) add(instrument);
    for (const instrument of watchlist) add(instrument);
    if (sidePanelTab === 'discover') {
      for (const instrument of discoverFilteredCategoryItems.slice(0, DISCOVER_INITIAL_QUOTE_TARGETS)) add(instrument);
      for (const instrument of visibleCategoryItems) {
        if (visibleIds.has(instrument.id)) add(instrument);
      }
    }

    return [...instruments.values()];
  }, [
    discoverFilteredCategoryItems,
    activePage,
    recentInstruments,
    selectedInstrument,
    sidePanelTab,
    terminalItems,
    visibleCategoryItems,
    visibleCategoryQuoteIds,
    watchlist,
  ]);
  const realtimeSubscriptionKey = realtimeSubscriptionInstruments
    .map((instrument) => `${instrument.assetType}:${instrument.market}:${instrument.code}`)
    .join('|');

  useEffect(() => {
    stream.subscribe(realtimeSubscriptionInstruments);
  }, [realtimeSubscriptionKey, realtimeSubscriptionInstruments, stream.subscribe]);

  const tapeTrades = useMemo(
    () =>
      selectedInstrument?.country === 'KR'
        ? stream.recentTrades.filter((trade) => trade.code === selectedInstrument.providerSymbol).slice(0, 16)
        : stream.recentTrades.slice(0, 16),
    [selectedInstrument, stream.recentTrades],
  );
  const tapeSummary = useMemo(() => {
    const summary = { up: 0, down: 0, flat: 0 };
    for (const trade of tapeTrades) {
      const tone = moveTone(trade.sign);
      if (tone === 'up') summary.up += 1;
      else if (tone === 'down') summary.down += 1;
      else summary.flat += 1;
    }
    return summary;
  }, [tapeTrades]);
  const instrumentNameByProviderSymbol = useMemo(() => {
    const names = new Map<string, string>();
    for (const instrument of [...watchlist, ...categoryItems]) {
      names.set(instrument.providerSymbol, instrument.name);
    }
    if (selectedInstrument) names.set(selectedInstrument.providerSymbol, selectedInstrument.name);
    return names;
  }, [categoryItems, selectedInstrument, watchlist]);
  const selectedNews = selectedInstrument ? (newsByCode[selectedInstrument.id] ?? []) : [];
  const terminalNewsCards = useMemo(() => {
    const cards = selectedNews.slice(0, 12).map(terminalNewsCardFromItem);
    return cards.length > 0 ? cards : FALLBACK_TERMINAL_NEWS;
  }, [selectedNews]);
  /*
   * 종목 뉴스를 못 찾으면 시장 주제 검색 링크로 대신한다. 그 사실을 화면이
   * 말하지 않으면 머리글의 `자동 큐레이션 · 4건 · 삼성전자 야간 환산가`가
   * 그 종목 뉴스 4건으로 읽힌다. 실제로는 어느 종목에서든 같은 링크 네 개다.
   * 폴백 배열을 그대로 돌려주므로 참조로 구별할 수 있다.
   */
  const isTerminalNewsFallback = terminalNewsCards === FALLBACK_TERMINAL_NEWS;
  const filteredTerminalNews = useMemo(
    () =>
      newsFilter === 'all'
        ? terminalNewsCards
        : terminalNewsCards.filter((item) => item.filters.includes(newsFilter)),
    [newsFilter, terminalNewsCards],
  );
  const selectedSourceLinks = useMemo(() => dataSourceLinksForInstrument(selectedInstrument), [selectedInstrument]);
  const selectedTopicNewsUrl = selectedInstrument ? topicNewsUrl(selectedInstrument.name) : topicNewsUrl('코스피 야간선물 원자재');
  const newsSummary = useMemo(() => {
    const sources = new Map<string, number>();
    let latestPublishedAt = 0;

    for (const item of selectedNews) {
      sources.set(item.source, (sources.get(item.source) ?? 0) + 1);
      if (item.publishedAt && item.publishedAt > latestPublishedAt) latestPublishedAt = item.publishedAt;
    }

    const topSource = [...sources.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      latestPublishedAt: latestPublishedAt || undefined,
      sourceCount: sources.size,
      topSourceName: topSource?.[0],
      topSourceCount: topSource?.[1] ?? 0,
    };
  }, [selectedNews]);
  const trimmedSymbolQuery = symbolQuery.trim();
  const isSymbolSearchPanelOpen =
    trimmedSymbolQuery.length >= 2 && (symbolResults.length > 0 || isSymbolSearching || hasSymbolSearchCompleted);
  const symbolSearchSummary = useMemo(
    () => summarizeInstrumentMoves(symbolResults, getSnapshotForInstrument),
    [quotesByCode, stream.trades, symbolResults],
  );
  const symbolSearchBreadthTotal =
    symbolSearchSummary.up + symbolSearchSummary.down + symbolSearchSummary.flat;
  const activeSymbolResultId =
    isSymbolSearchPanelOpen && symbolResults[activeSymbolResultIndex]
      ? `symbol-search-result-${activeSymbolResultIndex}`
      : undefined;
  const bottomDockTabLabel =
    bottomDockTab === 'volume' ? '거래량' : bottomDockTab === 'trades' ? '체결' : '뉴스';
  const bottomDockModeLabel =
    BOTTOM_DOCK_MODE_OPTIONS.find((option) => option.key === bottomDockMode)?.label ?? bottomDockMode;
  const orderQuantityNumber = Number(orderQuantity);

  /*
   * 지금 낼 수 있는 최대 수량. 매수는 실계좌 현금 기준, 매도는 보유 기준이다.
   * 토스증권도 매수 가능 금액과 판매 가능 수량을 따로 주는데, 우리는 그 값을
   * 받아 놓고 화면에 숫자로만 적어 둬서 몇 주인지는 사람이 계산해야 했다.
   */
  const maxOrderQuantity = useMemo(() => {
    if (orderSide === 'sell') return kisSellability?.sellableQuantity;
    return kisOrderability?.cashBuyQuantity;
  }, [kisOrderability, kisSellability, orderSide]);
  const orderLimitPriceNumber = Number(orderLimitPrice);
  const orderEstimatedPrice = snapshot?.price;
  const orderEffectivePrice =
    orderType === 'limit' && Number.isFinite(orderLimitPriceNumber) && orderLimitPriceNumber > 0
      ? orderLimitPriceNumber
      : orderEstimatedPrice;
  const orderEstimatedNotional =
    Number.isFinite(orderQuantityNumber) && orderEffectivePrice !== undefined
      ? orderQuantityNumber * orderEffectivePrice
      : undefined;
  /*
   * 비용은 국내 원화 종목에만 어림한다. 해외주식은 요율 체계가 아예 달라서
   * 국내 값을 갖다 대면 틀린 숫자를 보여 주게 된다 — 그럴 바엔 안 보여 준다.
   */
  const orderCost = useMemo(
    () =>
      selectedInstrument && isOrderableDomesticInstrument(selectedInstrument)
        ? estimateOrderCost(orderEstimatedNotional ?? 0, orderSide, selectedInstrument.market)
        : null,
    [orderEstimatedNotional, orderSide, selectedInstrument],
  );
  const orderEffectivePriceKrw = formatConvertedKrw(orderEffectivePrice, selectedInstrument?.currency, usdKrwRate);
  const orderEstimatedNotionalKrw = formatConvertedKrw(
    orderEstimatedNotional,
    selectedInstrument?.currency,
    usdKrwRate,
  );
  // 실계좌 한도는 paper 주문을 막지 않는다. 실주문 게이트를 대비한 참고 경고로만 노출한다.
  const orderLiveNotices = useMemo(() => {
    const notices: string[] = [];
    if (orderSide === 'buy') {
      if (!kisOrderability?.configured || orderEstimatedNotional === undefined) return notices;
      if (kisOrderability.cashBuyAmount !== undefined && orderEstimatedNotional > kisOrderability.cashBuyAmount) {
        /*
         * 위 칸의 이름(`실계좌 매수가능`)을 그대로 쓴다 — 같은 숫자를
         * `미수 없는 매수금액`이라 부르고 있어 다른 값처럼 읽혔고, `미수`는
         * 초보자가 모르는 말이다. 금액은 괄호로 뺀다. 통화에 따라 끝 글자가
         * 달라져(`원`/`$…`) 조사를 붙이면 틀린다 — 실제로 `49,751원를`였다.
         */
        notices.push(
          `실계좌 매수가능 금액을 초과합니다 (${formatMoney(kisOrderability.cashBuyAmount, kisOrderability.currency)}).`,
        );
      }
      if (kisOrderability.cashBuyQuantity !== undefined && orderQuantityNumber > kisOrderability.cashBuyQuantity) {
        // 0주일 때 `최대 0주까지 매수할 수 있습니다`가 되어 살 수 있다는 말처럼 읽혔다.
        notices.push(
          kisOrderability.cashBuyQuantity > 0
            ? `실계좌 기준 최대 ${formatNumber(kisOrderability.cashBuyQuantity)}주까지 매수할 수 있습니다.`
            : '실계좌 예수금으로는 1주도 살 수 없습니다.',
        );
      }
      return notices;
    }

    if (!kisSellability?.configured) return notices;
    const sellable = kisSellability.sellableQuantity;
    if (sellable !== undefined && orderQuantityNumber > sellable) {
      // 매수 쪽 `최대 0주까지…`와 같은 문제. 0이면 사실만 적지 말고 못 판다고 적는다.
      notices.push(
        sellable > 0
          ? `실계좌 매도가능수량은 ${formatNumber(sellable)}주입니다.`
          : '실계좌에 보유한 수량이 없어 매도할 수 없습니다.',
      );
    }
    return notices;
  }, [kisOrderability, kisSellability, orderEstimatedNotional, orderQuantityNumber, orderSide]);
  /**
   * 실주문 전송 조건. 서버 게이트와 같은 항목을 프런트에서도 막는다.
   * paper 주문 확인 체크(`orderAcknowledged`)와는 무관하다.
   */
  const liveOrderBlockers = useMemo(() => {
    const blockers: string[] = [...(liveOrderGate?.blockers ?? [])];
    if (!liveOrderGate) {
      blockers.push(
        liveOrderGateError
          ? `실주문을 보낼 수 있는지 확인하지 못했습니다. 확인 전에는 주문이 나가지 않습니다 (${liveOrderGateError})`
          : '실주문을 보낼 수 있는지 확인하는 중입니다.',
      );
    }
    if (!isOrderableDomesticInstrument(selectedInstrument)) blockers.push('국내 주식·ETF·ETN만 주문할 수 있습니다.');
    if (!Number.isFinite(orderQuantityNumber) || orderQuantityNumber <= 0) blockers.push('수량은 0보다 커야 합니다.');
    if (orderType === 'limit' && (!Number.isFinite(orderLimitPriceNumber) || orderLimitPriceNumber <= 0)) {
      blockers.push('지정가 주문은 단가가 필요합니다.');
    }

    /*
     * 리스크 룰도 여기서 미리 본다.
     *
     * 예전에는 자동매매 패널만 룰을 검사했고 수동 주문 티켓은 보지 않았다.
     * 그래서 시장가가 막혀 있고 허용 종목이 005930뿐인데도 SK하이닉스 시장가
     * 주문에 `매수 주문하기`가 열려 있었고, 확인 화면은 `확인하면 그대로
     * 접수됩니다`라고 말했다. 눌러서 서버가 거절해야 알았다.
     */
    blockers.push(
      ...riskRuleBlockers({
        rules: riskRules,
        error: riskRulesError,
        symbol: selectedInstrument?.providerSymbol,
        orderType,
        quantity: orderQuantityNumber,
        // 시장가는 단가가 없으므로 서버와 같이 현재가로 금액을 어림한다.
        price: orderType === 'limit' ? orderLimitPriceNumber : (snapshot?.price ?? 0),
      }),
    );
    return blockers;
  }, [
    liveOrderGate,
    liveOrderGateError,
    orderLimitPriceNumber,
    orderQuantityNumber,
    orderType,
    riskRules,
    riskRulesError,
    selectedInstrument,
    snapshot?.price,
  ]);
  const liveOrderCanSubmit = liveOrderBlockers.length === 0 && !isLiveOrderSubmitting;

  /*
   * 정정·취소가 막힌 사유.
   *
   * 게이트만 본다. **리스크 룰은 일부러 보지 않는다** — 서버도 이 경로에서는
   * checkRiskRules를 부르지 않는다(server.ts의 amend 라우트는 게이트만 본다).
   * 이유가 있다. 취소는 위험을 줄이는 동작인데 `허용 종목이 아닙니다`로 막으면,
   * 룰을 좁힌 뒤에 남아 있는 주문을 영영 못 거둔다. 같은 결함처럼 보인다고
   * 수동 주문·예약주문과 똑같이 맞추면 안 되는 자리다.
   *
   * 예전에는 이 버튼들이 게이트가 닫혀 있어도 그냥 눌렸다. 눌러야 403을 들었다.
   */
  const amendCancelBlockers = useMemo(() => {
    const blockers: string[] = [...(liveOrderGate?.blockers ?? [])];
    if (!liveOrderGate) {
      blockers.push(
        liveOrderGateError
          ? `실주문을 보낼 수 있는지 확인하지 못했습니다 (${liveOrderGateError})`
          : '실주문을 보낼 수 있는지 확인하는 중입니다.',
      );
    }
    return blockers;
  }, [liveOrderGate, liveOrderGateError]);
  const amendCancelBlockedReason = amendCancelBlockers.join('\n') || undefined;

  /** 예약주문 등록 버튼이 잠긴 이유. 화면에 그대로 보여준다. */
  const reservedOrderBlockers = useMemo(() => {
    /*
     * 예약주문도 실주문이다. 그런데 여기는 게이트도 리스크 룰도 보지 않고
     * 수량·단가만 봤다 — 서버는 둘 다 검사하는데(server.ts의 예약주문 등록
     * 라우트가 evaluateLiveOrderGate와 checkRiskRules를 부른다) 화면만 몰랐다.
     * 수동 주문 티켓과 같은 결함이 한 자리 더 있었다.
     *
     * 거래 시간은 빼고 본다. 예약주문은 장 밖에서 내는 것이라 서버도
     * `skipSessionCheck: true`로 부른다.
     */
    const blockers: string[] = [...(liveOrderGate?.blockers ?? [])];
    if (!liveOrderGate) {
      blockers.push(
        liveOrderGateError
          ? `실주문을 보낼 수 있는지 확인하지 못했습니다 (${liveOrderGateError})`
          : '실주문을 보낼 수 있는지 확인하는 중입니다.',
      );
    }
    if (!selectedInstrument) blockers.push('차트에서 종목을 먼저 선택하세요.');
    else if (!isOrderableDomesticInstrument(selectedInstrument)) {
      blockers.push('국내 주식·ETF·ETN만 예약주문할 수 있습니다.');
    }
    const quantity = Number(reservedQuantity);
    const price = Number(reservedPrice);
    if (!Number.isFinite(quantity) || quantity <= 0) blockers.push('수량은 0보다 커야 합니다.');
    if (!Number.isFinite(price) || price <= 0) blockers.push('지정가를 입력하세요.');
    blockers.push(
      ...riskRuleBlockers({
        rules: riskRules,
        error: riskRulesError,
        symbol: selectedInstrument?.providerSymbol,
        // 예약주문은 지정가만 받는다.
        orderType: 'limit',
        quantity,
        price,
      }),
    );
    return blockers;
  }, [
    liveOrderGate,
    liveOrderGateError,
    reservedPrice,
    reservedQuantity,
    riskRules,
    riskRulesError,
    selectedInstrument,
  ]);
  const kisAccountPositionCount = kisAccountSnapshot?.positions.length ?? 0;
  const kisExecutionCount = kisExecutionSnapshot?.executions.length ?? 0;
  const kisOpenExecutionCount =
    kisExecutionSnapshot?.executions.filter(
      (execution) => execution.status === 'open' || execution.status === 'partial',
    ).length ?? 0;
  const kisAccountPnlTone =
    kisAccountSnapshot?.unrealizedPnl === undefined
      ? 'flat'
      : kisAccountSnapshot.unrealizedPnl > 0
        ? 'up'
        : kisAccountSnapshot.unrealizedPnl < 0
          ? 'down'
          : 'flat';

  function selectInstrument(instrument: Instrument): void {
    setSelectedInstrument(instrument);
    if (isRealtimeChartInstrument(instrument)) {
      setActivePage('market');
      setTimeframe('1');
      setBottomDockTab('trades');
      if (bottomDockMode === 'hidden') setBottomDockMode('normal');
    }
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
        .catch((e) => setError(toErrorMessage(e)));
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
      .catch((e) => setError(toErrorMessage(e)));
  }

  function createSavedWatchlist(): void {
    const name = window.prompt('새 관심그룹 이름');
    if (!name?.trim()) return;
    createWatchlist(name.trim())
      .then((group) => {
        setSavedWatchlists((groups) => [...groups, group]);
        setActiveSavedWatchlistId(group.id);
      })
      .catch((e) => setError(toErrorMessage(e)));
  }

  function deleteSavedWatchlist(id: string): void {
    if (id === 'default') return;
    deleteWatchlist(id)
      .then(() => {
        setSavedWatchlists((groups) => groups.filter((group) => group.id !== id));
        if (activeSavedWatchlistId === id) setActiveSavedWatchlistId('default');
      })
      .catch((e) => setError(toErrorMessage(e)));
  }

  function runChartCommand(type: ChartCommandType): void {
    setChartCommand({ type, nonce: Date.now() });
  }

  function selectBottomDockTab(tab: BottomDockTab): void {
    setBottomDockTab(tab);
    if (bottomDockMode === 'hidden') setBottomDockMode('normal');
  }

  function applyLayoutPreset(preset: LayoutPreset): void {
    setLayoutPreset(preset);

    if (preset === 'chart') {
      setIsFocusMode(true);
      setIsWatchlistCollapsed(true);
      setBottomDockMode('hidden');
      setShowComparePanel(false);
      return;
    }

    if (preset === 'reading') {
      setIsFocusMode(false);
      setIsWatchlistCollapsed(false);
      setBottomDockMode('expanded');
      setShowComparePanel(true);
      return;
    }

    setIsFocusMode(false);
    setIsWatchlistCollapsed(false);
    setBottomDockMode('normal');
    setShowComparePanel(false);
  }

  /**
   * 실계좌 주문 전송. paper 주문과 완전히 다른 경로다.
   * 게이트는 서버가 최종 판정하고, 여기서는 같은 조건을 먼저 걸러 오발주를 줄인다.
   */
  async function submitLiveOrder(): Promise<void> {
    if (!selectedInstrument || !kisAccountId || !liveOrderCanSubmit) return;
    setIsLiveOrderSubmitting(true);
    setLiveOrderMessage(null);
    try {
      const result = await placeKisLiveOrder({
        accountId: kisAccountId,
        instrumentId: selectedInstrument.id,
        side: orderSide,
        orderType,
        quantity: orderQuantityNumber,
        limitPrice: orderType === 'limit' ? orderLimitPriceNumber : undefined,
        clientOrderId: liveOrderKey ?? undefined,
      });
      setLiveOrderMessage(
        `접수됨 · 주문번호 ${result.orderNo || '-'} (지점 ${result.orderBranchNo || '-'}) · ${result.message}`,
      );
      // 접수 직후 확인 단계를 닫고 키도 버린다. 다음 주문은 새 키로 나간다.
      setLiveOrderConfirming(false);
      setLiveOrderKey(null);
      refreshKisOpenOrders();
      refreshKisOrderLog();
      refreshKisAccountSnapshot();
      refreshKisExecutions();
    } catch (e) {
      setLiveOrderMessage(String(e instanceof Error ? e.message : e));
    } finally {
      setIsLiveOrderSubmitting(false);
    }
  }

  /*
   * 자동매매가 지금 설정으로 실제로 주문을 낼 수 있는지.
   *
   * 러너를 시작해도 매 회차 "후보 없음"이나 "차단"만 쌓이는 경우가 있다.
   * 그 이유는 리스크 룰에 있는데 화면이 다른 카드라 연결짓기 어렵다.
   * 시작 버튼 옆에서 바로 보이게 한다.
   */
  /**
   * 차단 사유에서 그 설정 칸으로 데려간다. 스크롤과 포커스를 함께 준다 —
   * 포커스만 주면 카드가 화면 밖일 때 보이지 않는 곳으로 커서가 간다.
   *
   * `behavior: 'smooth'`는 쓰지 않는다. 이 페이지의 스크롤 컨테이너
   * (`.chart-panel--portfolio`)에서는 아예 움직이지 않았다 — 브라우저 설정이나
   * CSS scroll-behavior 문제가 아니라(둘 다 기본값) 그냥 안 먹었다.
   * 즉시 스크롤은 scrollTop 0 → 1021로 정상 동작한다.
   */
  const focusRiskField = useCallback((fieldId: string): void => {
    const field = document.getElementById(fieldId);
    if (!field) return;
    field.scrollIntoView({ block: 'center' });
    field.focus({ preventScroll: true });
  }, []);

  const selectedAutoStrategy = autoStrategies.find((item) => item.key === autoStrategy);

  const autoTraderBlockers = useMemo(() => {
    /*
     * `아래에서 허용하세요`라고만 적었더니 갈 곳을 찾아야 했다. 리스크 룰
     * 카드는 534px 아래라 화면 밖이고, 그 안에 필드가 열 개다. 어느 칸인지
     * 이름으로 말하고, 바로 그 칸으로 데려갈 수 있게 id를 함께 넘긴다.
     */
    const blockers: Array<{ text: string; fieldId?: string }> = [];
    if (!riskRules) return blockers;
    if (!riskRules.enabled) {
      blockers.push({
        text: '이 계좌의 실주문이 꺼져 있습니다. 아래 리스크 룰의 `이 계좌 실주문 허용`을 켜세요.',
        fieldId: 'risk-enabled',
      });
    }
    if (!riskRules.allowMarketOrder) {
      blockers.push({
        text:
          '시장가 주문이 막혀 있습니다. 자동매매는 신호가 난 값에 붙어야 해서 시장가로 냅니다 —'
          + ' 아래 리스크 룰의 `시장가 주문 허용`을 켜세요.',
        fieldId: 'risk-allow-market-order',
      });
    }
    if (riskRules.symbolAllowlist.length > 0) {
      blockers.push({
        // 종목코드 뒤에 `로`를 붙이면 끝자리에 따라 틀린다 — `005930로`가 그랬다.
        text:
          `허용 종목이 좁혀져 있습니다 (${riskRules.symbolAllowlist.join(', ')}).`
          + ' 종목을 알고리즘이 고르게 하려면 아래 리스크 룰의 `허용 종목` 칸을 비우세요.',
        fieldId: 'risk-symbol-allowlist',
      });
    }
    if (autoMode === 'live' && liveOrderGate && !liveOrderGate.enabled) {
      // 게이트는 서버 설정이라 화면에서 갈 곳이 없다. 사유만 그대로 옮긴다.
      blockers.push(...liveOrderGate.blockers.map((text) => ({ text })));
    }
    return blockers;
  }, [autoMode, liveOrderGate, riskRules]);

  async function submitAutoTraderStart(): Promise<void> {
    if (!kisAccountId) return;
    setIsAutoSubmitting(true);
    setAutoMessage(null);
    try {
      const state = await startAutoTrader({
        accountId: kisAccountId,
        mode: autoMode,
        strategy: autoStrategy,
        targetEquity: Number(autoTarget),
        stopEquity: Number(autoStop),
        intervalSeconds: 60,
        maxPositions: 1,
      });
      setAutoTrader(state);
    } catch (e) {
      setAutoMessage(toErrorMessage(e));
    } finally {
      setIsAutoSubmitting(false);
    }
  }

  async function submitAutoTraderStop(): Promise<void> {
    if (!kisAccountId) return;
    setIsAutoSubmitting(true);
    setAutoMessage(null);
    try {
      setAutoTrader(await stopAutoTrader(kisAccountId));
    } catch (e) {
      setAutoMessage(toErrorMessage(e));
    } finally {
      setIsAutoSubmitting(false);
    }
  }

  /** 쉼표로 구분된 종목코드 입력을 배열로. 서버가 다시 정규화하므로 여기선 느슨하게 자른다. */
  function parseSymbolText(text: string): string[] {
    return text
      .split(/[,\s]+/)
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean);
  }

  async function saveRiskRules(): Promise<void> {
    if (!riskDraft) return;
    setIsRiskSaving(true);
    setRiskMessage(null);
    try {
      const saved = await updateKisRiskRules(
        {
          ...riskDraft,
          symbolAllowlist: parseSymbolText(riskSymbolText.allow),
          symbolBlocklist: parseSymbolText(riskSymbolText.block),
        },
        kisAccountId ?? undefined,
      );
      setRiskRules(saved);
      setRiskDraft(saved);
      setRiskSymbolText({ allow: saved.symbolAllowlist.join(', '), block: saved.symbolBlocklist.join(', ') });
      setRiskMessage('저장했습니다.');
    } catch (e) {
      setRiskMessage(String(e instanceof Error ? e.message : e));
    } finally {
      setIsRiskSaving(false);
    }
  }

  async function submitReservedOrder(): Promise<void> {
    if (!selectedInstrument) return;
    const quantity = Number(reservedQuantity);
    const limitPrice = Number(reservedPrice);
    if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(limitPrice) || limitPrice <= 0) {
      setReservedCancelMessage('수량과 지정가를 확인하세요.');
      return;
    }

    setIsReservedCancelling(true);
    setReservedCancelMessage(null);
    try {
      const result = await placeKisReservedOrder({
        accountId: kisAccountId ?? '',
        instrumentId: selectedInstrument.id,
        side: reservedSide,
        quantity,
        limitPrice,
      });
      // 목록 조회가 못 잡아도 취소하려면 순번이 필요하다. 응답값을 화면에 남긴다.
      setReservedCancelMessage(
        `등록됨 · 예약주문순번 ${result.reservationSeq || '(응답에 없음)'} · ${result.message}` +
          ' — 이 순번을 메모해 두세요. 취소에 필요합니다.',
      );
      refreshKisReservedOrders();
      refreshKisOrderLog();
    } catch (e) {
      setReservedCancelMessage(String(e instanceof Error ? e.message : e));
    } finally {
      setIsReservedCancelling(false);
    }
  }

  async function cancelReservedOrder(order: BrokerReservedOrder): Promise<void> {
    setIsReservedCancelling(true);
    setReservedCancelMessage(null);
    try {
      const result = await cancelKisReservedOrder({
        accountId: kisAccountId ?? '',
        reservationSeq: order.reservationSeq,
        reservationOrderDate: order.orderDate,
      });
      setReservedCancelMessage(
        result.processed
          ? `취소됨 · ${result.message}`
          : `접수됐지만 정상처리 여부가 확인되지 않았습니다 · ${result.message}`,
      );
      refreshKisReservedOrders();
      refreshKisOrderLog();
    } catch (e) {
      setReservedCancelMessage(
        `${String(e instanceof Error ? e.message : e)} — 실패하면 KIS 앱에서 직접 취소하세요.`,
      );
    } finally {
      setIsReservedCancelling(false);
    }
  }

  async function submitAmendOrCancel(order: BrokerAmendableOrder, action: 'amend' | 'cancel'): Promise<void> {
    const newPrice = Number(amendPrice);
    if (action === 'amend' && (!Number.isFinite(newPrice) || newPrice <= 0)) {
      setLiveOrderMessage('정정할 새 단가를 입력하세요.');
      return;
    }

    setIsLiveOrderSubmitting(true);
    setLiveOrderMessage(null);
    try {
      const result = await amendKisLiveOrder({
        accountId: kisAccountId ?? '',
        action,
        orderNo: order.orderNo,
        orderBranchNo: order.orderBranchNo,
        orderTypeCode: order.orderTypeCode,
        limitPrice: action === 'amend' ? newPrice : undefined,
        quantityAll: true,
      });
      setLiveOrderMessage(`${action === 'amend' ? '정정' : '취소'} 접수됨 · ${result.message}`);
      setAmendingOrderId(null);
      setAmendPrice('');
      refreshKisOpenOrders();
      refreshKisOrderLog();
    } catch (e) {
      setLiveOrderMessage(String(e instanceof Error ? e.message : e));
    } finally {
      setIsLiveOrderSubmitting(false);
    }
  }

  function submitSimulationOrder(side: OrderSide): void {
    if (!selectedInstrument || !snapshot) {
      setError('모의 주문할 종목과 현재가를 먼저 확인하세요.');
      return;
    }
    if (!Number.isFinite(simulationQuantityNumber) || simulationQuantityNumber <= 0) {
      setError('수량은 0보다 커야 합니다.');
      return;
    }

    const notional = simulationQuantityNumber * snapshot.price;
    if (side === 'buy') {
      if (notional > simulationCash) {
        setError('모의계좌 현금이 부족합니다.');
        return;
      }
      setSimulationCash((cash) => cash - notional);
      setSimulationPositions((positions) => {
        const existing = positions.find((position) => position.instrumentId === selectedInstrument.id);
        if (!existing) {
          return [
            ...positions,
            {
              instrumentId: selectedInstrument.id,
              symbol: selectedInstrument.symbol,
              name: selectedInstrument.name,
              quantity: simulationQuantityNumber,
              averagePrice: snapshot.price,
            },
          ];
        }
        return positions.map((position) => {
          if (position.instrumentId !== selectedInstrument.id) return position;
          const nextQuantity = position.quantity + simulationQuantityNumber;
          const nextAveragePrice =
            (position.averagePrice * position.quantity + notional) / nextQuantity;
          return { ...position, quantity: nextQuantity, averagePrice: nextAveragePrice };
        });
      });
      return;
    }

    if (!simulationSelectedPosition || simulationSelectedPosition.quantity < simulationQuantityNumber) {
      setError('모의계좌 보유 수량이 부족합니다.');
      return;
    }
    setSimulationCash((cash) => cash + notional);
    setSimulationPositions((positions) =>
      positions
        .map((position) =>
          position.instrumentId === selectedInstrument.id
            ? { ...position, quantity: position.quantity - simulationQuantityNumber }
            : position,
        )
        .filter((position) => position.quantity > 0),
    );
  }

  return (
    <div className={`app${isFocusMode ? ' is-focus-mode' : ''}`}>
      {/*
        키보드로 주문 폼까지 가려면 Tab을 45번 눌러야 했다 — 헤더, 검색,
        차트 도구(커서·십자선·추세선…), 지표, 기간, 프리셋을 전부 지난 뒤에야
        오른쪽 패널이 나온다. 마우스로는 바로 누르니 보이지 않던 거리다.
        첫 Tab에서 이 링크가 뜨고, 누르면 패널로 건너뛴다.
        평소에는 화면에서 안 보이지만 DOM에는 있어 낭독기도 읽는다.
      */}
      {activePage === 'market' && (
        <a className="skip-link" href="#side-panel">
          주문·관심 패널로 건너뛰기
        </a>
      )}
      <header className="app__header">
        <div>
          <span className="app__eyebrow">실시간 차트 · 뉴스 · 출처 터미널</span>
          <h1>KidChang-Charts</h1>
        </div>
        <nav className="app__nav" aria-label="주요 화면">
          {APP_PAGE_OPTIONS.map((page) => (
            <button
              aria-current={activePage === page.key ? 'page' : undefined}
              key={page.key}
              onClick={() => setActivePage(page.key)}
              title={page.title}
              type="button"
            >
              {page.label}
            </button>
          ))}
        </nav>
        <div className="app__status">
          <span className="mode-chip" data-armed={modeChipState} title={modeChipTitle}>
            {modeChipLabel}
          </span>
          {/* 환율은 상태가 아니라 데이터다. 신선도 배지와 같은 급으로 보이면 위계가 뭉개진다. */}
          <span
            className="freshness-chip"
            data-kind="data"
            data-tone={usdKrwRate ? 'fresh' : 'waiting'}
            title={usdKrwRate ? `갱신 ${formatClock(usdKrwRate.fetchedAt)}` : '환율 시세 대기'}
          >
            USD/KRW {usdKrwRate ? formatExchangeRate(usdKrwRate.rate) : '대기'}
          </span>
          <span className="freshness-chip" data-tone={quoteFreshnessTone} title={quoteFreshnessTitle}>
            {quoteFreshnessLabel}
          </span>
          <span className="freshness-chip" data-tone={tradeFreshnessTone} title={tradeFreshnessTitle}>
            {tradeFreshnessLabel}
          </span>
          {/*
            화면에 `새로고침`이라고만 적힌 버튼이 한 화면에 다섯 개까지 뜬다
            (시세·잔고·체결 내역·주문 기록·예약주문). 눈으로는 어느 카드 안에
            있는지로 구별되지만, 낭독기로 버튼만 훑으면 `새로고침` 다섯 번이라
            무엇을 새로 부르는 건지 알 수 없다. 무엇을 새로 부르는지 이름에 적는다.
          */}
          <button
            aria-label={isQuoteRefreshing ? '시세 불러오는 중' : '시세 새로고침'}
            className="status-refresh"
            disabled={quoteTargetIds.length === 0 || isQuoteRefreshing}
            onClick={() => refreshVisibleQuotes(false)}
            title="보이는 종목 시세 즉시 갱신"
            type="button"
          >
            {isQuoteRefreshing ? '불러오는 중' : '새로고침'}
          </button>
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

      {error && (
        <div className="app__error" role="alert">
          <span>{error}</span>
          <button aria-label="오류 닫기" onClick={() => setError(null)} type="button">
            닫기
          </button>
        </div>
      )}

      <div className={`app__body app__body--${activePage}`}>
        <main className={`chart-panel chart-panel--${activePage}`}>
          {activePage !== 'portfolio' ? (
          <div className="chart-commandbar">
            {/*
              여기 있던 종목명·국가·시장 표기를 뺐다. 90px 아래 시세 헤더가 같은
              것을 더 크게, 가격 옆에서 보여주고 있어 같은 말이 두 번 나왔다.
              시장 표기(`KOSPI · KRW`)는 다른 데가 없어 시세 헤더로 옮겼다.
              화면 상태 배지는 정체성이 아니라 도구 쪽 정보라 여기 남긴다.
            */}
            <div className="chart-commandbar__symbol">
              {layoutStateBadges.length > 0 && (
                <div className="layout-state" aria-label="화면 상태">
                  {layoutStateBadges.map((badge) => (
                    <em key={badge}>{badge}</em>
                  ))}
                </div>
              )}
            </div>
            <div className="symbol-search">
              <input
                aria-activedescendant={activeSymbolResultId}
                aria-autocomplete="list"
                aria-controls={isSymbolSearchPanelOpen ? 'symbol-search-results' : undefined}
                aria-expanded={isSymbolSearchPanelOpen}
                aria-label="국내/해외 종목 검색"
                onChange={(event) => setSymbolQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    setSymbolResults([]);
                    setActiveSymbolResultIndex(0);
                    setHasSymbolSearchCompleted(false);
                    return;
                  }
                  if (symbolResults.length === 0) return;
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setActiveSymbolResultIndex((index) => (index + 1) % symbolResults.length);
                    return;
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setActiveSymbolResultIndex((index) => (index - 1 + symbolResults.length) % symbolResults.length);
                    return;
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    const instrument = symbolResults[activeSymbolResultIndex] ?? symbolResults[0];
                    selectInstrument(instrument);
                    setSymbolQuery('');
                    setSymbolResults([]);
                    setActiveSymbolResultIndex(0);
                  }
                }}
                placeholder="종목 검색: 삼성전자, AAPL, TSLA"
                role="combobox"
                type="search"
                value={symbolQuery}
              />
              {isSymbolSearchPanelOpen && (
                <div className="symbol-search__results" id="symbol-search-results" role="listbox">
                  <div className="symbol-search__summary">
                    <strong>{isSymbolSearching ? '검색중' : `${symbolResults.length}개 결과`}</strong>
                    <span>{trimmedSymbolQuery}</span>
                    {symbolResults.length > 0 && (
                      <div className="symbol-search__breadth" aria-label="검색 결과 등락 요약">
                        <em data-tone="up">상승 {symbolSearchSummary.up}</em>
                        <em data-tone="down">하락 {symbolSearchSummary.down}</em>
                        <em>보합 {symbolSearchSummary.flat}</em>
                        <em>대기 {symbolSearchSummary.waiting}</em>
                        {symbolSearchBreadthTotal > 0 && (
                          <span>
                            <i
                              data-tone="up"
                              style={{ flexBasis: `${(symbolSearchSummary.up / symbolSearchBreadthTotal) * 100}%` }}
                            />
                            <i
                              data-tone="flat"
                              style={{ flexBasis: `${(symbolSearchSummary.flat / symbolSearchBreadthTotal) * 100}%` }}
                            />
                            <i
                              data-tone="down"
                              style={{ flexBasis: `${(symbolSearchSummary.down / symbolSearchBreadthTotal) * 100}%` }}
                            />
                          </span>
                        )}
                      </div>
                    )}
                    {symbolSearchSummary.topMover && (
                      <small className="symbol-search__top">
                        최대 변동 {symbolSearchSummary.topMover.instrument.name}{' '}
                        {formatRate(symbolSearchSummary.topMover.snapshot.changeRate)}
                      </small>
                    )}
                  </div>
                  {symbolResults.map((instrument, index) => {
                    const resultSnapshot = toSnapshot(undefined, quotesByCode[instrument.id]);
                    return (
                      <div
                        className="symbol-search__result"
                        data-active={index === activeSymbolResultIndex}
                        id={`symbol-search-result-${index}`}
                        key={instrument.id}
                        onMouseEnter={() => setActiveSymbolResultIndex(index)}
                        role="option"
                        aria-selected={index === activeSymbolResultIndex}
                      >
                        <button
                          className="symbol-search__select"
                          onFocus={() => setActiveSymbolResultIndex(index)}
                          onClick={() => {
                            selectInstrument(instrument);
                            setSymbolQuery('');
                            setSymbolResults([]);
                            setActiveSymbolResultIndex(0);
                          }}
                          type="button"
                        >
                          <strong>{instrument.symbol}</strong>
                          <span>{instrument.name}</span>
                          <small>{marketLabel(instrument)}</small>
                          {/* 값이 없으면 `-` 대신 왜 없는지 적는다. 목록 행과 같은 규칙이다. */}
                          <em
                            data-pending={resultSnapshot ? undefined : 'true'}
                            style={resultSnapshot ? { color: signColor(resultSnapshot.sign) } : undefined}
                          >
                            {resultSnapshot
                              ? `${formatCurrencyPrice(resultSnapshot.price, instrument.currency)} · ${formatRate(resultSnapshot.changeRate)}`
                              : pendingQuoteLabel(instrument)}
                          </em>
                        </button>
                        <button
                          aria-label={watchedIds.has(instrument.id) ? '관심종목에서 제거' : '관심종목에 추가'}
                          className="symbol-search__watch"
                          data-watched={watchedIds.has(instrument.id)}
                          onFocus={() => setActiveSymbolResultIndex(index)}
                          onClick={() => toggleWatch(instrument)}
                          title={watchedIds.has(instrument.id) ? '관심종목에서 제거' : '관심종목에 추가'}
                          type="button"
                        >
                          {watchedIds.has(instrument.id) ? '−' : '+'}
                        </button>
                      </div>
                    );
                  })}
                  {!isSymbolSearching && symbolResults.length === 0 && (
                    <div className="symbol-search__empty">검색 결과 없음</div>
                  )}
                  <div className="symbol-search__hint">↑↓ 이동 · Enter 선택 · Esc 닫기</div>
                </div>
              )}
            </div>
            {activePage === 'market' && <div className="chart-commandbar__actions">
              <div className="chart-tool-strip" role="toolbar" aria-label="차트 도구">
                {TOOL_OPTIONS.map((tool) => (
                  <button
                    aria-label={tool.title}
                    aria-pressed={tool.key === activeTool}
                    key={tool.key}
                    onClick={() => setActiveTool(tool.key)}
                    title={tool.title}
                    type="button"
                  >
                    {tool.label}
                  </button>
                ))}
              </div>
              <div className="layout-presets" role="tablist" aria-label="레이아웃 프리셋">
                {LAYOUT_PRESET_OPTIONS.map((option) => (
                  <button
                    aria-selected={layoutPreset === option.key}
                    key={option.key}
                    onClick={() => applyLayoutPreset(option.key)}
                    role="tab"
                    title={option.title}
                    type="button"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <button onClick={() => runChartCommand('fit')} title="전체 차트 맞춤 (F)" type="button">맞춤</button>
              {/* 이름이 `+`·`−`뿐이라 낭독기에는 기호로만 들렸다. 옆의 도구 줄은
                  이미 aria-label={tool.title}을 쓰고 있어 그 방식에 맞춘다. */}
              <button aria-label="차트 확대" onClick={() => runChartCommand('zoomIn')} title="차트 확대 (+)" type="button">+</button>
              <button aria-label="차트 축소" onClick={() => runChartCommand('zoomOut')} title="차트 축소 (-)" type="button">−</button>
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
                aria-pressed={showPriceLevels}
                onClick={() => setShowPriceLevels((value) => !value)}
                title="전일종가/시가/고가/저가 기준선 표시"
                type="button"
              >
                레벨
              </button>
              <button
                aria-pressed={isFocusMode}
                onClick={() => setIsFocusMode((value) => !value)}
                title={isFocusMode ? '집중 모드 해제 (Esc)' : '집중 모드'}
                type="button"
              >
                집중
              </button>
              <button
                aria-pressed={showComparePanel}
                onClick={() => setShowComparePanel((value) => !value)}
                title="관심종목도 바로가기 줄에 함께 표시 (C)"
                type="button"
              >
                비교
              </button>
            </div>}
          </div>
          ) : (
            <div className="page-heading">
              <div>
                <span>계좌 현황</span>
                {/* 상단 네비와 같은 이름을 쓴다. `포트폴리오`라고 적혀 있어 서로 달랐다. */}
                <strong>내 계좌</strong>
              </div>
              {/*
                계좌 선택은 이 화면 전체의 맥락이지 카드별 설정이 아니다. 예전엔
                잔고·주문체결·리스크 룰 카드가 각자 같은 선택기를 갖고 있었고, 셋 다
                같은 kisAccountId를 바꿨다. 같은 컨트롤이 세 번 보이면 카드마다 계좌를
                따로 고르는 것처럼 읽힌다. 여기 한 번만 둔다.
              */}
              <div className="page-heading__account">
                <BrokerAccountPicker accounts={kisAccounts} onChange={setKisAccountId} value={kisAccountId} />
              </div>
              {/* 계좌가 하나뿐이라 이름표 없이 금액만 적는다. */}
              <small className="page-heading__balances">
                <b data-account="live">
                  예수금{' '}
                  {kisAccountSnapshot?.configured
                    ? formatMoney(kisAccountSnapshot.cashBalance, kisAccountSnapshot.baseCurrency)
                    : '미설정'}
                </b>
              </small>
            </div>
          )}

          {/*
            예전엔 `최근`과 `비교` 두 줄이 따로 있었다. 둘 다 누르면 그 종목으로
            옮겨가는 같은 동작인 데다, 비교 목록이 최근 목록을 포함하고 있어
            비교를 켜면 같은 종목이 두 줄에 중복으로 보였다. 한 줄로 합치고
            비교 버튼은 "관심종목도 이어 붙이기"로 쓴다.
          */}
          {activePage !== 'portfolio' && chipInstruments.length > 0 && (
            <div className="recent-symbols" role="tablist" aria-label="종목 바로가기">
              <span className="recent-symbols__label">종목</span>
              {chipInstruments.map((instrument) => {
                const recentTrade = instrument.country === 'KR' ? stream.trades[instrument.providerSymbol] : undefined;
                const recentQuote = quotesByCode[instrument.id];
                const recentSnapshot = toSnapshot(
                  recentTrade,
                  recentQuote,
                );
                const recentSource = quoteSourceForInstrument(instrument, recentTrade, recentQuote);
                return (
                  <button
                    aria-selected={instrument.id === selectedInstrument?.id}
                    key={instrument.id}
                    onClick={() => selectInstrument(instrument)}
                    role="tab"
                    title={`${instrument.name} ${marketLabel(instrument)}`}
                    type="button"
                  >
                    <strong>{instrument.name}</strong>
                    <em style={{ color: signColor(recentSnapshot?.sign) }}>
                      {recentSnapshot
                        ? `${formatCurrencyPrice(recentSnapshot.price, instrument.currency)} ${formatRate(recentSnapshot.changeRate)}`
                        : marketLabel(instrument)}
                    </em>
                    <small data-source={recentSource}>{recentSource}</small>
                  </button>
                );
              })}
              <button
                aria-label="최근 종목 비우기"
                className="recent-symbols__clear"
                onClick={() => setRecentInstruments([])}
                title="최근 종목 비우기"
                type="button"
              >
                비우기
              </button>
            </div>
          )}

          {activePage === 'terminal' && (
            <section className="terminal-board" aria-label="발견">
              <div className="terminal-board__hero">
                <div>
                  {/*
                    한때 `조회 전용`이라고 적었더니 헤더의 게이트 배지와 같은 문구가
                    됐다. 이건 게이트 상태가 아니라 이 화면이 주문을 받지 않는다는
                    뜻이라, 게이트가 열리면 두 표시가 서로 어긋나 읽힌다.
                    화면 성격만 적는다.
                  */}
                  <span>야간 지표 · 시세 조회</span>
                  <h2>발견</h2>
                  {/*
                    상단 네비는 `발견`인데 제목은 `야간 지표 터미널`이라 서로 달랐다.
                    아래 탭이 시세·뉴스·커뮤니티·도구까지 담고 있어 제목이 실제
                    범위보다 좁기도 했다. 이름을 네비와 맞추고, 항상 보이는 부분이
                    무엇인지는 설명으로 남긴다.
                  */}
                  <p>야간 지표를 띄워 두고, 아래 탭에서 시세 흐름·뉴스·커뮤니티·도구를 살펴봅니다.</p>
                </div>
                {/*
                  화면에서 가장 큰 숫자인데 자산 유형만 적혀 있어 어느 종목인지 알 수 없었다.
                  아래 "지금 시장" 타일과 값이 같아 보여 중복으로 읽히기도 했다. 종목명을 붙인다.
                */}
                <div className="terminal-board__hero-metric" data-tone={selectedTone}>
                  {/* 자산 유형을 덧붙이면 "삼성전자 야간 환산가 · 야간 환산가"처럼 겹친다. 이름만 쓴다. */}
                  <span>{selectedInstrument?.name ?? '선택 대기'}</span>
                  <strong>{snapshot ? formatCurrencyPrice(snapshot.price, selectedCurrency) : '-'}</strong>
                  <em>{snapshot ? `${formatSignedCurrencyPrice(snapshot.change, selectedCurrency)} · ${formatRate(snapshot.changeRate)}` : '탐색에서 지표를 선택하세요'}</em>
                </div>
              </div>

              <section className="terminal-market-strip" aria-label="지금 시장">
                <div className="terminal-panel__header">
                  <strong>지금 시장</strong>
                  <span>{terminalItems.length > 0 ? `${terminalItems.length}개 지표` : '로딩 중'}</span>
                </div>
                <div className="terminal-market-strip__rows">
                  {terminalItems.map((instrument) => {
                    const itemTrade = instrument.country === 'KR' ? stream.trades[instrument.providerSymbol] : undefined;
                    const itemSnapshot = toSnapshot(itemTrade, quotesByCode[instrument.id]);
                    const itemTone = moveTone(itemSnapshot?.sign);
                    return (
                      <button
                        data-tone={itemTone}
                        key={instrument.id}
                        onClick={() => selectInstrument(instrument)}
                        title={isRealtimeChartInstrument(instrument) ? '실시간 1분 차트로 이동' : instrument.name}
                        type="button"
                      >
                        <span>{assetTypeLabel(instrument.assetType)}</span>
                        <strong>{instrument.name}</strong>
                        <em>{itemSnapshot ? formatCurrencyPrice(itemSnapshot.price, instrument.currency) : '-'}</em>
                        <small>{itemSnapshot ? formatRate(itemSnapshot.changeRate) : pendingQuoteLabel(instrument)}</small>
                      </button>
                    );
                  })}
                  {terminalItems.length === 0 && (
                    <p>터미널 지표를 불러오는 중입니다</p>
                  )}
                </div>
              </section>

              {/*
                `뉴스 ticker`가 영어라 `실시간 뉴스`로 바꿨는데(5aed021) 그건
                내가 잘못 붙인 말이다. 여기 항목은 뉴스 검색 링크이고, 실제
                기사가 있을 때도 스트리밍이 아니라 조회해 온 목록이다.
                출처는 항목마다 따로 적히니 제목은 종류만 말한다.
              */}
              <section className="terminal-news-ticker" aria-label="뉴스">
                <strong>뉴스</strong>
                <div>
                  {terminalNewsCards.slice(0, 4).map((item) => (
                    <a href={item.url} key={item.id} rel="noreferrer" target="_blank">
                      <span>{item.source}</span>
                      <em>{item.title}</em>
                    </a>
                  ))}
                </div>
              </section>

              <nav className="terminal-tabs" aria-label="발견 기능" ref={terminalTabsRef}>
                {TERMINAL_TAB_GROUPS.map((group) => (
                  <div className="terminal-tabs__group" key={group.label} role="group" aria-label={group.label}>
                    <span>{group.label}</span>
                    {group.options.map((option) => (
                      <button
                        aria-selected={terminalTab === option.key}
                        key={option.key}
                        onClick={() => setTerminalTab(option.key)}
                        title={option.title}
                        type="button"
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                ))}
              </nav>

              {terminalTab === 'overview' && <div className="terminal-board__grid">
                <section className="terminal-panel terminal-panel--shortcuts" aria-label="빠른 지표 탐색">
                  <div className="terminal-panel__header">
                    <strong>지표 묶음</strong>
                    <span>클릭하면 탐색 탭으로 이동</span>
                  </div>
                  <div className="terminal-shortcuts">
                    {TERMINAL_CATEGORY_SHORTCUTS.map((shortcut) => (
                      <button
                        key={shortcut.id}
                        onClick={() => {
                          setSidePanelTab('discover');
                          setActiveCategory(shortcut.id);
                          setActivePage('market');
                        }}
                        type="button"
                      >
                        <strong>{shortcut.label}</strong>
                        <span>{shortcut.detail}</span>
                      </button>
                    ))}
                  </div>
                </section>

                <section className="terminal-panel" aria-label="데이터 출처">
                  <div className="terminal-panel__header">
                    <strong>데이터 출처</strong>
                    <span>{selectedInstrument?.name ?? '공통 링크'}</span>
                  </div>
                  <div className="terminal-sources">
                    {selectedSourceLinks.map((source) => (
                      <a href={source.url} key={`${source.label}-${source.url}`} rel="noreferrer" target="_blank">
                        <strong>{source.label}</strong>
                        <span>{source.detail}</span>
                      </a>
                    ))}
                  </div>
                </section>

                <section className="terminal-panel terminal-panel--news" aria-label="뉴스룸">
                  <div className="terminal-panel__header">
                    <strong>뉴스룸</strong>
                    <span>{selectedNews.length > 0 ? `선택 종목 ${selectedNews.length}건` : '검색으로 채운 뉴스'}</span>
                  </div>
                  <div className="terminal-news">
                    {selectedNews.slice(0, 5).map((item) => (
                      <a href={newsSearchUrl(item)} key={item.id} rel="noreferrer" target="_blank">
                        <span>{formatNewsTime(item.publishedAt)}</span>
                        <strong>{item.title}</strong>
                        <em>{item.source}</em>
                      </a>
                    ))}
                    {selectedNews.length === 0 && (
                      <>
                        <a href={selectedTopicNewsUrl} rel="noreferrer" target="_blank">
                          <span>검색</span>
                          <strong>{selectedInstrument ? `${selectedInstrument.name} 관련 뉴스` : '야간선물·원자재 뉴스'}</strong>
                          <em>Google News</em>
                        </a>
                        <a href={topicNewsUrl('국내 야간선물 원자재 시장')} rel="noreferrer" target="_blank">
                          <span>검색</span>
                          <strong>국내 야간선물·원자재 시장 뉴스</strong>
                          <em>Google News</em>
                        </a>
                      </>
                    )}
                  </div>
                </section>

                <section className="terminal-panel terminal-panel--notice" aria-label="데이터 고지">
                  <div className="terminal-panel__header">
                    <strong>{marketCountdown.label}</strong>
                    <span>{marketCountdown.target}</span>
                  </div>
                  <p>
                    {marketCountdown.detail}. GDR 환산가와 원자재는 공식 주문 종목이 아니라 참고 지표이며,
                    시세·뉴스·출처 검증 흐름을 먼저 강화합니다.
                  </p>
                </section>
              </div>}

              {terminalTab === 'news' && (
                <section className="terminal-page terminal-page--news" aria-label="뉴스룸">
                  <div className="terminal-page__header">
                    <div>
                      <span>{isTerminalNewsFallback ? '종목 뉴스 없음 · 주제 검색' : '자동 큐레이션'}</span>
                      <strong>뉴스룸</strong>
                    </div>
                    <small>
                      {isTerminalNewsFallback
                        ? `${selectedInstrument?.name ?? '이 종목'}의 뉴스를 찾지 못했습니다 · 아래는 시장 주제 검색 링크입니다`
                        : `${filteredTerminalNews.length}건 · ${selectedInstrument?.name ?? '시장 전체'}`}
                    </small>
                  </div>
                  {/*
                    이 셋은 눌러도 아무 일도 일어나지 않았다 — onClick이 없다.
                    그런데 실제로 동작하는 `채팅 보기`와 똑같이 생겼고 커서까지
                    손가락으로 바뀌어서, 처음 보는 사람은 눌러 보고 앱이 고장난
                    줄 안다. 채팅 입력칸과 같은 방식으로 막아 두고 왜 막혔는지
                    옆에 적는다 — `disabled`만으로는 이유가 보이지 않는다.
                  */}
                  <div className="terminal-news-tools">
                    <button disabled type="button">알림 대기</button>
                    <button disabled type="button">음성 읽기</button>
                    <button disabled type="button">공유 링크</button>
                    <button onClick={() => setTerminalTab('chat')} type="button">채팅 보기</button>
                    <small>알림·음성·공유는 아직 연결되지 않았습니다</small>
                  </div>
                  <div className="terminal-filterbar" role="tablist" aria-label="뉴스 필터">
                    {NEWS_FILTER_OPTIONS.map((option) => (
                      <button
                        aria-selected={newsFilter === option.key}
                        key={option.key}
                        onClick={() => setNewsFilter(option.key)}
                        role="tab"
                        type="button"
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <div className="terminal-headlines">
                    {/*
                      여기 `86`, `79` 같은 숫자가 중요도 점수처럼 붙어 있었다.
                      실제로는 `Math.max(45, 92 - index * 6)` — 목록 순서를 숫자로
                      바꾼 것뿐이었다. 순서는 사실이니 순번으로 적는다.
                    */}
                    {filteredTerminalNews.slice(0, 3).map((item, index) => (
                      <a href={item.url} key={item.id} rel="noreferrer" target="_blank">
                        <span>{index + 1}</span>
                        <strong>{item.title}</strong>
                        <em>{item.source} · {item.publishedAt ? formatNewsTime(item.publishedAt) : '검색 후보'}</em>
                      </a>
                    ))}
                  </div>
                  <div className="terminal-news-list">
                    {filteredTerminalNews.map((item, index) => (
                      <a href={item.url} key={`${item.id}-${index}`} rel="noreferrer" target="_blank">
                        <span>{item.publishedAt ? formatNewsTime(item.publishedAt) : '검색'}</span>
                        <strong>{item.title}</strong>
                        <em>{item.filters.map((filter) => NEWS_FILTER_OPTIONS.find((option) => option.key === filter)?.label ?? filter).join(' · ')}</em>
                      </a>
                    ))}
                    {filteredTerminalNews.length === 0 && <p>선택한 필터의 뉴스가 없습니다</p>}
                  </div>
                </section>
              )}

              {terminalTab === 'macro' && (
                <section className="terminal-page terminal-page--macro" aria-label="매크로 대시보드">
                  <div className="terminal-page__header">
                    <div>
                      <span>원자재 · 환율 · 금리 · 글로벌 지수</span>
                      <strong>매크로 대시보드</strong>
                    </div>
                    <small>조회 가능 항목 우선 표시</small>
                  </div>
                  <div className="terminal-filterbar" role="tablist" aria-label="매크로 필터">
                    {MACRO_FILTER_OPTIONS.map((option) => (
                      <button
                        aria-selected={macroFilter === option.key}
                        key={option.key}
                        onClick={() => setMacroFilter(option.key)}
                        role="tab"
                        type="button"
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <div className="terminal-macro-grid">
                    {macroBoardGroups.map((group) => {
                      /*
                       * 값이 들어온 항목만 먼저 보여주고 나머지는 접는다. 이 화면은
                       * 25개 행 중 값이 있는 게 2개뿐이라, 전부 펼쳐 두면 `-`만 스무 줄
                       * 넘게 이어져 처음 보는 사람에게는 고장난 화면으로 읽힌다.
                       * 숨기지는 않는다 — 무엇이 왜 안 되는지는 펼쳐서 볼 수 있다.
                       */
                      const hasValue = (item: (typeof group.items)[number]): boolean =>
                        Boolean(item.snapshot || item.exchangeRate);
                      const ordered = [...group.items].sort(
                        (a, b) => Number(hasValue(b)) - Number(hasValue(a)),
                      );
                      const readyCount = ordered.filter(hasValue).length;

                      return (
                        <section className="terminal-panel" key={group.label}>
                          <div className="terminal-panel__header">
                            <strong>{group.label}</strong>
                            <span>{readyCount}/{group.items.length}</span>
                          </div>
                          <div className="terminal-macro-list">
                            <CollapsibleRows
                              limit={readyCount}
                              moreLabel={(hidden) => `아직 값을 받지 못한 항목 ${hidden}개 보기`}
                              rows={ordered.map((item) => {
                                const itemTone = item.exchangeRate
                                  ? feeImpactTone(item.exchangeRate.changeRate)
                                  : moveTone(item.snapshot?.sign);
                                return (
                                  <button
                                    data-tone={itemTone}
                                    disabled={!item.instrument && !item.exchangeRate}
                                    key={item.key}
                                    onClick={() => item.instrument && selectInstrument(item.instrument)}
                                    type="button"
                                  >
                                    <span>{item.label}</span>
                                    <strong>
                                      {item.exchangeRate
                                        ? formatExchangeRate(item.exchangeRate.rate)
                                        : item.snapshot
                                          ? formatCurrencyPrice(item.snapshot.price, item.instrument?.currency)
                                          : (item.fallback ?? '-')}
                                    </strong>
                                    <em>
                                      {item.exchangeRate
                                        ? formatRate(item.exchangeRate.changeRate)
                                        : item.snapshot
                                          ? formatRate(item.snapshot.changeRate)
                                          : item.detail}
                                    </em>
                                  </button>
                                );
                              })}
                            />
                          </div>
                        </section>
                      );
                    })}
                  </div>
                </section>
              )}

              {terminalTab === 'calendar' && (
                <section className="terminal-page terminal-page--calendar" aria-label="경제 캘린더">
                  <div className="terminal-page__header">
                    <div>
                      {/*
                        `KST · 2026년 7월`이 고정 문자열이었다. 달이 바뀌어도
                        7월이라고 적는다. 지금 달을 계산해서 쓴다.
                      */}
                      <span>
                        KST · {new Date(nowMs).getFullYear()}년 {new Date(nowMs).getMonth() + 1}월
                        {' · 다가오는 일정 '}{upcomingEvents.length}건
                      </span>
                      <strong>경제 캘린더</strong>
                    </div>
                    {/* 일정도 등급도 확인된 값이 아니다. 안내가 맨 아래 패널에만 있었다. */}
                    <SampleBadge note="일정과 중요도는 확인된 값이 아닙니다. 화면 구성을 보여주려고 넣어 둔 것이라 실제 발표 일정은 따로 확인하세요." />
                  </div>
                  {/*
                    지역과 중요도가 한 줄에 섞여 있었다. 두 갈래 모두 첫 항목이
                    `전체`라 같은 글씨의 버튼이 나란히 눌린 채로 있었고, 어느 쪽이
                    무엇을 거르는지 화면에 적혀 있지 않았다. 화면 낭독기에는 더
                    나빴다 — 한 tablist 안에서 `전체, 탭, 선택됨`이 두 번 났다.
                    tablist는 선택이 하나라는 뜻이라 무엇이 켜져 있는지 알 수 없다.
                    갈래마다 이름을 붙이고 tablist도 따로 둔다.
                  */}
                  <div className="terminal-filterbar terminal-filterbar--grouped">
                    <div className="terminal-filterbar__group">
                      <span className="terminal-filterbar__label" id="calendar-region-label">
                        지역
                      </span>
                      <div aria-labelledby="calendar-region-label" role="tablist">
                        {CALENDAR_REGION_OPTIONS.map((option) => (
                          <button
                            /* 두 갈래 모두 `전체`가 있어 버튼 이름만으로는 구별되지
                               않는다. 갈래 이름을 붙여야 버튼만 훑어도 알 수 있다. */
                            aria-label={`지역 ${option.label}`}
                            aria-selected={calendarRegionFilter === option.key}
                            key={option.key}
                            onClick={() => setCalendarRegionFilter(option.key)}
                            role="tab"
                            type="button"
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="terminal-filterbar__group">
                      <span className="terminal-filterbar__label" id="calendar-impact-label">
                        중요도
                      </span>
                      <div aria-labelledby="calendar-impact-label" role="tablist">
                        {CALENDAR_IMPACT_OPTIONS.map((option) => (
                          <button
                            aria-label={`중요도 ${option.label}`}
                            aria-selected={calendarImpactFilter === option.key}
                            key={option.key}
                            onClick={() => setCalendarImpactFilter(option.key)}
                            role="tab"
                            type="button"
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="terminal-calendar-grid">
                    {/*
                      지난 일정과 앞으로의 일정이 똑같이 보였다. 오늘이 07-26인데
                      07-13 발표가 같은 모양으로 떠 있으니, 위의 `다가오는 일정 2건`과
                      아래 10줄이 왜 다른지 알 수 없었다. 지난 줄을 눌러 둔다.
                    */}
                    {calendarEvents.map((event) => {
                      const isPast = new Date(`${event.date}T23:59:59+09:00`).getTime() < nowMs;
                      return (
                        <article
                          data-impact={event.impact}
                          data-past={isPast ? 'true' : undefined}
                          key={`${event.date}-${event.title}`}
                        >
                          <span>
                            {formatEventDay(event.date)} · {event.time}
                            {isPast && ' · 지남'}
                          </span>
                          <strong>{event.title}</strong>
                          <em>{event.region} · 중요도 {event.impact}</em>
                        </article>
                      );
                    })}
                  </div>
                  <div className="terminal-panel terminal-panel--notice">
                    <div className="terminal-panel__header">
                      <strong>운영 기준</strong>
                      <span>Asia/Seoul</span>
                    </div>
                    <p>이 캘린더는 화면 구성용 기본 일정입니다. 실제 발표치·컨센서스·이전치는 별도 경제지표 API 연동 단계에서 붙입니다.</p>
                  </div>
                </section>
              )}

              {terminalTab === 'reports' && (
                <section className="terminal-page terminal-page--reports" aria-label="종목 요약">
                  <div className="terminal-page__header">
                    <div>
                      <span>고른 종목의 오늘 수치 · 전일 종가 대비</span>
                      <strong>종목 요약</strong>
                    </div>
                    <small>{selectedInstrument?.name ?? '종목 선택 대기'}</small>
                  </div>
                  {/*
                    가치평가 모델 이름(마법공식·그레이엄·DCF·다모다란)을 걷어냈다.
                    이름은 실제 방법인데 계산은 그 방법이 아니었다. 재무제표가
                    없으면 못 내는 값이라, 지금 가진 시세로 계산되는 것만 둔다.
                  */}
                  <div className="terminal-report-grid">
                    {selectedReportRows.map((row) => (
                      <article key={row.key}>
                        <span>{row.label}</span>
                        <strong>{row.value}</strong>
                        <em>{row.detail}</em>
                        {row.bar !== undefined && <i style={{ width: `${row.bar}%` }} />}
                      </article>
                    ))}
                    {selectedReportRows.length === 0 && (
                      <p>{selectedInstrument ? pendingQuoteLabel(selectedInstrument) : '종목을 고르면 오늘 수치를 보여줍니다'}</p>
                    )}
                  </div>
                  <div className="terminal-report-layout">
                    <section className="terminal-panel">
                      <div className="terminal-panel__header">
                        <strong>이 화면이 보여주는 것</strong>
                        <span>{selectedInstrument?.symbol ?? '-'}</span>
                      </div>
                      <p>
                        {selectedInstrument
                          ? `${selectedInstrument.name}의 오늘 시세에서 바로 읽은 값입니다. 재무제표가 있어야 하는 가치평가(마법공식·그레이엄·DCF 등)는 아직 계산하지 않습니다.`
                          : '종목을 고르면 그 종목의 오늘 수치를 보여줍니다.'}
                      </p>
                    </section>
                    <section className="terminal-panel">
                      <div className="terminal-panel__header">
                        <strong>다음 연동 항목</strong>
                        <span>재무 데이터</span>
                      </div>
                      <div className="terminal-sources">
                        <a href={topicNewsUrl(`${selectedInstrument?.name ?? '국내 주식'} 실적 재무제표`)} rel="noreferrer" target="_blank">
                          <strong>실적 뉴스</strong>
                          <span>재무제표·컨센서스 검색</span>
                        </a>
                        <a href={topicNewsUrl(`${selectedInstrument?.name ?? '국내 주식'} 밸류에이션`)} rel="noreferrer" target="_blank">
                          <strong>밸류에이션</strong>
                          <span>PER·PBR·DCF 참고 검색</span>
                        </a>
                      </div>
                    </section>
                  </div>
                </section>
              )}

              {terminalTab === 'heatmap' && (
                <section className="terminal-page terminal-page--heatmap" aria-label="섹터 히트맵">
                  <div className="terminal-page__header">
                    <div>
                      <span>시총 상위 12종목 · 전일 종가 대비 · -5% ~ +5%로 색을 입힘</span>
                      <strong>섹터 히트맵</strong>
                    </div>
                    {/* 등락률은 이제 실제 시세다. 고정값인 타일 크기만 밝힌다. */}
                    <SampleBadge note="등락률은 실제 시세입니다. 타일 크기는 시총 비중이 아니라 화면을 채우는 고정 비율입니다." />
                  </div>
                  <div className="terminal-heatmap">
                    {heatmapRows.map((item) => (
                      <article
                        data-pending={item.changeRate === undefined ? 'true' : undefined}
                        data-tone={item.changeRate === undefined ? 'flat' : heatmapTone(item.changeRate)}
                        key={item.symbol}
                        style={{ flexGrow: Number(heatmapArea(item.weight).replace('fr', '')) }}
                      >
                        <strong>{item.name}</strong>
                        <span>{item.symbol} · {item.sector}</span>
                        <em>{item.changeRate === undefined ? '시세 대기' : formatRate(item.changeRate)}</em>
                      </article>
                    ))}
                  </div>
                  <div className="terminal-heatmap-legend">
                    <span>-5%</span>
                    <i />
                    <span>+5%</span>
                    <em>실시간 시총 TOP100 API 연동 전까지 대표 종목 구성으로 표시합니다.</em>
                  </div>
                </section>
              )}

              {terminalTab === 'ranking' && (
                <section className="terminal-page terminal-page--ranking" aria-label="많이 움직인 종목">
                  <div className="terminal-page__header">
                    <div>
                      <span>최근·관심 종목 중에서 · 전일 종가 대비</span>
                      <strong>많이 움직인 종목</strong>
                    </div>
                    <small>{moversBoard.ranked.length}개</small>
                  </div>
                  <div className="terminal-ranking-list">
                    {moversBoard.ranked.map((item, index) => (
                      <button
                        data-tone={moveTone(item.snapshot.sign)}
                        key={item.instrument.id}
                        onClick={() => selectInstrument(item.instrument)}
                        type="button"
                      >
                        <span>#{index + 1}</span>
                        <strong>{item.instrument.name}</strong>
                        <em>{formatCurrencyPrice(item.snapshot.price, item.instrument.currency)}</em>
                        <small>{formatRate(item.snapshot.changeRate)}</small>
                      </button>
                    ))}
                    {moversBoard.ranked.length === 0 && <p>시세가 들어오면 등락률이 큰 순서로 보여줍니다</p>}
                    {/* 시세를 못 받은 종목은 순위 없이, 왜 못 받았는지와 함께 접어 둔다. */}
                    {moversBoard.pending.length > 0 && (
                      <CollapsibleRows
                        limit={0}
                        moreLabel={(hidden) => `아직 시세를 받지 못한 종목 ${hidden}개 보기`}
                        rows={moversBoard.pending.map((item) => (
                          <button
                            key={item.instrument.id}
                            onClick={() => selectInstrument(item.instrument)}
                            type="button"
                          >
                            <span aria-hidden="true">·</span>
                            <strong>{item.instrument.name}</strong>
                            <em>-</em>
                            <small>{pendingQuoteLabel(item.instrument)}</small>
                          </button>
                        ))}
                      />
                    )}
                  </div>
                </section>
              )}

              {terminalTab === 'themes' && (
                <section className="terminal-page terminal-page--themes" aria-label="테마와 도미넌스">
                  <div className="terminal-page__header">
                    <div>
                      <span>
                        구성 종목 등락률 평균 · 전일 종가 대비
                        {themeBreadth.measured > 0 && ` · 상승 ${themeBreadth.up} · 하락 ${themeBreadth.down}`}
                      </span>
                      <strong>테마 보드</strong>
                    </div>
                    {/* 등락률은 실제 시세다. 어떤 종목을 묶었는지가 사람이 정한 부분이다. */}
                    <SampleBadge note="등락률은 구성 종목의 실제 시세로 계산합니다. 어떤 종목을 한 테마로 묶을지는 사람이 정한 것이라 분류 기준이 따로 있지는 않습니다." />
                  </div>
                  {/*
                    `삼닉 관심도 36%`가 있던 자리다. 무엇을 잰 값인지 정의가
                    없었고 계산할 소스도 없어서, 셀 수 있는 것으로 바꿨다.
                    설명도 고정 문구를 쓰지 않는다 — `시장 폭`이 1/6인데
                    `주요 테마 상승 우위`라고 적혀 있었다.
                  */}
                  <div className="terminal-dominance">
                    <div>
                      <span>시장 폭</span>
                      <strong>{themeBreadth.up}/{themeBreadth.measured || themeBreadth.total}</strong>
                      <em>
                        {themeBreadth.measured === 0
                          ? '시세 대기'
                          : themeBreadth.up > themeBreadth.down
                            ? '오른 테마가 더 많다'
                            : themeBreadth.up < themeBreadth.down
                              ? '내린 테마가 더 많다'
                              : '오른 테마와 내린 테마가 같다'}
                      </em>
                    </div>
                    <div>
                      <span>가장 오른 테마</span>
                      <strong>{themeTop?.name ?? '-'}</strong>
                      <em>{themeTop ? formatRate(themeTop.changeRate as number) : '시세 대기'}</em>
                    </div>
                    <div>
                      <span>가장 내린 테마</span>
                      <strong>{themeBottom?.name ?? '-'}</strong>
                      <em>{themeBottom ? formatRate(themeBottom.changeRate as number) : '시세 대기'}</em>
                    </div>
                  </div>
                  <div className="terminal-theme-list">
                    {themeRows.map((item) => (
                      <article
                        data-pending={item.changeRate === undefined ? 'true' : undefined}
                        data-tone={item.changeRate === undefined ? 'flat' : feeImpactTone(item.changeRate)}
                        key={item.name}
                      >
                        <div>
                          <strong>{item.name}</strong>
                          <span>{item.symbols.join(' · ')}</span>
                        </div>
                        <em>{item.changeRate === undefined ? '시세 대기' : formatRate(item.changeRate)}</em>
                        <span>{item.tags.join(' · ')}</span>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {terminalTab === 'fees' && (
                <section className="terminal-page terminal-page--fees" aria-label="수수료 계산기">
                  <div className="terminal-page__header">
                    <div>
                      <span>국내주식 왕복 거래 기준 · {feeMarketOption.label} · {feeMarketOption.unit}</span>
                      <strong>수수료 비교 계산기</strong>
                    </div>
                    <SampleBadge note="증권사 요율도 세율도 확인된 값이 아닙니다. 상품·이벤트·개설 경로에 따라 다르고 세율은 법으로 바뀌니, 실제 값은 본인 계좌와 최신 세법에서 확인하세요." />
                  </div>
                  {/* 계산에 쓴 가정을 적는다. 결과만 보여주면 무엇을 넣어 나온 값인지 알 수 없다. */}
                  <p className="terminal-fee-assumptions">
                    계산에 쓴 값 — 매도 세율 {(feeMarketOption.taxRate * 100).toFixed(3)}%
                    · 유관기관 수수료 {(FEE_BROKERS[0].institutionRate * 100).toFixed(3)}%
                    {feeMarket === 'us_stock' && ' · 해외주식은 국내 요율의 10배로 잡음(근사)'}
                    {feeMarket === 'kospi200_option' && ' · 옵션은 국내 요율의 1.4배로 잡음(근사)'}
                  </p>
                  <div className="terminal-filterbar" role="tablist" aria-label="수수료 시장 선택">
                    {FEE_MARKET_OPTIONS.map((option) => (
                      <button
                        aria-selected={feeMarket === option.key}
                        key={option.key}
                        onClick={() => setFeeMarket(option.key)}
                        role="tab"
                        type="button"
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <div className="terminal-fee-controls">
                    <label>
                      <span>매수금액</span>
                      <input
                        inputMode="numeric"
                        onChange={(event) => setFeeAmount(event.target.value)}
                        value={feeAmount}
                      />
                    </label>
                    <label>
                      <span>예상 수익률 %</span>
                      <input
                        inputMode="decimal"
                        onChange={(event) => setFeeExpectedReturn(event.target.value)}
                        value={feeExpectedReturn}
                      />
                    </label>
                    <div>
                      <span>이 표에서 최저</span>
                      <strong>{bestFeeRow ? bestFeeRow.broker.name : '-'}</strong>
                      <em>{bestFeeRow ? `${formatPrice(Math.round(bestFeeRow.totalFee))}원` : '-'}</em>
                    </div>
                    <div>
                      <span>이 표에서 최고</span>
                      <strong>{worstFeeRow ? worstFeeRow.broker.name : '-'}</strong>
                      <em>{worstFeeRow && bestFeeRow ? `${formatPrice(Math.round(worstFeeRow.totalFee - bestFeeRow.totalFee))}원 차이` : '-'}</em>
                    </div>
                  </div>
                  <div className="terminal-fee-table">
                    <div className="terminal-fee-table__head">
                      <span>증권사</span>
                      <span>수수료율</span>
                      <span>총 비용</span>
                      <span>실손익</span>
                    </div>
                    {feeRows.map((row, index) => (
                      <div className="terminal-fee-table__row" key={row.broker.name}>
                        {/* `BEST`는 추천으로 읽힌다. 확인 안 된 요율로 추천할 수 없다. */}
                        <strong>{index === 0 ? '이 표에서 최저 · ' : ''}{row.broker.name}<em>{row.broker.product}</em></strong>
                        <span>{(row.broker.commissionRate * 100).toFixed(4)}%</span>
                        <span>{formatPrice(Math.round(row.totalFee))}원</span>
                        <span data-tone={feeImpactTone(row.netPnl)}>{formatSignedPrice(Math.round(row.netPnl))}원</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {terminalTab === 'lounge' && (
                <section className="terminal-page terminal-page--lounge" aria-label="라운지">
                  <div className="terminal-page__header">
                    <div>
                      <span>커뮤니티 화면 구성 · 읽기 전용</span>
                      <strong>라운지</strong>
                    </div>
                    <SampleBadge note="실제 게시글이 아닙니다. 화면 구성을 보여주려고 넣어 둔 글입니다." />
                  </div>
                  <div className="terminal-lounge-layout">
                    <section className="terminal-panel">
                      <div className="terminal-panel__header">
                        <strong>새 글</strong>
                        <span>로그인 기능 대기</span>
                      </div>
                      <p>커뮤니티 기능은 계정·신고·관리 도구가 붙은 뒤 쓰기 기능을 열고, 현재는 읽기 전용 피드 구조만 제공합니다.</p>
                    </section>
                    <div className="terminal-lounge-posts">
                      {LOUNGE_POSTS.map((post) => (
                        <article key={post.id}>
                          <span>{post.tag} · @{post.author}</span>
                          <strong>{post.title}</strong>
                          <p>{post.body}</p>
                          <em>댓글 {post.replies} · 좋아요 {post.likes}</em>
                        </article>
                      ))}
                    </div>
                  </div>
                </section>
              )}

              {terminalTab === 'chat' && (
                <section className="terminal-page terminal-page--chat" aria-label="채팅 화면">
                  <div className="terminal-page__header">
                    <div>
                      <span>읽기 전용 · 인증·신고 도구 연동 전</span>
                      <strong>채팅 화면</strong>
                    </div>
                    <SampleBadge note="실제 대화가 아닙니다. 화면 구성을 보여주려고 넣어 둔 메시지라 시각도 고정입니다." />
                  </div>
                  <div className="terminal-filterbar" role="tablist" aria-label="채팅 폭 조절">
                    {CHAT_PANEL_MODE_OPTIONS.map((option) => (
                      <button
                        aria-selected={chatPanelMode === option.key}
                        key={option.key}
                        onClick={() => setChatPanelMode(option.key)}
                        role="tab"
                        type="button"
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                  <div className="terminal-chat-layout" data-mode={chatPanelMode}>
                    <section className="terminal-panel">
                      <div className="terminal-panel__header">
                        <strong>운영 상태</strong>
                        <span>모더레이션 대기</span>
                      </div>
                      <p>채팅은 알림, 신고, 금칙어, 계정 제한이 모두 준비된 뒤 쓰기 기능을 엽니다. 현재는 라이브 룸 화면 구조와 읽기 피드만 제공합니다.</p>
                    </section>
                    <div className="terminal-chat-feed">
                      {CHAT_MESSAGES.map((message) => (
                        <article data-tone={message.tone} key={message.id}>
                          <span>{message.time} · @{message.author}</span>
                          <strong>{message.message}</strong>
                        </article>
                      ))}
                    </div>
                  </div>
                  <div className="terminal-chat-composer">
                    <input disabled placeholder="로그인과 운영 정책 연동 후 메시지를 보낼 수 있습니다" />
                    <button disabled type="button">전송</button>
                  </div>
                </section>
              )}

              {terminalTab === 'simulation' && (
                <section className="terminal-page terminal-page--simulation" aria-label="모의투자">
                  <div className="terminal-page__header">
                    <div>
                      <span>실계좌 주문 전 연습</span>
                      <strong>모의투자</strong>
                    </div>
                    <small>{formatSignedPrice(Math.round(simulationPnl))} pt</small>
                  </div>
                  <div className="terminal-sim-metrics">
                    <div>
                      <span><Term>총 평가</Term></span>
                      <strong>{formatPrice(Math.round(simulationEquity))} pt</strong>
                    </div>
                    <div>
                      <span>현금</span>
                      <strong>{formatPrice(Math.round(simulationCash))} pt</strong>
                    </div>
                    <div>
                      <span>평가금액</span>
                      <strong>{formatPrice(Math.round(simulationMarketValue))} pt</strong>
                    </div>
                    <div>
                      <span>투자원금</span>
                      <strong>{formatPrice(Math.round(simulationCostBasis))} pt</strong>
                    </div>
                    <div>
                      <span>평가손익</span>
                      <strong data-tone={feeImpactTone(simulationPnl)}>{formatSignedPrice(Math.round(simulationPnl))} pt</strong>
                    </div>
                  </div>
                  <div className="terminal-simulation-grid">
                    <section className="terminal-panel">
                      <div className="terminal-panel__header">
                        <strong>모의 주문</strong>
                        <span>{selectedInstrument?.name ?? '종목 선택 대기'}</span>
                      </div>
                      <div className="terminal-sim-ticket">
                        <label>
                          <span>수량</span>
                          <input
                            inputMode="decimal"
                            onChange={(event) => setSimulationQuantity(event.target.value)}
                            value={simulationQuantity}
                          />
                        </label>
                        <div>
                          <span>현재가</span>
                          <strong>{snapshot ? formatCurrencyPrice(snapshot.price, selectedCurrency) : '-'}</strong>
                        </div>
                        <div>
                          <span>보유</span>
                          <strong>{simulationSelectedPosition ? formatPrice(simulationSelectedPosition.quantity) : '0'}</strong>
                        </div>
                        <button onClick={() => submitSimulationOrder('buy')} type="button">모의 매수</button>
                        <button onClick={() => submitSimulationOrder('sell')} type="button">모의 매도</button>
                        <button
                          onClick={() => {
                            setSimulationCash(1_000_000);
                            setSimulationPositions([]);
                          }}
                          type="button"
                        >
                          초기화
                        </button>
                      </div>
                    </section>
                    <section className="terminal-panel">
                      <div className="terminal-panel__header">
                        <strong>보유 포지션</strong>
                        <span>{simulationPositions.length}개</span>
                      </div>
                      <div className="terminal-sim-positions">
                        {simulationPositions.map((position) => {
                          const instrument =
                            [...terminalItems, ...recentInstruments, ...watchlist, ...categoryItems].find(
                              (item) => item.id === position.instrumentId,
                            );
                          const positionSnapshot = instrument ? getSnapshotForInstrument(instrument) : undefined;
                          const currentPrice = positionSnapshot?.price ?? position.averagePrice;
                          const pnl = (currentPrice - position.averagePrice) * position.quantity;
                          return (
                            <button
                              data-tone={feeImpactTone(pnl)}
                              key={position.instrumentId}
                              onClick={() => instrument && selectInstrument(instrument)}
                              type="button"
                            >
                              <span>{position.symbol}</span>
                              <strong>{position.name}</strong>
                              <em>{formatPrice(position.quantity)}주 · {formatPrice(Math.round(position.averagePrice))}</em>
                              <small>{formatSignedPrice(Math.round(pnl))} pt</small>
                            </button>
                          );
                        })}
                        {simulationPositions.length === 0 && <p>모의 매수하면 포지션이 표시됩니다</p>}
                      </div>
                    </section>
                  </div>
                  {/*
                    예전엔 `리더보드`에 지어낸 참가자 넷이 있었고 내 실제 손익이
                    그 사이에 #0으로 끼어 있었다. 이 모의투자는 서버 없이
                    localStorage만 쓰는 도구라 다른 참가자가 있을 수 없다 —
                    실데이터로 바꿀 길이 없는 순위표였다. 내 기록만 남긴다.
                  */}
                  <section className="terminal-panel">
                    <div className="terminal-panel__header">
                      <strong>내 모의 성적</strong>
                      <span>이 브라우저에만 저장됩니다</span>
                    </div>
                    <div className="terminal-leaderboard">
                      <div>
                        <span aria-hidden="true">·</span>
                        <strong>내 기록</strong>
                        <em>{formatSignedPrice(Math.round(simulationPnl))} pt</em>
                        <small>{simulationPositions.length}개 보유</small>
                      </div>
                    </div>
                  </section>
                </section>
              )}
            </section>
          )}

          {activePage !== 'portfolio' && <section className="quote-header">
            <div className="quote-header__identity">
              <div className="quote-header__symbol-row">
                <span className="quote-header__code">
                  {selectedInstrument ? `${selectedInstrument.symbol} · ${marketLabel(selectedInstrument)}` : '-'}
                </span>
                {selectedInstrument && (
                  <button
                    aria-label={watchedIds.has(selectedInstrument.id) ? '관심종목에서 제거' : '관심종목에 추가'}
                    aria-pressed={watchedIds.has(selectedInstrument.id)}
                    className="quote-header__watch"
                    onClick={() => toggleWatch(selectedInstrument)}
                    title={watchedIds.has(selectedInstrument.id) ? '관심종목에서 제거' : '관심종목에 추가'}
                    type="button"
                  >
                    {watchedIds.has(selectedInstrument.id) ? '★' : '☆'}
                  </button>
                )}
              </div>
              <h2>{selectedName || '종목을 선택하세요'}</h2>
              <span className="quote-header__time">{formatTradeTime(snapshot?.time)}</span>
            </div>
            <div
              className={`quote-header__price${isSelectedPriceFlashing ? ' is-flashing' : ''}`}
              data-move={selectedTone}
              style={{ color: selectedColor }}
            >
              <strong>{snapshot ? formatCurrencyPrice(snapshot.price, selectedCurrency) : '-'}</strong>
              {selectedKrwConversion && <span className="quote-header__converted">{selectedKrwConversion}</span>}
              {snapshot && (
                <span>
                  {formatSignedCurrencyPrice(snapshot.change, selectedCurrency)} ({formatRate(snapshot.changeRate)})
                </span>
              )}
              {snapshot && (
                <div className="quote-header__price-context">
                  <em data-tone={snapshot.price >= snapshot.open ? 'up' : 'down'}>
                    시가대비 {openChange !== undefined ? formatSignedCurrencyPrice(openChange, selectedCurrency) : '-'}
                    {openChangeRate !== undefined ? ` (${formatRate(openChangeRate)})` : ''}
                  </em>
                  {dayRangePosition !== null && <em>범위 {Math.round(dayRangePosition)}%</em>}
                </div>
              )}
            </div>
            <div className="quote-stats">
              <div>
                <span>시가</span>
                <strong>{snapshot ? formatCurrencyPrice(snapshot.open, selectedCurrency) : '-'}</strong>
              </div>
              <div>
                <span>고가</span>
                <strong>{snapshot ? formatCurrencyPrice(snapshot.high, selectedCurrency) : '-'}</strong>
              </div>
              <div>
                <span>저가</span>
                <strong>{snapshot ? formatCurrencyPrice(snapshot.low, selectedCurrency) : '-'}</strong>
              </div>
              <div>
                <span>거래량</span>
                <strong>{snapshot ? formatVolume(snapshot.accVolume) : '-'}</strong>
              </div>
            </div>
          </section>}

          {activePage !== 'portfolio' && <section className="market-strip" aria-label="종목 상세 정보">
            <div className="market-strip__status" data-tone={marketSession.tone}>
              <span>장 상태</span>
              <strong>{marketSession.label}</strong>
              <small>{marketSession.detail}</small>
            </div>
            {/*
              거래소 칸은 뺐다. 화면 맨 위 명령줄이 이미 `NIGHT_PROXY · KRW`를
              보여주고 있어 같은 말이 세 줄 아래 또 나왔다.
            */}
            {/* 공급자 종목코드는 내부값이라 겉으로 내지 않고 툴팁에 둔다. */}
            <div className="market-strip__item" title={selectedInstrument?.providerSymbol ?? undefined}>
              <span>종류</span>
              <strong>{selectedInstrument ? assetTypeLabel(selectedInstrument.assetType) : '-'}</strong>
            </div>
            <div className="market-strip__item">
              <span>전일종가</span>
              <strong>{formatCurrencyPrice(previousClose, selectedCurrency)}</strong>
              <small>정규장 {marketSession.hours}</small>
            </div>
            <div className="market-strip__range">
              <div>
                <span>당일 범위</span>
                <strong>
                  {snapshot
                    ? `${formatCurrencyPrice(snapshot.low, selectedCurrency)} - ${formatCurrencyPrice(snapshot.high, selectedCurrency)}`
                    : '-'}
                </strong>
              </div>
              <div className="market-strip__range-track">
                {dayRangePosition !== null && <span style={{ left: `${dayRangePosition}%` }} />}
              </div>
            </div>
            <div className="market-strip__item">
              <span>현지시간</span>
              <strong>{marketSession.localTime}</strong>
              <small>{quoteRefreshAt ? `갱신 ${formatClock(quoteRefreshAt)}` : '갱신 대기'}</small>
            </div>
          </section>}


          {activePage === 'market' && <div className="chart-toolbar">
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
            <div className="chart-toolbar__meta">
              <span>
                {chartCandles.length
                  ? `${chartCandles.length}개 ${activeTimeframe.label}`
                  : timeframe === '1D'
                    ? '데이터 대기'
                    : '실시간 분봉 대기'}
              </span>
              {chartOverlayBadges.map((badge) => (
                <em key={badge}>{badge}</em>
              ))}
              {realtimeChartLabel && (
                <em data-tone={selectedTrade ? 'live' : 'waiting'}>{realtimeChartLabel}</em>
              )}
            </div>
          </div>}

          {activePage === 'market' && <div className="chart-frame" data-tool={activeTool}>
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
              <span className="chart-readout__metric" data-tone={activeChartReadoutStats?.tone ?? 'flat'}>
                변동{' '}
                {activeChartReadoutStats
                  ? `${formatSignedPrice(activeChartReadoutStats.change)} (${formatRate(activeChartReadoutStats.changeRate)})`
                  : '-'}
              </span>
              <span className="chart-readout__metric">
                폭{' '}
                {activeChartReadoutStats
                  ? `${formatPrice(activeChartReadoutStats.range)} (${formatRate(activeChartReadoutStats.rangeRate)})`
                  : '-'}
              </span>
              {showMovingAverage && chartMovingAverages.ma5 !== undefined && (
                <span className="chart-readout__indicator" data-line="ma5">
                  MA5 {formatPrice(chartMovingAverages.ma5)}
                </span>
              )}
              {showMovingAverage && chartMovingAverages.ma20 !== undefined && (
                <span className="chart-readout__indicator" data-line="ma20">
                  MA20 {formatPrice(chartMovingAverages.ma20)}
                </span>
              )}
              {realtimeChartLabel && (
                <span className="chart-readout__live" data-tone={selectedTrade ? 'live' : 'waiting'}>
                  {realtimeChartLabel}
                </span>
              )}
              <span className="chart-readout__tool">{activeToolOption.title}</span>
            </div>
            {selectedInstrument && (
              <div className="chart-watermark" aria-hidden="true">
                <strong>{selectedInstrument.symbol}</strong>
                <span>
                  {selectedName} · {activeTimeframe.label}
                </span>
              </div>
            )}
            {selectedInstrument && chartCandles.length > 0 ? (
              <Chart
                candles={chartCandles}
                latestPrice={snapshot}
                previousClose={previousClose}
                liveTrade={timeframe === '1D' ? selectedTrade : undefined}
                timeVisible={timeframe !== '1D'}
                updateLastCandle={timeframe === '1D'}
                command={chartCommand}
                showMovingAverage={showMovingAverage}
                showRsi={showRsi}
                showPriceLevels={showPriceLevels}
                onReadoutChange={setHoveredChartReadout}
              />
            ) : (
              <div className="chart-panel__empty">
                {selectedInstrument
                  ? timeframe === '1D'
                    ? '차트 로딩 중'
                    : isRealtimeChartInstrument(selectedInstrument)
                      ? '실시간 체결 수신 시 1분봉이 생성됩니다'
                      : '실시간 분봉 대기'
                  : '종목을 선택하세요'}
              </div>
            )}
          </div>}

          {activePage === 'market' && bottomDockMode !== 'hidden' && bottomDockTab === 'volume' && (
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
              <div className="volume-panel__split">
                <span>상승/하락 거래량</span>
                <strong>
                  {volumeSummary.count ? `${Math.round(volumeUpRatio)}% / ${Math.round(volumeDownRatio)}%` : '-'}
                </strong>
                {volumeSummary.total > 0 && (
                  <div
                    className="volume-panel__split-track"
                    aria-label={`상승 거래량 ${formatVolume(volumeSummary.upVolume)}, 하락 거래량 ${formatVolume(
                      volumeSummary.downVolume,
                    )}, 보합 거래량 ${formatVolume(volumeSummary.flatVolume)}`}
                  >
                    <span data-tone="up" style={{ flexBasis: `${volumeUpRatio}%` }} />
                    <span
                      data-tone="flat"
                      style={{ flexBasis: `${(volumeSummary.flatVolume / volumeSummary.total) * 100}%` }}
                    />
                    <span data-tone="down" style={{ flexBasis: `${volumeDownRatio}%` }} />
                  </div>
                )}
              </div>
            </section>
          )}

          {activePage === 'market' && bottomDockMode !== 'hidden' && bottomDockTab === 'trades' && (
            <section className={`trade-tape ${bottomPanelClass}`} aria-label="최근 체결">
              <div className="trade-tape__header">
                <strong>최근 체결</strong>
                <span>{selectedInstrument?.country === 'KR' ? selectedName : '국내 구독 종목'}</span>
                <div className="trade-tape__summary" aria-label="최근 체결 등락 요약">
                  <em data-tone="up">상승 {tapeSummary.up}</em>
                  <em data-tone="down">하락 {tapeSummary.down}</em>
                  <em>보합 {tapeSummary.flat}</em>
                </div>
                {tapeTrades[0] && (
                  <small style={{ color: signColor(tapeTrades[0].sign) }}>
                    최신 {formatCurrencyPrice(tapeTrades[0].price, 'KRW')} · {formatRate(tapeTrades[0].changeRate)}
                  </small>
                )}
              </div>
              <div className="trade-tape__rows">
                {tapeTrades.map((trade, index) => {
                  const tradeRangePosition = getRangePosition(trade.price, trade.low, trade.high);
                  return (
                    <div
                      className={`trade-tape__row${index === 0 ? ' is-latest' : ''}`}
                      data-move={moveTone(trade.sign)}
                      key={`${trade.code}-${trade.date}-${trade.time}-${index}`}
                    >
                      <span className="trade-tape__time">{formatTradeTime(trade.time)}</span>
                      <span className="trade-tape__move">{moveTone(trade.sign) === 'up' ? '상승' : moveTone(trade.sign) === 'down' ? '하락' : '보합'}</span>
                      <strong>{instrumentNameByProviderSymbol.get(trade.code) ?? trade.code}</strong>
                      <span className="trade-tape__price-cell">
                        <em style={{ color: signColor(trade.sign) }}>{formatCurrencyPrice(trade.price, 'KRW')}</em>
                        {tradeRangePosition !== null && (
                          <span
                            aria-label={`당일 저가 ${formatCurrencyPrice(trade.low, 'KRW')}, 고가 ${formatCurrencyPrice(trade.high, 'KRW')} 범위 내 ${Math.round(tradeRangePosition)}% 위치`}
                            className="trade-tape__range"
                            title={`저가 ${formatCurrencyPrice(trade.low, 'KRW')} · 고가 ${formatCurrencyPrice(trade.high, 'KRW')}`}
                          >
                            <span style={{ left: `${tradeRangePosition}%` }} />
                          </span>
                        )}
                      </span>
                      <span>{formatSignedPrice(trade.change)}</span>
                      <span>{formatRate(trade.changeRate)}</span>
                      <span>{formatVolume(trade.volume)}</span>
                      <span>{formatVolume(trade.accVolume)}</span>
                    </div>
                  );
                })}
                {tapeTrades.length === 0 && (
                  <div className="trade-tape__empty">체결 수신 대기</div>
                )}
              </div>
            </section>
          )}

          {activePage === 'market' && bottomDockMode !== 'hidden' && bottomDockTab === 'news' && (
            <section className={`news-panel ${bottomPanelClass}`} aria-label="종목 뉴스">
              <div className="news-panel__header">
                <strong>뉴스</strong>
                <span>{selectedInstrument ? selectedInstrument.name : '종목 미선택'}</span>
                <em>{selectedNews.length ? `${selectedNews.length}건` : '대기'}</em>
                {selectedNews.length > 0 && (
                  <div className="news-panel__summary" aria-label="뉴스 요약">
                    <span>최신 {formatNewsTime(newsSummary.latestPublishedAt)}</span>
                    <span>
                      출처 {newsSummary.sourceCount}곳
                      {newsSummary.topSourceName ? ` · ${newsSummary.topSourceName} ${newsSummary.topSourceCount}` : ''}
                    </span>
                  </div>
                )}
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

          {activePage === 'market' && <div className="bottom-dock">
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
                  title={option.key === 'hidden' ? `${option.label} (B)` : option.label}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="bottom-dock__state" aria-label="하단 패널 상태">
              <em>{bottomDockMode === 'hidden' ? '하단 숨김' : bottomDockTabLabel}</em>
              <em>{bottomDockModeLabel}</em>
            </div>
            {/*
              세션 종류는 게이트에서 가져온다. 하드코딩이던 시절엔 게이트가 열려도
              문구가 그대로였다. 조회 전이면 갱신 시각과 신선도가 둘 다 빈 값이라
              한 마디로 줄인다 — 예전엔 `시세 갱신 시세 연결 대기 · 조회 대기`처럼
              문장이 깨졌다.
            */}
            <span className="bottom-dock__status">
              {sessionModeLabel} ·{' '}
              {quoteRefreshAt
                ? `시세 갱신 ${formatClock(quoteRefreshAt)} · ${quoteFreshnessLabel}`
                : '시세 조회 전'}
            </span>
          </div>}

          {activePage === 'portfolio' && (
            <section className="portfolio-page" aria-label="포트폴리오">
              {/*
                실계좌와 모의 계좌 금액이 구분 없이 이어지면 어느 돈인지 헷갈린다.
                실제로 실계좌 예수금 5만원 바로 아래 모의 현금 971만원이 나온다.
              */}
              <h2 className="portfolio-section" data-kind="live">
                <span>실계좌</span>
                <em>{kisAccountSnapshot?.accountLabel ?? 'KIS'} · 실제 자금</em>
              </h2>
              <section className="portfolio-card portfolio-card--wide" aria-label="KIS 실계좌 조회">
                <div className="portfolio-card__header">
                  <div>
                    <strong>KIS 실계좌</strong>
                    <span>
                      {kisAccountSnapshot?.accountLabel ?? '조회 대기'} ·{' '}
                      {kisAccountSnapshot?.updatedAt ? `갱신 ${formatClock(kisAccountSnapshot.updatedAt)}` : '미갱신'}
                    </span>
                  </div>
                  <div className="portfolio-card__actions">
                    <button
                      aria-label={isKisAccountRefreshing ? '잔고 조회 중' : '잔고 새로고침'}
                      className="portfolio-card__refresh"
                      disabled={isKisAccountRefreshing}
                      onClick={refreshKisAccountSnapshot}
                      type="button"
                    >
                      {isKisAccountRefreshing ? '조회 중' : '새로고침'}
                    </button>
                  </div>
                </div>
                {kisAccountSnapshot?.configured ? (
                  <>
                    <div className="portfolio-page__metrics portfolio-page__metrics--broker">
                      <div>
                        <span><Term>예수금</Term></span>
                        <strong>{formatMoney(kisAccountSnapshot.cashBalance, kisAccountSnapshot.baseCurrency)}</strong>
                      </div>
                      <div>
                        <span><Term>총 평가</Term></span>
                        <strong>{formatMoney(kisAccountSnapshot.totalEvaluation, kisAccountSnapshot.baseCurrency)}</strong>
                      </div>
                      <div>
                        <span><Term>주식 평가</Term></span>
                        <strong>{formatMoney(kisAccountSnapshot.stockEvaluation, kisAccountSnapshot.baseCurrency)}</strong>
                      </div>
                      <div>
                        <span><Term>평가 손익</Term></span>
                        <strong data-tone={kisAccountPnlTone}>
                          {formatMoney(kisAccountSnapshot.unrealizedPnl, kisAccountSnapshot.baseCurrency)}
                        </strong>
                      </div>
                      <div>
                        <span>보유 종목</span>
                        <strong>{kisAccountPositionCount}개</strong>
                      </div>
                    </div>
                    <div className="portfolio-table portfolio-table--positions">
                      <div className="portfolio-table__head">
                        <span>종목</span>
                        <span>수량</span>
                        <span>평균단가</span>
                        <span>현재가</span>
                        <span>평가손익</span>
                      </div>
                      {/*
                        보유 줄이 종목코드만 보여 주고 있었다 — `005930`. 이름은
                        응답에 이미 오는데(BrokerPosition.name) 화면이 안 읽었다.
                        평가손익도 부호·색·비율 없이 `3,000원`이라 벌었는지
                        잃었는지 한 번에 안 보였다. 비율도 응답에 있다.
                      */}
                      <CollapsibleRows rows={kisAccountSnapshot.positions.map((position) => {
                        const tone =
                          position.unrealizedPnl === undefined || position.unrealizedPnl === 0
                            ? 'flat'
                            : position.unrealizedPnl > 0
                              ? 'up'
                              : 'down';
                        return (
                          <div className="portfolio-table__row" key={position.symbol}>
                            <strong title={`${position.name} · ${position.symbol}`}>
                              {position.name || position.symbol}
                              <small>{position.symbol}</small>
                            </strong>
                            <span>{formatNumber(position.quantity)}</span>
                            <span>{formatMoney(position.averagePrice, position.currency)}</span>
                            <span>{formatMoney(position.currentPrice, position.currency)}</span>
                            <em className="portfolio-table__pnl" data-tone={tone}>
                              {position.unrealizedPnl === undefined
                                ? '-'
                                : `${position.unrealizedPnl > 0 ? '+' : ''}${formatMoney(position.unrealizedPnl, position.currency)}`}
                              {position.unrealizedPnlRate !== undefined && (
                                <small>{formatRate(position.unrealizedPnlRate)}</small>
                              )}
                            </em>
                          </div>
                        );
                      })} />
                      {kisAccountPositionCount === 0 && <div className="portfolio-table__empty">보유 종목이 없습니다 · 종목 화면에서 매수하면 여기에 표시됩니다</div>}
                    </div>
                  </>
                ) : (
                  <div className="portfolio-table__empty">
                    {kisAccountSnapshot?.message ?? 'KIS 계좌 조회 설정을 확인하는 중입니다'}
                  </div>
                )}
              </section>

              <section className="portfolio-card portfolio-card--wide" aria-label="KIS 실계좌 체결 내역">
                <div className="portfolio-card__header">
                  <div>
                    <strong>실계좌 주문·체결</strong>
                    <span>
                      {kisExecutionSnapshot
                        ? `${formatBrokerDate(kisExecutionSnapshot.from)} ~ ${formatBrokerDate(kisExecutionSnapshot.to)} · ${kisExecutionCount}건${
                            kisExecutionSnapshot.updatedAt ? ` · 갱신 ${formatClock(kisExecutionSnapshot.updatedAt)}` : ''
                          }`
                        : '조회 대기'}
                    </span>
                  </div>
                  <div className="portfolio-card__actions">
                    <button
                      aria-label={isKisExecutionRefreshing ? '체결 내역 조회 중' : '체결 내역 새로고침'}
                      className="portfolio-card__refresh"
                      disabled={isKisExecutionRefreshing}
                      onClick={refreshKisExecutions}
                      type="button"
                    >
                      {isKisExecutionRefreshing ? '조회 중' : '새로고침'}
                    </button>
                  </div>
                </div>
                {kisExecutionSnapshot?.configured ? (
                  <>
                    <div className="portfolio-page__metrics portfolio-page__metrics--broker">
                      <div>
                        <span>총 주문수량</span>
                        <strong>{formatNumber(kisExecutionSnapshot.totalOrderQuantity)}</strong>
                      </div>
                      <div>
                        <span>총 체결수량</span>
                        <strong>{formatNumber(kisExecutionSnapshot.totalFilledQuantity)}</strong>
                      </div>
                      <div>
                        <span>총 체결금액</span>
                        <strong>{formatMoney(kisExecutionSnapshot.totalFilledAmount)}</strong>
                      </div>
                      <div>
                        <span><Term>미체결</Term></span>
                        <strong>{kisOpenExecutionCount}건</strong>
                      </div>
                    </div>
                    <div className="portfolio-table portfolio-table--executions">
                      {/*
                        주문번호가 없어서 이 표만 다른 표와 맞춰 볼 수 없었다.
                        주문 진행 알림·주문 기록·미체결 셋은 주문번호를 보여주는데
                        여기만 빠져 있어, 낸 주문이 어디까지 갔는지 따라가려면
                        시각과 수량으로 눈짐작해야 했다. 값은 이미 오고 있었다.
                      */}
                      <div className="portfolio-table__head">
                        <span>주문시각</span>
                        <span>종목</span>
                        <span>구분</span>
                        <span>주문번호</span>
                        <span>체결/주문</span>
                        <span>체결단가</span>
                        <span>체결금액</span>
                        <span>상태</span>
                      </div>
                      <CollapsibleRows rows={kisExecutionSnapshot.executions.map((execution) => (
                        <div className="portfolio-table__row" key={execution.id}>
                          <span>{formatBrokerOrderTime(execution.orderDate, execution.orderTime)}</span>
                          <strong>{execution.name || execution.symbol}</strong>
                          <span>
                            {execution.side === 'buy' ? '매수' : '매도'}
                            {execution.orderTypeLabel ? ` · ${execution.orderTypeLabel}` : ''}
                          </span>
                          {/* 정정·취소 주문이면 원주문번호도 함께 봐야 어느 주문의 후속인지 안다. */}
                          <span title={execution.originalOrderNo ? `원주문 ${execution.originalOrderNo}` : undefined}>
                            {execution.orderNo || '-'}
                            {execution.originalOrderNo && (
                              <small>{` (원주문 ${execution.originalOrderNo})`}</small>
                            )}
                          </span>
                          <span>
                            {formatNumber(execution.filledQuantity)} / {formatNumber(execution.orderQuantity)}
                          </span>
                          <span>
                            {formatMoney(
                              execution.averageFilledPrice || execution.orderPrice,
                              execution.currency,
                            )}
                          </span>
                          <span>{formatMoney(execution.filledAmount, execution.currency)}</span>
                          <em data-status={execution.status}>{brokerExecutionStatusLabel(execution.status)}</em>
                        </div>
                      ))} />
                      {kisExecutionCount === 0 && (
                        <div className="portfolio-table__empty">이 기간에 낸 주문이 없습니다 · 기간을 넓히거나 종목 화면에서 주문해 보세요</div>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="portfolio-table__empty">
                    {kisExecutionSnapshot?.message ?? 'KIS 체결내역을 조회하는 중입니다'}
                  </div>
                )}
              </section>

              <section className="portfolio-card portfolio-card--wide" aria-label="기간별 매매손익">
                <div className="portfolio-card__header">
                  <div>
                    <strong>기간별 매매손익</strong>
                    <span>
                      {kisTradeProfit
                        ? `${formatBrokerDate(kisTradeProfit.from)} ~ ${formatBrokerDate(kisTradeProfit.to)} · 매도 확정 ${kisTradeProfit.rows.length}건`
                        : '조회 대기'}
                    </span>
                  </div>
                  <div className="portfolio-card__actions">
                    <div className="broker-account-picker" role="tablist" aria-label="조회 기간">
                      {TRADE_PROFIT_RANGES.map((range) => (
                        <button
                          aria-selected={tradeProfitDays === range.days}
                          key={range.days}
                          onClick={() => setTradeProfitDays(range.days)}
                          role="tab"
                          type="button"
                        >
                          {range.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                {kisTradeProfit?.configured ? (
                  <>
                    <div className="portfolio-page__metrics portfolio-page__metrics--broker">
                      <div>
                        <span>실현손익</span>
                        <strong data-tone={profitTone(kisTradeProfit.totalRealizedProfit)}>
                          {formatMoney(kisTradeProfit.totalRealizedProfit)}
                        </strong>
                      </div>
                      <div>
                        <span>손익률</span>
                        <strong data-tone={profitTone(kisTradeProfit.totalProfitRate)}>
                          {formatPercent(kisTradeProfit.totalProfitRate)}
                        </strong>
                      </div>
                      <div>
                        <span>수수료</span>
                        <strong>{formatMoney(kisTradeProfit.totalFee)}</strong>
                      </div>
                      <div>
                        <span>세금</span>
                        <strong>{formatMoney(kisTradeProfit.totalTax)}</strong>
                      </div>
                      <div>
                        <span>거래대금</span>
                        <strong>{formatMoney(kisTradeProfit.totalTradeAmount)}</strong>
                      </div>
                    </div>
                    {kisTradeProfit.rows.length === 0 ? (
                      <div className="portfolio-table__empty">확정 손익이 없습니다 · 손익은 팔았을 때 확정됩니다</div>
                    ) : (
                      <div className="portfolio-table portfolio-table--trade-profit">
                        <div className="portfolio-table__head">
                          <span>매매일</span>
                          <span>종목</span>
                          <span>매도</span>
                          <span>매입단가</span>
                          <span>수수료·세금</span>
                          <span>실현손익</span>
                          <span>손익률</span>
                        </div>
                        <CollapsibleRows rows={kisTradeProfit.rows.map((row) => (
                          <div className="portfolio-table__row" key={row.id}>
                            <span>{formatBrokerOrderTime(row.tradeDate)}</span>
                            <strong>{row.name || row.symbol}</strong>
                            <span>
                              {formatNumber(row.sellQuantity)}주 · {formatMoney(row.sellPrice, row.currency)}
                            </span>
                            <span>{formatMoney(row.buyPrice, row.currency)}</span>
                            <span>{formatMoney(row.fee + row.tax, row.currency)}</span>
                            <span data-tone={profitTone(row.realizedProfit)}>
                              {formatMoney(row.realizedProfit, row.currency)}
                            </span>
                            <span data-tone={profitTone(row.profitRate)}>{formatPercent(row.profitRate)}</span>
                          </div>
                        ))} />
                      </div>
                    )}
                  </>
                ) : (
                  <div className="portfolio-table__empty">
                    {kisTradeProfit?.message ?? '기간별 매매손익을 조회하는 중입니다'}
                  </div>
                )}
              </section>

              <section className="portfolio-card portfolio-card--wide" aria-label="자동매매">
                <div className="portfolio-card__header">
                  <div>
                    <strong>자동매매</strong>
                    <span>
                      규칙대로 사고팔다가 목표나 중단선에 닿으면 스스로 멈춥니다 · 수익을 보장하지 않습니다
                    </span>
                  </div>
                  <div className="portfolio-card__actions">
                    {/*
                      상태를 모르는 것과 멈춘 것을 구별한다. 예전에는 둘 다
                      `멈춤`이라 조회가 실패해도 멈춘 것처럼 보였다.
                    */}
                    <em className="auto-trader__status" data-status={isAutoTraderKnown ? autoTrader.status : 'unknown'}>
                      {isAutoTraderKnown ? AUTO_TRADER_STATUS_LABEL[autoTrader.status] : autoTraderUnknownLabel}
                    </em>
                  </div>
                </div>

                <div className="auto-trader">
                  <label className="auto-trader__field">
                    <span>전략</span>
                    <select
                      disabled={autoTrader?.status === 'running'}
                      onChange={(event) => setAutoStrategy(event.target.value)}
                      value={autoStrategy}
                    >
                      {autoStrategies.map((item) => (
                        <option key={item.key} value={item.key}>
                          {item.label}
                          {/*
                            `<option>`에는 툴팁을 붙일 수 없어 라벨 글 자체로 밝힌다.
                            드롭다운이 세 전략을 동등한 선택지로 늘어놓고 있었는데,
                            하나는 8종목 표본에서 확정으로 잃는다.
                          */}
                          {item.verdict === 'no_edge' ? ' — 백테스트에서 우위 없음' : ''}
                        </option>
                      ))}
                    </select>
                  </label>

                  {/* 고른 전략에 대해 무엇이 확인됐는지. 숫자만 적으면 시점이 없어 오해된다. */}
                  {selectedAutoStrategy?.backtestNote && (
                    <p
                      className="auto-trader__verdict"
                      data-verdict={selectedAutoStrategy.verdict}
                    >
                      {selectedAutoStrategy.backtestNote}
                    </p>
                  )}

                  <label className="auto-trader__field">
                    <span>실행 방식</span>
                    <select
                      disabled={autoTrader?.status === 'running'}
                      onChange={(event) => setAutoMode(event.target.value as AutoTraderMode)}
                      value={autoMode}
                    >
                      <option value="dry_run">연습 — 주문을 만들되 보내지 않음</option>
                      <option value="live">실제 — 실계좌로 주문을 보냄</option>
                    </select>
                  </label>

                  <label className="auto-trader__field">
                    <span>목표 금액 (닿으면 정지)</span>
                    <input
                      disabled={autoTrader?.status === 'running'}
                      inputMode="numeric"
                      onChange={(event) => setAutoTarget(event.target.value)}
                      value={autoTarget}
                    />
                  </label>

                  <label className="auto-trader__field">
                    <span>중단 금액 (내려가면 정지)</span>
                    <input
                      disabled={autoTrader?.status === 'running'}
                      inputMode="numeric"
                      onChange={(event) => setAutoStop(event.target.value)}
                      value={autoStop}
                    />
                  </label>

                  <div className="auto-trader__actions">
                    {autoTrader?.status === 'running' ? (
                      <button
                        className="auto-trader__stop"
                        disabled={isAutoSubmitting}
                        onClick={() => void submitAutoTraderStop()}
                        type="button"
                      >
                        {isAutoSubmitting ? '처리 중' : '정지'}
                      </button>
                    ) : (
                      /*
                        연습인지 실제인지가 버튼 색으로 보여야 한다. 매수 버튼 색을
                        그대로 쓰면 연습 모드인데도 실계좌 주문처럼 보인다.
                      */
                      <button
                        className="auto-trader__start"
                        data-mode={autoMode}
                        /*
                          지금 돌고 있는지 모를 때는 시작을 막는다. 조회가
                          실패한 것을 `멈춤`으로 읽고 또 시작하면 같은 계좌에
                          두 번 걸린다. 모르면 막힌 쪽에 둔다.
                        */
                        disabled={isAutoSubmitting || !isAutoTraderKnown}
                        onClick={() => void submitAutoTraderStart()}
                        type="button"
                      >
                        {isAutoSubmitting ? '처리 중' : autoMode === 'live' ? '실제 매매 시작' : '연습 시작'}
                      </button>
                    )}
                    {!isAutoTraderKnown && (
                      <em className="auto-trader__unknown">
                        {autoTraderError
                          ? `지금 돌고 있는지 확인하지 못해 시작을 막았습니다 — ${autoTraderError}`
                          : '지금 돌고 있는지 확인하는 중입니다'}
                      </em>
                    )}
                  </div>
                </div>

                {autoTrader?.startEquity !== undefined && (
                  <div className="portfolio-page__metrics portfolio-page__metrics--broker">
                    <div>
                      <span>시작 금액</span>
                      <strong>{formatMoney(autoTrader.startEquity)}</strong>
                    </div>
                    <div>
                      <span>지금 금액</span>
                      <strong>{formatMoney(autoTrader.currentEquity)}</strong>
                    </div>
                    <div>
                      <span>목표까지</span>
                      <strong>
                        {formatMoney(
                          Math.max(0, autoTrader.config.targetEquity - (autoTrader.currentEquity ?? 0)),
                        )}
                      </strong>
                    </div>
                  </div>
                )}

                {/*
                  막고 있는 설정을 시작 버튼 가까이 적는다. 리스크 룰은 아래 다른
                  카드에 있어서, 여기서 알려주지 않으면 왜 아무것도 안 사는지
                  알아내기 어렵다.
                */}
                {autoTrader?.status !== 'running' && autoTraderBlockers.length > 0 && (
                  <div className="auto-trader__blockers">
                    <strong>지금 설정으로는 주문이 나가지 않습니다</strong>
                    <ul>
                      {autoTraderBlockers.map((blocker) => (
                        <li key={blocker.text}>
                          {blocker.text}
                          {blocker.fieldId && (
                            <button
                              /* 막힌 사유마다 하나씩 붙어 이름이 전부 `설정으로 이동`이었다. */
                              aria-label={`설정으로 이동: ${blocker.text}`}
                              className="auto-trader__jump"
                              onClick={() => focusRiskField(blocker.fieldId as string)}
                              type="button"
                            >
                              설정으로 이동
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {autoTrader?.stopReason && <p className="live-order__result">{autoTrader.stopReason}</p>}
                {autoMessage && <p className="live-order__result">{autoMessage}</p>}

                <div className="portfolio-table portfolio-table--auto-runs">
                  <div className="portfolio-table__head">
                    <span>시각</span>
                    <span>내용</span>
                  </div>
                  {/*
                    예전에는 `.slice(0, 12)`로 잘랐다. 서버는 40건을 보내는데
                    28건이 말없이 사라지고, 남은 12건이 카드 714px 중 494px을
                    차지했다. 한 세션이 `시작 → 후보 없음 → 정지` 3줄이라
                    같은 내용이 계속 쌓이는 것도 이유다. 6줄(최근 두 세션)만
                    두고 나머지는 접는다 — 버리지는 않는다.
                  */}
                  <CollapsibleRows
                    limit={6}
                    moreLabel={(hidden) => `이전 기록 ${hidden}건 더 보기`}
                    rows={(autoTrader?.recentRuns ?? []).map((run) => (
                      <div className="portfolio-table__row" key={run.id}>
                        <span>{formatLogTime(run.createdAt, nowMs)}</span>
                        <span>{run.message}</span>
                      </div>
                    ))}
                  />
                  {(autoTrader?.recentRuns ?? []).length === 0 && (
                    <div className="portfolio-table__empty">
                      아직 실행한 적이 없습니다 · 시작하면 회차마다 무엇을 했는지 여기에 쌓입니다
                    </div>
                  )}
                  {/* 서버가 40건에서 자른다. 다 보여준 것처럼 두지 않는다. */}
                  {autoTrader?.recentRunsHasMore && (
                    <div className="portfolio-table__empty">
                      더 오래된 기록은 서버에 남아 있습니다 · 여기에는 최근 것만 옵니다
                    </div>
                  )}
                </div>
              </section>

              <section className="portfolio-card portfolio-card--wide" aria-label="실주문 리스크 룰">
                <div className="portfolio-card__header">
                  <div>
                    <strong>실주문 리스크 룰</strong>
                    <span>
                      주문이 열려 있어도 이 룰에 걸리면 나가지 않습니다
                      {riskRules ? '' : riskRulesError ? ' · 불러오지 못했습니다' : ' · 불러오는 중'}
                    </span>
                  </div>
                  <div className="portfolio-card__actions">
                    <button
                      className="portfolio-card__refresh"
                      disabled={!riskDraft || isRiskSaving}
                      onClick={() => void saveRiskRules()}
                      type="button"
                    >
                      {isRiskSaving ? '저장 중' : '저장'}
                    </button>
                  </div>
                </div>
                {riskDraft && (
                  <>
                    <div className="risk-rules">
                      <label className="risk-rules__toggle">
                        <input
                          checked={riskDraft.enabled}
                          id="risk-enabled"
                          onChange={(event) => setRiskDraft({ ...riskDraft, enabled: event.target.checked })}
                          type="checkbox"
                        />
                        <span>이 계좌 실주문 허용</span>
                      </label>
                      <label className="risk-rules__toggle">
                        <input
                          checked={riskDraft.allowMarketOrder}
                          id="risk-allow-market-order"
                          onChange={(event) => setRiskDraft({ ...riskDraft, allowMarketOrder: event.target.checked })}
                          type="checkbox"
                        />
                        <span>시장가 주문 허용</span>
                      </label>
                      <label>
                        <span>1회 수량 한도</span>
                        <input
                          min="1"
                          onChange={(event) =>
                            setRiskDraft({ ...riskDraft, maxOrderQuantity: Number(event.target.value) })
                          }
                          type="number"
                          value={riskDraft.maxOrderQuantity}
                        />
                      </label>
                      <label>
                        <span>1회 금액 한도</span>
                        <input
                          min="1"
                          onChange={(event) =>
                            setRiskDraft({ ...riskDraft, maxOrderNotional: Number(event.target.value) })
                          }
                          type="number"
                          value={riskDraft.maxOrderNotional}
                        />
                      </label>
                      <label>
                        <span>일일 건수 한도</span>
                        <input
                          min="1"
                          onChange={(event) =>
                            setRiskDraft({ ...riskDraft, dailyOrderCountLimit: Number(event.target.value) })
                          }
                          type="number"
                          value={riskDraft.dailyOrderCountLimit}
                        />
                      </label>
                      <label>
                        <span>일일 금액 한도</span>
                        <input
                          min="1"
                          onChange={(event) =>
                            setRiskDraft({ ...riskDraft, dailyNotionalLimit: Number(event.target.value) })
                          }
                          type="number"
                          value={riskDraft.dailyNotionalLimit}
                        />
                      </label>
                      <label>
                        <span>시작 시각</span>
                        <input
                          onChange={(event) => setRiskDraft({ ...riskDraft, sessionStart: event.target.value })}
                          placeholder="09:00"
                          type="text"
                          value={riskDraft.sessionStart}
                        />
                      </label>
                      <label>
                        <span>종료 시각</span>
                        <input
                          onChange={(event) => setRiskDraft({ ...riskDraft, sessionEnd: event.target.value })}
                          placeholder="15:30"
                          type="text"
                          value={riskDraft.sessionEnd}
                        />
                      </label>
                      <label className="risk-rules__wide">
                        <span>허용 종목 (비우면 전체 허용)</span>
                        <input
                          id="risk-symbol-allowlist"
                          onChange={(event) => setRiskSymbolText({ ...riskSymbolText, allow: event.target.value })}
                          placeholder="005930, 000660"
                          type="text"
                          value={riskSymbolText.allow}
                        />
                      </label>
                      <label className="risk-rules__wide">
                        <span>차단 종목</span>
                        <input
                          onChange={(event) => setRiskSymbolText({ ...riskSymbolText, block: event.target.value })}
                          placeholder="005930"
                          type="text"
                          value={riskSymbolText.block}
                        />
                      </label>
                    </div>
                    <div className="risk-rules__footer">
                      <em>주말·공휴일은 시간대와 무관하게 항상 차단됩니다.</em>
                      {riskMessage && <strong>{riskMessage}</strong>}
                    </div>
                  </>
                )}
              </section>

              <section className="portfolio-card portfolio-card--wide" aria-label="실계좌 주문 전송 기록">
                <div className="portfolio-card__header">
                  <div>
                    <strong>실계좌 주문 기록</strong>
                    <span>
                      {kisOrderLog.length}건
                      {kisOrderLogHasMore && ' (더 오래된 기록은 서버에 남아 있습니다)'}
                      {' · 차단된 시도도 남습니다'}
                      {kisOrderLogUpdatedAt !== null && ` · 갱신 ${formatClock(kisOrderLogUpdatedAt)}`}
                    </span>
                  </div>
                  <button
                    aria-label="주문 기록 새로고침"
                    className="portfolio-card__refresh"
                    onClick={refreshKisOrderLog}
                    type="button"
                  >
                    새로고침
                  </button>
                </div>
                {kisOrderLog.length === 0 ? (
                  <div className="portfolio-table__empty">실계좌 주문 시도 없음</div>
                ) : (
                  <div className="portfolio-table portfolio-table--order-log">
                    <div className="portfolio-table__head">
                      <span>시각</span>
                      <span>동작</span>
                      <span>종목</span>
                      <span>수량·단가</span>
                      <span>주문번호</span>
                      <span>사유</span>
                      <span>상태</span>
                    </div>
                    <CollapsibleRows rows={kisOrderLog.map((record) => (
                      <div className="portfolio-table__row" key={record.id}>
                        <span>{formatClock(record.createdAt)}</span>
                        <span>
                          {brokerOrderActionLabel(record.action)}
                          {record.side ? ` · ${record.side === 'buy' ? '매수' : '매도'}` : ''}
                        </span>
                        <strong title={record.requestedInstrumentId ?? record.symbol ?? ''}>
                          {orderLogSymbolLabel(record.symbol, record.requestedInstrumentId)}
                        </strong>
                        <span>
                          {record.quantity !== undefined ? `${formatNumber(record.quantity)}주` : '-'}
                          {record.limitPrice !== undefined ? ` · ${formatMoney(record.limitPrice)}` : ''}
                        </span>
                        <span>{record.orderNo ?? record.originalOrderNo ?? '-'}</span>
                        <span title={record.blockers.join(', ') || record.message}>
                          {record.blockers[0] ?? record.message}
                        </span>
                        <em data-status={record.status === 'submitted' ? 'filled' : record.status}>
                          {brokerOrderRecordStatusLabel(record.status)}
                        </em>
                      </div>
                    ))} />
                  </div>
                )}
              </section>

              <section className="portfolio-card portfolio-card--wide" aria-label="KIS 실계좌 예약주문">
                <div className="portfolio-card__header">
                  <div>
                    <strong>실계좌 예약주문</strong>
                    <span>
                      {kisReservedOrders.length}건 · 최근 30일 · 취소하지 않으면 다음 개장일에 주문이 나갑니다
                      {kisReservedOrdersUpdatedAt !== null && ` · 갱신 ${formatClock(kisReservedOrdersUpdatedAt)}`}
                    </span>
                  </div>
                  <div className="portfolio-card__actions">
                    <button
                      aria-label="예약주문 새로고침"
                      className="portfolio-card__refresh"
                      onClick={refreshKisReservedOrders}
                      type="button"
                    >
                      새로고침
                    </button>
                  </div>
                </div>
                {!isOrderableDomesticInstrument(selectedInstrument) && (
                  <UnorderableInstrumentNotice action="예약주문" where="종목 화면의 관심·탐색 탭" />
                )}
                <div className="risk-rules">
                  <label className="risk-rules__wide">
                    <span>종목 (차트에서 선택한 종목)</span>
                    <input
                      readOnly
                      type="text"
                      value={
                        !selectedInstrument
                          ? '차트에서 종목을 먼저 선택하세요'
                          : isOrderableDomesticInstrument(selectedInstrument)
                            ? `${selectedInstrument.symbol} · ${selectedInstrument.name}`
                            : `${selectedInstrument.name} — 주문 대상이 아닙니다 (국내 주식·ETF·ETN만)`
                      }
                    />
                  </label>
                  <label>
                    <span>방향</span>
                    <select onChange={(event) => setReservedSide(event.target.value as OrderSide)} value={reservedSide}>
                      <option value="buy">매수</option>
                      <option value="sell">매도</option>
                    </select>
                  </label>
                  <label>
                    <span>수량</span>
                    <input
                      min="1"
                      onChange={(event) => setReservedQuantity(event.target.value)}
                      step="1"
                      type="number"
                      value={reservedQuantity}
                    />
                  </label>
                  <label>
                    <span>지정가 (예약주문은 지정가만)</span>
                    <input
                      min="1"
                      onChange={(event) => setReservedPrice(event.target.value)}
                      placeholder={snapshot ? formatPrice(snapshot.price) : '현재가 대기'}
                      step="1"
                      type="number"
                      value={reservedPrice}
                    />
                  </label>
                  <label className="risk-rules__toggle">
                    {/*
                      매수·매도처럼 한 번 확인받는다. 예전에는 누르는 즉시
                      전송돼서, 단가를 한 자리 잘못 치면 그대로 나갔다.
                    */}
                    <button
                      className="live-order__submit"
                      /*
                       * 차단 사유가 있으면 잠근다. 예전에는 종목 조건만 봐서, 지정가가
                       * 비어 있어도 눌렸다. submitReservedOrder가 막아 주긴 했지만
                       * 눌러 봐야 아래 이미 적힌 말을 다시 들었다. 주문 티켓은 같은
                       * 상황에서 잠기는데 여기만 달랐다.
                       */
                      disabled={reservedOrderBlockers.length > 0 || isReservedCancelling}
                      onClick={() => setReservedConfirming(true)}
                      title={
                        reservedOrderBlockers.length > 0 ? reservedOrderBlockers.join('\n') : undefined
                      }
                      type="button"
                    >
                      {isReservedCancelling ? '처리 중' : '예약주문 등록'}
                    </button>
                  </label>
                </div>
                {reservedConfirming && (
                  <div className="live-order__confirm live-order__confirm--card">
                    <p>
                      <strong>{selectedInstrument?.name ?? '-'}</strong>
                      <span>
                        {reservedSide === 'buy' ? '매수' : '매도'} {formatNumber(Number(reservedQuantity))}주 ·
                        {' 지정가 '}{formatMoney(Number(reservedPrice), selectedInstrument?.currency)}
                      </span>
                      <em>
                        {kisAccounts.find((account) => account.id === kisAccountId)?.label ?? kisAccountId}
                        {' · 다음 개장일에 나갑니다'}
                      </em>
                    </p>
                    <div className="live-order__confirm-actions">
                      <button onClick={() => setReservedConfirming(false)} type="button">
                        취소
                      </button>
                      <button
                        className="live-order__submit"
                        disabled={reservedOrderBlockers.length > 0 || isReservedCancelling}
                        onClick={() => {
                          setReservedConfirming(false);
                          void submitReservedOrder();
                        }}
                        type="button"
                      >
                        {isReservedCancelling ? '전송 중' : '예약주문 확인'}
                      </button>
                    </div>
                  </div>
                )}
                {/* 버튼이 왜 잠겼는지 보이지 않으면 사용자가 원인을 추측해야 한다. */}
                {reservedOrderBlockers.length > 0 && (
                  <div className="live-order__messages live-order__messages--card">
                    {reservedOrderBlockers.map((blocker) => (
                      <em key={blocker}>{blocker}</em>
                    ))}
                  </div>
                )}
                {kisReservedOrders.length === 0 ? (
                  <div className="portfolio-table__empty">예약주문이 없습니다 · 아래에서 등록하면 다음 개장일에 주문이 나갑니다</div>
                ) : (
                  <div className="portfolio-table portfolio-table--reserved">
                    <div className="portfolio-table__head">
                      <span>주문일자</span>
                      <span>종목</span>
                      <span>방향</span>
                      <span>수량</span>
                      <span>단가</span>
                      <span>상태·취소</span>
                    </div>
                    <CollapsibleRows rows={kisReservedOrders.map((order) => (
                      <div className="portfolio-table__row" key={order.id}>
                        <span>{formatBrokerOrderTime(order.orderDate)}</span>
                        <strong>{order.name || order.symbol}</strong>
                        <span>{order.side === 'buy' ? '매수' : '매도'}</span>
                        <span>{formatNumber(order.orderQuantity)}</span>
                        <span>{formatMoney(order.orderPrice, order.currency)}</span>
                        <span className="live-order__actions">
                          <em data-status={order.canceled ? 'canceled' : 'open'}>
                            {order.canceled ? '취소됨' : order.statusLabel || '예약'}
                          </em>
                          {!order.canceled && (
                            <button
                              disabled={isReservedCancelling}
                              onClick={() => void cancelReservedOrder(order)}
                              type="button"
                            >
                              취소
                            </button>
                          )}
                        </span>
                      </div>
                    ))} />
                  </div>
                )}
                {reservedCancelMessage && <p className="live-order__result">{reservedCancelMessage}</p>}
              </section>
            </section>
          )}
        </main>

        {activePage === 'market' && <aside
          className={`watchlist${isWatchlistCollapsed ? ' is-collapsed' : ''}${isCompactList ? ' is-compact-list' : ''}`}
          data-panel={sidePanelTab}
          id="side-panel"
          /* 건너뛰기 링크가 여기로 포커스를 옮긴다. -1이라 Tab 순서는 그대로다. */
          tabIndex={-1}
        >
          <div className="watchlist__header">
            <div>
              <strong>{SIDE_PANEL_TITLE[sidePanelTab]}</strong>
              <span>
                {sidePanelTab === 'order'
                  ? selectedInstrument
                    ? `${selectedInstrument.symbol} · ${selectedInstrument.name}`
                    : '종목 미선택'
                  : sidePanelTab === 'watch'
                    ? `${activeSavedWatchlist?.name ?? '기본'} · ${watchlist.length}`
                    : `${visibleCategoryItems.length}개 후보`}
              </span>
            </div>
            <button
              aria-label={isWatchlistCollapsed ? '관심종목 펼치기' : '관심종목 접기'}
              className="watchlist__collapse"
              onClick={() => setIsWatchlistCollapsed((value) => !value)}
              title={isWatchlistCollapsed ? '관심종목 펼치기 (W)' : '관심종목 접기 (W)'}
              type="button"
            >
              {isWatchlistCollapsed ? '‹' : '›'}
            </button>
          </div>
          <div className="watchlist__tabs" role="tablist" aria-label="오른쪽 패널">
            {SIDE_PANEL_OPTIONS.map((option) => (
              <button
                aria-selected={sidePanelTab === option.key}
                key={option.key}
                onClick={() => setSidePanelTab(option.key)}
                role="tab"
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
          {sidePanelTab === 'order' && <section className="order-ticket" aria-label="매매 주문 티켓">
            {/*
              예전엔 여기에 `주문 티켓`과 종목명이 또 있었다. 패널 헤더가 이미
              같은 걸 보여주고 있어 좁은 폭에서 자리만 차지하다 세로로 눌렸다.
              계좌 선택만 남긴다.
            */}
            {/*
              계좌가 두 종류다. KIS에 연결한 실계좌와, 앱 안에만 있는 연습용
              모의계좌. 예전엔 이 둘을 한 줄에 붙여 `KIS 21  KIS 23  모의계좌`로
              보여서 KIS 계좌가 모의계좌인 것처럼 읽혔다. 어느 계좌로 나가는
              주문인지가 이 화면에서 가장 중요하므로 줄을 갈라 이름표를 붙인다.
            */}
            <div className="order-ticket__header">
              <div className="order-ticket__account">
                <span className="order-ticket__account-label">실계좌</span>
                <BrokerAccountPicker accounts={kisAccounts} onChange={setKisAccountId} value={kisAccountId} />
              </div>
            </div>
            {/*
              종목 자체가 주문 대상이 아니면 폼을 채우기 전에 알려야 한다.
              이전에는 이 사실이 `국내 주식·ETF·ETN만 주문할 수 있습니다`라는
              10px 잔글씨로 버튼 74px 아래에 있었다. 그 위로는 수량도 입력되고
              `예상 주문액`까지 계산돼서, 다 채우고 눌러 봐야 안 되는 걸 알았다.
              다른 차단 사유(게이트, 수량 0)는 고치면 되는 것이지만 이건 종목을
              바꾸는 수밖에 없어서, 할 일까지 함께 적는다.
            */}
            {!isOrderableDomesticInstrument(selectedInstrument) && (
              <UnorderableInstrumentNotice action="주문" where="위 관심·탐색 탭" />
            )}
            <OrderBookPanel
              book={orderBook}
              error={orderBookError}
              nowMs={nowMs}
              onPickPrice={(price) => {
                setOrderType('limit');
                setOrderLimitPrice(String(price));
              }}
              visible={isOrderableDomesticInstrument(selectedInstrument)}
            />
            <div className="order-ticket__body">
              <div className="order-ticket__controls">
                <div className="order-ticket__segments" role="tablist" aria-label="매수 매도">
                  <button
                    aria-selected={orderSide === 'buy'}
                    data-side="buy"
                    onClick={() => setOrderSide('buy')}
                    role="tab"
                    type="button"
                  >
                    매수
                  </button>
                  <button
                    aria-selected={orderSide === 'sell'}
                    data-side="sell"
                    onClick={() => setOrderSide('sell')}
                    role="tab"
                    type="button"
                  >
                    매도
                  </button>
                </div>
                <select
                  aria-label="주문 유형"
                  onChange={(event) => setOrderType(event.target.value as OrderType)}
                  value={orderType}
                >
                  {/* option 안에는 툴팁을 붙일 수 없어 선택지 글 자체로 뜻을 밝힌다. */}
                  <option value="market">시장가 — 지금 값에 바로</option>
                  <option value="limit">지정가 — 값을 정해서</option>
                </select>
                <select
                  aria-label="주문 유효기간"
                  onChange={(event) => setOrderTimeInForce(event.target.value as OrderTimeInForce)}
                  value={orderTimeInForce}
                >
                  <option value="day">오늘 안에</option>
                  <option value="ioc">즉시, 안 되면 취소</option>
                </select>
                {/*
                  토스증권 주문 API도 `cashBuyingPower`(현금 매수 가능 금액)와
                  `sellableQuantity`(판매 가능 수량)를 따로 준다. 우리도 같은 값을
                  받고 있으면서 화면에는 숫자로만 적어 뒀는데, 5만원으로 몇 주를
                  살 수 있는지 사람이 나눗셈해야 했다. 한 번에 채워 준다.
                */}
                <label className="order-ticket__quantity">
                  <span>수량</span>
                  <div>
                    <input
                      min="0"
                      onChange={(event) => setOrderQuantity(event.target.value)}
                      step="1"
                      type="number"
                      value={orderQuantity}
                    />
                    <button
                      disabled={maxOrderQuantity === undefined || maxOrderQuantity <= 0}
                      onClick={() => setOrderQuantity(String(maxOrderQuantity ?? 0))}
                      title={
                        maxOrderQuantity === undefined
                          ? '가능 수량을 조회하지 못했습니다'
                          : maxOrderQuantity <= 0
                            ? orderSide === 'buy'
                              ? '예수금으로 한 주도 살 수 없습니다'
                              : '팔 수 있는 수량이 없습니다'
                            : `${formatNumber(maxOrderQuantity)}주`
                      }
                      type="button"
                    >
                      최대
                    </button>
                  </div>
                </label>
                <label>
                  <span><Term>지정가</Term></span>
                  <input
                    disabled={orderType !== 'limit'}
                    min="0"
                    onChange={(event) => setOrderLimitPrice(event.target.value)}
                    placeholder={snapshot ? formatPrice(snapshot.price) : '현재가 대기'}
                    step="1"
                    type="number"
                    value={orderLimitPrice}
                  />
                </label>
              </div>
              <div className="order-ticket__summary">
                <div>
                  <span>예상 단가</span>
                  <strong>{formatMoney(orderEffectivePrice, selectedInstrument?.currency)}</strong>
                  {orderEffectivePriceKrw && <small>{orderEffectivePriceKrw}</small>}
                </div>
                <div>
                  <span>예상 주문액</span>
                  <strong>{formatMoney(orderEstimatedNotional, selectedInstrument?.currency)}</strong>
                  {orderEstimatedNotionalKrw && <small>{orderEstimatedNotionalKrw}</small>}
                </div>
                {/*
                  비용을 빼놓으면 총액만 보고 수수료·세금을 0으로 여기게 된다.
                  매도는 특히 커서 증권거래세가 수수료의 열 배가 넘는다.
                  요율·세율은 확인된 값이 아니라 어림이라고 함께 적는다.
                */}
                {orderCost && (
                  <div className="order-ticket__cost">
                    <span>예상 비용 (어림)</span>
                    <strong>{formatMoney(Math.round(orderCost.total), selectedInstrument?.currency)}</strong>
                    <small>
                      수수료 {formatNumber(Math.round(orderCost.commission))}
                      {' + 유관기관 '}{formatNumber(Math.round(orderCost.institutionFee))}
                      {orderSide === 'sell'
                        ? ` + 거래세 ${formatNumber(Math.round(orderCost.tax))}`
                        : ' · 매수에는 거래세가 없습니다'}
                    </small>
                    <small>
                      {orderSide === 'buy' ? '내야 할 돈 약 ' : '받을 돈 약 '}
                      {formatMoney(Math.round(orderCost.settlement), selectedInstrument?.currency)}
                    </small>
                    <em>
                      확인된 요율이 아닙니다 — 수수료 {(KIS_COMMISSION_RATE_ASSUMPTION * 100).toFixed(3)}%
                      {' · 유관기관 '}{(KR_INSTITUTION_FEE_RATE_ASSUMPTION * 100).toFixed(3)}%
                      {orderSide === 'sell' && ` · 거래세 ${(orderCost.taxRate * 100).toFixed(3)}%`}
                      로 잡은 값이라 실제 청구액과 다를 수 있습니다.
                    </em>
                  </div>
                )}
                <div data-account="live">
                  <span>{orderSide === 'buy' ? '실계좌 매수가능' : '실계좌 매도가능'}</span>
                  {orderSide === 'buy' ? (
                    <>
                      <strong>
                        {isKisOrderabilityLoading
                          ? '조회 중'
                          : kisOrderability?.configured
                            ? formatMoney(kisOrderability.cashBuyAmount, kisOrderability.currency)
                            : '-'}
                      </strong>
                      {kisOrderability?.configured && kisOrderability.cashBuyQuantity !== undefined && (
                        <small>최대 {formatNumber(kisOrderability.cashBuyQuantity)}주</small>
                      )}
                    </>
                  ) : (
                    <>
                      <strong>
                        {isKisSellabilityLoading
                          ? '조회 중'
                          : kisSellability?.configured
                            ? `${formatNumber(kisSellability.sellableQuantity)}주`
                            : '-'}
                      </strong>
                      {kisSellability?.configured && kisSellability.holdingQuantity !== undefined && (
                        <small>보유 {formatNumber(kisSellability.holdingQuantity)}주</small>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>

{/*
              위 상자에서 수량·가격을 넣는데 전송 버튼은 `실계좌 주문`이라는 다른
              제목의 상자에 있었다. 모의계좌를 걷어낼 때 남은 자국인데, 폼과 버튼이
              갈라져 있으니 어디서 주문이 나가는지 알기 어려웠다. 한 상자로 합치고
              제목 대신 어디로 나가는 주문인지만 적는다.
            */}
            <div className="live-order" aria-label="주문 전송">
              <div className="live-order__header">
                <strong>이 주문은 실계좌로 나갑니다</strong>
                <em data-open={liveOrderGate?.enabled ? 'true' : 'false'}>
                  {liveOrderGate ? (liveOrderGate.enabled ? '주문 가능' : '주문 잠김') : gateUnknownLabel}
                </em>
                <span>{liveOrderGate?.isProdEnv ? '실전 서버' : '모의 서버'}</span>
              </div>
              {/*
                예전엔 `실주문 전송`을 그대로 받아치는 문구 입력이 있었다. 클라이언트가
                아는 상수를 클라이언트가 다시 적는 거라 오발주를 막는 힘은 없었고,
                증권사 화면에서 볼 수 없는 모양이었다. 실제 주문 화면이 하는 대로
                주문 내용을 보여주고 한 번 확인받는다.
              */}
              <div className="live-order__body">
                {liveOrderConfirming ? (
                  <div className="live-order__confirm">
                    <p>
                      <strong>{selectedInstrument?.name ?? '-'}</strong>
                      <span>
                        {formatNumber(orderQuantityNumber)}주 ·{' '}
                        {orderType === 'market'
                          ? '시장가'
                          : `지정가 ${formatCurrencyPrice(orderLimitPriceNumber, selectedCurrency)}`}
                      </span>
                      {/* 주문이 실제로 나가는 계좌를 적는다. */}
                      <em>{kisAccounts.find((account) => account.id === kisAccountId)?.label ?? kisAccountId}</em>
                    </p>
                    <div className="live-order__confirm-actions">
                      <button
                        onClick={() => {
                          setLiveOrderConfirming(false);
                          setLiveOrderKey(null);
                        }}
                        type="button"
                      >
                        취소
                      </button>
                      <button
                        className="live-order__submit"
                        data-side={orderSide}
                        disabled={!liveOrderCanSubmit}
                        onClick={() => void submitLiveOrder()}
                        type="button"
                      >
                        {isLiveOrderSubmitting ? '전송 중' : '주문 확인'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="live-order__submit"
                    data-side={orderSide}
                    disabled={liveOrderBlockers.length > 0}
                    onClick={() => {
                      setLiveOrderKey(crypto.randomUUID());
                      setLiveOrderConfirming(true);
                    }}
                    /* 잠긴 버튼은 이유를 손에 쥐여준다. 눌리지 않는 이유가 화면 어딘가에만
                       적혀 있으면 버튼과 설명을 연결짓지 못한다. */
                    title={liveOrderBlockers.length > 0 ? liveOrderBlockers.join('\n') : undefined}
                    type="button"
                  >
                    {/*
                      위 탭에도 `매수`/`매도`가 있어 같은 말이 한 패널에 두 번
                      나왔다. 위는 방향을 고르는 것이고 여기는 주문을 내는 것이라
                      동사를 붙여 구분한다.
                    */}
                    {orderSide === 'buy' ? '매수 주문하기' : '매도 주문하기'}
                  </button>
                )}
              </div>
              <div className="live-order__messages">
                {liveOrderBlockers.length === 0 ? (
                  <em data-tone="warn">실계좌 주문입니다. 확인하면 그대로 접수됩니다.</em>
                ) : (
                  liveOrderBlockers.map((blocker) => <em key={blocker}>{blocker}</em>)
                )}
                {/*
                  미수 없는 매수금액·매도가능수량 안내. 주문을 막지는 않는다 —
                  미수를 쓰면 넘겨서도 주문할 수 있어서 차단 조건으로 쓰면 틀린다.
                  예전엔 연습 주문 쪽에 붙어 있었는데 실계좌 제약이라 여기로 옮겼다.
                */}
                {orderLiveNotices.map((notice) => (
                  <em data-tone="live" key={notice}>
                    {notice}
                  </em>
                ))}
              </div>
              {liveOrderMessage && <p className="live-order__result">{liveOrderMessage}</p>}
            </div>

            <div className="live-order__open" aria-label="실시간 주문·체결 통보">
              <div className="live-order__header">
                <strong>주문 진행 알림</strong>
                <span>
                  {stream.orderNotices.length > 0
                    ? `${stream.orderNotices.length}건 · 낸 주문이 접수·체결되는 과정이 실시간으로 들어옵니다`
                    : '낸 주문이 접수·체결되는 과정이 여기에 실시간으로 들어옵니다 (HTS ID 설정 필요)'}
                </span>
              </div>
              {stream.orderNotices.length === 0 ? (
                <div className="portfolio-table__empty">받은 통보가 없습니다 · 주문을 내면 접수·체결이 여기에 실시간으로 쌓입니다</div>
              ) : (
                <div className="portfolio-table portfolio-table--notices">
                  <div className="portfolio-table__head">
                    <span>시각</span>
                    <span>종목</span>
                    <span>구분</span>
                    <span>수량·단가</span>
                    <span>주문번호</span>
                    <span>상태</span>
                  </div>
                  {/* 헤더가 `N건`이라고 세어 놓고 20건만 그리면 숫자와 화면이 어긋난다. */}
                  <CollapsibleRows
                    moreLabel={(hidden) => `이전 통보 ${hidden}건 더 보기`}
                    rows={stream.orderNotices.map((notice) => (
                      <div className="portfolio-table__row" key={`${notice.orderNo}-${notice.receivedAt}`}>
                        <span>{formatBrokerClock(notice.time) ?? formatClock(notice.receivedAt)}</span>
                        <strong>{notice.name || notice.symbol}</strong>
                        <span>{notice.side === 'buy' ? '매수' : '매도'}</span>
                        <span>
                          {formatNumber(notice.quantity)}주 · {formatMoney(notice.price)}
                        </span>
                        <span>{notice.orderNo}</span>
                        <em data-status={notice.rejected ? 'rejected' : notice.kind === 'filled' ? 'filled' : 'open'}>
                          {notice.rejected ? '거부' : notice.kind === 'filled' ? '체결' : '접수'}
                        </em>
                      </div>
                    ))}
                  />
                </div>
              )}
            </div>

            <div className="live-order__open" aria-label="실계좌 미체결 주문">
              <div className="live-order__header">
                {/* `안 팔린`이라고 적으면 매수 주문이 빠진다. 미체결은 사고파는 양쪽 다 해당한다. */}
                <strong>체결을 기다리는 주문</strong>
                <span>
                  {kisOpenOrders.length}건 · 값을 고치거나 취소할 수 있습니다
                  {kisOpenOrdersUpdatedAt !== null && ` · 갱신 ${formatClock(kisOpenOrdersUpdatedAt)}`}
                </span>
                <button
                  aria-label={isKisOpenOrdersRefreshing ? '미체결 주문 조회 중' : '미체결 주문 새로고침'}
                  disabled={isKisOpenOrdersRefreshing}
                  onClick={refreshKisOpenOrders}
                  type="button"
                >
                  {isKisOpenOrdersRefreshing ? '조회 중' : '새로고침'}
                </button>
              </div>
              {/*
                정정·취소가 왜 잠겼는지 화면에 적는다. 버튼 title만으로는 마우스를
                올려야 보이고, 키보드로 오면 영영 못 본다.
              */}
              {kisOpenOrders.length > 0 && amendCancelBlockers.length > 0 && (
                <div className="live-order__messages live-order__messages--card">
                  {amendCancelBlockers.map((blocker) => (
                    <em key={blocker}>{blocker}</em>
                  ))}
                </div>
              )}
              {kisOpenOrders.length === 0 ? (
                <div className="portfolio-table__empty">아직 체결되지 않은 주문이 없습니다 · 지정가 주문을 내면 여기에서 값을 고치거나 취소할 수 있습니다</div>
              ) : (
                <div className="portfolio-table portfolio-table--open-orders">
                  <div className="portfolio-table__head">
                    <span>주문번호</span>
                    <span>종목</span>
                    <span>구분</span>
                    <span>가능/주문</span>
                    <span>주문단가</span>
                    <span>정정·취소</span>
                  </div>
                  {kisOpenOrders.map((order) => (
                    <div className="portfolio-table__row" key={order.id}>
                      <span>{order.orderNo}</span>
                      <strong>{order.name || order.symbol}</strong>
                      <span>
                        {order.side === 'buy' ? '매수' : '매도'}
                        {order.orderTypeLabel ? ` · ${order.orderTypeLabel}` : ''}
                      </span>
                      <span>
                        {formatNumber(order.amendableQuantity)} / {formatNumber(order.orderQuantity)}
                      </span>
                      <span>{formatMoney(order.orderPrice, order.currency)}</span>
                      <span className="live-order__actions">
                        {amendingOrderId === order.id ? (
                          <>
                            <input
                              aria-label="정정 단가"
                              min="0"
                              onChange={(event) => setAmendPrice(event.target.value)}
                              placeholder="새 단가"
                              step="1"
                              type="number"
                              value={amendPrice}
                            />
                            {/*
                              바로 보내지 않고 무엇이 어떻게 바뀌는지 한 번
                              보여준다. 단가를 한 자리 잘못 치면 그대로 나갔다.
                            */}
                            {amendConfirmKey === `${order.id}:amend` ? (
                              <>
                                <em className="live-order__inline-confirm">
                                  {formatMoney(order.orderPrice, order.currency)} →{' '}
                                  {formatMoney(Number(amendPrice), order.currency)}
                                </em>
                                <button
                                  className="live-order__submit"
                                  disabled={isLiveOrderSubmitting || amendCancelBlockers.length > 0}
                                  onClick={() => {
                                    setAmendConfirmKey(null);
                                    void submitAmendOrCancel(order, 'amend');
                                  }}
                                  type="button"
                                >
                                  정정 확인
                                </button>
                                <button onClick={() => setAmendConfirmKey(null)} type="button">
                                  아니오
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  disabled={isLiveOrderSubmitting || amendCancelBlockers.length > 0}
                                  onClick={() => setAmendConfirmKey(`${order.id}:amend`)}
                                  title={amendCancelBlockedReason}
                                  type="button"
                                >
                                  확정
                                </button>
                                <button
                                  onClick={() => {
                                    setAmendingOrderId(null);
                                    setAmendConfirmKey(null);
                                  }}
                                  type="button"
                                >
                                  닫기
                                </button>
                              </>
                            )}
                          </>
                        ) : amendConfirmKey === `${order.id}:cancel` ? (
                          <>
                            <em className="live-order__inline-confirm">
                              {formatNumber(order.amendableQuantity)}주 취소
                            </em>
                            <button
                              className="live-order__submit"
                              disabled={isLiveOrderSubmitting || amendCancelBlockers.length > 0}
                              onClick={() => {
                                setAmendConfirmKey(null);
                                void submitAmendOrCancel(order, 'cancel');
                              }}
                              type="button"
                            >
                              취소 확인
                            </button>
                            <button onClick={() => setAmendConfirmKey(null)} type="button">
                              아니오
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              disabled={amendCancelBlockers.length > 0}
                              onClick={() => {
                                setAmendingOrderId(order.id);
                                setAmendPrice(String(order.orderPrice || ''));
                              }}
                              title={amendCancelBlockedReason}
                              type="button"
                            >
                              정정
                            </button>
                            <button
                              disabled={isLiveOrderSubmitting || amendCancelBlockers.length > 0}
                              onClick={() => setAmendConfirmKey(`${order.id}:cancel`)}
                              title={amendCancelBlockedReason}
                              type="button"
                            >
                              취소
                            </button>
                          </>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </section>}
          {/*
            시세가 하나도 안 들어온 상태에서는 다섯 칸이 전부 `0`과 `-`였다.
            72px를 써서 아무것도 말하지 않는 셈이라, 그럴 땐 한 줄로 줄인다.
          */}
          {sidePanelTab === 'watch' && <div className="watchlist__summary" aria-label="관심종목 요약">
            {watchlistBreadthTotal === 0 ? (
              <div className="watchlist__summary-counts">
                <span>{watchlistSummary.waiting}종목 시세 대기</span>
              </div>
            ) : (
              <div className="watchlist__summary-counts">
                <span data-tone="up">상승 {watchlistSummary.up}</span>
                <span data-tone="down">하락 {watchlistSummary.down}</span>
                <span>보합 {watchlistSummary.flat}</span>
                {watchlistSummary.waiting > 0 && <span>대기 {watchlistSummary.waiting}</span>}
              </div>
            )}
            {watchlistBreadthTotal > 0 && (
              <div
                aria-label={`관심종목 상승 ${watchlistSummary.up}, 하락 ${watchlistSummary.down}, 보합 ${watchlistSummary.flat}`}
                className="watchlist__breadth"
              >
                <span
                  data-tone="up"
                  style={{ flexBasis: `${(watchlistSummary.up / watchlistBreadthTotal) * 100}%` }}
                />
                <span
                  data-tone="flat"
                  style={{ flexBasis: `${(watchlistSummary.flat / watchlistBreadthTotal) * 100}%` }}
                />
                <span
                  data-tone="down"
                  style={{ flexBasis: `${(watchlistSummary.down / watchlistBreadthTotal) * 100}%` }}
                />
              </div>
            )}
            {watchlistSummary.topMover && (
              <div className="watchlist__summary-top">
                <span>최대 변동</span>
                <strong style={{ color: signColor(watchlistSummary.topMover.snapshot.sign) }}>
                  {watchlistSummary.topMover.instrument.name} {formatRate(watchlistSummary.topMover.snapshot.changeRate)}
                </strong>
              </div>
            )}
          </div>}
          {sidePanelTab === 'watch' && <div className="watchlist__saved-groups" role="tablist" aria-label="저장 관심그룹">
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
                  <small>{group.id === 'default' ? '기본' : '사용자'}</small>
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
          </div>}
          {sidePanelTab === 'watch' && <div className="watchlist__groups" role="tablist" aria-label="관심종목 필터">
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
          </div>}
          {sidePanelTab === 'watch' && <input
            aria-label="종목 검색"
            className="watchlist__search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="종목명 또는 코드"
            type="search"
            value={query}
          />}
          {sidePanelTab === 'watch' && <div className="watchlist__tools">
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
            <button
              aria-pressed={isCompactList}
              className="watchlist__density"
              onClick={() => setIsCompactList((value) => !value)}
              title={isCompactList ? '기본 리스트 보기' : '촘촘한 리스트 보기'}
              type="button"
            >
              촘촘
            </button>
          </div>}
          {/*
            걸린 조건이 없고 걸러진 종목도 없으면 이 줄은 위에 있는 것을 그대로
            되풀이한다 — `현재 그룹 · 전체 · 기본순 · 6 / 6`에서 네 가지가 전부
            헤더와 버튼줄에 이미 있었다. 말할 게 있을 때만 낸다.
          */}
          {sidePanelTab === 'watch'
            && (watchFilterChips.length > 0 || filteredWatchlist.length !== watchlist.length) && (
            <div className="watchlist__section-title">
              <strong>걸린 조건</strong>
              <div className="watchlist__section-meta">
                <div className="watchlist__filter-chips" aria-label="지금 걸린 조건">
                  {watchFilterChips.map((chip) => (
                    <em key={chip}>{chip}</em>
                  ))}
                </div>
                <span>{filteredWatchlist.length} / {watchlist.length}</span>
              </div>
            </div>
          )}
          {sidePanelTab === 'watch' && <div className="watchlist__rows watchlist__rows--saved">
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
          </div>}
          {sidePanelTab === 'discover' && <div className="discover">
            <div className="discover__header">
              <strong>추천 리스트</strong>
              <div className="discover__meta">
                <div className="discover__breadth" aria-label="추천 리스트 등락 요약">
                  <em data-tone="up">상승 {categorySummary.up}</em>
                  <em data-tone="down">하락 {categorySummary.down}</em>
                  <em>보합 {categorySummary.flat}</em>
                  <em>대기 {categorySummary.waiting}</em>
                </div>
                <span className="discover__top">
                  {categorySummary.topMover
                    ? `최대 변동 ${categorySummary.topMover.instrument.name} ${formatRate(
                        categorySummary.topMover.snapshot.changeRate,
                      )}`
                    : '최대 변동 -'}
                </span>
              </div>
            </div>
            <div className="category-picker">
              <label>
                <span>카테고리</span>
                <select
                  aria-label="추천 카테고리"
                  onChange={(event) => setActiveCategory(event.target.value)}
                  value={activeCategory}
                >
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>검색</span>
                <input
                  aria-label="탐색 결과 검색"
                  onChange={(event) => setDiscoverQuery(event.target.value)}
                  placeholder="종목명/코드"
                  type="search"
                  value={discoverQuery}
                />
              </label>
            </div>
            <div className="discover__section-label discover__section-label--results">
              <strong>{categories.find((category) => category.id === activeCategory)?.label ?? '결과'}</strong>
              {/*
                예전엔 `1/1 반영 · 화면 근처 우선`이 늘 붙어 있었다. 다 받아온
                상태에서도 뜨는 데다, `화면 근처 우선`은 화면에 보이는 것부터
                조회한다는 내부 사정이라 읽는 사람이 할 일이 없다.
              */}
              {discoverQuoteNote && <span>{discoverQuoteNote}</span>}
            </div>
            <div className="watchlist__rows discover__rows" ref={discoverRowsRef}>
              {visibleCategoryItems.map((instrument) => (
                <div data-discover-instrument-id={instrument.id} key={instrument.id}>
                  <InstrumentRow
                    instrument={instrument}
                    trade={instrument.country === 'KR' ? stream.trades[instrument.providerSymbol] : undefined}
                    quote={quotesByCode[instrument.id]}
                    active={instrument.id === selectedInstrument?.id}
                    watched={watchedIds.has(instrument.id)}
                    onSelect={selectInstrument}
                    onToggleWatch={toggleWatch}
                  />
                </div>
              ))}
              {visibleCategoryItems.length === 0 && (
                <div className="watchlist__empty">추천 종목이 없습니다</div>
              )}
            </div>
          </div>}
        </aside>}
      </div>
    </div>
  );
}
