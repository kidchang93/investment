import { randomUUID } from 'node:crypto';
import { inferDomesticAssetType } from './assetTypes.js';
import { pool } from './client.js';
import type { Instrument, InstrumentCategory, WatchItem, WatchlistGroup } from '@invest/shared';

/**
 * 국내/해외 종목 마스터 저장소.
 * KIS 원본 종목 파일은 sync 스크립트에서 정규화하고, 서버는 이 타입만 조회한다.
 */

interface InstrumentRow {
  id: string;
  symbol: string;
  name: string;
  english_name: string | null;
  market: string;
  country: Instrument['country'];
  currency: string;
  asset_type: Instrument['assetType'];
  provider: Instrument['provider'];
  provider_symbol: string;
  exchange_code: string;
  timezone: string;
}

interface WatchlistRow {
  id: string;
  name: string;
  item_count: string;
}

interface DomesticAssetTypeRow {
  id: string;
  name: string;
  asset_type: Instrument['assetType'];
}

const DEFAULT_WATCHLIST_ID = 'default';
const TERMINAL_INSTRUMENT_IDS = [
  'KR:NIGHT_PROXY:005930',
  'KR:KRX_NIGHT:A01609',
  'GLOBAL:TV_COMMODITY:GOLD',
  'GLOBAL:TV_COMMODITY:SILVER',
  'GLOBAL:TV_COMMODITY:WTI',
  'GLOBAL:TV_COMMODITY:NATGAS',
] as const;

export const INSTRUMENT_CATEGORIES: InstrumentCategory[] = [
  {
    id: 'kr-major',
    label: '국내 대표주',
    description: '국내 대형주와 플랫폼/자동차 대표 종목',
  },
  {
    id: 'kr-all',
    label: '국내 전체',
    description: '국내 주식 전체 종목',
  },
  {
    id: 'us-megacap',
    label: '미국 대표주',
    description: '미국 빅테크와 시장 대표 종목',
  },
  {
    id: 'us-all',
    label: '미국 전체',
    description: '미국 주요 거래소 전체 종목',
  },
  {
    id: 'kr-etf',
    label: '국내 ETF/ETN',
    description: '국내 상장 ETF와 ETN',
  },
  {
    id: 'kr-etf-us',
    label: '미국·나스닥 ETF',
    description: '국내 상장 미국 지수/나스닥 ETF',
  },
  {
    id: 'kr-etf-income',
    label: '배당/커버드콜 ETF',
    description: '월배당, 배당성장, 커버드콜 ETF',
  },
  {
    id: 'kr-etf-bond',
    label: '채권/머니마켓 ETF',
    description: '국채, 회사채, CD금리, 머니마켓 ETF',
  },
  {
    id: 'kr-etf-leverage',
    label: '레버리지/인버스 ETF',
    description: '레버리지와 인버스 ETF',
  },
  {
    id: 'kr-etf-kodex',
    label: 'KODEX ETF',
    description: '삼성자산운용 KODEX ETF',
  },
  {
    id: 'kr-etf-tiger',
    label: 'TIGER ETF',
    description: '미래에셋 TIGER ETF',
  },
  {
    id: 'kr-etf-ace',
    label: 'ACE ETF',
    description: '한국투자 ACE ETF',
  },
  {
    id: 'kr-etf-kiwoom',
    label: 'KIWOOM ETF',
    description: '키움자산운용 ETF',
  },
  {
    id: 'us-etf',
    label: '해외 ETF',
    description: '미국 주요 지수/섹터 ETF와 해외 ETF',
  },
  {
    id: 'overseas-futures',
    label: '해외선물',
    description: '해외선물옵션 마스터의 해외선물 종목',
  },
  {
    id: 'kr-night-futures',
    label: '국내 야간선물',
    description: 'CME/KRX 연계 국내 야간 단일 선물 종목',
  },
  {
    id: 'kr-night-future-spreads',
    label: '야간선물 스프레드',
    description: '국내 야간선물 만기 간 스프레드 종목',
  },
  {
    id: 'kr-night-proxies',
    label: '야간 환산가',
    description: '해외 GDR과 환율로 환산한 국내 종목 야간 참고가',
  },
  {
    id: 'global-commodities',
    label: '원자재',
    description: '금, 은, 원유, 천연가스 등 글로벌 원자재 지표',
  },
  {
    id: 'kospi',
    label: 'KOSPI',
    description: '유가증권시장 종목',
  },
  {
    id: 'kosdaq',
    label: 'KOSDAQ',
    description: '코스닥시장 종목',
  },
  {
    id: 'nasdaq',
    label: 'NASDAQ',
    description: '나스닥 상장 종목',
  },
];

