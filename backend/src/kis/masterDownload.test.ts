/**
 * 마스터 받아 오기 검증 — **네트워크 없이 돈다** (`fetchImpl` 주입).
 *
 * 여기서 지키려는 것은 "받아진다"가 아니라 **못 받았을 때 기존 파일이 멀쩡한가**다.
 * 마스터를 덮어쓰다 깨지면 앱이 종목을 통째로 잃는다. 그래서 실패를 다섯 가지로
 * 일부러 만들어 본다 — 끊김 · 빈 응답 · HTTP 오류 · 네트워크 예외 · 형식 변경.
 *
 * ★ 그리고 zip 내부 타임스탬프가 파일 mtime으로 옮겨지는지. `themes.source_modified_at`이
 * 그 mtime에서 오고 화면에 `기준일`로 뜬다. 오늘로 덮이면 9개월 묵은 테마 명단이
 * "오늘 것"이 된다.
 *
 * 픽스처는 KIS에서 실제로 받은 zip이다 (`fixtures/idxcode.mst.zip`).
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DOWNLOADABLE_MASTERS,
  MASTER_DOWNLOAD_MANIFEST,
  assertMasterContent,
  downloadMasters,
  type FetchLike,
  type MasterFileSpec,
} from './masterDownload.js';

const ARCHIVE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'idxcode.mst.zip'),
);

/** 픽스처에서 실측한 값 (`unzip -Z -v`) */
const MEASURED_MODIFIED_AT_ISO = '2026-05-21T07:16:19.000Z';
const MEASURED_ENTRY_BYTES = 22_586;
const MEASURED_ENTRY_ROWS = 491;

const IDXCODE = findSpec('idxcode.mst');
/** 국내 종목 마스터 파서. 다른 형식의 파일을 먹이면 던진다 */
const KOSPI_VALIDATE = findSpec('kospi_code.mst').validate;

/**
 * 갈아 끼우면 안 되는 상황을 재기 위해 미리 깔아 두는 기존 파일.
 * 한글을 넣지 않는다 — 파일은 EUC-KR인데 시험이 UTF-8로 읽고 쓰면 비교가 어긋난다.
 */
const EXISTING_TEXT = 'KEEP-ME-0000001\n';
const EXISTING_MTIME = new Date('2020-01-02T03:04:05.000Z');

