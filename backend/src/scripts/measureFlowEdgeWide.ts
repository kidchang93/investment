/**
 * 수급이 가격을 예측하는가 — **넓은 표본으로 다시.** (사용자 가설 ②, 2차)
 *
 * ── 1차에서 무엇이 모자랐나 (2026-08-04) ─────────────────────────────────
 *
 * 20종목을 셋으로 나누니 버킷당 6~7종목이었다. 그 정도로는 "그날 외국인이 많이
 * 산 종목"을 줄 세울 수가 없다. 네 축 전부 부호는 양(+)이었지만 날짜 군집
 * t가 0.32~1.66으로 순진한 2.0도 못 넘었다.
 *
 * 그리고 **표본을 오늘 거래대금 순위로 골랐다.** 기준선 20일 수익이 +10.3%로
 * 나온 것이 그 증거다 — 시장 수익이 아니라 "최근 크게 움직인 종목만 봤다"는
 * 선정 인공물이다.
 *
 * ── 이번에 바꾼 것 ───────────────────────────────────────────────────────
 *
 * 1. **표본을 종목코드 순으로 고르게 뽑는다.** 코드는 상장 순서에 가깝고
 *    수익률과 무관하다 — 오늘의 성적으로 고르는 것보다 훨씬 덜 편향된다.
 *    (러너의 후보 선정에서 코드순이 문제였던 것은 **거래할 종목**을 그렇게
 *    고르면 유동성이 없기 때문이고, **측정 표본**으로는 성질이 정반대다.)
 * 2. **ETF·ETN을 뺀다.** ETF 수급은 LP(유동성공급자) 물량이 섞여 정보가 아니다.
 * 3. **십분위로 나눈다.** 종목이 많아야 할 수 있고, 상위 10% vs 하위 10%가
 *    셋으로 나누는 것보다 신호를 진하게 본다.
 * 4. **거래일이 모자라거나 매매가 없던 종목을 뺀다.** 그 필터는 측정 구간
 *    안에서 걸리므로 약한 look-ahead가 남는다 — 밝혀 둔다.
 *
 * ── 여전히 남는 전제 ─────────────────────────────────────────────────────
 *
 * - 겹치는 선도수익률: 날짜 군집 t도 **부풀려진 쪽**이다
 * - 상장폐지된 종목이 마스터에 없다(생존 편향)
 * - 측정 구간이 7/28 −10.84% · 7/31 +17.91%이 낀 극단장이다
 *
 * 조회 전용이다. 주문을 내지 않는다.
 *
 *   npx tsx src/scripts/measureFlowEdgeWide.ts [종목수]
 */

import { getKisAccount, config } from '../config.js';
import { pool } from '../db/client.js';
import { getInvestorFlowDaily, toCredentials } from '../kis/rest.js';

const wanted = Number(process.argv[2] ?? 150);

const prodId = process.env.KIS_OPEN_DAY_CREDENTIAL_ID;
const account = prodId ? getKisAccount(prodId) : null;
if (!account) {
  console.error('실전 조회 자격증명(KIS_OPEN_DAY_CREDENTIAL_ID)이 필요하다 — 모의는 초당 1건이라 너무 느리다.');
  process.exit(1);
}
const credentials = { ...toCredentials(account), crossServerRead: true };

const END_DATES = ['20260803', '20260620', '20260508', '20260327'];
const HORIZONS = [1, 5, 10, 20];
const ROUND_TRIP = 0.0043;
/** 이만큼 거래일이 있어야 표본에 넣는다. 20일 축을 재려면 넉넉해야 한다 */
const MIN_DAYS = 80;

interface Day {
  tradingDay: string;
  close: number;
  foreignShare: number;
}

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length === 0 ? 0 : s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
};
const mean = (v: number[]): number => (v.length === 0 ? 0 : v.reduce((a, b) => a + b, 0) / v.length);

/*
 * 코스피·코스닥 주식을 코드순으로 늘어놓고 고르게 건너뛰며 뽑는다.
 * `ORDER BY symbol`은 수익률과 무관한 순서라 성적으로 고르는 것보다 낫다.
 */
const { rows } = await pool.query<{ symbol: string; name: string }>(
  `SELECT symbol, name FROM instruments
   WHERE country = 'KR' AND asset_type = 'stock' AND market IN ('KOSPI', 'KOSDAQ')
   ORDER BY symbol`,
);
const step = Math.max(1, Math.floor(rows.length / wanted));
const picked = rows.filter((_, index) => index % step === 0).slice(0, wanted);

console.log(`자격증명 ${account.id}(조회 전용) · 서버 ${config.env}`);
console.log(`표집틀 코스피·코스닥 주식 ${rows.length}종목 → ${step}칸마다 뽑아 ${picked.length}종목 조회`);
console.log('★ 코드순 등간격이다 — 수익률과 무관한 순서라 "오늘 잘나가는 종목"으로 고르는 편향이 없다.\n');

