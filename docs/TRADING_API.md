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
| 호가·예상체결 | `quotations/inquire-asking-price-exp-ccn` | `FHKST01010200` | `GET /api/instruments/:id/order-book` | ✅ |

### 현재가에는 예상체결이 없다 (프리마켓)

`FHKST01010100`(현재가)에는 **예상체결 필드가 아예 없다.** 동시호가 구간에
현재가만 물으면 이렇게 온다 (2026-07-27 08:51 실측, 삼성전자):

```
stck_prpr = 249500   ← 전일 종가
prdy_ctrt = 0.00
stck_oprc / stck_hgpr / stck_lwpr = 0
acml_vol = 0
```

같은 시각 `FHKST01010200`(호가·예상체결)은:

```
antc_cnpr = 259500          예상 체결가
antc_cntg_prdy_ctrt = 4.01  예상 등락률
antc_vol = 116688           예상 거래량
antc_mkop_cls_code = 311    장운영 구분
```

화면이 `249,500원 0.00%`라고 적는 동안 실제로는 **+4.01%에 지시되고 있었다.**
프리마켓 값은 이 엔드포인트에서만 나온다.

### 장운영 구분 코드 (`antc_mkop_cls_code`)

**실측한 값만** 옮긴다 (`SESSION_PHASE_BY_CODE`, `backend/src/kis/rest.ts`).

| 코드 | 뜻 | 확인 방법 |
|------|------|------|
| `311` | 동시호가 | 2026-07-27 08:53~09:00:10, 20초 간격 22개 표본 |
| `112` | 정규장 | 같은 날 09:00:30 이후 18개 표본 |
| 그 외 | `unknown` | 확인 못 함 → 예상체결을 감춘다 |

> **마감 동시호가(15:20~15:30)의 코드는 아직 확인하지 못했다.** 확인되면
> 위 표와 `SESSION_PHASE_BY_CODE`에 함께 추가한다.

**예상체결가가 0인지로 동시호가를 판단하면 안 된다.** 정규장이 시작돼도 KIS는
이 값을 지우지 않고 개장 동시호가 결과를 그대로 들고 있다 — 09:00:10에
257,000이던 값이 09:06:11에도 257,000이었고, 그때 실제 현재가는 254,500이었다.
값의 유무로 보면 하루 종일 낡은 예상가를 현재처럼 띄우게 된다.

### 호출 비용

종목당 KIS 호출이 1회 더 늘어난다. 그래서 **보고 있는 종목 하나**에만 붙였다
(주문 패널이 열려 있는 동안 3초 간격). 관심목록 전체에 붙이면 목록 새로고침
한 번에 호출이 두 배가 되어 `EGW00201`에 걸린다.

### 재무 지표 — 값이 **연초부터의 누적**이다

`FHKST66430300`(재무비율) · `FHKST66430200`(손익계산서) · `FHKST66430100`(대차대조표)
셋을 결산연월(`stac_yymm`)로 맞춰 합친다. 두 가지를 반드시 알고 써야 한다.

**① 금액은 분기 단독이 아니라 연초부터의 누적이다.** 삼성전자 2025년 매출(억원):

| 결산연월 | 매출 | 창 |
|------|------|------|
| 202503 | 791,405 | 1~3월 누적 |
| 202506 | 1,537,068 | 1~6월 누적 |
| 202509 | 2,397,686 | 1~9월 누적 |
| 202512 | 3,336,059 | 1~12월 누적 |
| 202603 | 1,338,734 | 1~3월 누적 |

`202512`(333조) 아래에 `202603`(133조)이 오는데 회사가 3분의 1로 줄어든 게
아니라 창이 1년에서 3개월로 바뀐 것이다(2026-07-27 실측). **창을 안 밝히고
세로로 늘어놓으면 매년 1월에 망하는 회사가 된다.** 비율(ROE·순이익률·
매출성장률)은 같은 창끼리 계산돼 있어 그대로 읽어도 된다 — `202603`의
매출성장률 69.16%는 133.9조 ÷ 79.1조로 검산된다.

결산월이 곧 누적 개월 수라는 건 **12월 결산을 전제로 한 읽기**다. 그래서
`financialPeriodWindow`(창 표기)와 `detectCumulativeReporting`(같은 해 매출이
결산월 순으로 커지는지를 값으로 확인)을 나눠 뒀다. 화면은 확인된 것과 가정한
것을 점선으로 구분한다.

