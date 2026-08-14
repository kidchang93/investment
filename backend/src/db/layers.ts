/**
 * 3층 장부 저장소. **증권사가 모르는 것을 우리가 기억한다.**
 *
 * KIS 잔고에는 종목당 수량 하나뿐이라, 같은 종목을 ETF 층과 단기 층에서 사면
 * 어느 쪽 것인지 알 수 없다. 그 구분은 우리만 안다 — 그래서 여기 적고,
 * 합계가 잔고와 맞는지 `reconcile`로 대조한다.
 *
 * 계산은 `trading/layers.ts`가 한다(순수 함수). 이 모듈은 읽고 쓰기만 한다.
 */

import { pool } from './client.js';
import { applyTrade, type Layer, type LayerPosition, type LayerTrade } from '../trading/layers.js';

export async function ensureLayerSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_layer_positions (
      account_id TEXT           NOT NULL,
      layer      TEXT           NOT NULL,
      symbol     TEXT           NOT NULL,
      quantity   NUMERIC(24,8)  NOT NULL DEFAULT 0,
      cost       NUMERIC(20,4)  NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ    NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, layer, symbol)
    )
  `);
  /*
   * 실현손익은 **줄로 남긴다.** 층별 누계만 들고 있으면 "언제 무엇으로 벌었나"를
   * 되짚을 수 없고, 승률·손익비를 낼 수도 없다 — 그 둘이 단기 층 판정의 전부다.
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_layer_trades (
      id          BIGSERIAL PRIMARY KEY,
      account_id  TEXT          NOT NULL,
      layer       TEXT          NOT NULL,
      symbol      TEXT          NOT NULL,
      side        TEXT          NOT NULL,
      quantity    NUMERIC(24,8) NOT NULL,
      price       NUMERIC(20,6) NOT NULL,
      fee         NUMERIC(20,4) NOT NULL DEFAULT 0,
      realized_pnl NUMERIC(20,4),
      note        TEXT          NOT NULL DEFAULT '',
      traded_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS trading_layer_trades_acct_idx
      ON trading_layer_trades (account_id, layer, traded_at)
  `);
}

export async function getLayerPositions(accountId: string): Promise<LayerPosition[]> {
  await ensureLayerSchema();
  const { rows } = await pool.query<{ layer: string; symbol: string; quantity: string; cost: string }>(
    `SELECT layer, symbol, quantity::text, cost::text
       FROM trading_layer_positions
      WHERE account_id = $1 AND quantity > 0
      ORDER BY layer, symbol`,
    [accountId],
  );
  return rows.map((r) => ({
    layer: r.layer as Layer,
    symbol: r.symbol,
    quantity: Number(r.quantity),
    cost: Number(r.cost),
  }));
}

/** 층별 실현손익 누계 */
export async function getRealizedByLayer(accountId: string): Promise<Map<Layer, number>> {
  await ensureLayerSchema();
  const { rows } = await pool.query<{ layer: string; total: string }>(
    `SELECT layer, coalesce(sum(realized_pnl), 0)::text AS total
       FROM trading_layer_trades WHERE account_id = $1 GROUP BY layer`,
    [accountId],
  );
  return new Map(rows.map((r) => [r.layer as Layer, Number(r.total)]));
}

/**
 * 체결 하나를 장부에 반영한다. **읽기·계산·쓰기를 한 트랜잭션에서 한다** —
 * 두 곳에서 같은 종목을 동시에 쓰면 나중 것이 앞 것을 덮어 원가가 어긋난다.
 */
export async function recordLayerTrade(
  accountId: string,
  trade: LayerTrade,
  note = '',
): Promise<{ realizedPnl: number | null; shortfall: number }> {
  await ensureLayerSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ quantity: string; cost: string }>(
      `SELECT quantity::text, cost::text FROM trading_layer_positions
        WHERE account_id = $1 AND layer = $2 AND symbol = $3 FOR UPDATE`,
      [accountId, trade.layer, trade.symbol],
    );
    const current: LayerPosition = {
      layer: trade.layer,
      symbol: trade.symbol,
      quantity: Number(rows[0]?.quantity ?? 0),
      cost: Number(rows[0]?.cost ?? 0),
    };
    const result = applyTrade(current, trade);
    await client.query(
      `INSERT INTO trading_layer_positions (account_id, layer, symbol, quantity, cost, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (account_id, layer, symbol)
       DO UPDATE SET quantity = EXCLUDED.quantity, cost = EXCLUDED.cost, updated_at = now()`,
      [accountId, trade.layer, trade.symbol, result.position.quantity, result.position.cost],
    );
    await client.query(
      `INSERT INTO trading_layer_trades
         (account_id, layer, symbol, side, quantity, price, fee, realized_pnl, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        accountId, trade.layer, trade.symbol, trade.side,
        trade.quantity - result.shortfall, trade.price, trade.fee,
        result.realizedPnl, note,
      ],
    );
    await client.query('COMMIT');
    return { realizedPnl: result.realizedPnl, shortfall: result.shortfall };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** 단기 층 판정에 쓰는 것 — 승률과 손익비는 실현된 매도에서만 나온다 */
export interface LayerTradeStats {
  layer: Layer;
  closedTrades: number;
  wins: number;
  /** 이긴 것들의 평균 이익 */
  avgWin: number;
  /** 진 것들의 평균 손실(양수) */
  avgLoss: number;
  realizedPnl: number;
}

export async function getLayerTradeStats(accountId: string): Promise<LayerTradeStats[]> {
  await ensureLayerSchema();
  const { rows } = await pool.query<{
    layer: string; closed: string; wins: string; avg_win: string | null;
    avg_loss: string | null; total: string;
  }>(
    `SELECT layer,
            count(*)::text                                              AS closed,
            count(*) FILTER (WHERE realized_pnl > 0)::text              AS wins,
            avg(realized_pnl) FILTER (WHERE realized_pnl > 0)::text     AS avg_win,
            avg(-realized_pnl) FILTER (WHERE realized_pnl < 0)::text    AS avg_loss,
            coalesce(sum(realized_pnl), 0)::text                        AS total
       FROM trading_layer_trades
      WHERE account_id = $1 AND side = 'sell' AND realized_pnl IS NOT NULL
      GROUP BY layer ORDER BY layer`,
    [accountId],
  );
  return rows.map((r) => ({
    layer: r.layer as Layer,
    closedTrades: Number(r.closed),
    wins: Number(r.wins),
    // 이긴 매매가 없으면 평균이 `null`로 온다. 0으로 바꾸면 "평균 0원 이익"이 지어진다.
    avgWin: r.avg_win === null ? 0 : Number(r.avg_win),
    avgLoss: r.avg_loss === null ? 0 : Number(r.avg_loss),
    realizedPnl: Number(r.total),
  }));
}
