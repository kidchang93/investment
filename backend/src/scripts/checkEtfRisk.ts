/**
 * 보유 ETF의 **해지(상장폐지) 위험**을 잰다. 조회 전용 — 주문을 내지 않는다.
 *
 * ── 왜 필요한가 (2026-08-14) ─────────────────────────────────────────────
 *
 * 포트폴리오의 50%가 ETF인데 **ETF 폐지 목록을 구할 길이 없었다.** KIND 상장폐지
 * 목록은 `searchDelCompanySub` — **회사** 폐지라 펀드인 ETF가 아예 없다(실측:
 * 1,267건 중 ETF 0건 · 우선주 0건. 코드 끝자리가 0이 아닌 종목이 한 건도 없다).
 * KRX 정보데이터시스템은 세션을 요구해 스크립트로 못 받는다.
 *
 * ★ **그래서 질문을 바꿨다.** "얼마나 많이 사라졌나"(목록)를 못 구하면
 * "내 것이 사라질 위험이 있나"(순자산)를 재면 된다. 후자가 실제로 돈이 걸린
 * 질문이고, 이쪽은 KIS가 답한다(`FHPST02400000`의 `etf_ntas_ttam`).
 *
 * ── 문턱의 근거 ──────────────────────────────────────────────────────────
 *
 * KRX 규정상 ETF는 **순자산총액 50억원 미만이 일정 기간 지속되면** 관리종목을
 * 거쳐 상장폐지(신탁계약 해지) 대상이 된다. 그래서 50억을 기준선으로 두고
 * 몇 배 떨어져 있는지 적는다. **배수가 작아질수록 갈아탈 시간을 벌어야 한다.**
 *
 * 2026-08-14 첫 실측(보유 5종목): 최소가 TIGER 리츠부동산인프라 1조 5,338억원으로
 * 기준선의 **307배**였다. 걱정할 것이 아니었고, 그 사실을 재서 확인했다.
 *
 *   npx tsx src/scripts/checkEtfRisk.ts [069500 360750 ...] [계좌id]
 *
 * 종목을 안 주면 **계좌 잔고에서 읽는다**(기본 `VTS-ORDINARY`) — 손으로 적은
 * 목록은 보유와 어긋난다(`close.sh`가 같은 이유로 잔고를 스스로 읽는다).
 */

import { config, getKisAccount } from '../config.js';
import { closeDb, pool } from '../db/client.js';
import { getAccessToken, primaryCredentials } from '../kis/auth.js';
import { getKisDomesticAccountSnapshot } from '../kis/rest.js';

/** KRX 해지 기준선(원). 이 아래가 지속되면 관리·해지 절차가 시작된다 */
const DELISTING_FLOOR_WON = 5_000_000_000;

/** `etf_ntas_ttam`은 **억원 단위**로 온다 (2026-08-14 검산). */
const NTAS_UNIT_WON = 100_000_000;

interface EtfSize {
  code: string;
  name: string;
  /** 순자산총액(원) */
  netAssetsWon: number;
  listedShares: number;
  listedOn: string;
  /** 운용사. **한 곳에 몰리는 것도 위험**이라 함께 적는다 */
  manager: string;
  /** 기초지수 */
  benchmark: string;
}

async function fetchEtfSize(code: string, token: string): Promise<EtfSize | null> {
  const url = new URL('/uapi/etfetn/v1/quotations/inquire-price', config.restBase);
  url.searchParams.set('FID_COND_MRKT_DIV_CODE', 'J');
  url.searchParams.set('FID_INPUT_ISCD', code);
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      appkey: primaryCredentials.appKey,
      appsecret: primaryCredentials.appSecret,
      tr_id: 'FHPST02400000',
      custtype: 'P',
    },
  });
  const json = (await res.json()) as Record<string, unknown> & { msg1?: string };
  const o = (json.output ?? {}) as Record<string, string>;
  // 빈 응답을 0원짜리 ETF로 읽지 않는다 — 없는 것과 0은 다르다.
  if (!res.ok || !o.etf_ntas_ttam) {
    console.log(`  ${code} — 못 받았다 (HTTP ${res.status} ${json.msg1 ?? ''})`);
    return null;
  }
  /*
   * ★ 이 응답에는 **종목명이 없다**(2026-08-14 실측: 58필드에 `hts_kor_isnm`이
   * 없고 `mbcr_name`=운용사 · `etf_rprs_bstp_kor_isnm`=기초지수뿐). 이름은
   * `instruments`에서 가져온다 — 손으로 적으면 다른 종목을 보게 된다.
   */
  return {
    code,
    name: (await nameOf(code)) ?? code,
    netAssetsWon: Number(o.etf_ntas_ttam) * NTAS_UNIT_WON,
    listedShares: Number(o.lstn_stcn ?? 0),
    listedOn: String(o.stck_lstn_date ?? ''),
    manager: String(o.mbcr_name ?? '').trim(),
    benchmark: String(o.etf_rprs_bstp_kor_isnm ?? '').trim(),
  };
}

async function nameOf(symbol: string): Promise<string | null> {
  const { rows } = await pool.query<{ name: string }>(
    `SELECT name FROM instruments WHERE symbol = $1 AND country = 'KR' ORDER BY is_active DESC LIMIT 1`,
    [symbol],
  );
  return rows[0]?.name ?? null;
}

