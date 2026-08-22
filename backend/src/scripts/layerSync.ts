/**
 * 증권사 체결 내역을 **우리 기록에 되채운다.** 체결 조회 한 번으로 둘을 채운다:
 *
 *   ① 주문 기록(`trading_broker_orders`)의 **체결수량·체결단가**
 *   ② 층 장부(`trading_layer_trades`)의 매매와 **실현손익**
 *
 * ── 왜 따로 있나 (2026-08-18) ────────────────────────────────────────────
 *
 * `rebalance.ts`가 주문을 내지만 장부에는 쓰지 않는다. **접수와 체결이 다르기
 * 때문이다** — 접수 시점에 쓰면 미체결·부분체결·거절을 장부가 사실로 적는다.
 * 그날 실제로 그랬다: 4건을 접수한 직후 층 표는 그대로였고, 잔고 대조가
 * 어긋남을 잡았다(장부 96주 vs 증권사 137주).
 *
 * 그래서 **증권사가 "체결됐다"고 말한 것만** 장부에 넣는다. 이 스크립트가
 * 그 자리다.
 *
 * ── ★ 주문 기록 되채움 (2026-08-22) ──────────────────────────────────────
 *
 * 그 전까지 주문 기록은 "냈다"에서 멈춰 있었다. 실제 체결단가는 증권사에만
 * 있어서 슬리피지를 재려면 사람이 손으로 체결 조회를 열어야 했다. 접수값은
 * 그대로 두고 체결 칸만 채운다 — **둘이 벌어진 만큼이 슬리피지다.**
 *
 *   npx tsx src/scripts/layerSync.ts [계좌id] [--layer etf] [--days 3] [--apply]
 *
 * ★ **기본이 미리보기다.** `--apply`가 있어야 쓴다.
 * ★ 같은 체결을 두 번 넣지 않는다 — 이미 기록된 주문번호는 건너뛴다.
 *   (주문 기록 되채움은 예외다 — 부분체결이 늘어날 수 있어 매번 덮는다.)
 *
 * ★★ **`--layer`를 안 주면 층 없는 체결은 넣지 않는다**(2026-08-22 바뀜).
 *    예전에는 기본값 ETF로 조용히 들어갔고, 데몬은 인자 없이 부른다 —
 *    자동 경로가 모르는 것을 ETF라고 단정하는 구조였다. 왜 바꿨는지는
 *    `resolveFillLayer`에 적었다.
 */

import { getKisAccount } from '../config.js';
import { applyOrderFill } from '../db/brokerOrders.js';
import { closeDb, pool } from '../db/client.js';
import { ensureLayerSchema, recordLayerTrade } from '../db/layers.js';
import { getKisDomesticExecutions } from '../kis/rest.js';
import { LAYER_LABELS, resolveFillLayer, type Layer } from '../trading/layers.js';

const won = (n: number): string => Math.round(n).toLocaleString('ko-KR');

/**
 * 주문번호 → 층. **주문 시점에 적어 둔 것을 읽는다.**
 *
 * 증권사 잔고는 층을 모르므로, 체결을 어느 층에 넣을지는 우리가 주문할 때
 * 남긴 값이 유일한 근거다. 없는 주문(손으로 낸 것·옛 주문)은 여기 안 나오고,
 * 그때는 `--layer`로 사람이 정해 준다.
 */
async function layerByOrderNo(accountId: string): Promise<Map<string, Layer>> {
  const { rows } = await pool.query<{ order_no: string; layer: string }>(
    `SELECT order_no, layer FROM trading_broker_orders
      WHERE account_id = $1 AND coalesce(order_no,'') <> '' AND layer IS NOT NULL`,
    [accountId],
  );
  return new Map(rows.map((r) => [r.order_no, r.layer as Layer]));
}

