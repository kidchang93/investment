/**
 * **15:15에 실제로 아는 것만으로 골랐을 때 밤사이 수익이 남는가.**
 *
 * ── 왜 다시 재나 (2026-09-07) ────────────────────────────────────────────
 *
 * `measureOvernightTop`이 낸 답은 **전날 거래대금 상위 N**으로 고른 것이었다.
 * 그런데 그 값을 **주문 시점에 알 수 없다.**
 *
 *   일봉 수집은 15:45~17:00에 돌고, *"오늘 봉은 담지 않는다"*(미완성 봉을 완성된
 *   하루로 저장하지 않으려고). 그래서 9/7 15:15에 DB가 가진 최신 봉은 **9/3**이다 —
 *   전날(9/4)도 아니고 **이틀 전**이다.
 *
 * 즉 그 측정은 **살 수 없는 정보로 고른 것**이다. 이 레포는 "살 수 없는 가격으로
 * 재고 있었다"를 이미 한 번 겪었다(`measureOvernightTop` 주석).
 *
 * ── 15:15에 실제로 아는 것 ───────────────────────────────────────────────
 *
 *   ① 오늘 시가·현재가        (실시간 시세)
 *   ② 오늘 여기까지의 거래대금 (실시간 순위 API)
 *   ③ 이틀 전까지의 일봉      (DB)
 *
 * ★ **당일 거래대금으로 골라도 look-ahead가 아니다.** 원래 측정이 그것으로 망가진
 *   것은 *장중 수익률을 성과로 재면서* 당일 거래대금으로 골랐기 때문이다(순환).
 *   **밤사이 수익은 선택 이후의 미래**라 그 순환이 없다. 여기서는 밤사이만 본다.
 *
 * ── 무엇을 가르나 ────────────────────────────────────────────────────────
 *
 *   A. 당일   거래대금 상위 N  (15:15에 안다)          ← 쓸 수 있다
 *   B. 전날   거래대금 상위 N  (원래 측정. 15:45 이후) ← 못 쓴다
 *   C. 이틀전 거래대금 상위 N  (15:15에 안다)          ← 쓸 수 있다
 *
 * 셋을 나란히 놓아야 "쓸 수 있는 쪽으로 바꾸면 얼마를 잃나"를 안다.
 *
 * 그리고 장중 상승률 상한(급등주를 어디까지 포함하나)을 함께 가른다 —
 * 비용선을 넘는 구간이 거기서 갈렸다.
 *
 * ── ★★ 이 측정의 절대 수준을 쓰지 마라 (2026-09-07에 확인) ──────────────
 *
 * **셋을 견주는 상대 비교**(당일 vs 전날 vs 이틀전)가 이 스크립트의 목적이고,
 * 그것만 쓸 수 있다. 나온 밤사이 수익률 자체는 **위로 부풀려져 있다.**
 *
 * 1. **생존편향** — `trading_daily_bars`에 **오늘 살아 있는 종목만** 있다.
 *    폐지 1,267건의 과거가 통째로 없다(일봉 4,945종목 전부가 현재 상장 종목).
 *    이 전략은 급등주를 사는 것이라 **급등 후 폐지된 종목이 빠진 것**이 정확히
 *    가장 아픈 자리다. `collectDelistedBars.ts`가 이걸 메우려고 있지만
 *    데몬에 등록돼 있지 않고 돈 적이 없다.
 * 2. **종가를 확정 종가로 친다** — 실제로는 15:20에 예상체결가만 알고 주문한다.
 * 3. **단일가 슬리피지 미측정** — `trading_auction_settled`가 2일치뿐이다.
 *    하룻밤 우위가 그 크기와 비슷해서, 이 값을 모르면 이기는지조차 모른다.
 *
 * ★ 그래서 사용자가 정했다(`docs/USER_DECISIONS.md` 「종가 매매」) — 이 측정은
 *   **"무엇을 볼지"만** 알려주는 재료이고, *"왜 이 종목이 밤사이에도 오를 것인지"*는
 *   판단자가 뉴스·이벤트로 세운다.
 *
 * 조회 전용이다. 주문을 내지 않는다.
 *
 *   npx tsx --max-old-space-size=4096 src/scripts/measureOvernightExecutable.ts [--from 20050101]
 */

import { closeDb, pool } from '../db/client.js';

/** 상·하한가 근처는 체결이 안 되거나 물량이 없다 */
const LIMIT_MOVE = 0.28;

/** 거래대금 순위를 어디서 끊나 */
const TOP_NS = [20, 50, 100, 200] as const;

/** 장중 상승률 상한. 급등주를 어디까지 넣나 — 비용선이 여기서 갈렸다 */
const INTRADAY_CAPS = [0.05, 0.07, 0.10, 0.15, 0.28] as const;

/** 장중 상승률 상위 몇 %만 사나 */
const TOP_GAIN_FRACTION = 0.2;

