/**
 * KRX KIND 상장폐지 목록을 받아 **DB에 쌓는다.** 재는 것도 주문도 하지 않는다.
 *
 * ── 왜 (2026-08-13) ──────────────────────────────────────────────────────
 *
 * 일봉 21년 패널 3,923종목에 상장폐지가 사실상 0건이다. 유니버스가 오늘자 마스터
 * (`instruments.is_active = true`)에서 나오기 때문이고, 그래서 **되돌아오지 못한
 * 종목만 골라 지운 표본**에서 반전 신호를 재고 있었다. KIND 목록과 대조한 연도별
 * 누락률은 2005년 35.2% · 2010년 26.4% · 2018년 8.8% · 전체 23.2%다.
 *
 * ── 이 스크립트가 하는 것 ────────────────────────────────────────────────
 *
 *   1. KIND 목록을 4벌 받는다 — 전체 + 유가·코스닥·코넥스(전체에는 시장 열이 없다)
 *   2. `instrument_delistings`에 넣는다 (지우지 않는다 · 짝은 코드+폐지일)
 *   3. 마스터에 없는 코드를 `instruments`에 **비활성으로** 넣는다
 *   4. **어긋나는 것을 세어 적는다** — 폐지 목록에 있는데 마스터가 활성인 코드,
 *      두 번 이상 폐지된 코드(재상장), 시장을 못 붙인 코드
 *
 * ★ **KIS를 부르지 않는다.** 앱키도 토큰도 쓰지 않고, KIND는 로그인 없이 열려 있다.
 *
 * ★ 이 목록은 "폐지됐다"는 KIND의 말이지 **거래가 끝난 날이 아니다.** 012210
 * (삼미금속)은 2025-12-29 폐지로 적혀 있는데 봉은 오늘까지 온다. 계열을 끊는 판단은
 * 봉이 하고(`collectDelistedBars.ts`), 여기서는 목록을 사실대로 담기만 한다.
 *
 *   npx tsx src/scripts/collectDelistings.ts [--from 20050101] [--to 20260813] [--dry-run]
 */

import { closeDb, pool } from '../db/client.js';
import {
  ensureDelistingSchema,
  summarizeDelistings,
  upsertDelistings,
} from '../db/delistings.js';
import { ensureInstrumentSchema, insertInactiveInstruments } from '../db/instruments.js';
import { fetchDelistings, type DelistingRecord } from '../krx/kindDelistings.js';

/** KIND 목록의 시작. 일봉 저장소가 덮는 구간(21.4년)과 맞춘 값이다. */
const DEFAULT_FROM_DAY = '20050101';

interface Options {
  fromDay: string;
  toDay: string;
  /** 받아서 세어만 보고 DB는 건드리지 않는다 */
  dryRun: boolean;
}

function kstToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()).replace(/-/g, '');
}

function parseOptions(argv: string[]): Options {
  const options: Options = { fromDay: DEFAULT_FROM_DAY, toDay: kstToday(), dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const next = (): string => argv[(index += 1)] ?? '';
    switch (argv[index]) {
      case '--from':
        options.fromDay = next();
        break;
      case '--to':
        options.toDay = next();
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        throw new Error(`모르는 인자입니다: ${argv[index]}`);
    }
  }
  for (const day of [options.fromDay, options.toDay]) {
    if (!/^\d{8}$/.test(day)) throw new Error(`날짜는 YYYYMMDD입니다: ${day}`);
  }
  return options;
}

function formatDay(day: string | null): string {
  if (!day) return '-';
  return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
}

function count(value: number): string {
  return value.toLocaleString('ko-KR');
}