export async function ensureInstrumentSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS instruments (
      id text PRIMARY KEY,
      symbol text NOT NULL,
      name text NOT NULL,
      english_name text,
      market text NOT NULL,
      country text NOT NULL,
      currency text NOT NULL,
      asset_type text NOT NULL,
      provider text NOT NULL DEFAULT 'kis',
      provider_symbol text NOT NULL,
      exchange_code text NOT NULL,
      timezone text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      search_text text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS instruments_symbol_idx ON instruments (symbol);
    CREATE INDEX IF NOT EXISTS instruments_market_idx ON instruments (market);
    CREATE INDEX IF NOT EXISTS instruments_country_idx ON instruments (country);
    CREATE INDEX IF NOT EXISTS instruments_search_text_idx ON instruments USING gin (to_tsvector('simple', search_text));

    CREATE TABLE IF NOT EXISTS watchlists (
      id text PRIMARY KEY,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS watchlist_items (
      watchlist_id text NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
      instrument_id text NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
      position integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (watchlist_id, instrument_id)
    );

    CREATE INDEX IF NOT EXISTS watchlist_items_position_idx ON watchlist_items (watchlist_id, position);
  `);
  await pool.query(
    `
      INSERT INTO watchlists (id, name)
      VALUES ($1, '기본 관심종목')
      ON CONFLICT (id) DO NOTHING
    `,
    [DEFAULT_WATCHLIST_ID],
  );
}

export async function ensureDomesticAssetTypes(): Promise<void> {
  const result = await pool.query<DomesticAssetTypeRow>(`
    SELECT id, name, asset_type
    FROM instruments
    WHERE country = 'KR' AND is_active = true AND asset_type IN ('stock', 'etf', 'etn')
  `);

  const updates = result.rows
    .map((row) => ({ id: row.id, assetType: inferDomesticAssetType(row.name) }))
    .filter((row, index) => row.assetType !== result.rows[index].asset_type);

  if (updates.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const update of updates) {
      await client.query(
        `
          UPDATE instruments
          SET asset_type = $2, updated_at = now()
          WHERE id = $1
        `,
        [update.id, update.assetType],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function searchInstruments(query: string, limit = 30): Promise<Instrument[]> {
  const q = query.trim();
  if (!q) return [];

  const result = await pool.query<InstrumentRow>(
    `
      SELECT id, symbol, name, english_name, market, country, currency, asset_type,
             provider, provider_symbol, exchange_code, timezone
      FROM instruments
      WHERE is_active = true
        AND (
          symbol ILIKE $1 OR
          name ILIKE $1 OR
          COALESCE(english_name, '') ILIKE $1 OR
          search_text ILIKE $1
        )
      ORDER BY
        CASE WHEN symbol = upper($2) THEN 0 ELSE 1 END,
        CASE WHEN symbol ILIKE $3 THEN 0 ELSE 1 END,
        CASE WHEN country = 'KR' THEN 0 ELSE 1 END,
        symbol
      LIMIT $4
    `,
    [`%${q}%`, q, `${q}%`, limit],
  );

  return result.rows.map(rowToInstrument);
}

export async function getInstrument(id: string): Promise<Instrument | null> {
  const result = await pool.query<InstrumentRow>(
    `
      SELECT id, symbol, name, english_name, market, country, currency, asset_type,
             provider, provider_symbol, exchange_code, timezone
      FROM instruments
      WHERE id = $1 AND is_active = true
    `,
    [id],
  );
  return result.rows[0] ? rowToInstrument(result.rows[0]) : null;
}

/**
 * 종목코드 여러 개를 한 번에 찾는다. 국내만 본다.
 *
 * KIS 순위 API는 종목코드와 이름만 준다 — 우리 화면이 그 종목으로 옮겨 가려면
 * `instrumentId`가 필요하다. 마스터에 없는 종목(신규 상장·우선주 일부)은 그냥
 * 빠진다. **없는 것을 억지로 만들지 않고, 화면이 "이 종목은 열 수 없다"고 적는다.**
 */
export async function getDomesticInstrumentsBySymbols(
  symbols: string[],
): Promise<Map<string, Instrument>> {
  const unique = [...new Set(symbols.filter((s) => s.length > 0))];
  if (unique.length === 0) return new Map();
  const result = await pool.query<InstrumentRow>(
    `
      SELECT id, symbol, name, english_name, market, country, currency, asset_type,
             provider, provider_symbol, exchange_code, timezone
      FROM instruments
      WHERE symbol = ANY($1) AND country = 'KR' AND is_active = true
    `,
    [unique],
  );
  const bySymbol = new Map<string, Instrument>();
  for (const row of result.rows) {
    const instrument = rowToInstrument(row);
    // 같은 코드가 여러 시장에 있으면 먼저 온 것을 쓴다. 국내는 사실상 유일하다.
    if (!bySymbol.has(instrument.symbol)) bySymbol.set(instrument.symbol, instrument);
  }
  return bySymbol;
}

export async function getTerminalInstruments(): Promise<Instrument[]> {
  return getByIds([...TERMINAL_INSTRUMENT_IDS]);
}

export function getInstrumentCategories(): InstrumentCategory[] {
  return INSTRUMENT_CATEGORIES;
}

export async function getCategoryInstruments(categoryId: string, limit = 300, query = ''): Promise<Instrument[]> {
  switch (categoryId) {
    case 'kr-major':
      return filterByQuery(
        await getBySymbols(['005930', '000660', '035420', '035720', '005380', '012450', '068270'], [
          'KOSPI',
          'KOSDAQ',
        ]),
        query,
      );
    case 'us-megacap':
      return filterByQuery(
        await getBySymbols(['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'NFLX'], [
          'NAS',
          'NYS',
          'AMS',
        ]),
        query,
      );
    case 'kr-all':
      return getByFilter("country = 'KR' AND asset_type = 'stock'", limit, query);
    case 'us-all':
      return getByFilter("country = 'US' AND asset_type = 'stock'", limit, query);
    case 'us-etf':
      return getByFilter("country = 'US' AND asset_type = 'etf'", limit, query);
    case 'overseas-futures':
      return getByFilter("market = 'OV_FUT' AND asset_type = 'future'", limit, query);
    case 'kr-night-futures':
      return getByFilter("market = 'KRX_NIGHT' AND asset_type = 'future'", limit, query);
    case 'kr-night-future-spreads':
      return getByFilter("market = 'KRX_NIGHT' AND asset_type = 'future_spread'", limit, query);
    case 'kr-night-proxies':
      return getByFilter("market = 'NIGHT_PROXY' AND asset_type = 'night_proxy'", limit, query);
    case 'global-commodities':
      return getByFilter("market = 'TV_COMMODITY' AND asset_type = 'commodity'", limit, query);
    case 'kr-etf':
      return getByFilter("country = 'KR' AND asset_type IN ('etf', 'etn')", limit, query);
    case 'kr-etf-us':
      return getByFilter(
        "country = 'KR' AND asset_type = 'etf' AND (name ILIKE '%미국%' OR name ILIKE '%나스닥%' OR name ILIKE '%S&P%' OR name ILIKE '%NASDAQ%')",
        limit,
        query,
      );
    case 'kr-etf-income':
      return getByFilter(
        "country = 'KR' AND asset_type = 'etf' AND (name ILIKE '%배당%' OR name ILIKE '%커버드콜%' OR name ILIKE '%월배당%')",
        limit,
        query,
      );
    case 'kr-etf-bond':
      return getByFilter(
        "country = 'KR' AND asset_type = 'etf' AND (name ILIKE '%채권%' OR name ILIKE '%국채%' OR name ILIKE '%회사채%' OR name ILIKE '%CD금리%' OR name ILIKE '%머니마켓%')",
        limit,
        query,
      );
    case 'kr-etf-leverage':
      return getByFilter(
        "country = 'KR' AND asset_type = 'etf' AND (name ILIKE '%레버리지%' OR name ILIKE '%인버스%')",
        limit,
        query,
      );
    case 'kr-etf-kodex':
      return getByFilter("country = 'KR' AND asset_type = 'etf' AND name ILIKE 'KODEX%'", limit, query);
    case 'kr-etf-tiger':
      return getByFilter("country = 'KR' AND asset_type = 'etf' AND name ILIKE 'TIGER%'", limit, query);
    case 'kr-etf-ace':
      return getByFilter("country = 'KR' AND asset_type = 'etf' AND name ILIKE 'ACE%'", limit, query);
    case 'kr-etf-kiwoom':
      return getByFilter("country = 'KR' AND asset_type = 'etf' AND name ILIKE 'KIWOOM%'", limit, query);
    case 'kospi':
      return getByFilter("market = 'KOSPI' AND asset_type = 'stock'", limit, query);
    case 'kosdaq':
      return getByFilter("market = 'KOSDAQ' AND asset_type = 'stock'", limit, query);
    case 'nasdaq':
      return getByFilter("market = 'NAS' AND asset_type = 'stock'", limit, query);
    default:
      return [];
  }
}

export async function getDefaultWatchlist(): Promise<Instrument[]> {
  return getWatchlistItems(DEFAULT_WATCHLIST_ID);
}

export async function getWatchlists(): Promise<WatchlistGroup[]> {
  const result = await pool.query<WatchlistRow>(`
    SELECT w.id, w.name, count(wi.instrument_id)::text AS item_count
    FROM watchlists w
    LEFT JOIN watchlist_items wi ON wi.watchlist_id = w.id
    GROUP BY w.id, w.name, w.created_at
    ORDER BY
      CASE WHEN w.id = $1 THEN 0 ELSE 1 END,
      w.created_at,
      w.name
  `, [DEFAULT_WATCHLIST_ID]);

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    itemCount: Number(row.item_count),
  }));
}

export async function createWatchlist(name: string): Promise<WatchlistGroup> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('관심그룹 이름이 필요합니다.');

  const id = `wl_${randomUUID()}`;
  const result = await pool.query<{ id: string; name: string }>(
    `
      INSERT INTO watchlists (id, name)
      VALUES ($1, $2)
      RETURNING id, name
    `,
    [id, trimmed],
  );

  return { id: result.rows[0].id, name: result.rows[0].name, itemCount: 0 };
}

export async function deleteWatchlist(id: string): Promise<boolean> {
  if (id === DEFAULT_WATCHLIST_ID) return false;
  const result = await pool.query('DELETE FROM watchlists WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function getWatchlistItems(watchlistId: string): Promise<Instrument[]> {
  const result = await pool.query<InstrumentRow>(
    `
      SELECT i.id, i.symbol, i.name, i.english_name, i.market, i.country, i.currency,
             i.asset_type, i.provider, i.provider_symbol, i.exchange_code, i.timezone
      FROM watchlist_items wi
      JOIN instruments i ON i.id = wi.instrument_id
      WHERE wi.watchlist_id = $1 AND i.is_active = true
      ORDER BY wi.position, wi.created_at, i.symbol
    `,
    [watchlistId],
  );
  return result.rows.map(rowToInstrument);
}

export async function seedDefaultWatchlist(items: WatchItem[]): Promise<void> {
  const count = await pool.query<{ count: string }>(
    'SELECT count(*) FROM watchlist_items WHERE watchlist_id = $1',
    [DEFAULT_WATCHLIST_ID],
  );
  if (Number(count.rows[0]?.count ?? 0) > 0) return;

  for (const [index, item] of items.entries()) {
    const instrument = await pool.query<{ id: string }>(
      `
        SELECT id
        FROM instruments
        WHERE country = 'KR' AND symbol = $1 AND is_active = true
        ORDER BY
          CASE market WHEN 'KOSPI' THEN 0 WHEN 'KOSDAQ' THEN 1 WHEN 'KONEX' THEN 2 ELSE 3 END
        LIMIT 1
      `,
      [item.code],
    );
    const id = instrument.rows[0]?.id;
    if (!id) continue;
    await pool.query(
      `
        INSERT INTO watchlist_items (watchlist_id, instrument_id, position)
        VALUES ($1, $2, $3)
        ON CONFLICT (watchlist_id, instrument_id) DO NOTHING
      `,
      [DEFAULT_WATCHLIST_ID, id, index],
    );
  }
}

export async function addDefaultWatchlistItem(instrumentId: string): Promise<Instrument | null> {
  return addWatchlistItem(DEFAULT_WATCHLIST_ID, instrumentId);
}

export async function addWatchlistItem(watchlistId: string, instrumentId: string): Promise<Instrument | null> {
  const instrument = await getInstrument(instrumentId);
  if (!instrument) return null;
  await pool.query(
    `
      INSERT INTO watchlist_items (watchlist_id, instrument_id, position)
      VALUES (
        $1,
        $2,
        COALESCE((SELECT max(position) + 1 FROM watchlist_items WHERE watchlist_id = $1), 0)
      )
      ON CONFLICT (watchlist_id, instrument_id) DO NOTHING
    `,
    [watchlistId, instrumentId],
  );
  return instrument;
}

export async function removeDefaultWatchlistItem(instrumentId: string): Promise<void> {
  await removeWatchlistItem(DEFAULT_WATCHLIST_ID, instrumentId);
}

export async function removeWatchlistItem(watchlistId: string, instrumentId: string): Promise<void> {
  await pool.query(
    'DELETE FROM watchlist_items WHERE watchlist_id = $1 AND instrument_id = $2',
    [watchlistId, instrumentId],
  );
}

async function getBySymbols(symbols: string[], markets: string[]): Promise<Instrument[]> {
  const result = await pool.query<InstrumentRow>(
    `
      SELECT DISTINCT ON (symbol)
             id, symbol, name, english_name, market, country, currency, asset_type,
             provider, provider_symbol, exchange_code, timezone
      FROM instruments
      WHERE is_active = true
        AND symbol = ANY($1)
        AND market = ANY($2)
      ORDER BY
        symbol,
        array_position($1, symbol),
        array_position($2, market)
    `,
    [symbols, markets],
  );
  return result.rows
    .map(rowToInstrument)
    .sort((a, b) => symbols.indexOf(a.symbol) - symbols.indexOf(b.symbol));
}

async function getByIds(ids: string[]): Promise<Instrument[]> {
  const result = await pool.query<InstrumentRow>(
    `
      SELECT id, symbol, name, english_name, market, country, currency, asset_type,
             provider, provider_symbol, exchange_code, timezone
      FROM instruments
      WHERE is_active = true AND id = ANY($1)
      ORDER BY array_position($1, id)
    `,
    [ids],
  );
  return result.rows.map(rowToInstrument);
}

async function getByFilter(whereSql: string, limit: number, query = ''): Promise<Instrument[]> {
  const q = query.trim();
  const result = await pool.query<InstrumentRow>(
    `
      SELECT id, symbol, name, english_name, market, country, currency, asset_type,
             provider, provider_symbol, exchange_code, timezone
      FROM instruments
      WHERE is_active = true AND ${whereSql}
        AND (
          $2 = '' OR
          symbol ILIKE $3 OR
          name ILIKE $3 OR
          COALESCE(english_name, '') ILIKE $3 OR
          search_text ILIKE $3
        )
      ORDER BY
        CASE WHEN $2 <> '' AND symbol = upper($2) THEN 0 ELSE 1 END,
        CASE WHEN $2 <> '' AND symbol ILIKE $4 THEN 0 ELSE 1 END,
        CASE WHEN $2 <> '' AND country = 'KR' THEN 0 ELSE 1 END,
        symbol
      LIMIT $1
    `,
    [limit, q, `%${q}%`, `${q}%`],
  );
  return result.rows.map(rowToInstrument);
}

function filterByQuery(instruments: Instrument[], query: string): Instrument[] {
  const q = query.trim().toLowerCase();
  if (!q) return instruments;
  return instruments.filter(
    (instrument) =>
      instrument.symbol.toLowerCase().includes(q) ||
      instrument.name.toLowerCase().includes(q) ||
      (instrument.englishName?.toLowerCase().includes(q) ?? false),
  );
}

function rowToInstrument(row: InstrumentRow): Instrument {
  return {
    id: row.id,
    symbol: row.symbol,
    name: row.name,
    englishName: row.english_name ?? undefined,
    market: row.market,
    country: row.country,
    currency: row.currency,
    assetType: row.asset_type,
    provider: row.provider,
    providerSymbol: row.provider_symbol,
    exchangeCode: row.exchange_code,
    timezone: row.timezone,
  };
}
