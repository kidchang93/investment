/**
 * 매수 신호가 난 종목의 재무를 확인한다.
 *
 * 후보를 미리 거르지 않고 **신호가 난 뒤 그 종목 하나만** 본다. 재무 조회는
 * 종목당 KIS 호출 3회라, 후보 24종목을 미리 확인하면 72회가 더 나간다.
 * 실측(2026-07-27)에서 그렇게 걸러지는 건 순손실 1종목뿐이었다 — 호출 대비
 * 값이 안 맞는다. 신호가 난 종목만 보면 3회로 끝나고, 그 값이 그대로
 * "왜 이 종목인지" 근거가 된다.
 *
 * **매도는 확인하지 않는다.** 재무가 나쁘다고 팔지 못하게 하면 손실이 난
 * 종목에 갇힌다. 정정·취소를 리스크 룰로 막지 않는 것과 같은 이유다.
 */

import type { FinancialSnapshot, Instrument } from '@invest/shared';

import { getFinancials } from '../kis/rest.js';

export interface FundamentalsVerdict {
  allowed: boolean;
  /** 막혔으면 사유. 통과했으면 undefined */
  reason?: string;
  /** 판단에 쓴 값. 근거 기록에 그대로 남긴다 */
  snapshot?: FinancialSnapshot;
  /** 실행 기록에 적을 한 줄. 통과·차단 모두 남긴다 */
  note: string;
}

/**
 * 사람이 읽을 한 줄로 만든다. 값이 없는 지표는 적지 않는다 —
 * `ROE -` 같은 빈칸을 늘어놓으면 무엇을 보고 판단했는지 흐려진다.
 */
function describe(snapshot: FinancialSnapshot): string {
  const parts: string[] = [`${snapshot.period} 기준`];
  if (snapshot.roe !== undefined) parts.push(`ROE ${snapshot.roe}%`);
  if (snapshot.netMargin !== undefined) parts.push(`순이익률 ${snapshot.netMargin}%`);
  if (snapshot.debtRatio !== undefined) parts.push(`부채비율 ${snapshot.debtRatio}%`);
  if (snapshot.revenueGrowth !== undefined) parts.push(`매출성장 ${snapshot.revenueGrowth}%`);
  return parts.join(' · ');
}

export async function checkBuyFundamentals(instrument: Instrument): Promise<FundamentalsVerdict> {
  /*
   * ETF·ETN은 재무제표가 없다. 없는 것을 나쁜 것으로 읽으면 지금 유니버스의
   * 절반(28종목 중 14종목)이 통째로 빠진다.
   */
  if (instrument.assetType !== 'stock') {
    return { allowed: true, note: `재무 확인 건너뜀 · ${instrument.assetType.toUpperCase()}는 재무제표가 없습니다` };
  }

  let rows: FinancialSnapshot[];
  try {
    rows = await getFinancials(instrument.providerSymbol, 1);
  } catch (err) {
    /*
     * 못 받은 것을 "재무가 나쁘다"로 읽지 않는다. 다만 확인하지 못했다는
     * 사실은 기록에 남긴다 — 조용히 통과시키면 나중에 왜 샀는지 알 수 없다.
     */
    return { allowed: true, note: `재무를 확인하지 못했습니다 (${String(err).slice(0, 60)})` };
  }

  const snapshot = rows[0];
  if (!snapshot) return { allowed: true, note: '재무 데이터가 없습니다' };

  /*
   * 막는 기준은 순손실 하나뿐이다.
   *
   * 부채비율은 쓰지 않는다 — 588%는 보험사고 그 업종에서는 정상이다. 업종
   * 정보 없이 이 지표로 거르면 금융·건설이 통째로 빠진다.
   * ROE 0.00도 쓰지 않는다 — 진짜 0인지 계산이 안 된 것인지 구별되지 않는다
   * (덕양에너젠·한화손해보험이 ROE 0인데 순이익률은 플러스였다).
   */
  if (snapshot.netMargin !== undefined && snapshot.netMargin < 0) {
    return {
      allowed: false,
      reason: `최근 분기 순손실 (순이익률 ${snapshot.netMargin}%)`,
      snapshot,
      note: describe(snapshot),
    };
  }

  return { allowed: true, snapshot, note: describe(snapshot) };
}
