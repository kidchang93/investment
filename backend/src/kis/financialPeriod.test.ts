/**
 * 재무 기간 창 읽기 검증.
 *
 * 이 두 함수가 틀리면 화면이 `매출 133조`를 `매출 333조` 옆에 나란히 적어
 * 회사가 3분의 1로 줄어든 것처럼 보이게 만든다. 실제로는 창이 1년에서
 * 3개월로 바뀐 것뿐이다.
 *
 * 실측값(삼성전자 2026-07-27)을 그대로 태운다 — 지어낸 값으로만 재면
 * KIS가 실제로 무엇을 주는지는 여전히 모른다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  detectCumulativeReporting,
  financialPeriodWindow,
  type FinancialSnapshot,
} from '@invest/shared';

/** 삼성전자 실측(억원). 2025년 4개 분기와 2026년 1분기. */
const SAMSUNG: FinancialSnapshot[] = [
  { period: '202603', revenue: 1_338_734 },
  { period: '202512', revenue: 3_336_059 },
  { period: '202509', revenue: 2_397_686 },
  { period: '202506', revenue: 1_537_068 },
  { period: '202503', revenue: 791_405 },
];

describe('financialPeriodWindow', () => {
  it('3·6·9·12월은 누적 개월 수를 센다', () => {
    assert.equal(financialPeriodWindow('202603')?.months, 3);
    assert.equal(financialPeriodWindow('202506')?.months, 6);
    assert.equal(financialPeriodWindow('202509')?.months, 9);
    assert.equal(financialPeriodWindow('202512')?.months, 12);
  });

  it('창을 사람이 읽을 말로 적는다', () => {
    assert.equal(financialPeriodWindow('202603')?.label, '2026년 1~3월 누적');
    assert.equal(financialPeriodWindow('202512')?.label, '2025년 1~12월 누적');
    assert.equal(financialPeriodWindow('202603')?.shortLabel, '3개월');
    assert.equal(financialPeriodWindow('202512')?.shortLabel, '1년');
  });

  it('3의 배수가 아닌 결산월은 개월 수를 세지 않는다', () => {
    // 모르는 것을 아는 척하면 화면이 틀린 창을 적는다.
    const window = financialPeriodWindow('202602');
    assert.equal(window?.months, undefined);
    assert.equal(window?.label, '2026년 2월 결산');
    assert.equal(window?.shortLabel, '2월');
  });

  it('형식이 아니면 undefined', () => {
    assert.equal(financialPeriodWindow('2026'), undefined);
    assert.equal(financialPeriodWindow('20260'), undefined);
    assert.equal(financialPeriodWindow('202613'), undefined);
    assert.equal(financialPeriodWindow('202600'), undefined);
    assert.equal(financialPeriodWindow(''), undefined);
  });
});

describe('detectCumulativeReporting', () => {
  it('삼성전자 실측은 누적으로 확인된다', () => {
    assert.equal(detectCumulativeReporting(SAMSUNG), 'cumulative');
  });

  it('같은 해에서 뒤 분기 매출이 더 작으면 분기 단독이다', () => {
    const standalone: FinancialSnapshot[] = [
      { period: '202512', revenue: 940_000 },
      { period: '202509', revenue: 860_000 },
      { period: '202506', revenue: 745_000 },
      // 4분기가 3분기보다 작다 — 누적이면 있을 수 없다.
      { period: '202503', revenue: 791_405 },
    ];
    assert.equal(detectCumulativeReporting(standalone), 'standalone');
  });

  it('한 해에 한 행뿐이면 판단하지 않는다', () => {
    assert.equal(
      detectCumulativeReporting([
        { period: '202512', revenue: 3_336_059 },
        { period: '202412', revenue: 3_008_709 },
      ]),
      'unknown',
    );
  });

  it('매출이 없는 행만 오면 판단하지 않는다', () => {
    // ETF처럼 손익계산서가 안 오는 경우. 없는 것을 분기 단독으로 읽지 않는다.
    assert.equal(
      detectCumulativeReporting([{ period: '202603', roe: 12 }, { period: '202512', roe: 10 }]),
      'unknown',
    );
  });

  it('빈 배열은 unknown', () => {
    assert.equal(detectCumulativeReporting([]), 'unknown');
  });
});
