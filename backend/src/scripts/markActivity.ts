/**
 * **"지금 이걸 하고 있다"를 한 줄 남긴다.** 화면이 그 자세로 그린다.
 *
 *   npx tsx src/scripts/markActivity.ts <에이전트> <활동> [한 줄 설명]
 *
 * 에이전트: analyst · judge · closeJudge · executor · closer · guard · sweeper
 * 활동:     gathering · screening · researching · writing · ordering · measuring · idle
 *
 * ★ **실패해도 부르는 쪽을 멈추지 않는다.** 이건 꾸밈이지 판단이 아니다 —
 *   활동 기록이 안 됐다고 판단자가 죽으면 본말이 뒤집힌다. 종료 코드는 늘 0이다.
 */

import { closeDb } from '../db/client.js';
import { isAgentActivity, markAgentActivity } from '../db/agentActivity.js';

const [agent, activity, ...rest] = process.argv.slice(2);

async function main(): Promise<void> {
  if (!agent || !activity || !isAgentActivity(activity)) {
    console.log(`쓰는 법: markActivity.ts <에이전트> <활동> [설명]`);
    return;
  }
  await markAgentActivity(agent, activity, rest.join(' '));
  console.log(`${agent} → ${activity}${rest.length ? ` (${rest.join(' ')})` : ''}`);
}

main()
  .catch((error) => {
    // 조용히 넘기지 않되, 부르는 쪽을 멈추지도 않는다.
    console.log(`활동 기록 실패(무시): ${error instanceof Error ? error.message : error}`);
  })
  .finally(() => closeDb());
