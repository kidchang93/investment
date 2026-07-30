import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inferDomesticAssetType } from '../db/assetTypes.js';
import { closeDb, pool } from '../db/client.js';
import { ensureDomesticAssetTypes, ensureInstrumentSchema } from '../db/instruments.js';
import { ensureThemeSchema, replaceThemes } from '../db/themes.js';
import { DOMESTIC_MASTER_SPECS, parseDomesticMasterRow } from '../kis/domesticMaster.js';
import { INDEX_SECTOR_MASTER_FILE, parseIndexSectorNames } from '../kis/indexSectorMaster.js';
import { describeMasterDownload, downloadMasters } from '../kis/masterDownload.js';
import { parseThemeMaster, THEME_MASTER_FILE } from '../kis/themeMaster.js';
import type { Instrument, InstrumentSector } from '@invest/shared';

/**
 * KIS 종목 마스터 파일(.mst/.COD)을 로컬 Postgres instruments 테이블로 동기화한다.
 * 원본 파일은 backend/.cache에 두고 커밋하지 않는다.
 *
 * 국내 마스터 5종(`kospi`·`kosdaq`·`konex`·`idxcode`·`theme_code`)은 **여기서 먼저
 * 받는다**. 예전에는 손으로 넣어서 파일이 20일~9개월 묵어도 아무도 몰랐다.
 * 받기·검증·갈아끼우기는 `kis/masterDownload.ts`에 있고, 12시간 안에 받은 것은
 * 다시 받지 않는다. 못 받으면 기존 파일로 계속 간다 — 마스터를 통째로 잃는 쪽이
 * 훨씬 나쁘기 때문이다. 아예 파일이 없으면 그때 던진다.
 * (해외·선물 마스터는 경로와 형식이 달라 아직 손으로 넣는다.)
 *
 * 테마 동기화도 여기에 붙어 있다. 별도 스크립트로 빼지 않은 이유는 테마가 종목
 * 코드를 `instruments.id`로 맞춰 저장하기 때문이다 — 종목이 먼저 들어가야 하고,
 * 둘을 따로 돌리면 "종목만 새것, 테마 연결은 옛것"인 상태가 만들어진다.
 * 명령 하나로 묶어 반쪽 동기화를 없앤다.
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
  await refreshDomesticMasters();

  await ensureInstrumentSchema();
  await ensureThemeSchema();

  const instruments = [
    ...(await loadDomesticInstruments()),
    ...(await loadOverseasInstruments()),
    ...(await loadOverseasFutureInstruments()),
    ...(await loadDomesticNightFutureInstruments()),
    ...loadNightProxyInstruments(),
    ...loadCommodityIndicators(),
  ];

  const unique = dedupe(instruments);
  await upsertInstruments(unique);
  await ensureDomesticAssetTypes();
  console.log(`종목 마스터 동기화 완료: ${unique.length.toLocaleString('ko-KR')}건`);
  // 업종이 몇 건에 붙었는지 남긴다. 한 칸 밀리면 여기 숫자부터 무너진다.
  const withLarge = unique.filter((item) => item.sectorLarge).length;
  const withMid = unique.filter((item) => item.sectorMid).length;
  console.log(
    `지수업종: 대분류 ${withLarge.toLocaleString('ko-KR')}건 · 중분류 ${withMid.toLocaleString('ko-KR')}건 ` +
      `(나머지 ${(unique.length - withLarge).toLocaleString('ko-KR')}건은 분류 없음)`,
  );

  await syncThemes();
}

/**
 * 국내 마스터 5종을 최신으로 맞춘다.
 *
 * **못 받아도 던지지 않는다.** 기존 파일이 남아 있으면 그걸로 동기화를 이어 간다 —
 * KIS 서버가 잠깐 죽었다고 종목 테이블이 통째로 비는 쪽이 훨씬 나쁘다. 대신 무엇이
 * 실패했는지, 그래서 쓰는 파일이 며칠 묵은 것인지 로그에 적는다.
 *
 * 쓸 파일이 아예 없을 때만 던진다. 그 상태로 계속 가면 아래 `readFile`이 ENOENT로
 * 죽는데, 여기서 미리 사유를 적어 주는 편이 낫다.
 *
 * `--no-download`로 끌 수 있다. 네트워크 없이 지금 파일 그대로 돌려 보고 싶을 때 쓴다.
 */
