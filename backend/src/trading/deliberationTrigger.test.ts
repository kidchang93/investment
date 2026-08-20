/**
 * 사건 감지 검증.
 *
 * ★ 여기서 지키는 것 둘:
 *   1. **같은 사건에 두 번 깨지 않는다** — 기준선이 직전 회의라 회의가 열리면 갱신된다
 *   2. **모르는 것을 사건으로 치지 않는다** — 기준선이 없거나 값이 0이면 안 깨운다
 *
 * 잘못 울리는 감지기는 안 울리는 감지기와 같다. 매번 울리면 아무도 안 본다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkDeliberationTrigger, TRIGGER_THRESHOLDS } from './deliberationTrigger.js';

const ref = { kospi: 6500, kosdaq: 800, prices: { '005930': 100_000 } };

describe('사건 감지 — 직전 회의 대비로 잰다', () => {
  it('보유 종목이 문턱만큼 움직이면 연다', () => {
    for (const price of [103_000, 97_000]) {
      const v = checkDeliberationTrigger({
        reference: ref,
        now: { kospi: 6500, kosdaq: 800, prices: { '005930': price } },
        newFills: [],
      });
      assert.equal(v.fire, true, String(price));
      assert.match(v.reasons.join(' '), /보유 005930/);
    }
  });

  it('문턱에 못 미치면 안 연다', () => {
    const v = checkDeliberationTrigger({
      reference: ref,
      now: { kospi: 6500, kosdaq: 800, prices: { '005930': 102_900 } },
      newFills: [],
    });
    assert.equal(v.fire, false, v.reasons.join(' '));
  });

  /*
   * ★ 이게 이 설계의 핵심이다. 전일 종가 기준이면 아침에 −2% 벌어진 뒤 종일
   * 걸려 있어 매 폴링마다 깨운다. 직전 회의가 기준이면 회의가 열릴 때 갱신되므로
   * **같은 하락에 두 번 깨지 않는다.**
   */
  it('회의가 열려 기준선이 갱신되면 같은 하락에 다시 안 열린다', () => {
    const crashed = { kospi: 6500, kosdaq: 800, prices: { '005930': 95_000 } };
    assert.equal(checkDeliberationTrigger({ reference: ref, now: crashed, newFills: [] }).fire, true);

    // 회의가 열렸으므로 기준선이 95,000으로 갱신된다. 값이 그대로면 더는 사건이 아니다.
    const after = { kospi: 6500, kosdaq: 800, prices: { '005930': 95_000 } };
    assert.equal(
      checkDeliberationTrigger({ reference: after, now: crashed, newFills: [] }).fire,
      false,
    );
  });

  it('지수도 문턱을 넘으면 연다', () => {
    const v = checkDeliberationTrigger({
      reference: ref,
      now: { kospi: 6500 * (1 - TRIGGER_THRESHOLDS.indexMovePercent / 100), kosdaq: 800, prices: {} },
      newFills: [],
    });
    assert.equal(v.fire, true);
    assert.match(v.reasons.join(' '), /코스피/);
  });
});

describe('사건 감지 — 체결·거절은 값과 무관하게 사건이다', () => {
  it('거절이면 연다 — 값이 하나도 안 움직여도', () => {
    const v = checkDeliberationTrigger({
      reference: ref,
      now: { kospi: 6500, kosdaq: 800, prices: { '005930': 100_000 } },
      newFills: [{ symbol: '005930', side: 'sell', status: 'rejected' }],
    });
    assert.equal(v.fire, true);
    assert.match(v.reasons.join(' '), /거절/);
  });

  it('체결도 사건이다 — 자리가 바뀌었으니 다음 수를 정해야 한다', () => {
    const v = checkDeliberationTrigger({
      reference: ref,
      now: { kospi: 6500, kosdaq: 800, prices: { '005930': 100_000 } },
      newFills: [{ symbol: '005930', side: 'buy', status: 'filled' }],
    });
    assert.equal(v.fire, true);
    assert.match(v.reasons.join(' '), /체결/);
  });
});

