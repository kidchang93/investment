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
import { getDailyMarketBars, getInvestorFlowDaily, toCredentials } from '../kis/rest.js';
import { cumulativeCellCount, recordSignalMeasurements } from '../db/signalMeasurements.js';
import { bonferroniThreshold, runSignalHarness } from '../trading/signalHarness.js';
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
/**
 * 시세 TR은 기간을 통째로 받는다(한 번에 100거래일). 수급 기준일들이 덮는 범위와
 * **같은 구간**이어야 합쳐질 때 한쪽만 있는 날이 안 생긴다.
 */
const MARKET_RANGE: Record<string, [string, string]> = {
  recent: ['20260301', '20260804'],
  prior: ['20250922', '20260227'],
};
const periodKey = process.argv[3] ?? 'recent';
const END_DATES = PERIODS[periodKey];
const marketRange = MARKET_RANGE[periodKey];
if (!END_DATES || !marketRange) {
  console.error(`모르는 구간: ${periodKey} (${Object.keys(PERIODS).join(' | ')})`);
  process.exit(1);
}
const HORIZONS = [1, 5, 10, 20];
const ROUND_TRIP = 0.43;
const MIN_DAYS = 80;

/*
 * ── 2단계 프로토콜 (2026-08-05) ──────────────────────────────────────────
 *
 * 지금까지 두 구간에 **같은 문턱**을 썼다. 그건 표본 밖 검증을 낭비하는 것이다.
 *
 *   탐색  `recent`에서 전부 재고 **순위만** 매긴다. 결론을 내지 않는다.
 *   확정  `prior`에서 탐색이 지목한 **몇 개만** 딱 한 번. 문턱이 그 수로 정해진다.
 *
 * 962칸에 |t| > 4.05를 요구하는 것과 3칸에 2.40을 요구하는 것은 검정력이 완전히
 * 다르다. 다중검정 값은 탐색에서 치르고, 손대지 않은 데이터에는 한 번만 쓴다.
 *
 * ★ **확정 구간은 한 번 쓰면 끝이다.** 거기서 떨어진 것을 손봐서 다시 재면
 * 그 순간 그것도 탐색이 되고, 이 구조가 주는 이점이 사라진다. 그래서 확정
 * 실행은 원장에 `confirm:` 접두어로 남겨 나중에 구분할 수 있게 한다.
 *
 *   탐색: npx tsx src/scripts/measureSignalHarness.ts 150 recent
 *   확정: npx tsx src/scripts/measureSignalHarness.ts 150 prior momentum20,turnoverSurge
 */
const confirmKeys = (process.argv[4] ?? '')
  .split(',')
  .map((k) => k.trim())
  .filter((k) => k.length > 0);
const isConfirm = confirmKeys.length > 0;

const signals = isConfirm
  ? SIGNAL_CANDIDATES.filter((c) => confirmKeys.includes(c.key))
  : SIGNAL_CANDIDATES;
if (isConfirm && signals.length !== confirmKeys.length) {
  const missing = confirmKeys.filter((k) => !SIGNAL_CANDIDATES.some((c) => c.key === k));
  console.error(`모르는 신호: ${missing.join(', ')}`);
  process.exit(1);
}

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
/**
 * 시세가 안 붙은 날. **이 수를 반드시 찍는다** — 조용히 0이 아니면 시세 기반
 * 신호가 그 날들을 통째로 버리고 있다는 뜻이고, 그러면 신호마다 쓰는 날짜가 달라
 * 표를 나란히 읽을 수 없다.
 */
let daysWithoutMarket = 0;
for (const row of picked) {
  const byDay = new Map<string, DailyBar>();
  try {
    for (const endDate of END_DATES) {
      for (const f of await getInvestorFlowDaily(row.symbol, endDate, credentials)) {
        if (!(f.close > 0)) continue;
        byDay.set(f.tradingDay, f);
      }
    }
    /*
     * 시세를 **수급 위에 덧댄다.** 종가는 수급 응답의 것을 그대로 둔다 — 한
     * 응답 안에서 나온 값끼리 맞춰야 수정주가 경계에서 어긋나지 않는다.
     */
    for (const m of await getDailyMarketBars(row.symbol, marketRange[0], marketRange[1], credentials)) {
      const bar = byDay.get(m.tradingDay);
      if (!bar) continue;
      if (m.open > 0) bar.open = m.open;
      if (m.high > 0) bar.high = m.high;
      if (m.low > 0) bar.low = m.low;
      if (m.turnover > 0) bar.turnover = m.turnover;
      // 공매도 0%는 진짜 0일 수 있다(그날 공매도가 없었다). 값이 오면 그대로 받는다.
      bar.shortRatio = m.shortRatio;
    }
  } catch {
    failed += 1;
    continue;
  }
  const bars = [...byDay.values()].sort((a, b) => a.tradingDay.localeCompare(b.tradingDay));
  daysWithoutMarket += bars.filter((b) => b.turnover === undefined).length;
  if (bars.length >= MIN_DAYS) barsBySymbol.set(row.symbol, bars);
}

