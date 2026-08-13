/**
 * KIS 문자열 → 숫자. **빈 칸과 0을 가르는 경계**를 못 박는다.
 *
 * ── 무엇이 틀려 있었나 (2026-08-13) ───────────────────────────────────────
 *
 * `optionalNumber`가 `rest.ts` 안에서 `toNumber`로 짜여 있었다. `Number('')`은
 * NaN이 아니라 **0**이라, 이름이 `optionalNumber`인데 빈 문자열을 `null`로
 * 걸러내지 못했다 — KIS가 값을 안 준 자리가 "0원"으로 읽혔다.
 *
 *     optionalNumber('')  → 0     (고치기 전, 실측)
 *     optionalNumber('')  → null  (지금)
 *
 * 계좌 합계·포지션·주문·시세 정규화가 전부 이 함수를 지난다. 값이 있는 쪽을
 * 화면으로 태울 수 없는 상태(빈 계좌·개장 전·거래정지)가 많아, 여기서 문자열을
 * 직접 넣고 잰다. **네트워크를 쓰지 않는다.**
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { optionalNumber, toNumber, toNumberOrNaN } from './normalize.js';

describe('toNumber — 왜 그냥 쓰면 안 되나', () => {
  it('빈 문자열과 공백을 0으로 읽는다 — 이것이 함정이다', () => {
    /*
     * 이 시험은 고칠 것을 적은 게 아니라 **자바스크립트가 그렇다는 사실**을 적은
     * 것이다. `toNumber`는 쉼표만 걷어내고 `Number()`에 넘기므로 여기서 멈춘다.
     * 위를 감싸는 것이 `toNumberOrNaN`·`optionalNumber`다.
     */
    assert.equal(toNumber(''), 0);
    assert.equal(toNumber(' '), 0);
    assert.equal(toNumber('   '), 0);
  });

  it('쉼표는 걷어내고 숫자가 아닌 것은 NaN이다', () => {
    assert.equal(toNumber('1,234,567'), 1_234_567);
    assert.ok(Number.isNaN(toNumber('-')));
    assert.ok(Number.isNaN(toNumber(undefined)));
  });
});

describe('optionalNumber — 값 없음과 0을 가른다', () => {
  it('빈 문자열은 0이 아니라 값 없음이다', () => {
    assert.equal(optionalNumber(''), null);
  });

  it('공백만 있는 칸도 값 없음이다 — 공백 하나·여럿·탭', () => {
    assert.equal(optionalNumber(' '), null);
    assert.equal(optionalNumber('   '), null);
    assert.equal(optionalNumber('\t'), null);
  });

  it('칸 자체가 없어도 값 없음이다', () => {
    assert.equal(optionalNumber(undefined), null);
  });

  it("'0'은 진짜 0이다 — 값 없음으로 바꾸지 않는다", () => {
    /*
     * 이쪽을 반대로 만들면 같은 잘못을 방향만 바꿔 저지르는 것이다.
     * KIS는 미체결 평균가·거래량 0을 실제로 `'0'`으로 준다.
     */
    assert.equal(optionalNumber('0'), 0);
    assert.equal(optionalNumber('0.00'), 0);
    assert.equal(optionalNumber(' 0 '), 0);
  });

  it('실제 숫자는 그대로 온다 — 쉼표·음수·소수', () => {
    assert.equal(optionalNumber('1234'), 1234);
    assert.equal(optionalNumber('1,234,567'), 1_234_567);
    assert.equal(optionalNumber('-33220'), -33_220);
    assert.equal(optionalNumber('98898.5930'), 98_898.593);
    assert.equal(optionalNumber('9.19'), 9.19);
  });

  it('숫자가 아닌 글자는 값 없음이다', () => {
    assert.equal(optionalNumber('-'), null);
    assert.equal(optionalNumber('abc'), null);
    assert.equal(optionalNumber('null'), null);
  });

  it('toNumberOrNaN과 같은 자리에서 갈린다 — 표현만 NaN/null로 다르다', () => {
    for (const raw of ['', ' ', '-', 'abc', undefined]) {
      assert.ok(Number.isNaN(toNumberOrNaN(raw)), `${String(raw)}는 NaN이어야 한다`);
      assert.equal(optionalNumber(raw), null, `${String(raw)}는 null이어야 한다`);
    }
    for (const raw of ['0', '12', '1,000']) {
      assert.equal(optionalNumber(raw), toNumberOrNaN(raw));
    }
  });
});
