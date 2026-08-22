/**
 * **손절선을 깬 자리를 골라낸다.** 순수 함수다 — 그물을 타지 않는다.
 *
 * 판정을 스크립트 안에 두면 시험할 수 없고, 시험할 수 없는 판정이 시장가 매도를
 * 낸다. 부르는 쪽이 보유·손절가·미체결을 넘긴다.
 *
 * ── 규칙이 집행하는 이유 (2026-08-20, 사용자가 정했다) ────────────────────
 *
 * 손절값은 판단자가 **사기 전에 스스로 적은 값**이다. 규칙이 그것을 집행하는 것은
 * 새 판단이 아니라 **자기가 한 약속을 지키는 것**이다. 판단자를 부르면 1~2분이
 * 걸리고 급락에는 그 지연이 치명적이다.
 */

import { sellableQuantity } from './positionGuard.js';
import type { Layer } from './layers.js';
import type { BrokerExecution } from '@invest/shared';

export interface StopRule {
  /** 손절가(원) */
  stop: number;
  /** 그 값을 적은 회차. 왜 팔았는지 되짚는 실 */
  round: number;
  /**
   * ★ **어느 층의 자리인가.** 매수 결정이 적어 둔 값이다.
   *
   * ── 왜 여기까지 들고 오나 (2026-08-22) ────────────────────────────────
   *
   * **증권사 잔고는 층을 모른다.** 손절 매도가 이 값 없이 나가면
   * `trading_broker_orders.layer`가 비고, `layerSync`가 그 체결을 기본값(ETF)으로
   * 떨어뜨리거나 아예 못 넣는다. 2026-08-21에 실제로 그랬다 — 티에스이 20주가
   * 시장가로 팔렸는데 층 장부에는 매수만 남아 `layerReport`가 유망주 층을
   * **-33.31%**로 찍었다(원가는 남고 평가액이 0이 된 것이지 실제 손실이 아니다).
   * 그 상태로 20분마다 "장부와 잔고가 어긋난다" 경보가 하루 16번 울렸다.
   *
   * 값이 없으면 **비워 둔다.** 짐작해서 채우면 그 층의 손익이 거짓이 된다.
   */
  layer?: Layer;
}

export interface StopBreach {
  symbol: string;
  name: string;
  /** 실제로 팔 수 있는 수량. 미체결 매도를 뺀 값 */
  quantity: number;
  price: number;
  stop: number;
  round: number;
  /** 손절 매도를 어느 층에 되돌릴 것인가. 규칙에 적힌 값을 그대로 옮긴다 */
  layer?: Layer;
}

export interface StopCheckResult {
  /** 보유 중이면서 손절가가 적혀 있는 자리 — 실제 감시 대상 */
  watched: number;
  /** 현재가를 못 읽어 판정하지 못한 종목 */
  unknownPrice: string[];
  breaches: StopBreach[];
}

export function checkStops(
  positions: Array<{ symbol: string; name: string; quantity: number; currentPrice?: number }>,
  stops: Map<string, StopRule>,
  executions: BrokerExecution[],
): StopCheckResult {
  const breaches: StopBreach[] = [];
  const unknownPrice: string[] = [];
  let watched = 0;

  for (const position of positions) {
    const rule = stops.get(position.symbol);
    /*
     * 손절가가 없는 자리는 대상이 아니다. ETF 층은 알파를 주장하지 않으므로
     * 손절을 적지 않는다 — "안 적었다"와 "안 깼다"는 다른 사실이다.
     */
    if (!rule) continue;
    watched += 1;

    const price = position.currentPrice;
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      // ★ 0으로 읽으면 **전량이 손절로 떨어진다.** 모르면 판정하지 않는다.
      unknownPrice.push(position.symbol);
      continue;
    }
    if (price > rule.stop) continue;

    // 미체결 매도가 이미 있으면 그만큼 뺀다 — 안 그러면 없는 물량을 판다.
    const quantity = sellableQuantity(position.symbol, positions, executions);
    if (quantity <= 0) continue;

    breaches.push({
      symbol: position.symbol,
      name: position.name,
      quantity,
      price,
      stop: rule.stop,
      round: rule.round,
      layer: rule.layer,
    });
  }

  return { watched, unknownPrice, breaches };
}
