/**
 * KIS 테마 코드 마스터(`theme_code.mst`) 고정폭 레이아웃.
 *
 * 종목 마스터의 지수업종에는 `반도체`라는 칸이 없다. 테마가 그걸 가르는 유일한
 * 공개 자료다. 인증이 필요 없는 공개 파일이라 KIS API를 부르지 않는다.
 *
 * backend/.cache 실측(2026-07-31, 파일은 2025-11-06자): 292,984바이트 / 5,528행 /
 * **모든 행이 52바이트**, 개행은 `\n`만(CR 0개). EUC-KR 고정폭이고 레이아웃은
 *
 *   [0,3) 테마코드   [3,43) 테마명(40바이트)   [43,52) 단축코드(9바이트)
 *
 * 302개 테마 · 고유 종목 2,333개 · (테마,종목) 쌍 5,528개(중복 0). 한 종목에 테마가
 * 여러 개 붙는다 — 삼성전자 16개가 최대이고 평균 2.37개다.
 *
 * ## 바이트가 아니라 글자로 잘라도 되는 이유
 *
 * EUC-KR 한글은 2바이트인데 자바스크립트 문자열은 1글자다. 그래서 **고정폭 파일을
 * 글자 수로 자르면 한글 뒤의 자리가 전부 어긋난다.** 실제로 이 파일도 행마다 글자
 * 수가 43~52로 다르다(바이트는 전부 52).
 *
 * 그런데 여기서는 우연히 안전하다. 자르는 자리가 둘 다 **ASCII 구간에 있고, 그
 * 구간의 바깥쪽 끝에서 재기 때문**이다.
 *   - 테마코드는 숫자 3글자라 **앞에서** 세면 3글자 = 3바이트.
 *   - 단축코드 필드는 `[0-9A-Z]` 6글자 + 공백 3개로 전부 ASCII라 **뒤에서** 세면
 *     9글자 = 9바이트.
 *   - 남은 가운데가 테마명이고, 한글은 여기에만 있으므로 폭을 셀 필요가 없다.
 * 5,528행 전부에서 바이트 슬라이스와 글자 슬라이스 결과가 같음을 실측으로 확인했다.
 *
 * **앞에서 43글자를 세면 안 된다.** 그건 ASCII 구간이 아니라 한글이 든 테마명을
 * 지나가는 자리라 행마다 다른 곳을 가리킨다.
 *
 * ⚠ **KIS 공식 파이썬 파서(`theme_code.py`)의 `row[-10:]`을 그대로 옮기면 안 된다.**
 * 그 `10`은 `9 + 개행 1`이다 — 파이썬의 `for row in f`가 주는 row에는 줄 끝 개행이
 * 들어 있어서, **공식 파서도 실제로는 `[0,3) / [3,43) / [43,52)`로 자른다. 상수 자체는
 * 우리와 같다.** `domesticMaster.ts`의 꼬리(228 = 227 + 개행)와 정확히 같은 −1이다.
 *
 * 개행을 뗀 뒤 10을 세면 한 칸 밀린다. 지금은 테마명이 최대 24바이트뿐이라 그 자리가
 * 늘 공백이라 티가 안 나지만, 테마명이 40바이트를 채우고 한글로 끝나는 날 종목코드가
 * `버005930   `이 되고 이름은 `버`를 잃는다.
 *
 * 9를 쓰는 실익이 하나 더 있다. 공식 파서는 **마지막 줄에 개행이 없으면** 깨진다
 * (`row[-10:]`이 `' 005930   '`이 되고 `rstrip()` 뒤에도 앞 공백이 남는다). 지금 파일은
 * LF 5,528개에 잔여 0바이트라 해당 없지만, 개행을 떼고 뒤에서 9를 세는 우리 파서는
 * 그 경우에도 안전하다.
 *
 * ## 이 파일은 낡는다
 *
 * zip은 매일 재포장되지만 내용은 갱신되지 않는다. 2026-07-31에 받은 파일의 내부
 * 타임스탬프가 2025-11-06이었고, 테마 이름에 `2018 신규 상장주`~`2024 신규 상장주`는
 * 있어도 **2025·2026은 없다.** 낡음을 재는 값은 두 가지다.
 *   1. 파일의 수정 시각(= zip 내부 타임스탬프). 유일한 절대 기준일이다.
 *   2. 테마에 나오는 2,333종목 중 오늘자 종목 마스터에 없는 수 —
 *      2026-07-31 실측 218종목(쌍으로는 425/5,528).
 * 둘 다 DB에 남겨 화면이 "지금 반도체 테마"라고 거짓말하지 않게 한다.
 *
 * ETF에는 테마가 붙지 않는다 (2026-07-31 실측: 오늘자 마스터의 ETF 1,145종목 중
 * 테마가 있는 것 0건). 테마 화면에 ETF가 안 보이는 것은 결함이 아니다.
 */

