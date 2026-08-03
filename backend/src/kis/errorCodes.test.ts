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

import {
  isOrderTypeUnavailableOnServer,
  isTrUnavailableOnServer,
  kisErrorCodeOf,
  kisErrorHint,
  kisErrorKind,
  kisErrorSuffix,
  KisRequestError,
} from './errorCodes.js';

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

/*
 * 2026-08-03: 화면에 `KIS 예약주문 조회 실패: 502`가 하루 종일 떠 있었다.
 * 실제 원인은 모의 서버에 그 TR이 없는 것(`EGW02006`)이라 장애가 아니었는데,
 * 오류가 평범한 `Error`라 코드가 실려 오지 않아 라우트가 가를 수 없었다.
 */
describe('이 서버에 없는 기능인지 가르기', () => {
  it('EGW02006이면 참이다 — 설정으로 못 고치는 것이라 장애가 아니다', () => {
    assert.equal(isTrUnavailableOnServer(new KisRequestError('모의투자 TR 이 아닙니다.', 'EGW02006')), true);
  });

  /* 앱키·서버 짝이 어긋난 것은 고칠 수 있는 문제라 조용히 넘기면 안 된다. */
  it('앱키와 서버가 어긋난 것은 거짓이다', () => {
    for (const code of ['EGW02007', 'EGW02004']) {
      assert.equal(isTrUnavailableOnServer(new KisRequestError('짝 불일치', code)), false, code);
    }
  });

  it('한도·알 수 없는 코드는 거짓이다', () => {
    for (const code of ['EGW00201', 'EGW00215', '']) {
      assert.equal(isTrUnavailableOnServer(new KisRequestError('기타', code)), false, code);
    }
  });

  /* 네트워크 끊김 같은 진짜 장애는 502로 알려야 한다. */
  it('KIS 응답이 아닌 오류는 거짓이다', () => {
    assert.equal(isTrUnavailableOnServer(new Error('fetch failed')), false);
    assert.equal(isTrUnavailableOnServer('EGW02006'), false);
    assert.equal(isTrUnavailableOnServer(undefined), false);
  });
});

/*
 * 2026-08-03 실측: 장후 시간외 주문구분(`06`)으로 모의계좌에 매도를 냈더니
 * 8종목 전부 `40970000`으로 거절됐다 — "모의투자에서 제공하지 않는 주문유형입니다."
 * 재시도해도 같은 답이라 첫 건에서 그만둬야 한다.
 */
describe('이 서버가 안 받는 주문유형인지 가르기', () => {
  it('40970000이면 참이다', () => {
    assert.equal(
      isOrderTypeUnavailableOnServer(new KisRequestError('모의투자에서 제공하지 않는 주문유형입니다.', '40970000')),
      true,
    );
  });

  /* TR 자체가 없는 것(EGW02006)과는 다른 사실이다. 사람에게 할 말이 다르다. */
  it('TR이 없는 것과 섞이지 않는다', () => {
    const trGone = new KisRequestError('모의투자 TR 이 아닙니다.', 'EGW02006');
    assert.equal(isOrderTypeUnavailableOnServer(trGone), false);
    assert.equal(isTrUnavailableOnServer(trGone), true);

    const typeGone = new KisRequestError('주문유형', '40970000');
    assert.equal(isTrUnavailableOnServer(typeGone), false);
  });

  it('KIS 응답이 아닌 오류는 거짓이다', () => {
    assert.equal(isOrderTypeUnavailableOnServer(new Error('fetch failed')), false);
  });
});
