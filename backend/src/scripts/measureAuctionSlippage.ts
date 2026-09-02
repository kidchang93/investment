/**
 * **단일가에 얼마에 사고 팔리는지를 잰다.** 밤사이 전략의 승패가 여기서 갈린다.
 *
 * ── 왜 (2026-09-02) ──────────────────────────────────────────────────────
 *
 * 21년 측정에서 **종가 매수 → 익일 시가 매도**의 우위가 나왔다:
 *
 *   전날 거래대금 상위 100          밤사이 하루 +0.228% (t 16.1)
 *   거기서 장중 상승 상위 20%        하루 +0.294~0.512% (t 20~30)
 *
 * 그런데 **비용선이 정확히 그 자리에 있다.** 주식 매도 거래세만 0.20%이고
 * 수수료가 0.03%다 — **슬리피지가 0이어도 0.23%**라 상위 100은 본전이다.
 * 넘으려면 장중 급등 종목까지 사야 하는데, 그 종목이 **종가 단일가에 실제로
 * 붙는지**를 이 레포는 모른다.
 *
 * ── 무엇을 재나 ──────────────────────────────────────────────────────────
 *
 * 단일가 매매에는 슬리피지가 두 종류다.
 *
 *   ① **예측 오차** — 15:20~15:30에 내가 보는 것은 확정 종가가 아니라
 *      **예상체결가**다. 그것을 보고 주문하는데 실제 종가는 다르게 정해진다.
 *   ② **시장 충격** — 내 주문이 가격을 미는 것. 단일가는 가격이 하나로
 *      정해지므로 ②가 작다. 대신 **물량이 안 붙을 위험**이 있다.
 *
 * ①은 **주문 없이 잴 수 있다** — 예상체결가를 모아 두고 확정가와 대조하면 된다.
 * ②의 대리 지표로 **예상체결량**을 함께 기록한다(내가 사려는 수량이 그 안에
 * 들어가는지).
 *
 * ★ 이 레포의 실측 슬리피지 0.33%는 **얇은 종목의 성질**이었다. 같은 날 유동성
 *   종목 매수 5건은 평균 **+0.002%**였다(2026-08-03). 밤사이 전략은 거래대금
 *   상위만 사므로 뒤쪽에 가깝지만, **그건 시장가 기준이고 단일가는 아직 안 쟀다.**
 *
 * ── 쓰는 법 ──────────────────────────────────────────────────────────────
 *
 *   npx tsx src/scripts/measureAuctionSlippage.ts --close    # 15:20~15:30에 띄운다
 *   npx tsx src/scripts/measureAuctionSlippage.ts --open     # 08:30~09:00에 띄운다
 *   npx tsx src/scripts/measureAuctionSlippage.ts --report   # 쌓인 것을 집계한다
 *
 * ★ **며칠 모아야 한다.** 하루로는 표본이 20종목뿐이다.
 * ★ **창이 끝나면 확정가까지 받고 끝난다.** 처음에는 일봉과 대조하려 했는데
 *   KIS 일봉이 1~2영업일 지연이라(2026-08-24 수집이 08-21까지) 오늘 잰 것의
 *   답을 며칠 뒤에나 알게 된다. 그래서 자기완결로 바꿨다 —
 *   **중간에 끊으면 그날 확정가가 빈다.**
 *
 * 조회 전용이다. 주문을 내지 않는다.
 */

import { config } from '../config.js';
import { closeDb, pool } from '../db/client.js';
import { getAccessToken, primaryCredentials } from '../kis/auth.js';
import { getDomesticTurnoverRanking, getQuote } from '../kis/rest.js';

type Session = 'close' | 'open';

/** 몇 종목을 볼까. 모의 서버는 초당 1건이라 이 수와 간격이 서로 묶여 있다 */
const DEFAULT_SYMBOLS = 20;
/** 스냅샷 간격(초) */
const DEFAULT_INTERVAL = 60;

