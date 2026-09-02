/**
 * 수급 저장소의 **계약**을 못 박는다.
 *
 * 가장 중요한 것은 **값이 없는 날을 0으로 적지 않는 것**이다. 수급은 2005년
 * 10월 말부터 있는데, 그 전을 물어도 KIS는 오류가 아니라 **날짜와 종가는 맞고
 * 순매수 3열만 0인 응답**을 준다. 그대로 저장하면 "그날 아무도 순매수하지
 * 않았다"는 사실이 지어지고, 그 위에 쌓는 측정이 전부 거짓이 된다.
 *
 * 두 번째는 증분 갱신의 대조다. 일봉과 같은 이유로 수정주가 기준이 섞이면
 * 값으로는 알아볼 수 없다 — 여기서는 **종가**가 그 잣대다.
 *
 * 여기 시험은 전부 순수 계산이라 네트워크도 DB도 없이 돈다. 실제 표 동작은
 * 아래쪽에서 DB가 있을 때만 돈다 — `dailyBars.test.ts`와 같은 방식이다.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { pool } from './client.js';
import {
  appendSymbolFlow,
  compareInvestorFlow,
  ensureInvestorFlowSchema,
  getInvestorFlow,
  getInvestorFlowCursors,
  isEmptyFlowDay,
  needsFullFlowRefetch,
  recordInvestorFlowFailure,
  replaceSymbolFlow,
  saveInvestorFlowCursor,
  type InvestorFlowDayRow,
} from './investorFlow.js';

function day(
  tradingDay: string,
  close: number,
  overrides: Partial<InvestorFlowDayRow> = {},
): InvestorFlowDayRow {
  return {
    tradingDay,
    close,
    individual: -1_000,
    foreign: 700,
    institution: 300,
    ...overrides,
  };
}

describe('값이 없는 날 — 0으로 적지 않는다', () => {
  it('셋이 모두 0이면 값이 없는 날이다', () => {
    assert.equal(
      isEmptyFlowDay(day('20050801', 9_780, { individual: 0, foreign: 0, institution: 0 })),
      true,
    );
  });

  it('한 주체만 0인 날은 정상이다 — 그날 그 주체가 안 샀을 뿐이다', () => {
    assert.equal(isEmptyFlowDay(day('20260828', 270_000, { foreign: 0 })), false);
    assert.equal(
      isEmptyFlowDay(day('20260828', 270_000, { individual: 0, institution: 0 })),
      false,
      '외국인만 값이 있어도 그 하루는 사실이다',
    );
  });

  it('★ 종가가 0이면 값이 없는 날이다 — 상장 전에는 종가도 0으로 온다', () => {
    // 2026-09-02 실측: 408470의 상장(2026-03-25) 이전 71일이 전부 이 모양이었다.
    assert.equal(isEmptyFlowDay(day('20260227', 0, { individual: 0, foreign: 0, institution: 0 })), true);
    // 순매수가 있어도 종가가 0이면 안 넣는다 — 금액으로 바꿀 때 통째로 0원이 된다.
    assert.equal(isEmptyFlowDay(day('20260227', 0, { foreign: 5_000 })), true);
  });

  it('순매수가 음수여도 값이 있는 날이다', () => {
    assert.equal(
      isEmptyFlowDay(day('20260828', 270_000, { individual: -5_000, foreign: 5_000, institution: 0 })),
      false,
    );
  });
});

describe('증분 갱신 — 겹치는 구간을 종가로 대조한다', () => {
  it('종가가 같으면 새 거래일만 붙인다', () => {
    const stored = [day('20260826', 100), day('20260827', 101)];
    const fetched = [day('20260826', 100), day('20260827', 101), day('20260828', 102)];

    const comparison = compareInvestorFlow(stored, fetched);

    assert.equal(comparison.overlapDays, 2);
    assert.deepEqual(comparison.mismatches, []);
    assert.deepEqual(comparison.newDays.map((row) => row.tradingDay), ['20260828']);
    assert.equal(needsFullFlowRefetch(comparison), false);
  });

  it('종가가 어긋나면 전체를 다시 받는다 — 수정주가 기준이 바뀐 것이다', () => {
    const stored = [day('20260826', 2_500_000), day('20260827', 2_550_000)];
    const fetched = [day('20260826', 50_000), day('20260827', 51_000)];

    const comparison = compareInvestorFlow(stored, fetched);

    assert.equal(comparison.mismatches.length, 2);
    assert.equal(comparison.mismatches[0].storedClose, 2_500_000);
    assert.equal(comparison.mismatches[0].fetchedClose, 50_000);
    assert.equal(needsFullFlowRefetch(comparison), true);
  });

  it('순매수만 달라진 것으로는 다시 받지 않는다 — 그것이 무엇을 뜻하는지 모른다', () => {
    const stored = [day('20260826', 100, { foreign: 700 })];
    const fetched = [day('20260826', 100, { foreign: 70 })];

    const comparison = compareInvestorFlow(stored, fetched);

    assert.deepEqual(comparison.mismatches, [], '대조는 종가로만 한다');
    assert.equal(needsFullFlowRefetch(comparison), false);
  });

  it('겹치는 날이 없으면 대조를 못 한 것이다 — 붙이지 않고 다시 받는다', () => {
    const stored = [day('20260701', 100)];
    const fetched = [day('20260827', 101), day('20260828', 102)];

    const comparison = compareInvestorFlow(stored, fetched);

    assert.equal(comparison.overlapDays, 0);
    assert.equal(needsFullFlowRefetch(comparison), true, '모르는 것을 맞다고 치지 않는다');
  });

  it('저장분 사이에 구멍이 있으면 다시 받는다', () => {
    const stored = [day('20260826', 100), day('20260828', 102)];
    const fetched = [day('20260826', 100), day('20260827', 101), day('20260828', 102)];

    const comparison = compareInvestorFlow(stored, fetched);

    assert.deepEqual(comparison.missingDays, ['20260827']);
    assert.equal(needsFullFlowRefetch(comparison), true);
  });

  it('저장분이 비어 있으면 전부 새것이고 대조는 못 한 것이다', () => {
    const comparison = compareInvestorFlow([], [day('20260828', 102)]);

    assert.equal(comparison.overlapDays, 0);
    assert.deepEqual(comparison.newDays.map((row) => row.tradingDay), ['20260828']);
  });
});

/*
 * 아래는 실제 표를 건드린다. DATABASE_URL이 없거나 붙지 못하면 건너뛴다 —
 * 이 시험 하나 때문에 전체가 실패하면 안 된다.
 */
