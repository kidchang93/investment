/**
 * 계좌 합계 정규화 — 특히 **평가손익률이 무엇인지**를 못 박는다.
 *
 * ── 무엇이 틀려 있었나 (2026-08-12 09:03 실측) ────────────────────────────
 *
 * `unrealizedPnlRate`에 KIS의 `asst_icdc_erng_rt`(자산증감수익률)가 들어가 있었다.
 * 그건 **전일 총자산 대비 오늘 자산 변동**이라 평가손익률이 아니다.
 *
 *   자산증감수익률 0.17474202 = (96,154,944 − 95,987,214) / 95,987,214
 *   실제 평가손익률 +0.1769%  = 84,570 / 47,797,070
 *
 * 그날은 둘 다 ~0.17%라 눈으로는 안 갈렸다. **개장 전에는 자산이 안 움직여 0으로
 * 오므로**, 평가손익률이 −0.174%인 아침에 화면·판단자가 `0%`를 읽는다.
 *
 * 아래 픽스처는 KIS가 실제로 준 값이다(계좌번호·자격증명은 안 담긴다).
 * 값이 있는 쪽을 화면으로 태울 수 없어서 — 개장 전 상태를 만들 수 없다 —
 * 여기서 행을 직접 넣고 잰다.
 *
 * **네트워크를 쓰지 않는다.** 응답 정규화만 부른다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { accountTotalsFrom } from './rest.js';

/** 2026-08-12 09:03 실측 행. 개장 직후라 자산증감과 평가손익이 우연히 비슷했다. */
const MEASURED: Record<string, string> = {
  dnca_tot_amt: '48357874',
  prvs_rcdl_excc_amt: '48357874',
  nxdy_excc_amt: '48357874',
  tot_evlu_amt: '96154944',
  scts_evlu_amt: '47881640',
  pchs_amt_smtl_amt: '47797070',
  evlu_pfls_smtl_amt: '84570',
  bfdy_tot_asst_evlu_amt: '95987214',
  asst_icdc_amt: '167730',
  asst_icdc_erng_rt: '0.17474202',
};

