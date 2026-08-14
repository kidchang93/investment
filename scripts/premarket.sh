#!/bin/zsh
# 개장 전 자동 브리핑. **launchd가 부른다** (평일 08:12).
#
# ── 왜 이 파일이 레포 안에 있나 (2026-08-14) ──────────────────────────────
#
# 2026-08-07에 같은 일을 하는 `premarket-brief.sh`를 만들어 launchd에 걸었는데,
# **레포 밖(세션 스크래치패드)에 두어 세션이 끝나며 사라졌다.** 등록은 남아서
# 8/7부터 매 개장일 08:12에 조용히 실패했다:
#
#     /bin/zsh: can't open input file: .../scripts/premarket-brief.sh
#
# 이미 겪고 메모까지 해둔 함정이었다(watch.sh가 같은 이유로 한 번 사라졌다).
# **자동화가 부르는 것은 반드시 커밋된 자리에 있어야 한다.**
#
# ── 하는 일 ───────────────────────────────────────────────────────────────
#
#   1. 환경(Docker·Postgres·백엔드) 세우기 + 계좌         → morning.sh
#   2. 3층 성과와 장부·잔고 대조                          → layerReport.ts
#   3. 실행 기록(하트비트) 남기기                         → trading_heartbeats
#
# ★ **판단도 주문도 하지 않는다.** 사람이 볼 것을 준비만 한다.
#   에이전트 판단은 이 위에 따로 얹는다(`--agent`).
#
# 쓰는 법:  zsh scripts/premarket.sh [--agent]
#   --agent 를 주면 claude를 헤드리스로 불러 브리핑까지 만든다(토큰을 쓴다).

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

LOG_DIR=".cron-logs"
mkdir -p "$LOG_DIR"
STAMP="$(date '+%Y-%m-%d %H:%M:%S')"
OUT="$LOG_DIR/premarket-$(date '+%Y%m%d').log"

log() { print -r -- "[$(date '+%H:%M:%S')] $*" | tee -a "$OUT"; }

# 하트비트. **돌았다는 사실을 남긴다** — 안 돌면 아침에 사람이 알아야 한다.
# ★ zsh에서 `status`는 예약 변수다(마지막 종료 코드). 지역 변수로 쓰면
#   `read-only variable`로 죽는다 — 2026-08-14에 여기서 한 번 걸렸다.
heartbeat() {
  local hb_status="$1" hb_note="$2"
  docker exec kis-postgres psql -U kis -d kis -q -c "
    CREATE TABLE IF NOT EXISTS trading_heartbeats (
      id     BIGSERIAL PRIMARY KEY,
      name   TEXT        NOT NULL,
      status TEXT        NOT NULL,
      note   TEXT        NOT NULL DEFAULT '',
      ran_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO trading_heartbeats (name, status, note)
    VALUES ('premarket', '$hb_status', \$\$$hb_note\$\$);" >/dev/null 2>&1 \
    || log "⚠ 하트비트를 남기지 못했다 (Postgres가 아직 안 떴을 수 있다)"
}

log "=== 개장 전 브리핑 $STAMP ==="

# ── 1. 환경 ───────────────────────────────────────────────────────────
if zsh scripts/morning.sh 2>&1 | tee -a "$OUT"; then
  log "환경 준비 완료"
else
  log "★ 환경 준비 실패 — 아래 로그를 보라"
  heartbeat 'failed' '환경 준비 실패'
  exit 1
fi

# ── 2. 3층 성과 ───────────────────────────────────────────────────────
log "── 3층 성과 ──"
if (cd backend && npx tsx src/scripts/layerReport.ts 2>&1) | tee -a "$OUT"; then
  :
else
  # 장부와 잔고가 어긋나면 exit 1이 온다. **그것이 이 검사의 목적이라 실패가 아니다.**
  log "★ 층별 보고가 경고를 냈다 (장부·잔고 불일치일 수 있다). 위를 확인하라"
fi

# ── 3. 에이전트 브리핑 (선택) ─────────────────────────────────────────
if [[ "${1:-}" == "--agent" ]]; then
  log "── 에이전트 브리핑 ──"
  if command -v claude >/dev/null 2>&1; then
    # ★ 읽기만 시킨다. 주문 도구를 주지 않는다 — 사람이 없는 시각이다.
    claude -p "오늘 개장 전 브리핑을 3~5줄로 써라. \
$OUT 파일의 계좌·3층 성과를 읽고, 보유 종목에 밤사이 큰 일이 있었는지 웹에서 확인하라. \
판단이나 주문 제안은 하지 마라 — 사실만 적는다." 2>&1 | tee -a "$OUT"
  else
    log "claude CLI가 없어 건너뛴다"
  fi
fi

log "=== 끝 ==="
heartbeat 'ok' "$(date '+%H:%M') 정상"
