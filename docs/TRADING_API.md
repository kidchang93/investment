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
| 기간별 매매손익 | `trading/inquire-period-trade-profit` | `TTTC8715R` / **모의 없음** | `GET /api/broker/kis/trade-profit` | ✅ |
| 국내 개장일 | `quotations/chk-holiday` | `CTCA0903R` | (리스크 룰 내부) | ✅ |

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
| 예약주문 등록 | `trading/order-resv` | `CTSC0008U` / 모의 없음 | `POST /api/broker/kis/reserved-orders` | 🟡 |
| 예약주문 취소 | `trading/order-resv-rvsecncl` | `CTSC0009U` / 모의 없음 | `POST /api/broker/kis/reserved-orders/cancel` | 🟡 |
| 예약주문 정정 | `trading/order-resv-rvsecncl` | `CTSC0013U` | ⛔ | ⛔ |
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

**먼저 만족해야 하는 조건.**

| 조건 | 이유 |
|------|------|
| **개장일 09:00~15:30 (KST)** | 리스크 룰이 휴장일·시간대를 막는다. 주말엔 아예 못 보낸다 |
| **지정가가 ±30% 가격제한폭 안** | 밖이면 KIS가 거부한다. **1원·100원 같은 값은 통하지 않는다** |
| **지정가 × 수량 ≤ 매수가능금액** | 부족하면 KIS가 거부한다. `GET /api/broker/kis/orderability`로 확인 |
| `KIS_LIVE_ORDER_ENABLED=true` | 게이트 |

앞의 두 조건이 서로 잡아당긴다. **체결되지 않게 하려면 하한가 근처로 낮춰야 하는데,
하한가는 현재가의 70%라 예수금이 그만큼 필요하다.** 예수금이 적으면 저가 종목을 골라야 한다.

필요 예수금 ≈ `현재가 × 0.7 × 수량`. 예: 현재가 249,500원짜리를 1주 테스트하려면 약 175,000원이 든다.

**절차.**

```bash
# 1) 게이트를 연다 (.env를 고치지 말고 이 실행에만 준다)
KIS_LIVE_ORDER_ENABLED=true npm run dev:api

# 2) 매수가능금액과 현재가를 확인해 지정가를 정한다
curl "http://localhost:4000/api/broker/kis/orderability?instrumentId=<ID>&accountId=21&orderType=market"
curl "http://localhost:4000/api/broker/kis/quote/<ID>"

# 3) 하한가보다 살짝 위 지정가로 1주 (체결되지 않되 가격제한폭 안)
curl -X POST http://localhost:4000/api/broker/kis/orders \
  -H 'content-type: application/json' \
  -d '{"accountId":"21","instrumentId":"<ID>","side":"buy",
       "orderType":"limit","quantity":1,"limitPrice":<하한가+틱>,
       "confirmationPhrase":"실주문 전송"}'

# 4) 응답의 orderNo / orderBranchNo로 즉시 취소
curl -X POST http://localhost:4000/api/broker/kis/orders/amend \
  -H 'content-type: application/json' \
  -d '{"accountId":"21","action":"cancel","orderNo":"<ODNO>",
       "orderBranchNo":"<KRX_FWDG_ORD_ORGNO>","orderTypeCode":"00",
       "quantityAll":true,"confirmationPhrase":"실주문 전송"}'
```

화면으로도 같다. 매매 탭 > 실계좌 주문에 확인 문구를 넣고 전송한 뒤,
바로 옆 **미체결 주문**에서 취소를 누른다.

> 확인 후 반드시 취소하고 `KIS_LIVE_ORDER_ENABLED` 없이 서버를 다시 띄운다.
> 하한가 근처라도 시장이 급락하면 체결될 수 있다. 감당 가능한 금액으로만 한다.

### 1-1. 장 마감 후에 유일하게 테스트할 수 있는 경로 — 예약주문

