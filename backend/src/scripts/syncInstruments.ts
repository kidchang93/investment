import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inferDomesticAssetType } from '../db/assetTypes.js';
import { closeDb, pool } from '../db/client.js';
import { ensureDomesticAssetTypes, ensureInstrumentSchema } from '../db/instruments.js';
import { DOMESTIC_MASTER_SPECS, parseDomesticMasterRow } from '../kis/domesticMaster.js';
import type { Instrument } from '@invest/shared';

/**
 * KIS 종목 마스터 파일(.mst/.COD)을 로컬 Postgres instruments 테이블로 동기화한다.
 * 원본 파일은 backend/.cache에 두고 커밋하지 않는다.
 */

interface NormalizedInstrument extends Instrument {
  searchText: string;
}

const MASTER_DIR = resolve(process.cwd(), '.cache');
const decoder = new TextDecoder('euc-kr');

const OVERSEAS_EXCHANGES: Record<
  string,
  Pick<Instrument, 'country' | 'currency' | 'timezone'>
> = {
  NAS: { country: 'US', currency: 'USD', timezone: 'America/New_York' },
  NYS: { country: 'US', currency: 'USD', timezone: 'America/New_York' },
  AMS: { country: 'US', currency: 'USD', timezone: 'America/New_York' },
  BAY: { country: 'US', currency: 'USD', timezone: 'America/New_York' },
  BAQ: { country: 'US', currency: 'USD', timezone: 'America/New_York' },
  BAA: { country: 'US', currency: 'USD', timezone: 'America/New_York' },
  HKS: { country: 'HK', currency: 'HKD', timezone: 'Asia/Hong_Kong' },
  TSE: { country: 'JP', currency: 'JPY', timezone: 'Asia/Tokyo' },
  SHS: { country: 'CN', currency: 'CNY', timezone: 'Asia/Shanghai' },
  SZS: { country: 'CN', currency: 'CNY', timezone: 'Asia/Shanghai' },
  SHI: { country: 'CN', currency: 'CNY', timezone: 'Asia/Shanghai' },
  SZI: { country: 'CN', currency: 'CNY', timezone: 'Asia/Shanghai' },
  HSX: { country: 'VN', currency: 'VND', timezone: 'Asia/Ho_Chi_Minh' },
  HNX: { country: 'VN', currency: 'VND', timezone: 'Asia/Ho_Chi_Minh' },
};

async function main(): Promise<void> {
  await ensureInstrumentSchema();

  const instruments = [
    ...(await loadDomesticInstruments()),
    ...(await loadOverseasInstruments()),
    ...(await loadOverseasFutureInstruments()),
    ...(await loadDomesticNightFutureInstruments()),
    ...loadNightProxyInstruments(),
    ...loadCommodityIndicators(),
  ];

  await upsertInstruments(dedupe(instruments));
  await ensureDomesticAssetTypes();
  console.log(`종목 마스터 동기화 완료: ${instruments.length.toLocaleString('ko-KR')}건`);
}

async function loadDomesticInstruments(): Promise<NormalizedInstrument[]> {
  const result: NormalizedInstrument[] = [];
  for (const spec of DOMESTIC_MASTER_SPECS) {
    const path = resolve(MASTER_DIR, spec.file);
    const text = decoder.decode(await readFile(path));
    for (const row of text.split(/\r?\n/)) {
      if (!row.trim()) continue;
      const { symbol, name } = parseDomesticMasterRow(row, spec);
      // 단축코드가 6자리가 아닌 것은 시세 API가 받지 않아 담지 않는다.
      // KOSPI 실측(2026-07): 탈락 469건 = 7자리 ETN(`Q500093`) 385 + 9자리 수익증권 84.
      if (!/^[0-9A-Z]{6}$/.test(symbol) || !name) continue;
      result.push({
        id: `KR:${spec.market}:${symbol}`,
        symbol,
        name,
        market: spec.market,
        country: 'KR',
        currency: 'KRW',
        assetType: inferDomesticAssetType(name),
        provider: 'kis',
        providerSymbol: symbol,
        exchangeCode: 'J',
        timezone: 'Asia/Seoul',
        searchText: [symbol, name, spec.market, 'KR', 'KRW'].join(' '),
      });
    }
  }
  return result;
}

