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

import {
  credentialEnvNames,
  marketOpenDayHint,
  orderServerMismatch,
  parseAccountKey,
  parseAccountNumber,
  resolveMarketOpenDayLookup,
  restBaseFor,
} from './config.js';

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

/*
 * 개장일 조회(`chk-holiday` / `CTCA0903R`)는 **모의 서버에 없다** — HTTP 500 +
 * `EGW02006 모의투자 TR 이 아닙니다`(2026-08-01 실측). 조회 실패는 리스크 룰에서
 * "보류"가 되므로, 그대로 두면 모의 환경에서는 **통과하는 주문이 존재할 수 없다.**
 * 개장일은 계좌와 무관한 시장 사실이라 실전 서버에 물어도 답이 같아서 우회를 뒀다.
 *
 * 여기서 못 박는 것: 설정이 없으면 지금 그대로 실패할 자리로 가고, 설정이 있으면
 * **그 자격증명·그 서버**로 가고, 실전 환경에서는 이 우회가 아예 없다.
 */
describe('개장일 조회를 어디에 물어보는가', () => {
  const prodAccount = { id: '21', appKey: 'prod-key', appSecret: 'prod-secret' };
  const vtsOrdinary = { id: 'VTS-ORDINARY', appKey: 'vts-key', appSecret: 'vts-secret' };
  const accounts = [prodAccount, vtsOrdinary];
  const primary = { id: 'VTS-ORDINARY', appKey: 'vts-key', appSecret: 'vts-secret' };

  it('설정이 없으면 모의 서버에 물어본다 — 지금 동작 그대로(= 실패해서 보류)', () => {
    const lookup = resolveMarketOpenDayLookup({ env: 'vts', credentialId: undefined, accounts, primary });
    assert.equal(lookup.server, 'vts');
    assert.equal(lookup.viaProdServer, false);
    assert.equal(lookup.credentials.appKey, 'vts-key');
    assert.equal(lookup.problem, null);
    // 무엇을 하면 되는지는 말해 준다. 보류만 적으면 설정 문제인지 장애인지 알 수 없다.
    assert.match(marketOpenDayHint(lookup) ?? '', /KIS_OPEN_DAY_CREDENTIAL_ID/);
  });

  it('빈 문자열·공백만 있는 설정은 없는 것으로 본다', () => {
    for (const credentialId of ['', '   ']) {
      const lookup = resolveMarketOpenDayLookup({ env: 'vts', credentialId, accounts, primary });
      assert.equal(lookup.server, 'vts');
      assert.equal(lookup.viaProdServer, false);
    }
  });

  it('설정이 있으면 그 자격증명으로 실전 서버에 물어본다', () => {
    const lookup = resolveMarketOpenDayLookup({ env: 'vts', credentialId: '21', accounts, primary });
    assert.equal(lookup.server, 'prod');
    assert.equal(lookup.viaProdServer, true);
    assert.deepEqual(lookup.credentials, prodAccount);
    assert.equal(lookup.problem, null);
    assert.equal(marketOpenDayHint(lookup), null);
    // 도메인은 config.ts의 표 하나에서만 나온다.
    assert.equal(restBaseFor(lookup.server), 'https://openapi.koreainvestment.com:9443');
    assert.notEqual(restBaseFor('prod'), restBaseFor('vts'));
  });

  // 계좌에 종류가 붙으면 id가 `VTS-ORDINARY`가 된다. 고르는 것은 앱키다.
  it('자격증명 id로도 찾는다 — 종류가 붙은 계좌 id에 걸린다', () => {
    const lookup = resolveMarketOpenDayLookup({
      env: 'vts',
      credentialId: 'VTS',
      accounts,
      primary,
    });
    assert.equal(lookup.viaProdServer, true);
    assert.equal(lookup.credentials.id, 'VTS-ORDINARY');
  });

  /*
   * 없는 설정을 추측해서 아무 앱키나 쓰지 않는다. 대신 **왜 못 썼는지** 남긴다 —
   * 계좌가 조용히 사라진 전례가 두 번 있었다.
   */
  it('설정한 id를 못 찾으면 아무 앱키나 쓰지 않고 사유를 남긴다', () => {
    const lookup = resolveMarketOpenDayLookup({ env: 'vts', credentialId: '99', accounts, primary });
    assert.equal(lookup.server, 'vts');
    assert.equal(lookup.viaProdServer, false);
    assert.deepEqual(lookup.credentials, primary);
    assert.match(lookup.problem ?? '', /99/);
    assert.equal(marketOpenDayHint(lookup), lookup.problem);
  });

  it('실전 환경에서는 이 우회가 아예 동작하지 않는다', () => {
    const prodPrimary = { id: '21', appKey: 'prod-key', appSecret: 'prod-secret' };
    const plain = resolveMarketOpenDayLookup({
      env: 'prod',
      credentialId: undefined,
      accounts,
      primary: prodPrimary,
    });
    assert.deepEqual(plain, { credentials: prodPrimary, server: 'prod', viaProdServer: false, problem: null });

    // 설정이 있어도 실전에서는 쓰지 않는다. 대신 무시한다고 말한다.
    const configured = resolveMarketOpenDayLookup({
      env: 'prod',
      credentialId: 'VTS',
      accounts,
      primary: prodPrimary,
    });
    assert.equal(configured.server, 'prod');
    assert.equal(configured.viaProdServer, false);
    assert.deepEqual(configured.credentials, prodPrimary);
    assert.match(configured.problem ?? '', /무시/);
    /*
     * 실전 서버 조회는 이 설정과 무관하게 동작한다. 그런데도 실패했다면 원인이 다른
     * 데 있으므로 사유에 설정 이야기를 붙이지 않는다 — 엉뚱한 곳을 보게 만든다.
     */
    assert.equal(marketOpenDayHint(configured), null);
    assert.equal(marketOpenDayHint(plain), null);
  });
});

