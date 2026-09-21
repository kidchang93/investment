/**
 * **오래 들고 있으면 얼마가 되나** — 20년 지평을 재는 순수 함수들.
 *
 * ── 왜 생겼나 (2026-09-21) ───────────────────────────────────────────────
 *
 * 사용자가 ETF를 이렇게 고르겠다고 했다 — *"배당도 많이 주면서 나중에 한 20년뒤에
 * 팔았을때 충분한 시세차익을 가질 수 있을 정도의 종목으로 사는게 맞겠지?"*
 * 그전 도구(`reviewEtfLayer.ts`)는 **1년 창만** 봤다. 1년은 20년의 판단 재료가 못 된다 —
 * 그해 지수가 135% 오른 장이면 1년 수익이 모든 것을 덮는다.
 *
 * ★ **배당과 시세차익은 대체로 상충한다.** 원주가로 가르니 리츠 ETF는 7.2년간 **가격이
 *   연 −3.13%**였고 배당이 그것을 메워 총수익 연 2.95%였다. 배당으로 현금을 내보내면
 *   가격에 남는 것이 적다. 그래서 둘을 **같은 자리에 나란히** 둬야 판단이 된다.
 *   (첫 판은 수정주가 연 2.92%를 "가격"이라 적었다 — 수정주가는 배당을 품고 있다.)
 */

/** 연환산 수익률(%). 기간이 0 이하거나 가격이 0 이하면 `undefined` */
export function annualizedReturn(firstClose: number, lastClose: number, years: number): number | undefined {
  if (!(firstClose > 0) || !(lastClose > 0) || !(years > 0)) return undefined;
  return ((lastClose / firstClose) ** (1 / years) - 1) * 100;
}

/**
 * 총보수가 years년 동안 복리로 깎는 몫(%).
 *
 * 0.23%가 20년이면 4.50%, 0.0068%면 0.14%다(2026-09-21 보유 기준 34배 차이가 누적되면
 * 이렇게 벌어진다).
 *
 * ★ **과거 수익률에서 이것을 또 빼지 않는다.** 총보수는 매일 NAV에서 차감돼 이미
 *   가격에 들어가 있다. 이 값은 *"앞으로 이만큼 깎인다"*를 보는 것이다.
 */
export function feeDrag(feePct: number | undefined, years: number): number | undefined {
  if (feePct === undefined || !(feePct >= 0) || !(years > 0)) return undefined;
  return (1 - (1 - feePct / 100) ** years) * 100;
}

/** `YYYYMMDD` 두 날 사이의 햇수 (윤년을 평균으로 친다) */
export function yearsBetween(from: string, to: string): number {
  const t = (ymd: string): number =>
    Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
  return (t(to) - t(from)) / (365.25 * 86_400_000);
}

// ── 세금 ────────────────────────────────────────────────────────────────
//
// ★★ 세제는 2026-09-21에 운용사 원문으로 확인했다(`docs/MANUAL.md` 「ETF 종류별 세금」).
//    금융투자소득세는 2024-12-10에 폐지됐고, 2026-01-01 시행된 고배당기업 배당 분리과세
//    (조특법 §104조의27)는 **ETF 분배금에 적용되지 않는다.**

/**
 * 배당소득세 (소득세 14% + 지방소득세 1.4%).
 *
 * ⚠⚠ **이 파일의 세금은 전부 일반계좌(상품코드 01 위탁) 전제다.** 같은 ETF라도 계좌가
 *    바뀌면 과세가 통째로 달라진다(2026-09-21 `market-researcher`, 조특법·소득세법 원문):
 *    - **ISA** — 해지일에 한꺼번에, 순소득 200만원(서민형 400만원)까지 비과세, 넘는 몫
 *      9.9% 분리과세, **손익통산 된다**, 종합과세에 합산하지 않는다
 *    - **연금저축** — 인출 때까지 과세이연, 55세 이후 연금수령이면 3.3~5.5%, 중도인출 16.5%
 *    지금 시스템은 일반계좌 하나라 맞다. **연금·ISA 계좌를 붙이면 `taxDrag`에 계좌 종류를
 *    넣어야 한다** — 안 넣으면 그 계좌의 20년 세후가 실제보다 크게 나빠 보인다.
 */
export const DIVIDEND_TAX = 0.154;

/**
 * - `domestic` — 매매차익 비과세 · 분배금 15.4%
 * - `holdingPeriod` — 보유기간 과세. 매도 시 `Min(매매차익, 과표증분)` × 15.4%,
 *   분배금 15.4%. 차익이 **판 해의 배당소득**으로 잡힌다
 */
