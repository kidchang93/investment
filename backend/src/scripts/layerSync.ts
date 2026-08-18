/**
 * 증권사 체결 내역을 **층 장부에 반영한다.**
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
 *   npx tsx src/scripts/layerSync.ts [계좌id] [--layer etf] [--days 3] [--apply]
 *
 * ★ **기본이 미리보기다.** `--apply`가 있어야 장부를 쓴다.
 * ★ 같은 체결을 두 번 넣지 않는다 — 이미 기록된 주문번호는 건너뛴다.
 */

import { getKisAccount } from '../config.js';
import { closeDb, pool } from '../db/client.js';
import { ensureLayerSchema, recordLayerTrade } from '../db/layers.js';
import { getKisDomesticExecutions } from '../kis/rest.js';
import { LAYER_LABELS, type Layer } from '../trading/layers.js';

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
  const layer: Layer = args.includes('--layer') && ['etf', 'short', 'bet'].includes(layerArg)
    ? (layerArg as Layer)
    : 'etf';
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
    + ` · 주문에 층이 적힌 것 ${layerOf.size}건 (없으면 ${LAYER_LABELS[layer]}로 넣는다)`,
  );

  let added = 0;
  for (const e of filled) {
    if (done.has(e.orderNo)) continue;
    const price = e.averageFilledPrice > 0 ? e.averageFilledPrice : e.orderPrice;
    // 주문에 적힌 층이 있으면 그것이 맞다. 없으면 `--layer`(기본 etf)로 떨어진다.
    const target = layerOf.get(e.orderNo) ?? layer;
    console.log(
      `  ${e.orderDate} ${e.side === 'buy' ? '매수' : '매도'} ${e.symbol} ${e.name}`
      + ` ${e.filledQuantity}주 @ ${won(price)}원 → ${LAYER_LABELS[target]}`
      + `${layerOf.has(e.orderNo) ? '' : ' (주문에 층이 없어 기본값)'}`
      + ` (주문번호 ${e.orderNo})`,
    );
    if (!apply) continue;
    const result = await recordLayerTrade(
      accountId,
      { layer: target, symbol: e.symbol, side: e.side, quantity: e.filledQuantity, price, fee: 0 },
      `orderNo:${e.orderNo} ${e.orderDate}`,
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
    console.log(`\n장부에 ${added}건 넣었다. 확인: npx tsx src/scripts/layerReport.ts`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
