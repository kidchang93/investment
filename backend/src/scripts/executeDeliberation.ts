/**
 * 판단을 주문으로 옮긴다 — **판단자와 증권사 사이에 빠져 있던 고리.**
 *
 * ── 왜 생겼나 (2026-08-20) ───────────────────────────────────────────────
 *
 * 판단자를 자동 소집하는 장치는 8/19에 붙었다. 그런데 그 판단을 주문으로 바꾸는
 * 것은 아무도 하지 않았다 — `decisions`를 읽는 코드는 `checkTrigger.ts` 하나였고
 * 그건 *다음 회차를 열까* 판정용이다. 8/20 회차 21이 매수 두 건을 적었을 때
 * **사람이 손으로 옮겨 적어 주문했다.**
 *
 * ★ 그날 두 가지가 함께 드러났다. 둘 다 이 스크립트가 있으려면 먼저 필요했다:
 *   ① `decisions`에 **지정가 칸이 없었다** — 회차 21은 `rationale`에 글로만
 *      적었다("지정가 252,000원"). 사람은 읽지만 집행기는 못 읽는다.
 *   ② `decisions`에 **층 칸이 없었다** — 그래서 그날 주문의 `layer`가 비었고,
 *      체결됐다면 층 장부에 안 들어갔다. 증권사 잔고는 층을 모른다.
 *
 * ── 무엇을 하나 ──────────────────────────────────────────────────────────
 *
 *   npx tsx src/scripts/executeDeliberation.ts [계좌id] [--execute] [--round <id>]
 *
 * `--execute`가 없으면 **낼 주문을 출력만 한다.** 데몬은 `--execute`로 부른다.
 *
 * ★ **hold는 아무것도 하지 않는다.** buy·sell은 신규 주문, amend·cancel은 이미 낸
 *   주문을 정정·취소한다.
 *
 * ★ **이미 집행한 결정은 건너뛴다.** 회차의 `executions`에 남은 것을 보고 거른다 —
 *   데몬이 20분마다 불러도 같은 주문이 두 번 나가지 않는다. `clientOrderId`도
 *   회차 id로 찍어 서버 쪽에서 한 겹 더 막는다.
 *
 * ★ **오늘 회차가 아니면 거부한다.** 어제 판단으로 오늘 주문을 내면 그 사이
 *   가격이 움직인 것을 아무도 안 본 것이 된다. `--force`로만 넘긴다.
 *
 * 게이트와 리스크 룰은 **서버가** 본다(`POST /api/broker/kis/orders`). 이 스크립트가
 * 다시 판정하지 않는다 — 같은 규칙을 두 곳에 두면 한쪽만 고쳤을 때 갈라진다.
 */

import { getKisAccount } from '../config.js';
import { getKoreanInstrumentBySymbol } from '../db/instruments.js';
import { getLayerPositions } from '../db/layers.js';
import { resolveSellLayer, type Layer, type SellLayerDecision } from '../trading/layers.js';
import {
  attachExecutions,
  getDeliberations,
  type DeliberationDecision,
  type DeliberationExecution,
} from '../db/deliberations.js';
import { escapeMrkdwn, sendSlack, won as slackWon } from '../notify/slack.js';

const API_BASE = process.env.INVEST_API_BASE ?? 'http://localhost:4000';

/** KST 오늘 날짜 `YYYY-MM-DD`. 회차의 `tradingDay`와 같은 축으로 비교한다. */
function todayKst(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
}

interface PostResult {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

async function post(path: string, payload: unknown): Promise<PostResult> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // 본문이 JSON이 아니면 빈 객체로 둔다. status로 판정한다.
  }
  return { ok: res.ok, status: res.status, body };
}

/**
 * 이 결정이 이미 집행됐나.
 *
 * ★ **`side`가 아니라 `action`으로 센다.** 처음에는 `side`로 셌는데 `cancel`도
 *   `buy`로 떨어져서, 한 회차에서 같은 종목을 **취소하고 다시 사면 뒤엣것이
 *   조용히 건너뛰어졌다.** 옛 기록에는 `action`이 없으므로 `side`로 되돌아간다.
 */
