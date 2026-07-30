/**
 * KIS 공개 마스터 zip을 푸는 최소 리더.
 *
 * KIS는 종목·업종·테마 마스터를 `https://new.real.download.dws.co.kr/common/master/`에
 * **인증 없이** zip으로 공개한다. 엔트리는 파일당 하나뿐이라 범용 zip 라이브러리를
 * 붙이지 않고 여기서 직접 읽는다. 의존성을 늘리지 않는 것보다 중요한 이유가 하나 더
 * 있다 — **내부 타임스탬프를 우리가 직접 꺼내야 하기 때문**이다.
 *
 * ## ★ 내부 타임스탬프가 이 모듈의 존재 이유다
 *
 * zip은 **매일 재포장되지만 내용은 안 바뀐다.** 2026-07-30 실측:
 *
 * | 파일 | 응답 `Last-Modified` (zip 재포장) | zip 내부 타임스탬프 (내용) |
 * |------|------|------|
 * | `kospi_code.mst`  | 2026-07-30 18:55 KST | 2026-07-30 07:35 |
 * | `konex_code.mst`  | 2026-07-30 18:55 KST | 2026-07-30 05:58 |
 * | `idxcode.mst`     | 2026-07-30 18:55 KST | **2026-05-21 16:16** (2개월) |
 * | `theme_code.mst`  | 2026-07-30 18:55 KST | **2025-11-06 05:58** (9개월) |
 *
 * `themes.source_modified_at`이 이 값에서 오고 화면에 `기준일`로 뜬다. 풀 때 시각을
 * 안 옮기면 9개월 묵은 테마 명단이 "오늘 것"으로 표시된다. 그래서 이 리더는 내용과
 * 함께 `modifiedAt`을 돌려주고, 파일에 쓰는 쪽이 `utimes`로 그 값을 얹는다.
 *
 * 시각은 두 군데에 들어 있고 **정밀도가 다르다.**
 *   - DOS date/time (모든 zip 필수): 로컬 시간, **2초 단위**. `theme_code`는 05:58:10.
 *   - Info-ZIP `UT` 확장 필드(0x5455): UTC epoch 초, **1초 단위**. `theme_code`는 05:58:09.
 * 지금 backend/.cache에 있는 파일들의 mtime이 05:58:09/16:16:19라 **`UT` 쪽과 일치한다**
 * (macOS `unzip`이 그렇게 푼다). 우리도 `UT`를 먼저 보고 없을 때만 DOS로 물러선다.
 * 그래야 이미 받아 둔 파일과 새로 받은 파일의 기준일이 2초씩 어긋나지 않는다.
 *
 * ## 검증
 *
 * 받다 끊기거나 빈 파일이 오면 **여기서 던진다.** 부르는 쪽이 기존 파일을 그대로
 * 두게 하려면 쓰기 전에 걸러야 한다. 푼 길이와 CRC32를 zip이 적어 둔 값과 맞춰
 * 보므로, 한 바이트만 달라도 걸린다.
 *
 * `zlib.crc32`를 쓰지 않고 표를 직접 만든다 — 그 API는 Node 20.15+에만 있고
 * 이 레포의 `engines`는 `>=20`이다.
 */

import { inflateRawSync } from 'node:zlib';

/** End of central directory 서명 */
const EOCD_SIGNATURE = 0x06054b50;
/** Central directory file header 서명 */
const CENTRAL_SIGNATURE = 0x02014b50;
/** Local file header 서명 */
const LOCAL_SIGNATURE = 0x04034b50;

/** EOCD 고정부 길이(주석 제외). 주석은 KIS zip에 없다 */
const EOCD_FIXED_BYTES = 22;

/** 압축 방식. KIS는 8(deflate)로 준다 */
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;

/** general purpose bit 0. 암호화된 zip은 다루지 않는다 */
const FLAG_ENCRYPTED = 0x0001;

/** Info-ZIP extended timestamp 확장 필드 id */
const EXTRA_UNIX_TIMESTAMP = 0x5455;
/** 그 확장 필드의 bit 0 = 수정 시각이 들어 있다 */
const UNIX_TIMESTAMP_HAS_MTIME = 0x01;