async function loadOverseasInstruments(): Promise<NormalizedInstrument[]> {
  const files = (await readdir(MASTER_DIR)).filter((file) => file.endsWith('MST.COD'));
  const result: NormalizedInstrument[] = [];

  for (const file of files) {
    const text = decoder.decode(await readFile(resolve(MASTER_DIR, file)));
    for (const row of text.split(/\r?\n/)) {
      if (!row.trim()) continue;
      const cols = row.split('\t');
      const exchangeCode = cols[2]?.trim().toUpperCase();
      const symbol = cols[4]?.trim();
      const realtimeSymbol = cols[5]?.trim();
      const koreanName = cols[6]?.trim();
      const englishName = cols[7]?.trim();
      const securityType = cols[8]?.trim();
      const currency = cols[9]?.trim();
      const exchange = exchangeCode ? OVERSEAS_EXCHANGES[exchangeCode] : undefined;
      if (!exchange || !symbol || !realtimeSymbol) continue;

      const name = koreanName || englishName || symbol;
      result.push({
        id: `${exchange.country}:${exchangeCode}:${encodeInstrumentSymbol(symbol)}`,
        symbol,
        name,
        englishName: englishName || undefined,
        market: exchangeCode,
        country: exchange.country,
        currency: currency || exchange.currency,
        assetType: mapOverseasAssetType(securityType),
        provider: 'kis',
        providerSymbol: symbol,
        exchangeCode,
        timezone: exchange.timezone,
        searchText: [symbol, realtimeSymbol, name, englishName, exchangeCode, exchange.country, currency]
          .filter(Boolean)
          .join(' '),
      });
    }
  }

  return result;
}

async function loadOverseasFutureInstruments(): Promise<NormalizedInstrument[]> {
  const text = await readOptionalMaster('ffcode.mst');
  if (!text) return [];

  const result: NormalizedInstrument[] = [];
  for (const row of text.split(/\r?\n/)) {
    if (!row.trim()) continue;
    const symbol = row.slice(0, 32).trim();
    const name = row.slice(82, 107).trim();
    const exchangeCode = row.slice(-92, -82).trim();
    const productCode = row.slice(-82, -72).trim();
    const productKind = row.slice(-72, -69).trim();
    const isSpread = row.slice(-5, -4).trim() === 'Y';
    if (!symbol || !name || !exchangeCode || isSpread) continue;

    result.push({
      id: `GLOBAL:OV_FUT:${encodeInstrumentSymbol(symbol)}`,
      symbol,
      name,
      market: 'OV_FUT',
      country: 'GLOBAL',
      currency: 'USD',
      assetType: 'future',
      provider: 'kis',
      providerSymbol: symbol,
      exchangeCode,
      timezone: 'America/Chicago',
      searchText: [symbol, name, exchangeCode, productCode, productKind, '해외선물', '해외선물옵션']
        .filter(Boolean)
        .join(' '),
    });
  }

  return result;
}

async function loadDomesticNightFutureInstruments(): Promise<NormalizedInstrument[]> {
  const text = await readOptionalMaster('fo_cme_code.mst');
  if (!text) return [];

  const result: NormalizedInstrument[] = [];
  for (const row of text.split(/\r?\n/)) {
    if (!row.trim()) continue;
    const productType = row.slice(0, 1).trim();
    const symbol = row.slice(1, 10).trim();
    const standardCode = row.slice(10, 22).trim();
    const name = row.slice(22, 63).trim();
    const underlyingCode = row.slice(72, 81).trim();
    const underlyingName = row.slice(81).trim();
    if (!symbol || !name) continue;

    const assetType: NormalizedInstrument['assetType'] =
      productType === '2' || name.startsWith('SP ') ? 'future_spread' : 'future';

    result.push({
      id: `KR:KRX_NIGHT:${symbol}`,
      symbol,
      name: `야간 ${underlyingName || name} ${name}`,
      market: 'KRX_NIGHT',
      country: 'KR',
      currency: 'KRW',
      assetType,
      provider: 'kis',
      providerSymbol: symbol,
      exchangeCode: 'F',
      timezone: 'Asia/Seoul',
      searchText: [symbol, standardCode, name, underlyingCode, underlyingName, productType, '국내 야간선물', 'KRX 야간선물']
        .filter(Boolean)
        .join(' '),
    });
  }

  return result;
}

