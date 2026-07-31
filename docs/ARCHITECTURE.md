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
├── quoteCache.ts      # 현재가 캐시(45초). ★시각을 다시 찍지 않는다 — 나이는 Quote.fetchedAt 하나뿐
├── themes/
│   └── pulse.ts       # 테마 등락률: DB 명단 + 멀티시세 → 집계 (순수 함수 + 호출 예산)
└── kis/               # KIS 연동 레이어 (원본 스펙을 여기서만 다룬다)
    ├── auth.ts        # access_token(REST, 파일캐시) / approval_key(WS, 메모리)
    ├── rest.ts        # 일봉(getDailyCandles)·현재가(getQuote/getDomesticQuotes) 조회 + 정규화
    ├── normalize.ts   # KIS 원본 문자열 → 숫자·부호 (rest/multiQuote가 같은 규칙을 쓴다)
    ├── multiQuote.ts  # 멀티시세(FHKST11300006) 요청 조립 + 응답 자리 검산
    ├── realtime.ts    # KisRealtime: 실시간 체결 WS 클라이언트 (EventEmitter)
    ├── domesticMaster.ts     # 국내 종목 마스터(.mst) 고정폭 레이아웃 + 행 파서
    ├── indexSectorMaster.ts  # 지수·업종 코드 마스터(idxcode.mst) 레이아웃 + 코드→이름 표
    ├── themeMaster.ts        # 테마 코드 마스터(theme_code.mst) 레이아웃 + (테마,종목) 쌍
    ├── masterArchive.ts      # 공개 마스터 zip 풀기 (단일 엔트리 + ★내부 타임스탬프 + CRC 검증)
    ├── masterDownload.ts     # 공개 마스터 받기: 검증 뒤 갈아끼우기, 실패하면 기존 파일 유지
    └── fixtures/             # 실계좌로 받은 실제 응답 + 실제로 받은 마스터 zip
                              # (시험이 읽는다. 지어낸 모양이 아니다)
