import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DividendRecord } from '@invest/shared';
import { dividendYield, trailingDividendPerShare } from './dividend.js';

function rec(recordDate: string, amountPerShare: number): DividendRecord {
  return { symbol: '005935', recordDate, amountPerShare, payDate: '', kind: '분기' };
}

describe('배당 합계와 수익률', () => {
  /*
   * 값은 2026-09-21 삼성전자우 실측이다. 네 건 모두 365일 창 안이라 연 1,683원이고,
   * 현재가 206,000원에 대해 0.82%가 된다.
   *
   * ★ 처음 이 시험을 1,313으로 적었다가 틀렸다 — 2025-09-30을 "창 밖"이라고 눈대중했는데
   *   2026-09-21의 365일 전은 2025-09-21이라 9일 차이로 안에 든다. 경계는 세어야 한다.
   */
  it('최근 1년 기준일을 더한다', () => {
    const rows = [rec('20260630', 374), rec('20260331', 372), rec('20251231', 567), rec('20250930', 370)];
    assert.equal(trailingDividendPerShare(rows, '20260921'), 1683);
  });

  it('창을 하루라도 벗어나면 뺀다', () => {
    const rows = [rec('20250922', 100), rec('20250921', 999)];
    assert.equal(trailingDividendPerShare(rows, '20260921'), 100);
  });

  it('★ 레코드가 없으면 0이 아니라 undefined다 — 조회가 빠뜨린 종목을 배당 0으로 적으면 안 된다', () => {
    assert.equal(trailingDividendPerShare([], '20260921'), undefined);
  });

  it('창 안에 없으면 0이다 — 1년 넘게 끊긴 것은 아는 사실이다', () => {
    assert.equal(trailingDividendPerShare([rec('20240101', 500)], '20260921'), 0);
  });

  it('미래 기준일은 빼고 센다', () => {
    assert.equal(trailingDividendPerShare([rec('20260630', 374), rec('20261231', 600)], '20260921'), 374);
  });

  it('수익률은 주당 배당금을 현재가로 나눈다', () => {
    assert.equal(dividendYield(1034, 24_905)?.toFixed(2), '4.15');
  });

  it('모르는 값이나 가격 0이면 수익률도 모른다', () => {
    assert.equal(dividendYield(undefined, 24_905), undefined);
    assert.equal(dividendYield(1034, 0), undefined);
  });
});
