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
 *   realtime.ts     FIELDS_PER_RECORD = 46 · 야간선물 49
 *   multiQuote.ts   MULTI_QUOTE_MAX_CODES = 30
 *   orderDivisions.ts  주문 구분 코드표
 *   errorCodes.ts   서버 불일치 vs 없는 기능
 *
 * KIS가 스펙을 바꾸면 이것들이 **조용히 거짓이 된다.** 멀티시세는 31개를 보내도
 * 오류가 안 나고 31번째만 사라졌다(CLAUDE.md 4-1) — 그런 종류의 침묵이다.
 *
 * ── ★ pull은 하지 않는다 ─────────────────────────────────────────────────
 *
 * `fetch`만 하고 **알리기만** 한다. 받아 놓은 파일이 참조 중에 바뀌면 무엇을
 * 보고 짠 코드인지 흐려진다. 받을지, 무엇을 고칠지는 사람이 정한다.
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

function findClone(): string | null {
  for (const p of CANDIDATE_PATHS) if (existsSync(join(p, '.git'))) return p;
  return null;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
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
    '_받지 않았습니다. `git pull`과 코드 반영은 사람이 정합니다._',
    `_확인: ${escapeMrkdwn(repo)}_`,
  ].filter(Boolean);

  console.log(`\n${lines.join('\n')}`);

  if (notify && slackBotConfigured()) {
    const sent = await sendSlackBot(lines.join('\n'));
    console.log(sent ? '\n슬랙으로 알렸다.' : '\n슬랙 전송 실패.');
  }
  // ★ 사람이 봐야 하는 변경이므로 종료코드로도 알린다.
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
