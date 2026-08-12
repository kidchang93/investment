/**
 * 자동매매 후보 종목 고르기.
 *
 * 전략에 넘기기 전에 "애초에 살 수 없는 것"을 여기서 다 걸러낸다.
 * 전략이 살 수 없는 종목을 고르면 매 회차 보류 기록만 쌓이고 아무 일도 일어나지 않는다.
 *
 * 거르는 기준:
 * 1. 국내 주식·ETF·ETN만 (지수·선물·야간 프록시는 주문 자체가 안 된다)
 * 2. 현금으로 1주라도 살 수 있는 가격
 * 3. 리스크 룰의 허용·차단 목록
 *
 * 2번이 특히 중요하다. 예수금 5만원으로는 삼성전자(1주 약 25만원)를 살 수 없다.
 * 값을 모르고 고르면 후보 전부가 "1주도 못 삼"으로 끝난다.
 */

import type { Instrument, Quote, ScreeningVerdict } from '@invest/shared';
import { hasEmptyOrderBook, KRX_SESSION_MINUTES } from '@invest/shared';

import { getKisAccount } from '../config.js';
import { getCategoryInstruments } from '../db/instruments.js';
import { getRiskRules } from '../db/riskRules.js';
import {
  getDomesticTurnoverRanking,
  getInstrumentQuotes,
  MULTI_QUOTE_MAX_CODES,
} from '../kis/rest.js';
import { roundTripCostRate } from './backtest.js';

/*
 * 후보를 뽑아올 카테고리. 국내 주문 가능한 것만 둔다.
 * ETF를 함께 넣는 이유는 값이 싸서다 — 예수금이 적으면 개별주는 1주도 못 사는
 * 경우가 많은데 ETF는 1~4만원대가 많아 실제로 매수 가능한 후보가 남는다.
 */
const SOURCE_CATEGORIES = ['kr-all', 'kr-etf'];

/*
 * 가격을 확인하려고 KIS를 때리는 종목 수 상한.
 *
 * **호출 수로 잡는다.** 예전 값 24는 "종목당 1회 × 24회"였다 — 종목 수가 곧
 * 호출 수였다. 멀티시세는 30종목이 1회라, 종목 수만 적어 두면 몇 회가 나가는지
 * 알 수 없다.
 *
 * 2026-07-31 실측(실전 서버, 장 마감 후): 10묶음 300종목을 1.08초에 받았고
 * `EGW00201` 0건, 빈 자리 0건이었다. 여기는 그보다 아래인 8묶음 240종목이다.
 * **10묶음을 넘겨서는 재 보지 않았다** — 더 올리려면 다시 재라.
 */
const MAX_PRICE_LOOKUP_CALLS = 8;
const MAX_PRICE_LOOKUPS = MULTI_QUOTE_MAX_CODES * MAX_PRICE_LOOKUP_CALLS;

/*
 * 유동성 문턱 — 하루 거래대금이 이만큼은 돼야 후보로 본다.
 *
 * 백테스트는 원하는 값에 원하는 만큼 체결된다고 가정한다. 실제로는 하루 174주
 * 거래되는 ETF에 시장가를 넣으면 호가를 몇 칸 밀고 들어간다. 실측에서 매수
 * 가능한 47종목 중 거래량 1만주를 넘는 것은 16종목뿐이었고, 나머지는 백테스트
 * 숫자가 나와도 그 값에 살 수 없다.
 *
 * 5천만원은 5만원짜리 주문 하나가 거래대금의 0.1%인 수준이다. 이 계좌 규모에서
 * 호가를 밀지 않고 들어갈 수 있는 최소선으로 잡았다 — 더 큰 계좌면 올려야 한다.
 */
export const MIN_DAILY_TURNOVER = 50_000_000;

/*
 * 왕복 비용이 하루 변동폭에서 차지하는 비중의 상한.
 *
 * 사고파는 데 드는 비용(수수료 2회 + 거래세 + 슬리피지 2회)은 값이 얼마나
 * 움직이든 똑같이 나간다. 하루 0.3% 움직이는 종목에서 왕복 0.43%가 나가면
 * 방향을 맞혀도 진다. 하루 변동폭의 절반을 넘게 비용으로 쓰는 종목은 뺀다.
 *
 * **왕복 비용은 종목마다 다르다.** 주식 0.43%, ETF 0.23%(매도 거래세 면제)라
 * 요구 변동폭도 0.86% / 0.46%로 갈린다. 이 비중 상한만 공통이다.
 *
 * 2026-07-29 재측정에서 변동성 돌파가 백테스트 1회당 매매 13.4회에 비용이
 * 원금의 2.60%였다 — 다른 두 전략(0.58% / 0.60%)의 네 배가 넘는다.
 * 소액 계좌에서 비용은 전략을 고르는 문제가 아니라 후보를 고르는 문제다.
 */
export const MAX_COST_SHARE_OF_RANGE = 0.5;

/**
 * 사고팔 때 한 번씩 드는 비용을 합친 비율. 백테스트가 쓰는 값과 같은 것을 쓴다.
 *
 * **일반 주식 기준이다.** 국내 상장 ETF는 매도 거래세가 면제라 왕복 비용이
 * `ETF_ROUND_TRIP_COST_RATE`로 내려간다 — 종목을 아는 자리에서는 그쪽을 쓴다.
 */
