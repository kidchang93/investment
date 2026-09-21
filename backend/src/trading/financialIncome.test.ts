import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DividendRecord } from '@invest/shared';
import {
  dividendIncomeForYear, etfGainsForYear, sharesOnRecordDate, type IncomeTrade,
} from './financialIncome.js';

const buy = (symbol: string, quantity: number, tradedOn: string): IncomeTrade =>
  ({ symbol, side: 'buy', quantity, realizedPnl: null, tradedOn });
const sell = (symbol: string, quantity: number, tradedOn: string, pnl: number): IncomeTrade =>
  ({ symbol, side: 'sell', quantity, realizedPnl: pnl, tradedOn });
const div = (symbol: string, recordDate: string, amountPerShare: number, payDate: string): DividendRecord =>
  ({ symbol, recordDate, amountPerShare, payDate, kind: '' });

describe('올해 금융소득', () => {
  it('기준일 2일 전까지 체결된 것만 기준일 수량이다 — 결제가 T+2라서', () => {
    const trades = [buy('161510', 100, '20260825'), buy('161510', 50, '20260830')];
    assert.equal(sharesOnRecordDate(trades, '161510', '20260831'), 100, '8/30 매수는 결제 전이라 못 받는다');
  });

  it('판 것은 뺀다', () => {
    const trades = [buy('329200', 2700, '20260811'), sell('329200', 1000, '20260818', 0)];
    assert.equal(sharesOnRecordDate(trades, '329200', '20260831'), 1700);
  });

  it('지급일이 올해인 배당을 센다 — 작년 12월 기준·올해 1월 지급 결산배당은 올해 소득이다', () => {
    const trades = [buy('005935', 25, '20251201')];
    const d = [div('005935', '20251231', 567, '2026/04/17'), div('005935', '20250930', 370, '2025/11/19')];
    const r = dividendIncomeForYear(trades, d, 2026, '20260921');
    assert.equal(r.total, 25 * 567, '2025/11 지급분은 작년 소득이다');
  });

  it('아직 안 온 지급일은 세지 않는다', () => {
    const trades = [buy('161510', 100, '20260101')];
    const r = dividendIncomeForYear(trades, [div('161510', '20260930', 103, '2026/10/02')], 2026, '20260921');
    assert.equal(r.total, 0);
  });

  it('★ 기타형 차익은 매도 건별로 센다 — 손실이 이익을 상계하지 않는다', () => {
    const trades = [sell('360750', 100, '20260301', 500_000), sell('360750', 100, '20260601', -300_000)];
    const r = etfGainsForYear(trades, () => 'holdingPeriod', () => true, 2026);
    assert.equal(r.taxable, 500_000, '배당소득은 손익통산이 없다');
  });

  it('국내주식형·개별 주식 차익은 금융소득이 아니다', () => {
    const trades = [sell('069500', 10, '20260301', 1_000_000), sell('005930', 10, '20260301', 2_000_000)];
    const r = etfGainsForYear(trades, (s) => (s === '069500' ? 'domestic' : undefined), (s) => s === '069500', 2026);
    assert.equal(r.taxable, 0);
    assert.equal(r.unknown, 0, '개별 주식은 ETF가 아니라 "모름"에도 안 들어간다');
  });

  it('과세유형을 모르는 ETF 차익은 합계에 넣지 않고 따로 센다', () => {
    const trades = [sell('498400', 10, '20260301', 800_000)];
    const r = etfGainsForYear(trades, () => undefined, () => true, 2026);
    assert.deepEqual(r, { taxable: 0, unknown: 800_000 });
  });
});
