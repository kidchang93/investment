/**
 * 일봉 저장소의 **계약**을 못 박는다.
 *
 * 가장 중요한 것은 증분 갱신의 대조다. KIS 수정주가는 **요청 시점 기준**이라,
 * 액면분할이 나면 이미 저장한 21년치와 앞으로 붙일 줄이 다른 기준이 된다.
 * 그런데 섞였다는 사실은 **값으로는 알아볼 수 없다** — 그래프는 매끄럽고
 * 수익률만 조용히 틀린다. 그래서 "언제 전체를 다시 받아야 하는가"를 값으로 잰다.
 *
 * 여기 시험은 전부 순수 계산이라 네트워크도 DB도 없이 돈다. 실제 표 동작
 * (지우고 넣기·이어 붙이기·커서)은 아래쪽에서 DB가 있을 때만 돈다 —
 * `brokerOrders.test.ts`와 같은 방식이다.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { pool } from './client.js';
import {
  appendSymbolBars,
  compareDailyBars,
  ensureDailyBarSchema,
  getDailyBarCursors,
  getDailyBars,
  getSymbolVintages,
  needsFullRefetch,
  recordDailyBarFailure,
  replaceSymbolBars,
  saveDailyBarCursor,
  type DailyBar,
} from './dailyBars.js';

function bar(tradingDay: string, close: number, overrides: Partial<DailyBar> = {}): DailyBar {
  return {
    tradingDay,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
    turnover: close * 1_000,
    ...overrides,
  };
}

describe('증분 갱신 — 겹치는 구간을 대조한다', () => {
  it('값이 같으면 새 거래일만 붙인다', () => {
    const stored = [bar('20260806', 100), bar('20260807', 101)];
    const fetched = [bar('20260806', 100), bar('20260807', 101), bar('20260810', 102)];

    const comparison = compareDailyBars(stored, fetched);

    assert.equal(comparison.overlapDays, 2);
    assert.deepEqual(comparison.mismatches, []);
    assert.deepEqual(comparison.newBars.map((row) => row.tradingDay), ['20260810']);
    assert.equal(needsFullRefetch(comparison), false);
  });

  it('액면분할로 값이 바뀌면 전체를 다시 받는다', () => {
    /*
     * 005930은 2018-05-04에 50:1로 분할했다. 분할 전에 받아 둔 줄은 분할 뒤에
     * 다시 받으면 전부 1/50이 된다. **한 칸만 어긋나도 그 종목은 통째로 다시
     * 받아야 한다** — 어느 줄이 옛 기준인지 값으로 가릴 방법이 없다.
     */
    const stored = [bar('20260806', 2_500_000), bar('20260807', 2_550_000)];
    const fetched = [bar('20260806', 50_000), bar('20260807', 51_000)];

    const comparison = compareDailyBars(stored, fetched);

    assert.equal(comparison.overlapDays, 2);
    assert.ok(comparison.mismatches.length > 0);
    assert.equal(needsFullRefetch(comparison), true);
  });

  it('시가만 달라도 잡는다 — 종가만 보지 않는다', () => {
    const stored = [bar('20260807', 100, { open: 98 })];
    const fetched = [bar('20260807', 100, { open: 99 })];

    const comparison = compareDailyBars(stored, fetched);

    assert.deepEqual(comparison.mismatches, [
      { tradingDay: '20260807', field: 'open', stored: 98, fetched: 99 },
    ]);
    assert.equal(needsFullRefetch(comparison), true);
  });

  it('겹치는 날이 하나도 없으면 대조를 못 한 것이다 — 붙이지 않는다', () => {
    /*
     * 오래 안 돌리면 창(130일)이 저장분 뒤에서 시작한다. 그 사이에 분할이
     * 났는지 **알 수 없으므로** 맞다고 치지 않는다. 모르는 것을 통과시키면
     * 기준이 섞인 21년치가 남고, 그건 되돌릴 수 없다.
     */
    const stored = [bar('20250101', 100)];
    const fetched = [bar('20260806', 100), bar('20260807', 101)];

    const comparison = compareDailyBars(stored, fetched);

    assert.equal(comparison.overlapDays, 0);
    assert.equal(needsFullRefetch(comparison), true);
  });

  it('저장분 사이에 구멍이 있으면 붙이지 않는다', () => {
    const stored = [bar('20260806', 100), bar('20260810', 102)];
    const fetched = [bar('20260806', 100), bar('20260807', 101), bar('20260810', 102)];

    const comparison = compareDailyBars(stored, fetched);

    assert.deepEqual(comparison.missingDays, ['20260807']);
    assert.equal(needsFullRefetch(comparison), true);
  });

  it('저장분이 비어 있으면 새것으로 채우지 않고 전체를 받는다', () => {
    const comparison = compareDailyBars([], [bar('20260807', 101)]);
    assert.equal(comparison.overlapDays, 0);
    assert.equal(needsFullRefetch(comparison), true);
  });

  /*
   * 거래량은 대조하지 않는다 — 분할 시 거래량도 조정되는지 아직 안 재 봤고,
   * 확인 안 한 것으로 종목 전체를 다시 받게 하면 밤샘 수집만 늘어난다.
   * 값(가격)이 바뀌면 어차피 잡히므로 이 선택이 기준 혼입을 놓치지는 않는다.
   */
  it('거래량 차이만으로는 다시 받지 않는다', () => {
    const stored = [bar('20260807', 100, { volume: 1_000 })];
    const fetched = [bar('20260807', 100, { volume: 50_000 })];

    const comparison = compareDailyBars(stored, fetched);

    assert.deepEqual(comparison.mismatches, []);
    assert.equal(needsFullRefetch(comparison), false);
  });
});

