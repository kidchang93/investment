/**
 * 테마 등락률 집계 검증.
 *
 * 이 파일이 잡아야 하는 것은 **없는 사실이 지어지는 것**이다. 테마는 종목이
 * 1~110개로 제각각이고 그중 시세가 오는 것은 또 더 적다. 못 받은 종목을 0%로
 * 채우면 등락률·보합 수·거래대금이 전부 조용히 틀어지는데, 나오는 값은 여전히
 * 그럴듯한 숫자라 형식 검사로는 안 걸린다.
 *
 * **기대값은 손으로 계산해 리터럴로 적는다.** 검사 대상 함수(중앙값·가중평균)로
 * 기대값을 지으면 함수가 틀려도 왕복이 맞아떨어진다 — 앞 단위에서 픽스처를
 * 검사 대상 상수로 지어 결함을 놓친 적이 있다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Instrument, Quote, Theme, ThemeMembers } from '@invest/shared';

import { aggregateThemePulse, estimateQuoteCalls, planThemeQuotes } from './pulse.js';

function instrument(symbol: string, name: string, overrides: Partial<Instrument> = {}): Instrument {
  return {
    id: `KR:KOSPI:${symbol}`,
    symbol,
    name,
    market: 'KOSPI',
    country: 'KR',
    currency: 'KRW',
    assetType: 'stock',
    provider: 'kis',
    providerSymbol: symbol,
    exchangeCode: 'KRX',
    timezone: 'Asia/Seoul',
    ...overrides,
  };
}

/** 등락률과 거래대금만 시험이 본다. 나머지는 모양을 맞추는 값이다. */
function quote(id: string, changeRate: number, turnover?: number): Quote {
  return {
    code: id,
    price: 10_000,
    change: 100,
    changeRate,
    sign: changeRate > 0 ? '2' : changeRate < 0 ? '5' : '3',
    open: 10_000,
    high: 10_100,
    low: 9_900,
    accVolume: 1_000,
    ...(turnover !== undefined ? { turnover } : {}),
  };
}

function theme(overrides: Partial<Theme> = {}): Theme {
  return {
    code: '004',
    name: '반도체/반도체장비',
    sourceDate: '2025-11-06T00:00:00.000Z',
    symbolCount: 5,
    instrumentCount: 5,
    ...overrides,
  };
}

function members(instruments: Instrument[], missingSymbols: string[] = []): ThemeMembers {
  return {
    theme: theme({ symbolCount: instruments.length + missingSymbols.length, instrumentCount: instruments.length }),
    instruments,
    missingSymbols,
  };
}

const NO_BLANK = new Set<string>();
const NO_FAILURE = new Map<string, string>();

