/**
 * 경보를 검사하고 **사람에게 알린다.** 읽기만 하고 주문을 내지 않는다.
 *
 * ── 왜 필요한가 (2026-08-18) ─────────────────────────────────────────────
 *
 * 무인이 성립하려면 다섯 조건이 필요한데 셋은 이미 있다(멱등 키·손실 한계·
 * 하트비트). **남은 것이 "감지한 것을 사람에게 전달하는 길"이었다.**
 * 지금은 데몬이 기록만 하고 아무도 안 본다 — 8/7부터 8일간 자동화가 조용히
 * 죽어 있던 것도 같은 이유였다.
 *
 *   npx tsx src/scripts/checkAlerts.ts [계좌id] [--notify]
 *
 * `--notify`면 macOS 알림 센터로 띄운다(터미널에서 뜬 프로세스라 권한이 있다).
 * 없으면 화면에만 적는다.
 *
 * ★ **경보가 있으면 exit 1이다.** 부르는 쪽(데몬·자동 집행)이 그것으로 멈춘다.
 *
 * ★ **같은 경보를 하루에 한 번만 알린다**(2026-08-22). 2026-08-21에 경보 하나가
 *   20분마다 16번 울려 사용자가 데몬을 껐다 — 왜 그렇게 정했는지는
 *   `trading/alertNotice.ts`에 적었다. 억제되는 것은 **알림뿐이고** 경보 자체와
 *   종료 코드는 그대로다. 사람이 부를 때(`--notify` 없음)는 억제하지 않는다.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { getKisAccount } from '../config.js';
import { getAlertNotices, markAlertNotified } from '../db/alertNotices.js';
import { closeDb, pool } from '../db/client.js';
import { getLayerPositions } from '../db/layers.js';
import { getRiskRules } from '../db/riskRules.js';
import { getKisDomesticAccountSnapshot } from '../kis/rest.js';
import { splitByNotice } from '../trading/alertNotice.js';
import { reconcile } from '../trading/layers.js';

const run = promisify(execFile);
const won = (n: number): string => Math.round(n).toLocaleString('ko-KR');

interface Alert {
  /** 경보 종류. 알림 이력에서 이 경보를 찾는 자리 */
  key: string;
  /**
   * 내용의 정체성. 바뀌면 그날 안이라도 다시 알린다.
   *
   * ★ **매번 달라지는 값을 넣지 않는다** — 자산 평가액을 넣으면 시세가 움직일
   *   때마다 새 경보가 되어 억제가 한 번도 안 걸린다.
   */
  digest: string;
  /** 사람이 읽을 한 줄 */
  message: string;
  /** 무엇을 해야 하나 */
  action: string;
}

/**
 * macOS 알림. **실패해도 검사를 깨뜨리지 않는다** — 알림은 전달 수단이지
 * 판정이 아니다. 따옴표가 든 문자열이 스크립트를 깨지 않게 이스케이프한다.
 */
