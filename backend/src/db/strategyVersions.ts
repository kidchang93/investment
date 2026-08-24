/**
 * **전략 버전 원장.** 한 행이 "그때 무엇이 돌고 있었나" 하나다.
 *
 * 규율은 `docs/STRATEGY_DISCIPLINE.md`, 판정은 `trading/strategyVersion.ts`에 있고
 * 여기는 저장만 맡는다.
 *
 * ★ **덮어쓰지 않고 쌓는다.** 되돌리기가 성립하려면 직전 값이 그대로 남아 있어야
 *   하고, 무엇보다 **"그때 왜 그렇게 정했나"**가 나중에 필요해진다.
 *   `trading_deliberations`가 같은 이유로 같은 모양이다.
 */

import { pool } from './client.js';
import type { StrategyPrediction, StrategyVersionState } from '../trading/strategyVersion.js';

export interface StrategyVersionRow extends StrategyVersionState {
  strategyKey: string;
  params: Record<string, unknown>;
  rationale: string;
  /** 통과 근거 — 측정 원장의 어느 칸인가 */
  backtest: Record<string, unknown>;
  /** 관찰이 끝난 뒤 실제로 어땠나. 아직이면 null */
  outcome: { actual: number | null; verdict: string; judgedOn: string } | null;
  revertedTo: number | null;
  createdAt: string;
}

export async function ensureStrategyVersionSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_strategy_versions (
      id           BIGSERIAL PRIMARY KEY,
      strategy_key TEXT        NOT NULL,
      params       JSONB       NOT NULL DEFAULT '{}'::jsonb,
      rationale    TEXT        NOT NULL,
      prediction   JSONB       NOT NULL,
      backtest     JSONB       NOT NULL DEFAULT '{}'::jsonb,
      active_from  DATE        NOT NULL,
      freeze_until DATE        NOT NULL,
      previous_id  BIGINT,
      outcome      JSONB,
      reverted_to  BIGINT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS trading_strategy_versions_key_idx
      ON trading_strategy_versions (strategy_key, active_from DESC)
  `);
}

/**
 * 지금 도는 버전. 활성화일이 오늘 이하인 것 중 가장 최근.
 *
 * ★ **미래 날짜로 만든 버전은 안 돌아온다.** 앞당겨 넣어 두고 "이미 바뀌었다"고
 *   읽으면 동결 판정이 통째로 어긋난다.
 */
export async function getActiveStrategyVersion(
  strategyKey: string,
  today: string,
): Promise<StrategyVersionRow | null> {
  await ensureStrategyVersionSchema();
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT id::text, strategy_key, params, rationale, prediction, backtest,
            to_char(active_from,'YYYY-MM-DD')  AS active_from,
            to_char(freeze_until,'YYYY-MM-DD') AS freeze_until,
            previous_id::text, outcome, reverted_to::text,
            to_char(created_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI') AS created_at
       FROM trading_strategy_versions
      WHERE strategy_key = $1 AND active_from <= $2::date
      ORDER BY active_from DESC, id DESC
      LIMIT 1`,
    [strategyKey, today],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    strategyKey: String(row.strategy_key),
    params: (row.params ?? {}) as Record<string, unknown>,
    rationale: String(row.rationale),
    prediction: row.prediction as StrategyPrediction,
    backtest: (row.backtest ?? {}) as Record<string, unknown>,
    activeFrom: String(row.active_from),
    freezeUntil: String(row.freeze_until),
    previousId: row.previous_id === null ? undefined : Number(row.previous_id),
    outcome: (row.outcome ?? null) as StrategyVersionRow['outcome'],
    revertedTo: row.reverted_to === null ? null : Number(row.reverted_to),
    createdAt: String(row.created_at),
  };
}

export interface NewStrategyVersion {
  strategyKey: string;
  params: Record<string, unknown>;
  rationale: string;
  prediction: StrategyPrediction;
  backtest: Record<string, unknown>;
  activeFrom: string;
  freezeUntil: string;
  previousId?: number;
}

