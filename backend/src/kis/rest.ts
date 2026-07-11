import { config } from '../config.js';
import { getAccessToken } from './auth.js';
import type { Candle, CandlesResponse, Instrument, PriceSign, Quote } from '@invest/shared';

/** KIS REST GET 공통 헬퍼. tr_id별로 헤더/인증을 채워 호출한다. */
async function kisGet(
  path: string,
  trId: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const token = await getAccessToken();
  const url = new URL(config.restBase + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      appkey: config.appKey,
      appsecret: config.appSecret,
      tr_id: trId,
      custtype: config.custType,
    },
  });
  if (!res.ok) {
    throw new Error(`KIS GET ${path} 실패 (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

function yyyymmdd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function toNumber(value: string | undefined): number {
  return Number(value);
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

export async function getInstrumentIntradayCandles(instrument: Instrument): Promise<CandlesResponse> {
  if (instrument.country !== 'KR') {
    return { code: instrument.id, name: instrument.name, candles: [] };
  }
  return getDomesticIntradayCandles(instrument);
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
