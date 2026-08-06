/**
 * **지금까지 재 본 것을 전부 남긴다.** 신호 후보의 측정 원장이다.
 *
 * ── 왜 필요한가 (2026-08-05) ─────────────────────────────────────────────
 *
 * 지금까지 측정은 화면에 찍고 사라졌다. 기억과 문서에 요약만 남았다. 그러면
 * **다중검정을 정직하게 셀 수 없다.**
 *
 * 본페로니 문턱은 "이번에 몇 칸을 쟀나"가 아니라 **"지금까지 몇 칸을 쟀나"**로
 * 정해져야 한다. 매일 새 신호를 재면서 그때그때 40칸으로만 보정하면, 스무 날
 * 뒤에는 800칸을 잰 셈인데 문턱은 40칸짜리를 쓰고 있다. 그러면 **언젠가 반드시
 * 우연히 유의한 것이 나오고 우리는 그것을 "찾았다"고 믿는다.**
 *
 * 이 레포는 이미 검정 770칸에서 표본 밖 생존 0건을 겪었다. 그 770을 세어 두지
 * 않았다면 "드디어 하나 나왔다"로 끝났을 것이다.
 *
 * ── 무엇을 남기나 ────────────────────────────────────────────────────────
 *
 * 값만 남기면 안 된다. **가설(`rationale`)을 결과와 같은 줄에** 남긴다 — 그래야
 * 나중에 "이 이유를 재기 전에 적었다"를 증명할 수 있다. 사후에 이야기를 붙이는
 * 것이 이 일에서 가장 흔한 자기기만이다.
 *
 * **표본을 어떻게 골랐는지(`universe`)도 남긴다.** 2026-08-04에 그 하나가 결론을
 * 통째로 뒤집었다 — 거래대금순으로 고르니 20일 기준선이 +10.3%, 코드순으로 고르니
 * −5.7%였다. 같은 신호·같은 기간인데 표본 선정만 달랐다.
 *
 * ── 이 표가 답하는 질문 ──────────────────────────────────────────────────
 *
 *   "지금까지 몇 칸을 쟀나"        → `cumulativeCellCount()` (본페로니의 분모)
 *   "이 신호는 이미 죽였나"        → `findMeasurements({ signalKey })`
 *   "살아남은 것이 있나"           → `findMeasurements({ survivedOnly: true })`
 */

import { pool } from './client.js';

export interface SignalMeasurement {
  /** 언제 쟀나 (epoch ms) */
  measuredAt: number;
  signalKey: string;
  /** **재기 전에 적은 가설.** 결과와 같은 줄에 둬서 사후 이야기 붙이기를 막는다 */
  rationale: string;
  /** 보유 기간(거래일) */
  horizonDays: number;
  /** 구간 이름. 같은 신호를 다른 기간에 잰 것을 가른다 */
  periodKey: string;
  periodFrom: string;
  periodTo: string;
  /**
   * 표본을 **어떻게** 골랐나. 자유 문자열이 아니라 재현할 수 있는 서술이어야 한다.
   * 예: `code-ordered-equidistant-150` / `nxt-eligible-only`
   */
  universe: string;
  symbolsCount: number;
  daysCount: number;
  samples: number;
  /** 상위−하위 평균(%). 방향성 우위는 이 값의 절반이다 */
  spreadMean: number;
  spreadMedian: number;
  /** 날짜 군집 t */
  tStat: number;
  /** 시장을 뺀 뒤의 상위−하위(%)와 그 t, 그리고 시장 민감도 */
  alpha: number;
  alphaT: number;
  beta: number;

  /*
   * ★ **매수 다리 (2026-08-06 추가). 생존 판정은 이것으로 한다.**
   *
   * 이전 줄들은 `alpha/2`로 판정됐는데 그건 **공매도 다리를 반 세는 값**이다.
   * 2026-08-06에 `turnoverSurge` 20일이 그 결함으로 "★ 생존"이 났다 —
   * 갈라 보니 살 수 있는 쪽은 t 2.25로 문턱 2.74를 못 넘었다.
   *
   * `verdictBasis`로 어느 기준의 줄인지 구분한다. **섞어 읽으면 안 된다.**
   */
  topLegMean?: number;
  topLegT?: number;
  topLegTrimmed10?: number;
  topLegTop5Share?: number;
  /** 매수 다리에서 **시장까지 뺀** 몫과 그 t, 그리고 매수 다리의 시장 민감도 */
  topLegAlpha?: number;
  topLegAlphaT?: number;
  topLegBeta?: number;
  /**
   * 판정 기준. 값이 갈리므로 **섞어 읽으면 안 된다.**
   *
   *   (없음)        옛것 — `alpha/2`. 공매도 다리를 반 센다
   *   `topLeg`      매수 다리만. 시장은 안 뺐다
   *   `topLegAlpha` 매수 다리에서 시장까지 뺀 것. **지금 기준**
   */
  verdictBasis?: string;
  /** **그 실행에서** 잰 칸 수. 누적은 이 표를 세어 따로 구한다 */
  runCellCount: number;
  /** 그 실행에서 쓴 문턱 */
  bonferroniT: number;
  survived: boolean;
  note: string;
}

