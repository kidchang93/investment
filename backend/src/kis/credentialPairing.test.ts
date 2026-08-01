/**
 * 자격증명과 서버의 짝 검증 — **회귀 방지의 핵심**.
 *
 * 주문 가드는 있었는데 **정상 경로에서 한 번도 걸리지 않았다.**
 *
 *   rest.ts  toCredentials(account) → { id, appKey, appSecret }   ← server를 안 채웠다
 *   auth.ts  credentialServer(c)    → c.server ?? config.env      ← 그래서 config.env
 *   → orderServerMismatch(config.env, config.env) 는 **언제나 null**
 *
 * 도달 불가능한 방어선이었다. `KIS_<id>_SERVER`가 생기면서 실제로 짝이 어긋난 자격증명이
 * 존재할 수 있게 됐으니 여기서 못 박는다.
 *
 * **네트워크 없이 돈다.** 가드는 토큰을 받기 전에 서고, 시험은 `fetch`를 가로채
 * 한 번도 나가지 않았음을 확인한다. 실주문은 물론 조회도 나가지 않는다.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { config, orderServerMismatch, type KisAccountConfig, type KisServer } from '../config.js';
import { credentialServer } from './auth.js';
import {
  amendKisDomesticOrder,
  getKisDomesticAccountSnapshot,
  placeKisDomesticOrder,
  toCredentials,
} from './rest.js';

/** 이 실행의 서버가 아닌 쪽. `APP_ENV`가 무엇이든 "어긋난 짝"을 만들 수 있어야 한다. */
const OTHER_SERVER: KisServer = config.env === 'prod' ? 'vts' : 'prod';

function account(server?: KisServer): KisAccountConfig {
  return {
    id: 'TEST',
    label: '시험용',
    appKey: 'test-key',
    appSecret: 'test-secret',
    cano: '12345678',
    productCode: '01',
    server,
  };
}

/*
 * `fetch`를 가로채 **한 번도 나가지 않는 것**까지 확인한다. 전역을 통째로 바꾸는 것은
 * 위험하지만(이 레포에서 `window.Date`로 페이지를 멈춘 적이 있다) 여기서는 시험 하나
 * 범위이고 `afterEach`에서 반드시 되돌린다.
 */
const realFetch = globalThis.fetch;
let fetchCalls = 0;

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

describe('계좌 자격증명에 서버를 싣는다', () => {
  it('안 적으면 비워 두고, 그러면 이 실행의 서버로 본다 — 하위 호환', () => {
    const credentials = toCredentials(account());
    assert.equal(credentials.server, undefined);
    assert.equal(credentialServer(credentials), config.env);
    // 이 경우 가드는 걸리지 않는다. 지금 설정 대부분이 여기 해당한다.
    assert.equal(orderServerMismatch(credentialServer(credentials), config.env), null);
  });

  it('적으면 그 값이 자격증명에 실린다', () => {
    const credentials = toCredentials(account(OTHER_SERVER));
    assert.equal(credentials.server, OTHER_SERVER);
    assert.equal(credentialServer(credentials), OTHER_SERVER);
  });

  /*
   * 예전에는 `toCredentials`가 서버를 안 채워서 이 값이 **언제나 null**이었다.
   * 가드가 살아 있는지는 이 한 줄로 갈린다.
   */
  it('짝이 어긋나면 주문 가드가 사유를 낸다 — 예전에는 언제나 null이었다', () => {
    const credentials = toCredentials(account(OTHER_SERVER));
    assert.notEqual(orderServerMismatch(credentialServer(credentials), config.env), null);
  });
});

describe('짝이 어긋난 자격증명으로는 주문을 보내지 않는다', () => {
  it('현금 주문을 시도하면 던진다', async () => {
    await assert.rejects(
      placeKisDomesticOrder(account(OTHER_SERVER), {
        symbol: '005930',
        side: 'buy',
        orderType: 'limit',
        quantity: 1,
        limitPrice: 1_000,
      }),
      /자격증명이 주문 경로에 들어왔습니다/,
    );
    assert.equal(fetchCalls, 0, 'KIS로 나가기 전에 막아야 한다');
  });

  it('정정·취소도 같은 자리에서 막힌다', async () => {
    await assert.rejects(
      amendKisDomesticOrder(account(OTHER_SERVER), {
        action: 'cancel',
        orderNo: '0000000001',
        orderBranchNo: '00000',
        orderTypeCode: '00',
        quantityAll: true,
      }),
      /자격증명이 주문 경로에 들어왔습니다/,
    );
    assert.equal(fetchCalls, 0);
  });
});

/*
 * **조회도 막는다.** 계좌 TR은 이름이 `config.env`로 갈려(`TTTC8434R`/`VTTC8434R`)
 * 어느 도메인으로 보내도 맞지 않고, 보내는 순간 그 서버의 토큰이 발급돼 캐시된다 —
 * 2026-08-01에 `token-prod-VTS-EXTRAORDINARY.json`이 실제로 생겼다.
 */
describe('짝이 어긋난 자격증명으로는 조회도 보내지 않는다', () => {
  it('잔고 조회를 시도하면 던진다', async () => {
    await assert.rejects(getKisDomesticAccountSnapshot(account(OTHER_SERVER)), /조회도 보내지 않습니다/);
    assert.equal(fetchCalls, 0, '토큰 발급조차 나가면 안 된다');
  });

  it('막을 때 어느 자격증명인지 말한다', async () => {
    await assert.rejects(getKisDomesticAccountSnapshot(account(OTHER_SERVER)), /자격증명 TEST/);
  });
});
