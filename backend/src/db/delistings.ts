/**
 * 상장폐지 기록 저장소. **생존편향을 재고 걷어내는 근거 자료다.**
 *
 * ── 왜 `instruments`의 열이 아니라 별도 표인가 ───────────────────────────
 *
 * 세 가지 이유가 있고, 셋 다 실측으로 확인된 것이다(2026-08-13).
 *
 * **① 같은 코드가 두 번 이상 폐지된다.** 013890(지누스)은 2005-05-18에 자본전액잠식으로
 * 폐지됐는데 우리 봉은 2019-10-30부터 있다 — 같은 코드로 다른 회사가 다시 상장한
 * 것이다. 이런 코드가 7개다. `instruments`에 `delisted_on` 한 칸을 두면 에피소드가
 * 하나만 남고, **과거 에피소드가 현재 계열에 붙는다.**
 *
 * **② `instruments`는 오늘의 마스터다.** `scripts/syncInstruments.ts`는 매번 전체를
 * `is_active = false`로 밀고 오늘 마스터에 있는 것만 다시 켠다. 폐지는 **과거 사실**이라
 * 수명이 다르다. 오늘 마스터가 무엇을 담든 2008년에 우영이 폐지된 것은 그대로다.
 *
 * **③ 목록이 말하는 것과 봉이 말하는 것이 다르다.** 012210(삼미금속)은 2025-12-29
 * 폐지로 적혀 있는데 일봉은 오늘까지 이어진다(형식적 변경상장으로 보인다). 폐지 목록과
 * `is_active`를 한 칸에 뭉치면 **어느 쪽이 사실인지 물을 수조차 없다.** 그래서 여기는
 * KIND가 말한 것만 담고, `is_active`는 건드리지 않는다.
 *
 * ── 이 표를 쓰는 곳 ──────────────────────────────────────────────────────
 *
 *   scripts/collectDelistings.ts   KIND 목록 → 이 표 (+ 없는 코드는 instruments에 비활성으로)
 *   scripts/collectDelistedBars.ts 이 표 + instruments → 폐지 종목 일봉 수집 대상
 *   scripts/verifyDailyBars.ts     저장소에 폐지 계열이 정말 들어왔는지 검사
 *
 * 이 모듈은 조회·저장만 한다. 주문 경로가 아니다.
 */

import type { Instrument } from '@invest/shared';

import { pool } from './client.js';
import type { DailyBar } from './dailyBars.js';
import { instrumentColumns, rowToInstrument, type InstrumentRow } from './instruments.js';

/** 저장된 폐지 한 건. KIND가 말한 것 + 언제 받았는지. */
export interface DelistingRow {
  symbol: string;
  /** `YYYYMMDD` */
  delistedOn: string;
  name: string;
  /** `KOSPI` · `KOSDAQ` · `KONEX`. 못 붙였으면 `null` — 짐작해서 채우지 않는다 */
  market: string | null;
  reason: string;
  note: string | null;
  /** 어디서 왔나. 지금은 `KIND` 하나뿐이지만 출처가 둘이 되면 가려야 한다 */
  source: string;
  /** 받은 날 `YYYYMMDD`. 목록도 낡는다 */
  vintage: string;
}

