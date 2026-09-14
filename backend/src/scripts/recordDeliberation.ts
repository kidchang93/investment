/**
 * 회의 한 회차를 표준입력(JSON)으로 받아 남긴다.
 *
 * 에이전트가 쓰라고 만든 입구다. 에이전트에게 SQL을 짜게 하면 형식이 매번 달라지고
 * **반증 조건 검사를 우회할 수 있다.** 입구를 하나로 두면 규율이 한 곳에 산다.
 *
 *   cat round.json | npx tsx src/scripts/recordDeliberation.ts
 *
 * 집행 결과는 집행기(`executeDeliberation.ts`)가 회차에 직접 붙인다.
 *
 * 형식은 `backend/src/db/deliberations.ts`의 `DeliberationRound`다. **짐작해서
 * 채우지 마라** — 모르는 항목은 `unknowns`에 적는 것이 이 표의 쓰임이다.
 */

import { recordDeliberation, type DeliberationRound } from '../db/deliberations.js';

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const raw = Buffer.concat(chunks).toString('utf8').trim();
if (raw.length === 0) {
  console.error('표준입력이 비었습니다. JSON을 파이프로 넘기세요.');
  process.exit(1);
}

let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch (e) {
  console.error(`JSON을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

try {
  const id = await recordDeliberation(parsed as DeliberationRound);
  console.log(`회차를 남겼습니다. id=${id}`);
  console.log('★ 판단은 고치지 않습니다.');
} catch (e) {
  console.error(`남기지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

process.exit(0);
