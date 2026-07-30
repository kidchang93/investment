import { pool } from './client.js';
import { instrumentColumns, rowToInstrument, type InstrumentRow } from './instruments.js';
import type { Theme, ThemeMembers } from '@invest/shared';

/**
 * KIS 테마 분류 저장소.
 *
 * ## 왜 컬럼이 아니라 테이블인가
 *
 * 지수업종은 종목당 대분류 1 + 중분류 1이라 `instruments` 컬럼으로 붙였다. 테마는
 * 종목당 여러 개다 — 삼성전자 16개, 실측 평균 2.37개. 컬럼으로는 담을 수 없어
 * N:M 관계 테이블을 둔다.
 *
 * ## 왜 `symbol`과 `instrument_id`를 둘 다 두는가
 *
 * 테마 마스터는 6자리 단축코드만 주고 시장은 주지 않는다. 우리 `instruments.id`는
 * `KR:KOSPI:005930` 꼴이라 동기화 때 한 번 맞춰 둬야 조회가 조인 하나로 끝난다.
 *
 * 그런데 이 마스터는 낡아서(2026-07-31 실측: 파일이 2025-11-06자) 고유 종목
 * 2,333개 중 **218개가 오늘자 종목 마스터에 없다**(쌍으로는 425/5,528). 매칭된
 * 것만 담으면 그 218개가 조용히 사라지고, 화면은 "반도체 110종목"이라고 적으면서
 * 105개만 보여 주게 된다. 그래서 마스터가 준 사실(`symbol`)을 그대로 남기고
 * 우리 종목과의 연결(`instrument_id`)만 nullable로 붙인다.
 * → 목록을 뽑을 때 **몇 개 중 몇 개를 찾았는지**를 셀 수 있다.
 *
 * ## FK
 *
 * `theme_code`는 `themes`로 `ON DELETE CASCADE` — 테마가 없어지면 소속도 없어진다.
 * `instrument_id`는 `instruments`로 `ON DELETE SET NULL`(`trading_broker_orders`와
 * 같은 방식). RESTRICT면 9개월 묵은 테마 데이터가 종목 삭제를 막고, CASCADE면
 * "이 테마에 이런 종목이 있었다"는 사실 자체가 사라진다. 연결만 끊고 사실은 남긴다.
 */

/** 테마 동기화 결과. 스크립트가 이걸 그대로 찍는다 — 재지 않은 숫자를 적지 않기 위해서다. */
export interface ThemeSyncSummary {
  /** 마스터의 테마 수 */
  themeCount: number;
  /** (테마,종목) 쌍 수 */
  memberCount: number;
  /** 그중 우리 종목과 연결된 쌍 수 */
  linkedMemberCount: number;
  /** 마스터에 나오는 고유 종목 수 */
  symbolCount: number;
  /** 그중 우리 종목 마스터에서 못 찾은 수 */
  missingSymbolCount: number;
  /** 이 목록의 기준일 (마스터 파일이 만들어진 시각) */
  sourceModifiedAt: Date;
}

interface ThemeRow {
  code: string;
  name: string;
  source_modified_at: Date;
  symbol_count: string;
  instrument_count: string;
}

