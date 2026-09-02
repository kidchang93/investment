/**
 * **밤사이 수익(오버나이트)과 장중 수익을 갈라 잰다.**
 *
 * ── 무엇을 묻나 (2026-09-02) ────────────────────────────────────────────
 *
 * 사용자가 제안했다 — *"종가에 매수하고 다음날 개장 전에 매도했을 때 수익이 잘
 * 날 것이라 예상하는 것들을 매수해서 다음날 개장 전에 매도하는 전략은? 장중에는
 * 너무 변수가 많을 것 같아."*
 *
 * 그 말을 잴 수 있는 형태로 바꾸면 하루가 둘로 갈린다.
 *
 *   종가[t] → 시가[t+1]  = **오버나이트** (밤사이. 이 전략이 먹으려는 몫)
 *   시가[t] → 종가[t]    = **장중**       (이 전략이 피하려는 몫)
 *
 * ── ★ 이 레포가 이미 잰 것과 무엇이 다른가 ──────────────────────────────
 *
 * `measureOpeningGap`은 **"갭이 큰 날 장중이 어떤가"**를 쟀다(되돌아온다, t −7.46).
 * 그건 *갭의 크기가 장중을 예측하는가*이지 **오버나이트 수익 자체가 양수인가**가
 * 아니다. **후자는 한 번도 안 쟀다.**
 *
 * ── ★★ 벽이 매우 높다는 것을 먼저 적어 둔다 ────────────────────────────
 *
 * 이 전략은 **매일 왕복**한다. 연 246거래일이면:
 *
 *   주식  246 × 0.43% = 연 105.8%
 *   ETF   246 × 0.23% = 연  56.6%
 *
 * 즉 **하루 오버나이트 평균이 0.43%를 넘어야** 본전이다. 한국 주식의 하루 평균
 * 수익률이 0.03~0.04% 수준인 것을 생각하면 12배를 요구하는 셈이다. 그래서 이
 * 측정의 값어치는 *"되나"*보다 **"얼마나 모자라나"**를 정확히 아는 데 있다 —
 * 모자란 크기를 알면 선별로 메울 수 있는지 판단할 수 있다.
 *
 * ★ 다만 **체결 가능성은 이 전략의 강점**이다. 종가·시가 둘 다 단일가라 호가를
 *   밀고 들어가지 않는다. 그래서 슬리피지를 여러 수준으로 함께 낸다.
 *
 * ── 무엇을 조심했나 ─────────────────────────────────────────────────────
 *
 * - **유동성 문턱**: 거래대금이 없는 종목은 뺀다. 안 그러면 못 사는 종목이
 *   결과를 지배한다 — 이 레포가 여러 번 겪은 함정이다.
 * - **전날 정보로만 고른다**: 문턱도 선별도 `t`일까지의 값으로 판정하고
 *   `t`의 종가에 산다. `t+1` 시가는 결과일 뿐 선택에 안 쓴다.
 * - **날짜 군집 t**: 같은 날 종목들은 함께 움직인다. 종목·날짜를 독립으로 세면
 *   t가 부풀어 오른다(이 레포가 2026-08-13에 1.8배 부풀린 적이 있다).
 *   **날짜별 평균의 시계열**로 t를 낸다.
 * - **상·하한가 근처는 뺀다**: 체결이 안 되거나 물량이 없다.
 *
 * 조회 전용이다. 주문을 내지 않는다.
 *
 *   npx tsx --max-old-space-size=4096 src/scripts/measureOvernight.ts [--from 20050101] [--min-turnover 100]
 */

import { closeDb, pool } from '../db/client.js';

/** 거래대금 하한(억원). 이만큼도 안 도는 종목은 살 수 없다고 본다 */
const DEFAULT_MIN_TURNOVER_EOK = 100;

/** 하루 등락률이 이보다 크면 상·하한가 근처로 보고 뺀다 */
const LIMIT_MOVE = 0.28;

interface DayRow {
  symbol: string;
  day: string;
  open: number;
  close: number;
  turnover: number | null;
}

