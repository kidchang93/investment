import { resolve } from 'node:path';
import { describeMasterDownload, downloadMasters } from '../kis/masterDownload.js';

/**
 * KIS 공개 마스터 파일을 backend/.cache로 받아 온다.
 *
 *   npm run download:masters -w backend            # 최근에 받은 것은 건너뛴다
 *   npm run download:masters -w backend -- --force # 무조건 다시 받는다
 *
 * `sync:instruments`가 이걸 먼저 부르므로 보통은 따로 돌릴 일이 없다. 형식이 바뀌었는지
 * 동기화 없이 확인하고 싶을 때(파서만 통과시키고 DB는 건드리지 않는다) 쓴다.
 *
 * 인증이 필요 없는 공개 파일이라 토큰을 발급하지 않는다 — Postgres도 켜 있지 않아도 된다.
 */

const MASTER_DIR = resolve(process.cwd(), '.cache');

async function main(): Promise<void> {
  const force = process.argv.includes('--force');
  const results = await downloadMasters({ dir: MASTER_DIR, force });

  for (const result of results) console.log(describeMasterDownload(result));

  const unusable = results.filter((result) => !result.usable);
  if (unusable.length > 0) {
    console.error(
      `쓸 파일이 없는 마스터 ${unusable.length}건: ${unusable.map((r) => r.file).join(', ')}`,
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
