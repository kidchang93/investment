/**
 * 계좌 설정 파싱 검증.
 *
 * 여기가 틀리면 **계좌가 조용히 사라진다.** 두 번 그랬다 —
 *
 *   1. 계좌번호 자릿수가 안 맞아 `null`이 됐는데 아무 데도 안 남았다.
 *   2. `KIS_VTS_ACCOUNT_ORDINARY_NO`처럼 종류를 붙여 적은 키가 정규식에 안 걸렸다.
 *
 * 둘 다 오류가 아니라 **없는 것처럼** 동작했고, 넣은 사람은 오타를 낸 줄 모른 채
 * "왜 이 계좌가 화면에 없지"만 남았다. 계약을 시험에 못 박아 둔다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseAccountKey, parseAccountNumber } from './config.js';

describe('계좌 env 키 읽기', () => {
  it('접미사 없는 키는 자격증명과 계좌 id가 같다', () => {
    assert.deepEqual(parseAccountKey('KIS_21_ACCOUNT_NO'), { credentialId: '21', accountId: '21' });
  });

  /*
   * 한 앱키에 계좌가 여럿일 수 있다. KIS 모의투자가 그렇다 — 주식 계좌와
   * 선물옵션 계좌가 같은 앱키에 등록된다.
   */
  it('종류가 붙은 키는 계좌 id에 종류를 달고 자격증명은 그대로 둔다', () => {
    assert.deepEqual(parseAccountKey('KIS_VTS_ACCOUNT_ORDINARY_NO'), {
      credentialId: 'VTS',
      accountId: 'VTS-ORDINARY',
      kind: 'ORDINARY',
    });
    assert.deepEqual(parseAccountKey('KIS_VTS_ACCOUNT_EXTRAORDINARY_NO'), {
      credentialId: 'VTS',
      accountId: 'VTS-EXTRAORDINARY',
      kind: 'EXTRAORDINARY',
    });
  });

  it('계좌 키가 아닌 것은 걸리지 않는다', () => {
    // 앱키·시크릿·상품코드·HTS ID가 같은 접두사를 쓴다. 이것들이 계좌로 읽히면 안 된다.
    assert.equal(parseAccountKey('KIS_APP_KEY_21'), null);
    assert.equal(parseAccountKey('KIS_APP_SECRET_VTS'), null);
    assert.equal(parseAccountKey('KIS_21_ACCOUNT_PRODUCT_CODE'), null);
    assert.equal(parseAccountKey('KIS_HTS_ID'), null);
    assert.equal(parseAccountKey('KIS_LIVE_ORDER_ENABLED'), null);
  });

  it('종류는 대문자만 본다 — 소문자 접미사를 종류로 오해하지 않는다', () => {
    assert.equal(parseAccountKey('KIS_VTS_ACCOUNT_ordinary_NO'), null);
  });
});

describe('계좌번호 자릿수', () => {
  it('8자리는 종합계좌번호이고 상품코드는 기본 01이다', () => {
    assert.deepEqual(parseAccountNumber('12345678', undefined), { cano: '12345678', productCode: '01' });
  });

  it('상품코드를 따로 주면 그것을 쓴다', () => {
    assert.deepEqual(parseAccountNumber('12345678', '03'), { cano: '12345678', productCode: '03' });
  });

  it('10자리 이상은 8 + 2로 가른다. 하이픈은 무시한다', () => {
    assert.deepEqual(parseAccountNumber('12345678-01', undefined), { cano: '12345678', productCode: '01' });
    assert.deepEqual(parseAccountNumber('1234567802', undefined), { cano: '12345678', productCode: '02' });
  });

  /*
   * **짧은 계좌번호를 채워 주지 않는다.** 7자리를 받았을 때 (그대로 · 왼쪽 0 채움 ·
   * 오른쪽 0 채움) × 상품코드 7가지 = 21개 조합을 KIS에 실제로 물어봤고 전부
   * `INVALID_CHECK_ACNO`였다(2026-08-01). 무엇을 채워야 하는지 알 수 없다는 뜻이라
   * 짐작해서 채우면 틀린 번호로 조회를 계속 시도하게 된다.
   */
  it('8자리보다 짧으면 채우지 않고 못 쓴다고 한다', () => {
    assert.equal(parseAccountNumber('1234567', undefined), null);
    assert.equal(parseAccountNumber('123', undefined), null);
    assert.equal(parseAccountNumber('', undefined), null);
    assert.equal(parseAccountNumber(undefined, undefined), null);
  });

  it('9자리도 못 쓴다 — 상품코드를 지어내지 않는다', () => {
    assert.equal(parseAccountNumber('123456789', undefined), null);
  });

  it('숫자가 아닌 문자는 걷어낸 뒤 센다', () => {
    assert.deepEqual(parseAccountNumber(' 1234-5678 ', undefined), { cano: '12345678', productCode: '01' });
  });
});
