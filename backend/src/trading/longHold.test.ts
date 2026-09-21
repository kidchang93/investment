import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { annualizedReturn, feeDrag, taxDrag, yearsBetween } from './longHold.js';

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

describe('20년 세금', () => {
  it('배당이 없고 국내주식형이면 세금이 0이다', () => {
    assert.equal(taxDrag(10, 0, 20, 'domestic').dragPct.toFixed(6), '0.000000');
  });

  it('★ 같은 총수익이면 배당형이 차익형보다 세금을 더 낸다 — 국내주식형 기준', () => {
    // 둘 다 세전 연 ~10%: 하나는 가격 10%, 하나는 가격 5% + 배당 ~4.76%
    const growth = taxDrag(10, 0, 20, 'domestic');
    const income = taxDrag(5, 4.76, 20, 'domestic');
    assert.ok(Math.abs(growth.preTaxCagr - income.preTaxCagr) < 0.05, '세전이 같아야 비교가 된다');
    assert.ok(income.dragPct > growth.dragPct, '배당은 매년 과세되고 차익은 비과세다');
  });

  it('기타형은 판 해에 차익이 과세된다 — 같은 조건이면 국내주식형보다 더 깎인다', () => {
    const dom = taxDrag(10, 1, 20, 'domestic');
    const hp = taxDrag(10, 1, 20, 'holdingPeriod');
    assert.ok(hp.afterTaxCagr < dom.afterTaxCagr);
    assert.ok(hp.gainPerUnit > 5, '20년 연 10%면 원금의 5배가 넘는 차익이 한 해에 잡힌다');
  });

  it('재투자분은 원가로 친다 — 차익이 세후 가치에서 원가를 뺀 것을 넘지 않는다', () => {
    const r = taxDrag(0, 5, 20, 'holdingPeriod');
    assert.ok(r.gainPerUnit < 1e-9, '가격이 안 오르면 재투자해도 차익이 없다');
  });
});
