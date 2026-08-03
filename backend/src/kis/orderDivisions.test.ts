/**
 * 주문구분 코드 표 검증.
 *
 * 이 표가 틀리면 **다른 뜻으로 주문이 접수될 수** 있다 — 거절되는 것보다 나쁘다.
 * 그래서 값 자체보다 **확인된 것과 아닌 것이 섞이지 않는지**를 못 박는다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONFIRMED_ORDER_DIVISIONS,
  UNCONFIRMED_ORDER_DIVISIONS,
  usesZeroPrice,
} from './orderDivisions.js';

describe('주문구분 — 실주문으로 확인한 값', () => {
  /* 2026-08-03에 이 두 값으로 실제 체결됐다(경방·SK하이닉스 외). */
  it('지정가 00 · 시장가 01', () => {
    assert.equal(CONFIRMED_ORDER_DIVISIONS.limit, '00');
    assert.equal(CONFIRMED_ORDER_DIVISIONS.market, '01');
  });

  /* KIS 공식 예제 kis_domstk.py 454·528행. 문서 근거는 있고 주문 확인은 아직 없다. */
  it('장전 시간외 05', () => {
    assert.equal(CONFIRMED_ORDER_DIVISIONS.preMarketClose, '05');
  });

  it('전부 두 자리 숫자다', () => {
    for (const code of Object.values(CONFIRMED_ORDER_DIVISIONS)) {
      assert.match(code, /^\d{2}$/, code);
    }
  });
});

describe('주문구분 — 아직 모르는 것', () => {
  /*
   * 장후 시간외는 사용자가 원하는 기능이다(정규장에 못 판 것을 종가로 정리).
   * 존재는 공식 예제 715행이 말하지만 **코드값은 어디에도 없다.**
   * 여기 남아 있는 한 주문 경로에 넣으면 안 된다.
   */
  it('장후 시간외와 시간외 단일가는 확인된 표에 없다', () => {
    const confirmed: string[] = Object.values(CONFIRMED_ORDER_DIVISIONS);
    assert.ok(!confirmed.includes('06'), '06을 확인 없이 넣지 않았다');
    assert.ok(!confirmed.includes('07'), '07을 확인 없이 넣지 않았다');
    assert.equal(UNCONFIRMED_ORDER_DIVISIONS.length, 2);
  });
});

describe('단가를 비우는 주문구분', () => {
  /* 공식 예제 715행: 장전 시간외·장후 시간외·시장가는 단가를 '0'으로 보낸다. */
  it('시장가와 장전 시간외는 단가를 0으로 보낸다', () => {
    assert.equal(usesZeroPrice(CONFIRMED_ORDER_DIVISIONS.market), true);
    assert.equal(usesZeroPrice(CONFIRMED_ORDER_DIVISIONS.preMarketClose), true);
  });

  it('지정가는 실제 단가를 보낸다', () => {
    assert.equal(usesZeroPrice(CONFIRMED_ORDER_DIVISIONS.limit), false);
  });
});