export async function ensureDelistingSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS instrument_delistings (
      symbol       TEXT   NOT NULL,
      delisted_on  TEXT   NOT NULL,
      name         TEXT   NOT NULL,
      market       TEXT,
      reason       TEXT   NOT NULL,
      note         TEXT,
      source       TEXT   NOT NULL,
      vintage      TEXT   NOT NULL,
      fetched_at   BIGINT NOT NULL,
      /* 같은 코드가 여러 번 폐지된다 — 짝은 (코드, 폐지일)이다 */
      PRIMARY KEY (symbol, delisted_on)
    );

    CREATE INDEX IF NOT EXISTS instrument_delistings_day_idx
      ON instrument_delistings (delisted_on);
  `);
}

/**
 * 받아 온 목록을 넣는다. **지우지 않는다.**
 *
 * KIND는 구간을 좁혀 받을 수 있어서, 지우고 넣으면 이번에 안 받은 구간의 기록이
 * 사라진다. 이미 있는 (코드, 폐지일)은 이름·사유가 바뀌었을 수 있으니 갱신한다.
 */
export async function upsertDelistings(
  records: Array<Omit<DelistingRow, 'source' | 'vintage'>>,
  source: string,
  vintage: string,
  fetchedAt: number,
): Promise<{ inserted: number; updated: number }> {
  if (records.length === 0) return { inserted: 0, updated: 0 };
  const before = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM instrument_delistings',
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const record of records) {
      await client.query(
        `INSERT INTO instrument_delistings
           (symbol, delisted_on, name, market, reason, note, source, vintage, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (symbol, delisted_on) DO UPDATE SET
           name = EXCLUDED.name,
           market = COALESCE(EXCLUDED.market, instrument_delistings.market),
           reason = EXCLUDED.reason,
           note = EXCLUDED.note,
           source = EXCLUDED.source,
           vintage = EXCLUDED.vintage,
           fetched_at = EXCLUDED.fetched_at`,
        [
          record.symbol,
          record.delistedOn,
          record.name,
          record.market,
          record.reason,
          record.note,
          source,
          vintage,
          fetchedAt,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const after = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM instrument_delistings',
  );
  const inserted = Number(after.rows[0].count) - Number(before.rows[0].count);
  return { inserted, updated: records.length - inserted };
}

/** 폐지 기록 전부. 코드·폐지일 오름차순이다. */
export async function getDelistings(): Promise<DelistingRow[]> {
  const { rows } = await pool.query<{
    symbol: string;
    delisted_on: string;
    name: string;
    market: string | null;
    reason: string;
    note: string | null;
    source: string;
    vintage: string;
  }>(
    `SELECT symbol, delisted_on, name, market, reason, note, source, vintage
     FROM instrument_delistings
     ORDER BY symbol, delisted_on`,
  );
  return rows.map((row) => ({
    symbol: row.symbol,
    delistedOn: row.delisted_on,
    name: row.name,
    market: row.market,
    reason: row.reason,
    note: row.note,
    source: row.source,
    vintage: row.vintage,
  }));
}

/** 폐지 기록 요약. 수집 전후를 한 줄로 견준다. */
export interface DelistingStoreSummary {
  records: number;
  symbols: number;
  oldestDay: string | null;
  newestDay: string | null;
  /** 시장을 못 붙인 건수 */
  marketUnknown: number;
  /** 두 번 이상 폐지된 코드 수 = 재상장 후보 */
  multiEpisodeSymbols: number;
}

export async function summarizeDelistings(): Promise<DelistingStoreSummary> {
  const { rows } = await pool.query<{
    records: string; symbols: string; oldest: string | null; newest: string | null; unknown: string;
  }>(
    `SELECT count(*)::text AS records, count(DISTINCT symbol)::text AS symbols,
            min(delisted_on) AS oldest, max(delisted_on) AS newest,
            count(*) FILTER (WHERE market IS NULL)::text AS unknown
     FROM instrument_delistings`,
  );
  const multi = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM (
       SELECT symbol FROM instrument_delistings GROUP BY symbol HAVING count(*) > 1
     ) t`,
  );
  const row = rows[0];
  return {
    records: Number(row?.records ?? 0),
    symbols: Number(row?.symbols ?? 0),
    oldestDay: row?.oldest ?? null,
    newestDay: row?.newest ?? null,
    marketUnknown: Number(row?.unknown ?? 0),
    multiEpisodeSymbols: Number(multi.rows[0]?.count ?? 0),
  };
}

/**
 * 폐지 종목 일봉을 받을 후보. **`getDomesticHistoryUniverse`가 못 주는 쪽이다** —
 * 그쪽은 `is_active = true`로 걸러서 폐지 종목이 통째로 빠진다.
 *
 * 여기서 걸러 두는 것은 둘뿐이다.
 *
 * - **KONEX 제외.** 활성 유니버스와 같은 기준이다(유동성이 없어 측정에 못 쓴다).
 *   폐지 목록의 15%가 코넥스라 안 빼면 받는 시간만 늘어난다.
 * - **주식·ETF만.** 이름으로 추정한 `asset_type`이라 완벽하지는 않다.
 *
 * **지금 살아 있는 코드도 그대로 준다.** 걸러 내는 판단은 `planDelistedCollection`이
 * 하고, 왜 뺐는지 세어 적는다 — 여기서 조용히 빼면 840개가 800개가 된 이유를
 * 아무도 모른다.
 */
