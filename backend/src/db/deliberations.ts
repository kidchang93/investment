/**
 * **에이전트 회의 한 회차를 통째로 남긴다.**
 *
 * ── 왜 이게 없으면 안 되나 (2026-08-06) ──────────────────────────────────
 *
 * 판단자를 알고리즘에서 에이전트로 바꾸면서 **되돌려 재는 능력을 포기했다.**
 * 신호는 함수라 5년치에 다시 돌릴 수 있지만, 회의는 재현되지 않는다 —
 * "3월 14일에 에이전트가 뭐라 했을까"를 다시 만들 수 없다.
 *
 * 그 대가로 남는 것이 **앞으로 재는 것**뿐인데, 그러려면 판단을 그때 그대로
 * 남겨야 한다. 안 남기면 몇 달 뒤에 *"이게 됐나"*조차 물을 수 없다.
 * **이 표가 없으면 에이전트 구조는 측정 불가능한 채로 돌아간다.**
 *
 * ── 무엇을 남기나 — 셋을 갈라 둔다 ───────────────────────────────────────
 *
 *   판단   무엇을 하기로 했나 + 왜                    ← 결과를 보기 **전**에 정해진 것
 *   집행   실제로 무엇이 나갔나 + 얼마에 체결됐나      ← 판단과 다를 수 있다(관문·미체결)
 *   결과   그래서 어떻게 됐나                          ← 나중에 채운다
 *
 * **판단과 결과를 한 칸에 섞으면 점수를 못 낸다.** 좋은 판단이 나쁜 결과를 낼 수
 * 있고 그 반대도 있다 — 둘을 갈라야 "판단이 좋았나"와 "운이 좋았나"를 구분한다.
 *
 * ── ★ `falsifier`가 필수인 이유 ──────────────────────────────────────────
 *
 * **"이 판단이 틀렸다면 무엇이 관측될까"를 결과를 보기 전에 적는다.**
 *
 * 안 적으면 나중에 결과에 맞춰 이야기를 붙이게 된다 — 오르면 "역시 맞았다",
 * 내리면 "시장이 이상했다". 둘 다 되는 설명은 설명이 아니다. 이 레포의 신호
 * 후보들이 `rationale`을 재기 전에 적게 강제하는 것과 같은 규율이다.
 *
 * 2026-08-05 첫 회의에서 `quant-strategist`가 이걸 스스로 했다("내일 둘 다
 * 오르면 결과가 나빴던 것이지 틀린 것이 아니다"). 필드로 만들어 강제한다.
 */

import { pool } from './client.js';

/** 이 회차가 왜 열렸나 */
export type DeliberationTrigger = 'scheduled' | 'event' | 'manual';

