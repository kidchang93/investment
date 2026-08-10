#!/bin/zsh
#
# 아침 환경 세우기 — 개장 전에 사람이 부르면 판단에 필요한 것을 전부 띄운다.
#
# 왜 필요했나: 2026-08-06 · 08-07 · 08-10 **사흘 연속** 아침에 Docker·Postgres·백엔드가
# 죽어 있었다. 맥이 꺼졌다 켜지면 컨테이너가 안 돌아온다. 그걸 매번 손으로 확인하다가
# 8/7엔 08:47에야 발견해 개장 13분 전에 시작했다.
#
# ★ 이건 무인 스케줄러가 아니다. launchd로 걸어 봤지만 TCC가 막았고(레포가 ~/Desktop에
#   있어 launchd 프로세스가 읽지 못한다), 무엇보다 **맥이 꺼져 있으면 어차피 안 돈다.**
#   2026-08-09에 사용자와 정한 것: 무인화는 이르다. 하루 한 번 사람이 부르면 된다.
#   무인이 실제로 필요해지는 시점 — ①보유가 생겨 장중에 지켜볼 게 있을 때
#   ②스톱지정가(`ORD_DVSN=22`) 경로가 열렸을 때 ③아침에 못 깨우는 날이 잦아질 때.
#
# 쓰는 법:  zsh scripts/morning.sh

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

log() { print -r -- "[$(date '+%H:%M:%S')] $*"; }

log "=== 아침 환경 세우기 ==="

# ── Docker ────────────────────────────────────────────────────────────
if ! docker info >/dev/null 2>&1; then
  log "Docker 데몬이 없다. 띄운다 (30~60초 걸린다)"
  open -a Docker
  for i in $(seq 1 90); do
    docker info >/dev/null 2>&1 && { log "Docker 준비됨 (${i}s)"; break; }
    sleep 1
  done
fi
docker info >/dev/null 2>&1 || { log "✗ Docker를 못 띄웠다. 손으로 확인해야 한다"; exit 1; }

# ── Postgres ──────────────────────────────────────────────────────────
if ! docker exec kis-postgres pg_isready -U kis >/dev/null 2>&1; then
  log "kis-postgres가 안 떠 있다. 시작한다"
  docker start kis-postgres >/dev/null 2>&1
  for i in $(seq 1 30); do
    docker exec kis-postgres pg_isready -U kis >/dev/null 2>&1 && { log "Postgres 준비됨 (${i}s)"; break; }
    sleep 1
  done
fi
docker exec kis-postgres pg_isready -U kis >/dev/null 2>&1 \
  || { log "✗ Postgres가 안 뜬다. 백엔드도 못 뜬다 (ECONNREFUSED 127.0.0.1:55432)"; exit 1; }

# ── 백엔드 ────────────────────────────────────────────────────────────
# 이미 떠 있으면 건드리지 않는다 — 사람이 게이트를 열고 띄웠을 수 있다.
if curl -sf -m 3 http://localhost:4000/api/health >/dev/null 2>&1; then
  log "백엔드가 이미 떠 있다 — 그대로 쓴다"
else
  log "백엔드를 띄운다"
  # nohup + disown: 부모 셸이 끝나도 살아남는다. 이걸 안 하면 세션이 정리될 때 함께 죽는다
  # (2026-08-10에 실제로 겪었다 — 장중에 백엔드가 조용히 내려갔다).
  nohup npm run dev:api > /tmp/kis-api.log 2>&1 &
  disown
  for i in $(seq 1 60); do
    curl -sf -m 2 http://localhost:4000/api/health >/dev/null 2>&1 && { log "백엔드 준비됨 (${i}s)"; break; }
    sleep 1
  done
fi
curl -sf -m 3 http://localhost:4000/api/health >/dev/null 2>&1 \
  || { log "✗ 백엔드가 안 뜬다. 로그: /tmp/kis-api.log"; exit 1; }

# ── 상태 요약 ─────────────────────────────────────────────────────────
echo
log "── 계좌 ──"
curl -s -m 8 "http://localhost:4000/api/broker/kis/account?accountId=VTS-ORDINARY" \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
pos = d.get('positions') or []
print(f\"  현금 {d.get('cashBalance',0):,}원 · 평가 {d.get('totalEvaluation',0):,}원 · 보유 {len(pos)}종목\")
for p in pos:
    print(f\"    {p.get('name','?')} {p.get('quantity','?')}주 평가손익 {p.get('unrealizedPnl',0):,}원\")
" 2>&1

log "── 실주문 게이트 ──"
curl -s -m 8 "http://localhost:4000/api/broker/kis/live-order-gate" \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
b = d.get('blockers') or []
print(f\"  enabled={d.get('enabled')} · isProdEnv={d.get('isProdEnv')} · 차단사유 {b if b else '없음'}\")
" 2>&1

log "── 자동매매 ──"
curl -s -m 8 "http://localhost:4000/api/broker/kis/auto-trader?accountId=VTS-ORDINARY" \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(f\"  status={d.get('status','?')}  (영구 정지가 현재 설계다 — 판단자는 에이전트 회의)\")
" 2>&1

echo
log "환경 준비 끝. 다음: zsh scripts/scan.sh 로 시장을 훑고, 조사·측정·판단 에이전트를 소집한다"
