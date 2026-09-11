/**
 * **해외주식이 이 서버에서 되는가.** 조회 TR만 쏴서 표로 답한다.
 *
 * ── 왜 이것이 먼저인가 (2026-09-10) ─────────────────────────────────────
 *
 * 사용자가 정했다 — *"해외주식 먼저 하자."* 그런데 이 레포는 "될 줄 알고 만들었다
 * 안 되는 것을 나중에 알아" 두 번 크게 헛돌았다:
 *
 *   · 스톱지정가(`ORD_DVSN=22`) — 코드 완성 + 시험 631개 통과 **뒤에** 모의가 거절
 *   · 개장일 조회(`chk-holiday`) — 리스크 룰이 늘 보류로 막히고 **나서야** 원인 발견
 *
 * 그래서 **주문 코드를 한 줄도 쓰기 전에** 조회로 경계를 먼저 잰다. 여기서
 * `trNotOnVts`가 나오는 항목은 모의로 검증할 방법이 없고, 이 레포는 실주문
 * 게이트를 사람이 여는 구조라 **검증 없이 실전으로 갈 수 없다.**
 *
 * ★ **주문을 쏘지 않는다.** 조회 전용이다.
 *
 * ── 무엇을 읽나 ──────────────────────────────────────────────────────────
 *
 *   ok           이 서버에서 돈다
 *   trNotOnVts   EGW02006 — 그 TR이 모의 서버에 없다(기능이 없는 것)
 *   그 밖        오류 코드를 그대로 적는다 — **TR ID 오타와 미지원을 섞지 않으려고**
 *
 * ★ 계좌·상품코드가 안 맞아도 오류가 난다(`INVALID_CHECK_ACNO`). 그것도 코드로
 *   구분되므로 표에 그대로 남긴다 — 지어내지 않는다.
 *
 *   npx tsx src/scripts/probeOverseasStock.ts [계좌id]
 */

import { getKisAccount, config } from '../config.js';
import { probeKisTr } from '../kis/rest.js';

/**
 * 쏴 볼 조회 TR들.
 *
 * ★ **모의 TR ID가 문서에 있다는 것과 우리 계좌에서 된다는 것은 다르다.** 앞은
 *   웹으로 확인했고(`VTTS3012R`), 뒤를 재는 것이 이 스크립트다.
 *
 * ★ 주문 TR(`VTTT1002U` 매수 · 매도는 미확인 — `docs/TRADING_API.md` 4-1)은 **여기 넣지 않는다.** 조회로
 *   경계를 먼저 잰 뒤, 주문은 사람이 게이트를 열고 최소 수량으로 확인한다.
 */
interface Probe {
  label: string;
  path: string;
  /** 실전 TR */
  prod: string;
  /** 모의 TR. 없다고 알려진 것은 null */
  vts: string | null;
  params: (cano: string, productCode: string) => Record<string, string>;
}

/** 미국 나스닥·달러 기준으로 묻는다. 거래소·통화가 필수인 TR이 있다 */
const EXCHANGE = 'NASD';
const CURRENCY = 'USD';

const PROBES: Probe[] = [
  {
    label: '잔고',
    path: '/uapi/overseas-stock/v1/trading/inquire-balance',
    prod: 'TTTS3012R',
    vts: 'VTTS3012R',
    params: (cano, productCode) => ({
      CANO: cano,
      ACNT_PRDT_CD: productCode,
      OVRS_EXCG_CD: EXCHANGE,
      TR_CRCY_CD: CURRENCY,
      CTX_AREA_FK200: '',
      CTX_AREA_NK200: '',
    }),
  },
  {
    label: '매수가능금액',
    path: '/uapi/overseas-stock/v1/trading/inquire-psamount',
    prod: 'TTTS3007R',
    vts: 'VTTS3007R',
    params: (cano, productCode) => ({
      CANO: cano,
      ACNT_PRDT_CD: productCode,
      OVRS_EXCG_CD: EXCHANGE,
      OVRS_ORD_UNPR: '100',
      ITEM_CD: 'AAPL',
    }),
  },
  {
    label: '미체결',
    path: '/uapi/overseas-stock/v1/trading/inquire-nccs',
    prod: 'TTTS3018R',
    vts: 'VTTS3018R',
    params: (cano, productCode) => ({
      CANO: cano,
      ACNT_PRDT_CD: productCode,
      OVRS_EXCG_CD: EXCHANGE,
      SORT_SQN: 'DS',
      CTX_AREA_FK200: '',
      CTX_AREA_NK200: '',
    }),
  },
  {
    label: '체결기준현재잔고',
    path: '/uapi/overseas-stock/v1/trading/inquire-present-balance',
    prod: 'CTRP6504R',
    vts: 'VTRP6504R',
    params: (cano, productCode) => ({
      CANO: cano,
      ACNT_PRDT_CD: productCode,
      WCRC_FRCR_DVSN_CD: '02',
      NATN_CD: '840',
      TR_MKET_CD: '00',
      INQR_DVSN_CD: '00',
    }),
  },
];