export interface DeliberationDecision {
  symbol: string;
  name: string;
  /**
   * `amend`·`cancel`은 **이미 낸 주문**을 다루는 결정이다(2026-08-20 추가).
   *
   * 그날 아침 지정가 두 건이 미체결로 남았는데, 그것을 정정할지 취소할지
   * 그대로 둘지를 **아무도 정하지 않는 구조**였다 — 판단자는 하루 한 번
   * 열리고, 그 회차가 끝나면 주문은 15:30에 그냥 실효됐다.
   */
  action: 'buy' | 'sell' | 'hold' | 'amend' | 'cancel';
  /** `hold`면 0. `cancel`은 남은 수량 전부를 뜻하는 0을 쓸 수 있다 */
  quantity: number;
  /** 왜 이렇게 정했나. 사람이 읽을 글이다 */
  rationale: string;
  /**
   * ★ **지정가(원). 없으면 시장가다** — 집행기가 그렇게 읽는다.
   *
   * 2026-08-20까지 이 칸이 없어서, 회차 21은 지정가를 `rationale`에 글로만
   * 적었다("지정가 252,000원 37주"). 사람은 읽지만 집행기는 못 읽는다.
   * 그날 주문은 사람이 손으로 옮겨 적어야 했다.
   */
  limitPrice?: number;
  /**
   * ★ **3층 중 어디인가.** `buy`에 반드시 있어야 한다 — 없으면 `recordDeliberation`이
   * 던진다.
   *
   * **증권사 잔고는 층을 모른다.** 주문 시점에 적어 두지 않으면 체결을 층으로
   * 되돌릴 수 없고(`layerSync`), 층별 성과가 통째로 거짓이 된다. 2026-08-20에
   * 실제로 그랬다 — 그날 낸 두 건은 `rationale`에 "유망주 층"이라고 적혀 있었지만
   * 주문 기록의 `layer`는 비어 있었다.
   */
  layer?: 'etf' | 'short' | 'bet';
  /** `amend`·`cancel`의 대상. 원주문 번호(ODNO)와 채번지점(KRX_FWDG_ORD_ORGNO) */
  orderNo?: string;
  orderBranchNo?: string;
  /**
   * ★ **예측. 사기 전에 적고, 나중에 맞았는지 잰다.**
   *
   * ── 왜 (2026-08-19) ─────────────────────────────────────────────────
   *
   * 사용자가 정했다 — *"이 정도까지 들고 있으면 수익이 이 정도 나겠다 예측을
   * 하란 거지."* 그 전까지 결정에는 `action`과 `rationale`만 있어서, 판단이
   * 맞았는지 **되짚을 수가 없었다.** 산 뒤에 오르면 잘한 것이고 내리면 못한
   * 것이라는 사후 이야기만 남는다.
   *
   * 목표가·손절가·기간을 **사기 전에** 적어 두면 셋을 잴 수 있다:
   *   ① 목표에 닿았나  ② 기간 안에 닿았나  ③ 손절이 먼저 왔나
   *
   * ★ 이것이 판단 품질을 고치는 **유일한 고리**다. 예측을 안 남기면 에이전트가
   * 매번 새로 시작하고, 열 번을 돌려도 나아지지 않는다.
   *
   * `hold`·`sell`에는 없어도 된다 — 새로 들어가는 자리에만 필요하다.
   */
  plan?: {
    /** 익절 목표가(원) */
    targetPrice: number;
    /** 손절가(원). 여기 닿으면 판단이 틀린 것이다 */
    stopPrice: number;
    /** 목표까지 예상하는 보유 기간(거래일) */
    horizonDays: number;
    /** 목표가에 닿았을 때의 수익률(0~1). 비용을 뺀 값으로 적는다 */
    expectedReturn: number;
    /** 왜 그 값들인가. 목표가·손절가를 어디서 땄는지 */
    basis: string;
  };
}

export interface DeliberationExecution {
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  orderNo: string;
  /** 판정 시점 단가. 슬리피지의 기준이 된다 */
  estimatedPrice: number;
  /** 체결 평균가. 아직 모르면 넣지 않는다 */
  filledPrice?: number;
  /** 관문에 막혔으면 그 사유. 막힌 것도 남긴다 — 왜 못 냈는지가 판단의 일부다 */
  blockedBy?: string[];
}

export interface DeliberationRound {
  accountId: string;
  /** KST 거래일 `YYYY-MM-DD` */
  tradingDay: string;
  /** 회의 시작 시각 (epoch ms) */
  startedAt: number;
  trigger: DeliberationTrigger;
  /** 사건이면 무엇 때문인지. 정기면 빈 문자열 */
  triggerReason: string;

  /** 그때 총평가. 결과 점수의 기준선이다 */
  equity: number;
  /** 그때 보유. 판단을 되짚으려면 무엇을 들고 있었는지가 있어야 한다 */
  positions: Array<{ symbol: string; name: string; quantity: number; averagePrice: number }>;

  /** 에이전트별로 무엇을 내놓았나. `agent`는 에이전트 이름 */
  findings: Array<{ agent: string; summary: string }>;
  decisions: DeliberationDecision[];

  /**
   * ★ **결과를 보기 전에 적는 반증 조건.** 비워 두면 안 된다 —
   * `recordDeliberation`이 거부한다.
   */
  falsifier: string;
  /** 그때 **몰랐던** 것. 판단을 약하게 만드는 것을 숨기지 않는다 */
  unknowns: string[];
  sources: string[];

  /**
   * ★ **이 회차 시점의 값들. 다음 회차의 사건 판정 기준선이 된다.**
   *
   * 사건 문턱을 **전일 종가 대비**로 잡으면 한 번 걸린 뒤 종일 걸려 있는다 —
   * 아침에 −2% 벌어지면 그 뒤로 하루 종일 "사건"이라 깨우는 뜻이 사라진다.
   * **직전 회의 이후 변화**로 재야 "지난번 본 뒤로 크게 움직였다"가 된다.
   */
  reference: {
    kospi?: number;
    kosdaq?: number;
    /** 종목코드 → 그때 현재가. 보유·감시 종목 */
    prices: Record<string, number>;
  };

