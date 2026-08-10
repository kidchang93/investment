#!/bin/zsh
#
# 마감 정리 — 종가로 그날의 판단을 채점한다.
#
# `watch.sh`가 "지금 얼마인가"라면 이것은 **"오늘 판단이 맞았나"**를 묻는다.
# 시가·고가·종가를 함께 받아 세 가지를 낸다:
#   · 시가 대비 — "그날 아침에 샀으면 어떻게 됐나"
#   · 고가 대비 — 장중 고점에서 얼마나 반납했나
#   · 그룹 동일가중 — 종목 하나가 아니라 판단 단위로 채점
#
# ★ 일봉으로 받는다(`getDailyCandleHistory`). 현재가 API는 **당일 시가만** 주므로
#   지난 며칠을 거슬러 채점할 수 없다. 8/7 판단을 8/10에 이어 채점하려면 일봉이어야 한다.
#
# 쓰는 법:  zsh scripts/close.sh
#           그룹 정의는 아래 GROUPS를 고친다. 종목코드는 반드시 DB에서 확인한 것을 쓴다
#           (2026-08-10에 456040/010060, 017890/017900을 두 번 헷갈렸다).

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

date '+=== 마감 정리 %Y-%m-%d %H:%M:%S (%a) ==='

if ! curl -sf -m 3 http://localhost:4000/api/health >/dev/null 2>&1; then
  echo "✗ 백엔드(:4000)가 안 떠 있다."
  exit 1
fi

cat > backend/probe-close.ts <<'EOF'
import { getDailyCandleHistory } from './src/kis/rest.js';

const GROUPS: Array<[string, string[]]> = [
  ['오늘 급등 소부장 6종목', ['064760', '327260', '095610', '036930', '240810', '319660']],
  ['8/7 판단 대상 — 8/6 급락 6종목', ['005930', '000660', '402340', '009150', '011070', '034730']],
  ['오늘 감시 15종목', [
    '005930', '000660', '402340', '009150', '011070', '034730', '009830', '010060',
    '066970', '348370', '006400', '086520', '003670', '023530', '035420',
  ]],
];

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const pct = (a: number, b: number) => (b > 0 ? (a - b) / b * 100 : NaN);
const fmt = (v: number) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) : '?');

// 종목 하나씩 받되 지평은 짧게(2페이지 = 약 180거래일). 채점에는 최근 며칠이면 된다.
const cache = new Map<string, Awaited<ReturnType<typeof getDailyCandleHistory>>>();
const uniq = [...new Set(GROUPS.flatMap(([, s]) => s))];
for (const code of uniq) {
  try {
    cache.set(code, await getDailyCandleHistory(code, 20, 1));
  } catch (e) {
    console.log(`  ${code} 조회실패: ${(e as Error).message}`);
  }
}

for (const [title, syms] of GROUPS) {
  console.log(`\n[${title}]`);
  console.log('종목            종가        전일比    시가比    고가比');
  const acc: number[] = [];
  const accNoHanwha: number[] = [];
  for (const code of syms) {
    const r = cache.get(code);
    if (!r || r.candles.length < 2) { console.log(`${code}  조회실패`); continue; }
    const cs = r.candles;
    const today = cs[cs.length - 1];
    const prev = cs[cs.length - 2];
    const vOpen = pct(today.close, today.open);
    const vHigh = pct(today.close, today.high);
    const vPrev = pct(today.close, prev.close);
    if (Number.isFinite(vOpen)) {
      acc.push(vOpen);
      if (code !== '009830') accNoHanwha.push(vOpen);
    }
    console.log(
      `${r.name.padEnd(12)}${today.close.toLocaleString().padStart(10)}`
      + `${fmt(vPrev).padStart(10)}${fmt(vOpen).padStart(10)}${fmt(vHigh).padStart(10)}`,
    );
  }
  if (acc.length > 0) {
    const mean = acc.reduce((a, b) => a + b, 0) / acc.length;
    console.log(`  → 시가比 동일가중 ${fmt(mean)}%  (n=${acc.length})`);
    if (accNoHanwha.length > 0 && accNoHanwha.length !== acc.length) {
      const m2 = accNoHanwha.reduce((a, b) => a + b, 0) / accNoHanwha.length;
      console.log(`  → 한화솔루션 009830 제외 ${fmt(m2)}%  (n=${accNoHanwha.length})`);
    }
  }
}

// 8/7 판단 이어 채점 — 8/7 시가 대비 오늘 종가
console.log('\n[8/7 판단 채점 — 8/7 시가 → 오늘 종가]');
const grade = GROUPS[1][1];
const acc2: number[] = [];
for (const code of grade) {
  const r = cache.get(code);
  if (!r) continue;
  const cs = r.candles;
  const d0807 = cs.find((c) => day(c.time) === '2026-08-07');
  const today = cs[cs.length - 1];
  if (!d0807) { console.log(`  ${r.name} 8/7 봉 없음`); continue; }
  const v = pct(today.close, d0807.open);
  acc2.push(v);
  console.log(`  ${r.name.padEnd(12)} 8/7시가 ${d0807.open.toLocaleString().padStart(10)}`
    + ` → 오늘종가 ${today.close.toLocaleString().padStart(10)}  ${fmt(v)}%`);
}
if (acc2.length > 0) {
  const m = acc2.reduce((a, b) => a + b, 0) / acc2.length;
  console.log(`  → 동일가중 ${fmt(m)}%  (n=${acc2.length})   ※ 8/7 종가 시점 −2.77%였다. 최종 채점 8/21`);
}
EOF

(cd backend && npx tsx probe-close.ts 2>&1; rm -f probe-close.ts)
