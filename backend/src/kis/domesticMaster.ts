/**
 * KIS 국내 종목 마스터(.mst) 고정폭 레이아웃.
 *
 * 파일은 EUC-KR **고정폭**이라 한 행의 바이트 수가 시장마다 하나로 정해져 있다.
 * 앞쪽 61바이트는 세 시장이 같고(단축코드 9 + 표준코드 12 + 한글종목명 40),
 * 그 뒤에 붙는 꼬리(고정폭 필드 묶음)의 길이만 다르다.
 *
 *   [0,9)  단축코드   [9,21) 표준코드   [21,61) 한글종목명   [61,행끝) 꼬리
 *
 * backend/.cache 실측(2026-07-31, 파일은 2026-07-30자):
 *   kospi_code.mst  2,570행이 **전부** 288바이트 → 꼬리 288 − 61 = 227
 *   kosdaq_code.mst 1,823행이 **전부** 282바이트 → 꼬리 282 − 61 = 221
 *   konex_code.mst    109행이 **전부** 245바이트 → 꼬리 245 − 61 = 184
 * (2026-07-10~11자 파일에서는 2,561 / 1,822 / 107행이었다. **행 수는 날마다 바뀌지만
 *  바이트 폭은 그대로였다** — 20일 새 파일로도 288/282/245로 같았다.)
 *
 * ⚠ KIS 공식 파이썬 파서는 `rf1 = row[0:len(row) - 228]`처럼 적는데, 파이썬의
 * `for row in f`가 주는 row에는 **줄 끝 개행 1글자가 들어 있다**(universal newlines라
 * `\r\n`도 `\n` 하나로 온다). 우리는 개행을 뗀 뒤 읽으므로 그 상수를 그대로 쓰면
 * 한글종목명의 마지막 한 글자를 잘라 먹는다. 실제로 KOSPI 파일 22행이
 * `TIGER 엔비디아미국채커버드콜밸런스(합성`처럼 끝 글자를 잃었고, 그중 **8종목이**
 * 그대로 DB에 들어가 있었다(나머지 14행은 단축코드가 6자리가 아니라 담기지 않는다).
 * 대부분의 행은 이름 뒤 공백이 잘려 `.trim()`이 삼키는 바람에 티가 안 났다 —
 * **이름이 40바이트를 꽉 채운 행만 드러난다.**
 * 그래서 KOSPI는 227, KOSDAQ은 221을 쓴다. KONEX 184는 원래 맞는 값이라 그대로다 —
 * **일괄로 1을 빼면 안 된다.**
 *
 * 꼬리 길이는 한글종목명의 끝을 정하는 기준이라 한 칸만 밀려도 이름과 앞으로 읽을
 * 꼬리 필드(업종 등)가 통째로 어긋난다. 조용히 쓰레기가 되지 않도록 꼬리의 첫 필드인
 * 증권그룹구분코드(`ST`·`EF`·`EN`·`BC`… 대문자 2글자)로 매 행 정렬을 확인한다.
 *
 * 문자 단위로 잘라도 되는 이유: 앞 21바이트(단축·표준코드)와 꼬리 전체가 ASCII라
 * 바이트 수와 글자 수가 같다. 가운데 한글종목명만 EUC-KR 2바이트 문자를 포함하므로,
 * 양끝에서 재면 글자 수 계산이 바이트 수 계산과 어긋나지 않는다.
 *
 * 꼬리에서 읽는 필드는 지금 지수업종(대·중분류)뿐이다. 코드→이름 매핑은 다른 마스터
 * 파일이라 `indexSectorMaster.ts`에 있다.
 */

/** 한 행에서 한글종목명 앞에 오는 고정폭(단축코드 9 + 표준코드 12). */
const NAME_OFFSET = 21;

/** 한글종목명 필드 폭(바이트). 남는 자리는 공백으로 채워 온다. */
const NAME_FIELD_BYTES = 40;

/** 한글종목명이 가질 수 있는 글자 수 범위. 전부 한글(2바이트)이면 20, 전부 ASCII면 40. */
const NAME_MIN_CHARS = NAME_FIELD_BYTES / 2;
const NAME_MAX_CHARS = NAME_FIELD_BYTES;

/** 꼬리 첫 필드인 증권그룹구분코드. 정렬이 맞으면 항상 대문자 2글자다. */
const SECURITY_GROUP_CODE_PATTERN = /^[A-Z]{2}/;

/**
 * 꼬리 앞쪽 지수업종 필드의 자리.
 *
 *   [0,2) 증권그룹구분코드   [2,3) 시가총액규모
 *   [3,7) 지수업종대분류     [7,11) 지수업종중분류   [11,15) 지수업종소분류
 *
 * 값이 없으면 `0000`으로 채워 온다. 자릿수가 4가 아니거나 숫자가 아니면 꼬리가 밀린 것이다.
 *
 * ⚠ **소분류는 읽지 않는다.** 필드는 3단으로 잡혀 있지만 데이터는 2단이다 —
 * backend/.cache 실측(2026-07-31, 파일은 2026-07-30자)에서 국내 4,502행이 **전부**
 * `0000`이었다. 자리를 남겨 두는 것과 값이 있는 것은 다르다.
 */
const SECTOR_LARGE_OFFSET = 3;
const SECTOR_MID_OFFSET = 7;
const SECTOR_CODE_LENGTH = 4;

/** 지수업종이 붙지 않은 종목의 채움값. ETF·ETN·리츠 아닌 일반주도 중분류가 비는 경우가 있다. */
const SECTOR_CODE_NONE = '0000';

/** 정렬이 맞으면 지수업종 코드는 항상 숫자 4자리다. */
const SECTOR_CODE_PATTERN = /^\d{4}$/;

