# ARCHITECTURE

## 전체 구조

```
┌────────────┐   REST  /api/*         ┌─────────────────────────────┐   REST   ┌──────────────┐
│  frontend  │ ─────────────────────▶ │           backend            │ ───────▶ │   KIS 오픈API  │
│ (React/Vite)│                        │          (Fastify)           │          │  REST/WS 서버  │
│            │ ◀───── WS /stream ───── │  + WebSocketServer(/stream)  │ ◀─ WS ── │              │
└────────────┘   ServerMessage         │  + KisRealtime(단일 WS 연결)  │          └──────────────┘
                                       └─────────────────────────────┘
                          ▲                                    ▲
                          └──────── @invest/shared 타입 ────────┘  (양쪽이 공유)
```

- 프론트는 KIS를 직접 호출하지 않는다. 모든 외부 연동은 백엔드가 중계한다.
- 백엔드는 KIS 실시간 WebSocket에 **단일 연결**을 맺어 감시목록 전 종목을 구독하고, 붙은 프론트 클라이언트 전체에 broadcast한다.

## 워크스페이스 & 의존성 방향

```
frontend ──▶ @invest/shared ◀── backend
   (프론트와 백엔드는 서로 의존하지 않는다. 오직 shared 타입만 공유)
```

- `shared`는 어디에도 의존하지 않는 순수 타입 패키지다.
- 의존성은 항상 `shared` 쪽으로만 향한다. `shared`가 `backend`/`frontend`를 참조하면 안 된다.

## backend 레이어

```
backend/src/
├── server.ts          # 진입점. Fastify REST + WS 서버 조립, KisRealtime 기동
├── config.ts          # .env 로드, vts/prod 도메인·자격증명 분기
├── watchlist.ts       # 감시 종목 (env 오버라이드 → 없으면 기본값)
└── kis/               # KIS 연동 레이어 (원본 스펙을 여기서만 다룬다)
    ├── auth.ts        # access_token(REST, 파일캐시) / approval_key(WS, 메모리)
    ├── rest.ts        # 일봉(getDailyCandles)·현재가(getQuote) 조회 + 정규화
    └── realtime.ts    # KisRealtime: 실시간 체결 WS 클라이언트 (EventEmitter)
```

레이어 규칙:
- **`kis/`만 KIS 원본 필드·엔드포인트·TR_ID를 안다.** 바깥(`server.ts`)은 정규화된 `@invest/shared` 타입만 받는다.
- `server.ts`는 조립(wiring)만 담당한다. 비즈니스 로직을 `server.ts`에 두지 않는다.

## frontend 레이어

```
frontend/src/
├── main.tsx           # 진입점 (createRoot)
├── App.tsx            # 레이아웃: 감시목록 사이드바 + 차트 패널, 상태 오케스트레이션
├── Chart.tsx          # lightweight-charts 캔들 차트 (일봉 + 실시간 업데이트)
├── useStream.ts       # /stream WebSocket 훅 (자동 재접속, 종목별 최신 체결)
├── api.ts             # REST 클라이언트 (watchlist, candles)
├── config.ts          # API_BASE / STREAM_URL 파생
└── styles.css         # 다크 테마 스타일
```

## 데이터 흐름

### 1) 일봉 (REST, 종목 선택 시 1회)
```
App: 종목 선택 → fetchCandles(code) → GET /api/candles/:code
  → backend getDailyCandles() → KIS FHKST03010100 → Candle[] 정규화(오름차순)
  → Chart.setData()
```

### 2) 실시간 체결 (WebSocket, 지속)
```
KIS WS(H0STCNT0) ─raw frame─▶ KisRealtime.onMessage() ─parse─▶ 'trade' 이벤트(Trade)
  → server.broadcast({type:'trade'}) ─WS /stream─▶ useStream ─▶ trades[code] 갱신
  → App 리렌더(가격/등락) + Chart.update(오늘 캔들 OHLC)
```

### 3) 연결 상태
```
KisRealtime open/close → 'status' 이벤트 → broadcast({type:'status'})
  → useStream.kisConnected → App 헤더 상태 표시
신규 프론트 접속 시: server가 현재 kis.isConnected 스냅샷을 즉시 1회 전송
```

## 외부 시스템 연동 (KIS)

| 용도 | 프로토콜 | 엔드포인트 / TR_ID |
|------|------|------|
| access_token 발급 | REST POST | `/oauth2/tokenP` |
| approval_key 발급 | REST POST | `/oauth2/Approval` |
| 일봉 시세 | REST GET | `inquire-daily-itemchartprice` / `FHKST03010100` |
| 현재가 | REST GET | `inquire-price` / `FHKST01010100` |
| 실시간 체결 | WebSocket | `H0STCNT0` |
| 국내주식 잔고 | REST GET | `inquire-balance` / `TTTC8434R`(실전) · `VTTC8434R`(모의) |
| 매수가능 조회 | REST GET | `inquire-psbl-order` / `TTTC8908R`(실전) · `VTTC8908R`(모의) |
| 일별 주문체결 | REST GET | `inquire-daily-ccld` / `TTTC8001R`(실전) · `VTTC8001R`(모의) |

도메인은 `config.ts`에서 `vts`(모의) / `prod`(실전)로 분기한다.
**계좌 관련 TR_ID는 실전/모의 접두어(`TTTC`/`VTTC`)가 다르므로 `config.env` 분기로만 고른다.**

## 다계좌 자격증명 모델

KIS는 **앱키에 등록된 계좌만** 조회를 허용한다 (다른 계좌를 넣으면 `INVALID_CHECK_ACNO`).
그래서 앱키/시크릿은 전역 값이 아니라 계좌와 1:1로 묶인다.

```
config.kisAccounts: KisAccountConfig[]   # {id, label, appKey, appSecret, cano, productCode}
        │
        ├─ 계좌 API (잔고·매수가능·체결) → toCredentials(account) → 그 계좌의 앱키로 호출
        └─ config.appKey/appSecret       → 기본 계좌 1개의 앱키 (시세·종목마스터·실시간 WS 전용)
```

- env 규칙: `KIS_<id>_ACCOUNT_NO` + `KIS_APP_KEY_<id>` + `KIS_APP_SECRET_<id>` **3종이 모두 있어야** 한 계좌로 인정한다.
- 기본 계좌는 `KIS_PRIMARY_ACCOUNT_ID`, 없으면 id 오름차순 첫 계좌. 실행마다 바뀌지 않도록 정렬한다.
- 시세·실시간은 계좌와 무관하므로 기본 계좌의 앱키로 고정해 호출 한도를 한곳에 모은다.
- `access_token`·`approval_key`는 **앱키별로** 캐시한다 (`auth.ts`). 한 캐시를 공유하면 다른 앱키의 토큰으로 호출해 계좌 조회가 조용히 실패한다.
- 계좌번호(`CANO`)·상품코드(`ACNT_PRDT_CD`)는 서버 환경 변수에서만 읽고, 프론트로는 `maskKisAccount()`로 마스킹한 표시용 문자열과 `accountId`/`label`만 나간다.
- 라우트는 `?accountId=`로 계좌를 고른다. 생략하면 기본 계좌, 등록되지 않은 id면 404다.
