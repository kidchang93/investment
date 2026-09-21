/**
 * **올해 금융소득 — 2천만원 문턱까지 얼마 남았나**, 그리고 기타형 ETF를 올해 얼마까지
 * 실현해도 되나.
 *
 * 사용자가 물었다 (2026-09-21) — *"그런 제도들을 교묘히 이용해서 차익 실현하면
 * 되지않을까?"* 합법적인 답 하나가 **연도별 분할 실현**이다. 계산은 `trading/financialIncome.ts`.
 *
 * ★ **한 달에 한 번만 알린다.** 스케줄러가 매일 부르지만 이번 달 하트비트가 있으면
 *   비킨다(`--force`로 무시). **12월은 결정의 달이다** — 1월 1일에 한도가 새로 차므로,
 *   올해 여유 안에서 차익을 실현할지 이번 달에 정해야 한다.
 *
 * ⚠ 추정이다. 진짜 값은 증권사 원천징수 내역이다. 층 원장에 없는 체결은 빠진다.
 *
 * 쓰는 법:  cd backend && npx tsx src/scripts/financialIncome.ts [계좌id] [--force] [--notify]
 */
import { getKisAccount } from '../config.js';
import { pool } from '../db/client.js';
import { getDomesticInstrumentsBySymbols } from '../db/instruments.js';
import { getKisDividendSchedule, getKisDomesticAccountSnapshot } from '../kis/rest.js';
import { kstToday } from '../kis/normalize.js';
import { sendSlack } from '../notify/slack.js';
import {
  dividendIncomeForYear, etfGainsForYear, FINANCIAL_INCOME_THRESHOLD, type IncomeTrade,
} from '../trading/financialIncome.js';
import { CONFIRMED_ETF_TAX } from '../trading/longHold.js';
import type { DividendRecord } from '@invest/shared';

const args = process.argv.slice(2);
const accountId = args.find((a) => !a.startsWith('--')) ?? 'VTS-ORDINARY';
const force = args.includes('--force');
const notify = args.includes('--notify');
const account = getKisAccount(accountId);
if (!account) {
  console.error(`등록된 계좌가 아닙니다: ${accountId}`);
  process.exit(1);
}

const today = kstToday();
const year = Number(today.slice(0, 4));
const month = today.slice(4, 6);
const HEARTBEAT = `financial-income-${today.slice(0, 6)}`;

