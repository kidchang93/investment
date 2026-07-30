/**
 * KIS 공개 마스터 파일 받아 오기.
 *
 * 종목·업종·테마 마스터는 `https://new.real.download.dws.co.kr/common/master/<이름>.mst.zip`에
 * **인증 없이** 공개돼 있다(appkey·토큰이 필요 없어 발급 한도와 무관하다). 예전에는
 * 사람이 손으로 받아 backend/.cache에 넣었고, 그래서 파일이 20일~9개월 묵어도
 * 아무도 몰랐다. 그 과정을 코드로 남긴다.
 *
 * ## 실패해도 기존 파일을 깨지 않는다
 *
 * 마스터가 통째로 날아가면 앱이 종목을 잃는다. 그래서 순서가
 *
 *   1. 메모리로 받는다 (파일에 손대지 않는다)
 *   2. zip을 풀며 길이·CRC를 맞춘다 → 받다 끊긴 것은 여기서 걸린다
 *   3. 그 내용을 **실제 파서로** 끝까지 읽어 본다 → 형식이 바뀐 것은 여기서 걸린다
 *   4. 임시 파일에 쓰고 ★내부 타임스탬프를 얹은 뒤 `rename`으로 갈아 끼운다
 *
 * 1~3 어디서 실패해도 기존 파일은 그대로다. 4의 `rename`은 같은 디렉터리 안이라
 * 원자적이라서 "반쯤 쓰인 마스터"가 생기지 않는다.
 *
 * ## ★ 내부 타임스탬프를 파일 mtime으로 옮긴다
 *
 * `themes.source_modified_at`이 파일 mtime에서 오고 화면에 `기준일`로 뜬다
 * (`db/themes.ts`). zip은 매일 재포장되지만 내용은 안 바뀐다 — 2026-07-30 실측으로
 * 응답 `Last-Modified`는 다섯 파일 모두 그날인데 내부 타임스탬프는 `theme_code`가
 * 2025-11-06, `idxcode`가 2026-05-21이었다. 풀 때 시각을 안 옮기면 9개월 묵은 테마
 * 명단이 "오늘 것"으로 표시된다. `utimes`로 얹는 이유가 이것이다.
 *
 * ## 얼마나 자주 받는가
 *
 * 파일은 하루 한 번 만들어진다(실측 내부 타임스탬프 05:58~07:35 KST). 그래서
 * **12시간 안에 받은 것은 다시 받지 않는다.** 하루 최대 두 번이면 그날 갱신을 놓치지
 * 않으면서 KIS 서버를 반복해서 두드리지 않는다.
 *
 * "언제 받았는지"는 파일 mtime으로 알 수 없다 — mtime은 일부러 **내용의 기준일**로
 * 덮어쓰기 때문이다. 그래서 받은 시각은 `master-download.json`에 따로 적는다.
 * 이 두 시각을 섞지 않는 것이 `themes.source_modified_at`과 `synced_at`을 나눠 둔 것과
 * 같은 이유다.
 */

import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { DOMESTIC_MASTER_SPECS, parseDomesticMasterRow } from './domesticMaster.js';
import { INDEX_SECTOR_MASTER_FILE, parseIndexSectorNames } from './indexSectorMaster.js';
import { readSingleEntryZip } from './masterArchive.js';
import { parseThemeMaster, THEME_MASTER_FILE } from './themeMaster.js';

/** 인증 없이 열려 있는 공개 마스터 경로. 실전/모의와 무관하므로 `config.ts` 분기 대상이 아니다. */
export const MASTER_DOWNLOAD_BASE = 'https://new.real.download.dws.co.kr/common/master';

/** 받은 시각을 적어 두는 파일. 파일 mtime은 내용 기준일이라 이 용도로 못 쓴다. */
export const MASTER_DOWNLOAD_MANIFEST = 'master-download.json';

/** 하루 한 번 만들어지는 파일이라 12시간이면 그날 갱신을 놓치지 않는다. */
const DEFAULT_MAX_AGE_HOURS = 12;

/** 한 파일당 요청 제한 시간. 국내 5종은 zip으로 합쳐 260KB뿐이라 넉넉한 값이다. */
const REQUEST_TIMEOUT_MS = 30_000;

const decoder = new TextDecoder('euc-kr');

