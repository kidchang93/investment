/**
 * **적정가를 사후 채점한다.** "싸다"고 한 것이 실제로 올랐나.
 *
 * ── 왜 (2026-09-10) ──────────────────────────────────────────────────────
 *
 * `trading_fair_values`는 처음부터 이것을 위해 만들어졌다 — *"나중에 채점할 수
 * 있다. 30일 뒤 실제 주가와 대조하면 '이 적정가가 값어치가 있었나'를 답할 수
 * 있다"*(`analyzeFairValue.ts` 머리말). 그런데 **채점하는 쪽이 없었다.**
 *
 * ★★ **왜 원장(`measureWalkForward.ts`)으로 못 하나.** 적정가는 두 축의 평균인데
 *    재무 축은 21년에 태울 수가 없다 — KIS 재무는 종목당 **8분기(약 2년)**뿐이고
 *    (2026-09-10 실측: `getFinancials`가 최대 12를 요청해도 8이 온다) 그나마 지금
 *    조회한 확정치라 point-in-time이 아니다. 과거 시점 신호로 쓰면 아직 공시되지
 *    않은 숫자를 쓰는 것이라 look-ahead가 된다.
 *
 *    **원장 신호 22개가 전부 가격·수급인 것이 우연이 아니라 이 제약의 결과였다.**
 *    차트 축은 일봉만 쓰므로 원장에 태웠고(`ma60Discount`), 재무가 섞인 gap은
 *    **앞으로 쌓이는 기록으로 전향 채점**하는 수밖에 없다. 이 스크립트가 그것이다.
 *
 * ── 무엇을 재나 ──────────────────────────────────────────────────────────
 *
 * 그날 **첫 스냅샷**의 gap으로 줄을 세우고, N거래일 뒤 종가까지의 수익률을 본다.
 *
 * ★ **첫 스냅샷인 이유**: 하루에 5분마다 78번 기록되는데 다 쓰면 같은 날을 78번
 *   세는 것이 된다. 그리고 판단자가 그날 처음 그 값을 본 시점이 09:05이므로,
 *   "그때 알 수 있었던 것"으로 채점하려면 첫 것이 맞다.
 *
 * ★ **시장 중앙을 뺀다.** 시장이 오른 날은 아무거나 사도 오른다. 같은 날 표본
 *   전체의 중앙 수익률을 빼면 그 효과가 상쇄된다 — `analyzeFairValue`의
 *   `marketMedianReturn60`과 같은 원리이고, 이 레포가 21년 측정에서 쓴 분위
 *   나누기와도 같다.
 *
 * ★ **`falling`으로 갈라 본다.** 2026-09-10에 급락 축을 소집·화면에 걸면서
 *   판정을 함께 남기기 시작했다. 그 필터가 옳았는지는 "급락이라 판정한 것들이
 *   그 뒤 어떻게 됐나"로만 답할 수 있고, 그것이 이 칸에서 나온다.
 *
 * ★★ **표본이 모자라면 "모자랐다"고 말한다.** 적정가 기록은 2026-09-03에
 *    시작했고 900종목으로 넓어진 것은 09-09다. 20거래일 지평은 10월에야 첫
 *    표본이 찬다. 숫자를 채워 넣는 것보다 비어 있다고 적는 것이 낫다.
 *
 * 조회 전용이다. 주문을 내지 않는다.
 *
 *   npx tsx src/scripts/scoreFairValue.ts [--horizons 5,10,20] [--min-sample 30]
 */

import { closeDb, pool } from '../db/client.js';

/** 몇 거래일 뒤를 보나. 원장 축(`measureWalkForward`)과 맞춘다 */
const DEFAULT_HORIZONS = [5, 10, 20];
/**
 * 한 칸에 이만큼은 있어야 평균을 적는다.
 *
 * ★ 30인 이유는 통계가 아니라 **정직**이다. 표본 5개짜리 평균을 표에 적으면
 *   사람이 그것을 결과로 읽는다. 문턱을 넘긴 칸만 숫자를 적고 나머지는 표본 수만
 *   적는다 — 이 레포가 "0%를 지어내지 않는다"고 해 둔 자리와 같은 규칙이다.
 */
const DEFAULT_MIN_SAMPLE = 30;

