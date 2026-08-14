/**
 * 폐지 종목을 **무엇을 받고 무엇을 안 받나**, 그리고 **꼬리를 어디서 끊나**.
 *
 * 이 두 판단이 이 단위의 전부다. 둘 다 실측에서 나왔다(2026-08-13).
 *
 * - 폐지 목록에 있다고 계열을 끊으면 안 된다. 012210(삼미금속)은 2025-12-29 폐지로
 *   적혀 있는데 봉은 오늘까지 온다. 목록과 봉이 다른 말을 하는 것이다.
 * - 같은 코드가 두 번 상장된다. 013890(지누스)은 2005-05-18에 폐지됐는데 우리 봉은
 *   2019-10-30부터다. 과거 에피소드를 현재 계열에 붙이면 두 회사가 한 줄이 된다.
 * - 폐지일 언저리에는 **거래 없이 값만 바뀐 줄**이 붙는다. 005600은 마지막 줄이
 *   거래량 0에 +200%였다.
 *
 * 여기 시험은 전부 순수 계산이라 네트워크도 DB도 없이 돈다. 실제 표 동작은
 * 아래쪽에서 DB가 있을 때만 돈다 — `dailyBars.test.ts`와 같은 방식이다.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { Instrument } from '@invest/shared';

import { pool } from './client.js';
import type { DailyBar } from './dailyBars.js';
import {
  ensureDelistingSchema,
  getDelistings,
  isMarketTransfer,
  planDelistedCollection,
  summarizeDelistings,
  trimTrailingZeroVolumeBars,
  upsertDelistings,
  type DelistedCandidateRow,
} from './delistings.js';

function instrument(symbol: string, name = '시험종목'): Instrument {
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
    exchangeCode: 'J',
    timezone: 'Asia/Seoul',
  };
}

/**
 * 사유를 안 주면 **진짜 폐지**로 본다 — 옛 시험들이 기대하던 동작이다.
 * 시장 이동을 재는 시험만 사유를 직접 준다.
 */
function candidate(
  symbol: string,
  isActive: boolean,
  delistedDays: string[],
  reasons: string[] = [],
): DelistedCandidateRow {
  return {
    instrument: instrument(symbol),
    isActive,
    delistedEpisodes: delistedDays.map((day, i) => ({
      day,
      reason: reasons[i] ?? '기업의 계속성 및 경영의 투명성 등을 종합적으로 고려하여 상장폐지',
    })),
  };
}

function bar(tradingDay: string, close: number, volume: number | null): DailyBar {
  return { tradingDay, open: close, high: close, low: close, close, volume, turnover: volume === null ? null : 0 };
}

