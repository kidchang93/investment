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
const END_DATES = ['20260803', '20260620', '20260508', '20260327'];
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
console.log('신호                            축   상위−하위    중앙       우위       t   판정');
console.log('─'.repeat(84));

const survivors: typeof result.cells = [];
for (const signal of SIGNAL_CANDIDATES) {
  for (const cell of result.cells.filter((c) => c.signalKey === signal.key)) {
    const edge = cell.spreadMean / 2;
    // 살아남으려면 **둘 다**여야 한다 — 유의하고, 비용을 넘고, 부호가 맞아야 한다.
    const passes = Math.abs(cell.t) > result.bonferroniT && edge > ROUND_TRIP;
    if (passes) survivors.push(cell);
    console.log(
      `${signal.label.slice(0, 28).padEnd(30)}${String(cell.horizon).padStart(3)}일`
      + `  ${((cell.spreadMean >= 0 ? '+' : '') + cell.spreadMean.toFixed(3) + '%').padStart(9)}`
      + `  ${((cell.spreadMedian >= 0 ? '+' : '') + cell.spreadMedian.toFixed(3) + '%').padStart(8)}`
      + `  ${((edge >= 0 ? '+' : '') + edge.toFixed(3) + '%').padStart(8)}`
      + `  ${(cell.t >= 0 ? '+' : '') + cell.t.toFixed(2)}`.padStart(7)
      + `  ${passes ? '★ 생존' : ''}`,
    );
  }
}

console.log();
console.log(`── 판정 ${'─'.repeat(60)}`);
console.log(`살아남은 칸: ${survivors.length} / ${result.cellCount}`);
console.log(`조건: |t| > ${result.bonferroniT.toFixed(2)} (본페로니) **그리고** 한쪽 우위 > 왕복 비용 ${ROUND_TRIP}%`);
if (survivors.length === 0) {
  console.log('→ 이 후보들 중 이 축에서 비용을 넘는 우위는 없다. 그것도 답이다.');
} else {
  for (const s of survivors) {
    console.log(`→ ★ ${s.signalKey} ${s.horizon}일 · 우위 ${(s.spreadMean / 2).toFixed(3)}% · t ${s.t.toFixed(2)}`);
  }
  console.log('★ 살아남았다고 확정이 아니다 — 겹치는 선도수익률 때문에 t가 부풀려진 쪽이고,');
  console.log('  표본 밖(다른 기간)에서 다시 재야 한다.');
}

process.exit(0);
