/**
 * **지금 회의를 열어야 하는가**를 직전 회차와 견줘 판정한다.
 *
 * 정기 회차가 매번 부르는 입구다. 암산으로 하면 문턱을 그때그때 다르게 읽게 된다 —
 * "−1.49%면 1.5%나 마찬가지지"가 바로 그 모양이고, 그렇게 한 번 열면 다음부터
 * 문턱은 없는 것이 된다. **판정은 코드가 한다.**
 *
 * 조회 전용이다. 주문을 내지 않고 회차를 남기지도 않는다.
 *
 *   npx tsx src/scripts/checkTrigger.ts [계좌id]
 */

import { getKisAccount } from '../config.js';
import { getDeliberations } from '../db/deliberations.js';
import {
  DOMESTIC_INDEX_CODES,
  getDomesticIndex,
  getKisDomesticAccountSnapshot,
  getKisDomesticExecutions,
} from '../kis/rest.js';
import { checkDeliberationTrigger, TRIGGER_THRESHOLDS } from '../trading/deliberationTrigger.js';

const accountId = process.argv[2] ?? 'VTS-ORDINARY';
const account = getKisAccount(accountId);
if (!account) {
  console.error(`등록되지 않은 계좌: ${accountId}`);
  process.exit(1);
}

const [previous] = await getDeliberations({ accountId: account.id, limit: 1 });
const snapshot = await getKisDomesticAccountSnapshot(account);

const prices: Record<string, number> = {};
for (const p of snapshot.positions) {
  // 현재가가 없으면 넣지 않는다. 0으로 채우면 −100% 급변으로 읽힌다.
  const price = p.currentPrice;
  if (typeof price === 'number' && price > 0) prices[p.symbol] = price;
}

const now: { kospi?: number; kosdaq?: number; prices: Record<string, number> } = { prices };
for (const [key, code] of [['kospi', DOMESTIC_INDEX_CODES.kospi], ['kosdaq', DOMESTIC_INDEX_CODES.kosdaq]] as const) {
  try {
    now[key] = (await getDomesticIndex(code)).value;
  } catch {
    /* 못 얻으면 넣지 않는다. 0으로 채우면 −100% 급변으로 읽힌다 */
  }
}

/*
 * 직전 회차 **이후**에 생긴 체결·거절만 센다. 오늘 것을 전부 세면 이미 다룬
 * 체결에 매번 다시 깨어난다.
 *
 * ★ **날짜를 반드시 함께 본다.** 시각(`HHMMSS`)만 비교하면 **어제 14:53 체결이
 * 오늘 09:49보다 늦다**고 판정된다 — 2026-08-06 첫 실사용에서 실제로 그렇게
 * 오경보 13건이 났다. `days=1`이 어제~오늘을 주므로 어제 체결이 늘 섞여 있다.
 * `deliberationState.ts`가 같은 부류의 버그로 어제 주문을 오늘로 세던 것과 같다.
 */
const executionSnapshot = await getKisDomesticExecutions(account, 1).catch(() => null);

/** `YYYYMMDDHHMMSS`로 만들어 문자열 비교한다. 자릿수가 고정이라 사전순이 시간순이다 */
function stampOf(date: string, time: string | undefined): string {
  return `${date}${(time ?? '000000').padStart(6, '0')}`;
}
const previousStamp = previous
  ? (() => {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Seoul',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).formatToParts(new Date(previous.startedAt));
      const v = Object.fromEntries(parts.map((x) => [x.type, x.value]));
      return `${v.year}${v.month}${v.day}${v.hour}${v.minute}${v.second}`;
    })()
  : null;

const newFills = (executionSnapshot?.executions ?? [])
  .filter((e) => previousStamp !== null && stampOf(e.orderDate, e.orderTime) > previousStamp)
  .map((e) => ({ symbol: e.symbol, side: e.side, status: e.status }));

const verdict = checkDeliberationTrigger({
  reference: previous?.reference ?? null,
  now,
  newFills,
});

const kst = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
console.log(`# 사건 판정 · ${kst} KST · 계좌 ${account.id}`);
console.log(`문턱: 보유 ±${TRIGGER_THRESHOLDS.positionMovePercent}% · 지수 ±${TRIGGER_THRESHOLDS.indexMovePercent}% · 체결/거절\n`);

if (!previous) {
  console.log('직전 회차 없음 — 기준선이 없다. 값 변화로는 열지 않는다(첫 회차는 정기가 연다).');
} else {
  const at = new Date(previous.startedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
  console.log(`직전 회차 #${previous.id} · ${at}`);
  const line = (label: string, from: number | undefined, to: number | undefined): void => {
    if (from === undefined || to === undefined || !(from > 0)) {
      console.log(`  ${label.padEnd(10)} 기준선 또는 현재값 없음 — 건너뜀`);
      return;
    }
    const move = (to / from - 1) * 100;
    console.log(
      `  ${label.padEnd(10)} ${from.toFixed(2)} → ${to.toFixed(2)}`
      + `  ${move >= 0 ? '+' : ''}${move.toFixed(3)}%`,
    );
  };
  line('코스피', previous.reference.kospi, now.kospi);
  line('코스닥', previous.reference.kosdaq, now.kosdaq);
  for (const [symbol, price] of Object.entries(prices)) {
    line(symbol, previous.reference.prices[symbol], price);
  }
  if (Object.keys(prices).length === 0) console.log('  보유       없음 (전액 현금)');
  console.log(`  새 체결·거절 ${newFills.length}건`);
}

console.log();
console.log(verdict.fire ? '▶ 사건 있음 — 에이전트를 소집한다' : '▶ 사건 없음 — 가벼운 회차만 남긴다');
for (const reason of verdict.reasons) console.log(`  · ${reason}`);

/*
 * 다음 회차의 기준선으로 그대로 쓸 수 있게 찍어 준다. 손으로 옮겨 적으면 틀린다.
 */
console.log('\n## reference (이번 회차 기록에 그대로 넣을 것)');
console.log(JSON.stringify({ ...now }));

process.exit(verdict.fire ? 10 : 0);
