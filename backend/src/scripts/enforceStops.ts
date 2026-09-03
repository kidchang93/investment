/**
 * **손절을 실제로 집행한다.** 규칙이 하고, 판단자는 사후에 본다.
 *
 * ── 왜 규칙인가 (2026-08-20, 사용자가 정했다) ────────────────────────────
 *
 * 판단자가 사기 전에 `plan.stopPrice`를 적지만 **그건 거래소에 걸린 주문이
 * 아니었다.** 모의 서버가 스톱지정가(`ORD_DVSN=22`)를 거절하고, 손절 감시 러너는
 * 영구 정지 상태다. 남은 감시는 *"다음 회차가 눈으로 보는 것"*뿐인데, 판단자는
 * 하루 세 자리(정기 1 + 오전 1 + 오후 1)밖에 안 열린다. **자리를 다 쓰면 그날
 * 급락은 아무도 안 본다.**
 *
 * ★ 손절에 판단자를 부르지 않는 이유: 헤드리스 호출은 1~2분이 걸리고 **급락에는
 *   그 지연이 치명적이다.** 그리고 손절값은 판단자가 **사기 전에 스스로 적은 값**이라
 *   규칙이 그것을 집행하는 것은 새 판단이 아니다 — 자기가 한 약속을 지키는 것이다.
 *
 * ── 무엇을 하나 ──────────────────────────────────────────────────────────
 *
 *   npx tsx src/scripts/enforceStops.ts [계좌id] [--execute]
 *
 * `--execute`가 없으면 판정만 찍는다. 데몬이 장중 5분마다 `--execute`로 부른다.
 *
 * ★ **시장가로 판다.** 손절의 목적은 값을 잘 받는 것이 아니라 확실히 빠져나오는
 *   것이고, 급락 중에 지정가는 안 붙는다. 슬리피지보다 안 나가는 쪽이 위험하다.
 *
 * ★ **하루에 같은 종목을 두 번 손절하지 않는다** — `clientOrderId`가
 *   `stop-{종목}-{날짜}`라 서버 멱등성이 막는다. 5분마다 돌아도 주문은 한 번이다.
 *
 * ★ **미체결 매도가 이미 있으면 그만큼 뺀다**(`sellableQuantity`). 안 그러면
 *   없는 물량을 판다.
 *
 * 장 시간 밖에서는 서버 리스크 룰(09:00~15:30)이 거부한다 — 여기서 또 판정하지 않는다.
 */

import { getKisAccount } from '../config.js';
import { getDeliberations } from '../db/deliberations.js';
import { getKoreanInstrumentBySymbol } from '../db/instruments.js';
import { getLayerPositions } from '../db/layers.js';
import { getKisDomesticAccountSnapshot, getKisDomesticExecutions } from '../kis/rest.js';
import { escapeMrkdwn, sendSlack, sendSlackBot, won as slackWon } from '../notify/slack.js';
import type { Layer } from '../trading/layers.js';
import { checkStops, type StopRule } from '../trading/stopLoss.js';

const API_BASE = process.env.INVEST_API_BASE ?? 'http://localhost:4000';
const won = (n: number): string => Math.round(n).toLocaleString('ko-KR');

/**
 * 종목 → 층. **층 장부가 지금 그 종목을 어디에 두고 있나.**
 *
 * 매수 결정에 층이 안 적힌 옛 자리를 메우는 뒷받침이다. 같은 종목이 두 층에
 * 걸쳐 있으면 **비운다** — 어느 쪽에서 파는 것인지 우리가 모르는 것이고,
 * 짐작해서 고르면 두 층의 손익이 함께 거짓이 된다.
 */
async function layersOfLedger(accountId: string): Promise<Map<string, Layer | null>> {
  const positions = await getLayerPositions(accountId);
  const found = new Map<string, Layer | null>();
  for (const p of positions) {
    if (p.quantity <= 0) continue;
    const seen = found.get(p.symbol);
    found.set(p.symbol, seen === undefined ? p.layer : seen === p.layer ? p.layer : null);
  }
  return found;
}

