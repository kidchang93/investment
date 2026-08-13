/**
 * KRX KIND 상장폐지 목록 — 받아 오기와 파싱.
 *
 * ── 왜 필요한가 (2026-08-13) ─────────────────────────────────────────────
 *
 * 일봉 저장소의 21년 패널 3,923종목에 **상장폐지가 사실상 0건**이었다. 유니버스가
 * `instruments.is_active = true`로 걸러지는데 그 표는 **오늘자 마스터 스냅샷**이라,
 * 폐지된 회사는 애초에 들어올 자리가 없다. KIND 목록과 대조한 연도별 누락률은
 * 2005년 **35.2%** · 2010년 26.4% · 2018년 8.8% · 전체 23.2%다.
 *
 * ★ 이게 왜 치명적인가: walk-forward가 15창 전부 `reversal5`(최근 5일 낙폭 상위)를
 * 골랐는데, **폐지로 간 회사는 마지막 몇 달을 정확히 그 자리에서 보낸다.** 되돌아오지
 * 못한 것만 골라 지운 표본에서 반전을 잰 셈이다.
 *
 * ── 이 출처에 대해 확인한 것 (2026-08-13 실측) ───────────────────────────
 *
 * - **로그인도 키도 필요 없다.** `POST` 한 번에 HTTP 200 · 376KB가 온다.
 * - 확장자는 `.xls`지만 **내용은 EUC-KR HTML `<table>`**이다. 엑셀 바이너리가 아니다.
 * - 2005-01-01 ~ 2026-08-13 전체가 **1,267행**. `marketType`을 나눠 받으면
 *   유가 306 · 코스닥 765 · 코넥스 196 = 1,267로 합이 맞는다.
 * - **전체 목록에는 시장 구분 열이 없다.** 그래서 시장을 알려면 3회를 더 받아
 *   붙이는 수밖에 없다.
 *
 * ── 이 목록이 말하지 않는 것 ─────────────────────────────────────────────
 *
 * **"폐지일자"는 거래가 끝난 날이 아니다.** 012210(삼미금속)은 2025-12-29 폐지로
 * 적혀 있는데 일봉은 오늘(2026-08-13)까지 이어진다 — 형식적 변경상장으로 보인다.
 * 그래서 이 목록만 보고 계열을 끊지 않는다. 판정은 봉이 한다.
 *
 * 같은 코드가 여러 번 나오는 것도 정상이다(재상장·코드 재사용). 7개 코드가 그렇다.
 */

/** 조회 폼이 걸린 곳. 인증이 없으므로 `config.ts` 분기 대상이 아니다. */
export const KIND_DELISTING_URL = 'https://kind.krx.co.kr/investwarn/delcompany.do';

/** KIND `marketType` 코드. 비워 보내면 전체다 — 그 응답에는 시장 열이 없다. */
export const KIND_MARKET_TYPES: ReadonlyArray<{ code: string; market: string }> = [
  { code: '1', market: 'KOSPI' },
  { code: '2', market: 'KOSDAQ' },
  { code: '6', market: 'KONEX' },
];

/** 376KB 한 방이라 넉넉하다. 응답이 없으면 매달리지 않고 던진다. */
const REQUEST_TIMEOUT_MS = 30_000;

/** 표 머리글. 열 순서가 바뀌면 값이 조용히 어긋나므로 **여기서 던진다.** */
const EXPECTED_HEADER = ['번호', '회사명', '종목코드', '폐지일자', '폐지사유', '비고'] as const;

const decoder = new TextDecoder('euc-kr');

