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
#   환경을 세우는 것은 `morning.sh`, 자동 실행은 **백엔드 안의 스케줄러**다.
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
#
# ★★ **스케줄러는 백엔드 안에 있다** (2026-09-07에 이 판정을 고쳤다).
#
#    전에는 `daemon.sh __loop` 프로세스를 찾아 없으면 *"멈춤 — zsh scripts/daemon.sh
#    start"*라고 안내했다. 그런데 스케줄러는 **백엔드로 옮겨졌고**, `daemon.sh`는
#    맨 위에 *"이 파일을 다시 띄우지 마라"*고 적힌 채 이력용으로만 남아 있다.
#
#    2026-09-07 아침에 이 안내를 그대로 따라 `daemon.sh start`를 했고, 두 스케줄러가
#    **같은 작업을 두 번** 불렀다 — `premarket` 08:40:26에 두 번, `watch`가 2초
#    차이로 두 번. 손절은 `noHeartbeat`라 두 번 나가도 기록에 안 남는다
#    (`clientOrderId`가 막았지만 그건 마지막 방어선이다).
#
# ★ 이제 백엔드에 물어본다. `ticking`이 그 답이다.
auto_json=$(curl -s --max-time 3 http://localhost:4000/api/automation/status 2>/dev/null)
if [[ -n "$auto_json" ]]; then
  auto_line=$(print -r -- "$auto_json" | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print('?|백엔드가 자동화 상태를 안 준다'); raise SystemExit
s = d.get('settings', {})
state = 'on' if d.get('ticking') else 'off'
print(f\"{state}|틱 {d.get('now','?')} · 자동화 {'켜짐' if s.get('enabled') else '꺼짐'}\"
      f\" · 매매 {'켜짐' if s.get('tradingEnabled') else '꺼짐'} · 작업 {len(d.get('tasks',[]))}개\")
" 2>/dev/null)
  if [[ "${auto_line%%|*}" == "on" ]]; then
    ok "스케줄러   백엔드 안에서 돈다 — ${auto_line#*|}"
  else
    bad "스케줄러   안 돈다 — ${auto_line#*|} · 화면(:4000)「목표」탭에서 켠다"
  fi
else
  bad "스케줄러   상태를 못 읽었다 — 백엔드가 떠 있나 확인한다"
fi
# ★ 옛 데몬이 함께 돌면 모든 작업이 두 번 나간다. 크게 알린다.
daemon_pid=$(pgrep -f "daemon.sh __loop" 2>/dev/null | head -1)
if [[ -n "$daemon_pid" ]]; then
  bad "★★ 옛 데몬이 함께 돌고 있다 (pid $daemon_pid) — 모든 작업이 두 번 나간다"
  bad "   그 파일은 2026-09-07에 지웠다 — 되살린 것이면 kill 한다"
fi
backend_pid=$(pgrep -f "tsx watch src/server.ts" 2>/dev/null | head -1)
if [[ -n "$backend_pid" ]]; then
  ok "백엔드     pid $backend_pid  :4000"
  # ★ **살아 있다는 말과 계속 돈다는 말은 다르다.** 맥이 자면 백엔드도 스케줄러도
  #   함께 멈춘다 — 9/7~9/11 5거래일이 장중에 19~90분씩 잤다(`morning.sh` 절전 차단).
  if pgrep -f "^caffeinate -i -s -w ${backend_pid}\$" >/dev/null 2>&1; then
    ok "절전 차단  걸려 있음 — 맥이 유휴로 잠들지 않는다 (뚜껑을 닫으면 잔다)"
  else
    bad "절전 차단  없음 — 맥이 자면 손절 감시도 멈춘다. zsh scripts/morning.sh 로 붙인다"
  fi
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
db_ok=0
docker exec kis-postgres psql -U kis -d kis -tAc 'select 1' >/dev/null 2>&1 && db_ok=1
if (( db_ok )); then
  (cd backend && npx tsx src/scripts/layerReport.ts 2>&1) | sed 's/^/  /'
else
  print -r -- "  Postgres가 없어 못 읽는다"
fi

# ── 자동 실행 기록 ────────────────────────────────────────────────────
head_ "오늘 자동으로 한 일 (하트비트)"
if (( db_ok )); then
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
#
# ★ **작업표를 여기 박지 않는다.** 위에서 받은 `/api/automation/status`의 `tasks`
#   (`backend/src/automation/tasks.ts`)로 그린다. 박아 둔 표는 08:12·20분·15:40만
#   말했고 판단자·손절·종가 매매가 생긴 뒤에도 "데몬은 주문을 내지 않는다"고 적었다.
# ★ 요일·시각도 백엔드가 준 KST(`weekday`·`now`)로 본다. 이 맥의 시계로 흉내 내지 않는다.
if [[ -z "$auto_json" ]]; then
  print -r -- "  백엔드가 안 떠 있어 작업표를 못 읽었다 — 지금은 아무것도 자동으로 돌지 않는다"
else
  AUTO_JSON="$auto_json" python3 - <<'PY' 2>/dev/null || print -r -- "  작업표를 못 그렸다 (python3 오류)"
import json, os, unicodedata

def pad(text, width):
    used = sum(2 if unicodedata.east_asian_width(c) in 'WF' else 1 for c in text)
    return text + ' ' * max(1, width - used)

def hm(clock):
    return '%02d:%02d' % (clock // 100, clock % 100)

try:
    d = json.loads(os.environ['AUTO_JSON'])
    tasks, settings, weekday = d['tasks'], d['settings'], d['weekday']
    clock = int(d['now'].replace(':', ''))
except Exception:
    print('  작업표를 못 읽었다 — 응답 형식이 바뀌었는지 확인한다')
    raise SystemExit

quiet = None
if not settings.get('enabled'):
    quiet = '자동화가 꺼져 있다 — 아래는 켰을 때 도는 작업표다 (화면 :4000「목표」탭에서 켠다)'
elif weekday > 5:
    quiet = '주말이다 — 아래 작업표는 평일에만 돈다'
if quiet:
    print('  ' + quiet)

for t in sorted(tasks, key=lambda t: t['window'][0]):
    start, end = t['window']
    every = t.get('everyMinutes')
    cadence = '%d분마다' % every if not t['daily'] and every else '하루 한 번'
    if quiet:
        state = ''
    elif t.get('skipped') == 'trading-off':
        state = '매매 꺼짐이라 건너뛴다'
    elif t.get('running'):
        state = '지금 도는 중'
    elif t['daily'] and t.get('doneToday'):
        state = '오늘 함 ' + (t.get('lastRunAt') or '')
        if t.get('finishedToday') is False:
            state += ' · 안 끝남'
    elif t.get('inWindow'):
        if t['daily']:
            state = '창 안 — 아직 안 했다'
        elif t.get('noHeartbeat'):
            state = '창 안 — 기록을 남기지 않는다'
        else:
            state = '창 안 · 마지막 ' + (t.get('lastRunAt') or '없음')
    elif clock < start:
        state = '오늘 ' + hm(start) + '부터'
    else:
        state = '오늘 창 지남' + (' — 안 했다' if t['daily'] else '')
    print(('  ' + hm(start) + '~' + hm(end) + '  ' + pad(t['label'], 24) + pad(cadence, 11) + state).rstrip())

gated = [t['label'] for t in tasks if t.get('trading')]
print('')
print('  매매 스위치 ' + ('켜짐' if settings.get('tradingEnabled') else '꺼짐')
      + ' — 여기에 걸린 작업: ' + (' · '.join(gated) if gated else '없음'))
PY
fi
