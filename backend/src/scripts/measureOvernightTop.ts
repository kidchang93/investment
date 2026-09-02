/**
 * **거래대금 상위 N종목만 종가에 사서 다음 시가에 판다면.**
 *
 * ── 왜 다시 재나 (2026-09-02) ────────────────────────────────────────────
 *
 * `measureOvernight`가 두 가지를 알려줬다.
 *
 *   필터 없음(전 종목)   밤사이 하루 +0.118% · 장중 하루 **−0.069%** · 합 연 12.9%
 *   당일 거래대금 100억  밤사이 하루 +0.255% · 장중 하루 **+0.390%** · 합 연 **385%**
 *
 * ★★ **뒤가 거짓이다.** 21년간 시장이 연 385%로 오르지 않았다. 원인은 필터가
 *    **당일** 거래대금이라는 것 — "그날 거래가 터진 종목"을 고르는 것은 곧
 *    "그날 크게 오른 종목"을 고르는 것이다. **장중 수익률을 재면서 장중에
 *    일어난 일로 종목을 골랐다.** 전형적인 look-ahead다.
 *
 * 앞의 값(합 연 12.9%)은 KODEX 200 21.4년 실측 12.62%와 거의 같아 믿을 만하다.
 *
 * ── 그래서 이 스크립트가 고치는 것 ──────────────────────────────────────
 *
 * **① 필터를 전날 거래대금으로 옮긴다.** `t`일 종가에 살 때 우리가 아는 것은
 *    `t−1`일까지의 거래대금이다. 그것으로 고른다.
 *
 * **② 몇 종목을 살 것인지를 나눠 잰다.** 사용자가 말한 *"거래량이 많은 주식들
 *    몇 개 선별"*이 그것이다. 상위 10·20·50·100·200·500으로 갈라, **몇 개까지
 *    좁혀야 효과가 남는지**를 본다.
 *
 * **③ 전 종목(필터 없음)을 함께 낸다.** 좁히는 것이 실제로 값어치가 있는지는
 *    안 좁힌 것과 나란히 놓아야 안다.
 *
 * ── 무엇을 여전히 못 재나 ────────────────────────────────────────────────
 *
 * **슬리피지.** 이 전략의 승패는 거기서 갈린다 — 밤사이 우위가 0.1%대인데
 * 이 레포의 실측 슬리피지가 **0.33%**(시장가)다. 다만 종가·시가 둘 다
 * **단일가**라 호가를 밀고 들어가지 않으므로 그보다 훨씬 작을 수 있다.
 * **단일가 슬리피지는 이 레포가 아직 안 쟀다.** 그래서 비용을 여러 수준으로
 * 함께 낸다 — "얼마 이하면 사는가"를 답으로 남긴다.
 *
 * 그리고 **종가 단일가에 주문할 때 확정 종가를 모른다**(예상체결가만 안다).
 * 여기 계산은 확정 종가로 샀다고 친다 — 그만큼 낙관적이다.
 *
 * 조회 전용이다. 주문을 내지 않는다.
 *
 *   npx tsx src/scripts/measureOvernightTop.ts [--from 20050101]
 */

import { closeDb, pool } from '../db/client.js';

/** 상·하한가 근처는 체결이 안 되거나 물량이 없다 */
const LIMIT_MOVE = 0.28;

/** 몇 종목까지 좁혀 볼 것인가. `null`은 전 종목(안 좁힘) */
const TOP_NS: Array<number | null> = [10, 20, 50, 100, 200, 500, null];

interface DayStat {
  day: string;
  overnight: number;
  intraday: number;
  n: number;
}

