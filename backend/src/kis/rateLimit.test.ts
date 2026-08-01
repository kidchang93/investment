/**
 * 한도 초과 판정 검증.
 *
 * 초당 한도를 넘겼을 때 오는 코드가 **두 가지**인데 예전에는 하나만 봤다.
 *
 *   EGW00201  개인(앱키) 유량 — 실전 18건/초 · 모의 1건/초. 모든 TR
 *   EGW00215  원장 유량 120 TPS — 개인 유량과 무관. 잔고조회·ETF호가
 *
 * 뒤엣것이 오면 한도로 인식되지 않아 **백오프·재시도를 타지 못하고** 오류가 그대로
 * 위로 흘렀다. 잔고조회는 자동매매 러너가 매 회차 부르는 경로다.
 * 출처는 KIS 주식잔고조회 API 문서 원문(2026-08-01 확인).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isRateLimited } from './rest.js';

describe('초당 한도 판정', () => {
  it('개인 유량 초과를 한도로 본다', () => {
    assert.equal(isRateLimited({ msg_cd: 'EGW00201' }), true);
  });

  it('원장 유량 초과도 한도로 본다 — 재시도해야 하는 것은 같다', () => {
    assert.equal(isRateLimited({ msg_cd: 'EGW00215' }), true);
  });

  it('다른 오류는 한도가 아니다 — 재시도해도 같은 답이 온다', () => {
    // 이것들을 한도로 읽으면 400ms 기다렸다 같은 거절을 한 번 더 받는다.
    for (const code of ['EGW02006', 'EGW02007', 'EGW00123', 'OPSQ2000', 'MCA00000']) {
      assert.equal(isRateLimited({ msg_cd: code }), false, code);
    }
  });

  it('코드가 없으면 한도가 아니다', () => {
    assert.equal(isRateLimited({}), false);
    assert.equal(isRateLimited({ msg_cd: undefined }), false);
    assert.equal(isRateLimited({ msg_cd: '' }), false);
  });
});
