/**
 * 화면이 시세의 나이를 다루는 규칙 검증 (`shared`의 순수 함수 둘).
 *
 * 프런트에는 시험 러너가 없어서 `riskRuleBlockers`·`settledRealized`처럼 판단을
 * `shared`의 순수 함수로 빼고 여기서 덮는다. 실계좌·장중이 아니면 화면으로 태워
 * 볼 수 없는 자리라 더 그렇다.
 *
 * 재는 것은 둘이다.
 * - 늦게 온 **묵은** 값이 방금 받은 값을 덮지 않는가 (`shouldReplaceQuote`)
 * - 목록의 나이를 **가장 묵은 것**으로 말하는가 (`oldestFetchedAt`)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { oldestFetchedAt, shouldReplaceQuote, type Quote } from '@invest/shared';

const T0 = Date.parse('2026-07-31T01:20:00.000Z');

function quote(fetchedAt: number, code = 'KR:KOSPI:000660'): Quote {
  return {
    code,
    fetchedAt,
    price: 1_601_000,
    change: 13_000,
    changeRate: 0.82,
    sign: '2',
    open: 1_590_000,
    high: 1_610_000,
    low: 1_585_000,
    accVolume: 1_340_082,
  };
}

describe('shouldReplaceQuote', () => {
  it('아무것도 없으면 넣는다', () => {
    assert.equal(shouldReplaceQuote(undefined, quote(T0)), true);
  });

  it('새 값은 덮는다', () => {
    assert.equal(shouldReplaceQuote(quote(T0), quote(T0 + 1_000)), true);
  });

  /*
   * 실제로 나는 상황이다. 선택 종목은 단건(`/api/instruments/:id/quote`, 캐시 없음)
   * 으로 방금 받는데, 목록 묶음(`/api/instruments/quotes`)은 45초 캐시라 조금 뒤에
   * **더 묵은** 같은 종목이 도착한다. 도착 순서로 덮으면 방금 값이 사라진다.
   */
  it('묵은 값이 새 값을 덮지 않는다 — 45초 캐시가 방금 받은 단건을 지우는 자리다', () => {
    const fresh = quote(T0 + 45_000);
    const cached = quote(T0);
    assert.equal(shouldReplaceQuote(fresh, cached), false);
  });

  it('같은 시각이면 덮는다 — 안 덮으면 첫 값이 영영 남는다', () => {
    assert.equal(shouldReplaceQuote(quote(T0), quote(T0)), true);
  });
});

describe('oldestFetchedAt', () => {
  it('가장 묵은 것을 고른다 — 한 종목만 새것이어도 목록이 새것이 되면 안 된다', () => {
    const quotes = [quote(T0 + 40_000, 'a'), quote(T0, 'b'), quote(T0 + 5_000, 'c')];
    assert.equal(oldestFetchedAt(quotes), T0);
  });

  it('빈 목록은 undefined다 — Math.min()은 Infinity라 나이가 음수가 된다', () => {
    assert.equal(oldestFetchedAt([]), undefined);
    assert.equal(Math.min(), Infinity, '이 함정 때문에 함수로 뺐다');
  });

  it('시각이 숫자가 아닌 것은 세지 않는다', () => {
    assert.equal(oldestFetchedAt([quote(Number.NaN, 'a'), quote(T0, 'b')]), T0);
    assert.equal(oldestFetchedAt([quote(Number.NaN, 'a')]), undefined);
  });
});
