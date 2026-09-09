/**
 * **유망주 층을 단기 층에 합친다.** 되돌릴 수 있게 백업을 먼저 남긴다.
 *
 * ── 왜 (2026-09-09) ──────────────────────────────────────────────────────
 *
 * 사용자가 정했다 — *"유망주에 대한 언급은 빼고 단기로 다 넣어버리고."*
 * 배경은 `backend/src/trading/layers.ts`의 `Layer` 주석에 적었다.
 *
 * ── 왜 과거 기록까지 옮기나 ──────────────────────────────────────────────
 *
 * 층이 하나가 되었으므로 옛 유망주 손익을 `'bet'`으로 남겨 두면 **어느 합계에도
 * 안 잡힌다.** 층별 집계는 `LAYER_TARGETS`의 키를 돌기 때문이다. 실현손익
 * +817,850원이 조용히 사라지고, 누적 성적이 거짓이 된다.
 *
 * ★ **되돌리기**: `trading_layer_merge_backup`에 (테이블, 행 id)를 남긴다.
 *   되돌리려면 `--revert`를 준다. 백업이 없으면 되돌리지 않는다.
 */

import { pool } from '../db/client.js';

/**
 * 층 칸이 있고 **`id` 하나로 행을 짚을 수 있는** 표들. 여기 없는 표에 층이
 * 생기면 함께 적어야 한다.
 *
 * ★ `trading_layer_positions`는 여기 없다 — 키가 `(계좌, 층, 종목)`이라
 *   같은 종목이 두 층에 있으면 `UPDATE`가 키를 깨뜨린다. 아래에서 따로 **합산**한다.
 */
const TABLES = [
  'trading_layer_trades',
  'trading_broker_orders',
] as const;

/**
 * 자리를 합친다. 같은 종목이 두 층에 있으면 **수량과 원가를 더한다** — 평균원가법
 * 이므로 원가를 더하고 수량을 더하면 평균단가는 저절로 맞는다.
 *
 * 지금 계좌에는 겹치는 종목이 없지만, 겹친 채로 도는 날 조용히 한쪽을 덮어쓰면
 * 그 자리는 장부에서 사라진다. 그래서 겹치지 않는 지금 미리 옳게 적어 둔다.
 */
async function mergePositions(apply: boolean): Promise<number> {
  const { rows } = await pool.query<{ account_id: string; symbol: string; overlap: string }>(
    `SELECT b.account_id, b.symbol,
            (EXISTS (SELECT 1 FROM trading_layer_positions s
                      WHERE s.account_id = b.account_id AND s.symbol = b.symbol
                        AND s.layer = 'short'))::text AS overlap
       FROM trading_layer_positions b
      WHERE b.layer = 'bet'`,
  );
  console.log(`  trading_layer_positions · ${rows.length}자리`
    + ` (단기에 이미 있는 종목 ${rows.filter((r) => r.overlap === 'true').length})`);
  if (!apply || rows.length === 0) return rows.length;

  await pool.query(
    `INSERT INTO trading_layer_merge_backup (table_name, row_id, from_layer)
     SELECT 'trading_layer_positions', account_id || '|' || symbol, 'bet'
       FROM trading_layer_positions WHERE layer = 'bet'`,
  );
  // 겹치는 것은 더하고, 안 겹치는 것은 층 이름만 바꾼다.
  await pool.query(
    `INSERT INTO trading_layer_positions (account_id, layer, symbol, quantity, cost)
     SELECT account_id, 'short', symbol, quantity, cost
       FROM trading_layer_positions WHERE layer = 'bet'
     ON CONFLICT (account_id, layer, symbol) DO UPDATE
       SET quantity = trading_layer_positions.quantity + EXCLUDED.quantity,
           cost     = trading_layer_positions.cost     + EXCLUDED.cost,
           updated_at = now()`,
  );
  await pool.query(`DELETE FROM trading_layer_positions WHERE layer = 'bet'`);
  return rows.length;
}

