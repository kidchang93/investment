/**
 * 후보 신호 전부를 한꺼번에 잰다.
 *
 * 표본은 **코드순 등간격**이다 — 수익률과 무관한 순서라 "오늘 잘나가는 종목"으로
 * 고르는 편향이 없다. 2026-08-04에 그 편향이 결론을 통째로 뒤집는 것을 값으로
 * 봤다(20일 기준선 +10.3% → −5.7%).
 *
 * 조회 전용이다. 주문을 내지 않는다.
 *
 *   npx tsx src/scripts/measureSignalHarness.ts [종목수]
 */

import { getKisAccount, config } from '../config.js';
import { pool } from '../db/client.js';
import { getInvestorFlowDaily, toCredentials } from '../kis/rest.js';
import { runSignalHarness } from '../trading/signalHarness.js';
import { SIGNAL_CANDIDATES, type DailyBar } from '../trading/signals.js';

const wanted = Number(process.argv[2] ?? 150);

/*
 * 구간을 인자로 받는다. **표본 밖 검증이 이 스크립트의 다음 일**이라
 * 값을 박아 두면 매번 파일을 고쳐야 하고, 고친 김에 다른 것도 바뀌기 쉽다.
 *
 * 한 번에 30거래일씩 오므로 기준일을 물려 가며 받는다. 뒤에서 앞으로 간다.
 */
const PERIODS: Record<string, string[]> = {
  // 2026-03~08. 7/28 −10.84%(서킷브레이커)·7/31 +17.91%이 낀 극단 구간이다.
  recent: ['20260803', '20260620', '20260508', '20260327'],
  // 2025-09~2026-02. 표본 밖. 여기서 죽으면 recent의 생존은 그 구간의 성질이었다.
  prior: ['20260226', '20260115', '20251203', '20251022'],
};
const periodKey = process.argv[3] ?? 'recent';
const END_DATES = PERIODS[periodKey];
if (!END_DATES) {
  console.error(`모르는 구간: ${periodKey} (${Object.keys(PERIODS).join(' | ')})`);
  process.exit(1);
}
const HORIZONS = [1, 5, 10, 20];
const ROUND_TRIP = 0.43;
const MIN_DAYS = 80;

const prodId = process.env.KIS_OPEN_DAY_CREDENTIAL_ID;
const account = prodId ? getKisAccount(prodId) : null;
if (!account) {
  console.error('실전 조회 자격증명(KIS_OPEN_DAY_CREDENTIAL_ID)이 필요하다.');
  process.exit(1);
}
const credentials = { ...toCredentials(account), crossServerRead: true };

const { rows } = await pool.query<{ symbol: string; name: string }>(
  `SELECT symbol, name FROM instruments
   WHERE country = 'KR' AND asset_type = 'stock' AND market IN ('KOSPI', 'KOSDAQ')
   ORDER BY symbol`,
);
const step = Math.max(1, Math.floor(rows.length / wanted));
const picked = rows.filter((_, i) => i % step === 0).slice(0, wanted);

console.log(`자격증명 ${account.id}(조회 전용) · 서버 ${config.env}`);
console.log(`구간 ${periodKey} · 기준일 ${END_DATES.join(', ')}`);
console.log(`표집틀 ${rows.length}종목 → ${step}칸마다 ${picked.length}종목 조회\n`);

const barsBySymbol = new Map<string, DailyBar[]>();
let failed = 0;
for (const row of picked) {
  const byDay = new Map<string, DailyBar>();
  try {
    for (const endDate of END_DATES) {
      for (const f of await getInvestorFlowDaily(row.symbol, endDate, credentials)) {
        if (!(f.close > 0)) continue;
        byDay.set(f.tradingDay, f);
      }
    }
  } catch {
    failed += 1;
    continue;
  }
  const bars = [...byDay.values()].sort((a, b) => a.tradingDay.localeCompare(b.tradingDay));
  if (bars.length >= MIN_DAYS) barsBySymbol.set(row.symbol, bars);
}

