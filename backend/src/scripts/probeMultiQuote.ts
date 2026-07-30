/**
 * 멀티시세(관심종목 복수시세, FHKST11300006)가 실제로 무엇을 주는지 찍어 본다 (일회성 조사용).
 *
 * 공식 레포는 "한 번의 호출에 최대 30종목"이라고만 적는다. 그 말만 믿고 붙이면
 * 다음 셋을 모르는 채로 쓰게 된다.
 *   1. 31개를 넣으면 거부인가, 앞 30개만 오는가, 조용히 잘리는가
 *   2. 없는 종목코드가 섞이면 그 자리만 비는가, 통째로 실패하는가
 *   3. 출력 순서가 입력 순서와 같은가 (다르면 반드시 코드로 맞춰야 한다)
 *
 * 그리고 가장 중요한 것 — **단건 조회(FHKST01010100)와 값이 같은가.** 다르면
 * 이 API로 갈아타는 순간 화면 숫자가 조용히 바뀐다.
 *
 * 호출 예산이 있는 조사라 단계를 골라 돌릴 수 있게 했고, 마지막에 호출 수를 찍는다.
 *
 *   npx tsx src/scripts/probeMultiQuote.ts shape     # 응답 형식·상한·없는 코드·ETF
 *   npx tsx src/scripts/probeMultiQuote.ts compare   # 단건과 값 대조
 *   npx tsx src/scripts/probeMultiQuote.ts record    # 실제 응답을 시험 픽스처로 저장
 *   npx tsx src/scripts/probeMultiQuote.ts budget    # 연속 호출이 초당 한도에 걸리는지
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../config.js';
import { getCategoryInstruments } from '../db/instruments.js';
import { getAccessToken, primaryCredentials } from '../kis/auth.js';
import { getDomesticQuotes } from '../kis/rest.js';

const MULTI_PATH = '/uapi/domestic-stock/v1/quotations/intstock-multprice';
const MULTI_TR_ID = 'FHKST11300006';
const SINGLE_PATH = '/uapi/domestic-stock/v1/quotations/inquire-price';
const SINGLE_TR_ID = 'FHKST01010100';

/** 응답 행의 종목코드 필드. 이름·코드가 `inter_` 접두사고 값은 `inter2_` 접두사다. */
const CODE_FIELD = 'inter_shrn_iscd';

/** 반도체 테마(004)에서 뽑은 실제 종목. 테마 등락률이 이 API의 첫 사용처다. */
const SEMICONDUCTOR: string[] = [
  '000660', '000990', '003160', '005930', '009310',
  '011930', '020120', '024850', '029460', '030530',
  '031980', '033160', '033640', '036200', '036540',
  '036810', '036930', '037350', '038880', '039030',
  '039440', '042700', '045100', '045300', '050110',
  '051780', '052900', '056190', '058470', '064290',
  '064520', // 31번째
];

let calls = 0;

async function call(
  path: string,
  trId: string,
  params: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
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
  // 초당 한도(EGW00201)를 피한다. 조사도 한도를 태우면 아무것도 못 받는다.
  await new Promise((r) => setTimeout(r, 300));
  return { status: res.status, json };
}

function multiParams(symbols: string[], marketCode = 'J'): Record<string, string> {
  const params: Record<string, string> = {};
  symbols.forEach((symbol, index) => {
    params[`FID_COND_MRKT_DIV_CODE_${index + 1}`] = marketCode;
    params[`FID_INPUT_ISCD_${index + 1}`] = symbol;
  });
  return params;
}

async function multi(
  label: string,
  symbols: string[],
  marketCode = 'J',
): Promise<{ rows: Array<Record<string, string>>; json: Record<string, unknown> }> {
  const { status, json } = await call(MULTI_PATH, MULTI_TR_ID, multiParams(symbols, marketCode));
  const keys = Object.keys(json).filter((k) => k.startsWith('output'));
  const raw = json.output;
  const rows = (Array.isArray(raw) ? raw : []) as Array<Record<string, string>>;
  console.log(`\n=== ${label} (입력 ${symbols.length}종목) ===`);
  console.log(
    `HTTP ${status} · rt_cd=${json.rt_cd} · msg_cd=${json.msg_cd} · ${json.msg1} · output 키=[${keys.join(',')}] · 배열?${Array.isArray(raw)} · 행 ${rows.length}`,
  );
  return { rows, json };
}

function code(row: Record<string, string>): string {
  return String(row[CODE_FIELD] ?? '').trim();
}