```

`multiQuote.ts`를 `rest.ts`에서 떼어 둔 이유는 마스터 파서들과 같다 — **자리(순서)를
맞추는 계산**이라 시험으로 못 박아야 하고, 그 시험이 네트워크·DB 없이 돌아야 한다.
`rest.ts`는 HTTP만 치고 해석은 이 모듈이 한다.

`quoteCache.ts`를 `server.ts`에서 떼어 둔 이유도 시험이다. 캐시가 라우트 안에 인라인으로
있던 동안에는 "적중일 때 어떤 시각이 나가는가"를 서버를 띄우지 않고 잴 방법이 없었고,
그래서 45초 묵은 값이 표시 없이 나갔다. 시각(`now`)을 인자로 받아 시계를 갈아 끼우지
않고 45초 경계를 잰다. 자세한 규칙은 `docs/DESIGN.md`의 「시세의 나이」 절.

마스터 파일은 **파일 하나에 모듈 하나**다. 파일마다 고정폭 레이아웃이 다르고, 한 자리만
밀려도 뒤 필드가 전부 어긋나기 때문에 자리 계산을 한곳에 모아 둔다. 자리 계산은 이
모듈들 안에서만 하고 `scripts/syncInstruments.ts`는 정규화(코드에 이름 붙이기, DB 형태로
바꾸기)만 한다.

`npm run sync:instruments` 하나가 **받기 → 종목 → 업종 → 테마** 순서로 다 넣는다. 테마를
별도 스크립트로 빼지 않은 이유는 테마가 종목코드를 `instruments.id`로 맞춰 저장하기
때문이다 — 순서가 뒤집히거나 한쪽만 돌면 "종목은 새것, 테마 연결은 옛것"이 된다.

받기(`masterDownload.ts`)가 맨 앞에 붙은 것도 같은 이유다. 예전에는 사람이 손으로
`backend/.cache`에 넣었고 그래서 파일이 20일~9개월 묵어도 아무도 몰랐다. 국내 5종
(`kospi`·`kosdaq`·`konex`·`idxcode`·`theme_code`)만 받는다 — 해외(`*MST.COD`)·선물
(`ffcode.mst`)은 경로와 형식이 달라 아직 손으로 넣는다. 자세한 규칙은
`docs/DESIGN.md`의 「공개 마스터 파일 받기」 절.

### 종목 분류 두 축

| 축 | 저장 | 관계 | 출처 |
|------|------|------|------|
| 지수업종 | `instruments.sector_*` 컬럼 | 종목당 대 1 + 중 1 | `kospi/kosdaq_code.mst` 꼬리 + `idxcode.mst` |
| 테마 | `themes` + `theme_instruments` | **종목당 N개** (평균 2.37, 최대 16) | `theme_code.mst` |

업종에는 `반도체`라는 칸이 아예 없다. 삼성전자와 에코프로비엠이 같은 `제조 / 전기·전자`,
한화에어로스페이스와 한화오션이 같은 `제조 / 운송장비·부품`이다. 분야별로 돈이 어디로
도는지 보려면 테마가 필요하다. 자세한 설계는 `docs/DESIGN.md`의 「테마 분류」 절.

테마를 꺼내는 길은 셋이다. **앞의 둘은 DB만 보고 KIS를 부르지 않는다.**

| 라우트 | 하는 일 | KIS 호출 |
|------|------|------|
| `GET /api/themes` | 테마 목록. 잴 수 있는 것(`themes`)과 종목을 하나도 못 찾은 것(`emptyThemes`)을 갈라서 준다 | 0회 |
| `GET /api/themes/:code` | 테마 하나의 종목 + `missingSymbols` | 0회 |
| `GET /api/themes/pulse?codes=` | 테마들의 지금 등락률 | 30종목당 1회, 한 요청 8회까지 |

`pulse`는 **여러 테마를 한 번에** 받는다. 테마끼리 종목이 겹치므로(종목당 평균 2.37개)
합집합을 한 번에 물어야 같은 종목을 여러 번 묻지 않는다. 예산을 넘기면 **테마 단위로
통째로 빼고**(`skipped`) 사유를 함께 준다 — 110종목 중 30종목만 보고 낸 값을 "반도체 테마
등락률"이라 부를 수 없다.

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

`테마` 탭은 DB의 테마 302개를 그린다. 예전에는 여기에 `THEME_FLOW_ITEMS`(6테마 × 종목 2개)가
박혀 있어서 **한 제품 안에 `반도체` 테마가 둘** 있었다 — 화면의 반도체는 005930·000660
둘이었고 DB의 `반도체/반도체장비`는 110(101)종목이었다. 박힌 쪽을 지웠다. 시세는 자동으로
받지 않는다. 목록은 열 때 한 번(KIS 0회), 등락률은 **사용자가 `지금 재기`를 누를 때만**
받고 몇 회가 나가는지 버튼 옆에 적는다.

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
│                  # ★사유와 그 순서는 `verdictFor` 한 곳에 있다
├── screening.ts   # 같은 판정을 화면에 보이게 (거른 것도 사유와 함께 돌려준다)
├── autoTrader.ts  # 러너 (주기 실행, 목표·중단선·연속 실패 시 자동 정지)
├── runCandles.ts  # 한 회차의 분봉 재료: 무엇을 받을지 + 받은 게 오늘 것인지 (순수 함수)
├── backtest.ts    # 성과 측정 (다음 봉 시가 체결, 비용 차감, in/out-of-sample)
└── rangeExpansion.ts  # 문턱을 정하려고 재는 계산 (순수 함수, 아래 참고)
```

`runCandles.ts`를 `autoTrader.ts`에서 떼어 둔 이유는 시험이다. 러너가 무엇을
근거로 주문을 내는지가 여기 있는데, `loadCandles` 안에 인라인으로 있는 동안에는
실계좌를 띄우지 않고 잴 방법이 없었다. 시각(`now`)을 인자로 받아 시계를 갈아
끼우지 않고 날짜 경계를 잰다 — `quoteCache.ts`와 같은 방식이다.

두 가지를 정한다.

