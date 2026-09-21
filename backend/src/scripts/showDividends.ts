/**
 * 보유 종목을 **배당까지 넣어** 다시 본다.
 *
 * 사용자가 정했다 (2026-09-21) — *"etf에서는 배당주들도 있으니 배당까지 계산을 해서
 * 어떤 종목들을 사고 파는게 좋을지 산정해줘야돼 무작정 사놓고 기다리기만하면 안될 것 같아."*
 *
 * 가격만 보면 ETF 층은 "−6.99%짜리 하나와 나머지"로 보이는데, 배당을 넣으면 순서가
 * 달라진다. 이 표는 그 순서를 보여 준다. **판단은 하지 않는다** — 분석가·판단자가 본다.
 *
 * ★ 빈칸(`—`)은 0이 아니라 **모름**이다. 예탁원 배당일정이 일부 ETF를 빠뜨린다
 *   (`329200` TIGER 리츠부동산인프라가 2년 반 0건). 0으로 적으면 배당주를
 *   무배당으로 평가하게 된다 — `trading/dividend.ts` 참고.
 *
 * 쓰는 법:  cd backend && npx tsx src/scripts/showDividends.ts [계좌id]
 */
import { getKisAccount } from '../config.js';
import { getKisDividendSchedule, getKisDomesticAccountSnapshot } from '../kis/rest.js';
import { kstDaysAgo, kstToday } from '../kis/normalize.js';
import { getLayerPositions } from '../db/layers.js';
import { dividendYield, trailingDividendPerShare } from '../trading/dividend.js';

const accountId = process.argv[2] ?? 'VTS-ORDINARY';
const account = getKisAccount(accountId);
if (!account) {
  console.error(`등록된 계좌가 아닙니다: ${accountId}`);
  process.exit(1);
}

const today = kstToday();
const snapshot = await getKisDomesticAccountSnapshot(account);
const layers = new Map((await getLayerPositions(accountId)).map((p) => [p.symbol, p.layer]));

type Row = {
  symbol: string; name: string; layer: string; quantity: number; price: number;
  value: number; pnlRate: number | undefined;
  perShare: number | undefined; yieldPct: number | undefined; annual: number | undefined;
};

const rows: Row[] = [];
for (const position of snapshot.positions) {
  /*
   * 2년을 받아 1년 창을 센다. 1년만 받으면 창 경계의 건이 통째로 빠져
   * 연 배당이 한 번 적게 잡힌다.
   */
  const records = await getKisDividendSchedule(account, position.symbol, kstDaysAgo(730), today)
    .catch(() => []);
  const perShare = trailingDividendPerShare(records, today);
  const price = position.currentPrice ?? 0;
  const quantity = position.quantity ?? 0;
  rows.push({
    symbol: position.symbol,
    name: position.name ?? position.symbol,
    layer: layers.get(position.symbol) ?? '—',
    quantity,
    price,
    value: price * quantity,
    pnlRate: position.unrealizedPnlRate,
    perShare,
    yieldPct: dividendYield(perShare, price),
    annual: perShare === undefined ? undefined : perShare * quantity,
  });
}

const won = (n: number | undefined): string => (n === undefined ? '—' : `${Math.round(n).toLocaleString('ko-KR')}원`);
const pct = (n: number | undefined): string => (n === undefined ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`);

rows.sort((a, b) => (b.yieldPct ?? -1) - (a.yieldPct ?? -1));

console.log(`\n배당까지 넣어 본 보유 · ${accountId} · ${today}\n`);
console.log('종목                     층      평가액        평가손익률   배당수익률   연 배당(내 몫)');
console.log('─'.repeat(92));
for (const r of rows) {
  console.log(
    `${(r.name || r.symbol).slice(0, 20).padEnd(22)} ${r.layer.padEnd(6)} `
    + `${won(r.value).padStart(13)} ${pct(r.pnlRate).padStart(11)} `
    + `${pct(r.yieldPct).padStart(11)} ${won(r.annual).padStart(14)}`,
  );
}

/*
 * ★ 합계는 **아는 것만** 더한다. 모르는 종목을 0으로 넣으면 층 배당수익률이
 *   실제보다 낮게 나와 "배당이 별것 없다"는 잘못된 결론으로 간다.
 */
for (const layer of ['etf', 'short']) {
  const inLayer = rows.filter((r) => r.layer === layer);
  if (inLayer.length === 0) continue;
  const known = inLayer.filter((r) => r.annual !== undefined);
  const knownValue = known.reduce((s, r) => s + r.value, 0);
  const annual = known.reduce((s, r) => s + (r.annual ?? 0), 0);
  const unknown = inLayer.filter((r) => r.annual === undefined);
  console.log(
    `\n${layer} 층 · 평가 ${won(inLayer.reduce((s, r) => s + r.value, 0))} · `
    + `배당을 아는 ${known.length}종목(${won(knownValue)})에서 연 ${won(annual)} `
    + `= ${pct(dividendYield(annual, knownValue))}`,
  );
  if (unknown.length > 0) {
    console.log(`  ★ 모르는 ${unknown.length}종목은 뺐다: ${unknown.map((r) => `${r.name}(${won(r.value)})`).join(' · ')}`);
  }
}
process.exit(0);
