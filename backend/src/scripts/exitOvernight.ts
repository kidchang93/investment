/**
 * **어젯밤 종가에 산 것을 오늘 아침에 판다.** 종가 매매의 나가는 다리다.
 *
 * ── 왜 별도 스크립트인가 (2026-09-07) ────────────────────────────────────
 *
 * 사용자가 정했다 — *"시장 상황을 분석해서 종가에 사서 다음날 매도하는 전략."*
 *
 * 들어가는 쪽은 판단자가 한다(`prompts/deliberate-close.md`). 나가는 쪽은
 * **판단이 아니라 규칙**이다 — 살 때 이미 "하룻밤"이라고 정했으므로, 아침에
 * 다시 판단하면 그때 정한 것을 스스로 지우는 것이 된다. 손절을 규칙이 집행하는
 * 것과 같은 이유다(`docs/USER_DECISIONS.md`).
 *
 * ── 무엇을 파나 ──────────────────────────────────────────────────────────
 *
 * **오늘이 아닌 가장 최근 `close` 회차**가 산 종목이다. 회차의 `trigger`가
 * 유일한 표시라, 판단자가 그것을 안 적으면 여기서 안 보이고 **팔리지 않는다**
 * (프롬프트에 크게 적어 뒀다).
 *
 * ★ **결정 수량이 아니라 실제 보유 수량을 판다.** 종가 단일가는 부분체결이
 *   흔하고, 아침 손절(`enforceStops`)이 먼저 나갔을 수도 있다. 장부가 아니라
 *   **증권사 잔고**가 근거다.
 *
 * ── 얼마에 파나 ──────────────────────────────────────────────────────────
 *
 * ★ **시장가로 팔지 않는다.** 이 레포의 시장가 슬리피지 실측이 **0.33%**인데
 *   이 전략의 하룻밤 우위가 그 언저리다 — 시장가로 나가면 우위가 통째로 사라진다.
 *   현재가에서 조금 낮춘 지정가면 **최악이 정해진다**(그보다 나쁘게는 안 팔린다).
 *
 * 조회만 하려면 `--execute` 없이 부른다. 데몬은 `--execute`로 부른다.
 *
 *   npx tsx src/scripts/exitOvernight.ts [계좌id] [--execute]
 */

import { getKisAccount } from '../config.js';
import { getDeliberations } from '../db/deliberations.js';
import { getLayerPositions } from '../db/layers.js';
import { closeDb } from '../db/client.js';
import { getKoreanInstrumentBySymbol } from '../db/instruments.js';
import { getKisDomesticAccountSnapshot, getQuote } from '../kis/rest.js';
import { resolveSellLayer, type Layer } from '../trading/layers.js';

const API_BASE = process.env.INVEST_API_BASE ?? 'http://localhost:4000';

/**
 * 지정가를 현재가에서 **낮추는** 폭. 매도는 낮게 걸어야 붙는다.
 *
 * 0.3%는 이 레포의 시장가 슬리피지 실측(0.33%)보다 안쪽이다 — 시장가보다 나쁠
 * 이유가 없게 잡은 값이고, 실제 체결은 이보다 좋을 수 있다. 첫 몇 주는 이 값과
 * 실제 체결가의 차이를 모으는 것이 목적이다.
 */
const SELL_SLIP = 0.003;

/** KST 오늘 `YYYY-MM-DD`. 회차의 `tradingDay`와 같은 축이다. */
function todayKst(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
}

const won = (n: number): string => Math.round(n).toLocaleString('ko-KR');