/** DOS date/time의 기준 연도 */
const DOS_EPOCH_YEAR = 1980;

export interface MasterArchiveEntry {
  /** zip 안의 파일명 (`kospi_code.mst`) */
  name: string;
  /** 푼 내용 */
  data: Buffer;
  /**
   * ★ zip 내부 타임스탬프. **우리가 받아온 시각이 아니라 내용이 만들어진 시각이다.**
   * 이 값을 파일 mtime으로 옮겨야 `themes.source_modified_at`이 보존된다.
   */
  modifiedAt: Date;
  /** 어느 자리에서 읽었는가. `dos`면 2초 단위로 반올림된 값이다 */
  modifiedAtSource: 'unix-extra' | 'dos';
}

/**
 * 엔트리가 하나뿐인 zip을 푼다.
 *
 * 엔트리가 0개거나 2개 이상이면 던진다 — KIS 마스터 zip은 실측(5종)에서 전부 1개였고,
 * 늘었다는 것은 형식이 바뀌었다는 뜻이라 조용히 첫 엔트리를 고르면 안 된다.
 */
export function readSingleEntryZip(archive: Buffer, label: string): MasterArchiveEntry {
  const eocdOffset = findEocd(archive, label);
  const entryCount = archive.readUInt16LE(eocdOffset + 10);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);

  if (entryCount !== 1) {
    throw new Error(`${label}: zip 안의 파일이 1개가 아닙니다 (${entryCount}개).`);
  }
  if (centralOffset + 46 > archive.length) {
    throw new Error(`${label}: central directory 자리가 파일 밖입니다 (${centralOffset}).`);
  }
  if (archive.readUInt32LE(centralOffset) !== CENTRAL_SIGNATURE) {
    throw new Error(`${label}: central directory 서명이 없습니다 (자리 ${centralOffset}).`);
  }

  const flags = archive.readUInt16LE(centralOffset + 8);
  if (flags & FLAG_ENCRYPTED) {
    throw new Error(`${label}: 암호화된 zip은 읽지 않습니다.`);
  }

  const method = archive.readUInt16LE(centralOffset + 10);
  const dosTime = archive.readUInt16LE(centralOffset + 12);
  const dosDate = archive.readUInt16LE(centralOffset + 14);
  const expectedCrc = archive.readUInt32LE(centralOffset + 16);
  const compressedSize = archive.readUInt32LE(centralOffset + 20);
  const uncompressedSize = archive.readUInt32LE(centralOffset + 24);
  const nameLength = archive.readUInt16LE(centralOffset + 28);
  const extraLength = archive.readUInt16LE(centralOffset + 30);
  const localOffset = archive.readUInt32LE(centralOffset + 42);

  const name = archive.toString('latin1', centralOffset + 46, centralOffset + 46 + nameLength);
  const centralExtra = archive.subarray(
    centralOffset + 46 + nameLength,
    centralOffset + 46 + nameLength + extraLength,
  );

  // 데이터 자리는 **local header의** 길이로 잰다. central과 local의 확장 필드 길이가
  // 다르다 — 실측에서 central 24바이트 / local 28바이트였다(local에만 접근 시각이 붙는다).
  // central 길이를 쓰면 4바이트 어긋난 자리에서 압축을 풀게 된다.
  if (localOffset + 30 > archive.length) {
    throw new Error(`${label}: local header 자리가 파일 밖입니다 (${localOffset}).`);
  }
  if (archive.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
    throw new Error(`${label}: local header 서명이 없습니다 (자리 ${localOffset}).`);
  }
  const localNameLength = archive.readUInt16LE(localOffset + 26);
  const localExtraLength = archive.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > archive.length) {
    throw new Error(
      `${label}: 압축 데이터가 잘렸습니다 (필요 ${dataEnd.toLocaleString('ko-KR')}바이트, ` +
        `받은 것 ${archive.length.toLocaleString('ko-KR')}바이트).`,
    );
  }

  const raw = archive.subarray(dataStart, dataEnd);
  const data = decompress(raw, method, label);

  if (data.length !== uncompressedSize) {
    throw new Error(
      `${label}: 푼 길이가 zip이 적어 둔 값과 다릅니다 ` +
        `(${data.length.toLocaleString('ko-KR')} ≠ ${uncompressedSize.toLocaleString('ko-KR')}바이트).`,
    );
  }
  const actualCrc = crc32(data);
  if (actualCrc !== expectedCrc) {
    throw new Error(
      `${label}: CRC가 맞지 않습니다 ` +
        `(계산 ${hex32(actualCrc)} ≠ zip ${hex32(expectedCrc)}). 받는 중에 깨졌습니다.`,
    );
  }

  const unixModified = readUnixExtraModifiedAt(centralExtra);
  return {
    name,
    data,
    modifiedAt: unixModified ?? dosDateTimeToDate(dosDate, dosTime, label),
    modifiedAtSource: unixModified ? 'unix-extra' : 'dos',
  };
}

