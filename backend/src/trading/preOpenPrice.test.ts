/**
 * 개장 전 가격 출처 검증.
 *
 * ★ **가장 중요한 것은 "값이 없을 때 값을 지어내지 않는가"다.** 여기서 전일
 * 종가가 새어 나가면 러너가 어제 가격으로 지정가를 걸고, 갭이 큰 날일수록
 * 크게 틀린다 — 그리고 갭이 큰 날이 우리가 거래하려는 바로 그 날이다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { KisExchange } from '../kis/exchanges.js';
import { planPriceSource, resolveTradablePrice } from './preOpenPrice.js';

/** KST 기준 `HH:MM`의 Date. 서버 타임존과 무관해야 하므로 오프셋을 박아 만든다. */
function kst(hhmm: string): Date {
  return new Date(`2026-08-06T${hhmm}:00+09:00`);
}

describe('개장 전 가격 — 시각마다 물을 곳이 다르다', () => {
  it('08:00~08:49는 NXT 프리마켓이다', () => {
    for (const t of ['08:00', '08:30', '08:49']) {
      const plan = planPriceSource(kst(t));
      assert.equal(plan.kind, 'nxtLast', t);
      assert.equal(plan.exchange, 'NXT', t);
    }
  });

  /*
   * 08:50에 NXT가 휴장한다. 여기서 경계를 한 칸 넓게 잡으면 닫힌 시장에 물어
   * 값이 없는데 "없는 종목"으로 읽게 된다 — 원인이 완전히 달라진다.
   */
  it('08:50~08:59는 KRX 예상체결가다 — NXT는 이미 닫혔다', () => {
    for (const t of ['08:50', '08:55', '08:59']) {
      const plan = planPriceSource(kst(t));
      assert.equal(plan.kind, 'krxExpected', t);
      assert.equal(plan.exchange, 'KRX', t);
    }
  });

  it('09:00~15:30은 KRX 현재가다', () => {
    for (const t of ['09:00', '12:00', '15:30']) {
      assert.equal(planPriceSource(kst(t)).kind, 'krxLast', t);
    }
  });

  /*
   * KRX 동시호가는 08:30부터 호가를 받지만 **예상체결가는 08:50부터**다
   * (2025년에 20분→10분 단축). 그 사이를 "KRX에 물으면 된다"로 두면 전일 종가가
   * 온다 — 오류 없이, 정상 응답으로.
   */
  it('07:59와 15:31에는 살아 있는 값이 없다', () => {
    for (const t of ['07:59', '15:31', '20:00', '03:00']) {
      const plan = planPriceSource(kst(t));
      assert.equal(plan.kind, 'none', t);
      assert.equal(plan.exchange, null, t);
    }
  });
});

describe('개장 전 가격 — 없는 것을 지어내지 않는다', () => {
  const never = {
    lastPrice: async (): Promise<number> => {
      throw new Error('물을 곳이 없는 시각에는 부르면 안 된다');
    },
    expectedPrice: async (): Promise<number> => {
      throw new Error('물을 곳이 없는 시각에는 부르면 안 된다');
    },
  };

  it('물을 곳이 없는 시각에는 아예 묻지 않는다', async () => {
    const resolved = await resolveTradablePrice('005930', kst('07:30'), never);
    assert.equal(resolved.live, false);
    assert.equal(resolved.price, 0);
    assert.equal(resolved.kind, 'none');
  });

  /*
   * NXT 대상은 603종목뿐이다. 그 밖의 종목은 08:30에 정말로 값이 없고,
   * 그때 0이 아니라 전일 종가가 돌아오면 러너가 그걸로 주문을 만든다.
   */
  it('그 시장에 값이 없으면 live=false다 — 다른 값으로 대신하지 않는다', async () => {
    const resolved = await resolveTradablePrice('123456', kst('08:30'), {
      lastPrice: async () => 0,
      expectedPrice: async () => 999_999,
    });
    assert.equal(resolved.live, false);
    assert.equal(resolved.price, 0);
    // 예상체결가가 있어도 그 시각의 출처가 아니므로 끌어다 쓰지 않는다.
    assert.equal(resolved.kind, 'nxtLast');
  });

  it('NaN도 값이 아니다', async () => {
    const resolved = await resolveTradablePrice('005930', kst('08:30'), {
      lastPrice: async () => Number.NaN,
      expectedPrice: async () => 0,
    });
    assert.equal(resolved.live, false);
  });

  it('값이 있으면 그대로 주고 출처를 남긴다', async () => {
    const asked: KisExchange[] = [];
    const resolved = await resolveTradablePrice('005930', kst('08:30'), {
      lastPrice: async (_s, exchange) => {
        asked.push(exchange);
        return 247_750;
      },
      expectedPrice: async () => 0,
    });
    assert.equal(resolved.live, true);
    assert.equal(resolved.price, 247_750);
    assert.deepEqual(asked, ['NXT'], '프리마켓인데 KRX에 물었다');
    assert.match(resolved.note, /NXT/);
  });

  it('08:55에는 예상체결가 쪽을 부른다', async () => {
    let usedExpected = false;
    const resolved = await resolveTradablePrice('005930', kst('08:55'), {
      lastPrice: async () => 240_000,
      expectedPrice: async () => {
        usedExpected = true;
        return 251_000;
      },
    });
    assert.equal(usedExpected, true, '현재가를 불렀다 — 그 시각 현재가는 전일 종가다');
    assert.equal(resolved.price, 251_000);
  });
});
