/**
 * HTML 조각 → 글자. 네이버 금융(`naver/finance.ts`)과 KIND(`krx/kindDelistings.ts`)가 같이 쓴다.
 *
 * 둘 다 정규식으로 **특정 값 몇 개만** 뽑는 자리라 파서를 들이지 않았다. 각자 엔티티
 * 목록을 따로 들고 있던 동안 한쪽에만 있는 엔티티가 다른 쪽에서 날것으로 남았다 —
 * 목록은 두 곳에서 실제로 본 것의 합집합이다.
 */

/**
 * 실체참조를 되돌린다. 숫자 참조(`&#39;`·`&#039;`)도 온다.
 * ★ `&amp;`를 **마지막에** 푼다 — 먼저 풀면 `&amp;lt;`가 `<`가 되어 원문이 바뀐다.
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&middot;/g, '·')
    .replace(/&hellip;/g, '…')
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 태그를 걷어내고 실체참조를 되돌린 뒤 공백을 하나로 만든다 */
export function htmlText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
