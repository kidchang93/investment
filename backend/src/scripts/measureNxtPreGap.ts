/**
 * **08:00에 알 수 있는 것으로 줄 세워도 갭 되돌림이 남는가.**
 *
 * ── 왜 이 질문인가 (2026-08-05) ──────────────────────────────────────────
 *
 * `measureOpeningGap.ts`가 갭 되돌림을 찾았다(두 구간 t −7.46 / −5.15). 그런데
 * 그건 **09:00 확정 시가로 줄 세운 것**이라 실행할 수 없다 — 동시호가에 주문을
 * 넣으려면 09:00 전에 정해야 하는데 그때 확정 시가를 모른다.
 *
 * NXT 프리마켓은 08:00부터 **실제로 체결된다.** 그 값으로 줄 세워도 같은 것이
 * 나오면 **실행 가능한 신호**가 된다.
 *
 * ── 무엇을 재나 ──────────────────────────────────────────────────────────
 *
 *   preGap    = NXT 08:00 시가 / 전일 KRX 종가 − 1   ← **08:00에 안다**
 *   actualGap = KRX 09:00 시가 / 전일 KRX 종가 − 1   ← 09:00에야 안다
 *   intraday  = KRX 종가 / KRX 09:00 시가 − 1        ← 우리가 버는 것
 *
 * 물음 둘:
 *   ① preGap이 actualGap을 얼마나 미리 말해 주나 (회귀 기울기·상관)
 *   ② **preGap으로 줄 세워도** 하위 분위 intraday가 양(+)인가
 *
 * ②가 진짜 질문이다. ①이 좋아도 ②가 안 되면 쓸모없고, ①이 나빠도 ②가 되면 쓴다.
 *
 * ── 이 측정의 한계 ───────────────────────────────────────────────────────
 *
 * - **표본이 NXT 대상 종목으로 좁아진다**(603종목, 대형주 쏠림). 앞선 전 종목
 *   측정과 숫자를 나란히 놓으면 안 된다 — 다른 모집단이다
 * - NXT 일봉 시가가 08:00 프리마켓 시가라는 것은 **2026-08-04 분봉 대조로 확인**했다
 *   (일봉 시가 239,000 = 08:00 분봉 시가). 한 종목·하루로 확인한 것이다
 * - 08:00은 프리마켓의 **시작**이다. 08:45까지 값이 더 움직이므로 이 측정은
 *   실제로 쓸 수 있는 정보의 **일부만** 쓴 것이다 — 즉 **보수적인 쪽**이다
 *
 * 조회 전용이다. 주문을 내지 않는다.
 *
 *   npx tsx src/scripts/measureNxtPreGap.ts [종목수] [recent|prior]
 */

import { getKisAccount } from '../config.js';
import { pool } from '../db/client.js';
import { getDailyMarketBars, toCredentials } from '../kis/rest.js';

