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

도메인은 `config.ts`에서 `vts`(모의) / `prod`(실전)로 분기한다.