describe('무엇을 받나 — planDelistedCollection', () => {
  it('폐지된 코드는 2005-01-01부터 폐지일까지 받는다', () => {
    const plan = planDelistedCollection([candidate('012460', false, ['20080313'])], '20050101');

    assert.deepEqual(plan.targets, [{ symbol: '012460', from: '20050101', to: '20080313' }]);
    assert.deepEqual(plan.skipped, []);
  });

  it('폐지 목록에 있어도 마스터가 활성이면 받지 않는다 — 012210은 폐지일 뒤에도 거래된다', () => {
    /*
     * 폐지 목록이 말하는 것과 봉이 말하는 것이 다르다. 여기서 받아 버리면
     * `replaceSymbolBars`가 그 종목의 21년치를 **폐지일까지로 잘라 갈아 끼운다.**
     * 살아 있는 계열의 주인은 `collectDailyBars.ts`다.
     */
    const plan = planDelistedCollection([candidate('012210', true, ['20251229'])], '20050101');

    assert.deepEqual(plan.targets, []);
    assert.equal(plan.skipped.length, 1);
    assert.equal(plan.skipped[0].reason, 'stillActive');
    assert.match(plan.skipped[0].detail, /20251229/);
  });

  it('두 번 이상 폐지된 코드는 받지 않는다 — 어느 구간이 어느 회사인지 가를 수 없다', () => {
    const plan = planDelistedCollection([candidate('031440', false, ['20100429', '20260811'])], '20050101');

    assert.deepEqual(plan.targets, []);
    assert.equal(plan.skipped[0].reason, 'relisted');
    assert.match(plan.skipped[0].detail, /2건/);
  });

  /*
   * ★ 2026-08-14: `relisted`로 빠진 8종목이 **하나도 재상장이 아니었다.**
   * 전부 `시장 이동 → 나중에 진짜 폐지`라, 기록이 둘이라는 이유만으로 진짜 폐지
   * 8종목이 표본에서 사라지고 있었다.
   */
  it('★ 앞 기록이 시장 이동이면 마지막 폐지일까지 받는다 — 시장을 옮긴 것은 퇴장이 아니다', () => {
    const plan = planDelistedCollection(
      [candidate('197210', false, ['20151120', '20200514'], ['코스닥시장 이전상장'])],
      '20050101',
    );

    assert.deepEqual(plan.targets, [{ symbol: '197210', from: '20050101', to: '20200514' }]);
    assert.deepEqual(plan.skipped, []);
  });

  it('시장 이동의 세 표현을 다 잡는다 — 실측에 있는 것만', () => {
    for (const reason of ['코스닥시장 이전상장', '유가증권시장 상장', '코스닥시장 상장']) {
      assert.equal(isMarketTransfer(reason), true, reason);
    }
  });

  it('★ `상장폐지`가 든 사유는 시장 이동이 아니다 — 느슨하게 잡으면 진짜 폐지가 섞인다', () => {
    for (const reason of [
      '기업의 계속성 및 경영의 투명성 등을 종합적으로 고려하여 상장폐지기준에 해당한다고 결정',
      '신청에 의한 상장폐지',
      '상장예비심사 청구서 미제출로 관리종목 지정 후 1개월 이내 동 사유 미해소',
    ]) {
      assert.equal(isMarketTransfer(reason), false, reason);
    }
  });

  it('앞 기록이 진짜 폐지면 여전히 받지 않는다 — 코드 재사용은 가릴 근거가 없다', () => {
    const plan = planDelistedCollection(
      [candidate('013890', false, ['20050518', '20240101'], ['자본전액잠식', '감사의견 거절'])],
      '20050101',
    );

    assert.deepEqual(plan.targets, []);
    assert.equal(plan.skipped[0].reason, 'relisted');
  });

  it('폐지일이 없으면 받지 않는다 — 끝을 모르는 채로 받으면 어디까지가 그 회사인지 알 수 없다', () => {
    const plan = planDelistedCollection([candidate('000000', false, [])], '20050101');

    assert.deepEqual(plan.targets, []);
    assert.equal(plan.skipped[0].reason, 'noDelistingDay');
  });

  it('폐지일이 여럿이면 정렬해서 본다 — 들어온 순서에 기대지 않는다', () => {
    const plan = planDelistedCollection([candidate('031440', false, ['20260811', '20100429'])], '20050101');
    assert.match(plan.skipped[0].detail, /20100429, 20260811/);
  });

  it('뺀 것을 세어 남긴다 — 1,021개가 된 이유를 말할 수 있어야 한다', () => {
    const plan = planDelistedCollection(
      [
        candidate('012460', false, ['20080313']),
        candidate('012210', true, ['20251229']),
        candidate('031440', false, ['20100429', '20260811']),
      ],
      '20050101',
    );

    assert.equal(plan.targets.length, 1);
    assert.deepEqual(plan.skipped.map((row) => row.reason).sort(), ['relisted', 'stillActive']);
  });
});

