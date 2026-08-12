/**
 * 일봉 저장소를 **재기 전에 검사한다.** 8항목.
 *
 * ── 왜 (2026-08-12) ──────────────────────────────────────────────────────
 *
 * 21년치를 받아 놓고 바로 walk-forward를 돌리면, 나온 숫자가 우위인지 데이터
 * 파탄인지 가릴 방법이 없다. 370종목 표본에서 이미 **가격제한폭을 넘는 봉 11건**이
 * 나왔다 — `005070` 2008-01-22 `1,124 → 2,881(+156.3%)`처럼 그날 시장에서
 * 일어날 수 없는 값이다. 수정주가 기준이 한쪽에만 반영된 것이고, 그대로 두면
 * 그 종목의 그 시절 수익률이 통째로 거짓이다.
 *
 * ── 이 스크립트가 지키는 것 ──────────────────────────────────────────────
 *
 * - **DB만 본다. KIS를 부르지 않는다.** 수집이 도는 중에도 안전하게 돌아간다.
 * - **아무것도 고치지 않는다.** 읽기 전용이다. 무엇이 잘못됐는지만 말한다.
 * - **`vintage`가 섞인 종목이 하나라도 있으면 멈춘다**(종료코드 1). 그건 수정주가
 *   기준이 다른 줄이 한 종목 안에 섞였다는 뜻이고, 값으로는 알아볼 수 없다.
 *
 *   npx tsx src/scripts/verifyDailyBars.ts [--breaks 40] [--mismatch 40]
 */

import { closeDb, pool } from '../db/client.js';
import { PRICE_LIMIT_ERAS } from '../trading/panel.js';

interface Options {
  /** 파탄 봉을 몇 줄까지 찍을까 */
  breaks: number;
  /** 우선주 불일치를 몇 줄까지 찍을까 */
  mismatch: number;
}

function parseOptions(argv: string[]): Options {
  const options: Options = { breaks: 40, mismatch: 40 };
  for (let index = 0; index < argv.length; index += 1) {
    const next = (): string => argv[(index += 1)] ?? '';
    switch (argv[index]) {
      case '--breaks':
        options.breaks = Number(next());
        break;
      case '--mismatch':
        options.mismatch = Number(next());
        break;
      default:
        throw new Error(`모르는 인자입니다: ${argv[index]}`);
    }
  }
  return options;
}

