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
import { getKisDomesticAccountSnapshot, getKisDomesticExecutions } from '../kis/rest.js';
import { checkStops, type StopRule } from '../trading/stopLoss.js';

const API_BASE = process.env.INVEST_API_BASE ?? 'http://localhost:4000';
const won = (n: number): string => Math.round(n).toLocaleString('ko-KR');

/**
 * 종목별 **가장 최근에 적힌** 손절가.
 *
 * 회차는 새것부터 오므로 처음 만난 값이 최신이다. 나중 회차가 같은 종목을 다시
 * 사면서 손절을 옮겼으면 그 값이 맞다 — 옛 회차의 값으로 팔면 판단자가 이미
 * 바꾼 약속을 지키는 것이 된다.
 */
async function stopPricesOf(accountId: string): Promise<Map<string, StopRule>> {
  const rounds = await getDeliberations({ accountId, limit: 30 });
  const stops = new Map<string, StopRule>();
  for (const round of rounds) {
    for (const d of round.decisions) {
      if (d.action !== 'buy' || !d.plan) continue;
      if (stops.has(d.symbol)) continue;
      if (!Number.isFinite(d.plan.stopPrice) || d.plan.stopPrice <= 0) continue;
      stops.set(d.symbol, { stop: d.plan.stopPrice, round: round.id });
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
  for (const symbol of result.unknownPrice) {
    console.log(`  ? ${symbol} — 현재가를 못 읽어 판정하지 않는다`);
  }

  console.log(
    `손절 검사 · 보유 ${snapshot.positions.length} · 감시 중 ${result.watched}`
    + ` · 깬 것 ${breached.length}${execute ? '' : '   [판정만 — 실제로 팔려면 --execute]'}`,
  );
  for (const b of breached) {
    console.log(
      `  ★ ${b.symbol} ${b.name} ${b.quantity}주 · 현재가 ${won(b.price)}원`
      + ` ≤ 손절 ${won(b.stop)}원 (회차 ${b.round})`,
    );
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
        clientOrderId: `stop-${b.symbol}-${today}`,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const order = (body.order ?? body) as Record<string, unknown>;
    if (res.ok && typeof order.orderNo === 'string' && order.orderNo) {
      console.log(`  ✓ 손절 매도 ${b.symbol} ${b.name} ${b.quantity}주 시장가 → 주문번호 ${order.orderNo}`);
    } else {
      const why = Array.isArray(body.blockers)
        ? (body.blockers as string[]).join(' · ')
        : String(body.message ?? `HTTP ${res.status}`);
      console.log(`  ✗ 손절 매도 ${b.symbol} 실패 — ${why}`);
    }
  }
  // 손절이 나갔다는 것은 사람도 알아야 한다.
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