describe('aggregateThemePulse — 대표값', () => {
  /*
   * 대표값을 단순평균으로 바꾸면 이 시험이 죽는다. 그게 이 시험의 목적이다 —
   * 소형 테마에서는 한 종목의 상한가가 단순평균을 통째로 끌어간다.
   */
  it('중앙값은 상한가 한 종목에 끌려가지 않는다 (평균과 갈린다)', () => {
    const list = [
      instrument('000001', '가'),
      instrument('000002', '나'),
      instrument('000003', '다'),
      instrument('000004', '라'),
      instrument('000005', '마'),
    ];
    const quotes = new Map([
      ['KR:KOSPI:000001', quote('KR:KOSPI:000001', 29.9)],
      ['KR:KOSPI:000002', quote('KR:KOSPI:000002', 0.5)],
      ['KR:KOSPI:000003', quote('KR:KOSPI:000003', 0.2)],
      ['KR:KOSPI:000004', quote('KR:KOSPI:000004', -0.4)],
      ['KR:KOSPI:000005', quote('KR:KOSPI:000005', -1.0)],
    ]);

    const pulse = aggregateThemePulse(members(list), quotes, NO_BLANK, NO_FAILURE);

    // 정렬하면 -1.0, -0.4, 0.2, 0.5, 29.9 → 가운데는 0.2
    assert.equal(pulse.changeRateMedian, 0.2);
    // (29.9 + 0.5 + 0.2 - 0.4 - 1.0) / 5 = 29.2 / 5 = 5.84
    assert.equal(pulse.changeRateMean, 5.84);
    assert.notEqual(pulse.changeRateMedian, pulse.changeRateMean);
  });

  it('짝수면 가운데 둘의 평균이다', () => {
    const list = [
      instrument('000001', '가'),
      instrument('000002', '나'),
      instrument('000003', '다'),
      instrument('000004', '라'),
    ];
    const quotes = new Map([
      ['KR:KOSPI:000001', quote('KR:KOSPI:000001', 5)],
      ['KR:KOSPI:000002', quote('KR:KOSPI:000002', 2)],
      ['KR:KOSPI:000003', quote('KR:KOSPI:000003', 0)],
      ['KR:KOSPI:000004', quote('KR:KOSPI:000004', -1)],
    ]);

    const pulse = aggregateThemePulse(members(list), quotes, NO_BLANK, NO_FAILURE);
    // -1, 0, 2, 5 → (0 + 2) / 2 = 1
    assert.equal(pulse.changeRateMedian, 1);
    assert.equal(pulse.changeRateMean, 1.5);
  });

  it('한 종목짜리 테마는 그 값이 곧 중앙값이다', () => {
    const quotes = new Map([['KR:KOSPI:000001', quote('KR:KOSPI:000001', -3.25)]]);
    const pulse = aggregateThemePulse(
      members([instrument('000001', '가')]),
      quotes,
      NO_BLANK,
      NO_FAILURE,
    );
    assert.equal(pulse.changeRateMedian, -3.25);
    assert.equal(pulse.quotedCount, 1);
  });

  it('등락률 내림차순으로 준다', () => {
    const list = [instrument('000001', '가'), instrument('000002', '나'), instrument('000003', '다')];
    const quotes = new Map([
      ['KR:KOSPI:000001', quote('KR:KOSPI:000001', -2)],
      ['KR:KOSPI:000002', quote('KR:KOSPI:000002', 7)],
      ['KR:KOSPI:000003', quote('KR:KOSPI:000003', 1)],
    ]);
    const pulse = aggregateThemePulse(members(list), quotes, NO_BLANK, NO_FAILURE);
    assert.deepEqual(pulse.members.map((row) => row.symbol), ['000002', '000003', '000001']);
  });
});

