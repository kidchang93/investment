/**
 * 층별 성과. **어느 층이 목표에 기여하고 어느 층이 까먹는지 본다.**
 *
 * 목표는 "3층으로 연 15~20%"이고 산수는 이렇다:
 *
 *   ETF 50% × 12%(21.4년 실측) = 6.0%p
 *   → 단기 30% + 유망주 20%가 연 18~28%를 내야 한다
 *
 * 그런데 지금까지 계좌 전체 손익만 봐서 **그 두 층이 실제로 무엇을 했는지
 * 알 수 없었다.** 2026-08-14 평가손익 +1,073,430원 중 98%가 KODEX 200
 * 하나였다는 것도 손으로 세어서 알았다.
 *
 *   npx tsx src/scripts/layerReport.ts [계좌id]
 *   npx tsx src/scripts/layerReport.ts --seed-etf   # 지금 보유를 ETF 층으로 초기화
 *
 * ★ **장부와 증권사 잔고를 반드시 대조한다.** 2026-08-14에 같은 주문이 두 번
 * 체결된 것을 잡은 것이 이 대조였다. 장부만 믿으면 그런 사고가 조용히 지나간다.
 */

import { getKisAccount } from '../config.js';
import { closeDb } from '../db/client.js';
import {
  getLayerPositions,
  getLayerTradeStats,
  getRealizedByLayer,
  recordLayerTrade,
} from '../db/layers.js';
import { getKisDomesticAccountSnapshot } from '../kis/rest.js';
import { LAYER_LABELS, reconcile, summarizeLayers } from '../trading/layers.js';

