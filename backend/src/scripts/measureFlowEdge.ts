/**
 * 수급이 **가격을 예측하는가**를 잰다. (사용자 가설 ②)
 *
 * ── 무엇을 묻나 ──────────────────────────────────────────────────────────
 *
 * 오늘 외국인이 크게 순매수한 종목을 사서 N일 뒤 팔면 어땠나. 이것이 진짜 질문이다.
 *
 * ★ **지속성(①)이 없어도 이건 성립할 수 있다.** 수급이 매일 반복되지 않아도
 * 한 번의 큰 유입이 며칠간 값을 밀 수 있다. 둘은 다른 물음이다.
 *
 * ── 거울을 함께 잰다 ─────────────────────────────────────────────────────
 *
 * 순매수 **상위**를 사는 것과 **하위**를 사는 것을 나란히 잰다. 진짜 우위면 둘이
 * 반대 부호로 갈리고, 아니면 같은 값이 나온다. 오늘 `ma_cross`가 정확히 그렇게
 * 무너졌다 — 신호와 거울이 둘 다 −0.06%로 같았다.
 *
 * ── 왜 여러 축(N)을 재나 ─────────────────────────────────────────────────
 *
 * 왕복 비용 0.43%가 움직임에서 차지하는 몫이 축마다 다르다. 11분 보유면 112%라
 * 방향을 맞혀도 지고, 20일이면 10%다. **어느 축에서 싸울 수 있는지**가 이 표의 절반이다.
 *
 * ── 표본과 그 한계 ───────────────────────────────────────────────────────
 *
 * 겹치는 선도수익률을 쓰므로 관측이 독립이 아니다. N일 축의 유효 표본은
 * 대략 `종목 수 × (거래일 수 / N)`이다 — 그 값을 함께 찍는다. 작으면 작다고 적는다.
 *
 * 조회 전용이다. 주문을 내지 않는다.
 *
 *   npx tsx src/scripts/measureFlowEdge.ts
 */

import { getKisAccount, config } from '../config.js';
import { getDomesticInstrumentsBySymbols } from '../db/instruments.js';
import { getDomesticTurnoverRanking, getInvestorFlowDaily, toCredentials } from '../kis/rest.js';
import { isOrderableForAutoTrader } from '../trading/universe.js';

const prodId = process.env.KIS_OPEN_DAY_CREDENTIAL_ID;
const account = prodId ? getKisAccount(prodId) : null;
const credentials = account ? { ...toCredentials(account), crossServerRead: true } : undefined;

/** 한 번에 30일씩 오므로 기준일을 물려 가며 더 받는다. */
const END_DATES = ['20260803', '20260620', '20260508', '20260327'];
/** 잴 보유 기간(거래일). 비용이 움직임에서 차지하는 몫이 축마다 다르다 */
const HORIZONS = [1, 5, 10, 20];
/** 왕복 비용. 백테스트·후보 필터가 쓰는 값과 같다 */
const ROUND_TRIP = 0.0043;