/** 받을 수 있는 마스터 하나. `validate`는 어긋나면 던진다 — 값을 돌려주지 않는다. */
export interface MasterFileSpec {
  /** backend/.cache 안의 파일명 (`kospi_code.mst`) */
  file: string;
  /** 푼 내용을 실제 파서로 끝까지 읽어 본다. 갈아 끼우기 전에 부른다 */
  validate: (text: string) => void;
}

/**
 * 이번 단위에서 받는 국내 마스터 5종. 파일명은 파서 모듈의 상수에서 가져와
 * 두 곳이 어긋나지 않게 한다.
 *
 * 해외(`*MST.COD`)·선물(`ffcode.mst`)·채권은 경로와 형식이 달라 넣지 않았다.
 * backend/.cache에 있는 그 파일들은 지금도 손으로 넣은 것들이다.
 */
export const DOWNLOADABLE_MASTERS: readonly MasterFileSpec[] = [
  ...DOMESTIC_MASTER_SPECS.map((spec) => ({
    file: spec.file,
    validate: (text: string): void => {
      for (const row of splitRows(text)) parseDomesticMasterRow(row, spec);
    },
  })),
  {
    file: INDEX_SECTOR_MASTER_FILE,
    validate: (text: string): void => {
      parseIndexSectorNames(text);
    },
  },
  {
    file: THEME_MASTER_FILE,
    validate: (text: string): void => {
      parseThemeMaster(text);
    },
  },
];

/**
 * 시험이 네트워크 없이 돌 수 있게 좁혀 둔 fetch 모양. 전역 `fetch`가 그대로 들어간다.
 */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface MasterDownloadOptions {
  /** 마스터를 둘 디렉터리 */
  dir: string;
  /** 이 시간 안에 받은 파일은 건너뛴다 */
  maxAgeHours?: number;
  /** 최근에 받았어도 다시 받는다 */
  force?: boolean;
  /** 받을 파일. 기본은 국내 5종 전부 */
  files?: readonly MasterFileSpec[];
  /** 시험용 주입구 */
  fetchImpl?: FetchLike;
}

/** 한 파일의 결과. `삼항 사슬` 대신 이 값으로 갈라 적는다. */
export type MasterDownloadStatus =
  /** 받아서 갈아 끼웠다 */
  | 'downloaded'
  /** 최근에 받은 것이 있어 건너뛰었다 */
  | 'skipped'
  /** 못 받았다. 기존 파일은 손대지 않았다 */
  | 'failed';

export interface MasterDownloadResult {
  file: string;
  status: MasterDownloadStatus;
  /**
   * ★ 이 내용의 기준일(zip 내부 타임스탬프). 건너뛰었거나 실패했을 때는 디스크에 있는
   * 파일의 mtime이고, 쓸 파일이 아예 없으면 `null`이다.
   */
  sourceModifiedAt: Date | null;
  /** 새 파일의 행 수. 받았을 때만 있다 */
  rowCount: number | null;
  /**
   * 갈아 끼우기 전 파일의 행 수. 처음 받는 것이면 `null`이다.
   * **줄었다고 막지는 않는다** — 상장폐지로 실제로 줄 수 있다. 다만 로그에 남긴다.
   */
  previousRowCount: number | null;
  /** 푼 파일 크기(바이트). 받았을 때만 있다 */
  bytes: number | null;
  /** 실패 사유 */
  error: string | null;
  /** 이 파일로 동기화를 돌릴 수 있는가 (새로 받았거나 기존 파일이 남아 있는가) */
  usable: boolean;
}

interface ManifestEntry {
  /** 우리가 받아온 시각 */
  fetchedAt: string;
  /** ★ zip 내부 타임스탬프 = 내용의 기준일 */
  sourceModifiedAt: string;
  /** 응답 `Last-Modified` = zip을 재포장한 시각. **내용 기준일이 아니다** */
  archivePackagedAt: string | null;
  bytes: number;
  rowCount: number;
}

type Manifest = Record<string, ManifestEntry>;

/**
 * 마스터들을 순서대로 받는다. **한 번에 하나씩** 친다 — 5개를 동시에 던져 KIS 서버를
 * 두드릴 이유가 없다(실측 5개 합계 260KB).
 *
 * 한 파일이 실패해도 나머지를 계속 받고, 던지지 않는다. 무엇이 못 받아졌는지는
 * 결과의 `status`·`error`로 넘긴다 — 부르는 쪽이 "기존 파일로 돌릴지"를 정한다.
 */