function loadNightProxyInstruments(): NormalizedInstrument[] {
  return [
    {
      id: 'KR:NIGHT_PROXY:005930',
      symbol: '005930-NIGHT',
      name: '삼성전자 야간 환산가',
      market: 'NIGHT_PROXY',
      country: 'KR',
      currency: 'KRW',
      assetType: 'night_proxy',
      provider: 'kis',
      providerSymbol: 'LSE:BC94',
      exchangeCode: 'TV',
      timezone: 'Europe/London',
      searchText: [
        '005930',
        '삼성전자',
        '삼성전자 야간',
        '삼야',
        'GDR',
        'LSE:BC94',
        '야간 환산가',
        '야간지표',
      ].join(' '),
    },
  ];
}

function loadCommodityIndicators(): NormalizedInstrument[] {
  const indicators: Array<{
    id: string;
    symbol: string;
    name: string;
    providerSymbol: string;
    keywords: string[];
  }> = [
    {
      id: 'GLOBAL:TV_COMMODITY:GOLD',
      symbol: 'GOLD',
      name: '금 선물',
      providerSymbol: 'COMEX:GC1!',
      keywords: ['금', '골드', 'gold', '원자재', '귀금속'],
    },
    {
      id: 'GLOBAL:TV_COMMODITY:SILVER',
      symbol: 'SILVER',
      name: '은 선물',
      providerSymbol: 'COMEX:SI1!',
      keywords: ['은', '실버', 'silver', '원자재', '귀금속'],
    },
    {
      id: 'GLOBAL:TV_COMMODITY:WTI',
      symbol: 'WTI',
      name: 'WTI 원유',
      providerSymbol: 'NYMEX:CL1!',
      keywords: ['원유', 'WTI', '유가', 'oil', 'crude', '원자재'],
    },
    {
      id: 'GLOBAL:TV_COMMODITY:NATGAS',
      symbol: 'NATGAS',
      name: '천연가스',
      providerSymbol: 'NYMEX:NG1!',
      keywords: ['천연가스', '가스', 'natural gas', 'natgas', '원자재'],
    },
  ];

  return indicators.map((indicator) => ({
    id: indicator.id,
    symbol: indicator.symbol,
    name: indicator.name,
    market: 'TV_COMMODITY',
    country: 'GLOBAL',
    currency: 'USD',
    assetType: 'commodity',
    provider: 'tradingview',
    providerSymbol: indicator.providerSymbol,
    exchangeCode: indicator.providerSymbol.split(':')[0] ?? 'TV',
    timezone: 'America/New_York',
    searchText: [indicator.symbol, indicator.name, indicator.providerSymbol, ...indicator.keywords].join(' '),
  }));
}

async function upsertInstruments(instruments: NormalizedInstrument[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE instruments SET is_active = false');

    const sql = `
      INSERT INTO instruments (
        id, symbol, name, english_name, market, country, currency, asset_type,
        provider, provider_symbol, exchange_code, timezone, is_active, search_text, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, true, $13, now()
      )
      ON CONFLICT (id) DO UPDATE SET
        symbol = EXCLUDED.symbol,
        name = EXCLUDED.name,
        english_name = EXCLUDED.english_name,
        market = EXCLUDED.market,
        country = EXCLUDED.country,
        currency = EXCLUDED.currency,
        asset_type = EXCLUDED.asset_type,
        provider = EXCLUDED.provider,
        provider_symbol = EXCLUDED.provider_symbol,
        exchange_code = EXCLUDED.exchange_code,
        timezone = EXCLUDED.timezone,
        is_active = true,
        search_text = EXCLUDED.search_text,
        updated_at = now()
    `;

    for (const item of instruments) {
      await client.query(sql, [
        item.id,
        item.symbol,
        item.name,
        item.englishName ?? null,
        item.market,
        item.country,
        item.currency,
        item.assetType,
        item.provider,
        item.providerSymbol,
        item.exchangeCode,
        item.timezone,
        item.searchText,
      ]);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function dedupe(instruments: NormalizedInstrument[]): NormalizedInstrument[] {
  return [...new Map(instruments.map((item) => [item.id, item])).values()];
}

async function readOptionalMaster(file: string): Promise<string | null> {
  try {
    return decoder.decode(await readFile(resolve(MASTER_DIR, file)));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return null;
    throw error;
  }
}

function mapOverseasAssetType(value: string | undefined): Instrument['assetType'] {
  if (value === '1') return 'index';
  if (value === '2') return 'stock';
  if (value === '3') return 'etf';
  return 'other';
}

function encodeInstrumentSymbol(symbol: string): string {
  return Buffer.from(symbol).toString('base64url');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb();
  });
