/**
 * 멀티시세(FHKST11300006) 요청 조립·응답 해석 검증.
 *
 * **픽스처는 실계좌(prod)로 받은 실제 응답이다**(`fixtures/intstockMultprice-*.json`,
 * 2026-07-31 00:54 KST 녹화 = 2026-07-30 종가). 지어낸 모양으로 재면 실제와
 * 어긋나도 통과한다. 특히 **없는 종목코드가 전 필드 빈 문자열 행으로 자리를
 * 지킨다**는 것은 상상해서는 나오지 않는 모양이다.
 *
 * 이 파일이 잡아야 하는 결함은 하나로 모인다 — **한 칸 밀림.** 밀려도 나오는 값이
 * 다른 종목의 그럴듯한 가격이라 형식 검사로는 절대 안 걸린다. 그래서 값이 아니라
 * **자리와 코드**를 검사한다.
 *
 * 상한 30도 검사 대상 상수로 세지 않고 **실측 리터럴**로 적는다. 상수로 기대값을
 * 지으면 상수가 틀려도 기대값이 같이 틀리게 지어져 왕복이 맞아떨어진다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  chunkQuoteCodes,
  multiQuoteParams,
  parseMultiQuoteChunk,
} from './multiQuote.js';

/** 실측(2026-07-31): 31종목을 넣으면 rt_cd=0으로 응답하면서 30행만 온다. */
const MEASURED_MAX_CODES = 30;

/**
 * 응답을 받은 시각. 파서는 이 값을 **그대로 옮겨 담아야** 한다.
 *
 * KIS는 시세에 시각을 주지 않으므로(응답 29필드에 없다) 나이는 우리가 찍는
 * 수밖에 없다. 파서가 제 시계(`Date.now()`)를 보면 파싱 시각이 찍히고, 그러면
 * 캐시에서 다시 꺼낼 때 나이가 지워진다. 픽스처 녹화 시각을 그대로 쓴다.
 */
const FETCHED_AT = Date.parse('2026-07-31T00:54:11.441Z');

interface Fixture {
  recordedAt: string;
  requestedSymbols: string[];
  response: { rt_cd: string; msg_cd: string; msg1: string; output: Array<Record<string, string>> };
}

/**
 * 이 파일(backend/src/kis) 기준으로 잡는다. `process.cwd()`를 쓰면 레포 루트에서
 * 돌릴 때 파일을 못 찾아 시험이 조용히 건너뛰어진다.
 */
function fixture(name: string): Fixture {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', name);
  return JSON.parse(readFileSync(path, 'utf8')) as Fixture;
}

describe('chunkQuoteCodes', () => {
  it('30개씩 나눈다 — 반도체 테마 110종목은 4묶음', () => {
    const codes = Array.from({ length: 110 }, (_, i) => String(i).padStart(6, '0'));
    assert.deepEqual(
      chunkQuoteCodes(codes).map((chunk) => chunk.length),
      [30, 30, 30, 20],
    );
    // 나누면서 빠지거나 겹치면 안 된다.
    assert.deepEqual(chunkQuoteCodes(codes).flat(), codes);
  });

  it('딱 30개는 한 묶음, 31개부터 두 묶음', () => {
    const make = (n: number): string[] => Array.from({ length: n }, (_, i) => String(i).padStart(6, '0'));
    assert.deepEqual(chunkQuoteCodes(make(MEASURED_MAX_CODES)).map((c) => c.length), [30]);
    assert.deepEqual(chunkQuoteCodes(make(MEASURED_MAX_CODES + 1)).map((c) => c.length), [30, 1]);
  });

  it('빈 목록은 묶음도 없다 — 종목 0개로 호출이 나가면 KIS가 거부한다', () => {
    assert.deepEqual(chunkQuoteCodes([]), []);
  });
});