/** backend/.cache 안의 파일명. 인증 없이 받는 공개 마스터다. */
export const THEME_MASTER_FILE = 'theme_code.mst';

/** 테마코드는 행 맨 앞 3글자다. 숫자 3자리라 앞에서 세도 바이트와 어긋나지 않는다. */
const THEME_CODE_LENGTH = 3;

/**
 * 단축코드 필드 폭(바이트). 종목 마스터의 단축코드와 같은 9바이트 필드이고
 * 실측에서는 6글자 코드 + 공백 3개로 채워 왔다.
 * 공식 파서의 `10`은 여기에 개행 1글자를 더한 값이다 — 위 주석 참고.
 */
const SYMBOL_FIELD_LENGTH = 9;

/** 테마명 필드 폭(바이트). 실측 최대는 24바이트라 늘 여유가 있다. */
const THEME_NAME_FIELD_BYTES = 40;

/** 테마명이 가질 수 있는 글자 수 범위. 전부 한글(2바이트)이면 20, 전부 ASCII면 40. */
const THEME_NAME_MIN_CHARS = THEME_NAME_FIELD_BYTES / 2;
const THEME_NAME_MAX_CHARS = THEME_NAME_FIELD_BYTES;

/** 행 전체가 가질 수 있는 글자 수 범위. 실측은 43~52였다(바이트는 전부 52). */
const ROW_MIN_CHARS = THEME_CODE_LENGTH + THEME_NAME_MIN_CHARS + SYMBOL_FIELD_LENGTH;
const ROW_MAX_CHARS = THEME_CODE_LENGTH + THEME_NAME_MAX_CHARS + SYMBOL_FIELD_LENGTH;

/** 정렬이 맞으면 테마코드는 항상 숫자 3자리다 (`004`, `017`, `172`). */
const THEME_CODE_PATTERN = /^\d{3}$/;

/**
 * 단축코드 필드 **원본**의 모양. 코드 6글자 뒤에 공백 3개다.
 *
 * `.trim()`한 값이 아니라 자른 그대로를 검사하는 것이 요점이다. 한 칸 왼쪽으로
 * 밀면(공식 파서의 10) `' 027360   '`이 되는데, 이건 trim하면 멀쩡한 6자리
 * 종목코드라 형식 검사를 그대로 통과한다. 앞 글자가 공백인지까지 봐야 걸린다.
 */
const SYMBOL_FIELD_PATTERN = /^[0-9A-Z]{6} {3}$/;

/** 마스터 한 행: 어떤 테마에 어떤 종목이 들어 있다 */
export interface ThemeMasterRow {
  /** 테마코드 3자리 */
  themeCode: string;
  /** 테마 이름 (뒤 공백 제거) */
  themeName: string;
  /** 단축종목코드 6자리 */
  symbol: string;
}

/** 파일 전체를 테마 표와 (테마,종목) 쌍으로 나눈 것 */
export interface ThemeMaster {
  /** 테마코드 → 이름. 실측 302개 */
  names: Map<string, string>;
  /** (테마,종목) 쌍. 실측 5,528개이고 중복이 없다 */
  members: ThemeMasterRow[];
}

