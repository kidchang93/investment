/**
 * 현재가 캐시 검증 — **캐시가 나이를 지우지 않는가.**
 *
 * 이 시험이 없어서 45초 묵은 값이 표시 없이 나갔다. 2026-07-31 장중 실전 실측:
 * `/api/instruments/quotes`를 7.4초 간격으로 두 번 부르면 응답이 바이트 단위로
 * 같았고(`accVolume=1340082`), 같은 7초 사이 단건 조회는 12,204주가 늘어 있었다.
 * 그 45초 동안 000660이 1,601,000 → 1,588,000원(−0.81%) 움직였다.
 *
 * 그래서 여기서 재는 것은 값이 맞는지가 아니라 **시각이 언제 것인지**다.
 * 캐시 적중에 `Date.now()`를 넣는 변이가 들어오면 첫 시험이 죽는다(확인함).
 *
 * 시각은 전부 인자로 넣는다. 전역 시계를 갈아 끼우면 45초 경계를 정확히 못 재고,
 * `window.Date`를 통째로 바꿨다가 화면이 멈춘 전례도 있다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Quote } from '@invest/shared';

import { QUOTE_CACHE_TTL_MS, QuoteCache } from './quoteCache.js';

/** 2026-07-31 10:20:00 KST. 시험이 시계를 안 보게 고정값으로 둔다. */
const T0 = Date.parse('2026-07-31T01:20:00.000Z');

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    code: 'KR:KOSPI:000660',
    fetchedAt: T0,
    price: 1_601_000,
    change: 13_000,
    changeRate: 0.82,
    sign: '2',
    open: 1_590_000,
    high: 1_610_000,
    low: 1_585_000,
    accVolume: 1_340_082,
    turnover: 2_241_669_628_000,
    ...overrides,
  };
}

describe('QuoteCache — 적중', () => {
  it('캐시에서 꺼낸 값은 **처음 받은 시각**을 그대로 들고 나온다', () => {
    const cache = new QuoteCache(QUOTE_CACHE_TTL_MS);
    cache.store('KR:KOSPI:000660', quote());

    // 44.9초 뒤. 아직 안 지났으니 적중이다.
    const now = T0 + 44_900;
    const { hits, misses } = cache.lookup(['KR:KOSPI:000660'], now);

    assert.deepEqual(misses, []);
    const hit = hits.get('KR:KOSPI:000660');
    assert.ok(hit);
    /*
     * 여기가 이 파일의 핵심이다. `now`를 넣으면 44.9초 묵은 값이 방금 것이 된다.
     * 나이를 재는 쪽은 `now - fetchedAt`을 보므로 0초로 읽힌다.
     */
    assert.equal(hit.fetchedAt, T0, '캐시가 시각을 다시 찍었다');
    assert.notEqual(hit.fetchedAt, now);
    assert.equal(now - hit.fetchedAt, 44_900, '나이가 44.9초로 나와야 한다');
  });

  it('값도 그대로다 — 나이만 붙이고 내용을 바꾸지 않는다', () => {
    const cache = new QuoteCache();
    const original = quote();
    cache.store('KR:KOSPI:000660', original);
    assert.deepEqual(cache.lookup(['KR:KOSPI:000660'], T0 + 1_000).hits.get('KR:KOSPI:000660'), original);
  });

  it('여러 번 꺼내도 나이는 계속 자란다 — 볼 때마다 새것이 되지 않는다', () => {
    const cache = new QuoteCache();
    cache.store('KR:KOSPI:000660', quote());
    const first = cache.lookup(['KR:KOSPI:000660'], T0 + 7_400).hits.get('KR:KOSPI:000660');
    const second = cache.lookup(['KR:KOSPI:000660'], T0 + 20_000).hits.get('KR:KOSPI:000660');
    assert.equal(first?.fetchedAt, T0);
    assert.equal(second?.fetchedAt, T0);
  });
});

describe('QuoteCache — 만료', () => {
  it('45초가 지나면 다시 받는다', () => {
    const cache = new QuoteCache(QUOTE_CACHE_TTL_MS);
    cache.store('KR:KOSPI:000660', quote());
    const { hits, misses } = cache.lookup(['KR:KOSPI:000660'], T0 + QUOTE_CACHE_TTL_MS);
    assert.equal(hits.size, 0);
    assert.deepEqual(misses, ['KR:KOSPI:000660']);
  });

  it('경계 바로 앞은 적중, 경계는 만료다', () => {
    const cache = new QuoteCache(QUOTE_CACHE_TTL_MS);
    cache.store('KR:KOSPI:000660', quote());
    assert.equal(cache.lookup(['KR:KOSPI:000660'], T0 + QUOTE_CACHE_TTL_MS - 1).hits.size, 1);
    assert.equal(cache.lookup(['KR:KOSPI:000660'], T0 + QUOTE_CACHE_TTL_MS).hits.size, 0);
  });

  it('다시 받아 넣으면 새 시각이 나온다', () => {
    const cache = new QuoteCache(QUOTE_CACHE_TTL_MS);
    cache.store('KR:KOSPI:000660', quote());
    const refetchedAt = T0 + 50_000;
    cache.store('KR:KOSPI:000660', quote({ fetchedAt: refetchedAt, price: 1_588_000 }));

    const hit = cache.lookup(['KR:KOSPI:000660'], refetchedAt + 1_000).hits.get('KR:KOSPI:000660');
    assert.equal(hit?.fetchedAt, refetchedAt);
    assert.equal(hit?.price, 1_588_000);
  });
});

describe('QuoteCache — 섞였을 때', () => {
  it('적중과 만료를 갈라 주고, 다시 받을 것은 물어본 순서를 지킨다', () => {
    const cache = new QuoteCache(QUOTE_CACHE_TTL_MS);
    cache.store('a', quote({ code: 'a' }));
    cache.store('b', quote({ code: 'b', fetchedAt: T0 - 60_000 }));
    cache.store('d', quote({ code: 'd' }));

    const { hits, misses } = cache.lookup(['a', 'b', 'c', 'd'], T0 + 1_000);
    assert.deepEqual([...hits.keys()], ['a', 'd']);
    // b는 너무 묵어서, c는 아예 없어서 다시 받는다. 둘을 하나로 뭉쳐도 결과는 같지만 순서는 지킨다.
    assert.deepEqual(misses, ['b', 'c']);
  });

  it('시각이 숫자가 아니면 적중으로 치지 않는다 — 나이를 모르는 값은 못 쓴다', () => {
    const cache = new QuoteCache(QUOTE_CACHE_TTL_MS);
    cache.store('a', quote({ code: 'a', fetchedAt: Number.NaN }));
    assert.deepEqual(cache.lookup(['a'], T0).misses, ['a']);
  });
});