async function notify(title: string, body: string): Promise<void> {
  const esc = (t: string): string => t.replace(/["\\]/g, '\\$&');
  try {
    await run('osascript', [
      '-e',
      `display notification "${esc(body)}" with title "${esc(title)}" sound name "Basso"`,
    ]);
  } catch {
    // 알림을 못 띄워도 화면 출력은 남는다.
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const accountId = args.find((a) => !a.startsWith('--')) ?? 'VTS-ORDINARY';
  const shouldNotify = args.includes('--notify');
  const account = getKisAccount(accountId);
  if (!account) throw new Error(`등록되지 않은 계좌: ${accountId}`);

  const alerts: Alert[] = [];
  const snapshot = await getKisDomesticAccountSnapshot(account);
  const rules = await getRiskRules(accountId);

  // ── ① 중단선 ────────────────────────────────────────────────────────
  /*
   * ★★ **가장 작은 값으로 본다.** 중단선은 보수적이어야 하고, 세 값이 서로
   * 다르게 틀리기 때문이다:
   *
   *   D+0 예수금 + 주식   오늘 산 것이 안 빠져 **부풀어 보인다**
   *                       (2026-08-18 실측: 1.26억 vs 실제 0.97억, +2,850만)
   *   D+2 정산액 + 주식   실제로 쓸 수 있는 돈. 보통 이것이 맞다
   *   총평가              모의 서버가 전일 매수대금을 한 번 더 뺀 적이 있다
   *                       (2026-08-12: 절반으로 나왔다가 정산 뒤 돌아왔다)
   *
   * 부풀면 중단선을 늦게 잡고, 쪼그라들면 없는 손실로 멈춘다. **늦게 잡는 쪽이
   * 더 위험하므로** 작은 값을 쓰되, 값들이 크게 갈리면 그 사실을 함께 적는다.
   */
  const stock = snapshot.stockEvaluation ?? 0;
  const byD0 = (snapshot.cashBalance ?? 0) + stock;
  const byD2 = (snapshot.settlementCash ?? 0) + stock;
  const byTotal = snapshot.totalEvaluation ?? 0;
  const candidates = [byD0, byD2, byTotal].filter((v) => v > 0);
  const equity = candidates.length > 0 ? Math.min(...candidates) : 0;
  const spread = candidates.length > 0 ? Math.max(...candidates) - equity : 0;
  // 1% 넘게 갈리면 어느 값을 썼는지 밝힌다 — 조용히 고르면 나중에 못 되짚는다.
  if (spread > equity * 0.01) {
    console.log(
      `  (자산 계산이 갈린다 — D+0 ${won(byD0)} · D+2 ${won(byD2)} · 총평가 ${won(byTotal)}`
      + ` → 가장 작은 ${won(equity)}원으로 본다)`,
    );
  }
  if (rules.stopEquity > 0 && equity < rules.stopEquity) {
    alerts.push({
      key: 'stop-equity',
      // 자산은 시세 따라 매초 바뀐다. 정체성은 **중단선 아래라는 사실** 하나다.
      digest: String(rules.stopEquity),
      message: `중단선 도달 — 자산 ${won(equity)}원 < ${won(rules.stopEquity)}원`,
      action: '새 매수를 멈추고 무엇이 빠졌는지 본다. 자동 집행은 이 상태에서 거부된다.',
    });
  }

  // ── ② 장부와 잔고 ───────────────────────────────────────────────────
  const positions = await getLayerPositions(accountId);
  const brokerQty = new Map(snapshot.positions.map((p) => [p.symbol, p.quantity]));
  const mismatches = reconcile(positions, brokerQty);
  if (mismatches.length > 0) {
    const symbols = mismatches.map((m) => m.symbol);
    alerts.push({
      key: 'layer-mismatch',
      // 어긋난 종목이 바뀌면 새 사실이다. 수량 차이까지는 안 담는다 —
      // 부분체결이 이어지는 동안 매 회차 값이 달라져 억제가 안 걸린다.
      digest: [...symbols].sort().join(' '),
      message: `장부와 잔고가 ${mismatches.length}종목 어긋난다 (${symbols.join(' ')})`,
      action: 'npx tsx src/scripts/layerSync.ts 로 빠진 체결을 넣는다. 층별 손익은 그때까지 믿을 수 없다.',
    });
  }

  // ── ③ 자동화가 돌고 있나 ────────────────────────────────────────────
  /*
   * 평일 개장 뒤인데 오늘 하트비트가 없으면 데몬이 멈춰 있었다는 뜻이다.
   * 8/7부터 8일간 아무도 몰랐던 것이 정확히 이 상태였다.
   */
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM trading_heartbeats
      WHERE (ran_at AT TIME ZONE 'Asia/Seoul')::date = (now() AT TIME ZONE 'Asia/Seoul')::date`,
  );
  const seoulNow = new Date(Date.now() + 9 * 3600 * 1000);
  const dow = seoulNow.getUTCDay();
  const hhmm = seoulNow.getUTCHours() * 100 + seoulNow.getUTCMinutes();
  if (dow >= 1 && dow <= 5 && hhmm > 900 && Number(rows[0]?.n ?? 0) === 0) {
    alerts.push({
      key: 'daemon-idle',
      digest: '',
      message: '평일 개장 뒤인데 오늘 자동 실행 기록이 없다',
      action: 'zsh scripts/daemon.sh status 로 확인하고 멈춰 있으면 start.',
    });
  }

  // ── 결과 ────────────────────────────────────────────────────────────
  const stamp = seoulNow.toISOString().slice(11, 19);
  if (alerts.length === 0) {
    console.log(`${stamp} 경보 없음 · 자산 ${won(equity)}원 · 중단선 ${won(rules.stopEquity)}원`);
    return;
  }

  /*
   * ★ **사람이 부를 때는 억제하지 않는다.** 손으로 부른 것은 "지금 상태를
   *   보여 달라"이므로 전부 찍는다. 억제는 데몬이 20분마다 부르는 자리
   *   (`--notify`)에만 건다.
   */
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
  const { fresh, muted } = shouldNotify
    ? splitByNotice(alerts, await getAlertNotices(accountId), today)
    : { fresh: alerts, muted: [] as Alert[] };

  console.log(`${stamp} ★ 경보 ${alerts.length}건${muted.length > 0 ? ` (새것 ${fresh.length})` : ''}`);
  for (const a of fresh) {
    console.log(`  ★ ${a.message}`);
    console.log(`    → ${a.action}`);
  }
  // 되풀이되는 것은 한 줄로 줄인다 — 없어진 것이 아니라 오늘 이미 알린 것이다.
  for (const a of muted) {
    console.log(`  · ${a.message} (오늘 이미 알렸다)`);
  }

  if (shouldNotify && fresh.length > 0) {
    await notify(`투자 경보 ${fresh.length}건`, fresh.map((a) => a.message).join(' / '));
    // 알림을 띄운 뒤에 적는다 — 먼저 적으면 실패한 알림이 하루를 조용하게 만든다.
    for (const a of fresh) await markAlertNotified(accountId, a.key, a.digest, today);
  }
  // 부르는 쪽이 이 값으로 멈춘다. **억제해도 경보는 경보다.**
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
