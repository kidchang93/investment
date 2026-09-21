/**
 * 배당을 수익률로 바꾸는 순수 함수들.
 *
 * ★★ **"모른다"와 "0"을 가른다.** 예탁원 배당일정(`HHKDB669102C0`)은 정상 응답의
 *    모습으로 **빈 결과를 돌려줄 때가 있다** — 2026-09-21에 `329200` TIGER 리츠부동산
 *    인프라가 두 번 연속 0건이었다가 세 번째에 24건(연 396원, 9.7%)을 줬다.
 *    그 빈 응답을 "배당 없음"으로 읽었다면 1,099만원짜리 자리를 **9.7%에서 0%로**
 *    잘못 평가한다. 그래서 **레코드가 하나도 없으면 `undefined`**를 돌려주고,
 *    진짜 0원인 종목(`411060` ACE KRX금현물은 주당 1원짜리 한 건이 실제로 있다)과
 *    구분한다. 화면·표에서 그것은 `0%`가 아니라 `—`로 나와야 한다.
 *
 * ★ 주당 배당금만 쓴다. KIS의 `divi_rate`는 **액면가 대비** 비율이라
 *   (삼성전자우가 `374.00`으로 온다) 수익률이 아니다 — `kis/rest.ts` 주석 참고.
 */
import type { DividendRecord } from '@invest/shared';

/** `YYYYMMDD`에서 days일 뺀 `YYYYMMDD`. 배당 기준일 비교는 문자열로 족하다. */
function ymdDaysBefore(ymd: string, days: number): string {
  const t = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
  return new Date(t - days * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * 최근 1년(기준일 기준) 주당 배당금 합계.
 *
 * ★ **아직 오지 않은 기준일은 뺀다.** 과거 실적으로 앞을 가늠하는 값이므로,
 *   미리 공시된 다음 배당이 섞이면 한 해에 다섯 번을 센 값이 된다.
 *
 * @returns 레코드가 하나도 없으면 `undefined` — **"배당 없음"이 아니라 "모름"이다**
 */
export function trailingDividendPerShare(
  records: DividendRecord[],
  asOf: string,
  days = 365,
): number | undefined {
  if (records.length === 0) return undefined;
  const from = ymdDaysBefore(asOf, days);
  const inWindow = records.filter((r) => r.recordDate > from && r.recordDate <= asOf);
  // 창 안에 하나도 없으면 1년 넘게 배당이 끊긴 것이다 — 그건 0으로 아는 사실이다.
  return inWindow.reduce((sum, r) => sum + r.amountPerShare, 0);
}

/** 배당수익률(%) = 주당 배당금 / 현재가 × 100. 어느 한쪽이 없거나 가격이 0이면 `undefined`. */
export function dividendYield(perShare: number | undefined, price: number | undefined): number | undefined {
  if (perShare === undefined || price === undefined || price <= 0) return undefined;
  return (perShare / price) * 100;
}