export interface DelistedCandidateRow {
  instrument: Instrument;
  /** 지금 마스터에 살아 있나. **폐지 목록에 있어도 `true`일 수 있다** */
  isActive: boolean;
  /**
   * 이 코드의 폐지 기록 전부, 날짜 오름차순.
   *
   * ★ **사유를 날짜와 함께 든다.** 둘 이상이라고 다 재상장이 아니다 —
   * 시장을 옮긴 것(`코스닥시장 이전상장`)이 폐지로 기록되고 그 회사가 나중에
   * 진짜 폐지되면 기록이 둘이 된다. 그때 첫 기록의 **사유**가 그것을 가른다.
   */
  delistedEpisodes: Array<{ day: string; reason: string }>;
}

/**
 * ★ **시장을 옮긴 것은 퇴장이 아니다.**
 *
 * 코스닥→코스피 이전상장이 KIND에 상장폐지로 기록된다. 그 회사는 같은
 * 종목코드로 계속 거래되므로 봉도 하나의 연속된 계열이다.
 *
 * 정확히 이 세 표현만 잡는다(2026-08-14 실측: `코스닥시장 이전상장` 70건 ·
 * `유가증권시장 상장` 33건 · `코스닥시장 상장`). 느슨하게 하면 `상장폐지`가 든
 * 사유가 섞이므로 **문장 전체를 못 박는다.** 못 잡으면 지금처럼 빠질 뿐이라
 * 안전한 쪽으로 틀린다.
 */
export function isMarketTransfer(reason: string): boolean {
  return /^(코스닥|유가증권|코넥스)시장 (이전)?상장$/.test(reason.trim());
}

export async function getDelistedCandidates(): Promise<DelistedCandidateRow[]> {
  /*
   * 같은 코드가 두 시장에 있으면(드물다) 한 줄만 쓴다 — 두 줄이면 같은 종목을
   * 두 번 받고 뒤엣것이 앞엣것을 갈아 끼운다. 고르는 순서는 관심종목 seed와 같다.
   */
  const { rows } = await pool.query<
    InstrumentRow & { is_active: boolean; delisted_days: string[]; delisted_reasons: string[] }
  >(
    `SELECT DISTINCT ON (i.symbol) ${instrumentColumns('i.')}, i.is_active,
            d.delisted_days, d.delisted_reasons
     FROM instruments i
     JOIN (
       SELECT symbol,
              array_agg(delisted_on ORDER BY delisted_on) AS delisted_days,
              array_agg(reason ORDER BY delisted_on)      AS delisted_reasons
       FROM instrument_delistings
       GROUP BY symbol
     ) d ON d.symbol = i.symbol
     WHERE i.country = 'KR'
       AND i.market <> 'KONEX'
       AND i.asset_type IN ('stock', 'etf')
     ORDER BY i.symbol,
       CASE i.market WHEN 'KOSPI' THEN 0 WHEN 'KOSDAQ' THEN 1 ELSE 2 END`,
  );
  return rows.map((row) => ({
    instrument: rowToInstrument(row),
    isActive: row.is_active,
    // 두 배열은 같은 `ORDER BY`에서 나오므로 자리가 맞는다.
    delistedEpisodes: row.delisted_days.map((day, i) => ({
      day,
      reason: row.delisted_reasons[i] ?? '',
    })),
  }));
}

/**
 * **생존편향의 크기를 지금 잰다.** 상수로 박아 두지 않는 이유가 여기 있다 —
 * 봉이 들어오면 같은 KIND 목록에서도 답이 바뀐다. 2026-08-13에 손으로 박은
 * `missingSymbols: 840`이 하룻밤 만에 거짓이 됐다(803종목이 들어왔다).
 *
 * ── ★ 셋으로 가른다. `is_active`나 사유 글로 가르지 않는다 ────────────────
 *
 * 폐지 목록에는 **퇴장이 아닌 것이 섞여 있다.** 코스닥→코스피 이전상장과
 * 스팩소멸합병이 KIND에 상장폐지로 기록되는데, 그 종목들은 오늘도 같은
 * 종목코드로 거래된다(신세계푸드·LG유플러스·엘앤에프·포스코DX…).
 *
 * 사유 글로는 안 갈린다 — 2026-08-14 실측에서 폐지 기록 1,287건 중 131건이
 * 마스터에 살아 있는데 **그중 66건은 사유가 이전상장이 아니었다.**
 * `is_active`로도 안 갈린다 — 최근 폐지는 마스터가 아직 안 지워졌고, 메리츠화재
 * 같은 완전자회사화 종목은 계열이 끊겼는데도 활성으로 남아 있다.
 *
 * **계열이 끊겼는지는 봉이 말한다.** 그래서 마지막 봉의 위치로 가른다:
 *
 *   covered      봉이 있고 계열이 끝났다      → 표본에 실제로 반영된 퇴장
 *   missing      봉이 아예 없다               → 아직 남은 편향
 *   continuing   봉이 있고 계열이 이어진다    → 퇴장이 아니었다
 */
