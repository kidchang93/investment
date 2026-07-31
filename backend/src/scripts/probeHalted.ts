/**
 * 거래정지 종목을 무엇으로 알아볼 수 있나 (일회성 조사용).
 *
 * 2026-07-31 장중 실측에서 `183300 코미코`·`000880 한화`가 반도체 테마 중앙값
 * +8.88%(98/101 상승) 한가운데서 정확히 0%였다. 호가 단계도 잔량도 0이었다.
 * 그때 이 종목들은 `screenQuote`에서 `illiquid`(거래대금 부족)로 걸렸다 —
 * "얇다"와 "아예 못 산다"가 한 사유로 뭉쳐 있었다.
 *
 * 이 스크립트가 답해야 하는 것은 셋이다.
 *   1. 단건(`FHKST01010100`) 80필드에 **거래정지 플래그**가 있나. 있으면 그게 가장 정확하다
 *   2. 멀티시세(`FHKST11300006`) 29필드만으로 같은 판정을 낼 수 있나 (호출 +0회)
 *   3. 그 판정이 **개장 직후 정상 종목**을 거래정지로 오인하지 않나
 *
 * 3번이 핵심이다. 거래량 0 + 시고저 0은 09:00:00 직후의 정상 종목도 그렇다.
 * 호가 잔량은 다르다 — 정상 종목은 장전 동시호가(08:30~)부터 주문이 쌓인다.
 *
 * ## 무엇이 나왔나 (2026-07-31 11:33~11:35 KST, 정규장)
 *
 *   1. **있다.** `iscd_stat_cls_code = 58`이 거래정지다. 다만 **단건에만** 있어
 *      종목당 1회가 더 나간다(120종목 스크리닝이 4회 → 124회)
 *   2. **된다.** `total_askp_rsqn`·`total_bidp_rsqn`이 **양쪽 다 0**이면 거래정지였다
 *      (누적 12종목 전부 일치, 호가가 있는 표본 15종목에서 놓친 것 0건).
 *      **한쪽만 0인 것을 걸면 안 된다** — 상한가 잠김이 그렇다(`002070` +29.83%)
 *   3. **안 한다.** 거래대금 0원이어도 호가가 있으면 정상이다(`0000Y0`·`001067`).
 *      다만 **장전(08:30 이전)·휴장일은 재지 않았다** — 그래서 판정 이름이
 *      `거래정지`가 아니라 `호가 없음`(`noOrderBook`)이다
 *
 * 자세한 표는 `docs/USER_FINDINGS.md`와 `docs/DESIGN.md`의 「호가가 없는 종목」 절.
 *
 *   npx tsx src/scripts/probeHalted.ts fields    # 단건 80필드 전체 + 멀티 29필드 나란히
 *   npx tsx src/scripts/probeHalted.ts scan      # 스크리닝 풀 120종목: 멀티 판정 vs 단건 플래그
 *   npx tsx src/scripts/probeHalted.ts verify    # 우리 코드(runScreening)가 실제로 갈라내는지
 */

import { config } from '../config.js';
import { getCategoryInstruments } from '../db/instruments.js';
import { getAccessToken, primaryCredentials } from '../kis/auth.js';
import { getThemePulses } from '../themes/pulse.js';
import { runScreening } from '../trading/screening.js';

const MULTI_PATH = '/uapi/domestic-stock/v1/quotations/intstock-multprice';
const MULTI_TR_ID = 'FHKST11300006';
const SINGLE_PATH = '/uapi/domestic-stock/v1/quotations/inquire-price';
const SINGLE_TR_ID = 'FHKST01010100';

/** 실측에서 호가창이 통째로 비어 있던 종목 + 대조군. */
const SUSPECTS = ['183300', '000880', '009310'];
const CONTROLS = ['005930', '000860', '000660'];

let calls = 0;

async function call(
  path: string,
  trId: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  calls += 1;
  const token = await getAccessToken(primaryCredentials);
  const url = new URL(path, config.restBase);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      appkey: primaryCredentials.appKey,
      appsecret: primaryCredentials.appSecret,
      tr_id: trId,
      custtype: 'P',
    },
  });
  const json = (await res.json()) as Record<string, unknown>;
  await new Promise((r) => setTimeout(r, 300));
  return json;
}

function multiParams(symbols: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  symbols.forEach((symbol, index) => {
    params[`FID_COND_MRKT_DIV_CODE_${index + 1}`] = 'J';
    params[`FID_INPUT_ISCD_${index + 1}`] = symbol;
  });
  return params;
}