export async function downloadMasters(
  options: MasterDownloadOptions,
): Promise<MasterDownloadResult[]> {
  const files = options.files ?? DOWNLOADABLE_MASTERS;
  const maxAgeMs = (options.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS) * 3_600_000;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const manifestPath = resolve(options.dir, MASTER_DOWNLOAD_MANIFEST);
  // 새로 클론한 뒤에는 .cache가 아예 없다. 없으면 임시 파일 쓰기가 ENOENT로 죽어
  // "받았는데 못 썼다"가 되므로 먼저 만든다.
  await mkdir(options.dir, { recursive: true });
  const manifest = await readManifest(manifestPath);

  const results: MasterDownloadResult[] = [];
  for (const spec of files) {
    const result = await downloadOne(spec, {
      dir: options.dir,
      force: options.force ?? false,
      maxAgeMs,
      fetchImpl,
      manifest,
    });
    results.push(result);
  }

  await writeManifest(manifestPath, manifest);
  return results;
}

/**
 * 결과 한 줄을 사람이 읽는 말로 바꾼다.
 *
 * 스크립트가 둘(`download:masters` · `sync:instruments`)이라 각자 제 나름의 말을 붙이면
 * 같은 상태가 두 가지로 불린다. 문구는 여기 한 곳에서만 만든다.
 *
 * **기준일에는 며칠 묵었는지를 함께 적는다.** 손으로 넣던 시절에 20일·2개월·9개월
 * 묵은 파일이 섞여 있었는데 아무도 몰랐던 것이 이 작업의 출발점이다.
 */
export function describeMasterDownload(result: MasterDownloadResult, now = new Date()): string {
  const label = result.file.padEnd(16);
  const source = result.sourceModifiedAt
    ? `기준일 ${formatDate(result.sourceModifiedAt)} (${ageDays(result.sourceModifiedAt, now).toLocaleString('ko-KR')}일 전)`
    : '기준일 모름';

  const detail: Record<MasterDownloadStatus, () => string> = {
    downloaded: () =>
      `받음 ${(result.rowCount ?? 0).toLocaleString('ko-KR')}행${formatRowDelta(result)} · ` +
      `${source} · ${(result.bytes ?? 0).toLocaleString('ko-KR')}바이트`,
    skipped: () => `건너뜀 (최근에 받았습니다) · ${source}`,
    failed: () =>
      `실패: ${result.error ?? '사유 없음'} · ` +
      (result.usable ? `기존 파일로 진행합니다 (${source})` : '쓸 파일이 없습니다'),
  };

  return `${label}${detail[result.status]()}`;
}

/**
 * 행 수가 얼마나 바뀌었는지. **줄었다고 막지 않는다** — 상장폐지·코드변경으로 실제로
 * 줄 수 있고, 막으면 영영 낡은 파일로 돌게 된다. 대신 눈에 띄게 적는다.
 */
function formatRowDelta(result: MasterDownloadResult): string {
  if (result.previousRowCount === null || result.rowCount === null) return ' (처음 받음)';
  const delta = result.rowCount - result.previousRowCount;
  if (delta === 0) return ' (이전과 같음)';
  const sign = delta > 0 ? '+' : '−';
  return ` (이전 ${result.previousRowCount.toLocaleString('ko-KR')}행, ${sign}${Math.abs(delta).toLocaleString('ko-KR')})`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });
}

function ageDays(date: Date, now: Date): number {
  return Math.floor((now.getTime() - date.getTime()) / 86_400_000);
}

interface DownloadOneContext {
  dir: string;
  force: boolean;
  maxAgeMs: number;
  fetchImpl: FetchLike;
  manifest: Manifest;
}