describe('aggregateThemePulse — 거래대금 가중', () => {
  /*
   * 물음이 "돈이 어디로 도는지"라 가중평균이 따로 필요하다. 다만 대표값과
   * 성질이 다르다 — 대형주 하나가 든 테마는 이 값이 사실상 그 종목 등락률이다.
   * 그래서 셋을 따로 담고, 이 시험이 셋이 실제로 갈리는 것을 못 박는다.
   */
  it('큰 거래대금 쪽으로 쏠린다 — 중앙값·평균과 갈린다', () => {
    const list = [instrument('005930', '삼성전자'), instrument('000002', '나'), instrument('000003', '다')];
    const quotes = new Map([
      // 거래대금 90억, -1%
      ['KR:KOSPI:005930', quote('KR:KOSPI:005930', -1, 9_000_000_000)],
      // 5억, +10%
      ['KR:KOSPI:000002', quote('KR:KOSPI:000002', 10, 500_000_000)],
      // 5억, +20%
      ['KR:KOSPI:000003', quote('KR:KOSPI:000003', 20, 500_000_000)],
    ]);

    const pulse = aggregateThemePulse(members(list), quotes, NO_BLANK, NO_FAILURE);

    // (-1×90 + 10×5 + 20×5) / 100 = (-90 + 50 + 100) / 100 = 0.6
    assert.equal(pulse.changeRateWeighted, 0.6);
    assert.equal(pulse.changeRateMedian, 10);
    // (-1 + 10 + 20) / 3 = 29/3
    assert.equal(pulse.changeRateMean, 29 / 3);
    assert.equal(pulse.turnover, 10_000_000_000);
    assert.equal(pulse.turnoverCount, 3);
  });

  /*
   * 여기서 어림(`현재가 × 거래량`)으로 채우면 이 시험이 죽는다. 어림은
   * 2026-07-30 113종목 실측에서 중앙값 +0.28%, 범위 −6.68% ~ +6.24%로 어긋난다.
   */
  it('거래대금이 없는 종목은 가중에서 빼고 몇 개로 냈는지 밝힌다', () => {
    const list = [instrument('000001', '가'), instrument('000002', '나')];
    const quotes = new Map([
      ['KR:KOSPI:000001', quote('KR:KOSPI:000001', -5, 1_000_000_000)],
      // 거래대금이 안 온 종목. 어림하면 10,000 × 1,000 = 1,000만원이 잡힌다.
      ['KR:KOSPI:000002', quote('KR:KOSPI:000002', 25)],
    ]);

    const pulse = aggregateThemePulse(members(list), quotes, NO_BLANK, NO_FAILURE);

    assert.equal(pulse.changeRateWeighted, -5, '거래대금이 온 종목만으로 낸다');
    assert.equal(pulse.turnover, 1_000_000_000);
    assert.equal(pulse.turnoverCount, 1);
    assert.equal(pulse.quotedCount, 2, '가중에서 빠져도 등락률 표본에는 남는다');
    assert.equal(pulse.changeRateMean, 10);
    assert.equal('turnover' in pulse.members[0], false, '없는 거래대금을 지어내지 않는다');
  });

  it('거래대금이 하나도 없으면 가중평균과 합계 자체가 없다 — 0이 아니다', () => {
    const quotes = new Map([['KR:KOSPI:000001', quote('KR:KOSPI:000001', 1.5)]]);
    const pulse = aggregateThemePulse(
      members([instrument('000001', '가')]),
      quotes,
      NO_BLANK,
      NO_FAILURE,
    );
    assert.equal('changeRateWeighted' in pulse, false);
    assert.equal('turnover' in pulse, false);
    assert.equal(pulse.turnoverCount, 0);
  });

  it('거래대금 0인 거래정지 종목은 가중에 넣지 않는다 — 0을 곱하면 없는 것과 같다', () => {
    // 009310 참엔지니어링 실측: 현재가는 있고 거래량·거래대금이 0.
    const list = [instrument('000001', '가'), instrument('009310', '참엔지니어링')];
    const quotes = new Map([
      ['KR:KOSPI:000001', quote('KR:KOSPI:000001', 3, 2_000_000_000)],
      ['KR:KOSPI:009310', quote('KR:KOSPI:009310', 0, 0)],
    ]);
    const pulse = aggregateThemePulse(members(list), quotes, NO_BLANK, NO_FAILURE);
    assert.equal(pulse.turnoverCount, 1);
    assert.equal(pulse.changeRateWeighted, 3);
    assert.equal(pulse.quotedCount, 2, '거래정지 종목도 등락률 표본에는 남는다');
    assert.equal(pulse.unchanged, 1);
  });
});