describe('사건 감지 — 모르는 것을 사건으로 치지 않는다', () => {
  /*
   * 오늘 첫 회의는 기준선이 없다. 여기서 열면 **매 폴링마다** 열린다 —
   * 첫 회의는 정기 회차가 연다.
   */
  it('기준선이 없으면 값 변화로는 안 연다', () => {
    const v = checkDeliberationTrigger({
      reference: null,
      now: { kospi: 6500, kosdaq: 800, prices: { '005930': 1 } },
      newFills: [],
    });
    assert.equal(v.fire, false, v.reasons.join(' '));
  });

  it('기준선이 없어도 체결·거절은 연다', () => {
    const v = checkDeliberationTrigger({
      reference: null,
      now: { prices: {} },
      newFills: [{ symbol: '005930', side: 'sell', status: 'rejected' }],
    });
    assert.equal(v.fire, true);
  });

  /* 직전 회의 때 안 갖고 있던 종목은 비교할 대상이 없다. 0으로 치면 무한대가 된다. */
  it('기준선에 없는 종목은 건너뛴다', () => {
    const v = checkDeliberationTrigger({
      reference: ref,
      now: { prices: { '000660': 999_999 } },
      newFills: [],
    });
    assert.equal(v.fire, false, v.reasons.join(' '));
  });

  it('기준값이 0이면 나누지 않는다', () => {
    const v = checkDeliberationTrigger({
      reference: { kospi: 0, prices: { '005930': 0 } },
      now: { kospi: 6500, prices: { '005930': 100_000 } },
      newFills: [],
    });
    assert.equal(v.fire, false, v.reasons.join(' '));
  });
});

describe('사건 감지 — 사유를 전부 적는다', () => {
  it('여러 개가 겹치면 모두 남긴다', () => {
    const v = checkDeliberationTrigger({
      reference: ref,
      now: { kospi: 6300, kosdaq: 800, prices: { '005930': 95_000 } },
      newFills: [{ symbol: '000660', side: 'buy', status: 'filled' }],
    });
    assert.equal(v.fire, true);
    // 체결 · 보유 급변 · 지수 급변 셋이 다 있어야 한다. 하나만 적으면 나머지를 놓친다.
    assert.equal(v.reasons.length, 3, v.reasons.join(' / '));
  });
});

describe('오래 묵은 미체결 — 안 붙는 것도 사건이다 (2026-08-20)', () => {
  const HOUR = 60 * 60 * 1000;
  const now = 1_000 * HOUR;
  const stale = [{ symbol: '005930', side: 'buy' as const, placedAt: now - 4 * HOUR }];

  it('장이 충분히 지나고 주문도 묵었으면 연다', () => {
    const v = checkDeliberationTrigger({
      reference: ref,
      now: { prices: {} },
      newFills: [],
      openOrders: stale,
      now_ms: now,
      sessionElapsed: 0.75,
    });
    assert.equal(v.fire, true, v.reasons.join(' '));
    assert.match(v.reasons[0], /005930 매수 미체결/);
  });

  it('★ 장이 덜 지났으면 열지 않는다 — 갭 되돌림은 종가까지 걸쳐 온다', () => {
    const v = checkDeliberationTrigger({
      reference: ref,
      now: { prices: {} },
      newFills: [],
      openOrders: stale,
      now_ms: now,
      sessionElapsed: 0.3,
    });
    assert.equal(v.fire, false, v.reasons.join(' '));
  });

  it('★ 장은 지났어도 방금 낸 주문이면 열지 않는다', () => {
    const v = checkDeliberationTrigger({
      reference: ref,
      now: { prices: {} },
      newFills: [],
      // 13:30에 갓 낸 주문. 장 경과만 보면 즉시 "오래됐다"가 되는 자리다
      openOrders: [{ symbol: '005930', side: 'buy', placedAt: now - 10 * 60 * 1000 }],
      now_ms: now,
      sessionElapsed: 0.75,
    });
    assert.equal(v.fire, false, v.reasons.join(' '));
  });

  it('미체결을 안 넘기면 이 판정을 하지 않는다 — 기존 호출부가 깨지지 않는다', () => {
    const v = checkDeliberationTrigger({
      reference: ref,
      now: { prices: {} },
      newFills: [],
      sessionElapsed: 0.9,
      now_ms: now,
    });
    assert.equal(v.fire, false, v.reasons.join(' '));
  });

  it('여러 건이면 전부 적는다', () => {
    const v = checkDeliberationTrigger({
      reference: ref,
      now: { prices: {} },
      newFills: [],
      openOrders: [
        { symbol: '005930', side: 'buy', placedAt: now - 4 * HOUR },
        { symbol: '105560', side: 'buy', placedAt: now - 4 * HOUR },
      ],
      now_ms: now,
      sessionElapsed: 0.75,
    });
    assert.equal(v.reasons.length, 2, v.reasons.join(' / '));
  });
});
