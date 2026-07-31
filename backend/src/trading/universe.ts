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
import { getInstrumentQuotes, MULTI_QUOTE_MAX_CODES } from '../kis/rest.js';
import { DEFAULT_COSTS } from './backtest.js';

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
 * 2026-07-29 재측정에서 변동성 돌파가 백테스트 1회당 매매 13.4회에 비용이
 * 원금의 2.60%였다 — 다른 두 전략(0.58% / 0.60%)의 네 배가 넘는다.
 * 소액 계좌에서 비용은 전략을 고르는 문제가 아니라 후보를 고르는 문제다.
 */
export const MAX_COST_SHARE_OF_RANGE = 0.5;

/** 사고팔 때 한 번씩 드는 비용을 합친 비율. 백테스트가 쓰는 값과 같은 것을 쓴다. */
export const ROUND_TRIP_COST_RATE =
  DEFAULT_COSTS.commissionRate * 2 + DEFAULT_COSTS.sellTaxRate + DEFAULT_COSTS.slippageRate * 2;

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
 */
export function screenQuote(quote: Quote, elapsed: number): keyof UniverseRejections | null {
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
  if (rangeRate !== undefined && ROUND_TRIP_COST_RATE > rangeRate * MAX_COST_SHARE_OF_RANGE) {
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
export function verdictFor(quote: Quote, elapsed: number, cash: number): ScreeningVerdict {
  const screened = screenQuote(quote, elapsed);
  if (screened === 'noOrderBook') return 'noOrderBook';
  if (quote.price > cash) return 'tooExpensive';
  return screened ?? 'pass';
}

function isOrderable(instrument: Instrument): boolean {
  if (instrument.country !== 'KR') return false;
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
  /** 비어 있을 때 왜 비었는지. 그대로 실행 기록에 남는다 */
  note?: string;
}

export async function loadAutoTraderCandidates(accountId: string, cash: number): Promise<CandidateResult> {
  const account = getKisAccount(accountId);
  if (!account) return { instruments: [], note: '등록된 계좌가 아닙니다' };
  if (cash <= 0) return { instruments: [], note: '현금이 없습니다' };

  const rules = await getRiskRules(accountId);
  const blocked = new Set(rules.symbolBlocklist);
  const allowed = rules.symbolAllowlist.length > 0 ? new Set(rules.symbolAllowlist) : null;

  const pools = await Promise.all(
    SOURCE_CATEGORIES.map((category) => getCategoryInstruments(category, 200).catch(() => [])),
  );
  const usable = pools.map((pool) =>
    pool
      .filter(isOrderable)
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
   */
  const pool: Instrument[] = [];
  const seen = new Set<string>();
  for (let index = 0; pool.length < MAX_PRICE_LOOKUPS * 4; index += 1) {
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
      note: allowed
        ? `리스크 룰의 허용 종목(${rules.symbolAllowlist.join(', ')}) 중 주문 가능한 국내 종목이 없습니다`
        : '주문 가능한 국내 종목을 찾지 못했습니다',
    };
  }

  /*
   * 값을 모르면 고를 수 없다. 전 종목을 훑을 수는 없으니 앞에서 잘라 확인하고,
   * 확인한 것 중 통과한 것만 전략에게 넘어간다.
   *
   * 조회는 멀티시세로 30종목씩 묶어 나간다 — 종목당 1회이던 때는 24종목이
   * 24회였고, 지금은 240종목이 8회다.
   */
  const targets = pool.slice(0, MAX_PRICE_LOOKUPS);
  const prices: number[] = [];
  const rejections: UniverseRejections = { tooExpensive: 0, noOrderBook: 0, illiquid: 0, costHeavy: 0 };
  const elapsed = sessionElapsedRatio();
  const batch = await getInstrumentQuotes(targets);
  const instruments: Instrument[] = [];

  for (const instrument of targets) {
    const quote = batch.quotes.get(instrument.id);
    // 값을 못 받은 종목은 거절이 아니다. 아래에서 따로 센다.
    if (!quote) continue;
    const price = quote.price;
    if (!Number.isFinite(price) || price <= 0) continue;
    prices.push(price);
    /*
     * 살 수 있다고 다 후보는 아니다. 백테스트에서 나온 숫자를 실제로
     * 거둘 수 있는 종목만 남긴다 — 호가가 있어야 애초에 체결되고, 물량이
     * 있어야 그 값에 체결되고, 하루 변동폭이 왕복 비용보다 넉넉해야 방향을
     * 맞혔을 때 남는다. 순서와 사유는 `verdictFor` 한 곳에 있다.
     */
    const verdict = verdictFor(quote, elapsed, cash);
    if (verdict !== 'pass') {
      rejections[verdict] += 1;
      continue;
    }
    instruments.push(instrument);
  }
  if (instruments.length > 0) return { instruments };

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
      note: `살 수 있는 종목은 있었지만 모두 걸러졌습니다 — ${parts.join(' · ')}. ${priceHint}${unresolvedHint}`,
    };
  }

  return {
    instruments: [],
    note: allowed
      ? `허용 종목(${rules.symbolAllowlist.join(', ')})을 현금 ${Math.floor(cash).toLocaleString()}원으로 1주도 살 수 없습니다 · ${priceHint}${unresolvedHint}`
      : `현금 ${Math.floor(cash).toLocaleString()}원으로 1주라도 살 수 있는 종목이 없습니다 · ${priceHint}${unresolvedHint}`,
  };
}
