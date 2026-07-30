/**
 * KIS 공개 마스터 zip 리더 검증.
 *
 * **픽스처는 KIS에서 실제로 받은 zip이다** (`fixtures/idxcode.mst.zip`, 2026-07-30 04:25 KST
 * 수신, 4,985바이트). 내가 만든 zip 라이터로 지으면 내 상수로 쓰고 내 상수로 읽어
 * 왕복이 저절로 맞아떨어진다 — 자리 계산 결함이 통째로 숨는다.
 *
 * 이 파일이 지키려는 것은 셋이다.
 *   1. ★ **내부 타임스탬프가 오늘로 바뀌지 않는다.** `themes.source_modified_at`이 여기서
 *      온다. zip은 매일 재포장되지만 내용은 안 바뀌어서, 시각을 안 옮기면 9개월 묵은
 *      테마 명단이 "오늘 것"으로 뜬다.
 *   2. **받다 끊긴 파일이 통과하지 못한다.** 통과하면 기존 마스터를 덮어써 종목을 잃는다.
 *   3. 데이터 자리를 **local header**의 길이로 잰다 (central과 다르다).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { crc32, readSingleEntryZip } from './masterArchive.js';

const ARCHIVE = readFixture('idxcode.mst.zip');

/**
 * 픽스처에서 직접 잰 값. **파서 상수를 쓰지 않고 실측으로 적는다.**
 *
 *   $ unzip -l  → 22586  05-21-2026 16:16  idxcode.mst
 *   $ unzip -Z -v → UT extra field modtime: 2026 May 21 07:16:19 UTC
 *                   DOS date/time:          2026 May 21 16:16:20 (로컬, 2초 단위)
 */
const MEASURED_ENTRY_NAME = 'idxcode.mst';
const MEASURED_ENTRY_BYTES = 22_586;
const MEASURED_ENTRY_ROWS = 491;
const MEASURED_MODIFIED_AT_ISO = '2026-05-21T07:16:19.000Z';
/** zip이 central directory에 적어 둔 CRC. 우리 계산과 맞춰 보는 **독립 오라클**이다 */
const MEASURED_CRC = 0xd224c78b;

/** 픽스처의 자리들. 바이트를 조작해 실패를 재현하는 데 쓴다 */
const CENTRAL_OFFSET = 4882;
const EOCD_OFFSET = 4963;

