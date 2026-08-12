/**
 * 패널 검증 — **자리 계산이 전부다.**
 *
 * 종목마다 거래일이 다르다(상장·거래정지·폐지). 한 자리만 밀려도 다른 날 값을
 * 읽는데, 값은 그럴듯해서 형식 검사로는 안 걸린다. `multiQuote.ts`가 자리를
 * 검산하는 것과 같은 이유로 여기 시험이 있다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildPanel,
  buildScoreMatrix,
  buildUniverseMask,
  localAt,
  priceLimitFor,
  quickSelect,
  scanAdjustmentBreaks,
  symbolHistory,
  type PanelBar,
} from './panel.js';
import type { SignalCandidate } from './signals.js';

function bar(day: string, close: number, extra: Partial<PanelBar> = {}): PanelBar {
  return {
    tradingDay: day,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
    turnover: close * 1_000,
    ...extra,
  };
}

/** 계산만 재려고 만든 신호. 내용에 뜻이 없다. */
function scoreOf(pick: (close: number) => number | undefined): SignalCandidate {
  return {
    key: 'fixed',
    label: '고정 점수',
    rationale: '자리 계산을 재려고 만든 것이다. 실제 후보가 아니며 값에 뜻이 없다.',
    dataRequirement: 'price',
    frozenAt: '2026-08-12',
    minHistory: 0,
    score: (ctx) => pick(ctx.history[ctx.index].close),
  };
}

describe('buildPanel — 종목마다 날짜가 다를 때', () => {
  const barsBySymbol = new Map<string, PanelBar[]>([
    // A는 1·2·3일, B는 2일만, C는 1·3일. 합집합이 셋이고 빈 자리가 셋이다.
    ['A', [bar('20260101', 100), bar('20260102', 110), bar('20260103', 120)]],
    ['B', [bar('20260102', 200)]],
    ['C', [bar('20260101', 300), bar('20260103', 320)]],
  ]);
  const panel = buildPanel(barsBySymbol);

  it('날짜는 합집합이고 오름차순이다', () => {
    assert.deepEqual(panel.days, ['20260101', '20260102', '20260103']);
  });

  it('종목은 오름차순이다 — 실행마다 순서가 바뀌면 결과가 재현되지 않는다', () => {
    assert.deepEqual(panel.symbols, ['A', 'B', 'C']);
  });

  it('localIndex가 그 종목 안 자리를 가리킨다', () => {
    // A: 세 날 모두 0·1·2
    assert.equal(localAt(panel, 0, 0), 0);
    assert.equal(localAt(panel, 1, 0), 1);
    assert.equal(localAt(panel, 2, 0), 2);
    // B: 둘째 날만 있고 그 자리는 0이다
    assert.equal(localAt(panel, 1, 1), 0);
    // C: 첫날 0, 셋째 날 1 — **둘째 날을 건너뛰었으므로 1이지 2가 아니다**
    assert.equal(localAt(panel, 0, 2), 0);
    assert.equal(localAt(panel, 2, 2), 1);
  });

  it('봉이 없는 날은 −1이다 — 0으로 두면 조용히 첫 봉을 읽는다', () => {
    assert.equal(localAt(panel, 0, 1), -1);
    assert.equal(localAt(panel, 2, 1), -1);
    assert.equal(localAt(panel, 1, 2), -1);
  });

  it('값이 자리와 함께 간다', () => {
    assert.equal(panel.close[2][localAt(panel, 2, 2)], 320);
    assert.equal(panel.barCount[2], 2);
  });
});