**예약주문 접수 가능 시간은 15:40 ~ 다음 영업일 07:30이다.** 현금주문과 달리 장이 닫혀
있어도 접수되므로, 주말·야간에 주문 전송 경로를 확인할 수 있는 유일한 수단이다.

리스크 룰은 **시간대·개장일 검사만 건너뛰고** 금액·수량·종목 제한은 그대로 적용한다.
장 마감 후에 넣는 게 정상인 기능에 장중 잣대를 대면 정상 사용을 막기 때문이다.

```bash
KIS_LIVE_ORDER_ENABLED=true npm run dev:api

# 등록 → 응답의 reservationSeq를 보관한다
curl -X POST http://localhost:4000/api/broker/kis/reserved-orders \
  -H 'content-type: application/json' \
  -d '{"accountId":"21","instrumentId":"KR:KOSPI:005930","side":"buy",
       "quantity":1,"limitPrice":<지정가>,"confirmationPhrase":"실주문 전송"}'

# 목록 확인
curl "http://localhost:4000/api/broker/kis/reserved-orders?accountId=21"

# 취소 — 화면에서도 된다.
#   포트폴리오 > 실계좌 예약주문 카드 헤더에 '실주문 전송'을 입력하면
#   각 행의 [취소] 버튼이 활성화된다.
# (주문일자는 등록한 날짜 YYYYMMDD)
curl -X POST http://localhost:4000/api/broker/kis/reserved-orders/cancel \
  -H 'content-type: application/json' \
  -d '{"accountId":"21","reservationSeq":"<SEQ>","reservationOrderDate":"<YYYYMMDD>",
       "confirmationPhrase":"실주문 전송"}'
```

> ⚠ **예약주문은 취소하지 않으면 다음 개장일에 실제로 주문이 나간다.** 반드시 취소한다.
>
> ⚠ 취소에 필요한 `RSVN_ORD_ORGNO`(예약주문조직번호)가 **등록 응답에도 조회 응답에도 없다.**
> KIS 공식 예제조차 `"123"` / `"001"`처럼 임의값을 쓴다. 우리는 빈 값으로 보낸다.
> **이 경로로 취소가 실패하면 KIS HTS/MTS 앱에서 직접 취소해야 한다.**

### 2. 일부 API는 모의투자(vts)를 지원하지 않는다

**이유.** KIS 공식 예제에 모의 분기(`VTTC*`)가 없는 API가 있다.

- 매도가능수량 `TTTC8408R`
- 정정취소가능주문조회 `TTTC0084R`
- 예약주문 계열 `CTSC0008U` / `CTSC0009U` / `CTSC0013U` / `CTSC0004R`

**해결 방법.** 이 세 가지는 `APP_ENV=prod`에서만 쓴다. 모의 환경에서 화면이 비어야 한다면
대체 경로를 쓴다.

- 매도가능수량 → 잔고조회(`VTTC8434R`)의 `hldg_qty`로 근사. 미결제·대주 상황은 반영되지 않는다.
- 정정취소가능주문 → 체결내역(`VTTC0081R`)에서 `CCLD_DVSN='02'`(미체결)로 필터.

### 3. 실시간 주문·체결 통보(H0STCNI0) — 구현됨, HTS ID 필요

구현은 끝났고 **`.env`에 HTS ID만 넣으면 켜진다.**

```
KIS_HTS_ID=your_hts_id          # 계좌가 여러 개여도 하나면 이걸로
KIS_21_HTS_ID=your_hts_id       # 계좌마다 다르면 계좌별로
```

HTS/MTS **로그인 ID**다. 종목코드가 아니다. 비워두면 통보만 꺼지고 나머지는 그대로 돈다.

구현하며 확인한 것:

- 시세(`H0STCNT0`)와 달리 payload가 **AES-256-CBC로 암호화**되어 온다. 키/IV는
  구독 성공 응답 `body.output.key` / `output.iv`에 **한 번만** 실려 온다. 놓치면 못 읽는다.
