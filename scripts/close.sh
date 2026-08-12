#!/bin/zsh
#
# 마감 정리 — 종가로 그날을 채점한다.
#
# `watch.sh`가 "지금 얼마인가"라면 이것은 **"오늘 판단이 맞았나"**를 묻는다.
#
# ★ 2026-08-11에 처음으로 보유가 생겼다(ETF 5종목). 그래서 이 스크립트도 바뀐다 —
#   전에는 "안 산 것이 맞았나"만 채점했는데(감시 목록 하드코딩), 이제는
#   **보유 종목을 계좌에서 직접 읽어** 매입가 대비로 잰다. 목록을 손으로 적으면
#   사고팔 때마다 스크립트를 고쳐야 하고, 그러다 실제 보유와 어긋난다.
#
# ★ 일봉으로 받는 이유: 현재가 API는 **당일 시가만** 준다. 지난 며칠을 거슬러
#   채점하려면(8/7 판단을 8/10에 이어 채점하는 식) 일봉이어야 한다.
#
# 쓰는 법:  zsh scripts/close.sh [추적할 종목코드 ...]
#           보유 종목은 자동으로 잡힌다. 인자를 주면 그것도 함께 본다
#           (예: 안 산 후보를 추적할 때).

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

EXTRA="${*:-}"

date '+=== 마감 정리 %Y-%m-%d %H:%M:%S (%a) ==='

if ! curl -sf -m 3 http://localhost:4000/api/health >/dev/null 2>&1; then
  echo "✗ 백엔드(:4000)가 안 떠 있다. zsh scripts/morning.sh"
  exit 1
fi