export const ROUND_TRIP_COST_RATE = roundTripCostRate();

/** ETF 기준 왕복 비용. 매도 거래세가 빠져 주식보다 `KR_SELL_TAX_RATE`만큼 싸다. */
export const ETF_ROUND_TRIP_COST_RATE = roundTripCostRate({ assetType: 'etf' });

/*
 * 정규장 09:00-15:30. 장 초반에는 거래대금이 아직 안 쌓인다.
 * 예전에는 여기서 `9 * 60`을 따로 들고 있어 프론트의 장 상태 표시와 갈라질 수
 * 있었다. 같은 사실이니 shared 한 곳에서 가져온다.
 *
 * **초 단위로 잰다.** 분 단위이던 때는 09:00:00~09:00:59가 전부 한 값(540)이라
 * 개장 첫 1분이 통째로 한 칸에 뭉쳤다. 아래 오프바이원의 원인이다.
 */
const SESSION_OPEN_SECONDS = KRX_SESSION_MINUTES.open * 60;
const SESSION_CLOSE_SECONDS = KRX_SESSION_MINUTES.close * 60;
/** 정규장 한 판의 길이(초). 09:00~15:30 = 390분 = 23,400초 */
const SESSION_SECONDS = SESSION_CLOSE_SECONDS - SESSION_OPEN_SECONDS;

/**
 * 지금까지 지난 장 시간의 비율 (0~1).
 *
 * 유동성 문턱을 하루치로 걸면 09:05에는 모든 종목이 걸린다 — 아직 5분치만
 * 쌓였기 때문이다. 지난 만큼만 요구한다. 장 시작 전이나 마감 후에는 1로 본다
 * (전일 종가 기준 누적이 이미 하루치다).
 *
 * ── 개장 경계 (2026-07-31 장중 실측으로 잡은 오프바이원) ────────────────
 *
 * 예전에는 분 단위로 재고 `minutes <= 개장`이라, **09:00:00~09:00:59가 전부
 * "장 시작 전"으로 분류돼 1이 됐다.** 유효 문턱이 하루치 5천만원이라 개장 첫
 * 1분이 15:29(49,871,795원)보다 엄격했고, 09:01에 128,205원으로 **390배 계단**이
 * 생겼다. 그 1분에 스크리닝이나 후보 선정이 돌면 거의 전 종목을 `illiquid`로
 * 버린다. 주석의 의도는 "장 시작 전"이었는데 09:00은 장 시작 **후**다.
 *
 * 고칠 때 `<`로만 바꾸면 09:00대가 0이 되어 문턱이 0원이 된다. 그러면
 * `turnover < 0`이 언제나 거짓이라 **유동성 검사가 아무도 안 거른다.**
 * 그래서 두 가지를 함께 둔다.
 *
 * 1. **초까지 반영한다.** 09:00:30이 `30/23400`(문턱 약 64,103원)이다. 분 경계
 *    값은 예전과 같다 — `60k/23400 = k/390`이라 09:01은 그대로 `1/390`이다.
 * 2. **장이 열려 있으면 최소 한 칸(1초치)은 지난 것으로 본다.** 09:00:00
 *    정각의 문턱이 0원이 아니라 약 2,137원이다. 개장 동시호가가 09:00:00에
 *    체결되므로 "아직 아무것도 안 쌓였다"가 아니고, 무엇보다 문턱이 0이면
 *    검사 자체가 사라진다.
 *
 * 2번이 실제로 무엇을 막는지는 쟀다 — 2026-07-31 10:46 실전 서버, `kr-all` 앞
 * 120종목 중 **거래대금이 이 문턱 아래인 것은 정확히 "거래대금 0원" 6종목**이다
 * (`000880 한화`·`00088K 한화3우B`·`000300 DH오토넥스`·`001067 JW중외제약2우B`·
 * `001470 삼부토건`·`001570 금양` — 전부 현재가는 있고 거래량 0). 문턱이 0이면
 * 이 여섯이 09:00대에 자동매매 후보로 올라간다. 거래대금 0원은 어느 시각에도
 * 통과하면 안 된다.
 *
 * (그 여섯 중 호가까지 빈 종목은 이제 `noOrderBook`으로 먼저 갈라진다. 위
 *  문턱은 그래도 필요하다 — `0000Y0`처럼 **호가는 있는데 오늘 체결이 없는**
 *  종목은 여전히 여기서 걸러야 한다.)
 */
export function sessionElapsedRatio(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const seconds = Number(map.hour) * 3600 + Number(map.minute) * 60 + Number(map.second);
  // 09:00:00은 장 시작 **후**다. 여기를 `<=`로 두면 개장 첫 순간이 장 밖이 된다.
  if (seconds < SESSION_OPEN_SECONDS || seconds >= SESSION_CLOSE_SECONDS) return 1;
  return Math.max(seconds - SESSION_OPEN_SECONDS, 1) / SESSION_SECONDS;
}

/** 후보에서 빠진 이유. 왜 비었는지 실행 기록에 적으려면 세어야 한다. */
export interface UniverseRejections {
  tooExpensive: number;
  /** 매도·매수 호가가 모두 없어 어떤 값에도 체결되지 않는 종목 */
  noOrderBook: number;
  illiquid: number;
  costHeavy: number;
}

