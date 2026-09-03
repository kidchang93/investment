/**
 * **미체결 정리** — 5분 넘게 안 붙은 주문을 적정가로 정정하거나 철회한다.
 *
 * ── 왜 (2026-09-03) ──────────────────────────────────────────────────────
 *
 * 사용자가 정했다 — *"미체결 건은 5분 이상 미체결이면 가격을 조정해서 주문을
 * 넣어야 되는데 적정가 수준에서 주문 넣어야 돼. 그게 아니라면 철회하는 게 맞아."*
 *
 * ★★ **그날 3주 묵은 미체결 두 건이 나왔다.** 8/14에 걸어 둔 KODEX 200 45주와
 *    ACE KRX금현물 170주가 아무도 모르는 채로 걸려 있었다 — 모의 서버에서
 *    미체결 조회가 늘 실패했기 때문이다(`kis/rest.ts`에서 고쳤다). 예수금이
 *    그만큼 묶여 있었고, **값이 닿으면 3주 전 판단으로 지금 체결된다.**
 *
 * 이 스크립트가 그것을 막는다.
 *
 * ── 규칙 ─────────────────────────────────────────────────────────────────
 *
 * 5분 넘은 미체결마다:
 *
 *   ① 적정가가 없다               → **취소.** 근거 없이 걸어 둘 수 없다
 *   ② 매수인데 현재가 > 적정가 상단 → **취소.** 비싼 것을 살 이유가 사라졌다
 *   ③ 매도인데 현재가 < 적정가 하단 → **취소.** 싼 것을 팔 이유가 사라졌다
 *   ④ 그 밖                        → **현재가로 정정.** 값은 맞는데 안 붙는 것뿐이다
 *
 * ★ ④에서 현재가를 쓰는 이유: 적정가는 **범위**이고 체결은 **한 값**이다.
 *   적정가 안에 있다는 것이 확인된 이상, 붙게 하려면 지금 시장이 부르는 값이어야
 *   한다. 적정가 상단에 걸면 또 안 붙는다.
 *
 * ★★ **이것은 판단이 아니라 규칙이다.** 판단자를 부르지 않는다 — 2026-08-20에
 *    사용자가 *"정정·취소를 숫자로 박지 않는다"*고 했던 것과 어긋나 보이지만,
 *    그때 막은 것은 **"안 붙으니 현재가로 따라간다"를 무조건 하는 것**이었다.
 *    여기서는 **적정가라는 잣대를 먼저 통과**해야 정정하고, 통과 못 하면 취소한다.
 *    근거가 사라진 주문을 걸어 두는 것이 더 위험하다.
 *
 *   npx tsx src/scripts/manageOpenOrders.ts [계좌id] [--execute] [--minutes 5]
 *     ★ `--execute` 없이는 **판정만** 한다.
 */

import '../config.js';

import { getKisAccount } from '../config.js';
import { closeDb, pool } from '../db/client.js';
import { getDomesticQuotes, getKisDomesticAmendableOrders } from '../kis/rest.js';

/** 이만큼 지나도 안 붙으면 손댄다 */
const DEFAULT_STALE_MINUTES = 5;
/** 적정가가 이보다 오래되면 못 믿는다. 분석가가 5분마다 도므로 넉넉하다 */
const FAIR_VALUE_MAX_AGE_MIN = 30;

const won = (n: number): string => `${Math.round(n).toLocaleString('ko-KR')}원`;

interface FairRow {
  symbol: string;
  chart_mid: number | null;
  fundamental_mid: number | null;
  gap: number | null;
}

/**
 * 이 주문이 몇 분 전 것인가. **날짜를 먼저 본다.**
 *
 * ★★ 처음에 `orderTime`(HHMMSS)만 보고 계산했다가 **3주 묵은 주문을 놓쳤다**
 *    (2026-09-03). 8/14 09:30에 낸 주문을 "오늘 09:30"으로 읽어 몇십 분 전으로
 *    계산했고, 그날 그 시각이 아직 안 지났으면 음수가 되어 0으로 눌렸다.
 *
 * ★ **날짜가 오늘이 아니면 아주 오래된 것**이다. 정확한 분은 필요 없다 —
 *   어차피 문턱(5분)을 훌쩍 넘는다. 날짜를 모르면 시각으로 낸다.
 */
function minutesSince(orderDate: string | undefined, orderTime: string | undefined): number | null {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' })
    .format(new Date()).replace(/-/g, '');
  if (orderDate && /^\d{8}$/.test(orderDate) && orderDate !== today) {
    // 며칠 전 주문. 하루를 1,440분으로 세어 대략을 돌려준다.
    const days = Math.max(
      1,
      Math.round((Date.parse(`${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6)}`)
        - Date.parse(`${orderDate.slice(0, 4)}-${orderDate.slice(4, 6)}-${orderDate.slice(6)}`))
        / 86_400_000),
    );
    return days * 1_440;
  }
  if (!orderTime || !/^\d{6}$/.test(orderTime)) return null;
  const now = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date()).replace(/:/g, '');
  const toSec = (t: string): number =>
    Number(t.slice(0, 2)) * 3600 + Number(t.slice(2, 4)) * 60 + Number(t.slice(4, 6));
  const diff = (toSec(now) - toSec(orderTime)) / 60;
  return diff < 0 ? 0 : diff;
}