export interface DelistingGapMeasurement {
  fetchedOn: string | null;
  measuredOn: string;
  totalRows: number;
  coveredSymbols: number;
  missingSymbols: number;
  continuingSymbols: number;
  /** 아직 빠진 것의 사유 상위. KIND 원문 그대로 자르지 않고 앞부분만 쓴다 */
  reasons: Array<{ label: string; count: number }>;
  missingShareByYear: Array<{ year: number; share: number }>;
  overallMissingShare: number;
}

/**
 * `measuredOn`은 부른 쪽이 준다 — 이 모듈이 `Date`를 읽으면 시험이 날짜에 매인다.
 *
 * `seriesEndGapDays`는 `scanAdjustmentBreaks`와 **같은 뜻**이어야 한다. 한쪽이
 * "끝났다"고 보고 다른 쪽이 아니라고 보면 두 판정문이 서로 다른 표본을 말한다.
 */
export async function measureDelistingGap(
  measuredOn: string,
  seriesEndGapDays = 5,
): Promise<DelistingGapMeasurement> {
  /*
   * 코드 하나가 여러 번 폐지될 수 있다(재상장). 마지막 폐지일로 대표한다 —
   * 지금 계열이 끊겼는지를 묻는 것이므로 가장 최근 사건이 답이다.
   */
  const { rows } = await pool.query<{
    zone: string; year: string; symbols: string;
  }>(
    `WITH last_day AS (
       SELECT max(trading_day) AS day FROM trading_daily_bars
     ),
     cutoff AS (
       SELECT trading_day AS day FROM (
         SELECT DISTINCT trading_day FROM trading_daily_bars ORDER BY trading_day DESC LIMIT $1
       ) t ORDER BY trading_day ASC LIMIT 1
     ),
     episodes AS (
       SELECT d.symbol, max(d.delisted_on) AS delisted_on
       FROM instrument_delistings d
       LEFT JOIN instruments i ON i.symbol = d.symbol
       WHERE d.market IN ('KOSPI', 'KOSDAQ') OR i.market IN ('KOSPI', 'KOSDAQ')
       GROUP BY d.symbol
     ),
     placed AS (
       SELECT e.symbol, e.delisted_on,
              (SELECT max(b.trading_day) FROM trading_daily_bars b WHERE b.symbol = e.symbol) AS last_bar
       FROM episodes e
     )
     SELECT CASE
              WHEN last_bar IS NULL THEN 'missing'
              WHEN last_bar < (SELECT day FROM cutoff) THEN 'covered'
              ELSE 'continuing'
            END AS zone,
            substring(delisted_on, 1, 4) AS year,
            count(*)::text AS symbols
     FROM placed
     GROUP BY 1, 2`,
    [Math.max(1, seriesEndGapDays)],
  );

  const totals = { covered: 0, missing: 0, continuing: 0 };
  const byYear = new Map<number, { covered: number; missing: number }>();
  for (const row of rows) {
    const symbols = Number(row.symbols);
    if (row.zone === 'covered') totals.covered += symbols;
    else if (row.zone === 'missing') totals.missing += symbols;
    else totals.continuing += symbols;
    // 누락률의 분모는 **퇴장한 것**이다. 이어지는 코드는 애초에 빠질 대상이 아니다.
    if (row.zone === 'continuing') continue;
    const year = Number(row.year);
    if (!Number.isFinite(year)) continue;
    const bucket = byYear.get(year) ?? { covered: 0, missing: 0 };
    if (row.zone === 'covered') bucket.covered += symbols;
    else bucket.missing += symbols;
    byYear.set(year, bucket);
  }

  const meta = await pool.query<{ total: string; fetched: string | null }>(
    `SELECT count(*)::text AS total, max(vintage) AS fetched FROM instrument_delistings`,
  );
  /*
   * ★ **위 분류와 같은 종목만 센다.** 시장 필터가 빠져 있어서 KONEX 등 분류에
   * 들어가지도 않은 코드까지 세고 있었다 — `missing`이 7인데 사유는 "피흡수합병
   * 36"이라고 적혀 숫자끼리 어긋났다(2026-08-14). 한 문단 안의 수는 같은 것을
   * 세야 한다.
   */
  const reasons = await pool.query<{ label: string; count: string }>(
    `SELECT left(d.reason, 28) AS label, count(*)::text AS count
     FROM instrument_delistings d
     LEFT JOIN instruments i ON i.symbol = d.symbol
     WHERE (d.market IN ('KOSPI', 'KOSDAQ') OR i.market IN ('KOSPI', 'KOSDAQ'))
       AND NOT EXISTS (SELECT 1 FROM trading_daily_bars b WHERE b.symbol = d.symbol)
     GROUP BY 1 ORDER BY count(*) DESC LIMIT 4`,
  );

  const exits = totals.covered + totals.missing;
  return {
    fetchedOn: meta.rows[0]?.fetched ?? null,
    measuredOn,
    totalRows: Number(meta.rows[0]?.total ?? 0),
    coveredSymbols: totals.covered,
    missingSymbols: totals.missing,
    continuingSymbols: totals.continuing,
    reasons: reasons.rows.map((r) => ({ label: r.label, count: Number(r.count) })),
    missingShareByYear: [...byYear.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, bucket]) => ({
        year,
        share: bucket.covered + bucket.missing > 0
          ? bucket.missing / (bucket.covered + bucket.missing)
          : 0,
      })),
    overallMissingShare: exits > 0 ? totals.missing / exits : 0,
  };
}

