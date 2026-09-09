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
import { getLatestStopPrices } from '../db/deliberations.js';
import { getKoreanInstrumentBySymbol } from '../db/instruments.js';
import {
  getKisDomesticAccountSnapshot,
  getKisDomesticAmendableOrders,
  getKisDomesticOrderability,
} from '../kis/rest.js';

/** 이보다 오래된 적정가는 낡았다고 알린다. 분석가가 5분마다 도므로 넉넉한 값이다 */
const STALE_MINUTES = 20;
/**
 * 적정가 표에 보일 **후보** 수(보유와 ⭐는 이와 별개로 전부 보인다).
 *
 * 후보 풀이 900종목이라 다 찍으면 1,800줄이다. 판단자가 그것을 읽고 나면 판단할
 * 자리가 남지 않는다. 문턱을 넘은 것은 위 ⭐ 섹션이 이미 골라 놓았으므로, 여기서는
 * **그 판정이 어디쯤에서 끊겼는지 보이는 만큼**만 있으면 된다.
 */
const CANDIDATE_SHOWN = 25;

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

  /*
   * ── ⭐ 추천 ─────────────────────────────────────────────────────────────
   *
   * ★★ **적정가 표보다 먼저 찍는다.** 표는 155줄이고 후보를 넓히면 900줄이 된다.
   *    판단자가 그것을 눈으로 훑어 문턱 넘은 것을 골라내야 했고, 회차 542·543이
   *    연달아 "화면에 ⭐ 추천 섹션이 없다"고 적었다.
   *
   * ★ 분석가가 계산한 그 판정을 그대로 읽는다. 여기서 다시 고르면 슬랙에 나간
   *   값과 판단자가 보는 값이 갈린다(적정가를 DB에서 읽는 것과 같은 이유다).
   */
  interface PickRow {
    symbol: string; standard: string; rule: string; gap: number | null; age_min: number;
  }
  /*
   * ★ **표를 만들지 않는다.** 이 스크립트는 조회 전용이고, 표는 분석가가 만든다.
   *   분석가가 한 번도 안 돈 계좌에서는 표 자체가 없으므로 그것을 견딘다 —
   *   없는 표 하나 때문에 계좌도 미체결도 못 보고 죽으면 회차가 통째로 날아간다.
   */
  /*
   * ★★ `null`은 **못 읽었다**이고 `[]`는 **0건**이다. 섞으면 "추천이 없습니다"가
   *    거짓말이 된다 — 판단자는 그것을 "살 것이 없구나"로 읽고 지나간다.
   */
  const picks: PickRow[] | null = await pool.query<PickRow>(
    `SELECT symbol, standard, rule, gap,
            EXTRACT(EPOCH FROM (now() - measured_at)) / 60 AS age_min
       FROM trading_fair_value_picks
      WHERE measured_at = (
              SELECT max(measured_at) FROM trading_fair_value_picks
               WHERE measured_at > now() - interval '2 hours')
      ORDER BY gap ASC NULLS LAST`,
  ).then((r) => r.rows).catch(() => null);

  console.log('── ⭐ 추천 (분석가 판정) ──');
  if (picks === null) {
    console.log('  ★ 추천을 읽지 못했습니다 — 없다는 뜻이 아닙니다.');
    console.log('    분석가가 이 계좌에서 한 번도 안 돌았을 수 있습니다. 아래 표로 직접 보세요.');
  } else if (picks.length === 0) {
    /*
     * ★ **"추천 0건"과 "분석가가 안 돌았다"는 다른 사실이다.** 아래 적정가 표가
     *   비어 있으면 후자다. 이 줄만 보고 "살 것이 없구나"로 읽으면 안 된다.
     */
    console.log(rows.length === 0
      ? '  (분석가가 아직 안 돌았습니다 — 아래 적정가 표도 비어 있습니다)'
      : '  없음 — 문턱을 넘은 종목이 없습니다. 아래 표에서 직접 고를 이유는 없습니다.');
  } else {
    console.log(`  기준: ${picks[0].rule}`);
    for (const p of picks) {
      const instrument = await getKoreanInstrumentBySymbol(p.symbol);
      const stale = p.age_min > STALE_MINUTES ? ` ⚠${Math.round(p.age_min)}분 전` : '';
      console.log(
        `  ⭐ [${p.standard}] ${p.symbol} ${instrument?.name ?? p.symbol}`
        + `${p.gap === null ? '' : ` · ${(p.gap * 100).toFixed(1)}%`}${stale}`,
      );
    }
    console.log('  ★ ⭐는 "사라"가 아닙니다 — 층 상한·매수여력·plan을 세울 수 있는지는 당신이 봅니다.');
  }

  console.log('\n── 적정가 (분석가 계산) ──');
  if (rows.length === 0) {
    /*
     * ★ **조용히 비워 두지 않는다.** 판단자가 빈 표를 보면 "살 것이 없나 보다"로
     *   읽고 지나간다 — 실제로는 분석가가 안 돈 것이다. 2026-08-21에
     *   `deliberationState`가 "뉴스는 여기 없다"고 적어 둔 탓에 회차 셋이 헛돌았다.
     */
    console.log('  ★ 적정가가 없습니다 — 분석가가 아직 안 돌았습니다.');
    console.log('    이 회차는 적정가 없이 판단해야 하고, 그 사실을 findings에 적으세요.');
  } else {
    /*
     * ★★ **다 찍지 않는다** (2026-09-09). 후보를 900종목으로 넓히면서 이 표가
     *    1,800줄(종목당 값 + 근거)이 됐다. 판단자가 그것을 읽고 나면 정작 판단할
     *    자리가 남지 않는다 — 화면은 판단을 **돕는** 것이지 대신하는 것도,
     *    묻어 버리는 것도 아니다.
     *
     * ★ 무엇을 남기나:
     *   ① **보유는 전부** — 팔지 말지는 매 회차 물어야 하는 질문이다
     *   ② **⭐로 뽑힌 것은 전부** — 위 섹션이 이미 이유를 적었고, 여기서는 그
     *      근거(차트·재무 값)를 본다
     *   ③ 나머지는 **싼 순으로 CANDIDATE_SHOWN개**까지. 그 아래는 한 줄로 센다
     *
     * ★ 잘라낸 것을 **말한다.** 조용히 자르면 판단자는 그것이 전부인 줄 알고
     *   "후보가 이것뿐이다"라고 적는다 — 30종목 상한을 넘겨 31번째가 조용히
     *   사라졌던 멀티시세와 같은 병이다.
     */
    /*
     * ★ 보유는 **층 장부**에서 읽는다. 이 표는 계좌 조회보다 **먼저** 찍히므로
     *   증권사 잔고를 아직 모른다. 장부는 매일 마감에 잔고와 대조되고 어긋나면
     *   화면이 그것을 말하므로(`pendingSync`), 여기서 쓰기에 충분하다.
     *   못 읽어도 표가 조금 길어질 뿐이라 조용히 넘어간다.
     */
    const held = new Set(await pool.query<{ symbol: string }>(
      `SELECT DISTINCT symbol FROM trading_layer_positions
        WHERE account_id = $1 AND quantity > 0`,
      [accountId],
    ).then((r) => r.rows.map((x) => x.symbol)).catch(() => []));
    const starred = new Set((picks ?? []).map((p) => p.symbol));
    const sorted = rows.sort((a, b) => (a.gap ?? 99) - (b.gap ?? 99));
    let shownCandidates = 0;
    let hidden = 0;
    const visible = sorted.filter((r) => {
      if (held.has(r.symbol) || starred.has(r.symbol)) return true;
      if (shownCandidates < CANDIDATE_SHOWN) { shownCandidates += 1; return true; }
      hidden += 1;
      return false;
    });
    if (hidden > 0) {
      console.log(`  (보유 ${held.size} · ⭐ ${starred.size} · 그 밖에 싼 순으로 ${shownCandidates}종목을 보입니다`
        + ` — 문턱 밖 ${hidden}종목은 접었습니다)`);
    }
    for (const r of visible) {
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
    /*
     * ★★ **내가 적은 익절·손절을 함께 찍는다** (2026-09-09).
     *
     * 그전에는 평단·평가손익만 나와서, 익절가를 넘었는지 판단자가 **여기서 알 수
     * 없었다.** 회차 542·543이 매 회차 `deliberationState.ts`를 따로 실행해
     * 확인했다고 적었다 — 회차마다 무는 비용이다.
     *
     * `deliberationState`가 쓰는 것과 **같은 함수**를 쓴다. 두 화면이 다른 값을
     * 보이면 어느 쪽을 믿을지가 새 문제가 된다.
     */
    const plans = await getLatestStopPrices(accountId).catch(() => new Map());
    for (const p of snap.positions) {
      if (p.quantity <= 0) continue;
      console.log(
        `    ${p.symbol} ${p.name} ${p.quantity}주 · 평단 ${won(p.averagePrice)}`
        + ` · 평가손익 ${(p.unrealizedPnl ?? 0) >= 0 ? '+' : ''}${won(p.unrealizedPnl ?? 0)}`
        + ` (${(p.unrealizedPnlRate ?? 0).toFixed(2)}%)`,
      );
      const plan = plans.get(p.symbol);
      const price = p.currentPrice ?? 0;
      console.log(plan
        ? `      · 내가 적은 값 → 익절 ${plan.target ? won(plan.target) : '없음'}`
          + `${plan.target && price >= plan.target ? ' ★넘었다' : ''}`
          + ` / 손절 ${won(plan.stop)}${price > 0 && price <= plan.stop ? ' ★깼다' : ''}`
          + ` (회차 ${plan.round})`
        : '      · 내가 적은 값 없음 (익절·손절 둘 다 지킬 약속이 없다)');
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
