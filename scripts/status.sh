#!/bin/zsh
# 지금 시스템이 어떻게 돌고 있나. **한 화면에 다 보이게 한다.**
#
# ── 왜 필요한가 (2026-08-14) ─────────────────────────────────────────────
#
# 하루에 세 번 "지금 뭐가 살아 있지?"를 손으로 확인했다. 그날 알게 된 것:
#
#   - 아침에 Docker·Postgres·백엔드가 **전부 죽어 있었다** (8/6·8/7·8/10도 그랬다)
#   - launchd 자동화가 **8일째 조용히 실패**하고 있었다
#   - PID 파일이 살아 있는 데몬을 "멈췄다"고 말했다
#
# 셋 다 **물어보지 않으면 모르는 것**이었다. 그래서 한 명령으로 묶는다.
#
# ★ **읽기만 한다.** 아무것도 고치지 않고 주문도 내지 않는다.
#   환경을 세우는 것은 `morning.sh`, 자동 실행은 `daemon.sh`다.
#
# 쓰는 법:  zsh scripts/status.sh

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

ok()   { print -r -- "  ● $1" }
bad()  { print -r -- "  ○ $1" }
head_() { print -r -- ""; print -r -- "── $1 ─────────────────────────────────────────" }

print -r -- "════ 시스템 상태 · $(date '+%Y-%m-%d %H:%M:%S %a') ════"

# ── 프로세스 ──────────────────────────────────────────────────────────
head_ "돌고 있는 것"
if pgrep -f "daemon.sh __loop" >/dev/null 2>&1; then
  ok "데몬       pid $(pgrep -f 'daemon.sh __loop' | head -1)  (평일 08:12 / 장중 20분 / 15:40)"
else
  bad "데몬       멈춤 — zsh scripts/daemon.sh start"
fi
if pgrep -f "tsx watch src/server.ts" >/dev/null 2>&1; then
  ok "백엔드     pid $(pgrep -f 'tsx watch src/server.ts' | head -1)  :4000"
else
  bad "백엔드     죽음 — npm run dev:api"
fi
if docker info >/dev/null 2>&1; then
  ok "Docker     살아 있음"
  status_line=$(docker ps --filter name=kis-postgres --format '{{.Status}}' 2>/dev/null | head -1)
  if [[ -n "$status_line" ]]; then ok "Postgres   $status_line"; else bad "Postgres   안 떠 있음 — docker start kis-postgres"; fi
else
  bad "Docker     죽음 — open -a Docker"
  bad "Postgres   확인 불가"
fi

# ── 안전 상태 ─────────────────────────────────────────────────────────
head_ "주문이 어디로 나가나"
app_env=$(grep -E '^APP_ENV=' .env 2>/dev/null | cut -d= -f2)
gate=$(grep -E '^KIS_LIVE_ORDER_ENABLED=' .env 2>/dev/null | cut -d= -f2)
print -r -- "  APP_ENV=${app_env:-?}  ·  게이트 ${gate:-?}"
if [[ "$app_env" == "prod" ]]; then
  print -r -- "  ★★ 실전 서버다. 주문이 **실계좌로 나간다.**"
else
  print -r -- "  모의 서버 — 주문이 실계좌로 나가지 않는다."
fi
# 앱키가 어느 서버용인지 사람이 적어 뒀나(CLAUDE.md 7-1). 없으면 추정으로 동작한다.
if grep -qE '^KIS_[A-Z0-9-]+_SERVER=' .env 2>/dev/null; then
  print -r -- "  앱키-서버 짝이 .env에 명시돼 있다 (추정이 아니다)"
else
  print -r -- "  ★ KIS_<id>_SERVER가 없다 — 앱키 서버를 APP_ENV로 **추정**한다"
fi

# ── 계좌와 3층 ────────────────────────────────────────────────────────
head_ "계좌와 3층"
if docker exec kis-postgres psql -U kis -d kis -tAc 'select 1' >/dev/null 2>&1; then
  (cd backend && npx tsx src/scripts/layerReport.ts 2>&1) | sed 's/^/  /'
else
  print -r -- "  Postgres가 없어 못 읽는다"
fi

# ── 자동 실행 기록 ────────────────────────────────────────────────────
head_ "오늘 자동으로 한 일 (하트비트)"
if docker exec kis-postgres psql -U kis -d kis -tAc 'select 1' >/dev/null 2>&1; then
  rows=$(docker exec kis-postgres psql -U kis -d kis -c \
    "SELECT name AS 이름, to_char(ran_at AT TIME ZONE 'Asia/Seoul','HH24:MI:SS') AS 시각, note AS 비고
       FROM trading_heartbeats
      WHERE (ran_at AT TIME ZONE 'Asia/Seoul')::date = (now() AT TIME ZONE 'Asia/Seoul')::date
      ORDER BY id DESC LIMIT 8;" 2>/dev/null)
  if print -r -- "$rows" | grep -q '0 rows'; then
    print -r -- "  오늘 아무것도 안 돌았다."
    # ★ 평일 개장 후인데 비어 있으면 그건 사실이 아니라 사고다.
    dow=$(date '+%u'); hhmm=$(date '+%H%M')
    if [[ "$dow" -le 5 && "$hhmm" > "0830" ]]; then
      print -r -- "  ★ 평일 $(date '+%H:%M')인데 기록이 없다 — 데몬이 멈춰 있었을 수 있다."
    fi
  else
    print -r -- "$rows" | sed 's/^/  /'
  fi
else
  print -r -- "  Postgres가 없어 못 읽는다"
fi

# ── 다음에 무엇이 언제 ────────────────────────────────────────────────
head_ "다음 자동 실행"
dow=$(date '+%u'); hhmm=$(date '+%H%M')
if [[ "$dow" -gt 5 ]]; then
  print -r -- "  주말이다. 다음 평일 08:12에 개장 전 브리핑."
elif [[ "$hhmm" < "0812" ]]; then
  print -r -- "  오늘 08:12  개장 전 브리핑"
elif [[ "$hhmm" < "1520" ]]; then
  print -r -- "  장중 — 20분마다 감시, 15:40에 마감 정리"
elif [[ "$hhmm" < "1540" ]]; then
  print -r -- "  오늘 15:40  마감 정리"
else
  print -r -- "  오늘 일정은 끝. 다음 평일 08:12."
fi
print -r -- ""
print -r -- "  ★ 데몬은 **주문을 내지 않는다.** 상태를 준비하고 기록만 한다."