/**
 * 호출 사이 간격.
 *
 * ★★ **모의 서버는 유량이 얇다.** 간격 없이 넷을 연달아 쏘니 그중 하나가
 *    `EGW00201`로 떨어졌고, 바로 뒤 같은 TR을 다시 부르니 정상으로 왔다
 *    (2026-09-10 실측). 그대로 두면 **일시적 유량 오류를 "미지원"으로 표에
 *    적게 된다** — 이 스크립트가 존재하는 이유를 스스로 무너뜨리는 자리다.
 */
const GAP_MS = 700;
const wait = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/**
 * 한 번 더 물어본다. **유량 오류는 재시도로 갈라진다** — 진짜 미지원(EGW02006)은
 * 몇 번을 보내도 같은 답이므로 재시도해도 결론이 안 바뀐다.
 */
async function probeWithRetry(
  ...args: Parameters<typeof probeKisTr>
): Promise<Awaited<ReturnType<typeof probeKisTr>>> {
  const first = await probeKisTr(...args);
  if (first.ok || first.kind !== null) return first;
  await wait(GAP_MS * 2);
  return probeKisTr(...args);
}

const VERDICT: Record<string, string> = {
  trNotOnVts: '✗ 모의에 그 TR이 없다',
  serverMismatch: '✗ 앱키/서버 짝이 어긋난다',
  orderTypeNotOnVts: '✗ 모의에 그 주문유형이 없다',
  orderRefused: '✗ 거절',
};

async function main(): Promise<void> {
  const accountId = process.argv[2] ?? 'VTS-ORDINARY';
  const account = getKisAccount(accountId);
  if (!account) {
    console.error(`계좌를 못 찾았다: ${accountId}`);
    process.exitCode = 1;
    return;
  }

  console.log('=== 해외주식 — 이 서버에서 무엇이 되나 ===');
  console.log(`계좌 ${account.id} · 서버 ${config.env} · 거래소 ${EXCHANGE} · 통화 ${CURRENCY}`);
  console.log('★ 조회만 한다. 주문은 쏘지 않는다.\n');

  const rows: string[] = [];
  for (const probe of PROBES) {
    const trId = config.env === 'prod' ? probe.prod : probe.vts;
    if (trId === null) {
      rows.push(`  ${probe.label.padEnd(16)} —          이 서버용 TR이 알려져 있지 않다`);
      continue;
    }
    const result = await probeWithRetry(
      account, probe.path, trId, probe.params(account.cano, account.productCode),
    );
    await wait(GAP_MS);
    /*
     * ★ **오류 코드를 반드시 함께 적는다.** TR ID 오타도 오류를 내므로, 코드가
     *   없으면 "모의 미지원"으로 잘못 기록하게 된다.
     */
    const verdict = result.ok
      ? '✅ 된다'
      : (result.kind ? VERDICT[result.kind] : `✗ ${result.code || '코드 없음'}`);
    rows.push(
      `  ${probe.label.padEnd(16)} ${trId.padEnd(11)} ${verdict.padEnd(22)} ${result.message.slice(0, 60)}`,
    );
  }
  console.log(rows.join('\n'));

  /*
   * ── ★★ 되는 것과 **살 수 있는 것**은 다르다 ─────────────────────────────
   *
   * 조회가 다 통과해도 **외화 예수금이 없으면 한 주도 못 산다.** 해외주식은
   * 달러로 결제하고, 원화만 있으면 환전이 먼저다. 그래서 매수가능금액의 실제
   * 값을 함께 찍는다 — "TR이 된다"에서 멈추면 그 다음 관문을 못 본다.
   */
  const psAmount = PROBES.find((x) => x.label === '매수가능금액');
  if (psAmount) {
    const trId = config.env === 'prod' ? psAmount.prod : psAmount.vts;
    if (trId !== null) {
      const r = await probeWithRetry(
        account, psAmount.path, trId, psAmount.params(account.cano, account.productCode),
      );
      const out = (r.body?.output ?? {}) as Record<string, unknown>;
      const num = (k: string): string => {
        const v = out[k];
        return v === undefined || v === '' ? '—' : Number(v).toLocaleString('ko-KR');
      };
      console.log('\n── 실제로 살 수 있나 (AAPL 100달러 기준) ──');
      console.log(`  주문가능 외화     ${num('ord_psbl_frcr_amt')}`);
      console.log(`  주문가능 원화     ${num('frcr_ord_psbl_amt1')}`);
      console.log(`  최대 주문가능 수량 ${num('max_ord_psbl_qty')}주`);
      console.log(`  적용 환율         ${num('exrt')}`);
      if (Number(out.max_ord_psbl_qty ?? 0) <= 0) {
        console.log('  ★ 0주다 — TR이 되는 것과 살 수 있는 것은 다르다.');
        console.log('    외화 예수금이 없으면 환전이 먼저이고, 모의에서 환전이 되는지는 별도로 재야 한다.');
      }
    }
  }

  console.log('\n★ 읽는 법');
  console.log('  ✅ 된다        → 모의로 검증할 수 있다. 여기부터 붙인다');
  console.log('  ✗ TR이 없다    → 모의로는 못 만든다. 실전 게이트를 사람이 열어야 검증된다');
  console.log('  ✗ 그 밖        → 코드를 보고 가른다(계좌 불일치·파라미터 오류는 고칠 수 있다)');
  console.log('\n결과를 docs/TRADING_API.md 상태표에 적는다 — 다음 사람이 다시 재지 않게.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
