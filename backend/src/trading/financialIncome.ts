/**
 * **올해 금융소득이 얼마인가** — 연 2천만원 종합과세 문턱까지 얼마 남았나.
 *
 * ── 왜 생겼나 (2026-09-21) ───────────────────────────────────────────────
 *
 * 사용자가 물었다 — *"그런 제도들을 교묘히 이용해서 차익 실현하면 되지않을까?"*
 * 합법적인 답 하나가 **연도별 분할 실현**이다. 기타형 ETF(보유기간과세)는 20년치
 * 차익이 판 해 한 번에 배당소득으로 잡혀, 그해 금융소득이 2천만원을 넘으면 넘는 몫이
 * 다른 소득과 합산돼 누진된다. 해마다 문턱 안쪽으로 나눠 실현하면 피한다. 그러려면
 * **올해 이미 얼마를 썼나**를 알아야 한다.
 *
 * ── 무엇을 세나 ──────────────────────────────────────────────────────────
 *
 * - **배당·분배금** — 주식·ETF 가리지 않고 전부 금융소득이다
 * - **기타형 ETF 매도 차익** — `Min(매매차익, 과표증분)`. 과표증분을 갖고 있지 않아
 *   매매차익으로 센다(상한). **매도 건별로** 세고 손실 건은 0이다 — 일반계좌의 배당소득은
 *   손익통산이 안 된다(금융투자소득세가 2024-12-10에 폐지돼 통산 제도가 없다).
 *   ★ ISA 안에서는 통산된다 — 이 말은 일반계좌에서만 맞다
 * - 국내주식형 ETF·개별 주식의 매매차익은 **세지 않는다** — 비과세다(대주주 아님)
 *
 * ⚠⚠ **일반계좌만 센다.** ISA 소득은 종합소득에 합산하지 않고(조특법 §91의18①), 연금계좌
 *    운용수익은 인출할 때 연금·기타소득이 된다(소득세법 §20의3). **둘 다 2천만원 문턱에 넣으면
 *    안 된다** — 계좌 구분 없이 세면 문턱까지의 여유를 실제보다 작게 본다. 지금 원장은 일반계좌
 *    하나(`VTS-ORDINARY`)라 맞다. 연금·ISA를 붙이면 계좌로 거른다(2026-09-21 확인).
 *
 * ⚠ **추정이다.** 진짜 금융소득은 증권사가 연말에 주는 원천징수 내역이다. 이 계산은
 *   층 원장(`trading_layer_trades`)으로 재구성한 것이라 원장에 없는 체결(층 모르는 옛
 *   82건 등)은 빠진다. "문턱까지 여유가 있나"를 가늠하는 데 쓰고, 연말 실현 결정 전에는
 *   증권사 내역으로 확인한다.
 */
import type { DividendRecord } from '@invest/shared';
import type { EtfTaxType } from './longHold.js';

/** 금융소득종합과세 문턱 (2026-09-21 확인 — 국세청·투자설명서) */
export const FINANCIAL_INCOME_THRESHOLD = 20_000_000;

export interface IncomeTrade {
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  /** 매도 건의 실현손익(원). 매수 건은 `null` */
  realizedPnl: number | null;
  /** 체결일 `YYYYMMDD` (KST) */
  tradedOn: string;
}

/** `YYYYMMDD`에서 days일 뺀 날 */
function ymdMinus(ymd: string, days: number): string {
  const t = Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)));
  return new Date(t - days * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * 배당기준일에 주주명부에 오른 수량.
 *
 * ★ 결제가 T+2라 **기준일 2일 전까지** 체결된 것이 기준일에 잡힌다. 여기서는 달력으로
 *   2일을 뺀다 — 영업일로 세야 맞으므로 **기준일 앞에 주말·휴일이 끼면 하루이틀 틀린다.**
 *   그 경계에 체결이 걸리는 일은 드물어 근사로 둔다.
 *   ponytail: 달력 2일 근사, 경계 체결이 잦아지면 개장일 달력으로 센다.
 */
export function sharesOnRecordDate(trades: IncomeTrade[], symbol: string, recordDate: string): number {
  const cutoff = ymdMinus(recordDate, 2);
  let held = 0;
  for (const t of trades) {
    if (t.symbol !== symbol || t.tradedOn > cutoff) continue;
    held += t.side === 'buy' ? t.quantity : -t.quantity;
  }
  return Math.max(0, held);
}

export interface DividendIncomeRow {
  symbol: string;
  recordDate: string;
  shares: number;
  amount: number;
}

/**
 * year년에 **지급된** 배당 × 기준일에 들고 있던 수량.
 *
 * ★ **어느 해 소득인지는 지급일로 가른다.** 과세 귀속이 지급일 기준이라 12월 말 기준일·
 *   이듬해 4월 지급인 결산배당은 이듬해 소득이다. **받을 자격은 기준일로 가른다** —
 *   그날 들고 있어야 받는다. 지급일이 비어 있으면(아직 안 정해짐) 기준일로 대신한다.
 */
export function dividendIncomeForYear(
  trades: IncomeTrade[],
  dividends: DividendRecord[],
  year: number,
  asOf: string,
): { total: number; rows: DividendIncomeRow[] } {
  const rows: DividendIncomeRow[] = [];
  for (const d of dividends) {
    const payYmd = d.payDate.replace(/\//g, '') || d.recordDate;
    if (payYmd.slice(0, 4) !== String(year) || payYmd > asOf) continue;
    const shares = sharesOnRecordDate(trades, d.symbol, d.recordDate);
    if (shares <= 0) continue;
    rows.push({ symbol: d.symbol, recordDate: d.recordDate, shares, amount: shares * d.amountPerShare });
  }
  return { total: rows.reduce((s, r) => s + r.amount, 0), rows };
}

/**
 * year년에 판 기타형 ETF의 과세 차익.
 *
 * @returns `taxable` 확인된 기타형의 과세 차익 · `unknown` 과세유형을 모르는 ETF의 차익
 *   (금융소득인지 모른다 — 합계에 넣지 않고 따로 보인다)
 */
export function etfGainsForYear(
  trades: IncomeTrade[],
  taxTypeOf: (symbol: string) => EtfTaxType | undefined,
  isEtf: (symbol: string) => boolean,
  year: number,
): { taxable: number; unknown: number } {
  let taxable = 0;
  let unknown = 0;
  for (const t of trades) {
    if (t.side !== 'sell' || t.tradedOn.slice(0, 4) !== String(year)) continue;
    // 손실 건은 0이다 — 배당소득은 건끼리 통산하지 않는다.
    const gain = Math.max(0, t.realizedPnl ?? 0);
    if (gain === 0 || !isEtf(t.symbol)) continue;
    const type = taxTypeOf(t.symbol);
    if (type === 'holdingPeriod') taxable += gain;
    else if (type === undefined) unknown += gain;
  }
  return { taxable, unknown };
}