const TEST_SYMBOL = 'TEST_INVESTOR_FLOW';
let usable = false;

before(async () => {
  try {
    await ensureInvestorFlowSchema();
    await pool.query('DELETE FROM trading_investor_flow WHERE symbol = $1', [TEST_SYMBOL]);
    await pool.query('DELETE FROM trading_investor_flow_cursor WHERE symbol = $1', [TEST_SYMBOL]);
    usable = true;
  } catch {
    usable = false;
  }
});

after(async () => {
  if (usable) {
    await pool.query('DELETE FROM trading_investor_flow WHERE symbol = $1', [TEST_SYMBOL])
      .catch(() => undefined);
    await pool.query('DELETE FROM trading_investor_flow_cursor WHERE symbol = $1', [TEST_SYMBOL])
      .catch(() => undefined);
  }
  await pool.end().catch(() => undefined);
});

describe('저장소 (DB가 있을 때만)', () => {
  it('통째로 갈아 끼운다 — 옛 기준 줄이 남지 않는다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못했습니다');

    await replaceSymbolFlow(TEST_SYMBOL, [day('20260826', 2_500_000)], '20260901', 1);
    await replaceSymbolFlow(TEST_SYMBOL, [day('20260826', 50_000)], '20260902', 2);

    const rows = await getInvestorFlow(TEST_SYMBOL);
    assert.deepEqual(rows.map((row) => row.close), [50_000]);
  });

  it('순매수 음수가 그대로 돌아온다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못했습니다');

    await replaceSymbolFlow(
      TEST_SYMBOL,
      [day('20260826', 270_000, { individual: -3_654_326, foreign: 1_943_936, institution: 1_823_763 })],
      '20260902',
      3,
    );

    const [row] = await getInvestorFlow(TEST_SYMBOL);
    assert.equal(row.individual, -3_654_326, 'BIGINT 칸이 부호를 잃지 않는다');
    assert.equal(row.foreign, 1_943_936);
    assert.equal(row.institution, 1_823_763);
  });

  it('새 거래일만 덧붙이고 이미 있는 날은 건드리지 않는다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못했습니다');

    await replaceSymbolFlow(TEST_SYMBOL, [day('20260826', 100)], '20260901', 4);
    await appendSymbolFlow(TEST_SYMBOL, [day('20260826', 999), day('20260827', 101)], '20260902', 5);

    const rows = await getInvestorFlow(TEST_SYMBOL);
    assert.deepEqual(rows.map((row) => row.close), [100, 101], '이미 있는 날은 그대로다');
  });

  it('커서의 oldestDay가 그 종목 수급의 시작점이다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못했습니다');

    await saveInvestorFlowCursor({
      symbol: TEST_SYMBOL,
      oldestDay: '20051024',
      newestDay: '20260828',
      dayCount: 5_100,
      done: true,
      lastError: null,
      lastAttemptAt: 12_345,
    });

    const cursor = (await getInvestorFlowCursors()).get(TEST_SYMBOL);
    assert.equal(cursor?.oldestDay, '20051024');
    assert.equal(cursor?.dayCount, 5_100);
    assert.equal(cursor?.done, true);
  });

  it('실패를 적어도 done을 되돌리지 않는다 — 끝난 종목을 다시 받게 하면 안 된다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못했습니다');

    await saveInvestorFlowCursor({
      symbol: TEST_SYMBOL,
      oldestDay: '20051024',
      newestDay: '20260828',
      dayCount: 5_100,
      done: true,
      lastError: null,
      lastAttemptAt: 1,
    });
    await recordInvestorFlowFailure(TEST_SYMBOL, '소켓이 끊겼습니다', 2);

    const cursor = (await getInvestorFlowCursors()).get(TEST_SYMBOL);
    assert.equal(cursor?.done, true, 'done은 그대로다');
    assert.equal(cursor?.lastError, '소켓이 끊겼습니다');
  });
});
