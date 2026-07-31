/**
 * 변동폭 확장 계산 검증.
 *
 * 이 계산이 틀리면 측정 결과가 조용히 틀린 채로 문서에 남는다. 특히 t분 봉을
 * 앞뒤 어느 쪽에 넣느냐는 한 칸 차이로 "앞으로 벌어질 폭"을 부풀린다 —
 * 지나간 폭을 미래에 섞으면 어떤 잣대든 잘 맞는 것처럼 보인다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  fullDayRangeRate,
  normalizeMinuteBars,
  quantile,
  snapshotAt,
  spearman,
  spreadEvenly,
  type MinuteBar,
} from './rangeExpansion.js';

/** 09:00부터 1분 간격. 값은 시험마다 직접 적는다. */
function bars(rows: Array<[high: number, low: number, close: number]>, startMinute = 540): MinuteBar[] {
  return rows.map(([high, low, close], index) => ({ minute: startMinute + index, high, low, close }));
}

describe('분봉 정규화', () => {
  it('오름차순으로 세우고 겹친 분은 하나만 남긴다', () => {
    // 창을 여러 번 받아 이어 붙이면 경계가 겹친다. 겹친 채로 세면 봉 수가 부풀려진다.
    const merged = normalizeMinuteBars([
      { minute: 600, high: 110, low: 90, close: 100 },
      { minute: 540, high: 105, low: 95, close: 100 },
      { minute: 600, high: 110, low: 90, close: 100 },
    ]);
    assert.equal(merged.length, 2);
    assert.deepEqual(merged.map((bar) => bar.minute), [540, 600]);
  });

  it('값이 0이거나 음수인 봉은 버린다', () => {
    // KIS가 빈 문자열을 주는 자리가 0으로 읽히면 저가 0이 하루 저가가 된다.
    const merged = normalizeMinuteBars([
      { minute: 540, high: 0, low: 0, close: 0 },
      { minute: 541, high: 105, low: 95, close: 100 },
    ]);
    assert.deepEqual(merged.map((bar) => bar.minute), [541]);
  });
});

describe('시각별 앞뒤 변동폭', () => {
  /*
   * 09:00 100~100, 09:01 102~99, 09:02 105~101, 09:03 103~95
   * 누적 고가/저가: 09:00 100/100 · 09:01 102/99 · 09:02 105/99 · 09:03 105/95
   */
  const day = bars([
    [100, 100, 100],
    [102, 99, 101],
    [105, 101, 104],
    [103, 95, 96],
  ]);

  it('t분 봉은 t까지의 정보에 넣는다', () => {
    const at = snapshotAt(day, 541);
    assert.ok(at);
    assert.equal(at.barsSoFar, 2);
    assert.equal(at.price, 101, '09:01 종가');
    // (102 − 99) / 101
    assert.equal(at.rangeRate, 3 / 101);
  });

  it('앞으로 벌어질 폭에 t분 봉을 넣지 않는다', () => {
    const at = snapshotAt(day, 541);
    assert.ok(at);
    assert.equal(at.barsAhead, 2);
    // 09:02~09:03 고가 105 · 저가 95 → 10 ÷ 101. 09:01의 99를 섞으면 안 된다.
    assert.equal(at.aheadRangeRate, 10 / 101);
  });

  it('앞뒤 분모는 둘 다 그 시각의 값이다 — 종가로 나누면 미래를 훔친다', () => {
    const at = snapshotAt(day, 540);
    assert.ok(at);
    assert.equal(at.price, 100);
    assert.equal(at.rangeRate, 0, '개장 첫 봉이 한 값이면 누적 폭은 0이다');
    // 09:01~09:03 고가 105 · 저가 95 → 10 ÷ 100 (종가 96으로 나누면 0.1042가 된다)
    assert.equal(at.aheadRangeRate, 10 / 100);
  });

  it('마감 시각에는 앞으로 벌어질 폭이 0이다 — 모르는 것이 아니다', () => {
    const at = snapshotAt(day, 543);
    assert.ok(at);
    assert.equal(at.barsAhead, 0);
    assert.equal(at.aheadRangeRate, 0);
    assert.equal(at.rangeRate, 10 / 96);
  });

  it('그 시각 이전에 봉이 없으면 null이다 — 0으로 채우지 않는다', () => {
    // 09:00 이전은 값이 0인 것이 아니라 아직 없는 것이다.
    assert.equal(snapshotAt(day, 539), null);
    assert.equal(snapshotAt([], 600), null);
  });

  it('그리드 시각에 봉이 없어도 직전 봉으로 잰다', () => {
    // 거래가 뜸한 종목은 분봉이 비는 자리가 있다. 없는 시각을 물었다고
    // 못 잰 것으로 두면 유동성이 낮은 종목만 표본에서 빠진다.
    const sparse = bars([[100, 100, 100]]).concat({ minute: 600, high: 110, low: 90, close: 105 });
    const at = snapshotAt(sparse, 570);
    assert.ok(at);
    assert.equal(at.barsSoFar, 1);
    assert.equal(at.price, 100);
    assert.equal(at.aheadRangeRate, 20 / 100);
  });
});