describe('multiQuoteParams', () => {
  it('번호는 1부터다 — 0부터 세면 첫 종목이 빠지고 필수 파라미터가 없어진다', () => {
    assert.deepEqual(multiQuoteParams(['005930', '000660']), {
      FID_COND_MRKT_DIV_CODE_1: 'J',
      FID_INPUT_ISCD_1: '005930',
      FID_COND_MRKT_DIV_CODE_2: 'J',
      FID_INPUT_ISCD_2: '000660',
    });
  });

  it('30종목이면 파라미터가 60개다', () => {
    const codes = Array.from({ length: MEASURED_MAX_CODES }, (_, i) => String(i).padStart(6, '0'));
    const params = multiQuoteParams(codes);
    assert.equal(Object.keys(params).length, MEASURED_MAX_CODES * 2);
    assert.equal(params[`FID_INPUT_ISCD_${MEASURED_MAX_CODES}`], codes[MEASURED_MAX_CODES - 1]);
  });

  it('31종목이면 던진다 — KIS는 오류가 아니라 조용히 30개로 자른다', () => {
    const codes = Array.from({ length: MEASURED_MAX_CODES + 1 }, (_, i) => String(i).padStart(6, '0'));
    assert.throws(() => multiQuoteParams(codes), /한 번에 30종목까지입니다/);
  });

  it('빈 목록이면 던진다', () => {
    assert.throws(() => multiQuoteParams([]), /종목코드가 하나도 없습니다/);
  });
});