console.log(`쓸 수 있는 종목 ${barsBySymbol.size} · 조회 실패 ${failed}`);
console.log(`시세가 안 붙은 종목·날 ${daysWithoutMarket}개`
  + (daysWithoutMarket > 0 ? ' ← 시세 기반 신호는 이만큼 덜 본다' : ''));
console.log(
  `${isConfirm ? '★ 확정' : '탐색'} · 후보 ${signals.length}개 × 축 ${HORIZONS.length}개`
  + (isConfirm
    ? ` — 탐색이 지목한 것만: ${confirmKeys.join(', ')}`
    : ' — 순위만 매기고 결론은 내지 않는다')
  + '\n',
);

const result = runSignalHarness({
  barsBySymbol,
  signals,
  horizons: HORIZONS,
  minNamesPerDay: 30,
  buckets: 10,
});

/*
 * ★ **문턱은 이번 실행이 아니라 지금까지 잰 전부로 정한다.**
 *
 * 매일 새 신호를 재면서 그때그때 이번 칸 수로만 보정하면, 스무 날 뒤에는 800칸을
 * 잰 셈인데 문턱은 40칸짜리를 쓰고 있다. 그러면 **언젠가 반드시 우연히 유의한
 * 것이 나오고 그것을 "찾았다"고 믿는다.**
 *
 * 원장(`trading_signal_measurements`)이 지금까지의 줄 수를 세어 준다. 이번에 잴
 * 칸을 더한 값이 정직한 분모다.
 */
const priorCells = await cumulativeCellCount();
const totalCells = priorCells + result.cellCount;
/*
 * 확정 실행은 **이번 칸만**으로 문턱을 정한다. 손대지 않은 구간에 미리 정해 둔
 * 가설 몇 개를 한 번 태우는 것이라, 지금까지의 탐색 부담을 다시 물리지 않는다.
 * 탐색 실행은 누적으로 문턱을 올린다.
 */
const threshold = bonferroniThreshold(isConfirm ? result.cellCount : totalCells);

if (isConfirm) {
  console.log(`★ 확정 ${result.cellCount}칸 · 문턱 |t| > ${threshold.toFixed(2)}`);
  console.log('  손대지 않은 구간에 미리 지목한 가설만 태운다 — 누적 부담을 다시 물리지 않는다.');
  console.log('  ★ 이 구간은 한 번 쓰면 끝이다. 떨어진 것을 손봐 다시 재면 그건 탐색이다.\n');
} else {
  console.log(`탐색 ${result.cellCount}칸 · 지금까지 잰 것 ${priorCells}칸 → 누적 ${totalCells}칸`);
  console.log(`본페로니 문턱 |t| > ${threshold.toFixed(2)}`
    + `  (이번 것만 세면 ${result.bonferroniT.toFixed(2)} — 그걸 쓰면 안 된다)\n`);
}
/*
 * ★ **판정을 매수 다리로 바꿨다 (2026-08-06).**
 *
 * 예전에는 `alpha/2`(스프레드의 절반)로 판정했다. 그건 상위를 사고 하위를 **파는**
 * 것을 반씩 센 값인데 **우리는 공매도를 못 한다.** 2026-08-06에 `turnoverSurge`
 * 20일이 그 결함으로 "★ 생존"이 났다 — 갈라 보니 살 수 있는 쪽은 t 2.25로
 * 문턱 2.74를 못 넘었다.
 *
 * **원장에 남은 이전 생존 판정들은 전부 옛 기준이다.** 다시 재기 전에는 믿지 않는다.
 */
console.log('신호                        축   다리알파   t    (참고)다리   10%절사 상위5일  베타  판정');
console.log('─'.repeat(100));

