#!/bin/zsh
#
# 시장 스캔 — **오늘 무슨 일이 일어나는지 발견하는** 도구다.
# `watch.sh`가 정해 둔 종목을 지켜보는 것이라면, 이것은 **모르는 것을 찾는** 쪽이다.
#
# 왜 필요했나 — 이틀 연속 큰 사건을 통째로 놓쳤다:
#   2026-08-07  엔켐 +18.62%(고가=종가 마감) — 감시 목록에 없었다
#   2026-08-10  티씨케이 +20.74%, SK하이닉스 54조 팹 투자발 소부장 폭등 — 역시 없었다
# 그날 퀀트가 이렇게 적었다: *"유니버스를 16종목으로 좁게 잡는 것 자체가 반복적 실수일 수
# 있다. 이건 '안 사는 판단'의 반증이 아니라 '무엇을 후보로 볼 것인가'의 반증이고,
# 지금 구조로는 못 잡는다."* 이 스크립트가 그 구멍을 메운다.
#
# ★ 왜 등락률 순위를 안 쓰나
#   `/api/market/movers`는 등락률 상위 30건인데 **상한가 잡주가 전부 차지한다.**
#   2026-08-10 실측: 30건 중 거래대금 300억 이상이 3건뿐이었고, 그날의 주인공
#   티씨케이(+19.84%)는 **순위 밖으로 밀려 안 보였다.** 등락률로는 못 찾는다.
#
# ★ 그래서 두 갈래로 본다
#   (1) **거래대금 순위** — `fid_blng_cls_code:'3'`(거래금액순). 자금이 어디로 가는지.
#       거래량순(`'0'`)을 쓰면 값싼 종목이 위로 온다 — `rest.ts` 주석에 이미 적힌 함정이다.
#   (2) **테마 맥박** — 섹터가 통째로 움직이면 개별 등락률로는 안 보여도 여기서는 보인다.
#       2026-08-10에 테마 004로 RF머트리얼즈 +20.8%·테스 +16.45%가 바로 잡혔다.
#
# ★ 이건 발견 도구이지 매수 신호가 아니다.
#   여기 뜬 종목을 사라는 뜻이 절대 아니다. "무슨 일이 일어나는지 알고 판단하라"는 것이다.
#   레포의 측정 원장은 1,026칸 중 표본 밖 생존 0건이고, 급등 추격은 그중에서도 진 축이다.
#
# 쓰는 법:  zsh scripts/scan.sh [테마코드,...]
#           예) zsh scripts/scan.sh 004,989,231
#           생략하면 아래 기본 테마. 테마는 호출 비용이 크니(2개에 약 7콜) 3~4개로 둔다.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

THEMES="${1:-004,989,231}"   # 반도체/반도체장비 · 2차전지(소재부품장비) · HBM
TOP_N="${2:-25}"

date '+=== 시장 스캔 %Y-%m-%d %H:%M:%S (%a) ==='

if ! curl -sf -m 3 http://localhost:4000/api/health >/dev/null 2>&1; then
  echo "✗ 백엔드(:4000)가 안 떠 있다."
  exit 1
fi

# ── 1. 지수 ───────────────────────────────────────────────────────────
# heredoc은 quoted(<<'EOF')로 둔다 — TS 템플릿 리터럴의 ${...}가 셸에 먹히면
# `bad substitution`으로 죽는다(2026-08-10에 실제로 밟았다). 인자는 환경변수로 넘긴다.
cat > backend/probe-scan.ts <<'EOF'
import { getDomesticIndex, getDomesticTurnoverRanking } from './src/kis/rest.js';
for (const [c, l] of [['0001','코스피'],['1001','코스닥']] as Array<[string,string]>) {
  try {
    const q = await getDomesticIndex(c);
    console.log('IDX ' + l + ' ' + q.value + ' (' + q.changeRate + '%) 상승' + q.advancing + '/하락' + q.declining);
  } catch (e) { console.log('IDX ' + l + ' 조회실패'); }
}
try {
  const syms = await getDomesticTurnoverRanking(Number(process.env.TOP_N ?? 25));
  console.log('TURNOVER ' + syms.join(' '));
} catch (e) { console.log('TURNOVER 조회실패 ' + (e as Error).message); }
EOF
OUT=$(cd backend && TOP_N="$TOP_N" npx tsx probe-scan.ts 2>&1; rm -f probe-scan.ts)
echo "$OUT" | grep '^IDX' | sed 's/^IDX //'
SYMS=$(echo "$OUT" | grep '^TURNOVER ' | sed 's/^TURNOVER //')

