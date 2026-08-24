/**
 * 레버리지·단일종목 파생 제외 검증.
 *
 * 2026-08-03에 후보를 거래대금 순으로 고치자마자 러너가 자리 8개 중 셋을 같은
 * 기초자산(SK하이닉스)의 파생으로 채웠다. 레버리지 2배를 반영한 실효 노출이
 * 총평가의 64.6%였다 — `maxPositions`는 종목 수를 세지 위험을 세지 않는다.
 *
 * 이름으로 거르는 것은 어림이라 **덜 사는 쪽으로 틀리게** 둔다. 그래서 두 가지를
 * 함께 못 박는다: 실제로 산 종목들이 걸릴 것 · 멀쩡한 종목이 안 걸릴 것.
 *
 * ★★ **2026-08-24에 1배 인버스를 열었다**(사용자 결정). 공매도를 할 수 없으므로
 *    하락에 거는 유일한 길이기 때문이다 — 이유는 `isOrderableForAutoTrader`에 적었다.
 *    그날의 사고를 만든 **단일종목 파생과 배수 상품은 그대로 막는다.**
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

describe('자동매매 후보 — 배수·단일종목 파생은 뺀다', () => {
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

  it('DB에 실제로 있는 다른 배수·단일종목 표기들도 걸린다', () => {
    for (const name of [
      'KODEX 코스닥150레버리지',
      'SOL SK하이닉스선물단일종목인버스2X',
      'TIGER 이머징마켓MSCI레버리지(합성 H)',
      'KODEX 200선물인버스2X',
    ]) {
      assert.equal(isOrderableForAutoTrader(etf(name)), false, name);
    }
  });

  /*
   * ★ 공매도를 못 하므로 **하락에 거는 자리는 1배 인버스뿐**이다. 열어 두되
   *   10% 상한이 함께 걸린다(`docs/USER_DECISIONS.md`).
   */
  it('★ 1배 인버스는 통과한다 — 숏 노출을 얻는 유일한 길이다', () => {
    for (const name of ['KODEX 인버스', 'TIGER 인버스', 'KODEX 200선물인버스']) {
      assert.equal(isOrderableForAutoTrader(etf(name)), true, name);
    }
  });

  /*
   * 기초자산 데이터가 없어 이름만으로는 지수 인버스와 원자재 인버스를 못 가른다.
   * **그 자리는 10% 상한과 판단자가 근거를 대야 하는 규율이 막는다** — 여기서
   * 다 거르려 하면 규칙이 유지되지 않는다.
   */
  it('원자재 인버스도 이름으로는 안 걸린다 — 그 사실을 값으로 남긴다', () => {
    assert.equal(isOrderableForAutoTrader(etf('KODEX WTI원유선물인버스(H)')), true);
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