/**
 * 오늘 고가−저가를 지금 값으로 나눈 비율. **모르는 것과 0인 것을 가른다.**
 *
 * 고가·저가를 아직 못 받았으면 `undefined`, 받았는데 한 값이면 `0`이다.
 * 둘은 다른 사실이다 — 앞은 "아직 모른다", 뒤는 "오늘 한 값에만 체결됐다"다.
 *
 * ── 왜 갈라야 하나 (2026-07-31 장중 실측) ────────────────────────────────
 *
 * 예전에는 `if (range > 0)` 하나로 둘을 함께 건너뛰었다. 그래서 **1원 움직인
 * 종목은 `costHeavy`로 버리면서 한 푼도 안 움직인 종목은 통과**시켰다. 문턱을
 * 어느 쪽으로 정하든 이 순서는 성립하지 않는다 — 폭이 넓을수록 나쁠 수는 없다.
 *
 * 실제로 `000227 유유제약2우B`가 09:35과 10:00 두 회차 모두 `pass`였다.
 * 거래대금이 8,684,600원으로 **1원도 안 바뀐** 채였다 — 25분 동안 체결이 한
 * 건도 없었는데 유동성은 누적값이라 통과하고 비용은 고가=저가라 면제됐다.
 *
 * `high`·`low`가 NaN이거나 0이면 비교가 전부 거짓이라 `undefined`로 떨어진다.
 * KIS는 값이 없는 자리에 빈 문자열을 주고 거래정지 종목은 고가·저가가 0이다.
 */
export function knownRangeRate(quote: Quote): number | undefined {
  if (!(quote.price > 0) || !(quote.high > 0) || !(quote.low > 0)) return undefined;
  // 고가 < 저가는 성립하지 않는 값이다. 억지로 음수 폭을 만들지 않는다.
  if (quote.high < quote.low) return undefined;
  return (quote.high - quote.low) / quote.price;
}

/**
 * 유동성·비용으로 거른다. 통과하면 null, 걸리면 사유.
 *
 * 두 조건 모두 "백테스트에서는 되는데 실제로는 안 되는" 것을 잡는다.
 * 백테스트는 원하는 값에 원하는 만큼 체결된다고 보지만 실제 시장은 아니다.
 *
 * `instrument`는 **비용 문턱에만** 쓴다. 국내 상장 ETF는 매도 거래세가 면제라
 * 왕복 비용이 0.23%인데, 안 넘기면 주식 기준 0.43%로 재서 요구 변동폭이 두 배가
 * 된다 — 값이 얌전한 ETF가 통째로 `costHeavy`로 걸린다. 종목을 모르는 호출
 * (측정 스크립트 일부)은 지금까지처럼 주식 기준으로 남는다: 모르는 쪽은 비용이
 * 큰 쪽에 둔다.
 */
