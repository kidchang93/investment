import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inferDomesticAssetType } from '../db/assetTypes.js';
import { closeDb, pool } from '../db/client.js';
import { ensureDomesticAssetTypes, ensureInstrumentSchema } from '../db/instruments.js';
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

const DOMESTIC_FILES = [
  { file: 'kospi_code.mst', market: 'KOSPI', tailLength: 228 },
  { file: 'kosdaq_code.mst', market: 'KOSDAQ', tailLength: 222 },
  { file: 'konex_code.mst', market: 'KONEX', tailLength: 184 },
] as const;

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
  ];

  await upsertInstruments(dedupe(instruments));
  await ensureDomesticAssetTypes();
  console.log(`종목 마스터 동기화 완료: ${instruments.length.toLocaleString('ko-KR')}건`);
}

async function loadDomesticInstruments(): Promise<NormalizedInstrument[]> {
  const result: NormalizedInstrument[] = [];
  for (const spec of DOMESTIC_FILES) {
    const path = resolve(MASTER_DIR, spec.file);
    const text = decoder.decode(await readFile(path));
    for (const row of text.split(/\r?\n/)) {
      if (!row.trim()) continue;
      const symbol = row.slice(0, 9).trim();
      const name = row.slice(21, row.length - spec.tailLength).trim();
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