describe('parseMultiQuoteChunk — 실제 응답 30종목', () => {
  const f = fixture('intstockMultprice-30.json');

  it('30행이 요청 순서 그대로 온다', () => {
    assert.equal(f.response.output.length, 30);
    assert.deepEqual(
      f.response.output.map((row) => row.inter_shrn_iscd),
      f.requestedSymbols,
    );
  });

  it('30종목 전부를 시세로 바꾼다 — 빈 자리 없음', () => {
    const parsed = parseMultiQuoteChunk(f.requestedSymbols, f.response.output, FETCHED_AT);
    assert.equal(parsed.quotes.length, 30);
    assert.deepEqual(parsed.blank, []);
    assert.deepEqual(parsed.quotes.map((q) => q.code), f.requestedSymbols);
  });

  it('값이 단건 조회(FHKST01010100)와 같다 — 같은 시각 실측치를 못 박는다', () => {
    const parsed = parseMultiQuoteChunk(f.requestedSymbols, f.response.output, FETCHED_AT);
    const byCode = new Map(parsed.quotes.map((q) => [q.code, q]));

    // 2026-07-30 종가. 단건 조회로 같은 값을 확인했다(probeMultiQuote compare).
    assert.deepEqual(byCode.get('000660'), {
      code: '000660',
      fetchedAt: FETCHED_AT,
      price: 1_322_000,
      change: -79_000,
      changeRate: -5.64,
      sign: '5',
      open: 1_361_000,
      high: 1_459_000,
      low: 1_287_000,
      accVolume: 9_543_189,
      turnover: 12_945_505_619_452,
      totalAskQuantity: 67_750,
      totalBidQuantity: 150_516,
    });
    assert.deepEqual(byCode.get('005930'), {
      code: '005930',
      fetchedAt: FETCHED_AT,
      price: 207_000,
      change: -1_500,
      changeRate: -0.72,
      sign: '5',
      open: 214_000,
      high: 226_000,
      low: 202_000,
      accVolume: 46_694_193,
      turnover: 9_915_591_555_814,
      totalAskQuantity: 278_890,
      totalBidQuantity: 1_017_500,
    });
  });

  /*
   * 어긋나는 크기를 이 한 종목으로 일반화하지 마라. 2026-07-30 스크리닝 풀 113종목
   * 실측에서 중앙값은 +0.28%이고 범위가 −6.68% ~ +6.24%다(부호가 양쪽). 005930이
   * +2.59%인 것을 "실측 2.5%"로 문서 세 곳에 적었다가 검증에서 걸렸다.
   */
  it('거래대금은 어림이 아니라 실제 값이다 — 005930은 어림이 2.59% 작다', () => {
    const parsed = parseMultiQuoteChunk(f.requestedSymbols, f.response.output, FETCHED_AT);
    const samsung = parsed.quotes.find((q) => q.code === '005930');
    assert.ok(samsung);
    const estimate = samsung.price * samsung.accVolume;
    assert.equal(samsung.turnover, 9_915_591_555_814);
    assert.equal(estimate, 9_665_697_951_000);
    // 어림값을 실제 값처럼 쓰면 이만큼 틀린다. 유동성 문턱이 이 값을 본다.
    assert.ok(Math.abs(estimate - (samsung.turnover ?? 0)) > 249_000_000_000);
  });

  /*
   * 시각을 인자로 받는 이유. 파서가 `Date.now()`를 부르면 이 시험이 죽는다 —
   * 픽스처는 2026-07-31 00:54 녹화분이고, 지금 시각과 같을 수 없다.
   */
  it('받은 시각을 그대로 옮겨 담는다 — 파서가 제 시계를 보지 않는다', () => {
    const parsed = parseMultiQuoteChunk(f.requestedSymbols, f.response.output, FETCHED_AT);
    assert.equal(parsed.quotes.length, 30);
    for (const quote of parsed.quotes) {
      assert.equal(quote.fetchedAt, FETCHED_AT, `${quote.code}의 시각이 인자와 다르다`);
    }
  });

  it('한 응답에서 나온 30종목은 시각이 하나다 — 파싱 순서가 나이가 되면 안 된다', () => {
    const parsed = parseMultiQuoteChunk(f.requestedSymbols, f.response.output, FETCHED_AT);
    assert.deepEqual([...new Set(parsed.quotes.map((q) => q.fetchedAt))], [FETCHED_AT]);
  });

  it('거래정지 종목의 0을 버리지 않는다 — 값이 0인 것과 값이 없는 것은 다르다', () => {
    const parsed = parseMultiQuoteChunk(f.requestedSymbols, f.response.output, FETCHED_AT);
    const halted = parsed.quotes.find((q) => q.code === '009310');
    assert.ok(halted, '009310은 시고저·거래량이 전부 0이지만 현재가는 5,330원이다');
    assert.equal(halted.price, 5_330);
    assert.equal(halted.accVolume, 0);
    assert.equal(halted.high, 0);
    assert.equal(halted.low, 0);
    assert.equal(halted.turnover, 0);
    assert.equal(parsed.blank.includes('009310'), false);
  });

  /*
   * 총 잔량을 담는 것 자체를 못 박는다. 안 담으면 `hasEmptyOrderBook`이 30종목
   * 전부 "모른다"로 떨어져 판정이 조용히 사라진다 — 값이 틀리는 게 아니라
   * 검사가 없어지는 쪽이라 화면으로는 안 보인다.
   */
  it('총 매도·매수 잔량을 담는다 — 30종목 중 잔량이 없는 행은 하나도 없다', () => {
    const parsed = parseMultiQuoteChunk(f.requestedSymbols, f.response.output, FETCHED_AT);
    const missing = parsed.quotes.filter(
      (q) => q.totalAskQuantity === undefined || q.totalBidQuantity === undefined,
    );
    assert.deepEqual(missing.map((q) => q.code), []);
  });

  it('거래정지 종목은 호가 잔량이 양쪽 다 0으로 온다 (009310 실측)', () => {
    const parsed = parseMultiQuoteChunk(f.requestedSymbols, f.response.output, FETCHED_AT);
    const halted = parsed.quotes.find((q) => q.code === '009310');
    assert.ok(halted);
    assert.equal(halted.totalAskQuantity, 0);
    assert.equal(halted.totalBidQuantity, 0);
    // 나머지 29종목은 양쪽 다 0이 아니다. 이게 갈라진다는 것이 판정의 근거다.
    const alsoEmpty = parsed.quotes.filter(
      (q) => q.code !== '009310' && q.totalAskQuantity === 0 && q.totalBidQuantity === 0,
    );
    assert.deepEqual(alsoEmpty.map((q) => q.code), []);
  });

  it('한쪽 잔량만 없으면 둘 다 안 담는다 — 반쪽으로는 판정할 수 없다', () => {
    const row = f.response.output.find((r) => r.inter_shrn_iscd === '005930');
    assert.ok(row);
    const parsed = parseMultiQuoteChunk(['005930'], [{ ...row, total_bidp_rsqn: '' }], FETCHED_AT);
    assert.equal(parsed.quotes.length, 1);
    assert.equal('totalAskQuantity' in parsed.quotes[0], false);
    assert.equal('totalBidQuantity' in parsed.quotes[0], false);
  });

  it('잔량 빈 문자열을 0으로 읽지 않는다 — 그러면 멀쩡한 종목이 호가 없음이 된다', () => {
    // `Number('')`은 0이다. 그대로 읽으면 잔량을 못 받은 종목이 "양쪽 0"이 되어
    // 전 종목이 거래정지로 판정된다.
    const row = f.response.output.find((r) => r.inter_shrn_iscd === '005930');
    assert.ok(row);
    const parsed = parseMultiQuoteChunk(
      ['005930'],
      [{ ...row, total_askp_rsqn: '', total_bidp_rsqn: '' }],
      FETCHED_AT,
    );
    assert.equal(parsed.quotes[0].totalAskQuantity, undefined);
    assert.equal(parsed.quotes[0].totalBidQuantity, undefined);
  });
});