function alreadyDone(done: DeliberationExecution[], decision: DeliberationDecision): boolean {
  return done.some((e) => e.symbol === decision.symbol && (e.action ?? e.side) === decision.action);
}

/**
 * 이 결정을 **주문으로 옮길 수 있나.** `recordDeliberation`이 기록 시점에 같은 것을
 * 보지만 여기서 한 겹 더 본다 — 그 검증이 생기기 전에 남은 회차(8/20 회차 21이
 * 그렇다)와, 사람이 SQL로 직접 넣은 기록이 있을 수 있다.
 *
 * ★ **막을 때는 조용히 넘기지 않고 크게 적는다.** "판단은 했는데 아무 일도 안
 *   일어났다"가 조용히 생기는 것이 이 고리 전체에서 가장 나쁜 실패다.
 */
function executionProblem(d: DeliberationDecision, sellLayer: SellLayerDecision | null): string | null {
  if (d.action === 'buy' || d.action === 'sell') {
    if (typeof d.limitPrice !== 'number' || d.limitPrice <= 0) {
      return '지정가(limitPrice)가 없다 — 시장가로 나가므로 집행하지 않는다';
    }
  }
  if (d.action === 'buy' && !d.layer) {
    return '층(layer)이 없다 — 체결을 층으로 되돌릴 수 없어 집행하지 않는다';
  }
  /*
   * ★ 매도는 판단자에게 층을 묻지 않고 **장부에서 읽는다** — 이미 가진 것을
   *   파는 것이라 답이 장부에 있다. 장부가 답을 못 내는 경우(두 층에 걸침 ·
   *   판단자와 어긋남)에만 막는다. 자세한 근거는 `resolveSellLayer`.
   */
  if (d.action === 'sell' && sellLayer?.kind === 'block') return sellLayer.why;
  if ((d.action === 'amend' || d.action === 'cancel') && !d.orderNo) {
    return '대상 주문번호(orderNo)가 없다';
  }
  return null;
}