describe('aggregateThemePulse — 표본이 전체가 아니다', () => {
  it('시세가 안 온 종목을 0%로 채우지 않는다', () => {
    const list = [instrument('000001', '가'), instrument('000002', '나'), instrument('000003', '다')];
    const quotes = new Map([
      ['KR:KOSPI:000001', quote('KR:KOSPI:000001', 4)],
      ['KR:KOSPI:000002', quote('KR:KOSPI:000002', 6)],
    ]);
    const blank = new Set(['KR:KOSPI:000003']);

    const pulse = aggregateThemePulse(members(list, ['000009']), quotes, blank, NO_FAILURE);

    // 0%짜리를 끼우면 중앙값이 4로, 보합이 1로 바뀐다.
    assert.equal(pulse.changeRateMedian, 5);
    assert.equal(pulse.changeRateMean, 5);
    assert.equal(pulse.unchanged, 0);
    assert.equal(pulse.quotedCount, 2);
    assert.deepEqual(pulse.blankSymbols, ['000003']);
    // 마스터 4 → 지금 찾은 3 → 시세 온 2. 셋이 각각 남아야 화면이 적을 수 있다.
    assert.equal(pulse.theme.symbolCount, 4);
    assert.equal(pulse.theme.instrumentCount, 3);
    assert.deepEqual(pulse.missingSymbols, ['000009']);
  });

  it('조회가 깨진 것과 값이 빈 것을 가른다', () => {
    const list = [
      instrument('000001', '가'),
      instrument('000002', '나'),
      instrument('000003', '다'),
      instrument('000004', '라'),
    ];
    const quotes = new Map([['KR:KOSPI:000001', quote('KR:KOSPI:000001', 2)]]);
    const blank = new Set(['KR:KOSPI:000002']);
    const failures = new Map([
      ['KR:KOSPI:000003', 'KIS 멀티시세 실패 (EGW00201): 초당 거래건수를 초과하였습니다.'],
      ['KR:KOSPI:000004', 'KIS 멀티시세 실패 (EGW00201): 초당 거래건수를 초과하였습니다.'],
    ]);

    const pulse = aggregateThemePulse(members(list), quotes, blank, failures);

    assert.deepEqual(pulse.blankSymbols, ['000002']);
    assert.deepEqual(pulse.failedSymbols, ['000003', '000004']);
    assert.equal(pulse.failureMessages.length, 1, '같은 사유를 두 번 적지 않는다');
    assert.match(pulse.failureMessages[0], /EGW00201/);
  });

  it('묻지도 않은 종목은 빈 값이 아니라 못 받은 것으로 적는다', () => {
    // 예산에서 빠진 종목이 그대로 넘어온 상황. 빈 값에 섞으면 KIS 탓으로 읽힌다.
    const list = [instrument('000001', '가'), instrument('000002', '나')];
    const quotes = new Map([['KR:KOSPI:000001', quote('KR:KOSPI:000001', 1)]]);

    const pulse = aggregateThemePulse(members(list), quotes, NO_BLANK, NO_FAILURE);

    assert.deepEqual(pulse.blankSymbols, []);
    assert.deepEqual(pulse.failedSymbols, ['000002']);
    assert.deepEqual(pulse.failureMessages, ['이 요청에서 시세를 묻지 않았습니다.']);
  });

  it('종목이 하나도 없는 테마는 등락률이 아예 없다 — 0%가 아니다', () => {
    // 실측: 302개 중 `062 와이브로` · `260 2차전지` · `321 건설사(대형)`가 그렇다.
    const empty: ThemeMembers = {
      theme: theme({ code: '260', name: '2차전지', symbolCount: 1, instrumentCount: 0 }),
      instruments: [],
      missingSymbols: ['900110'],
    };

    const pulse = aggregateThemePulse(empty, new Map(), NO_BLANK, NO_FAILURE);

    assert.equal('changeRateMedian' in pulse, false);
    assert.equal('changeRateMean' in pulse, false);
    assert.equal('changeRateWeighted' in pulse, false);
    assert.equal(pulse.quotedCount, 0);
    assert.equal(pulse.advancing, 0);
    assert.equal(pulse.declining, 0);
    assert.equal(pulse.unchanged, 0);
    assert.deepEqual(pulse.missingSymbols, ['900110']);
  });

  it('보합을 오름·내림 어느 쪽에도 넣지 않는다', () => {
    const list = [instrument('000001', '가'), instrument('000002', '나'), instrument('000003', '다')];
    const quotes = new Map([
      ['KR:KOSPI:000001', quote('KR:KOSPI:000001', 0)],
      ['KR:KOSPI:000002', quote('KR:KOSPI:000002', 0.01)],
      ['KR:KOSPI:000003', quote('KR:KOSPI:000003', -0.01)],
    ]);
    const pulse = aggregateThemePulse(members(list), quotes, NO_BLANK, NO_FAILURE);
    assert.equal(pulse.advancing, 1);
    assert.equal(pulse.declining, 1);
    assert.equal(pulse.unchanged, 1);
  });

  it('테마 밖 종목이 시세에 섞여 있어도 집계에 넣지 않는다', () => {
    // 여러 테마를 한 번에 잴 때 합집합 시세가 통째로 넘어온다.
    const quotes = new Map([
      ['KR:KOSPI:000001', quote('KR:KOSPI:000001', 2)],
      ['KR:KOSPI:999999', quote('KR:KOSPI:999999', 25)],
    ]);
    const pulse = aggregateThemePulse(
      members([instrument('000001', '가')]),
      quotes,
      NO_BLANK,
      NO_FAILURE,
    );
    assert.equal(pulse.quotedCount, 1);
    assert.equal(pulse.changeRateMedian, 2);
  });
});

