import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addWatchlistItem,
  createOrder,
  createWatchlist,
  deleteWatchlist,
  fetchKisAccountSnapshot,
  fetchCategoryInstruments,
  fetchInstrumentCandles,
  fetchInstrumentCategories,
  fetchInstrumentIntradayCandles,
  fetchInstrumentNews,
  fetchInstrumentQuote,
  fetchInstrumentQuotes,
  fetchTerminalInstruments,
  fetchTradingOverview,
  fetchWatchlistItems,
  fetchWatchlists,
  removeWatchlistItem,
  searchInstruments,
} from './api';
import { useStream } from './useStream';
import { Chart, type ChartCommand, type ChartCommandType, type ChartReadout } from './Chart';
import type {
  BrokerAccountSnapshot,
  Candle,
  CandlesResponse,
  ClientSubscribeInstrument,
  Instrument,
  InstrumentCategory,
  NewsItem,
  OrderSide,
  OrderTimeInForce,
  OrderType,
  PriceSign,
  Quote,
  TradingOverview,
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
type AppPage = 'terminal' | 'market' | 'trade' | 'portfolio';
type SidePanelTab = 'watch' | 'discover';
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
  score: number;
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
  leader: string;
  score: number;
  change: number;
  tags: string[];
}

interface FeeBroker {
  name: string;
  product: string;
  commissionRate: number;
  institutionRate: number;
  supportsDerivatives: boolean;
}

interface ReportModel {
  key: string;
  label: string;
  score: number;
  detail: string;
}