export function screenQuote(
  quote: Quote,
  elapsed: number,
  instrument?: Pick<Instrument, 'assetType'> | null,
): keyof UniverseRejections | null {
  /*
   * ── 호가가 아예 없는 종목이 먼저다 ────────────────────────────────────────
   *
   * "얇다"(`illiquid`)와 "아예 못 산다"는 다른 사실인데 예전에는 한 사유로
   * 뭉쳤다. 거래정지 종목은 거래대금이 0원이라 유동성 문턱에 먼저 걸렸고,
   * 실행 기록에는 `거래대금 부족 17종목`이라고만 남았다 — 2026-07-31 10:00
   * 실측에서 그 17종목 중 2종목이 거래정지였다.
   *
   * 유동성보다 앞에 두는 이유는 사유의 값어치다. 유동성이 모자란 종목은 문턱을
   * 낮추면 살 수 있지만, 호가가 없는 종목은 문턱을 어떻게 잡아도 못 산다.
   *
   * 잔량을 못 받은 경로(단건 시세·해외·선물)는 `undefined`라 여기서 걸리지
   * 않는다. 모르는 것을 나쁜 것으로 단정하지 않는다 — `knownRangeRate`와 같다.
   */
  if (hasEmptyOrderBook(quote) === true) return 'noOrderBook';

  /*
   * 거래대금은 KIS가 실제 값(`Quote.turnover`)을 준다. 국내 주식·ETF는 단건·멀티
   * 시세 둘 다 담아 오므로 이 문을 지나는 종목은 전부 실제 값이다.
   *
   * `현재가 × 누적거래량`은 어림이다 — 하루 종일의 체결을 마지막 값 하나로
   * 곱하는 것이라, 실제로는 `VWAP × 거래량`과의 차이만큼 어긋난다.
   *
   * **어긋나는 크기를 한 종목으로 재지 마라.** 2026-07-30 스크리닝 풀 113종목
   * 실측에서 중앙값은 +0.28%지만 범위가 **−6.68% ~ +6.24%**로 부호가 양쪽이다
   * (005930 하나만 보면 +2.59%다). 등락률과의 상관이 r = −0.768이라 하락일에는
   * 어림이 작게, 상승일에는 크게 나온다. 상·하한가를 오간 종목이면 더 벌어진다.
   *
   * 같은 실측에서 판정이 뒤집힌 종목은 0건이었지만 **안전하다는 뜻은 아니다** —
   * `000105 유한양행우`가 문턱 대비 −1.9%였고, 오차가 +2%만 났어도 뒤집혔다.
   * 값을 안 주는 경로(해외·선물·야간 환산가)를 위해 어림을 남겨 두지만, 어림이라는
   * 사실이 사라지지 않게 여기 적어 둔다.
   */
  const turnover = quote.turnover ?? quote.price * quote.accVolume;
  if (turnover < MIN_DAILY_TURNOVER * elapsed) return 'illiquid';

  /*
   * 고가·저가를 아직 못 받은 종목은 이 잣대로 거르지 않는다 — 모르는 것을
   * 나쁜 것으로 단정하는 셈이다. 다만 **받았는데 한 값인 것은 아는 값이다.**
   * 폭이 0이면 왕복 비용을 이길 길이 없으므로 그대로 걸린다.
   *
   * ── 이 문턱은 시간비례가 아니다. 그건 잰 결과다 ─────────────────────────
   *
   * 위 유동성 문턱만 `elapsed`를 곱한다. 거래대금은 시간에 쌓이지만 고가−저가는
   * **누적이 아니라 범위**라 같은 방식으로 나눌 수 없다. 그러면 어떻게 나눠야
   * 하는지를 2026-07-31에 과거 3개월을 재구성해 쟀다
   * (`scripts/measureRangeExpansion.ts` → `docs/USER_FINDINGS.md`).
   *
   * 후보 둘이 실측으로 **기각**됐다(50종목 × 15거래일, 2026-04-28~07-30).
   * 폭이 벌어지는 속도가 둘 다보다 훨씬 느리다.
   *
   *   09:01 → 09:05  elapsed 5.00배 · √elapsed 2.24배 · **실제 폭 1.68배**
   *   09:05 → 09:15  elapsed 3.00배 · √elapsed 1.73배 · **실제 폭 1.27배**
   *
   * 09:01에 이미 하루치 폭의 25.2%(중앙값)가 벌어져 있다. `elapsed`(0.26%)를
   * 곱하면 문턱이 사실상 사라진다. 그래서 하루치 잣대를 그대로 둔다.
   *
   * **그렇다고 지금 값이 맞다는 뜻은 아니다.** 같은 측정에서 이 문턱은 장 초반에
   * 너무 빡빡하고(09:01 헛탈락 34.7%p) 장 후반에 너무 헐겁다(15:00에 앞으로 남은
   * 폭이 0.860%에 못 미치는데 통과시킨 것이 50.2%). 고치려면 "지나간 폭" 대신
   * "앞으로 남을 폭"을 재야 하는데, 그건 상수 조정이 아니라 문턱이 무엇을 묻는지를
   * 바꾸는 일이다. 무엇을 더 재야 정할 수 있는지는 `docs/USER_FINDINGS.md`에 적었다.
   */
  const rangeRate = knownRangeRate(quote);
  const costRate = roundTripCostRate(instrument);
  if (rangeRate !== undefined && costRate > rangeRate * MAX_COST_SHARE_OF_RANGE) {
    return 'costHeavy';
  }
  return null;
}

/**
 * 예수금까지 넣어 한 줄로 판정한다. **자동매매와 화면이 같은 함수를 쓴다.**
 *
 * 예전에는 순서(`가격 → 유동성 → 비용`)를 `loadAutoTraderCandidates`와
 * `runScreening`이 각자 들고 있었다. 같은 규칙을 두 곳에 두면 한쪽만 고쳤을 때
 * 화면의 사유와 실행 기록의 사유가 조용히 갈라진다 — `knownRangeRate`를
 * 떼어낸 것과 같은 이유다.
 *
 * ── 순서: 호가 없음 → 가격 초과 → 유동성 → 비용 ─────────────────────────
 *
 * `noOrderBook`이 `tooExpensive`보다 앞이다. 예수금은 **계좌마다 다른 사정**이라
 * 같은 종목이 계좌에 따라 다른 사유로 걸리는데, 호가가 없다는 것은 누구에게나
 * 같은 사실이다. 거래정지 종목에 `1주가 예수금보다 비쌈`이라고 적으면 "돈을 더
 * 넣으면 살 수 있다"로 읽히는데 그건 거짓이다 — 실측 6종목 중 `000880 한화`가
 * 83,800원이라 실제로 그렇게 걸렸다.
 *
 * 가격이 유동성·비용보다 앞인 것은 예전 결정 그대로다. 살 수도 없는 종목을
 * 문턱으로 거르면 사유가 뒤바뀐다.
 */
export function verdictFor(
  quote: Quote,
  elapsed: number,
  cash: number,
  instrument?: Pick<Instrument, 'assetType'> | null,
): ScreeningVerdict {
  const screened = screenQuote(quote, elapsed, instrument);
  if (screened === 'noOrderBook') return 'noOrderBook';
  if (quote.price > cash) return 'tooExpensive';
  return screened ?? 'pass';
}

