import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DividendRecord } from '@invest/shared';
import { exDividendDayOf, monthEndPayer } from './exDividend.js';

const rec = (recordDate: string, amountPerShare: number): DividendRecord =>
  ({ symbol: '329200', recordDate, amountPerShare, payDate: '', kind: '' });

describe('배당락일 추정', () => {
  /* 329200 리츠 실측 기준일 — 전부 그 달 마지막 개장일이다. */
  it('월배당 ETF는 12개 달이 다 들어오고 최근 금액을 쓴다', () => {
    const rows = ['20250930', '20251031', '20251128', '20251230', '20260130', '20260227',
      '20260331', '20260430', '20260529', '20260630', '20260731', '20260831'].map((d) => rec(d, 33));
    const p = monthEndPayer(rows, '20260921');
    assert.equal(p?.months.size, 12);
    assert.equal(p?.lastAmount, 33);
  });

  it('분기 배당은 그 달만 든다', () => {
    const p = monthEndPayer([rec('20251031', 140), rec('20260130', 80), rec('20260430', 446), rec('20260731', 183)], '20260921');
    assert.deepEqual([...p!.months].sort((a, b) => a - b), [1, 4, 7, 10]);
    assert.equal(p?.lastAmount, 183);
  });

  it('★ 월 중 기준일이 한 건이라도 있으면 추정하지 않는다 — 월말 규칙이 틀린다', () => {
    assert.equal(monthEndPayer([rec('20260615', 100), rec('20260831', 100)], '20260921'), undefined);
  });

  it('배당 이력이 없으면 추정하지 않는다', () => {
    assert.equal(monthEndPayer([], '20260921'), undefined);
  });

  it('배당락일은 이달 마지막 개장일의 직전 개장일이다 — 결제가 T+2라서', () => {
    // 2026-09: 추석 연휴 뒤 29·30일 개장 → 기준일 9/30, 배당락 9/29
    assert.equal(exDividendDayOf(['20260922', '20260923', '20260929', '20260930']), '20260929');
  });
});