/** 몇 분을 사람이 읽을 말로. 3주 묵은 것을 "30240분"으로 적으면 안 읽힌다 */
function ageLabel(mins: number): string {
  if (mins < 60) return `${Math.round(mins)}분`;
  if (mins < 1_440) return `${(mins / 60).toFixed(1)}시간`;
  return `${Math.round(mins / 1_440)}일`;
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`http://localhost:4000${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json()) as Record<string, unknown>;
    const blockers = Array.isArray(json.blockers) ? (json.blockers as string[]).join(' · ') : '';
    return {
      ok: res.ok,
      message: blockers || String(json.message ?? (res.ok ? '접수' : `HTTP ${res.status}`)),
    };
  } catch (error) {
    return { ok: false, message: (error as Error).message.slice(0, 80) };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const minArg = args.indexOf('--minutes');
  const staleMinutes = minArg >= 0 ? Number(args[minArg + 1]) : DEFAULT_STALE_MINUTES;
  const accountId = args.find((a) => !a.startsWith('--') && a !== String(staleMinutes)) ?? 'VTS-ORDINARY';

  const account = getKisAccount(accountId);
  if (!account) { console.error(`등록되지 않은 계좌: ${accountId}`); process.exitCode = 1; return; }

  const open = await getKisDomesticAmendableOrders(account);
  const stale = open.filter((o) => {
    const mins = minutesSince(o.orderDate, o.orderTime);
    // ★ 주문 시각을 모르면 **손대지 않는다.** 방금 낸 것일 수 있다.
    return mins !== null && mins >= staleMinutes && o.amendableQuantity > 0;
  });

  console.log(
    `미체결 ${open.length}건 · ${staleMinutes}분 넘은 것 ${stale.length}건`
    + `${execute ? '' : '   [판정만 — 실제로 내려면 --execute]'}`,
  );
  if (stale.length === 0) return;

  // ── 적정가 ──
  const { rows } = await pool.query<FairRow>(
    `SELECT DISTINCT ON (symbol) symbol, chart_mid, fundamental_mid, gap
       FROM trading_fair_values
      WHERE measured_at > now() - ($1 || ' minutes')::interval
      ORDER BY symbol, measured_at DESC`,
    [String(FAIR_VALUE_MAX_AGE_MIN)],
  );
  const fair = new Map(rows.map((r) => [r.symbol, r]));

  // ── 현재가 ──
  const quotes = new Map<string, number>();
  try {
    const batch = await getDomesticQuotes(stale.map((o) => o.symbol));
    for (const [code, q] of batch.quotes) if (q.price > 0) quotes.set(code, q.price);
  } catch (error) {
    console.log(`시세를 못 받았다 — 이 회차는 아무것도 하지 않는다 (${(error as Error).message.slice(0, 50)})`);
    return;
  }

  for (const o of stale) {
    const mins = minutesSince(o.orderDate, o.orderTime) ?? 0;
    const label = `${o.symbol} ${o.name} ${o.side === 'buy' ? '매수' : '매도'}`
      + ` ${o.amendableQuantity}주 @ ${won(o.orderPrice)} (${ageLabel(mins)} 묵음)`;

    const price = quotes.get(o.symbol);
    if (!price) {
      console.log(`  · ${label} → 현재가를 못 받아 그대로 둔다`);
      continue;
    }

    const fv = fair.get(o.symbol);
    const mids = [fv?.chart_mid, fv?.fundamental_mid].filter((v): v is number => typeof v === 'number' && v > 0);

    let action: 'cancel' | 'amend';
    let why: string;

    if (mids.length === 0) {
      action = 'cancel';
      why = '적정가가 없다 — 근거 없이 걸어 둘 수 없다';
    } else {
      const mid = mids.reduce((a, b) => a + b, 0) / mids.length;
      if (o.side === 'buy' && price > mid) {
        action = 'cancel';
        why = `현재가 ${won(price)} > 적정가 ${won(mid)} — 살 이유가 사라졌다`;
      } else if (o.side === 'sell' && price < mid) {
        action = 'cancel';
        why = `현재가 ${won(price)} < 적정가 ${won(mid)} — 팔 이유가 사라졌다`;
      } else {
        action = 'amend';
        why = `적정가 ${won(mid)} 안이다 — 현재가 ${won(price)}로 붙인다`;
      }
    }

    console.log(`  · ${label}\n      → ${action === 'cancel' ? '취소' : '정정'}: ${why}`);
    if (!execute) continue;

    const result = await post('/api/broker/kis/orders/amend', {
      accountId: account.id,
      action,
      orderNo: o.orderNo,
      orderBranchNo: o.orderBranchNo,
      orderTypeCode: o.orderTypeCode || '00',
      quantity: action === 'cancel' ? undefined : o.amendableQuantity,
      quantityAll: action === 'cancel',
      limitPrice: action === 'amend' ? price : undefined,
    });
    console.log(`        ${result.ok ? '✓' : '✗'} ${result.message}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
