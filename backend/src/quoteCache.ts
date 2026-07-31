/**
 * `/api/instruments/quotes`가 쓰는 현재가 캐시.
 *
 * 관심목록·탐색 리스트는 같은 종목을 짧은 간격으로 여러 번 묻는다. 그때마다
 * KIS를 때리면 호출 한도를 여기서 다 태우므로 잠깐 들고 있는다.
 *
 * ## 캐시는 시각을 다시 찍지 않는다
 *
 * 이 모듈이 존재하는 이유가 여기 있다. 예전에는 캐시가 `{quote, fetchedAt}`으로
 * **제 시각을 따로** 들고 있었고, `Quote`에는 시각이 아예 없었다. 그래서 캐시에서
 * 꺼내 준 값이 언제 것인지 응답 어디에도 남지 않았다 — 2026-07-31 장중 실측에서
 * 7.4초 간격의 두 요청이 바이트 단위로 같은 값을 돌려줬고(`accVolume=1340082`),
 * 같은 7초 사이 단건 조회는 12,204주가 늘어 있었다. 그 45초 동안 000660이
 * 1,601,000 → 1,588,000원(−0.81%) 움직였는데 화면은 `갱신 3초 전`이라고 적었다.
 *
 * 이제 시각은 `Quote.fetchedAt` 하나뿐이고, 캐시는 그것을 **읽기만** 한다.
 * `store`가 시각을 받지 않는 것은 실수가 아니라 그 규약이다 — 넣을 때 다시 찍으면
 * 묵은 값이 방금 것이 된다.
 *
 * ## 시각을 인자로 받는다
 *
 * `lookup(ids, now)`의 `now`는 기본값이 있지만 시험은 넣어서 부른다. 전역 시계를
 * 갈아 끼우지 않고 45초 경계를 재기 위해서다(`sessionElapsedRatio`와 같은 방식).
 */

import type { Quote } from '@invest/shared';

/**
 * 같은 값을 다시 써도 되는 시간.
 *
 * **이 값이 곧 시세가 묵을 수 있는 최대 시간이다.** 줄이면 KIS 호출이 늘고
 * 늘리면 화면이 더 묵는다. 나이를 `Quote.fetchedAt`으로 내보내므로 화면이
 * 얼마나 묵었는지 말할 수 있다 — 이 상수를 프런트가 알 필요는 없다.
 */
export const QUOTE_CACHE_TTL_MS = 45_000;

/** 캐시를 뒤진 결과. 받은 것과 다시 받아야 하는 것을 갈라 준다. */
export interface QuoteCacheLookup {
  /** 그대로 쓸 것. **`fetchedAt`은 처음 받은 시각 그대로다** */
  hits: Map<string, Quote>;
  /** 캐시에 없거나 너무 묵어서 다시 받아야 하는 식별자. 물어본 순서를 지킨다 */
  misses: string[];
}

export class QuoteCache {
  private readonly entries = new Map<string, Quote>();

  constructor(private readonly ttlMs: number = QUOTE_CACHE_TTL_MS) {}

  /**
   * 넣는다. 키는 `Instrument.id`이고 시각은 `quote.fetchedAt`을 그대로 쓴다.
   * **여기서 시각을 찍지 않는다** — 넣는 시각과 받은 시각은 다른 사실이다.
   */
  store(id: string, quote: Quote): void {
    this.entries.set(id, quote);
  }

  lookup(ids: string[], now: number = Date.now()): QuoteCacheLookup {
    const hits = new Map<string, Quote>();
    const misses: string[] = [];

    for (const id of ids) {
      const cached = this.entries.get(id);
      /*
       * `fetchedAt`이 숫자가 아니면 나이를 모른다. 모르는 값을 캐시 적중으로
       * 치면 얼마나 묵었는지 못 밝히므로 다시 받는 쪽으로 둔다.
       */
      if (!cached || !Number.isFinite(cached.fetchedAt) || now - cached.fetchedAt >= this.ttlMs) {
        misses.push(id);
        continue;
      }
      hits.set(id, cached);
    }

    return { hits, misses };
  }
}
