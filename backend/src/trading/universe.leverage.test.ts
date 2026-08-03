/**
 * 레버리지·인버스 제외 검증.
 *
 * 2026-08-03에 후보를 거래대금 순으로 고치자마자 러너가 자리 8개 중 셋을 같은
 * 기초자산(SK하이닉스)의 파생으로 채웠다. 레버리지 2배를 반영한 실효 노출이
 * 총평가의 64.6%였다 — `maxPositions`는 종목 수를 세지 위험을 세지 않는다.
 *
 * 이름으로 거르는 것은 어림이라 **덜 사는 쪽으로 틀리게** 둔다. 그래서 두 가지를
 * 함께 못 박는다: 실제로 산 종목들이 걸릴 것 · 멀쩡한 종목이 안 걸릴 것.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Instrument } from '@invest/shared';

import { isOrderableForAutoTrader } from './universe.js';

function etf(name: string): Instrument {
  return {
    id: `KR:KOSPI:${name}`,
    symbol: '000000',
    name,
    market: 'KOSPI',
    country: 'KR',
    currency: 'KRW',
    assetType: 'etf',
    provider: 'kis',
    providerSymbol: '000000',
    exchangeCode: 'KRX',
    timezone: 'Asia/Seoul',
  };
}

describe('자동매매 후보 — 레버리지·인버스는 뺀다', () => {
  /* 그날 실제로 자리를 차지한 것들. 셋 다 걸려야 한다. */
  it('그날 한 종목에 64.6%를 몰리게 한 상품들이 걸린다', () => {
    for (const name of [
      'TIGER SK하이닉스단일종목레버리지',
      'KODEX SK하이닉스단일종목레버리지',
      'PLUS 삼성전자선물단일종목인버스2X',
    ]) {
      assert.equal(isOrderableForAutoTrader(etf(name)), false, name);
    }
  });

  it('DB에 실제로 있는 다른 표기들도 걸린다', () => {
    for (const name of [
      'KODEX 코스닥150레버리지',
      'TIGER 인버스',
      'KODEX WTI원유선물인버스(H)',
      'SOL SK하이닉스선물단일종목인버스2X',
      'TIGER 이머징마켓MSCI레버리지(합성 H)',
    ]) {
      assert.equal(isOrderableForAutoTrader(etf(name)), false, name);
    }
  });

  /* 덜 사는 쪽으로 틀리되, 멀쩡한 것까지 버리면 후보가 남지 않는다. */
  it('파생이 아닌 종목은 그대로 통과한다', () => {
    for (const name of [
      'KODEX 200',
      'TIGER 미국S&P500',
      'RISE AI반도체TOP10',
      'KODEX 삼성전자',
      'SK하이닉스',
    ]) {
      assert.equal(isOrderableForAutoTrader(etf(name)), true, name);
    }
  });

  it('국내가 아니거나 주문할 수 없는 자산은 그대로 빠진다', () => {
    assert.equal(isOrderableForAutoTrader({ ...etf('KODEX 200'), country: 'US' }), false);
    assert.equal(isOrderableForAutoTrader({ ...etf('코스피200'), assetType: 'index' }), false);
  });
});
