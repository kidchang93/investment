/**
 * 낸 신호를 채점하고 누적 성적을 찍는다.
 *
 * 장 마감 뒤에 돌린다. 여러 번 돌려도 같은 (신호, 기간)은 다시 채점되지
 * 않으므로 성적이 부풀지 않는다.
 *
 *   npx tsx src/scripts/scoreSignals.ts [계좌id]
 */

import { ensureSignalScoreSchema, getSignalScoreSummary } from '../db/signalScores.js';
import { scoreAccountSignals, SCORE_HORIZONS } from '../trading/scoring.js';
import { pool } from '../db/client.js';

async function main(): Promise<void> {
  const accountId = process.argv[2] ?? '21';
  await ensureSignalScoreSchema();

  const result = await scoreAccountSignals(accountId);
  console.log(
    `매수 신호 ${result.scanned}건 훑음 · 새로 채점 ${result.scored}건`
    + ` · 기간 미달 ${result.tooEarly}건 · 가격 못 구함 ${result.unresolved}건\n`,
  );

  const summary = await getSignalScoreSummary(accountId);
  if (summary.length === 0) {
    console.log('아직 채점된 신호가 없습니다. 자동매매를 돌려 신호를 쌓은 뒤 다음 거래일에 다시 돌리세요.');
    console.log(`채점 기간: ${SCORE_HORIZONS.join('·')}거래일 · 비용을 뺀 값으로 승패를 셉니다.`);
  } else {
    console.log('누적 성적 (비용 왕복 0.41%를 뺀 값)');
    for (const row of summary) {
      console.log(
        `  ${String(row.horizonDays).padStart(2)}거래일 후`
        + ` n=${String(row.count).padStart(4)}`
        + ` 승률 ${(row.winRate * 100).toFixed(1).padStart(5)}%`
        + ` 평균 ${row.avgNetReturn.toFixed(2).padStart(7)}%`
        + ` 중앙값 ${row.medianNetReturn.toFixed(2).padStart(7)}%`,
      );
    }
    console.log('\n평균과 중앙값이 벌어지면 몇 종목이 성적을 끌고 있다는 뜻이다.');
  }
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