/**
 * 한 행을 테마코드·테마명·종목코드로 나눈다. 개행을 뗀 행을 넘긴다.
 *
 * 정렬이 어긋나면 `null`을 돌려주지 않고 **던진다.** 한 행이 밀렸다는 것은 파일
 * 전체가 밀렸다는 뜻이라, 조용히 건너뛰면 엉뚱한 종목이 테마에 담긴 채 끝난다.
 */
export function parseThemeMasterRow(row: string): ThemeMasterRow {
  if (row.length < ROW_MIN_CHARS || row.length > ROW_MAX_CHARS) {
    throw new Error(
      `${THEME_MASTER_FILE}: 행 길이가 고정폭과 맞지 않습니다 ` +
        `(${row.length}글자, 허용 ${ROW_MIN_CHARS}~${ROW_MAX_CHARS}). 앞 20글자: ${row.slice(0, 20)}`,
    );
  }

  const themeCode = row.slice(0, THEME_CODE_LENGTH);
  if (!THEME_CODE_PATTERN.test(themeCode)) {
    throw new Error(
      `${THEME_MASTER_FILE}: 테마코드 자리가 어긋났습니다 (${JSON.stringify(themeCode)}, 숫자 3자리여야 합니다). ` +
        `앞 20글자: ${row.slice(0, 20)}`,
    );
  }

  // 종목코드는 **뒤에서** 잰다. 앞에서 43글자를 세면 한글이 든 테마명을 지나가서
  // 행마다 다른 자리를 가리킨다.
  const symbolFieldStart = row.length - SYMBOL_FIELD_LENGTH;
  const symbolField = row.slice(symbolFieldStart);
  if (!SYMBOL_FIELD_PATTERN.test(symbolField)) {
    throw new Error(
      `${THEME_MASTER_FILE}: 단축코드 자리가 어긋났습니다 (${JSON.stringify(symbolField)}). ` +
        `앞 20글자: ${row.slice(0, 20)}`,
    );
  }

  const themeName = row.slice(THEME_CODE_LENGTH, symbolFieldStart).trim();
  if (!themeName) {
    throw new Error(
      `${THEME_MASTER_FILE}: 테마 이름이 비었습니다 (테마 ${themeCode}). 앞 20글자: ${row.slice(0, 20)}`,
    );
  }

  return { themeCode, themeName, symbol: symbolField.trim() };
}

/**
 * 파일 전체를 읽어 테마 표와 쌍 목록을 만든다.
 *
 * 같은 테마코드에 다른 이름이 붙거나 같은 (테마,종목) 쌍이 두 번 나오면 던진다.
 * 실측 5,528행에서 둘 다 0건이었고, 생겼다는 것은 파일 형식이 바뀌었다는 뜻이다.
 */
export function parseThemeMaster(text: string): ThemeMaster {
  const names = new Map<string, string>();
  const members: ThemeMasterRow[] = [];
  const seen = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = parseThemeMasterRow(line);

    const known = names.get(row.themeCode);
    if (known !== undefined && known !== row.themeName) {
      throw new Error(
        `${THEME_MASTER_FILE}: 같은 테마코드에 이름이 둘입니다 ` +
          `(${row.themeCode}: ${known} / ${row.themeName}).`,
      );
    }
    names.set(row.themeCode, row.themeName);

    const key = `${row.themeCode}|${row.symbol}`;
    if (seen.has(key)) {
      throw new Error(
        `${THEME_MASTER_FILE}: 같은 (테마,종목) 쌍이 두 번 나옵니다 ` +
          `(${row.themeCode} ${row.themeName} / ${row.symbol}).`,
      );
    }
    seen.add(key);
    members.push(row);
  }

  return { names, members };
}

/** 테마별 종목 수. 실측 반도체/반도체장비 110 · 방위산업 27 · 농업 26 */
export function countThemeMembers(master: ThemeMaster): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of master.members) {
    counts.set(row.themeCode, (counts.get(row.themeCode) ?? 0) + 1);
  }
  return counts;
}

/** 테마에 등장하는 고유 종목코드. 실측 2,333개 */
export function themeMasterSymbols(master: ThemeMaster): string[] {
  return [...new Set(master.members.map((row) => row.symbol))];
}