describe('누적 거래대금 어림', () => {
  it('t까지의 봉만 쌓는다 — 뒤 봉을 섞으면 유동성이 미리 통과한다', () => {
    const day: MinuteBar[] = [
      { minute: 540, high: 100, low: 100, close: 100, volume: 10 },
      { minute: 541, high: 102, low: 99, close: 101, volume: 20 },
      { minute: 542, high: 105, low: 95, close: 96, volume: 30 },
    ];
    const at = snapshotAt(day, 541);
    assert.ok(at);
    assert.equal(at.turnoverSoFar, 100 * 10 + 101 * 20);
  });

  it('체결량이 없으면 undefined다 — 0으로 채우면 "거래 없음"이 지어진다', () => {
    const day: MinuteBar[] = [{ minute: 540, high: 100, low: 100, close: 100 }];
    const at = snapshotAt(day, 540);
    assert.ok(at);
    assert.equal(at.turnoverSoFar, undefined);
  });

  it('체결량 0은 아는 값이다 — undefined가 아니라 0이다', () => {
    const day: MinuteBar[] = [{ minute: 540, high: 100, low: 100, close: 100, volume: 0 }];
    const at = snapshotAt(day, 540);
    assert.ok(at);
    assert.equal(at.turnoverSoFar, 0);
  });
});

describe('하루 전체 변동폭', () => {
  it('마감 시점 스냅샷과 같은 값이다', () => {
    const day = bars([
      [100, 100, 100],
      [102, 99, 101],
      [105, 95, 96],
    ]);
    const closing = snapshotAt(day, 542);
    assert.ok(closing);
    assert.equal(fullDayRangeRate(day), closing.rangeRate);
    assert.equal(fullDayRangeRate(day), 10 / 96);
  });

  it('봉이 없으면 null이다', () => {
    assert.equal(fullDayRangeRate([]), null);
  });
});

describe('표본 고르게 흩뿌리기', () => {
  const days = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9'];

  it('양 끝을 넣고 사이를 고르게 고른다', () => {
    assert.deepEqual(spreadEvenly(days, 3), ['d1', 'd5', 'd9']);
    assert.deepEqual(spreadEvenly(days, 5), ['d1', 'd3', 'd5', 'd7', 'd9']);
  });

  it('하나만 고르면 가장 최근 것이다 — undefined가 아니다', () => {
    /*
     * `(len-1) × i / (n-1)`은 n이 1이면 0/0 = NaN이라 `items[NaN]`이
     * `undefined`가 됐다. 오류 없이 조회가 돌고 **표본만 0건**이 나온다.
     */
    assert.deepEqual(spreadEvenly(days, 1), ['d9']);
  });

  it('목록이 요청보다 짧으면 그대로 준다', () => {
    assert.deepEqual(spreadEvenly(['d1', 'd2'], 5), ['d1', 'd2']);
    assert.deepEqual(spreadEvenly([], 5), []);
  });

  it('0개를 요청하면 빈 목록이다', () => {
    assert.deepEqual(spreadEvenly(days, 0), []);
  });

  it('겹쳐 집힌 것은 하나만 남긴다', () => {
    // 짧은 목록에서 많이 고르면 같은 자리가 여러 번 집힌다.
    assert.deepEqual(spreadEvenly(['d1', 'd2', 'd3'], 3), ['d1', 'd2', 'd3']);
  });
});

describe('순위 상관', () => {
  it('같은 순서면 1, 뒤집히면 −1이다', () => {
    assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
    assert.equal(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
  });

  it('값이 아니라 순서를 본다 — 한 종목의 극단값에 끌려가지 않는다', () => {
    // 피어슨이면 마지막 점 하나가 계수를 좌우한다. 순위로 보면 여전히 1이다.
    assert.equal(spearman([1, 2, 3, 1_000_000], [1, 2, 3, 4]), 1);
  });

  it('같은 값은 평균 순위를 나눠 갖는다 — 배열 순서가 순위가 되면 안 된다', () => {
    // 셋이 같은 값이면 어느 쪽과도 상관이 없어야 한다.
    assert.ok(Number.isNaN(spearman([5, 5, 5], [1, 2, 3])));
  });

  it('표본이 모자라면 NaN이다 — 0(무관)이 아니다', () => {
    assert.ok(Number.isNaN(spearman([1], [1])));
    assert.ok(Number.isNaN(spearman([], [])));
  });

  it('한쪽이 NaN인 쌍은 뺀다', () => {
    assert.equal(spearman([1, 2, 3, NaN], [10, 20, 30, 40]), 1);
  });
});

describe('분위수', () => {
  it('중앙값', () => {
    assert.equal(quantile([3, 1, 2], 0.5), 2);
    assert.equal(quantile([4, 1, 2, 3], 0.5), 2.5);
  });

  it('양 끝', () => {
    assert.equal(quantile([1, 2, 3, 4], 0), 1);
    assert.equal(quantile([1, 2, 3, 4], 1), 4);
  });

  it('사분위는 선형 보간한다', () => {
    assert.equal(quantile([1, 2, 3, 4, 5], 0.25), 2);
    assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75);
  });

  it('빈 표본은 NaN이다 — 0으로 채우면 없는 값이 최솟값이 된다', () => {
    assert.ok(Number.isNaN(quantile([], 0.5)));
    assert.ok(Number.isNaN(quantile([NaN], 0.5)));
  });
});
