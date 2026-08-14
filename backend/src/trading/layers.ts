/**
 * 3층 장부. **어느 층이 돈을 벌고 어느 층이 까먹는지 가른다.**
 *
 * ── 왜 필요한가 (2026-08-14) ─────────────────────────────────────────────
 *
 * 목표를 "3층으로 연 15~20%"로 잡았는데, 지금은 **계좌 전체 손익만 보인다.**
 * 오늘 평가손익 +1,073,430원 중 **+1,053,255원(98%)이 KODEX 200 하나**였다는
 * 것도 손으로 세어서 알았다. 이 상태로는 물을 수가 없다:
 *
 *   - 단기 층이 정말 버는가, ETF가 번 것을 까먹는가
 *   - 유망주 층에 20%를 두는 것이 값어치가 있는가
 *   - 비중을 어느 쪽으로 옮겨야 하는가
 *
 * 답을 모르면 비중을 고칠 근거도 없다. 그래서 **매매마다 층을 적고 층별로 센다.**
 *
 * ── ★ KIS 잔고는 층을 모른다 ────────────────────────────────────────────
 *
 * 같은 종목을 ETF 층에서도 사고 단기 층에서도 살 수 있는데, 증권사 잔고는
 * 합쳐진 수량 하나뿐이다. 그래서 **층은 우리 장부가 기억하고, 합계가 잔고와
 * 맞는지 대조한다.** 어긋나면 그 사실을 말한다 — 오늘 중복 체결도 잔고 대조로
 * 잡았다.
 *
 * ── 평균원가법 ───────────────────────────────────────────────────────────
 *
 * 매수는 수량과 원가를 더하고, 매도는 **그 시점 평균원가**로 실현손익을 낸다.
 * 선입선출(FIFO)이 아니라 평균원가인 이유는 국내 증권사 잔고 표시와 같은
 * 방식이라 대조가 쉽기 때문이다.
 */

/** 3층. 값은 DB에 그대로 들어가므로 바꾸면 기록이 갈린다 */
export type Layer = 'etf' | 'short' | 'bet';

export const LAYER_LABELS: Record<Layer, string> = {
  etf: 'ETF',
  short: '단기',
  bet: '유망주',
};

/** 층이 노리는 비중(총자산 대비)과 그 근거 */
export const LAYER_TARGETS: Record<Layer, { weight: number; rationale: string }> = {
  etf: {
    weight: 0.50,
    rationale: '시장 노출. 알파를 주장하지 않는다 — 21.4년 실측 연 12.12%',
  },
  short: {
    weight: 0.30,
    rationale: '1~2주 보유, +10% 익절/−5% 손절. 손익비 2:1이라 승률 34%면 본전',
  },
  bet: {
    weight: 0.20,
    rationale: '자유 베팅. 강한 증명을 요구하므로 자주 0원이다',
  },
};

export interface LayerPosition {
  layer: Layer;
  symbol: string;
  quantity: number;
  /** 남은 수량의 취득원가 합(원). `quantity`가 0이면 0이어야 한다 */
  cost: number;
}

export interface LayerTrade {
  layer: Layer;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  /** 체결가(원) */
  price: number;
  /** 수수료·세금 합(원). 모르면 0 */
  fee: number;
}

export interface ApplyResult {
  position: LayerPosition;
  /** 매도일 때만 값이 있다. 매수는 실현이 없다 */
  realizedPnl: number | null;
  /** 못 팔아 남은 수량. 장부보다 많이 팔라고 하면 여기 남는다 */
  shortfall: number;
}

/** 평균단가. 수량이 0이면 0을 준다 — 나누기를 부르는 쪽에 맡기지 않는다 */
export function averageCost(position: LayerPosition): number {
  return position.quantity > 0 ? position.cost / position.quantity : 0;
}

/**
 * 한 체결을 장부에 반영한다. **순수 함수라 DB 없이 시험한다.**
 *
 * ★ **장부에 없는 수량은 팔지 않는다.** 더 팔라고 하면 있는 만큼만 팔고
 * 나머지를 `shortfall`로 돌려준다 — 조용히 음수 수량을 만들면 그 층의
 * 원가가 망가지고 이후 모든 손익이 거짓이 된다.
 */
