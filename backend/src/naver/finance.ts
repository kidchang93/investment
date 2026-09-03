/**
 * 네이버 금융에서 **시황·뉴스·거래대금 상위**를 받아 온다.
 *
 * ── 왜 여기서 받나 (2026-09-03) ──────────────────────────────────────────
 *
 * 사용자가 *"KIS로 호출하는 건 한계가 있을 것 같으니"*라고 했다. 맞다 —
 * KIS 뉴스는 **제목만** 오고 그나마 시세 나열이 기사로 섞여 온다
 * (`newsWatch.ts`가 그것을 걸러야 했다).
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

/**
 * HTML 엔티티를 푼다. 뉴스 제목에 `&quot;`·`&middot;`·`&hellip;`가 그대로 온다.
 * ★ `&amp;`를 **마지막에** 푼다 — 먼저 풀면 `&amp;quot;`가 `"`가 되어 원문이 바뀐다.
 */
function unescapeHtml(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&hellip;/g, '…')
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 태그를 걷어내고 공백을 정리한다 */
function stripTags(html: string): string {
  return unescapeHtml(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** `6,604.81` → `6604.81`. 못 읽으면 `null`(0으로 채우지 않는다) */
function parseNumber(text: string | undefined): number | null {
  if (!text) return null;
  const cleaned = text.replace(/[,\s]/g, '');
  if (!/^[+-]?\d+(\.\d+)?$/.test(cleaned)) return null;
  return Number(cleaned);
}

// ── 시황 ────────────────────────────────────────────────────────────────

export interface IndexQuote {
  name: string;
  /** 현재 지수. 못 읽었으면 `null` */
  value: number | null;
  /** 전일 대비. 부호 포함 */
  change: number | null;
  /** 등락률(%) */
  changeRate: number | null;
}

/**
 * 코스피·코스닥 지수. `/sise/`의 `id="KOSPI_now"` 꼴에서 읽는다.
 *
 * 실제 모양(2026-09-03 실측):
 *
 * ```html
 * <span id="KOSPI_now" class="num ">6,615.71</span>
 * <span id="KOSPI_change" class="num_s ">
 *   <span class="nup"></span>42.09 +0.64%<span class="blind">상승</span>
 * </span>
 * ```
 *
 * ★ **등락률에는 부호가 이미 붙어 있다**(`+0.64%` · `-1.20%`). 처음에 클래스에서
 *   방향을 따로 읽으려다 `null`만 나왔다 — 부호는 숫자에 있고 클래스(`nup`/`ndown`)와
 *   `<span class="blind">상승</span>`은 그것을 되풀이할 뿐이다.
 *
 * ★ **변화량에는 부호가 없다**(`42.09`). 그래서 등락률의 부호를 그것에 옮겨 붙인다.
 */
export async function getIndexQuotes(): Promise<IndexQuote[]> {
  const html = await fetchPage('/sise/');
  const out: IndexQuote[] = [];
  for (const [key, name] of [['KOSPI', '코스피'], ['KOSDAQ', '코스닥']] as const) {
    const now = new RegExp(`id="${key}_now"[^>]*>([^<]+)<`).exec(html);
    const block = new RegExp(`id="${key}_change"[\\s\\S]{0,400}?</span>\\s*</a>`).exec(html);
    const text = block ? stripTags(block[0]) : '';
    // "42.09 +0.64% 상승" — 등락률만 부호를 갖는다.
    const rate = parseNumber(/([+-]?\d+\.\d+)%/.exec(text)?.[1]);
    const changeAbs = parseNumber(/([\d,]+\.?\d*)\s*[+-]?\d/.exec(text)?.[1]);
    const sign = rate !== null && rate < 0 ? -1 : 1;
    out.push({
      name,
      value: parseNumber(now?.[1]),
      change: changeAbs === null ? null : Math.abs(changeAbs) * sign,
      changeRate: rate,
    });
  }
  return out;
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
    const title = stripTags(m[1]);
    // 꼬리의 언론사·날짜·시각을 뗀다.
    const summary = stripTags(m[2])
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
      url: hrefMatch ? `${BASE}${unescapeHtml(hrefMatch[1])}` : '',
    });
  }
  return out;
}

// ── 거래대금 상위 ───────────────────────────────────────────────────────

export interface TurnoverRow {
  rank: number;
  name: string;
  /** 종목코드. 링크에서 읽는다 */
  symbol: string;
  price: number | null;
  changeRate: number | null;
}

/**
 * 거래대금(거래량) 상위. `/sise/sise_quant.naver`.
 *
 * ★ **자금이 어디로 몰리는지**가 이 표의 값어치다. 2026-09-03 아침에 상위가
 *   인버스·레버리지 ETF로 도배돼 있었는데, 그건 "방향에 베팅이 몰렸다"는
 *   신호이지 개별 종목 이야기가 아니다.
 */
export async function getTurnoverTop(limit = 15): Promise<TurnoverRow[]> {
  const html = await fetchPage('/sise/sise_quant.naver');
  const out: TurnoverRow[] = [];
  // 각 줄: <a href="/item/main.naver?code=069500" class="tltle">KODEX 200</a> … 이어서 td들
  /*
   * 실제 모양(2026-09-03 실측) — 셀 사이에 줄바꿈과 중첩 span이 많다:
   *
   * ```html
   * <td><a href="/item/main.naver?code=252670" class="tltle">KODEX 200선물인버스2X</a></td>
   * <td class="number">82</td>                    ← 현재가
   * <td class="number"> … 1 … </td>               ← 전일비(부호 없음)
   * <td class="number"> … -1.20% … </td>          ← 등락률(부호 있음)
   * ```
   *
   * ★ 처음에 `[\s\S]{0,600}?</tr>`로 잡으려다 **한 줄도 못 읽었다** — 셀 안의
   *   빈 줄·주석 때문에 한 행이 600자를 넘는다. 다음 종목 링크 전까지로 끊는다.
   * ★ 등락률에는 부호가 이미 붙어 있다. 클래스에서 방향을 다시 읽지 않는다.
   */
  const rowRe = new RegExp(
    'href="/item/main\\.naver\\?code=([0-9A-Z]{6})"[^>]*class="tltle">([^<]+)</a>'
    + '([\\s\\S]*?)(?=href="/item/main\\.naver\\?code=|</table>)',
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null && out.length < limit) {
    const cells = [...m[3].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => stripTags(c[1]));
    const price = parseNumber(cells[0]);
    const rateCell = cells.find((c) => c.includes('%'));
    const rate = parseNumber(rateCell?.replace('%', '').replace(/\s/g, ''));
    out.push({
      rank: out.length + 1,
      symbol: m[1],
      name: unescapeHtml(m[2]).trim(),
      price,
      changeRate: rate,
    });
  }
  return out;
}
