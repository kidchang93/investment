/**
 * **빠른 판단자가 보는 것 전부.** 적정가 표 + 계좌 + 미체결을 한 순간으로 낸다.
 *
 * ── 왜 (2026-09-03) ──────────────────────────────────────────────────────
 *
 * 사용자가 정했다 — *"분석가가 메세지 보낸 후 판단자를 바로 부르면 돼. 판단자도
 * 이제 프로세스를 좀 단순화해도 되겠지?"*
 *
 * 맞다. 오늘 정식 회차가 **13분** 걸렸다(09:47→10:00). 5분마다 도는 자리에는
 * 못 쓴다. 빠른 판단자는 **이 스크립트 하나만** 보고 2~3분에 끝낸다.
 *
 * ★ **따로 조회하지 않고 한 번에 낸다.** 적정가·계좌·미체결을 따로 부르면
 *   시각이 어긋나 결론이 갈린다 — `deliberationState`가 같은 이유로 그렇게
 *   짜여 있다.
 *
 * ★ **적정가는 DB에서 읽는다.** 분석가(`analyzeFairValue.ts`)가 5분마다 계산해
 *   `trading_fair_values`에 넣은 **가장 최근 것**을 쓴다. 여기서 다시 계산하면
 *   슬랙에 보낸 값과 판단자가 보는 값이 달라진다.
 *
 * 조회 전용이다. 주문을 내지 않는다.
 *
 *   npx tsx src/scripts/showFairValues.ts [계좌id]
 */

import '../config.js';

import { getKisAccount } from '../config.js';
import { closeDb, pool } from '../db/client.js';
import { getKoreanInstrumentBySymbol } from '../db/instruments.js';
import {
  getKisDomesticAccountSnapshot,
  getKisDomesticAmendableOrders,
  getKisDomesticOrderability,
} from '../kis/rest.js';

/** 이보다 오래된 적정가는 낡았다고 알린다. 분석가가 5분마다 도므로 넉넉한 값이다 */
const STALE_MINUTES = 20;

const won = (n: number): string => `${Math.round(n).toLocaleString('ko-KR')}원`;

interface FairRow {
  symbol: string;
  price: number;
  chart_mid: number | null;
  fundamental_mid: number | null;
  gap: number | null;
  basis: string;
  age_min: number;
}

