/**
 * 목표 비중으로 되돌린다. **재시도해도 같은 주문이 두 번 나가지 않는다.**
 *
 * ── 왜 이 스크립트가 생겼나 (2026-08-14) ─────────────────────────────────
 *
 * 단기 30% 자리를 ETF로 채우다 **같은 주문이 두 번 체결됐다.** KIS 모의 서버가
 * 느려져 요청이 타임아웃됐는데 서버는 큐에 두고 계속 처리했고, DB에 기록이 없는
 * 것을 보고 "안 나갔다"고 판단해 curl로 재전송한 것이다.
 *
 * ★ **막을 수 있는 사고였다.** 주문 라우트에는 이미 `clientOrderId` 멱등 키가
 * 있고 화면(`App.tsx`)은 그것을 쓴다. 키를 주면 `claimClientOrderId`가 DB 유니크
 * 제약으로 선점하고 **`status='sending'` 줄을 먼저 남기므로**, 처리 중인 주문도
 * DB에 보인다. 키를 안 써서 그 줄이 없었고, 그래서 "기록이 없다"를 "안 나갔다"로
 * 잘못 읽었다.
 *
 * 그래서 이 스크립트는 **손으로 curl을 치지 않게 하는 것**이 목적이다.
 * 키는 `rebalance-<날짜>-<종목>-<방향>`이라 **같은 날 같은 종목 같은 방향은
 * 몇 번을 돌려도 한 번만 나간다.** 중간에 죽어도 다시 실행하면 이어진다.
 *
 * ── 쓰는 법 ──────────────────────────────────────────────────────────────
 *
 *   npx tsx src/scripts/rebalance.ts                 # 계획만 본다 (기본)
 *   npx tsx src/scripts/rebalance.ts --execute       # 실제로 낸다
 *   npx tsx src/scripts/rebalance.ts --account 21 --bucket 0.8
 *
 * ★ **기본이 계획 보기다.** `--execute`를 적어야 나간다 — 실수로 돌려도 주문이
 * 나가지 않는 쪽이 기본이어야 한다.
 */

import { config, getKisAccount } from '../config.js';
import { closeDb } from '../db/client.js';
import { getKisDomesticAccountSnapshot } from '../kis/rest.js';
import { planRebalance, type RebalanceHolding, type RebalanceLeg } from '../trading/rebalance.js';

/**
 * ETF 묶음 안의 목표 비중 (2026-08-11 확정).
 *
 * 거래대금·분배금만 보면 레버리지·커버드콜이 뽑히는 것을 발견해 관문으로 바꿔
 * 고른 조합이다. 겹침은 구성종목이 아니라 **일간수익률 상관**으로 쟀다
 * (`396500` 반도체TOP10 vs `069500` = 0.943 → 반도체 ETF 9종목 전부 제외).
 * **숫자를 바꾸려면 그 근거부터 다시 세운다.**
 */
const TARGET_WEIGHTS: ReadonlyArray<{ symbol: string; weight: number; label: string }> = [
  { symbol: '360750', weight: 0.251, label: 'TIGER 미국S&P500' },
  { symbol: '329200', weight: 0.231, label: 'TIGER 리츠부동산인프라' },
  { symbol: '069500', weight: 0.199, label: 'KODEX 200' },
  { symbol: '161510', weight: 0.170, label: 'PLUS 고배당주' },
  { symbol: '411060', weight: 0.150, label: 'ACE KRX금현물' },
];

/** 총자산 중 ETF 묶음의 비중. ETF 50% + 단기 30%(ETF로 대체) = 80% */
const DEFAULT_BUCKET_WEIGHT = 0.80;

/** 지정가를 현재가에서 띄우는 폭. ETF 왕복 실측 비용이 0.085%라 그 안쪽이다 */
const SLIP_RATE = 0.002;

/** 이보다 작은 다리는 만들지 않는다. 잔돈 매매는 비용만 든다 */
const MIN_LEG_AMOUNT = 500_000;

