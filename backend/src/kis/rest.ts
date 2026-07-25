import { config, type KisAccountConfig } from '../config.js';
import { getAccessToken, primaryCredentials, type KisCredentials } from './auth.js';
import type {
  BrokerAccountSnapshot,
  BrokerExecution,
  BrokerExecutionSnapshot,
  BrokerExecutionStatus,
  BrokerAmendableOrder,
  BrokerOrderability,
  BrokerPosition,
  BrokerReservedOrder,
  BrokerSellability,
  BrokerTradeProfitRow,
  BrokerTradeProfitSnapshot,
  OrderSide,
  Candle,
  CandlesResponse,
  ExchangeRate,
  Instrument,
  NewsItem,
  OrderType,
  PriceSign,
  Quote,
} from '@invest/shared';

/**
 * KIS REST POST 공통 헬퍼. 주문 계열은 전부 POST이고 파라미터를 body로 보낸다.
 * GET과 달리 `hashkey` 헤더는 필수가 아니며, 생략해도 정상 접수된다.
 */
async function kisPost(
  path: string,
  trId: string,
  body: Record<string, string>,
  credentials: KisCredentials,
): Promise<Record<string, unknown>> {
  const token = await getAccessToken(credentials);
  // 주문은 재시도하지 않는다. 중복 접수 위험이 조회 실패보다 훨씬 크다.
  return scheduleKisCall(async () => {
    const res = await fetch(config.restBase + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: credentials.appKey,
        appsecret: credentials.appSecret,
        tr_id: trId,
        custtype: config.custType,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`KIS POST ${path} 실패 (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as Record<string, unknown>;
  });
}

/** KIS 초당 호출 한도 초과 코드. 잔고·체결·손익을 한 화면에서 동시에 부르면 쉽게 걸린다. */
const KIS_RATE_LIMIT_CODE = 'EGW00201';
const KIS_MIN_CALL_GAP_MS = 70;
const KIS_RATE_LIMIT_BACKOFF_MS = 400;

let kisCallChain: Promise<unknown> = Promise.resolve();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * KIS REST 호출을 한 줄로 세워 최소 간격을 둔다.
 * 포트폴리오 화면이 계좌·체결·예약주문·매매손익을 동시에 띄우면 초당 한도에 걸려
 * 일부 카드만 502로 비는 일이 생긴다. 순서를 지키는 대신 조금 느리게 간다.
 */
function scheduleKisCall<T>(run: () => Promise<T>): Promise<T> {
  const result = kisCallChain.then(run, run);
  kisCallChain = result.then(
    () => delay(KIS_MIN_CALL_GAP_MS),
    () => delay(KIS_MIN_CALL_GAP_MS),
  );
  return result;
}

function isRateLimited(body: Record<string, unknown>): boolean {
  return String(body.msg_cd ?? '') === KIS_RATE_LIMIT_CODE;
}

/** KIS REST GET 공통 헬퍼. tr_id별로 헤더/인증을 채워 호출한다. */
async function kisGet(
  path: string,
  trId: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  return (await kisGetWithHeaders(path, trId, params)).body;
}

async function kisGetWithHeaders(
  path: string,
  trId: string,
  params: Record<string, string>,
  trCont = '',
  credentials: KisCredentials = primaryCredentials,
): Promise<{ body: Record<string, unknown>; headers: Headers }> {
  const token = await getAccessToken(credentials);
  const url = new URL(config.restBase + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    appkey: credentials.appKey,
    appsecret: credentials.appSecret,
    tr_id: trId,
    custtype: config.custType,
  };
  if (trCont) headers.tr_cont = trCont;

  async function callOnce(): Promise<{ body: Record<string, unknown>; headers: Headers }> {
    const res = await fetch(url, { headers: { ...headers } });
    if (!res.ok) {
      throw new Error(`KIS GET ${path} 실패 (${res.status}): ${await res.text()}`);
    }
    return { body: (await res.json()) as Record<string, unknown>, headers: res.headers };
  }

  const first = await scheduleKisCall(callOnce);
  // 한도에 걸리면 잠시 쉬고 한 번만 더 시도한다. 계속 두드리면 더 오래 막힌다.
  if (!isRateLimited(first.body)) return first;
  await delay(KIS_RATE_LIMIT_BACKOFF_MS);
  return scheduleKisCall(callOnce);
}

function yyyymmdd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function toNumber(value: string | undefined): number {
  return Number(value?.replace(/,/g, ''));
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function parseSign(value: string | undefined): PriceSign {
  if (value === '1' || value === '2' || value === '3' || value === '4' || value === '5') {
    return value;
  }
  return '3';
}

function signFromChange(change: number): PriceSign {
  if (change > 0) return '2';
  if (change < 0) return '5';
  return '3';
}

function requireNumber(value: string | undefined, field: string): number {
  const n = toNumber(value);
  if (!Number.isFinite(n)) {
    throw new Error(`현재가 응답 숫자 필드가 올바르지 않습니다: ${field}`);
  }
  return n;
}

function optionalNumber(value: string | undefined): number | null {
  const n = toNumber(value);
  return Number.isFinite(n) ? n : null;
}

function maskKisAccount(cano: string, productCode: string): string {
  return `****${cano.slice(-4)}-${productCode}`;
}

const MISSING_ACCOUNT_MESSAGE =
  'KIS 계좌 설정이 없습니다. KIS_<id>_ACCOUNT_NO / KIS_APP_KEY_<id> / KIS_APP_SECRET_<id>를 함께 채워주세요.';

/** 계좌 조회는 그 계좌가 등록된 앱키로만 가능하다. 계좌 설정에서 자격증명만 뽑아 쓴다. */
function toCredentials(account: KisAccountConfig): KisCredentials {
  return { id: account.id, appKey: account.appKey, appSecret: account.appSecret };
}

/**
 * 일봉 시세 (국내주식 기간별시세, tr_id: FHKST03010100).
 * output1에서 종목명, output2에서 최근 캔들 배열(내림차순)을 얻어 오름차순으로 정규화한다.
 */
export async function getDailyCandles(code: string, days = 120): Promise<CandlesResponse> {
  const end = new Date();
  const start = new Date();
  // 주말·공휴일을 감안해 여유 있게 과거로 잡는다.
  start.setDate(start.getDate() - Math.ceil(days * 1.7));

  const json = await kisGet(
    '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice',
    'FHKST03010100',
    {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: yyyymmdd(start),
      FID_INPUT_DATE_2: yyyymmdd(end),
      FID_PERIOD_DIV_CODE: 'D',
      FID_ORG_ADJ_PRC: '0', // 0: 수정주가
    },
  );

  const output1 = (json.output1 ?? {}) as Record<string, string>;
  const output2 = (json.output2 ?? []) as Array<Record<string, string>>;
  const name = output1.hts_kor_isnm ?? code;

  const candles: Candle[] = output2
    .filter((r) => r.stck_bsop_date)
    .map((r) => {
      const y = Number(r.stck_bsop_date.slice(0, 4));
      const m = Number(r.stck_bsop_date.slice(4, 6));
      const d = Number(r.stck_bsop_date.slice(6, 8));
      return {
        time: Math.floor(Date.UTC(y, m - 1, d) / 1000),
        open: toNumber(r.stck_oprc),
        high: toNumber(r.stck_hgpr),
        low: toNumber(r.stck_lwpr),
        close: toNumber(r.stck_clpr),
        volume: toNumber(r.acml_vol),
      };
    })
    .filter(
      (c) =>
        Number.isFinite(c.time) &&
        isPositiveFinite(c.open) &&
        isPositiveFinite(c.high) &&
        isPositiveFinite(c.low) &&
        isPositiveFinite(c.close) &&
        isNonNegativeFinite(c.volume ?? 0),
    )
    .sort((a, b) => a.time - b.time);

  return { code, name, candles };
}

function kstToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
}

function kstDateTimeToTimestamp(date: string, time: string): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(4, 6));
  const d = Number(date.slice(6, 8));
  const hh = Number(time.slice(0, 2));
  const mm = Number(time.slice(2, 4));
  return Math.floor(Date.UTC(y, m - 1, d, hh - 9, mm, 0) / 1000);
}

function optionalKstDateTimeToTimestamp(date: string | undefined, time: string | undefined): number | undefined {
  if (!/^\d{8}$/.test(date ?? '') || !/^\d{6}$/.test(time ?? '')) return undefined;
  const timestamp = kstDateTimeToTimestamp(date as string, time as string);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isFutureAssetType(assetType: Instrument['assetType']): boolean {
  return assetType === 'future' || assetType === 'future_spread';
}

interface TradingViewQuote {
  close: number;
  change?: number;
  change_abs?: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  currency?: string;
}

const NIGHT_PROXY_SPECS: Record<
  string,
  { underlyingCode: string; sourceSymbol: string; fxSymbol: string; ratio: number }
> = {
  'KR:NIGHT_PROXY:005930': {
    underlyingCode: '005930',
    sourceSymbol: 'LSE:BC94',
    fxSymbol: 'FX_IDC:USDKRW',
    ratio: 25,
  },
};

const COMMODITY_CANDLE_SPECS: Record<string, Pick<Instrument, 'providerSymbol' | 'exchangeCode'>> = {
  'GLOBAL:TV_COMMODITY:GOLD': { providerSymbol: 'GCQ26', exchangeCode: 'CME' },
  'GLOBAL:TV_COMMODITY:SILVER': { providerSymbol: 'SIU26', exchangeCode: 'CME' },
  'GLOBAL:TV_COMMODITY:WTI': { providerSymbol: 'CLQ26', exchangeCode: 'CME' },
  'GLOBAL:TV_COMMODITY:NATGAS': { providerSymbol: 'NGQ26', exchangeCode: 'CME' },
};

async function fetchTradingViewQuote(symbol: string): Promise<TradingViewQuote> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const url = new URL('https://scanner.tradingview.com/symbol');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('fields', 'close,change,change_abs,open,high,low,volume,currency');

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`TradingView 조회 실패 (${res.status})`);
    }
    const json = (await res.json()) as Partial<TradingViewQuote> & { code?: string; errmsg?: string };
    if (json.code || !Number.isFinite(json.close)) {
      throw new Error(`TradingView 응답이 올바르지 않습니다: ${symbol}`);
    }
    return json as TradingViewQuote;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getUsdKrwExchangeRate(): Promise<ExchangeRate> {
  const quote = await fetchTradingViewQuote('FX_IDC:USDKRW');
  const rate = quote.close;
  const change = Number((quote.change_abs ?? rate - (quote.open ?? rate)).toFixed(4));
  const changeRate = Number((quote.change ?? (quote.open ? change / quote.open * 100 : 0)).toFixed(2));
  return {
    pair: 'USD/KRW',
    baseCurrency: 'USD',
    quoteCurrency: 'KRW',
    rate,
    change,
    changeRate,
    fetchedAt: Date.now(),
  };
}

function convertGdrPrice(price: number | undefined, fx: number, ratio: number): number | undefined {
  if (!Number.isFinite(price ?? NaN)) return undefined;
  return Number(((price as number) * fx / ratio).toFixed(2));
}

function todayUtcSeconds(): number {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
}

/** 국내주식 1분봉 시세 (주식일별분봉조회, tr_id: FHKST03010230). */
async function getDomesticIntradayCandles(instrument: Instrument): Promise<CandlesResponse> {
  const json = await kisGet(
    '/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice',
    'FHKST03010230',
    {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: instrument.providerSymbol,
      FID_INPUT_HOUR_1: '235959',
      FID_INPUT_DATE_1: kstToday(),
      FID_PW_DATA_INCU_YN: 'N',
      FID_FAKE_TICK_INCU_YN: '',
    },
  );

  const output2 = (json.output2 ?? []) as Array<Record<string, string>>;
  const candles: Candle[] = output2
    .filter((r) => /^\d{8}$/.test(r.stck_bsop_date ?? '') && /^\d{6}$/.test(r.stck_cntg_hour ?? ''))
    .map((r) => ({
      time: kstDateTimeToTimestamp(r.stck_bsop_date, r.stck_cntg_hour),
      open: toNumber(r.stck_oprc),
      high: toNumber(r.stck_hgpr),
      low: toNumber(r.stck_lwpr),
      close: toNumber(r.stck_prpr),
      volume: toNumber(r.cntg_vol),
    }))
    .filter(
      (c) =>
        Number.isFinite(c.time) &&
        isPositiveFinite(c.open) &&
        isPositiveFinite(c.high) &&
        isPositiveFinite(c.low) &&
        isPositiveFinite(c.close) &&
        isNonNegativeFinite(c.volume ?? 0),
    )
    .sort((a, b) => a.time - b.time);

  return { code: instrument.id, name: instrument.name, candles };
}

async function getOverseasIntradayCandles(instrument: Instrument): Promise<CandlesResponse> {
  const json = await kisGet('/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice', 'HHDFS76950200', {
    AUTH: '',
    EXCD: instrument.exchangeCode,
    SYMB: instrument.providerSymbol,
    NMIN: '1',
    PINC: '1',
    NEXT: '',
    NREC: '120',
    FILL: '',
    KEYB: '',
  });

  const output2 = (json.output2 ?? []) as Array<Record<string, string>>;
  const candles: Candle[] = output2
    .filter((r) => /^\d{8}$/.test(r.kymd ?? '') && /^\d{6}$/.test(r.khms ?? ''))
    .map((r) => ({
      time: kstDateTimeToTimestamp(r.kymd, r.khms),
      open: toNumber(r.open),
      high: toNumber(r.high),
      low: toNumber(r.low),
      close: toNumber(r.last),
      volume: toNumber(r.evol),
    }))
    .filter(
      (c) =>
        Number.isFinite(c.time) &&
        isPositiveFinite(c.open) &&
        isPositiveFinite(c.high) &&
        isPositiveFinite(c.low) &&
        isPositiveFinite(c.close) &&
        isNonNegativeFinite(c.volume ?? 0),
    )
    .sort((a, b) => a.time - b.time);

  return { code: instrument.id, name: instrument.name, candles };
}

/** 현재가 스냅샷 (주식현재가 시세, tr_id: FHKST01010100). */
export async function getQuote(code: string): Promise<Quote> {
  const json = await kisGet(
    '/uapi/domestic-stock/v1/quotations/inquire-price',
    'FHKST01010100',
    { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code },
  );
  const o = (json.output ?? {}) as Record<string, string>;
  return {
    code,
    price: requireNumber(o.stck_prpr, 'stck_prpr'),
    change: requireNumber(o.prdy_vrss, 'prdy_vrss'),
    changeRate: requireNumber(o.prdy_ctrt, 'prdy_ctrt'),
    sign: parseSign(o.prdy_vrss_sign),
    open: requireNumber(o.stck_oprc, 'stck_oprc'),
    high: requireNumber(o.stck_hgpr, 'stck_hgpr'),
    low: requireNumber(o.stck_lwpr, 'stck_lwpr'),
    accVolume: requireNumber(o.acml_vol, 'acml_vol'),
  };
}

export async function getInstrumentCandles(
  instrument: Instrument,
  days = 120,
): Promise<CandlesResponse> {
  if (instrument.assetType === 'night_proxy') {
    return { code: instrument.id, name: instrument.name, candles: [] };
  }
  if (instrument.assetType === 'commodity') return getCommodityIndicatorCandles(instrument, days);
  if (isFutureAssetType(instrument.assetType)) {
    if (instrument.market === 'OV_FUT') return getOverseasFutureDailyCandles(instrument);
    return getDomesticFutureDailyCandles(instrument, days);
  }
  if (instrument.country === 'KR') {
    const response = await getDailyCandles(instrument.providerSymbol, days);
    return { ...response, code: instrument.id, name: instrument.name };
  }
  return getOverseasDailyCandles(instrument, days);
}

export async function getInstrumentQuote(instrument: Instrument): Promise<Quote> {
  if (instrument.assetType === 'commodity') {
    return getTradingViewInstrumentQuote(instrument);
  }
  if (instrument.assetType === 'night_proxy') {
    return getNightProxyQuote(instrument);
  }
  if (isFutureAssetType(instrument.assetType)) {
    if (instrument.market === 'OV_FUT') return getOverseasFutureQuote(instrument);
    return getDomesticFutureQuote(instrument);
  }
  if (instrument.country === 'KR') {
    const quote = await getQuote(instrument.providerSymbol);
    return { ...quote, code: instrument.id };
  }
  return getOverseasQuote(instrument);
}

async function getCommodityIndicatorCandles(
  instrument: Instrument,
  _days: number,
): Promise<CandlesResponse> {
  const spec = COMMODITY_CANDLE_SPECS[instrument.id];
  if (!spec) return { code: instrument.id, name: instrument.name, candles: [] };
  try {
    const response = await getOverseasFutureDailyCandles({
      ...instrument,
      assetType: 'future',
      market: 'OV_FUT',
      provider: 'kis',
      providerSymbol: spec.providerSymbol,
      exchangeCode: spec.exchangeCode,
    });
    return { ...response, code: instrument.id, name: instrument.name };
  } catch {
    const quote = await fetchTradingViewQuote(instrument.providerSymbol);
    return {
      code: instrument.id,
      name: instrument.name,
      candles: [
        {
          time: todayUtcSeconds(),
          open: quote.open ?? quote.close,
          high: quote.high ?? quote.close,
          low: quote.low ?? quote.close,
          close: quote.close,
          volume: quote.volume ?? 0,
        },
      ],
    };
  }
}

async function getTradingViewInstrumentQuote(instrument: Instrument): Promise<Quote> {
  const quote = await fetchTradingViewQuote(instrument.providerSymbol);
  const price = quote.close;
  const change = Number((quote.change_abs ?? price - (quote.open ?? price)).toFixed(4));
  const changeRate = Number((quote.change ?? (quote.open ? change / quote.open * 100 : 0)).toFixed(2));
  return {
    code: instrument.id,
    price,
    change,
    changeRate,
    sign: signFromChange(change),
    open: quote.open ?? price,
    high: quote.high ?? price,
    low: quote.low ?? price,
    accVolume: Number.isFinite(quote.volume ?? NaN) ? (quote.volume as number) : 0,
  };
}

async function getNightProxyQuote(instrument: Instrument): Promise<Quote> {
  const spec = NIGHT_PROXY_SPECS[instrument.id];
  if (!spec) {
    throw new Error(`지원하지 않는 야간 환산가입니다: ${instrument.id}`);
  }

  const [source, fx, regularQuote] = await Promise.all([
    fetchTradingViewQuote(spec.sourceSymbol),
    fetchTradingViewQuote(spec.fxSymbol),
    getQuote(spec.underlyingCode),
  ]);
  const price = convertGdrPrice(source.close, fx.close, spec.ratio);
  if (!Number.isFinite(price ?? NaN)) {
    throw new Error(`야간 환산가 계산에 실패했습니다: ${instrument.id}`);
  }

  const regularPrice = regularQuote.price;
  const change = Number(((price as number) - regularPrice).toFixed(2));
  const changeRate = regularPrice > 0 ? Number((change / regularPrice * 100).toFixed(2)) : 0;
  const open = convertGdrPrice(source.open, fx.close, spec.ratio) ?? (price as number);
  const high = convertGdrPrice(source.high, fx.close, spec.ratio) ?? (price as number);
  const low = convertGdrPrice(source.low, fx.close, spec.ratio) ?? (price as number);

  return {
    code: instrument.id,
    price: price as number,
    change,
    changeRate,
    sign: signFromChange(change),
    open,
    high,
    low,
    accVolume: Number.isFinite(source.volume ?? NaN) ? (source.volume as number) : 0,
  };
}

/** 국내 선물옵션 현재가 (선물옵션 시세, tr_id: FHMIF10000000). */
async function getDomesticFutureQuote(instrument: Instrument): Promise<Quote> {
  const json = await kisGet(
    '/uapi/domestic-futureoption/v1/quotations/inquire-price',
    'FHMIF10000000',
    {
      FID_COND_MRKT_DIV_CODE: instrument.exchangeCode || 'F',
      FID_INPUT_ISCD: instrument.providerSymbol,
    },
  );
  const o = (json.output1 ?? {}) as Record<string, string>;
  return {
    code: instrument.id,
    price: requireNumber(o.futs_prpr, 'futs_prpr'),
    change: requireNumber(o.futs_prdy_vrss, 'futs_prdy_vrss'),
    changeRate: requireNumber(o.futs_prdy_ctrt, 'futs_prdy_ctrt'),
    sign: parseSign(o.prdy_vrss_sign),
    open: requireNumber(o.futs_oprc, 'futs_oprc'),
    high: requireNumber(o.futs_hgpr, 'futs_hgpr'),
    low: requireNumber(o.futs_lwpr, 'futs_lwpr'),
    accVolume: requireNumber(o.acml_vol, 'acml_vol'),
  };
}

/** 해외선물 현재가 (해외선물종목현재가, tr_id: HHDFC55010000). */
async function getOverseasFutureQuote(instrument: Instrument): Promise<Quote> {
  const json = await kisGet(
    '/uapi/overseas-futureoption/v1/quotations/inquire-price',
    'HHDFC55010000',
    { SRS_CD: instrument.providerSymbol },
  );
  const rows = json.output1;
  const o = (Array.isArray(rows) ? rows[0] : rows ?? {}) as Record<string, string>;
  return {
    code: instrument.id,
    price: requireNumber(o.last_price, 'last_price'),
    change: requireNumber(o.prev_diff_price, 'prev_diff_price'),
    changeRate: requireNumber(o.prev_diff_rate, 'prev_diff_rate'),
    sign: parseSign(o.prev_diff_flag),
    open: requireNumber(o.open_price, 'open_price'),
    high: requireNumber(o.high_price, 'high_price'),
    low: requireNumber(o.low_price, 'low_price'),
    accVolume: requireNumber(o.vol, 'vol'),
  };
}

async function getDomesticFutureDailyCandles(
  instrument: Instrument,
  days: number,
): Promise<CandlesResponse> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - Math.ceil(days * 1.7));

  const json = await kisGet(
    '/uapi/domestic-futureoption/v1/quotations/inquire-daily-fuopchartprice',
    'FHKIF03020100',
    {
      FID_COND_MRKT_DIV_CODE: instrument.exchangeCode || 'F',
      FID_INPUT_ISCD: instrument.providerSymbol,
      FID_INPUT_DATE_1: yyyymmdd(start),
      FID_INPUT_DATE_2: yyyymmdd(end),
      FID_PERIOD_DIV_CODE: 'D',
    },
  );

  const output2 = (json.output2 ?? []) as Array<Record<string, string>>;
  const candles: Candle[] = output2
    .filter((r) => /^\d{8}$/.test(r.stck_bsop_date ?? ''))
    .map((r) => {
      const y = Number(r.stck_bsop_date.slice(0, 4));
      const m = Number(r.stck_bsop_date.slice(4, 6));
      const d = Number(r.stck_bsop_date.slice(6, 8));
      return {
        time: Math.floor(Date.UTC(y, m - 1, d) / 1000),
        open: toNumber(r.futs_oprc),
        high: toNumber(r.futs_hgpr),
        low: toNumber(r.futs_lwpr),
        close: toNumber(r.futs_prpr),
        volume: toNumber(r.acml_vol),
      };
    })
    .filter(
      (c) =>
        Number.isFinite(c.time) &&
        isPositiveFinite(c.open) &&
        isPositiveFinite(c.high) &&
        isPositiveFinite(c.low) &&
        isPositiveFinite(c.close) &&
        isNonNegativeFinite(c.volume ?? 0),
    )
    .sort((a, b) => a.time - b.time);

  return { code: instrument.id, name: instrument.name, candles };
}

async function getOverseasFutureDailyCandles(instrument: Instrument): Promise<CandlesResponse> {
  const json = await kisGet(
    '/uapi/overseas-futureoption/v1/quotations/daily-ccnl',
    'HHDFC55020100',
    {
      SRS_CD: instrument.providerSymbol,
      EXCH_CD: instrument.exchangeCode,
      START_DATE_TIME: '',
      CLOSE_DATE_TIME: yyyymmdd(new Date()),
      QRY_TP: 'Q',
      QRY_CNT: '40',
      QRY_GAP: '',
      INDEX_KEY: '',
    },
  );

  const output2 = (json.output2 ?? []) as Array<Record<string, string>>;
  const candles: Candle[] = output2
    .filter((r) => /^\d{8}$/.test(r.data_date ?? ''))
    .map((r) => {
      const y = Number(r.data_date.slice(0, 4));
      const m = Number(r.data_date.slice(4, 6));
      const d = Number(r.data_date.slice(6, 8));
      return {
        time: Math.floor(Date.UTC(y, m - 1, d) / 1000),
        open: toNumber(r.open_price),
        high: toNumber(r.high_price),
        low: toNumber(r.low_price),
        close: toNumber(r.last_price),
        volume: toNumber(r.vol),
      };
    })
    .filter(
      (c) =>
        Number.isFinite(c.time) &&
        isPositiveFinite(c.open) &&
        isPositiveFinite(c.high) &&
        isPositiveFinite(c.low) &&
        isPositiveFinite(c.close) &&
        isNonNegativeFinite(c.volume ?? 0),
    )
    .sort((a, b) => a.time - b.time);

  return { code: instrument.id, name: instrument.name, candles };
}

export async function getKisDomesticAccountSnapshot(
  account: KisAccountConfig | null,
): Promise<BrokerAccountSnapshot> {
  if (!account) {
    return {
      broker: 'kis',
      configured: false,
      accountId: '',
      accountLabel: 'KIS 계좌 미설정',
      baseCurrency: 'KRW',
      positions: [],
      message: MISSING_ACCOUNT_MESSAGE,
    };
  }

  const trId = config.env === 'prod' ? 'TTTC8434R' : 'VTTC8434R';
  const positions: BrokerPosition[] = [];
  let summary: Record<string, string> = {};
  let fk100 = '';
  let nk100 = '';
  let trCont = '';

  for (let depth = 0; depth < 10; depth += 1) {
    const { body, headers } = await kisGetWithHeaders(
      '/uapi/domestic-stock/v1/trading/inquire-balance',
      trId,
      {
        CANO: account.cano,
        ACNT_PRDT_CD: account.productCode,
        AFHR_FLPR_YN: 'N',
        OFL_YN: '',
        INQR_DVSN: '01',
        UNPR_DVSN: '01',
        FUND_STTL_ICLD_YN: 'N',
        FNCG_AMT_AUTO_RDPT_YN: 'N',
        PRCS_DVSN: '00',
        CTX_AREA_FK100: fk100,
        CTX_AREA_NK100: nk100,
      },
      trCont,
      toCredentials(account),
    );

    if (body.rt_cd && body.rt_cd !== '0') {
      throw new Error(`KIS 주식잔고조회 실패: ${String(body.msg1 ?? body.msg_cd ?? '알 수 없는 오류')}`);
    }

    const output1 = Array.isArray(body.output1) ? (body.output1 as Array<Record<string, string>>) : [];
    const output2 = Array.isArray(body.output2)
      ? (body.output2 as Array<Record<string, string>>)
      : body.output2 && typeof body.output2 === 'object'
        ? [body.output2 as Record<string, string>]
        : [];

    positions.push(...output1.map(rowToBrokerPosition).filter((position) => position.quantity > 0));
    summary = output2[0] ?? summary;

    trCont = headers.get('tr_cont') ?? '';
    fk100 = String(body.ctx_area_fk100 ?? '');
    nk100 = String(body.ctx_area_nk100 ?? '');
    if (trCont !== 'M' && trCont !== 'F') break;
  }

  return {
    broker: 'kis',
    configured: true,
    accountId: account.id,
    accountLabel: `${account.label} · ${maskKisAccount(account.cano, account.productCode)}`,
    baseCurrency: 'KRW',
    cashBalance: firstNumber(summary, ['dnca_tot_amt', 'nxdy_excc_amt']) ?? 0,
    totalEvaluation: firstNumber(summary, ['tot_evlu_amt']),
    stockEvaluation: firstNumber(summary, ['scts_evlu_amt']),
    purchaseAmount: firstNumber(summary, ['pchs_amt_smtl_amt']),
    unrealizedPnl: firstNumber(summary, ['evlu_pfls_smtl_amt']),
    unrealizedPnlRate: firstNumber(summary, ['asst_icdc_erng_rt', 'evlu_erng_rt']),
    positions,
    updatedAt: Date.now(),
  };
}

/**
 * 국내주식 매수가능 조회 (tr_id: TTTC8908R 실전 / VTTC8908R 모의).
 *
 * KIS는 주문구분에 따라 계산 근거가 달라진다.
 * - 시장가: ORD_DVSN='01' + ORD_UNPR='0'. 단가를 넣으면 응답이 왜곡된다.
 * - 지정가: ORD_DVSN='00' + 실제 단가. 단가가 없으면 수량이 0으로 내려온다.
 *
 * `nrcvb_*`는 미수(외상) 없는 값, `max_*`는 미수를 포함한 값이라 서로 다르다.
 * 주문 게이트는 보수적으로 미수 없는 값을 기준 삼도록 둘 다 노출한다.
 */
export async function getKisDomesticOrderability(
  account: KisAccountConfig | null,
  symbol: string,
  orderType: OrderType,
  price: number,
): Promise<BrokerOrderability> {
  const requestedPrice = orderType === 'limit' && isPositiveFinite(price) ? Math.floor(price) : 0;

  if (!account) {
    return {
      broker: 'kis',
      configured: false,
      accountId: '',
      symbol,
      currency: 'KRW',
      orderType,
      requestedPrice,
      message: MISSING_ACCOUNT_MESSAGE,
    };
  }

  const trId = config.env === 'prod' ? 'TTTC8908R' : 'VTTC8908R';
  const { body } = await kisGetWithHeaders(
    '/uapi/domestic-stock/v1/trading/inquire-psbl-order',
    trId,
    {
      CANO: account.cano,
      ACNT_PRDT_CD: account.productCode,
      PDNO: symbol,
      ORD_UNPR: String(requestedPrice),
      ORD_DVSN: orderType === 'limit' ? '00' : '01',
      CMA_EVLU_AMT_ICLD_YN: 'N',
      OVRS_ICLD_YN: 'N',
    },
    '',
    toCredentials(account),
  );

  if (body.rt_cd && body.rt_cd !== '0') {
    throw new Error(`KIS 매수가능조회 실패: ${String(body.msg1 ?? body.msg_cd ?? '알 수 없는 오류')}`);
  }

  const output = (body.output ?? {}) as Record<string, string>;
  return {
    broker: 'kis',
    configured: true,
    accountId: account.id,
    symbol,
    currency: 'KRW',
    orderType,
    requestedPrice,
    cashAvailable: firstNumber(output, ['ord_psbl_cash']),
    reusableAmount: firstNumber(output, ['ruse_psbl_amt']),
    cashBuyAmount: firstNumber(output, ['nrcvb_buy_amt']),
    cashBuyQuantity: firstNumber(output, ['nrcvb_buy_qty']),
    maxBuyAmount: firstNumber(output, ['max_buy_amt']),
    maxBuyQuantity: firstNumber(output, ['max_buy_qty']),
    calculatedUnitPrice: firstNumber(output, ['psbl_qty_calc_unpr']),
    fetchedAt: Date.now(),
  };
}

/**
 * KST 기준 오늘에서 days일 전 날짜를 YYYYMMDD로. 조회 구간 시작일 계산용.
 * 서버 타임존과 무관해야 하므로 UTC 게터로만 다시 포맷한다 (`yyyymmdd`는 로컬 기준이라 쓰지 않는다).
 */
function kstDaysAgo(days: number): string {
  const today = kstToday();
  const base = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(4, 6)) - 1, Number(today.slice(6, 8)));
  const past = new Date(base - days * 86_400_000);
  const month = String(past.getUTCMonth() + 1).padStart(2, '0');
  const day = String(past.getUTCDate()).padStart(2, '0');
  return `${past.getUTCFullYear()}${month}${day}`;
}

/** KIS 체결 진행 상태를 감사용 상태로 정규화한다. 취소·거부도 기록으로 남긴다. */
function toBrokerExecutionStatus(row: Record<string, string>): BrokerExecutionStatus {
  if (row.cncl_yn === 'Y') return 'canceled';

  const orderQuantity = optionalNumber(row.ord_qty) ?? 0;
  const filledQuantity = optionalNumber(row.tot_ccld_qty) ?? 0;
  const rejectedQuantity = optionalNumber(row.rjct_qty) ?? 0;

  if (rejectedQuantity > 0 && filledQuantity === 0) return 'rejected';
  if (filledQuantity > 0 && filledQuantity >= orderQuantity) return 'filled';
  if (filledQuantity > 0) return 'partial';
  return 'open';
}

function rowToBrokerExecution(row: Record<string, string>, index: number): BrokerExecution {
  const orderNo = row.odno ?? '';
  const orderDate = row.ord_dt ?? '';
  // 정정·취소가 아닌 주문의 원주문번호는 전부 0으로 채워져 내려온다. 값 자체는 자르지 않는다.
  const originalOrderNo = row.orgn_odno ?? '';

  return {
    id: `${orderDate}-${orderNo}-${index}`,
    orderNo,
    originalOrderNo: /^0*$/.test(originalOrderNo) ? undefined : originalOrderNo,
    orderDate,
    orderTime: /^\d{6}$/.test(row.ord_tmd ?? '') ? row.ord_tmd : undefined,
    symbol: row.pdno ?? '',
    name: row.prdt_name ?? row.pdno ?? '',
    // 매도매수구분코드: 01=매도, 02=매수
    side: row.sll_buy_dvsn_cd === '01' ? 'sell' : 'buy',
    orderTypeLabel: row.ord_dvsn_name ?? '',
    orderQuantity: optionalNumber(row.ord_qty) ?? 0,
    orderPrice: optionalNumber(row.ord_unpr) ?? 0,
    filledQuantity: optionalNumber(row.tot_ccld_qty) ?? 0,
    filledAmount: optionalNumber(row.tot_ccld_amt) ?? 0,
    // avg_prvs는 체결 평균가다. 미체결이면 0으로 내려온다.
    averageFilledPrice: optionalNumber(row.avg_prvs) ?? 0,
    remainQuantity: optionalNumber(row.rmn_qty) ?? 0,
    rejectedQuantity: optionalNumber(row.rjct_qty) ?? 0,
    status: toBrokerExecutionStatus(row),
    currency: 'KRW',
  };
}

/**
 * 국내주식 일별 주문체결 조회 (tr_id: TTTC8001R 실전 / VTTC8001R 모의).
 *
 * KIS는 3개월 이내만 이 tr_id로 조회할 수 있고, 응답이 페이지 단위라
 * tr_cont가 M/F인 동안 CTX_AREA_* 키를 물려 이어 받아야 한다.
 */
export async function getKisDomesticExecutions(
  account: KisAccountConfig | null,
  days = 30,
): Promise<BrokerExecutionSnapshot> {
  const to = kstToday();
  // KIS는 이 tr_id로 3개월 이내만 조회할 수 있어 상한을 90일로 자른다.
  const from = kstDaysAgo(Number.isFinite(days) ? Math.min(Math.max(Math.floor(days), 1), 90) : 30);

  if (!account) {
    return {
      broker: 'kis',
      configured: false,
      accountId: '',
      accountLabel: 'KIS 계좌 미설정',
      from,
      to,
      executions: [],
      message: MISSING_ACCOUNT_MESSAGE,
    };
  }

  // 3개월 이내 조회용 현행 tr_id. 구 TTTC8001R도 아직 응답하지만 문서상 현행은 이쪽이다.
  // 3개월 이전 구간은 CTSC9215R / VTSC9215R로 갈라진다.
  const trId = config.env === 'prod' ? 'TTTC0081R' : 'VTTC0081R';
  const executions: BrokerExecution[] = [];
  let summary: Record<string, string> = {};
  let fk100 = '';
  let nk100 = '';
  let trCont = '';

  for (let depth = 0; depth < 10; depth += 1) {
    const { body, headers } = await kisGetWithHeaders(
      '/uapi/domestic-stock/v1/trading/inquire-daily-ccld',
      trId,
      {
        CANO: account.cano,
        ACNT_PRDT_CD: account.productCode,
        INQR_STRT_DT: from,
        INQR_END_DT: to,
        SLL_BUY_DVSN_CD: '00',
        INQR_DVSN: '00',
        PDNO: '',
        CCLD_DVSN: '00',
        ORD_GNO_BRNO: '',
        ODNO: '',
        INQR_DVSN_3: '00',
        INQR_DVSN_1: '',
        CTX_AREA_FK100: fk100,
        CTX_AREA_NK100: nk100,
      },
      trCont,
      toCredentials(account),
    );

    if (body.rt_cd && body.rt_cd !== '0') {
      throw new Error(`KIS 주문체결조회 실패: ${String(body.msg1 ?? body.msg_cd ?? '알 수 없는 오류')}`);
    }

    const output1 = Array.isArray(body.output1) ? (body.output1 as Array<Record<string, string>>) : [];
    const output2 = Array.isArray(body.output2)
      ? (body.output2[0] as Record<string, string> | undefined)
      : body.output2 && typeof body.output2 === 'object'
        ? (body.output2 as Record<string, string>)
        : undefined;

    // 페이지가 이어지므로 id 인덱스는 누적 개수를 기준으로 잡는다.
    const offset = executions.length;
    output1.forEach((row, index) => executions.push(rowToBrokerExecution(row, offset + index)));
    summary = output2 ?? summary;

    trCont = headers.get('tr_cont') ?? '';
    fk100 = String(body.ctx_area_fk100 ?? '');
    nk100 = String(body.ctx_area_nk100 ?? '');
    if (trCont !== 'M' && trCont !== 'F') break;
  }

  return {
    broker: 'kis',
    configured: true,
    accountId: account.id,
    accountLabel: `${account.label} · ${maskKisAccount(account.cano, account.productCode)}`,
    from,
    to,
    executions,
    totalOrderQuantity: firstNumber(summary, ['tot_ord_qty']),
    totalFilledQuantity: firstNumber(summary, ['tot_ccld_qty']),
    totalFilledAmount: firstNumber(summary, ['tot_ccld_amt']),
    updatedAt: Date.now(),
  };
}

/**
 * 국내주식 기간별 매매손익 조회 (tr_id: TTTC8715R, 모의투자 미지원).
 *
 * 체결내역(`inquire-daily-ccld`)과 달리 **매도로 확정된 실현손익**과 수수료·세금을 준다.
 * 합계(output2)는 브로커가 계산해 준 값을 그대로 쓴다. 우리가 다시 더하면 어긋난다.
 */
export async function getKisDomesticTradeProfit(
  account: KisAccountConfig | null,
  days = 30,
): Promise<BrokerTradeProfitSnapshot> {
  const to = kstToday();
  const from = kstDaysAgo(Number.isFinite(days) ? Math.min(Math.max(Math.floor(days), 1), 365) : 30);

  if (!account) {
    return {
      broker: 'kis',
      configured: false,
      accountId: '',
      from,
      to,
      rows: [],
      message: MISSING_ACCOUNT_MESSAGE,
    };
  }

  const rows: BrokerTradeProfitRow[] = [];
  let summary: Record<string, string> = {};
  let fk100 = '';
  let nk100 = '';
  let trCont = '';

  for (let depth = 0; depth < 10; depth += 1) {
    const { body, headers } = await kisGetWithHeaders(
      '/uapi/domestic-stock/v1/trading/inquire-period-trade-profit',
      'TTTC8715R',
      {
        CANO: account.cano,
        ACNT_PRDT_CD: account.productCode,
        SORT_DVSN: '00',
        INQR_STRT_DT: from,
        INQR_END_DT: to,
        CBLC_DVSN: '00',
        PDNO: '',
        CTX_AREA_FK100: fk100,
        CTX_AREA_NK100: nk100,
      },
      trCont,
      toCredentials(account),
    );

    if (body.rt_cd && body.rt_cd !== '0') {
      throw new Error(`KIS 기간별매매손익조회 실패: ${String(body.msg1 ?? body.msg_cd ?? '알 수 없는 오류')}`);
    }

    const output1 = Array.isArray(body.output1) ? (body.output1 as Array<Record<string, string>>) : [];
    const output2 = Array.isArray(body.output2)
      ? (body.output2[0] as Record<string, string> | undefined)
      : body.output2 && typeof body.output2 === 'object'
        ? (body.output2 as Record<string, string>)
        : undefined;

    const offset = rows.length;
    output1.forEach((row, index) => {
      rows.push({
        id: `${row.trad_dt ?? ''}-${row.pdno ?? ''}-${offset + index}`,
        tradeDate: row.trad_dt ?? '',
        symbol: row.pdno ?? '',
        name: row.prdt_name ?? row.pdno ?? '',
        tradeTypeLabel: row.trad_dvsn_name ?? '',
        sellQuantity: optionalNumber(row.sll_qty) ?? 0,
        sellPrice: optionalNumber(row.sll_pric) ?? 0,
        sellAmount: optionalNumber(row.sll_amt) ?? 0,
        buyQuantity: optionalNumber(row.buy_qty) ?? 0,
        buyPrice: optionalNumber(row.pchs_unpr) ?? 0,
        buyAmount: optionalNumber(row.buy_amt) ?? 0,
        realizedProfit: optionalNumber(row.rlzt_pfls) ?? 0,
        profitRate: optionalNumber(row.pfls_rt) ?? 0,
        fee: optionalNumber(row.fee) ?? 0,
        tax: optionalNumber(row.tl_tax) ?? 0,
        loanInterest: optionalNumber(row.loan_int) ?? 0,
        currency: 'KRW',
      });
    });
    summary = output2 ?? summary;

    trCont = headers.get('tr_cont') ?? '';
    fk100 = String(body.ctx_area_fk100 ?? '');
    nk100 = String(body.ctx_area_nk100 ?? '');
    if (trCont !== 'M' && trCont !== 'F') break;
  }

  return {
    broker: 'kis',
    configured: true,
    accountId: account.id,
    from,
    to,
    rows,
    totalRealizedProfit: firstNumber(summary, ['tot_rlzt_pfls']),
    totalProfitRate: firstNumber(summary, ['tot_pftrt']),
    totalFee: firstNumber(summary, ['tot_fee']),
    totalTax: firstNumber(summary, ['tot_tltx']),
    totalTradeAmount: firstNumber(summary, ['tot_tr_amt']),
    updatedAt: Date.now(),
  };
}

/** 개장일 판정 캐시. 같은 날짜를 주문마다 다시 묻지 않는다. */
const marketOpenCache = new Map<string, boolean>();

/**
 * 국내 개장일 여부 (국내휴장일조회, tr_id: CTCA0903R).
 *
 * 시각만 보는 검증으로는 주말·공휴일 주문을 막지 못한다. KIS가
 * "장운영일자가 주문일과 상이합니다"로 거부하기 전에 우리가 먼저 걸러야 한다.
 * `opnd_yn`이 개장일 여부다(영업일 `bzdy_yn`과 다르다 — 영업일이어도 휴장일 수 있다).
 */
export async function isDomesticMarketOpenDay(date = kstToday()): Promise<boolean> {
  const cached = marketOpenCache.get(date);
  if (cached !== undefined) return cached;

  const { body } = await kisGetWithHeaders(
    '/uapi/domestic-stock/v1/quotations/chk-holiday',
    'CTCA0903R',
    { BASS_DT: date, CTX_AREA_FK: '', CTX_AREA_NK: '' },
  );

  if (body.rt_cd && body.rt_cd !== '0') {
    throw new Error(`KIS 휴장일조회 실패: ${String(body.msg1 ?? body.msg_cd ?? '알 수 없는 오류')}`);
  }

  const rows = Array.isArray(body.output) ? (body.output as Array<Record<string, string>>) : [];
  const today = rows.find((row) => row.bass_dt === date);
  if (!today) throw new Error(`KIS 휴장일조회에 ${date} 항목이 없습니다.`);

  const open = today.opnd_yn === 'Y';
  marketOpenCache.set(date, open);
  return open;
}

/** 국내주식 매도가능수량 조회 (tr_id: TTTC8408R, 모의투자 미지원). */
export async function getKisDomesticSellability(
  account: KisAccountConfig | null,
  symbol: string,
): Promise<BrokerSellability> {
  if (!account) {
    return {
      broker: 'kis',
      configured: false,
      accountId: '',
      symbol,
      currency: 'KRW',
      message: MISSING_ACCOUNT_MESSAGE,
    };
  }

  const { body } = await kisGetWithHeaders(
    '/uapi/domestic-stock/v1/trading/inquire-psbl-sell',
    'TTTC8408R',
    { CANO: account.cano, ACNT_PRDT_CD: account.productCode, PDNO: symbol },
    '',
    toCredentials(account),
  );

  if (body.rt_cd && body.rt_cd !== '0') {
    throw new Error(`KIS 매도가능수량조회 실패: ${String(body.msg1 ?? body.msg_cd ?? '알 수 없는 오류')}`);
  }

  const rows = Array.isArray(body.output)
    ? (body.output as Array<Record<string, string>>)
    : body.output && typeof body.output === 'object'
      ? [body.output as Record<string, string>]
      : [];
  const output = rows[0] ?? {};

  // 응답 필드는 잔고조회와 이름이 다르다. 잔고수량은 cblc_qty, 현재가는 now_pric다.
  // 종목명은 아예 내려오지 않으므로(pdno만 온다) 화면이 이미 아는 이름을 쓰게 둔다.
  return {
    broker: 'kis',
    configured: true,
    accountId: account.id,
    symbol,
    currency: 'KRW',
    sellableQuantity: firstNumber(output, ['ord_psbl_qty']),
    holdingQuantity: firstNumber(output, ['cblc_qty']),
    /** 미수(외상) 수량. 결제 전이라 매도가 막힐 수 있는 양 */
    unsettledQuantity: firstNumber(output, ['nsvg_qty']),
    price: firstNumber(output, ['now_pric']),
    averagePrice: firstNumber(output, ['pchs_avg_pric']),
    fetchedAt: Date.now(),
  };
}

/**
 * 국내주식 정정취소가능주문 조회 (tr_id: TTTC0084R, 모의투자 미지원).
 * 정정·취소 전송에는 주문번호(odno)와 **주문채번지점번호(ord_gno_brno)** 가 함께 필요하다.
 */
export async function getKisDomesticAmendableOrders(
  account: KisAccountConfig | null,
): Promise<BrokerAmendableOrder[]> {
  if (!account) return [];

  const orders: BrokerAmendableOrder[] = [];
  let fk100 = '';
  let nk100 = '';
  let trCont = '';

  for (let depth = 0; depth < 10; depth += 1) {
    const { body, headers } = await kisGetWithHeaders(
      '/uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl',
      'TTTC0084R',
      {
        CANO: account.cano,
        ACNT_PRDT_CD: account.productCode,
        // 조회구분1: 0 주문 / 1 종목, 조회구분2: 0 전체 / 1 매도 / 2 매수
        INQR_DVSN_1: '1',
        INQR_DVSN_2: '0',
        CTX_AREA_FK100: fk100,
        CTX_AREA_NK100: nk100,
      },
      trCont,
      toCredentials(account),
    );

    if (body.rt_cd && body.rt_cd !== '0') {
      throw new Error(`KIS 정정취소가능주문조회 실패: ${String(body.msg1 ?? body.msg_cd ?? '알 수 없는 오류')}`);
    }

    const rows = Array.isArray(body.output) ? (body.output as Array<Record<string, string>>) : [];
    const offset = orders.length;
    rows.forEach((row, index) => {
      orders.push({
        id: `${row.ord_gno_brno ?? ''}-${row.odno ?? ''}-${offset + index}`,
        orderNo: row.odno ?? '',
        originalOrderNo: /^0*$/.test(row.orgn_odno ?? '') ? undefined : row.orgn_odno,
        orderBranchNo: row.ord_gno_brno ?? '',
        symbol: row.pdno ?? '',
        name: row.prdt_name ?? row.pdno ?? '',
        side: row.sll_buy_dvsn_cd === '01' ? 'sell' : 'buy',
        orderTypeLabel: row.ord_dvsn_name ?? '',
        orderTypeCode: row.ord_dvsn_cd ?? '00',
        orderQuantity: optionalNumber(row.ord_qty) ?? 0,
        orderPrice: optionalNumber(row.ord_unpr) ?? 0,
        filledQuantity: optionalNumber(row.tot_ccld_qty) ?? 0,
        // 이 응답에는 잔여수량(rmn_qty)이 없다. psbl_qty(가능수량)가 정정·취소 대상 수량이다.
        amendableQuantity: optionalNumber(row.psbl_qty) ?? 0,
        orderTime: /^\d{6}$/.test(row.ord_tmd ?? '') ? row.ord_tmd : undefined,
        currency: 'KRW',
      });
    });

    trCont = headers.get('tr_cont') ?? '';
    fk100 = String(body.ctx_area_fk100 ?? '');
    nk100 = String(body.ctx_area_nk100 ?? '');
    if (trCont !== 'M' && trCont !== 'F') break;
  }

  return orders;
}

/** 국내주식 예약주문 조회 (tr_id: CTSC0004R, 모의투자 미지원). */
export async function getKisDomesticReservedOrders(
  account: KisAccountConfig | null,
  days = 30,
): Promise<BrokerReservedOrder[]> {
  if (!account) return [];

  const { body } = await kisGetWithHeaders(
    '/uapi/domestic-stock/v1/trading/order-resv-ccnl',
    'CTSC0004R',
    {
      RSVN_ORD_ORD_DT: kstDaysAgo(Number.isFinite(days) ? Math.min(Math.max(Math.floor(days), 1), 90) : 30),
      RSVN_ORD_END_DT: kstToday(),
      TMNL_MDIA_KIND_CD: '00',
      CANO: account.cano,
      ACNT_PRDT_CD: account.productCode,
      PRCS_DVSN_CD: '0',
      CNCL_YN: '',
      RSVN_ORD_SEQ: '',
      PDNO: '',
      SLL_BUY_DVSN_CD: '',
    },
    '',
    toCredentials(account),
  );

  if (body.rt_cd && body.rt_cd !== '0') {
    throw new Error(`KIS 예약주문조회 실패: ${String(body.msg1 ?? body.msg_cd ?? '알 수 없는 오류')}`);
  }

  // 예약주문 응답은 일반 주문과 필드명이 다르다.
  // 수량·단가에 rsvn 접두어가 붙고(ord_rsvn_qty / ord_rsvn_unpr), 종목명은 kor_item_shtn_name,
  // 취소 여부는 cncl_yn이 아니라 취소주문일자(cncl_ord_dt) 유무로 판단한다.
  const rows = Array.isArray(body.output) ? (body.output as Array<Record<string, string>>) : [];
  return rows.map((row, index) => ({
    id: `${row.rsvn_ord_seq ?? ''}-${index}`,
    reservationSeq: row.rsvn_ord_seq ?? '',
    orderDate: row.rsvn_ord_ord_dt || row.rsvn_ord_rcit_dt || '',
    endDate: row.rsvn_end_dt || undefined,
    symbol: row.pdno ?? '',
    name: row.kor_item_shtn_name ?? row.pdno ?? '',
    side: row.sll_buy_dvsn_cd === '01' ? 'sell' : 'buy',
    orderQuantity: optionalNumber(row.ord_rsvn_qty) ?? 0,
    orderPrice: optionalNumber(row.ord_rsvn_unpr) ?? 0,
    filledQuantity: optionalNumber(row.tot_ccld_qty) ?? 0,
    statusLabel: row.prcs_rslt || row.ord_dvsn_name || '',
    canceled: Boolean(row.cncl_ord_dt && !/^0*$/.test(row.cncl_ord_dt)),
    currency: 'KRW',
  }));
}

/**
 * 국내주식 현금 주문 전송 (tr_id: 실전 TTTC0012U 매수 / TTTC0011U 매도, 모의 VTTC0012U / VTTC0011U).
 *
 * 주의할 점:
 * - `EXCG_ID_DVSN_CD`(거래소ID구분코드)가 필수다. 국내 정규장은 'KRX'.
 * - 시장가는 `ORD_DVSN='01'` + `ORD_UNPR='0'`, 지정가는 `'00'` + 실제 단가.
 * - `SLL_TYPE`은 매도에만 쓴다(01 일반매도). 매수에는 빈 값을 넣는다.
 * - 응답 output의 `ODNO`(주문번호)와 `KRX_FWDG_ORD_ORGNO`(주문채번지점번호)를 반드시 보관해야
 *   이후 정정·취소를 보낼 수 있다.
 */
export async function placeKisDomesticOrder(
  account: KisAccountConfig,
  params: {
    symbol: string;
    side: OrderSide;
    orderType: OrderType;
    quantity: number;
    limitPrice?: number;
  },
): Promise<{ orderNo: string; orderBranchNo: string; acceptedAt: string; message: string }> {
  const isBuy = params.side === 'buy';
  const trId = config.env === 'prod' ? (isBuy ? 'TTTC0012U' : 'TTTC0011U') : isBuy ? 'VTTC0012U' : 'VTTC0011U';
  const isLimit = params.orderType === 'limit';

  const body = await kisPost(
    '/uapi/domestic-stock/v1/trading/order-cash',
    trId,
    {
      CANO: account.cano,
      ACNT_PRDT_CD: account.productCode,
      PDNO: params.symbol,
      ORD_DVSN: isLimit ? '00' : '01',
      ORD_QTY: String(Math.floor(params.quantity)),
      ORD_UNPR: isLimit ? String(Math.floor(params.limitPrice ?? 0)) : '0',
      EXCG_ID_DVSN_CD: 'KRX',
      SLL_TYPE: isBuy ? '' : '01',
      CNDT_PRIC: '',
    },
    toCredentials(account),
  );

  if (body.rt_cd !== '0') {
    throw new Error(`KIS 주문 전송 실패: ${String(body.msg1 ?? body.msg_cd ?? '알 수 없는 오류')}`);
  }

  const output = (body.output ?? {}) as Record<string, string>;
  return {
    orderNo: output.ODNO ?? '',
    orderBranchNo: output.KRX_FWDG_ORD_ORGNO ?? '',
    acceptedAt: output.ORD_TMD ?? '',
    message: String(body.msg1 ?? '주문이 접수되었습니다.').trim(),
  };
}

/**
 * 국내주식 주문 정정·취소 (tr_id: 실전 TTTC0013U / 모의 VTTC0013U).
 *
 * - `RVSE_CNCL_DVSN_CD`: 01 정정, 02 취소.
 * - 취소는 단가를 보지 않으므로 `ORD_UNPR='0'`으로 보낸다.
 * - `QTY_ALL_ORD_YN='Y'`면 잔량 전부를 대상으로 하고 `ORD_QTY`는 무시된다.
 * - `ORD_DVSN`은 원주문의 주문구분 코드를 그대로 되돌려줘야 한다.
 */
export async function amendKisDomesticOrder(
  account: KisAccountConfig,
  params: {
    action: 'amend' | 'cancel';
    orderNo: string;
    orderBranchNo: string;
    orderTypeCode: string;
    quantity?: number;
    limitPrice?: number;
    quantityAll: boolean;
  },
): Promise<{ orderNo: string; acceptedAt: string; message: string }> {
  const trId = config.env === 'prod' ? 'TTTC0013U' : 'VTTC0013U';
  const isCancel = params.action === 'cancel';

  const body = await kisPost(
    '/uapi/domestic-stock/v1/trading/order-rvsecncl',
    trId,
    {
      CANO: account.cano,
      ACNT_PRDT_CD: account.productCode,
      KRX_FWDG_ORD_ORGNO: params.orderBranchNo,
      ORGN_ODNO: params.orderNo,
      ORD_DVSN: params.orderTypeCode,
      RVSE_CNCL_DVSN_CD: isCancel ? '02' : '01',
      ORD_QTY: params.quantityAll ? '0' : String(Math.floor(params.quantity ?? 0)),
      ORD_UNPR: isCancel ? '0' : String(Math.floor(params.limitPrice ?? 0)),
      QTY_ALL_ORD_YN: params.quantityAll ? 'Y' : 'N',
      EXCG_ID_DVSN_CD: 'KRX',
    },
    toCredentials(account),
  );

  if (body.rt_cd !== '0') {
    throw new Error(`KIS 주문 ${isCancel ? '취소' : '정정'} 실패: ${String(body.msg1 ?? body.msg_cd ?? '알 수 없는 오류')}`);
  }

  const output = (body.output ?? {}) as Record<string, string>;
  return {
    orderNo: output.ODNO ?? params.orderNo,
    acceptedAt: output.ORD_TMD ?? '',
    message: String(body.msg1 ?? '요청이 접수되었습니다.').trim(),
  };
}

export async function getInstrumentIntradayCandles(instrument: Instrument): Promise<CandlesResponse> {
  if (instrument.assetType === 'night_proxy' || instrument.assetType === 'commodity') {
    return { code: instrument.id, name: instrument.name, candles: [] };
  }
  if (instrument.country === 'KR') return getDomesticIntradayCandles(instrument);
  return getOverseasIntradayCandles(instrument);
}

export async function getInstrumentNews(instrument: Instrument): Promise<NewsItem[]> {
  if (instrument.assetType === 'night_proxy' || instrument.assetType === 'commodity') return [];
  if (instrument.country === 'KR') return getDomesticNews(instrument);
  return getOverseasNews(instrument);
}

function firstNumber(row: Record<string, string>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = optionalNumber(row[key]);
    if (value !== null) return value;
  }
  return undefined;
}

function rowToBrokerPosition(row: Record<string, string>): BrokerPosition {
  return {
    symbol: row.pdno ?? '',
    name: row.prdt_name ?? row.prdt_name_abrv ?? row.pdno ?? '',
    quantity: optionalNumber(row.hldg_qty) ?? 0,
    averagePrice: optionalNumber(row.pchs_avg_pric) ?? 0,
    currentPrice: optionalNumber(row.prpr) ?? undefined,
    purchaseAmount: optionalNumber(row.pchs_amt) ?? undefined,
    marketValue: optionalNumber(row.evlu_amt) ?? undefined,
    unrealizedPnl: optionalNumber(row.evlu_pfls_amt) ?? undefined,
    unrealizedPnlRate: optionalNumber(row.evlu_pfls_rt) ?? undefined,
    currency: 'KRW',
  };
}

async function getDomesticNews(instrument: Instrument): Promise<NewsItem[]> {
  const json = await kisGet('/uapi/domestic-stock/v1/quotations/news-title', 'FHKST01011800', {
    FID_NEWS_OFER_ENTP_CODE: '',
    FID_COND_MRKT_CLS_CODE: '00',
    FID_INPUT_ISCD: instrument.providerSymbol,
    FID_TITL_CNTT: '',
    FID_INPUT_DATE_1: '',
    FID_INPUT_HOUR_1: '',
    FID_RANK_SORT_CLS_CODE: '01',
    FID_INPUT_SRNO: '',
  });
  const rows = (json.output ?? []) as Array<Record<string, string>>;
  return rows
    .map((row, index) => ({
      id: row.cntt_usiq_srno ?? `${instrument.id}-${row.data_dt ?? ''}-${row.data_tm ?? ''}-${index}`,
      title: row.hts_pbnt_titl_cntt ?? '',
      source: row.dorg || row.news_ofer_entp_code || 'KIS',
      publishedAt: optionalKstDateTimeToTimestamp(row.data_dt, row.data_tm),
      symbol: instrument.symbol,
    }))
    .filter((item) => item.title.length > 0)
    .slice(0, 20);
}

async function getOverseasNews(instrument: Instrument): Promise<NewsItem[]> {
  const nationCode = instrument.country === 'US' ? 'US' : instrument.country;
  const json = await kisGet('/uapi/overseas-price/v1/quotations/news-title', 'HHPSTH60100C1', {
    INFO_GB: '',
    CLASS_CD: '',
    NATION_CD: nationCode,
    EXCHANGE_CD: instrument.exchangeCode,
    SYMB: instrument.providerSymbol,
    DATA_DT: '',
    DATA_TM: '',
    CTS: '',
  });
  const rows = (json.outblock1 ?? []) as Array<Record<string, string>>;
  return rows
    .map((row, index) => ({
      id: row.news_key ?? `${instrument.id}-${row.data_dt ?? ''}-${row.data_tm ?? ''}-${index}`,
      title: row.title ?? '',
      source: row.source || row.class_name || 'KIS',
      publishedAt: optionalKstDateTimeToTimestamp(row.data_dt, row.data_tm),
      symbol: row.symb || instrument.symbol,
    }))
    .filter((item) => item.title.length > 0)
    .slice(0, 20);
}

async function getOverseasDailyCandles(
  instrument: Instrument,
  days: number,
): Promise<CandlesResponse> {
  const json = await kisGet('/uapi/overseas-price/v1/quotations/dailyprice', 'HHDFS76240000', {
    AUTH: '',
    EXCD: instrument.exchangeCode,
    SYMB: instrument.providerSymbol,
    GUBN: '0', // 0: 일봉
    BYMD: '',
    MODP: '1', // 1: 수정주가 반영
  });

  const output2 = (json.output2 ?? []) as Array<Record<string, string>>;
  const candles: Candle[] = output2
    .filter((r) => r.xymd)
    .map((r) => {
      const y = Number(r.xymd.slice(0, 4));
      const m = Number(r.xymd.slice(4, 6));
      const d = Number(r.xymd.slice(6, 8));
      return {
        time: Math.floor(Date.UTC(y, m - 1, d) / 1000),
        open: toNumber(r.open),
        high: toNumber(r.high),
        low: toNumber(r.low),
        close: toNumber(r.clos),
        volume: toNumber(r.tvol),
      };
    })
    .filter(
      (c) =>
        Number.isFinite(c.time) &&
        isPositiveFinite(c.open) &&
        isPositiveFinite(c.high) &&
        isPositiveFinite(c.low) &&
        isPositiveFinite(c.close) &&
        isNonNegativeFinite(c.volume ?? 0),
    )
    .sort((a, b) => a.time - b.time)
    .slice(-days);

  return { code: instrument.id, name: instrument.name, candles };
}

async function getOverseasQuote(instrument: Instrument): Promise<Quote> {
  const [priceJson, detailJson] = await Promise.all([
    kisGet('/uapi/overseas-price/v1/quotations/price', 'HHDFS00000300', {
      AUTH: '',
      EXCD: instrument.exchangeCode,
      SYMB: instrument.providerSymbol,
    }),
    kisGet('/uapi/overseas-price/v1/quotations/price-detail', 'HHDFS76200200', {
      AUTH: '',
      EXCD: instrument.exchangeCode,
      SYMB: instrument.providerSymbol,
    }),
  ]);
  const priceOutput = (priceJson.output ?? {}) as Record<string, string>;
  const detailOutput = (detailJson.output ?? {}) as Record<string, string>;
  const price = requireNumber(priceOutput.last, 'last');
  return {
    code: instrument.id,
    price,
    change: requireNumber(priceOutput.diff, 'diff'),
    changeRate: requireNumber(priceOutput.rate, 'rate'),
    sign: parseSign(priceOutput.sign),
    open: optionalNumber(detailOutput.open) ?? price,
    high: optionalNumber(detailOutput.high) ?? price,
    low: optionalNumber(detailOutput.low) ?? price,
    accVolume: optionalNumber(priceOutput.tvol) ?? optionalNumber(detailOutput.tvol) ?? 0,
  };
}