  /** 집행 결과. 회의 시점엔 비어 있고 집행 뒤에 채운다 */
  executions: DeliberationExecution[];
}

export async function ensureDeliberationSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_deliberations (
      id             BIGSERIAL PRIMARY KEY,
      account_id     TEXT        NOT NULL,
      trading_day    DATE        NOT NULL,
      started_at     BIGINT      NOT NULL,
      trigger        TEXT        NOT NULL,
      trigger_reason TEXT        NOT NULL DEFAULT '',
      equity         DOUBLE PRECISION NOT NULL,
      positions      JSONB       NOT NULL DEFAULT '[]'::jsonb,
      findings       JSONB       NOT NULL DEFAULT '[]'::jsonb,
      decisions      JSONB       NOT NULL DEFAULT '[]'::jsonb,
      falsifier      TEXT        NOT NULL,
      unknowns       JSONB       NOT NULL DEFAULT '[]'::jsonb,
      sources        JSONB       NOT NULL DEFAULT '[]'::jsonb,
      reference      JSONB       NOT NULL DEFAULT '{"prices":{}}'::jsonb,
      executions     JSONB       NOT NULL DEFAULT '[]'::jsonb,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  /*
   * **덮어쓰지 않고 쌓는다.** 같은 날 회차가 여럿이고, 앞 회차가 뭐라고 했는지가
   * 뒤 회차를 읽는 데 필요하다 — 판단이 바뀌었다는 사실 자체가 기록이다.
   */
  await pool.query(`
    CREATE INDEX IF NOT EXISTS trading_deliberations_day_idx
      ON trading_deliberations (trading_day DESC, account_id, started_at DESC)
  `);
}

/**
 * 회차를 남기고 id를 돌려준다. 집행 결과는 나중에 `attachExecutions`로 붙인다.
 *
 * ★ **`falsifier`가 비면 던진다.** 기본값을 주면 아무도 안 적고, 그러면 몇 달 뒤
 * 결과에 맞춰 이야기를 붙이게 된다 — 이 표를 만든 이유가 사라진다.
 */
/**
 * 결정 하나가 **집행될 수 있는 모양인가**를 본다. 못 내는 결정을 기록만 하면
 * "판단은 했는데 아무 일도 안 일어난" 자리가 조용히 생긴다.
 *
 * ★ 던지는 이유를 메시지에 정확히 적는다 — 판단자는 헤드리스라 이 문장을 읽고
 *   JSON을 고쳐 다시 넣는다. `falsifier`가 이미 그렇게 동작한다.
 */
function decisionProblem(d: DeliberationDecision): string | null {
  if (d.action === 'buy') {
    // 층을 모르면 체결을 층에 되돌릴 수 없다. 짐작해서 채우지 않는다.
    if (d.layer !== 'etf' && d.layer !== 'short' && d.layer !== 'bet') {
      return `${d.symbol} 매수에 layer가 없습니다. 'etf' | 'short' | 'bet' 중 하나를 적으세요`
        + ' — 증권사 잔고는 층을 모르므로 여기 없으면 층별 성과가 거짓이 됩니다.';
    }
    /*
     * ★ **지정가 없는 매수를 받지 않는다.** `limitPrice`가 비면 집행기가 시장가로
     *   읽는데, 시장가는 값을 모르는 채 나가는 주문이다. 2026-08-01에 러너가 늘
     *   시장가라 일일 금액 한도에 **영원히 0원**으로 쌓인 적도 있다.
     *   판단자는 얼마에 살지를 정하는 것이 일이다 — 안 정했으면 판단이 덜 된 것이다.
     */
    if (typeof d.limitPrice !== 'number' || !Number.isFinite(d.limitPrice) || d.limitPrice <= 0) {
      return `${d.symbol} 매수에 limitPrice가 없습니다 — 얼마에 살지 적으세요.`
        + ' 비우면 시장가로 나갑니다.';
    }
    // 예측이 없으면 나중에 맞았는지 잴 수 없다. 이 표를 만든 이유가 사라진다.
    if (!d.plan) {
      return `${d.symbol} 매수에 plan이 없습니다.`
        + ' targetPrice · stopPrice · horizonDays · expectedReturn · basis를 사기 전에 적으세요.';
    }
  }
  if (d.action === 'amend' || d.action === 'cancel') {
    if (!d.orderNo) {
      return `${d.symbol} ${d.action}에 orderNo가 없습니다 — 어느 주문을 다루는지 알 수 없습니다.`;
    }
    if (d.action === 'amend' && typeof d.limitPrice !== 'number') {
      return `${d.symbol} amend에 limitPrice가 없습니다 — 얼마로 정정하는지 알 수 없습니다.`;
    }
  }
  return null;
}

