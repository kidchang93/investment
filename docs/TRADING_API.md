# TRADING_API

KIS 오픈API 매매 기능의 구현 현황과, 막혀 있는 항목의 이유·해결 방법을 정리한다.

> 스펙 출처: [koreainvestment/open-trading-api](https://github.com/koreainvestment/open-trading-api)
> (`examples_llm/domestic_stock/*`, `MCP/Kis Trading MCP/configs/domestic_stock.json`)

## 상태 범례

| 표시 | 의미 |
|------|------|
| ✅ 검증됨 | 실계좌(prod)로 호출해 `rt_cd=0` 응답을 확인함 |
| 🟡 미검증 | 코드는 완성됐지만 실제 호출로 확인하지 않음 |
| ⛔ 미구현 | 아직 구현하지 않음. 아래 "막혀 있는 항목" 참고 |

---

## 국내주식 조회

| 기능 | 엔드포인트 | TR_ID (실전 / 모의) | 우리 라우트 | 상태 |
|------|------|------|------|------|
| 주식잔고 | `trading/inquire-balance` | `TTTC8434R` / `VTTC8434R` | `GET /api/broker/kis/account` | ✅ |
| 매수가능 | `trading/inquire-psbl-order` | `TTTC8908R` / `VTTC8908R` | `GET /api/broker/kis/orderability` | ✅ |
| 일별 주문체결 | `trading/inquire-daily-ccld` | `TTTC0081R` / `VTTC0081R` | `GET /api/broker/kis/executions` | ✅ |
| 매도가능수량 | `trading/inquire-psbl-sell` | `TTTC8408R` / **모의 없음** | `GET /api/broker/kis/sellability` | ✅ |
| 정정취소가능주문 | `trading/inquire-psbl-rvsecncl` | `TTTC0084R` / **모의 없음** | `GET /api/broker/kis/open-orders` | ✅ |
| 예약주문 조회 | `trading/order-resv-ccnl` | `CTSC0004R` / **모의 없음** | `GET /api/broker/kis/reserved-orders` | ✅ |

### TR_ID 변경 이력 주의

KIS가 주문/계좌 TR_ID를 개편했다. 구 ID도 아직 응답하지만 **문서상 현행 ID를 쓴다.**

| 기능 | 구 TR_ID | 현행 TR_ID |
|------|------|------|
| 일별 주문체결(3개월 이내) | `TTTC8001R` | `TTTC0081R` |
| 일별 주문체결(3개월 이전) | `CTSC9115R` | `CTSC9215R` |
| 현금 매수 | `TTTC0802U` | `TTTC0012U` |
| 현금 매도 | `TTTC0801U` | `TTTC0011U` |
| 주문 정정취소 | `TTTC0803U` | `TTTC0013U` |
| 정정취소가능주문조회 | `TTTC8036R` | `TTTC0084R` |

> 구 ID(`TTTC8001R`)와 현행 ID(`TTTC0081R`) 둘 다 실계좌에서 `rt_cd=0`으로 응답하는 것을 확인했다.
> 언제 구 ID가 회수될지 알 수 없으므로 현행 ID만 쓴다.

---

## 국내주식 주문

| 기능 | 엔드포인트 | TR_ID (실전 / 모의) | 우리 라우트 | 상태 |
|------|------|------|------|------|
| 현금 매수·매도 | `trading/order-cash` | 매수 `TTTC0012U`/`VTTC0012U`, 매도 `TTTC0011U`/`VTTC0011U` | `POST /api/broker/kis/orders` | 🟡 |
| 주문 정정·취소 | `trading/order-rvsecncl` | `TTTC0013U` / `VTTC0013U` | `POST /api/broker/kis/orders/amend` | 🟡 |
| 예약주문 등록 | `trading/order-resv` | `CTSC0008U` / 모의 없음 | ⛔ | ⛔ |
| 예약주문 정정·취소 | `trading/order-resv-rvsecncl` | 취소 `CTSC0009U`, 정정 `CTSC0013U` | ⛔ | ⛔ |
| 신용 주문 | `trading/order-credit` | — | ⛔ | ⛔ |

### 주문 전송 시 실수하기 쉬운 지점

1. **`EXCG_ID_DVSN_CD`가 필수다.** 거래소ID구분코드로 국내 정규장은 `'KRX'`. 예전 스펙에는 없던 값이라 누락하면 접수되지 않는다.
2. **시장가/지정가 조합.** 시장가는 `ORD_DVSN='01'` + `ORD_UNPR='0'`, 지정가는 `ORD_DVSN='00'` + 실제 단가.
3. **`SLL_TYPE`은 매도에만.** `01` 일반매도. 매수에는 빈 문자열을 넣는다.
4. **주문 응답의 두 값을 반드시 보관한다.** `ODNO`(주문번호)와 `KRX_FWDG_ORD_ORGNO`(주문채번지점번호). 둘 다 없으면 정정·취소를 보낼 수 없다.
5. **정정·취소는 원주문의 `ORD_DVSN`을 그대로 되돌려줘야 한다.** 정정취소가능주문조회 결과의 `ord_dvsn_cd`를 그대로 넘긴다.
6. **`QTY_ALL_ORD_YN='Y'`면 잔량 전부**가 대상이고 `ORD_QTY`는 무시된다.

---

## 실주문 게이트

기본값은 **항상 차단**이다. `GET /api/broker/kis/live-order-gate`가 막힌 이유를 그대로 알려준다.

열리기 위한 조건:

1. `KIS_LIVE_ORDER_ENABLED=true` (서버 환경 변수)
2. 등록된 KIS 계좌가 1개 이상
3. 요청 body의 `confirmationPhrase`가 정확히 `실주문 전송`
4. 국내 주식·ETF·ETN 종목 (지수·선물·야간 프록시는 거부)
5. 수량 > 0, 지정가면 단가 > 0

체크박스 대신 **문구 입력**을 서버가 검증한다. 클릭 한 번으로 오발주가 나가지 않게 하려는 의도다.

### 확인된 차단 동작

| 요청 | 결과 |
|------|------|
| 게이트 꺼짐 | `403` + `gate.blockers` |
| 확인 문구 불일치 | `400` |
| 수량 0 | `400` |
| 지정가인데 단가 없음 | `400` |
| 야간 프록시 종목 | `400` |
| 미등록 `accountId` | `404` |

전부 KIS에 도달하기 전에 거부된다.

---

## 막혀 있는 항목과 해결 방법

### 1. 실주문 전송은 사람이 직접 확인해야 한다

**이유.** AI 에이전트는 주식 매수·매도를 대신 실행하지 않는다. 그래서 `order-cash` /
`order-rvsecncl`은 코드만 완성돼 있고 실제 전송 검증이 비어 있다(🟡).

**해결 방법.**

```bash
# 1) 모의투자 계좌로 먼저 확인하는 것을 권한다 (아래 2번 참고)
# 2) 서버에서 게이트를 연다
KIS_LIVE_ORDER_ENABLED=true npm run dev:api

# 3) 체결 가능성이 낮은 지정가로 1주만 넣어 접수만 확인한다
curl -X POST http://localhost:4000/api/broker/kis/orders \
  -H 'content-type: application/json' \
  -d '{"accountId":"21","instrumentId":"KR:KOSPI:005930","side":"buy",
       "orderType":"limit","quantity":1,"limitPrice":100,
       "confirmationPhrase":"실주문 전송"}'

# 4) 응답의 orderNo / orderBranchNo로 즉시 취소한다
curl -X POST http://localhost:4000/api/broker/kis/orders/amend \
  -H 'content-type: application/json' \
  -d '{"accountId":"21","action":"cancel","orderNo":"<ODNO>",
       "orderBranchNo":"<KRX_FWDG_ORD_ORGNO>","orderTypeCode":"00",
       "quantityAll":true,"confirmationPhrase":"실주문 전송"}'
```

> 지정가 100원처럼 현재가와 크게 떨어진 값은 접수는 되지만 체결되지 않아 접수 경로만 확인할 수 있다.
> 확인 후 반드시 취소하고 `KIS_LIVE_ORDER_ENABLED`를 다시 내린다.

### 2. 일부 API는 모의투자(vts)를 지원하지 않는다

**이유.** KIS 공식 예제에 모의 분기(`VTTC*`)가 없는 API가 있다.

- 매도가능수량 `TTTC8408R`
- 정정취소가능주문조회 `TTTC0084R`
- 예약주문 계열 `CTSC0008U` / `CTSC0009U` / `CTSC0013U` / `CTSC0004R`

**해결 방법.** 이 세 가지는 `APP_ENV=prod`에서만 쓴다. 모의 환경에서 화면이 비어야 한다면
대체 경로를 쓴다.

- 매도가능수량 → 잔고조회(`VTTC8434R`)의 `hldg_qty`로 근사. 미결제·대주 상황은 반영되지 않는다.
- 정정취소가능주문 → 체결내역(`VTTC0081R`)에서 `CCLD_DVSN='02'`(미체결)로 필터.

### 3. 실시간 주문·체결 통보(H0STCNI0)가 미구현이다

**이유.** 시세 통보(`H0STCNT0`)와 달리 체결통보 프레임은 **AES256으로 암호화**되어 온다.
구독 응답에 담긴 KEY/IV로 복호화해야 하고, 기존 `realtime.ts`의 평문 파서로는 읽을 수 없다.
모의투자는 `H0STCNI9`로 TR_ID가 갈린다.

**해결 방법.**

1. 구독 요청은 `tr_key`에 **HTS ID**를 넣는다 (종목코드가 아니다).
2. 구독 성공 응답 body의 `output.key` / `output.iv`를 보관한다.
3. 이후 수신 프레임 payload를 `AES-256-CBC`로 복호화한다 (Node `crypto.createDecipheriv`).
4. 복호화한 문자열을 `^`로 분리한다. **14번째 값 `CNTG_YN`이 `2`면 체결 통보, `1`이면
   주문·정정·취소·거부 접수 통보**다.
5. `shared`에 정규화 타입을 만들고 `ServerMessage` 유니언에 variant를 추가한 뒤
   `useStream.ts`의 소비부도 함께 갱신한다 (`docs/DESIGN.md`의 "새 실시간 TR 구독 추가" 절차).

### 4. 해외주식 주문이 미구현이다

**이유.** 국내와 TR_ID·파라미터 체계가 다르다. 거래소코드(`OVRS_EXCG_CD`), 통화, 주문구분이
시장마다 갈리고 미국은 주간(`TTTT1002U`/`TTTT1006U`)과 야간거래가 또 나뉜다.
현재 `Instrument` 모델에는 주문에 필요한 거래소·통화 매핑이 완성돼 있지 않다.

**해결 방법.** `overseas-stock/v1/trading/order`를 별도 함수로 분리하고, 시장별 TR_ID 맵을
`kis/` 안에 둔다. 계정 통화(`baseCurrency`)와 종목 통화가 다른 문제는 주문 티켓의
기존 통화 검증 로직을 확장해 처리한다.

### 5. 계좌마다 앱키가 다르다 (교차 조회 불가)

**이유.** KIS는 앱키에 등록된 계좌만 허용한다. 다른 계좌를 넣으면 `INVALID_CHECK_ACNO`다.
실측 결과:

| | 계좌 21 | 계좌 23 |
|---|---|---|
| 앱키 21 | ✅ | ❌ `INVALID_CHECK_ACNO` |
| 앱키 23 | ❌ `INVALID_CHECK_ACNO` | ✅ |

**해결 방법.** 이미 반영돼 있다. `KisAccountConfig`가 앱키/시크릿을 계좌와 함께 들고 다니고,
토큰·approval_key도 앱키별로 캐시한다. 계좌를 추가할 때 `KIS_<id>_ACCOUNT_NO`,
`KIS_APP_KEY_<id>`, `KIS_APP_SECRET_<id>` **3종을 모두** 넣어야 인식된다.

### 6. 토큰 발급에 호출 제한이 있다

**이유.** `access_token`은 24h 유효이고 발급 횟수·빈도 제한이 있다(같은 앱키로 연속 발급 시 거부).

**해결 방법.** 이미 반영돼 있다. `backend/.cache/token-{env}-{계좌id}.json`으로 앱키별 파일 캐시를
쓰고, 동시 요청이 중복 발급하지 않도록 in-flight Promise를 공유한다. 캐시 경로는 백엔드
실행 디렉터리 기준이라 실제로는 `backend/.cache/`에 쌓인다.

### 7. 장 시간 밖에서는 접수되지 않는다

**이유.** 정규장(09:00~15:30) 밖에서 `order-cash`를 보내면 KIS가 거부한다. 시간외단일가·
장전시간외는 `ORD_DVSN` 코드가 따로 있다.

**해결 방법.** 주문 전송 전에 `chk_holiday`(국내휴장일조회)로 영업일을 확인하고, 세션에 맞는
`ORD_DVSN`을 고른다. 현재는 정규장 지정가(`00`)/시장가(`01`)만 지원한다.

---

## 화면 연결 상태

| 화면 | 붙은 기능 |
|------|------|
| 주문 티켓 | 실계좌 매수가능(매수) / 매도가능수량(매도), 한도 초과 참고 경고 |
| 주문 티켓 · 실계좌 주문 | 게이트 상태 배지, 확인 문구 입력, 전송 버튼 |
| 주문 티켓 · 미체결 주문 | 목록 + 정정(단가 입력) / 취소 |
| 포트폴리오 | 실계좌 잔고, 주문·체결 감사 기록, 예약주문 목록 |

전송 버튼은 **서버 게이트와 프런트 검증을 모두 통과해야** 열린다. 확인 문구를 정확히
입력해도 `KIS_LIVE_ORDER_ENABLED`가 꺼져 있으면 잠긴 채로 남는 것을 확인했다.

## 다음 작업 순서

1. 사용자가 위 1번 절차로 주문 접수·취소 경로를 검증 (🟡 → ✅)
2. 주문 전송/응답/체결/정정취소를 `trading_order_events`에 기록
3. 실시간 주문체결통보(H0STCNI0) 복호화 구현
4. 예약주문 등록·취소
5. 해외주식 주문