/** 상장폐지 한 건. 이 표가 말하는 사실만 담는다 — 거래가 언제 끝났는지는 봉이 안다. */
export interface DelistingRecord {
  /** 6자리 단축코드 */
  symbol: string;
  /** 폐지 당시 회사명. 지금 마스터의 이름과 다를 수 있다 */
  name: string;
  /** 폐지일자 `YYYYMMDD` */
  delistedOn: string;
  reason: string;
  /** 비고. 빈 칸이 대부분이라 없으면 `null`이다 — 빈 문자열로 채우지 않는다 */
  note: string | null;
  /**
   * `KOSPI` · `KOSDAQ` · `KONEX`. **전체 목록에는 없는 값**이라 시장별 목록을
   * 따로 받아 붙인 것이고, 못 붙였으면 `null`이다 — 짐작해서 채우지 않는다.
   */
  market: string | null;
}

/** 시장별 목록까지 합쳐 받은 결과. **몇 개를 못 붙였는지**가 함께 나온다. */
export interface DelistingFetchResult {
  records: DelistingRecord[];
  /** 전체 목록의 행 수. `records.length`와 다르면 같은 (코드, 폐지일)이 겹쳐 접힌 것이다 */
  totalRows: number;
  /** 시장별로 받은 행 수 */
  byMarket: Array<{ market: string; rows: number }>;
  /** 시장을 못 붙인 건수. 전체 목록에만 있고 시장별 목록 어디에도 없던 것들 */
  marketUnknown: number;
  /** 시장별 목록에만 있고 전체 목록에는 없던 건수. 0이 아니면 목록이 어긋난 것이다 */
  marketOnly: number;
}

/**
 * HTML `<table>`을 줄로 바꾼다. **머리글 열 순서를 확인하고 나서 읽는다.**
 *
 * 형식이 바뀌면 값을 돌려주지 말고 던져야 한다 — 열이 한 칸 밀리면 폐지사유가
 * 종목코드 자리에 들어가고, 그건 형식 검사로는 안 걸린다.
 */
