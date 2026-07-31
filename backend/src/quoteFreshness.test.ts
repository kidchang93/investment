/**
 * 화면이 시세의 나이를 다루는 규칙 검증 (`shared`의 순수 함수 둘).
 *
 * 프런트에는 시험 러너가 없어서 `riskRuleBlockers`·`settledRealized`처럼 판단을
 * `shared`의 순수 함수로 빼고 여기서 덮는다. 실계좌·장중이 아니면 화면으로 태워
 * 볼 수 없는 자리라 더 그렇다.
 *
 * 재는 것은 셋이다.
 * - 늦게 온 **묵은** 값이 방금 받은 값을 덮지 않는가 (`shouldReplaceQuote`)
 * - 목록의 나이를 **가장 묵은 것**으로 말하는가 (`oldestFetchedAt`)
 * - **아직 안 옴**과 **못 받음**을 가르는가 (`quoteFreshnessState`)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { oldestFetchedAt, quoteFreshnessState, shouldReplaceQuote, type Quote } from '@invest/shared';

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

/*
 * 화면 세 자리(헤더 칩·종목 정보 띠·하단 도크)가 이 판정으로 말한다.
 *
 * 실패 쪽은 실계좌·장중에도 화면으로 태우기 어렵다 — 502를 흉내 내야 나온다.
 * 그래서 `riskRuleBlockers`처럼 판정만 떼어 여기서 덮는다.
 */
describe('quoteFreshnessState', () => {
  const STALE_MS = 120_000;

  it('받은 것도 없고 실패도 없으면 기다리는 중이다', () => {
    assert.deepEqual(quoteFreshnessState(null, T0, STALE_MS, false), { kind: 'waiting', ageMs: null });
  });

  /*
   * 예전에는 이 자리도 `waiting`이라 화면이 `갱신 대기`라고 적었다. 오지 않을
   * 답을 기다리게 된다 — 2026-07-31 장중에 시세 조회를 502로 막고 확인했다.
   */
  it('받은 것이 없는데 조회가 깨졌으면 기다리는 중이 아니다', () => {
    assert.deepEqual(quoteFreshnessState(null, T0, STALE_MS, true), { kind: 'failed', ageMs: null });
  });

  it('문턱 안이면 나이를 말한다', () => {
    assert.deepEqual(quoteFreshnessState(T0 - 40_000, T0, STALE_MS, false), { kind: 'fresh', ageMs: 40_000 });
  });

  it('문턱을 넘으면 낡았다고 말한다', () => {
    assert.deepEqual(quoteFreshnessState(T0 - 121_000, T0, STALE_MS, false), { kind: 'stale', ageMs: 121_000 });
  });

  it('경계에서는 아직 낡지 않았다', () => {
    assert.equal(quoteFreshnessState(T0 - STALE_MS, T0, STALE_MS, false).kind, 'fresh');
    assert.equal(quoteFreshnessState(T0 - STALE_MS - 1, T0, STALE_MS, false).kind, 'stale');
  });

  /*
   * 받아 둔 값이 있어도 마지막 조회가 실패했으면 그게 지금 값인지는 아는 것이
   * 아니다. 나이는 그대로 말하되 `fresh`라고 하지는 않는다.
   */
  it('값이 방금 것이어도 마지막 조회가 실패했으면 fresh가 아니다', () => {
    assert.deepEqual(quoteFreshnessState(T0 - 1_000, T0, STALE_MS, true), { kind: 'stale', ageMs: 1_000 });
  });

  it('시계가 뒤로 가도 나이는 음수가 되지 않는다', () => {
    assert.deepEqual(quoteFreshnessState(T0 + 5_000, T0, STALE_MS, false), { kind: 'fresh', ageMs: 0 });
  });
});