const won = (n: number): string => Math.round(n).toLocaleString('ko-KR');
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const w = (t: string): number => [...t].reduce((a, c) => a + (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(c) ? 2 : 1), 0);
const padR = (t: string, n: number): string => t + ' '.repeat(Math.max(1, n - w(t)));
const padL = (t: string, n: number): string => ' '.repeat(Math.max(1, n - w(t))) + t;
const signed = (n: number): string => `${n >= 0 ? '+' : ''}${won(n)}`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const accountId = args.find((a) => !a.startsWith('--')) ?? 'VTS-ORDINARY';
  const account = getKisAccount(accountId);
  if (!account) throw new Error(`등록되지 않은 계좌: ${accountId}`);

  const snapshot = await getKisDomesticAccountSnapshot(account);
  const brokerQty = new Map(snapshot.positions.map((p) => [p.symbol, p.quantity]));
  const prices = new Map<string, number>();
  for (const p of snapshot.positions) {
    if (typeof p.currentPrice === 'number' && p.currentPrice > 0) prices.set(p.symbol, p.currentPrice);
  }

  /*
   * ★ 장부를 처음 세울 때 쓴다. 지금 보유는 전부 ETF 층에서 산 것이다 —
   * 단기 30%도 ETF로 대체했고(2026-08-14 사용자 결정) 유망주는 0원이다.
   * **한 번만 쓴다.** 두 번 돌리면 같은 수량이 두 번 들어간다.
   */
  if (args.includes('--seed-etf')) {
    const existing = await getLayerPositions(accountId);
    if (existing.length > 0) {
      console.log(`이미 장부에 ${existing.length}줄이 있다 — 초기화를 건너뛴다.`);
      console.log('다시 세우려면 trading_layer_positions/trades를 먼저 비워야 한다.');
    } else {
      for (const p of snapshot.positions) {
        await recordLayerTrade(
          accountId,
          {
            layer: 'etf',
            symbol: p.symbol,
            side: 'buy',
            quantity: p.quantity,
            // 평균단가로 넣는다 — 개별 체결가는 이미 지나갔고 증권사도 평균만 준다.
            price: p.averagePrice ?? 0,
            fee: 0,
          },
          '장부 초기화(2026-08-14 보유를 ETF 층으로)',
        );
      }
      console.log(`장부를 세웠다 — ${snapshot.positions.length}종목을 ETF 층에 넣었다.\n`);
    }
  }

  const positions = await getLayerPositions(accountId);
  if (positions.length === 0) {
    console.log('장부가 비어 있다.');
    console.log('지금 보유를 ETF 층으로 세우려면: npx tsx src/scripts/layerReport.ts --seed-etf');
    return;
  }

  // D+0이 아니라 D+2를 쓴다 — 오늘 산 것이 안 빠진 값으로 비중을 내면 자산이 부푼다.
  const cash = snapshot.settlementCash ?? 0;
  const realized = await getRealizedByLayer(accountId);
  const { summaries, unpriced, totalAssets } = summarizeLayers(positions, prices, realized, cash);

  console.log(`3층 성과 · 계좌 ${accountId} · 총자산 ${won(totalAssets)}원 (D+2 현금 ${won(cash)}원 포함)\n`);
  console.log(
    padR('층', 8) + padL('종목', 5) + padL('원가', 13) + padL('평가액', 13)
    + padL('평가손익', 12) + padL('실현손익', 12) + padL('합계손익', 12)
    + padL('비중', 7) + padL('목표', 7),
  );
  console.log('─'.repeat(90));
  for (const s of summaries) {
    console.log(
      padR(LAYER_LABELS[s.layer], 8)
      + padL(String(s.symbols), 5)
      + padL(won(s.cost), 13)
      + padL(won(s.marketValue), 13)
      + padL(signed(s.unrealizedPnl), 12)
      + padL(signed(s.realizedPnl), 12)
      + padL(signed(s.totalPnl), 12)
      + padL(pct(s.weight), 7)
      + padL(pct(s.targetWeight), 7),
    );
  }
  console.log('─'.repeat(90));
  const totalPnl = summaries.reduce((a, s) => a + s.totalPnl, 0);
  const totalCost = summaries.reduce((a, s) => a + s.cost, 0);
  console.log(
    padR('합계', 8) + padL('', 5) + padL(won(totalCost), 13)
    + padL(won(summaries.reduce((a, s) => a + s.marketValue, 0)), 13)
    + padL('', 12) + padL('', 12) + padL(signed(totalPnl), 12),
  );

  /*
   * ★ **기여도를 적는다.** "어느 층이 목표를 만들고 있나"가 이 표의 목적이다.
   * 손익만 나열하면 크기가 다른 층을 견줄 수 없다.
   */
  console.log('\n목표 기여 — 각 층이 총자산 대비 몇 %p를 만들었나');
  for (const s of summaries) {
    if (s.symbols === 0 && s.realizedPnl === 0) {
      console.log(`  ${padR(LAYER_LABELS[s.layer], 8)} — 아직 아무것도 없다 (목표 비중 ${pct(s.targetWeight)})`);
      continue;
    }
    const contribution = totalAssets > 0 ? s.totalPnl / totalAssets : 0;
    const onCost = s.cost > 0 ? s.totalPnl / s.cost : 0;
    console.log(
      `  ${padR(LAYER_LABELS[s.layer], 8)} ${padL(`${(contribution * 100).toFixed(2)}%p`, 8)}`
      + `  (그 층 원가 대비 ${(onCost * 100).toFixed(2)}%)`,
    );
  }

  const stats = await getLayerTradeStats(accountId);
  if (stats.length > 0) {
    console.log('\n청산된 매매 — 승률과 손익비 (단기 층 판정의 전부다)');
    for (const st of stats) {
      const rate = st.closedTrades > 0 ? st.wins / st.closedTrades : 0;
      const ratio = st.avgLoss > 0 ? st.avgWin / st.avgLoss : 0;
      /*
       * ★ 손익비로 본전 승률을 낸다. 2026-08-03 실주행이 승률 33.3%·손익비 0.44라
       * **승률 70%를 요구하는 구조**였고 그래서 졌다. 그 사실이 표에 보여야 한다.
       */
      const breakEven = ratio > 0 ? 1 / (1 + ratio) : null;
      console.log(
        `  ${padR(LAYER_LABELS[st.layer], 8)} ${st.closedTrades}건 · 승률 ${pct(rate)}`
        + ` · 손익비 ${ratio.toFixed(2)}`
        + (breakEven === null ? '' : ` → 본전 승률 ${pct(breakEven)}`)
        + ` · 실현 ${signed(st.realizedPnl)}원`,
      );
    }
  }

  if (unpriced.length > 0) {
    console.log(`\n★ 현재가를 못 받아 평가액에서 뺀 것: ${unpriced.join(' ')} (원가는 남아 있다)`);
  }

  /*
   * ★★ **장부와 잔고 대조.** 여기가 어긋나면 위 숫자가 전부 거짓이다.
   * 2026-08-14 중복 체결도 이 대조로 잡았다.
   */
  const mismatches = reconcile(positions, brokerQty);
  console.log('');
  if (mismatches.length === 0) {
    console.log('장부와 증권사 잔고가 맞는다.');
  } else {
    console.log(`★ 장부와 잔고가 어긋난다 — ${mismatches.length}종목. **위 숫자를 믿지 마라.**`);
    for (const m of mismatches) {
      console.log(`  ${m.symbol}  장부 ${won(m.ledger)}주 · 증권사 ${won(m.broker)}주 (차이 ${signed(m.broker - m.ledger)}주)`);
    }
    console.log('  → 빠진 매매를 장부에 넣거나, 손으로 낸 주문이 있었는지 확인한다.');
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
