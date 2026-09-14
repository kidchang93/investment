/**
 * 네이버 금융에서 **주요 뉴스**를 받아 온다.
 *
 * ── 왜 여기서 받나 (2026-09-03) ──────────────────────────────────────────
 *
 * 사용자가 *"KIS로 호출하는 건 한계가 있을 것 같으니"*라고 했다. 맞다 —
 * KIS 뉴스는 **제목만** 오고 그나마 시세 나열이 기사로 섞여 온다.
 *
 * 처음에는 Firecrawl·Playwright를 얹으려 했는데 **둘 다 필요 없었다.**
 * 네이버 금융은 **서버 렌더링 정적 HTML**이라 그냥 받으면 된다(2026-09-03 실측:
 * 시황 170KB에 코스피 지수가 그대로, 뉴스 66KB에 제목 20건 + 본문 요약).
 *
 *   Firecrawl    크레딧 비용 — 10분마다 4페이지면 하루 156회
 *   Playwright   브라우저를 띄운다. 무겁고 느리다
 *   ★ 그냥 받기  비용 0 · 의존성 0 · 빠르다
 *
 * **로그인·클릭·스크롤이 필요해지면** 그때 Playwright를 붙인다. 지금은 아니다.
 *
 * ── EUC-KR ───────────────────────────────────────────────────────────────
 *
 * 네이버 금융은 아직 **EUC-KR**이다. 바이트로 받아 우리가 푼다 —
 * `krx/kindDelistings.ts`가 KIND에 쓰는 것과 같은 방식이다.
 * `res.text()`로 받으면 UTF-8로 해석해 한글이 깨진다.
 *
 * ── ★ HTML을 정규식으로 읽는 것에 대해 ──────────────────────────────────
 *
 * 일반적으로는 나쁜 방법이지만, **특정 값 몇 개만 뽑는** 자리에서는 이 레포가
 * 이미 쓰고 있다(KIND 폐지 목록). 파서를 통째로 들이는 것보다 의존성이 없고,
 * **깨지면 조용히 틀리는 게 아니라 값이 안 나온다** — 그때는 `null`이 되고
 * 호출부가 "못 읽었다"고 적는다.
 *
 * 조회 전용이다. 주문을 내지 않는다.
 */

import { decodeEntities, htmlText } from '../htmlText.js';

const BASE = 'https://finance.naver.com';

/**
 * 사람이 쓰는 브라우저인 척한다. 없으면 네이버가 다른 화면을 주거나 막는다.
 * ★ 이건 우회가 아니라 **정상 페이지를 받기 위한 것**이다 — 로그인도, 유료
 *   구역도 아닌 공개 시황 페이지다.
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const decoder = new TextDecoder('euc-kr');

/** 한 페이지를 받아 EUC-KR을 푼다. 실패하면 던진다 — 호출부가 적는다 */
async function fetchPage(path: string): Promise<string> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`네이버 ${path} 실패: HTTP ${res.status}`);
  return decoder.decode(new Uint8Array(await res.arrayBuffer()));
}

// ── 주요 뉴스 ───────────────────────────────────────────────────────────

export interface NaverNews {
  title: string;
  /** 본문 앞부분 요약. **KIS에는 없는 것이고 이것 때문에 네이버를 쓴다** */
  summary: string;
  url: string;
}

/**
 * 주요 뉴스. `/news/mainnews.naver`의 `articleSubject`·`articleSummary`.
 *
 * ★ 요약에는 언론사·시각이 뒤에 붙어 온다("… 머니투데이 2026-09-03 09:12").
 *   그 꼬리를 떼야 읽을 만하다.
 */
export async function getMainNews(limit = 10): Promise<NaverNews[]> {
  const html = await fetchPage('/news/mainnews.naver');
  const out: NaverNews[] = [];
  const blockRe = /<dd class="articleSubject">([\s\S]*?)<\/dd>\s*<dd class="articleSummary">([\s\S]*?)<\/dd>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null && out.length < limit) {
    const hrefMatch = /href="([^"]+)"/.exec(m[1]);
    const title = htmlText(m[1]);
    // 꼬리의 언론사·날짜·시각을 뗀다.
    const summary = htmlText(m[2])
      // "… 머니투데이 | 2026-09-03 09:12" 꼬리를 뗀다. 구분자가 `|`일 때도 없을 때도 있다.
      // 실제 꼬리: "… 머니투데이 | 2026-09-03 09:20:57" — **초까지** 온다.
      // 처음에 `\d{2}:\d{2}`까지만 봐서 한 건도 안 잘렸다.
      // ★ 언론사 이름에 **숫자가 들어간다**("뉴스1"·"채널A"). 처음에 `[가-힣A-Za-z.\s]`로
      //   잡아 "뉴스1 | 2026-09-03 09:22:37"이 그대로 남았다. 숫자를 넣는다.
      .replace(/\.{0,2}\s*[가-힣A-Za-z0-9.\s]{2,20}\s*\|?\s*\d{4}-\d{2}-\d{2}(\s+\d{2}:\d{2}(:\d{2})?)?\s*$/, '…')
      .trim();
    if (!title) continue;
    out.push({
      title,
      summary,
      url: hrefMatch ? `${BASE}${decodeEntities(hrefMatch[1])}` : '',
    });
  }
  return out;
}
