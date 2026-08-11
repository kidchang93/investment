/**
 * 현금 주문 본문 조립 검증.
 *
 * ★ 이 시험이 지키는 것은 둘이다.
 *
 * 1. **기존 주문 경로(`00`·`01`·`06`)가 한 글자도 바뀌지 않는다.** 스톱지정가를
 *    열면서 같은 함수를 지나가므로, 지금까지 실제로 체결된 그 본문을 통째로
 *    적어 두고 비교한다. 필드 하나가 바뀌어도 여기서 걸린다
 * 2. **짝이 안 맞는 스톱지정가는 나가지 않는다.** 거절되면 그나마 낫고, 조건
 *    없이 접수되면 손절을 걸었다고 믿는 주문이 손절 없이 시장에 남는다
 *
 * 네트워크가 필요 없다 — 조립은 순수 함수이고, 그래서 실주문 없이 잴 수 있다.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import type { KisAccountConfig } from '../config.js';
import { assertStopLimitPair, orderCashPayload } from './orderCash.js';
import {
  AFTER_HOURS_CLOSE_CANDIDATE,
  CONFIRMED_ORDER_DIVISIONS,
  isUnconfirmedDivision,
  STOP_LIMIT_ORDER_DIVISION,
} from './orderDivisions.js';
import type { OrderVenue } from './orderVenues.js';
import { placeKisDomesticOrder } from './rest.js';

const ACCOUNT = { cano: '12345678', productCode: '01' } as const;

function payload(overrides: Partial<Parameters<typeof orderCashPayload>[0]> = {}) {
  return orderCashPayload({
    ...ACCOUNT,
    symbol: '005930',
    side: 'buy',
    division: CONFIRMED_ORDER_DIVISIONS.limit,
    quantity: 3,
    limitPrice: 68_000,
    venue: 'KRX',
    ...overrides,
  });
}

describe('현금 주문 본문 — 기존 경로가 그대로다', () => {
  /* 2026-08-03에 이 모양으로 실제 체결됐다. 한 필드도 달라지면 안 된다. */
  it('지정가 매수', () => {
    assert.deepEqual(payload(), {
      CANO: '12345678',
      ACNT_PRDT_CD: '01',
      PDNO: '005930',
      ORD_DVSN: '00',
      ORD_QTY: '3',
      ORD_UNPR: '68000',
      EXCG_ID_DVSN_CD: 'KRX',
      SLL_TYPE: '',
      CNDT_PRIC: '',
    });
  });

  it('지정가 매도 — 매도에만 SLL_TYPE이 붙는다', () => {
    assert.equal(payload({ side: 'sell' }).SLL_TYPE, '01');
    assert.equal(payload({ side: 'buy' }).SLL_TYPE, '');
  });

  /* 시장가는 단가를 빈 문자열이 아니라 '0'으로 보낸다(공식 예제 715행). */
  it('시장가는 단가가 0이고 조건가격 자리는 빈 값이다', () => {
    const body = payload({ division: CONFIRMED_ORDER_DIVISIONS.market, limitPrice: undefined });
    assert.equal(body.ORD_DVSN, '01');
    assert.equal(body.ORD_UNPR, '0');
    assert.equal(body.CNDT_PRIC, '');
  });

  /*
   * 러너의 장후 시간외 청산 경로. 단가 없이 `06`으로 나간다 — 여기가 깨지면
   * 그 경로가 조용히 `ORD_UNPR: ''`로 바뀐다.
   */
  it('장후 시간외 후보(06)도 단가가 0이다', () => {
    const body = payload({ division: AFTER_HOURS_CLOSE_CANDIDATE, limitPrice: undefined });
    assert.equal(body.ORD_UNPR, '0');
  });

  it('수량·단가는 내림해서 정수 문자열로 나간다', () => {
    const body = payload({ quantity: 3.9, limitPrice: 68_000.7 });
    assert.equal(body.ORD_QTY, '3');
    assert.equal(body.ORD_UNPR, '68000');
  });
});

describe('스톱지정가 — 정상 조합', () => {
  const stopLimit = {
    division: STOP_LIMIT_ORDER_DIVISION,
    limitPrice: 27_000,
    conditionPrice: 26_000,
  } as const;

  /*
   * 미래에셋 안내의 예시 그대로다 — 스톱가 26,000 · 지정가 27,000에 닿으면
   * 27,000으로 주문이 나간다.
   */
  it('조건가격이 CNDT_PRIC에, 지정가가 ORD_UNPR에 들어간다', () => {
    const body = payload(stopLimit);
    assert.equal(body.ORD_DVSN, '22');
    assert.equal(body.CNDT_PRIC, '26000');
    assert.equal(body.ORD_UNPR, '27000');
  });

  it('조건가격도 내림해서 정수 문자열로 나간다', () => {
    assert.equal(payload({ ...stopLimit, conditionPrice: 26_000.9 }).CNDT_PRIC, '26000');
  });

  it('NXT도 스톱지정가를 받는다 — 막는 것은 SOR뿐이다', () => {
    assert.equal(payload({ ...stopLimit, venue: 'NXT' }).CNDT_PRIC, '26000');
  });

  /*
   * ★ 아직 접수시켜 본 적이 없다. 이 값이 확인된 표로 올라가는 날 이 시험이
   * 실패하는데, 그때는 **주석과 기록 문구를 함께 고치라는 신호**다.
   */
  it('아직 미확인 주문구분이다 — 쓰는 경로는 그 사실을 기록에 남긴다', () => {
    assert.equal(isUnconfirmedDivision(STOP_LIMIT_ORDER_DIVISION), true);
  });
});