# ── 계좌: 보유 종목과 손익 ────────────────────────────────────────────
echo
echo "── 계좌 ──"
ACCT=$(curl -s -m 10 "http://localhost:4000/api/broker/kis/account?accountId=VTS-ORDINARY")
echo "$ACCT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
pos = d.get('positions') or []
cash = d.get('cashBalance') or 0
stock = d.get('stockEvaluation') or 0
print(f\"  총평가 {d.get('totalEvaluation',0):,}원 · 예수금 {cash:,}원 · D+2 {d.get('settlementCash',0):,}원\")
# ★ 2026-08-12 실측: 모의 서버가 전일 매수대금을 D+2 정산액에서 한 번 더 뺀다.
#   tot_evlu_amt = 주식평가 + D+2 라서 총평가가 그만큼 작게 나온다.
#   실제 자산은 예수금 + 주식평가이므로 둘을 함께 적어 어긋나면 눈에 띄게 한다.
real = cash + stock
te = d.get('totalEvaluation') or 0
if abs(real - te) > 1000:
    print(f\"  ★ 예수금+주식평가 = {real:,}원 — 총평가와 {real-te:+,}원 어긋난다\"
          f\" (모의 서버 D+2 이중차감으로 확인된 현상)\")
r = d.get('unrealizedPnlRate'); a = d.get('assetChangeRate')
print(f\"  평가손익 {d.get('unrealizedPnl',0):+,}원\"
      f\" ({'—' if r is None else f'{r:+.2f}%'} 매입대비)\"
      f\" · 자산증감 {'—' if a is None else f'{a:+.2f}%'} (전일대비)\")
print(f\"  보유 {len(pos)}종목 · 매입 {d.get('purchaseAmount',0):,}원\")
for p in sorted(pos, key=lambda x: -(x.get('unrealizedPnl') or 0)):
    avg = p.get('averagePrice') or 0
    cur = p.get('currentPrice') or 0
    rate = (cur / avg - 1) * 100 if avg else float('nan')
    print(f\"    {p.get('name','?'):<22}{p.get('quantity') or 0:>7,}주  {avg:>10,.0f} → {cur:>10,.0f}\"
          f\"  {p.get('unrealizedPnl') or 0:>+11,}원 ({rate:+.2f}%)\")
" 2>&1
HELD_CODES=$(echo "$ACCT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(' '.join(str(p.get('symbol','')) for p in (d.get('positions') or []) if p.get('symbol')))" 2>/dev/null)

# ── 지수 ──────────────────────────────────────────────────────────────
echo
echo "── 지수 ──"
cat > backend/probe-close.ts <<'EOF'
import { getDomesticIndex } from './src/kis/rest.js';
for (const [c, l] of [['0001','코스피'],['1001','코스닥']] as Array<[string,string]>) {
  for (let i = 0; i < 3; i++) {
    try {
      const q = await getDomesticIndex(c);
      console.log(`  ${l} ${q.value} (${q.changeRate}%) 상승${q.advancing}/하락${q.declining}`);
      break;
    } catch (e) {
      if (i === 2) console.log(`  ${l} 조회실패(3회)`);
      else await new Promise(r => setTimeout(r, 1500));
    }
  }
}
EOF
(cd backend && npx tsx probe-close.ts 2>&1 | grep -E '코스피|코스닥'; rm -f probe-close.ts)

# ── 종가 채점 (보유 + 인자로 받은 추적 대상) ──────────────────────────
SYMS="$HELD_CODES $EXTRA"
[[ -z "${SYMS// /}" ]] && { echo; echo "(보유 0종목 · 추적 대상 없음)"; exit 0; }

echo
echo "── 종가 (전일 대비 · 시가 대비 · 고가 대비) ──"
cat > backend/probe-close2.ts <<'EOF'
import { getDailyCandleHistory } from './src/kis/rest.js';
const codes = (process.env.SYMS ?? '').trim().split(/\s+/).filter(Boolean);
const pct = (a: number, b: number) => (b > 0 ? (a - b) / b * 100 : NaN);
const f = (v: number) => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) : '?');
console.log('종목            종가        전일比    시가比    고가比');
const acc: number[] = [];
for (const code of codes) {
  try {
    // 2페이지면 약 180거래일 — 며칠 거슬러 채점하기에 충분하고 유량도 아낀다
    const r = await getDailyCandleHistory(code, 20, 1);
    const cs = r.candles;
    if (cs.length < 2) { console.log(`${code} 봉 부족`); continue; }
    const t = cs[cs.length - 1]; const p = cs[cs.length - 2];
    const vo = pct(t.close, t.open);
    if (Number.isFinite(vo)) acc.push(vo);
    console.log(
      `${r.name.padEnd(12)}${t.close.toLocaleString().padStart(10)}`
      + `${f(pct(t.close, p.close)).padStart(10)}${f(vo).padStart(10)}`
      + `${f(pct(t.close, t.high)).padStart(10)}`,
    );
  } catch (e) {
    console.log(`${code} 조회실패: ${(e as Error).message.slice(0, 40)}`);
  }
  await new Promise((r) => setTimeout(r, 1200)); // ★ 유량 — 연타하면 빈 응답이 온다
}
if (acc.length > 1) {
  const m = acc.reduce((a, b) => a + b, 0) / acc.length;
  console.log(`  → 시가比 동일가중 ${f(m)}%  (n=${acc.length})`);
}
EOF
(cd backend && SYMS="$SYMS" npx tsx probe-close2.ts 2>&1; rm -f probe-close2.ts)

# ── 수집 진행 (돌고 있으면) ───────────────────────────────────────────
if pgrep -f collectDailyBars >/dev/null 2>&1; then
  echo
  echo "── 21년 일봉 수집 (진행 중) ──"
  docker exec kis-postgres psql -U kis -d kis -t -A -F' | ' -c "
    SELECT count(*) FILTER (WHERE done)||' 종목',
           (SELECT to_char(count(*),'FM999,999,999') FROM trading_daily_bars)||'봉',
           count(*) FILTER (WHERE last_error IS NOT NULL)||'건 오류'
    FROM trading_daily_bar_cursor;" 2>/dev/null
  tail -1 /tmp/kis-collect.log 2>/dev/null | sed 's/^/  /'
fi