/** 왜 이 코드를 안 받나. 사유마다 고쳐야 할 곳이 다르므로 뭉뚱그리지 않는다. */
export type DelistedSkipReason = 'stillActive' | 'relisted' | 'noDelistingDay';

export interface DelistedCollectionTarget {
  symbol: string;
  /** 받을 구간의 시작 `YYYYMMDD` */
  from: string;
  /** 받을 구간의 끝 = 폐지일 `YYYYMMDD` */
  to: string;
}

export interface DelistedCollectionPlan {
  targets: DelistedCollectionTarget[];
  skipped: Array<{ symbol: string; reason: DelistedSkipReason; detail: string }>;
}

/**
 * 무엇을 받고 무엇을 안 받나. **순수 함수라 DB 없이 시험에 태운다.**
 *
 * ── 안 받는 둘 ───────────────────────────────────────────────────────────
 *
 * **① 지금 살아 있는 코드(`stillActive`).** 폐지 목록에 있어도 마스터가 활성이면
 * 그 계열의 주인은 `collectDailyBars.ts`다. 여기서 또 받으면 `replaceSymbolBars`가
 * 그 종목의 21년치를 **폐지일까지로 잘라 갈아 끼운다.** 이유는 둘 중 하나인데
 * 여기서는 가릴 수 없다 — 마스터가 폐지를 아직 못 따라갔거나(최근 3주에 5건),
 * 폐지 목록이 말하는 것과 달리 거래가 안 끊겼거나(012210 삼미금속은 폐지일
 * 2025-12-29 뒤에도 오늘까지 봉이 온다). **가릴 수 없는 것을 골라잡지 않는다.**
 *
 * **② 두 번 이상 폐지된 코드(`relisted`).** 같은 코드에 다른 회사가 얹힌 것이라
 * 어느 구간이 어느 회사인지 가를 근거가 없다(013890 지누스 외 6개). 옛 폐지일
 * 다음부터 받으면 될 것 같지만, 폐지 뒤에도 KIS가 **직전 줄을 복사한 가짜 행**을
 * 주는 것을 실측했다(012460 우영: 폐지일 2008-03-13 뒤 3-14·3-17이 3-12의 복사).
 * 그 가짜가 어디까지인지 모르는 채로 붙이면 두 회사의 값이 한 계열에 섞인다.
 *
 * ── ★ 그런데 ②가 반대로 동작하고 있었다 (2026-08-14) ────────────────────
 *
 * `relisted`로 빠진 8종목을 열어 보니 **하나도 재상장이 아니었다.** 전부
 * `시장 이동 → 나중에 진짜 폐지` 였다:
 *
 *   197210 리드       20151120(코스닥시장 이전상장) → 20200514(기업의 계속성…)
 *   030790 비케이탑스 20101102(유가증권시장 상장)   → 20240513(감사의견 의견거절)
 *
 * 시장을 옮긴 것은 퇴장이 아니고 봉도 끊기지 않는다. 그러니 **마지막 폐지일까지
 * 받는 것이 맞다.** 그런데 기록이 둘이라는 이유로 통째로 빠져, 진짜 폐지 8종목이
 * 표본에서 사라졌다. 반대로 주석이 경고하던 013890(지누스)은 **폐지 기록이 1건**
 * 이라 이 조건에 애초에 걸리지 않았다 — **막으려던 것은 안 막고, 받아야 할 것만
 * 막고 있었다.**
 *
 * 그래서 첫 기록이 시장 이동이면(`isMarketTransfer`) 마지막 폐지일로 받는다.
 * 그 밖의 다중 기록은 지금처럼 뺀다 — 그건 여전히 가릴 근거가 없다.
 */
