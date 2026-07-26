/**
 * 멱등성 키 검증.
 *
 * 중복 주문을 막는 유일한 장치라 눈으로만 보고 넘기지 않는다. 실제 주문은
 * 보내지 않고 DB 제약이 두 번째 요청을 실제로 막는지만 확인한다.
 *
 * DATABASE_URL이 없거나 DB에 붙지 못하면 건너뛴다 — 이 테스트 하나 때문에
 * 전체 테스트가 실패하면 안 된다.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { pool } from './client.js';
import {
  claimClientOrderId,
  completeClaimedOrder,
  ensureBrokerOrderSchema,
  getOrderByClientOrderId,
} from './brokerOrders.js';

let usable = false;
const created: string[] = [];

before(async () => {
  try {
    await ensureBrokerOrderSchema();
    usable = true;
  } catch {
    usable = false;
  }
});

after(async () => {
  if (usable && created.length > 0) {
    await pool
      .query('DELETE FROM trading_broker_orders WHERE client_order_id = ANY($1)', [created])
      .catch(() => undefined);
  }
  await pool.end().catch(() => undefined);
});

describe('멱등성 키', { skip: false }, () => {
  it('같은 키로 두 번 선점하면 두 번째는 거부된다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못해 건너뜀');
    const key = `test-${randomUUID()}`;
    created.push(key);

    assert.equal(await claimClientOrderId('21', key, 'place'), true, '첫 선점은 성공해야 한다');
    assert.equal(await claimClientOrderId('21', key, 'place'), false, '같은 키 재선점은 거부돼야 한다');
  });

  it('동시에 들어와도 하나만 통과한다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못해 건너뜀');
    const key = `test-${randomUUID()}`;
    created.push(key);

    /*
     * 조회 후 삽입 방식이면 이 지점에서 둘 다 통과한다. 유니크 제약으로 막아야
     * 동시 요청에서도 하나만 남는다.
     */
    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimClientOrderId('21', key, 'place')),
    );
    assert.equal(results.filter(Boolean).length, 1, `통과한 요청 수: ${results.filter(Boolean).length}`);
  });

  it('선점한 줄을 결과로 채우면 그 결과를 되읽을 수 있다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못해 건너뜀');
    const key = `test-${randomUUID()}`;
    created.push(key);

    await claimClientOrderId('21', key, 'place');
    await completeClaimedOrder(key, {
      status: 'submitted',
      message: '접수 완료',
      side: 'buy',
      symbol: '005930',
      orderType: 'market',
      quantity: 1,
      orderNo: 'TEST-1',
      orderBranchNo: '00',
    });

    const saved = await getOrderByClientOrderId(key);
    assert.equal(saved?.status, 'submitted');
    assert.equal(saved?.orderNo, 'TEST-1');
    assert.equal(saved?.message, '접수 완료');
  });

  it('없는 키를 조회하면 null', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못해 건너뜀');
    assert.equal(await getOrderByClientOrderId(`test-none-${randomUUID()}`), null);
  });
});
