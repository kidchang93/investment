/**
 * 토큰 캐시 키 검증.
 *
 * 토큰은 **발급받은 서버에서만** 통한다. 그런데 캐시 이름에 `config.env`가 박혀
 * 있었다 — 그 실행이 모의냐 실전이냐만 담고, **그 토큰이 어느 서버 것인지**는
 * 담지 않았다. 개장일 조회가 모의 환경에서도 실전 서버에 붙게 되면서
 * (`KIS_OPEN_DAY_CREDENTIAL_ID`) 이 차이가 실제 문제가 된다:
 *
 *   1. 실전 서버에서 받은 토큰이 `token-vts-21.json`에 저장돼 **이름이 거짓말을 한다.**
 *   2. 더 나쁘게는, 나중에 같은 캐시를 모의 도메인 호출이 재사용하면
 *      **모의 서버에 실전 토큰**을 보내게 된다.
 *
 * 그래서 캐시 키는 자격증명과 서버 **둘 다**로 갈린다. 파일을 만들지 않고 이름만
 * 재는 순수 함수라 네트워크도 디스크도 건드리지 않는다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { appKeyFingerprint, isSameAppKey, tokenCacheFileName, tokenCacheKey } from './auth.js';

describe('토큰 캐시 파일 이름', () => {
  it('같은 자격증명이라도 서버가 다르면 다른 파일이다', () => {
    assert.equal(tokenCacheFileName('21', 'prod'), 'token-prod-21.json');
    assert.equal(tokenCacheFileName('21', 'vts'), 'token-vts-21.json');
    assert.notEqual(tokenCacheFileName('21', 'prod'), tokenCacheFileName('21', 'vts'));
  });

  it('같은 서버라도 자격증명이 다르면 다른 파일이다', () => {
    assert.notEqual(tokenCacheFileName('21', 'vts'), tokenCacheFileName('VTS-ORDINARY', 'vts'));
    assert.equal(tokenCacheFileName('VTS-ORDINARY', 'vts'), 'token-vts-VTS-ORDINARY.json');
  });

  /*
   * 구버전 단일 계좌(`default`)는 접미사 없는 이름을 그대로 둔다. 이름을 바꾸면
   * 멀쩡한 토큰을 버리고 다시 발급받는데, 발급에는 횟수 제한이 있다.
   */
  it('구버전 단일 계좌 이름은 그대로 둔다', () => {
    assert.equal(tokenCacheFileName('default', 'vts'), 'token-vts.json');
    assert.equal(tokenCacheFileName('default', 'prod'), 'token-prod.json');
  });
});

describe('메모리 캐시 키', () => {
  // 발급 중 Promise·approval_key도 같은 두 축으로 갈려야 한다.
  it('서버와 자격증명 둘 다로 갈린다', () => {
    assert.equal(tokenCacheKey('21', 'prod'), 'prod:21');
    assert.notEqual(tokenCacheKey('21', 'prod'), tokenCacheKey('21', 'vts'));
    assert.notEqual(tokenCacheKey('21', 'vts'), tokenCacheKey('23', 'vts'));
  });
});

/*
 * 캐시 이름은 `token-{서버}-{자격증명 id}.json`이라 **id가 같고 앱키만 바뀌면 같은
 * 파일**이다. 그러면 옛 앱키로 받은 토큰을 새 앱키로 쓰게 되고 KIS가
 * `EGW00123 기간이 만료된 token 입니다`로 거부한다 — 2026-08-01에 실제로 겪었다.
 * 모의 앱키를 계좌별로 나눠 넣었는데, **만료가 아니라 다른 앱키의 토큰**인데도
 * 오류 문구가 만료라고 말해서 원인을 찾기 어려웠다.
 */
describe('앱키가 바뀌면 토큰 캐시를 버린다', () => {
  it('같은 앱키면 지문이 같다', () => {
    assert.equal(appKeyFingerprint('key-a'), appKeyFingerprint('key-a'));
  });

  it('다른 앱키면 지문이 다르다', () => {
    assert.notEqual(appKeyFingerprint('key-a'), appKeyFingerprint('key-b'));
  });

  it('지문에 앱키가 그대로 남지 않는다', () => {
    // 자격증명이 파일에 남을 이유가 없다. "바뀌었는가"만 가르면 된다.
    const key = 'PSxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const fingerprint = appKeyFingerprint(key);
    assert.ok(!fingerprint.includes(key));
    assert.ok(fingerprint.length < key.length);
    assert.match(fingerprint, /^[0-9a-f]+$/);
  });

  it('같은 앱키의 캐시는 쓴다', () => {
    assert.equal(isSameAppKey({ appKeyFingerprint: appKeyFingerprint('key-a') }, 'key-a'), true);
  });

  it('다른 앱키의 캐시는 버린다', () => {
    assert.equal(isSameAppKey({ appKeyFingerprint: appKeyFingerprint('key-a') }, 'key-b'), false);
  });

  /*
   * 지문이 없는 옛 캐시는 통과시킨다. 앱키가 그대로인 경우가 대부분이고, 버리면
   * 멀쩡한 토큰을 재발급하게 되는데 발급에는 횟수 제한이 있다(1일 1회 원칙).
   */
  it('지문이 없는 옛 캐시는 그대로 쓴다', () => {
    assert.equal(isSameAppKey({}, 'key-a'), true);
    assert.equal(isSameAppKey({ appKeyFingerprint: undefined }, 'key-a'), true);
  });
});
