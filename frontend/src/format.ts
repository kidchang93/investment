/**
 * 두 파일 이상이 쓰는 화면 숫자 포맷. 한 파일만 쓰는 것은 그 파일에 둔다.
 *
 * 부호 접두(`n > 0 ? '+' : ''`)를 `Intl.NumberFormat`의 `signDisplay`로 바꾸지
 * 않는다 — 0 근처(`+0.00%` → `0.00%`)·반올림(`1.005`)·자릿수 쉼표에서 출력이 달라진다.
 */

export function formatWon(value: number): string {
  return `${Math.round(value).toLocaleString('ko-KR')}원`;
}

/** 0은 `+0원`으로 적는다(`formatRate`와 달리 `>= 0`) */
export function formatSignedWon(value: number): string {
  return `${value >= 0 ? '+' : ''}${formatWon(value)}`;
}

/** 비율(0.123) → `12.3%` */
export function formatRatio(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

/** `HHMM` 정수 → `HH:MM` */
export function formatHhmm(value: number): string {
  return `${String(Math.floor(value / 100)).padStart(2, '0')}:${String(value % 100).padStart(2, '0')}`;
}

/** 등락률(이미 % 단위) → `+1.23%` */
export function formatRate(n: number): string {
  if (!Number.isFinite(n)) return '-';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export function formatVolume(n: number): string {
  if (!Number.isFinite(n)) return '-';
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}억`;
  if (n >= 10_000) return `${Math.floor(n / 10_000).toLocaleString('ko-KR')}만`;
  /*
   * 거래량은 주식 수라 소수점이 의미 없다. 평균 거래량처럼 나눗셈으로 나온 값이
   * 1만 미만이면 `4,573.842`처럼 소수점 세 자리가 그대로 찍혔다 — 옆 칸들이
   * `54만`, `5만`인데 혼자만 형식이 달랐다.
   */
  return Math.round(n).toLocaleString('ko-KR');
}
