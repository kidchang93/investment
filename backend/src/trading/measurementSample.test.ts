/**
 * 표본을 어떻게 세는가를 못 박는다.
 *
 * 이 계산이 틀리면 **오류 없이 판정문만 좋아진다.** 실제로 그랬다 — 현금으로
 * 1주도 못 사는 종목이 0.00%로 섞여 중앙값을 끌어올렸고, 그 결과가 화면의
 * 전략 판정문으로 나갔다. 그래서 경계값(딱 살 수 있는 값·딱 모자란 봉 수)을
 * 시험으로 잡아 둔다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Candle } from '@invest/shared';

import {
  countExcluded,
  countMeasured,
  describeSampleTally,
  emptySampleTally,
  sampleExclusion,
  stratify,
} from './measurementSample.js';

/** 저가만 다르게 준다. 나머지는 살 수 있는지 판정에 쓰이지 않는다. */
function candlesWithLows(lows: number[]): Candle[] {
  return lows.map((low, index) => ({
    time: index,
    open: low + 10,
    high: low + 20,
    low,
    close: low + 5,
    volume: 1000,
  }));
}

describe('표본 제외 판정', () => {
  it('봉이 minBars + 1보다 적으면 뺀다 — 체결할 다음 봉이 있어야 신호 한 번이 성립한다', () => {
    const cheap = new Array(20).fill(100);
    assert.equal(sampleExclusion(candlesWithLows(cheap), 50_000, 20), 'tooFewBars');
    assert.equal(sampleExclusion(candlesWithLows([...cheap, 100]), 50_000, 20), null);
  });

  it('봉 부족이 가격보다 앞이다 — 잴 수 없는 조건이 먼저다', () => {
    assert.equal(sampleExclusion(candlesWithLows([900_000, 900_000]), 50_000, 20), 'tooFewBars');
  });

  it('구간 내내 1주 값이 현금보다 비싸면 뺀다', () => {
    const candles = candlesWithLows(new Array(30).fill(50_001));
    assert.equal(sampleExclusion(candles, 50_000, 5), 'unaffordable');
  });

  it('딱 현금만큼이면 살 수 있다 (경계는 포함)', () => {
    const candles = candlesWithLows(new Array(30).fill(50_000));
    assert.equal(sampleExclusion(candles, 50_000, 5), null);
  });

  it('한 봉이라도 현금 아래로 내려오면 표본이다', () => {
    const lows = new Array(30).fill(80_000);
    lows[17] = 49_999;
    assert.equal(sampleExclusion(candlesWithLows(lows), 50_000, 5), null);
  });

  it('쓸 수 있는 저가가 하나도 없으면 「비싸다」가 아니라 「값이 없다」다', () => {
    const candles = candlesWithLows(new Array(30).fill(0));
    assert.equal(sampleExclusion(candles, 50_000, 5), 'noUsablePrice');
    const nan = candlesWithLows(new Array(30).fill(Number.NaN));
    assert.equal(sampleExclusion(nan, 50_000, 5), 'noUsablePrice');
  });
});

describe('표본 집계', () => {
  it('뺀 것과 잰 것을 합치면 집어든 수가 된다', () => {
    const tally = emptySampleTally();
    countExcluded(tally, 'unaffordable');
    countExcluded(tally, 'tooFewBars');
    countMeasured(tally, { tradeCount: 3, openQuantity: 0 });
    countMeasured(tally, { tradeCount: 0, openQuantity: 0 });

    assert.equal(tally.considered, 4);
    assert.equal(tally.measured, 2);
    assert.equal(tally.tooFewBars + tally.unaffordable + tally.noUsablePrice, 2);
  });

  it('매매 0건과 미청산은 빼지 않고 센다', () => {
    const tally = emptySampleTally();
    countMeasured(tally, { tradeCount: 0, openQuantity: 0 });
    countMeasured(tally, { tradeCount: 5, openQuantity: 2 });

    assert.equal(tally.measured, 2, '둘 다 성적에 들어간다');
    assert.equal(tally.noTrade, 1);
    assert.equal(tally.openEnded, 1);
  });

  it('0인 사유도 적는다 — 「없었다」와 「안 봤다」를 가른다', () => {
    const tally = emptySampleTally();
    countMeasured(tally, { tradeCount: 0, openQuantity: 1 });
    countExcluded(tally, 'unaffordable');

    assert.equal(
      describeSampleTally(tally, '종목·구간'),
      '표본 2종목·구간 중 1개를 쟀다 (뺌: 봉 부족 0 · 현금으로 1주도 못 삼 1 · 쓸 수 있는 값이 없음 0)'
      + ' · 쟀지만 매매 0건 1개 · 미청산으로 끝남 1개',
    );
  });
});

describe('층 나누기', () => {
  it('개수가 같게 갈린다', () => {
    assert.deepEqual(stratify([1, 2, 3, 4, 5, 6], 3), [[1, 2], [3, 4], [5, 6]]);
  });

  it('나머지는 앞 층부터 하나씩 — 마지막 층만 커지지 않는다', () => {
    assert.deepEqual(stratify([1, 2, 3, 4, 5, 6, 7], 3), [[1, 2, 3], [4, 5], [6, 7]]);
  });

  it('층이 목록보다 많으면 빈 층을 만들지 않는다', () => {
    assert.deepEqual(stratify([1, 2], 5), [[1], [2]]);
  });

  it('빈 목록이나 층 0이면 빈 결과', () => {
    assert.deepEqual(stratify([], 5), []);
    assert.deepEqual(stratify([1, 2, 3], 0), []);
  });

  it('층을 이어 붙이면 원래 목록이다 — 잃거나 겹치지 않는다', () => {
    const items = Array.from({ length: 389 }, (_, index) => index);
    assert.deepEqual(stratify(items, 5).flat(), items);
  });
});
