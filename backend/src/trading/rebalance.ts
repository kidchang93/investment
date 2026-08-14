/**
 * 목표 비중으로 되돌리는 계획을 만든다. **순수 계산이라 DB도 KIS도 부르지 않는다.**
 *
 * ── 왜 필요한가 (2026-08-14) ─────────────────────────────────────────────
 *
 * 단기 30% 자리를 ETF로 채우는 매수를 집행하다 **같은 주문이 두 번 체결됐다.**
 * KIS 모의 서버가 느려져 요청이 타임아웃됐는데 서버는 큐에 두고 계속 처리했고,
 * DB에 기록이 없는 것을 보고 "안 나갔다"고 판단해 재전송한 것이다. 결과:
 *
 *   329200 리츠      목표 23.1% → 실제 25.7%   (+1,693주 초과)
 *   161510 고배당주  목표 17.0% → 실제 18.8%   (+195주 초과)
 *   069500 KODEX200  목표 19.9% → 실제 10.9%   (한 주도 못 삼)
 *   411060 금현물    목표 15.0% → 실제  7.2%   (한 주도 못 삼)
 *
 * 되돌리려면 매도와 매수를 섞어 여러 건을 내야 하는데, **같은 사고가 나면 더
 * 망가진다.** 그래서 계획을 값으로 만들고(이 모듈), 집행은 멱등 키를 붙여
 * 재시도해도 안전하게 한다(`scripts/rebalance.ts`).
 *
 * ★ 계획을 눈으로 확인한 뒤 집행하도록 둘을 갈랐다. 계산이 순수하면 시험이
 * 네트워크 없이 돌고, 무엇을 팔고 살지 미리 볼 수 있다.
 */

/** 한 종목의 목표 비중. **ETF 묶음 안에서의 비중**이지 총자산 대비가 아니다 */
export interface RebalanceTarget {
  symbol: string;
  /** 0~1 */
  weight: number;
}

export interface RebalanceHolding {
  symbol: string;
  name: string;
  quantity: number;
  /** 현재가(원). 없으면 그 종목은 계획에서 빠지고 사유가 남는다 */
  price: number | null;
}

export interface RebalanceLeg {
  symbol: string;
  name: string;
  side: 'buy' | 'sell';
  quantity: number;
  /** 지정가(원) */
  limitPrice: number;
  /** `quantity × limitPrice` */
  amount: number;
  /** 지금 비중 → 목표 비중 (0~1) */
  fromWeight: number;
  toWeight: number;
}

export interface RebalancePlanInput {
  holdings: RebalanceHolding[];
  targets: RebalanceTarget[];
  /** 쓸 수 있는 현금(원). **D+2 정산액을 넣는다** — D+0은 오늘 산 것이 안 빠져 있다 */
  cash: number;
  /** 총자산 중 ETF 묶음이 차지할 비중(0~1) */
  bucketWeight: number;
  /**
   * 지정가를 현재가에서 얼마나 띄울까(0~1). 매수는 위로, 매도는 아래로.
   * ETF 호가단위는 값과 무관하게 5원 고정이라 그 배수로 떨어뜨린다.
   */
  slipRate: number;
  /** 이만큼 미만이면 건드리지 않는다(원). 잔돈 매매를 막는다 */
  minLegAmount: number;
}

export interface RebalancePlan {
  legs: RebalanceLeg[];
  /** 총자산(현금 + 보유 평가액) */
  totalAssets: number;
  /** ETF 묶음의 목표 금액 */
  bucketTarget: number;
  /** 지금 묶음 금액 */
  bucketNow: number;
  sellAmount: number;
  buyAmount: number;
  /** 집행 뒤 남을 현금(어림). 매도 대금은 D+2라 **당일 매수에 못 쓴다** */
  cashAfter: number;
  /** 계획에서 빠진 것과 사유. 조용히 버리지 않는다 */
  skipped: Array<{ symbol: string; reason: string }>;
}