/*
 * 레버리지·인버스 상품을 가리는 이름 패턴.
 *
 * ── 왜 빼나 (2026-08-03 장중 실측) ────────────────────────────────────────
 *
 * 후보를 **거래대금 순**으로 고치자마자 러너가 이것들을 샀다. 자리 8개 중 셋이
 * 같은 기초자산이었다.
 *
 *   TIGER SK하이닉스단일종목레버리지  12,912,225 × 2배 = 25,824,450
 *   KODEX SK하이닉스단일종목레버리지  12,888,780 × 2배 = 25,777,560
 *   SK하이닉스(현물)                 12,712,000 × 1배 = 12,712,000
 *   ────────────────────────────────────────────────────────────
 *   SK하이닉스 실효 노출              64,314,010 = **총평가의 64.6%**
 *
 * `maxPositions`는 **종목 수**를 세지 위험을 세지 않는다. 여덟 자리가 여덟 개의
 * 다른 위험이라고 가정했는데 실제로는 한 종목의 파생 셋이었다. 분산이 아니라
 * 한 종목 몰빵이고, 거래대금 순 정렬이 이것을 부른다 — 단일종목 레버리지 ETF는
 * 거래대금이 크고 서로 상관이 1에 가깝다.
 *
 * 레버리지 상품에는 이 중복과 별개의 문제도 있다. **일간 수익률의 배수**를
 * 좇으므로 오르내림이 반복되면 기초자산이 제자리여도 값이 깎인다(변동성 끌림).
 * 이 레포의 백테스트는 그 성질을 모형에 넣지 않는다.
 *
 * 2026-08-03 기준 국내 ETF·ETN 1,158개 중 103개가 이 패턴에 걸린다.
 * 종목명으로 거르는 것은 어림이다 — 기초자산 구성 데이터가 없다. 그래서
 * **덜 사는 쪽으로 틀린다**: 이름에 표시가 없는 파생은 못 거르지만, 거른 것이
 * 파생이 아닌 경우는 없다.
 */
const LEVERAGED_NAME_PATTERN = /레버리지|인버스|\dX/;

export function isOrderableForAutoTrader(instrument: Instrument): boolean {
  if (instrument.country !== 'KR') return false;
  if (LEVERAGED_NAME_PATTERN.test(instrument.name)) return false;
  return instrument.assetType === 'stock' || instrument.assetType === 'etf' || instrument.assetType === 'etn';
}

/**
 * 현금으로 1주라도 살 수 있는 종목만 돌려준다.
 *
 * 허용 목록이 설정돼 있으면 그 안에서만 고른다 — 리스크 룰이 어차피 나머지를
 * 막으므로, 막힐 걸 알면서 후보에 올릴 이유가 없다.
 */
export interface CandidateResult {
  instruments: Instrument[];
  /**
   * 후보의 총 매도잔량(주). 주문 수량 상한을 재는 데 쓴다.
   *
   * 멀티시세가 주는 값이라 **여기서 넘기지 않으면 다시 물어야 한다** — 종목마다
   * 호가 조회 1회가 더 나간다. 값이 없는 종목은 키가 아예 없다(0을 넣지 않는다).
   */
  askDepthByInstrumentId: Map<string, number>;
  /** 비어 있을 때 왜 비었는지. 그대로 실행 기록에 남는다 */
  note?: string;
}

/*
 * 이번 회차에 훑기 시작할 자리. **회차마다 앞으로 밀린다.**
 *
 * ── 왜 (2026-08-03) ───────────────────────────────────────────────────────
 *
 * 이 함수는 늘 풀 **앞 240종목**만 값을 물었다. 풀은 `ORDER BY symbol`이라
 * 언제나 `000020 동화약품`부터다. 4,041종목 중 6%를, 그것도 매일 같은 6%를
 * 봤다. 그중 후보가 되는 것은 다시 앞 8종목이라 러너가 실제로 판단하는 대상은
 * **매 회차 같은 8종목(0.2%)**이었다. 종목 선정이 사실상 가나다순이었다.
 *
 * 한 회차에 전 종목을 물을 수는 없다 — 4,041종목이면 멀티시세 135회이고,
 * 모의 서버는 초당 1회라 148초다. 주기(60초)를 넘긴다.
 *
 * 그래서 **회차마다 다른 구간**을 본다. 17회차(약 17분)면 한 바퀴 돌고, 그동안
 * 본 종목의 거래대금을 아래 `turnoverBySymbol`에 쌓아 순위를 만든다. 호출 수는
 * 그대로다.
 */
let scanOffset = 0;

/*
 * 회차를 넘어 쌓이는 거래대금. **순위를 매기는 데만 쓴다.**
 *
 * 이 값으로 주문을 내지 않는다 — 값이 묵었을 수 있다. 주문에 쓰는 값(가격·
 * 잔량)은 언제나 이번 회차에 받은 것이다. 여기 쌓는 것은 "다음에 누구를 물어볼까"의
 * 근거일 뿐이다.
 *
 * 프로세스가 다시 뜨면 비고 17분에 걸쳐 다시 찬다. 그동안은 아는 만큼으로 고른다.
 */
const turnoverBySymbol = new Map<string, { turnover: number; at: number }>();

/** 시험이 회차 간 상태에 기대지 않게 하는 초기화. */
export function resetUniverseScanState(): void {
  scanOffset = 0;
  turnoverBySymbol.clear();
}

