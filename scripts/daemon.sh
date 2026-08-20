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

# Postgres가 준비될 때까지 기다린다. **재부팅 직후에는 데몬이 먼저 뜬다** —
# 터미널(.zshrc)이 Docker Desktop보다 빠를 수 있다. 2026-08-19 아침에 그래서
# 하트비트·브리핑·판단자가 전부 실패했고, DB가 없어 **실패했다는 기록조차
# 안 남았다**(하트비트도 DB에 쓴다).
wait_for_db() {
  local tries="${1:-60}"
  for i in $(seq 1 "$tries"); do
    docker exec kis-postgres pg_isready -U kis >/dev/null 2>&1 && return 0
    if [[ $((i % 10)) -eq 1 ]]; then
      # ★ **Docker 데몬 자체가 없으면 `docker start`는 아무 소용이 없다.**
      #   2026-08-20 아침에 그랬다 — 재부팅 뒤 Docker Desktop이 안 떠서, 어제
      #   넣은 이 대기가 컨테이너만 두드리며 5분을 흘려보낼 참이었다. 사람이
      #   `morning.sh`를 돌려 Docker를 띄운 09:01:47에야 데몬이 풀렸다.
      #   **아무도 안 깨우면 그날 자동화가 통째로 빠진다.** 앱을 직접 띄운다
      #   (터미널에서 뜬 프로세스라 TCC 권한이 있다 — 파일 머리말 참고).
      if ! docker info >/dev/null 2>&1; then
        log "Docker 데몬이 없다 — Docker Desktop을 띄운다 (30~60초)"
        open -a Docker >/dev/null 2>&1
      else
        # 컨테이너가 멈춰 있으면 깨운다. 재시작 정책이 unless-stopped라 보통은
        # Docker가 알아서 띄우지만, 사람이 손으로 멈춰 둔 경우가 있다.
        docker start kis-postgres >/dev/null 2>&1
      fi
    fi
    sleep 5
  done
  return 1
}

# ★ **데몬이 둘 이상 뜨는 것을 막는다.** 2026-08-20 09:00:03과 09:02:10에 두 개가
#   떠서 **판단자를 각각 소집했다**(헤드리스 Claude 두 벌 + 같은 회차 이중 기록).
#   `.zshrc`도 `daemon.sh start`도 "pgrep으로 보고 → 띄운다"라 그 사이가 원자적이
#   아니었고, 창이 여럿 열리면 둘 다 "없다"를 보고 지나간다.
#
#   ★ PID 파일 문제(2026-08-14, 먼저 죽은 데몬의 trap이 남의 파일을 지웠다)를
#     되풀이하지 않으려고 `mkdir`을 쓴다 — 원자적이라 경쟁에서 한 쪽만 이긴다.
#
#   ★★ **락을 지우는 trap을 걸지 않는다.** 걸어 봤다가 되돌렸다 — zsh는 명령
#      치환 서브셸(`$(date ...)` 같은 것)이 끝날 때도 EXIT trap을 실행한다.
#      락을 잡자마자 루프 첫 줄의 `$(date '+%u')`에서 스스로 지워 버려, 막으려던
#      중복이 그대로 되살아났다(2026-08-20에 시험으로 잡았다).
#      **정리는 다음 데몬이 한다** — 주인 PID가 죽었거나 다른 프로그램이 그 번호를
#      물려받았으면 회수한다. 락이 남아 있는 것은 고장이 아니다.
LOCK_FILE="$LOG_DIR/daemon.lock"

lock_owner_alive() {
  local owner
  owner=$(cat "$LOCK_FILE" 2>/dev/null) || return 1
  [[ -n "$owner" ]] || return 1
  # PID 번호만 보지 않는다 — 재부팅 뒤 그 번호를 다른 프로그램이 물려받는다.
  ps -p "$owner" -o command= 2>/dev/null | grep -q "daemon.sh __loop"
}

