/**
 * 개장 갭이 **이어지는가 되돌아오는가**를 잰다.
 *
 * ── 무엇을 묻나 ──────────────────────────────────────────────────────────
 *
 * 사용자가 관찰했다: *"프리마켓에서 서서히 오르다가 개장하니까 또 한번 오른다."*
 * 그 말을 잴 수 있는 형태로 바꾸면 이렇다.
 *
 *   전일 종가 → 오늘 시가 = **갭**            (밤사이 정보가 값에 박히는 몫)
 *   오늘 시가 → 오늘 종가 = **장중**           (개장 뒤에도 이어지는 몫)
 *
 * 갭이 큰 날 장중도 같은 방향이면 **이어지는 것**이고, 반대면 **되돌아오는 것**이다.
 * 둘 중 무엇인지에 따라 "개장 전에 사 두는 것"의 뜻이 정반대가 된다.
 *
 * ── 이게 왜 중요한가 ─────────────────────────────────────────────────────
 *
 * 갭이 이어진다면, 밤사이 정보를 개장 전에 읽고 시가에 들어가는 것이 값어치가
 * 있다. 되돌아온다면 **시가에 사는 것이 가장 나쁜 자리**다.
 *
 * ★ 다만 이 측정으로도 못 아는 것이 있다. **시가에 실제로 살 수 있느냐**는
 * 제도의 문제다(동시호가·NXT). 여기서는 "그럴 수 있다면 값어치가 있었나"까지만 잰다.
 *
 * ── 거울을 함께 잰다 ─────────────────────────────────────────────────────
 *
 * 갭 상위와 하위를 나란히 본다. 진짜 관계면 부호가 갈리고, 아니면 같은 값이 나온다.
 *
 * 조회 전용이다. 주문을 내지 않는다.
 *
 *   npx tsx src/scripts/measureOpeningGap.ts [종목수] [recent|prior]
 */

import { getKisAccount } from '../config.js';
import { pool } from '../db/client.js';
import { getDailyMarketBars, toCredentials, type DailyMarketBar } from '../kis/rest.js';

const wanted = Number(process.argv[2] ?? 120);
const PERIODS: Record<string, [string, string]> = {
  recent: ['20260301', '20260804'],
  prior: ['20251001', '20260228'],
};
const periodKey = process.argv[3] ?? 'recent';
const range = PERIODS[periodKey];
if (!range) {
  console.error(`모르는 구간: ${periodKey}`);
  process.exit(1);
}

const prodId = process.env.KIS_OPEN_DAY_CREDENTIAL_ID;
const account = prodId ? getKisAccount(prodId) : null;
if (!account) {
  console.error('실전 조회 자격증명(KIS_OPEN_DAY_CREDENTIAL_ID)이 필요하다.');
  process.exit(1);
}
const credentials = { ...toCredentials(account), crossServerRead: true };

const mean = (v: number[]): number => (v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length);
function median(v: number[]): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

const { rows } = await pool.query<{ symbol: string }>(
  `SELECT symbol FROM instruments
   WHERE country = 'KR' AND asset_type = 'stock' AND market IN ('KOSPI', 'KOSDAQ')
   ORDER BY symbol`,
);
const step = Math.max(1, Math.floor(rows.length / wanted));
const picked = rows.filter((_, i) => i % step === 0).slice(0, wanted);

console.log(`구간 ${periodKey} (${range[0]}~${range[1]}) · ${picked.length}종목 조회`);
console.log('★ 표본은 코드순 등간격 — 수익률과 무관한 순서다.\n');

/** 한 종목·하루의 갭과 장중. 둘 다 % */
interface GapDay {
  gap: number;
  intraday: number;
  /** 갭 다음 날 종가까지. "하루 더 들고 가면"을 재려고 둔다 */
  nextDay: number | undefined;
}

const days: GapDay[] = [];
/** 날짜별로 모아 군집 t를 낸다 */
const byDay = new Map<string, GapDay[]>();
let failed = 0;

for (const row of picked) {
  let bars: DailyMarketBar[];
  try {
    bars = await getDailyMarketBars(row.symbol, range[0], range[1], credentials);
  } catch {
    failed += 1;
    continue;
  }
  // KIS는 최신순으로 준다. 날짜 오름차순으로 뒤집는다.
  const asc = [...bars].sort((a, b) => a.tradingDay.localeCompare(b.tradingDay));
  for (let i = 1; i < asc.length; i += 1) {
    const prev = asc[i - 1];
    const cur = asc[i];
    // 값이 하나라도 0이면 그날은 잴 수 없다. 0으로 채우지 않는다.
    if (!(prev.close > 0) || !(cur.open > 0) || !(cur.close > 0)) continue;
    const entry: GapDay = {
      gap: (cur.open / prev.close - 1) * 100,
      intraday: (cur.close / cur.open - 1) * 100,
      nextDay:
        i + 1 < asc.length && asc[i + 1].close > 0 ? (asc[i + 1].close / cur.open - 1) * 100 : undefined,
    };
    days.push(entry);
    const list = byDay.get(cur.tradingDay) ?? [];
    list.push(entry);
    byDay.set(cur.tradingDay, list);
  }
}

console.log(`종목·날 ${days.length}개 · 날짜 ${byDay.size}일 · 조회 실패 ${failed}\n`);
if (days.length < 100) {
  console.log('표본이 너무 적다. 여기서 멈춘다.');
  process.exit(0);
}

console.log(`갭 자체:  평균 ${mean(days.map((d) => d.gap)).toFixed(3)}%`
  + ` · 중앙 ${median(days.map((d) => d.gap)).toFixed(3)}%`);
