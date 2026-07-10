import { config } from '../config.js';
import { getAccessToken } from './auth.js';
import type { Candle, CandlesResponse, Quote } from '@invest/shared';

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
        open: Number(r.stck_oprc),
        high: Number(r.stck_hgpr),
        low: Number(r.stck_lwpr),
        close: Number(r.stck_clpr),
        volume: Number(r.acml_vol),
      };
    })
    .filter((c) => Number.isFinite(c.open) && c.open > 0)
    .sort((a, b) => a.time - b.time);

  return { code, name, candles };
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
    price: Number(o.stck_prpr),
    change: Number(o.prdy_vrss),
    changeRate: Number(o.prdy_ctrt),
    sign: o.prdy_vrss_sign ?? '3',
    open: Number(o.stck_oprc),
    high: Number(o.stck_hgpr),
    low: Number(o.stck_lwpr),
    accVolume: Number(o.acml_vol),
  };
}