async function main(): Promise<void> {
  const accountId = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'VTS-ORDINARY';
  const account = getKisAccount(accountId);

  console.log(`=== 빠른 판단 상태 · ${accountId} · ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} ===\n`);

  // ── 적정가 (분석가가 넣은 가장 최근 것) ──
  const { rows } = await pool.query<FairRow>(
    `SELECT DISTINCT ON (symbol)
            symbol, price, chart_mid, fundamental_mid, gap, basis,
            EXTRACT(EPOCH FROM (now() - measured_at)) / 60 AS age_min
       FROM trading_fair_values
      WHERE measured_at > now() - interval '2 hours'
      ORDER BY symbol, measured_at DESC`,
  );

  console.log('── 적정가 (분석가 계산) ──');
  if (rows.length === 0) {
    /*
     * ★ **조용히 비워 두지 않는다.** 판단자가 빈 표를 보면 "살 것이 없나 보다"로
     *   읽고 지나간다 — 실제로는 분석가가 안 돈 것이다. 2026-08-21에
     *   `deliberationState`가 "뉴스는 여기 없다"고 적어 둔 탓에 회차 셋이 헛돌았다.
     */
    console.log('  ★ 적정가가 없습니다 — 분석가가 아직 안 돌았습니다.');
    console.log('    이 회차는 적정가 없이 판단해야 하고, 그 사실을 findings에 적으세요.');
  } else {
    for (const r of rows.sort((a, b) => (a.gap ?? 99) - (b.gap ?? 99))) {
      const instrument = await getKoreanInstrumentBySymbol(r.symbol);
      const name = instrument?.name ?? r.symbol;
      const stale = r.age_min > STALE_MINUTES ? ` ⚠${Math.round(r.age_min)}분 전` : '';
      if (r.gap === null) {
        console.log(`  ${r.symbol} ${name} ${won(r.price)} — 적정가 못 냄${stale}`);
        continue;
      }
      const mark = r.gap < -0.05 ? '싸다' : r.gap > 0.05 ? '비싸다' : '비슷';
      const axes = [
        r.chart_mid ? `차트중앙 ${won(r.chart_mid)}` : null,
        r.fundamental_mid ? `재무중앙 ${won(r.fundamental_mid)}` : null,
      ].filter(Boolean).join(' · ');
      console.log(
        `  ${r.symbol} ${name} ${won(r.price)} · ${(r.gap * 100).toFixed(1)}% (${mark}) · ${axes}${stale}`,
      );
      if (r.basis) console.log(`      ${r.basis}`);
    }
  }

  if (!account) {
    console.log('\n★ 등록되지 않은 계좌입니다. 계좌 없이 판단할 수 없습니다.');
    return;
  }

  // ── 계좌 ──
  console.log('\n── 계좌 ──');
  try {
    const snap = await getKisDomesticAccountSnapshot(account);
    const pnl = snap.positions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
    console.log(`  총평가 ${won(snap.totalEvaluation ?? 0)} · 예수금 ${won(snap.cashBalance ?? 0)} · 평가손익 ${pnl >= 0 ? '+' : ''}${won(pnl)}`);
    /*
     * ★ **예수금이 아니라 매수여력을 봐야 한다.** 예수금(D+0)에는 오늘 체결된 것도
     *   미체결이 묶어 둔 것도 아직 안 빠져 있다 — 2026-08-20에 예수금
     *   19,649,294원인데 매수여력은 984,524원이었다.
     */
    /*
     * ★ 매수여력은 **스냅샷에 없다** — 종목·가격을 넣어 따로 물어야 한다.
     *   기준 종목 하나로 물어 대략을 본다(같은 계좌면 현금 여력은 같다).
     */
    try {
      const ord = await getKisDomesticOrderability(account, '069500', 'limit', 100_000);
      if (ord.cashAvailable !== undefined) {
        console.log(`  ★ 매수여력 ${won(ord.cashAvailable)} — 주문 수량은 이것으로 계산한다`);
      } else {
        console.log('  ★ 매수여력을 못 읽었습니다. 예수금보다 훨씬 작을 수 있으니 크게 사지 마세요.');
      }
    } catch {
      console.log('  ★ 매수여력을 못 읽었습니다. 예수금보다 훨씬 작을 수 있으니 크게 사지 마세요.');
    }
    for (const p of snap.positions) {
      if (p.quantity <= 0) continue;
      console.log(
        `    ${p.symbol} ${p.name} ${p.quantity}주 · 평단 ${won(p.averagePrice)}`
        + ` · 평가손익 ${(p.unrealizedPnl ?? 0) >= 0 ? '+' : ''}${won(p.unrealizedPnl ?? 0)}`
        + ` (${(p.unrealizedPnlRate ?? 0).toFixed(2)}%)`,
      );
    }
  } catch (error) {
    console.log(`  ★ 계좌를 못 읽었습니다: ${(error as Error).message.slice(0, 80)}`);
    console.log('    자리 크기를 계산할 수 없으므로 이 회차에서는 매수하지 마세요.');
  }

  // ── 미체결 ──
  console.log('\n── 미체결 ──');
  try {
    const open = await getKisDomesticAmendableOrders(account);
    if (open.length === 0) console.log('  없음');
    for (const o of open) {
      console.log(
        `  ${o.symbol} ${o.name} ${o.side === 'buy' ? '매수' : '매도'}`
        + ` 남은 ${o.amendableQuantity}주 / 낸 ${o.orderQuantity}주`
        + ` · 주문번호 ${o.orderNo} · 지점 ${o.orderBranchNo} · 구분 ${o.orderTypeCode}`,
      );
    }
  } catch (error) {
    console.log(`  (못 읽었습니다: ${(error as Error).message.slice(0, 60)})`);
  }

  // ── 오늘 이미 한 판단 ──
  console.log('\n── 오늘 회차 ──');
  const { rows: today } = await pool.query<{ id: string; trigger: string; n: string; at: string }>(
    `SELECT id::text, trigger, jsonb_array_length(decisions)::text AS n,
            to_char(created_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS at
       FROM trading_deliberations
      WHERE account_id = $1 AND trading_day = (now() AT TIME ZONE 'Asia/Seoul')::date
      ORDER BY id`,
    [accountId],
  );
  if (today.length === 0) console.log('  아직 없음');
  for (const r of today) console.log(`  회차 ${r.id} · ${r.at} · ${r.trigger} · 결정 ${r.n}건`);
  console.log('\n★ 같은 판단을 되풀이하지 마세요. 위 회차가 이미 정한 것은 그대로 둡니다.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
