/**
 * 관심종목(멀티종목) 시세조회 `FHKST11300006`의 요청 조립과 응답 해석.
 *
 * 한 번의 호출로 **최대 30종목**을 받는다. 종목당 1회를 때리던 곳(후보 고르기·
 * 스크리닝·관심목록 배치)의 상한이 여기에 걸려 있었다.
 *
 * 파싱을 `rest.ts`에서 떼어 둔 이유는 `domesticMaster.ts`와 같다 — 자리(순서)를
 * 맞추는 계산이라 시험으로 못 박아야 하고, 시험이 네트워크·DB 없이 돌아야 한다.
 *
 * ## 2026-07-31 실계좌(prod)로 재서 확인한 것
 *
 * | 물음 | 실측 |
 * |------|------|
 * | 응답 형식 | 최상위 `output` **배열** 하나. `output1`/`output2`로 나뉘지 않는다 |
 * | 행당 필드 | 29개. 값은 `inter2_` 접두사, 코드·이름은 `inter_` 접두사다 |
 * | 30종목 | 30행. 요청 순서 그대로 |
 * | **31종목** | **`rt_cd=0`으로 정상 응답하면서 30행만 온다.** 31번째는 조용히 사라진다 |
 * | 20종목 | 20행. 파라미터를 덜 채워도 된다 |
 * | 없는 코드(`999999`) | **그 자리만 전 필드가 빈 문자열인 행으로 온다.** 통째로 실패하지 않는다 |
 * | ETF | 된다. `FID_COND_MRKT_DIV_CODE`는 주식과 같은 `J` |
 * | 단건(`FHKST01010100`)과 값 | 현재가·전일대비·등락률·부호·시가·고가·저가·거래량·거래대금이 **전부 일치** |
 *
 * **31종목이 오류가 아니라는 것이 이 API의 함정이다.** 묶는 크기를 잘못 잡으면
 * `rt_cd=0`을 받고도 종목이 조용히 빠진 채로 "이 테마는 이게 전부"라고 적게 된다.
 * 그래서 `MULTI_QUOTE_MAX_CODES`를 넘겨 부르지 않고, 응답 자리도 코드로 검산한다.
 *
 * ## 값이 없을 때 단건과 다르게 말한다
 *
 * 상장 직후라 아직 시세가 없는 ETF(`0021C0` ACE TDF장기자산배분액티브 등)를 물으면
 * 두 API가 다르게 답한다 — **단건은 `stck_prpr = 0`으로 0을 주고, 멀티는 빈 문자열을
 * 준다**(2026-07-31 실측). 그래서 이쪽은 `blank`로 갈라낼 수 있고, 단건 경로는
 * `현재가 0원`이라는 없는 사실을 만든다. 부르는 쪽이 `price <= 0`을 따로 걸러야 하는
 * 이유가 여기 있다.
 *
 * ## 전일종가와 기준가는 다른 값이다
 *
 * 응답에 `inter2_prdy_clpr`(전일종가)와 `inter2_sdpr`(기준가)이 **둘 다** 있다.
 * 주식은 보통 같지만 ETF는 갈린다 — 069500(KODEX 200) 실측에서 전일종가 89,605 ·
 * 기준가 89,425였다(분배금). 등락률(`prdy_ctrt`)과 전일대비(`inter2_prdy_vrss`)는
 * **기준가 기준**이다: (87,635 − 89,425) ÷ 89,425 = −2.00%로 `prdy_ctrt`와 맞는다.
 * 우리 `Quote`는 둘 다 담지 않으므로 여기서는 읽지 않는다. 나중에 담을 때
 * 아무 쪽이나 고르면 ETF에서 어긋난다.
 */

import type { Quote } from '@invest/shared';

import { isNonNegativeFinite, isPositiveFinite, parseSign, toNumberOrNaN } from './normalize.js';