async function ensureBackupTable(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS trading_layer_merge_backup (
       id          bigserial PRIMARY KEY,
       table_name  text        NOT NULL,
       row_id      text        NOT NULL,
       from_layer  text        NOT NULL,
       moved_at    timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

async function migrate(apply: boolean): Promise<void> {
  await ensureBackupTable();
  let total = await mergePositions(apply);
  for (const table of TABLES) {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM ${table} WHERE layer = 'bet'`,
    );
    total += rows.length;
    console.log(`  ${table} · ${rows.length}행`);
    if (!apply || rows.length === 0) continue;
    await pool.query(
      `INSERT INTO trading_layer_merge_backup (table_name, row_id, from_layer)
       SELECT $1, id::text, 'bet' FROM ${table} WHERE layer = 'bet'`,
      [table],
    );
    await pool.query(`UPDATE ${table} SET layer = 'short' WHERE layer = 'bet'`);
  }

  /*
   * ★ 회차 기록(`trading_deliberations.decisions`)의 층도 옮긴다. 판단자가
   *   과거 회차를 읽을 때 없는 층 이름을 보면 혼란만 남는다. 이쪽은 jsonb라
   *   행 단위 백업 대신 **원본 jsonb를 통째로** 남긴다.
   */
  const { rows: rounds } = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM trading_deliberations WHERE decisions::text LIKE '%"bet"%'`,
  );
  console.log(`  trading_deliberations · ${rounds.length}회차`);
  total += rounds.length;
  if (apply && rounds.length > 0) {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS trading_deliberations_layer_backup (
         round_id bigint PRIMARY KEY, decisions jsonb NOT NULL,
         saved_at timestamptz NOT NULL DEFAULT now())`,
    );
    await pool.query(
      `INSERT INTO trading_deliberations_layer_backup (round_id, decisions)
       SELECT id, decisions FROM trading_deliberations WHERE decisions::text LIKE '%"bet"%'
       ON CONFLICT (round_id) DO NOTHING`,
    );
    await pool.query(
      `UPDATE trading_deliberations
          SET decisions = replace(decisions::text, '"layer":"bet"', '"layer":"short"')::jsonb
        WHERE decisions::text LIKE '%"bet"%'`,
    );
  }

  console.log(apply ? `\n옮겼다 · 합계 ${total}건` : `\n미리보기다 · 합계 ${total}건. 넣으려면 --apply`);
}

async function revert(): Promise<void> {
  const { rows } = await pool.query<{ table_name: string; row_id: string }>(
    `SELECT table_name, row_id FROM trading_layer_merge_backup ORDER BY id`,
  );
  if (rows.length === 0) {
    console.log('되돌릴 백업이 없다.');
    return;
  }
  for (const table of TABLES) {
    const ids = rows.filter((r) => r.table_name === table).map((r) => r.row_id);
    if (ids.length === 0) continue;
    await pool.query(`UPDATE ${table} SET layer = 'bet' WHERE id::text = ANY($1)`, [ids]);
    console.log(`  ${table} · ${ids.length}행 되돌림`);
  }

  /*
   * ★ 자리는 되돌릴 수 없는 경우가 있다 — 합쳐진 뒤 매매가 일어났으면 어느
   *   수량이 어느 층 것이었는지 알 수 없다. 그래서 **합치기 전에 겹치지
   *   않았던 것만** 돌려놓고, 겹쳤던 것은 말하고 남긴다.
   */
  const posKeys = rows.filter((r) => r.table_name === 'trading_layer_positions');
  for (const { row_id } of posKeys) {
    const [accountId, symbol] = row_id.split('|');
    const { rowCount } = await pool.query(
      `UPDATE trading_layer_positions SET layer = 'bet'
        WHERE account_id = $1 AND symbol = $2 AND layer = 'short'`,
      [accountId, symbol],
    );
    if (rowCount === 0) console.log(`  ★ ${symbol} 자리는 되돌리지 못했다 — 사라졌거나 합쳐졌다`);
  }
  if (posKeys.length > 0) console.log(`  trading_layer_positions · ${posKeys.length}자리 시도`);
  await pool.query(
    `UPDATE trading_deliberations d SET decisions = b.decisions
       FROM trading_deliberations_layer_backup b WHERE d.id = b.round_id`,
  ).catch(() => undefined);
  await pool.query('DELETE FROM trading_layer_merge_backup');
  console.log('되돌렸다.');
}

const args = process.argv.slice(2);
try {
  if (args.includes('--revert')) await revert();
  else await migrate(args.includes('--apply'));
} finally {
  await pool.end();
}