export function applyTrade(position: LayerPosition, trade: LayerTrade): ApplyResult {
  if (trade.layer !== position.layer || trade.symbol !== position.symbol) {
    throw new Error('다른 층·종목의 체결을 이 자리에 반영할 수 없습니다');
  }
  if (!(trade.quantity > 0)) throw new Error('체결 수량은 0보다 커야 합니다');

  if (trade.side === 'buy') {
    return {
      position: {
        ...position,
        quantity: position.quantity + trade.quantity,
        // 수수료는 취득원가에 얹는다. 그래야 "얼마를 써서 얼마가 됐나"가 맞는다.
        cost: position.cost + trade.quantity * trade.price + trade.fee,
      },
      realizedPnl: null,
      shortfall: 0,
    };
  }

  const sellable = Math.min(trade.quantity, position.quantity);
  const shortfall = trade.quantity - sellable;
  if (sellable === 0) {
    return { position, realizedPnl: 0, shortfall };
  }
  const unitCost = averageCost(position);
  const proceeds = sellable * trade.price - trade.fee;
  const realizedPnl = proceeds - sellable * unitCost;
  const remaining = position.quantity - sellable;
  return {
    position: {
      ...position,
      quantity: remaining,
      // 수량이 0이면 원가도 0이다. 부동소수 찌꺼기를 남기지 않는다.
      cost: remaining > 0 ? position.cost - sellable * unitCost : 0,
    },
    realizedPnl,
    shortfall,
  };
}

export interface LayerSummary {
  layer: Layer;
  /** 지금 들고 있는 것의 취득원가 합 */
  cost: number;
  /** 지금 평가액(현재가 × 수량) */
  marketValue: number;
  /** 평가손익 */
  unrealizedPnl: number;
  /** 누적 실현손익 */
  realizedPnl: number;
  /** 실현 + 평가 */
  totalPnl: number;
  /** 총자산 대비 비중(0~1) */
  weight: number;
  targetWeight: number;
  symbols: number;
}

/**
 * 층별로 센다. **현재가를 못 받은 종목은 평가액에서 빼고 세어 돌려준다** —
 * 0으로 채우면 그 층이 통째로 손실난 것처럼 보인다.
 */
export function summarizeLayers(
  positions: LayerPosition[],
  prices: Map<string, number>,
  realizedByLayer: Map<Layer, number>,
  cash: number,
): { summaries: LayerSummary[]; unpriced: string[]; totalAssets: number } {
  const unpriced: string[] = [];
  const byLayer = new Map<Layer, LayerSummary>();
  for (const layer of Object.keys(LAYER_TARGETS) as Layer[]) {
    byLayer.set(layer, {
      layer,
      cost: 0,
      marketValue: 0,
      unrealizedPnl: 0,
      realizedPnl: realizedByLayer.get(layer) ?? 0,
      totalPnl: 0,
      weight: 0,
      targetWeight: LAYER_TARGETS[layer].weight,
      symbols: 0,
    });
  }

  for (const p of positions) {
    if (p.quantity <= 0) continue;
    const summary = byLayer.get(p.layer);
    if (!summary) continue;
    const price = prices.get(p.symbol);
    summary.cost += p.cost;
    summary.symbols += 1;
    if (price === undefined || !(price > 0)) {
      unpriced.push(`${p.layer}:${p.symbol}`);
      continue;
    }
    summary.marketValue += p.quantity * price;
  }

  let invested = 0;
  for (const s of byLayer.values()) {
    s.unrealizedPnl = s.marketValue - s.cost;
    s.totalPnl = s.unrealizedPnl + s.realizedPnl;
    invested += s.marketValue;
  }
  const totalAssets = invested + cash;
  for (const s of byLayer.values()) {
    s.weight = totalAssets > 0 ? s.marketValue / totalAssets : 0;
  }

  return {
    summaries: [...byLayer.values()],
    unpriced,
    totalAssets,
  };
}

/**
 * 장부 합계가 증권사 잔고와 맞나. **어긋나면 그 사실이 값으로 남아야 한다.**
 *
 * 2026-08-14에 같은 주문이 두 번 체결됐을 때, 그것을 잡은 것이 잔고 대조였다.
 * 장부만 믿으면 그 사고가 조용히 지나간다.
 */
export interface LedgerMismatch {
  symbol: string;
  /** 우리 장부의 층별 합계 */
  ledger: number;
  /** 증권사가 말하는 수량 */
  broker: number;
}

export function reconcile(
  positions: LayerPosition[],
  brokerQuantities: Map<string, number>,
): LedgerMismatch[] {
  const ledger = new Map<string, number>();
  for (const p of positions) {
    if (p.quantity <= 0) continue;
    ledger.set(p.symbol, (ledger.get(p.symbol) ?? 0) + p.quantity);
  }
  const symbols = new Set([...ledger.keys(), ...brokerQuantities.keys()]);
  const mismatches: LedgerMismatch[] = [];
  for (const symbol of [...symbols].sort()) {
    const ours = ledger.get(symbol) ?? 0;
    const theirs = brokerQuantities.get(symbol) ?? 0;
    if (Math.abs(ours - theirs) > 1e-9) {
      mismatches.push({ symbol, ledger: ours, broker: theirs });
    }
  }
  return mismatches;
}
