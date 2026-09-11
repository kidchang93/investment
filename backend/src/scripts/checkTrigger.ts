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
import { sessionElapsedRatio } from '../trading/universe.js';

const accountId = process.argv[2] ?? 'VTS-ORDINARY';
const account = getKisAccount(accountId);
if (!account) {
  console.error(`등록되지 않은 계좌: ${accountId}`);
  process.exit(1);
}

/*
 * ★★ **직전 "정식" 회차와 견준다** (2026-09-11). 그전에는 종류를 가리지 않고 가장
 *    최근 회차(limit 1)를 기준으로 삼았다. 9/3에 5분 빠른 회차가 생긴 뒤로 그 기준은
 *    **늘 몇 분 전**이 됐고, 몇 분 사이엔 아무것도 안 변하니 정식 회차가 매번
 *    "사건 없음 — 가벼운 회차"로 스스로를 격하했다:
 *
 *      9/8   "직전 회차 #114가 1분 전에 이미 다뤘다 — 가벼운 회차로 남긴다"
 *      9/11  "직전 #1261 이후 3분, 보유 ±0.2% 이내 — 가벼운 회차"
 *
 *    매수 10건은 전부 정식·사건 회차에서 나왔는데 **9/7 이후 0건**이었다.
 *    빠른 회차(`fair-value`)는 기준에서 뺀다 — 보유·⭐만 보는 자리라 정식 회차가
 *    한 일을 대신하지 않는다. 200건(상한)을 읽어 하루치 빠른 회차를 넘긴다.
 */
const [previous] = (await getDeliberations({ accountId: account.id, limit: 200 }))
  .filter((round) => round.trigger !== 'fair-value');
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

/*
 * ★ **아직 안 붙은 주문.** 값이 안 움직여도 "걸어 둔 값에 안 붙는다"는 것이
 *   판단할 거리다 — 2026-08-20에 지정가 두 건 중 하나가 종일 미체결이었는데
 *   정정할지 취소할지 그대로 둘지 **아무도 정하지 않았다.**
 *
 * 오늘 것만 본다. 어제 미체결은 그날 장 마감에 이미 실효됐다.
 */
const todayKst = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' })
  .format(new Date())
  .replace(/-/g, '');
const openOrders = (executionSnapshot?.executions ?? [])
  /*
   * ★ **`status`만 보면 안 된다.** 취소된 원주문이 `open`인 채 잔량만 0으로
   *   남는다(2026-08-20 11:01, 삼성전자 취소 뒤 실측). 그대로 두면 오후 재소집이
   *   **이미 없는 주문 때문에** 판단자를 부른다 — 헤드리스 Claude가 헛돈다.
   */
  .filter((e) => e.status === 'open' && e.remainQuantity > 0 && e.orderDate === todayKst)
  .map((e) => {
    const t = (e.orderTime ?? '000000').padStart(6, '0');
    const d = e.orderDate;
    // KST로 못박아 읽는다. 시간대를 안 적으면 이 프로세스의 지역 시간으로 읽힌다.
    const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
      + `T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}+09:00`;
    return { symbol: e.symbol, side: e.side, placedAt: new Date(iso).getTime() };
  });

const verdict = checkDeliberationTrigger({
  reference: previous?.reference ?? null,
  now,
  newFills,
  openOrders,
  now_ms: Date.now(),
  sessionElapsed: sessionElapsedRatio(),
});

const kst = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
console.log(`# 사건 판정 · ${kst} KST · 계좌 ${account.id}`);
console.log(
  `문턱: 보유 ±${TRIGGER_THRESHOLDS.positionMovePercent}% · 지수 ±${TRIGGER_THRESHOLDS.indexMovePercent}%`
  + ` · 체결/거절 · 미체결(장 ${TRIGGER_THRESHOLDS.staleOrderSessionRatio * 100}% 경과 후 ${TRIGGER_THRESHOLDS.minOpenOrderMinutes}분 이상)`
  + `\n미체결 ${openOrders.length}건 · 장 경과 ${(sessionElapsedRatio() * 100).toFixed(0)}%\n`,
);

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
/*
 * ★★ **사건이 없어도 발굴은 한다** (2026-09-11). 판단자는 이 한 줄을 따른다 —
 *    `deliberate.md`에는 "가벼운 회차"라는 말이 없고, 옛 문구 "가벼운 회차만
 *    남긴다"가 300종목 발굴을 건너뛰게 한 **유일한 출처**였다. 사건은 **보유를
 *    깊이 다시 볼지**만 정한다. 하루 한 번 넓게 조사하는 것이 정식 회차의 일이다
 *    (USER_DECISIONS 자동화 표). ★ 이 문구를 grep하는 코드는 없다(2026-09-11 확인).
 */
console.log(verdict.fire
  ? '▶ 사건 있음 — 에이전트를 소집한다'
  : '▶ 사건 없음 — 보유 재점검은 가볍게 한다. ★ 발굴(브리핑·screenCandidates)은 그대로 한다 — 정식 회차의 일이다');
for (const reason of verdict.reasons) console.log(`  · ${reason}`);

/*
 * 다음 회차의 기준선으로 그대로 쓸 수 있게 찍어 준다. 손으로 옮겨 적으면 틀린다.
 */
console.log('\n## reference (이번 회차 기록에 그대로 넣을 것)');
console.log(JSON.stringify({ ...now }));

process.exit(verdict.fire ? 10 : 0);
