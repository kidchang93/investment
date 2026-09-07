#!/bin/zsh
# **종가 회차의 결정을 장 마감 동시호가에 낸다.** (2026-09-07)
#
# ── 왜 판단자와 갈라져 있나 ──────────────────────────────────────────────
#
# 다른 회차는 `deliberate.sh`가 판단 직후 집행기를 부른다. 종가 회차만 다르다 —
# **장 마감 동시호가 창이 15:20~15:30**이라 그 전에 내면 정규장 주문으로 즉시
# 체결된다. 그러면 "종가에 산다"가 아니라 "15:1x에 산다"가 되고, 21년 측정이
# 말한 자리가 아니게 된다.
#
# ★ **회차 id를 찍어 부른다.** 집행기는 인자가 없으면 *최신* 회차를 집행하는데,
#   판단(15:00~)과 집행(15:21) 사이에 빠른 회차(`fair-value`, 5분 주기)가 끼어들
#   수 있다. 그러면 종가 결정 대신 그 회차를 집행하게 된다.
#
# 집행기는 멱등이라(회차 `executions` + `clientOrderId`) 여러 번 불러도 같은
# 주문이 두 번 나가지 않는다. 그래서 데몬이 몇 분마다 불러도 안전하다.
#
#   zsh scripts/close-execute.sh [계좌id]

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

ACCOUNT="${1:-VTS-ORDINARY}"
mkdir -p .cron-logs
LOG=".cron-logs/deliberate-$(date +%Y%m%d).log"
log() { echo "[$(date '+%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

if ! docker exec kis-postgres pg_isready -U kis >/dev/null 2>&1; then
  log "Postgres가 안 떠 있다 — 종가 집행을 건너뛴다"
  exit 1
fi

ROUND=$(docker exec kis-postgres psql -U kis -d kis -tAc \
  "SELECT id FROM trading_deliberations
    WHERE account_id='$ACCOUNT'
      AND trading_day = (now() AT TIME ZONE 'Asia/Seoul')::date
      AND trigger = 'close'
    ORDER BY id DESC LIMIT 1" 2>/dev/null | tr -d ' ')

if [[ -z "$ROUND" ]]; then
  # 판단자가 아직 안 끝났거나 오늘 종가 회차가 없다. 둘 다 낼 것이 없는 것이다.
  log "오늘 종가 회차가 없다 — 낼 것이 없다"
  exit 0
fi

log "종가 집행 시작 · 회차 $ROUND"
(cd backend && npx tsx src/scripts/executeDeliberation.ts "$ACCOUNT" --round "$ROUND" --execute) >> "$LOG" 2>&1
code=$?
if [[ $code -eq 0 ]]; then
  log "종가 집행 끝 · 회차 $ROUND"
else
  log "★ 종가 집행이 실패했다 (exit $code) — 다음 회차가 다시 본다"
fi
exit 0