export const MULTI_QUOTE_PATH = '/uapi/domestic-stock/v1/quotations/intstock-multprice';
export const MULTI_QUOTE_TR_ID = 'FHKST11300006';

/**
 * 한 번에 넣을 수 있는 종목 수. **넘겨도 오류가 아니라 조용히 잘린다**(실측).
 * 늘려 보고 싶으면 이 상수만 고치지 말고 실호출로 행 수를 다시 세라.
 */
export const MULTI_QUOTE_MAX_CODES = 30;

/** 시장 구분. `J`=KRX. 주식·ETF·ETN이 모두 `J`다(`NX`는 넥스트레이드, 우리는 안 쓴다). */
export const MULTI_QUOTE_MARKET_CODE = 'J';

/** 응답 행의 종목코드 필드. 코드·이름만 `inter_`, 시세 값은 `inter2_` 접두사다. */
const CODE_FIELD = 'inter_shrn_iscd';

/** 한 묶음을 해석한 결과. **못 받은 것을 빈 값으로 지우지 않는다.** */
export interface MultiQuoteChunkResult {
  quotes: Quote[];
  /**
   * 자리는 왔는데 값이 없던 종목코드. 없는 코드·상장폐지·조회 불가가 여기로 온다.
   * `quotes`에 0원짜리로 섞으면 "값이 0"과 "값이 없음"이 구별되지 않는다.
   */
  blank: string[];
}

/**
 * 종목코드를 30개씩 나눈다.
 *
 * 30을 넘겨 보내면 KIS가 `rt_cd=0`으로 답하면서 뒤를 버리므로, 나누는 쪽에서
 * 지켜야 한다. 302개 테마 중 반도체가 110종목이라 실제로 매번 나뉜다.
 */
export function chunkQuoteCodes(codes: string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < codes.length; index += MULTI_QUOTE_MAX_CODES) {
    chunks.push(codes.slice(index, index + MULTI_QUOTE_MAX_CODES));
  }
  return chunks;
}

/**
 * `FID_COND_MRKT_DIV_CODE_n` / `FID_INPUT_ISCD_n` 쌍을 만든다. n은 **1부터**다.
 * 0부터 세면 첫 종목이 통째로 빠지고, 필수 파라미터가 없어 KIS가 거부한다.
 */
export function multiQuoteParams(codes: string[]): Record<string, string> {
  if (codes.length === 0) throw new Error('멀티시세에 종목코드가 하나도 없습니다');
  if (codes.length > MULTI_QUOTE_MAX_CODES) {
    // 여기서 막지 않으면 KIS가 정상 응답으로 뒤를 잘라 버려 아무도 눈치채지 못한다.
    throw new Error(
      `멀티시세는 한 번에 ${MULTI_QUOTE_MAX_CODES}종목까지입니다 (${codes.length}종목을 넣었습니다)`,
    );
  }
  const params: Record<string, string> = {};
  codes.forEach((code, index) => {
    params[`FID_COND_MRKT_DIV_CODE_${index + 1}`] = MULTI_QUOTE_MARKET_CODE;
    params[`FID_INPUT_ISCD_${index + 1}`] = code;
  });
  return params;
}

/**
 * 응답 행을 요청 순서에 맞춰 `Quote`로 바꾼다.
 *
 * **자리를 코드로 검산한다.** 없는 코드가 빈 행으로 자리를 지킨다는 것은 실측으로
 * 확인했지만, 언젠가 KIS가 그 행을 빼면 뒤가 통째로 한 칸씩 밀린다. 그때 나오는
 * 값은 **다른 종목의 그럴듯한 가격**이라 형식 검사로는 절대 안 걸린다. 어긋나면 던진다.
 *
 * `fetchedAt`은 인자로 받는다. 여기서 `Date.now()`를 부르면 파싱 시각이 찍히고,
 * 시험이 시계를 갈아 끼워야 돌아간다. 응답을 받은 쪽(`rest.ts`)이 그 시각을 안다.
 */