const wanted = Number(process.argv[2] ?? 150);
const PERIODS: Record<string, [string, string]> = {
  recent: ['20260301', '20260804'],
  // NXT는 2025-03-04 출범이라 그 앞은 아예 없다. prior도 출범 뒤로 잡는다.
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

const { rows } = await pool.query<{ symbol: string }>(
  `SELECT symbol FROM instruments
   WHERE country = 'KR' AND asset_type = 'stock' AND market IN ('KOSPI', 'KOSDAQ')
   ORDER BY symbol`,
);
const step = Math.max(1, Math.floor(rows.length / wanted));
const picked = rows.filter((_, i) => i % step === 0).slice(0, wanted);

console.log(`구간 ${periodKey} (${range[0]}~${range[1]}) · 후보 ${picked.length}종목`);
console.log('★ 표본은 코드순 등간격 — 그중 NXT 대상만 남는다(대형주 쏠림).\n');

interface Day {
  preGap: number;
  actualGap: number;
  intraday: number;
}

const byDay = new Map<string, Day[]>();
const all: Day[] = [];
let nxtStocks = 0;
let noNxt = 0;
let failed = 0;

for (const row of picked) {
  /*
   * **NXT를 먼저 묻는다.** 코드순 표본의 약 80%가 NXT 대상이 아니라, KRX를 먼저
   * 받으면 그 호출이 통째로 버려진다. 순서만 바꿔도 호출이 절반 아래로 준다 —
   * 표본을 키우려면 이게 필요하다.
   */
  let nxt;
  try {
    nxt = await getDailyMarketBars(row.symbol, range[0], range[1], credentials, 'NXT');
  } catch {
    failed += 1;
    continue;
  }
  // NXT 대상이 아니면 행이 안 오거나 값이 0이다. 그 종목은 프리마켓에서 살 수 없다.
  const nxtOpenByDay = new Map<string, number>();
  for (const b of nxt) if (b.open > 0) nxtOpenByDay.set(b.tradingDay, b.open);
  if (nxtOpenByDay.size === 0) {
    noNxt += 1;
    continue;
  }
  nxtStocks += 1;

  let krx;
  try {
    krx = await getDailyMarketBars(row.symbol, range[0], range[1], credentials);
  } catch {
    failed += 1;
    continue;
  }

  const asc = [...krx].sort((a, b) => a.tradingDay.localeCompare(b.tradingDay));
  for (let i = 1; i < asc.length; i += 1) {
    const prev = asc[i - 1];
    const cur = asc[i];
    const nxtOpen = nxtOpenByDay.get(cur.tradingDay);
    // 하나라도 없으면 그날은 못 잰다. 0으로 채우지 않는다.
    if (nxtOpen === undefined) continue;
    if (!(prev.close > 0) || !(cur.open > 0) || !(cur.close > 0)) continue;
    const entry: Day = {
      preGap: (nxtOpen / prev.close - 1) * 100,
      actualGap: (cur.open / prev.close - 1) * 100,
      intraday: (cur.close / cur.open - 1) * 100,
    };
    all.push(entry);
    const list = byDay.get(cur.tradingDay) ?? [];
    list.push(entry);
    byDay.set(cur.tradingDay, list);
  }
}

console.log(`NXT 대상 ${nxtStocks}종목 · NXT 없음 ${noNxt} · 조회 실패 ${failed}`);
console.log(`종목·날 ${all.length}개 · 날짜 ${byDay.size}일\n`);
if (all.length < 200) {
  console.log('표본이 너무 적다. 여기서 멈춘다.');
  process.exit(0);
}

/*
 * ① 08:00이 09:00을 얼마나 말해 주나. actualGap을 preGap에 회귀한다.
 *   기울기 1·상관 1이면 08:00에 이미 다 정해진 것이고, 0이면 아무 상관이 없다.
 */
const mx = mean(all.map((d) => d.preGap));
const my = mean(all.map((d) => d.actualGap));
let sxy = 0;
let sxx = 0;
let syy = 0;
for (const d of all) {
  sxy += (d.preGap - mx) * (d.actualGap - my);
  sxx += (d.preGap - mx) ** 2;
  syy += (d.actualGap - my) ** 2;
}
const slope = sxx > 0 ? sxy / sxx : 0;
const corr = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;

console.log('① 08:00 프리마켓이 09:00 시가를 얼마나 미리 말해 주나');
console.log(`   기울기 ${slope.toFixed(3)} · 상관 ${corr.toFixed(3)} · 설명력 R² ${(corr * corr).toFixed(3)}`);
console.log(`   preGap 평균 ${mx.toFixed(3)}%  vs  actualGap 평균 ${my.toFixed(3)}%`);
console.log(
  corr > 0.7
    ? '   → 08:00에 이미 대부분 정해져 있다. 그 값으로 줄 세워도 될 만하다.'
    : '   → 08:00과 09:00이 꽤 다르다. 아래 ②가 더 중요하다.',
);
console.log();

/*
 * ② **preGap으로 줄 세운다.** 09:00 확정 시가가 아니라 08:00에 아는 값이다.
 *   이게 양(+)이어야 실제로 쓸 수 있다.
 */
const BUCKETS = 10;

interface Ranked {
  /** 분위별 장중 수익(%) */
  intraday: number[][];
  /** 분위별 줄 세운 값(%) */
  key: number[][];
  /** 분위별 그날 평균을 뺀 장중(%) */
  adjusted: number[][];
  /** 날짜별 1분위−10분위 */
  dailySpread: number[];
}

/**
 * 주어진 값으로 날짜마다 줄 세워 십분위를 모은다.
 *
 * **두 번 부른다** — `preGap`(08:00에 아는 값)과 `actualGap`(09:00에야 아는 값).
 * 같은 표본·같은 날짜에 두 잣대를 태워야 *"줄 세운 값이 달라서 죽은 것"*과
 * *"표본이 달라서 죽은 것"*을 가를 수 있다. 첫 실행에서 둘이 함께 바뀌어
 * 어느 쪽인지 알 수 없었다(2026-08-05).
 */
function rankBy(pick: (d: Day) => number): Ranked {
  const out: Ranked = {
    intraday: Array.from({ length: BUCKETS }, () => []),
    key: Array.from({ length: BUCKETS }, () => []),
    adjusted: Array.from({ length: BUCKETS }, () => []),
    dailySpread: [],
  };
  for (const [, list] of byDay) {
    // NXT 대상만 남아 종목 수가 적다. 20이면 십분위가 분위당 2종목이다 — 그 아래는 안 센다.
    if (list.length < 20) continue;
    const sorted = [...list].sort((a, b) => pick(b) - pick(a));
    const dayMean = mean(sorted.map((d) => d.intraday));
    const size = sorted.length / BUCKETS;
    const top: number[] = [];
    const bottom: number[] = [];
    for (let i = 0; i < sorted.length; i += 1) {
      const b = Math.min(BUCKETS - 1, Math.floor(i / size));
      out.intraday[b].push(sorted[i].intraday);
      out.key[b].push(pick(sorted[i]));
      out.adjusted[b].push(sorted[i].intraday - dayMean);
      if (b === 0) top.push(sorted[i].intraday);
      else if (b === BUCKETS - 1) bottom.push(sorted[i].intraday);
    }
    if (top.length > 0 && bottom.length > 0) out.dailySpread.push(mean(top) - mean(bottom));
  }
  return out;
}

function report(title: string, keyLabel: string, r: Ranked): void {
  console.log(title);
  console.log(`분위   표본  ${keyLabel.padStart(9)}   장중(시가→종가)  시장뺀 장중`);
  console.log('─'.repeat(60));
  const sign = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(3) + '%';
  for (let b = 0; b < BUCKETS; b += 1) {
    console.log(
      `${String(b + 1).padStart(3)}${String(r.intraday[b].length).padStart(7)}`
      + `  ${sign(mean(r.key[b])).padStart(9)}`
      + `  ${sign(mean(r.intraday[b])).padStart(16)}`
      + `  ${sign(mean(r.adjusted[b])).padStart(12)}`,
    );
  }
  const dm = mean(r.dailySpread);
  const variance =
    r.dailySpread.length > 1
      ? r.dailySpread.reduce((a, v) => a + (v - dm) ** 2, 0) / (r.dailySpread.length - 1)
      : 0;
  const se = variance > 0 ? Math.sqrt(variance / r.dailySpread.length) : 0;
  const t = se > 0 ? dm / se : 0;
  const trimmed = [...r.dailySpread].sort((a, b) => Math.abs(a) - Math.abs(b)).slice(0, -5);
  console.log(`▶ 1분위−10분위 = ${sign(dm)} · 날짜군집 t = ${t >= 0 ? '+' : ''}${t.toFixed(2)}`
    + ` (날짜 ${r.dailySpread.length}개) · 극단 5일 빼면 ${sign(mean(trimmed))}`);

  /*
   * ★ 실제로 쓸 수 있는 것은 **하위 분위 매수 한 다리뿐**이다. 상위를 파는 쪽이
   *   이익이 커도 그건 공매도라 우리가 못 쓴다. 그 한 다리만 따로 센다.
   */
  const leg = mean(r.intraday[BUCKETS - 1]);
  console.log(`  쓸 수 있는 한 다리(10분위 매수): ${sign(leg)} − 비용 0.430% = ${sign(leg - 0.43)}`
    + (leg - 0.43 > 0 ? '  ★ 비용을 넘는다' : '  → 비용을 못 넘는다'));
  console.log();
}

report(
  '② 08:00 프리마켓 갭으로 줄 세운다 — **실행 가능한 쪽**',
  '08:00 갭',
  rankBy((d) => d.preGap),
);
report(
  '③ [대조군] 09:00 확정 시가로 줄 세운다 — 같은 표본·같은 날짜',
  '09:00 갭',
  rankBy((d) => d.actualGap),
);

console.log('★ ②와 ③을 나란히 읽는다.');
console.log('  ③이 살아 있고 ②가 죽었으면 → **08:00에는 아직 정보가 안 실린 것**이다.');
console.log('  ③도 죽었으면 → 줄 세운 값 문제가 아니라 **이 표본(NXT 대상 대형주)에 그 현상이 없는 것**이다.');
console.log('  전 종목 측정(measureOpeningGap)과 숫자를 직접 비교하면 안 된다 — 모집단이 다르다.');
console.log();
console.log('★ 여전히 못 답하는 것: 08:00은 프리마켓의 **시작**이다. 08:45까지 값이 더 움직이므로');
console.log('  실제로 쓸 수 있는 정보의 일부만 쓴 것이다 — 분봉으로 재면 달라질 수 있다.');

process.exit(0);