async function multiRows(symbols: string[]): Promise<Array<Record<string, string>>> {
  const json = await call(MULTI_PATH, MULTI_TR_ID, multiParams(symbols));
  const raw = json.output;
  return (Array.isArray(raw) ? raw : []) as Array<Record<string, string>>;
}

async function singleOutput(symbol: string): Promise<Record<string, string>> {
  const json = await call(SINGLE_PATH, SINGLE_TR_ID, {
    FID_COND_MRKT_DIV_CODE: 'J',
    FID_INPUT_ISCD: symbol,
  });
  return (json.output ?? {}) as Record<string, string>;
}

/** 단건 응답에서 "상태"를 말할 법한 필드만 골라 본다. 이름에 추측을 담지 않는다. */
const STATUS_FIELD_HINT = /stat|stop|halt|susp|warn|mang|sltr|cls_code|yn$/i;

async function probeFields(): Promise<void> {
  const given = process.argv.slice(3);
  const symbols = given.length > 0 ? given : [...SUSPECTS, ...CONTROLS];
  const rows = await multiRows(symbols);
  const byCode = new Map(rows.map((r) => [String(r.inter_shrn_iscd ?? '').trim(), r]));

  for (const symbol of symbols) {
    const single = await singleOutput(symbol);
    const m = byCode.get(symbol);
    console.log(`\n=== ${symbol} ${single.hts_kor_isnm ?? m?.inter_kor_isnm ?? '(이름 없음)'} ===`);
    console.log(`  단건 필드 ${Object.keys(single).length}개`);
    console.log(
      `  단건: 현재가=${single.stck_prpr} 등락=${single.prdy_ctrt} 시=${single.stck_oprc} 고=${single.stck_hgpr} 저=${single.stck_lwpr} 거래량=${single.acml_vol} 거래대금=${single.acml_tr_pbmn}`,
    );
    if (m) {
      console.log(
        `  멀티: 현재가=${m.inter2_prpr} 등락=${m.prdy_ctrt} 시=${m.inter2_oprc} 거래량=${m.acml_vol} 거래대금=${m.acml_tr_pbmn}`,
      );
      console.log(
        `  멀티 호가: 매도호가=[${m.inter2_askp}] 매수호가=[${m.inter2_bidp}] 매도1잔량=[${m.seln_rsqn}] 매수1잔량=[${m.shnu_rsqn}] 총매도잔량=[${m.total_askp_rsqn}] 총매수잔량=[${m.total_bidp_rsqn}]`,
      );
      console.log(
        `  멀티 예상체결: vrss=[${m.intr_antc_cntg_vrss}] sign=[${m.intr_antc_cntg_vrss_sign}] ctrt=[${m.intr_antc_cntg_prdy_ctrt}] vol=[${m.intr_antc_vol}] hour_cls=[${m.hour_cls_code}]`,
      );
    } else {
      console.log('  멀티: 행 없음');
    }
    const flagged = Object.entries(single).filter(([k]) => STATUS_FIELD_HINT.test(k));
    console.log(`  단건 상태성 필드 ${flagged.length}개:`);
    for (const [k, v] of flagged) console.log(`    ${k} = [${v}]`);
  }

  if (given.length > 0) return;

  // 어떤 필드가 있는지 전체를 한 번은 눈으로 본다. 이름만 보고 넘겨짚지 않는다.
  const sample = await singleOutput(SUSPECTS[0]);
  console.log(`\n=== ${SUSPECTS[0]} 단건 전체 필드 ${Object.keys(sample).length}개 ===`);
  console.log(`  ${Object.keys(sample).join(' ')}`);
  console.log(`  잔량(rsqn)·호가(askp/bidp) 필드: [${Object.keys(sample).filter((k) => /rsqn|askp|bidp/.test(k)).join(' ')}]`);
  for (const [k, v] of Object.entries(sample)) console.log(`  ${k} = [${v}]`);
}

/**
 * 스크리닝 풀 120종목을 멀티시세로 훑어 **호가가 통째로 빈 종목**을 찾고,
 * 그 종목만 단건으로 다시 물어 플래그와 맞는지 본다.
 *
 * 멀티 4회 + (의심 종목 수)회. 전 종목을 단건으로 물으면 124회다 — 그게 안 되는
 * 이유가 이 조사의 전제다.
 */
