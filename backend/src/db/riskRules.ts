import { pool } from './client.js';
import { isDomesticMarketOpenDay } from '../kis/rest.js';
import type { OrderSide, OrderType, RiskRuleSet, RiskVerdict } from '@invest/shared';

/**
 * 계좌별 실주문 리스크 룰.
 *
 * 게이트(`KIS_LIVE_ORDER_ENABLED`)는 "실주문을 켰는가"만 본다.
 * 여기서는 "이 주문을 내도 되는가"를 본다 — 1회 한도, 일일 한도, 종목 제한, 장 시간.
 *
 * 판정은 항상 서버에서 한다. 프런트는 결과를 보여줄 뿐 우회할 수 없다.
 */

interface RiskRuleRow {
  account_id: string;
  enabled: boolean;
  max_order_notional: string;
  max_order_quantity: string;
  daily_notional_limit: string;
  daily_order_count_limit: string;
  allow_market_order: boolean;
  session_start: string;
  session_end: string;
  symbol_allowlist: string[] | null;
  symbol_blocklist: string[] | null;
}

/** 계좌 설정이 없을 때 쓰는 보수적인 기본값. 처음부터 크게 열어두지 않는다. */
const DEFAULT_RULES: Omit<RiskRuleSet, 'accountId'> = {
  enabled: true,
  maxOrderNotional: 1_000_000,
  maxOrderQuantity: 1_000,
  dailyNotionalLimit: 5_000_000,
  dailyOrderCountLimit: 20,
  allowMarketOrder: false,
  sessionStart: '09:00',
  sessionEnd: '15:30',
  symbolAllowlist: [],
  symbolBlocklist: [],
};

export async function ensureRiskRuleSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_risk_rules (
      account_id text PRIMARY KEY,
      enabled boolean NOT NULL DEFAULT true,
      max_order_notional numeric(20, 4) NOT NULL DEFAULT 1000000,
      max_order_quantity numeric(24, 8) NOT NULL DEFAULT 1000,
      daily_notional_limit numeric(20, 4) NOT NULL DEFAULT 5000000,
      daily_order_count_limit integer NOT NULL DEFAULT 20,
      allow_market_order boolean NOT NULL DEFAULT false,
      session_start text NOT NULL DEFAULT '09:00',
      session_end text NOT NULL DEFAULT '15:30',
      symbol_allowlist jsonb NOT NULL DEFAULT '[]'::jsonb,
      symbol_blocklist jsonb NOT NULL DEFAULT '[]'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function getRiskRules(accountId: string): Promise<RiskRuleSet> {
  const { rows } = await pool.query<RiskRuleRow>(
    `SELECT * FROM trading_risk_rules WHERE account_id = $1`,
    [accountId],
  );
  const row = rows[0];
  if (!row) return { accountId, ...DEFAULT_RULES };

  return {
    accountId,
    enabled: row.enabled,
    maxOrderNotional: Number(row.max_order_notional),
    maxOrderQuantity: Number(row.max_order_quantity),
    dailyNotionalLimit: Number(row.daily_notional_limit),
    dailyOrderCountLimit: Number(row.daily_order_count_limit),
    allowMarketOrder: row.allow_market_order,
    sessionStart: row.session_start,
    sessionEnd: row.session_end,
    symbolAllowlist: row.symbol_allowlist ?? [],
    symbolBlocklist: row.symbol_blocklist ?? [],
  };
}

export async function upsertRiskRules(rules: RiskRuleSet): Promise<RiskRuleSet> {
  await pool.query(
    `
      INSERT INTO trading_risk_rules (
        account_id, enabled, max_order_notional, max_order_quantity, daily_notional_limit,
        daily_order_count_limit, allow_market_order, session_start, session_end,
        symbol_allowlist, symbol_blocklist, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, now())
      ON CONFLICT (account_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        max_order_notional = EXCLUDED.max_order_notional,
        max_order_quantity = EXCLUDED.max_order_quantity,
        daily_notional_limit = EXCLUDED.daily_notional_limit,
        daily_order_count_limit = EXCLUDED.daily_order_count_limit,
        allow_market_order = EXCLUDED.allow_market_order,
        session_start = EXCLUDED.session_start,
        session_end = EXCLUDED.session_end,
        symbol_allowlist = EXCLUDED.symbol_allowlist,
        symbol_blocklist = EXCLUDED.symbol_blocklist,
        updated_at = now()
    `,
    [
      rules.accountId,
      rules.enabled,
      rules.maxOrderNotional,
      rules.maxOrderQuantity,
      rules.dailyNotionalLimit,
      rules.dailyOrderCountLimit,
      rules.allowMarketOrder,
      rules.sessionStart,
      rules.sessionEnd,
      JSON.stringify(rules.symbolAllowlist),
      JSON.stringify(rules.symbolBlocklist),
    ],
  );
  return getRiskRules(rules.accountId);
}

/** 오늘(KST) 접수된 실주문의 건수와 금액 합. 일일 한도 판정에 쓴다. */
async function getTodayUsage(accountId: string): Promise<{ count: number; notional: number }> {
  const { rows } = await pool.query<{ order_count: string; notional_sum: string | null }>(
    `
      SELECT
        COUNT(*)::text AS order_count,
        COALESCE(SUM(COALESCE(quantity, 0) * COALESCE(limit_price, 0)), 0)::text AS notional_sum
      FROM trading_broker_orders
      WHERE account_id = $1
        AND action = 'place'
        AND status = 'submitted'
        AND (created_at AT TIME ZONE 'Asia/Seoul')::date = (now() AT TIME ZONE 'Asia/Seoul')::date
    `,
    [accountId],
  );
  const row = rows[0];
  return { count: Number(row?.order_count ?? 0), notional: Number(row?.notional_sum ?? 0) };
}

/** 'HH:MM' 문자열을 분 단위로. 형식이 깨지면 null. */
function toMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** 지금이 KST 기준 몇 분인지. 서버 타임존과 무관해야 하므로 Intl로 뽑는다. */
function kstNowMinutes(): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(values.hour) * 60 + Number(values.minute);
}