export async function ensureThemeSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS themes (
      code text PRIMARY KEY,
      name text NOT NULL,
      -- 이 목록의 기준일. 마스터 파일이 만들어진 시각이지 우리가 받아온 시각이 아니다.
      -- zip은 매일 재포장되지만 내용은 갱신되지 않아 둘이 몇 달씩 벌어진다.
      source_modified_at timestamptz NOT NULL,
      synced_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS theme_instruments (
      theme_code text NOT NULL REFERENCES themes(code) ON DELETE CASCADE,
      -- 마스터가 준 원본 사실. 우리 종목과 못 이어져도 지우지 않는다.
      symbol text NOT NULL,
      -- 동기화 시점에 맞춘 우리 종목. 상장폐지·코드변경이면 NULL이다.
      instrument_id text REFERENCES instruments(id) ON DELETE SET NULL,
      PRIMARY KEY (theme_code, symbol)
    );

    -- PK 앞자리가 theme_code라 "테마 하나의 종목 목록"은 인덱스 앞부분 스캔으로 끝난다.
    -- 다음 단계인 멀티시세(한 번에 30종목)가 테마마다 이 질의를 때린다.
    CREATE INDEX IF NOT EXISTS theme_instruments_instrument_idx
      ON theme_instruments (instrument_id);
    CREATE INDEX IF NOT EXISTS theme_instruments_symbol_idx
      ON theme_instruments (symbol);
  `);
}

/**
 * 테마 전체를 파일 내용으로 갈아 끼운다.
 *
 * `instruments`처럼 `is_active` 플래그로 남기지 않고 지웠다 넣는다. 테마를 참조하는
 * 다른 테이블이 없고, 마스터에서 빠진 테마를 남겨 두면 "지금 있는 테마"와
 * 구별되지 않기 때문이다.
 *
 * **`syncInstruments`가 종목을 넣은 다음에 불러야 한다.** `instrument_id`를 여기서
 * 맞추므로 순서가 뒤집히면 방금 상장된 종목이 통째로 미연결로 남는다.
 */
export async function replaceThemes(
  names: Map<string, string>,
  members: Array<{ themeCode: string; symbol: string }>,
  sourceModifiedAt: Date,
): Promise<ThemeSyncSummary> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // theme_instruments는 ON DELETE CASCADE로 함께 지워진다.
    await client.query('DELETE FROM themes');

    await client.query(
      `
        INSERT INTO themes (code, name, source_modified_at, synced_at)
        SELECT t.code, t.name, $3::timestamptz, now()
        FROM unnest($1::text[], $2::text[]) AS t(code, name)
      `,
      [[...names.keys()], [...names.values()], sourceModifiedAt.toISOString()],
    );

    // 단축코드 → 우리 종목. 같은 코드가 여러 시장에 있으면 국내 주식 시장 순으로
    // 고른다 (`seedDefaultWatchlist`와 같은 우선순위). 못 찾으면 NULL로 남는다.
    const inserted = await client.query(
      `
        INSERT INTO theme_instruments (theme_code, symbol, instrument_id)
        SELECT m.theme_code, m.symbol, i.id
        FROM unnest($1::text[], $2::text[]) AS m(theme_code, symbol)
        LEFT JOIN LATERAL (
          SELECT id
          FROM instruments
          WHERE symbol = m.symbol AND country = 'KR' AND is_active = true
          ORDER BY
            CASE market WHEN 'KOSPI' THEN 0 WHEN 'KOSDAQ' THEN 1 WHEN 'KONEX' THEN 2 ELSE 3 END
          LIMIT 1
        ) i ON true
        RETURNING symbol, instrument_id
      `,
      [members.map((m) => m.themeCode), members.map((m) => m.symbol)],
    );

    await client.query('COMMIT');

    const linkedMemberCount = inserted.rows.filter(
      (row: { instrument_id: string | null }) => row.instrument_id !== null,
    ).length;
    const missing = new Set(
      inserted.rows
        .filter((row: { instrument_id: string | null }) => row.instrument_id === null)
        .map((row: { symbol: string }) => row.symbol),
    );

    return {
      themeCount: names.size,
      memberCount: members.length,
      linkedMemberCount,
      symbolCount: new Set(members.map((m) => m.symbol)).size,
      missingSymbolCount: missing.size,
      sourceModifiedAt,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * 테마 목록. 종목 수는 **마스터가 넣어 둔 수**와 **지금 찾은 수**를 따로 준다.
 * 둘을 하나로 합치면 낡았다는 사실이 사라진다.
 */
export async function listThemes(): Promise<Theme[]> {
  const result = await pool.query<ThemeRow>(`
    SELECT
      t.code,
      t.name,
      t.source_modified_at,
      count(ti.symbol)::text AS symbol_count,
      count(i.id)::text AS instrument_count
    FROM themes t
    LEFT JOIN theme_instruments ti ON ti.theme_code = t.code
    LEFT JOIN instruments i ON i.id = ti.instrument_id AND i.is_active = true
    GROUP BY t.code, t.name, t.source_modified_at
    ORDER BY t.name
  `);
  return result.rows.map(rowToTheme);
}

/**
 * 테마 하나의 종목 목록.
 *
 * 못 찾은 종목코드를 버리지 않고 `missingSymbols`로 함께 준다 — 화면이
 * `110종목 중 105종목`이라고 적을 수 있어야 하기 때문이다.
 */
export async function getThemeMembers(code: string): Promise<ThemeMembers | null> {
  const themeResult = await pool.query<{ code: string; name: string; source_modified_at: Date }>(
    'SELECT code, name, source_modified_at FROM themes WHERE code = $1',
    [code],
  );
  const themeRow = themeResult.rows[0];
  if (!themeRow) return null;

  const found = await pool.query<InstrumentRow>(
    `
      SELECT ${instrumentColumns('i.')}
      FROM theme_instruments ti
      JOIN instruments i ON i.id = ti.instrument_id AND i.is_active = true
      WHERE ti.theme_code = $1
      ORDER BY i.symbol
    `,
    [code],
  );

  const missing = await pool.query<{ symbol: string }>(
    `
      SELECT ti.symbol
      FROM theme_instruments ti
      LEFT JOIN instruments i ON i.id = ti.instrument_id AND i.is_active = true
      WHERE ti.theme_code = $1 AND i.id IS NULL
      ORDER BY ti.symbol
    `,
    [code],
  );

  const instruments = found.rows.map(rowToInstrument);
  const missingSymbols = missing.rows.map((row) => row.symbol);

  return {
    theme: {
      code: themeRow.code,
      name: themeRow.name,
      sourceDate: themeRow.source_modified_at.toISOString(),
      symbolCount: instruments.length + missingSymbols.length,
      instrumentCount: instruments.length,
    },
    instruments,
    missingSymbols,
  };
}

function rowToTheme(row: ThemeRow): Theme {
  return {
    code: row.code,
    name: row.name,
    sourceDate: row.source_modified_at.toISOString(),
    symbolCount: Number(row.symbol_count),
    instrumentCount: Number(row.instrument_count),
  };
}