console.log(`쓸 수 있는 종목 ${barsBySymbol.size} · 조회 실패 ${failed}`);
console.log(`후보 ${SIGNAL_CANDIDATES.length}개 × 축 ${HORIZONS.length}개\n`);

const result = runSignalHarness({
  barsBySymbol,
  signals: SIGNAL_CANDIDATES,
  horizons: HORIZONS,
  minNamesPerDay: 30,
  buckets: 10,
});

console.log(`총 ${result.cellCount}칸 · 본페로니 문턱 |t| > ${result.bonferroniT.toFixed(2)}\n`);
console.log('신호                        축    우위      t   │  알파(시장뺌)  알파t   베타  판정');
console.log('─'.repeat(88));

const survivors: typeof result.cells = [];
for (const signal of SIGNAL_CANDIDATES) {
  for (const cell of result.cells.filter((c) => c.signalKey === signal.key)) {
    const edge = cell.spreadMean / 2;
    const alphaEdge = cell.alpha / 2;
    /*
     * **생존은 알파로 판정한다.** 원시 우위가 크고 유의해도 그게 시장 노출이면
     * 매매 근거가 아니다 — 2026-08-04에 저변동성이 +5.807%(t 10.68)로 살아남았는데
     * 그 구간은 평범한 종목이 20일에 −5.7% 빠지던 장이었다.
     *
     * 셋을 다 넘어야 한다: 시장을 뺀 뒤에도 유의하고, 그 알파가 왕복 비용을 넘고,
     * 부호가 맞아야 한다.
     */
    const passes = Math.abs(cell.alphaT) > result.bonferroniT && alphaEdge > ROUND_TRIP;
    if (passes) survivors.push(cell);
    console.log(
      `${signal.label.slice(0, 24).padEnd(26)}${String(cell.horizon).padStart(3)}일`
      + `  ${((edge >= 0 ? '+' : '') + edge.toFixed(3) + '%').padStart(8)}`
      + `  ${((cell.t >= 0 ? '+' : '') + cell.t.toFixed(2)).padStart(6)}`
      + `  │  ${((alphaEdge >= 0 ? '+' : '') + alphaEdge.toFixed(3) + '%').padStart(9)}`
      + `  ${((cell.alphaT >= 0 ? '+' : '') + cell.alphaT.toFixed(2)).padStart(6)}`
      + `  ${cell.beta.toFixed(2).padStart(5)}`
      + `  ${passes ? '★ 생존' : ''}`,
    );
  }
}

console.log();
console.log(`── 판정 ${'─'.repeat(60)}`);
console.log(`살아남은 칸: ${survivors.length} / ${result.cellCount}`);
console.log(`조건: **시장을 뺀** |알파t| > ${result.bonferroniT.toFixed(2)} (본페로니) 그리고 알파 우위 > 왕복 비용 ${ROUND_TRIP}%`);
console.log('베타가 1에 가까운 칸은 그 신호가 시장 방향에 얹혀 있다는 뜻이다 — 우위가 아니라 노출이다.');
if (survivors.length === 0) {
  console.log('→ 이 후보들 중 이 축에서 비용을 넘는 우위는 없다. 그것도 답이다.');
} else {
  for (const s of survivors) {
    console.log(
      `→ ★ ${s.signalKey} ${s.horizon}일 · 알파 ${(s.alpha / 2).toFixed(3)}% (t ${s.alphaT.toFixed(2)})`
      + ` · 원시 우위 ${(s.spreadMean / 2).toFixed(3)}% · 베타 ${s.beta.toFixed(2)}`,
    );
  }
  console.log('★ 살아남았다고 확정이 아니다 — 겹치는 선도수익률 때문에 t가 부풀려진 쪽이고,');
  console.log('  표본 밖(다른 기간)에서 다시 재야 한다.');
}

process.exit(0);
