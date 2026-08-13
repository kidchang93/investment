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
  /** 이 코드의 폐지일 전부, 오름차순. 둘 이상이면 재상장한 것이다 */
  delistedDays: string[];
}

export async function getDelistedCandidates(): Promise<DelistedCandidateRow[]> {
  /*
   * 같은 코드가 두 시장에 있으면(드물다) 한 줄만 쓴다 — 두 줄이면 같은 종목을
   * 두 번 받고 뒤엣것이 앞엣것을 갈아 끼운다. 고르는 순서는 관심종목 seed와 같다.
   */
  const { rows } = await pool.query<InstrumentRow & { is_active: boolean; delisted_days: string[] }>(
    `SELECT DISTINCT ON (i.symbol) ${instrumentColumns('i.')}, i.is_active, d.delisted_days
     FROM instruments i
     JOIN (
       SELECT symbol, array_agg(delisted_on ORDER BY delisted_on) AS delisted_days
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
    delistedDays: row.delisted_days,
  }));
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
 */
export function planDelistedCollection(
  candidates: DelistedCandidateRow[],
  defaultFrom: string,
): DelistedCollectionPlan {
  const targets: DelistedCollectionTarget[] = [];
  const skipped: DelistedCollectionPlan['skipped'] = [];

  for (const candidate of candidates) {
    const symbol = candidate.instrument.symbol;
    const days = [...candidate.delistedDays].filter((day) => /^\d{8}$/.test(day)).sort();
    if (days.length === 0) {
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
    if (days.length > 1) {
      skipped.push({ symbol, reason: 'relisted', detail: `폐지 기록이 ${days.length}건입니다 (${days.join(', ')})` });
      continue;
    }
    targets.push({ symbol, from: defaultFrom, to: days[0] });
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