const survivors: typeof result.cells = [];
for (const signal of signals) {
  for (const cell of result.cells.filter((c) => c.signalKey === signal.key)) {
    /*
     * **생존은 알파로 판정한다.** 원시 우위가 크고 유의해도 그게 시장 노출이면
     * 매매 근거가 아니다 — 2026-08-04에 저변동성이 +5.807%(t 10.68)로 살아남았는데
     * 그 구간은 평범한 종목이 20일에 −5.7% 빠지던 장이었다.
     *
     * 셋을 다 넘어야 한다: 시장을 뺀 뒤에도 유의하고, 그 알파가 왕복 비용을 넘고,
     * 부호가 맞아야 한다.
     */
    /*
     * **매수 다리로 판정한다.** 셋을 다 넘어야 한다:
     * 살 수 있는 쪽이 유의하고(문턱), 그 값이 왕복 비용을 넘고, 부호가 맞아야 한다.
     */
    /*
     * ★ **판정은 매수 다리의 알파로 한다 (2026-08-06).**
     *
     * `topLegMean`만 보면 저변동성 계열이 전부 통과한다 — 하락장에서 변동 큰
     * 종목이 더 빠지므로 자동으로 나오는 값이다. 시장을 뺀 뒤에도 남아야 우위다.
     */
    const passes = Math.abs(cell.topLegAlphaT) > threshold && cell.topLegAlpha > ROUND_TRIP;
    if (passes) survivors.push(cell);
    const sign = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(3) + '%';
    const share = cell.topLegTop5Share;
    console.log(
      `${signal.label.slice(0, 24).padEnd(26)}${String(cell.horizon).padStart(3)}일`
      + `  ${sign(cell.topLegAlpha).padStart(8)}`
      + `  ${((cell.topLegAlphaT >= 0 ? '+' : '') + cell.topLegAlphaT.toFixed(2)).padStart(6)}`
      + `  ${sign(cell.topLegMean).padStart(10)}`
      + `  ${sign(cell.topLegTrimmed10).padStart(8)}`
      // 합이 0에 가까우면 몫을 물을 수 없다. 큰 수를 찍어 오해하게 두지 않는다.
      + `  ${(share === undefined ? '—' : `${(share * 100).toFixed(0)}%`).padStart(6)}`
      + `  ${cell.topLegBeta.toFixed(2).padStart(5)}`
      + `  ${passes ? '★ 생존' : ''}`,
    );
  }
}

console.log();
console.log(`── 판정 ${'─'.repeat(60)}`);
console.log(`살아남은 칸: ${survivors.length} / ${result.cellCount}`);
console.log(`조건: **매수 다리의 알파**(시장 회귀 절편) |t| > ${threshold.toFixed(2)}`
  + ` (누적 ${totalCells}칸 본페로니) 그리고 그 값 > 왕복 비용 ${ROUND_TRIP}%`);
console.log('★ (참고)다리는 시장을 안 뺀 값이다 — 저변동성은 하락장에서 자동으로 커진다.');
console.log('★ 상위5일 몫이 크면 관계가 아니라 사건이다. 10%절사와 함께 읽는다.');
console.log('베타가 1에 가까운 칸은 그 신호가 시장 방향에 얹혀 있다는 뜻이다 — 우위가 아니라 노출이다.');
if (survivors.length === 0) {
  console.log('→ 이 후보들 중 이 축에서 비용을 넘는 우위는 없다. 그것도 답이다.');
} else {
  for (const s of survivors) {
    console.log(
      `→ ★ ${s.signalKey} ${s.horizon}일 · **다리 알파** ${s.topLegAlpha.toFixed(3)}% (t ${s.topLegAlphaT.toFixed(2)})`
      + ` · 시장 안 뺀 다리 ${s.topLegMean.toFixed(3)}% · 10%절사 ${s.topLegTrimmed10.toFixed(3)}%`
      + ` · 다리 베타 ${s.topLegBeta.toFixed(2)}`
      + (s.topLegTop5Share === undefined ? '' : ` · 상위5일 몫 ${(s.topLegTop5Share * 100).toFixed(0)}%`),
    );
  }
  console.log('★ 살아남았다고 확정이 아니다 — 겹치는 선도수익률 때문에 t가 부풀려진 쪽이고,');
  console.log('  표본 밖(다른 기간)에서 다시 재야 한다.');
}

/*
 * **살아남았든 죽었든 전부 남긴다.** 죽은 것을 안 남기면 다음에 또 재게 되고,
 * 그 반복이 곧 다중검정 부담인데 세어지지 않는다.
 */
await recordSignalMeasurements(
  result.cells.map((cell) => ({
    measuredAt: Date.now(),
    signalKey: cell.signalKey,
    rationale: signals.find((s) => s.key === cell.signalKey)?.rationale ?? '',
    horizonDays: cell.horizon,
    periodKey: isConfirm ? `confirm:${periodKey}` : periodKey,
    periodFrom: END_DATES[END_DATES.length - 1],
    periodTo: END_DATES[0],
    universe: `code-ordered-equidistant-${picked.length}`,
    symbolsCount: barsBySymbol.size,
    daysCount: cell.days,
    samples: cell.samples,
    spreadMean: cell.spreadMean,
    spreadMedian: cell.spreadMedian,
    tStat: cell.t,
    alpha: cell.alpha,
    alphaT: cell.alphaT,
    beta: cell.beta,
    runCellCount: result.cellCount,
    bonferroniT: threshold,
    survived: survivors.includes(cell),
    note: `시세 안 붙은 종목·날 ${daysWithoutMarket}`,
    topLegMean: cell.topLegMean,
    topLegT: cell.topLegT,
    topLegTrimmed10: cell.topLegTrimmed10,
    topLegTop5Share: cell.topLegTop5Share,
    topLegAlpha: cell.topLegAlpha,
    topLegAlphaT: cell.topLegAlphaT,
    topLegBeta: cell.topLegBeta,
    verdictBasis: 'topLegAlpha',
  })),
);
console.log(`\n원장에 ${result.cells.length}줄 남겼다 — 다음 실행의 문턱이 그만큼 올라간다.`);

process.exit(0);
