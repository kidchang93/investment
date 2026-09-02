# Investment Monitor - Knowledge Base

> 이 문서는 Claude가 프로젝트 작업 시 실수를 방지하기 위한 엄격한 기준을 제공합니다.

## 프로젝트 개요

**Investment Monitor**는 한국투자증권(KIS) 오픈API를 기반으로 국내 주식의 **일봉 시세와 실시간 체결가를 모니터링**하는 웹 애플리케이션입니다. 백엔드가 KIS API를 중계·정규화하고, 프론트엔드는 캔들 차트로 시각화합니다.

### 핵심 기술 스택

| 항목 | 기술 |
|------|------|
| 언어 | TypeScript 5.6 (ESM, `"type": "module"`) |
| 런타임 | Node.js ≥ 20 |
| 모노레포 | npm workspaces (`shared` / `backend` / `frontend`) |
| 백엔드 | Fastify 5 + ws 8 (REST + WebSocket 중계) |
| 프론트엔드 | React 18 + Vite 5 + lightweight-charts 4 |
| 외부 API | 한국투자증권 오픈API (REST + 실시간 WebSocket) |
| 개발 실행 | tsx (backend), vite (frontend), concurrently |

### 워크스페이스 구조

| 워크스페이스 | 패키지명 | 역할 |
|------|------|------|
| `shared` | `@invest/shared` | 백엔드↔프론트 공유 도메인 타입 (빌드 없이 소스 직접 참조) |
| `backend` | `backend` | KIS API 중계, 정규화, REST/WS 서버 |
| `frontend` | `frontend` | React 시세 모니터링 UI |

---

## 빌드 및 실행 명령어

```bash
# 최초 1회: 의존성 설치 (루트에서 워크스페이스 전체)
npm install

# .env 준비 (루트에 생성)
cp .env.example .env      # KIS_APP_KEY / KIS_APP_SECRET 채우기

# Postgres를 먼저 띄운다. 없으면 백엔드가 뜨지 않는다
#   [api] Error: connect ECONNREFUSED 127.0.0.1:55432
docker start kis-postgres            # 컨테이너가 이미 있으면 이것으로 충분하다

# 없으면 새로 만든다. 접속 정보는 DATABASE_URL 기본값과 맞춘 것이고,
# 다른 방법으로 띄워도 된다 — 다르게 띄우면 DATABASE_URL을 고친다
docker run -d --name kis-postgres -p 55432:5432 \
  -e POSTGRES_USER=kis -e POSTGRES_PASSWORD=kis_local -e POSTGRES_DB=kis \
  postgres:16-alpine

# ★ 기동은 이 하나다 (2026-09-02~) — Docker·Postgres·백엔드·화면
#   http://localhost:4000 에서 화면·API·WebSocket이 전부 나온다.
#   스케줄러는 백엔드 안에 있고(`backend/src/automation/`) 켜고 끄는 것은 화면에서 한다.
#   ★ 자동 시작은 걸지 않는다 — 사용자가 기동하라고 할 때만 (docs/USER_DECISIONS.md)
zsh scripts/morning.sh

# 프론트를 고쳤으면 빌드해야 :4000에 반영된다
npm run build

# 개발 모드: 백엔드(:4000) + 프론트(:5173) 동시 실행 (HMR이 필요할 때만)
npm run dev

# 개별 실행
npm run dev:api           # 백엔드만 (tsx watch)
npm run dev:web           # 프론트만 (vite)

# 검증
npm run typecheck         # 백엔드 tsc --noEmit
npm run typecheck -w frontend   # 프론트 tsc --noEmit
npm run build             # 프론트 프로덕션 빌드 (vite build)
```

> **검증됨**: 위 `typecheck`(backend/frontend)와 `build`는 실제 통과 확인함.

---

## 환경 변수 (.env)

