#!/bin/zsh
#
# 장중 감시 회차 측정 — 지수 + 관측 종목 + 계좌를 한 번에 찍는다.
#
# 왜 이렇게 생겼나. 2026-08-07에 세 번 데였다:
#
#  (1) 종목을 하나씩 `GET /api/quote/<code>`로 치면 KIS 모의 서버 유량(실전의 1/18)에 걸려
#      **오류가 아니라 빈 응답**이 온다. 11개 중 8개가 조용히 비었다. 재시도 3회를 넣어도
#      3개가 실패했고 회차 하나가 15분 걸렸다.
#      → 멀티시세(`POST /api/instruments/quotes`) 1회 호출로 바꿨다. 0.09초다.
#
#  (2) instrumentId의 시장 구분을 손으로 적었더니 엘앤에프(KOSPI인데 KOSDAQ으로 적음)가
#      **빈 배열로 조용히 사라졌다.** 11개 요청에 10개 응답인데 오류가 없다 —
#      `CLAUDE.md` 4-1이 경고하는 그 함정이다.
#      → 시장 구분을 짐작하지 않는다. `instruments` 테이블에서 가져온다.
#      → 그리고 요청 수와 응답 수를 대조한다. 이게 이 스크립트의 핵심 안전장치다.
#
#  (3) 이 스크립트를 세션 스크래치패드에 뒀더니 세션이 바뀌자 사라졌다(2026-08-10 아침).
#      → 그래서 레포 안에 있다.
#
# 쓰는 법:  zsh scripts/watch.sh  [종목코드 ...]
#           인자를 주면 그 종목만, 없으면 아래 기본 목록.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

DEFAULT_SYMBOLS="005930 000660 402340 009150 011070 034730 009830 010060 066970 348370 006400 086520 003670 023530 035420"
SYMBOLS="${*:-$DEFAULT_SYMBOLS}"

date '+=== %Y-%m-%d %H:%M:%S (%a) ==='

if ! curl -sf -m 3 http://localhost:4000/api/health >/dev/null 2>&1; then
  echo "✗ 백엔드(:4000)가 안 떠 있다. docker start kis-postgres → npm run dev:api"
  exit 1
fi

# ── 지수 ──────────────────────────────────────────────────────────────
# HTTP 라우트에 없다. `/api/quote/0001`은 price:0을 준다 — 쓰면 안 된다.
cat > backend/probe-index.ts <<'EOF'
import { getDomesticIndex } from './src/kis/rest.js';
for (const [c, l] of [['0001','코스피'],['1001','코스닥']] as Array<[string,string]>) {
  for (let i = 0; i < 3; i++) {
    try {
      const q = await getDomesticIndex(c);
      console.log(`${l} ${q.value} (${q.changeRate}%) 상승${q.advancing}/하락${q.declining}`);
      break;
    } catch (e) {
      if (i === 2) console.log(`${l} 조회실패(3회) ${(e as Error).message}`);
      else await new Promise(r => setTimeout(r, 1500));
    }
  }
}
EOF
(cd backend && npx tsx probe-index.ts 2>&1 | grep -E '코스피|코스닥'; rm -f probe-index.ts)

# ── 종목 ──────────────────────────────────────────────────────────────
IN_LIST=$(echo "$SYMBOLS" | tr ' ' '\n' | sed "s/.*/'&'/" | paste -sd, -)
MAP=$(docker exec kis-postgres psql -U kis -d kis -t -A -F'|' \
  -c "SELECT id, name FROM instruments WHERE symbol IN ($IN_LIST);" 2>/dev/null)

WANT=$(echo "$SYMBOLS" | wc -w | tr -d ' ')
HAVE=$(echo "$MAP" | grep -c '|')
[[ "$HAVE" != "$WANT" ]] && echo "⚠ DB에서 못 찾은 종목이 있다: 요청 $WANT · 찾음 $HAVE"

IDS_JSON=$(echo "$MAP" | cut -d'|' -f1 | sed 's/.*/"&"/' | paste -sd, -)

curl -s -m 20 -X POST http://localhost:4000/api/instruments/quotes \
  -H 'content-type: application/json' -d "{\"ids\":[$IDS_JSON]}" \
  | MAP="$MAP" WANT="$HAVE" python3 -c "
import json, os, sys
rows = json.load(sys.stdin)
names = dict(l.split('|', 1) for l in os.environ['MAP'].strip().split('\n') if '|' in l)
want = int(os.environ['WANT'])
print(f'{len(rows)}/{want}개 응답' + ('' if len(rows) == want else '  ⚠ 사라진 종목이 있다'))
print(f\"{'종목':<12}{'등락%':>9}{'현재가':>12}{'시가':>12}{'시가比%':>9}\")
got = set()
for r in sorted(rows, key=lambda x: -(x.get('changeRate') or 0)):
    cid = r.get('code', ''); got.add(cid)
    c, o = r.get('price'), r.get('open')
    vo = (c - o) / o * 100 if o else None
    print(f\"{names.get(cid, cid):<12}{r.get('changeRate','?'):>9}{c:>12,}{(o or 0):>12,}\"
          f\"{(f'{vo:+.2f}' if vo is not None else '?'):>9}\")
missing = [names[i] for i in names if i not in got]
if missing: print('⚠ 응답에 없는 종목: ' + ', '.join(missing))
" 2>&1

# ── 계좌 ──────────────────────────────────────────────────────────────
for try in 1 2 3; do
  acct=$(curl -s -m 8 "http://localhost:4000/api/broker/kis/account?accountId=VTS-ORDINARY")
  cash="$(echo "$acct" | sed -n 's/.*"cashBalance":\([0-9]*\).*/\1/p')"
  [[ -n "$cash" ]] && break
  /bin/sleep 1.5
done
if [[ -n "$cash" ]]; then
  echo "계좌 현금 $cash · $(echo "$acct" | grep -o '"positions":\[[^]]*\]' | head -c 200)"
else
  echo "계좌 조회실패(3회)"
fi