describe('readSingleEntryZip', () => {
  it('실제 KIS zip을 풀어 이름·길이·행 수를 준다', () => {
    const entry = readSingleEntryZip(ARCHIVE, 'idxcode.mst.zip');
    assert.equal(entry.name, MEASURED_ENTRY_NAME);
    assert.equal(entry.data.length, MEASURED_ENTRY_BYTES);
    assert.equal(countRows(entry.data), MEASURED_ENTRY_ROWS);
  });

  it('★ 내부 타임스탬프가 그대로 나온다 — 받은 시각이 아니다', () => {
    const entry = readSingleEntryZip(ARCHIVE, 'idxcode.mst.zip');
    assert.equal(entry.modifiedAt.toISOString(), MEASURED_MODIFIED_AT_ISO);
    assert.equal(entry.modifiedAtSource, 'unix-extra');
    // 이 픽스처를 받은 것은 2026-07-30이다. 재포장 시각을 집었다면 여기서 걸린다.
    assert.ok(
      entry.modifiedAt.getTime() < Date.parse('2026-06-01T00:00:00Z'),
      '내부 타임스탬프가 아니라 오늘 날짜를 집었다',
    );
  });

  it('UT 확장 필드와 DOS 자리가 서로를 검산한다 (DOS는 2초 단위)', () => {
    // 두 값은 zip 안에 **다른 방식으로** 적혀 있다. 한쪽만 보고 자리를 잘못 잡았다면
    // 둘이 몇 시간·며칠씩 어긋난다.
    const entry = readSingleEntryZip(ARCHIVE, 'idxcode.mst.zip');
    const dosDate = ARCHIVE.readUInt16LE(CENTRAL_OFFSET + 14);
    const dosTime = ARCHIVE.readUInt16LE(CENTRAL_OFFSET + 12);
    const fromDos = new Date(
      1980 + ((dosDate >> 9) & 0x7f),
      ((dosDate >> 5) & 0x0f) - 1,
      dosDate & 0x1f,
      (dosTime >> 11) & 0x1f,
      (dosTime >> 5) & 0x3f,
      (dosTime & 0x1f) * 2,
    );
    const gapMs = Math.abs(fromDos.getTime() - entry.modifiedAt.getTime());
    assert.ok(gapMs <= 2000, `UT와 DOS가 ${gapMs}ms 벌어졌다`);
  });

  it('UT 확장 필드가 없으면 DOS 자리로 물러선다', () => {
    // central directory의 확장 필드 길이를 0으로 만들어 UT를 감춘다.
    // (local header 쪽은 그대로라 데이터 자리는 안 바뀐다)
    const patched = Buffer.from(ARCHIVE);
    patched.writeUInt16LE(0, CENTRAL_OFFSET + 30);
    // central header가 짧아진 만큼 EOCD의 central directory 크기도 줄여 준다.
    patched.writeUInt32LE(patched.readUInt32LE(EOCD_OFFSET + 12) - 24, EOCD_OFFSET + 12);

    const entry = readSingleEntryZip(patched, 'idxcode.mst.zip');
    assert.equal(entry.modifiedAtSource, 'dos');
    // DOS는 2초 단위라 UT(…:19)보다 1초 늦은 …:20이 된다. 날짜는 같아야 한다.
    assert.equal(entry.modifiedAt.getFullYear(), 2026);
    assert.equal(entry.modifiedAt.getMonth(), 4);
    assert.equal(entry.modifiedAt.getDate(), 21);
  });

  it('데이터 자리를 local header 길이로 잰다 — central과 다르다', () => {
    // 이 파일은 central 확장 필드 24바이트, local 28바이트다(local에만 접근 시각이 붙는다).
    // central 길이로 재면 4바이트 어긋난 자리에서 압축을 풀게 되고 위 시험들이 죽는다.
    const centralExtraLength = ARCHIVE.readUInt16LE(CENTRAL_OFFSET + 30);
    const localOffset = ARCHIVE.readUInt32LE(CENTRAL_OFFSET + 42);
    const localExtraLength = ARCHIVE.readUInt16LE(localOffset + 28);
    assert.equal(centralExtraLength, 24);
    assert.equal(localExtraLength, 28);
    assert.notEqual(centralExtraLength, localExtraLength);
  });

  it('받다 끊기면 던진다 — 뒤를 자른다', () => {
    for (const keep of [0, 21, 100, 2000, ARCHIVE.length - 1]) {
      assert.throws(
        () => readSingleEntryZip(ARCHIVE.subarray(0, keep), 'idxcode.mst.zip'),
        /idxcode\.mst\.zip:/,
        `${keep}바이트만 받았는데 통과했다`,
      );
    }
  });

  it('빈 파일은 던진다', () => {
    assert.throws(
      () => readSingleEntryZip(Buffer.alloc(0), 'idxcode.mst.zip'),
      /너무 짧습니다/,
    );
  });

  it('zip이 아니면 던진다 — 오류 HTML을 200으로 주는 경우', () => {
    const html = Buffer.from('<html><body>404 Not Found</body></html>'.repeat(4));
    assert.throws(() => readSingleEntryZip(html, 'idxcode.mst.zip'), /EOCD|짧습니다/);
  });

  it('압축 데이터가 한 바이트라도 바뀌면 CRC로 걸린다', () => {
    // 가운데 한 바이트를 뒤집는다. **이 자리는 inflate가 통과시키고 길이도 그대로라**
    // 오직 CRC만 잡아낸다 — CRC 검사를 빼면 이 시험 하나만 죽는 것으로 확인했다.
    const patched = Buffer.from(ARCHIVE);
    const target = 2000;
    patched[target] = patched[target]! ^ 0xff;
    assert.throws(() => readSingleEntryZip(patched, 'idxcode.mst.zip'), /CRC가 맞지 않습니다/);
  });

  it('푼 길이가 zip이 적어 둔 값과 다르면 던진다', () => {
    const patched = Buffer.from(ARCHIVE);
    patched.writeUInt32LE(MEASURED_ENTRY_BYTES - 1, CENTRAL_OFFSET + 24);
    assert.throws(() => readSingleEntryZip(patched, 'idxcode.mst.zip'), /푼 길이가/);
  });

  it('엔트리가 1개가 아니면 던진다 — 형식이 바뀐 것이다', () => {
    const patched = Buffer.from(ARCHIVE);
    patched.writeUInt16LE(2, EOCD_OFFSET + 10);
    assert.throws(() => readSingleEntryZip(patched, 'idxcode.mst.zip'), /1개가 아닙니다/);
  });

  it('암호화된 zip은 읽지 않는다', () => {
    const patched = Buffer.from(ARCHIVE);
    patched.writeUInt16LE(0x0001, CENTRAL_OFFSET + 8);
    assert.throws(() => readSingleEntryZip(patched, 'idxcode.mst.zip'), /암호화된/);
  });

  it('모르는 압축 방식이면 던진다', () => {
    const patched = Buffer.from(ARCHIVE);
    patched.writeUInt16LE(99, CENTRAL_OFFSET + 10);
    assert.throws(() => readSingleEntryZip(patched, 'idxcode.mst.zip'), /압축 방식/);
  });
});

describe('crc32', () => {
  it('zip이 적어 둔 CRC와 맞는다 — 우리가 만든 값이 아닌 독립 오라클이다', () => {
    const entry = readSingleEntryZip(ARCHIVE, 'idxcode.mst.zip');
    assert.equal(crc32(entry.data), MEASURED_CRC);
    assert.equal(ARCHIVE.readUInt32LE(CENTRAL_OFFSET + 16), MEASURED_CRC);
  });

  it('IEEE 802.3 표준값과 맞는다', () => {
    // 널리 알려진 검사값. 표 생성이 어긋나면 여기서 걸린다.
    assert.equal(crc32(Buffer.alloc(0)), 0x00000000);
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
    assert.equal(crc32(Buffer.from('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  });
});

function readFixture(name: string): Buffer {
  return readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', name));
}

function countRows(data: Buffer): number {
  return new TextDecoder('euc-kr')
    .decode(data)
    .split(/\r?\n/)
    .filter((row) => row.trim()).length;
}