interface Options {
  accountId: string;
  execute: boolean;
  bucketWeight: number;
  /** 멱등 키에 들어갈 날짜 `YYYYMMDD`. 하루에 한 번만 복원한다 */
  day: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    accountId: 'VTS-ORDINARY',
    execute: false,
    bucketWeight: DEFAULT_BUCKET_WEIGHT,
    day: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--account':
        options.accountId = argv[++i] ?? options.accountId;
        break;
      case '--execute':
        options.execute = true;
        break;
      case '--bucket': {
        const value = Number(argv[++i]);
        if (!(value > 0 && value <= 1)) throw new Error('--bucket은 0보다 크고 1 이하여야 합니다');
        options.bucketWeight = value;
        break;
      }
      case '--day':
        options.day = argv[++i] ?? options.day;
        break;
      default:
        if (argv[i].startsWith('--')) throw new Error(`모르는 옵션입니다: ${argv[i]}`);
    }
  }
  return options;
}

const won = (n: number): string => Math.round(n).toLocaleString('ko-KR');
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const width = (t: string): number => [...t].reduce((a, c) => a + (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(c) ? 2 : 1), 0);
const padR = (t: string, n: number): string => t + ' '.repeat(Math.max(1, n - width(t)));
const padL = (t: string, n: number): string => ' '.repeat(Math.max(1, n - width(t))) + t;

/**
 * 한 다리를 낸다. **키가 같으면 서버가 두 번째를 거절한다.**
 *
 * 응답이 안 오면(타임아웃) 던진다 — 하지만 **주문은 나갔을 수 있다.** 그래서
 * 부른 쪽이 같은 키로 다시 실행하면 되고, 그때 서버가 "이미 처리된 주문"이라고
 * 답한다. 2026-08-14에 없던 것이 정확히 이 성질이다.
 */