export interface RiskCheckInput {
  accountId: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;
  /** 지정가면 단가, 시장가면 현재가 추정치 */
  price: number;
  /**
   * 거래 시간대·개장일 검사를 건너뛴다.
   * 예약주문은 장 마감 후(15:40~다음 영업일 07:30)에 넣는 게 정상이라
   * 같은 잣대를 대면 정상 사용을 막는다. 금액·수량·종목 제한은 그대로 적용된다.
   */
  skipSessionCheck?: boolean;
}

/**
 * 주문 1건을 룰에 비춰 판정한다.
 * 위반 사유를 모두 모아 돌려준다. 첫 번째에서 멈추면 사용자가 고칠 때마다 새 사유를 만난다.
 */
export async function checkRiskRules(input: RiskCheckInput): Promise<RiskVerdict> {
  const rules = await getRiskRules(input.accountId);
  const violations: string[] = [];

  if (!rules.enabled) {
    return { allowed: false, violations: ['이 계좌는 리스크 룰에서 실주문이 꺼져 있습니다.'], rules };
  }

  const notional = input.quantity * input.price;

  if (input.quantity > rules.maxOrderQuantity) {
    violations.push(`1회 주문 수량 한도 ${rules.maxOrderQuantity.toLocaleString('ko-KR')}주를 초과합니다.`);
  }
  if (notional > rules.maxOrderNotional) {
    violations.push(`1회 주문 금액 한도 ${rules.maxOrderNotional.toLocaleString('ko-KR')}원을 초과합니다.`);
  }
  if (input.orderType === 'market' && !rules.allowMarketOrder) {
    violations.push('이 계좌는 시장가 주문이 막혀 있습니다.');
  }
  if (rules.symbolBlocklist.includes(input.symbol)) {
    violations.push(`차단 종목입니다 (${input.symbol}).`);
  }
  if (rules.symbolAllowlist.length > 0 && !rules.symbolAllowlist.includes(input.symbol)) {
    violations.push(`허용 종목 목록에 없습니다 (${input.symbol}).`);
  }

  if (!input.skipSessionCheck) {
    const start = toMinutes(rules.sessionStart);
    const end = toMinutes(rules.sessionEnd);
    if (start === null || end === null) {
      violations.push('거래 시간 설정이 올바르지 않습니다 (HH:MM).');
    } else {
      const now = kstNowMinutes();
      if (now < start || now > end) {
        violations.push(`허용 시간(${rules.sessionStart}~${rules.sessionEnd}, KST) 밖입니다.`);
      }
    }

    /*
     * 시각만 보면 주말·공휴일 주문이 그대로 나간다. 실제로 토요일 13시 주문이 룰을 통과해
     * KIS까지 갔다가 "장운영일자가 주문일과 상이합니다"로 거부된 적이 있다.
     * 개장일 판정은 KIS에 묻되, 조회가 실패하면 보내지 않는 쪽으로 막는다.
     */
    try {
      if (!(await isDomesticMarketOpenDay())) {
        violations.push('오늘은 국내 증시 휴장일입니다.');
      }
    } catch {
      violations.push('개장일을 확인할 수 없어 주문을 보류합니다.');
    }
  }

  const usage = await getTodayUsage(input.accountId);
  if (usage.count + 1 > rules.dailyOrderCountLimit) {
    violations.push(`일일 주문 건수 한도 ${rules.dailyOrderCountLimit}건을 초과합니다 (오늘 ${usage.count}건).`);
  }
  if (usage.notional + notional > rules.dailyNotionalLimit) {
    violations.push(
      `일일 주문 금액 한도 ${rules.dailyNotionalLimit.toLocaleString('ko-KR')}원을 초과합니다 ` +
        `(오늘 ${usage.notional.toLocaleString('ko-KR')}원).`,
    );
  }

  return { allowed: violations.length === 0, violations, rules, todayOrderCount: usage.count, todayNotional: usage.notional };
}
