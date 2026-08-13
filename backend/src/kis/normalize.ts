/**
 * KIS 원본 문자열 → 우리 숫자·부호.
 *
 * `rest.ts`와 `multiQuote.ts`가 같은 규칙으로 값을 좁혀야 해서 한곳에 모았다.
 * 특히 **부호 규약은 TR이 달라도 같다** — `1`=상한 `2`=상승 `3`=보합 `4`=하한 `5`=하락.
 * 파일마다 따로 적어 두면 한쪽만 고쳤을 때 같은 값이 두 화면에서 다른 색으로 나온다.
 *
 * 여기 있는 것은 전부 순수 함수다. 네트워크도 설정도 건드리지 않는다.
 */

import type { PriceSign } from '@invest/shared';

/** KIS는 숫자에 천단위 쉼표를 섞어 주는 필드가 있다. */
export function toNumber(value: string | undefined): number {
  return Number(value?.replace(/,/g, ''));
}

/**
 * 값이 없는 자리를 0으로 읽지 않는다.
 *
 * **`Number('')`은 0이다.** KIS는 값이 없는 자리에 빈 문자열을 주므로
 * `toNumber`를 그대로 쓰면 "값 없음"이 "0"이 된다. 멀티시세는 없는 종목코드를
 * **전 필드가 빈 문자열인 행**으로 돌려주기 때문에 이 차이가 그대로 드러난다 —
 * 거래대금이 0으로 잡히면 "오늘 한 주도 안 거래됐다"는 사실이 되어 버린다.
 */
export function toNumberOrNaN(value: string | undefined): number {
  const text = value?.trim();
  if (!text) return Number.NaN;
  return toNumber(text);
}

/**
 * 값이 없으면 `null`. **"값 없음"과 "0"을 가르는 것이 이 함수의 일이다.**
 *
 * ── 왜 `toNumber`로 짜면 안 되나 (2026-08-13) ──────────────────────────────
 *
 * 예전에는 `rest.ts` 안에서 `toNumber`로 짜여 있었다. 그런데 `Number('')`은 0이라
 * **빈 문자열이 `null`이 아니라 0으로 나왔다** — 이름이 `optionalNumber`인데 정작
 * 없는 값을 걸러내지 못했다. KIS는 값이 없는 자리에 빈 문자열을 주므로 그대로 두면
 * "값 없음"이 "0원"이 된다. `toNumberOrNaN`이 그래서 있고, 여기가 그것을 쓴다.
 *
 * 갈라지는 자리:
 * - `''` · `'   '` · `undefined` → `null` (값이 없다)
 * - `'0'` · `'0.00'` → `0` (**진짜 0이다. 그대로 0으로 남는다**)
 * - `'-'` · `'abc'` → `null` (숫자가 아니다)
 *
 * 부르는 쪽에서 `?? 0`으로 받으면 이 구분은 다시 사라진다. 필드가 `number | undefined`인
 * 자리는 `?? undefined`로 받아 없는 것을 없다고 말한다.
 */
export function optionalNumber(value: string | undefined): number | null {
  const n = toNumberOrNaN(value);
  return Number.isFinite(n) ? n : null;
}

export function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * 전일 대비 부호. 모르는 값은 보합(`3`)으로 둔다.
 * 색으로 바뀌는 값이라 상승/하락 어느 쪽으로도 넘겨짚지 않는다.
 */
export function parseSign(value: string | undefined): PriceSign {
  if (value === '1' || value === '2' || value === '3' || value === '4' || value === '5') {
    return value;
  }
  return '3';
}