- 필드는 26개, `^` 구분. **인덱스 13 `CNTG_YN`이 `2`면 체결, `1`이면 접수**(주문·정정·취소·거부).
- `tr_key`는 HTS ID다. 종목코드처럼 대문자로 정규화하면 구독이 깨진다.
- **프레임에 고객ID(`CUST_ID`)와 계좌번호(`ACNT_NO`)가 들어 있다.** 둘 다 프런트로
  내보내지 않는다. 계좌번호는 서버가 화면용 `accountId`로 바꿔서만 전달한다.
- 잘못된 HTS ID면 KIS가 이렇게 답한다.
  ```json
  {"header":{"tr_id":"(null)"},"body":{"rt_cd":"9","msg_cd":"OPSP0017","msg1":"ERROR : htsid가잘못되었습니다"}}
  ```
  **`header.tr_id`가 `"(null)"`이라 tr_id로 거르면 오류가 통째로 묻힌다.** `rt_cd`를 먼저 본다.
- 모의투자는 `H0STCNI9`로 갈린다.

**남은 제약.** 통보는 approval_key가 발급된 앱키 기준으로만 온다. WS 연결이 기본 계좌
앱키 하나라서 **기본 계좌의 통보만 수신된다.** 다른 계좌까지 받으려면 그 계좌 앱키로
WS를 하나 더 열어야 한다.

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

### 6-1. 초당 호출 한도 (EGW00201)

**이유.** KIS는 초당 호출 수를 제한한다. 포트폴리오가 계좌·체결·예약주문·매매손익
**4개를 동시에** 부르면서 실제로 걸렸고, 일부 카드만 502로 비었다.

**해결 방법.** REST 호출을 한 줄로 세워 최소 70ms 간격을 둔다(`scheduleKisCall`).
`EGW00201`이 오면 400ms 쉬고 **한 번만** 재시도한다. 계속 두드리면 더 오래 막힌다.
**주문(POST)은 재시도하지 않는다.** 중복 접수 위험이 조회 실패보다 훨씬 크다.
4개 동시 호출 × 3회차에서 전부 200, 한도 초과 0건으로 확인했다.

### 6. 토큰 발급에 호출 제한이 있다

**이유.** `access_token`은 24h 유효이고 발급 횟수·빈도 제한이 있다(같은 앱키로 연속 발급 시 거부).

**해결 방법.** 이미 반영돼 있다. `backend/.cache/token-{env}-{계좌id}.json`으로 앱키별 파일 캐시를
쓰고, 동시 요청이 중복 발급하지 않도록 in-flight Promise를 공유한다. 캐시 경로는 백엔드
실행 디렉터리 기준이라 실제로는 `backend/.cache/`에 쌓인다.

### 7. 장 시간 밖에서는 접수되지 않는다

**이유.** 정규장(09:00~15:30) 밖에서 `order-cash`를 보내면 KIS가 거부한다. 시간외단일가·
장전시간외는 `ORD_DVSN` 코드가 따로 있다.

**해결 방법.** 리스크 룰이 시간대와 개장일을 함께 본다(`chk-holiday` / `CTCA0903R`).
**시각만 검사하면 주말·공휴일 주문이 그대로 나간다** — 실제로 토요일 13시 지정가 주문이
룰을 통과해 KIS까지 갔다가 `장운영일자가 주문일과 상이합니다`로 거부된 적이 있다.
개장일 판정은 `opnd_yn`을 쓴다. `bzdy_yn`(영업일)이나 `tr_day_yn`(거래일)이 아니다 —
토요일도 `tr_day_yn=Y`로 내려온다.
조회가 실패하면 "보류"로 막는다. 확인 못 한 채 내보내지 않는다.

시간외 세션은 아직 지원하지 않는다. 정규장 지정가(`00`)/시장가(`01`)만 쓴다.

---

## 화면 연결 상태

