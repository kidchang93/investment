/**
 * 후보 거르기 검증.
 *
 * 이 두 문이 무엇을 통과시키느냐가 자동매매가 무엇을 사느냐다. 백테스트가
 * 아무리 좋게 나와도 여기서 잘못 통과시키면 그 값에 체결되지 않는다.
 *
 * 경계값을 못 박아 둔다 — 문턱은 조정할 값이지만, 조정했을 때 어느 쪽으로
 * 움직이는지는 시험이 말해 줘야 한다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Quote } from '@invest/shared';

import { screenQuote } from './universe.js';

/** 넉넉히 통과하는 기본값. 시험마다 필요한 값만 덮어쓴다. */
function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    code: 'KR:KOSPI:000000',
    price: 10_000,
    change: 0,
    changeRate: 0,
    sign: '3',
    open: 10_000,
    // 하루 2% 움직인 종목. 왕복 비용 0.43%는 변동폭의 21% 수준이라 통과한다.
    high: 10_100,
    low: 9_900,
    accVolume: 100_000, // 거래대금 10억
    ...overrides,
  };
}

describe('후보 거르기 — 유동성', () => {
  it('거래대금이 넉넉하면 통과한다', () => {
    assert.equal(screenQuote(quote(), 1), null);
  });

  it('거래대금이 문턱에 못 미치면 걸린다', () => {
    // 5천만원 문턱. 1만원 × 4,000주 = 4천만원.
    assert.equal(screenQuote(quote({ accVolume: 4_000 }), 1), 'illiquid');
  });

  it('문턱 바로 위는 통과한다', () => {
    // 1만원 × 5,000주 = 5천만원 = 문턱. 미만일 때만 거르므로 통과다.
    assert.equal(screenQuote(quote({ accVolume: 5_000 }), 1), null);
  });

  it('KIS가 준 실제 거래대금을 쓴다 — 현재가 × 거래량 어림이 아니다', () => {
    /*
     * 어림값(현재가 × 누적거래량)은 하루치 체결을 마지막 값 하나로 곱하는 것이라
     * 실제와 어긋난다. 005930 실측(2026-07-30 종가): 어림 9.67조 vs 실제 9.92조.
     *
     * 여기서는 둘이 문턱의 **반대편**에 놓이게 만든다. 어림값을 쓰면 판정이
     * 뒤집히므로, 이 시험이 통과한다는 것은 실제 값을 봤다는 뜻이다.
     */
    const underEstimated = quote({ price: 10_000, accVolume: 4_000, turnover: 60_000_000 });
    assert.equal(underEstimated.price * underEstimated.accVolume, 40_000_000, '어림하면 문턱 아래다');
    assert.equal(screenQuote(underEstimated, 1), null, '실제 거래대금은 6천만원이라 통과해야 한다');

    const overEstimated = quote({ price: 10_000, accVolume: 6_000, turnover: 40_000_000 });
    assert.equal(overEstimated.price * overEstimated.accVolume, 60_000_000, '어림하면 문턱 위다');
    assert.equal(screenQuote(overEstimated, 1), 'illiquid', '실제 거래대금은 4천만원이라 걸려야 한다');
  });

  it('거래대금을 안 주는 경로(해외·선물·야간 환산가)는 어림값으로 본다', () => {
    // 값이 없다고 통과시키거나 통째로 거르지 않는다. 어림이라는 사실만 남긴다.
    assert.equal(screenQuote(quote({ accVolume: 4_000 }), 1), 'illiquid');
    assert.equal(screenQuote(quote({ accVolume: 6_000 }), 1), null);
  });

  it('거래대금이 0이면 값이 0인 것이지 모르는 것이 아니다', () => {
    // 거래정지 종목이 실제로 이렇게 온다(009310 실측: 현재가 5,330 · 거래량 0).
    assert.equal(screenQuote(quote({ accVolume: 0, turnover: 0, high: 0, low: 0 }), 1), 'illiquid');
  });

  it('장 초반에는 지난 시간만큼만 요구한다', () => {
    /*
     * 09:05에는 5분치만 쌓인다. 하루치 문턱을 그대로 걸면 전 종목이 걸린다.
     * 10%가 지났으면 문턱도 10%다.
     */
    const early = quote({ accVolume: 600 }); // 거래대금 600만원
    assert.equal(screenQuote(early, 1), 'illiquid', '하루치 기준으로는 부족하다');
    assert.equal(screenQuote(early, 0.1), null, '10%만 지났으면 통과해야 한다');
  });
});

describe('후보 거르기 — 왕복 비용', () => {
  it('하루 변동폭이 넉넉하면 통과한다', () => {
    // 변동폭 2%, 왕복 비용 0.43% → 비용이 변동폭의 21%.
    assert.equal(screenQuote(quote({ high: 10_100, low: 9_900 }), 1), null);
  });

  it('변동폭이 왕복 비용의 두 배에 못 미치면 걸린다', () => {
    /*
     * 왕복 비용 0.43%(수수료 0.015%×2 + 거래세 0.20% + 슬리피지 0.1%×2).
     * 변동폭이 0.5%면 비용이 그 82%다. 방향을 맞혀도 남지 않는다.
     */
    assert.equal(screenQuote(quote({ high: 10_025, low: 9_975 }), 1), 'costHeavy');
  });

  it('고가·저가가 아직 없으면 이 잣대로 거르지 않는다', () => {
    /*
     * 장 초반이나 거래가 없는 종목은 고가·저가가 0으로 온다. 그걸 변동폭
     * 0으로 읽고 거르면, 모르는 것을 나쁜 것으로 단정하는 셈이다.
     */
    assert.equal(screenQuote(quote({ high: 0, low: 0 }), 1), null);
  });

  it('유동성이 먼저 걸리면 그 사유로 돌려준다', () => {
    // 둘 다 걸리는 종목. 순서가 정해져 있어야 기록이 흔들리지 않는다.
    assert.equal(screenQuote(quote({ accVolume: 100, high: 10_025, low: 9_975 }), 1), 'illiquid');
  });
});