async function probeShape(): Promise<void> {
  // ── 1) 30종목: 응답 형식과 필드 전체를 본다 ─────────────────────────
  const thirty = (await multi('30종목', SEMICONDUCTOR.slice(0, 30))).rows;
  if (thirty.length > 0) {
    console.log(`  첫 행 필드 ${Object.keys(thirty[0]).length}개:`);
    console.log(`    ${Object.keys(thirty[0]).join(' ')}`);
    console.log('  첫 행 원문:');
    for (const [k, v] of Object.entries(thirty[0])) console.log(`    ${k} = ${v}`);
    console.log(`  입력: ${SEMICONDUCTOR.slice(0, 30).join(' ')}`);
    console.log(`  출력: ${thirty.map(code).join(' ')}`);
    console.log(`  순서 일치? ${thirty.every((r, i) => code(r) === SEMICONDUCTOR[i])}`);
    for (const [i, r] of thirty.entries()) {
      console.log(
        `    ${String(i + 1).padStart(2)} ${code(r)} ${r.inter_kor_isnm} 현재가=${r.inter2_prpr} 등락=${r.prdy_ctrt} 거래량=${r.acml_vol} 거래대금=${r.acml_tr_pbmn}`,
      );
    }
  }

  // ── 2) 31종목: 초과하면 어떻게 되나 ────────────────────────────────
  const thirtyOne = (await multi('31종목(초과)', SEMICONDUCTOR.slice(0, 31))).rows;
  if (thirtyOne.length > 0) {
    console.log(`  출력 코드: ${thirtyOne.map(code).join(' ')}`);
    console.log(`  31번째(${SEMICONDUCTOR[30]}) 포함? ${thirtyOne.some((r) => code(r) === SEMICONDUCTOR[30])}`);
  }

  // ── 3) 20종목만: 파라미터를 덜 채우면 ──────────────────────────────
  const twenty = (await multi('20종목', SEMICONDUCTOR.slice(0, 20))).rows;
  if (twenty.length > 0) console.log(`  출력 코드: ${twenty.map(code).join(' ')}`);

  // ── 4) 없는 종목코드 섞기 ─────────────────────────────────────────
  const withBogus = ['005930', '000660', '999999', '042700', '069500'];
  const bogus = (await multi('없는 종목코드(999999) 섞기', withBogus)).rows;
  for (const [i, r] of bogus.entries()) {
    console.log(
      `    ${i + 1} 입력=${withBogus[i]} 코드=[${r[CODE_FIELD]}] 이름=[${r.inter_kor_isnm}] 현재가=[${r.inter2_prpr}] 등락=[${r.prdy_ctrt}]`,
    );
  }

  // ── 5) ETF도 되나 (시장구분 J 그대로) ──────────────────────────────
  const etf = (await multi('ETF (069500·122630) + 주식', ['069500', '122630', '005930'])).rows;
  for (const r of etf) {
    console.log(
      `    ${code(r)} ${r.inter_kor_isnm} 현재가=${r.inter2_prpr} 등락=${r.prdy_ctrt} 거래량=${r.acml_vol} 거래대금=${r.acml_tr_pbmn}`,
    );
  }

  // ── 6) 입력 순서를 뒤집으면 출력도 뒤집히나 ────────────────────────
  const reversed = ['069500', '042700', '000660', '005930'];
  const rev = (await multi('순서 뒤집기', reversed)).rows;
  console.log(`    입력: ${reversed.join(' ')}`);
  console.log(`    출력: ${rev.map(code).join(' ')}`);
}

async function probeCompare(): Promise<void> {
  console.log('\n=== 단건 대조 (FHKST01010100 vs FHKST11300006) ===');
  const compareSymbols = ['005930', '000660', '069500'];
  const multiForCompare = (await multi('대조용 멀티 3종목', compareSymbols)).rows;
  const multiByCode = new Map(multiForCompare.map((r) => [code(r), r]));

  for (const symbol of compareSymbols) {
    const { json } = await call(SINGLE_PATH, SINGLE_TR_ID, {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: symbol,
    });
    const single = (json.output ?? {}) as Record<string, string>;
    const m = multiByCode.get(symbol);
    console.log(`\n  ${symbol}`);
    const pairs: Array<[string, string, string]> = [
      ['현재가', 'stck_prpr', 'inter2_prpr'],
      ['전일대비', 'prdy_vrss', 'inter2_prdy_vrss'],
      ['등락률', 'prdy_ctrt', 'prdy_ctrt'],
      ['부호', 'prdy_vrss_sign', 'prdy_vrss_sign'],
      ['시가', 'stck_oprc', 'inter2_oprc'],
      ['고가', 'stck_hgpr', 'inter2_hgpr'],
      ['저가', 'stck_lwpr', 'inter2_lwpr'],
      ['전일종가', 'stck_sdpr', 'inter2_prdy_clpr'],
      ['누적거래량', 'acml_vol', 'acml_vol'],
      ['누적거래대금', 'acml_tr_pbmn', 'acml_tr_pbmn'],
      ['상한가', 'stck_mxpr', 'inter2_mxpr'],
      ['하한가', 'stck_llam', 'inter2_llam'],
    ];
    for (const [label, singleKey, multiKey] of pairs) {
      const a = single[singleKey];
      const b = m?.[multiKey];
      const same = a !== undefined && b !== undefined && Number(a) === Number(b);
      console.log(
        `    ${label.padEnd(6)} 단건 ${singleKey}=${a ?? '(없음)'} · 멀티 ${multiKey}=${b ?? '(없음)'} ${same ? '일치' : '≠'}`,
      );
    }
    if (m) {
      const onlyMulti = Object.keys(m).filter((k) => !(k in single));
      const onlySingle = Object.keys(single).filter((k) => !(k in m));
      console.log(`    멀티에만: ${onlyMulti.join(' ')}`);
      console.log(`    단건 전용 필드 ${onlySingle.length}개`);
    }
  }
}

