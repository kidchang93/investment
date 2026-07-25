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

# 개발 모드: 백엔드(:4000) + 프론트(:5173) 동시 실행
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
| `KIS_<id>_ACCOUNT_NO` | | 계좌 `<id>`의 계좌번호. `12345678-01` 통합 표기 또는 앞 8자리 |
| `KIS_<id>_ACCOUNT_PRODUCT_CODE` | | 상품코드 2자리. 생략하면 `01`(종합위탁) |
| `KIS_PRIMARY_ACCOUNT_ID` | | 시세·실시간 WS에 쓸 기본 계좌 id. 생략하면 id 오름차순 첫 계좌 |
| `KIS_ACCOUNT_NO` | | 구버전 단일 계좌 방식. `KIS_APP_KEY`/`KIS_APP_SECRET`와 함께 쓴다 |
| `KIS_ACCOUNT_PRODUCT_CODE` | | 구버전 단일 계좌의 상품코드 2자리 |
| `APP_ENV` | | `vts`(모의, 기본) \| `prod`(실전) |
| `PORT` | | 백엔드 포트 (기본 4000) |
| `DATABASE_URL` | | 종목 마스터·매매 기록용 Postgres (기본 `postgresql://kis:kis_local@localhost:55432/kis`) |
| `WATCHLIST` | | `005930:삼성전자,000660:SK하이닉스` 형식. 비우면 기본 감시목록 사용 |
| `VITE_API_BASE` | | 프론트가 바라볼 백엔드 주소 (기본 `http://localhost:4000`) |

---

## docs/ 인덱스 — 작업 전 필독 매핑

| 작업 | 먼저 읽을 문서 |
|------|------|
| 모듈/데이터 흐름 파악, 새 파일 위치 결정 | `docs/ARCHITECTURE.md` |
| KIS 연동·정규화·타입 추가/변경 | `docs/DESIGN.md` |
| 코드 작성 (네이밍/패턴) | `docs/CODE_STYLE.md` |
| 리뷰·머지 전 점검 | `docs/REVIEW.md` |
| 서브에이전트로 작업 분배 | `docs/SUBAGENTS.md` |

---

## 절대 하지 말아야 할 것

1. **KIS 원본 필드명(약어)을 프론트로 노출하지 말 것.** `stck_prpr`, `prdy_ctrt` 같은 약어는 반드시 `backend/src/kis/`에서 `@invest/shared` 타입으로 정규화한 뒤 넘긴다. 프론트는 KIS 스펙을 몰라야 한다.
2. **인증 토큰 발급을 남발하지 말 것.** `access_token`은 발급 횟수 제한이 있어 `.cache/token-{env}-{계좌id}.json`으로 **앱키별로** 캐시한다 (구버전 단일 계좌는 `token-{env}.json`). 인증 로직을 바꿀 때 캐시 재사용을 깨지 않는다. 캐시는 백엔드 실행 디렉터리 기준이라 실제 경로는 `backend/.cache/`다.

2-1. **계좌 조회에 다른 계좌의 앱키를 쓰지 말 것.** KIS는 앱키에 등록된 계좌만 허용하고, 아니면 `INVALID_CHECK_ACNO`로 거부한다. 앱키/시크릿은 전역 값이 아니라 `KisAccountConfig`로 계좌와 함께 다닌다. 계좌 API를 추가할 때 `toCredentials(account)`를 `kisGetWithHeaders`에 넘겨야 한다.
3. **두 인증 엔드포인트의 시크릿 필드명 혼동 금지.** `/oauth2/tokenP` → `appsecret`, `/oauth2/Approval` → `secretkey`. 서로 다르다.
4. **실시간 프레임 파서의 상수를 임의로 바꾸지 말 것.** `H0STCNT0`의 `FIELDS_PER_RECORD = 46`, 필드 인덱스 매핑은 KIS 스펙에 고정돼 있다.
5. **`.env`와 `.cache/`를 커밋하지 말 것.** (자격증명·토큰 포함)
6. **`shared`를 빌드 산출물로 참조하지 말 것.** `main`/`types`가 `src/index.ts`를 직접 가리킨다. 컴파일 단계 없이 소스로 소비된다.
7. **모의(`vts`)/실전(`prod`) 도메인을 하드코딩하지 말 것.** 반드시 `config.ts`의 분기를 통한다.
