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
 *   npx tsx src/scripts/warmFinancialCache.ts [--limit 150] [--force]
 *     `--force`면 아직 안 낡은 것도 다시 받는다.
 */

import '../config.js';

import { closeDb, pool } from '../db/client.js';
import { getTopTurnoverInstruments } from '../db/instruments.js';
import { getFinancials } from '../kis/rest.js';
import { classifyAsset } from '../trading/fairValue.js';

/** 분석가의 후보 풀과 같은 값. 그보다 적게 채우면 분석가가 장중에 마저 받는다 */
const DEFAULT_LIMIT = 150;
/** `analyzeFairValue.ts`의 `FINANCIAL_TTL_HOURS`와 같아야 한다 */
const TTL_HOURS = 12;
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
  }
  console.log(`받음 ${ok} · 재무 없음 ${empty} · 실패 ${failed}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