describe('buildPanel — 없는 값을 0으로 채우지 않는다', () => {
  it('volume·turnover가 null이면 NaN이다', () => {
    const panel = buildPanel(
      new Map([['A', [bar('20260101', 100, { volume: null, turnover: null })]]]),
    );
    assert.ok(Number.isNaN(panel.volume[0][0]), String(panel.volume[0][0]));
    assert.ok(Number.isNaN(panel.turnover[0][0]), String(panel.turnover[0][0]));
    // 0이면 "그날 한 주도 안 거래됐다"가 지어진다. 그 거짓을 여기서 막는다.
    assert.notEqual(panel.volume[0][0], 0);
  });

  it('open·high·low가 없으면 NaN이다', () => {
    const panel = buildPanel(
      new Map([['A', [{ tradingDay: '20260101', close: 100 }]]]),
    );
    assert.ok(Number.isNaN(panel.open[0][0]));
  });
});

describe('symbolHistory — 수급은 NaN이다', () => {
  it('일봉 저장소에 없는 값을 0으로 만들지 않는다', () => {
    const panel = buildPanel(new Map([['A', [bar('20260101', 100)]]]));
    const history = symbolHistory(panel, 0);
    assert.equal(history[0].tradingDay, '20260101');
    assert.equal(history[0].close, 100);
    assert.ok(Number.isNaN(history[0].foreign));
    assert.ok(Number.isNaN(history[0].individual));
    assert.ok(Number.isNaN(history[0].institution));
  });
});

describe('buildScoreMatrix', () => {
  it('점수가 (날짜, 종목) 자리에 들어간다', () => {
    const panel = buildPanel(
      new Map([
        ['A', [bar('20260101', 100), bar('20260102', 110)]],
        ['B', [bar('20260102', 200)]],
      ]),
    );
    const scores = buildScoreMatrix(panel, scoreOf((close) => close));
    const symbolCount = panel.symbols.length;
    assert.equal(scores[0 * symbolCount + 0], 100);
    assert.equal(scores[1 * symbolCount + 0], 110);
    assert.equal(scores[1 * symbolCount + 1], 200);
    // B는 첫날 봉이 없다. 0이 아니라 NaN이어야 한다.
    assert.ok(Number.isNaN(scores[0 * symbolCount + 1]));
  });

  it('undefined·무한대는 자리를 비워 둔다', () => {
    const panel = buildPanel(new Map([['A', [bar('20260101', 100)]]]));
    const scores = buildScoreMatrix(panel, scoreOf(() => undefined));
    assert.ok(Number.isNaN(scores[0]));
  });
});

describe('수정주가 파탄 — 그 봉 이전을 통째로 버린다', () => {
  it('가격제한폭은 시기마다 다르다', () => {
    assert.equal(priceLimitFor('20081231'), 0.155);
    assert.equal(priceLimitFor('20200101'), 0.31);
  });

  it('파탄 앞 구간을 버리고 몇 봉인지 센다', () => {
    // 2008년: +156%는 그날 한계(±15%)로 불가능하다. 실제 005070 2008-01-22이 그랬다.
    const panel = buildPanel(
      new Map([
        [
          'A',
          [
            bar('20080118', 1_100),
            bar('20080121', 1_124),
            bar('20080122', 2_881),
            bar('20080123', 2_900),
          ],
        ],
      ]),
    );
    const scan = scanAdjustmentBreaks(panel);
    assert.equal(scan.breaks.length, 1);
    assert.equal(scan.breaks[0].tradingDay, '20080122');
    // 파탄 봉부터 쓴다 — 봉 하나만 빼면 앞뒤가 다른 자로 잰 값이 이어 붙는다.
    assert.equal(scan.firstUsableLocal[0], 2);
    assert.equal(scan.droppedBars, 2);
    assert.equal(scan.brokenSymbols, 1);
  });

  it('파탄이 없으면 첫 자리부터 쓴다', () => {
    const panel = buildPanel(
      new Map([['A', [bar('20200102', 1_000), bar('20200103', 1_050)]]]),
    );
    const scan = scanAdjustmentBreaks(panel);
    assert.equal(scan.breaks.length, 0);
    assert.equal(scan.firstUsableLocal[0], 0);
    assert.equal(scan.droppedBars, 0);
  });
});