/*
 * 실전 자격증명이 주문 경로로 새면 **모의 환경인 줄 알고 실계좌에 주문이 나간다.**
 * 개장일 우회는 조회 전용이라, 주문 POST는 도메인을 `config.restBase`로 고정하고
 * 서버가 다른 자격증명이 들어오면 보내기 전에 던진다.
 */
describe('주문 경로에 다른 서버 자격증명이 새지 않는다', () => {
  it('서버가 같으면 통과한다', () => {
    assert.equal(orderServerMismatch('vts', 'vts'), null);
    assert.equal(orderServerMismatch('prod', 'prod'), null);
  });

  it('모의 환경에 실전 자격증명이 들어오면 사유를 돌려준다', () => {
    const reason = orderServerMismatch('prod', 'vts') ?? '';
    assert.match(reason, /모의 서버로만 보냅니다/);
    assert.match(reason, /실전 서버 자격증명/);
  });

  it('반대 방향도 막는다', () => {
    assert.match(orderServerMismatch('vts', 'prod') ?? '', /실전 서버로만 보냅니다/);
  });
});

/*
 * **계좌마다 앱키가 다를 수 있다.** KIS 모의투자를 종류별로 따로 신청하면 앱키도
 * 계좌도 각각 나온다 — 그러면 공용 앱키(`KIS_APP_KEY_VTS`)가 아예 없다.
 *
 * 2026-08-01에 이것 때문에 두 계좌가 통째로 빠졌다. 계좌는
 * `KIS_VTS_ACCOUNT_ORDINARY_NO`인데 앱키는 `KIS_APP_KEY_ORDINARY_VTS`로 들어와서,
 * 코드가 찾던 `KIS_APP_KEY_VTS`가 없었다. 계좌 키가 `<id>_ACCOUNT_<종류>_NO`라
 * 앱키를 어느 순서로 적을지 사람마다 다르게 읽는다 — 그래서 둘 다 본다.
 */
describe('앱키 env 이름 후보', () => {
  it('종류가 없으면 한 가지뿐이다', () => {
    assert.deepEqual(credentialEnvNames('KIS_APP_KEY', '21'), ['KIS_APP_KEY_21']);
  });

  it('종류가 있으면 계좌별 앱키를 먼저 보고 공용을 마지막에 본다', () => {
    assert.deepEqual(credentialEnvNames('KIS_APP_KEY', 'VTS', 'ORDINARY'), [
      'KIS_APP_KEY_ORDINARY_VTS',
      'KIS_APP_KEY_VTS_ORDINARY',
      'KIS_APP_KEY_VTS',
    ]);
  });

  it('시크릿도 같은 규칙이다', () => {
    assert.deepEqual(credentialEnvNames('KIS_APP_SECRET', 'VTS', 'EXTRAORDINARY'), [
      'KIS_APP_SECRET_EXTRAORDINARY_VTS',
      'KIS_APP_SECRET_VTS_EXTRAORDINARY',
      'KIS_APP_SECRET_VTS',
    ]);
  });

  it('공용 앱키가 맨 마지막이다 — 계좌별이 있으면 그쪽이 이긴다', () => {
    const names = credentialEnvNames('KIS_APP_KEY', 'VTS', 'ORDINARY');
    assert.equal(names[names.length - 1], 'KIS_APP_KEY_VTS');
  });
});