| 변수 | 필수 | 설명 |
|------|------|------|
| `KIS_APP_KEY` | ✅ | KIS Developers 발급 appkey |
| `KIS_APP_SECRET` | ✅ | KIS Developers 발급 appsecret |
| `KIS_APP_KEY_<id>` | | 계좌 `<id>`용 appkey (다계좌 방식) |
| `KIS_APP_SECRET_<id>` | | 계좌 `<id>`용 appsecret (다계좌 방식) |
| `KIS_<id>_ACCOUNT_NO` | | 계좌 `<id>`의 계좌번호. `12345678-01` 통합 표기 또는 앞 8자리. **8자리보다 짧으면 안 쓴다** — 짐작해서 채우지 않는다 |
| `KIS_<id>_ACCOUNT_<종류>_NO` | | 한 앱키에 계좌가 여럿일 때(모의투자의 `ORDINARY` 주식 / `EXTRAORDINARY` 선물옵션). 계좌 id는 `<id>-<종류>`가 되고 앱키는 `KIS_APP_KEY_<id>`를 함께 쓴다 |
| `KIS_<id>_ACCOUNT_PRODUCT_CODE` | | 상품코드 2자리. 생략하면 `01`(종합위탁) |
| `KIS_<id>_SERVER` | | 그 앱키가 붙는 서버 (`prod` \| `vts`). **생략하면 `APP_ENV`로 추정한다.** 적었는데 `APP_ENV`와 어긋나면 그 자격증명으로는 주문도 조회도 안 나가고, 기본 계좌가 어긋나면 서버가 뜨지 않는다 |
| `KIS_ACCOUNT_SERVER` | | 구버전 단일 계좌(`KIS_ACCOUNT_NO`)용 서버 표기 |
| `KIS_PRIMARY_ACCOUNT_ID` | | 시세·실시간 WS에 쓸 기본 계좌 id. 생략하면 id 오름차순 첫 계좌 |
| `KIS_OPEN_DAY_CREDENTIAL_ID` | | 개장일 조회(`chk-holiday`)를 물어볼 자격증명 id. **모의 서버에 이 TR이 없어** `APP_ENV=vts`면 리스크 룰이 늘 보류로 막힌다. 이 값을 주면 **개장일 조회 하나만** 그 앱키로 실전 서버에 보낸다. **조회 전용이고 주문에는 절대 쓰지 않는다.** 없으면 지금 동작 그대로(보류), `APP_ENV=prod`면 무시 |
| `KIS_LIVE_ORDER_ENABLED` | | `true`면 실주문 전송 허용. **기본값은 항상 차단**이다 |
| `KIS_<id>_HTS_ID` / `KIS_HTS_ID` | | HTS/MTS 로그인 ID. 실시간 주문·체결 통보(`H0STCNI0`) 구독의 `tr_key`. 종목코드가 아니다. 없으면 통보만 비활성화된다 |
| `KIS_ACCOUNT_NO` | | 구버전 단일 계좌 방식. `KIS_APP_KEY`/`KIS_APP_SECRET`와 함께 쓴다 |
| `KIS_ACCOUNT_PRODUCT_CODE` | | 구버전 단일 계좌의 상품코드 2자리 |
| `APP_ENV` | | `vts`(모의, 기본) \| `prod`(실전) |
| `PORT` | | 백엔드 포트 (기본 4000) |
| `DATABASE_URL` | | 종목 마스터·매매 기록용 Postgres (기본 `postgresql://kis:kis_local@localhost:55432/kis`) |
| `WATCHLIST` | | `005930:삼성전자,000660:SK하이닉스` 형식. 비우면 기본 감시목록 사용 |
| `VITE_API_BASE` | | 프론트가 바라볼 백엔드 주소 (기본 `http://localhost:4000`) |
| `SLACK_WEBHOOK_URL` | | 슬랙 Incoming Webhook. 넣으면 **손절 집행·경보·자동 주문**이 채널로 간다. 이 시스템은 사용자의 맥에서만 돌아 macOS 알림은 맥 앞에 있어야 보인다 — 자리를 비우면 손절이 나가도 모른다. **URL 자체가 자격증명이다**(가진 사람은 누구나 그 채널에 글을 쓴다). 없으면 조용히 안 보낸다 |

---

## docs/ 인덱스 — 작업 전 필독 매핑

| 작업 | 먼저 읽을 문서 |
|------|------|
| 모듈/데이터 흐름 파악, 새 파일 위치 결정 | `docs/ARCHITECTURE.md` |
| KIS 연동·정규화·타입 추가/변경 | `docs/DESIGN.md` |
| 코드 작성 (네이밍/패턴) | `docs/CODE_STYLE.md` |
| 리뷰·머지 전 점검 | `docs/REVIEW.md` |
| 서브에이전트로 작업 분배 | `docs/SUBAGENTS.md` |
| **사람이 정한 것 확인 (목표·층·자동화 범위)** | **`docs/USER_DECISIONS.md`** |
| **자동매매를 매일 어떻게 돌리나 (사람이 하는 일)** | **`docs/OPERATIONS.md`** |
| 매매 API 추가·주문 전송·차단 사유 확인 | `docs/TRADING_API.md` |
| 매매 기능 로드맵·DB 설계 | `docs/TRADING_ROADMAP.md` |
| **전략 파라미터를 바꾸려 할 때** | **`docs/STRATEGY_DISCIPLINE.md`** — 동결 기간·되돌리기·바꿀 수 있는 것의 목록 |

---

## 절대 하지 말아야 할 것