async function probeScan(): Promise<void> {
  const poolSize = Number(process.argv[3] ?? 120);
  const pools = await Promise.all(
    ['kr-all', 'kr-etf'].map((category) => getCategoryInstruments(category, 300).catch(() => [])),
  );
  const symbols: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; symbols.length < poolSize; index += 1) {
    let added = false;
    for (const list of pools) {
      const instrument = list[index];
      if (!instrument || instrument.provider !== 'kis' || seen.has(instrument.providerSymbol)) continue;
      seen.add(instrument.providerSymbol);
      symbols.push(instrument.providerSymbol);
      added = true;
    }
    if (!added) break;
  }

  const rows: Array<Record<string, string>> = [];
  for (let i = 0; i < symbols.length; i += 30) {
    rows.push(...(await multiRows(symbols.slice(i, i + 30))));
  }
  console.log(`\n=== 풀 ${symbols.length}종목 · 멀티 응답 ${rows.length}행 ===`);

  const emptyBook: Array<Record<string, string>> = [];
  const oneSided: Array<Record<string, string>> = [];
  const zeroTurnover: Array<Record<string, string>> = [];
  for (const r of rows) {
    const ask = Number(r.total_askp_rsqn || '0');
    const bid = Number(r.total_bidp_rsqn || '0');
    if (ask === 0 && bid === 0) emptyBook.push(r);
    else if (ask === 0 || bid === 0) oneSided.push(r);
    if (Number(r.acml_tr_pbmn || '0') === 0) zeroTurnover.push(r);
  }
  console.log(`  호가 잔량이 양쪽 0 : ${emptyBook.length}종목`);
  console.log(`  호가 잔량이 한쪽만 0 : ${oneSided.length}종목 (상·하한가 잠김이면 정상이다)`);
  for (const r of oneSided) {
    console.log(
      `    ${r.inter_shrn_iscd} ${String(r.inter_kor_isnm).padEnd(16)} 등락=${String(r.prdy_ctrt).padStart(7)} 현재가=${r.inter2_prpr} 상한가=${r.inter2_mxpr} 하한가=${r.inter2_llam} 총매도=${r.total_askp_rsqn} 총매수=${r.total_bidp_rsqn} 거래대금=${r.acml_tr_pbmn}`,
    );
  }
  console.log(`  거래대금 0원       : ${zeroTurnover.length}종목`);
  const onlyZeroTurnover = zeroTurnover.filter((r) => !emptyBook.includes(r));
  console.log(`  거래대금만 0 (호가는 있음): ${onlyZeroTurnover.length}종목`);

  const show = (label: string, list: Array<Record<string, string>>) => {
    console.log(`\n  ${label}`);
    for (const r of list) {
      console.log(
        `    ${r.inter_shrn_iscd} ${String(r.inter_kor_isnm).padEnd(18)} 현재가=${String(r.inter2_prpr).padStart(9)} 등락=${String(r.prdy_ctrt).padStart(7)} 시=${String(r.inter2_oprc).padStart(9)} 거래량=${String(r.acml_vol).padStart(10)} 총매도=${String(r.total_askp_rsqn).padStart(9)} 총매수=${String(r.total_bidp_rsqn).padStart(9)}`,
      );
    }
  };
  show('호가 잔량 양쪽 0:', emptyBook);
  show('거래대금만 0 (호가는 있음):', onlyZeroTurnover);

  // 의심 종목만 단건으로 되물어 플래그를 확인한다.
  const suspects = [...new Set([...emptyBook, ...onlyZeroTurnover].map((r) => r.inter_shrn_iscd))];
  console.log(`\n  === 단건 플래그 대조 — 의심 종목 (${suspects.length}회) ===`);
  for (const symbol of suspects) {
    const single = await singleOutput(symbol);
    console.log(
      `    ${symbol} 상태=${single.iscd_stat_cls_code} 임시정지=${single.temp_stop_yn} 관리=${single.mang_issu_cls_code} 정리매매=${single.sltr_yn} VI=${single.vi_cls_code} 경고=${single.mrkt_warn_cls_code}`,
    );
  }

  /*
   * 반대 방향도 본다 — **호가가 있는데 거래정지인 종목**이 있으면 놓친 것이다.
   * 전 종목을 단건으로 물을 수는 없으니 고르게 뽑아 표본으로 센다.
   */
  const withBook = rows.filter((r) => !emptyBook.includes(r));
  const stride = Math.max(1, Math.floor(withBook.length / 15));
  const controls = withBook.filter((_, i) => i % stride === 0).slice(0, 15);
  console.log(`\n  === 단건 플래그 대조 — 호가가 있는 종목 표본 (${controls.length}/${withBook.length}종목) ===`);
  let missed = 0;
  for (const r of controls) {
    const symbol = r.inter_shrn_iscd;
    const single = await singleOutput(symbol);
    if (single.iscd_stat_cls_code === '58') missed += 1;
    console.log(
      `    ${symbol} ${String(r.inter_kor_isnm).padEnd(16)} 상태=${single.iscd_stat_cls_code} 임시정지=${single.temp_stop_yn} VI=${single.vi_cls_code} 총매도=${r.total_askp_rsqn} 총매수=${r.total_bidp_rsqn} 거래대금=${r.acml_tr_pbmn}`,
    );
  }
  console.log(`  호가가 있는데 상태=58인 종목: ${missed}/${controls.length}`);
}

