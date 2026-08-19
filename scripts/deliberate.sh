#!/bin/zsh
# 판단자를 **자동으로 소집한다.** 데몬이 부르고, 사람은 아무것도 안 한다.
#
# ── 왜 생겼나 (2026-08-19) ───────────────────────────────────────────────
#
# 2026-08-05에 판단자를 알고리즘(러너)에서 에이전트로 바꿨다. 그런데 **그
# 에이전트를 부르는 장치를 안 만들었다.** 사람이 `/trading-loop`을 손으로
# 불러야만 돌았고, 안 부르니 **8/06 이후 13일간 한 번도 안 돌았다.**
# 그동안 측정만 쌓였다. 사용자가 정확히 그것을 지적했다 —
# *"맨날 분석하다가 끝나고 사지도 못하고 팔지도 못한다."*
#
# 이 스크립트가 그 빠진 고리다. 데몬이 정해진 시각에 이걸 부르면
# 판단이 **매일** 남는다.
#
# ── 무엇을 하나 ──────────────────────────────────────────────────────────
#
#   claude CLI를 headless(-p)로 띄워 `prompts/deliberate.md`를 준다.
#   에이전트가 상태를 모으고, 후보를 훑고, 판단해 `trading_deliberations`에
#   한 회차를 남긴다.
#
# ★ **주문은 내지 않는다.** 프롬프트가 그렇게 못 박고, 여기서도 `--execute`가
#   붙은 명령을 막는다. 집행은 별도 경로다 — 판단과 집행을 갈라 둬야
#   "왜 샀나"를 나중에 되짚을 수 있다.
#
# ── 쓰는 법 ──────────────────────────────────────────────────────────────
#
#   zsh scripts/deliberate.sh [계좌id]      # 기본 VTS-ORDINARY
#
# 로그는 .cron-logs/deliberate-YYYYMMDD.log 에 쌓인다.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

ACCOUNT="${1:-VTS-ORDINARY}"
LOG_DIR=".cron-logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/deliberate-$(date '+%Y%m%d').log"

log() { print -r -- "[$(date '+%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

if ! command -v claude >/dev/null 2>&1; then
  log "claude CLI가 없다 — 판단자를 부를 수 없다"
  exit 1
fi

# Postgres가 없으면 상태도 못 모으고 기록도 못 남긴다. 미리 막는다.
if ! docker exec kis-postgres pg_isready -U kis >/dev/null 2>&1; then
  log "Postgres가 안 떠 있다 — docker start kis-postgres 후 다시"
  exit 1
fi

log "판단자 소집 · 계좌 $ACCOUNT"

# ★ 허용 도구를 좁힌다. 판단에 필요한 것만 준다 —
#   Bash(상태 수집·기록)·Read·Grep·Glob·WebSearch·WebFetch.
#   Write/Edit는 주지 않는다. 판단자가 코드를 고칠 일이 없다.
claude -p "$(cat prompts/deliberate.md)

계좌 id는 **$ACCOUNT** 입니다. 지금 시각은 $(date '+%Y-%m-%d %H:%M') KST 입니다." \
  --allowedTools "Bash,Read,Grep,Glob,WebSearch,WebFetch" \
  --permission-mode acceptEdits \
  >> "$LOG" 2>&1
code=$?

if [[ $code -eq 0 ]]; then
  log "판단자 회차 끝"
else
  log "판단자가 실패했다 (exit $code) — 로그를 본다: $LOG"
fi
exit $code
