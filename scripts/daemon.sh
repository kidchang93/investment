#!/bin/zsh
# 상주 스케줄러. **터미널에서 띄우면 레포를 옮기지 않아도 된다.**
#
# ── 왜 launchd가 아닌가 (2026-08-14 실측) ────────────────────────────────
#
# launchd로 걸면 macOS TCC가 막는다. 임시 plist로 확인했다:
#
#     ls: /Users/kidchang/Desktop/ck/privacy/investment/scripts/: Operation not permitted
#
# `~/Desktop`은 보호 디렉터리라 launchd 프로세스가 아예 못 읽는다. 레포를 밖으로
# 옮기면 풀리지만, 옮기지 않기로 했다.
#
# ★ **터미널에서 띄운 프로세스는 막히지 않는다.** 같은 날 확인했다 —
# `nohup zsh -c 'ls scripts/'`가 정상으로 읽고 Docker에도 붙었다. 터미널이
# 이미 받아 둔 권한을 자식 프로세스가 물려받기 때문이다. 그래서 이 데몬은
# **사람이 터미널에서 한 번 띄우고**, 그 뒤로는 터미널을 닫아도 계속 돈다.
#
# ── 한계 ─────────────────────────────────────────────────────────────────
#
# **재부팅하면 멈춘다.** 로그인 후 터미널에서 다시 띄워야 한다(아래 자동 시작
# 참고). 그 대신 하트비트를 남기므로 **안 돌고 있으면 아침에 알 수 있다** —
# 8/7부터 8일간 자동화가 조용히 죽어 있던 것이 이 장치가 없어서였다.
#
# ── 쓰는 법 ──────────────────────────────────────────────────────────────
#
#   zsh scripts/daemon.sh start     # 띄운다 (터미널을 닫아도 산다)
#   zsh scripts/daemon.sh status    # 돌고 있나 · 오늘 무엇을 했나
#   zsh scripts/daemon.sh stop      # 멈춘다
#
# 터미널을 열 때 자동으로 띄우려면 ~/.zshrc에 한 줄:
#   (cd ~/Desktop/ck/privacy/investment && zsh scripts/daemon.sh start >/dev/null 2>&1)
#
# ★ **주문을 내지 않는다.** 상태를 준비하고 기록만 한다. 매매 자동화는
#   그 위에 따로 얹는다 — 무엇을 자동으로 살지는 사람이 정한 뒤다.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

LOG_DIR=".cron-logs"
mkdir -p "$LOG_DIR"

# ★ **PID 파일을 쓰지 않는다.** 2026-08-14에 파일이 프로세스와 어긋나 살아 있는
#   데몬을 "멈췄다"고 말했다(먼저 죽은 데몬의 trap이 남의 파일을 지웠고, trap을
#   고친 뒤에도 어긋났다). 프로세스를 직접 찾는 쪽이 거짓말을 안 한다.
daemon_pid() { pgrep -f "daemon.sh __loop" | head -1; }

log() { print -r -- "[$(date '+%m-%d %H:%M:%S')] $*" >> "$LOG_DIR/daemon-$(date '+%Y%m%d').log"; }