if (!force) {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM trading_heartbeats WHERE name = $1 AND status = 'ok'`,
    [HEARTBEAT],
  );
  if (Number(rows[0]?.n ?? 0) > 0) {
    console.log('이번 달 금융소득 점검은 이미 했다 — 비킨다 (--force로 무시)');
    process.exit(0);
  }
}

// ── 원장 ────────────────────────────────────────────────────────────────
/*
 * ★ **올해 것만 읽지 않는다.** 1월 기준일 배당을 받았는지는 작년 12월에 산 수량에
 *   달려 있다 — 기준일 수량은 그 전 체결을 전부 누적해야 나온다.
 */
const { rows: raw } = await pool.query<{
  symbol: string; side: string; quantity: string; realized_pnl: string | null; traded_on: string;
}>(
  `SELECT symbol, side, quantity::text, realized_pnl::text,
          to_char(traded_at AT TIME ZONE 'Asia/Seoul', 'YYYYMMDD') AS traded_on
     FROM trading_layer_trades WHERE account_id = $1 ORDER BY traded_at`,
  [accountId],
);
const trades: IncomeTrade[] = raw
  .filter((r) => r.side === 'buy' || r.side === 'sell')
  .map((r) => ({
    symbol: r.symbol,
    side: r.side as 'buy' | 'sell',
    quantity: Number(r.quantity),
    realizedPnl: r.realized_pnl === null ? null : Number(r.realized_pnl),
    tradedOn: r.traded_on,
  }));

const snapshot = await getKisDomesticAccountSnapshot(account);
const symbols = [...new Set([...trades.map((t) => t.symbol), ...snapshot.positions.map((p) => p.symbol)])];
const instruments = await getDomesticInstrumentsBySymbols(symbols);
const isEtf = (s: string): boolean => instruments.get(s)?.assetType === 'etf';
const taxTypeOf = (s: string) => CONFIRMED_ETF_TAX[s]?.type;
const nameOf = (s: string): string => instruments.get(s)?.name ?? s;

// ── 배당 ────────────────────────────────────────────────────────────────
const dividends: DividendRecord[] = [];
// 작년 10월부터 — 작년 말 기준일·올해 지급인 결산배당을 놓치지 않게
const fetchDiv = (s: string) => getKisDividendSchedule(account!, s, `${year - 1}1001`, today).catch(() => null);
let missed: string[] = [];
for (const s of symbols) {
  const got = await fetchDiv(s);
  if (got === null) missed.push(s);
  else dividends.push(...got);
}
/*
 * ★ **못 받은 종목은 끝에서 한 번 더 묻는다.** 모의 서버는 초당 1건이라 장중에는
 *   손절 감시·분석가 루프와 유량이 겹친다. 2026-09-21 첫 실행에서 PLUS 고배당주가
 *   그렇게 빠져 배당 53,354원이 합계에서 사라졌다 — 혼자 다시 부르니 매번 11건이 왔다.
 * ⚠ **빈 응답은 다시 묻지 않는다.** 개별 주식 대부분이 정상적으로 빈 결과라 호출이
 *   두 배가 된다. 그래서 빈 응답으로 빠진 배당은 여기서 못 잡는다(`kis/rest.ts` 주석).
 */
if (missed.length > 0) {
  await new Promise((r) => setTimeout(r, 1500));
  const still: string[] = [];
  for (const s of missed) {
    const got = await fetchDiv(s);
    if (got === null) still.push(s);
    else dividends.push(...got);
  }
  missed = still;
}
const div = dividendIncomeForYear(trades, dividends, year, today);
const gains = etfGainsForYear(trades, taxTypeOf, isEtf, year);
const total = div.total + gains.taxable;
const headroom = FINANCIAL_INCOME_THRESHOLD - total;

// ── 기타형 보유 — 지금 팔면 금융소득이 되는 것 ───────────────────────────
const holdingPeriodHeld = snapshot.positions
  .filter((p) => taxTypeOf(p.symbol) === 'holdingPeriod')
  .map((p) => ({ name: nameOf(p.symbol), unrealized: p.unrealizedPnl ?? 0 }));
const unrealizedGain = holdingPeriodHeld.reduce((s, h) => s + Math.max(0, h.unrealized), 0);

// ── 출력 ────────────────────────────────────────────────────────────────
const won = (n: number): string => `${Math.round(n).toLocaleString('ko-KR')}원`;
const lines: string[] = [];
lines.push(`${year}년 금융소득 (1/1 ~ ${today.slice(4, 6)}/${today.slice(6)}) · ${accountId} · 추정`);
lines.push(`  배당·분배금       ${won(div.total).padStart(14)}  (${div.rows.length}건, 기준일 보유 수량 × 주당 배당)`);
lines.push(`  기타형 ETF 차익   ${won(gains.taxable).padStart(14)}  (매도 건별, 손실은 0 — 통산 없음)`);
lines.push(`  ─────────────────────────────`);
lines.push(`  합계              ${won(total).padStart(14)}  / 문턱 ${won(FINANCIAL_INCOME_THRESHOLD)}`);
lines.push(`  ${headroom >= 0 ? '남은 여유' : '★ 넘었다'}         ${won(Math.abs(headroom)).padStart(14)}`);
/* 합계만 보이면 검산이 안 된다 — 첫 실행에서 1건 71,346원이 무엇인지 원장을 따로 뒤져야 했다. */
for (const r of div.rows) {
  lines.push(`    ${nameOf(r.symbol)} ${r.recordDate} 기준 ${r.shares.toLocaleString('ko-KR')}주 → ${won(r.amount)}`);
}
if (gains.unknown > 0) {
  lines.push(`  ※ 과세유형을 모르는 ETF 차익 ${won(gains.unknown)}은 합계에 넣지 않았습니다 — 기타형이면 금융소득입니다`);
}
if (missed.length > 0) {
  lines.push(`  ※ 배당을 못 받은 ${missed.length}종목: ${missed.map(nameOf).join(' · ')} — 합계가 적게 나왔을 수 있습니다`);
}

lines.push('');
if (holdingPeriodHeld.length === 0) {
  lines.push('기타형(보유기간과세) ETF를 들고 있지 않다 — 판 해에 몰릴 차익이 없다.');
} else {
  lines.push('기타형 보유 — 지금 팔면 그 차익이 올해 금융소득이 된다:');
  for (const h of holdingPeriodHeld) lines.push(`  ${h.name} 평가손익 ${h.unrealized >= 0 ? '+' : ''}${won(h.unrealized)}`);
  if (unrealizedGain === 0) {
    lines.push('  → 지금은 평가차익이 없다. 실현해도 금융소득이 늘지 않는다.');
  } else if (unrealizedGain <= headroom) {
    lines.push(`  → 차익 ${won(unrealizedGain)}이 올해 여유 ${won(headroom)} 안이다. 올해 실현해도 종합과세가 없다.`);
  } else {
    lines.push(`  → 차익 ${won(unrealizedGain)}이 올해 여유 ${won(Math.max(0, headroom))}를 넘는다. 여유만큼만 실현하고 나머지는 내년으로 넘기면 피한다.`);
  }
}
/*
 * ★ 12월은 결정의 달이다. 1월 1일에 문턱이 새로 차므로, 올해 여유를 쓰지 않고 넘기면
 *   그 여유는 사라진다. 기타형 차익이 쌓여 있는데 여유가 남았으면 이번 달이 기회다.
 */
if (month === '12' && unrealizedGain > 0 && headroom > 0) {
  lines.push('');
  lines.push(`★★ 12월입니다 — 올해 여유 ${won(headroom)}는 1월 1일에 사라집니다. 기타형 차익을 그 안에서 실현할지 이번 달에 정하세요.`);
}
lines.push('');
lines.push('⚠ 추정입니다. 실현 결정 전에는 증권사 원천징수 내역으로 확인하세요. 누진세율은 다른 소득에 달려 있습니다.');

const text = lines.join('\n');
console.log(`\n${text}`);

if (notify) {
  await sendSlack(`*금융소득 점검* (${today})\n\`\`\`\n${text}\n\`\`\``).catch(() => false);
}
await pool.query(
  `INSERT INTO trading_heartbeats (name, status, note) VALUES ($1, 'ok', $2)`,
  [HEARTBEAT, `합계 ${Math.round(total)} · 여유 ${Math.round(headroom)}`],
);
process.exit(0);