export interface DomesticMasterSpec {
  /** backend/.cache 안의 파일명 */
  file: string;
  /** 우리 도메인의 시장 구분 */
  market: string;
  /** 한글종목명 뒤에 붙는 고정폭 꼬리의 길이 */
  tailLength: number;
  /**
   * 꼬리에 지수업종 필드가 있는가.
   *
   * **KONEX는 꼬리 레이아웃 자체가 다르다.** 같은 자리를 읽으면 숫자가 나오지만
   * 업종 코드가 아니다 — 실측(2026-07-31, 파일은 2026-07-30자) 109행에서 대분류
   * 자리는 96행이 `0000`이고 나머지도 `0001 종합`·`0002 대형주`처럼 업종이 아니다.
   * 중분류 자리는 109개 중 **104개**가 `8320`·`3375`처럼 idxcode.mst에 없는 값이고,
   * 매치되는 다섯도 `KC산업 → 기술성장기업`·`에피바이오텍 → F-K200 산업재 인버스-2X`
   * 처럼 업종이라 부를 수 없는 것들이다.
   * 켜면 `0102`·`8320`에서 동기화가 던진다. 조용히 엉뚱한 업종을 붙이지 않도록 끈다.
   */
  hasIndexSectorFields: boolean;
}

/** 한 종목의 지수업종. 분류가 없으면 `null`이다 — 빈 문자열로 채우지 않는다. */
export interface DomesticMasterSector {
  /** 지수업종 대분류 코드 (KOSPI `0001`~, KOSDAQ `1001`~) */
  largeCode: string | null;
  /** 지수업종 중분류 코드. 대분류만 있고 중분류가 없는 종목이 있다 */
  midCode: string | null;
}

export interface DomesticMasterRow {
  /** 단축코드. 국내 주식·ETF는 6자리, 수익증권 등은 9자리로도 온다 */
  symbol: string;
  /** 표준코드(ISIN) 12자리 */
  standardCode: string;
  /** 한글종목명 (뒤 공백 제거) */
  name: string;
  /** 지수업종 코드. 이름은 `indexSectorMaster.ts`가 붙인다 */
  sector: DomesticMasterSector;
  /** 꼬리 원본. 아직 안 쓰는 고정폭 필드를 여기서 잘라 쓴다 */
  tail: string;
}

export const DOMESTIC_MASTER_SPECS: readonly DomesticMasterSpec[] = [
  { file: 'kospi_code.mst', market: 'KOSPI', tailLength: 227, hasIndexSectorFields: true },
  { file: 'kosdaq_code.mst', market: 'KOSDAQ', tailLength: 221, hasIndexSectorFields: true },
  { file: 'konex_code.mst', market: 'KONEX', tailLength: 184, hasIndexSectorFields: false },
];

/**
 * 마스터 한 행을 필드로 나눈다. 개행을 뗀 행을 넘긴다.
 *
 * 정렬이 어긋나면 `null`을 돌려주지 않고 **던진다.** 한 행이 밀렸다는 것은 그 파일
 * 전체가 밀렸다는 뜻이라, 조용히 건너뛰면 이름이 반쯤 잘린 채로 DB에 들어간다.
 */
export function parseDomesticMasterRow(row: string, spec: DomesticMasterSpec): DomesticMasterRow {
  const nameEnd = row.length - spec.tailLength;
  const nameLength = nameEnd - NAME_OFFSET;
  if (nameLength < NAME_MIN_CHARS || nameLength > NAME_MAX_CHARS) {
    throw new Error(
      `${spec.file}: 행 길이가 고정폭과 맞지 않습니다 ` +
        `(${row.length}글자, 종목명 ${nameLength}글자, 허용 ${NAME_MIN_CHARS}~${NAME_MAX_CHARS}). ` +
        `앞 30글자: ${row.slice(0, 30)}`,
    );
  }

  const tail = row.slice(nameEnd);
  if (!SECURITY_GROUP_CODE_PATTERN.test(tail)) {
    throw new Error(
      `${spec.file}: 꼬리 정렬이 어긋났습니다 ` +
        `(tailLength=${spec.tailLength}, 증권그룹구분코드 자리=${JSON.stringify(tail.slice(0, 2))}). ` +
        `앞 30글자: ${row.slice(0, 30)}`,
    );
  }

  return {
    symbol: row.slice(0, 9).trim(),
    standardCode: row.slice(9, NAME_OFFSET).trim(),
    name: row.slice(NAME_OFFSET, nameEnd).trim(),
    sector: readSector(tail, spec),
    tail,
  };
}

/** 꼬리에서 지수업종 코드를 자른다. 시장이 업종 필드를 갖지 않으면 읽지 않는다. */
function readSector(tail: string, spec: DomesticMasterSpec): DomesticMasterSector {
  if (!spec.hasIndexSectorFields) return { largeCode: null, midCode: null };
  return {
    largeCode: readSectorCode(tail, SECTOR_LARGE_OFFSET, spec),
    midCode: readSectorCode(tail, SECTOR_MID_OFFSET, spec),
  };
}

function readSectorCode(tail: string, offset: number, spec: DomesticMasterSpec): string | null {
  const raw = tail.slice(offset, offset + SECTOR_CODE_LENGTH);
  if (!SECTOR_CODE_PATTERN.test(raw)) {
    throw new Error(
      `${spec.file}: 지수업종 자리가 어긋났습니다 ` +
        `(꼬리 ${offset}~${offset + SECTOR_CODE_LENGTH}=${JSON.stringify(raw)}, 숫자 4자리여야 합니다). ` +
        `꼬리 앞 20글자: ${tail.slice(0, 20)}`,
    );
  }
  return raw === SECTOR_CODE_NONE ? null : raw;
}