| | 규칙 | 왜 |
|------|------|------|
| `checkCandleDay` | **마지막 봉이 KST 오늘이 아니면 제외** | 그 날짜에 봉이 없으면 KIS가 이전 거래일 것을 `MCA00000 정상처리`로 채워 준다. 날짜를 안 보면 개장 직후에 **어제 15:30 종가로 신호와 주문 수량**이 나온다 |
| `candleTargets` | **보유 종목이 먼저고 예산에 잘리지 않는다** | 후보 필터에서 빠진 보유 종목은 매도 신호가 아예 날 수 없다. 현금을 다 써서 산 다음 회차가 특히 그렇다 |

제외는 `신호 없음`이 아니라 **제외**로 기록에 남는다. "볼 것을 다 보고 낼 신호가
없었다"와 "볼 수가 없었다"는 다른 사실이다. 장전·휴장일에는 전 종목이 제외되는데,
그 시각에 오늘 값이 존재하지 않으므로 맞는 동작이다. **시계로 가르지 않는다** —
휴장일을 아는 것은 서버(`chk-holiday`)지 이 계산이 아니라서, 시계로 가르면
휴장일에 같은 결함이 그대로 돌아온다. 근거 실측은 `docs/USER_FINDINGS.md`.

한 회차 분봉 호출 수는 `max(MAX_CANDIDATES_PER_RUN, 보유 종목 수)`다. 보유에
예산을 걸지 않는 것은 자르는 순간 못 파는 종목이 생기기 때문이고, 대신 후보가
남은 자리만 쓴다 — 나가는 문이 들어오는 문보다 앞이다.

후보 거르기의 문턱(`MIN_DAILY_TURNOVER`·`MAX_COST_SHARE_OF_RANGE`)은 **재서**
정한다. `rangeExpansion.ts`는 그 측정의 계산부고, 실제로 재는 것은
`scripts/measureRangeExpansion.ts`(KIS로 과거 분봉을 받아 재구성) →
`scripts/analyzeRangeExpansion.ts`(받아 둔 표본만 읽어 해석) 두 단계다.
받는 것과 해석하는 것을 갈라 둔 이유는, 종목·하루당 KIS 5회가 나가므로 보는
각도를 바꿀 때마다 다시 받을 수 없기 때문이다. 잰 결과는 `docs/USER_FINDINGS.md`.

### `backend/src/scripts/` — 조사용 스크립트의 KIS 경계

**일회성 조사 스크립트는 KIS를 직접 부른다.** `captureAuction.ts`·`dumpQuoteRaw.ts`·
`probeIntradayHistory.ts`·`measureRangeExpansion.ts`가 `config.restBase`와
`getAccessToken(primaryCredentials)`로 직접 URL을 짜고 원본 필드명을 읽는다.
"무엇이 오는지"를 확인하려고 만든 것이라 정규화하면 그 목적이 사라진다.

**이 예외는 `scripts/`까지다.** 원본 필드가 `server.ts`나 프론트로 흘러가면 안
된다는 규칙은 그대로다. 어떤 조사 경로가 화면 기능이 되면 그때 `kis/`로 옮긴다 —
`measureRangeExpansion.ts`의 날짜 지정 분봉 조회가 그 후보다(지금
`getInstrumentIntradayCandles`는 오늘 날짜가 박혀 있고 120봉만 준다).

후보에서 빠진 사유(`ScreeningVerdict`)는 **자동매매와 화면이 같은 함수**로 낸다 —
`verdictFor(quote, elapsed, cash)`. 예전에는 `loadAutoTraderCandidates`와
`runScreening`이 순서를 각자 들고 있어, 한쪽만 고치면 화면의 사유와 실행 기록의
사유가 조용히 갈라졌다. 순서는 `noOrderBook` → `tooExpensive` → `illiquid` →
`costHeavy`이고 근거는 `docs/DESIGN.md`의 「호가가 없는 종목」 절에 있다.

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
| 현재가 (1종목) | REST GET | `inquire-price` / `FHKST01010100` |
| 현재가 (최대 30종목) | REST GET | `intstock-multprice` / `FHKST11300006` |
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