/*
 * 아래는 실제 표를 건드린다. DATABASE_URL이 없거나 붙지 못하면 건너뛴다 —
 * 이 시험 하나 때문에 전체가 실패하면 안 된다.
 */
const TEST_SYMBOL = 'TEST_DAILY_BARS';
let usable = false;

before(async () => {
  try {
    await ensureDailyBarSchema();
    await pool.query('DELETE FROM trading_daily_bars WHERE symbol = $1', [TEST_SYMBOL]);
    await pool.query('DELETE FROM trading_daily_bar_cursor WHERE symbol = $1', [TEST_SYMBOL]);
    usable = true;
  } catch {
    usable = false;
  }
});

after(async () => {
  if (usable) {
    await pool.query('DELETE FROM trading_daily_bars WHERE symbol = $1', [TEST_SYMBOL]).catch(() => undefined);
    await pool.query('DELETE FROM trading_daily_bar_cursor WHERE symbol = $1', [TEST_SYMBOL]).catch(() => undefined);
  }
  await pool.end().catch(() => undefined);
});

describe('저장소 (DB가 있을 때만)', () => {
  it('통째로 갈아 끼운다 — 옛 기준 줄이 남지 않는다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못했습니다');

    await replaceSymbolBars(TEST_SYMBOL, [bar('20260806', 2_500_000), bar('20260807', 2_550_000)], '20260810', 1);
    await replaceSymbolBars(TEST_SYMBOL, [bar('20260806', 50_000), bar('20260807', 51_000)], '20260811', 2);

    const rows = await getDailyBars(TEST_SYMBOL);
    assert.deepEqual(rows.map((row) => row.close), [50_000, 51_000]);
    // 지우고 넣으므로 기준일이 하나뿐이다. 둘이면 섞인 것이다.
    assert.deepEqual(await getSymbolVintages(TEST_SYMBOL), ['20260811']);
  });

  it('안 온 값을 0으로 채우지 않는다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못했습니다');

    await replaceSymbolBars(
      TEST_SYMBOL,
      [bar('20260806', 100, { volume: null, turnover: null })],
      '20260811',
      3,
    );

    const [row] = await getDailyBars(TEST_SYMBOL);
    assert.equal(row.volume, null);
    assert.equal(row.turnover, null);
  });

  it('새 거래일만 덧붙이고 이미 있는 날은 건드리지 않는다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못했습니다');

    await replaceSymbolBars(TEST_SYMBOL, [bar('20260806', 100)], '20260810', 4);
    await appendSymbolBars(TEST_SYMBOL, [bar('20260806', 999), bar('20260807', 101)], '20260811', 5);

    const rows = await getDailyBars(TEST_SYMBOL);
    assert.deepEqual(rows.map((row) => row.close), [100, 101], '이미 있는 날은 그대로다');
  });

  it('거래대금은 조 단위여도 그대로 돌아온다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못했습니다');

    // 005930의 2026-08-11 실측값. BIGINT 칸이 정수를 잃지 않는지 본다.
    await replaceSymbolBars(
      TEST_SYMBOL,
      [bar('20260806', 239_000, { volume: 20_446_163, turnover: 4_851_846_094_250 })],
      '20260811',
      6,
    );

    const [row] = await getDailyBars(TEST_SYMBOL);
    assert.equal(row.turnover, 4_851_846_094_250);
    assert.equal(row.volume, 20_446_163);
  });

  it('실패는 done을 켜지 않는다 — 건너뛴 종목을 끝난 것으로 세면 영영 안 받는다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못했습니다');

    await saveDailyBarCursor({
      symbol: TEST_SYMBOL,
      oldestDay: '20260806',
      newestDay: '20260807',
      barCount: 2,
      done: true,
      lastError: null,
      lastAttemptAt: 7,
    });
    await recordDailyBarFailure(TEST_SYMBOL, '소켓이 끊겼습니다', 8);

    const cursor = (await getDailyBarCursors()).get(TEST_SYMBOL);
    assert.ok(cursor);
    assert.equal(cursor.lastError, '소켓이 끊겼습니다');
    assert.equal(cursor.lastAttemptAt, 8);
    /*
     * 이미 다 받아 둔 종목에 갱신이 실패한 것이라 `done`은 그대로 둔다.
     * 한 번도 못 받은 종목은 애초에 커서가 없거나 `done=false`라, 실패를
     * 적어도 다음 실행이 다시 시도한다.
     */
    assert.equal(cursor.done, true);
  });
});