# 오늘 이 일을 이미 했나. **하트비트가 유일한 근거다** — 데몬이 재시작돼도 안 겹친다.
did_today() {
  local name="$1"
  local n
  n=$(docker exec kis-postgres psql -U kis -d kis -tAc \
    "SELECT count(*) FROM trading_heartbeats
      WHERE name='$name' AND status='ok'
        AND (ran_at AT TIME ZONE 'Asia/Seoul')::date = (now() AT TIME ZONE 'Asia/Seoul')::date" 2>/dev/null) || return 1
  [[ "${n:-0}" -gt 0 ]]
}

mark() {
  local name="$1" note="$2"
  docker exec kis-postgres psql -U kis -d kis -q -c "
    CREATE TABLE IF NOT EXISTS trading_heartbeats (
      id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '', ran_at TIMESTAMPTZ NOT NULL DEFAULT now());
    INSERT INTO trading_heartbeats (name, status, note) VALUES ('$name','ok',\$\$$note\$\$);" \
    >/dev/null 2>&1
}

run_loop() {
  log "데몬 시작 (pid $$)"
  mark 'daemon-start' "pid $$"
  while true; do
    local dow hhmm
    dow=$(date '+%u')      # 1=월 … 7=일
    hhmm=$(date '+%H%M')

    if [[ "$dow" -le 5 ]]; then
      # ── 08:12 개장 전 ──────────────────────────────────────────────
      if [[ "$hhmm" == "0812" || ("$hhmm" > "0812" && "$hhmm" < "0850") ]] && ! did_today premarket; then
        log "개장 전 브리핑 시작"
        zsh scripts/premarket.sh >> "$LOG_DIR/daemon-$(date '+%Y%m%d').log" 2>&1
        log "개장 전 브리핑 끝"
      fi

      # ── 장중 20분마다 감시 (09:10~15:20) ──────────────────────────
      if [[ "$hhmm" > "0909" && "$hhmm" < "1521" ]]; then
        local slot="watch-$(date '+%H')$(( $(date '+%M') / 20 ))"
        if ! did_today "$slot"; then
          zsh scripts/watch.sh >> "$LOG_DIR/daemon-$(date '+%Y%m%d').log" 2>&1
          # ★ 경보는 **감지만 하고 아무도 안 보면 없는 것과 같다.** --notify로
          #   알림 센터에 띄운다(터미널에서 뜬 프로세스라 권한이 있다).
          #   경보가 없으면 조용하다 — 늘 뜨는 알림은 안 읽힌다.
          (cd backend && npx tsx src/scripts/checkAlerts.ts --notify) \
            >> "$LOG_DIR/daemon-$(date '+%Y%m%d').log" 2>&1
          mark "$slot" "$(date '+%H:%M')"
        fi
      fi

      # ── 15:40 마감 정리 ───────────────────────────────────────────
      if [[ "$hhmm" > "1539" && "$hhmm" < "1620" ]] && ! did_today close; then
        log "마감 정리 시작"
        zsh scripts/close.sh >> "$LOG_DIR/daemon-$(date '+%Y%m%d').log" 2>&1
        # ★ 체결을 층 장부에 넣는다. **접수가 아니라 체결만** 들어간다.
        #   손으로 치는 것을 잊으면 장부가 어긋나고 층별 성과가 통째로 거짓이 된다
        #   (2026-08-18에 실제로 그랬다 — 4건을 접수했는데 층 표는 그대로였다).
        (cd backend && npx tsx src/scripts/layerSync.ts --apply) \
          >> "$LOG_DIR/daemon-$(date '+%Y%m%d').log" 2>&1
        (cd backend && npx tsx src/scripts/layerReport.ts) \
          >> "$LOG_DIR/daemon-$(date '+%Y%m%d').log" 2>&1
        mark close "$(date '+%H:%M')"
        log "마감 정리 끝"
      fi

      # ── 15:45 일봉 수집 (백그라운드 · 3시간) ──────────────────────
      #
      # ★ **장중에는 절대 돌리지 않는다.** 2026-08-18에 13:50에 돌렸더니 5분
      #   만에 화면과 경보 확인이 502를 받았다 — 수집이 1.2초마다 KIS를 두드려
      #   잔고 조회와 유량을 다툰다. 스크립트에 가드가 있어 08:30~15:40에는
      #   스스로 거부하지만, 여기서도 그 시간을 피해 부른다.
      #
      # ★ 데몬 루프를 막지 않으려고 백그라운드로 띄운다. 세 시간이 걸리는데
      #   그동안 감시가 멈추면 안 된다.
      #
      # 시작과 완료를 따로 적는다 — 시작만 하고 죽은 것을 "했다"고 읽으면
      # 며칠째 낡은 일봉으로 재고 있어도 모른다.
      if [[ "$hhmm" > "1544" && "$hhmm" < "1700" ]] && ! did_today daily-bars-start; then
        log "일봉 수집 시작 (백그라운드 · 3시간 예상)"
        mark daily-bars-start "$(date '+%H:%M')"
        (
          cd backend && npx tsx src/scripts/collectDailyBars.ts --refresh \
            >> "../$LOG_DIR/bars-$(date '+%Y%m%d').log" 2>&1
          bars_code=$?
          cd ..
          if [[ $bars_code -eq 0 ]]; then
            mark daily-bars "완료"
            log "일봉 수집 끝"
          else
            log "일봉 수집 실패 (exit $bars_code) — .cron-logs/bars-*.log 를 본다"
          fi
        ) &
      fi
    fi

    sleep 60
  done
}

case "${1:-status}" in
  start)
    if [[ -n "$(daemon_pid)" ]]; then
      print -r -- "이미 돌고 있다 (pid $(daemon_pid))"
      exit 0
    fi
    # nohup + disown이 없으면 터미널을 닫을 때 함께 죽는다 — 2026-08-10에 겪었다.
    nohup zsh "$0" __loop > /dev/null 2>&1 &
    disown
    print -r -- "데몬을 띄웠다. 상태: zsh scripts/daemon.sh status"
    ;;
  __loop)
    run_loop
    ;;
  stop)
    local_pid="$(daemon_pid)"
    if [[ -n "$local_pid" ]]; then
      pkill -f "daemon.sh __loop" && print -r -- "멈췄다 (pid $local_pid)"
      log "데몬 종료 요청"
    else
      print -r -- "돌고 있지 않다"
    fi
    ;;
  status)
    if [[ -n "$(daemon_pid)" ]]; then
      print -r -- "● 돌고 있다 (pid $(daemon_pid))"
    else
      print -r -- "○ 멈춰 있다 — zsh scripts/daemon.sh start"
    fi
    print -r -- ""
    print -r -- "오늘 한 일:"
    docker exec kis-postgres psql -U kis -d kis -c \
      "SELECT name AS 이름, to_char(ran_at AT TIME ZONE 'Asia/Seoul','HH24:MI:SS') AS 시각, note AS 비고
         FROM trading_heartbeats
        WHERE (ran_at AT TIME ZONE 'Asia/Seoul')::date = (now() AT TIME ZONE 'Asia/Seoul')::date
        ORDER BY id DESC LIMIT 12;" 2>/dev/null \
      || print -r -- "  (Postgres가 안 떠 있어 못 읽는다)"
    ;;
  *)
    print -r -- "쓰는 법: zsh scripts/daemon.sh [start|stop|status]"
    exit 1
    ;;
esac
