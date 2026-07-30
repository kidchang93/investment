/**
 * KIS 국내 종목 마스터(.mst) 고정폭 레이아웃.
 *
 * 파일은 EUC-KR **고정폭**이라 한 행의 바이트 수가 시장마다 하나로 정해져 있다.
 * 앞쪽 61바이트는 세 시장이 같고(단축코드 9 + 표준코드 12 + 한글종목명 40),
 * 그 뒤에 붙는 꼬리(고정폭 필드 묶음)의 길이만 다르다.
 *
 *   [0,9)  단축코드   [9,21) 표준코드   [21,61) 한글종목명   [61,행끝) 꼬리
 *
 * backend/.cache 실측(2026-07-31, 파일은 2026-07-10~11자):
 *   kospi_code.mst  2,561행이 **전부** 288바이트 → 꼬리 288 − 61 = 227
 *   kosdaq_code.mst 1,822행이 **전부** 282바이트 → 꼬리 282 − 61 = 221
 *   konex_code.mst    107행이 **전부** 245바이트 → 꼬리 245 − 61 = 184
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

export interface DomesticMasterSpec {
  /** backend/.cache 안의 파일명 */
  file: string;
  /** 우리 도메인의 시장 구분 */
  market: string;
  /** 한글종목명 뒤에 붙는 고정폭 꼬리의 길이 */
  tailLength: number;
}

export interface DomesticMasterRow {
  /** 단축코드. 국내 주식·ETF는 6자리, 수익증권 등은 9자리로도 온다 */
  symbol: string;
  /** 표준코드(ISIN) 12자리 */
  standardCode: string;
  /** 한글종목명 (뒤 공백 제거) */
  name: string;
  /** 꼬리 원본. 업종 등 고정폭 필드를 여기서 잘라 쓴다 */
  tail: string;
}

export const DOMESTIC_MASTER_SPECS: readonly DomesticMasterSpec[] = [
  { file: 'kospi_code.mst', market: 'KOSPI', tailLength: 227 },
  { file: 'kosdaq_code.mst', market: 'KOSDAQ', tailLength: 221 },
  { file: 'konex_code.mst', market: 'KONEX', tailLength: 184 },
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
    tail,
  };
}
