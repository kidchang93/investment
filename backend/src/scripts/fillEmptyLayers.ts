/**
 * **층이 비면 발굴 회차를 부른다.** 자동화가 스스로 빈 자리를 채우게 하는 고리다.
 *
 * ── 왜 (2026-09-03) ──────────────────────────────────────────────────────
 *
 * 사용자가 정했다 — *"빈층 채우기는 자동화로 진행해줘."*
 *
 * 그날 ETF 층을 60.8%→48.5%로 줄여 현금 3,148만원(33%)이 생겼는데, **자동화가
 * 그것을 쓸 길이 없었다.** 구조가 이랬다:
 *
 *   정식 회차(조사·발굴함)   → 하루 **한 번**   `daily: true`
 *   빠른 회차(조사 금지)     → 5분마다
 *
 * 그래서 단기 층이 8.7%/30%, 유망주가 9.8%/20%로 비어 있는데도 5분마다 도는
 * 판단자는 *"매수 여지가 있는 층에는 적정가 표 안에 살 종목이 없다. **새 종목
 * 발굴은 이 회차의 일이 아니다**"*라고 적고 지나갔다. 맞는 판단이었다 —
 * 그 회차에 발굴을 금지한 것이 우리다.
 *
 * ★★ **하루 한 번의 발굴로는 21%p를 못 채운다.** 이 스크립트가 빠진 고리다.
 *
 * ── 언제 부르나 ──────────────────────────────────────────────────────────
 *
 *   ① 어느 층이든 목표보다 `GAP_THRESHOLD` 이상 미달이고
 *   ② 매수여력이 `MIN_BUYING_POWER` 이상 남아 있고
 *   ③ 오늘 부른 횟수가 `MAX_ROUNDS_PER_DAY` 미만일 때
 *
 * ★ 셋 다여야 부른다. 정식 회차는 13분 걸리고 헤드리스 Claude 값이 든다 —
 *   **채울 돈이 없는데 부르면 그냥 낭비다.**
 *
 * ★ **주문을 내지 않는다.** 이 스크립트가 하는 일은 *"지금 발굴할 이유가 있나"*를
 *   판정하고 판단자를 부르는 것까지다. 무엇을 살지는 판단자가 정하고
 *   `plan`·`falsifier`와 함께 회차에 남긴다 — 그 경계를 여기서 넘지 않는다.
 *
 *   npx tsx src/scripts/fillEmptyLayers.ts [계좌id] [--execute]
 *     ★ `--execute` 없이는 **판정만** 한다.
 */

import { spawn } from 'node:child_process';

import '../config.js';

import { getKisAccount } from '../config.js';
import { closeDb, pool } from '../db/client.js';
import { getLayerPositions, getRealizedByLayer } from '../db/layers.js';
import { getKisDomesticAccountSnapshot, getKisDomesticOrderability } from '../kis/rest.js';
import { LAYER_LABELS, summarizeLayers } from '../trading/layers.js';

/** 목표보다 이만큼 넘게 비어 있어야 부른다. 몇 %p 어긋난 것은 늘 있다 */
const GAP_THRESHOLD = 0.05;
/**
 * 이보다 적으면 부르지 않는다. 자리 하나를 채우지도 못하는 돈으로 판단자를
 * 부르면 "살 수 있는 게 없다"는 회차만 쌓인다.
 */
const MIN_BUYING_POWER = 3_000_000;
/**
 * 하루 이만큼만. 정식 회차는 13분 걸리고 헤드리스 Claude 값이 든다.
 * ★ 한 번에 층이 다 차지는 않는다 — 자리 크기 상한(총자산 10%)이 있어서
 *   여러 회차에 나눠 채우는 것이 정상이다.
 */
const MAX_ROUNDS_PER_DAY = 4;
/** 이 하트비트로 오늘 몇 번 불렀는지 센다 */
const HEARTBEAT = 'layer-fill';