describe('parseMultiQuoteChunk — 없는 종목코드가 섞인 실제 응답', () => {
  const f = fixture('intstockMultprice-missing.json');

  it('없는 코드는 전 필드가 빈 문자열인 행으로 자리를 지킨다 (실측)', () => {
    assert.deepEqual(f.requestedSymbols, ['005930', '000660', '999999', '042700', '069500']);
    assert.equal(f.response.output.length, 5);
    const bogusRow = f.response.output[2];
    assert.equal(bogusRow.inter_shrn_iscd, '');
    assert.equal(bogusRow.inter2_prpr, '');
    assert.equal(bogusRow.acml_vol, '');
    // 통째로 실패하지 않는다.
    assert.equal(f.response.rt_cd, '0');
  });

  it('빈 자리는 blank로 빼고 나머지는 제자리 값을 그대로 준다', () => {
    const parsed = parseMultiQuoteChunk(f.requestedSymbols, f.response.output, FETCHED_AT);
    assert.deepEqual(parsed.blank, ['999999']);
    assert.deepEqual(parsed.quotes.map((q) => q.code), ['005930', '000660', '042700', '069500']);

    /*
     * 여기가 이 시험의 핵심이다. 빈 행을 그냥 걸러내고 남은 행을 요청 순서에
     * 갖다 붙이면 999999 뒤가 한 칸씩 당겨져 042700이 069500의 값을 받는다.
     * 둘 다 실재하는 6자리 코드에 그럴듯한 가격이라 형식 검사로는 안 걸린다.
     */
    const byCode = new Map(parsed.quotes.map((q) => [q.code, q]));
    assert.equal(byCode.get('042700')?.price, 167_600);
    assert.equal(byCode.get('069500')?.price, 87_635);
    assert.notEqual(byCode.get('042700')?.price, byCode.get('069500')?.price);
  });

  it('빈 자리를 0원짜리 시세로 만들지 않는다', () => {
    const parsed = parseMultiQuoteChunk(f.requestedSymbols, f.response.output, FETCHED_AT);
    assert.equal(parsed.quotes.some((q) => q.price === 0), false);
    assert.equal(parsed.quotes.some((q) => q.code === '999999'), false);
  });

  it('빈 행이 빠져 뒤가 밀리면 던진다 — 값만 보면 멀쩡하다', () => {
    // KIS가 없는 코드의 행을 아예 빼는 쪽으로 바뀌면 이렇게 온다.
    const shifted = f.response.output.filter((row) => row.inter_shrn_iscd !== '');
    // 행 수까지 맞춰 놓아, 개수 검사만으로는 못 잡는 상황을 만든다.
    shifted.push(shifted[shifted.length - 1]);
    assert.equal(shifted.length, f.requestedSymbols.length);
    assert.throws(
      () => parseMultiQuoteChunk(f.requestedSymbols, shifted, FETCHED_AT),
      /응답 순서가 요청과 어긋났습니다: 3번째에 999999를 물었는데 042700가 왔습니다/,
    );
  });

  it('행 수가 다르면 던진다 — 31종목을 물었을 때 30행이 오는 그 상황이다', () => {
    assert.throws(
      () => parseMultiQuoteChunk([...f.requestedSymbols, '005490'], f.response.output, FETCHED_AT),
      /응답 행 수가 요청과 다릅니다: 요청 6종목, 응답 5행/,
    );
  });
});

