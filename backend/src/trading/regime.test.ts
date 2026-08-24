/**
 * 국면 분류 검증.
 *
 * ★ **가장 중요한 것은 "미래를 안 보는가"다.** 국면으로 표본을 가르는데 그 판정이
 * 미래를 보면, 갈라서 잰 모든 값이 거짓이 되고 그 거짓은 **좋아 보이는 쪽으로**
 * 나온다 — 나중에 오를 구간을 "추세장"이라고 부르게 되기 때문이다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPanel, type Panel, type PanelBar, type UniverseMask } from './panel.js';
import {
  buildMarketReturns,
  buildRegimeSeries,
  efficiencyRatio,
  regimeMaskOf,
} from './regime.js';

/** 종목 하나짜리 패널. 그 종목의 수익률이 곧 시장이 된다. */
function onePanel(closes: number[]): Panel {
  const bars: PanelBar[] = closes.map((close, i) => ({
    tradingDay: `2026${String(1000 + i).padStart(4, '0')}`,
    close,
  }));
  return buildPanel(new Map([['000001', bars]]));
}

/** 모든 날에 그 한 종목이 들어 있는 마스크. `dayOffsets`·`dayMembers`만 쓴다. */
function fullMask(panel: Panel): UniverseMask {
  const dayCount = panel.days.length;
  return {
    mask: new Uint8Array(dayCount).fill(1),
    dayOffsets: Int32Array.from({ length: dayCount + 1 }, (_, i) => i),
    dayMembers: Int32Array.from({ length: dayCount }, () => 0),
    usableDays: dayCount,
    thinDays: 0,
    ineligibleSymbols: 0,
    adjustment: { breaks: [], droppedBars: 0, affectedSymbols: 0, exemptBreaks: 0, exemptSymbols: 0 },
    namesMedian: 1,
    namesMin: 1,
  } as unknown as UniverseMask;
}

describe('효율성 비율', () => {
  it('한 방향으로만 가면 1이다', () => {
    // 매일 같은 폭으로 오르기만 하면 |합| = 절대값의 합이다.
    const returns = Float64Array.from({ length: 30 }, () => 0.01);
    const ratio = efficiencyRatio(returns, 29, 20);
    assert.ok(Math.abs((ratio as number) - 1) < 1e-12, String(ratio));
  });

  it('같은 폭으로 오르내리기를 반복하면 0에 가깝다', () => {
    // +1%, −1%가 짝수 번이면 합이 0이라 비도 0이다.
    const returns = Float64Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const ratio = efficiencyRatio(returns, 29, 20);
    assert.ok(Math.abs(ratio as number) < 1e-12, String(ratio));
  });

  it('구간에 못 잰 날이 하나라도 있으면 값을 내지 않는다', () => {
    const returns = Float64Array.from({ length: 30 }, () => 0.01);
    returns[15] = Number.NaN;
    // 빼고 계산하면 날 수가 다른 구간끼리 비교하게 된다. 0으로도 채우지 않는다.
    assert.equal(efficiencyRatio(returns, 29, 20), undefined);
  });

  it('앞자리가 모자라면 값을 내지 않는다', () => {
    const returns = Float64Array.from({ length: 30 }, () => 0.01);
    assert.equal(efficiencyRatio(returns, 18, 20), undefined);
  });
});

describe('시장 수익률', () => {
  it('첫날은 전일이 없어 값을 내지 않는다', () => {
    const panel = onePanel([100, 110, 121]);
    const returns = buildMarketReturns(panel, fullMask(panel));
    assert.ok(Number.isNaN(returns[0]));
    assert.ok(Math.abs(returns[1] - Math.log(1.1)) < 1e-12, String(returns[1]));
    assert.ok(Math.abs(returns[2] - Math.log(1.1)) < 1e-12, String(returns[2]));
  });
});

describe('국면 분류', () => {
  /** 300일. 앞 절반은 한 방향, 뒤 절반은 톱니. */
  function mixedCloses(): number[] {
    const closes = [100];
    for (let i = 1; i < 300; i += 1) {
      const previous = closes[i - 1];
      closes.push(i < 150 ? previous * 1.002 : previous * (i % 2 === 0 ? 1.01 : 1 / 1.01));
    }
    return closes;
  }

  it('★ 미래를 바꿔도 그 앞의 국면이 안 바뀐다', () => {
    const base = mixedCloses();
    const at = 280;
    const before = buildRegimeSeries(onePanel(base), fullMask(onePanel(base)));

    // `at` 뒤를 통째로 뒤집는다. 국면이 미래를 보면 여기서 앞자리가 흔들린다.
    const tampered = base.map((close, i) => (i <= at ? close : close * (i % 2 === 0 ? 1.5 : 0.6)));
    const after = buildRegimeSeries(onePanel(tampered), fullMask(onePanel(tampered)));

    for (let d = 0; d <= at; d += 1) {
      assert.equal(after.regimes[d], before.regimes[d], `${d}일차 국면이 미래에 따라 바뀐다`);
    }
  });

  it('문턱을 만들 표본이 모일 때까지는 판정하지 않는다', () => {
    const closes = mixedCloses();
    const panel = onePanel(closes);
    const series = buildRegimeSeries(panel, fullMask(panel));
    // 기본 minHistory가 250이라 300일 계열에서는 대부분이 unknown이다.
    assert.ok(series.unknownDays >= 250, `unknown ${series.unknownDays}일`);
    for (let d = 0; d < 250; d += 1) assert.equal(series.regimes[d], 'unknown', `${d}일차`);
  });

  it('추세 구간이 횡보 구간보다 비율이 높다', () => {
    const trending = Float64Array.from({ length: 30 }, () => 0.005);
    const chopping = Float64Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 0.02 : -0.02));
    const a = efficiencyRatio(trending, 29, 20) as number;
    const b = efficiencyRatio(chopping, 29, 20) as number;
    assert.ok(a > b, `${a} > ${b}`);
  });

  it('마스크는 고른 국면만 1이고 unknown은 어느 쪽에도 안 들어간다', () => {
    const closes = mixedCloses();
    const panel = onePanel(closes);
    const series = buildRegimeSeries(panel, fullMask(panel));
    const trend = regimeMaskOf(series, 'trend');
    const chop = regimeMaskOf(series, 'chop');
    for (let d = 0; d < series.regimes.length; d += 1) {
      // 같은 날이 양쪽에 들어가면 표본이 겹쳐 두 검정이 독립이 아니게 된다.
      assert.ok(!(trend[d] === 1 && chop[d] === 1), `${d}일차가 양쪽에 있다`);
      if (series.regimes[d] === 'unknown') {
        assert.equal(trend[d], 0, `${d}일차 unknown이 추세에 들어갔다`);
        assert.equal(chop[d], 0, `${d}일차 unknown이 횡보에 들어갔다`);
      }
    }
    let trendCount = 0;
    let chopCount = 0;
    for (let d = 0; d < series.regimes.length; d += 1) {
      trendCount += trend[d];
      chopCount += chop[d];
    }
    assert.equal(trendCount, series.trendDays);
    assert.equal(chopCount, series.chopDays);
  });
});