/** 호가단위 5원에 맞춘 지정가. 매수는 올리고 매도는 내려 체결을 우선한다. */
export function limitPriceFor(price: number, side: 'buy' | 'sell', slipRate: number): number {
  const raw = side === 'buy' ? price * (1 + slipRate) : price * (1 - slipRate);
  const ticks = side === 'buy' ? Math.ceil(raw / 5) : Math.floor(raw / 5);
  return Math.max(5, ticks * 5);
}

/**
 * 목표 비중과의 차이를 매매 다리로 옮긴다.
 *
 * ★ **매도 대금은 당일 매수에 못 쓴다**(국내 주식 D+2). `cashAfter`는 그 사실을
 * 반영하지 않은 어림값이라, 매수 총액이 `cash`를 넘지 않는지는 부른 쪽이 본다.
 */
export function planRebalance(input: RebalancePlanInput): RebalancePlan {
  const { holdings, targets, cash, bucketWeight, slipRate, minLegAmount } = input;
  const skipped: Array<{ symbol: string; reason: string }> = [];

  const priced = holdings.filter((h) => {
    if (h.price !== null && h.price > 0) return true;
    // 현재가가 없으면 평가액을 지어낼 수 없다. 총자산에서도 빼면 비중이 왜곡되므로
    // 계획에서만 빼고 사실을 남긴다.
    skipped.push({ symbol: h.symbol, reason: '현재가를 못 받아 계획에서 뺐다' });
    return false;
  });

  const valueOf = (h: RebalanceHolding): number => h.quantity * (h.price ?? 0);
  const bucketNow = priced.reduce((sum, h) => sum + valueOf(h), 0);
  const totalAssets = bucketNow + cash;
  const bucketTarget = totalAssets * bucketWeight;

  const weightBySymbol = new Map(targets.map((t) => [t.symbol, t.weight]));
  const legs: RebalanceLeg[] = [];

  for (const h of priced) {
    const weight = weightBySymbol.get(h.symbol);
    if (weight === undefined) {
      skipped.push({ symbol: h.symbol, reason: '목표 비중에 없는 종목이라 건드리지 않았다' });
      continue;
    }
    const price = h.price as number;
    const now = valueOf(h);
    const target = bucketTarget * weight;
    const gap = target - now;
    const side: 'buy' | 'sell' = gap >= 0 ? 'buy' : 'sell';
    const limitPrice = limitPriceFor(price, side, slipRate);
    // 수량은 **현재가**로 낸다. 지정가로 내면 슬립만큼 목표를 넘거나 못 미친다.
    let quantity = Math.floor(Math.abs(gap) / price);
    if (side === 'sell') quantity = Math.min(quantity, h.quantity);
    const amount = quantity * limitPrice;
    if (quantity <= 0 || amount < minLegAmount) {
      if (Math.abs(gap) >= 1) {
        skipped.push({
          symbol: h.symbol,
          reason: `차이 ${Math.round(Math.abs(gap)).toLocaleString('ko-KR')}원이 문턱보다 작다`,
        });
      }
      continue;
    }
    legs.push({
      symbol: h.symbol,
      name: h.name,
      side,
      quantity,
      limitPrice,
      amount,
      fromWeight: bucketTarget > 0 ? now / totalAssets : 0,
      toWeight: totalAssets > 0 ? (now + (side === 'buy' ? 1 : -1) * quantity * price) / totalAssets : 0,
    });
  }

  // 매도를 먼저 둔다 — 자리를 비우고 채우는 순서가 사람이 읽기에도 자연스럽다.
  legs.sort((a, b) => (a.side === b.side ? b.amount - a.amount : a.side === 'sell' ? -1 : 1));

  const sellAmount = legs.filter((l) => l.side === 'sell').reduce((s, l) => s + l.amount, 0);
  const buyAmount = legs.filter((l) => l.side === 'buy').reduce((s, l) => s + l.amount, 0);

  return {
    legs,
    totalAssets,
    bucketTarget,
    bucketNow,
    sellAmount,
    buyAmount,
    cashAfter: cash + sellAmount - buyAmount,
    skipped,
  };
}