| 화면 | 붙은 기능 |
|------|------|
| 주문 티켓 | 실계좌 매수가능(매수) / 매도가능수량(매도), 한도 초과 참고 경고 |
| 주문 티켓 · 실계좌 주문 | 게이트 상태 배지, 확인 문구 입력, 전송 버튼 |
| 주문 티켓 · 미체결 주문 | 목록 + 정정(단가 입력) / 취소 |
| 주문 티켓 · 실시간 통보 | 접수·체결·거부가 실시간으로 쌓임 (HTS ID 필요) |
| 포트폴리오 | 실계좌 잔고, 주문·체결 감사 기록, 기간별 매매손익, 리스크 룰 편집, 주문 전송 기록, 예약주문 목록·취소 |

전송 버튼은 **서버 게이트와 프런트 검증을 모두 통과해야** 열린다. 확인 문구를 정확히
입력해도 `KIS_LIVE_ORDER_ENABLED`가 꺼져 있으면 잠긴 채로 남는 것을 확인했다.

## 리스크 룰 (`trading_risk_rules`)

게이트가 "실주문을 켰는가"라면, 리스크 룰은 "이 주문을 내도 되는가"를 본다.
계좌별로 저장하고, 행이 없으면 보수적인 기본값을 쓴다.

| 룰 | 기본값 | 막는 것 |
|------|------|------|
| `enabled` | `true` | false면 이 계좌 실주문 전부 |
| `maxOrderQuantity` | 1,000주 | 1회 주문 수량 |
| `maxOrderNotional` | 1,000,000원 | 1회 주문 금액 |
| `dailyOrderCountLimit` | 20건 | 오늘(KST) 접수 건수 |
| `dailyNotionalLimit` | 5,000,000원 | 오늘(KST) 접수 금액 합 |
| `allowMarketOrder` | `false` | 시장가 주문 |
| `sessionStart`~`sessionEnd` | 09:00~15:30 | 허용 시간대 (KST) |
| 개장일 | — | 주말·공휴일 (`chk-holiday`) |
| `symbolAllowlist` | `[]` | 비어 있지 않으면 목록 밖 종목 |
| `symbolBlocklist` | `[]` | 목록에 있는 종목 |

- `GET /api/broker/kis/risk-rules?accountId=` — 현재 룰
- `PUT /api/broker/kis/risk-rules?accountId=` — 부분 수정(merge). 음수 한도, 1회>일일,
  뒤집힌 시간대는 저장 자체를 거부한다.
- 화면: 포트폴리오 > **실주문 리스크 룰** 카드에서 계좌별로 편집한다.

위반 사유는 **전부 모아서** 돌려준다. 하나씩 알려주면 고칠 때마다 새 사유를 만난다.
일일 사용량은 `trading_broker_orders`에서 오늘 `submitted`된 `place` 건만 센다.
시장가는 단가가 없어 현재가로 금액을 추정해 한도를 본다.

## 주문 전송 감사 기록

모든 전송 시도가 `trading_broker_orders`에 남는다. `GET /api/broker/kis/order-log`로 읽고,
`accountId`를 생략하면 전체를 준다(미등록 계좌로 시도한 기록도 감사 대상이라 기본 계좌로 좁히지 않는다).

| 상태 | 언제 |
|------|------|
| `blocked` | 게이트가 닫혀 있거나 확인 문구·수량·단가·종목·계좌 검증에 막힘 |
| `submitted` | 브로커가 접수함. `orderNo` / `orderBranchNo` 저장 |
| `rejected` | 브로커가 거부함. 사유가 `message`에 남음 |

계좌번호(CANO)·앱키·확인 문구는 저장하지 않는다. 화면용 계좌 id만 남긴다.
기록 저장이 실패해도 주문 응답 자체는 깨지지 않는다(실패 시 서버 로그에 경고).

## 다음 작업 순서

1. 사용자가 `.env`에 `KIS_HTS_ID`를 넣어 실시간 통보 수신 확인
2. 사용자가 위 1번 절차로 주문 접수·취소 경로를 검증 (🟡 → ✅)
3. 예약주문 등록·취소
4. 해외주식 주문