async function downloadOne(
  spec: MasterFileSpec,
  ctx: DownloadOneContext,
): Promise<MasterDownloadResult> {
  const path = resolve(ctx.dir, spec.file);
  const existing = await statOrNull(path);

  if (!ctx.force && existing && isFresh(ctx.manifest[spec.file], ctx.maxAgeMs)) {
    return {
      file: spec.file,
      status: 'skipped',
      // 건너뛴 파일의 기준일은 디스크의 mtime이다. 우리가 그렇게 얹어 둔 값이다.
      sourceModifiedAt: existing.mtime,
      rowCount: null,
      previousRowCount: null,
      bytes: null,
      error: null,
      usable: true,
    };
  }

  try {
    const { entry, packagedAt } = await fetchMaster(spec.file, ctx.fetchImpl);
    if (entry.name !== spec.file) {
      throw new Error(`zip 안의 이름이 다릅니다 (${JSON.stringify(entry.name)}).`);
    }

    const text = decoder.decode(entry.data);
    spec.validate(text);
    const rowCount = assertMasterContent(text, spec.file);

    const previousRowCount = existing ? countRows(decoder.decode(await readFile(path))) : null;
    await replaceFile(path, entry.data, entry.modifiedAt);

    ctx.manifest[spec.file] = {
      fetchedAt: new Date().toISOString(),
      sourceModifiedAt: entry.modifiedAt.toISOString(),
      archivePackagedAt: packagedAt,
      bytes: entry.data.length,
      rowCount,
    };

    return {
      file: spec.file,
      status: 'downloaded',
      sourceModifiedAt: entry.modifiedAt,
      rowCount,
      previousRowCount,
      bytes: entry.data.length,
      error: null,
      usable: true,
    };
  } catch (error) {
    return {
      file: spec.file,
      status: 'failed',
      sourceModifiedAt: existing?.mtime ?? null,
      rowCount: null,
      previousRowCount: null,
      bytes: null,
      error: error instanceof Error ? error.message : String(error),
      // 기존 파일에는 손대지 않았다. 있으면 그걸로 돌릴 수 있다.
      usable: existing !== null,
    };
  }
}

async function fetchMaster(
  file: string,
  fetchImpl: FetchLike,
): Promise<{ entry: ReturnType<typeof readSingleEntryZip>; packagedAt: string | null }> {
  const url = `${MASTER_DOWNLOAD_BASE}/${file}.zip`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`${url} 응답이 ${response.status} ${response.statusText}입니다.`);
  }
  const archive = Buffer.from(await response.arrayBuffer());
  return {
    entry: readSingleEntryZip(archive, `${file}.zip`),
    packagedAt: response.headers.get('last-modified'),
  };
}

/**
 * ★ 임시 파일에 쓰고 **내부 타임스탬프를 얹은 뒤** 갈아 끼운다.
 *
 * `utimes`를 `rename` 앞에 부르는 것이 요점이다. `rename`은 mtime을 건드리지 않으므로
 * 시각이 그대로 따라간다. 순서를 뒤집으면 잠깐이지만 오늘 날짜의 파일이 노출된다.
 * 임시 파일을 같은 디렉터리에 두는 것도 요점이다 — 파일시스템이 다르면 `rename`이
 * 복사가 되어 원자성이 깨진다.
 */
async function replaceFile(path: string, data: Buffer, modifiedAt: Date): Promise<void> {
  const tempPath = `${path}.download-${process.pid}.tmp`;
  try {
    await writeFile(tempPath, data);
    await utimes(tempPath, modifiedAt, modifiedAt);
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function isFresh(entry: ManifestEntry | undefined, maxAgeMs: number): boolean {
  if (!entry) return false;
  const fetchedAt = Date.parse(entry.fetchedAt);
  if (Number.isNaN(fetchedAt)) return false;
  return Date.now() - fetchedAt < maxAgeMs;
}

async function readManifest(path: string): Promise<Manifest> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Manifest;
  } catch {
    // 없거나 깨졌으면 빈 것으로 시작한다. 이 파일은 "언제 받았나"만 담고 있어
    // 잃어도 한 번 더 받으면 그만이다.
    return {};
  }
}

async function writeManifest(path: string, manifest: Manifest): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function statOrNull(path: string): Promise<{ mtime: Date } | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/**
 * 갈아 끼우기 직전의 마지막 그물. 행이 하나도 없으면 던지고, 있으면 행 수를 준다.
 *
 * 파서들은 **행마다** 검사하므로 행이 0개면 아무 말 없이 통과한다 — 빈 파일이
 * 마스터를 덮어쓰면 종목이 통째로 사라진다. zip 단계(길이·CRC)에서 대부분 걸리지만
 * "형식은 맞는데 내용이 빈" 응답은 여기서만 걸린다.
 */
export function assertMasterContent(text: string, file: string): number {
  const rowCount = countRows(text);
  if (rowCount === 0) {
    throw new Error(`${file}: 받은 파일에 행이 하나도 없습니다.`);
  }
  return rowCount;
}

/** 마스터 파일의 행. 빈 줄은 세지 않는다 (파서들과 같은 규칙). */
function splitRows(text: string): string[] {
  return text.split(/\r?\n/).filter((row) => row.trim());
}

function countRows(text: string): number {
  return splitRows(text).length;
}
