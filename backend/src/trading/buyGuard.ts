/**
 * **분석가 제안서를 집행기가 그대로 내도 되는가** — 매수 수량을 한도 안으로 줄이거나 막는다.
 *
 * ── 왜 생겼나 (2026-09-15) ───────────────────────────────────────────────
 *
 * 사용자가 빠른 회차에서 판단자(Claude)를 뺐다 — *"분석가는 집행을 위해 분석해주면
 * 될 것 같고 판단자는 집행만 하면 될 것 같아."* 그런데 층 50%·종목 10%·위험 2%·
 * 매수여력은 **판단자가 프롬프트를 읽고 지키던 것**이라 코드 어디에도 없었다.
 * 판단자를 빼면 함께 사라진다 — 러너를 끄며 보호 넷이 사라졌던 2026-08-05와 같은 자리다.
 *
 * ★ **넘치면 줄인다, 1주도 안 남으면 막는다.** 막기만 하면 분석가가 수량을 조금 틀릴
 *   때마다 한 바퀴를 버린다. 줄인 이유는 크게 적는다.
 * ★ **순수 함수다.** 계좌 값은 부르는 쪽이 넘긴다 — 못 읽었으면 부르는 쪽이 막는다.
 * ★ 매도는 여기 오지 않는다. 안전장치는 들어가는 것을 막지 나오는 것을 막지 않는다.
 */

/** 단기 층 한 종목 상한(총자산 대비). `docs/USER_DECISIONS.md` 「두 층 포트폴리오」 */
export const STOCK_CAP = 0.10;
/** 층 하나의 상한 */
export const LAYER_CAP = 0.50;
/** 손절까지 잃을 수 있는 돈의 상한 */
export const RISK_CAP = 0.02;
/** 제안 지정가에서 현재가가 이만큼 넘게 벗어나면 상황이 바뀐 것으로 본다 */
export const MAX_DRIFT = 0.02;

export interface BuyGuardInput {
  quantity: number;
  limitPrice: number;
  stopPrice?: number;
  layer: 'etf' | 'short';
  /** 총자산(총평가) */
  equity: number;
  /** 매수여력 — 예수금이 아니다 */
  buyingPower: number;
  /** 이 종목을 이미 든 평가액 */
  heldValue: number;
  /** 이 층 전체 평가액(이 종목 포함) */
  layerValue: number;
  /** 지금 현재가. 모르면 벗어남 검사를 건너뛴다 */
  currentPrice?: number;
}

export type BuyGuardVerdict =
  | { kind: 'ok'; quantity: number; trimmed: string[] }
  | { kind: 'block'; why: string };

export function checkBuy(input: BuyGuardInput): BuyGuardVerdict {
  const { limitPrice: price, equity } = input;
  if (!(price > 0) || !(equity > 0) || !(input.quantity >= 1)) {
    return { kind: 'block', why: '수량·지정가·총자산 중 읽지 못한 값이 있다' };
  }
  // 비율로 나누면 102,000/100,000 − 1이 0.02를 부동소수점만큼 넘는다 — 금액 차이로 잰다.
  if (input.currentPrice && Math.abs(input.currentPrice - price) > MAX_DRIFT * price) {
    return {
      kind: 'block',
      why: `현재가 ${input.currentPrice}원이 지정가 ${price}원에서 ${(MAX_DRIFT * 100).toFixed(0)}% 넘게 벗어났다 — 제안 뒤 상황이 바뀌었다`,
    };
  }
  if (input.stopPrice !== undefined && input.stopPrice >= price) {
    return { kind: 'block', why: `손절가 ${input.stopPrice}원이 지정가 ${price}원 이상이다` };
  }

  const caps: Array<[string, number]> = [
    ['매수여력', input.buyingPower / price],
    [`층 ${LAYER_CAP * 100}%`, (LAYER_CAP * equity - input.layerValue) / price],
  ];
  if (input.layer === 'short') {
    caps.push([`종목 ${STOCK_CAP * 100}%`, (STOCK_CAP * equity - input.heldValue) / price]);
    if (input.stopPrice !== undefined) {
      caps.push([`위험 ${RISK_CAP * 100}%`, (RISK_CAP * equity) / (price - input.stopPrice)]);
    }
  }

  let quantity = Math.floor(input.quantity);
  const trimmed: string[] = [];
  for (const [label, room] of caps) {
    const max = Math.max(0, Math.floor(room));
    if (max < quantity) {
      trimmed.push(`${label} 때문에 ${quantity}주 → ${max}주`);
      quantity = max;
    }
  }
  if (quantity < 1) return { kind: 'block', why: `한도에 걸려 1주도 못 산다 (${trimmed.join(' · ')})` };
  return { kind: 'ok', quantity, trimmed };
}
