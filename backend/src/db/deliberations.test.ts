/**
 * 회의 기록 검증.
 *
 * ★ 여기서 지키는 것은 하나다: **반증 조건 없이는 기록되지 않는다.**
 *
 * 에이전트 구조는 되돌려 잴 수 없다. 남는 검증 수단이 "그때 적은 판단을 나중에
 * 채점하는 것"뿐인데, 반증 조건이 없으면 결과에 맞춰 이야기를 붙이게 된다 —
 * 오르면 "역시 맞았다", 내리면 "시장이 이상했다". 그러면 채점이 불가능하다.
 *
 * 이 시험은 **DB를 타지 않는다.** 검사가 스키마 준비보다 먼저 일어나므로
 * Postgres 없이도 돈다 — 안전장치는 시험할 수 있어야 안전장치다.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { recordDeliberation, type DeliberationRound } from './deliberations.js';

function round(over: Partial<DeliberationRound> = {}): DeliberationRound {
  return {
    accountId: 'VTS-ORDINARY',
    tradingDay: '2026-08-06',
    startedAt: 1_785_980_000_000,
    trigger: 'scheduled',
    triggerReason: '',
    equity: 96_077_424,
    positions: [],
    findings: [{ agent: 'quant-strategist', summary: '우위 없음' }],
    decisions: [{ symbol: '005930', name: '삼성전자', action: 'hold', quantity: 0, rationale: '근거 없음' }],
    falsifier: '내일 시가가 전일 종가 대비 +2% 이상이면 이 보류 판단은 기회비용을 놓친 것이다.',
    unknowns: [],
    sources: [],
    reference: { prices: {} },
    executions: [],
    ...over,
  };
}

describe('회의 기록 — 반증 조건이 없으면 안 남는다', () => {
  it('falsifier가 비면 던진다', async () => {
    await assert.rejects(
      () => recordDeliberation(round({ falsifier: '' })),
      /반증 조건/,
    );
  });

  /*
   * 공백만 넣거나 "없음" 같은 한두 글자로 때우는 길을 막는다. 형식만 채우면
   * 필드가 있으나 마나가 된다 — 이 표를 만든 이유가 사라진다.
   */
  it('공백이나 너무 짧은 것도 안 된다', async () => {
    for (const value of ['   ', '없음', '몰라', '        \n  ']) {
      await assert.rejects(
        () => recordDeliberation(round({ falsifier: value })),
        /반증 조건/,
        value,
      );
    }
  });

  /*
   * ★ 거부는 **DB에 닿기 전에** 일어나야 한다. Postgres가 없는 환경에서 이
   * 시험이 통과한다는 것 자체가 그 증거다 — 연결 오류가 아니라 우리 메시지가 나온다.
   */
  it('거부 사유가 무엇을 적어야 하는지까지 말한다', async () => {
    await assert.rejects(
      () => recordDeliberation(round({ falsifier: '' })),
      /무엇이 관측될까/,
    );
  });
});

/*
 * ★★ 손절선은 층마다 다르다 (2026-09-21 사용자 결정 — ETF에는 손절선을 두지 않는다).
 *    예전엔 타입만 stopPrice를 필수라 적고 런타임은 검사하지 않았다. 단기 층에서 빠지면
 *    손절 없는 자리가 조용히 생기고(손절 감시는 stopPrice가 있는 결정만 본다), ETF에 적으면
 *    장기 자리를 가격으로 판다. **거부되는지만** 본다 — 통과시키면 실제 DB에 기록된다.
 */
describe('매수 plan의 손절가 — 층마다 다르다', () => {
  const buy = (layer: 'short' | 'etf', stopPrice?: number) => round({
    decisions: [{
      symbol: '329200', name: 'TIGER 리츠부동산인프라', action: 'buy', quantity: 10, limitPrice: 4_070,
      layer, rationale: '시험',
      plan: { horizonDays: 250, expectedReturn: 0.05, basis: '시험', ...(stopPrice ? { stopPrice } : {}) },
    }],
  });

  it('단기 층 매수에 stopPrice가 없으면 기록하지 않는다 — 손절 없는 자리가 생긴다', async () => {
    await assert.rejects(recordDeliberation(buy('short')), /단기 층 매수에 stopPrice가 없습니다/);
  });

  it('ETF 층 매수에 stopPrice가 있으면 기록하지 않는다 — ETF에는 손절선을 두지 않는다', async () => {
    await assert.rejects(recordDeliberation(buy('etf', 3_800)), /ETF 층 매수에 stopPrice가 있습니다/);
  });
});