export function parseMultiQuoteChunk(
  requestedCodes: string[],
  rows: Array<Record<string, string>>,
  fetchedAt: number,
): MultiQuoteChunkResult {
  if (rows.length !== requestedCodes.length) {
    throw new Error(
      `멀티시세 응답 행 수가 요청과 다릅니다: 요청 ${requestedCodes.length}종목, 응답 ${rows.length}행`,
    );
  }

  const quotes: Quote[] = [];
  const blank: string[] = [];

  requestedCodes.forEach((requested, index) => {
    const row = rows[index];
    const code = String(row[CODE_FIELD] ?? '').trim();
    if (code === '') {
      // 실측: 없는 종목코드는 전 필드가 빈 문자열인 행으로 자리만 지킨다.
      blank.push(requested);
      return;
    }
    if (code !== requested) {
      throw new Error(
        `멀티시세 응답 순서가 요청과 어긋났습니다: ${index + 1}번째에 ${requested}를 물었는데 ${code}가 왔습니다`,
      );
    }
    const quote = toQuote(code, row, fetchedAt);
    if (!quote) {
      // 코드는 왔는데 숫자가 안 온 행. 0으로 채우면 "거래대금 0"으로 읽혀
      // 유동성 문턱에 걸린 것처럼 보인다. 값이 없는 것은 값이 아니다.
      blank.push(requested);
      return;
    }
    quotes.push(quote);
  });

  return { quotes, blank };
}

/**
 * 행 하나를 `Quote`로. 필수 숫자가 하나라도 숫자가 아니면 `null`이다.
 *
 * `NaN`을 그대로 흘리면 안 된다 — `screenQuote`의 `NaN < 문턱`은 false라
 * **값을 모르는 종목이 유동성 검사를 통과해 버린다.**
 *
 * 빈 문자열을 `Number()`에 넣으면 **0**이 나오므로 `toNumberOrNaN`으로 읽는다.
 * 그냥 읽으면 값이 안 온 종목이 "거래대금 0원"이 되어 사실이 하나 지어진다.
 */
function toQuote(code: string, row: Record<string, string>, fetchedAt: number): Quote | null {
  const price = toNumberOrNaN(row.inter2_prpr);
  const change = toNumberOrNaN(row.inter2_prdy_vrss);
  const changeRate = toNumberOrNaN(row.prdy_ctrt);
  const open = toNumberOrNaN(row.inter2_oprc);
  const high = toNumberOrNaN(row.inter2_hgpr);
  const low = toNumberOrNaN(row.inter2_lwpr);
  const accVolume = toNumberOrNaN(row.acml_vol);

  if (!isPositiveFinite(price)) return null;
  if (!Number.isFinite(change) || !Number.isFinite(changeRate)) return null;
  /*
   * 시가·고가·저가·거래량은 0이 정상이다. 거래정지 종목이 실제로 그렇게 온다 —
   * 009310(참엔지니어링) 실측: 현재가 5,330 · 시고저 0 · 거래량 0 · 거래대금 0.
   * 0을 버리면 "오늘 안 거래된 종목"을 통째로 잃는다.
   */
  if (![open, high, low, accVolume].every(isNonNegativeFinite)) return null;

  const turnover = toNumberOrNaN(row.acml_tr_pbmn);

  return {
    code,
    // 응답 하나에서 나온 30종목은 전부 같은 시각이다. 행마다 다시 재면 파싱 순서가 나이가 된다.
    fetchedAt,
    price,
    change,
    changeRate,
    sign: parseSign(row.prdy_vrss_sign),
    open,
    high,
    low,
    accVolume,
    // 누적 거래대금. 없으면 담지 않는다 — 0으로 채우면 유동성 문턱에 걸린 것처럼 보인다.
    ...(isNonNegativeFinite(turnover) ? { turnover } : {}),
  };
}