async function refreshDomesticMasters(): Promise<void> {
  if (process.argv.includes('--no-download')) {
    console.log('마스터 다운로드 건너뜀 (--no-download)');
    return;
  }

  const results = await downloadMasters({
    dir: MASTER_DIR,
    force: process.argv.includes('--force-download'),
  });
  for (const result of results) console.log(describeMasterDownload(result));

  const unusable = results.filter((result) => !result.usable);
  if (unusable.length > 0) {
    throw new Error(
      `마스터를 받지 못했고 기존 파일도 없습니다: ${unusable.map((r) => r.file).join(', ')}. ` +
        `네트워크를 확인하거나 파일을 ${MASTER_DIR}에 두고 다시 실행하세요.`,
    );
  }
}

/**
 * 테마 분류를 동기화한다. **종목을 넣은 뒤에 부른다** — 단축코드를 `instruments.id`로
 * 맞추므로 순서가 뒤집히면 연결이 통째로 비게 된다.
 *
 * 기준일은 마스터 파일의 수정 시각이다. zip 내부 타임스탬프가 그대로 남는 값이고,
 * 이 파일이 언제 만들어졌는지 알 수 있는 **유일한 단서**다. 파일을 `cp`로 옮기면
 * 시각이 오늘로 바뀌어 실제보다 새것으로 보일 수 있다는 한계는 있지만, 아무 기준일도
 * 없이 "지금 반도체 테마"라고 말하는 것보다는 낫다.
 */
async function syncThemes(): Promise<void> {
  const path = resolve(MASTER_DIR, THEME_MASTER_FILE);
  let text: string;
  let sourceModifiedAt: Date;
  try {
    text = decoder.decode(await readFile(path));
    sourceModifiedAt = (await stat(path)).mtime;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') throw error;
    throw new Error(
      `테마 코드 마스터가 없습니다: ${path}. ` +
        `KIS 공개 마스터 파일(${THEME_MASTER_FILE})을 backend/.cache에 두고 다시 실행하세요.`,
    );
  }

  const master = parseThemeMaster(text);
  const summary = await replaceThemes(master.names, master.members, sourceModifiedAt);

  const sourceDate = summary.sourceModifiedAt.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });
  const ageDays = Math.floor((Date.now() - summary.sourceModifiedAt.getTime()) / 86_400_000);
  console.log(
    `테마 동기화 완료: ${summary.themeCount.toLocaleString('ko-KR')}개 테마 · ` +
      `${summary.memberCount.toLocaleString('ko-KR')}쌍 (기준일 ${sourceDate}, ${ageDays.toLocaleString('ko-KR')}일 전)`,
  );
  // 낡음을 숫자로 남긴다. "몇 개 중 몇 개를 찾았는지"를 안 적으면 화면이 옛 목록을
  // 오늘 목록인 것처럼 보여 주게 된다.
  console.log(
    `테마 종목: 고유 ${summary.symbolCount.toLocaleString('ko-KR')}종목 중 ` +
      `${(summary.symbolCount - summary.missingSymbolCount).toLocaleString('ko-KR')}종목 연결 · ` +
      `${summary.missingSymbolCount.toLocaleString('ko-KR')}종목은 오늘자 종목 마스터에 없음(상장폐지·코드변경) · ` +
      `쌍 기준 ${summary.linkedMemberCount.toLocaleString('ko-KR')}/${summary.memberCount.toLocaleString('ko-KR')}`,
  );
}

