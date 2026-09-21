import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { annualizedReturn, feeDrag, yearsBetween } from './longHold.js';

describe('오래 들고 있으면', () => {
  it('두 배가 되는 데 10년이면 연 7.18%다', () => {
    assert.equal(annualizedReturn(100, 200, 10)?.toFixed(2), '7.18');
  });

  it('값이 줄었으면 음수다 — 리츠처럼 배당이 전부인 종목이 여기 걸린다', () => {
    assert.ok((annualizedReturn(100, 95, 4.7) ?? 0) < 0);
  });

  it('기간이나 가격이 없으면 모른다', () => {
    assert.equal(annualizedReturn(0, 100, 5), undefined);
    assert.equal(annualizedReturn(100, 100, 0), undefined);
  });

  /* 2026-09-21 보유 실측값이다. 보수가 34배 차이면 20년에 이만큼 벌어진다. */
  it('보수 20년 누적 — PLUS 고배당주 0.23%는 4.50%, TIGER 미국S&P500 0.0068%는 0.14%', () => {
    assert.equal(feeDrag(0.23, 20)?.toFixed(2), '4.50');
    assert.equal(feeDrag(0.0068, 20)?.toFixed(2), '0.14');
  });

  it('보수를 모르면 0이 아니라 모른다 — 모르는 쪽이 싸 보이면 안 된다', () => {
    assert.equal(feeDrag(undefined, 20), undefined);
  });

  it('햇수는 달력으로 센다', () => {
    assert.equal(yearsBetween('20050309', '20260917').toFixed(1), '21.5');
  });
});