/*
 * 한 회차에서 **아직 안 본 종목**에 쓸 자리.
 *
 * 전부 거래대금 상위에만 쓰면 처음에 우연히 본 종목들이 계속 이기고 나머지는
 * 영영 후보가 못 된다. 반대로 전부 탐색에 쓰면 실제로 살 종목의 값이 묵는다.
 *
 * 자리가 남으면(아직 아는 종목이 적으면) 탐색이 더 가져간다 — 그래서 초반
 * 열몇 회차는 거의 전부 탐색이고, 4,041종목을 240씩 훑어 **약 17분**이면 한
 * 바퀴가 돈다. 그 뒤로는 상위 180 + 탐색 60이 된다.
 */
const EXPLORE_SLOTS = MULTI_QUOTE_MAX_CODES * 2;

/**
 * 이번 회차에 값을 물어볼 종목.
 *
 * **활용과 탐색을 섞는다.** 활용은 지금까지 본 것 중 거래대금 상위 — 1억을
 * 실제로 태울 수 있는 종목은 그쪽에 있고, 살 종목의 값이 가장 신선해야 한다.
 * 탐색은 아직 안 본 종목 — 순위를 만들려면 일단 값이 있어야 한다.
 *
 * 여기 쌓인 거래대금으로 **주문을 내지는 않는다.** 값이 묵었을 수 있다.
 * 주문에 쓰는 가격·잔량은 언제나 이번 회차에 받은 것이다.
 */
export function scanTargets(pool: Instrument[], size: number): Instrument[] {
  const unseen = pool.filter((instrument) => !turnoverBySymbol.has(instrument.symbol));
  const ranked = pool
    .filter((instrument) => turnoverBySymbol.has(instrument.symbol))
    .sort(
      (a, b) =>
        (turnoverBySymbol.get(b.symbol)?.turnover ?? 0) - (turnoverBySymbol.get(a.symbol)?.turnover ?? 0),
    );

  const exploreRoom = Math.min(unseen.length, Math.max(EXPLORE_SLOTS, size - ranked.length));
  const explore =
    exploreRoom > 0
      ? (() => {
          const start = scanOffset % unseen.length;
          scanOffset += exploreRoom;
          return [...unseen.slice(start), ...unseen.slice(0, start)].slice(0, exploreRoom);
        })()
      : [];

  // 같은 종목을 두 번 묻지 않는다. 묻는 자리가 한 칸 낭비된다.
  const picked: Instrument[] = [];
  const seen = new Set<string>();
  for (const instrument of [...ranked.slice(0, size - explore.length), ...explore]) {
    if (seen.has(instrument.id)) continue;
    seen.add(instrument.id);
    picked.push(instrument);
    if (picked.length >= size) break;
  }
  return picked;
}

/** 이번 회차에 받은 거래대금을 순위 재료로 쌓는다. */
export function rememberTurnover(symbol: string, turnover: number, at: number): void {
  if (!Number.isFinite(turnover) || turnover < 0) return;
  turnoverBySymbol.set(symbol, { turnover, at });
}

/* 후보가 없는 회차는 잔량도 없다. 매번 새 Map을 만들지 않는다. */
const EMPTY_ASK_DEPTH = new Map<string, number>();

/**
 * 거래소가 매긴 거래대금 상위 종목 중 **이 풀에 있는 것**.
 *
 * 풀에 없는 것은 조용히 빠진다 — 레버리지·인버스이거나 차단 목록에 있거나
 * 허용 목록 밖인 종목이다. 그 판정은 이미 풀을 만들 때 끝났고, 여기서 다시
 * 하면 두 곳에 같은 규칙이 생긴다.
 */
async function loadRankedInstruments(pool: Instrument[]): Promise<Instrument[]> {
  const symbols = await getDomesticTurnoverRanking(MULTI_QUOTE_MAX_CODES);
  if (symbols.length === 0) return [];
  const bySymbol = new Map(pool.map((instrument) => [instrument.symbol, instrument]));
  const ordered: Instrument[] = [];
  for (const symbol of symbols) {
    const instrument = bySymbol.get(symbol);
    if (instrument) ordered.push(instrument);
  }
  return ordered;
}