type Lag = 0 | 1 | 2;

interface DayStat {
  day: string;
  overnight: number;
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
 * 하루치 평균 밤사이 수익.
 *
 * @param lag 거래대금을 며칠 전 것으로 줄 세우나. 0=당일 · 1=전날 · 2=이틀 전
 * @param cap 장중 상승률이 이보다 크면 뺀다 (급등주 상한)
 */
async function measure(
  from: string, topN: number, lag: Lag, cap: number,
): Promise<DayStat[]> {
  /*
   * ★ 거래대금 순위 열만 `lag`으로 갈린다. 나머지는 전부 같다 —
   *   그래야 셋의 차이가 오직 "언제 알 수 있는 값이냐"에서만 온다.
   */
  const turnoverExpr = lag === 0
    ? 'turnover'
    : `lag(turnover, ${lag}) OVER (PARTITION BY symbol ORDER BY trading_day)`;

  const { rows } = await pool.query<{ trading_day: string; overnight: string; n: string }>(
    `
    WITH shifted AS (
      SELECT symbol, trading_day, open, close,
             ${turnoverExpr} AS rank_turnover,
             lead(open) OVER (PARTITION BY symbol ORDER BY trading_day) AS next_open
        FROM trading_daily_bars
       WHERE trading_day >= $1
    ),
    usable AS (
      SELECT trading_day,
             next_open / close - 1 AS overnight,
             close / open - 1      AS intraday,
             row_number() OVER (
               PARTITION BY trading_day ORDER BY rank_turnover DESC
             ) AS turnover_rank
        FROM shifted
       WHERE rank_turnover IS NOT NULL AND rank_turnover > 0
         AND open > 0 AND close > 0 AND next_open > 0
         AND abs(next_open / close - 1) < ${LIMIT_MOVE}
         AND abs(close / open - 1)      < ${LIMIT_MOVE}
    ),
    ranked AS (
      SELECT trading_day, overnight, intraday,
             -- 장중 상승률 상위 몇 %인가. 상한을 씌운 뒤에 줄 세운다.
             percent_rank() OVER (PARTITION BY trading_day ORDER BY intraday) AS gain_rank
        FROM usable
       WHERE turnover_rank <= ${topN}
         AND intraday > 0
         AND intraday <= ${cap}
    )
    SELECT trading_day,
           avg(overnight)::text AS overnight,
           count(*)::text       AS n
      FROM ranked
     WHERE gain_rank >= ${1 - TOP_GAIN_FRACTION}
     GROUP BY trading_day
     HAVING count(*) >= 3
     ORDER BY trading_day
    `,
    [from],
  );
  return rows.map((r) => ({
    day: r.trading_day,
    overnight: Number(r.overnight),
    n: Number(r.n),
  }));
}

const LAG_LABEL: Record<Lag, string> = {
  0: '당일(쓸 수 있다)',
  1: '전날(못 쓴다)',
  2: '이틀전(쓸 수 있다)',
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fromArg = args.indexOf('--from');
  const from = fromArg >= 0 ? args[fromArg + 1] : '20050101';

  console.log('종가 매수 → 익일 시가 매도 · **15:15에 아는 것만으로 골랐을 때**\n');
  console.log(`거래대금 상위 N 안에서 장중 상승률 상위 ${TOP_GAIN_FRACTION * 100}%만 산다.`);
  console.log('★ 종가는 확정 종가로 친다 — 실제로는 예상체결가만 알고 주문하므로 그만큼 낙관적이다.\n');

  for (const cap of INTRADAY_CAPS) {
    console.log(`\n── 장중 상승률 상한 ${pct(cap, 0)} ${'─'.repeat(46)}`);
    console.log(
      '거래대금 기준'.padEnd(20)
      + '상위'.padStart(6)
      + '밤사이/일'.padStart(11)
      + '연율'.padStart(10)
      + 't'.padStart(8)
      + '하루종목'.padStart(10)
      + '거래일'.padStart(8),
    );
    for (const lag of [0, 1, 2] as const) {
      for (const topN of TOP_NS) {
        const stats = await measure(from, topN, lag, cap);
        if (stats.length < 100) continue;
        const on = stat(stats.map((s) => s.overnight));
        const avgN = stats.reduce((a, s) => a + s.n, 0) / stats.length;
        console.log(
          LAG_LABEL[lag].padEnd(20)
          + String(topN).padStart(6)
          + pct(on.mean).padStart(11)
          + pct(annual(on.mean), 1).padStart(10)
          + on.t.toFixed(1).padStart(8)
          + avgN.toFixed(0).padStart(10)
          + String(stats.length).padStart(8),
        );
      }
    }
  }

  console.log('\n★ 비용: 매도 거래세 0.20% + 수수료 + 단일가 슬리피지(미측정).');
  console.log('  밤사이 평균이 그 합을 넘어야 남는다 — 넘는 칸만 후보다.');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