/**
 * 우리 코드가 실제로 갈라내는지 본다. 시험은 픽스처로 도는데, 지금 장중 응답에
 * 잔량이 실제로 실려 오는지는 실호출로만 알 수 있다 — 필드명을 한 글자만 틀려도
 * 전 종목이 "모른다"로 떨어지고 판정이 조용히 사라진다.
 */
async function probeVerify(): Promise<void> {
  const cash = Number(process.argv[3] ?? 1_000_000);
  const lookups = Number(process.argv[4] ?? 120);
  const result = await runScreening(cash, lookups);
  calls += Math.ceil(lookups / 30);

  const counts = new Map<string, number>();
  for (const row of result.rows) counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);
  console.log(
    `\n=== runScreening(현금 ${cash.toLocaleString()}원, ${lookups}종목) · 장 경과 ${(result.elapsed * 100).toFixed(1)}% ===`,
  );
  console.log(`  풀 ${result.poolSize} · 시세 못 받음 ${result.unresolved}`);
  for (const [verdict, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${verdict.padEnd(14)} ${count}`);
  }
  for (const row of result.rows.filter((r) => r.verdict === 'noOrderBook')) {
    console.log(
      `    호가 없음: ${row.symbol} ${row.name} 현재가=${row.price.toLocaleString()} 등락=${row.changeRate} 거래대금=${row.turnover}`,
    );
  }
}

/** 테마 등락률에서 호가 없는 종목이 실제로 빠지는지. 표본 사슬을 그대로 찍는다. */
async function probeTheme(): Promise<void> {
  const codes = process.argv.slice(3);
  if (codes.length === 0) throw new Error('테마 코드를 하나 이상 넣어라 (예: 012 004 260)');
  const batch = await getThemePulses(codes);
  calls += batch.quoteCalls;
  console.log(`\n=== 테마 등락률 · 조회 ${batch.quoteCalls}/${batch.maxQuoteCalls}회 ===`);
  for (const pulse of batch.pulses) {
    console.log(
      `\n  ${pulse.theme.code} ${pulse.theme.name} — 명단 ${pulse.theme.symbolCount} · 찾은 종목 ${pulse.theme.instrumentCount} · 등락률 ${pulse.quotedCount}`,
    );
    console.log(
      `    중앙값=${pulse.changeRateMedian?.toFixed(3) ?? '없음'} 단순평균=${pulse.changeRateMean?.toFixed(3) ?? '없음'} 가중=${pulse.changeRateWeighted?.toFixed(3) ?? '없음'}(${pulse.turnoverCount}종목)`,
    );
    console.log(`    상승 ${pulse.advancing} · 하락 ${pulse.declining} · 보합 ${pulse.unchanged}`);
    console.log(
      `    호가 없음 ${pulse.noOrderBookSymbols.length}종목 [${pulse.noOrderBookSymbols.join(' ')}] · 빈 값 ${pulse.blankSymbols.length} · 실패 ${pulse.failedSymbols.length}`,
    );
  }
  for (const skip of batch.skipped) console.log(`  건너뜀 ${skip.code}: ${skip.reason}`);
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'fields';
  console.log(`env=${config.env} restBase=${config.restBase} now=${new Date().toISOString()} mode=${mode}`);
  if (mode === 'fields') await probeFields();
  else if (mode === 'scan') await probeScan();
  else if (mode === 'verify') await probeVerify();
  else if (mode === 'theme') await probeTheme();
  else throw new Error(`모르는 모드입니다: ${mode} (fields|scan|verify|theme)`);
  console.log(`\n총 KIS 호출 ${calls}회`);
}

main().catch((err) => {
  console.error(err);
  console.log(`\n총 KIS 호출 ${calls}회 (실패로 중단)`);
  process.exit(1);
});
