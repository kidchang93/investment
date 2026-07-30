/**
 * KIS 지수·업종 코드 마스터(`idxcode.mst`) 고정폭 레이아웃.
 *
 * 국내 종목 마스터의 꼬리에는 지수업종이 **코드로만** 들어 있다(`0027`). 사람이 읽는
 * 이름(`제조`)은 이 파일에 있다. 인증이 필요 없는 공개 파일이라 KIS API를 부르지 않는다.
 *
 * backend/.cache 실측(2026-07-31, 파일은 2026-05-21자): 22,586바이트 / 491행 /
 * **모든 행이 45바이트**다. EUC-KR 고정폭이고 레이아웃은
 *
 *   [0,1) 시장구분   [1,5) 지수업종코드   [5,45) 이름
 *
 * 시장구분은 코드 첫 글자와 같다(491행 전부). KOSPI 계열은 `0`, KOSDAQ 계열은 `1`로
 * 시작하므로 같은 `제조`가 KOSPI `0027`·KOSDAQ `1009`로 따로 있다 — **코드를 시장 없이
 * 섞으면 안 된다.**
 *
 * ⚠ **KIS 공식 파이썬 파서(`sector_code.py`)의 이름 자리는 틀렸다.** `tname = row[3:43]`
 * 이라 이름 앞에 코드 뒤 2자리가 붙어 나온다 — `0001`이 `'01종합'`이 된다. 코드 자리
 * (`row[1:5]`)는 맞다. 실제 이름은 `row[5:]`부터이고, 이 레포는 실측으로 확인했다.
 * (`0001` → `종합`, `0013` → `전기·전자`, `1009` → `제조`)
 *
 * 문자 단위로 잘라도 되는 이유: 앞 5바이트가 ASCII라 바이트 수와 글자 수가 같다.
 * 이름만 EUC-KR 2바이트 문자를 포함하는데, 행의 끝까지 읽으므로 폭 계산이 필요 없다.
 */

/** backend/.cache 안의 파일명. 인증 없이 받는 공개 마스터다. */
export const INDEX_SECTOR_MASTER_FILE = 'idxcode.mst';

/** 시장구분 1글자 뒤가 코드다. */
const CODE_OFFSET = 1;
const CODE_LENGTH = 4;

/** 코드 뒤부터 행 끝까지가 이름 필드(40바이트)다. */
const NAME_OFFSET = CODE_OFFSET + CODE_LENGTH;

/** 정렬이 맞으면 코드는 항상 숫자·대문자 4글자다 (`0027`, `E199`, `T000`). */
const CODE_PATTERN = /^[0-9A-Z]{4}$/;

export interface IndexSectorMasterRow {
  /** 지수업종 코드 4자리 */
  code: string;
  /** 지수업종 이름 (뒤 공백 제거) */
  name: string;
}

/**
 * 한 행을 코드·이름으로 나눈다. 개행을 뗀 행을 넘긴다.
 *
 * 이름이 빈 행은 `null`이다 — 실측에서 `9999` 한 행이 그랬다. 이름 없는 코드를
 * 빈 문자열로 담아 두면 종목에 이름 없는 업종이 붙는다.
 *
 * 정렬이 어긋나면 던진다. 한 행이 밀렸다는 것은 파일 전체가 밀렸다는 뜻이라,
 * 조용히 건너뛰면 업종 이름이 통째로 사라진 채 동기화가 끝난다.
 */
export function parseIndexSectorMasterRow(row: string): IndexSectorMasterRow | null {
  const code = row.slice(CODE_OFFSET, CODE_OFFSET + CODE_LENGTH);
  if (!CODE_PATTERN.test(code)) {
    throw new Error(
      `${INDEX_SECTOR_MASTER_FILE}: 코드 자리가 어긋났습니다 (${JSON.stringify(code)}). ` +
        `앞 20글자: ${row.slice(0, 20)}`,
    );
  }

  const name = row.slice(NAME_OFFSET).trim();
  return name ? { code, name } : null;
}

/**
 * 파일 전체를 `코드 → 이름` 표로 만든다.
 *
 * 같은 코드가 두 번 나오면 던진다. 실측에서는 491행 모두 코드가 유일했고,
 * 중복이 생겼다는 것은 파일 형식이 바뀌었다는 뜻이다.
 */
export function parseIndexSectorNames(text: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const row of text.split(/\r?\n/)) {
    if (!row.trim()) continue;
    const parsed = parseIndexSectorMasterRow(row);
    if (!parsed) continue;
    if (names.has(parsed.code)) {
      throw new Error(
        `${INDEX_SECTOR_MASTER_FILE}: 같은 코드가 두 번 나옵니다 ` +
          `(${parsed.code}: ${names.get(parsed.code)} / ${parsed.name}).`,
      );
    }
    names.set(parsed.code, parsed.name);
  }
  return names;
}