acquire_lock() {
  local tmp="$LOG_DIR/.lock.$$"
  print -r -- "$$" > "$tmp" 2>/dev/null || return 1
  # ★ `mkdir`이 아니라 `ln`이다. mkdir은 디렉터리를 먼저 만들고 PID를 나중에
  #   적으므로 그 사이에 들어온 쪽이 "주인이 없다"며 회수해 버린다 —
  #   2026-08-20에 동시 기동 10개로 시험했더니 **5개가 이겼다.** 하드링크는
  #   PID가 이미 들어 있는 파일을 거는 것이라 그 창이 없다.
  if ln "$tmp" "$LOCK_FILE" 2>/dev/null; then rm -f "$tmp"; return 0; fi
  if lock_owner_alive; then rm -f "$tmp"; return 1; fi
  log "락 주인이 죽어 있다 — 회수한다"
  rm -f "$LOCK_FILE"
  ln "$tmp" "$LOCK_FILE" 2>/dev/null || { rm -f "$tmp"; return 1; }
  rm -f "$tmp"
  # 회수만은 둘이 동시에 지우고 동시에 걸 수 있다. 잡은 뒤 한 번 더 확인하고,
  # 내 것이 아니면 물러난다.
  sleep 1
  [[ "$(cat "$LOCK_FILE" 2>/dev/null)" == "$$" ]] || return 1
  return 0
}

run_loop() {
  if ! acquire_lock; then
    # 조용히 물러난다. `.zshrc`가 터미널을 열 때마다 부르므로 시끄러우면 안 된다.
    log "이미 다른 데몬이 돌고 있다 (pid $(cat "$LOCK_FILE" 2>/dev/null)) — 이 프로세스는 물러난다"
    return 0
  fi
  log "데몬 시작 (pid $$)"
  if wait_for_db 60; then
    log "Postgres 준비됨"
  else
    log "★ Postgres를 5분 기다려도 없다 — 하트비트도 못 남긴다. Docker를 확인하라"
  fi
  mark 'daemon-start' "pid $$"
  while true; do
    # ★ **DB가 없으면 이 회차는 아무것도 하지 않는다.** `did_today`는 DB를 못
    #   읽으면 "아직 안 했다"를 돌려주므로, 그대로 두면 매 분 브리핑과 판단자를
    #   다시 부른다 — 판단자는 헤드리스 Claude라 부를 때마다 실제 비용이 나간다.
    #   여기서 60초를 쓰므로 아래 sleep 없이도 주기가 유지된다.
    if ! wait_for_db 12; then
      log "Postgres가 없다 — 이 회차를 건너뛴다 (Docker를 확인하라)"
      continue
    fi

    local dow hhmm
    dow=$(date '+%u')      # 1=월 … 7=일
    hhmm=$(date '+%H%M')

    if [[ "$dow" -le 5 ]]; then
      # ── 08:12 개장 전 ──────────────────────────────────────────────
      # ★ **창을 장 마감까지 넓혔다.** 예전에는 08:12~08:50이라, 재부팅 뒤
      #   08:59에 데몬이 뜬 2026-08-19에는 그날 브리핑을 통째로 건너뛰었다.
      #   늦게라도 하는 것이 안 하는 것보다 낫다 — 하트비트가 몇 시에 했는지
      #   적으므로 "제때 했나"는 그것으로 판별한다.
      if [[ "$hhmm" > "0811" && "$hhmm" < "1530" ]] && ! did_today premarket; then
        log "개장 전 브리핑 시작"
        zsh scripts/premarket.sh >> "$LOG_DIR/daemon-$(date '+%Y%m%d').log" 2>&1
        log "개장 전 브리핑 끝"
      fi

      # ── 08:20 판단자 소집 ─────────────────────────────────────────
      #
      # ★ **이것이 8/06 이후 13일간 빠져 있던 고리다.** 판단자를 에이전트로
      #   바꿔 놓고 부르는 장치를 안 만들어서, 사람이 손으로 `/trading-loop`을
      #   부를 때만 돌았다. 안 부르니 안 돌았고 측정만 쌓였다.
      #
      # 개장 전(08:20)에 둔 이유는 **판단이 서 있어야 장이 열릴 때 집행할 수
      # 있기** 때문이다. 브리핑(08:12) 뒤라 그 결과를 재료로 쓴다.
      #
      # ★ 주문은 내지 않는다 — 판단을 기록하는 데까지다.
      # 판단자도 같다 — 늦게 떠도 그날 한 번은 소집한다(장중 소집은 실제로
      # 2026-08-19 14:54에 돌려 정상 동작을 확인했다).
      if [[ "$hhmm" > "0819" && "$hhmm" < "1530" ]] && ! did_today deliberate; then
        log "판단자 소집 시작"
        zsh scripts/deliberate.sh >> "$LOG_DIR/daemon-$(date '+%Y%m%d').log" 2>&1
        if [[ $? -eq 0 ]]; then
          mark deliberate "$(date '+%H:%M')"
          log "판단자 소집 끝"
        else
          log "판단자 실패 — 하트비트를 남기지 않는다(다음 회차가 다시 시도한다)"
        fi
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