/**
 * 실제 응답을 시험 픽스처로 저장한다.
 *
 * 지어낸 모양으로 파서를 재면 실제와 어긋나도 통과한다. 특히 없는 종목코드가
 * **빈 행으로 자리를 지킨다**는 것은 지어내서는 절대 나오지 않는 모양이다.
 */
async function probeRecord(): Promise<void> {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../kis/fixtures');
  mkdirSync(dir, { recursive: true });

  const cases: Array<{ file: string; label: string; symbols: string[] }> = [
    { file: 'intstockMultprice-30.json', label: '30종목', symbols: SEMICONDUCTOR.slice(0, 30) },
    {
      file: 'intstockMultprice-missing.json',
      label: '없는 코드 섞기',
      symbols: ['005930', '000660', '999999', '042700', '069500'],
    },
  ];

  for (const c of cases) {
    const { json } = await multi(c.label, c.symbols);
    const path = resolve(dir, c.file);
    writeFileSync(
      path,
      `${JSON.stringify({ recordedAt: new Date().toISOString(), requestedSymbols: c.symbols, response: json }, null, 2)}\n`,
    );
    console.log(`  저장: ${path}`);
  }
}

/**
 * 조회 상한을 정하려면 **연속 호출이 초당 한도에 걸리는지**를 재야 한다.
 * 숫자만 올리고 `EGW00201`에 걸리면 아무것도 못 받는다.
 *
 * 우리 실제 경로(`getDomesticQuotes` → `kisGet` → `scheduleKisCall`)를 그대로
 * 태운다. 별도로 fetch를 짜면 간격 조절이 빠진 채로 재게 된다.
 */
async function probeBudget(): Promise<void> {
  const chunks = Number(process.argv[3] ?? 10);
  const instruments = await getCategoryInstruments('kr-all', 300);
  const symbols = instruments
    .filter((i) => i.country === 'KR' && i.provider === 'kis')
    .map((i) => i.providerSymbol)
    .slice(0, chunks * 30);
  console.log(`\n=== 연속 호출 ${chunks}묶음 (${symbols.length}종목) ===`);

  const started = Date.now();
  const result = await getDomesticQuotes(symbols);
  const elapsed = Date.now() - started;
  calls += chunks;

  console.log(`  걸린 시간 ${(elapsed / 1000).toFixed(2)}초`);
  console.log(`  받은 시세 ${result.quotes.size}종목 · 빈 자리 ${result.blank.length} · 실패 묶음 ${result.failed.length}`);
  for (const failure of result.failed) {
    console.log(`    실패 ${failure.codes.length}종목: ${failure.message}`);
  }
  const rateLimited = result.failed.filter((f) => f.message.includes('EGW00201')).length;
  console.log(`  초당 한도(EGW00201) 걸린 묶음 ${rateLimited}건`);
  if (result.blank.length > 0) console.log(`  빈 자리 코드: ${result.blank.join(' ')}`);
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'shape';
  console.log(`env=${config.env} restBase=${config.restBase} now=${new Date().toISOString()} mode=${mode}`);
  if (mode === 'shape') await probeShape();
  else if (mode === 'compare') await probeCompare();
  else if (mode === 'record') await probeRecord();
  else if (mode === 'budget') await probeBudget();
  else throw new Error(`모르는 모드입니다: ${mode} (shape|compare|record|budget)`);
  console.log(`\n총 KIS 호출 ${calls}회`);
}

main().catch((err) => {
  console.error(err);
  console.log(`\n총 KIS 호출 ${calls}회 (실패로 중단)`);
  process.exit(1);
});
