/**
 * 해외주식 주문(`/uapi/overseas-stock/v1/trading/order`) 요청 본문 조립.
 *
 * `orderCash.ts`와 같은 이유로 `rest.ts`에서 떼어 뒀다 — **보내기 전에 막아야
 * 하는 계산**이라 네트워크 없이 시험에 태워야 한다. 조회는 틀리면 다시 부르면
 * 되지만 주문은 한 번 나가면 되돌릴 수 없다.
 *
 * ── ★★ TR이 시장마다 갈리고, 모의는 실전과 번호 체계가 다르다 ─────────────
 *
 * 2026-09-10에 KIS 공식 예제(`open-trading-api`)에서 확인했다. **가장 위험한
 * 자리가 미국 매도다:**
 *
 *     미국 매수   실전 TTTT1002U   모의 VTTT1002U     ← 뒤 네 자리가 같다
 *     미국 매도   실전 TTTT1006U   모의 VTTT1001U     ← **다르다**
 *
 * 실전 번호에 `V`만 붙여 `VTTT1006U`로 짐작했으면 틀렸다. 그래서 이 표는
 * **짝마다 명시**하고, 규칙으로 만들지 않는다 — 규칙이 하나라도 어긋나면
 * 주문이 엉뚱한 TR로 나간다.
 *
 * ── 지정가만 만든다 ──────────────────────────────────────────────────────
 *
 * ★ 해외주식은 **시장가 지원이 시장마다 다르다.** 확인되지 않은 주문구분을
 *   지금 넣지 않는다 — 이 레포가 스톱지정가(`ORD_DVSN=22`)에서 겪은 그대로,
 *   "될 줄 알고 만든" 경로는 검증할 수 없는 코드로 남는다. 지정가(`00`)만
 *   확인해 두고, 시장가는 필요해질 때 탐침으로 재고 넣는다.
 */

import type { OrderSide } from '@invest/shared';

/**
 * KIS 해외 거래소 코드(`OVRS_EXCG_CD`).
 *
 * ★ **뜻이 아니라 KIS 코드 그대로다.** 이 모듈이 `kis/` 안에 있는 이유이고,
 *   바깥으로는 이 값이 나가지 않는다.
 */
export type OverseasExchange =
  | 'NASD' | 'NYSE' | 'AMEX'   // 미국
  | 'SEHK'                     // 홍콩
  | 'SHAA'                     // 중국 상해
  | 'SZAA'                     // 중국 심천
  | 'TKSE'                     // 일본
  | 'HASE' | 'VNSE';           // 베트남 하노이 · 호치민

/** TR이 갈리는 단위. 거래소가 아니라 **시장**이다 — 미국 셋이 같은 TR을 쓴다 */
type OverseasMarket = 'US' | 'HK' | 'SHANGHAI' | 'SHENZHEN' | 'JP' | 'VN';

const EXCHANGE_MARKET: Record<OverseasExchange, OverseasMarket> = {
  NASD: 'US', NYSE: 'US', AMEX: 'US',
  SEHK: 'HK',
  SHAA: 'SHANGHAI',
  SZAA: 'SHENZHEN',
  TKSE: 'JP',
  HASE: 'VN', VNSE: 'VN',
};

interface TrPair { buy: string; sell: string }

/**
 * 시장 × 서버 × 방향 → TR.
 *
 * ★★ **`V`를 붙여 만들지 않는다.** 미국 매도가 그 규칙을 깬다(위 주석).
 *    출처는 KIS 공식 예제이고, 새 시장을 넣을 때도 **거기서 베껴 온다.**
 */
const ORDER_TR: Record<OverseasMarket, { prod: TrPair; vts: TrPair }> = {
  US: {
    prod: { buy: 'TTTT1002U', sell: 'TTTT1006U' },
    // ★ 매도가 1001U다 — 1006U가 아니다.
    vts: { buy: 'VTTT1002U', sell: 'VTTT1001U' },
  },
  HK: {
    prod: { buy: 'TTTS1002U', sell: 'TTTS1001U' },
    vts: { buy: 'VTTS1002U', sell: 'VTTS1001U' },
  },
  SHANGHAI: {
    prod: { buy: 'TTTS0202U', sell: 'TTTS1005U' },
    vts: { buy: 'VTTS0202U', sell: 'VTTS1005U' },
  },
  SHENZHEN: {
    prod: { buy: 'TTTS0305U', sell: 'TTTS0304U' },
    vts: { buy: 'VTTS0305U', sell: 'VTTS0304U' },
  },
  JP: {
    prod: { buy: 'TTTS0308U', sell: 'TTTS0307U' },
    vts: { buy: 'VTTS0308U', sell: 'VTTS0307U' },
  },
  VN: {
    prod: { buy: 'TTTS0311U', sell: 'TTTS0310U' },
    vts: { buy: 'VTTS0311U', sell: 'VTTS0310U' },
  },
};

