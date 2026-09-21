/**
 * **배당락 전후로 사고파는 타이밍에 이득이 있나** — 원주가로 잰다.
 *
 * ── 왜 생겼나 (2026-09-21) ───────────────────────────────────────────────
 *
 * 사용자가 ETF 매매 방식을 제안했다 — *"팔때 배당락일 이전이라면 배당락일 다음에 팔던
 * 배당금을 받지 않고 팔던 자유롭게 열어두는게 좋을 것 같아. 매수하는것도 각 종목
 * 배당락일 직전까지 매수하도록하고 만약 배당락일이 지나서 폭락 시그널이 오게되면 폭락 후
 * 매매해서 다음 배당락일에 더 큰 이득을 볼 수 있다면 그렇게 매매하는 것도 방법이 될 수
 * 있을 것 같아."* 규칙으로 박기 전에 잰다(`docs/STRATEGY_DISCIPLINE.md` 원칙 2).
 *
 * ── 무엇을 재나 ──────────────────────────────────────────────────────────
 *
 * 1. **낙폭비율** = (배당락 전일 종가 − 배당락일 시가) ÷ 주당 배당금
 *    일반계좌 국내주식형은 배당에 15.4%가 붙고 차익은 비과세라, 배당을 받는 쪽(직전 매수·
 *    직후 매도)이 이득인 문턱이 **0.846**이다. 기타형은 차익도 15.4%라 문턱이 **1.0**.
 *    세후 손익 ≈ (문턱 − 낙폭비율) × 배당률
 * 2. **배당락 뒤 흐름** — 배당락일 시가에서 5·20거래일 뒤 종가, **KODEX 200 대비**.
 *    양수면 "배당락 뒤에 사면 반등한다"
 *
 * ★★★ **원주가로 잰다.** 수정주가(DB 일봉)는 ETF 분배금까지 조정해 배당락 갭이 **사라져
 *     있다** — 첫 판을 수정주가로 쟀더니 모든 종목의 낙폭비율이 0 근처로 나왔고, 그걸
 *     추적하다 수정주가가 배당을 품고 있다는 것을 알았다(`kis/rest.ts` `getKisRawDailyBars`).
 * ★ 시장 조정은 KODEX 200 **수정주가**로 한다 — 배당락일이 아닌 날의 일간 수익률은 원주가와
 *   같다. KODEX 200 자신의 배당락은 조정하지 않는다.
 * ★ 탐색 측정이다. 유의성 검정은 하지 않았다 — 효과가 편도 비용(~0.04%)보다 작으면 유의해도
 *   쓸 수 없어 따질 필요가 없다.
 *
 * 배당 건마다 원주가를 한 번씩 묻는다(모의 초당 1건이라 220건에 4분쯤).
 *
 * 쓰는 법:  cd backend && npx tsx src/scripts/measureExDividend.ts
 */
import { getKisAccount } from '../config.js';
import { getKisDividendSchedule, getKisRawDailyBars } from '../kis/rest.js';
import { kstToday } from '../kis/normalize.js';
import { getDailyBars } from '../db/dailyBars.js';

const account = getKisAccount('VTS-ORDINARY')!;
const today = kstToday();
const names: Record<string, string> = {
  '161510': 'PLUS 고배당주', '329200': 'TIGER 리츠부동산인프라', '069500': 'KODEX 200',
  '360750': 'TIGER 미국S&P500', '005935': '삼성전자우',
};
const plus = (ymd: string, d: number) => { const t = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6)); return new Date(t + d * 864e5).toISOString().slice(0, 10).replace(/-/g, ''); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const med = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

// 시장: KODEX 200 수정주가 — 배당락일이 아닌 날의 일간 수익률은 원주가와 같다
const k = await getDailyBars('069500');
const kIdx = new Map(k.map((b, i) => [b.tradingDay, i]));

for (const sym of Object.keys(names)) {
  let divs = await getKisDividendSchedule(account, sym, '20100101', today).catch(() => []);
  if (divs.length === 0) { await sleep(1500); divs = await getKisDividendSchedule(account, sym, '20100101', today).catch(() => []); }
  const uniq = [...new Map(divs.filter((d) => d.amountPerShare > 0 && d.recordDate < today).map((d) => [d.recordDate, d])).values()];
  const ratios: number[] = []; const adjRatios: number[] = []; const d5: number[] = []; const d20: number[] = []; const yl: number[] = [];
  for (const d of uniq) {
    await sleep(1050);
    const bars = await getKisRawDailyBars(sym, plus(d.recordDate, -8), plus(d.recordDate, 40)).catch(() => []);
    const ex = bars.reduce((acc, b, i) => (b.tradingDay < d.recordDate ? i : acc), -1);
    if (ex < 1) continue;
    const prev = bars[ex - 1]!; const e = bars[ex]!;
    if (!(prev.close > 0 && e.open > 0)) continue;
    const gap = prev.close - e.open;
    ratios.push(gap / d.amountPerShare);
    yl.push(d.amountPerShare / prev.close * 100);
    // 시장 갭: 같은 밤 KODEX 200 (자기 자신이면 조정 안 함)
    const ki = kIdx.get(e.tradingDay);
    const mkt = sym !== '069500' && ki && ki > 0 ? k[ki]!.open / k[ki - 1]!.close - 1 : 0;
    adjRatios.push((gap + mkt * prev.close) / d.amountPerShare);
    // 배당락 뒤 흐름 — 원주가, 시장 대비
    for (const [n, arr] of [[5, d5], [20, d20]] as const) {
      const t = bars[ex + n];
      if (!t) continue;
      const own = t.close / e.open - 1;
      const ks = kIdx.get(e.tradingDay); const ke = kIdx.get(t.tradingDay);
      const m = sym !== '069500' && ks !== undefined && ke !== undefined ? k[ke]!.close / k[ks]!.open - 1 : 0;
      arr.push((own - m) * 100);
    }
  }
  console.log(`${names[sym]!.padEnd(22)} n=${String(ratios.length).padStart(3)} 건당배당 ${med(yl).toFixed(2)}% | 낙폭비율 중앙 ${med(ratios).toFixed(2)} 평균 ${mean(ratios).toFixed(2)} · 시장조정 중앙 ${med(adjRatios).toFixed(2)} | 배당락후 5일 ${med(d5).toFixed(2)}% 20일 ${med(d20).toFixed(2)}% (시장대비 중앙)`);
}
process.exit(0);