function day(value: string | null): string {
  if (!value) return '-';
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function number(value: number): string {
  return value.toLocaleString('ko-KR');
}

function pct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function heading(index: number, title: string): void {
  console.log(`\n${'━'.repeat(78)}`);
  console.log(`${index}. ${title}`);
  console.log('━'.repeat(78));
}

/**
 * 가격제한폭 표를 SQL의 `CASE`로 옮긴다.
 *
 * 판정은 `trading/panel.ts`의 `PRICE_LIMIT_ERAS` 한 곳에서 나온다 — 두 곳에
 * 숫자를 적으면 한쪽만 고쳐진다.
 */
function limitCaseSql(column: string): string {
  const branches = PRICE_LIMIT_ERAS.slice(0, -1)
    .map((era) => `WHEN ${column} <= '${era.until}' THEN ${era.limit}`)
    .join('\n           ');
  const fallback = PRICE_LIMIT_ERAS[PRICE_LIMIT_ERAS.length - 1].limit;
  return `CASE ${branches}\n           ELSE ${fallback} END`;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  let fatal = 0;

  const summary = await pool.query<{
    symbols: string; bars: string; oldest: string | null; newest: string | null;
  }>(
    `SELECT count(DISTINCT symbol)::text AS symbols, count(*)::text AS bars,
            min(trading_day) AS oldest, max(trading_day) AS newest
     FROM trading_daily_bars`,
  );
  const store = summary.rows[0];
  console.log('일봉 저장소 검사 · DB만 본다 (KIS 호출 0회) · 아무것도 고치지 않는다');
  console.log(
    `종목 ${number(Number(store.symbols))} · 봉 ${number(Number(store.bars))}`
    + ` · ${day(store.oldest)} ~ ${day(store.newest)}`,
  );
  console.log('★ 수집이 도는 중이면 이 숫자는 지금 이 순간의 것이다.');

  // ── 1. 가격제한폭 초과 봉 ────────────────────────────────────────────────
  heading(1, '가격제한폭을 넘는 봉 — 수정주가 파탄');
  console.log(
    `기준: ${PRICE_LIMIT_ERAS.map((e) => `~${day(e.until === '99999999' ? null : e.until)} ±${pct(e.limit)}`)
      .join(' / ')
      .replace('~- ', '그 뒤 ')}`,
  );
  console.log('★ KRX 한계는 실제로 2015-06-15에 ±15%→±30%가 됐다. 여기 경계(2015-01-01)는');
  console.log('  2015 상반기를 느슨하게 본다 — 덜 잡을 수는 있어도 멀쩡한 봉을 파탄으로 몰지는 않는다.');

  const breaks = await pool.query<{
    symbol: string; trading_day: string; prev_close: string; close: string; change_rate: string;
  }>(
    `WITH stepped AS (
       SELECT symbol, trading_day, close,
              lag(close) OVER (PARTITION BY symbol ORDER BY trading_day) AS prev_close
       FROM trading_daily_bars
     )
     SELECT symbol, trading_day, prev_close::text, close::text,
            (close / prev_close - 1)::text AS change_rate
     FROM stepped
     WHERE prev_close > 0 AND close > 0
       AND abs(close / prev_close - 1) > ${limitCaseSql('trading_day')}
     ORDER BY abs(close / prev_close - 1) DESC`,
  );
  console.log(`\n파탄 봉 ${number(breaks.rowCount ?? 0)}건`
    + ` · 걸린 종목 ${number(new Set(breaks.rows.map((r) => r.symbol)).size)}개`);
  if (breaks.rowCount === 0) {
    console.log('  없다.');
  } else {
    console.log('  종목      날짜          앞 종가        종가        변화');
    for (const row of breaks.rows.slice(0, options.breaks)) {
      console.log(
        `  ${row.symbol}  ${day(row.trading_day)}  ${number(Number(row.prev_close)).padStart(11)}`
        + ` ${number(Number(row.close)).padStart(11)}`
        + `  ${(Number(row.change_rate) >= 0 ? '+' : '') + pct(Number(row.change_rate))}`,
      );
    }
    if ((breaks.rowCount ?? 0) > options.breaks) {
      console.log(`  … 그리고 ${number((breaks.rowCount ?? 0) - options.breaks)}건 더 (--breaks로 늘린다)`);
    }
    console.log('\n  → 측정은 이 봉 **이전** 구간을 종목째 버린다(`scanAdjustmentBreaks`).');
    console.log('    봉 하나만 빼면 앞뒤가 다른 자로 잰 값이 이어 붙는다.');
  }

  // ── 2. vintage 혼입 ──────────────────────────────────────────────────────
  heading(2, 'vintage가 둘 이상인 종목 — 수정주가 기준 혼입');
  const vintages = await pool.query<{ symbol: string; vintages: string; kinds: string }>(
    `SELECT symbol, string_agg(DISTINCT vintage, ', ' ORDER BY vintage) AS vintages,
            count(DISTINCT vintage)::text AS kinds
     FROM trading_daily_bars
     GROUP BY symbol
     HAVING count(DISTINCT vintage) > 1
     ORDER BY symbol`,
  );
  if (vintages.rowCount === 0) {
    console.log('없다 — 한 종목은 한 세션에서 통째로 받혔다.');
  } else {
    fatal += 1;
    console.log(`★ ${number(vintages.rowCount ?? 0)}종목이 섞였다. **여기서 멈춘다.**`);
    for (const row of vintages.rows.slice(0, 40)) console.log(`  ${row.symbol}  ${row.vintages}`);
    console.log('  → 값으로는 알아볼 수 없는 종류의 오류다. 그 종목을 다시 받아야 한다.');
  }

  // ── 3. 마지막 봉이 뒤처진 종목 ───────────────────────────────────────────
  heading(3, '마지막 봉이 20거래일 이상 이른 종목 — 거래정지·정리매매');
  const cutoff = await pool.query<{ cutoff: string }>(
    `SELECT trading_day AS cutoff
     FROM (SELECT DISTINCT trading_day FROM trading_daily_bars ORDER BY trading_day DESC LIMIT 20) t
     ORDER BY trading_day ASC LIMIT 1`,
  );
  const cutoffDay = cutoff.rows[0]?.cutoff ?? null;
  if (!cutoffDay) {
    console.log('거래일이 20일도 안 된다 — 판정할 수 없다.');
  } else {
    const stale = await pool.query<{ symbol: string; last_day: string; bars: string }>(
      `SELECT symbol, max(trading_day) AS last_day, count(*)::text AS bars
       FROM trading_daily_bars
       GROUP BY symbol
       HAVING max(trading_day) < $1
       ORDER BY max(trading_day)`,
      [cutoffDay],
    );
    console.log(`기준일 ${day(cutoffDay)} (최근 20번째 거래일) · 뒤처진 종목 ${number(stale.rowCount ?? 0)}개`);
    for (const row of stale.rows.slice(0, 20)) {
      console.log(`  ${row.symbol}  마지막 ${day(row.last_day)}  ${number(Number(row.bars))}봉`);
    }
    if ((stale.rowCount ?? 0) > 20) console.log(`  … 그리고 ${number((stale.rowCount ?? 0) - 20)}개 더`);
    console.log('\n  ★ 이 종목들은 **폐지 직전 표본**일 수 있다. 지금 마스터에 살아 있다는 것은');
    console.log('    오늘 기준 사실이고, 과거 어느 날 그것이 사실이었는지는 알 수 없다.');
  }

  // ── 4. 연도별 거래 종목 수 ───────────────────────────────────────────────
  heading(4, '연도별 그해 거래된 종목 수 — 생존편향의 분자');
  const perYear = await pool.query<{ y: string; symbols: string; bars: string; days: string }>(
    `SELECT substring(trading_day, 1, 4) AS y,
            count(DISTINCT symbol)::text AS symbols,
            count(*)::text               AS bars,
            count(DISTINCT trading_day)::text AS days
     FROM trading_daily_bars
     GROUP BY 1 ORDER BY 1`,
  );
  console.log('  연도   종목      거래일    봉');
  for (const row of perYear.rows) {
    console.log(
      `  ${row.y}  ${number(Number(row.symbols)).padStart(6)}`
      + `  ${number(Number(row.days)).padStart(6)}`
      + `  ${number(Number(row.bars)).padStart(9)}`,
    );
  }
  console.log('\n  ★ 옛 연도의 종목 수가 적은 것은 **그때 상장이 적어서가 아니라**');
  console.log('    그 뒤 폐지된 종목이 오늘 마스터에 없어서다. 이것이 생존편향이다.');

  // ── 5. NULL 비율 ─────────────────────────────────────────────────────────
  heading(5, '거래량·거래대금 NULL 비율 — 안 온 것과 0인 것은 다르다');
  const nulls = await pool.query<{
    y: string; n: string; vnull: string; tnull: string; vzero: string; tzero: string;
  }>(
    `SELECT substring(trading_day, 1, 4) AS y, count(*)::text AS n,
            count(*) FILTER (WHERE volume IS NULL)::text   AS vnull,
            count(*) FILTER (WHERE turnover IS NULL)::text  AS tnull,
            count(*) FILTER (WHERE volume = 0)::text        AS vzero,
            count(*) FILTER (WHERE turnover = 0)::text      AS tzero
     FROM trading_daily_bars GROUP BY 1 ORDER BY 1`,
  );
  console.log('  연도    거래량NULL   거래대금NULL   거래량 0    거래대금 0');
  for (const row of nulls.rows) {
    const n = Number(row.n);
    console.log(
      `  ${row.y}  ${(`${number(Number(row.vnull))} (${pct(Number(row.vnull) / n)})`).padStart(14)}`
      + `  ${(`${number(Number(row.tnull))} (${pct(Number(row.tnull) / n)})`).padStart(14)}`
      + `  ${number(Number(row.vzero)).padStart(9)}`
      + `  ${number(Number(row.tzero)).padStart(11)}`,
    );
  }
  console.log('\n  ★ 0은 사실일 수 있다(거래정지일에 KIS가 실제로 0을 준다). NULL은 안 온 것이다.');

  // ── 6. 불가능한 봉 ───────────────────────────────────────────────────────
  heading(6, '불가능한 봉 — close<=0 · high<low · high<close · low>close');
  const impossible = await pool.query<{
    nonpositive: string; hl: string; hc: string; lc: string; ho: string; lo: string;
  }>(
    `SELECT count(*) FILTER (WHERE close <= 0 OR open <= 0 OR high <= 0 OR low <= 0)::text AS nonpositive,
            count(*) FILTER (WHERE high < low)::text   AS hl,
            count(*) FILTER (WHERE high < close)::text  AS hc,
            count(*) FILTER (WHERE low > close)::text   AS lc,
            count(*) FILTER (WHERE high < open)::text   AS ho,
            count(*) FILTER (WHERE low > open)::text    AS lo
     FROM trading_daily_bars`,
  );
  const bad = impossible.rows[0];
  const badTotal = Object.values(bad).reduce((a, v) => a + Number(v), 0);
  console.log(`  0 이하           ${number(Number(bad.nonpositive))}`);
  console.log(`  고 < 저          ${number(Number(bad.hl))}`);
  console.log(`  고 < 종          ${number(Number(bad.hc))}`);
  console.log(`  저 > 종          ${number(Number(bad.lc))}`);
  console.log(`  고 < 시          ${number(Number(bad.ho))}`);
  console.log(`  저 > 시          ${number(Number(bad.lo))}`);
  if (badTotal > 0) {
    const sample = await pool.query<{
      symbol: string; trading_day: string; open: string; high: string; low: string; close: string;
    }>(
      `SELECT symbol, trading_day, open::text, high::text, low::text, close::text
       FROM trading_daily_bars
       WHERE close <= 0 OR open <= 0 OR high <= 0 OR low <= 0
          OR high < low OR high < close OR low > close OR high < open OR low > open
       ORDER BY symbol, trading_day LIMIT 20`,
    );
    console.log('\n  종목      날짜           시       고       저       종');
    for (const row of sample.rows) {
      console.log(
        `  ${row.symbol}  ${day(row.trading_day)}  ${Number(row.open).toString().padStart(8)}`
        + ` ${Number(row.high).toString().padStart(8)} ${Number(row.low).toString().padStart(8)}`
        + ` ${Number(row.close).toString().padStart(8)}`,
      );
    }
  } else {
    console.log('\n  없다.');
  }

  // ── 7. 우선주 판정 두 방식 ───────────────────────────────────────────────
  heading(7, '우선주 판정 — 코드 끝자리 vs 이름');
  const preferred = await pool.query<{
    symbol: string; name: string; by_code: boolean; by_name: boolean;
  }>(
    `SELECT symbol, name,
            (right(symbol, 1) <> '0')       AS by_code,
            (name ~ '우[A-Z]?$')             AS by_name
     FROM instruments
     WHERE country = 'KR' AND asset_type = 'stock' AND market IN ('KOSPI', 'KOSDAQ')
     ORDER BY symbol`,
  );
  const byCode = preferred.rows.filter((r) => r.by_code);
  const byName = preferred.rows.filter((r) => r.by_name);
  const disagree = preferred.rows.filter((r) => r.by_code !== r.by_name);
  console.log(`표집틀 ${number(preferred.rowCount ?? 0)}종목 (KOSPI+KOSDAQ 주식)`);
  console.log(`  코드 끝자리 ≠ '0'  ${number(byCode.length)}종`);
  console.log(`  이름이 '우'로 끝남  ${number(byName.length)}종`);
  console.log(`  ★ 두 방식이 갈리는 종목 ${number(disagree.length)}종`);
  if (disagree.length > 0) {
    console.log('\n  종목      이름                        코드판정  이름판정');
    for (const row of disagree.slice(0, options.mismatch)) {
      console.log(
        `  ${row.symbol}  ${row.name.slice(0, 24).padEnd(26)}`
        + `${row.by_code ? '우선주  ' : '보통주  '}  ${row.by_name ? '우선주' : '보통주'}`,
      );
    }
    if (disagree.length > options.mismatch) {
      console.log(`  … 그리고 ${number(disagree.length - options.mismatch)}종 더 (--mismatch로 늘린다)`);
    }
  }
  console.log('\n  → 측정 유니버스는 **둘 중 하나라도 우선주라고 하면 뺀다.** 어느 쪽이 맞는지');
  console.log('    모르는 채로 한쪽만 믿으면 보통주 표본에 우선주가 섞인다.');

  // ── 8. 봉 수 분포 ────────────────────────────────────────────────────────
  heading(8, '종목별 봉 수 분포');
  const buckets = await pool.query<{ bucket: string; symbols: string }>(
    `WITH counted AS (SELECT symbol, count(*) AS bars FROM trading_daily_bars GROUP BY symbol)
     SELECT CASE
              WHEN bars < 120   THEN '1) 120봉 미만 — 신호가 설 자리가 없다'
              WHEN bars < 250   THEN '2) 120~249봉 (1년 미만)'
              WHEN bars < 1250  THEN '3) 250~1,249봉 (1~5년)'
              WHEN bars < 2500  THEN '4) 1,250~2,499봉 (5~10년)'
              WHEN bars < 5000  THEN '5) 2,500~4,999봉 (10~20년)'
              ELSE                   '6) 5,000봉 이상 (20년 이상)'
            END AS bucket,
            count(*)::text AS symbols
     FROM counted GROUP BY 1 ORDER BY 1`,
  );
  for (const row of buckets.rows) console.log(`  ${row.bucket.padEnd(44)} ${number(Number(row.symbols)).padStart(6)}종목`);
  const short = buckets.rows.find((r) => r.bucket.startsWith('1)'));
  console.log(`\n  → 120봉 미만 ${number(Number(short?.symbols ?? 0))}종목은 유니버스에서 자동으로 빠진다.`);

  // ── 판정 ────────────────────────────────────────────────────────────────
  console.log(`\n${'━'.repeat(78)}`);
  if (fatal > 0) {
    console.log('★ 멈춤 — vintage가 섞인 종목이 있다. 재기 전에 그 종목을 다시 받아야 한다.');
    process.exitCode = 1;
    return;
  }
  console.log('vintage 혼입 없음 — 재도 되는 상태다.');
  console.log('★ 파탄 봉과 뒤처진 종목은 **막는 사유가 아니라 재는 조건**이다. 측정이 그것을');
  console.log('  어떻게 다루는지가 결과에 남는다(파탄 앞 구간 버림 · 생존편향 표시).');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