/**
 * gap을 나누는 자리.
 *
 * ★ **운영에서 쓰는 문턱을 그대로 쓴다** — `RECOMMEND_GAP`(−10%)과
 *   `CHEAP_GATE`(−7%)가 실제로 후보를 가르는 값이므로, 채점도 같은 자리에서
 *   갈라야 "그 문턱이 옳았나"에 답이 된다. −20%는 그 아래를 한 번 더 가른 것이다
 *   (2026-09-10에 판단자가 본 25칸이 전부 −27% 아래였다).
 */
const BUCKETS: Array<{ label: string; from: number; to: number }> = [
  { label: 'gap ≤ −20%', from: -Infinity, to: -0.20 },
  { label: '−20% ~ −10%', from: -0.20, to: -0.10 },
  { label: '−10% ~ −7%', from: -0.10, to: -0.07 },
  { label: '−7% ~ 0%', from: -0.07, to: 0 },
  { label: 'gap ≥ 0%', from: 0, to: Infinity },
];

interface Row {
  d: string;
  symbol: string;
  gap: number;
  falling: boolean;
  forward: number;
}

const pct = (n: number): string => `${(n * 100).toFixed(2)}%`;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * `horizon` 거래일 뒤 종가까지의 수익률을 스냅샷마다 붙여 온다.
 *
 * ★ **일봉의 거래일에 번호를 매겨 센다.** 달력 날짜로 세면 휴장이 낀 구간이
 *   짧아진다. 번호는 저장소에 실제로 봉이 있는 날로만 매겨진다.
 *
 * ★ 시작가는 **스냅샷의 `price`**다(그때 실제로 살 수 있던 값). 그날 종가를
 *   쓰면 09:05에 알 수 없던 값으로 사는 것이 된다.
 */
async function loadRows(horizon: number): Promise<Row[]> {
  const { rows } = await pool.query<{
    d: string; symbol: string; gap: string; falling: boolean; forward: string;
  }>(
    `WITH days AS (
       SELECT trading_day, row_number() OVER (ORDER BY trading_day) AS n
         FROM (SELECT DISTINCT trading_day FROM trading_daily_bars
                WHERE trading_day >= '20260101') t
     ),
     snap AS (
       SELECT DISTINCT ON (symbol, (measured_at AT TIME ZONE 'Asia/Seoul')::date)
              symbol,
              to_char(measured_at AT TIME ZONE 'Asia/Seoul', 'YYYYMMDD') AS d,
              price, gap, falling
         FROM trading_fair_values
        WHERE gap IS NOT NULL AND price > 0
        ORDER BY symbol, (measured_at AT TIME ZONE 'Asia/Seoul')::date, measured_at
     )
     SELECT s.d, s.symbol, s.gap::text, s.falling,
            (b.close / s.price - 1)::text AS forward
       FROM snap s
       JOIN days d0 ON d0.trading_day = s.d
       JOIN days d1 ON d1.n = d0.n + $1
       JOIN trading_daily_bars b ON b.symbol = s.symbol AND b.trading_day = d1.trading_day
      WHERE b.close > 0`,
    [horizon],
  );
  return rows.map((r) => ({
    d: r.d, symbol: r.symbol, gap: Number(r.gap), falling: r.falling, forward: Number(r.forward),
  }));
}

/**
 * 같은 날 표본 전체의 중앙 수익률을 뺀다.
 *
 * ★ 이것이 없으면 "시장이 오른 날 기록이 많았다"가 곧 우위로 보인다.
 */
function excessOf(rows: Row[]): Map<string, number> {
  const byDay = new Map<string, number[]>();
  for (const r of rows) {
    const list = byDay.get(r.d) ?? [];
    list.push(r.forward);
    byDay.set(r.d, list);
  }
  const med = new Map<string, number>();
  for (const [day, values] of byDay) med.set(day, median(values));
  return med;
}