const tempDirs: string[] = [];
after(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe('downloadMasters — 받기', () => {
  it('★ 파일 mtime이 zip 내부 타임스탬프다 — 받아온 시각이 아니다', async () => {
    const dir = await makeDir();
    const [result] = await downloadMasters({
      dir,
      files: [IDXCODE],
      fetchImpl: serveArchive(),
    });

    assert.equal(result!.status, 'downloaded');
    const info = await stat(resolve(dir, 'idxcode.mst'));
    assert.equal(info.mtime.toISOString(), MEASURED_MODIFIED_AT_ISO);
    assert.equal(result!.sourceModifiedAt?.toISOString(), MEASURED_MODIFIED_AT_ISO);
    // 오늘 날짜를 얹었다면 여기서 걸린다.
    assert.ok(
      Date.now() - info.mtime.getTime() > 30 * 86_400_000,
      'mtime이 최근이다 — 내부 타임스탬프가 아니라 받은 시각을 얹었다',
    );
  });

  it('내용과 행 수가 zip 그대로다', async () => {
    const dir = await makeDir();
    const [result] = await downloadMasters({ dir, files: [IDXCODE], fetchImpl: serveArchive() });

    const written = await readFile(resolve(dir, 'idxcode.mst'));
    assert.equal(written.length, MEASURED_ENTRY_BYTES);
    assert.equal(result!.rowCount, MEASURED_ENTRY_ROWS);
    assert.equal(result!.previousRowCount, null, '처음 받는 것이라 이전 값이 없다');
    assert.equal(result!.bytes, MEASURED_ENTRY_BYTES);
  });

  it('이전 행 수와 새 행 수를 둘 다 남긴다 — 줄어도 막지는 않는다', async () => {
    const dir = await makeDir();
    await seedExisting(dir, 'idxcode.mst');

    const [result] = await downloadMasters({ dir, files: [IDXCODE], fetchImpl: serveArchive() });
    assert.equal(result!.status, 'downloaded');
    assert.equal(result!.previousRowCount, 1);
    assert.equal(result!.rowCount, MEASURED_ENTRY_ROWS);
  });

  it('받은 시각은 mtime이 아니라 매니페스트에 적는다', async () => {
    const dir = await makeDir();
    const before = Date.now();
    await downloadMasters({ dir, files: [IDXCODE], fetchImpl: serveArchive() });

    const manifest = JSON.parse(await readFile(resolve(dir, MASTER_DOWNLOAD_MANIFEST), 'utf8'));
    const entry = manifest['idxcode.mst'];
    // 내용 기준일과 받은 시각을 섞으면 낡음을 잴 수 없게 된다.
    assert.equal(entry.sourceModifiedAt, MEASURED_MODIFIED_AT_ISO);
    assert.ok(Date.parse(entry.fetchedAt) >= before);
    assert.equal(entry.rowCount, MEASURED_ENTRY_ROWS);
    // 응답 헤더의 재포장 시각도 남긴다 — 이게 내용 기준일이 아니라는 증거다.
    assert.equal(entry.archivePackagedAt, 'Thu, 30 Jul 2026 09:55:05 GMT');
    assert.notEqual(entry.archivePackagedAt, entry.sourceModifiedAt);
  });

  it('.cache가 없어도 만들어서 받는다 — 새로 클론한 상태', async () => {
    const dir = resolve(await makeDir(), 'nested', '.cache');
    const [result] = await downloadMasters({ dir, files: [IDXCODE], fetchImpl: serveArchive() });
    assert.equal(result!.status, 'downloaded');
    assert.equal((await stat(resolve(dir, 'idxcode.mst'))).size, MEASURED_ENTRY_BYTES);
  });

  it('임시 파일을 남기지 않는다', async () => {
    const dir = await makeDir();
    await downloadMasters({ dir, files: [IDXCODE], fetchImpl: serveArchive() });
    const files = await readdir(dir);
    assert.deepEqual(files.sort(), [MASTER_DOWNLOAD_MANIFEST, 'idxcode.mst'].sort());
  });
});

describe('downloadMasters — 실패해도 기존 파일을 지킨다', () => {
  const failures: Array<{ name: string; fetchImpl: FetchLike; message: RegExp }> = [
    {
      name: '받다가 끊긴다 (앞부분만 온다)',
      fetchImpl: serveBytes(ARCHIVE.subarray(0, 1500)),
      message: /EOCD|잘렸습니다/,
    },
    {
      name: '빈 파일이 온다',
      fetchImpl: serveBytes(Buffer.alloc(0)),
      message: /너무 짧습니다/,
    },
    {
      name: 'zip이 아니라 오류 문서가 온다',
      fetchImpl: serveBytes(Buffer.from('<html>error</html>'.repeat(4))),
      message: /EOCD|짧습니다/,
    },
    {
      name: 'HTTP 404',
      fetchImpl: () =>
        Promise.resolve({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          headers: { get: () => null },
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
        }),
      message: /404 Not Found/,
    },
    {
      name: '네트워크가 끊겨 fetch가 던진다',
      fetchImpl: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
      message: /ENOTFOUND/,
    },
    {
      name: 'zip 안의 이름이 다르다',
      // theme_code.mst.zip 자리에 idxcode 내용이 왔다고 치는 상황.
      fetchImpl: serveArchive(),
      message: /zip 안의 이름이 다릅니다/,
    },
  ];

  for (const failure of failures) {
    it(`${failure.name} → 기존 파일이 그대로다`, async () => {
      const dir = await makeDir();
      // 이름 불일치 상황만 다른 파일명으로 재야 한다.
      const spec: MasterFileSpec =
        failure.name === 'zip 안의 이름이 다르다' ? findSpec('theme_code.mst') : IDXCODE;
      await seedExisting(dir, spec.file);

      const [result] = await downloadMasters({ dir, files: [spec], fetchImpl: failure.fetchImpl });

      assert.equal(result!.status, 'failed');
      assert.match(result!.error ?? '', failure.message);
      assert.equal(result!.usable, true, '기존 파일이 있으니 동기화는 계속할 수 있다');
      await assertExistingUntouched(dir, spec.file);
      assert.deepEqual(
        (await readdir(dir)).filter((name) => name.endsWith('.tmp')),
        [],
        '임시 파일이 남았다',
      );
    });
  }

  it('형식이 바뀌어 파서가 던지면 갈아 끼우지 않는다', async () => {
    // 진짜 파서에 진짜 파일을 먹인다 — idxcode 내용(45바이트 행)을 국내 종목 마스터
    // 파서(288바이트 행)로 읽으면 고정폭이 안 맞아 던진다. 형식이 바뀌면 이렇게 된다.
    const dir = await makeDir();
    const spec: MasterFileSpec = { file: 'idxcode.mst', validate: KOSPI_VALIDATE };
    await seedExisting(dir, spec.file);

    const [result] = await downloadMasters({ dir, files: [spec], fetchImpl: serveArchive() });
    assert.equal(result!.status, 'failed');
    assert.match(result!.error ?? '', /고정폭과 맞지 않습니다/);
    await assertExistingUntouched(dir, spec.file);
  });

  it('기존 파일이 없는 채로 실패하면 쓸 파일이 없다고 말한다', async () => {
    const dir = await makeDir();
    const [result] = await downloadMasters({
      dir,
      files: [IDXCODE],
      fetchImpl: () => Promise.reject(new Error('getaddrinfo ENOTFOUND')),
    });

    assert.equal(result!.status, 'failed');
    assert.equal(result!.usable, false);
    assert.equal(result!.sourceModifiedAt, null, '기준일을 지어내지 않는다');
    await assert.rejects(() => stat(resolve(dir, 'idxcode.mst')));
  });

  it('한 파일이 실패해도 나머지를 계속 받는다', async () => {
    const dir = await makeDir();
    const theme = findSpec('theme_code.mst');
    const fetchImpl: FetchLike = (url) =>
      url.includes('theme_code')
        ? Promise.reject(new Error('getaddrinfo ENOTFOUND'))
        : serveArchive()(url);

    const results = await downloadMasters({ dir, files: [theme, IDXCODE], fetchImpl });
    assert.deepEqual(
      results.map((r) => [r.file, r.status]),
      [
        ['theme_code.mst', 'failed'],
        ['idxcode.mst', 'downloaded'],
      ],
    );
  });
});

describe('downloadMasters — KIS 서버를 반복해서 두드리지 않는다', () => {
  it('최근에 받은 것은 다시 받지 않는다', async () => {
    const dir = await makeDir();
    let calls = 0;
    const counting: FetchLike = (url) => {
      calls += 1;
      return serveArchive()(url);
    };

    await downloadMasters({ dir, files: [IDXCODE], fetchImpl: counting });
    assert.equal(calls, 1);

    const [second] = await downloadMasters({ dir, files: [IDXCODE], fetchImpl: counting });
    assert.equal(calls, 1, '두 번째는 나가지 않아야 한다');
    assert.equal(second!.status, 'skipped');
    // 건너뛰어도 기준일은 말해 준다 — 디스크의 mtime이 곧 내용 기준일이다.
    assert.equal(second!.sourceModifiedAt?.toISOString(), MEASURED_MODIFIED_AT_ISO);
  });

  it('--force면 최근에 받았어도 다시 받는다', async () => {
    const dir = await makeDir();
    let calls = 0;
    const counting: FetchLike = (url) => {
      calls += 1;
      return serveArchive()(url);
    };

    await downloadMasters({ dir, files: [IDXCODE], fetchImpl: counting });
    const [second] = await downloadMasters({
      dir,
      files: [IDXCODE],
      fetchImpl: counting,
      force: true,
    });
    assert.equal(calls, 2);
    assert.equal(second!.status, 'downloaded');
    assert.equal(second!.previousRowCount, MEASURED_ENTRY_ROWS, '같은 파일을 다시 받았다');
  });

  it('시간이 지나면 다시 받는다', async () => {
    const dir = await makeDir();
    let calls = 0;
    const counting: FetchLike = (url) => {
      calls += 1;
      return serveArchive()(url);
    };

    await downloadMasters({ dir, files: [IDXCODE], fetchImpl: counting, maxAgeHours: 12 });
    // 0시간이면 방금 받은 것도 낡은 것으로 본다.
    await downloadMasters({ dir, files: [IDXCODE], fetchImpl: counting, maxAgeHours: 0 });
    assert.equal(calls, 2);
  });

  it('파일이 지워졌으면 매니페스트가 새것이어도 다시 받는다', async () => {
    const dir = await makeDir();
    let calls = 0;
    const counting: FetchLike = (url) => {
      calls += 1;
      return serveArchive()(url);
    };

    await downloadMasters({ dir, files: [IDXCODE], fetchImpl: counting });
    await rm(resolve(dir, 'idxcode.mst'));
    const [second] = await downloadMasters({ dir, files: [IDXCODE], fetchImpl: counting });
    assert.equal(calls, 2);
    assert.equal(second!.status, 'downloaded');
  });
});

describe('DOWNLOADABLE_MASTERS', () => {
  it('국내 5종이고 파일명이 파서 모듈의 상수와 같다', () => {
    assert.deepEqual(
      DOWNLOADABLE_MASTERS.map((spec) => spec.file),
      ['kospi_code.mst', 'kosdaq_code.mst', 'konex_code.mst', 'idxcode.mst', 'theme_code.mst'],
    );
  });
});

describe('assertMasterContent', () => {
  /**
   * 행이 0개인 응답은 실제 KIS에서 본 적이 없고 zip을 지어내지 않으면 만들 수도 없다.
   * 그래서 그물만 따로 잰다 — 파서들은 **행마다** 검사하므로 행이 없으면 통과한다.
   */
  it('빈 내용은 던진다 — 파서는 이걸 통과시킨다', () => {
    for (const empty of ['', '\n', '\r\n\r\n', '   \n \t \n']) {
      assert.equal(
        DOWNLOADABLE_MASTERS.every((spec) => tryValidate(spec, empty)),
        true,
        '파서가 빈 내용을 이미 걸러 준다면 이 그물은 필요 없다',
      );
      assert.throws(() => assertMasterContent(empty, 'idxcode.mst'), /행이 하나도 없습니다/);
    }
  });

  it('행이 있으면 그 수를 준다', () => {
    assert.equal(assertMasterContent('a\nb\n\nc\n', 'idxcode.mst'), 3);
  });
});

/** 파서가 던지지 않고 통과하면 true */
function tryValidate(spec: MasterFileSpec, text: string): boolean {
  try {
    spec.validate(text);
    return true;
  } catch {
    return false;
  }
}

// ── 도우미 ────────────────────────────────────────────────

function findSpec(file: string): MasterFileSpec {
  const spec = DOWNLOADABLE_MASTERS.find((candidate) => candidate.file === file);
  assert.ok(spec, `${file} 스펙이 없다`);
  return spec;
}

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), 'kis-master-'));
  tempDirs.push(dir);
  return dir;
}

