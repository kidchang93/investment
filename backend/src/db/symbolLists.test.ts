/**
 * 종목 허용·차단 목록이 **매도를 막지 않는지** 검증.
 *
 * ── 왜 이 시험이 따로 있나 (2026-08-04) ──────────────────────────────────
 *
 * 에이전트가 그날의 종목을 허용목록에 써넣는 구조를 붙이려다 잡았다. 허용목록은
 * **매일 바뀌는 값**이라, 어제 산 종목이 오늘 목록에 없는 것이 정상이다. 그런데
 * 그때 매도가 막히면 **계좌가 하루 만에 통째로 얼어붙는다** — 보유 8종목이
 * 영영 못 파는 자산이 된다.
 *
 * 이 착각이 이번이 세 번째다(일일 건수 한도 · 일일 금액 한도 · 종목 목록).
 * 그래서 값으로 못 박는다: **안전장치는 들어가는 것을 막지 나오는 것을 막지 않는다.**
 *
 * `checkRiskRules`는 DB를 타므로 여기서는 그 안의 판정 순서를 그대로 옮긴
 * 순수 함수로 잰다 — 시험이 Postgres에 기대면 결과가 환경에 따라 흔들린다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { OrderSide } from '@invest/shared';

/**
 * `checkRiskRules`의 종목 목록 판정과 **같은 규칙**. 저기를 고치면 여기도 고쳐야
 * 한다 — 두 곳에 두는 것이 마음에 걸리지만, DB 없이 이 계약을 잴 방법이 없다.
 */
function symbolListViolations(input: {
  side: OrderSide;
  symbol: string;
  allowlist: string[];
  blocklist: string[];
}): string[] {
  const violations: string[] = [];
  if (input.side !== 'sell') {
    if (input.blocklist.includes(input.symbol)) violations.push('차단 종목');
    if (input.allowlist.length > 0 && !input.allowlist.includes(input.symbol)) {
      violations.push('허용 목록 밖');
    }
  }
  return violations;
}

const TODAY_PICKS = ['005930', '000660'];

describe('종목 목록 — 사는 것을 막는다', () => {
  it('허용목록 밖 종목은 못 산다', () => {
    const blocked = symbolListViolations({
      side: 'buy',
      symbol: '000050',
      allowlist: TODAY_PICKS,
      blocklist: [],
    });
    assert.deepEqual(blocked, ['허용 목록 밖']);
  });

  it('허용목록 안 종목은 살 수 있다', () => {
    assert.deepEqual(
      symbolListViolations({ side: 'buy', symbol: '005930', allowlist: TODAY_PICKS, blocklist: [] }),
      [],
    );
  });

  it('차단 종목은 못 산다', () => {
    assert.deepEqual(
      symbolListViolations({ side: 'buy', symbol: '005930', allowlist: [], blocklist: ['005930'] }),
      ['차단 종목'],
    );
  });

  it('목록이 비어 있으면 아무것도 안 막는다', () => {
    assert.deepEqual(
      symbolListViolations({ side: 'buy', symbol: '000050', allowlist: [], blocklist: [] }),
      [],
    );
  });
});

describe('종목 목록 — 나오는 것은 막지 않는다', () => {
  /*
   * 어제 산 종목이 오늘 허용목록에 없는 상황. 에이전트가 매일 목록을 새로
   * 쓰면 **정상적으로 늘 일어난다.**
   */
  it('허용목록 밖이어도 팔 수 있다 — 계좌가 얼어붙지 않게', () => {
    assert.deepEqual(
      symbolListViolations({ side: 'sell', symbol: '000050', allowlist: TODAY_PICKS, blocklist: [] }),
      [],
    );
  });

  /* 위험해서 차단한 종목일수록 빠져나오는 길은 열려 있어야 한다. */
  it('차단 종목이어도 팔 수 있다', () => {
    assert.deepEqual(
      symbolListViolations({ side: 'sell', symbol: '005930', allowlist: [], blocklist: ['005930'] }),
      [],
    );
  });

  it('둘 다에 걸려도 팔 수 있다', () => {
    assert.deepEqual(
      symbolListViolations({
        side: 'sell',
        symbol: '000050',
        allowlist: TODAY_PICKS,
        blocklist: ['000050'],
      }),
      [],
    );
  });
});

/*
 * 2026-08-04 11:54:29 실측: *"SK텔레콤 매도 차단 · 1회 주문 금액 한도
 * 13,000,000원을 초과합니다."* 143주 × 91,700원 = 13.1M. 그 종목이 팔 수 없는
 * 채로 갇혔다 — 값이 오르면 더 못 판다.
 *
 * 오늘 같은 착각을 **네 번** 고쳤다(일일 건수 · 일일 금액 · 종목 목록 · 1회 한도).
 * 그래서 규칙 자체를 시험으로 못 박는다.
 */
function perOrderViolations(input: {
  side: OrderSide;
  quantity: number;
  notional: number | undefined;
  maxQuantity: number;
  maxNotional: number;
}): string[] {
  const violations: string[] = [];
  if (input.side !== 'sell') {
    if (input.quantity > input.maxQuantity) violations.push('1회 수량 초과');
    if (input.notional === undefined) violations.push('단가 모름');
    else if (input.notional > input.maxNotional) violations.push('1회 금액 초과');
  }
  return violations;
}

describe('1회 한도 — 사는 것만 막는다', () => {
  const LIMITS = { maxQuantity: 50_000, maxNotional: 13_000_000 };

  it('한도를 넘는 매수는 막는다', () => {
    assert.deepEqual(
      perOrderViolations({ side: 'buy', quantity: 143, notional: 13_113_100, ...LIMITS }),
      ['1회 금액 초과'],
    );
  });

  /* 그날 실제로 갇힌 조합. 이제 나갈 수 있어야 한다. */
  it('한도를 넘어도 매도는 막지 않는다 — 갇히지 않게', () => {
    assert.deepEqual(
      perOrderViolations({ side: 'sell', quantity: 143, notional: 13_113_100, ...LIMITS }),
      [],
    );
  });

  it('수량 한도도 매도는 안 막는다', () => {
    assert.deepEqual(
      perOrderViolations({ side: 'sell', quantity: 999_999, notional: 1_000, ...LIMITS }),
      [],
    );
  });

  /*
   * 단가를 모르면 매수는 보류한다(얼마나 큰 베팅인지 모른다). 매도는 수량이
   * 보유량으로 정해져 있어 그 걱정이 성립하지 않는다.
   */
  it('단가를 몰라도 매도는 나간다', () => {
    assert.deepEqual(
      perOrderViolations({ side: 'sell', quantity: 143, notional: undefined, ...LIMITS }),
      [],
    );
    assert.deepEqual(
      perOrderViolations({ side: 'buy', quantity: 143, notional: undefined, ...LIMITS }),
      ['단가 모름'],
    );
  });
});
