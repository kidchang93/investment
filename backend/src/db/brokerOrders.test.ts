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
  applyOrderFill,
  claimClientOrderId,
  completeClaimedOrder,
  ensureBrokerOrderSchema,
  getBrokerOrderRecords,
  getOrderByClientOrderId,
  recordBrokerOrderAttempt,
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

  it('★ 선점한 줄에 층을 채운다 — 빠지면 층별 성과가 통째로 거짓이 된다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못해 건너뜀');
    const key = `test-${randomUUID()}`;
    created.push(key);

    /*
     * 2026-08-20에 이 자리가 비어 있어서 티에스이 매수가 유망주 층 대신 ETF 층으로
     * 들어갔다. 집행기는 항상 멱등 키를 쓰므로 **자동 매매 전부**가 해당했다.
     */
    await claimClientOrderId('21', key, 'place');
    await completeClaimedOrder(key, {
      status: 'submitted',
      message: '접수 완료',
      side: 'buy',
      symbol: '131290',
      orderType: 'limit',
      quantity: 20,
      limitPrice: 245_500,
      orderNo: 'TEST-LAYER',
      orderBranchNo: '00',
      layer: 'bet',
    });

    const saved = await getOrderByClientOrderId(key);
    assert.equal(saved?.layer, 'bet', '층이 저장돼야 layerSync가 되돌릴 수 있다');
  });

  it('없는 키를 조회하면 null', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못해 건너뜀');
    assert.equal(await getOrderByClientOrderId(`test-none-${randomUUID()}`), null);
  });
});

/*
 * ★ `recordBrokerOrderAttempt`는 **실패해도 던지지 않고 false를 돌려준다** —
 * 기록 실패가 주문 응답을 깨뜨리면 안 되기 때문이다. 뒤집어 말하면 컬럼을
 * 하나 빠뜨려도 아무 소리 없이 기록만 사라진다. 그래서 넣고 되읽는 것까지 잰다.
 */
describe('감사 기록 — 스톱가는 지정가와 갈라서 남는다', () => {
  it('넣은 값이 그대로 되읽힌다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못해 건너뜀');
    const key = `test-${randomUUID()}`;
    const accountId = `test-stop-${randomUUID()}`;
    created.push(key);

    const saved = await recordBrokerOrderAttempt({
      accountId,
      clientOrderId: key,
      action: 'place',
      status: 'blocked',
      message: '시험용 기록 — 주문은 보내지 않았습니다',
      side: 'buy',
      symbol: '005930',
      orderType: 'limit',
      quantity: 1,
      limitPrice: 27_000,
      stopPrice: 26_000,
    });
    assert.equal(saved, true, '기록이 조용히 실패하면 안 된다');

    const { records } = await getBrokerOrderRecords(accountId, 1);
    assert.equal(records.length, 1);
    // 둘이 서로 다른 칸에 남아야 한다. 합치면 손절이 걸린 주문인지 알 수 없다.
    assert.equal(records[0].limitPrice, 27_000);
    assert.equal(records[0].stopPrice, 26_000);
  });

  it('스톱가가 없는 주문에는 그 칸이 비어 있다 — 0으로 채우지 않는다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못해 건너뜀');
    const key = `test-${randomUUID()}`;
    const accountId = `test-nostop-${randomUUID()}`;
    created.push(key);

    await recordBrokerOrderAttempt({
      accountId,
      clientOrderId: key,
      action: 'place',
      status: 'blocked',
      message: '시험용 기록 — 주문은 보내지 않았습니다',
      side: 'buy',
      symbol: '005930',
      orderType: 'limit',
      quantity: 1,
      limitPrice: 27_000,
    });

    const { records } = await getBrokerOrderRecords(accountId, 1);
    assert.equal(records[0].stopPrice, undefined);
  });
});

/*
 * ★ 체결 되채움 (2026-08-22). 주문 기록은 "냈다"에서 멈춰 있었고, 실제 체결단가는
 *   증권사에만 있었다. 접수값을 덮어쓰면 슬리피지를 영영 못 재므로 그것도 잰다.
 */
describe('체결 되채움 — 접수값을 덮지 않는다', () => {
  it('체결수량·체결단가가 들어가고 접수값은 그대로 남는다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못해 건너뜀');
    const key = `test-${randomUUID()}`;
    const accountId = `test-fill-${randomUUID()}`;
    const orderNo = `FILL-${randomUUID().slice(0, 8)}`;
    created.push(key);

    await recordBrokerOrderAttempt({
      accountId,
      clientOrderId: key,
      action: 'place',
      status: 'submitted',
      message: '시험용 기록 — 주문은 보내지 않았습니다',
      side: 'buy',
      symbol: '005930',
      orderType: 'limit',
      quantity: 10,
      limitPrice: 252_000,
      orderNo,
    });

    const touched = await applyOrderFill(accountId, orderNo, 10, 253_500);
    assert.equal(touched, 1, '그 주문 한 줄만 바뀌어야 한다');

    const { rows } = await pool.query<{ q: string; p: string; oq: string; lp: string; at: string | null }>(
      `SELECT filled_quantity::text AS q, filled_price::text AS p,
              quantity::text AS oq, limit_price::text AS lp,
              fills_synced_at::text AS at
         FROM trading_broker_orders WHERE account_id = $1`,
      [accountId],
    );
    assert.equal(Number(rows[0].q), 10);
    assert.equal(Number(rows[0].p), 253_500);
    // ★ 접수값이 그대로 남아야 슬리피지(253,500 − 252,000)를 잴 수 있다.
    assert.equal(Number(rows[0].oq), 10);
    assert.equal(Number(rows[0].lp), 252_000);
    assert.ok(rows[0].at, '언제 받아 적었는지가 남아야 한다');
  });

  it('★ 우리 기록에 없는 주문번호면 아무것도 바꾸지 않는다 — 손으로 낸 주문이다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못해 건너뜀');
    const accountId = `test-fill-${randomUUID()}`;
    assert.equal(await applyOrderFill(accountId, `NOPE-${randomUUID().slice(0, 8)}`, 5, 1_000), 0);
  });

  it('체결이 0이거나 단가가 0이면 쓰지 않는다 — 미체결을 "0원에 체결"로 적지 않는다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못해 건너뜀');
    const key = `test-${randomUUID()}`;
    const accountId = `test-fill-${randomUUID()}`;
    const orderNo = `FILL0-${randomUUID().slice(0, 8)}`;
    created.push(key);

    await recordBrokerOrderAttempt({
      accountId,
      clientOrderId: key,
      action: 'place',
      status: 'submitted',
      message: '시험용 기록 — 주문은 보내지 않았습니다',
      side: 'buy',
      symbol: '005930',
      orderType: 'limit',
      quantity: 10,
      limitPrice: 252_000,
      orderNo,
    });

    assert.equal(await applyOrderFill(accountId, orderNo, 0, 253_500), 0, '체결 0');
    assert.equal(await applyOrderFill(accountId, orderNo, 10, 0), 0, '단가 0');

    const { rows } = await pool.query<{ q: string | null }>(
      `SELECT filled_quantity::text AS q FROM trading_broker_orders WHERE account_id = $1`,
      [accountId],
    );
    assert.equal(rows[0].q, null, '비어 있어야 "아직 안 받아 왔다"로 읽힌다');
  });
});
