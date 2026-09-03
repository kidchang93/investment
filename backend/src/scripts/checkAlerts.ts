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
import { getTodaySubmittedQuantities } from '../db/brokerOrders.js';
import { getLayerPositions } from '../db/layers.js';
import { getRiskRules } from '../db/riskRules.js';
import { getKisDomesticAccountSnapshot } from '../kis/rest.js';
import { escapeMrkdwn, sendSlack } from '../notify/slack.js';
import { splitByNotice } from '../trading/alertNotice.js';
import { explainMismatches, reconcile } from '../trading/layers.js';

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
   * ★★ **가장 작은 값으로 본다.** 중단선은 보수적이어야 하고, 값들이 서로
   * 다르게 틀리기 때문이다:
   *
   *   D+2 정산액 + 주식   실제로 쓸 수 있는 돈. 보통 이것이 맞다
   *   총평가              모의 서버가 전일 매수대금을 한 번 더 뺀 적이 있다
   *                       (2026-08-12: 절반으로 나왔다가 정산 뒤 돌아왔다)
   *
   * ── ★★ D+0을 뺀 이유 (2026-09-03) ──────────────────────────────────
   *
   * 전에는 `D+0 예수금 + 주식`도 후보에 넣고 *"오늘 산 것이 안 빠져 부풀어
   * 보인다"*고 적어 두었다. **그 설명이 반쪽이었다** — D+0은 오늘 **판** 것도
   * 안 들어와 있어서, 매도가 많은 날에는 반대로 **쪼그라든다.**
   *
   * 그날 ETF를 1,650만원어치 팔자 D+0이 5,788만원으로 나왔다(D+2·총평가는
   * 9,483만원). 3,700만원 적은 값이 중단선 7,600만원 아래로 떨어져 **없는
   * 손실로 경보가 울렸고**, `checkAlerts`가 종료코드 1을 내자 스케줄러가
   * `watch`를 실패로 보아 하트비트를 안 남겼다. 매 분 재시도가 트랙 B를
   * 점유해 **`fair-value`가 2시간 반을 굶었다.**
   *
   * ★ D+0은 **양방향으로 틀린다.** 사는 날엔 부풀고 파는 날엔 쪼그라든다 —
   *   그래서 "작은 쪽을 고른다"는 보수적 규칙이 성립하지 않는다. 뺀다.
   */
  const stock = snapshot.stockEvaluation ?? 0;
  const byD2 = (snapshot.settlementCash ?? 0) + stock;
  const byTotal = snapshot.totalEvaluation ?? 0;
  const candidates = [byD2, byTotal].filter((v) => v > 0);
  const equity = candidates.length > 0 ? Math.min(...candidates) : 0;
  const spread = candidates.length > 0 ? Math.max(...candidates) - equity : 0;
  // 1% 넘게 갈리면 어느 값을 썼는지 밝힌다 — 조용히 고르면 나중에 못 되짚는다.
  if (spread > equity * 0.01) {
    console.log(
      `  (자산 계산이 갈린다 — D+2 ${won(byD2)} · 총평가 ${won(byTotal)}`
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
  /*
   * ★★ **오늘 우리가 낸 주문으로 설명되는 차이는 알리지 않는다** (2026-09-02).
   *
   * 장부는 체결이 확인된 것만 담고 그 확인은 마감 정리에서 한다. 그래서 장중에
   * 체결되면 15:40까지 **반드시** 어긋나 보인다 — 그 정상 상태가 20분마다
   * 경보로 나갔다. 이 경보는 2026-08-21에 하루 16번 울려 감시를 통째로 멈추게
   * 한 전력이 있고, 그때 붙인 중복 억제는 **매매하는 날마다 한 번**은 그대로
   * 울리게 둔다. 매일 울리는 경보는 읽히지 않고, 그러면 8/25 삼성전자처럼
   * 진짜로 빠진 것을 8일간 못 본다.
   *
   * ★ 설명으로 인정하는 것은 **우리 주문뿐**이다. 사람이 손으로 판 것은 여전히
   *   알린다 — 그것이야말로 이 경보가 잡아야 할 일이다.
   */
  const positions = await getLayerPositions(accountId);
  const brokerQty = new Map(snapshot.positions.map((p) => [p.symbol, p.quantity]));
  const explained = explainMismatches(
    reconcile(positions, brokerQty),
    await getTodaySubmittedQuantities(accountId),
  );
  const pendingSync = explained.filter((m) => m.explained);
  const mismatches = explained.filter((m) => !m.explained);
  if (pendingSync.length > 0) {
    // 경보는 아니지만 **로그에는 남긴다.** 조용히 지나가면 나중에 못 되짚는다.
    console.log(
      `  (오늘 낸 주문으로 설명되는 차이 ${pendingSync.length}종목:`
      + ` ${pendingSync.map((m) => m.symbol).join(' ')} — 마감 정리에서 들어온다)`,
    );
  }
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
    /*
     * ★ **슬랙도 같은 억제를 받는다.** `fresh`만 보내므로 하루 한 번이다 —
     *   슬랙에 16번 울리면 macOS 알림으로 겪은 일(2026-08-21에 사용자가 데몬을
     *   껐다)이 채널에서 되풀이될 뿐이다. 알림을 늘리는 것이 아니라
     *   **닿는 곳을 늘리는 것**이 목적이다.
     */
    await sendSlack(
      `:warning: *투자 경보 ${fresh.length}건* · ${accountId}\n`
      + fresh.map((a) => `• ${escapeMrkdwn(a.message)}\n  ↳ ${escapeMrkdwn(a.action)}`).join('\n'),
    );
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