export async function ensureSignalMeasurementSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_signal_measurements (
      id             BIGSERIAL PRIMARY KEY,
      measured_at    BIGINT       NOT NULL,
      signal_key     TEXT         NOT NULL,
      rationale      TEXT         NOT NULL,
      horizon_days   INTEGER      NOT NULL,
      period_key     TEXT         NOT NULL,
      period_from    TEXT         NOT NULL,
      period_to      TEXT         NOT NULL,
      universe       TEXT         NOT NULL,
      symbols_count  INTEGER      NOT NULL,
      days_count     INTEGER      NOT NULL,
      samples        INTEGER      NOT NULL,
      spread_mean    DOUBLE PRECISION NOT NULL,
      spread_median  DOUBLE PRECISION NOT NULL,
      t_stat         DOUBLE PRECISION NOT NULL,
      alpha          DOUBLE PRECISION NOT NULL,
      alpha_t        DOUBLE PRECISION NOT NULL,
      beta           DOUBLE PRECISION NOT NULL,
      run_cell_count INTEGER      NOT NULL,
      bonferroni_t   DOUBLE PRECISION NOT NULL,
      survived       BOOLEAN      NOT NULL,
      note           TEXT         NOT NULL DEFAULT ''
    )
  `);
  /*
   * 나중에 붙은 열. `CREATE TABLE IF NOT EXISTS`는 이미 있는 표를 안 건드리므로
   * 따로 채운다. **옛 줄의 `verdict_basis`가 NULL로 남는 것이 맞다** —
   * 그 줄들은 매수 다리를 안 재고 판정한 것이고, 그 사실 자체가 기록이어야 한다.
   */
  await pool.query(`
    ALTER TABLE trading_signal_measurements
      ADD COLUMN IF NOT EXISTS top_leg_mean       DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS top_leg_t          DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS top_leg_trimmed10  DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS top_leg_top5_share DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS verdict_basis      TEXT,
      ADD COLUMN IF NOT EXISTS top_leg_alpha      DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS top_leg_alpha_t    DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS top_leg_beta       DOUBLE PRECISION
  `);
  /*
   * 같은 (신호·축·구간·표본)을 다시 재면 **덮어쓰지 않고 한 줄 더 쌓는다.**
   * 두 번 잰 것은 두 번 잰 것이다 — 그것도 다중검정 부담이다. 대신 조회가
   * 느려지지 않게 색인만 둔다.
   */
  await pool.query(`
    CREATE INDEX IF NOT EXISTS trading_signal_measurements_lookup
      ON trading_signal_measurements (signal_key, period_key, horizon_days)
  `);
}

export async function recordSignalMeasurements(rows: SignalMeasurement[]): Promise<void> {
  if (rows.length === 0) return;
  await ensureSignalMeasurementSchema();
  for (const r of rows) {
    await pool.query(
      `INSERT INTO trading_signal_measurements
         (measured_at, signal_key, rationale, horizon_days, period_key, period_from, period_to,
          universe, symbols_count, days_count, samples, spread_mean, spread_median, t_stat,
          alpha, alpha_t, beta, run_cell_count, bonferroni_t, survived, note,
          top_leg_mean, top_leg_t, top_leg_trimmed10, top_leg_top5_share, verdict_basis,
          top_leg_alpha, top_leg_alpha_t, top_leg_beta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
               $22,$23,$24,$25,$26,$27,$28,$29)`,
      [
        r.measuredAt, r.signalKey, r.rationale, r.horizonDays, r.periodKey, r.periodFrom,
        r.periodTo, r.universe, r.symbolsCount, r.daysCount, r.samples, r.spreadMean,
        r.spreadMedian, r.tStat, r.alpha, r.alphaT, r.beta, r.runCellCount, r.bonferroniT,
        r.survived, r.note,
        r.topLegMean ?? null, r.topLegT ?? null, r.topLegTrimmed10 ?? null,
        r.topLegTop5Share ?? null, r.verdictBasis ?? null,
        r.topLegAlpha ?? null, r.topLegAlphaT ?? null, r.topLegBeta ?? null,
      ],
    );
  }
}

/**
 * **원장이 생기기 전에 이미 잰 검정 수.**
 *
 * 원장을 0에서 시작하면 첫 실행이 "지금까지 56칸 쟀다"고 믿고 낮은 문턱을 쓴다.
 * 그건 이 원장이 막으려던 바로 그 일이다. 그래서 과거분을 **수로** 이고 간다.
 *
 * 내역 (2026-08-05 기준):
 *
 *   770  전략 파라미터 백테스트 검정 — 표본 밖 생존 0건
 *    40  2026-08-04 신호 하네스 `recent` (후보 10 × 축 4)
 *    40  2026-08-04 신호 하네스 `prior`
 *   ───
 *   850
 *
 * ★ **줄 단위로 재구성하지 않고 수만 남긴다.** 개별 줄을 지어내면 원장이 거짓이
 * 된다 — "재기 전에 적은 가설"을 사후에 채워 넣는 셈이라 이 표의 존재 이유를 깬다.
 *
 * ★ 여기 **안 들어간 것**: 갭 측정(`measureOpeningGap`)과 NXT 프리갭
 * (`measureNxtPreGap`)의 랭킹 6건. 그 스크립트들은 아직 원장에 안 쓴다 —
 * 붙이면 이 상수에서 빼는 게 아니라 그쪽이 줄을 쌓게 한다.
 */
export const PRE_LEDGER_CELL_COUNT = 850;

/**
 * **지금까지 잰 칸이 몇 개인가.** 본페로니의 분모다.
 *
 * ★ **줄 수를 그대로 센다.** 같은 칸을 두 번 쟀으면 둘로 센다 — 두 번 봤으면
 * 우연히 유의할 기회도 두 번이다. `DISTINCT`로 줄이고 싶은 유혹이 있는데,
 * 그건 문턱을 낮추는 방향이라 정확히 잘못된 쪽이다.
 */
export async function cumulativeCellCount(): Promise<number> {
  await ensureSignalMeasurementSchema();
  const { rows } = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM trading_signal_measurements`,
  );
  return PRE_LEDGER_CELL_COUNT + Number(rows[0]?.n ?? 0);
}