/** 보유 코드. **손으로 적지 않는다** — 잔고가 곧 목록이다. */
async function heldCodes(accountId: string): Promise<string[]> {
  const account = getKisAccount(accountId);
  if (!account) {
    console.log(`등록되지 않은 계좌: ${accountId}`);
    return [];
  }
  const snapshot = await getKisDomesticAccountSnapshot(account);
  return [...new Set(snapshot.positions.map((p) => p.symbol))].sort();
}

function formatWon(won: number): string {
  if (won >= 1_000_000_000_000) return `${(won / 1_000_000_000_000).toFixed(2)}조원`;
  return `${Math.round(won / 100_000_000).toLocaleString('ko-KR')}억원`;
}

async function main(): Promise<void> {
  console.log('ETF 해지 위험 점검 · 조회 전용 (주문을 내지 않는다)');
  const args = process.argv.slice(2);
  const argCodes = args.filter((a) => /^\d{6}$/.test(a));
  const accountId = args.find((a) => !/^\d{6}$/.test(a)) ?? 'VTS-ORDINARY';
  const codes = argCodes.length > 0 ? argCodes : await heldCodes(accountId);
  if (codes.length === 0) {
    console.log('볼 종목이 없다 — 보유가 없거나 계좌를 못 읽었다.');
    return;
  }
  console.log(
    `대상 ${codes.length}종목 ${argCodes.length > 0 ? '(인자로 받음)' : '(계좌 잔고에서 읽음)'}`
    + ` · 기준선 순자산 ${formatWon(DELISTING_FLOOR_WON)} (KRX 해지 기준)\n`,
  );

  const token = await getAccessToken(primaryCredentials);
  const sizes: EtfSize[] = [];
  const failed: string[] = [];
  for (const code of codes) {
    const size = await fetchEtfSize(code, token);
    if (size) sizes.push(size);
    else failed.push(code);
    /*
     * 모의 서버는 초당 1건이라 300ms로는 `초당 거래건수를 초과하였습니다`가 난다
     * (2026-08-14 실측, 5종목 중 1종목 실패). 조사에 서둘 이유가 없다.
     */
    await new Promise((r) => setTimeout(r, 1_200));
  }
  if (sizes.length === 0) {
    console.log('\n★ 한 종목도 못 받았다 — ETF가 아니거나(주식은 이 TR이 답하지 않는다) 조회가 실패했다.');
    return;
  }

  sizes.sort((a, b) => a.netAssetsWon - b.netAssetsWon);
  // 한글은 터미널에서 2칸을 먹는다. `padEnd`로 채우면 표가 어긋난다.
  const pad = (text: string, width: number): string => {
    const w = [...text].reduce((sum, c) => sum + (/[ᄀ-ᇿ　-〿가-힯＀-￯]/.test(c) ? 2 : 1), 0);
    return text + ' '.repeat(Math.max(1, width - w));
  };
  console.log('  종목    이름                        순자산  기준선대비  상장일     운용사');
  for (const s of sizes) {
    const ratio = s.netAssetsWon / DELISTING_FLOOR_WON;
    console.log(
      `  ${s.code}  ${pad(s.name, 24)}${formatWon(s.netAssetsWon).padStart(9)}`
      + `${`${ratio.toFixed(0)}배`.padStart(10)}  ${s.listedOn}   ${s.manager}`,
    );
  }

  /*
   * ★ 순자산만 보면 "안전하다"로 끝나지만, **같은 운용사에 몰려 있으면** 그
   * 운용사의 사정 하나로 여러 개가 함께 흔들린다. 세어서 적기만 한다 —
   * 몇 개까지가 괜찮은지는 이 검사가 답할 수 있는 것이 아니다.
   */
  const byManager = new Map<string, number>();
  for (const s of sizes) byManager.set(s.manager, (byManager.get(s.manager) ?? 0) + 1);
  const spread = [...byManager.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n  운용사 ${spread.map(([m, n]) => `${m || '(모름)'} ${n}`).join(' · ')}`);

  const worst = sizes[0];
  const worstRatio = worst.netAssetsWon / DELISTING_FLOOR_WON;
  console.log('');
  /*
   * ★ **못 받은 것이 있으면 판정을 하지 않는다.** 못 받은 종목이 가장 작을 수도
   * 있는데 "가장 작은 것도 476배다"라고 적으면 조용한 거짓말이 된다.
   */
  if (failed.length > 0) {
    console.log(
      `★ ${failed.length}종목을 못 받았다(${failed.join(' ')}) — **판정하지 않는다.**`
      + ' 못 받은 것이 가장 작을 수도 있다. 다시 돌려라.',
    );
  } else if (worstRatio < 3) {
    console.log(`★ ${worst.name}이 기준선의 ${worstRatio.toFixed(1)}배다 — 갈아탈 준비를 시작해야 한다.`);
  } else if (worstRatio < 20) {
    console.log(`★ 가장 작은 것이 ${worst.name}(기준선의 ${worstRatio.toFixed(0)}배)다. 분기 점검에서 다시 본다.`);
  } else {
    console.log(`가장 작은 것도 기준선의 ${worstRatio.toFixed(0)}배다 — 해지 위험은 이 표본에 없다.`);
  }
  console.log('★ 순자산이 큰 것이 수익률을 보장하지는 않는다. 이 검사가 답하는 것은 **사라질 위험** 하나다.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
