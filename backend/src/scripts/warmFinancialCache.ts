/**
 * **재무를 미리 받아 둔다.** 분석가가 장중에 KIS를 두들기지 않게 하는 자리다.
 *
 * ── 왜 (2026-09-03) ──────────────────────────────────────────────────────
 *
 * 사용자가 정했다 — *"회차가 돌게 되면 시간 너무 많이 허비해서 안 되고 분석가를
 * 더 심층적으로 다루는 게 좋을 것 같은데?"*
 *
 * 맞다. 정식 회차는 13분 + 헤드리스 Claude 값이고, 분석가는 **Claude를 안 부르고**
 * 5분마다 돈다. 발굴을 분석가 쪽으로 옮기는 것이 싸다.
 *
 * 그런데 후보를 150종목으로 넓히자 **한 회차가 10분을 넘겼다**(실측). 병목은
 * 계산이 아니라 **종목당 KIS 재무 조회**였다. 게다가 장중에 그렇게 두들기면
 * 다른 조회가 `EGW00201`(초당 호출 한도)로 막힌다 — 그날 실제로 계좌 조회가
 * 막혔다.
 *
 * ★ 재무는 **분기마다 바뀐다.** 5분마다 다시 받을 이유가 없고, 장중에 받을
 *   이유는 더 없다. 개장 전에 한 번 채워 두면 분석가는 **DB만 읽어** 빨라진다.
 *
 * ★ `analyzeFairValue.ts`와 **같은 표**(`trading_financial_cache`)를 쓴다.
 *   TTL도 그쪽 상수와 맞춰 12시간이다 — 여기서 채운 것을 그쪽이 그대로 읽는다.
 *
 *   npx tsx src/scripts/warmFinancialCache.ts [--limit 900] [--force]
 *     `--force`면 아직 안 낡은 것도 다시 받는다.
 */

import '../config.js';

import { closeDb, pool } from '../db/client.js';
import { getTopTurnoverInstruments } from '../db/instruments.js';
import { getFinancials } from '../kis/rest.js';
import { FINANCIAL_TTL_HOURS, classifyAsset } from '../trading/fairValue.js';

/**
 * 거래대금 상위 이만큼을 채운다.
 *
 * ── 왜 150에서 900으로 넓혔나 (2026-09-09) ───────────────────────────────
 *
 * 사용자가 물었다 — *"전체 종목을 스캔하는 게 맞아?"*
 *
 * 재보니 국내 개별주식 2,765종목 중 **155종목(5.6%)**만 보고 있었다. 그런데
 * 그냥 전부로 넓히면 헛돈다. **적정가는 차트·재무 두 축의 평균인데 재무가
 * 없으면 차트 하나로만 낸다** — 그러면 gap이 곧 "낙폭"이 되고, 판단자는
 * 무너진 종목의 순위표를 받는다. 실제로 그날 판단자가 그렇게 적었다:
 * *"코오롱티슈진 −63.5% ... 여전히 '크게 떨어졌다'이지 '싸다'가 아니다."*
 *
 * 그러니 **후보를 넓히기 전에 재무부터 채운다.** 이 스크립트가 그 자리다.
 *
 * ★ **어디까지 채우나** — 20일 평균 거래대금 10억 이상이 895종목이다. 총자산
 *   9,600만원에 한 종목 상한 10%(960만원)를 넣으려면 그 정도는 돌아야 한다.
 *   하루 거래대금 1억짜리에 960만원을 넣으면 그날 거래의 10%가 되어 사고
 *   파는 값 자체를 우리가 밀어 올린다. 그 아래는 **사도 못 파는 종목**이다.
 */
const DEFAULT_LIMIT = 900;
/** ★ 받는 쪽과 읽는 쪽이 같아야 해서 `trading/fairValue.ts`에 모아 두었다 */
const TTL_HOURS = FINANCIAL_TTL_HOURS;
/**
 * 조회 사이 간격(ms). KIS는 **초당** 호출을 센다 — 붙여 쏘면 `EGW00201`이 난다.
 * 개장 전이라 급할 것이 없으니 넉넉히 둔다.
 */
const GAP_MS = 120;

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const limArg = args.indexOf('--limit');
  const limit = limArg >= 0 ? Number(args[limArg + 1]) || DEFAULT_LIMIT : DEFAULT_LIMIT;

  const ranked = await getTopTurnoverInstruments(['stock'], limit);
  const targets = ranked.filter((i) => classifyAsset(i.name, i.assetType) === 'stock');

  const { rows: fresh } = await pool.query<{ symbol: string }>(
    `SELECT symbol FROM trading_financial_cache
      WHERE fetched_at > now() - ($1 || ' hours')::interval`,
    [String(TTL_HOURS)],
  );
  const cached = new Set(fresh.map((r) => r.symbol));
  const todo = force ? targets : targets.filter((i) => !cached.has(i.symbol));

  console.log(
    `거래대금 상위 ${limit} 중 개별주식 ${targets.length}종목`
    + ` · 이미 신선한 것 ${targets.length - todo.length} · 받을 것 ${todo.length}`,
  );
  if (todo.length === 0) return;

  let ok = 0;
  let empty = 0;
  let failed = 0;
  /*
   * ★ **얼마나 남았는지 말한다.** 900종목이면 십수 분이 걸린다 — 조용하면
   *   멎은 것인지 도는 것인지 알 수 없고, 사람은 그때 죽여 버린다.
   */
  const startedAt = Date.now();
  let done = 0;
  for (const inst of todo) {
    try {
      const fins = await getFinancials(inst.symbol, 8);
      /*
       * ★ **빈 응답도 캐시한다.** 재무가 없는 종목(신규상장·관리종목)은 몇 번을
       *   물어도 없다. 안 넣으면 5분마다 그 종목만 계속 KIS를 두들긴다.
       */
      await pool.query(
        `INSERT INTO trading_financial_cache (symbol, payload, fetched_at) VALUES ($1, $2, now())
         ON CONFLICT (symbol) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
        [inst.symbol, JSON.stringify(fins)],
      );
      if (fins.length > 0) ok += 1; else empty += 1;
    } catch (error) {
      failed += 1;
      /*
       * ★ 실패는 **캐시하지 않는다.** 빈 응답("이 종목엔 재무가 없다")과
       *   조회 실패("지금 못 받았다")는 다른 사실이다 — 실패를 넣으면 다음
       *   12시간 동안 있는 재무를 없다고 읽는다.
       */
      if (failed <= 3) console.log(`  ${inst.symbol} ${inst.name}: ${(error as Error).message.slice(0, 60)}`);
    }
    await sleep(GAP_MS);
    done += 1;
    if (done % 100 === 0 || done === todo.length) {
      const perItem = (Date.now() - startedAt) / done;
      const leftMin = Math.round((todo.length - done) * perItem / 60_000);
      console.log(
        `  ${done}/${todo.length} · 받음 ${ok} · 재무 없음 ${empty} · 실패 ${failed}`
        + ` · 종목당 ${(perItem / 1000).toFixed(2)}초 · 남은 시간 약 ${leftMin}분`,
      );
    }
  }
  const tookMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
  console.log(`받음 ${ok} · 재무 없음 ${empty} · 실패 ${failed} · ${tookMin}분 걸렸다`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
