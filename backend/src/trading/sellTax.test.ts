/**
 * 매도 세율 판정의 경계를 못 박는다.
 *
 * ── 왜 (2026-08-12) ──────────────────────────────────────────────────────
 *
 * **국내 상장 ETF는 매도 시 증권거래세가 면제다. 종류와 무관하다.** 그런데
 * 백테스트는 조건 없이 주식 세율을 물렸고, 주문 티켓은 `market`(코넥스인가)만
 * 보고 있었다. 세율을 정하는 자리가 여럿이라 한 곳만 고치면 화면과 측정이
 * 조용히 갈라진다 — 그래서 면제 판정은 `shared`의 `isKrSellTaxExempt` 하나뿐이고,
 * 여기서 그 하나를 시험한다.
 *
 * 이 시험이 지키는 것은 **면제 여부**지 세율 숫자가 아니다. 숫자는
 * `KR_SELL_TAX_RATE`가 정하고 법이 바뀌면 그 값만 고친다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isKrSellTaxExempt, type Instrument } from '@invest/shared';

function instrument(overrides: Partial<Instrument> = {}): Instrument {
  return {
    id: 'KR:KOSPI:005930',
    symbol: '005930',
    name: '테스트종목',
    market: 'KOSPI',
    country: 'KR',
    currency: 'KRW',
    assetType: 'stock',
    provider: 'kis',
    providerSymbol: '005930',
    exchangeCode: 'KRX',
    timezone: 'Asia/Seoul',
    ...overrides,
  };
}

describe('매도 세율 — ETF 면제', () => {
  it('ETF는 매도 거래세가 면제다', () => {
    assert.equal(isKrSellTaxExempt(instrument({ assetType: 'etf' })), true);
  });

  it('일반 주식은 면제가 아니다', () => {
    assert.equal(isKrSellTaxExempt(instrument()), false);
  });

  it('ETN은 면제로 넣지 않았다 — 확인된 출처가 없어서다', () => {
    /*
     * 실제로 면제일 수 있다. 다만 이 레포는 그것을 확인한 출처를 아직 갖고 있지
     * 않다. `KR_SELL_TAX_RATE` 주석이 적은 대로, 출처 없이 두 값 중 하나를
     * 고르면 반은 틀린다 — 지금 동작을 시험으로 고정해 두고, 확인되면 여기와
     * `isKrSellTaxExempt`를 함께 고친다.
     */
    assert.equal(isKrSellTaxExempt(instrument({ assetType: 'etn' })), false);
  });

  it('해외·파생형 ETF의 매매차익 15.4%는 넣지 않았다 — 여기서 재는 것은 거래세뿐이다', () => {
    /*
     * 국내주식형이든 해외지수·채권·원자재·파생형이든 **거래세는 똑같이 0**이다.
     * 갈리는 것은 매매차익 과세인데 그건 보유기간 과세라
     * `Min(매매차익, 과표증분)` 구조이고 **과표증분을 우리가 모른다.**
     * 지금 넣으면 틀린 값이 들어가므로 안 넣었고, 그 종류에 대해 이 앱의 비용은
     * **과소계상**이다. `Instrument`에 그 구분이 없으므로 시험도 종류로 갈리지
     * 않는다는 사실만 못 박는다.
     */
    const domestic = instrument({ assetType: 'etf', name: 'KODEX 200' });
    const overseas = instrument({ assetType: 'etf', name: 'TIGER 미국나스닥100' });
    assert.equal(isKrSellTaxExempt(domestic), isKrSellTaxExempt(overseas));
    assert.equal(isKrSellTaxExempt(overseas), true);
  });
});