function report(rows: Row[], horizon: number, minSample: number): void {
  console.log(`\n━━━ ${horizon}거래일 뒤 ━━━`);
  if (rows.length === 0) {
    console.log('  표본 0건 — 아직 채점할 수 있는 날이 없다.');
    return;
  }
  const dayMedian = excessOf(rows);
  const days = new Set(rows.map((r) => r.d));
  console.log(`  표본 ${rows.length.toLocaleString('ko-KR')}건 · 기준일 ${days.size}일`
    + ` (${[...days].sort()[0]} ~ ${[...days].sort().slice(-1)[0]})`);

  console.log('\n  gap 구간별 · 시장 중앙 대비 초과');
  for (const bucket of BUCKETS) {
    const hit = rows.filter((r) => r.gap > bucket.from && r.gap <= bucket.to);
    const excess = hit.map((r) => r.forward - (dayMedian.get(r.d) ?? 0));
    if (hit.length < minSample) {
      console.log(`    ${bucket.label.padEnd(14)} 표본 ${hit.length}건 — ${minSample}건에 못 미쳐 적지 않는다`);
      continue;
    }
    const win = excess.filter((e) => e > 0).length / excess.length;
    console.log(`    ${bucket.label.padEnd(14)} ${hit.length.toString().padStart(6)}건`
      + ` · 초과 평균 ${pct(mean(excess)).padStart(8)} · 중앙 ${pct(median(excess)).padStart(8)}`
      + ` · 이긴 비율 ${(win * 100).toFixed(1)}%`);
  }

  /*
   * ★ **급락 판정이 옳았나.** 같은 gap 구간 안에서 falling 쪽이 더 나쁘면 그
   *   필터는 값어치가 있다. 더 좋으면 우리는 살 수 있는 것을 버리고 있는 것이다.
   */
  console.log('\n  급락 판정(falling)으로 가른 것 — gap ≤ −10%인 것만');
  const cheap = rows.filter((r) => r.gap <= -0.10);
  for (const [label, hit] of [
    ['급락 아님', cheap.filter((r) => !r.falling)],
    ['급락 판정', cheap.filter((r) => r.falling)],
  ] as Array<[string, Row[]]>) {
    const excess = hit.map((r) => r.forward - (dayMedian.get(r.d) ?? 0));
    if (hit.length < minSample) {
      console.log(`    ${label.padEnd(10)} 표본 ${hit.length}건 — ${minSample}건에 못 미쳐 적지 않는다`);
      continue;
    }
    console.log(`    ${label.padEnd(10)} ${hit.length.toString().padStart(6)}건`
      + ` · 초과 평균 ${pct(mean(excess)).padStart(8)} · 중앙 ${pct(median(excess)).padStart(8)}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const valueOf = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const horizons = (valueOf('--horizons') ?? '').length > 0
    ? (valueOf('--horizons') ?? '').split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : DEFAULT_HORIZONS;
  const minSample = Number(valueOf('--min-sample') ?? DEFAULT_MIN_SAMPLE);

  console.log('=== 적정가 사후 채점 ===');
  console.log('"싸다"고 한 것이 실제로 올랐나. 그날 첫 스냅샷 기준 · 시장 중앙 대비 초과.\n');

  const { rows: span } = await pool.query<{ first: string; last: string; n: string }>(
    `SELECT to_char(min(measured_at) AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS first,
            to_char(max(measured_at) AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS last,
            count(*)::text AS n
       FROM trading_fair_values`,
  );
  const { rows: bars } = await pool.query<{ last: string }>(
    'SELECT max(trading_day) AS last FROM trading_daily_bars',
  );
  console.log(`적정가 기록 ${Number(span[0]?.n ?? 0).toLocaleString('ko-KR')}행`
    + ` · ${span[0]?.first} ~ ${span[0]?.last}`);
  console.log(`일봉 저장소 마지막 ${bars[0]?.last}`);
  /*
   * ★ **일봉이 어디까지 있는지 먼저 적는다.** 채점은 일봉으로 하므로, 일봉이
   *   오늘까지 안 채워져 있으면 최근 기준일은 아직 못 잰다. 그것을 모르면
   *   "표본이 적다"를 신호가 없는 것으로 잘못 읽는다.
   */

  for (const horizon of horizons) {
    report(await loadRows(horizon), horizon, minSample);
  }

  console.log('\n★ 비용을 빼지 않은 값이다. 왕복 0.43%(개별주식)를 넘어야 실제로 돈이 된다.');
  console.log('★ 재무 축은 21년 원장에 못 태운다(KIS 재무 8분기·point-in-time 아님) —');
  console.log('  그래서 이 전향 채점이 그 축을 판정하는 유일한 길이다. 차트 축은');
  console.log('  ma60Discount로 원장에 있다.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDb);
