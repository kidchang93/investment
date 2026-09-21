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
 * ★ **배당과 시세차익은 대체로 상충한다.** 첫 실측에서 리츠 ETF가 배당 9.73%인데
 *   가격은 7.2년간 연 2.92%, 최근 4.7년은 연 −1.07%였다. 배당으로 현금을 내보내면
 *   가격에 남는 것이 적다. 그래서 둘을 **같은 자리에 나란히** 둬야 판단이 된다.
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