describe('estimateQuoteCalls', () => {
  const many = (count: number): Instrument[] =>
    Array.from({ length: count }, (_, index) => instrument(String(index + 1).padStart(6, '0'), `종목${index}`));

  it('30종목은 1회, 31종목은 2회다', () => {
    assert.equal(estimateQuoteCalls(many(30)), 1);
    assert.equal(estimateQuoteCalls(many(31)), 2);
  });

  it('101종목(반도체 실측)은 4회다', () => {
    assert.equal(estimateQuoteCalls(many(101)), 4);
  });

  it('없으면 0회다 — 빈 테마에 호출이 나가면 안 된다', () => {
    assert.equal(estimateQuoteCalls([]), 0);
  });

  it('같은 종목코드는 한 번만 센다 — 테마끼리 겹친다', () => {
    const samsung = instrument('005930', '삼성전자');
    assert.equal(estimateQuoteCalls([samsung, { ...samsung, id: 'KR:KOSDAQ:005930', market: 'KOSDAQ' }]), 1);
  });

  it('묶을 수 없는 종목은 종목당 1회다', () => {
    const nightProxy = instrument('005930', '삼성전자 야간 환산가', {
      id: 'KR:NIGHT_PROXY:005930',
      market: 'NIGHT_PROXY',
      assetType: 'night_proxy',
    });
    assert.equal(estimateQuoteCalls([nightProxy]), 1);
    assert.equal(estimateQuoteCalls([...many(30), nightProxy]), 2);
  });
});

describe('planThemeQuotes — 예산', () => {
  const themeOf = (code: string, name: string, count: number, offset: number): ThemeMembers => ({
    theme: theme({ code, name, symbolCount: count, instrumentCount: count }),
    instruments: Array.from({ length: count }, (_, index) =>
      instrument(String(offset + index).padStart(6, '0'), `${name}${index}`),
    ),
    missingSymbols: [],
  });

  it('겹치는 종목은 한 번만 묻는다', () => {
    const a = themeOf('004', '반도체', 20, 1);
    const b = themeOf('011', '바이오', 20, 1); // 같은 종목 20개
    const plan = planThemeQuotes([a, b], 8);
    assert.equal(plan.measured.length, 2);
    assert.equal(plan.instruments.length, 20);
    assert.equal(estimateQuoteCalls(plan.instruments), 1);
  });

  /*
   * 여기서 예산을 넘긴 테마를 잘라서라도 재면 이 시험이 죽는다. 110종목 중
   * 30종목만 보고 낸 값을 "반도체 테마 등락률"이라 부를 수 없다.
   */
  it('예산을 넘기는 테마는 통째로 뺀다 — 반쪽으로 재지 않는다', () => {
    const big = themeOf('004', '반도체/반도체장비', 101, 1_000);
    const plan = planThemeQuotes([big], 3);
    assert.deepEqual(plan.measured, []);
    assert.equal(plan.instruments.length, 0);
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0].code, '004');
    assert.match(plan.skipped[0].reason, /상한 3회를 넘습니다 \(101종목\)/);
  });

  it('앞 테마가 예산을 넘겨도 뒤 테마는 잰다', () => {
    const big = themeOf('004', '반도체/반도체장비', 101, 1_000);
    const small = themeOf('012', '방위산업', 26, 5_000);
    const plan = planThemeQuotes([big, small], 3);
    assert.deepEqual(plan.measured.map((m) => m.theme.code), ['012']);
    assert.equal(plan.instruments.length, 26);
    assert.deepEqual(plan.skipped.map((s) => s.code), ['004']);
  });

  it('예산은 합집합으로 잰다 — 앞 테마가 쓴 만큼 뒤가 좁아진다', () => {
    const a = themeOf('a', '가', 30, 1_000);
    const b = themeOf('b', '나', 30, 2_000);
    const c = themeOf('c', '다', 30, 3_000);
    const plan = planThemeQuotes([a, b, c], 2);
    assert.deepEqual(plan.measured.map((m) => m.theme.code), ['a', 'b']);
    assert.deepEqual(plan.skipped.map((s) => s.code), ['c']);
    assert.equal(estimateQuoteCalls(plan.instruments), 2);
  });

  it('종목이 없는 테마는 호출을 쓰지 않아 언제나 통과한다', () => {
    const empty: ThemeMembers = {
      theme: theme({ code: '260', name: '2차전지', symbolCount: 1, instrumentCount: 0 }),
      instruments: [],
      missingSymbols: ['900110'],
    };
    const plan = planThemeQuotes([empty], 1);
    assert.deepEqual(plan.measured.map((m) => m.theme.code), ['260']);
    assert.equal(plan.instruments.length, 0);
    assert.deepEqual(plan.skipped, []);
  });
});