/** 지정가. 해외는 이것만 확인해 두고 쓴다 (위 주석) */
export const OVERSEAS_LIMIT_ORDER_DIVISION = '00';

/** 못 보내는 이유를 말할 때 앞에 붙인다. 보내기 전에 멈췄다는 사실이 먼저다. */
const NOT_SENT = '해외주식 주문을 보내지 않았습니다:';

/**
 * 이 거래소·서버·방향의 TR. 모르는 거래소면 **던진다.**
 *
 * ★ 기본값을 두지 않는다 — 모르는 거래소에 미국 TR을 보내면 KIS가 받아 줄 수도
 *   있고, 그러면 **엉뚱한 시장에 주문이 나간다.**
 */
export function overseasOrderTr(
  exchange: OverseasExchange, side: OrderSide, server: 'prod' | 'vts',
): string {
  const market = EXCHANGE_MARKET[exchange];
  if (market === undefined) {
    throw new Error(`${NOT_SENT} 모르는 거래소입니다: ${exchange}`);
  }
  const pair = ORDER_TR[market][server];
  return side === 'buy' ? pair.buy : pair.sell;
}

export interface OverseasOrderInput {
  /** 계좌번호 앞 8자리 */
  cano: string;
  /** 상품코드 2자리 */
  productCode: string;
  exchange: OverseasExchange;
  /** 해외 종목코드. 미국은 티커(`AAPL`) */
  symbol: string;
  side: OrderSide;
  quantity: number;
  /**
   * 지정가. **필수다** — 시장가 주문구분을 안 만들었으므로 값이 없으면 보낼 수
   * 없다. `'0'`으로 나가면 값이 빠진 주문이 접수될 수 있다.
   */
  limitPrice: number;
}

function isPositive(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * 값이 어긋나면 **조립하지 않고 던진다.**
 *
 * 반환값의 키는 KIS 스펙 그대로다 — 바깥으로는 이 모양이 나가지 않는다.
 */
export function overseasOrderPayload(input: OverseasOrderInput): Record<string, string> {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new Error(`${NOT_SENT} 수량이 1 이상의 정수여야 합니다 (받은 값 ${input.quantity}).`);
  }
  /*
   * ★ 지정가가 없으면 던진다. 국내 현금주문은 시장가일 때 단가를 `'0'`으로
   *   비우는 규칙이 있지만, 여기서는 시장가 자체를 안 만들었으므로 `'0'`이
   *   나갈 자리가 없다 — 나간다면 그건 값이 빠진 것이다.
   */
  if (!isPositive(input.limitPrice)) {
    throw new Error(
      `${NOT_SENT} 지정가가 필요합니다 — 해외주식은 지정가만 보냅니다`
      + '(시장가 주문구분은 시장마다 달라 아직 확인하지 않았습니다).',
    );
  }
  if (EXCHANGE_MARKET[input.exchange] === undefined) {
    throw new Error(`${NOT_SENT} 모르는 거래소입니다: ${input.exchange}`);
  }
  if (input.symbol.trim() === '') {
    throw new Error(`${NOT_SENT} 종목코드가 비어 있습니다.`);
  }

  return {
    CANO: input.cano,
    ACNT_PRDT_CD: input.productCode,
    OVRS_EXCG_CD: input.exchange,
    PDNO: input.symbol,
    ORD_QTY: String(input.quantity),
    /*
     * ★ 소수 둘째 자리까지 보낸다. 미국은 호가가 0.01달러라 정수로 반올림하면
     *   **낼 수 없는 값**이 되고, 자릿수를 안 맞추면 KIS가 거절한다.
     */
    OVRS_ORD_UNPR: input.limitPrice.toFixed(2),
    /** 주문 서버 구분. 공식 예제가 `'0'` 고정이다 */
    ORD_SVR_DVSN_CD: '0',
    ORD_DVSN: OVERSEAS_LIMIT_ORDER_DIVISION,
    /*
     * ★ 매도일 때만 매도유형(`'00'` 일반매도)을 넣는다. 매수에 넣으면 KIS가
     *   거절하는 시장이 있어 **방향으로 가른다.**
     */
    ...(input.side === 'sell' ? { SLL_TYPE: '00' } : {}),
    /** 연락처·주문점 지정번호는 안 쓴다. 비워 보내는 것이 공식 예제 그대로다 */
    CTAC_TLNO: '',
    MGCO_APTM_ODNO: '',
  };
}
