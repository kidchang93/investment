/**
 * KIS 오류 코드 가르기 검증.
 *
 * 세 코드가 비슷하게 생겼는데 뜻이 다르다. 섞으면 사람이 엉뚱한 곳을 고친다.
 *
 *   EGW02007  실전 앱키를 모의 서버에      → 짝 문제. APP_ENV/KIS_<id>_SERVER를 고친다
 *   EGW02004  모의 앱키를 실전 서버에      → 짝 문제. 같은 곳을 고친다
 *   EGW02006  그 TR이 모의 서버에 없다    → **짝 문제가 아니다.** 앱키는 멀쩡하다
 *
 * 마지막 것을 짝 문제로 읽으면, 개장일 우회(`KIS_OPEN_DAY_CREDENTIAL_ID`)를 안 켠
 * 사람에게 "앱키가 틀렸다"고 말하게 된다 — 앱키가 아니라 모의 서버에 그 기능이 없다.
 *
 * 네트워크 없이 돈다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { kisErrorCodeOf, kisErrorHint, kisErrorKind, kisErrorSuffix } from './errorCodes.js';

describe('짝이 어긋난 오류를 가른다', () => {
  it('실전 앱키를 모의 서버에 보낸 것은 짝 문제다', () => {
    assert.equal(kisErrorKind('EGW02007'), 'serverMismatch');
    assert.match(kisErrorHint('EGW02007') ?? '', /실전 서버용 앱키를 모의 서버에/);
  });

  it('모의 앱키를 실전 서버에 보낸 것도 짝 문제다', () => {
    assert.equal(kisErrorKind('EGW02004'), 'serverMismatch');
    assert.match(kisErrorHint('EGW02004') ?? '', /모의 서버용 앱키를 실전 서버에/);
  });

  it('두 방향의 말이 서로 다르다 — 어느 값을 고칠지 알 수 있어야 한다', () => {
    assert.notEqual(kisErrorHint('EGW02007'), kisErrorHint('EGW02004'));
    for (const code of ['EGW02007', 'EGW02004']) {
      assert.match(kisErrorHint(code) ?? '', /KIS_<id>_SERVER/, code);
    }
  });
});

describe('기능이 없는 것은 짝 문제가 아니다', () => {
  it('EGW02006은 앱키가 틀렸다고 말하지 않는다', () => {
    assert.equal(kisErrorKind('EGW02006'), 'trNotOnVts');
    assert.notEqual(kisErrorKind('EGW02006'), 'serverMismatch');
    const hint = kisErrorHint('EGW02006') ?? '';
    assert.match(hint, /앱키가 틀린 것이 아닙니다/);
    assert.doesNotMatch(hint, /짝이 어긋/);
  });
});

describe('모르는 코드는 지어내지 않는다', () => {
  it('한도·토큰·정상 코드에는 할 말이 없다', () => {
    // 한도는 재시도로 풀리는 것이라 판정이 따로 있다(`isRateLimited`).
    for (const code of ['EGW00201', 'EGW00215', 'EGW00123', 'MCA00000', 'OPSQ2000', '']) {
      assert.equal(kisErrorKind(code), null, code);
      assert.equal(kisErrorHint(code), null, code);
    }
  });

  it('본문에서 코드를 못 찾으면 덧말이 빈 문자열이다', () => {
    assert.equal(kisErrorSuffix({}), '');
    assert.equal(kisErrorSuffix('보통 텍스트'), '');
    assert.equal(kisErrorSuffix(undefined), '');
    assert.equal(kisErrorSuffix(null), '');
  });
});

/*
 * 본문이 **문자열로 남아 있는 자리**가 있다 — POST 실패와 토큰 발급 실패는
 * `res.text()`를 그대로 들고 throw한다. 파싱된 객체와 원문 둘 다 받아야 한다.
 */
describe('응답 본문에서 코드 꺼내기', () => {
  it('파싱된 객체에서 꺼낸다', () => {
    assert.equal(kisErrorCodeOf({ rt_cd: '1', msg_cd: 'EGW02004', msg1: '...' }), 'EGW02004');
  });

  it('원문 문자열에서도 꺼낸다', () => {
    const raw = '{"rt_cd":"1","msg_cd":"EGW02006","msg1":"모의투자 TR 이 아닙니다."}';
    assert.equal(kisErrorCodeOf(raw), 'EGW02006');
    assert.match(kisErrorSuffix(raw), /모의 서버에 없습니다/);
  });

  it('JSON이 아닌 본문에도 던지지 않는다', () => {
    assert.equal(kisErrorCodeOf('<html>502 Bad Gateway</html>'), '');
    assert.equal(kisErrorCodeOf(''), '');
    assert.equal(kisErrorCodeOf(123), '');
  });
});
