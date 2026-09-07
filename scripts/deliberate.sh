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

# ★ `--quick`이면 **가벼운 프롬프트**를 쓴다 (2026-09-03).
#
#   정식 회차는 후보 300종목을 훑고 웹을 뒤져 **13분**이 걸린다(09:47→10:00 실측).
#   5분마다 도는 자리에는 못 쓴다. 빠른 회차는 분석가가 낸 적정가 표 하나만 보고
#   2~3분에 끝낸다 — 조사를 안 하는 것이 그 회차의 전부다.
#
# ★★ `--close`면 **종가 판단자**다 (2026-09-07). 사용자가 정했다 —
#    *"장이 끝나고 종가 매매 방식을 도입해보는 것도 좋을 것 같아. 시장 상황을
#    분석해서 종가에 사서 다음날 매도하는 전략을 펼쳐봐야될 것 같아."*
#
#    같은 뼈대(분석가 → 판단자 → 집행)를 쓰되 보는 지평이 **하룻밤**이라
#    판단 기준이 통째로 다르다. 그래서 프롬프트를 따로 둔다.
QUICK=0
CLOSE=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --quick) QUICK=1 ;;
    --close) CLOSE=1 ;;
    *) ARGS+=("$a") ;;
  esac
done
ACCOUNT="${ARGS[1]:-VTS-ORDINARY}"
if [[ $CLOSE -eq 1 ]]; then
  PROMPT_FILE="prompts/deliberate-close.md"
  LOG_SUFFIX="close"
elif [[ $QUICK -eq 1 ]]; then
  PROMPT_FILE="prompts/deliberate-quick.md"
  LOG_SUFFIX="quick"
else
  PROMPT_FILE="prompts/deliberate.md"
  LOG_SUFFIX=""
fi
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

# ── ★★ 두 벌이 뜨는 것을 여기서 막는다 (2026-09-07) ──────────────────────
#
# `analyzeFairValue.ts`의 주석은 *"중복은 스케줄러의 `guard`(pgrep)와
# `deliberate.sh`가 막는다"*고 적혀 있었지만 **이 스크립트에는 아무 락도 없었다.**
# 스케줄러의 `guard`는 `deliberate` 작업이 뜰 때만 검사하고, 적정가 분석이
# `spawn`으로 띄우는 빠른 회차는 그 검사를 거치지 않는다.
#
# 그래서 정식 회차(10~15분)가 도는 동안 빠른 회차가 끼어들 수 있었다. 겹치면
# 헤드리스 Claude가 두 벌이라 비용이 두 배이고, 회차 수로 성패를 가리는 위
# `count_rounds`가 서로의 행을 보고 오판한다.
#
# ★ `mkdir`은 원자적이라 락으로 쓴다. 안에 pid를 적어 **죽은 락은 스스로 걷는다** —
#   안 걷으면 한 번 죽은 뒤로 판단자가 영영 안 돈다(그쪽이 더 나쁘다).
LOCK_DIR=".cron-logs/deliberate.lock"
mkdir -p .cron-logs
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  OWNER=$(cat "$LOCK_DIR/pid" 2>/dev/null || echo '')
  if [[ -n "$OWNER" ]] && kill -0 "$OWNER" 2>/dev/null; then
    log "판단자가 이미 돌고 있다 (pid $OWNER) — 이번 회차는 건너뛴다${LOG_SUFFIX:+ · $LOG_SUFFIX}"
    exit 0
  fi
  log "죽은 락을 걷는다 (pid ${OWNER:-없음})"
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" || { log "락을 잡지 못했다"; exit 1; }
fi
echo $$ > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