1. **KIS 원본 필드명(약어)을 프론트로 노출하지 말 것.** `stck_prpr`, `prdy_ctrt` 같은 약어는 반드시 `backend/src/kis/`에서 `@invest/shared` 타입으로 정규화한 뒤 넘긴다. 프론트는 KIS 스펙을 몰라야 한다.
2. **인증 토큰 발급을 남발하지 말 것.** `access_token`은 발급 횟수 제한이 있어 `.cache/token-{서버}-{계좌id}.json`으로 **앱키별·서버별로** 캐시한다 (구버전 단일 계좌는 `token-{서버}.json`). 토큰은 **발급받은 서버에서만** 통하므로 파일 이름의 `{서버}`는 그 실행의 `APP_ENV`가 아니라 **그 토큰을 받은 서버**다 — 개장일 조회는 모의 환경에서도 실전 서버에 붙는다(`KIS_OPEN_DAY_CREDENTIAL_ID`). 인증 로직을 바꿀 때 캐시 재사용을 깨지 않는다. 캐시는 백엔드 실행 디렉터리 기준이라 실제 경로는 `backend/.cache/`다.

2-1. **계좌 조회에 다른 계좌의 앱키를 쓰지 말 것.** KIS는 앱키에 등록된 계좌만 허용하고, 아니면 `INVALID_CHECK_ACNO`로 거부한다. 앱키/시크릿은 전역 값이 아니라 `KisAccountConfig`로 계좌와 함께 다닌다. 계좌 API를 추가할 때 `toCredentials(account)`를 `kisGetWithHeaders`에 넘겨야 한다.
3. **두 인증 엔드포인트의 시크릿 필드명 혼동 금지.** `/oauth2/tokenP` → `appsecret`, `/oauth2/Approval` → `secretkey`. 서로 다르다.
4. **실시간 프레임 파서의 상수를 임의로 바꾸지 말 것.** `H0STCNT0`의 `FIELDS_PER_RECORD = 46`, 필드 인덱스 매핑은 KIS 스펙에 고정돼 있다.

4-1. **멀티시세(`FHKST11300006`)의 30종목 상한을 넘기지 말 것.** 31개를 보내면 **오류가 나지 않는다** — `rt_cd=0`으로 정상 응답하면서 31번째가 조용히 사라진다(2026-07-31 실측). 그대로 두면 "이 테마는 이게 전부"라고 적게 된다. `multiQuoteParams`가 던지게 해 뒀으니 그 가드를 걷어내지 않는다.
5. **`.env`와 `.cache/`를 커밋하지 말 것.** (자격증명·토큰 포함)
6. **`shared`를 빌드 산출물로 참조하지 말 것.** `main`/`types`가 `src/index.ts`를 직접 가리킨다. 컴파일 단계 없이 소스로 소비된다.
7. **모의(`vts`)/실전(`prod`) 도메인을 하드코딩하지 말 것.** 반드시 `config.ts`의 `restBaseFor()` 표를 통한다. 조회(GET)의 도메인은 **자격증명이 정한다**(`KisCredentials.server`) — 토큰이 발급받은 서버에서만 통하므로 둘이 함께 다녀야 한다. **주문(POST)은 예외로 `config.restBase`에 고정**하고, 서버가 다른 자격증명이 들어오면 `orderServerMismatch()`가 보내기 전에 던진다. 실전 자격증명이 주문 경로로 새면 모의 환경인 줄 알고 실계좌에 주문이 나간다.

7-1. **앱키가 어느 서버용인지 짐작하지 말 것.** KIS는 알려주지 않고 앱키 문자열에도 표시가 없다. 사람이 `KIS_<id>_SERVER`(`prod`|`vts`)에 적으면 그것을 지키고, 안 적었으면 `APP_ENV`로 추정하되 **추정이라고 시작 로그에 적는다.** 적어 둔 값과 `APP_ENV`가 어긋나면 그 자격증명으로는 **주문도 조회도 보내지 않는다**(`readServerMismatch`) — 계좌 TR 이름이 `APP_ENV`로 갈려(`TTTC`/`VTTC`) 어차피 맞지 않고, 보내는 순간 그 서버의 토큰이 발급돼 캐시된다. 기본 자격증명이 어긋나면 `assertCredentials()`가 **서버를 못 뜨게 한다.** 예외는 개장일(`chk-holiday`) 하나뿐이고 `KisCredentials.crossServerRead`로 호출부가 밝힌다 — **다른 TR에 그 표시를 옮겨 붙이지 않는다.**

7-2. **서버 불일치 오류와 "그 기능이 없는 것"을 섞지 말 것.** `EGW02007`(실전 앱키를 모의 서버에)·`EGW02004`(모의 앱키를 실전 서버에)는 **짝 문제**지만 `EGW02006`(모의투자 TR이 아닙니다)은 앱키가 아니라 **모의 서버에 그 기능이 없는 것**이다. 가르는 표는 `kis/errorCodes.ts` 한 곳에 있다.