describe('parseMultiQuoteChunk — 숫자가 아닌 값', () => {
  const f = fixture('intstockMultprice-missing.json');
  const good = f.response.output[0];

  it('코드는 왔는데 현재가가 비면 blank다 — NaN을 흘리면 유동성 검사를 그냥 통과한다', () => {
    const broken = { ...good, inter2_prpr: '' };
    const parsed = parseMultiQuoteChunk(['005930'], [broken], FETCHED_AT);
    assert.deepEqual(parsed.quotes, []);
    assert.deepEqual(parsed.blank, ['005930']);
  });

  it('거래량이 숫자가 아니면 blank다', () => {
    const broken = { ...good, acml_vol: '-' };
    const parsed = parseMultiQuoteChunk(['005930'], [broken], FETCHED_AT);
    assert.deepEqual(parsed.blank, ['005930']);
  });

  it('거래대금만 없으면 시세는 살리되 그 값은 담지 않는다', () => {
    // `Number('')`은 0이다. 그냥 읽으면 turnover가 0으로 들어가 "오늘 한 주도
    // 거래되지 않았다"가 되고, 유동성 문턱이 그걸 사실로 받아 종목을 거른다.
    assert.equal(Number(''), 0, '이 함정 때문에 toNumberOrNaN이 있다');

    const withoutTurnover = { ...good, acml_tr_pbmn: '' };
    const parsed = parseMultiQuoteChunk(['005930'], [withoutTurnover], FETCHED_AT);
    assert.equal(parsed.quotes.length, 1);
    assert.equal('turnover' in parsed.quotes[0], false, '0으로 채우면 거래가 없었던 것으로 읽힌다');
    assert.equal(parsed.quotes[0].price, 207_000);
  });

  it('빈 문자열을 0으로 읽지 않는다 — 거래량이 비면 blank지 0이 아니다', () => {
    const parsed = parseMultiQuoteChunk(['005930'], [{ ...good, acml_vol: '' }], FETCHED_AT);
    assert.deepEqual(parsed.quotes, []);
    assert.deepEqual(parsed.blank, ['005930']);
  });

  it('부호를 모르면 보합(3)으로 둔다 — 상승·하락 어느 쪽으로도 넘겨짚지 않는다', () => {
    const parsed = parseMultiQuoteChunk(['005930'], [{ ...good, prdy_vrss_sign: '' }], FETCHED_AT);
    assert.equal(parsed.quotes[0].sign, '3');
  });

  /*
   * 이 시험이 없어서 `isPositiveFinite(price)` → `isNonNegativeFinite(price)` 변이가
   * 살아남았다(2026-07-31 검증). 가상의 이야기가 아니다 — **단건 조회는 상장 직후
   * ETF에 `stck_prpr: "0"`을 실제로 준다**(`0021C0` 실측). 멀티는 지금 빈 문자열을
   * 주지만 언젠가 같은 `"0"`을 주기 시작하면 이 가드 하나만 남는다.
   *
   * 0원짜리 시세는 없는 사실이다. 거래정지 종목의 `시고저·거래량 0`과는 다르다 —
   * 그건 "오늘 안 거래됐다"는 참인 사실이고, 현재가 0은 "이 종목은 0원이다"라는
   * 거짓이다. 유동성 검사(`price * accVolume`)도 0을 그냥 통과시킨다.
   */
  it('현재가가 "0"이면 blank다 — 0원짜리 시세는 없는 사실이다', () => {
    const zeroPrice = { ...good, inter2_prpr: '0' };
    const parsed = parseMultiQuoteChunk(['005930'], [zeroPrice], FETCHED_AT);
    assert.deepEqual(parsed.quotes, [], '0원을 시세로 만들면 안 된다');
    assert.deepEqual(parsed.blank, ['005930']);
  });

  it('현재가 0을 거르는 것과 거래정지 종목의 0을 남기는 것은 다른 판단이다', () => {
    // 거래정지: 현재가는 있고 시고저·거래량만 0. 이건 살린다.
    // (009310 참엔지니어링 실측: 현재가 5,330 · 시고저 0 · 거래량 0)
    const halted = { ...good, inter2_oprc: '0', inter2_hgpr: '0', inter2_lwpr: '0', acml_vol: '0' };
    const parsedHalted = parseMultiQuoteChunk(['005930'], [halted], FETCHED_AT);
    assert.equal(parsedHalted.quotes.length, 1, '거래정지 종목을 잃으면 안 된다');
    assert.equal(parsedHalted.quotes[0].accVolume, 0);
  });
});