console.log(`장중:     평균 ${mean(days.map((d) => d.intraday)).toFixed(3)}%`
  + ` · 중앙 ${median(days.map((d) => d.intraday)).toFixed(3)}%\n`);

/*
 * 날짜마다 갭으로 줄 세워 상위/하위 십분위의 **장중** 수익을 본다.
 * 같은 날 안에서 줄 세워야 그날 시장 전체가 오른 것이 상쇄된다.
 */
/**
 * 십분위마다 모아 둔다. 상·하위만 보면 "가운데는 어땠나"를 못 보는데, 단조로운
 * 계단이 아니면 그건 관계가 아니라 **양 끝의 극단** 몇 개다.
 */
const BUCKETS = 10;
const bucketIntra: number[][] = Array.from({ length: BUCKETS }, () => []);
const bucketGap: number[][] = Array.from({ length: BUCKETS }, () => []);
const bucketNext: number[][] = Array.from({ length: BUCKETS }, () => []);
/** 그날 전체 평균을 뺀 값. 시장이 그날 통째로 빠진 몫을 걷어낸다 */
const bucketAdj: number[][] = Array.from({ length: BUCKETS }, () => []);
const dailySpread: number[] = [];
const dailyAdjSpread: number[] = [];

for (const [, list] of byDay) {
  // 줄을 세우려면 그날 종목이 충분해야 한다.
  if (list.length < 30) continue;
  const sorted = [...list].sort((a, b) => b.gap - a.gap);
  const dayMean = mean(sorted.map((d) => d.intraday));
  const dTop: number[] = [];
  const dBottom: number[] = [];
  const size = sorted.length / BUCKETS;
  for (let i = 0; i < sorted.length; i += 1) {
    const { gap, intraday, nextDay } = sorted[i];
    const b = Math.min(BUCKETS - 1, Math.floor(i / size));
    bucketIntra[b].push(intraday);
    bucketGap[b].push(gap);
    bucketAdj[b].push(intraday - dayMean);
    if (nextDay !== undefined) bucketNext[b].push(nextDay);
    if (b === 0) dTop.push(intraday);
    else if (b === BUCKETS - 1) dBottom.push(intraday);
  }
  dailySpread.push(mean(dTop) - mean(dBottom));
  // 같은 날 안의 차이라 시장 몫은 이미 상쇄된다. 그래도 나란히 두면 읽기 쉽다.
  dailyAdjSpread.push(mean(dTop) - mean(dBottom));
}

console.log('갭 십분위 · 그날 시가에 사서 언제 파나  (1분위 = 가장 크게 오르며 출발)');
console.log('분위   표본    그날 갭     장중(시가→종가)  시장뺀 장중   다음날');
console.log('─'.repeat(74));
for (let b = 0; b < BUCKETS; b += 1) {
  const sign = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(3) + '%';
  console.log(
    `${String(b + 1).padStart(3)}${String(bucketIntra[b].length).padStart(7)}`
    + `  ${sign(mean(bucketGap[b])).padStart(9)}`
    + `  ${sign(mean(bucketIntra[b])).padStart(16)}`
    + `  ${sign(mean(bucketAdj[b])).padStart(12)}`
    + `  ${sign(mean(bucketNext[b])).padStart(9)}`,
  );
}

const dm = mean(dailySpread);
const variance =
  dailySpread.length > 1
    ? dailySpread.reduce((a, v) => a + (v - dm) ** 2, 0) / (dailySpread.length - 1)
    : 0;
const se = variance > 0 ? Math.sqrt(variance / dailySpread.length) : 0;
const t = se > 0 ? dm / se : 0;

/*
 * **며칠이 다 만든 값인가.** 날짜별 값에서 절대값 큰 다섯 날을 빼고 다시 본다.
 * 크게 줄면 그건 관계가 아니라 몇 번의 사건이다 — 이 구간에는 서킷브레이커가 있다.
 */
const trimmed = [...dailySpread].sort((a, b) => Math.abs(a) - Math.abs(b)).slice(0, -5);

console.log();
console.log(`▶ 1분위−10분위 장중 = ${(dm >= 0 ? '+' : '') + dm.toFixed(3)}%`
  + ` · 날짜군집 t = ${t >= 0 ? '+' : ''}${t.toFixed(2)} (날짜 ${dailySpread.length}개)`);
console.log(`  극단 5일 빼면 ${(mean(trimmed) >= 0 ? '+' : '') + mean(trimmed).toFixed(3)}%`
  + ` — 크게 줄면 관계가 아니라 사건이다`);
console.log(`  한쪽 우위 ${(dm / 2 >= 0 ? '+' : '') + (dm / 2).toFixed(3)}% vs 왕복 비용 0.430%`);
console.log();
console.log(
  dm > 0
    ? '→ 갭이 **이어진다**. 급등 출발한 종목이 장중에도 더 올랐다.'
    : '→ 갭이 **되돌아온다**. 급등 출발한 종목이 장중에 더 빠졌다 — 시가에 사는 것이 나쁜 자리다.',
);
console.log();
console.log('★ 이 측정이 **못 답하는 것** — 결론을 쓰기 전에 반드시 같이 읽는다:');
console.log('  1. 시가에 실제로 살 수 있느냐. 동시호가에 넣으려면 09:00 전에 정해야 하는데');
console.log('     그때 아는 것은 확정 시가가 아니라 **예상체결가**다. 여기서는 확정 시가로 줄 세웠다.');
console.log('  2. 상·하한가가 낀 분위는 애초에 체결이 안 되거나 물량이 없다.');
console.log('  3. 매도 쪽(공매도)은 우리가 못 쓴다. 실제로 쓸 수 있는 것은 하위 분위 매수뿐이다.');

process.exit(0);