**② 값이 없는 필드에 `99.99`가 온다.** 삼성전자(매출 133조)·SK하이닉스(52조)·
동화약품(1,306억) 셋 다 `depr_cost`·`sell_mang`·`bsop_non_ernn`·`spec_prfi`가
정확히 `99.99`였다. 규모가 전혀 다른 회사가 같은 값이면 값이 아니라 표시다.
`financeNumber`가 정규화 단계에서 `undefined`로 지운다.

**대상**: 국내 주식만. ETF·ETN·해외 종목은 서버가 404에 사유를 담아 준다.
이건 조회 **실패**가 아니라 **해당 없음**이다 — 재무제표가 없는 상품을
"재무가 나쁘다"로 읽으면 안 되므로 화면에서도 오류와 다르게 그린다.

**호출 비용**: 종목당 3회. 하단 독의 `재무` 탭을 열었을 때만, 종목이 바뀔
때만 부른다. 분기 값이라 주기 갱신이 필요 없다.

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
3. 국내 주식·ETF·ETN 종목 (지수·선물·야간 프록시는 거부)
4. 수량 > 0, 지정가면 단가 > 0
5. 리스크 룰 통과 (1회/일일 한도, 허용·차단 종목, 거래시간, 거래일)

> 예전에는 `confirmationPhrase`로 `실주문 전송`을 정확히 받아야 했다. 클라이언트가 아는
> 상수를 클라이언트가 다시 보내는 것뿐이라 오발주를 막는 힘이 없었고, 증권사 화면에는
> 없는 모양이라 걷어냈다. 대신 화면에서 주문 내용(종목·수량·가격·계좌)을 보여주고
> 한 번 확인받는다 — 실제 주문 화면이 하는 방식이다. **서버 쪽 실제 차단은 게이트와
> 리스크 룰이 담당한다.**

### 확인된 차단 동작

| 요청 | 결과 |
|------|------|
| 게이트 꺼짐 | `403` + `gate.blockers` |
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
       "orderType":"limit","quantity":1,"limitPrice":<하한가+틱>}'

# 4) 응답의 orderNo / orderBranchNo로 즉시 취소
curl -X POST http://localhost:4000/api/broker/kis/orders/amend \
  -H 'content-type: application/json' \
  -d '{"accountId":"21","action":"cancel","orderNo":"<ODNO>",
       "orderBranchNo":"<KRX_FWDG_ORD_ORGNO>","orderTypeCode":"00",
       "quantityAll":true}'
```

화면으로도 같다. 종목 화면 > 오른쪽 주문 탭 > 실계좌 주문에서 매수/매도를 누르고 확인한 뒤,
바로 옆 **미체결 주문**에서 취소를 누른다.

> 확인 후 반드시 취소하고 `KIS_LIVE_ORDER_ENABLED` 없이 서버를 다시 띄운다.
> 하한가 근처라도 시장이 급락하면 체결될 수 있다. 감당 가능한 금액으로만 한다.

### 1-1. 장 마감 후에 유일하게 테스트할 수 있는 경로 — 예약주문

**예약주문 접수 가능 시간은 15:40 ~ 다음 영업일 07:30이다.** 현금주문과 달리 장이 닫혀
있어도 접수되므로, 주말·야간에 주문 전송 경로를 확인할 수 있는 유일한 수단이다.

리스크 룰은 **시간대·개장일 검사만 건너뛰고** 금액·수량·종목 제한은 그대로 적용한다.
장 마감 후에 넣는 게 정상인 기능에 장중 잣대를 대면 정상 사용을 막기 때문이다.

화면으로 하는 게 편하다. **포트폴리오 > 실계좌 예약주문** 카드에서
등록·취소 버튼은 게이트가 열려 있으면 바로 쓸 수 있다. 종목은 차트에서 고른 것을 쓴다.

> 등록 응답의 `reservationSeq`는 **취소에 반드시 필요하다.** 조회 필터(`CNCL_YN` 등)의
> 의미가 확실하지 않아 목록에 안 잡힐 수 있으므로, 등록 직후 화면 메시지와
> 주문 기록 카드 양쪽에 순번을 남긴다.

curl로 하려면:

```bash
KIS_LIVE_ORDER_ENABLED=true npm run dev:api