async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_auction_snapshots (
      symbol          TEXT   NOT NULL,
      trading_day     TEXT   NOT NULL,
      session         TEXT   NOT NULL,
      captured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      /* KST 'HHMM'. 마감에 가까울수록 예상가가 정확해지는지 보려면 이게 필요하다 */
      clock           TEXT   NOT NULL,
      expected_price  DOUBLE PRECISION,
      expected_volume BIGINT,
      current_price   DOUBLE PRECISION,
      /* 그날 시가 대비 지금까지의 등락 — 장중 상승 상위를 나중에 가르는 잣대 */
      day_open        DOUBLE PRECISION,
      PRIMARY KEY (symbol, trading_day, session, clock)
    );

    /*
     * ★ 확정가를 **여기에 직접 담는다.** 처음에는 일봉과 대조할 생각이었는데
     *   KIS 일봉이 **1~2영업일 지연**된다(2026-08-24 15:45 수집이 08-21까지만
     *   받았다). 그러면 오늘 잰 것의 답을 며칠 뒤에나 알게 되고, 그동안 이
     *   측정이 맞는지 모른 채 다음 날을 또 잰다.
     *
     *   그래서 창이 끝난 직후 확정가를 직접 받아 이 표에 담는다.
     */
    CREATE TABLE IF NOT EXISTS trading_auction_settled (
      symbol       TEXT NOT NULL,
      trading_day  TEXT NOT NULL,
      session      TEXT NOT NULL,
      settled_price DOUBLE PRECISION NOT NULL,
      captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (symbol, trading_day, session)
    );
  `);
}

interface Snap {
  expectedPrice: number | null;
  expectedVolume: number | null;
  currentPrice: number | null;
  dayOpen: number | null;
  marketPhase: string;
}

/**
 * 예상체결 스냅샷 하나. `FHKST01010200`.
 *
 * ★ 빈 문자열을 `Number()`에 그냥 넣지 않는다 — `Number('')`은 0이다.
 *   이 레포가 여러 번 당한 함정이라 여기서도 `null`로 돌린다.
 */
async function snapshot(code: string, token: string): Promise<Snap> {
  const url = new URL('/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn', config.restBase);
  url.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J');
  url.searchParams.set('FID_INPUT_ISCD', code);
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      appkey: primaryCredentials.appKey,
      appsecret: primaryCredentials.appSecret,
      tr_id: 'FHKST01010200',
      custtype: 'P',
    },
  });
  const json = (await res.json()) as { output2?: Record<string, string> };
  const o = json.output2 ?? {};
  const num = (v: string | undefined): number | null => {
    if (v === undefined || v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n !== 0 ? n : null;
  };
  return {
    expectedPrice: num(o.antc_cnpr),
    expectedVolume: num(o.antc_vol),
    currentPrice: num(o.stck_prpr),
    dayOpen: num(o.stck_oprc),
    marketPhase: o.antc_mkop_cls_code ?? '',
  };
}

function kstNow(): { day: string; clock: string; hhmm: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const clock = `${parts.hour}${parts.minute}`;
  return {
    day: `${parts.year}${parts.month}${parts.day}`,
    clock,
    hhmm: Number(clock),
  };
}

const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

async function collect(session: Session, symbolCount: number, intervalSec: number): Promise<void> {
  await ensureSchema();
  const token = await getAccessToken(primaryCredentials);

  // 창을 벗어나면 아무것도 하지 않는다. 잘못된 시각의 값이 섞이면 집계가 거짓이 된다.
  const window = session === 'close' ? [1519, 1531] : [829, 901];
  const now = kstNow();
  if (now.hhmm < window[0] || now.hhmm > window[1]) {
    console.error(
      `지금 ${now.clock}은 ${session === 'close' ? '종가' : '시가'} 단일가 창`
      + `(${window[0]}~${window[1]}) 밖이다. 그 시각에 띄운다.`,
    );
    process.exitCode = 1;
    return;
  }

  /*
   * ★ 대상은 **그 시점 거래대금 상위**다. 밤사이 전략이 사려는 바로 그 종목들이고,
   *   장중 상승률로 더 좁히는 것은 나중에 집계에서 한다(지금은 다 모아 둔다).
   */
  const symbols = await getDomesticTurnoverRanking(symbolCount);
  console.log(`${session === 'close' ? '종가' : '시가'} 단일가 수집 · 종목 ${symbols.length} · ${intervalSec}초 간격`);
  console.log(`대상 ${symbols.join(' ')}\n`);

  let round = 0;
  for (;;) {
    const t = kstNow();
    if (t.hhmm > window[1]) break;
    round += 1;
    let saved = 0;
    for (const code of symbols) {
      try {
        const s = await snapshot(code, token);
        await pool.query(
          `INSERT INTO trading_auction_snapshots
             (symbol, trading_day, session, clock, expected_price, expected_volume, current_price, day_open)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (symbol, trading_day, session, clock) DO NOTHING`,
          [code, t.day, session, t.clock, s.expectedPrice, s.expectedVolume, s.currentPrice, s.dayOpen],
        );
        saved += 1;
      } catch (error) {
        console.log(`  ${code} 실패 — ${(error as Error).message.slice(0, 80)}`);
      }
    }
    console.log(`[${t.clock}] ${round}회차 · ${saved}/${symbols.length}종목 저장`);
    await delay(intervalSec * 1000);
  }

  /*
   * ★ 창이 끝나면 **확정가를 바로 받는다.** 종가 세션은 마감 뒤 현재가가 곧
   *   종가이고, 시가 세션은 개장 뒤 `stck_oprc`가 곧 시가다. 일봉을 기다리면
   *   1~2영업일이 뜬다.
   */
  console.log('\n창이 끝났다. 확정가를 받는다…');
  await delay(session === 'close' ? 90_000 : 60_000);
  await settlePrices(session, symbols);
}

/**
 * 확정가를 받아 담는다.
 *
 * ── ★★ 예상체결 TR을 쓰면 안 된다 (2026-09-02 실측) ─────────────────────
 *
 * 처음에는 같은 `snapshot()`(예상체결 TR)으로 받았는데 **20종목 중 4개만**
 * 들어왔다. 15:34는 **마감 후**라 그 TR의 `output2`가 빈 값을 준다 — 그리고
 * `catch {}`가 그것을 조용히 삼켜 **왜 빠졌는지 알 수도 없었다.**
 *
 * 확정가는 **정규 현재가 조회**(`getQuote`)로 받는다. 마감 후에도 종가를 준다.
 * 시가 세션은 `open` 필드가 그날 시가다.
 *
 * ★ 실패를 세어서 말한다. 조용히 빠지면 표본이 왜 작은지 모른 채 결론을 낸다.
 */
async function settlePrices(session: Session, symbols: string[]): Promise<void> {
  const day = kstNow().day;
  let settled = 0;
  const failed: string[] = [];
  for (const code of symbols) {
    try {
      const quote = await getQuote(code);
      const price = session === 'close' ? quote.price : quote.open;
      if (!(price > 0)) { failed.push(`${code}(가격 0)`); continue; }
      await pool.query(
        `INSERT INTO trading_auction_settled (symbol, trading_day, session, settled_price)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (symbol, trading_day, session) DO UPDATE SET settled_price = EXCLUDED.settled_price`,
        [code, day, session, price],
      );
      settled += 1;
    } catch (error) {
      failed.push(`${code}(${(error as Error).message.slice(0, 40)})`);
    }
  }
  console.log(`확정가 ${settled}/${symbols.length}종목 저장. 집계: --report`);
  if (failed.length > 0) console.log(`  못 받은 것: ${failed.join(' · ')}`);
}

/**
 * 쌓인 것을 집계한다.
 *
 * **예측 오차 = (확정가 / 예상가) − 1.** 종가 단일가는 그날 `close`가 확정가이고,
 * 시가 단일가는 그날 `open`이다.
 */
async function report(): Promise<void> {
  await ensureSchema();
  const { rows } = await pool.query<{
    session: string; clock: string; n: string; mean_err: string; abs_err: string; p90: string;
  }>(
    `
    /* 마감 전 마지막 값만 쓴다 — 아래 clock 조건이 그것이다.
       종가 세션의 15:30·15:31 스냅샷은 이미 마감된 뒤라 그때 값으로 오차를 재면
       "주문할 때 내가 본 값"이 아니다. 주문은 15:30 전에 넣어야 하므로
       종가는 15:29까지, 시가는 08:59까지가 우리가 아는 전부다. */
    WITH last_snap AS (
      SELECT DISTINCT ON (symbol, trading_day, session)
             symbol, trading_day, session, clock, expected_price, expected_volume
        FROM trading_auction_snapshots
       WHERE expected_price IS NOT NULL
         AND ((session = 'close' AND clock <= '1529') OR (session = 'open' AND clock <= '0859'))
       ORDER BY symbol, trading_day, session, clock DESC
    ),
    joined AS (
      SELECT s.session, s.clock, t.settled_price AS settled, s.expected_price
        FROM last_snap s
        JOIN trading_auction_settled t
          ON t.symbol = s.symbol AND t.trading_day = s.trading_day AND t.session = s.session
       WHERE t.settled_price > 0
    )
    SELECT session,
           max(clock)                                        AS clock,
           count(*)::text                                     AS n,
           (avg(settled / expected_price - 1))::text          AS mean_err,
           (avg(abs(settled / expected_price - 1)))::text      AS abs_err,
           (percentile_cont(0.9) WITHIN GROUP
             (ORDER BY abs(settled / expected_price - 1)))::text AS p90
      FROM joined
     GROUP BY session
    `,
  );

  if (rows.length === 0) {
    const { rows: raw } = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM trading_auction_snapshots',
    );
    console.log(`아직 집계할 것이 없다 (스냅샷 ${raw[0]?.n ?? 0}건).`);
    console.log('수집기가 창이 끝난 뒤 확정가까지 담는다 — 중간에 끊으면 그 부분이 빈다.');
    return;
  }

  console.log('단일가 예측 오차 — 마지막 스냅샷의 예상체결가 대비 확정가\n');
  console.log('구간'.padEnd(10) + '표본'.padStart(8) + '평균오차'.padStart(12) + '절대오차'.padStart(12) + '90분위'.padStart(12));
  console.log('─'.repeat(56));
  for (const r of rows) {
    const p = (v: string): string => `${(Number(v) * 100).toFixed(3)}%`;
    console.log(
      (r.session === 'close' ? '종가' : '시가').padEnd(10)
      + r.n.padStart(8)
      + p(r.mean_err).padStart(12)
      + p(r.abs_err).padStart(12)
      + p(r.p90).padStart(12),
    );
  }
  console.log(
    '\n★ **절대오차**가 실질 슬리피지에 가깝다 — 부호와 무관하게 내가 본 값과'
    + '\n  실제 값이 벌어진 크기다. 평균오차는 방향(체계적으로 높거나 낮게 정해지나)을 본다.'
    + '\n★ 밤사이 전략의 본전선은 왕복 0.223%이고 그중 세금·수수료가 이미 0.23%다.'
    + '\n  즉 **여기 오차가 0에 가까워야** 급등주 선별분(+0.07~0.28%)이 남는다.',
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--report')) {
    await report();
    return;
  }
  /*
   * ★ 확정가만 다시 받는다. 수집은 됐는데 확정가가 빠진 날을 살린다 —
   *   2026-09-02에 예상체결 TR로 받다가 16종목을 놓쳤고, 스냅샷은 멀쩡했다.
   */
  if (args.includes('--settle')) {
    await ensureSchema();
    const session: Session = args.includes('--open') ? 'open' : 'close';
    const { rows } = await pool.query<{ symbol: string }>(
      `SELECT DISTINCT symbol FROM trading_auction_snapshots
        WHERE session = $1 AND trading_day = $2 ORDER BY symbol`,
      [session, kstNow().day],
    );
    if (rows.length === 0) { console.log('오늘 그 세션의 스냅샷이 없습니다.'); return; }
    console.log(`${session} 확정가를 다시 받는다 · ${rows.length}종목`);
    await settlePrices(session, rows.map((r) => r.symbol));
    return;
  }
  const session: Session | null = args.includes('--close') ? 'close' : args.includes('--open') ? 'open' : null;
  if (!session) {
    console.error('--close · --open · --report 중 하나를 준다.');
    process.exitCode = 1;
    return;
  }
  const symbolsArg = args.indexOf('--symbols');
  const intervalArg = args.indexOf('--interval');
  await collect(
    session,
    symbolsArg >= 0 ? Number(args[symbolsArg + 1]) : DEFAULT_SYMBOLS,
    intervalArg >= 0 ? Number(args[intervalArg + 1]) : DEFAULT_INTERVAL,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