export type EtfTaxType = 'domestic' | 'holdingPeriod';

/**
 * **원문으로 확인한 종목만** 적는다 — 이름으로 짐작하지 않는다.
 *
 * `Instrument`에 과세유형이 없고(`isKrSellTaxExempt` 주석), 네이버 응답에도 없다
 * (`etfBaseIdx` 기초지수만 온다). "미국"이 들어갔으니 기타형이겠지 하고 고르면
 * 커버드콜·혼합형에서 틀린다. 여기 없는 종목의 세후 값은 **모름**이다.
 */
export const CONFIRMED_ETF_TAX: Readonly<Record<string, { type: EtfTaxType; source: string }>> = {
  '069500': { type: 'domestic', source: '삼성자산운용 상품 API "매매차익 : 비과세" (2026-09-21)' },
  '161510': { type: 'domestic', source: '한화 투자설명서 "국내주식형 ETF … 보유기간 과세가 적용되지 않습니다" (2026-02-03 효력)' },
  /*
   * ⚠ 법적 명칭이 「…혼합자산상장지수투자신탁(재간접형)」인데 운용사가 매매차익을
   *   비과세로 적는다. 그 법적 근거는 확인 못 했다 — 운용사 문장만 있다.
   *   리츠 9.9% 분리과세(조특법 §87조의7)는 **대상이 아니다**(부동산집합투자기구가 아니다).
   */
  '329200': { type: 'domestic', source: '미래에셋 상품 페이지 "매매차익은 비과세" (2026-09-21) — 법적 근거 미확인' },
  '360750': { type: 'holdingPeriod', source: '미래에셋 상품 페이지 "Min(매매차익, 과표 증분) X 15.4%" (2026-09-21)' },
  /* ★ KRX 금시장 직접투자의 비과세는 **ETF로 넘어오지 않는다**(투자설명서 비교표). */
  '411060': { type: 'holdingPeriod', source: '한국투자 투자설명서 "배당소득세 과세 / 금융소득종합과세 대상" (2026-02-13 효력)' },
};

/**
 * 배당을 세후로 재투자하며 years년 들고 판다 — **세금이 연 몇 %p를 깎나.**
 *
 * @param growthPct **가격만의** 연 상승률(%) — **원주가**로 낸 값을 넣는다. 수정주가는 ETF
 *   분배금까지 조정해 배당 재투자를 품고 있어, 그걸 넣고 배당을 또 재투자하면 두 번 센다
 *   (2026-09-21 첫 판이 그랬다). 총보수는 원주가에도 이미 들어가 있다
 * @param dividendPct 배당수익률(%). 매년 그 해 가치에 대해 받는다
 *
 * ★ **기타형은 매매차익 전액을 과세 대상으로 본다 — 상한이다.** 실제 과세는
 *   `Min(매매차익, 과표증분)`이고 과표증분은 매매차익을 넘지 않는다. 해외주식만
 *   든 ETF·금현물은 둘이 거의 같아 이 상한이 실제에 가깝다.
 * ★ 종합과세(연 금융소득 2천만원 초과분의 누진)는 **넣지 않는다** — 다른 소득에
 *   달려 있어 여기서 모른다. 대신 `gainPerUnit`을 돌려주어 부르는 쪽이 판 해의
 *   차익 크기를 보고 경고하게 한다.
 */
export function taxDrag(
  growthPct: number, dividendPct: number, years: number, type: EtfTaxType,
): { preTaxCagr: number; afterTaxCagr: number; dragPct: number; gainPerUnit: number } {
  const g = growthPct / 100;
  const d = dividendPct / 100;
  const run = (taxed: boolean): { value: number; basis: number } => {
    let value = 1;
    let basis = 1;
    for (let y = 0; y < years; y += 1) {
      value *= 1 + g;
      const reinvest = value * d * (taxed ? 1 - DIVIDEND_TAX : 1);
      value += reinvest;
      basis += reinvest; // 재투자한 몫은 원가다 — 그 몫까지 차익으로 세면 이중 과세다
    }
    return { value, basis };
  };
  const pre = run(false);
  const post = run(true);
  const gain = Math.max(0, post.value - post.basis);
  const afterSale = type === 'holdingPeriod' ? post.value - gain * DIVIDEND_TAX : post.value;
  const preTaxCagr = (pre.value ** (1 / years) - 1) * 100;
  const afterTaxCagr = (afterSale ** (1 / years) - 1) * 100;
  return { preTaxCagr, afterTaxCagr, dragPct: preTaxCagr - afterTaxCagr, gainPerUnit: gain };
}
