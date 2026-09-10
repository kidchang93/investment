#!/bin/zsh
#
# **기동 — 이 하나로 다 뜬다.** Docker · Postgres · 백엔드 · 화면.
#
# ── ★★ 2026-09-02에 이것이 유일한 기동 명령이 됐다 ──────────────────────
#
# 그전에는 셋을 따로 띄웠다: `morning.sh`(환경) + `daemon.sh`(스케줄러) +
# `dev:web`(화면). 사용자가 정리했다 —
#
#   *"웹에서 컨트롤하고 싶은데 데몬 이런 게 아니라"*
#   *"백 프론트 두 개를 꼭 둬야 되나? 하나로 서빙할 수 있는 방법이 제일 좋을 것 같다"*
#   *"백엔드는 자동으로 켜지 말고 내가 기동하라고 할 때만 기동해줘"*
#
# 그래서 지금은 **백엔드 하나**다. 스케줄러는 그 안에 있고(`automation/`),
# 화면도 그 안에서 낸다(`frontend/dist`). 옛 터미널 데몬은 2026-09-07에 지웠다 —
# 함께 돌면 모든 작업이 두 번 나간다(`docs/OPERATIONS.md`).
#
# ★ **자동 시작은 걸지 않는다.** 사용자가 늘 Claude Code를 켜고 시작하므로
#   그 자리에서 말하면 된다(`docs/USER_DECISIONS.md`). `.zshrc`·launchd·로그인
#   항목 어디에도 넣지 않는다 — 두 번 뺀 결정이다.
#
# ★ **띄운다고 자동화가 도는 것은 아니다.** 스케줄러 스위치는 화면에 있다.
#   그 둘은 다른 것이다.
#
# ── 원래 왜 생겼나 ──────────────────────────────────────────────────────
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

# ── 화면 ──────────────────────────────────────────────────────────────
# 백엔드가 `frontend/dist`를 함께 낸다. 없으면 화면이 안 뜨는데 **이유가 안
# 보이므로** 여기서 미리 만들어 둔다(첫 빌드 1분, 그 뒤 1초 안쪽).
if [[ ! -f frontend/dist/index.html ]]; then
  log "화면 빌드가 없다 — 만든다"
  npm run build >/tmp/kis-web-build.log 2>&1 \
    && log "화면 빌드 완료" \
    || log "✗ 화면 빌드 실패 — /tmp/kis-web-build.log"
fi

