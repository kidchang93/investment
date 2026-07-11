import { config } from '../config.js';
import { getAccessToken } from './auth.js';
import type { BrokerAccountSnapshot, BrokerPosition, Candle, CandlesResponse, Instrument, NewsItem, PriceSign, Quote } from '@invest/shared';

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
): Promise<{ body: Record<string, unknown>; headers: Headers }> {
  const token = await getAccessToken();
  const url = new URL(config.restBase + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    appkey: config.appKey,
    appsecret: config.appSecret,
    tr_id: trId,
    custtype: config.custType,
  };
  if (trCont) headers.tr_cont = trCont;

  const res = await fetch(url, {
    headers: {
      ...headers,
    },
  });
  if (!res.ok) {
    throw new Error(`KIS GET ${path} 실패 (${res.status}): ${await res.text()}`);
  }
  return { body: (await res.json()) as Record<string, unknown>, headers: res.headers };
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
  if (instrument.country === 'KR') {
    const response = await getDailyCandles(instrument.providerSymbol, days);
    return { ...response, code: instrument.id, name: instrument.name };
  }
  return getOverseasDailyCandles(instrument, days);
}

export async function getInstrumentQuote(instrument: Instrument): Promise<Quote> {
  if (instrument.country === 'KR') {
    const quote = await getQuote(instrument.providerSymbol);
    return { ...quote, code: instrument.id };
  }
  return getOverseasQuote(instrument);
}

export async function getKisDomesticAccountSnapshot(): Promise<BrokerAccountSnapshot> {
  const account = config.kisAccount;
  if (!account) {
    return {
      broker: 'kis',
      configured: false,
      accountLabel: 'KIS 계좌 미설정',
      baseCurrency: 'KRW',
      positions: [],
      message: 'KIS_ACCOUNT_NO 또는 KIS_ACCOUNT_NO/KIS_ACCOUNT_PRODUCT_CODE 환경 변수가 필요합니다.',
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
    accountLabel: maskKisAccount(account.cano, account.productCode),
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

export async function getInstrumentIntradayCandles(instrument: Instrument): Promise<CandlesResponse> {
  if (instrument.country === 'KR') return getDomesticIntradayCandles(instrument);
  return getOverseasIntradayCandles(instrument);
}

export async function getInstrumentNews(instrument: Instrument): Promise<NewsItem[]> {
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