function describe(d: DeliberationDecision): string {
  const price = d.limitPrice ? `지정가 ${d.limitPrice.toLocaleString('ko-KR')}원` : '시장가';
  switch (d.action) {
    case 'buy':
      return `매수 ${d.symbol} ${d.name} ${d.quantity}주 ${price} · 층 ${d.layer}`;
    case 'sell':
      return `매도 ${d.symbol} ${d.name} ${d.quantity}주 ${price}`
        + (d.layer ? ` · 층 ${d.layer}(판단자)` : '');
    case 'amend':
      return `정정 ${d.symbol} ${d.name} 주문 ${d.orderNo} → ${price}`;
    case 'cancel':
      return `취소 ${d.symbol} ${d.name} 주문 ${d.orderNo}`;
    default:
      return `보유 ${d.symbol} ${d.name}`;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const force = args.includes('--force');
  const roundArgIndex = args.indexOf('--round');
  const roundId = roundArgIndex >= 0 ? Number(args[roundArgIndex + 1]) : undefined;
  const accountId = args.find((a) => !a.startsWith('--') && a !== String(roundId)) ?? 'VTS-ORDINARY';

  const account = getKisAccount(accountId);
  if (!account) {
    console.error(`등록되지 않은 계좌: ${accountId}`);
    process.exit(1);
  }

  const rounds = await getDeliberations({ accountId: account.id, limit: 20 });
  const round = roundId ? rounds.find((r) => r.id === roundId) : rounds[0];
  if (!round) {
    console.log('집행할 회차가 없다.');
    return;
  }

  const today = todayKst();
  if (round.tradingDay !== today && !force) {
    console.log(
      `회차 ${round.id}는 ${round.tradingDay} 판단이고 오늘은 ${today}다 — 집행하지 않는다.`
      + '\n어제 판단으로 오늘 주문을 내면 그 사이 움직인 값을 아무도 안 본 것이 된다.'
      + ' 정말 낼 것이면 --force.',
    );
    return;
  }

  // `hold`를 걸러내면서 타입도 함께 좁힌다 — 아래에서 `action`을 집행 기록에 그대로 넣는다.
  const actionable = round.decisions.filter(
    (d): d is DeliberationDecision & { action: 'buy' | 'sell' | 'amend' | 'cancel' } => d.action !== 'hold',
  );
  const pending = actionable.filter((d) => !alreadyDone(round.executions, d));
  const skipped = actionable.length - pending.length;

  console.log(
    `회차 ${round.id} (${round.tradingDay} · ${round.trigger})`
    + ` · 결정 ${round.decisions.length} · 집행 대상 ${actionable.length}`
    + ` · 이미 집행 ${skipped} · 이번에 낼 것 ${pending.length}`
    + `${execute ? '' : '   [계획만 — 실제로 내려면 --execute]'}`,
  );
  for (const d of pending) console.log(`  ${describe(d)}`);
  if (pending.length === 0) return;
  if (!execute) return;

  console.log();
  const executions: DeliberationExecution[] = [...round.executions];

  /*
   * 매도의 층을 장부에서 읽는다. **한 번만 읽는다** — 이 회차를 집행하는 동안
   * 층 장부는 바뀌지 않는다(체결이 들어와야 바뀌고 그건 마감 뒤 `layerSync`다).
   */
  const holdingLayers = new Map<string, Layer[]>();
  for (const position of await getLayerPositions(account.id)) {
    const layers = holdingLayers.get(position.symbol) ?? [];
    layers.push(position.layer);
    holdingLayers.set(position.symbol, layers);
  }

  for (const d of pending) {
    const side = d.action === 'sell' ? 'sell' : 'buy';
    const sellLayer = d.action === 'sell'
      ? resolveSellLayer(d.layer as Layer | undefined, holdingLayers.get(d.symbol) ?? [])
      : null;
    if (sellLayer && sellLayer.kind !== 'use') {
      // 층을 못 정한 이유는 **주문을 내든 안 내든** 적어 둔다. 조용히 넘기지 않는다.
      console.log(`  · ${d.symbol} 매도 층: ${sellLayer.why}`);
    }
    const problem = executionProblem(d, sellLayer);
    if (problem) {
      console.log(`  ✗ ${describe(d)} → ${problem}`);
      executions.push({
        symbol: d.symbol,
        side,
        action: d.action,
        quantity: d.quantity,
        orderNo: '',
        estimatedPrice: d.limitPrice ?? 0,
        blockedBy: [problem],
      });
      continue;
    }
    let result: PostResult;

    if (d.action === 'amend' || d.action === 'cancel') {
      result = await post('/api/broker/kis/orders/amend', {
        accountId: account.id,
        action: d.action,
        orderNo: d.orderNo,
        orderBranchNo: d.orderBranchNo,
        /*
         * 원주문의 주문구분코드. 지정가 보통가는 `00`이다.
         * ★ 모의 서버에는 정정취소가능주문조회가 없어 원주문에서 되읽을 수 없다 —
         *   판단자가 `orderTypeCode`를 안 적으면 우리가 낸 주문이 지정가였다는
         *   사실에서 `00`을 쓴다. 실전 계좌라면 조회로 확인해야 하는 자리다.
         */
        orderTypeCode: '00',
        quantity: d.quantity > 0 ? d.quantity : undefined,
        quantityAll: d.action === 'cancel' || d.quantity <= 0,
        limitPrice: d.limitPrice,
      });
    } else {
      const instrument = await getKoreanInstrumentBySymbol(d.symbol);
      if (!instrument) {
        console.log(`  ✗ ${d.symbol} — 종목 마스터에 없다. 주문하지 않는다`);
        executions.push({
          symbol: d.symbol,
          side,
          action: d.action,
          quantity: d.quantity,
          orderNo: '',
          estimatedPrice: d.limitPrice ?? 0,
          blockedBy: ['종목 마스터 없음'],
        });
        continue;
      }
      result = await post('/api/broker/kis/orders', {
        accountId: account.id,
        instrumentId: instrument.id,
        side,
        orderType: d.limitPrice ? 'limit' : 'market',
        quantity: d.quantity,
        limitPrice: d.limitPrice,
        // 매수는 판단자가 적은 층, 매도는 장부에서 읽은 층이다.
        layer: sellLayer?.kind === 'use' ? sellLayer.layer : d.layer,
        // 회차 id를 넣어 같은 판단이 두 번 나가지 않게 한다.
        clientOrderId: `delib${round.id}-${round.tradingDay.replace(/-/g, '')}-${d.symbol}-${side}${d.quantity}`,
      });
    }

    const order = (result.body.order ?? result.body) as Record<string, unknown>;
    const orderNo = typeof order.orderNo === 'string' ? order.orderNo : '';
    if (result.ok && orderNo) {
      console.log(`  ✓ ${describe(d)} → 주문번호 ${orderNo}`);
      executions.push({
        symbol: d.symbol,
        side,
        action: d.action,
        quantity: d.quantity,
        orderNo,
        estimatedPrice: d.limitPrice ?? 0,
      });
    } else {
      // 막힌 것도 남긴다 — 왜 못 냈는지가 판단의 일부다.
      const blockers = Array.isArray(result.body.blockers)
        ? (result.body.blockers as string[])
        : [String(result.body.message ?? `HTTP ${result.status}`)];
      console.log(`  ✗ ${describe(d)} → ${blockers.join(' · ')}`);
      executions.push({
        symbol: d.symbol,
        side,
        action: d.action,
        quantity: d.quantity,
        orderNo: '',
        estimatedPrice: d.limitPrice ?? 0,
        blockedBy: blockers,
      });
    }
  }

  await attachExecutions(round.id, executions);
  console.log(`\n회차 ${round.id}에 집행 결과 ${executions.length}건을 붙였다.`);

  /*
   * ★ **낸 주문을 슬랙으로 알린다** (2026-08-24). 자동 매매의 값어치는 사람이
   *   자리를 비워도 도는 것인데, 무엇을 샀는지 저녁까지 모르면 그건 무인이 아니라
   *   **깜깜이**다. 낸 것과 막힌 것을 한 줄씩 적는다.
   *
   * ★ 낸 것이 없으면 보내지 않는다 — hold만 있는 날이 대부분이고, 매일 "오늘은
   *   아무것도 안 했다"가 오면 정작 주문이 나간 날의 알림이 묻힌다.
   */
  if (executions.length > 0) {
    const placed = executions.filter((e) => e.orderNo);
    const blocked = executions.filter((e) => !e.orderNo);
    const lines = [
      `:white_check_mark: *주문 ${placed.length}건* · 회차 ${round.id} · ${account.id}`,
      ...placed.map((e) => {
        const d = round.decisions.find((x) => x.symbol === e.symbol && x.action === e.action);
        const price = e.estimatedPrice > 0 ? `지정가 ${slackWon(e.estimatedPrice)}` : '시장가';
        return `• ${e.side === 'buy' ? '매수' : '매도'} ${escapeMrkdwn(d?.name ?? e.symbol)}`
          + ` (${e.symbol}) ${e.quantity}주 · ${price}`
          + `${d?.layer ? ` · ${d.layer} 층` : ''} · \`${e.orderNo}\``
          + (d?.plan ? `\n  ↳ 목표 ${slackWon(d.plan.targetPrice)} / 손절 ${slackWon(d.plan.stopPrice)}`
            + ` / ${d.plan.horizonDays}거래일` : '');
      }),
      ...(blocked.length > 0
        ? [`:no_entry: *막힌 것 ${blocked.length}건*`,
          ...blocked.map((e) => `• ${escapeMrkdwn(e.symbol)} ${e.action} — ${escapeMrkdwn((e.blockedBy ?? []).join(' · '))}`)]
        : []),
    ];
    await sendSlack(lines.join('\n'));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