/** 이미 재 본 것을 되짚는다. 같은 신호를 모르고 또 재는 일을 막는다. */
export async function findMeasurements(filter: {
  signalKey?: string;
  periodKey?: string;
  survivedOnly?: boolean;
  limit?: number;
}): Promise<SignalMeasurement[]> {
  await ensureSignalMeasurementSchema();
  const where: string[] = [];
  const values: unknown[] = [];
  if (filter.signalKey) {
    values.push(filter.signalKey);
    where.push(`signal_key = $${values.length}`);
  }
  if (filter.periodKey) {
    values.push(filter.periodKey);
    where.push(`period_key = $${values.length}`);
  }
  if (filter.survivedOnly) where.push('survived = TRUE');
  values.push(Math.min(500, Math.max(1, filter.limit ?? 200)));

  const { rows } = await pool.query<Record<string, string | number | boolean>>(
    `SELECT * FROM trading_signal_measurements
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY measured_at DESC, id DESC
     LIMIT $${values.length}`,
    values,
  );
  return rows.map((row) => ({
    measuredAt: Number(row.measured_at),
    signalKey: String(row.signal_key),
    rationale: String(row.rationale),
    horizonDays: Number(row.horizon_days),
    periodKey: String(row.period_key),
    periodFrom: String(row.period_from),
    periodTo: String(row.period_to),
    universe: String(row.universe),
    symbolsCount: Number(row.symbols_count),
    daysCount: Number(row.days_count),
    samples: Number(row.samples),
    spreadMean: Number(row.spread_mean),
    spreadMedian: Number(row.spread_median),
    tStat: Number(row.t_stat),
    alpha: Number(row.alpha),
    alphaT: Number(row.alpha_t),
    beta: Number(row.beta),
    runCellCount: Number(row.run_cell_count),
    bonferroniT: Number(row.bonferroni_t),
    survived: Boolean(row.survived),
    note: String(row.note),
    topLegMean: row.top_leg_mean === null ? undefined : Number(row.top_leg_mean),
    topLegT: row.top_leg_t === null ? undefined : Number(row.top_leg_t),
    topLegTrimmed10: row.top_leg_trimmed10 === null ? undefined : Number(row.top_leg_trimmed10),
    topLegTop5Share: row.top_leg_top5_share === null ? undefined : Number(row.top_leg_top5_share),
    verdictBasis: row.verdict_basis === null ? undefined : String(row.verdict_basis),
    topLegAlpha: row.top_leg_alpha === null ? undefined : Number(row.top_leg_alpha),
    topLegAlphaT: row.top_leg_alpha_t === null ? undefined : Number(row.top_leg_alpha_t),
    topLegBeta: row.top_leg_beta === null ? undefined : Number(row.top_leg_beta),
  }));
}