async function alreadyRecorded(accountId: string): Promise<Set<string>> {
  await ensureLayerSchema();
  const { rows } = await pool.query<{ note: string }>(
    `SELECT note FROM trading_layer_trades WHERE account_id = $1 AND note LIKE 'orderNo:%'`,
    [accountId],
  );
  return new Set(rows.map((r) => r.note.replace(/^orderNo:/, '').split(' ')[0]));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const accountId = args.find((a) => !a.startsWith('--')) ?? 'VTS-ORDINARY';
  const apply = args.includes('--apply');
  const layerArg = args[args.indexOf('--layer') + 1];
  /*
   * ★ **기본값이 없다**(2026-08-22). 예전에는 `'etf'`였고, 인자를 안 주는
   *   자동 경로(데몬)가 층 모르는 체결을 전부 ETF로 만들고 있었다.
   */
  const requestedLayer: Layer | undefined =
    args.includes('--layer') && ['etf', 'short', 'bet'].includes(layerArg)
      ? (layerArg as Layer)
      : undefined;
  const daysArg = Number(args[args.indexOf('--days') + 1]);
  const days = args.includes('--days') && Number.isFinite(daysArg) ? daysArg : 3;

  const account = getKisAccount(accountId);
  if (!account) throw new Error(`등록되지 않은 계좌: ${accountId}`);

  const snapshot = await getKisDomesticExecutions(account, days);
  if (!snapshot.configured) {
    console.log(`체결 내역을 못 받았다: ${snapshot.message ?? '사유 없음'}`);
    return;
  }
  const done = await alreadyRecorded(accountId);
  const layerOf = await layerByOrderNo(accountId);

  // 체결 수량이 0인 것은 주문만 있고 체결이 없는 것이다 — 장부에 넣지 않는다.
  const filled = snapshot.executions.filter((e) => e.filledQuantity > 0);
  console.log(
    `체결 내역 ${snapshot.executions.length}건 중 체결 있는 것 ${filled.length}건`
    + ` · 이미 장부에 든 것 ${done.size}건`
    + ` · 주문에 층이 적힌 것 ${layerOf.size}건`
    + `${requestedLayer ? ` (없으면 ${LAYER_LABELS[requestedLayer]}로 넣는다)` : ' (없으면 넣지 않는다 — --layer로 정해 준다)'}`,
  );

  let added = 0;
  let refilled = 0;
  const skipped: string[] = [];
  for (const e of filled) {
    const price = e.averageFilledPrice > 0 ? e.averageFilledPrice : e.orderPrice;

    /*
     * ★ **주문 기록 되채움은 층과 무관하고 중복 판정도 안 탄다.** 층을 몰라도
     *   "얼마에 붙었나"는 사실이고, 부분체결은 다음 회차에 늘어난 값으로 덮여야 한다.
     */
    if (apply) {
      const touched = await applyOrderFill(accountId, e.orderNo, e.filledQuantity, price);
      if (touched > 0) refilled += touched;
    }

    if (done.has(e.orderNo)) continue;
    const decision = resolveFillLayer(layerOf.get(e.orderNo), requestedLayer);
    const head = `  ${e.orderDate} ${e.side === 'buy' ? '매수' : '매도'} ${e.symbol} ${e.name}`
      + ` ${e.filledQuantity}주 @ ${won(price)}원`;
    if (decision.kind === 'skip') {
      // ★ 조용히 넘기지 않는다. 빠진 것은 잔고 대조가 잡지만, 잘못 들어간 것은 아무도 못 잡는다.
      console.log(`${head} → ★ 건너뛴다 (주문번호 ${e.orderNo})`);
      console.log(`    ${decision.why}`);
      skipped.push(`${e.symbol} ${e.name} (주문번호 ${e.orderNo})`);
      continue;
    }
    console.log(
      `${head} → ${LAYER_LABELS[decision.layer]}`
      + `${decision.fromOrder ? '' : ' (주문에 층이 없어 --layer 값으로)'}`
      + ` (주문번호 ${e.orderNo})`,
    );
    if (!apply) continue;
    const result = await recordLayerTrade(
      accountId,
      {
        layer: decision.layer,
        symbol: e.symbol,
        side: e.side,
        quantity: e.filledQuantity,
        price,
        fee: 0,
      },
      `orderNo:${e.orderNo} ${e.orderDate}`,
      // ★ **체결한 날로 적는다.** 기록한 날로 적으면 하루 늦게 메울 때 어긋난다.
      e.orderDate,
    );
    if (result.shortfall > 0) {
      console.log(`    ★ 장부에 ${result.shortfall}주가 모자라 그만큼 못 팔았다 — 앞선 매수가 빠졌을 수 있다`);
    }
    if (result.realizedPnl !== null) {
      console.log(`    실현손익 ${result.realizedPnl >= 0 ? '+' : ''}${won(result.realizedPnl)}원`);
    }
    added += 1;
  }

  if (!apply) {
    console.log(`\n미리보기다. 실제로 넣으려면 --apply를 붙인다.`);
  } else {
    console.log(`\n장부에 ${added}건 넣었다 · 주문 기록에 체결 ${refilled}건 되채웠다.`);
    console.log(`확인: npx tsx src/scripts/layerReport.ts`);
  }
  if (skipped.length > 0) {
    /*
     * ★ **종료 코드로 알린다.** 데몬이 이 값을 보고 로그에 크게 남긴다 —
     *   그냥 지나가면 "층 장부가 조용히 뒤처진 상태"가 며칠씩 이어진다.
     */
    console.log(`\n★ 층을 몰라 안 넣은 체결 ${skipped.length}건:`);
    for (const line of skipped) console.log(`  - ${line}`);
    console.log('  넣으려면 그 층을 정해 다시 부른다 — 예: --layer bet --apply');
    process.exitCode = 3;
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
