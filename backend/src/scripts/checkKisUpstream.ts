/**
 * **KIS 공식 저장소가 우리가 쓰는 곳을 바꿨나.** 바뀌었으면 알린다.
 *
 * ── 왜 (2026-09-03) ──────────────────────────────────────────────────────
 *
 * 사용자가 짚었다 — *"KIS 깃 포크해온 레포였나. 업데이트 계속 해줘야 될 것 같다."*
 *
 * 이 레포는 **포크가 아니다**(첫 커밋부터 직접 만들었다). 그런데 KIS 스펙을
 * **숫자로 박아 두고** 있어서 우려는 정확하다:
 *
 *   realtime.ts     FIELDS_PER_RECORD = 47 · 야간선물 49
 *                   ★ 2026-09-11에 46→47로 바뀌었는데 이 스크립트가 못 잡았다 — GitHub
 *                     샘플이 안 바뀌었고 KIS 공지(2026-09-09)에만 있었다
 *   multiQuote.ts   MULTI_QUOTE_MAX_CODES = 30
 *   orderDivisions.ts  주문 구분 코드표
 *   errorCodes.ts   서버 불일치 vs 없는 기능
 *
 * KIS가 스펙을 바꾸면 이것들이 **조용히 거짓이 된다.** 멀티시세는 31개를 보내도
 * 오류가 안 나고 31번째만 사라졌다(CLAUDE.md 4-1) — 그런 종류의 침묵이다.
 *
 * ── pull은 한다 (2026-09-03 사용자 결정) ────────────────────────────────
 *
 * 처음엔 `fetch`만 하고 받지 않게 짰다. 사용자가 정리했다 — *"웬만해선 API
 * 호출하는 데 있어서 큰 변화는 없을 거야. git pull 해도 상관없고, 만약 큰
 * 변화가 있다면 공지사항에 나올 테니 그걸 확인하면 될 것 같아."*
 *
 * 맞다. 클론은 **읽기 전용 참고 자료**라 최신이 낫고, 우리 코드가 그 파일을
 * 빌드에 쓰지 않는다. 받아 두고 **무엇이 바뀌었는지만 알린다.**
 *
 * ★ **공지사항은 아직 사람이 읽는다 — 알림에 링크를 넣는다.** 처음엔 "자동으로
 *   못 읽는다"고 적었다. 게시판 화면은 SPA라 HTML에는 빈 목록(`총 0건`)만 오기
 *   때문이다. **틀렸다** — 화면이 부르는 `apiportal.koreainvestment.com/api/forums/
 *   {forumId}/posts/{id}`가 로그인 없이 JSON을 준다(2026-09-15 확인 · forumId는
 *   아래 `NOTICE_URL` 끝의 값 · 목록은 `sort`·`page`·`size`를 빼면 500이다).
 *   그 공지(2026-09-09, 애프터마켓·`H0STCNT0` 47필드)를 이 스크립트가 못 잡아
 *   나흘간 체결을 버렸다. 공지를 자동으로 읽게 할지는 아직 사용자가 정하지 않았다.
 *
 * ── ★★ 우리가 쓰는 경로만 본다 ──────────────────────────────────────────
 *
 * 공식 레포에는 백테스터·전략빌더·MCP가 함께 있는데 **우리는 안 쓴다.**
 * 2026-08-26 커밋이 딱 그쪽만 고쳤다 — 전부 알리면 곧 아무도 안 읽는다.
 *
 *   npx tsx src/scripts/checkKisUpstream.ts [--notify]
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import '../config.js';

import { escapeMrkdwn, sendSlackBot, slackBotConfigured } from '../notify/slack.js';

const run = promisify(execFile);

/** 클론이 있을 만한 자리. 없으면 조용히 건너뛴다 — 이것 때문에 자동화가 실패하면 안 된다 */
const CANDIDATE_PATHS = [
  process.env.KIS_UPSTREAM_PATH,
  join(homedir(), 'Desktop/ck/privacy/open-trading-api'),
].filter((p): p is string => typeof p === 'string' && p.length > 0);

/**
 * 우리가 스펙 출처로 삼는 경로.
 *
 * ★ 늘리는 것은 사람의 결정이다 — 여기 없는 곳이 바뀌면 안 알린다.
 */