#
# ── 화면의 자세 (2026-09-07) ─────────────────────────────────────────────
#
# 사무실 화면이 "지금 무엇을 하는가"로 캐릭터 자세를 바꾼다. 하트비트는
# **끝났다**를 남기는 것이라 10~15분짜리 회차가 도는 동안 비어 있다 —
# 그 사이를 이 표시가 채운다(`backend/src/db/agentActivity.ts`).
#
# ★ 실패해도 판단을 막지 않는다. 꾸밈이 판단을 멈추면 본말이 뒤집힌다.
SEAT=$([[ $CLOSE -eq 1 ]] && echo closeJudge || echo judge)
mark() { (cd backend && npx tsx src/scripts/markActivity.ts "$SEAT" "$1" "${2:-}") >/dev/null 2>&1 || true; }
# 자리를 떠날 때 반드시 되돌린다 — 안 그러면 화면이 영영 "일하는 중"으로 남는다.
trap 'mark idle; rm -rf "$LOCK_DIR"' EXIT

log "판단자 소집 · 계좌 $ACCOUNT${LOG_SUFFIX:+ · $LOG_SUFFIX}"
mark gathering "상태를 모으는 중"

# ★ **소집 전 회차 수를 세어 둔다.** 아래에서 "정말 한 회차가 남았나"를 이것으로
#   가린다 — `claude -p`의 종료 코드만 보면 **아무것도 안 하고 끝나도 성공**이다.
#   2026-08-21에 실제로 그랬다: 판단자가 리서처를 띄웠다가 백그라운드 대기
#   한도(600초)에 걸려 강제 종료됐는데, 종료 코드가 0이라 데몬이 "오늘 판단자
#   했다"고 하트비트를 남겼다. **그날 판단이 통째로 사라졌고 아무도 몰랐다.**
#
# ★★ **내 종류의 회차만 센다** (2026-09-07). 안 가르면 이 방어가 통째로 무력해진다.
#
#   빠른 회차(`--quick`)는 `fair-value` 창에서 **5분마다** 후보가 되고, 정식 회차는
#   **10~15분**이 걸린다. 즉 정식 회차가 도는 동안 빠른 회차가 두세 번 끼어들고
#   같은 표에 행을 남긴다. 종류를 안 가리면 **정식 회차가 아무것도 안 남기고 죽어도**
#   그 사이 빠른 회차가 남긴 행 때문에 `AFTER > BEFORE`가 되어 성공으로 읽힌다.
#
#   그러면 데몬이 하트비트를 남기고, `deliberate`는 `daily: true`라 **그날 발굴이
#   통째로 날아간다.** 위에 적힌 2026-08-21 사고가 정확히 그 모양이었고, 이 함수는
#   그것을 막으려고 생겼다. 실측: 오늘까지 `fair-value` 59건 · `scheduled` 22건 —
#   끼어드는 쪽이 세 배 가까이 많다.
if [[ $QUICK -eq 1 ]]; then
  ROUND_FILTER="AND trigger = 'fair-value'"
elif [[ $CLOSE -eq 1 ]]; then
  ROUND_FILTER="AND trigger = 'close'"
else
  # 정식 회차는 빠른 회차도 종가 회차도 자기 것으로 세지 않는다.
  ROUND_FILTER="AND trigger NOT IN ('fair-value','close')"
fi
count_rounds() {
  docker exec kis-postgres psql -U kis -d kis -tAc \
    "SELECT count(*) FROM trading_deliberations
      WHERE account_id='$ACCOUNT'
        AND trading_day = (now() AT TIME ZONE 'Asia/Seoul')::date
        $ROUND_FILTER" 2>/dev/null | tr -d ' '
}
BEFORE=$(count_rounds)
BEFORE=${BEFORE:-0}

# ★ 허용 도구를 좁힌다. 판단에 필요한 것만 준다 —
#   Bash(상태 수집·기록)·Read·Grep·Glob·WebSearch·WebFetch.
#   Write/Edit는 주지 않는다. 판단자가 코드를 고칠 일이 없다.
claude -p "$(cat "$PROMPT_FILE")