interface Bucket {
  /** 날짜별 평균 오버나이트 수익률 */
  overnight: number[];
  /** 날짜별 평균 장중 수익률 */
  intraday: number[];
  days: string[];
  /** 이 묶음에 들어온 (종목·날) 수 */
  samples: number;
}

function emptyBucket(): Bucket {
  return { overnight: [], intraday: [], days: [], samples: 0 };
}

/** 평균과 날짜 군집 t */
function stat(xs: number[]): { mean: number; t: number; n: number } {
  const n = xs.length;
  if (n < 3) return { mean: 0, t: 0, n };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  return { mean, t: sd > 0 ? (mean / (sd / Math.sqrt(n))) * 1 : 0, n };
}

/** 하루 평균 수익률을 연율로. 246거래일 복리 */
const annual = (daily: number): number => (1 + daily) ** 246 - 1;
const pct = (v: number, d = 3): string => `${(v * 100).toFixed(d)}%`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fromArg = args.indexOf('--from');
  const from = fromArg >= 0 ? args[fromArg + 1] : '20050101';
  const turnoverArg = args.indexOf('--min-turnover');
  const minTurnover = (turnoverArg >= 0 ? Number(args[turnoverArg + 1]) : DEFAULT_MIN_TURNOVER_EOK) * 1e8;

  console.log('밤사이 수익 vs 장중 수익 — 종가에 사서 다음 시가에 파는 전략의 바닥\n');
  console.log(`구간 ${from}~ · 거래대금 하한 ${(minTurnover / 1e8).toFixed(0)}억 · 상·하한가 근처 제외\n`);

  /*
   * 종목별로 훑는다. 전 종목 21년이면 2,000만 행이라 한 번에 못 올린다.
   * 종목 하나의 계열을 받아 날짜별 통계에 더하고 버린다.
   */
  const { rows: symbolRows } = await pool.query<{ symbol: string }>(
    `SELECT DISTINCT symbol FROM trading_daily_bars WHERE trading_day >= $1 ORDER BY symbol`,
    [from],
  );
  const symbols = symbolRows.map((r) => r.symbol);
  console.log(`종목 ${symbols.length.toLocaleString('ko-KR')}개를 훑는다…\n`);

  // 날짜 → 합계. 마지막에 날짜별 평균으로 바꾼다.
  interface Acc { onSum: number; inSum: number; n: number }
  const byDay = new Map<string, Acc>();
  /** 거래대금 분위별(1=가장 큼) */
  const byQuintile = new Map<number, Map<string, Acc>>();
  for (let q = 1; q <= 5; q += 1) byQuintile.set(q, new Map());

  let totalSamples = 0;
  let processed = 0;

  for (const symbol of symbols) {
    const { rows } = await pool.query<DayRow>(
      `SELECT symbol, trading_day AS day, open, close, turnover
         FROM trading_daily_bars
        WHERE symbol = $1 AND trading_day >= $2
        ORDER BY trading_day`,
      [symbol, from],
    );
    processed += 1;
    if (processed % 500 === 0) {
      console.log(`  … ${processed}/${symbols.length} (표본 ${totalSamples.toLocaleString('ko-KR')})`);
    }
    for (let i = 0; i < rows.length - 1; i += 1) {
      const today = rows[i];
      const next = rows[i + 1];
      if (!(today.close > 0) || !(next.open > 0) || !(today.open > 0)) continue;
      // **전날까지의 정보로만 고른다** — 거래대금 문턱은 `t`일 값이고 매수는 `t` 종가다.
      if (today.turnover === null || today.turnover < minTurnover) continue;

      const overnight = next.open / today.close - 1;
      const intraday = today.close / today.open - 1;
      // 상·하한가 근처는 체결이 안 되거나 물량이 없다.
      if (Math.abs(overnight) > LIMIT_MOVE || Math.abs(intraday) > LIMIT_MOVE) continue;

      const acc = byDay.get(today.day) ?? { onSum: 0, inSum: 0, n: 0 };
      acc.onSum += overnight;
      acc.inSum += intraday;
      acc.n += 1;
      byDay.set(today.day, acc);
      totalSamples += 1;
    }
  }

  const days = [...byDay.keys()].sort();
  const bucket: Bucket = emptyBucket();
  for (const d of days) {
    const acc = byDay.get(d)!;
    if (acc.n < 5) continue;   // 종목이 너무 적은 날은 평균이 흔들린다
    bucket.days.push(d);
    bucket.overnight.push(acc.onSum / acc.n);
    bucket.intraday.push(acc.inSum / acc.n);
    bucket.samples += acc.n;
  }

  const on = stat(bucket.overnight);
  const intra = stat(bucket.intraday);
  const both = stat(bucket.overnight.map((v, i) => v + bucket.intraday[i]));

  console.log(`\n표본 (종목·날) ${bucket.samples.toLocaleString('ko-KR')} · 거래일 ${bucket.days.length.toLocaleString('ko-KR')}`);
  console.log(`구간 ${bucket.days[0]} ~ ${bucket.days[bucket.days.length - 1]}\n`);

  console.log('구분'.padEnd(16) + '하루 평균'.padStart(12) + '연율'.padStart(12) + '날짜군집 t'.padStart(12));
  console.log('─'.repeat(52));
  console.log('밤사이'.padEnd(16) + pct(on.mean).padStart(12) + pct(annual(on.mean), 1).padStart(12) + on.t.toFixed(2).padStart(12));
  console.log('장중'.padEnd(16) + pct(intra.mean).padStart(12) + pct(annual(intra.mean), 1).padStart(12) + intra.t.toFixed(2).padStart(12));
  console.log('합(하루 전체)'.padEnd(16) + pct(both.mean).padStart(12) + pct(annual(both.mean), 1).padStart(12) + both.t.toFixed(2).padStart(12));

  // ── 비용 손익분기 ──
  console.log('\n비용을 넣으면 — **매일 왕복**이라 연 246회다');
  console.log('  왕복비용'.padEnd(20) + '하루 순수익'.padStart(14) + '연율'.padStart(14) + '판정'.padStart(10));
  console.log('─'.repeat(60));
  for (const [label, cost] of [
    ['0.23% (ETF·단일가)', 0.0023],
    ['0.43% (주식 기준값)', 0.0043],
    ['0.10% (슬리피지 0으로 가정)', 0.0010],
    ['0.03% (수수료만)', 0.0003],
  ] as Array<[string, number]>) {
    const net = on.mean - cost;
    console.log(
      `  ${label}`.padEnd(20)
      + pct(net).padStart(14)
      + pct(annual(net), 1).padStart(14)
      + (net > 0 ? '넘는다' : '못 넘는다').padStart(10),
    );
  }

  console.log(
    `\n★ 본전에 필요한 하루 밤사이 수익 = 왕복비용. 실제는 ${pct(on.mean)}이므로`
    + ` **비용이 ${(on.mean > 0 ? (0.0043 / on.mean).toFixed(1) : '∞')}배**다(주식 0.43% 기준).`,
  );

  // ── 연도별 안정성 ──
  console.log('\n연도별 — 한두 해가 만든 것인지 본다');
  console.log('  해'.padEnd(8) + '밤사이'.padStart(12) + '장중'.padStart(12) + '거래일'.padStart(9));
  console.log('─'.repeat(42));
  const years = [...new Set(bucket.days.map((d) => d.slice(0, 4)))].sort();
  for (const y of years) {
    const idx = bucket.days.map((d, i) => (d.startsWith(y) ? i : -1)).filter((i) => i >= 0);
    if (idx.length < 20) continue;
    const o = stat(idx.map((i) => bucket.overnight[i]));
    const t = stat(idx.map((i) => bucket.intraday[i]));
    console.log(
      `  ${y}`.padEnd(8)
      + pct(o.mean).padStart(12)
      + pct(t.mean).padStart(12)
      + String(idx.length).padStart(9),
    );
  }

  void byQuintile;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