const WATCHED = [
  'examples_user/',   // REST TR·파라미터
  'legacy/websocket/', // 실시간 프레임 필드 배치
  'legacy/rest/',      // 구버전 REST 샘플
  'docs/',             // 스펙 문서
  'stocks_info/',      // 종목 마스터 규격
];

/** 큰 변화는 여기 난다. 자동으로 읽을지 안 정했으므로 링크만 실어 보낸다 */
const NOTICE_URL = 'https://apiportal.koreainvestment.com/community/10000000-0000-0011-0000-000000000001';

function findClone(): string | null {
  for (const p of CANDIDATE_PATHS) if (existsSync(join(p, '.git'))) return p;
  return null;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

/**
 * 받아 둔다. **`--ff-only`다** — 이 클론은 읽기 전용 참고 자료이고, 우리가 커밋한
 * 것이 있다면 그건 사고이므로 조용히 병합해 덮지 않는다.
 */
async function pull(repo: string, branch: string): Promise<void> {
  try {
    await git(repo, ['merge', '--ff-only', `origin/${branch}`]);
    console.log('  받았다 (ff-only).');
  } catch (error) {
    console.log(`  ★ 받지 못했다 — 로컬에 커밋이 있는 것 같다: ${(error as Error).message.slice(0, 100)}`);
  }
}

async function main(): Promise<void> {
  const notify = process.argv.includes('--notify');
  const repo = findClone();
  if (!repo) {
    console.log('KIS 공식 저장소 클론을 못 찾았다 — 건너뛴다.');
    console.log(`  찾아본 곳: ${CANDIDATE_PATHS.join(' · ')}`);
    console.log('  다른 곳에 있으면 KIS_UPSTREAM_PATH에 적는다.');
    return;
  }

  const branch = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  await git(repo, ['fetch', 'origin', '--quiet']);

  const behind = Number(await git(repo, ['rev-list', '--count', `HEAD..origin/${branch}`]));
  console.log(`KIS 공식 저장소 ${repo}\n  브랜치 ${branch} · 뒤처진 커밋 ${behind}개`);
  if (behind === 0) { console.log('  최신이다.'); return; }

  // ★ 우리가 쓰는 경로에 변경이 있나. 없으면 알리지 않는다.
  const changed = (await git(repo, [
    'diff', '--name-only', 'HEAD', `origin/${branch}`, '--', ...WATCHED,
  ])).split('\n').filter(Boolean);

  const allChanged = (await git(repo, ['diff', '--name-only', 'HEAD', `origin/${branch}`]))
    .split('\n').filter(Boolean);

  console.log(`  바뀐 파일 ${allChanged.length}개 중 **우리가 쓰는 것** ${changed.length}개`);

  if (changed.length === 0) {
    console.log('  우리가 쓰는 경로는 그대로다 — 알리지 않는다.');
    console.log(`  (바뀐 곳: ${[...new Set(allChanged.map((f) => f.split('/')[0]))].join(', ')})`);
    await pull(repo, branch);
    return;
  }

  const commits = await git(repo, [
    'log', '--format=%h %ad %s', '--date=short', `HEAD..origin/${branch}`, '--', ...WATCHED,
  ]);

  const lines = [
    `⚠️ *KIS 공식 저장소가 우리가 쓰는 곳을 바꿨습니다* — ${changed.length}개 파일`,
    '',
    ...changed.slice(0, 15).map((f) => `• \`${escapeMrkdwn(f)}\``),
    changed.length > 15 ? `_…외 ${changed.length - 15}개_` : '',
    '',
    '*커밋*',
    ...commits.split('\n').slice(0, 8).map((c) => `• ${escapeMrkdwn(c)}`),
    '',
    `_클론은 받아 두었습니다(${escapeMrkdwn(repo)}). **코드 반영은 사람이 정합니다.**_`,
    `_큰 변경은 공지사항에 납니다 → ${NOTICE_URL}_`,
  ].filter(Boolean);

  console.log(`\n${lines.join('\n')}`);

  if (notify && slackBotConfigured()) {
    const sent = await sendSlackBot(lines.join('\n'));
    console.log(sent ? '\n슬랙으로 알렸다.' : '\n슬랙 전송 실패.');
  }
  // ★ 알린 **뒤에** 받는다. 받고 나면 diff가 사라져 무엇을 알렸는지 못 되짚는다.
  await pull(repo, branch);
  // ★ 사람이 봐야 하는 변경이므로 종료코드로도 알린다.
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
