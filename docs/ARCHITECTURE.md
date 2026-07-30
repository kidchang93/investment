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
    ├── realtime.ts    # KisRealtime: 실시간 체결 WS 클라이언트 (EventEmitter)
    └── domesticMaster.ts  # 국내 종목 마스터(.mst) 고정폭 레이아웃 + 행 파서
```

레이어 규칙:
- **`kis/`만 KIS 원본 필드·엔드포인트·TR_ID를 안다.** 바깥(`server.ts`)은 정규화된 `@invest/shared` 타입만 받는다.
- `server.ts`는 조립(wiring)만 담당한다. 비즈니스 로직을 `server.ts`에 두지 않는다.

## frontend 레이어

```
frontend/src/
├── main.tsx           # 진입점 (createRoot)
├── App.tsx            # 레이아웃: 본문 패널 + 오른쪽 사이드바, 상태 오케스트레이션
├── Chart.tsx          # lightweight-charts 캔들 차트 (일봉 + 실시간 업데이트)
├── useStream.ts       # /stream WebSocket 훅 (자동 재접속, 종목별 최신 체결)
├── api.ts             # REST 클라이언트 (watchlist, candles)
├── config.ts          # API_BASE / STREAM_URL 파생
└── styles.css         # 다크 테마 스타일
```

### 화면 구성 (`AppPage`)

상단 네비게이션의 세 항목이 곧 `AppPage`다. 라벨과 실제 내용이 어긋나지 않게 둔다.

| `AppPage` | 라벨 | 내용 |
|------|------|------|
| `market` | 종목 | 차트 + 오른쪽 사이드바(주문·관심·탐색) |
| `portfolio` | 내 계좌 | 잔고, 주문·체결 내역, 매매손익, 자동매매, 리스크 룰, 예약주문 |
| `terminal` | 발견 | 야간 지표 + 하위 탭 13개 (아래 네 묶음) |

`발견`의 하위 탭은 `TERMINAL_TAB_GROUPS`에 묶어 둔다. 13개를 한 줄에 평평하게 늘어놓으면
라벨만 봐서는 히트맵·랭킹·테마가 어떻게 다른지 알 수 없다. 줄은 하나로 두고 그룹 라벨과
구분선만 넣는다.

| 묶음 | 탭 |
|------|------|
| 시세 | 대시보드, 히트맵, 랭킹, 테마, 매크로 |
| 뉴스·일정 | 뉴스룸, 캘린더, 리포트 |
| 커뮤니티 | 라운지, 채팅 |
| 도구 | 수수료, 스크리닝, 모의투자 |

저장값 검증처럼 그룹이 필요 없는 곳은 `TERMINAL_TAB_OPTIONS`(평탄한 목록)를 쓴다.

오른쪽 사이드바(`SidePanelTab`)는 `order` / `watch` / `discover` 셋이며 `market`에서만 뜬다.
주문 티켓은 `order` 탭 안에서만 렌더된다 — 차트를 보면서 주문할 수 있어야 하기 때문이다.

> 예전에는 `trade` 화면이 따로 있었으나 상단 네비에 버튼이 없어 포트폴리오 표의 행을
> 눌러야만 닿았고, 새로고침하면 저장값 검증에서 걸러졌다. 주문을 `market`의 사이드바
> 탭으로 옮기면서 없앴다. 매수가능금액·매도가능수량·미체결처럼 KIS를 때리는 조회는
> `isOrderPanelOpen`(= `market` + `order` 탭)에 묶어 차트만 볼 때는 나가지 않게 한다.

### 자동매매

러너는 **서버 메모리**에 산다. 화면은 상태를 받아 보여줄 뿐이고, 시작·정지도
서버에 요청한다. 서버가 재시작되면 멈춘 상태로 시작한다 — 사람이 모르는 사이에
되살아나 주문을 내는 쪽이 더 위험하다. 실행 기록만 DB(`trading_auto_runs`)에
남아 재시작 뒤에도 무슨 일이 있었는지 볼 수 있다.

```
backend/src/trading/
├── strategy.ts    # Strategy 인터페이스 + 이동평균 교차 / 변동성 돌파 / 평균 회귀
├── universe.ts    # 후보 고르기 (국내 주문 가능 + 살 수 있는 가격 + 리스크 룰)
├── autoTrader.ts  # 러너 (주기 실행, 목표·중단선·연속 실패 시 자동 정지)
└── backtest.ts    # 성과 측정 (다음 봉 시가 체결, 비용 차감, in/out-of-sample)
```

안전 순서는 **전략 → 러너 → 리스크 룰 → 게이트**다. 전략은 "무엇을 살지"만
정하고 "내도 되는지"는 뒤쪽이 본다. 전략이 안전장치를 알면 두 곳에서 같은
판단을 하게 되고 한쪽만 고치면 조용히 어긋난다.

`dry_run`은 주문을 만들되 KIS로 보내지 않는다. `live`는 서버 게이트가 열려
있어야 **시작조차** 된다 — 닫힌 채로 시작하면 매 회차 거부되며 기록만 쌓여
켜졌다고 착각하기 쉽다.

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
| 실시간 주문·체결 통보 | WebSocket | `H0STCNI0`(실전) · `H0STCNI9`(모의). payload가 AES-256-CBC 암호화 |
| 국내주식 잔고 | REST GET | `inquire-balance` / `TTTC8434R`(실전) · `VTTC8434R`(모의) |
| 매수가능 조회 | REST GET | `inquire-psbl-order` / `TTTC8908R`(실전) · `VTTC8908R`(모의) |
| 일별 주문체결 | REST GET | `inquire-daily-ccld` / `TTTC0081R`(실전) · `VTTC0081R`(모의) |
| 매도가능수량 | REST GET | `inquire-psbl-sell` / `TTTC8408R` (모의 미지원) |
| 정정취소가능주문 | REST GET | `inquire-psbl-rvsecncl` / `TTTC0084R` (모의 미지원) |
| 예약주문 조회 | REST GET | `order-resv-ccnl` / `CTSC0004R` (모의 미지원) |
| 기간별 매매손익 | REST GET | `inquire-period-trade-profit` / `TTTC8715R` (모의 미지원) |
| 국내 개장일 | REST GET | `chk-holiday` / `CTCA0903R` |
| 현금 주문 | REST POST | `order-cash` / 매수 `TTTC0012U` · 매도 `TTTC0011U` |
| 주문 정정·취소 | REST POST | `order-rvsecncl` / `TTTC0013U` |

> KIS가 주문/계좌 TR_ID를 개편했다. 구 ID(`TTTC8001R`, `TTTC0802U` 등)도 아직 응답하지만
> 현행 ID만 쓴다. 전체 대응표와 막힌 항목은 `docs/TRADING_API.md` 참고.

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