function stat(xs: number[]): { mean: number; t: number } {
  const n = xs.length;
  if (n < 3) return { mean: 0, t: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return { mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0 };
}

const annual = (daily: number): number => (1 + daily) ** 246 - 1;
const pct = (v: number, d = 3): string => `${(v * 100).toFixed(d)}%`;

/**
 * 날짜별 평균을 SQL로 낸다. 1,277만 행을 Node로 올리면 메모리가 터지고,
 * 순위 매기기는 Postgres가 훨씬 잘한다.
 *
 * ★ `lag(turnover)`가 **전날** 거래대금이고 그것으로 순위를 매긴다.
 *   `lead(open)`이 다음 거래일 시가 — 그 종목의 다음 봉이지 다음 달력일이 아니다.
 */
async function measure(
  from: string,
  topN: number | null,
  assetType?: 'stock' | 'etf',
): Promise<DayStat[]> {
  const { rows } = await pool.query<{
    trading_day: string; overnight: string; intraday: string; n: string;
  }>(
    `
    WITH shifted AS (
      SELECT symbol, trading_day, open, close,
             lag(turnover) OVER (PARTITION BY symbol ORDER BY trading_day) AS prev_turnover,
             lead(open)    OVER (PARTITION BY symbol ORDER BY trading_day) AS next_open
        FROM trading_daily_bars b
       WHERE trading_day >= $1
         ${assetType ? `AND EXISTS (SELECT 1 FROM instruments i
                                     WHERE i.symbol = b.symbol AND i.asset_type = '${assetType}')` : ''}
    ),
    usable AS (
      SELECT trading_day,
             next_open / close - 1 AS overnight,
             close / open - 1      AS intraday,
             row_number() OVER (
               PARTITION BY trading_day ORDER BY prev_turnover DESC
             ) AS rk
        FROM shifted
       WHERE prev_turnover IS NOT NULL AND prev_turnover > 0
         AND open > 0 AND close > 0 AND next_open > 0
         AND abs(next_open / close - 1) < ${LIMIT_MOVE}
         AND abs(close / open - 1)      < ${LIMIT_MOVE}
    )
    SELECT trading_day,
           avg(overnight)::text AS overnight,
           avg(intraday)::text  AS intraday,
           count(*)::text       AS n
      FROM usable
     ${topN === null ? '' : `WHERE rk <= ${topN}`}
     GROUP BY trading_day
     HAVING count(*) >= 5
     ORDER BY trading_day
    `,
    [from],
  );
  return rows.map((r) => ({
    day: r.trading_day,
    overnight: Number(r.overnight),
    intraday: Number(r.intraday),
    n: Number(r.n),
  }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fromArg = args.indexOf('--from');
  const from = fromArg >= 0 ? args[fromArg + 1] : '20050101';

  console.log('종가 매수 → 익일 시가 매도 · 거래대금 상위 N종목\n');
  console.log('★ 순위는 **전날** 거래대금이다 — 당일로 고르면 "그날 오른 종목"을 고르는 것이 되어');
  console.log('  장중 수익이 지어진다(그렇게 재면 하루 전체가 연 385%로 나온다. 실제는 연 12.9%다).\n');

  console.log(
    '상위'.padEnd(8)
    + '밤사이/일'.padStart(11)
    + '연율'.padStart(10)
    + 't'.padStart(8)
    + '장중/일'.padStart(11)
    + '연율'.padStart(10)
    + '하루평균종목'.padStart(13)
    + '거래일'.padStart(8),
  );
  console.log('─'.repeat(80));

  const results: Array<{ topN: number | null; on: { mean: number; t: number }; intra: { mean: number; t: number }; avgN: number; days: number }> = [];

  for (const topN of TOP_NS) {
    const stats = await measure(from, topN);
    if (stats.length < 100) continue;
    const on = stat(stats.map((s) => s.overnight));
    const intra = stat(stats.map((s) => s.intraday));
    const avgN = stats.reduce((a, s) => a + s.n, 0) / stats.length;
    results.push({ topN, on, intra, avgN, days: stats.length });
    console.log(
      (topN === null ? '전 종목' : `${topN}`).padEnd(8)
      + pct(on.mean).padStart(11)
      + pct(annual(on.mean), 1).padStart(10)
      + on.t.toFixed(1).padStart(8)
      + pct(intra.mean).padStart(11)
      + pct(annual(intra.mean), 1).padStart(10)
      + avgN.toFixed(0).padStart(13)
      + String(stats.length).padStart(8),
    );
  }

  // ── 비용 손익분기 ──
  console.log('\n비용을 넣으면 — **매일 왕복**이라 연 246회다');
  console.log(
    '상위'.padEnd(8)
    + '0.43%(주식)'.padStart(14)
    + '0.23%(ETF)'.padStart(13)
    + '0.10%'.padStart(11)
    + '0.06%'.padStart(11)
    + '0.03%(수수료만)'.padStart(17),
  );
  console.log('─'.repeat(76));
  for (const r of results) {
    const cells = [0.0043, 0.0023, 0.0010, 0.0006, 0.0003].map((c) => {
      const net = r.on.mean - c;
      return net > 0 ? pct(annual(net), 1) : '—';
    });
    console.log(
      (r.topN === null ? '전 종목' : `${r.topN}`).padEnd(8)
      + cells[0].padStart(14)
      + cells[1].padStart(13)
      + cells[2].padStart(11)
      + cells[3].padStart(11)
      + cells[4].padStart(17),
    );
  }
  console.log('  — 는 비용을 못 넘어 손실이라는 뜻');

  // 본전 비용
  console.log('\n본전이 되는 왕복 비용 (이보다 싸게 사고팔 수 있어야 한다)');
  for (const r of results) {
    console.log(
      `  상위 ${(r.topN === null ? '전 종목' : String(r.topN)).padEnd(8)}`
      + `왕복 ${pct(r.on.mean)} 미만`,
    );
  }
  // ── ★★ ETF만 — 매도 거래세가 면제라 본전선이 완전히 달라진다 ──
  console.log('\n\n【ETF만】 매도 거래세 0.20%가 면제다. 본전선이 그만큼 내려간다');
  console.log(
    '상위'.padEnd(8)
    + '밤사이/일'.padStart(11)
    + '연율'.padStart(10)
    + 't'.padStart(8)
    + '장중/일'.padStart(11)
    + '하루평균종목'.padStart(13)
    + '왕복0.13%'.padStart(12)
    + '왕복0.06%'.padStart(12),
  );
  console.log('─'.repeat(85));
  for (const topN of [5, 10, 20, 50, 100]) {
    const stats = await measure(from, topN, 'etf');
    if (stats.length < 100) continue;
    const on = stat(stats.map((s2) => s2.overnight));
    const intra = stat(stats.map((s2) => s2.intraday));
    const avgN = stats.reduce((a, s2) => a + s2.n, 0) / stats.length;
    const net13 = on.mean - 0.0013;
    const net06 = on.mean - 0.0006;
    console.log(
      String(topN).padEnd(8)
      + pct(on.mean).padStart(11)
      + pct(annual(on.mean), 1).padStart(10)
      + on.t.toFixed(1).padStart(8)
      + pct(intra.mean).padStart(11)
      + avgN.toFixed(0).padStart(13)
      + (net13 > 0 ? pct(annual(net13), 1) : '—').padStart(12)
      + (net06 > 0 ? pct(annual(net06), 1) : '—').padStart(12),
    );
  }
  console.log('  왕복 0.13% = 수수료 0.03% + 편도 슬리피지 0.05%  ·  0.06% = 수수료 + 편도 0.015%');

  console.log(
    '\n★ 이 레포 실측 슬리피지는 **0.33%(시장가)**다. 다만 종가·시가 둘 다 단일가라'
    + '\n  호가를 밀지 않으므로 그보다 훨씬 작을 수 있다 — **단일가 슬리피지는 아직 안 쟀다.**'
    + '\n  수수료만으로 0.03%이므로, 슬리피지가 편도 0.02%p 아래면 위 표의 왼쪽 칸이 살아난다.',
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