/**
 * 새 버전을 남긴다.
 *
 * ★ **예측이 없으면 던진다.** 판단자의 `falsifier`·`plan`이 같은 이유로 같은 모양이다 —
 *   기본값을 주면 아무도 안 적고, 그러면 몇 달 뒤 결과에 맞춰 이야기를 붙이게 된다.
 *   *"이 변경으로 무엇이 얼마나 나아질 것인가"*를 **바꾸기 전에** 적어야 한다.
 */
export async function recordStrategyVersion(v: NewStrategyVersion): Promise<number> {
  const p = v.prediction;
  if (!p || typeof p.metric !== 'string' || p.metric.trim().length < 2) {
    throw new Error(
      '전략 버전에 예측(prediction.metric)이 없습니다.'
      + ' 무엇으로 잴 것인지를 바꾸기 전에 적어야 합니다.',
    );
  }
  if (typeof p.expected !== 'number' || !Number.isFinite(p.expected)) {
    throw new Error(`예측값(prediction.expected)이 숫자가 아닙니다: ${String(p.expected)}`);
  }
  if (!Number.isInteger(p.horizonDays) || p.horizonDays <= 0) {
    throw new Error('관찰 기간(prediction.horizonDays)은 1 이상의 거래일이어야 합니다.');
  }
  if (v.rationale.trim().length < 10) {
    throw new Error('전략 버전에 근거(rationale)가 없습니다 — 왜 이 값인지 적어야 합니다.');
  }
  if (v.freezeUntil <= v.activeFrom) {
    throw new Error(
      `동결 끝(${v.freezeUntil})이 활성화일(${v.activeFrom}) 뒤여야 합니다.`
      + ' 같은 날로 두면 동결이 없는 것과 같습니다.',
    );
  }
  await ensureStrategyVersionSchema();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO trading_strategy_versions
       (strategy_key, params, rationale, prediction, backtest, active_from, freeze_until, previous_id)
     VALUES ($1, $2::jsonb, $3, $4::jsonb, $5::jsonb, $6::date, $7::date, $8)
     RETURNING id::text`,
    [
      v.strategyKey,
      JSON.stringify(v.params),
      v.rationale,
      JSON.stringify(v.prediction),
      JSON.stringify(v.backtest),
      v.activeFrom,
      v.freezeUntil,
      v.previousId ?? null,
    ],
  );
  return Number(rows[0].id);
}

/** 관찰이 끝난 버전에 결과를 붙인다. 되돌렸으면 그 대상도 함께 */
export async function attachStrategyOutcome(
  id: number,
  outcome: { actual: number | null; verdict: string; judgedOn: string },
  revertedTo?: number,
): Promise<void> {
  await ensureStrategyVersionSchema();
  await pool.query(
    `UPDATE trading_strategy_versions SET outcome = $2::jsonb, reverted_to = $3 WHERE id = $1`,
    [id, JSON.stringify(outcome), revertedTo ?? null],
  );
}

/** 이력 전부. 되돌린 것까지 남는다 — 무엇을 시도했고 무엇이 죽었는지가 기록이다 */
export async function getStrategyHistory(strategyKey: string, limit = 20): Promise<
  Array<{ id: number; activeFrom: string; freezeUntil: string; rationale: string;
          outcome: StrategyVersionRow['outcome']; revertedTo: number | null }>
> {
  await ensureStrategyVersionSchema();
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 200) : 20;
  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT id::text, to_char(active_from,'YYYY-MM-DD') AS active_from,
            to_char(freeze_until,'YYYY-MM-DD') AS freeze_until,
            rationale, outcome, reverted_to::text
       FROM trading_strategy_versions
      WHERE strategy_key = $1
      ORDER BY active_from DESC, id DESC
      LIMIT $2`,
    [strategyKey, safeLimit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    activeFrom: String(r.active_from),
    freezeUntil: String(r.freeze_until),
    rationale: String(r.rationale),
    outcome: (r.outcome ?? null) as StrategyVersionRow['outcome'],
    revertedTo: r.reverted_to === null ? null : Number(r.reverted_to),
  }));
}