interface Day {
  tradingDay: string;
  close: number;
  /** 그날 셋의 절대값 합으로 나눈 외국인 순매수. 종목 간 비교가 되게 한다 */
  foreignShare: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

const symbols = await getDomesticTurnoverRanking(30);
const found = await getDomesticInstrumentsBySymbols(symbols);
const targets = symbols.filter((symbol) => {
  const instrument = found.get(symbol);
  return instrument !== undefined && isOrderableForAutoTrader(instrument);
});

console.log(`자격증명 ${account?.id ?? `기본(${config.env})`} · 표본 ${targets.length}종목`);
console.log('★ 오늘 거래대금 순위로 골랐다 — 선정에 look-ahead가 있다. 이 측정의 미해소 전제다.\n');

/** 종목별 날짜 오름차순 계열 */
const seriesBySymbol = new Map<string, Day[]>();
for (const symbol of targets) {
  const byDay = new Map<string, Day>();
  for (const endDate of END_DATES) {
    const flows = await getInvestorFlowDaily(symbol, endDate, credentials);
    for (const f of flows) {
      const scale = Math.abs(f.individual) + Math.abs(f.foreign) + Math.abs(f.institution);
      // 매매가 아예 없던 날은 비중을 만들 수 없다. 0으로 채우지 않고 건너뛴다.
      if (scale <= 0 || !(f.close > 0)) continue;
      byDay.set(f.tradingDay, {
        tradingDay: f.tradingDay,
        close: f.close,
        foreignShare: f.foreign / scale,
      });
    }
  }
  const series = [...byDay.values()].sort((a, b) => a.tradingDay.localeCompare(b.tradingDay));
  if (series.length >= 40) seriesBySymbol.set(symbol, series);
}

const dayCounts = [...seriesBySymbol.values()].map((s) => s.length);
console.log(`거래일 중앙 ${median(dayCounts)}일 · ${seriesBySymbol.size}종목이 40일 이상\n`);

console.log('보유   구분           표본   평균 수익   중앙   비용 포함    유효표본');
console.log('─'.repeat(76));

/** 축별로 날짜 하나당 상위−하위 하나. 군집 표준오차를 내는 재료다 */
const dailySpreads = new Map<number, number[]>();

for (const horizon of HORIZONS) {
  /** 그날 순매수 비중 상위/하위 3분위로 갈라 선도수익률을 모은다 */
  const top: number[] = [];
  const bottom: number[] = [];
  const all: number[] = [];

  // 날짜별로 종목을 줄 세워야 "그날 상대적으로 많이 산 종목"이 된다.
  const days = new Set<string>();
  for (const series of seriesBySymbol.values()) for (const d of series) days.add(d.tradingDay);

  for (const day of [...days].sort()) {
    const snapshot: Array<{ symbol: string; share: number; forward: number }> = [];
    for (const [symbol, series] of seriesBySymbol) {
      const index = series.findIndex((d) => d.tradingDay === day);
      if (index < 0 || index + horizon >= series.length) continue;
      const entry = series[index].close;
      const exit = series[index + horizon].close;
      if (!(entry > 0) || !(exit > 0)) continue;
      snapshot.push({ symbol, share: series[index].foreignShare, forward: exit / entry - 1 });
    }
    // 줄을 세우려면 그날 종목이 충분해야 한다. 셋으로 나눌 수 없으면 건너뛴다.
    if (snapshot.length < 9) continue;
    snapshot.sort((a, b) => b.share - a.share);
    const cut = Math.floor(snapshot.length / 3);
    const dayTop: number[] = [];
    const dayBottom: number[] = [];
    for (let i = 0; i < snapshot.length; i += 1) {
      all.push(snapshot[i].forward);
      if (i < cut) {
        top.push(snapshot[i].forward);
        dayTop.push(snapshot[i].forward);
      } else if (i >= snapshot.length - cut) {
        bottom.push(snapshot[i].forward);
        dayBottom.push(snapshot[i].forward);
      }
    }
    // 그날 하루의 상위−하위. 이것 하나가 관측 하나다.
    const list = dailySpreads.get(horizon) ?? [];
    list.push((mean(dayTop) - mean(dayBottom)) * 100);
    dailySpreads.set(horizon, list);
  }

  const effective = Math.round(median(dayCounts) / horizon) * seriesBySymbol.size;
  const show = (label: string, values: number[]): void => {
    if (values.length === 0) {
      console.log(`${String(horizon).padStart(3)}일  ${label.padEnd(12)}  표본 없음`);
      return;
    }
    const m = mean(values) * 100;
    const md = median(values) * 100;
    const withCost = m - ROUND_TRIP * 100;
    console.log(
      `${String(horizon).padStart(3)}일  ${label.padEnd(12)}${String(values.length).padStart(6)}`
      + `  ${(m >= 0 ? '+' : '') + m.toFixed(3)}%`.padStart(11)
      + `  ${(md >= 0 ? '+' : '') + md.toFixed(3)}%`.padStart(9)
      + `  ${(withCost >= 0 ? '+' : '') + withCost.toFixed(3)}%`.padStart(11)
      + `  ${String(effective).padStart(8)}`,
    );
  };
  show('순매수 상위', top);
  show('순매수 하위(거울)', bottom);
  show('전체(기준선)', all);
  /*
   * **이것이 판정이다.** 상위−하위가 방향성 우위이고, 그 절반이 한쪽 베팅의 몫이다.
   * 둘이 같으면 수급은 그 축에서 아무 말도 하지 않는 것이다.
   */
  const spread = (mean(top) - mean(bottom)) * 100;
  const spreadMedian = (median(top) - median(bottom)) * 100;
  /*
   * **날짜로 묶어 유의성을 잰다.** 같은 날의 종목들은 시장이 함께 움직여 독립이
   * 아니고, 겹치는 선도수익률은 날짜끼리도 겹친다. 날짜별 상위−하위 하나씩을
   * 관측으로 세면 종목 간 상관이 사라진다 — 겹침은 여전히 남으므로 이 t도
   * **부풀려진 쪽**이다. 여기서도 못 넘기면 볼 것이 없다는 뜻이다.
   */
  const daily = dailySpreads.get(horizon) ?? [];
  const dm = mean(daily);
  const variance =
    daily.length > 1
      ? daily.reduce((acc, v) => acc + (v - dm) ** 2, 0) / (daily.length - 1)
      : 0;
  const se = daily.length > 0 && variance > 0 ? Math.sqrt(variance / daily.length) : 0;
  const t = se > 0 ? dm / se : 0;
  console.log(
    `      ▶ 상위−하위 평균 ${(spread >= 0 ? '+' : '') + spread.toFixed(3)}%`
    + ` · 중앙 ${(spreadMedian >= 0 ? '+' : '') + spreadMedian.toFixed(3)}%`
    + ` · 한쪽 우위 ${(spread / 2 >= 0 ? '+' : '') + (spread / 2).toFixed(3)}%`,
  );
  console.log(
    `        날짜 군집 t = ${t >= 0 ? '+' : ''}${t.toFixed(2)}`
    + ` (날짜 ${daily.length}개, 4축 본페로니 |t|>2.50)`
    + ` · 왕복 0.430% 대비 ${spread / 2 !== 0 ? (0.43 / Math.abs(spread / 2)).toFixed(2) : '∞'}배 필요\n`,
  );
}

process.exit(0);
