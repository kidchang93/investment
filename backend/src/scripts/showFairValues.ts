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
import { getLayerPositions } from '../db/layers.js';
import {
  getKisDomesticAccountSnapshot,
  getKisDomesticAmendableOrders,
  getKisDomesticOrderability,
} from '../kis/rest.js';
import { won } from '../notify/slack.js';
import { LAYER_CAP, STOCK_CAP } from '../trading/buyGuard.js';
import { AXIS_DIVERGENCE_LIMIT } from '../trading/fairValue.js';

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
/** 📈에서 "상한가 근처"로 표시하는 등락률(%). KRX 가격제한폭은 ±30%다 */
const LIMIT_UP_WARN = 25;

/** 분석가가 붙인 뉴스 한 칸. 배열이면 받은 기사, `{failed}`면 못 받은 것 */
type NewsCell = Array<{ title: string; source: string; publishedAt?: number }> | { failed: string };

/** 초 단위 시각을 KST로. ★ 밀리초로 읽으면 1970년이 나온다(NewsItem 주석) */
function newsTime(sec?: number): string {
  if (sec === undefined) return '(시각 없음)';
  return new Date(sec * 1000).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/**
 * 뉴스 한 칸을 줄로.
 *
 * ★★ **"0건"·"못 받음"·"안 받음"을 가른다.** 섞으면 판단자가 "뉴스가 없으니
 *    문제없다"로 읽는다. 2026-09-11까지 지침은 뉴스가 표에 붙어 온다고 약속했는데
 *    이 화면은 **한 줄도 찍지 않았다** — 회차 1311~1363이 그것을 적었다.
 */
function newsLines(cell: NewsCell | null | undefined, isStar: boolean): string[] {
  if (cell === null || cell === undefined) {
    return isStar ? ['      📰 이 표에는 뉴스가 없습니다(분석가가 뉴스를 붙이기 전 기록)'] : [];
  }
  if (!Array.isArray(cell)) return [`      📰 뉴스를 못 받았습니다 — 없다는 뜻이 아닙니다 (${cell.failed})`];
  if (cell.length === 0) return ['      📰 최근 기사 0건'];
  return cell.map((n) => `      📰 ${newsTime(n.publishedAt)} ${n.source} · ${n.title}`);
}

interface FairRow {
  symbol: string;
  price: number;
  chart_mid: number | null;
  fundamental_mid: number | null;
  gap: number | null;
  basis: string;
  age_min: number;
  /** 시장 대비 60일로 급락 중인가 — 분석가가 판정해 넣는다 */
  falling: boolean;
  /** 종목별 뉴스 — ⭐·보유 개별주식에만 있다. `null`이면 안 받았다 */
  news: NewsCell | null;
}

/**
 * 종목 줄에 붙일 적정가 꼬리표.
 *
 * ★★ **왜 못 냈는지를 함께 적는다** (2026-09-16).
 *
 * 이 자리가 빈칸이던 동안 판단자가 매 회차 *"두 축 중 하나가 통째로 없어 손절선
 * 기준을 못 세운다 — 종목 판단이 아니라 **데이터가 없어서** 못 산 것"*이라고
 * `unknowns`에 적었다. **오진이었다.** 그날 걸린 종목은 두 축이 **다 있었고**,
 * 2.0~12.8배 어긋나 `combine()`이 **일부러** 안 낸 것이다(`trading/fairValue.ts`).
 * 사유는 `combine()`이 `missing`에 정확히 적지만 그 배열은 저장되지 않는다
 * (`trading_fair_values`에 칸이 없다). 두 축 값은 저장되므로 배수는 여기서 다시 낸다.
 *
 * ★ `undefined`(적정가를 재지 않은 종목)와 `null`(재 봤지만 못 냄)은 **다른
 *   사실**이다. 둘을 같은 빈칸으로 두면 "모른다"와 "안 봤다"가 섞인다.
 *
 * ★ 못 냈다는 것 자체가 정보다 — 2026-09-16 📈(오늘 오른 것) 10종목 중 **6종목**이
 *   이것이었다. 테마로 급등하면 과거 배수가 성립하지 않으므로, 이 꼬리표는
 *   사실상 "재무로는 설명이 안 되는 자리"를 가리킨다.
 */
function fairGapLabel(row: FairRow | undefined): string {
  if (row === undefined) return '';
  if (row.gap !== null) {
    return ` · 적정가 대비 ${row.gap > 0 ? '+' : ''}${(row.gap * 100).toFixed(1)}%`;
  }
  /*
   * ★★ **`gap`이 `null`인 길은 둘이고 서로 다른 사실이다** (2026-09-16 실측).
   *
   * `combine()`을 그대로 따라간다 — 순서를 바꾸면 설명이 틀린다:
   *   ① 두 축이 다 있고 한계 이상 어긋남 → 거기서 바로 `null`이 된다
   *   ② 축을 하나도 못 냄
   *
   * ★ 셋째 길(`price = 0`)이 있었다 — 9/16에 42,530행 중 335행. 처음 쓴 판이 그중
   *   비츠로테크(차트 8,518원 · 재무 8,430원)에 *"두 축이 1.0배 어긋남"*이라고 적었다.
   *   2026-09-17부터 분석가가 **현재가 없는 행을 아예 안 남긴다**(`analyzeFairValue.ts`).
   */
  const chart = row.chart_mid;
  const fundamental = row.fundamental_mid;
  if (chart && fundamental) {
    const ratio = Math.max(chart, fundamental) / Math.min(chart, fundamental);
    if (ratio >= AXIS_DIVERGENCE_LIMIT) {
      return ` · 적정가 못 냄 — 두 축이 ${ratio.toFixed(1)}배 어긋남`
        + `(한계 ${AXIS_DIVERGENCE_LIMIT.toFixed(1)}배, 차트중앙 ${won(chart)} · 재무중앙 ${won(fundamental)}).`
        + ' 과거 배수가 더 이상 성립하지 않는 것이고, 데이터가 없는 것이 아니다';
    }
  }
  return ' · 적정가 못 냄 — 두 축을 하나도 못 냈다';
}

async function main(): Promise<void> {
  const accountId = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'VTS-ORDINARY';
  const account = getKisAccount(accountId);

  console.log(`=== 분석가 화면 · ${accountId} · ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} ===\n`);

  // ── 적정가 (분석가가 넣은 가장 최근 것) ──
  const { rows } = await pool.query<FairRow>(
    `SELECT DISTINCT ON (symbol)
            symbol, price, chart_mid, fundamental_mid, gap, basis, falling, news,
            EXTRACT(EPOCH FROM (now() - measured_at)) / 60 AS age_min
       FROM trading_fair_values
      WHERE measured_at > now() - interval '2 hours'
      ORDER BY symbol, measured_at DESC`,
  );
  const bySymbol = new Map(rows.map((r) => [r.symbol, r]));

  /*
   * ── 📝 분석가의 직전 노트 (2026-09-15) ────────────────────────────────────
   *
   * 분석가 루프가 매 바퀴 **모든 종목**을 보되 처음부터 다시 조사하지 않게, 오늘 마지막으로
   * 남긴 결론을 종목 줄마다 붙인다(`prompts/analyst.md` 6절). 노트는 회차 `findings`에
   * `agent: 'analyst-note'`로 들어간다 — 표를 새로 만들지 않았다.
   */
  interface NoteRow { symbol: string; verdict: string; reason: string; recheck: string; price: number | null; at: string }
  const notes = new Map((await pool.query<NoteRow>(
    `SELECT DISTINCT ON (f->>'symbol')
            f->>'symbol' AS symbol, f->>'verdict' AS verdict, f->>'reason' AS reason,
            coalesce(f->>'recheckIf', '') AS recheck, (f->>'price')::float8 AS price,
            to_char(d.created_at AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS at
       FROM trading_deliberations d, jsonb_array_elements(d.findings) f
      WHERE d.account_id = $1
        AND d.trading_day = (now() AT TIME ZONE 'Asia/Seoul')::date
        AND f->>'agent' = 'analyst-note'
      ORDER BY f->>'symbol', d.id DESC`,
    [accountId],
  ).catch(() => ({ rows: [] as NoteRow[] }))).rows.map((n) => [n.symbol, n]));
  const noteLine = (symbol: string, price: number | undefined): void => {
    const n = notes.get(symbol);
    if (!n) {
      console.log('      📝 노트 없음 — 오늘 처음 봅니다');
      return;
    }
    const moved = n.price && price ? ` → 지금 ${price >= n.price ? '+' : ''}${((price / n.price - 1) * 100).toFixed(1)}%` : '';
    console.log(`      📝 ${n.at} ${n.verdict}${n.price ? ` @${won(n.price)}` : ''}${moved} · ${n.reason}`
      + `${n.recheck ? ` · 다시 볼 조건: ${n.recheck}` : ''}`);
  };

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
      noteLine(p.symbol, bySymbol.get(p.symbol)?.price);
      // ★ "왜 떨어졌나"를 여기서 본다 — 지침이 약속한 그 뉴스다.
      for (const line of newsLines(bySymbol.get(p.symbol)?.news, true)) console.log(line);
    }
    console.log('  ★ ⭐는 "사라"가 아닙니다 — 층 상한·매수여력·plan을 세울 수 있는지는 당신이 봅니다.');
  }

  /** 분석가가 회차마다 남기는 훑음 기록(`risers-scan`·`catalyst-scan`) */
  interface ScanRecord { ran_at: Date; status: string; note: string; age_min: number }
  const lastScan = (name: string): Promise<ScanRecord | null | undefined> => pool.query<ScanRecord>(
    `SELECT ran_at, status, note, EXTRACT(EPOCH FROM (now() - ran_at)) / 60 AS age_min
       FROM trading_heartbeats
      WHERE name = $1 AND ran_at > now() - interval '2 hours'
      ORDER BY ran_at DESC LIMIT 1`,
    [name],
  ).then((r) => r.rows[0]).catch(() => null);

  /*
   * ── 📣 재료가 막 나온 종목 (2026-09-11) ──────────────────────────────────
   *
   * 사용자가 정했다 — *"오를만한 것들로 브리핑을 해줘야지 이미 오른 걸 가지고
   * 뭐하려고?"* 최근 2거래일 공시에 호재가 붙었는데 공시 직전 종가 대비 아직
   * +5% 넘게 안 움직인 종목이다(`trading/disclosureCatalyst.ts`).
   *
   * ★ 📈와 같은 규칙으로 "0건·못 훑음·기록 없음"을 가르고, 기록과 같은 시각의 줄만 읽는다.
   */
  interface CatalystRow {
    symbol: string; name: string; labels: string; title: string; published_day: string;
    published_time: string; correction: boolean; base_day: string; base_close: number;
    price: number; move: number; warnings: string; rule: string; news: NewsCell | null;
  }
  const catScan = await lastScan('catalyst-scan');
  console.log('\n── 📣 재료가 막 나온 종목 (공시 호재 · 공시 뒤 아직 덜 움직임) ──');
  if (catScan === null) {
    console.log('  ★ 📣 기록을 읽지 못했습니다 — 없다는 뜻이 아닙니다.');
  } else if (catScan === undefined) {
    console.log('  (최근 2시간에 분석가가 공시를 훑은 기록이 없습니다 — 없다는 뜻이 아닙니다. 장 밖에는 훑지 않습니다)');
  } else if (catScan.status !== 'ok') {
    console.log(`  ★ 이번 회차는 공시를 못 훑었습니다 — 없다는 뜻이 아닙니다 (${catScan.note})`);
  } else {
    const picks: CatalystRow[] | null = await pool.query<CatalystRow>(
      `SELECT symbol, name, labels, title, published_day, published_time, correction,
              base_day, base_close, price, move, warnings, rule, news
         FROM trading_catalyst_picks
        WHERE measured_at = $1
        ORDER BY published_day DESC, published_time DESC`,
      [catScan.ran_at],
    ).then((r) => r.rows).catch(() => null);
    const stale = catScan.age_min > STALE_MINUTES ? ` ⚠${Math.round(catScan.age_min)}분 전` : '';
    const md = (day: string): string => `${day.slice(4, 6)}/${day.slice(6, 8)}`;
    if (picks === null) {
      console.log('  ★ 📣 줄을 읽지 못했습니다 — 없다는 뜻이 아닙니다.');
    } else if (picks.length === 0) {
      console.log(`  없음${stale} — ${catScan.note}`);
    } else {
      console.log(`  기준: ${picks[0].rule}${stale}`);
      for (const c of picks) {
        const gap = fairGapLabel(bySymbol.get(c.symbol));
        console.log(
          `  📣 ${c.symbol} ${c.name} ${won(c.price)} · 공시 뒤 ${c.move >= 0 ? '+' : ''}${(c.move * 100).toFixed(1)}%`
          + ` (기준 ${md(c.base_day)} 종가 ${won(c.base_close)})${gap}`,
        );
        console.log(
          `      재료 [${c.labels}] ${md(c.published_day)} ${c.published_time.slice(0, 2)}:${c.published_time.slice(2, 4)}`
          + ` ${c.correction ? '(정정) ' : ''}${c.title}`,
        );
        if (c.warnings !== '') console.log(`      ⚠ 같은 기간 악재 공시: ${c.warnings}`);
        noteLine(c.symbol, c.price);
        for (const line of newsLines(c.news, true)) console.log(line);
      }
      console.log('  ★ 📣는 "재료가 나왔다"이지 "오른다"가 아닙니다 — 재료의 크기(공급계약은 매출 대비 금액)는 원문에만 있습니다.');
    }
  }

  /*
   * ── 📈 오늘 오르는 후보 (2026-09-11) ────────────────────────────────────
   *
   * 사용자가 정했다 — 정식 회차의 발굴기를 빠른 회차에도 보여준다. ⭐는 정의상
   * **떨어진 것**이라, 이 섹션이 없으면 빠른 판단자 앞에 오르는 종목이 오지 않는다.
   *
   * ★★ "0건"·"못 훑음"·"아직 안 훑음"을 가른다. 분석가가 회차마다 남기는 기록
   *    (`risers-scan`)이 어느 쪽인지 말하고, **그 기록과 같은 시각의 줄만** 읽는다 —
   *    0건인 회차에 옛 회차의 줄이 오늘 것처럼 보이면 안 된다.
   */
  interface RiserRow {
    symbol: string; name: string; price: number; change_rate: number; turnover: number;
    range_rate: number | null; rule: string; news: NewsCell | null;
  }
  // ★ `null`은 못 읽었다, `undefined`는 기록이 없다 — 둘 다 "0건"이 아니다.
  const scan = await lastScan('risers-scan');

  console.log('\n── 📈 오늘 오른 종목 (이미 오른 것 — 오른 이유가 1~2주 남을 때만 근거) ──');
  if (scan === null) {
    console.log('  ★ 📈 기록을 읽지 못했습니다 — 없다는 뜻이 아닙니다.');
  } else if (scan === undefined) {
    console.log('  (최근 2시간에 분석가가 훑은 기록이 없습니다 — 없다는 뜻이 아닙니다. 장 밖에는 훑지 않습니다)');
  } else if (scan.status !== 'ok') {
    console.log(`  ★ 이번 회차는 못 훑었습니다 — 없다는 뜻이 아닙니다 (${scan.note})`);
  } else {
    const risers: RiserRow[] | null = await pool.query<RiserRow>(
      `SELECT symbol, name, price, change_rate, turnover, range_rate, rule, news
         FROM trading_screening_risers
        WHERE measured_at = $1
        ORDER BY change_rate DESC`,
      [scan.ran_at],
    ).then((r) => r.rows).catch(() => null);
    const stale = scan.age_min > STALE_MINUTES ? ` ⚠${Math.round(scan.age_min)}분 전` : '';
    if (risers === null) {
      console.log('  ★ 📈 줄을 읽지 못했습니다 — 없다는 뜻이 아닙니다.');
    } else if (risers.length === 0) {
      console.log(`  없음 — 오늘 오른 개별주식 중 스크리너를 통과한 것이 없습니다${stale} (${scan.note})`);
    } else {
      console.log(`  기준: ${risers[0].rule}${stale}`);
      for (const r of risers) {
        // ★ 적정가 표에 있으면 함께 적는다 — 크게 +이면 이미 많이 오른 자리다.
        const gap = fairGapLabel(bySymbol.get(r.symbol));
        const range = r.range_rate === null ? '' : ` · 변동폭 ${r.range_rate.toFixed(2)}%`;
        // ★ 가격제한폭 근처는 팔 사람이 없어 체결이 어렵고 되돌림이 크다.
        const limitUp = r.change_rate >= LIMIT_UP_WARN ? ' · ⚠상한가 근처' : '';
        console.log(
          `  📈 ${r.symbol} ${r.name} ${won(r.price)} · +${r.change_rate.toFixed(2)}%`
          + ` · 거래대금 ${Math.round(r.turnover / 100_000_000).toLocaleString('ko-KR')}억${range}${gap}${limitUp}`,
        );
        noteLine(r.symbol, r.price);
        for (const line of newsLines(r.news, true)) console.log(line);
      }
      console.log('  ★ 📈는 "오른다"이지 "더 오른다"가 아닙니다 — 오른 이유(📰)가 1~2주 남을 때만 근거가 됩니다.');
    }
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
    let dropped = 0;
    const visible = sorted.filter((r) => {
      if (held.has(r.symbol) || starred.has(r.symbol)) return true;
      /*
       * ★★ **떨어지는 중인 후보는 이 25칸을 안 먹는다** (2026-09-10).
       *
       * 이 표는 gap 오름차순이라 25칸이 정의상 **가장 많이 떨어진 것들**로
       * 채워졌다. 판단자는 회차마다 그것을 읽고 같은 말을 남겼다 —
       * *"가장 싼 여섯(코오롱티슈진 −63.4%, HLB −31.3%)은 전부 '크게
       * 떨어졌다'이지 '싸다'가 아니다. 회차 542~595가 같은 이유로 걸렀다."*
       * (2026-09-09 회차 596)
       *
       * 그동안 급락이 아니면서 싼 후보는 25칸 **뒤로 밀려 안 보였다.** 자리를
       * 비켜 주는 것이 이 수정이다.
       *
       * ★ **보유와 ⭐는 위에서 이미 통과했다.** 들고 있는 것이 무너지는 중이면
       *   그것이야말로 봐야 하는 자리이고, ⭐는 애초에 이 판정으로 걸러진
       *   뒤에 뽑힌 것이다.
       */
      if (r.falling) { dropped += 1; return false; }
      if (shownCandidates < CANDIDATE_SHOWN) { shownCandidates += 1; return true; }
      hidden += 1;
      return false;
    });
    if (hidden > 0 || dropped > 0) {
      console.log(`  (보유 ${held.size} · ⭐ ${starred.size} · 그 밖에 싼 순으로 ${shownCandidates}종목을 보입니다`
        + ` — 문턱 밖 ${hidden}종목은 접었습니다)`);
    }
    /*
     * ★ **접은 것을 말한다.** 조용히 자르면 판단자는 그것이 전부인 줄 알고
     *   "후보가 이것뿐이다"라고 적는다 — 31번째가 조용히 사라졌던 멀티시세와
     *   같은 병이다. 그리고 이 필터가 너무 세게 걸리는 날이 오면 이 줄이
     *   그것을 먼저 보여 준다.
     */
    if (dropped > 0) {
      console.log(`  ★ 떨어지는 중인 ${dropped}종목은 후보에서 뺐습니다 — 시장 대비 60일로 급락 중이라`
        + ` "싸다"가 아니라 "떨어졌다"입니다(보유·⭐는 그대로 보입니다).`);
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
      // ★ 보유 개별주식은 "팔 이유(나쁜 뉴스)가 붙었나"를 여기서 본다.
      if (r.news !== null && r.news !== undefined) for (const line of newsLines(r.news, false)) console.log(line);
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
    /*
     * ★★ **총평가가 무엇으로 이루어졌는지 함께 적는다** (2026-09-10).
     *
     * 그전에는 `총평가 · 예수금(D+0) · 평가손익`만 찍었다. 판단자가 검산하면
     * **총평가 ≠ 보유 평가 합 + 예수금**이 되는데, 차이가 회차마다 4.88~4.95백만원
     * 으로 거의 고정이라 판단자는 그것을 **결함으로 의심하고 미결에 적었다.
     * 열네 회차째였다** — *"이 값이 틀리면 층 비중·자리 크기가 전부 틀린다."*
     *
     * 결함이 아니었다. 총평가는 **D+2 예수금**(`settlementCash`)으로 이루어지고
     * 화면에 찍히던 것은 **D+0**(`cashBalance`)이라, 그 둘의 차이가 그대로
     * 보였을 뿐이다(2026-09-10 실측: 33,573,826 − 28,650,344 = 4,923,482).
     *
     * ★ **셋을 나란히 적는다.** 값이 셋인 것을 숨기면 판단자는 매 회차 같은
     *   자리에서 같은 의심을 되풀이한다 — 검산할 수 있게 해 주는 것이 답이다.
     */
    const stock = snap.stockEvaluation ?? snap.positions.reduce((s, p) => s + (p.marketValue ?? 0), 0);
    console.log(`  총평가 ${won(snap.totalEvaluation ?? 0)} · 평가손익 ${pnl >= 0 ? '+' : ''}${won(pnl)}`);
    console.log(`    = 주식 ${won(stock)} + D+2 예수금 ${won(snap.settlementCash ?? 0)}`);
    console.log(`    지금 예수금(D+0) ${won(snap.cashBalance ?? 0)}`
      + ` — 총평가와 검산할 때는 위의 D+2를 쓴다`);
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
     * ★★ **운용 지침 — 빈 자리를 보인다** (2026-09-17). 사용자가 정했다: 단기 층이 비어
     *   있으면 후보를 기대값 순으로 사서 채운다(`prompts/analyst.md`). 그전엔 이 값이 화면에
     *   없어 분석가가 매번 따로 셌고, 층이 5.1%인 채로 4거래일 매수 0건이었다.
     *   값은 층 장부 수량 × 지금 현재가다(집행기 `layerValue`와 같은 재료).
     */
    const equity = snap.totalEvaluation ?? 0;
    const priceOf = new Map(snap.positions.map((p) => [p.symbol, p.currentPrice ?? 0]));
    const shortValue = (await getLayerPositions(accountId).catch(() => []))
      .filter((p) => p.layer === 'short')
      .reduce((s, p) => s + p.quantity * (priceOf.get(p.symbol) ?? 0), 0);
    if (equity > 0) {
      const room = Math.max(0, LAYER_CAP * equity - shortValue);
      console.log(`  ★ 단기 층 ${((shortValue / equity) * 100).toFixed(1)}% · 목표 ${LAYER_CAP * 100}%`
        + ` — 빈 자리 ${won(room)} (한 종목 최대 ${STOCK_CAP * 100}% = ${won(STOCK_CAP * equity)})`);
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
      noteLine(p.symbol, p.currentPrice);
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

await main().finally(closeDb);
