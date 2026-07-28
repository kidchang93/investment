/**
 * 신호 채점 기록.
 *
 * 백테스트는 과거만 말한다. 지금 이 전략이 되는지는 **낸 신호를 나중에 채점해야**
 * 안다. 자동매매가 남긴 매수 신호(`trading_auto_runs`)를 며칠 뒤 가격과 견줘
 * 맞았는지 세고, 그 결과를 여기 쌓는다.
 *
 * 한 신호를 여러 기간(1·5·20일)으로 채점한다. 전략마다 들고 있는 기간이 달라
 * 하나로만 재면 이동평균 교차를 하루 성적으로 판정하게 된다.
 *
 * **비용을 뺀 값을 함께 남긴다.** 왕복 0.43%를 빼지 않으면 이겼다고 착각한다.
 */

import { pool } from './client.js';

export interface SignalScoreInput {
  /** 채점 대상이 된 trading_auto_runs.id */
  runId: string;
  accountId: string;
  instrumentId: string;
  /** 신호가 난 시각 */
  signalAt: Date;
  signalPrice: number;
  /** 며칠 뒤로 쟀는지 (거래일 기준) */
  horizonDays: number;
  /** 그 시점의 종가 */
  exitPrice: number;
  /** 비용 빼기 전 수익률 % */
  grossReturn: number;
  /** 왕복 비용을 뺀 수익률 % */
  netReturn: number;
}

export interface SignalScoreSummary {
  horizonDays: number;
  count: number;
  /** 비용을 뺀 뒤에도 플러스인 신호 수 */
  winCount: number;
  winRate: number;
  avgNetReturn: number;
  medianNetReturn: number;
}

export async function ensureSignalScoreSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_signal_scores (
      id BIGSERIAL PRIMARY KEY,
      run_id BIGINT NOT NULL,
      account_id TEXT NOT NULL,
      instrument_id TEXT NOT NULL,
      signal_at TIMESTAMPTZ NOT NULL,
      signal_price NUMERIC NOT NULL,
      horizon_days INT NOT NULL,
      exit_price NUMERIC NOT NULL,
      gross_return NUMERIC NOT NULL,
      net_return NUMERIC NOT NULL,
      scored_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    /*
     * 같은 신호를 같은 기간으로 두 번 채점하지 않는다. 채점기를 하루에 여러 번
     * 돌려도 결과가 늘어나지 않아야 성적이 부풀지 않는다.
     */
    CREATE UNIQUE INDEX IF NOT EXISTS trading_signal_scores_run_horizon_key
      ON trading_signal_scores (run_id, horizon_days);

    CREATE INDEX IF NOT EXISTS trading_signal_scores_account_idx
      ON trading_signal_scores (account_id, signal_at DESC);
  `);
}

/** 이미 채점한 (신호, 기간) 조합. 다시 재지 않으려고 먼저 읽는다. */
export async function getScoredKeys(accountId: string): Promise<Set<string>> {
  const { rows } = await pool.query<{ run_id: string; horizon_days: number }>(
    'SELECT run_id, horizon_days FROM trading_signal_scores WHERE account_id = $1',
    [accountId],
  );
  return new Set(rows.map((row) => `${row.run_id}:${row.horizon_days}`));
}

export async function recordSignalScore(input: SignalScoreInput): Promise<boolean> {
  try {
    await pool.query(
      `
        INSERT INTO trading_signal_scores
          (run_id, account_id, instrument_id, signal_at, signal_price,
           horizon_days, exit_price, gross_return, net_return)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (run_id, horizon_days) DO NOTHING
      `,
      [
        input.runId,
        input.accountId,
        input.instrumentId,
        input.signalAt,
        input.signalPrice,
        input.horizonDays,
        input.exitPrice,
        input.grossReturn,
        input.netReturn,
      ],
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 기간별 누적 성적.
 *
 * 평균과 중앙값을 함께 낸다 — 한 종목이 크게 오르면 평균만 좋아진다.
 * 승률도 함께 낸다 — 이기는 횟수가 많아도 지는 크기가 크면 진다.
 */
export async function getSignalScoreSummary(accountId: string): Promise<SignalScoreSummary[]> {
  const { rows } = await pool.query<{
    horizon_days: number;
    count: string;
    win_count: string;
    avg_net: string;
    median_net: string;
  }>(
    `
      SELECT
        horizon_days,
        COUNT(*) AS count,
        COUNT(*) FILTER (WHERE net_return > 0) AS win_count,
        AVG(net_return) AS avg_net,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY net_return) AS median_net
      FROM trading_signal_scores
      WHERE account_id = $1
      GROUP BY horizon_days
      ORDER BY horizon_days
    `,
    [accountId],
  );

  return rows.map((row) => {
    const count = Number(row.count);
    const winCount = Number(row.win_count);
    return {
      horizonDays: row.horizon_days,
      count,
      winCount,
      winRate: count > 0 ? winCount / count : 0,
      avgNetReturn: Number(row.avg_net),
      medianNetReturn: Number(row.median_net),
    };
  });
}

export interface PendingSignal {
  runId: string;
  accountId: string;
  instrumentId: string;
  signalAt: Date;
  signalPrice: number;
}

/**
 * 아직 채점하지 않은 매수 신호.
 *
 * 가격이 없는 줄(후보 없음·보류 등)은 채점할 수 없으므로 제외한다.
 * 모의 실행도 포함한다 — 주문이 나갔는지와 신호가 맞았는지는 다른 질문이다.
 */
export async function getBuySignalsToScore(accountId: string, sinceDays = 60): Promise<PendingSignal[]> {
  const { rows } = await pool.query<{
    id: string;
    account_id: string;
    instrument_id: string;
    created_at: Date;
    price: string;
  }>(
    `
      SELECT id, account_id, instrument_id, created_at, price
      FROM trading_auto_runs
      WHERE account_id = $1
        AND side = 'buy'
        AND instrument_id IS NOT NULL
        AND price IS NOT NULL
        AND price > 0
        AND created_at >= now() - ($2 || ' days')::interval
      ORDER BY created_at
    `,
    [accountId, String(sinceDays)],
  );
  return rows.map((row) => ({
    runId: row.id,
    accountId: row.account_id,
    instrumentId: row.instrument_id,
    signalAt: row.created_at,
    signalPrice: Number(row.price),
  }));
}