async function placeLeg(leg: RebalanceLeg, options: Options): Promise<string> {
  const clientOrderId = `rebalance-${options.day}-${leg.symbol}-${leg.side}`;
  const response = await fetch(`http://127.0.0.1:${config.port}/api/broker/kis/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accountId: options.accountId,
      instrumentId: `KR:KOSPI:${leg.symbol}`,
      side: leg.side,
      orderType: 'limit',
      quantity: leg.quantity,
      limitPrice: leg.limitPrice,
      clientOrderId,
    }),
    // 서버가 느려도 우리가 먼저 끊지 않는다. 끊으면 결과를 모르는 주문이 생긴다.
    signal: AbortSignal.timeout(180_000),
  });
  const body = (await response.json()) as { message?: string; accepted?: boolean; orderNo?: string };
  const mark = body.accepted ? '접수' : '거절';
  return `${mark} ${body.orderNo ? `주문번호 ${body.orderNo} · ` : ''}${body.message ?? ''}`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const account = getKisAccount(options.accountId);
  if (!account) throw new Error(`등록되지 않은 계좌: ${options.accountId}`);

  console.log(
    `비중 복원 · 계좌 ${options.accountId} · ETF 묶음 목표 ${pct(options.bucketWeight)}`
    + ` · ${options.execute ? '★ 실제로 낸다' : '계획만 본다(--execute로 집행)'}`,
  );

  const snapshot = await getKisDomesticAccountSnapshot(account);
  const holdings: RebalanceHolding[] = snapshot.positions.map((p) => ({
    symbol: p.symbol,
    name: p.name,
    quantity: p.quantity,
    // 값이 없으면 `null`로 넘긴다 — 0으로 채우면 "0원짜리"가 지어진다.
    price: typeof p.currentPrice === 'number' && p.currentPrice > 0 ? p.currentPrice : null,
  }));

  /*
   * ★ **D+2 정산액을 쓴다.** `cashBalance`(D+0)는 오늘 산 것이 아직 안 빠진
   * 값이라 그것으로 총자산을 내면 자산이 부풀어 목표가 커진다(2026-08-14에
   * 현금 비중이 17.3%인데 37.5%로 보였다).
   */
  const cash = snapshot.settlementCash ?? 0;
  const plan = planRebalance({
    holdings,
    targets: TARGET_WEIGHTS.map(({ symbol, weight }) => ({ symbol, weight })),
    cash,
    bucketWeight: options.bucketWeight,
    slipRate: SLIP_RATE,
    minLegAmount: MIN_LEG_AMOUNT,
  });

  console.log(
    `총자산 ${won(plan.totalAssets)}원 = 보유 ${won(plan.bucketNow)}원 + D+2 현금 ${won(cash)}원`,
  );
  console.log(`ETF 묶음 목표 ${won(plan.bucketTarget)}원 (지금 ${won(plan.bucketNow)}원)\n`);

  if (plan.legs.length === 0) {
    console.log('맞출 것이 없다 — 비중이 이미 목표 안에 있다.');
  } else {
    console.log(
      padR('종목', 25) + padL('방향', 5) + padL('수량', 7) + padL('지정가', 10)
      + padL('금액', 12) + padL('지금', 8) + padL('→목표', 8),
    );
    console.log('─'.repeat(76));
    for (const leg of plan.legs) {
      console.log(
        padR(`${leg.symbol} ${leg.name}`, 25)
        + padL(leg.side === 'sell' ? '매도' : '매수', 5)
        + padL(String(leg.quantity), 7)
        + padL(won(leg.limitPrice), 10)
        + padL(won(leg.amount), 12)
        + padL(pct(leg.fromWeight), 8)
        + padL(pct(leg.toWeight), 8),
      );
    }
    console.log('─'.repeat(76));
    console.log(`매도 ${won(plan.sellAmount)}원 · 매수 ${won(plan.buyAmount)}원`);
    /*
     * ★ **매도 대금은 당일 매수에 못 쓴다**(국내 주식 D+2). 매수 총액이 지금
     * 현금을 넘으면 뒤쪽 다리가 잔고 부족으로 거절된다 — 미리 말한다.
     */
    if (plan.buyAmount > cash) {
      console.log(
        `★ 매수 ${won(plan.buyAmount)}원이 D+2 현금 ${won(cash)}원을 넘는다.`
        + ' 매도 대금은 D+2라 오늘 못 쓴다 — 뒤쪽 매수가 거절될 수 있다.',
      );
    }
  }
  for (const s of plan.skipped) console.log(`  건너뜀 ${s.symbol} — ${s.reason}`);

  if (!options.execute) {
    console.log('\n계획만 봤다. 실제로 내려면 --execute를 붙인다.');
    return;
  }

  console.log(`\n집행 · 멱등 키 rebalance-${options.day}-<종목>-<방향>`);
  console.log('★ 중간에 끊겨도 같은 명령을 다시 돌리면 이어진다 — 같은 키는 두 번 안 나간다.\n');
  for (const leg of plan.legs) {
    const label = `${leg.side === 'sell' ? '매도' : '매수'} ${leg.symbol} ${leg.quantity}주 @ ${won(leg.limitPrice)}원`;
    try {
      console.log(`  ${label} → ${await placeLeg(leg, options)}`);
    } catch (error) {
      /*
       * 응답을 못 받았다. **주문이 나갔는지 모른다** — 나갔다고도 안 나갔다고도
       * 적지 않는다. 같은 키로 다시 돌리면 서버가 답을 준다.
       */
      console.log(`  ${label} → ★ 응답 없음: ${String(error)}`);
      console.log('    결과를 모른다. **같은 명령을 다시 돌려라** — 나갔으면 서버가 그렇게 답한다.');
    }
  }
  console.log('\n집행 끝. 보유를 다시 확인하려면 zsh scripts/watch.sh');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