계좌 id는 **$ACCOUNT** 입니다. 지금 시각은 $(date '+%Y-%m-%d %H:%M') KST 입니다." \
  --allowedTools "Bash,Read,Grep,Glob,WebSearch,WebFetch" \
  --permission-mode acceptEdits \
  >> "$LOG" 2>&1
code=$?

AFTER=$(count_rounds)
AFTER=${AFTER:-0}

if [[ $code -ne 0 ]]; then
  log "판단자가 실패했다 (exit $code) — 로그를 본다: $LOG"
  exit $code
fi

# ★ 종료 코드가 0이어도 **회차가 안 늘었으면 실패다.** 하트비트를 남기지 않아야
#   데몬이 다음 루프에서 다시 부른다.
if [[ "${AFTER:-0}" -le "${BEFORE:-0}" ]]; then
  log "★ 판단자가 정상 종료했지만 회차를 남기지 않았다 (오늘 $BEFORE → $AFTER) — 실패로 친다"
  exit 3
fi

log "판단자 회차 끝 (오늘 $BEFORE → $AFTER)"

# ── ★★ 집행을 여기서 한다 (2026-09-03) ────────────────────────────────
#
# 사용자가 정했다 — *"집행기 기능을 판단자에 넣어줘도 될 것 같아. 집행기가
# 5분마다 도는 건 또 비효율적일 것 같고 판단자에서 집행할 수 있게 해줘야 돼."*
#
# 맞다. 집행기를 5분마다 돌리면 **낼 것이 없는 회차가 대부분**이다 — 판단이
# 나오는 것은 하루 몇 번인데 78번 돌며 매번 계좌를 조회한다.
#
# ★ **회차 직후가 유일하게 낼 것이 있는 시점**이다. 데몬 시절에도 그랬다
#   (`run_executor`를 판단자 뒤에 불렀다). 스케줄러로 옮기며 그 고리가 빠져
#   2026-09-03 오전에 **판단이 통째로 집행되지 않았다** — 회차가 09:21 창을
#   지나 끝났기 때문이다.
#
# ★ **판단자가 아니라 이 스크립트가 부른다.** 판단자 프롬프트는 여전히
#   *"당신은 주문을 내지 않습니다"*이고 `--execute`를 금지한다. 판단과 집행을
#   가른 이유가 "왜 샀나"를 되짚기 위해서인데, 판단자가 직접 주문하면 그
#   경계가 사라진다. **적은 것을 우리가 옮긴다.**
#
# ★ 집행기는 멱등이다(회차 `executions` + `clientOrderId`). 낼 것이 없으면
#   아무 일도 하지 않는다.
#
# ★★ **종가 회차는 여기서 집행하지 않는다** (2026-09-07). 장 마감 동시호가 창이
#    **15:20~15:30**이라 그 전에 내면 정규장 주문으로 즉시 체결된다 — 그러면
#    "종가에 산다"가 아니라 "15:1x에 산다"가 되고, 21년 측정이 말한 자리가 아니다.
#
#    판단은 15:00~15:15에 하고(10~15분 걸린다) 집행은 `close-execute` 작업이
#    15:21에 **그 회차 id를 찍어** 부른다. id를 찍는 것은 그 사이 빠른 회차가
#    끼어들어 "최신 회차"가 바뀔 수 있기 때문이다.
if [[ $CLOSE -eq 1 ]]; then
  log "종가 회차는 여기서 집행하지 않는다 — 15:21에 close-execute가 낸다"
  exit 0
fi

mark ordering "판단을 주문으로 옮기는 중"
log "집행기 시작"
(cd backend && npx tsx src/scripts/executeDeliberation.ts "$ACCOUNT" --execute) >> "$LOG" 2>&1
exec_code=$?
if [[ $exec_code -eq 0 ]]; then
  log "집행기 끝"
else
  log "★ 집행기가 실패했다 (exit $exec_code) — 판단은 남았으니 다음 회차가 다시 본다"
fi

exit 0