describe('꼬리를 어디서 끊나 — trimTrailingZeroVolumeBars', () => {
  it('폐지일의 거래량 0 봉을 뗀다 — 거래 없이 +200%가 마지막 봉이 되면 안 된다', () => {
    /*
     * 005600 중앙제지 실측: 2005-01-05 종가 10(거래량 354,427) →
     * 폐지일 01-06 종가 30(거래량 0). 담으면 폐지 손실이 줄어 보이고,
     * `scanAdjustmentBreaks`가 그 봉을 파탄으로 잡아 21년을 통째로 버린다.
     */
    const trimmed = trimTrailingZeroVolumeBars([
      bar('20050104', 30, 250_110),
      bar('20050105', 10, 354_427),
      bar('20050106', 30, 0),
    ]);

    assert.equal(trimmed.trimmed, 1);
    assert.deepEqual(trimmed.bars.map((row) => row.tradingDay), ['20050104', '20050105']);
  });

  it('끝에 여러 개가 붙어 있으면 모두 뗀다', () => {
    const trimmed = trimTrailingZeroVolumeBars([
      bar('20190107', 100, 1_000),
      bar('20190108', 100, 500),
      bar('20190109', 100, 0),
      bar('20190110', 100, 0),
    ]);
    assert.equal(trimmed.trimmed, 2);
  });

  it('중간의 거래정지 구간은 남긴다 — 그 뒤에 다시 거래된 사실이 있다', () => {
    /*
     * 117930 한진해운은 2017-02-03~02-22 스무 날이 780원 고정·거래량 0이었고
     * 그 뒤 정리매매로 다시 거래됐다. 그 구간은 계열의 일부다.
     */
    const trimmed = trimTrailingZeroVolumeBars([
      bar('20170202', 780, 218_194_059),
      bar('20170203', 780, 0),
      bar('20170206', 780, 0),
      bar('20170223', 310, 104_049_406),
    ]);

    assert.equal(trimmed.trimmed, 0);
    assert.equal(trimmed.bars.length, 4);
  });

  it('전부 거래량 0이면 한 건도 남지 않는다 — 그 구간엔 거래가 없었다', () => {
    /*
     * 000110은 2005-01-03~04-22의 75봉이 전부 그랬다(2026-08-13 실측).
     * 남길 것이 없다는 사실을 0봉으로 말한다 — 값이 있는 척하지 않는다.
     */
    const trimmed = trimTrailingZeroVolumeBars([bar('20050103', 100, 0), bar('20050104', 100, 0)]);

    assert.deepEqual(trimmed.bars, []);
    assert.equal(trimmed.trimmed, 2);
  });

  it('거래량이 null이면 거기서 멈춘다 — 안 온 것을 0이라고 단정하지 않는다', () => {
    const trimmed = trimTrailingZeroVolumeBars([bar('20050103', 100, 1_000), bar('20050104', 100, null)]);

    assert.equal(trimmed.trimmed, 0);
    assert.equal(trimmed.bars.length, 2);
  });

  it('빈 배열은 빈 배열이다', () => {
    assert.deepEqual(trimTrailingZeroVolumeBars([]), { bars: [], trimmed: 0 });
  });
});

/*
 * 아래는 실제 표를 건드린다. DATABASE_URL이 없거나 붙지 못하면 건너뛴다.
 */
const TEST_SYMBOL = 'TEST_DELISTING';
let usable = false;

before(async () => {
  try {
    await ensureDelistingSchema();
    await pool.query('DELETE FROM instrument_delistings WHERE symbol = $1', [TEST_SYMBOL]);
    usable = true;
  } catch {
    usable = false;
  }
});

after(async () => {
  if (usable) {
    await pool.query('DELETE FROM instrument_delistings WHERE symbol = $1', [TEST_SYMBOL]).catch(() => undefined);
  }
  await pool.end().catch(() => undefined);
});

describe('저장소 (DB가 있을 때만)', () => {
  it('같은 코드의 폐지 두 건이 나란히 남는다 — 재상장을 한 줄로 뭉개지 않는다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못했습니다');

    await upsertDelistings(
      [
        { symbol: TEST_SYMBOL, delistedOn: '20100429', name: '앞회사', market: 'KOSDAQ', reason: '사유1', note: null },
        { symbol: TEST_SYMBOL, delistedOn: '20260811', name: '뒷회사', market: 'KOSPI', reason: '사유2', note: '비고' },
      ],
      'KIND',
      '20260813',
      1,
    );

    const rows = (await getDelistings()).filter((row) => row.symbol === TEST_SYMBOL);
    assert.deepEqual(rows.map((row) => row.delistedOn), ['20100429', '20260811']);
    assert.deepEqual(rows.map((row) => row.market), ['KOSDAQ', 'KOSPI']);
    assert.equal(rows[1].note, '비고');
  });

  it('다시 받아도 지우지 않는다 — 이번에 안 받은 구간의 기록이 남는다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못했습니다');

    await upsertDelistings(
      [{ symbol: TEST_SYMBOL, delistedOn: '20260811', name: '이름바뀜', market: null, reason: '사유3', note: null }],
      'KIND',
      '20260814',
      2,
    );

    const rows = (await getDelistings()).filter((row) => row.symbol === TEST_SYMBOL);
    assert.equal(rows.length, 2, '앞 기록이 그대로 있다');
    const latest = rows[1];
    assert.equal(latest.name, '이름바뀜');
    assert.equal(latest.market, 'KOSPI', '새로 온 값이 null이면 이미 붙여 둔 시장을 지우지 않는다');
    assert.equal(latest.vintage, '20260814');
  });

  it('요약이 재상장 코드를 센다', async (t) => {
    if (!usable) return t.skip('DB에 붙지 못했습니다');

    const summary = await summarizeDelistings();
    assert.ok(summary.records >= 2);
    assert.ok(summary.multiEpisodeSymbols >= 1);
  });
});