# 등록 → 응답의 reservationSeq를 보관한다
curl -X POST http://localhost:4000/api/broker/kis/reserved-orders \
  -H 'content-type: application/json' \
  -d '{"accountId":"21","instrumentId":"KR:KOSPI:005930","side":"buy",
       "quantity":1,"limitPrice":<지정가>}'

# 목록 확인
curl "http://localhost:4000/api/broker/kis/reserved-orders?accountId=21"

# 취소 — 화면에서도 된다.
#   포트폴리오 > 실계좌 예약주문 카드 헤더에 '실주문 전송'을 입력하면
#   각 행의 [취소] 버튼이 활성화된다.
# (주문일자는 등록한 날짜 YYYYMMDD)
curl -X POST http://localhost:4000/api/broker/kis/reserved-orders/cancel \
  -H 'content-type: application/json' \
  -d '{"accountId":"21","reservationSeq":"<SEQ>","reservationOrderDate":"<YYYYMMDD>"}'
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
| 주문 티켓 · 실계좌 주문 | 게이트 상태 배지, 매수/매도 버튼, 주문 확인 단계 |
| 주문 티켓 · 미체결 주문 | 목록 + 정정(단가 입력) / 취소 |
| 주문 티켓 · 실시간 통보 | 접수·체결·거부가 실시간으로 쌓임 (HTS ID 필요) |
| 포트폴리오 | 실계좌 잔고, 주문·체결 감사 기록, 기간별 매매손익, 리스크 룰 편집, 주문 전송 기록, 예약주문 목록·취소 |

매수/매도 버튼은 **프런트 검증을 통과해야** 열리고, 그다음 주문 확인 단계의 전송
버튼은 **서버 게이트까지 통과해야** 열린다. `KIS_LIVE_ORDER_ENABLED`가 꺼져 있으면
확인 단계까지 가더라도 전송 버튼이 잠긴 채로 남는 것을 확인했다.

## 중복 주문 방지 (멱등성 키)

`POST /api/broker/kis/orders`는 `clientOrderId`를 받는다. 같은 값으로 다시 보내면
새 주문을 내지 않고 앞선 결과를 그대로 돌려준다. 네트워크가 끊겨 재시도할 때
같은 주문이 두 번 나가는 것을 막는 장치다.

순서가 핵심이다 — **주문을 내기 전에** 키를 선점한다.

```
클라이언트가 키 생성 (주문 확인 단계 진입 시 1회)
  → 서버: trading_broker_orders에 status='sending'으로 INSERT
      · 성공 → 주문 전송 → 같은 줄을 결과로 UPDATE
      · 유니크 충돌 → 이미 처리된 요청. 앞선 결과를 반환하고 전송하지 않음
      · DB 오류 → 503. 중복인지 알 수 없으므로 전송하지 않는다
```

애플리케이션에서 조회 후 삽입하면 동시 요청 사이에 틈이 생기므로 DB 유니크
제약(`trading_broker_orders_client_order_id_key`, `WHERE client_order_id IS NOT NULL`)으로
막는다. 동시에 5개를 보내도 하나만 통과하는 것을 테스트로 확인한다
(`src/db/brokerOrders.test.ts`).

막힌 주문(`blocked`)에는 키를 달지 않는다. 조건을 고쳐 다시 시도하는 게 정상이라
같은 키를 막으면 오히려 방해가 된다.

자동매매 러너도 신호마다 키를 만들어 같은 경로를 탄다. 회차 겹침은 busy 플래그가
막지만, KIS 호출이 타임아웃 뒤 재시도되는 경우는 그것만으로 막지 못한다.

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
| `blocked` | 게이트가 닫혀 있거나 수량·단가·종목·계좌·리스크 룰 검증에 막힘 |
| `submitted` | 브로커가 접수함. `orderNo` / `orderBranchNo` 저장 |
| `rejected` | 브로커가 거부함. 사유가 `message`에 남음 |

계좌번호(CANO)·앱키는 저장하지 않는다. 화면용 계좌 id만 남긴다.
기록 저장이 실패해도 주문 응답 자체는 깨지지 않는다(실패 시 서버 로그에 경고).

## 다음 작업 순서

1. 사용자가 `.env`에 `KIS_HTS_ID`를 넣어 실시간 통보 수신 확인
2. 사용자가 위 1번 절차로 주문 접수·취소 경로를 검증 (🟡 → ✅)
3. 예약주문 등록·취소
4. 해외주식 주문