/** 갈아 끼우면 안 되는 기존 파일을 깐다. mtime도 옛날로 맞춰 둔다 */
async function seedExisting(dir: string, file: string): Promise<void> {
  const path = resolve(dir, file);
  await writeFile(path, EXISTING_TEXT, 'utf8');
  await utimes(path, EXISTING_MTIME, EXISTING_MTIME);
}

/** 기존 파일이 내용도 시각도 안 바뀌었는지 */
async function assertExistingUntouched(dir: string, file: string): Promise<void> {
  const path = resolve(dir, file);
  assert.equal(await readFile(path, 'utf8'), EXISTING_TEXT, '기존 파일 내용이 바뀌었다');
  assert.equal(
    (await stat(path)).mtime.toISOString(),
    EXISTING_MTIME.toISOString(),
    '기존 파일 시각이 바뀌었다',
  );
}

/** 실제 KIS 응답 헤더를 그대로 흉내 낸다 (2026-07-30 실측) */
function serveArchive(): FetchLike {
  return serveBytes(ARCHIVE);
}

function serveBytes(body: Buffer): FetchLike {
  return () =>
    Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {
        get: (name: string): string | null =>
          name.toLowerCase() === 'last-modified' ? 'Thu, 30 Jul 2026 09:55:05 GMT' : null,
      },
      arrayBuffer: () => Promise.resolve(toArrayBuffer(body)),
    });
}

/** 진짜 `Response.arrayBuffer()`처럼 새 버퍼를 준다 (Buffer의 내부 풀을 넘기지 않는다) */
function toArrayBuffer(body: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(body.byteLength);
  new Uint8Array(copy).set(body);
  return copy;
}