describe('계좌 합계 — 평가손익률', () => {
  it('평가손익률은 매입금액 대비로 계산한다', () => {
    const totals = accountTotalsFrom(MEASURED);
    assert.ok(totals.unrealizedPnlRate !== undefined);
    assert.ok(
      Math.abs(totals.unrealizedPnlRate - (84_570 / 47_797_070) * 100) < 1e-12,
      String(totals.unrealizedPnlRate),
    );
  });

  it('KIS의 자산증감수익률을 평가손익률이라고 부르지 않는다', () => {
    const totals = accountTotalsFrom(MEASURED);
    assert.equal(totals.assetChangeRate, 0.17474202);
    assert.notEqual(totals.unrealizedPnlRate, totals.assetChangeRate);
  });

  it('개장 전 — 자산이 안 움직여도 평가손익률은 0이 아니다', () => {
    /*
     * 이것이 이 시험의 이유다. 장 시작 전에는 총자산이 전일과 같아
     * `asst_icdc_erng_rt`가 `0.00000000`으로 온다. 그 값을 평가손익률 자리에 두면
     * **실제로 −0.17% 손실 중인 계좌가 `0%`(본전)로 보인다.**
     */
    const preOpen: Record<string, string> = {
      ...MEASURED,
      tot_evlu_amt: '95987214',
      pchs_amt_smtl_amt: '47797070',
      evlu_pfls_smtl_amt: '-83000',
      asst_icdc_amt: '0',
      asst_icdc_erng_rt: '0.00000000',
    };
    const totals = accountTotalsFrom(preOpen);
    assert.equal(totals.assetChangeRate, 0);
    assert.ok(totals.unrealizedPnlRate !== undefined);
    assert.ok(totals.unrealizedPnlRate < 0, `손실 중인데 ${totals.unrealizedPnlRate}`);
    assert.ok(
      Math.abs(totals.unrealizedPnlRate - (-83_000 / 47_797_070) * 100) < 1e-12,
      String(totals.unrealizedPnlRate),
    );
  });

  it('보유가 없으면 평가손익률은 0%가 아니라 없는 값이다', () => {
    /*
     * 매입금액이 0이면 분모가 없다. 0%로 적으면 "본전이었다"로 읽히는데
     * 실제로는 잴 것이 없는 것이다 — `settledRealized`와 같은 규칙이다.
     */
    const empty: Record<string, string> = {
      dnca_tot_amt: '100000000',
      tot_evlu_amt: '100000000',
      pchs_amt_smtl_amt: '0',
      evlu_pfls_smtl_amt: '0',
      asst_icdc_erng_rt: '0.00000000',
    };
    assert.equal(accountTotalsFrom(empty).unrealizedPnlRate, undefined);
  });

  it('칸 자체가 없으면 값도 없다 — 0으로 채우지 않는다', () => {
    const totals = accountTotalsFrom({});
    assert.equal(totals.purchaseAmount, undefined);
    assert.equal(totals.unrealizedPnl, undefined);
    assert.equal(totals.unrealizedPnlRate, undefined);
    assert.equal(totals.assetChangeRate, undefined);
  });

  it('빈 문자열은 0이 아니라 없는 값이다', () => {
    /*
     * ★ **2026-08-13에 뒤집힌 시험이다.** 그전에는 여기서 `purchaseAmount === 0`을
     * 확인하고 있었다 — 고쳐서가 아니라 그때 `optionalNumber`가 `Number('')`을 썼기
     * 때문이고(`Number('')`은 NaN이 아니라 **0**이다), 범위가 커서 지금 동작만
     * 적어 둔 것이었다. 지금은 `optionalNumber`가 `toNumberOrNaN`을 거치므로
     * 빈 칸이 `null` → `undefined`로 나온다.
     *
     * `'0'`(문자 영)은 그대로 0이어야 한다. 아래 `'0으로 온 칸'` 시험이 그것이다.
     */
    const blank: Record<string, string> = { pchs_amt_smtl_amt: '', evlu_pfls_smtl_amt: '' };
    const totals = accountTotalsFrom(blank);
    assert.equal(totals.purchaseAmount, undefined);
    assert.equal(totals.unrealizedPnl, undefined);
    assert.equal(totals.unrealizedPnlRate, undefined);
  });

  it("0으로 온 칸은 0이다 — 빈 칸과 같이 취급하지 않는다", () => {
    const zeroed: Record<string, string> = { pchs_amt_smtl_amt: '0', evlu_pfls_smtl_amt: '0' };
    const totals = accountTotalsFrom(zeroed);
    assert.equal(totals.purchaseAmount, 0);
    assert.equal(totals.unrealizedPnl, 0);
    // 분모가 0이라 손익률은 여전히 없는 값이다.
    assert.equal(totals.unrealizedPnlRate, undefined);
  });

  it('첫 후보가 빈 칸이면 다음 후보로 넘어간다 — D+2가 비면 D+1', () => {
    /*
     * `settlementCash`는 D+2(`prvs_rcdl_excc_amt`) → D+1(`nxdy_excc_amt`) 순으로
     * 고르게 돼 있는데, 빈 문자열이 0으로 읽히던 동안에는 **첫 후보가 비어도
     * 거기서 멈춰 0원**이 나왔다. 대체 경로가 있는데 한 번도 안 쓰였다.
     *
     * 0원이면 `spendableCash`가 "쓸 돈이 없다"로 읽어 러너가 아무것도 못 산다.
     */
    const missingD2: Record<string, string> = {
      ...MEASURED,
      prvs_rcdl_excc_amt: '',
      nxdy_excc_amt: '48273304',
    };
    assert.equal(accountTotalsFrom(missingD2).settlementCash, 48_273_304);
  });

  it('나머지 합계는 예전 계약 그대로다', () => {
    const totals = accountTotalsFrom(MEASURED);
    assert.equal(totals.cashBalance, 48_357_874);
    assert.equal(totals.settlementCash, 48_357_874);
    assert.equal(totals.totalEvaluation, 96_154_944);
    assert.equal(totals.stockEvaluation, 47_881_640);
    assert.equal(totals.purchaseAmount, 47_797_070);
    assert.equal(totals.unrealizedPnl, 84_570);
  });
});
