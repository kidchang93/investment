/**
 * 해외주식 주문 본문의 **계약**을 못 박는다.
 *
 * 주문은 한 번 나가면 되돌릴 수 없다. 그래서 조립 결과 자체를 시험에 태운다 —
 * `orderCash.test.ts`와 같은 이유다.
 */

import assert from 'node:assert/strict';
import { describe as suite, it } from 'node:test';

import {
  OVERSEAS_LIMIT_ORDER_DIVISION, overseasOrderPayload, overseasOrderTr,
} from './orderOverseas.js';

const base = {
  cano: '12345678',
  productCode: '01',
  exchange: 'NASD' as const,
  symbol: 'AAPL',
  quantity: 1,
  limitPrice: 190.25,
};

suite('해외주식 TR 고르기', () => {
  it('★★ 미국 **매도 모의**는 VTTT1001U다 — 실전(TTTT1006U)에 V를 붙인 값이 아니다', () => {
    /*
     * 2026-09-10에 KIS 공식 예제에서 확인한 비대칭. 매수는 실전 TTTT1002U /
     * 모의 VTTT1002U로 뒤 네 자리가 같은데, **매도만 다르다.**
     * 규칙으로 만들면(실전 번호에 V) 매도가 엉뚱한 TR로 나간다.
     */
    assert.equal(overseasOrderTr('NASD', 'sell', 'vts'), 'VTTT1001U');
    assert.equal(overseasOrderTr('NASD', 'sell', 'prod'), 'TTTT1006U');
    assert.notEqual(overseasOrderTr('NASD', 'sell', 'vts'), 'VTTT1006U');
  });

  it('미국 매수는 실전·모의가 뒤 네 자리를 공유한다', () => {
    assert.equal(overseasOrderTr('NASD', 'buy', 'prod'), 'TTTT1002U');
    assert.equal(overseasOrderTr('NASD', 'buy', 'vts'), 'VTTT1002U');
  });

  it('미국 세 거래소는 같은 TR을 쓴다 — TR은 거래소가 아니라 시장 단위다', () => {
    for (const side of ['buy', 'sell'] as const) {
      const nasd = overseasOrderTr('NASD', side, 'vts');
      assert.equal(overseasOrderTr('NYSE', side, 'vts'), nasd);
      assert.equal(overseasOrderTr('AMEX', side, 'vts'), nasd);
    }
  });

  it('시장마다 TR이 다르다 — 미국 것을 다른 시장에 쓰지 않는다', () => {
    assert.notEqual(overseasOrderTr('TKSE', 'buy', 'vts'), overseasOrderTr('NASD', 'buy', 'vts'));
    assert.notEqual(overseasOrderTr('SEHK', 'buy', 'vts'), overseasOrderTr('NASD', 'buy', 'vts'));
  });

  it('모르는 거래소는 **던진다** — 기본값으로 미국에 보내지 않는다', () => {
    assert.throws(
      () => overseasOrderTr('XXXX' as never, 'buy', 'vts'),
      /모르는 거래소/,
    );
  });
});

suite('해외주식 주문 본문', () => {
  it('지정가 주문구분과 필수 칸을 채운다', () => {
    const body = overseasOrderPayload({ ...base, side: 'buy' });
    assert.equal(body.CANO, '12345678');
    assert.equal(body.OVRS_EXCG_CD, 'NASD');
    assert.equal(body.PDNO, 'AAPL');
    assert.equal(body.ORD_QTY, '1');
    assert.equal(body.ORD_DVSN, OVERSEAS_LIMIT_ORDER_DIVISION);
    assert.equal(body.ORD_SVR_DVSN_CD, '0');
  });

  it('★ 단가는 소수 둘째 자리로 보낸다 — 반올림하면 낼 수 없는 값이 된다', () => {
    // 미국 호가가 0.01달러다. 정수로 만들면 그 값에 주문을 낼 수 없다.
    assert.equal(overseasOrderPayload({ ...base, side: 'buy' }).OVRS_ORD_UNPR, '190.25');
    assert.equal(
      overseasOrderPayload({ ...base, side: 'buy', limitPrice: 7 }).OVRS_ORD_UNPR,
      '7.00',
    );
  });

  it('★ 매도유형은 **매도일 때만** 넣는다', () => {
    assert.equal(overseasOrderPayload({ ...base, side: 'sell' }).SLL_TYPE, '00');
    assert.ok(!('SLL_TYPE' in overseasOrderPayload({ ...base, side: 'buy' })));
  });

  it('★★ 지정가가 없으면 던진다 — 0으로 나가면 값이 빠진 주문이 접수된다', () => {
    assert.throws(
      () => overseasOrderPayload({ ...base, side: 'buy', limitPrice: 0 }),
      /지정가가 필요합니다/,
    );
    assert.throws(
      () => overseasOrderPayload({ ...base, side: 'buy', limitPrice: Number.NaN }),
      /지정가가 필요합니다/,
    );
  });

  it('수량이 1 이상의 정수가 아니면 던진다', () => {
    for (const quantity of [0, -1, 1.5]) {
      assert.throws(
        () => overseasOrderPayload({ ...base, side: 'buy', quantity }),
        /수량이 1 이상의 정수/,
        `quantity=${quantity}`,
      );
    }
  });

  it('모르는 거래소·빈 종목코드는 던진다', () => {
    assert.throws(
      () => overseasOrderPayload({ ...base, side: 'buy', exchange: 'XXXX' as never }),
      /모르는 거래소/,
    );
    assert.throws(
      () => overseasOrderPayload({ ...base, side: 'buy', symbol: '  ' }),
      /종목코드가 비어 있습니다/,
    );
  });
});