export async function recordDeliberation(round: DeliberationRound): Promise<number> {
  if (round.falsifier.trim().length < 10) {
    throw new Error(
      '회의 기록에 반증 조건(falsifier)이 없습니다.'
      + ' "이 판단이 틀렸다면 무엇이 관측될까"를 결과를 보기 전에 적어야 합니다.',
    );
  }
  for (const decision of round.decisions) {
    const problem = decisionProblem(decision);
    if (problem) throw new Error(problem);
  }
  await ensureDeliberationSchema();
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO trading_deliberations
       (account_id, trading_day, started_at, trigger, trigger_reason, equity,
        positions, findings, decisions, falsifier, unknowns, sources, reference, executions)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb)
     RETURNING id::text`,
    [
      round.accountId, round.tradingDay, round.startedAt, round.trigger, round.triggerReason,
      round.equity,
      JSON.stringify(round.positions), JSON.stringify(round.findings),
      JSON.stringify(round.decisions), round.falsifier,
      JSON.stringify(round.unknowns), JSON.stringify(round.sources),
      JSON.stringify(round.reference ?? { prices: {} }),
      JSON.stringify(round.executions),
    ],
  );
  return Number(rows[0].id);
}

/**
 * 집행 결과를 회차에 붙인다.
 *
 * **판단을 고치지 않는다.** 집행이 판단과 달라도(관문에 막혔거나 부분체결)
 * 판단 쪽은 그대로 두고 집행 쪽에만 적는다 — 그 차이가 나중에 볼 값이다.
 */
export async function attachExecutions(
  id: number,
  executions: DeliberationExecution[],
): Promise<void> {
  await pool.query(
    `UPDATE trading_deliberations SET executions = $2::jsonb WHERE id = $1`,
    [id, JSON.stringify(executions)],
  );
}

export async function getDeliberations(filter: {
  accountId?: string;
  tradingDay?: string;
  limit?: number;
}): Promise<Array<DeliberationRound & { id: number }>> {
  await ensureDeliberationSchema();
  const where: string[] = [];
  const values: unknown[] = [];
  if (filter.accountId) {
    values.push(filter.accountId);
    where.push(`account_id = $${values.length}`);
  }
  if (filter.tradingDay) {
    values.push(filter.tradingDay);
    where.push(`trading_day = $${values.length}`);
  }
  values.push(Math.min(200, Math.max(1, filter.limit ?? 50)));

  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT id::text, account_id, trading_day::text, started_at::text, trigger, trigger_reason,
            equity, positions, findings, decisions, falsifier, unknowns, sources,
            reference, executions
     FROM trading_deliberations
     ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY started_at DESC
     LIMIT $${values.length}`,
    values,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    accountId: String(r.account_id),
    tradingDay: String(r.trading_day),
    startedAt: Number(r.started_at),
    trigger: String(r.trigger) as DeliberationTrigger,
    triggerReason: String(r.trigger_reason),
    equity: Number(r.equity),
    positions: (r.positions ?? []) as DeliberationRound['positions'],
    findings: (r.findings ?? []) as DeliberationRound['findings'],
    decisions: (r.decisions ?? []) as DeliberationDecision[],
    falsifier: String(r.falsifier),
    unknowns: (r.unknowns ?? []) as string[],
    sources: (r.sources ?? []) as string[],
    reference: (r.reference ?? { prices: {} }) as DeliberationRound['reference'],
    executions: (r.executions ?? []) as DeliberationExecution[],
  }));
}
