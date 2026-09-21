/**
 * **오늘·내일 배당락일 종목** — 미리 알 수 없어 과거 패턴으로 추정한다.
 *
 * ── 왜 생겼나 (2026-09-21) ───────────────────────────────────────────────
 *
 * 배당락일에는 가격이 배당만큼 **기계적으로** 빠진다(원주가 실측: ETF 낙폭비율 0.76~1.08,
 * `scripts/measureExDividend.ts`). 리츠는 매달 0.75%다. 분석가·판단자가 그 하락을 "급락"으로
 * 읽으면 멀쩡한 자리를 판다 — 사용자가 짚은 *"폭락 시그널"*과 가려야 한다.
 *
 * ── 왜 추정인가 ───────────────────────────────────────────────────────────
 *
 * **다음 기준일은 어디서도 미리 나오지 않는다.** KIS 예탁원 배당일정은 기준일이 지난 뒤에야
 * 조회되고(2026-09-21에 9/1~12/31을 물으니 보유 5종목 모두 0건), 네이버에도 분배 예고가 없다.
 * 대신 보유 종목의 과거 기준일이 **전부 그 달 마지막 개장일**이었다
 * (8/31·7/31·6/30·5/29·4/30·3/31·2/27·1/30·12/30 — 주말·12/31 휴장을 비켜 간다).
 * 그래서 "이 종목이 배당하던 달이면, 이달 마지막 개장일이 기준일이고 그 직전 개장일이
 * 배당락일"로 본다. **추정이라고 적는다.**
 *
 * ★ 결제가 T+2라 기준일 직전 개장일이 배당락일이다 — 그 전날까지 사야 기준일에 주주다.
 * ★ 과거 기준일이 월말(20일 이후)이 아니었던 종목은 **추정하지 않는다** — 월 중 기준일이면
 *   이 규칙이 틀린다.
 */
import type { DividendRecord } from '@invest/shared';

export interface MonthEndPayer {
  /** 배당하던 달(1~12) */
  months: Set<number>;
  /** 가장 최근 주당 배당금 — 다음 배당의 추정값 */
  lastAmount: number;
}

/**
 * 과거 13개월 기준일로 "월말형 배당"인지 본다. 아니면 `undefined` — 추정하지 않는다.
 *
 * 13개월인 이유: 연 1회 배당도 한 번은 들어오고, 분기·월배당의 달 집합이 다 드러난다.
 */
export function monthEndPayer(records: DividendRecord[], asOf: string): MonthEndPayer | undefined {
  const from = `${Number(asOf.slice(0, 4)) - 1}${asOf.slice(4, 6)}01`;
  const recent = records.filter((r) => r.recordDate >= from && r.recordDate <= asOf && r.amountPerShare > 0);
  if (recent.length === 0) return undefined;
  // 한 건이라도 월 중(20일 전) 기준일이면 월말 규칙을 쓸 수 없다.
  if (recent.some((r) => Number(r.recordDate.slice(6, 8)) < 20)) return undefined;
  const latest = recent.reduce((a, b) => (a.recordDate > b.recordDate ? a : b));
  return { months: new Set(recent.map((r) => Number(r.recordDate.slice(4, 6)))), lastAmount: latest.amountPerShare };
}

/**
 * 이달 배당락일 — 이달 마지막 개장일의 **직전** 개장일.
 *
 * @param openDays 이달 개장일(`YYYYMMDD`) 오름차순. 부르는 쪽이 개장일 조회로 채운다
 */
export function exDividendDayOf(openDays: string[]): string | undefined {
  return openDays.length >= 2 ? openDays[openDays.length - 2] : undefined;
}