async function post(path: string, payload: unknown): Promise<{
  ok: boolean; status: number; body: Record<string, unknown>;
}> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // 본문이 JSON이 아니면 status로만 판정한다.
  }
  return { ok: res.ok, status: res.status, body };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const execute = args.includes('--execute');
  const accountId = args.find((a) => !a.startsWith('--')) ?? 'VTS-ORDINARY';

  const account = getKisAccount(accountId);
  if (!account) throw new Error(`등록되지 않은 계좌: ${accountId}`);

  const today = todayKst();
  /*
   * ★ **오늘 회차는 제외한다.** 오늘 15:00 종가 회차가 이미 돌았다면 그것은
   *   오늘 밤에 들고 갈 자리이지 지금 팔 자리가 아니다.
   */
  const rounds = await getDeliberations({ accountId, limit: 40 });
  const source = rounds.find((r) => r.trigger === 'close' && r.tradingDay !== today);
  if (!source) {
    console.log('팔 것이 없다 — 지난 종가 회차가 없다.');
    return;
  }

  const bought = source.decisions.filter((d) => d.action === 'buy');
  console.log(
    `회차 ${source.id} (${source.tradingDay} · close) · 매수 결정 ${bought.length}건`,
  );
  if (bought.length === 0) return;

  const snapshot = await getKisDomesticAccountSnapshot(account);
  if (!snapshot.configured) {
    console.log(`잔고를 못 읽었다: ${snapshot.message ?? '사유 없음'}`);
    process.exitCode = 1;
    return;
  }
  const held = new Map(snapshot.positions.map((p) => [p.symbol, p]));

  // 종목이 어느 층들에 걸쳐 있나. 집행기와 같은 방식으로 모은다.
  const holdingLayers = new Map<string, Layer[]>();
  for (const position of await getLayerPositions(accountId)) {
    const layers = holdingLayers.get(position.symbol) ?? [];
    layers.push(position.layer);
    holdingLayers.set(position.symbol, layers);
  }

  let placed = 0;
  for (const d of bought) {
    const position = held.get(d.symbol);
    const quantity = Math.floor(position?.quantity ?? 0);
    if (quantity <= 0) {
      // 체결이 안 됐거나 아침 손절이 먼저 나갔다. 둘 다 팔 것이 없는 것이다.
      console.log(`  · ${d.symbol} ${d.name} — 보유 0주, 건너뛴다`);
      continue;
    }

    /*
     * ★ 매도의 층은 판단자에게 묻지 않고 **장부에서 읽는다**(2026-09-02 결정).
     *   이미 가진 것을 파는 것이라 답이 장부에 있다.
     */
    const sellLayer = resolveSellLayer(
      d.layer as Layer | undefined,
      holdingLayers.get(d.symbol) ?? [],
    );
    if (sellLayer.kind === 'block') {
      console.log(`  ✗ ${d.symbol} ${d.name} — ${sellLayer.why}`);
      continue;
    }
    if (sellLayer.kind !== 'use') {
      // 층을 못 정한 이유는 주문을 내든 안 내든 적어 둔다. 조용히 넘기지 않는다.
      console.log(`    · 매도 층: ${sellLayer.why}`);
    }

    const quote = await getQuote(d.symbol);
    if (!(quote.price > 0)) {
      console.log(`  ✗ ${d.symbol} ${d.name} — 현재가를 못 받았다`);
      continue;
    }
    // 호가 단위로 내리는 것은 서버가 한다. 여기서는 원 단위로 자른다.
    const limitPrice = Math.floor(quote.price * (1 - SELL_SLIP));

    const buyPrice = d.limitPrice ?? position?.averagePrice ?? 0;
    const gap = buyPrice > 0 ? (limitPrice / buyPrice - 1) * 100 : 0;
    console.log(
      `  ${d.symbol} ${d.name} ${quantity}주 · 현재가 ${won(quote.price)}원`
      + ` → 지정가 ${won(limitPrice)}원 (매수 ${won(buyPrice)}원 대비 ${gap >= 0 ? '+' : ''}${gap.toFixed(2)}%)`,
    );

    if (!execute) continue;

    const instrument = await getKoreanInstrumentBySymbol(d.symbol);
    if (!instrument) {
      console.log(`    ✗ 종목 마스터에 없다 — 주문하지 않는다`);
      continue;
    }
    const result = await post('/api/broker/kis/orders', {
      accountId: account.id,
      instrumentId: instrument.id,
      side: 'sell',
      orderType: 'limit',
      quantity,
      limitPrice,
      layer: sellLayer.kind === 'use' ? sellLayer.layer : d.layer,
      /*
       * ★ 하루 한 번만 나가게 찍는다. 데몬이 여러 번 불러도 같은 매도가 두 번
       *   나가지 않는다 — 서버가 이 키로 선점한다.
       */
      clientOrderId: `exit${source.id}-${today.replace(/-/g, '')}-${d.symbol}`,
    });
    const order = (result.body.order ?? result.body) as Record<string, unknown>;
    const orderNo = typeof order.orderNo === 'string' ? order.orderNo : '';
    if (result.ok && orderNo) {
      console.log(`    ✓ 주문번호 ${orderNo}`);
      placed += 1;
    } else {
      const blockers = Array.isArray(result.body.blockers)
        ? (result.body.blockers as string[])
        : [String(result.body.message ?? `HTTP ${result.status}`)];
      console.log(`    ✗ ${blockers.join(' · ')}`);
    }
  }

  if (!execute) {
    console.log('\n미리보기다. 실제로 내려면 --execute를 붙인다.');
  } else {
    console.log(`\n매도 ${placed}건을 냈다.`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