# ── 자동화 ────────────────────────────────────────────────────────────
# ★ **떴다고 도는 것이 아니다.** 스케줄러는 화면에서 켠다 — 그 둘은 다른
#   스위치이고, 섞으면 "서버를 띄우면 매매가 시작되는" 구조가 된다.
AUTO=$(curl -s -m 5 http://localhost:4000/api/automation/status 2>/dev/null \
  | python3 -c "
import json,sys
try:
    d = json.load(sys.stdin); s = d['settings']
    print(('자동화 켜짐' if s['enabled'] else '자동화 꺼짐')
          + ' · ' + ('매매 켜짐' if s['tradingEnabled'] else '매매 꺼짐'))
except Exception:
    print('상태를 못 읽었다')
" 2>/dev/null)
log "── 자동화 ──"
log "  ${AUTO:-상태를 못 읽었다}"
log "  켜고 끄는 것은 화면에서: http://localhost:4000  (「목표」 탭 맨 위)"

# ── 일봉 저장소 ───────────────────────────────────────────────────────
#
# ★★ **"돌았다"와 "끝까지 갔다"는 다르다** (2026-09-10에 값으로 봤다).
#
# 일봉 수집은 `background: true`라 스케줄러가 **시작할 때** 하트비트를 남긴다.
# 그래서 화면에도 하트비트에도 `daily-bars ok`가 찍히는데, 완료는 `-done`이라는
# 다른 이름으로 남는다. 6거래일 중 **4일(9/3·9/4·9/8·9/9)이 완료 기록이 없었고**
# 아무도 몰랐다 — 그날 아침 내가 이 스크립트 출력을 보고 "정상"이라고 읽었다.
#
# 데이터가 증거였다: 커서의 1,403종목이 **9/4에 멈춰** 있고 2,507종목만 9/8까지였다.
# 완주한 이틀은 수집이 끝난 **뒤에** 커밋이 있었고, 실패한 사흘은 수집 **중에**
# `backend/src` 커밋이 셋씩 있었다 — `tsx watch`가 백엔드를 재시작할 때 spawn된
# 수집이 함께 죽는 것으로 보인다.
#
# ★ 그래서 **하트비트가 아니라 커서를 본다.** "돌았다는 기록"이 아니라 "실제로
#   어디까지 채웠나"가 사실이다. 뒤처진 종목이 있으면 그 수를 적는다.
log "── 일봉 저장소 ──"
docker exec kis-postgres psql -U kis -d kis -t -A -F'|' -c "
  SELECT newest_day, count(*) FROM trading_daily_bar_cursor
   WHERE newest_day IS NOT NULL GROUP BY 1 ORDER BY 1 DESC;" 2>/dev/null \
  | python3 -c "
import sys, datetime
rows = [l.strip().split('|') for l in sys.stdin if l.strip()]
if not rows:
    print('  커서를 못 읽었다')
else:
    newest = rows[0][0]
    print(f'  최신 {newest} · {rows[0][1]}종목')
    # ★ **계열이 끝난 종목은 뒤처진 것이 아니다.** 상장폐지가 1,000종목 넘게
    #   들어 있고(생존편향을 없애려 일부러 넣었다) 그것들의 마지막 봉은 폐지일이다.
    #   그것까지 세면 2,438종목이 뒤처졌다가 되어 진짜 문제(1,403)를 묻는다.
    #   최신일에서 30일 안쪽만 따라와야 하는데 안 온 것으로 본다.
    #   ★ 이 블록은 셸의 python3 -c 큰따옴표 안이다 — 주석에도 큰따옴표를 쓰면
    #     문자열이 거기서 닫혀 조용히 아무것도 안 찍힌다(2026-09-10에 그랬다).
    cut = (datetime.datetime.strptime(newest, '%Y%m%d') - datetime.timedelta(days=30)).strftime('%Y%m%d')
    late = [(d, n) for d, n in rows[1:] if d >= cut]
    ended = sum(int(n) for d, n in rows[1:] if d < cut)
    if late:
        print(f'  ★ {sum(int(n) for _, n in late)}종목이 뒤처져 있다 — '
              + ' · '.join(f'{d} {n}종목' for d, n in late[:5]))
        print('    메우려면: cd backend && npx tsx src/scripts/collectDailyBars.ts --refresh')
    if ended:
        print(f'  (계열이 끝난 종목 {ended}개는 뺐다 — 상장폐지라 따라오지 않는 것이 맞다)')
" 2>/dev/null || log "  일봉 상태를 못 읽었다"

# ★ 어제 수집이 끝까지 갔나. 시작만 남고 -done이 없으면 도중에 죽은 것이다.
docker exec kis-postgres psql -U kis -d kis -t -A -F'|' -c "
  SELECT to_char(max(ran_at) FILTER (WHERE name = 'daily-bars')      AT TIME ZONE 'Asia/Seoul', 'MM-DD HH24:MI'),
         to_char(max(ran_at) FILTER (WHERE name = 'daily-bars-done') AT TIME ZONE 'Asia/Seoul', 'MM-DD HH24:MI')
    FROM trading_heartbeats WHERE name LIKE 'daily-bars%';" 2>/dev/null \
  | python3 -c "
import sys
raw = sys.stdin.read().strip()
if raw:
    started, done = (raw.split('|') + [''])[:2]
    if started and (not done or done < started):
        print(f'  ★ 마지막 수집({started})이 완료 기록을 안 남겼다 — 도중에 죽었다')
        print('    수집 중에 backend/src를 고치면 tsx watch 재시작에 함께 죽는다')
" 2>/dev/null || true

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