export function planDelistedCollection(
  candidates: DelistedCandidateRow[],
  defaultFrom: string,
): DelistedCollectionPlan {
  const targets: DelistedCollectionTarget[] = [];
  const skipped: DelistedCollectionPlan['skipped'] = [];

  for (const candidate of candidates) {
    const symbol = candidate.instrument.symbol;
    const episodes = [...candidate.delistedEpisodes]
      .filter((e) => /^\d{8}$/.test(e.day))
      .sort((a, b) => a.day.localeCompare(b.day));
    const days = episodes.map((e) => e.day);
    if (episodes.length === 0) {
      skipped.push({ symbol, reason: 'noDelistingDay', detail: '폐지일이 없습니다' });
      continue;
    }
    if (candidate.isActive) {
      skipped.push({
        symbol,
        reason: 'stillActive',
        detail: `마스터에 살아 있습니다 (폐지 기록 ${days[days.length - 1]})`,
      });
      continue;
    }
    /*
     * 기록이 여럿이어도 **앞엣것이 전부 시장 이동이면** 한 회사의 계열이다.
     * 마지막 것만 진짜 퇴장이므로 그 날짜까지 받는다.
     */
    const priorAllTransfers = episodes.slice(0, -1).every((e) => isMarketTransfer(e.reason));
    if (episodes.length > 1 && !priorAllTransfers) {
      skipped.push({ symbol, reason: 'relisted', detail: `폐지 기록이 ${days.length}건입니다 (${days.join(', ')})` });
      continue;
    }
    targets.push({ symbol, from: defaultFrom, to: days[days.length - 1] });
  }

  return { targets, skipped };
}

/**
 * 끝에 붙은 **거래량 0 봉**을 떼어 낸다. 몇 개를 뗐는지 함께 돌려준다.
 *
 * ── 왜 (2026-08-13 실측) ─────────────────────────────────────────────────
 *
 * 폐지일 언저리에는 시장에서 일어나지 않은 줄이 붙는다.
 *
 *   005600 중앙제지  2005-01-05 종가 10(거래량 354,427) → 폐지일 01-06 종가 30(거래량 0)
 *   012460 우영      2008-03-12 종가 80(거래량 23,790,275) → 폐지일 03-13 종가 80(거래량 0)
 *   117930 한진해운  2017-02-03~02-22 종가 780 고정(거래량 0) — 거래정지
 *
 * 005600의 마지막 줄은 **거래 없이 +200%**다. 그대로 담으면 두 가지가 동시에
 * 망가진다 — 폐지 손실이 그만큼 줄어 보이고, `scanAdjustmentBreaks`가 그 봉을
 * 가격제한폭 파탄으로 잡아 **그 종목의 21년을 통째로 버린다.**
 *
 * **끝만 뗀다.** 중간의 거래정지 구간(117930의 20일)은 그대로 둔다 — 그 뒤에 다시
 * 거래된 사실이 있으므로 계열의 일부다. 끝에 붙은 것은 **그 값으로 팔 수 없었다**는
 * 점에서 다르다.
 *
 * 이름은 잰 데까지만 붙인다. `거래정지`가 아니라 `거래량 0`이다 — 거래량이 0인
 * 이유가 정지인지 폐지 절차인지는 이 값으로 가릴 수 없다.
 */
export function trimTrailingZeroVolumeBars(bars: DailyBar[]): { bars: DailyBar[]; trimmed: number } {
  let end = bars.length;
  // 거래량이 `null`(안 온 것)이면 멈춘다 — 0이라고 단정하지 않는다.
  while (end > 0 && bars[end - 1].volume === 0) end -= 1;
  return { bars: bars.slice(0, end), trimmed: bars.length - end };
}