const won = (n: number): string => `${Math.round(n).toLocaleString('ko-KR')}원`;
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const accountId = args.find((a) => !a.startsWith('--')) ?? 'VTS-ORDINARY';

  const account = getKisAccount(accountId);
  if (!account) { console.error(`등록되지 않은 계좌: ${accountId}`); process.exitCode = 1; return; }

  // ── 층 비중 ──
  const snapshot = await getKisDomesticAccountSnapshot(account);
  const prices = new Map<string, number>();
  for (const p of snapshot.positions) {
    if (typeof p.currentPrice === 'number' && p.currentPrice > 0) prices.set(p.symbol, p.currentPrice);
  }
  const positions = await getLayerPositions(accountId);
  if (positions.length === 0) {
    console.log('장부가 비어 있다 — 층을 모르니 판정할 수 없다.');
    return;
  }
  // D+2를 쓴다. 오늘 산 것이 안 빠진 D+0로 비중을 내면 자산이 부푼다.
  const realized = await getRealizedByLayer(accountId);
  const { summaries, totalAssets } = summarizeLayers(
    positions, prices, realized, snapshot.settlementCash ?? 0,
  );

  const short = summaries
    .map((s) => ({ ...s, gap: s.targetWeight - s.weight }))
    .filter((s) => s.gap >= GAP_THRESHOLD)
    .sort((a, b) => b.gap - a.gap);

  console.log(`층 비중 · 총자산 ${won(totalAssets)}`);
  for (const s of summaries) {
    const gap = s.targetWeight - s.weight;
    const mark = gap >= GAP_THRESHOLD ? '★ 미달' : gap <= -GAP_THRESHOLD ? '  초과' : '  맞음';
    console.log(`  ${mark} ${LAYER_LABELS[s.layer]}  ${pct(s.weight)} / 목표 ${pct(s.targetWeight)}  (${gap >= 0 ? '+' : ''}${pct(gap)})`);
  }

  if (short.length === 0) {
    console.log(`\n부르지 않는다 — ${pct(GAP_THRESHOLD)} 넘게 비어 있는 층이 없다.`);
    return;
  }

  // ── 매수여력 ──
  /*
   * ★ **예수금이 아니라 매수여력을 본다.** 예수금에는 미체결이 묶어 둔 것도
   *   오늘 체결된 것도 아직 안 빠져 있다 — 2026-08-20에 예수금 19,649,294원인데
   *   매수여력은 984,524원이었다.
   */
  let buyingPower = 0;
  try {
    const ord = await getKisDomesticOrderability(account, '069500', 'limit', 100_000);
    buyingPower = ord.cashAvailable ?? 0;
  } catch (error) {
    console.log(`\n매수여력을 못 읽었다 — 부르지 않는다 (${(error as Error).message.slice(0, 60)})`);
    return;
  }
  console.log(`\n매수여력 ${won(buyingPower)}`);

  if (buyingPower < MIN_BUYING_POWER) {
    console.log(`부르지 않는다 — 매수여력이 문턱 ${won(MIN_BUYING_POWER)}에 못 미친다.`);
    return;
  }

  // ── 오늘 몇 번 불렀나 ──
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM trading_heartbeats
      WHERE name = $1
        AND (ran_at AT TIME ZONE 'Asia/Seoul')::date = (now() AT TIME ZONE 'Asia/Seoul')::date`,
    [HEARTBEAT],
  );
  const already = Number(rows[0]?.n ?? 0);
  if (already >= MAX_ROUNDS_PER_DAY) {
    console.log(`부르지 않는다 — 오늘 이미 ${already}번 불렀다(상한 ${MAX_ROUNDS_PER_DAY}).`);
    return;
  }

  const why = short.map((s) => `${LAYER_LABELS[s.layer]} ${pct(s.gap)} 미달`).join(' · ');
  console.log(`\n★ 발굴 회차를 부른다 (오늘 ${already + 1}/${MAX_ROUNDS_PER_DAY}) — ${why}`);
  if (!execute) { console.log('  [판정만 — 실제로 부르려면 --execute]'); return; }

  await pool.query(
    `INSERT INTO trading_heartbeats (name, status, note) VALUES ($1, 'ok', $2)`,
    [HEARTBEAT, why],
  );

  /*
   * ★ 백그라운드로 띄우고 **기다리지 않는다.** 정식 회차는 13분 걸리는데
   *   스케줄러 루프를 그동안 막을 수 없다. 중복은 `deliberate.sh`의 guard가 막는다.
   */
  const child = spawn('zsh', ['scripts/deliberate.sh', accountId], {
    cwd: process.cwd().endsWith('backend') ? '..' : '.',
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log('  발굴 회차를 띄웠다 — 결과는 trading_deliberations에 남는다.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