describe('스톱지정가 — 짝이 안 맞으면 보내지 않는다', () => {
  it('22인데 조건가격이 없으면 던진다', () => {
    assert.throws(
      () => payload({ division: STOP_LIMIT_ORDER_DIVISION, limitPrice: 27_000 }),
      /조건가격이 필요합니다/,
    );
    // 무엇을 해야 하는지까지 말한다 — 코드만 던지면 사람이 원인을 못 찾는다.
    assert.throws(
      () => payload({ division: STOP_LIMIT_ORDER_DIVISION, limitPrice: 27_000 }),
      /주문을 보내지 않았습니다/,
    );
  });

  it('조건가격이 0이나 음수여도 없는 것과 같다', () => {
    for (const conditionPrice of [0, -1, Number.NaN]) {
      assert.throws(
        () => payload({ division: STOP_LIMIT_ORDER_DIVISION, limitPrice: 27_000, conditionPrice }),
        /조건가격이 필요합니다/,
        `conditionPrice=${String(conditionPrice)}`,
      );
    }
  });

  /*
   * 스톱가에 닿았을 때 얼마에 낼지가 없으면 `ORD_UNPR`이 '0'으로 나간다.
   * 그건 스톱지정가가 아니라 값이 빠진 주문이다.
   */
  it('22인데 지정가가 없으면 던진다', () => {
    assert.throws(
      () => payload({ division: STOP_LIMIT_ORDER_DIVISION, conditionPrice: 26_000, limitPrice: undefined }),
      /지정가도 필요합니다/,
    );
  });

  /*
   * **조용히 무시하면 안 된다.** 부르는 쪽은 스톱을 걸었다고 믿는데 실제로는
   * 그냥 지정가 주문이 나간다 — 그 사실은 값이 크게 움직인 뒤에야 드러난다.
   */
  it('22가 아닌데 조건가격이 오면 던진다', () => {
    assert.throws(
      () => payload({ division: CONFIRMED_ORDER_DIVISIONS.limit, conditionPrice: 26_000 }),
      /조건가격은 스톱지정가/,
    );
    assert.throws(
      () => payload({ division: CONFIRMED_ORDER_DIVISIONS.market, limitPrice: undefined, conditionPrice: 26_000 }),
      /조건가격은 스톱지정가/,
    );
  });

  /*
   * SOR은 `OrderVenue` 타입에 아직 없다 — 그래서 여기서만 캐스트로 넣어 본다.
   * 타입이 넓어지는 날 스톱지정가가 함께 새어 나가지 않는지가 이 시험의 값어치다.
   * 개발자센터 `ORD_DVSN` 표와 미래에셋 안내가 독립적으로 SOR에는 없다고 적었다.
   */
  it('SOR로는 스톱지정가를 보내지 않는다', () => {
    assert.throws(
      () =>
        payload({
          division: STOP_LIMIT_ORDER_DIVISION,
          limitPrice: 27_000,
          conditionPrice: 26_000,
          venue: 'SOR' as OrderVenue,
        }),
      /스톱지정가\(주문구분 22\)를 받지 않습니다/,
    );
  });

  /* 가드만 따로 부를 수 있어야 한다 — 조립 전에 물어보는 자리가 생길 수 있다. */
  it('가드는 따로도 선다', () => {
    assert.doesNotThrow(() =>
      assertStopLimitPair({
        division: STOP_LIMIT_ORDER_DIVISION,
        conditionPrice: 26_000,
        limitPrice: 27_000,
        venue: 'KRX',
      }),
    );
    assert.doesNotThrow(() =>
      assertStopLimitPair({ division: CONFIRMED_ORDER_DIVISIONS.limit, limitPrice: 68_000, venue: 'KRX' }),
    );
  });
});

/*
 * 순수 함수가 던지는 것만으로는 모자란다 — **주문 함수가 그것을 실제로 지나가는지**가
 * 남는다. 가드를 통과 못 한 주문이 KIS에 닿기 전에 멈추는 것까지 확인한다.
 *
 * `fetch`를 가로채는 방식은 `credentialPairing.test.ts`와 같다. 전역을 바꾸는 것은
 * 위험하지만 시험 하나 범위이고 `afterEach`에서 반드시 되돌린다.
 */
const realFetch = globalThis.fetch;
let fetchCalls = 0;

const TEST_ACCOUNT: KisAccountConfig = {
  id: 'TEST',
  label: '시험용',
  appKey: 'test-key',
  appSecret: 'test-secret',
  cano: '12345678',
  productCode: '01',
};

describe('주문 함수도 같은 가드를 지난다', () => {
  beforeEach(() => {
    fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('시험 중에는 KIS로 나가면 안 된다');
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('조건가격 없는 스톱지정가는 토큰조차 받으러 가지 않는다', async () => {
    await assert.rejects(
      placeKisDomesticOrder(TEST_ACCOUNT, {
        symbol: '005930',
        side: 'buy',
        orderType: 'limit',
        quantity: 1,
        limitPrice: 68_000,
        orderDivision: STOP_LIMIT_ORDER_DIVISION,
      }),
      /조건가격이 필요합니다/,
    );
    assert.equal(fetchCalls, 0, 'KIS로 나가기 전에 막아야 한다');
  });

  it('지정가에 조건가격을 실어 보내도 나가지 않는다', async () => {
    await assert.rejects(
      placeKisDomesticOrder(TEST_ACCOUNT, {
        symbol: '005930',
        side: 'buy',
        orderType: 'limit',
        quantity: 1,
        limitPrice: 68_000,
        conditionPrice: 26_000,
      }),
      /조건가격은 스톱지정가/,
    );
    assert.equal(fetchCalls, 0);
  });
});