/** 같은 코드가 여러 번 나온 것. 재상장이거나 코드가 다시 쓰인 것이다. */
function multiEpisodes(records: DelistingRecord[]): Map<string, DelistingRecord[]> {
  const bySymbol = new Map<string, DelistingRecord[]>();
  for (const record of records) {
    const list = bySymbol.get(record.symbol) ?? [];
    list.push(record);
    bySymbol.set(record.symbol, list);
  }
  return new Map([...bySymbol].filter(([, list]) => list.length > 1));
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  console.log(
    `KIND 상장폐지 목록 · ${formatDay(options.fromDay)} ~ ${formatDay(options.toDay)}`
    + ` · KIS 호출 0회 (로그인·앱키 없이 열려 있다)`,
  );

  const fetched = await fetchDelistings(options.fromDay, options.toDay);
  const folded = fetched.totalRows - fetched.records.length;
  console.log(
    `받은 행 ${count(fetched.totalRows)}`
    + (folded > 0 ? ` · 같은 (코드,폐지일)이 겹쳐 접힌 것 ${count(folded)}` : '')
    + ` · 고유 코드 ${count(new Set(fetched.records.map((r) => r.symbol)).size)}`,
  );
  console.log(
    `시장별: ${fetched.byMarket.map((m) => `${m.market} ${count(m.rows)}`).join(' · ')}`
    + ` · 합 ${count(fetched.byMarket.reduce((sum, m) => sum + m.rows, 0))}`,
  );
  if (fetched.marketUnknown > 0) {
    console.log(`  ★ 시장을 못 붙인 건수 ${count(fetched.marketUnknown)} — 그 코드는 마스터에 넣지 않는다`);
  }
  if (fetched.marketOnly > 0) {
    console.log(
      `  ★ 시장별 목록에만 있고 전체 목록에는 없는 건수 ${count(fetched.marketOnly)}`
      + ' — 두 목록이 어긋났다는 뜻이다',
    );
  }

  const repeats = multiEpisodes(fetched.records);
  console.log(`\n두 번 이상 폐지된 코드 ${count(repeats.size)}개 (재상장·코드 재사용)`);
  for (const [symbol, list] of [...repeats].slice(0, 20)) {
    console.log(
      `  ${symbol}  ${list.map((r) => `${formatDay(r.delistedOn)} ${r.name}`).join('  |  ')}`,
    );
  }
  console.log('  → 이 코드들은 일봉 수집에서 뺀다. 어느 구간이 어느 회사인지 가를 근거가 없다.');

  if (options.dryRun) {
    console.log('\n--dry-run이라 DB는 건드리지 않았다.');
    return;
  }

  await ensureInstrumentSchema();
  await ensureDelistingSchema();

  const now = Date.now();
  const saved = await upsertDelistings(
    fetched.records.map((record) => ({
      symbol: record.symbol,
      delistedOn: record.delistedOn,
      name: record.name,
      market: record.market,
      reason: record.reason,
      note: record.note,
    })),
    'KIND',
    kstToday(),
    now,
  );
  console.log(`\n폐지 기록 저장: 새로 ${count(saved.inserted)}건 · 이미 있던 것 갱신 ${count(saved.updated)}건`);

  /*
   * 마스터에 없는 코드를 비활성으로 넣는다. 코드 하나에 여러 에피소드가 있으면
   * **가장 최근 이름**을 쓴다 — 옛 회사 이름으로 남으면 사람이 알아볼 수 없다.
   */
  const latestBySymbol = new Map<string, DelistingRecord>();
  for (const record of fetched.records) {
    const previous = latestBySymbol.get(record.symbol);
    if (!previous || record.delistedOn > previous.delistedOn) latestBySymbol.set(record.symbol, record);
  }
  const seeded = await insertInactiveInstruments(
    [...latestBySymbol.values()].map((record) => ({
      symbol: record.symbol,
      name: record.name,
      market: record.market,
    })),
  );
  console.log(
    `마스터에 넣은 폐지 코드 ${count(seeded.inserted)}개(is_active=false)`
    + ` · 이미 있던 코드 ${count(seeded.alreadyPresent)}개`
    + (seeded.skippedNoMarket > 0 ? ` · 시장을 몰라 못 넣은 코드 ${count(seeded.skippedNoMarket)}개` : ''),
  );

  /*
   * ★ 폐지 목록에 있는데 마스터가 **활성**인 코드. 둘 중 하나인데 여기서는 못 가른다.
   *   ① 마스터가 폐지를 아직 못 따라갔다 (최근에 폐지된 것)
   *   ② 폐지 목록과 달리 거래가 안 끊겼다 (012210 삼미금속)
   * 가릴 수 있는 것은 봉뿐이라, 여기서는 **몇 개인지와 무엇인지만** 적는다.
   */
  const active = await pool.query<{ symbol: string; name: string; delisted_on: string; reason: string }>(
    `SELECT i.symbol, i.name, d.delisted_on, d.reason
     FROM instruments i
     JOIN instrument_delistings d ON d.symbol = i.symbol
     WHERE i.country = 'KR' AND i.is_active = true
     ORDER BY d.delisted_on DESC, i.symbol`,
  );
  console.log(`\n★ 폐지 목록에 있는데 마스터가 활성인 코드 ${count(active.rowCount ?? 0)}개`);
  for (const row of active.rows.slice(0, 20)) {
    console.log(`  ${row.symbol} ${row.name.slice(0, 12).padEnd(14)} ${formatDay(row.delisted_on)}  ${row.reason.slice(0, 40)}`);
  }
  if ((active.rowCount ?? 0) > 20) console.log(`  … 그리고 ${count((active.rowCount ?? 0) - 20)}개 더`);
  console.log('  → 마스터가 폐지를 못 따라간 것일 수도, 거래가 안 끊긴 것일 수도 있다.');
  console.log('    일봉 수집은 이 코드들을 건드리지 않는다 (살아 있는 계열의 주인은 collectDailyBars다).');

  const summary = await summarizeDelistings();
  console.log(
    `\n저장소 전체: 기록 ${count(summary.records)}건 · 코드 ${count(summary.symbols)}개`
    + ` · ${formatDay(summary.oldestDay)} ~ ${formatDay(summary.newestDay)}`
    + ` · 시장 미상 ${count(summary.marketUnknown)}건 · 재상장 코드 ${count(summary.multiEpisodeSymbols)}개`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