/**
 * 종목별 **가장 최근에 적힌** 손절가와 그 자리의 층.
 *
 * 회차는 새것부터 오므로 처음 만난 값이 최신이다. 나중 회차가 같은 종목을 다시
 * 사면서 손절을 옮겼으면 그 값이 맞다 — 옛 회차의 값으로 팔면 판단자가 이미
 * 바꾼 약속을 지키는 것이 된다.
 *
 * ★ **층을 함께 들고 온다**(2026-08-22). 손절 매도가 층 없이 나가면 그 체결을
 *   층으로 되돌릴 수 없다 — `StopRule.layer` 주석에 그날 무슨 일이 있었는지 적었다.
 *   결정에 층이 없으면 층 장부에서 찾고, 그것도 갈리면 비운 채 둔다.
 */
async function stopPricesOf(accountId: string): Promise<Map<string, StopRule>> {
  const [rounds, ledger] = await Promise.all([
    getDeliberations({ accountId, limit: 30 }),
    layersOfLedger(accountId),
  ]);
  const stops = new Map<string, StopRule>();
  for (const round of rounds) {
    for (const d of round.decisions) {
      if (d.action !== 'buy' || !d.plan) continue;
      if (stops.has(d.symbol)) continue;
      if (!Number.isFinite(d.plan.stopPrice) || d.plan.stopPrice <= 0) continue;
      stops.set(d.symbol, {
        stop: d.plan.stopPrice,
        round: round.id,
        layer: d.layer ?? ledger.get(d.symbol) ?? undefined,
      });
    }
  }
  return stops;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const accountId = args.find((a) => !a.startsWith('--')) ?? 'VTS-ORDINARY';

  const account = getKisAccount(accountId);
  if (!account) {
    console.error(`등록되지 않은 계좌: ${accountId}`);
    process.exit(1);
  }

  const [snapshot, executionSnapshot, stops] = await Promise.all([
    getKisDomesticAccountSnapshot(account),
    getKisDomesticExecutions(account, 1).catch(() => null),
    stopPricesOf(account.id),
  ]);

  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' })
    .format(new Date())
    .replace(/-/g, '');

  const result = checkStops(snapshot.positions, stops, executionSnapshot?.executions ?? []);
  const breached = result.breaches;

  /*
   * ★ **아무 일도 없으면 조용하다.** 데몬이 장중 매 분 부르므로 한 줄씩만 찍어도
   *   하루 390줄이 쌓이고, 그러면 정작 손절이 나간 줄이 묻힌다 — `checkAlerts`가
   *   "늘 뜨는 경고는 안 읽힌다"고 적어 둔 것과 같은 이유다.
   *
   *   사람이 부를 때(`--execute` 없음)는 항상 찍는다. 안 그러면 돌았는지 모른다.
   */
  const worthSaying = breached.length > 0 || result.unknownPrice.length > 0 || !execute;
  if (worthSaying) {
    console.log(
      `손절 검사 · 보유 ${snapshot.positions.length} · 감시 중 ${result.watched}`
      + ` · 깬 것 ${breached.length}${execute ? '' : '   [판정만 — 실제로 팔려면 --execute]'}`,
    );
  }
  for (const symbol of result.unknownPrice) {
    console.log(`  ? ${symbol} — 현재가를 못 읽어 판정하지 않는다`);
  }
  /*
   * ★ 사람이 부를 때는 **감시 중인 자리를 펼쳐 찍는다.** 층이 비어 있는 것을
   *   미리 보라고 두는 자리다 — 2026-08-21에는 층이 빈 채로 손절이 나가고 나서야
   *   장부가 어긋나 있다는 것을 알았다. 데몬(`--execute`)은 여전히 조용하다.
   */
  if (!execute) {
    for (const position of snapshot.positions) {
      const rule = stops.get(position.symbol);
      if (!rule) continue;
      console.log(
        `  · ${position.symbol} ${position.name} 손절 ${won(rule.stop)}원 (회차 ${rule.round})`
        + `${rule.layer ? ` · 층 ${rule.layer}` : ' · ★ 층 없음 — 팔면 층 장부가 끊긴다'}`,
      );
    }
  }
  for (const b of breached) {
    console.log(
      `  ★ ${b.symbol} ${b.name} ${b.quantity}주 · 현재가 ${won(b.price)}원`
      + ` ≤ 손절 ${won(b.stop)}원 (회차 ${b.round})`,
    );
    /*
     * ★ **층을 모르면 크게 적는다.** 팔기는 판다 — 손절을 미루는 것이 더 나쁘다.
     *   대신 그 체결은 층으로 되돌아가지 않으므로, 조용히 넘어가면 어제처럼
     *   층 손익이 거짓이 된 채 아무도 모른다.
     */
    if (!b.layer) {
      console.log(
        `    ! 층을 모른다 — 매도는 나가지만 층 장부에 안 들어간다.`
        + ` 판 뒤 layerSync --layer 로 사람이 넣어야 한다`,
      );
    }
  }
  if (breached.length === 0 || !execute) {
    // 경보처럼 종료 코드로 알린다 — 부르는 쪽이 그것으로 알림을 띄운다.
    process.exit(breached.length > 0 ? 1 : 0);
  }

  for (const b of breached) {
    const instrument = await getKoreanInstrumentBySymbol(b.symbol);
    if (!instrument) {
      console.log(`  ✗ ${b.symbol} — 종목 마스터에 없다. 팔지 못했다`);
      continue;
    }
    const res = await fetch(`${API_BASE}/api/broker/kis/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: account.id,
        instrumentId: instrument.id,
        side: 'sell',
        orderType: 'market',
        quantity: b.quantity,
        /*
         * ★ **층을 함께 보낸다**(2026-08-22). 이 값이 `trading_broker_orders.layer`에
         *   남아야 `layerSync`가 체결을 제 층으로 되돌린다. 없으면 기본값(ETF)으로
         *   떨어져 **조용히 틀린다** — 2026-08-21 티에스이 손절이 그랬다.
         */
        layer: b.layer,
        clientOrderId: `stop-${b.symbol}-${today}`,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const order = (body.order ?? body) as Record<string, unknown>;
    if (res.ok && typeof order.orderNo === 'string' && order.orderNo) {
      console.log(
        `  ✓ 손절 매도 ${b.symbol} ${b.name} ${b.quantity}주 시장가`
        + `${b.layer ? ` · 층 ${b.layer}` : ' · 층 없음'} → 주문번호 ${order.orderNo}`,
      );
      /*
       * ★ **슬랙으로 알린다.** 손절은 사람이 가장 급하게 알아야 하는 일인데,
       *   macOS 알림은 맥 앞에 있어야 보인다 — 개장 시간에 다른 일을 하려고
       *   만든 시스템에서 그 알림은 대부분 아무도 못 본다.
       *
       * ★ 값을 잘 받는 것이 목적이 아니라 빠져나오는 것이 목적인 주문이라
       *   시장가로 나갔다는 사실도 함께 적는다.
       */
      await sendSlackBot(
        `:rotating_light: *손절 집행* — ${escapeMrkdwn(b.name)} (${b.symbol})\n`
        + `${b.quantity}주 *시장가 전량 매도* · 주문번호 \`${order.orderNo}\`\n`
        + `현재가 ${slackWon(b.price)} ≤ 손절 ${slackWon(b.stop)} (회차 ${b.round})`
        + `${b.layer ? ` · ${b.layer} 층` : ' · ★ 층 없음 — 장부에 안 들어간다'}`,
        'trade',
      );
    } else {
      const why = Array.isArray(body.blockers)
        ? (body.blockers as string[]).join(' · ')
        : String(body.message ?? `HTTP ${res.status}`);
      console.log(`  ✗ 손절 매도 ${b.symbol} 실패 — ${why}`);
      /*
       * ★★ **못 판 것이 판 것보다 급하다.** 손절선을 깼는데 주문이 안 나갔다는
       *   것은 그 자리가 무방비로 남아 있다는 뜻이다 — 사람이 손으로 팔아야 한다.
       */
      await sendSlack(
        `:x: *손절이 나가지 못했다* — ${escapeMrkdwn(b.name)} (${b.symbol}) ${b.quantity}주\n`
        + `현재가 ${slackWon(b.price)} ≤ 손절 ${slackWon(b.stop)} (회차 ${b.round})\n`
        + `사유: ${escapeMrkdwn(why)}\n`
        + `*이 자리는 지금 무방비다 — 손으로 처리해야 한다.*`,
      );
    }
  }
  // 손절이 나갔다는 것은 사람도 알아야 한다.
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