interface HeatmapItem {
  symbol: string;
  name: string;
  sector: string;
  weight: number;
  change: number;
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

const APP_PAGE_OPTIONS: Array<{ key: AppPage; label: string; title: string }> = [
  { key: 'terminal', label: '터미널', title: '야간 지표와 데이터 출처' },
  { key: 'market', label: '차트', title: '차트와 관심종목' },
  { key: 'portfolio', label: '포트폴리오', title: '계좌와 보유 현황' },
];

const SIDE_PANEL_OPTIONS: Array<{ key: SidePanelTab; label: string }> = [
  { key: 'watch', label: '관심' },
  { key: 'discover', label: '탐색' },
];

const TERMINAL_CATEGORY_SHORTCUTS = [
  { id: 'kr-night-proxies', label: '야간 환산가', detail: 'GDR·환율 기반' },
  { id: 'kr-night-futures', label: '국내 야간선물', detail: 'KRX 야간 단일 선물' },
  { id: 'global-commodities', label: '원자재', detail: '금·은·원유·가스' },
  { id: 'overseas-futures', label: '해외선물', detail: '글로벌 선물' },
] as const;

const TERMINAL_TAB_OPTIONS: Array<{ key: TerminalTab; label: string; title: string }> = [
  { key: 'overview', label: '대시보드', title: '핵심 지표와 출처' },
  { key: 'news', label: '뉴스룸', title: '속보와 종목별 뉴스' },
  { key: 'macro', label: '매크로', title: '원자재·환율·금리·지수' },
  { key: 'calendar', label: '캘린더', title: '경제 지표 발표 일정' },
  { key: 'reports', label: '리포트', title: '가치투자 모델 보고서' },
  { key: 'heatmap', label: '히트맵', title: '시총 상위 종목 등락 지도' },
  { key: 'ranking', label: '랭킹', title: '24시간 인기 종목' },
  { key: 'themes', label: '테마', title: '도미넌스와 테마 흐름' },
  { key: 'fees', label: '수수료', title: '증권사 비용 계산' },
  { key: 'lounge', label: '라운지', title: '트레이더 쓰레드 피드' },
  { key: 'chat', label: '채팅', title: '실시간 채팅 미리보기' },
  { key: 'simulation', label: '시뮬', title: '테스트매매와 리더보드' },
];

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

const FEE_MARKET_OPTIONS: Array<{ key: FeeMarket; label: string; taxRate: number; unit: string }> = [
  { key: 'kospi', label: '코스피', taxRate: 0.002, unit: 'KRW' },
  { key: 'kosdaq', label: '코스닥', taxRate: 0.002, unit: 'KRW' },
  { key: 'konex', label: '코넥스', taxRate: 0.001, unit: 'KRW' },
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
    score: 86,
    filters: ['stocks', 'policy'],
    url: topicNewsUrl('반도체 AI 공급망 증시 뉴스'),
  },
  {
    id: 'fallback-macro',
    title: '미국 금리·달러 흐름과 야간선물 영향',
    source: '검색',
    score: 79,
    filters: ['macro', 'policy'],
    url: topicNewsUrl('미국 금리 달러 야간선물 뉴스'),
  },
  {
    id: 'fallback-commodity',
    title: '원유·금 가격 변동과 원자재 섹터',
    source: '검색',
    score: 74,
    filters: ['commodities', 'macro'],
    url: topicNewsUrl('원유 금 원자재 시장 뉴스'),
  },
  {
    id: 'fallback-crypto',
    title: '비트코인과 위험자산 선호 변화',
    source: '검색',
    score: 68,
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
      { key: 'usdkrw', label: 'USD/KRW', detail: '환율 원본 연동 예정', filter: 'fx', fallback: '-' },
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

const THEME_FLOW_ITEMS: ThemeFlowItem[] = [
  { name: '반도체', leader: '삼성전자 · SK하이닉스', score: 92, change: 18.4, tags: ['HBM', 'AI'] },
  { name: '방산', leader: '한화에어로스페이스', score: 81, change: 12.2, tags: ['수출', '정책'] },
  { name: '전력기기', leader: 'HD현대일렉트릭', score: 76, change: 9.7, tags: ['전력망', 'AI데이터센터'] },
  { name: '2차전지', leader: 'LG에너지솔루션', score: 64, change: -3.8, tags: ['IRA', '소재'] },
  { name: '바이오', leader: '삼성바이오로직스', score: 58, change: 4.1, tags: ['CDMO', '실적'] },
  { name: '조선', leader: 'HD한국조선해양', score: 55, change: 6.5, tags: ['LNG', '수주'] },
];

const REPORT_MODELS: ReportModel[] = [
  { key: 'magic', label: '마법공식', score: 82, detail: '수익성·자본효율 기반 정렬' },
  { key: 'graham', label: '그레이엄', score: 76, detail: '안전마진·재무 안정성 점검' },
  { key: 'dcf', label: 'DCF', score: 69, detail: '현금흐름 할인 민감도' },
  { key: 'damodaran', label: '다모다란', score: 71, detail: '시장 프리미엄·리스크 조정' },
];

const HEATMAP_ITEMS: HeatmapItem[] = [
  { symbol: '005930', name: '삼성전자', sector: 'semiconductor', weight: 18, change: 0.22 },
  { symbol: '000660', name: 'SK하이닉스', sector: 'semiconductor', weight: 14, change: -0.27 },
  { symbol: '373220', name: 'LG에너지솔루션', sector: 'battery', weight: 8, change: -1.18 },
  { symbol: '207940', name: '삼성바이오로직스', sector: 'bio', weight: 7, change: 0.84 },
  { symbol: '012450', name: '한화에어로스페이스', sector: 'defense', weight: 6, change: 2.11 },
  { symbol: '329180', name: 'HD현대중공업', sector: 'shipbuilding', weight: 5, change: 1.62 },
  { symbol: '005380', name: '현대차', sector: 'auto', weight: 5, change: -0.42 },
  { symbol: '035420', name: 'NAVER', sector: 'platform', weight: 4, change: 0.37 },
  { symbol: '035720', name: '카카오', sector: 'platform', weight: 3, change: -0.75 },
  { symbol: '051910', name: 'LG화학', sector: 'battery', weight: 3, change: -1.42 },
  { symbol: '068270', name: '셀트리온', sector: 'bio', weight: 3, change: 0.51 },
  { symbol: '000270', name: '기아', sector: 'auto', weight: 3, change: 0.18 },
];

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

const CHAT_MESSAGES: ChatMessage[] = [
  { id: 'chat-1', author: 'open-watch', message: '개장 전 환율이 먼저 튀면 야간 환산가 괴리를 같이 보세요.', time: '08:41', tone: 'macro' },
  { id: 'chat-2', author: 'semi-bid', message: '삼전 GDR 프리미엄은 둔한데 KOSPI200 야간선물은 강합니다.', time: '08:43', tone: 'normal' },
  { id: 'chat-3', author: 'risk-alert', message: 'CPI 발표 전후 뉴스 링크는 출처 확인 후 공유합니다.', time: '08:44', tone: 'alert' },
  { id: 'chat-4', author: 'oil-desk', message: 'WTI 하락은 정유보다 항공/운송 쪽 반응도 같이 체크 중입니다.', time: '08:45', tone: 'normal' },
];

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

const SIMULATION_LEADERS = [
  { rank: 1, name: 'night-alpha', pnl: 184200, trades: 32, winRate: 62 },
  { rank: 2, name: 'macro-runner', pnl: 126500, trades: 21, winRate: 57 },
  { rank: 3, name: 'oil-swing', pnl: 98400, trades: 18, winRate: 55 },
  { rank: 4, name: 'risk-flat', pnl: 41200, trades: 11, winRate: 64 },
];

const OVERSEAS_REFRESH_MS = 5_000;
const LIST_QUOTE_REFRESH_MS = 60_000;
const QUOTE_STALE_MS = LIST_QUOTE_REFRESH_MS * 2;
const TRADE_STALE_MS = 10_000;
// 탐색 리스트는 전체 현재가를 선조회하지 않는다. 첫 화면과 스크롤로 보인 종목만 점진적으로 채운다.
const LIST_QUOTE_REQUEST_CHUNK_SIZE = 8;
const DISCOVER_INITIAL_QUOTE_TARGETS = 24;
const SEARCH_QUOTE_TARGETS = 10;
const RECENT_INSTRUMENT_LIMIT = 8;
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

function terminalNewsCardFromItem(item: NewsItem, index: number): TerminalNewsCard {
  const cleanTitle = cleanNewsSearchText(item.title) || item.title;
  return {
    id: item.id,
    title: cleanTitle,
    source: item.source,
    score: Math.max(45, 92 - index * 6),
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
  if (n === undefined || !Number.isFinite(n)) return '-';
  return `${n.toLocaleString('ko-KR', {
    maximumFractionDigits: currency === 'KRW' ? 0 : 2,
  })} ${currency}`;
}

function orderStatusLabel(status: string): string {
  switch (status) {
    case 'blocked':
      return '차단';
    case 'accepted':
      return '접수';
    case 'submitted':
      return '전송';
    case 'filled':
      return '체결';
    case 'canceled':
      return '취소';
    case 'rejected':
      return '거부';
    default:
      return status;
  }
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
    case 'GLOBAL':
      return '해외';
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

  return (
    <button
      className={`instrument-row${active ? ' active' : ''}${flashing ? ' is-flashing' : ''}`}
      onClick={() => onSelect(instrument)}
      data-move={tone}
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
        <span>{snapshot ? formatPrice(snapshot.price) : '-'}</span>
        {snapshot && (
          <span className="instrument-row__rate">
            {formatSignedPrice(snapshot.change)} ({formatRate(snapshot.changeRate)})
          </span>
        )}
        {snapshot && rangePosition !== null && (
          <span
            aria-label={`당일 저가 ${formatPrice(snapshot.low)}, 고가 ${formatPrice(snapshot.high)} 범위 내 ${Math.round(rangePosition)}% 위치`}
            className="instrument-row__range"
            title={`저가 ${formatPrice(snapshot.low)} · 고가 ${formatPrice(snapshot.high)}`}
          >
            <span style={{ left: `${rangePosition}%` }} />
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
  const [activeCategory, setActiveCategory] = useState<string>('kr-night-proxies');
  const [categoryItems, setCategoryItems] = useState<Instrument[]>([]);
  const [terminalItems, setTerminalItems] = useState<Instrument[]>([]);
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
  const [tradingOverview, setTradingOverview] = useState<TradingOverview | null>(null);
  const [kisAccountSnapshot, setKisAccountSnapshot] = useState<BrokerAccountSnapshot | null>(null);
  const [isKisAccountRefreshing, setIsKisAccountRefreshing] = useState(false);
  const [orderSide, setOrderSide] = useState<OrderSide>('buy');
  const [orderType, setOrderType] = useState<OrderType>('market');
  const [orderTimeInForce, setOrderTimeInForce] = useState<OrderTimeInForce>('day');
  const [orderQuantity, setOrderQuantity] = useState('1');
  const [orderLimitPrice, setOrderLimitPrice] = useState('');
  const [orderAcknowledged, setOrderAcknowledged] = useState(false);
  const [isOrderSubmitting, setIsOrderSubmitting] = useState(false);
  const [simulationCash, setSimulationCash] = useState(() => {
    const value = Number(window.localStorage.getItem(`${STORAGE_PREFIX}simulationCash`));
    return Number.isFinite(value) && value >= 0 ? value : 1_000_000;
  });
  const [simulationPositions, setSimulationPositions] = useState<SimulationPosition[]>(readStoredSimulationPositions);
  const [simulationQuantity, setSimulationQuantity] = useState('1');
  const [error, setError] = useState<string | null>(null);
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
    fetchTerminalInstruments()
      .then((items) => {
        setTerminalItems(items);
        if (items.length) setSelectedInstrument((current) => current ?? items[0]);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    fetchInstrumentCategories()
      .then(setCategories)
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    fetchTradingOverview()
      .then(setTradingOverview)
      .catch((e) => setError(String(e)));
  }, []);

  const refreshKisAccountSnapshot = useCallback((): void => {
    setIsKisAccountRefreshing(true);
    fetchKisAccountSnapshot()
      .then(setKisAccountSnapshot)
      .catch((e) => setError(String(e)))
      .finally(() => setIsKisAccountRefreshing(false));
  }, []);

  useEffect(() => {
    refreshKisAccountSnapshot();
  }, [refreshKisAccountSnapshot]);

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
          if (!disposed) setError(String(e));
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
          if (!disposed) setError(String(e));
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
    const shouldLoadNews = activePage === 'terminal' || bottomDockTab === 'news';
    if (!selectedInstrument || !shouldLoadNews || newsByCode[selectedInstrument.id]) return;
    fetchInstrumentNews(selectedInstrument.id)
      .then((items) => setNewsByCode((current) => ({ ...current, [selectedInstrument.id]: items })))
      .catch((e) => setError(String(e)));
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
          if (shouldApply()) setError(String(e));
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
  const activeToolOption = TOOL_OPTIONS.find((tool) => tool.key === activeTool) ?? TOOL_OPTIONS[1];
  const quoteLagMs = quoteRefreshAt ? Math.max(0, nowMs - quoteRefreshAt) : null;
  const quoteFreshnessTone = quoteLagMs === null ? 'waiting' : quoteLagMs > QUOTE_STALE_MS ? 'stale' : 'fresh';
  const quoteFreshnessLabel =
    quoteLagMs === null ? '조회 대기' : `조회 ${Math.floor(quoteLagMs / 1000)}초 전`;
  const latestTradeMs = tradeTimestampMs(stream.recentTrades[0]);
  const tradeLagMs = latestTradeMs ? Math.max(0, nowMs - latestTradeMs) : null;
  const tradeFreshnessTone =
    tradeLagMs === null ? 'waiting' : tradeLagMs > TRADE_STALE_MS ? 'stale' : 'fresh';
  const tradeFreshnessLabel =
    tradeLagMs === null ? '체결 대기' : `체결 ${Math.floor(tradeLagMs / 1000)}초 전`;
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
  const comparisonItems = useMemo(() => {
    const seen = new Set<string>();
    const candidates: Instrument[] = [];

    for (const instrument of [...recentInstruments, ...watchlist]) {
      if (instrument.id === selectedInstrument?.id || seen.has(instrument.id)) continue;
      seen.add(instrument.id);
      candidates.push(instrument);
    }

    return candidates.slice(0, 6);
  }, [recentInstruments, selectedInstrument?.id, watchlist]);
  const layoutStateBadges = useMemo(() => {
    const badges: string[] = [];
    if (isFocusMode) badges.push('집중');
    if (isWatchlistCollapsed && !isFocusMode) badges.push('관심 접힘');
    if (bottomDockMode === 'hidden') badges.push('하단 숨김');
    if (bottomDockMode === 'expanded') badges.push('하단 확장');
    if (showComparePanel) badges.push('비교');
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
  const macroBoardGroups = useMemo(
    () =>
      MACRO_BOARD_GROUPS.map((group) => ({
        ...group,
        items: group.items
          .filter((item) => macroFilter === 'all' || item.filter === macroFilter)
          .map((item) => {
            const instrument = item.instrumentId ? terminalInstrumentById.get(item.instrumentId) : undefined;
            const itemSnapshot = instrument ? getSnapshotForInstrument(instrument) : undefined;
            return { ...item, instrument, snapshot: itemSnapshot };
          }),
      })).filter((group) => group.items.length > 0),
    [macroFilter, quotesByCode, stream.trades, terminalInstrumentById],
  );
  const macroCoreItems = macroBoardGroups[0]?.items ?? [];
  const upcomingEvents = useMemo(
    () =>
      ECONOMIC_EVENTS.filter((event) => new Date(`${event.date}T23:59:59+09:00`).getTime() >= nowMs)
        .filter((event) => calendarRegionFilter === 'all' || event.scope === calendarRegionFilter)
        .filter((event) => calendarImpactFilter === 'all' || event.impact === calendarImpactFilter)
        .slice(0, 6),
    [calendarImpactFilter, calendarRegionFilter, nowMs],
  );
  const calendarEvents = useMemo(
    () =>
      ECONOMIC_EVENTS.filter((event) => calendarRegionFilter === 'all' || event.scope === calendarRegionFilter)
        .filter((event) => calendarImpactFilter === 'all' || event.impact === calendarImpactFilter),
    [calendarImpactFilter, calendarRegionFilter],
  );
  const themeBreadth = useMemo(() => {
    const up = THEME_FLOW_ITEMS.filter((item) => item.change > 0).length;
    const down = THEME_FLOW_ITEMS.filter((item) => item.change < 0).length;
    return { up, down, total: THEME_FLOW_ITEMS.length };
  }, []);
  const marketCountdown = useMemo(() => getKoreanMarketCountdown(nowMs), [nowMs]);
  const popularInstruments = useMemo(() => {
    const seen = new Set<string>();
    const candidates = [...terminalItems, ...recentInstruments, ...watchlist, ...categoryItems].filter((instrument) => {
      if (seen.has(instrument.id)) return false;
      seen.add(instrument.id);
      return true;
    });

    return candidates
      .map((instrument) => ({ instrument, snapshot: getSnapshotForInstrument(instrument) }))
      .sort((a, b) => Math.abs(b.snapshot?.changeRate ?? 0) - Math.abs(a.snapshot?.changeRate ?? 0))
      .slice(0, 10);
  }, [categoryItems, quotesByCode, recentInstruments, stream.trades, terminalItems, watchlist]);
  const selectedReportModels = useMemo(() => {
    const volumeBoost = snapshot ? Math.min(12, Math.log10(Math.max(1, snapshot.accVolume)) * 1.6) : 4;
    const momentumPenalty = snapshot ? Math.min(10, Math.abs(snapshot.changeRate) * 0.8) : 0;
    return REPORT_MODELS.map((model, index) => ({
      ...model,
      score: Math.round(Math.max(0, Math.min(100, model.score + volumeBoost - momentumPenalty - index))),
    }));
  }, [snapshot?.accVolume, snapshot?.changeRate]);
  const feeAmountNumber = parseAmountInput(feeAmount, 1_000_000);
  const feeExpectedReturnNumber = Number(feeExpectedReturn);
  const feeMarketOption = FEE_MARKET_OPTIONS.find((option) => option.key === feeMarket) ?? FEE_MARKET_OPTIONS[0];
  const feeRows = useMemo(() => {
    const returnRate = Number.isFinite(feeExpectedReturnNumber) ? feeExpectedReturnNumber / 100 : 0;
    const grossSellAmount = feeAmountNumber * (1 + returnRate);
    const isDerivative = feeMarket === 'kospi200_future' || feeMarket === 'kospi200_option';
    return FEE_BROKERS.filter((broker) => !isDerivative || broker.supportsDerivatives).map((broker) => {
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
  const simulationPnl = simulationEquity - 1_000_000;
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
  const watchFilterChips = useMemo(() => {
    const groupLabel = WATCH_GROUP_OPTIONS.find((option) => option.key === watchGroup)?.label ?? '전체';
    const moveLabel = MOVE_FILTER_OPTIONS.find((option) => option.key === moveFilter)?.label ?? '전체';
    const sortLabel = WATCH_SORT_OPTIONS.find((option) => option.key === watchSort)?.label ?? '기본순';
    return [
      groupLabel,
      moveFilter === 'all' ? undefined : moveLabel,
      sortLabel,
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
  const activeTradingAccount = tradingOverview?.accounts[0];
  const selectedPosition = tradingOverview?.positions.find(
    (position) => position.instrument.id === selectedInstrument?.id,
  );
  const orderQuantityNumber = Number(orderQuantity);
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
  const orderRiskMessages = useMemo(() => {
    const messages: string[] = [];
    if (!selectedInstrument) messages.push('종목을 먼저 선택하세요.');
    if (!activeTradingAccount) messages.push('매매 계정을 불러오는 중입니다.');
    if (!Number.isFinite(orderQuantityNumber) || orderQuantityNumber <= 0) messages.push('수량은 0보다 커야 합니다.');
    if (!orderEstimatedPrice) messages.push('현재가를 확인할 수 없습니다.');
    if (orderType === 'limit' && (!Number.isFinite(orderLimitPriceNumber) || orderLimitPriceNumber <= 0)) {
      messages.push('지정가를 입력하세요.');
    }
    if (selectedInstrument && activeTradingAccount && selectedInstrument.currency !== activeTradingAccount.baseCurrency) {
      messages.push(
        `계정 통화(${activeTradingAccount.baseCurrency})와 종목 통화(${selectedInstrument.currency})가 달라 아직 주문할 수 없습니다.`,
      );
    }
    if (activeTradingAccount && orderEstimatedNotional !== undefined) {
      if (orderEstimatedNotional > activeTradingAccount.maxOrderNotional) {
        messages.push(`1회 주문 한도 ${formatMoney(activeTradingAccount.maxOrderNotional)}를 초과했습니다.`);
      }
      if (orderSide === 'buy' && orderEstimatedNotional > activeTradingAccount.buyingPower) {
        messages.push('주문 가능 금액을 초과했습니다.');
      }
    }
    if (orderSide === 'sell' && (selectedPosition?.quantity ?? 0) < orderQuantityNumber) {
      messages.push('보유 수량보다 많은 매도 주문입니다.');
    }
    if (!orderAcknowledged) messages.push('주문 확인 체크가 필요합니다.');
    return messages;
  }, [
    activeTradingAccount,
    orderAcknowledged,
    orderEstimatedNotional,
    orderEstimatedPrice,
    orderLimitPriceNumber,
    orderQuantityNumber,
    orderSide,
    orderType,
    selectedInstrument,
    selectedInstrument?.currency,
    selectedPosition?.quantity,
  ]);
  const orderCanSubmit =
    Boolean(selectedInstrument && activeTradingAccount && orderRiskMessages.length === 0 && orderEstimatedPrice) &&
    !isOrderSubmitting;
  const portfolioPositionCount = tradingOverview?.positions.length ?? 0;
  const kisAccountPositionCount = kisAccountSnapshot?.positions.length ?? 0;
  const kisAccountPnlTone =
    kisAccountSnapshot?.unrealizedPnl === undefined
      ? 'flat'
      : kisAccountSnapshot.unrealizedPnl > 0
        ? 'up'
        : kisAccountSnapshot.unrealizedPnl < 0
          ? 'down'
          : 'flat';
  const portfolioMarketValue = useMemo(
    () =>
      tradingOverview?.positions.reduce((total, position) => {
        const positionSnapshot = getSnapshotForInstrument(position.instrument);
        return total + position.quantity * (positionSnapshot?.price ?? position.averagePrice);
      }, 0) ?? 0,
    [quotesByCode, stream.trades, tradingOverview?.positions],
  );
  const recentFillTotal =
    tradingOverview?.recentFills.slice(0, 10).reduce((total, fill) => total + fill.notional, 0) ?? 0;

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

  async function submitOrderIntent(): Promise<void> {
    if (!selectedInstrument || !activeTradingAccount || !orderEstimatedPrice) return;
    setIsOrderSubmitting(true);
    try {
      await createOrder({
        accountId: activeTradingAccount.id,
        instrumentId: selectedInstrument.id,
        side: orderSide,
        orderType,
        timeInForce: orderTimeInForce,
        quantity: orderQuantityNumber,
        limitPrice: orderType === 'limit' ? orderLimitPriceNumber : undefined,
        estimatedPrice: orderEstimatedPrice,
        userAcknowledged: orderAcknowledged,
      });
      setOrderAcknowledged(false);
      const overview = await fetchTradingOverview();
      setTradingOverview(overview);
    } catch (e) {
      setError(String(e));
    } finally {
      setIsOrderSubmitting(false);
    }
  }

  function submitSimulationOrder(side: OrderSide): void {
    if (!selectedInstrument || !snapshot) {
      setError('시뮬레이션할 종목과 현재가를 먼저 확인하세요.');
      return;
    }
    if (!Number.isFinite(simulationQuantityNumber) || simulationQuantityNumber <= 0) {
      setError('시뮬레이션 수량은 0보다 커야 합니다.');
      return;
    }

    const notional = simulationQuantityNumber * snapshot.price;
    if (side === 'buy') {
      if (notional > simulationCash) {
        setError('시뮬레이션 현금이 부족합니다.');
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
      setError('시뮬레이션 보유 수량이 부족합니다.');
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
      <header className="app__header">
        <div>
          <span className="app__eyebrow">야간 지표 · 뉴스 · 출처 터미널</span>
          <h1>Night Market Monitor</h1>
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
          <span className="mode-chip">조회 전용</span>
          <span className="freshness-chip" data-tone={quoteFreshnessTone}>{quoteFreshnessLabel}</span>
          <span className="freshness-chip" data-tone={tradeFreshnessTone}>{tradeFreshnessLabel}</span>
          <button
            className="status-refresh"
            disabled={quoteTargetIds.length === 0 || isQuoteRefreshing}
            onClick={() => refreshVisibleQuotes(false)}
            title="보이는 종목 시세 즉시 갱신"
            type="button"
          >
            {isQuoteRefreshing ? '갱신중' : '갱신'}
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

      {error && <div className="app__error">{error}</div>}

      <div className={`app__body app__body--${activePage}`}>
        <main className={`chart-panel chart-panel--${activePage}`}>
          {activePage !== 'portfolio' ? (
          <div className="chart-commandbar">
            <div className="chart-commandbar__symbol">
              <span>{selectedInstrument?.country ?? '-'}</span>
              <strong>{selectedName || '-'}</strong>
              <small>{selectedInstrument ? marketLabel(selectedInstrument) : '-'}</small>
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
                          <em style={{ color: signColor(resultSnapshot?.sign) }}>
                            {resultSnapshot
                              ? `${formatPrice(resultSnapshot.price)} · ${formatRate(resultSnapshot.changeRate)}`
                              : '-'}
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
              <button onClick={() => runChartCommand('zoomIn')} title="차트 확대 (+)" type="button">+</button>
              <button onClick={() => runChartCommand('zoomOut')} title="차트 축소 (-)" type="button">−</button>
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
                title="최근/관심 종목 비교 (C)"
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
                <strong>포트폴리오</strong>
              </div>
              <small>{activeTradingAccount?.label ?? '계정 대기'} · {formatMoney(activeTradingAccount?.cashBalance, activeTradingAccount?.baseCurrency)}</small>
            </div>
          )}

          {activePage !== 'portfolio' && recentInstruments.length > 0 && (
            <div className="recent-symbols" role="tablist" aria-label="최근 종목">
              <span className="recent-symbols__label">최근</span>
              {recentInstruments.map((instrument) => {
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
                    <span>{instrument.symbol}</span>
                    <strong>{instrument.name}</strong>
                    <em style={{ color: signColor(recentSnapshot?.sign) }}>
                      {recentSnapshot
                        ? `${formatPrice(recentSnapshot.price)} ${formatRate(recentSnapshot.changeRate)}`
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

          {activePage === 'market' && showComparePanel && (
            <div className="comparison-strip" aria-label="종목 비교">
              <span className="comparison-strip__label">비교</span>
              {comparisonItems.map((instrument) => {
                const comparisonTrade =
                  instrument.country === 'KR' ? stream.trades[instrument.providerSymbol] : undefined;
                const comparisonQuote = quotesByCode[instrument.id];
                const comparisonSnapshot = toSnapshot(
                  comparisonTrade,
                  comparisonQuote,
                );
                const comparisonSource = quoteSourceForInstrument(instrument, comparisonTrade, comparisonQuote);
                return (
                  <button
                    key={instrument.id}
                    onClick={() => selectInstrument(instrument)}
                    title={`${instrument.name} ${marketLabel(instrument)}`}
                    type="button"
                  >
                    <strong>{instrument.symbol}</strong>
                    <span>{instrument.name}</span>
                    <em style={{ color: signColor(comparisonSnapshot?.sign) }}>
                      {comparisonSnapshot
                        ? `${formatPrice(comparisonSnapshot.price)} · ${formatRate(comparisonSnapshot.changeRate)}`
                        : '-'}
                    </em>
                    <small data-source={comparisonSource}>{comparisonSource}</small>
                  </button>
                );
              })}
              {comparisonItems.length === 0 && (
                <p>최근 종목이나 관심종목을 선택하면 비교할 수 있습니다</p>
              )}
            </div>
          )}

          {activePage === 'terminal' && (
            <section className="terminal-board" aria-label="야간 지표 터미널">
              <div className="terminal-board__hero">
                <div>
                  <span>야간 지표 · 조회 전용</span>
                  <h2>야간 지표 터미널</h2>
                  <p>국내 야간선물, GDR 환산가, 원자재와 관련 뉴스를 한 화면에서 확인합니다.</p>
                </div>
                <div className="terminal-board__hero-metric" data-tone={selectedTone}>
                  <span>{selectedInstrument ? assetTypeLabel(selectedInstrument.assetType) : '선택 대기'}</span>
                  <strong>{snapshot ? formatPrice(snapshot.price) : '-'}</strong>
                  <em>{snapshot ? `${formatSignedPrice(snapshot.change)} · ${formatRate(snapshot.changeRate)}` : '탐색에서 지표를 선택하세요'}</em>
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
                        type="button"
                      >
                        <span>{assetTypeLabel(instrument.assetType)}</span>
                        <strong>{instrument.name}</strong>
                        <em>{itemSnapshot ? formatPrice(itemSnapshot.price) : '-'}</em>
                        <small>{itemSnapshot ? formatRate(itemSnapshot.changeRate) : '조회 대기'}</small>
                      </button>
                    );
                  })}
                  {terminalItems.length === 0 && (
                    <p>터미널 지표를 불러오는 중입니다</p>
                  )}
                </div>
              </section>

              <section className="terminal-news-ticker" aria-label="뉴스 ticker">
                <strong>뉴스 ticker</strong>
                <div>
                  {terminalNewsCards.slice(0, 4).map((item) => (
                    <a href={item.url} key={item.id} rel="noreferrer" target="_blank">
                      <span>{item.source}</span>
                      <em>{item.title}</em>
                    </a>
                  ))}
                </div>
              </section>

              <nav className="terminal-tabs" aria-label="터미널 기능">
                {TERMINAL_TAB_OPTIONS.map((option) => (
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
                    <span>{selectedNews.length > 0 ? `선택 종목 ${selectedNews.length}건` : '검색 기반 fallback'}</span>
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
                      <span>자동 큐레이션</span>
                      <strong>뉴스룸</strong>
                    </div>
                    <small>{filteredTerminalNews.length}건 · {selectedInstrument?.name ?? '시장 전체'}</small>
                  </div>
                  <div className="terminal-news-tools">
                    <button type="button">알림 대기</button>
                    <button type="button">음성 읽기</button>
                    <button type="button">공유 링크</button>
                    <button onClick={() => setTerminalTab('chat')} type="button">채팅 보기</button>
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
                    {filteredTerminalNews.slice(0, 3).map((item) => (
                      <a href={item.url} key={item.id} rel="noreferrer" target="_blank">
                        <span>{item.score}</span>
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
                  <div className="terminal-kpi-row">
                    {macroCoreItems.map((item) => (
                      <button
                        data-tone={moveTone(item.snapshot?.sign)}
                        key={item.key}
                        onClick={() => item.instrument && selectInstrument(item.instrument)}
                        type="button"
                      >
                        <span>{item.label}</span>
                        <strong>{item.snapshot ? formatPrice(item.snapshot.price) : (item.fallback ?? '-')}</strong>
                        <em>{item.snapshot ? formatRate(item.snapshot.changeRate) : item.detail}</em>
                      </button>
                    ))}
                  </div>
                  <div className="terminal-macro-grid">
                    {macroBoardGroups.map((group) => (
                      <section className="terminal-panel" key={group.label}>
                        <div className="terminal-panel__header">
                          <strong>{group.label}</strong>
                          <span>{group.items.filter((item) => item.snapshot).length}/{group.items.length}</span>
                        </div>
                        <div className="terminal-macro-list">
                          {group.items.map((item) => (
                            <button
                              data-tone={moveTone(item.snapshot?.sign)}
                              disabled={!item.instrument}
                              key={item.key}
                              onClick={() => item.instrument && selectInstrument(item.instrument)}
                              type="button"
                            >
                              <span>{item.label}</span>
                              <strong>{item.snapshot ? formatPrice(item.snapshot.price) : (item.fallback ?? '-')}</strong>
                              <em>{item.snapshot ? formatRate(item.snapshot.changeRate) : item.detail}</em>
                            </button>
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                </section>
              )}

              {terminalTab === 'calendar' && (
                <section className="terminal-page terminal-page--calendar" aria-label="경제 캘린더">
                  <div className="terminal-page__header">
                    <div>
                      <span>KST · 2026년 7월</span>
                      <strong>경제 캘린더</strong>
                    </div>
                    <small>다가오는 일정 {upcomingEvents.length}건</small>
                  </div>
                  <div className="terminal-filterbar" role="tablist" aria-label="캘린더 필터">
                    {CALENDAR_REGION_OPTIONS.map((option) => (
                      <button
                        aria-selected={calendarRegionFilter === option.key}
                        key={option.key}
                        onClick={() => setCalendarRegionFilter(option.key)}
                        role="tab"
                        type="button"
                      >
                        {option.label}
                      </button>
                    ))}
                    {CALENDAR_IMPACT_OPTIONS.map((option) => (
                      <button
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
                  <div className="terminal-calendar-grid">
                    {calendarEvents.map((event) => (
                      <article data-impact={event.impact} key={`${event.date}-${event.title}`}>
                        <span>{formatEventDay(event.date)} · {event.time}</span>
                        <strong>{event.title}</strong>
                        <em>{event.region} · 중요도 {event.impact}</em>
                      </article>
                    ))}
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
                <section className="terminal-page terminal-page--reports" aria-label="가치투자 리포트">
                  <div className="terminal-page__header">
                    <div>
                      <span>마법공식 · 그레이엄 · DCF · 다모다란</span>
                      <strong>가치투자 리포트</strong>
                    </div>
                    <small>{selectedInstrument?.name ?? '종목 선택 대기'}</small>
                  </div>
                  <div className="terminal-report-grid">
                    {selectedReportModels.map((model) => (
                      <article key={model.key}>
                        <span>{model.label}</span>
                        <strong>{model.score}</strong>
                        <em>{model.detail}</em>
                        <i style={{ width: `${model.score}%` }} />
                      </article>
                    ))}
                  </div>
                  <div className="terminal-report-layout">
                    <section className="terminal-panel">
                      <div className="terminal-panel__header">
                        <strong>현재 리포트 요약</strong>
                        <span>{selectedInstrument?.symbol ?? '-'}</span>
                      </div>
                      <p>
                        {selectedInstrument
                          ? `${selectedInstrument.name}의 현재가, 거래량, 변동률을 기준으로 가치 모델 점수를 재계산했습니다. 재무제표 API가 붙기 전까지는 가격 기반 예비 스코어로 표시합니다.`
                          : '종목을 선택하면 가격 기반 예비 리포트를 생성합니다.'}
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
                      <span>시총 상위 종목 · 등락률 시각화</span>
                      <strong>섹터 히트맵</strong>
                    </div>
                    <small>-5% ~ +5% 범위</small>
                  </div>
                  <div className="terminal-heatmap">
                    {HEATMAP_ITEMS.map((item) => (
                      <article
                        data-tone={heatmapTone(item.change)}
                        key={item.symbol}
                        style={{ flexGrow: Number(heatmapArea(item.weight).replace('fr', '')) }}
                      >
                        <strong>{item.name}</strong>
                        <span>{item.symbol} · {item.sector}</span>
                        <em>{formatRate(item.change)}</em>
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
                <section className="terminal-page terminal-page--ranking" aria-label="24시간 인기 종목">
                  <div className="terminal-page__header">
                    <div>
                      <span>최근·관심·터미널 지표 기반</span>
                      <strong>24시간 인기 종목</strong>
                    </div>
                    <small>{popularInstruments.length}개 후보</small>
                  </div>
                  <div className="terminal-ranking-list">
                    {popularInstruments.map((item, index) => (
                      <button
                        data-tone={moveTone(item.snapshot?.sign)}
                        key={item.instrument.id}
                        onClick={() => selectInstrument(item.instrument)}
                        type="button"
                      >
                        <span>#{index + 1}</span>
                        <strong>{item.instrument.name}</strong>
                        <em>{item.snapshot ? formatPrice(item.snapshot.price) : '-'}</em>
                        <small>{item.snapshot ? formatRate(item.snapshot.changeRate) : '조회 대기'}</small>
                      </button>
                    ))}
                    {popularInstruments.length === 0 && <p>시세가 쌓이면 인기 종목을 표시합니다</p>}
                  </div>
                </section>
              )}

              {terminalTab === 'themes' && (
                <section className="terminal-page terminal-page--themes" aria-label="테마와 도미넌스">
                  <div className="terminal-page__header">
                    <div>
                      <span>시장 도미넌스 · 테마 흐름</span>
                      <strong>테마 보드</strong>
                    </div>
                    <small>상승 {themeBreadth.up} · 하락 {themeBreadth.down}</small>
                  </div>
                  <div className="terminal-dominance">
                    <div>
                      <span>삼닉 관심도</span>
                      <strong>36%</strong>
                      <em>반도체 테마 내 거래대금 비중 추정</em>
                    </div>
                    <div>
                      <span>시장 폭</span>
                      <strong>{themeBreadth.up}/{themeBreadth.total}</strong>
                      <em>주요 테마 상승 우위</em>
                    </div>
                    <div>
                      <span>상위 테마</span>
                      <strong>{THEME_FLOW_ITEMS[0]?.name}</strong>
                      <em>{THEME_FLOW_ITEMS[0]?.leader}</em>
                    </div>
                  </div>
                  <div className="terminal-theme-list">
                    {THEME_FLOW_ITEMS.map((item) => (
                      <article data-tone={feeImpactTone(item.change)} key={item.name}>
                        <div>
                          <strong>{item.name}</strong>
                          <span>{item.leader}</span>
                        </div>
                        <em>{item.score}</em>
                        <small>{formatRate(item.change)}</small>
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
                      <span>국내주식 왕복 거래 기준</span>
                      <strong>수수료 비교 계산기</strong>
                    </div>
                    <small>{feeMarketOption.label} · {feeMarketOption.unit}</small>
                  </div>
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
                      <span>최저 비용</span>
                      <strong>{bestFeeRow ? bestFeeRow.broker.name : '-'}</strong>
                      <em>{bestFeeRow ? `${formatPrice(Math.round(bestFeeRow.totalFee))}원` : '-'}</em>
                    </div>
                    <div>
                      <span>최고 비용</span>
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
                        <strong>{index === 0 ? 'BEST ' : ''}{row.broker.name}<em>{row.broker.product}</em></strong>
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
                      <span>트레이더 쓰레드 피드</span>
                      <strong>라운지</strong>
                    </div>
                    <small>읽기 전용 샘플</small>
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
                <section className="terminal-page terminal-page--chat" aria-label="실시간 채팅">
                  <div className="terminal-page__header">
                    <div>
                      <span>라이브 룸 · 읽기 전용</span>
                      <strong>실시간 채팅</strong>
                    </div>
                    <small>인증·신고 도구 연동 전</small>
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
                <section className="terminal-page terminal-page--simulation" aria-label="테스트매매">
                  <div className="terminal-page__header">
                    <div>
                      <span>실매매 전 단계</span>
                      <strong>테스트매매 시뮬레이션</strong>
                    </div>
                    <small>{formatSignedPrice(Math.round(simulationPnl))} pt</small>
                  </div>
                  <div className="terminal-sim-metrics">
                    <div>
                      <span>총 평가</span>
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
                        <strong>가상 주문</strong>
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
                          <strong>{snapshot ? formatPrice(snapshot.price) : '-'}</strong>
                        </div>
                        <div>
                          <span>보유</span>
                          <strong>{simulationSelectedPosition ? formatPrice(simulationSelectedPosition.quantity) : '0'}</strong>
                        </div>
                        <button onClick={() => submitSimulationOrder('buy')} type="button">가상 매수</button>
                        <button onClick={() => submitSimulationOrder('sell')} type="button">가상 매도</button>
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
                        {simulationPositions.length === 0 && <p>가상 매수하면 포지션이 표시됩니다</p>}
                      </div>
                    </section>
                  </div>
                  <section className="terminal-panel">
                    <div className="terminal-panel__header">
                      <strong>리더보드</strong>
                      <span>내 순위는 로컬 평가 기준</span>
                    </div>
                    <div className="terminal-leaderboard">
                      <div>
                        <span>#0</span>
                        <strong>my-simulation</strong>
                        <em>{formatSignedPrice(Math.round(simulationPnl))} pt</em>
                        <small>{simulationPositions.length}개 보유</small>
                      </div>
                      {SIMULATION_LEADERS.map((leader) => (
                        <div key={leader.rank}>
                          <span>#{leader.rank}</span>
                          <strong>{leader.name}</strong>
                          <em>{formatSignedPrice(leader.pnl)} pt</em>
                          <small>{leader.trades}회 · 승률 {leader.winRate}%</small>
                        </div>
                      ))}
                    </div>
                  </section>
                </section>
              )}
            </section>
          )}

          {activePage !== 'portfolio' && <section className="quote-header">
            <div className="quote-header__identity">
              <div className="quote-header__symbol-row">
                <span className="quote-header__code">{selectedInstrument?.symbol ?? '-'}</span>
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
              <strong>{snapshot ? formatPrice(snapshot.price) : '-'}</strong>
              {snapshot && (
                <span>
                  {formatSignedPrice(snapshot.change)} ({formatRate(snapshot.changeRate)})
                </span>
              )}
              {snapshot && (
                <div className="quote-header__price-context">
                  <em data-tone={snapshot.price >= snapshot.open ? 'up' : 'down'}>
                    시가대비 {openChange !== undefined ? formatSignedPrice(openChange) : '-'}
                    {openChangeRate !== undefined ? ` (${formatRate(openChangeRate)})` : ''}
                  </em>
                  {dayRangePosition !== null && <em>범위 {Math.round(dayRangePosition)}%</em>}
                </div>
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
          </section>}

          {activePage !== 'portfolio' && <section className="market-strip" aria-label="종목 상세 정보">
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
                {dayRangePosition !== null && <span style={{ left: `${dayRangePosition}%` }} />}
              </div>
            </div>
            <div className="market-strip__item">
              <span>현지시간</span>
              <strong>{marketSession.localTime}</strong>
              <small>{quoteRefreshAt ? `갱신 ${formatClock(quoteRefreshAt)}` : '갱신 대기'}</small>
            </div>
          </section>}

          {activePage === 'trade' && <section className="order-ticket" aria-label="매매 주문 티켓">
            <div className="order-ticket__header">
              <div>
                <span>주문 티켓</span>
                <strong>{selectedInstrument ? `${selectedInstrument.symbol} · ${selectedInstrument.name}` : '종목 미선택'}</strong>
              </div>
              <div className="order-ticket__account">
                <em>{activeTradingAccount?.label ?? '계정 대기'}</em>
                <span>{activeTradingAccount?.mode === 'paper' ? 'PAPER' : 'LIVE 잠금'}</span>
              </div>
            </div>
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
                  <option value="market">시장가</option>
                  <option value="limit">지정가</option>
                </select>
                <select
                  aria-label="주문 유효기간"
                  onChange={(event) => setOrderTimeInForce(event.target.value as OrderTimeInForce)}
                  value={orderTimeInForce}
                >
                  <option value="day">DAY</option>
                  <option value="ioc">IOC</option>
                </select>
                <label>
                  <span>수량</span>
                  <input
                    min="0"
                    onChange={(event) => setOrderQuantity(event.target.value)}
                    step="1"
                    type="number"
                    value={orderQuantity}
                  />
                </label>
                <label>
                  <span>지정가</span>
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
                </div>
                <div>
                  <span>예상 주문액</span>
                  <strong>{formatMoney(orderEstimatedNotional, selectedInstrument?.currency)}</strong>
                </div>
                <div>
                  <span>주문 가능</span>
                  <strong>{formatMoney(activeTradingAccount?.buyingPower, activeTradingAccount?.baseCurrency)}</strong>
                </div>
                <div>
                  <span>보유 수량</span>
                  <strong>{selectedPosition ? formatNumber(selectedPosition.quantity) : '-'}</strong>
                </div>
              </div>
              <div className="order-ticket__risk">
                <label className="order-ticket__ack">
                  <input
                    checked={orderAcknowledged}
                    onChange={(event) => setOrderAcknowledged(event.target.checked)}
                    type="checkbox"
                  />
                  <span>paper 주문이며 실계좌로 전송되지 않음을 확인했습니다.</span>
                </label>
                <div className="order-ticket__messages">
                  {orderRiskMessages.length === 0 ? (
                    <em data-tone="ok">주문 의도 생성 가능</em>
                  ) : (
                    orderRiskMessages.map((message) => <em key={message}>{message}</em>)
                  )}
                </div>
              </div>
              <button
                className="order-ticket__submit"
                disabled={!orderCanSubmit}
                onClick={() => void submitOrderIntent()}
                type="button"
              >
                {isOrderSubmitting ? '처리 중' : orderType === 'market' ? 'Paper 즉시 체결' : 'Paper 주문 저장'}
              </button>
            </div>
            {tradingOverview && (
              <div className="order-ticket__recent" aria-label="최근 주문 의도">
                <span>최근 주문</span>
                {tradingOverview.recentOrders.slice(0, 3).map((order) => (
                  <div key={order.id}>
                    <strong>{order.instrument.symbol}</strong>
                    <em data-status={order.status}>{orderStatusLabel(order.status)}</em>
                    <span>
                      {order.side === 'buy' ? '매수' : '매도'} {formatNumber(order.quantity)} ·{' '}
                      {formatMoney(order.estimatedNotional, order.currency)}
                    </span>
                  </div>
                ))}
                {tradingOverview.recentOrders.length === 0 && <strong>저장된 주문 없음</strong>}
                <span>최근 체결</span>
                {tradingOverview.recentFills.slice(0, 3).map((fill) => (
                  <div key={fill.id}>
                    <strong>{fill.instrument.symbol}</strong>
                    <em data-status="filled">체결</em>
                    <span>
                      {fill.side === 'buy' ? '매수' : '매도'} {formatNumber(fill.quantity)} ·{' '}
                      {formatMoney(fill.notional, fill.currency)}
                    </span>
                  </div>
                ))}
                {tradingOverview.recentFills.length === 0 && <strong>체결 없음</strong>}
              </div>
            )}
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
                    최신 {formatPrice(tapeTrades[0].price)} · {formatRate(tapeTrades[0].changeRate)}
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
                        <em style={{ color: signColor(trade.sign) }}>{formatPrice(trade.price)}</em>
                        {tradeRangePosition !== null && (
                          <span
                            aria-label={`당일 저가 ${formatPrice(trade.low)}, 고가 ${formatPrice(trade.high)} 범위 내 ${Math.round(tradeRangePosition)}% 위치`}
                            className="trade-tape__range"
                            title={`저가 ${formatPrice(trade.low)} · 고가 ${formatPrice(trade.high)}`}
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
            <span className="bottom-dock__status">
              조회 전용 세션 · 시세 갱신 {formatClock(quoteRefreshAt)} · {quoteFreshnessLabel}
            </span>
          </div>}

          {activePage === 'portfolio' && (
            <section className="portfolio-page" aria-label="포트폴리오">
              <section className="portfolio-card portfolio-card--wide" aria-label="KIS 실계좌 조회">
                <div className="portfolio-card__header">
                  <div>
                    <strong>KIS 실계좌</strong>
                    <span>
                      {kisAccountSnapshot?.accountLabel ?? '조회 대기'} ·{' '}
                      {kisAccountSnapshot?.updatedAt ? `갱신 ${formatClock(kisAccountSnapshot.updatedAt)}` : '미갱신'}
                    </span>
                  </div>
                  <button
                    className="portfolio-card__refresh"
                    disabled={isKisAccountRefreshing}
                    onClick={refreshKisAccountSnapshot}
                    type="button"
                  >
                    {isKisAccountRefreshing ? '조회 중' : '새로고침'}
                  </button>
                </div>
                {kisAccountSnapshot?.configured ? (
                  <>
                    <div className="portfolio-page__metrics portfolio-page__metrics--broker">
                      <div>
                        <span>예수금</span>
                        <strong>{formatMoney(kisAccountSnapshot.cashBalance, kisAccountSnapshot.baseCurrency)}</strong>
                      </div>
                      <div>
                        <span>총 평가</span>
                        <strong>{formatMoney(kisAccountSnapshot.totalEvaluation, kisAccountSnapshot.baseCurrency)}</strong>
                      </div>
                      <div>
                        <span>주식 평가</span>
                        <strong>{formatMoney(kisAccountSnapshot.stockEvaluation, kisAccountSnapshot.baseCurrency)}</strong>
                      </div>
                      <div>
                        <span>평가 손익</span>
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
                      {kisAccountSnapshot.positions.slice(0, 16).map((position) => (
                        <div className="portfolio-table__row" key={position.symbol}>
                          <strong>{position.symbol}</strong>
                          <span>{formatNumber(position.quantity)}</span>
                          <span>{formatMoney(position.averagePrice, position.currency)}</span>
                          <span>{formatMoney(position.currentPrice, position.currency)}</span>
                          <span>{formatMoney(position.unrealizedPnl, position.currency)}</span>
                        </div>
                      ))}
                      {kisAccountPositionCount === 0 && <div className="portfolio-table__empty">실계좌 보유 종목 없음</div>}
                    </div>
                  </>
                ) : (
                  <div className="portfolio-table__empty">
                    {kisAccountSnapshot?.message ?? 'KIS 계좌 조회 설정을 확인하는 중입니다'}
                  </div>
                )}
              </section>

              <div className="portfolio-page__metrics">
                <div>
                  <span>현금</span>
                  <strong>{formatMoney(activeTradingAccount?.cashBalance, activeTradingAccount?.baseCurrency)}</strong>
                </div>
                <div>
                  <span>주문 가능</span>
                  <strong>{formatMoney(activeTradingAccount?.buyingPower, activeTradingAccount?.baseCurrency)}</strong>
                </div>
                <div>
                  <span>보유 종목</span>
                  <strong>{portfolioPositionCount}개</strong>
                </div>
                <div>
                  <span>평가 기준액</span>
                  <strong>{formatMoney(portfolioMarketValue, activeTradingAccount?.baseCurrency)}</strong>
                </div>
                <div>
                  <span>최근 체결액</span>
                  <strong>{formatMoney(recentFillTotal, activeTradingAccount?.baseCurrency)}</strong>
                </div>
              </div>

              <div className="portfolio-page__grid">
                <section className="portfolio-card" aria-label="보유 포지션">
                  <div className="portfolio-card__header">
                    <strong>보유 포지션</strong>
                    <span>{portfolioPositionCount}개</span>
                  </div>
                  <div className="portfolio-table portfolio-table--positions">
                    <div className="portfolio-table__head">
                      <span>종목</span>
                      <span>수량</span>
                      <span>평균단가</span>
                      <span>현재가</span>
                      <span>평가금액</span>
                    </div>
                    {tradingOverview?.positions.map((position) => {
                      const positionSnapshot = getSnapshotForInstrument(position.instrument);
                      const markPrice = positionSnapshot?.price ?? position.averagePrice;
                      return (
                        <button
                          className="portfolio-table__row"
                          key={position.id}
                          onClick={() => {
                            selectInstrument(position.instrument);
                            setActivePage('trade');
                          }}
                          type="button"
                        >
                          <strong>{position.instrument.symbol}</strong>
                          <span>{formatNumber(position.quantity)}</span>
                          <span>{formatMoney(position.averagePrice, position.currency)}</span>
                          <span>{formatMoney(markPrice, position.currency)}</span>
                          <span>{formatMoney(position.quantity * markPrice, position.currency)}</span>
                        </button>
                      );
                    })}
                    {portfolioPositionCount === 0 && <div className="portfolio-table__empty">보유 포지션 없음</div>}
                  </div>
                </section>

                <section className="portfolio-card" aria-label="최근 주문">
                  <div className="portfolio-card__header">
                    <strong>최근 주문</strong>
                    <span>{tradingOverview?.recentOrders.length ?? 0}건</span>
                  </div>
                  <div className="portfolio-table portfolio-table--orders">
                    <div className="portfolio-table__head">
                      <span>상태</span>
                      <span>종목</span>
                      <span>방향</span>
                      <span>수량</span>
                      <span>주문액</span>
                    </div>
                    {tradingOverview?.recentOrders.slice(0, 12).map((order) => (
                      <button
                        className="portfolio-table__row"
                        key={order.id}
                        onClick={() => {
                          selectInstrument(order.instrument);
                          setActivePage('trade');
                        }}
                        type="button"
                      >
                        <em data-status={order.status}>{orderStatusLabel(order.status)}</em>
                        <strong>{order.instrument.symbol}</strong>
                        <span>{order.side === 'buy' ? '매수' : '매도'}</span>
                        <span>{formatNumber(order.quantity)}</span>
                        <span>{formatMoney(order.estimatedNotional, order.currency)}</span>
                      </button>
                    ))}
                    {(!tradingOverview || tradingOverview.recentOrders.length === 0) && (
                      <div className="portfolio-table__empty">주문 기록 없음</div>
                    )}
                  </div>
                </section>

                <section className="portfolio-card portfolio-card--wide" aria-label="최근 체결">
                  <div className="portfolio-card__header">
                    <strong>최근 체결</strong>
                    <span>{tradingOverview?.recentFills.length ?? 0}건</span>
                  </div>
                  <div className="portfolio-table portfolio-table--fills">
                    <div className="portfolio-table__head">
                      <span>종목</span>
                      <span>방향</span>
                      <span>수량</span>
                      <span>체결가</span>
                      <span>체결액</span>
                    </div>
                    {tradingOverview?.recentFills.slice(0, 16).map((fill) => (
                      <button
                        className="portfolio-table__row"
                        key={fill.id}
                        onClick={() => {
                          selectInstrument(fill.instrument);
                          setActivePage('trade');
                        }}
                        type="button"
                      >
                        <strong>{fill.instrument.symbol}</strong>
                        <span>{fill.side === 'buy' ? '매수' : '매도'}</span>
                        <span>{formatNumber(fill.quantity)}</span>
                        <span>{formatMoney(fill.price, fill.currency)}</span>
                        <span>{formatMoney(fill.notional, fill.currency)}</span>
                      </button>
                    ))}
                    {(!tradingOverview || tradingOverview.recentFills.length === 0) && (
                      <div className="portfolio-table__empty">체결 기록 없음</div>
                    )}
                  </div>
                </section>
              </div>
            </section>
          )}
        </main>

        {(activePage === 'market' || activePage === 'trade') && <aside className={`watchlist${isWatchlistCollapsed ? ' is-collapsed' : ''}${isCompactList ? ' is-compact-list' : ''}`}>
          <div className="watchlist__header">
            <div>
              <strong>{sidePanelTab === 'watch' ? '관심종목' : '종목 탐색'}</strong>
              <span>
                {sidePanelTab === 'watch'
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
          {sidePanelTab === 'watch' && <div className="watchlist__summary" aria-label="관심종목 요약">
            <div className="watchlist__summary-counts">
              <span data-tone="up">상승 {watchlistSummary.up}</span>
              <span data-tone="down">하락 {watchlistSummary.down}</span>
              <span>보합 {watchlistSummary.flat}</span>
              <span>대기 {watchlistSummary.waiting}</span>
            </div>
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
          {sidePanelTab === 'watch' && <div className="watchlist__section-title">
            <strong>현재 그룹</strong>
            <div className="watchlist__section-meta">
              <div className="watchlist__filter-chips" aria-label="현재 리스트 필터">
                {watchFilterChips.map((chip) => (
                  <em key={chip}>{chip}</em>
                ))}
              </div>
              <span>{filteredWatchlist.length} / {watchlist.length}</span>
            </div>
          </div>}
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
              <span>
                {categoryQuoteProgress.loaded}/{categoryQuoteProgress.total} 반영 ·{' '}
                {isQuoteRefreshing ? `갱신 중 ${categoryQuoteProgress.requested}개` : '화면 근처 우선'}
              </span>
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