describe('quickSelect', () => {
  it('k번째로 작은 값을 고른다', () => {
    const values = Float64Array.from([5, 1, 9, 3, 7]);
    assert.equal(quickSelect(values.slice(), 5, 0), 1);
    assert.equal(quickSelect(values.slice(), 5, 2), 5);
    assert.equal(quickSelect(values.slice(), 5, 4), 9);
  });
});

describe('buildUniverseMask', () => {
  /** 종목 `count`개 × 날짜 `days`개. 거래대금만 종목마다 다르게 준다. */
  function grid(count: number, days: number): Map<string, PanelBar[]> {
    const map = new Map<string, PanelBar[]>();
    for (let s = 0; s < count; s += 1) {
      const bars: PanelBar[] = [];
      for (let d = 0; d < days; d += 1) {
        bars.push({
          tradingDay: String(20200101 + d),
          open: 1_000 + s,
          high: 1_000 + s,
          low: 1_000 + s,
          close: 1_000 + s + d,
          volume: 1_000,
          turnover: 200_000_000 + s * 10_000_000,
        });
      }
      map.set(`S${String(s).padStart(3, '0')}`, bars);
    }
    return map;
  }

  const spec = {
    minBars: 3,
    activityWindow: 3,
    minActiveDays: 3,
    turnoverWindow: 3,
    minTurnover: 100_000_000,
    turnoverBottomFraction: 0.2,
    minNamesPerDay: 8,
    scoreGateSignals: [scoreOf((close) => close)],
  };

  it('그날 종목이 모자라면 날짜를 통째로 버린다', () => {
    const panel = buildPanel(grid(5, 10));
    const mask = buildUniverseMask(panel, {
      ...spec,
      eligibleSymbols: new Set(panel.symbols),
    });
    assert.equal(mask.usableDays, 0);
    assert.ok(mask.thinDays > 0);
  });

  it('거래대금 하위 몫을 뺀다', () => {
    const panel = buildPanel(grid(10, 10));
    const mask = buildUniverseMask(panel, {
      ...spec,
      eligibleSymbols: new Set(panel.symbols),
    });
    assert.ok(mask.usableDays > 0, '쓸 수 있는 날짜가 없다');
    // 10종목 중 하위 20%(2종목)가 빠져 8종목이 남는다.
    assert.equal(mask.namesMin, 8);
    const day = panel.days.length - 1;
    const symbolCount = panel.symbols.length;
    assert.equal(mask.mask[day * symbolCount + 0], 0, '거래대금 최하위가 남았다');
    assert.equal(mask.mask[day * symbolCount + 9], 1, '거래대금 최상위가 빠졌다');
  });

  it('자격 밖 종목은 아예 안 본다', () => {
    const panel = buildPanel(grid(10, 10));
    const eligible = new Set(panel.symbols.slice(0, 9));
    const mask = buildUniverseMask(panel, { ...spec, eligibleSymbols: eligible });
    assert.equal(mask.ineligibleSymbols, 1);
    const symbolCount = panel.symbols.length;
    for (let d = 0; d < panel.days.length; d += 1) {
      assert.equal(mask.mask[d * symbolCount + 9], 0);
    }
  });

  it('점수를 못 내는 종목은 공통 게이트에서 빠진다', () => {
    const panel = buildPanel(grid(10, 10));
    const dropFirst = scoreOf((close) => (close >= 1_000 && close < 1_003 ? undefined : close));
    const mask = buildUniverseMask(panel, {
      ...spec,
      minNamesPerDay: 1,
      scoreGateSignals: [scoreOf((c) => c), dropFirst],
      eligibleSymbols: new Set(panel.symbols),
    });
    const symbolCount = panel.symbols.length;
    // S000은 초반 며칠 점수가 안 나온다 → 그 자리들이 빠져야 한다.
    assert.equal(mask.mask[2 * symbolCount + 0], 0);
  });
});