# ── 2. 거래대금 상위 — 자금이 어디로 가나 ─────────────────────────────
if [[ -n "$SYMS" && "$SYMS" != *조회실패* ]]; then
  IN_LIST=$(echo "$SYMS" | tr ' ' '\n' | sed "s/.*/'&'/" | paste -sd, -)
  MAP=$(docker exec kis-postgres psql -U kis -d kis -t -A -F'|' \
    -c "SELECT id, name, asset_type FROM instruments WHERE symbol IN ($IN_LIST);" 2>/dev/null)
  IDS_JSON=$(echo "$MAP" | cut -d'|' -f1 | sed 's/.*/"&"/' | paste -sd, -)

  echo
  echo "── 거래대금 상위 (ETF·우선주 제외) ──"
  curl -s -m 20 -X POST http://localhost:4000/api/instruments/quotes \
    -H 'content-type: application/json' -d "{\"ids\":[$IDS_JSON]}" \
    | MAP="$MAP" python3 -c "
import json, os, sys
rows = json.load(sys.stdin)
meta = {}
for l in os.environ['MAP'].strip().split('\n'):
    if '|' in l:
        p = l.split('|')
        meta[p[0]] = (p[1], p[2] if len(p) > 2 else '')
skipped = 0
print(f\"{'종목':<16}{'등락%':>8}{'현재가':>12}{'거래대금':>12}\")
for r in sorted(rows, key=lambda x: -(x.get('turnover') or 0)):
    cid = r.get('code','')
    name, atype = meta.get(cid, (cid, ''))
    # ETF·우선주는 자금 흐름을 가린다 — 지수 베팅이지 종목 재료가 아니다
    if atype and atype != 'stock': skipped += 1; continue
    if name.endswith('우') or 'KODEX' in name or 'TIGER' in name or 'KBSTAR' in name or 'ACE' in name:
        skipped += 1; continue
    t = r.get('turnover') or 0
    print(f\"{name:<16}{r.get('changeRate','?'):>8}{r.get('price',0):>12,}{t/1e8:>10,.0f}억\")
print(f'  (ETF·우선주 {skipped}건 걸렀다)')
" 2>&1
fi

# ── 3. 테마 맥박 — 섹터가 통째로 움직이는지 ───────────────────────────
echo
echo "── 테마 맥박 ($THEMES) ──"
curl -s -m 40 "http://localhost:4000/api/themes/pulse?codes=$THEMES" \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
if 'message' in d:
    print('  조회실패:', d['message']); sys.exit()
print(f\"  (호출 {d.get('quoteCalls','?')}/{d.get('maxQuoteCalls','?')})\")
for p in d.get('pulses', []):
    th = p.get('theme', {})
    ms = p.get('members', [])
    ups = [m for m in ms if (m.get('changeRate') or 0) > 0]
    avg = sum((m.get('changeRate') or 0) for m in ms) / len(ms) if ms else 0
    print(f\"\n  [{th.get('code')}] {th.get('name')}  구성 {th.get('instrumentCount')}종목 \"
          f\"· 표본 {len(ms)} · 상승 {len(ups)} · 표본평균 {avg:+.2f}%\")
    for m in sorted(ms, key=lambda x: -(x.get('changeRate') or 0))[:6]:
        t = (m.get('turnover') or 0) / 1e8
        print(f\"    {m.get('name','?'):<14}{m.get('changeRate'):>8}{m.get('price',0):>12,}{t:>10,.0f}억\")
" 2>&1