const seriesBySymbol = new Map<string, Day[]>();
const nameBySymbol = new Map<string, string>();
let failed = 0;
let tooShort = 0;
for (const row of picked) {
  const byDay = new Map<string, Day>();
  try {
    for (const endDate of END_DATES) {
      for (const f of await getInvestorFlowDaily(row.symbol, endDate, credentials)) {
        const scale = Math.abs(f.individual) + Math.abs(f.foreign) + Math.abs(f.institution);
        if (scale <= 0 || !(f.close > 0)) continue;
        byDay.set(f.tradingDay, {
          tradingDay: f.tradingDay,
          close: f.close,
          foreignShare: f.foreign / scale,
        });
      }
    }
  } catch {
    failed += 1;
    continue;
  }
  const series = [...byDay.values()].sort((a, b) => a.tradingDay.localeCompare(b.tradingDay));
  if (series.length < MIN_DAYS) {
    tooShort += 1;
    continue;
  }
  seriesBySymbol.set(row.symbol, series);
  nameBySymbol.set(row.symbol, row.name);
}

const dayCounts = [...seriesBySymbol.values()].map((s) => s.length);
console.log(`쓸 수 있는 종목 ${seriesBySymbol.size} · 거래일 중앙 ${median(dayCounts)}일`);
console.log(`조회 실패 ${failed} · 거래일 ${MIN_DAYS}일 미만 ${tooShort} (거절이 아니라 못 잰 것이다)\n`);

if (seriesBySymbol.size < 30) {
  console.log('종목이 너무 적어 십분위로 나눌 수 없다. 여기서 멈춘다.');
  process.exit(0);
}

console.log('보유  구분              표본     평균      중앙   비용포함');
console.log('─'.repeat(62));

for (const horizon of HORIZONS) {
  const top: number[] = [];
  const bottom: number[] = [];
  const all: number[] = [];
  const dailySpread: number[] = [];

  const days = new Set<string>();
  for (const series of seriesBySymbol.values()) for (const d of series) days.add(d.tradingDay);

  for (const day of [...days].sort()) {
    const snapshot: Array<{ share: number; forward: number }> = [];
    for (const series of seriesBySymbol.values()) {
      const index = series.findIndex((d) => d.tradingDay === day);
      if (index < 0 || index + horizon >= series.length) continue;
      const entry = series[index].close;
      const exit = series[index + horizon].close;
      if (!(entry > 0) || !(exit > 0)) continue;
      snapshot.push({ share: series[index].foreignShare, forward: exit / entry - 1 });
    }
    // 십분위를 만들려면 그날 종목이 30개는 있어야 한다.
    if (snapshot.length < 30) continue;
    snapshot.sort((a, b) => b.share - a.share);
    const cut = Math.max(1, Math.floor(snapshot.length / 10));
    const dayTop: number[] = [];
    const dayBottom: number[] = [];
    for (let i = 0; i < snapshot.length; i += 1) {
      all.push(snapshot[i].forward);
      if (i < cut) { top.push(snapshot[i].forward); dayTop.push(snapshot[i].forward); }
      else if (i >= snapshot.length - cut) { bottom.push(snapshot[i].forward); dayBottom.push(snapshot[i].forward); }
    }
    dailySpread.push((mean(dayTop) - mean(dayBottom)) * 100);
  }

  if (top.length === 0) {
    console.log(`${String(horizon).padStart(3)}일  표본 없음`);
    continue;
  }
  const show = (label: string, v: number[]): void => {
    const m = mean(v) * 100;
    console.log(
      `${String(horizon).padStart(3)}일  ${label.padEnd(16)}${String(v.length).padStart(5)}`
      + `  ${((m >= 0 ? '+' : '') + m.toFixed(3) + '%').padStart(9)}`
      + `  ${(((median(v) * 100 >= 0 ? '+' : '') + (median(v) * 100).toFixed(3)) + '%').padStart(9)}`
      + `  ${((m - ROUND_TRIP * 100 >= 0 ? '+' : '') + (m - ROUND_TRIP * 100).toFixed(3) + '%').padStart(9)}`,
    );
  };
  show('수급 상위 10%', top);
  show('수급 하위 10%(거울)', bottom);
  show('전체(기준선)', all);

  const dm = mean(dailySpread);
  const variance =
    dailySpread.length > 1
      ? dailySpread.reduce((a, v) => a + (v - dm) ** 2, 0) / (dailySpread.length - 1)
      : 0;
  const se = variance > 0 ? Math.sqrt(variance / dailySpread.length) : 0;
  const t = se > 0 ? dm / se : 0;
  const edge = (mean(top) - mean(bottom)) * 100 / 2;
  console.log(
    `      ▶ 한쪽 우위 ${(edge >= 0 ? '+' : '') + edge.toFixed(3)}%`
    + ` · 날짜군집 t = ${t >= 0 ? '+' : ''}${t.toFixed(2)} (날짜 ${dailySpread.length}개)`
    + ` · 본페로니 |t|>2.50`
    + ` · 비용 0.43% 대비 ${edge !== 0 ? (0.43 / Math.abs(edge)).toFixed(2) : '∞'}배 필요\n`,
  );
}

process.exit(0);