/**
 * EOCD를 뒤에서부터 찾는다. zip 주석이 있으면 EOCD가 파일 끝이 아니라서
 * 서명을 훑어야 한다 — KIS zip에는 주석이 없지만 형식상 그렇다.
 */
function findEocd(archive: Buffer, label: string): number {
  if (archive.length < EOCD_FIXED_BYTES) {
    throw new Error(
      `${label}: zip이라기엔 너무 짧습니다 (${archive.length.toLocaleString('ko-KR')}바이트). ` +
        `받다가 끊겼거나 zip이 아닙니다.`,
    );
  }
  for (let offset = archive.length - EOCD_FIXED_BYTES; offset >= 0; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error(`${label}: zip 끝 표지(EOCD)를 찾지 못했습니다. 받다가 끊겼거나 zip이 아닙니다.`);
}

function decompress(raw: Buffer, method: number, label: string): Buffer {
  if (method === METHOD_STORED) return Buffer.from(raw);
  if (method === METHOD_DEFLATED) return inflateRawSync(raw);
  throw new Error(`${label}: 다루지 않는 압축 방식입니다 (method=${method}).`);
}

/**
 * Info-ZIP `UT` 확장 필드에서 수정 시각(UTC epoch 초)을 읽는다. 없으면 `null`이다.
 *
 * central directory 쪽에는 수정 시각 하나만 들어 있고(5바이트), local header 쪽에는
 * 접근 시각까지 들어 있다(9바이트). 우리는 central을 읽으므로 첫 4바이트만 본다.
 */
function readUnixExtraModifiedAt(extra: Buffer): Date | null {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    const body = extra.subarray(offset + 4, offset + 4 + size);
    if (id === EXTRA_UNIX_TIMESTAMP && body.length >= 5 && body[0]! & UNIX_TIMESTAMP_HAS_MTIME) {
      return new Date(body.readInt32LE(1) * 1000);
    }
    offset += 4 + size;
  }
  return null;
}

/**
 * DOS date/time을 **로컬 시간대**로 해석한다. zip 형식에 시간대가 없어서 그렇다 —
 * KIS가 KST로 적고 우리도 KST에서 도는 동안만 맞는다. `UT` 확장 필드가 있으면
 * 그쪽이 UTC라 시간대 문제가 없고, 그래서 그쪽을 먼저 본다.
 */
function dosDateTimeToDate(dosDate: number, dosTime: number, label: string): Date {
  const year = DOS_EPOCH_YEAR + ((dosDate >> 9) & 0x7f);
  const month = (dosDate >> 5) & 0x0f;
  const day = dosDate & 0x1f;
  const hour = (dosTime >> 11) & 0x1f;
  const minute = (dosTime >> 5) & 0x3f;
  const second = (dosTime & 0x1f) * 2;
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`${label}: zip 내부 날짜가 말이 안 됩니다 (${year}-${month}-${day}).`);
  }
  return new Date(year, month - 1, day, hour, minute, second);
}

/** CRC-32 (IEEE 802.3). zip이 적어 둔 값과 맞춰 받다 끊긴 파일을 걸러낸다. */
export function crc32(data: Buffer): number {
  let value = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    value = CRC32_TABLE[(value ^ data[i]!) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

const CRC32_TABLE = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
}

function hex32(value: number): string {
  return `0x${value.toString(16).padStart(8, '0')}`;
}