async function loadDomesticInstruments(): Promise<NormalizedInstrument[]> {
  const sectorNames = await loadIndexSectorNames();
  const result: NormalizedInstrument[] = [];
  for (const spec of DOMESTIC_MASTER_SPECS) {
    const path = resolve(MASTER_DIR, spec.file);
    const text = decoder.decode(await readFile(path));
    for (const row of text.split(/\r?\n/)) {
      if (!row.trim()) continue;
      const { symbol, name, sector } = parseDomesticMasterRow(row, spec);
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
        sectorLarge: toInstrumentSector(sector.largeCode, sectorNames, spec.file, symbol),
        sectorMid: toInstrumentSector(sector.midCode, sectorNames, spec.file, symbol),
        searchText: [symbol, name, spec.market, 'KR', 'KRW'].join(' '),
      });
    }
  }
  return result;
}

/**
 * 지수업종 코드 → 이름 표를 읽는다.
 *
 * 파일이 없으면 던진다. 이름 없이 코드만 담아 두면 화면이 `0027`을 그대로 찍게 되고,
 * 조용히 비워 두면 "업종이 없는 종목"과 구별되지 않는다.
 */
async function loadIndexSectorNames(): Promise<Map<string, string>> {
  const path = resolve(MASTER_DIR, INDEX_SECTOR_MASTER_FILE);
  try {
    return parseIndexSectorNames(decoder.decode(await readFile(path)));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') throw error;
    throw new Error(
      `지수업종 코드 마스터가 없습니다: ${path}. ` +
        `KIS 공개 마스터 파일(${INDEX_SECTOR_MASTER_FILE})을 backend/.cache에 두고 다시 실행하세요.`,
    );
  }
}

/**
 * 업종 코드에 이름을 붙인다. 코드가 없으면 `undefined`다 — ETF·KONEX가 그렇고,
 * **분류가 없는 것이지 0이 아니다.**
 *
 * 코드가 있는데 표에 없으면 던진다. 마스터의 꼬리가 한 칸 밀렸거나 코드 마스터가
 * 낡았다는 뜻이라, 그대로 두면 엉뚱한 업종이 붙거나 빈 값이 섞인다.
 * (2026-07-31 실측: KOSPI·KOSDAQ의 업종 코드 4,207개가 전부 표에 있었다.
 *  종목 마스터를 2026-07-10~11자에서 2026-07-30자로 바꿔도 등장 개수가 4,207로
 *  같았다. 왜 같은지는 재지 않았다 — 들고 난 종목이 상쇄됐을 수 있다)
 */
function toInstrumentSector(
  code: string | null,
  names: Map<string, string>,
  file: string,
  symbol: string,
): InstrumentSector | undefined {
  if (!code) return undefined;
  const name = names.get(code);
  if (!name) {
    throw new Error(
      `${file}: 업종 코드를 ${INDEX_SECTOR_MASTER_FILE}에서 찾지 못했습니다 (종목 ${symbol}, 코드 ${code}). ` +
        `꼬리 자리가 밀렸거나 코드 마스터가 낡았습니다.`,
    );
  }
  return { code, name };
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
        provider, provider_symbol, exchange_code, timezone, is_active, search_text,
        sector_large_code, sector_large_name, sector_mid_code, sector_mid_name, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, true, $13,
        $14, $15, $16, $17, now()
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
        -- 업종이 빠진 종목은 NULL로 되돌린다. 옛 값을 남겨 두면 상장폐지·재분류를 못 따라간다.
        sector_large_code = EXCLUDED.sector_large_code,
        sector_large_name = EXCLUDED.sector_large_name,
        sector_mid_code = EXCLUDED.sector_mid_code,
        sector_mid_name = EXCLUDED.sector_mid_name,
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
        item.sectorLarge?.code ?? null,
        item.sectorLarge?.name ?? null,
        item.sectorMid?.code ?? null,
        item.sectorMid?.name ?? null,
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