export async function loadAutoTraderCandidates(accountId: string, cash: number): Promise<CandidateResult> {
  const account = getKisAccount(accountId);
  if (!account) {
    return { instruments: [], askDepthByInstrumentId: EMPTY_ASK_DEPTH, note: '등록된 계좌가 아닙니다' };
  }
  if (cash <= 0) {
    return { instruments: [], askDepthByInstrumentId: EMPTY_ASK_DEPTH, note: '현금이 없습니다' };
  }

  const rules = await getRiskRules(accountId);
  const blocked = new Set(rules.symbolBlocklist);
  const allowed = rules.symbolAllowlist.length > 0 ? new Set(rules.symbolAllowlist) : null;

  /*
   * 국내 전 종목을 풀에 담는다. 예전에는 카테고리당 200개였다 — 그것만으로도
   * 조회 상한(240종목)을 채우니 문제가 안 보였는데, **풀 자체가 코드순 앞
   * 400종목**이라 4,041종목 중 나머지는 후보가 될 길이 없었다.
   *
   * 여기는 로컬 Postgres라 다 담아도 싸다. 실제로 몇 종목에 값을 물을지는
   * `scanTargets`가 정하고 그건 여전히 회차당 240종목이다.
   */
  const pools = await Promise.all(
    SOURCE_CATEGORIES.map((category) => getCategoryInstruments(category, 5_000).catch(() => [])),
  );
  const usable = pools.map((pool) =>
    pool
      .filter(isOrderableForAutoTrader)
      .filter((instrument) => !blocked.has(instrument.symbol))
      .filter((instrument) => (allowed ? allowed.has(instrument.symbol) : true)),
  );

  /*
   * 카테고리를 번갈아 뽑는다. 앞 카테고리를 통째로 먼저 쓰면 조회 상한을 거기서
   * 다 태우고, 예수금 5만원으로는 하나도 살 수 없어 매 회차 "후보 없음"으로 끝났다.
   * 실제로 그렇게 돌아갔다.
   *
   * (여기 원래 "국내 전체 목록은 **시총 순**이라 앞쪽이 전부 대형주"라고 적혀
   * 있었는데 틀렸다 — `getByFilter`는 검색어가 없으면 `ORDER BY symbol`이라 풀
   * 앞쪽은 `000020 동화약품`·`0000D0` ETF다. 결론은 그대로지만 근거가 달랐다.)
   *
   * **이제 여기서 자르지 않는다.** 자르면 잘린 종목은 `scanTargets`가 영영 못
   * 본다. 자르는 자리는 값을 물어보는 곳 하나뿐이다.
   */
  const pool: Instrument[] = [];
  const seen = new Set<string>();
  for (let index = 0; ; index += 1) {
    let added = false;
    for (const list of usable) {
      const instrument = list[index];
      if (!instrument || seen.has(instrument.id)) continue;
      seen.add(instrument.id);
      pool.push(instrument);
      added = true;
    }
    if (!added) break;
  }

  if (pool.length === 0) {
    return {
      instruments: [],
      askDepthByInstrumentId: EMPTY_ASK_DEPTH,
      note: allowed
        ? `리스크 룰의 허용 종목(${rules.symbolAllowlist.join(', ')}) 중 주문 가능한 국내 종목이 없습니다`
        : '주문 가능한 국내 종목을 찾지 못했습니다',
    };
  }

  /*
   * 값을 모르면 고를 수 없다. 전 종목을 한 회차에 훑을 수는 없으니
   * (4,041종목 = 멀티시세 135회 = 모의 서버에서 148초, 주기 60초를 넘긴다)
   * 회차마다 240종목씩 묻고, 확인한 것 중 통과한 것만 전략에게 넘어간다.
   *
   * **누구에게 물을지는 `scanTargets`가 정한다** — 예전에는 `pool.slice(0, 240)`,
   * 즉 언제나 종목코드 앞쪽이었다.
   */
  /*
   * ── 거래소 순위를 먼저 넣는다 (2026-08-04) ──────────────────────────────
   *
   * 예전에는 `scanTargets`만 썼다. 그런데 그것은 마스터를 **코드순으로** 240개씩
   * 훑는 것이라, 거래대금 상위 20종목 중 그 안에 든 것이 SK하이닉스 하나뿐이었다
   * (2026-08-04 실측). 삼성전자는 풀 406번째, NAVER는 1,131번째, SK이터닉스는
   * 3,702번째다. 회차마다 밀어 17분이면 한 바퀴 돌게 해 뒀지만 **서버가 재기동되면
   * 그 진행이 0으로 돌아가고**, 그날 아침에만 4번 재기동됐다.
   *
   * 거래소에 직접 물으면 훑을 필요가 없다. **KIS 호출 1회**로 지금 돈이 몰린
   * 종목이 온다.
   *
   * 훑기를 없애지는 않는다. 순위는 상위 몇십 종목까지만 주므로, 남는 조회 예산은
   * 그대로 훑기에 쓴다 — 순위 밖에도 살 만한 종목이 있고 그건 훑어야 안다.
   *
   * 순위 조회가 실패해도 후보 선정을 멈추지 않는다. 훑기만으로도 돌아간다 —
   * 예전 동작 그대로다.
   */
  const ranked = await loadRankedInstruments(pool).catch(() => [] as Instrument[]);
  const scanned = scanTargets(pool, Math.max(0, MAX_PRICE_LOOKUPS - ranked.length));
  const targets: Instrument[] = [];
  const targetSeen = new Set<string>();
  for (const instrument of [...ranked, ...scanned]) {
    if (targetSeen.has(instrument.id)) continue;
    targetSeen.add(instrument.id);
    targets.push(instrument);
  }
  const prices: number[] = [];
  const rejections: UniverseRejections = { tooExpensive: 0, noOrderBook: 0, illiquid: 0, costHeavy: 0 };
  const elapsed = sessionElapsedRatio();
  const batch = await getInstrumentQuotes(targets);
  const scannedAt = Date.now();
  const passed: Array<{ instrument: Instrument; turnover: number; askDepth?: number }> = [];

  for (const instrument of targets) {
    const quote = batch.quotes.get(instrument.id);
    // 값을 못 받은 종목은 거절이 아니다. 아래에서 따로 센다.
    if (!quote) continue;
    const price = quote.price;
    if (!Number.isFinite(price) || price <= 0) continue;
    prices.push(price);
    const turnover = quote.turnover ?? price * quote.accVolume;
    /*
     * 거른 종목의 거래대금도 쌓는다. 다음 회차에 누구를 물어볼지 정하는
     * 재료라, 오늘 예수금으로 못 사는 종목이라도 순위는 알아야 한다.
     */
    rememberTurnover(instrument.symbol, turnover, scannedAt);
    /*
     * 살 수 있다고 다 후보는 아니다. 백테스트에서 나온 숫자를 실제로
     * 거둘 수 있는 종목만 남긴다 — 호가가 있어야 애초에 체결되고, 물량이
     * 있어야 그 값에 체결되고, 하루 변동폭이 왕복 비용보다 넉넉해야 방향을
     * 맞혔을 때 남는다. 순서와 사유는 `verdictFor` 한 곳에 있다.
     */
    const verdict = verdictFor(quote, elapsed, cash, instrument);
    if (verdict !== 'pass') {
      rejections[verdict] += 1;
      continue;
    }
    passed.push({ instrument, turnover, askDepth: quote.totalAskQuantity });
  }

  if (passed.length > 0) {
    /*
     * **거래대금 내림차순으로 넘긴다.** 러너는 이 목록 앞에서부터 잘라 쓰므로
     * (`candleTargets`) 순서가 곧 선정이다. 예전에는 여기가 종목코드 순이라
     * 러너가 실제로 판단하는 8종목이 언제나 `000020`부터였다 — 선정이랄 것이 없었다.
     *
     * 거래대금으로 줄 세우는 것은 그것이 **체결 비용이 갈리는 축**이라서다.
     * 일봉 축 측정에서 표본을 층으로 가른 기준과 같다.
     */
    passed.sort((a, b) => b.turnover - a.turnover);
    const askDepthByInstrumentId = new Map<string, number>();
    for (const item of passed) {
      // 값이 없는 종목은 키를 넣지 않는다. 0을 넣으면 "잔량이 0"이 되어 못 산다.
      if (item.askDepth !== undefined) askDepthByInstrumentId.set(item.instrument.id, item.askDepth);
    }
    return { instruments: passed.map((item) => item.instrument), askDepthByInstrumentId };
  }

  /*
   * 못 물어본 종목을 말하지 않으면 "물어본 것 중에 없었다"와 "물었는데 값이
   * 안 왔다"가 같은 기록으로 남는다. 값이 안 온 것은 거절이 아니다.
   */
  const unresolved = targets.length - prices.length;
  const unresolvedHint = unresolved > 0 ? ` · 시세를 못 받은 종목 ${unresolved}개` : '';

  /*
   * 후보가 하나도 안 남는 이유는 대부분 둘 중 하나다 — 허용 종목이 좁게 잡혀
   * 있거나, 예수금으로 1주도 살 수 없는 값비싼 종목만 남았거나. 어느 쪽인지
   * 적어주지 않으면 매 회차 "후보 없음"만 쌓이고 무엇을 고쳐야 할지 알 수 없다.
   */
  const cheapest = Math.min(...prices.filter((price) => Number.isFinite(price) && price > 0));
  const priceHint = Number.isFinite(cheapest)
    ? `확인한 종목 중 가장 싼 것이 ${Math.round(cheapest).toLocaleString()}원입니다`
    : '가격을 확인하지 못했습니다';

  /*
   * 어느 문에서 걸렸는지 세어 적는다. `후보 없음`만 쌓이면 값을 올려야 할지
   * 필터를 낮춰야 할지 알 수 없다.
   */
  const filtered = rejections.noOrderBook + rejections.illiquid + rejections.costHeavy;
  if (filtered > 0) {
    const parts: string[] = [];
    if (rejections.tooExpensive > 0) parts.push(`가격 초과 ${rejections.tooExpensive}종목`);
    // "호가 없음"을 "거래대금 부족"에 섞지 않는다. 문턱을 낮춰도 살 수 없는 종목이다.
    if (rejections.noOrderBook > 0) parts.push(`호가 없음 ${rejections.noOrderBook}종목`);
    if (rejections.illiquid > 0) parts.push(`거래대금 부족 ${rejections.illiquid}종목`);
    if (rejections.costHeavy > 0) parts.push(`왕복 비용이 하루 변동폭의 절반을 넘음 ${rejections.costHeavy}종목`);
    return {
      instruments: [],
      askDepthByInstrumentId: EMPTY_ASK_DEPTH,
      note: `살 수 있는 종목은 있었지만 모두 걸러졌습니다 — ${parts.join(' · ')}. ${priceHint}${unresolvedHint}`,
    };
  }

  return {
    instruments: [],
    askDepthByInstrumentId: EMPTY_ASK_DEPTH,
    note: allowed
      ? `허용 종목(${rules.symbolAllowlist.join(', ')})을 현금 ${Math.floor(cash).toLocaleString()}원으로 1주도 살 수 없습니다 · ${priceHint}${unresolvedHint}`
      : `현금 ${Math.floor(cash).toLocaleString()}원으로 1주라도 살 수 있는 종목이 없습니다 · ${priceHint}${unresolvedHint}`,
  };
}