export function parseDelistingTable(html: string): DelistingRecord[] {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
  if (rows.length === 0) throw new Error('KIND 상장폐지 목록에 <tr>이 하나도 없습니다 (형식이 바뀌었습니다)');

  let headerSeen = false;
  const records: DelistingRecord[] = [];

  for (const row of rows) {
    const headerCells = [...row.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => cellText(m[1]));
    if (headerCells.length > 0) {
      assertHeader(headerCells);
      headerSeen = true;
      continue;
    }

    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cellText(m[1]));
    if (cells.length === 0) continue;
    if (cells.length !== EXPECTED_HEADER.length) {
      throw new Error(`KIND 상장폐지 목록의 열 수가 ${EXPECTED_HEADER.length}이 아닙니다: ${cells.join(' | ')}`);
    }
    const [, name, symbol, delistedOn, reason, note] = cells;
    if (!/^[0-9A-Z]{6}$/.test(symbol)) {
      throw new Error(`KIND 상장폐지 목록의 종목코드 자리가 6자리가 아닙니다: ${cells.join(' | ')}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(delistedOn)) {
      throw new Error(`KIND 상장폐지 목록의 폐지일자 형식이 다릅니다: ${cells.join(' | ')}`);
    }
    records.push({
      symbol,
      name,
      delistedOn: delistedOn.replace(/-/g, ''),
      reason,
      note: note === '' ? null : note,
      market: null,
    });
  }

  if (!headerSeen) throw new Error('KIND 상장폐지 목록에 머리글 행이 없습니다 (형식이 바뀌었습니다)');
  return records;
}

function assertHeader(cells: string[]): void {
  const same = cells.length === EXPECTED_HEADER.length
    && EXPECTED_HEADER.every((expected, index) => cells[index] === expected);
  if (!same) {
    throw new Error(
      `KIND 상장폐지 목록의 머리글이 바뀌었습니다: 받은 것 [${cells.join(', ')}]`
      + ` · 아는 것 [${EXPECTED_HEADER.join(', ')}]`,
    );
  }
}

/** 칸 하나에서 글자만 남긴다. 태그를 지우고 실체참조를 되돌린 뒤 공백을 하나로 만든다. */
function cellText(cell: string): string {
  return decodeEntities(cell.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** KIND가 실제로 쓰는 것들만 되돌린다. 숫자 참조(`&#39;`)도 온다. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    // `&amp;`는 마지막이다 — 먼저 풀면 `&amp;lt;`가 `<`가 된다.
    .replace(/&amp;/g, '&');
}

/**
 * 전체 목록에 시장 구분을 붙인다. **짝은 (코드, 폐지일)**이다.
 *
 * 코드만으로 맞추면 재상장 코드에서 옛 에피소드에 새 시장이 붙는다.
 */
export function attachMarkets(
  all: DelistingRecord[],
  byMarket: Array<{ market: string; records: DelistingRecord[] }>,
): { records: DelistingRecord[]; marketUnknown: number; marketOnly: number } {
  const marketOf = new Map<string, string>();
  for (const group of byMarket) {
    for (const record of group.records) marketOf.set(keyOf(record), group.market);
  }
  const seen = new Set<string>();
  const records = all.map((record) => {
    const key = keyOf(record);
    seen.add(key);
    return { ...record, market: marketOf.get(key) ?? null };
  });
  return {
    records,
    marketUnknown: records.filter((record) => record.market === null).length,
    marketOnly: [...marketOf.keys()].filter((key) => !seen.has(key)).length,
  };
}

function keyOf(record: DelistingRecord): string {
  return `${record.symbol}|${record.delistedOn}`;
}

/**
 * 같은 (코드, 폐지일)이 두 번 오면 하나로 접는다.
 *
 * 접힌 건수는 부른 쪽이 `원본 행 − 결과 행`으로 센다(`DelistingFetchResult.totalRows`).
 * 조용히 지우면 목록 행 수와 저장 건수가 다른 이유를 알 수 없다.
 */
export function dedupeDelistings(records: DelistingRecord[]): DelistingRecord[] {
  const byKey = new Map<string, DelistingRecord>();
  for (const record of records) {
    const key = keyOf(record);
    if (!byKey.has(key)) byKey.set(key, record);
  }
  return [...byKey.values()];
}

/** `YYYYMMDD` → KIND가 받는 `YYYY-MM-DD`. */
export function toKindDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** 목록 한 벌을 받아 온다. EUC-KR로 오므로 **바이트로 받아 우리가 푼다.** */
export async function fetchDelistingHtml(
  fromDay: string,
  toDay: string,
  marketType = '',
): Promise<string> {
  const body = new URLSearchParams({
    method: 'searchDelCompanySub',
    forward: 'delcompany_down',
    // 한 번에 다 받는다. 페이지를 나누면 그 사이에 목록이 바뀔 수 있다.
    currentPageSize: '3000',
    pageIndex: '1',
    marketType,
    fromDate: toKindDate(fromDay),
    toDate: toKindDate(toDay),
  });
  const response = await fetch(KIND_DELISTING_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`KIND 상장폐지 목록 요청이 실패했습니다: HTTP ${response.status}`);
  }
  return decoder.decode(new Uint8Array(await response.arrayBuffer()));
}

/**
 * 전체 + 시장별 3벌을 받아 합친다. **KIS와 무관하다** — 토큰도 앱키도 쓰지 않는다.
 */
export async function fetchDelistings(fromDay: string, toDay: string): Promise<DelistingFetchResult> {
  const parsed = parseDelistingTable(await fetchDelistingHtml(fromDay, toDay));
  const all = dedupeDelistings(parsed);
  const groups: Array<{ market: string; records: DelistingRecord[] }> = [];
  for (const { code, market } of KIND_MARKET_TYPES) {
    const records = dedupeDelistings(parseDelistingTable(await fetchDelistingHtml(fromDay, toDay, code)));
    groups.push({ market, records });
  }
  const attached = attachMarkets(all, groups);
  return {
    records: attached.records,
    totalRows: parsed.length,
    byMarket: groups.map((group) => ({ market: group.market, rows: group.records.length })),
    marketUnknown: attached.marketUnknown,
    marketOnly: attached.marketOnly,
  };
}
