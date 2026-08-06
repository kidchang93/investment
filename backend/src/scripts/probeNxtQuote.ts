/**
 * 시세 TR이 **거래소를 고를 수 있는가**를 확인한다.
 *
 * ── 왜 (2026-08-05) ──────────────────────────────────────────────────────
 *
 * 이 레포는 `FID_COND_MRKT_DIV_CODE`를 어디서나 `'J'`(KRX)로 박아 뒀다
 * (`rest.ts:744`·`:1258`, `multiQuote.ts:72`). 그래서 **NXT 프리마켓
 * 08:00~08:50에 실제로 체결되는 값을 한 번도 본 적이 없다.**
 *
 * KIS 공식 카탈로그(MCP/data.csv)는 같은 TR이 `J:KRX, NX:NXT, UN:통합`을
 * 받는다고 적는다. 사실이면 **주문 경로를 하나도 안 건드리고** 개장 전 흐름을
 * 볼 수 있다. 문서에만 있는 이야기라 찍어서 확인한다.
 *
 * ── 대조군을 함께 넣는다 ─────────────────────────────────────────────────
 *
 * 2026-08-05에 `ORD_DVSN` 조회로 같은 것을 하려다 당했다 — 아무 값이나 넣어도
 * 통과해서 "05/06/07 다 된다"고 쓸 뻔했다. **말이 안 되는 코드(`ZZ`)를 함께
 * 보내** 그것도 통과하면 이 TR은 필드를 검사하지 않는 것이고, 그러면 `NX`가
 * 통과한 것도 아무 뜻이 없다.
 *
 * ── 무엇으로 "진짜 NXT"라고 판정하나 ─────────────────────────────────────
 *
 * 응답이 오는 것으로는 부족하다. **`J`와 값이 달라야** 다른 시장을 본 것이다.
 * 같은 값이 오면 KIS가 코드를 무시하고 KRX를 준 것이다.
 *
 * 조회 전용이다. 주문을 내지 않는다.
 *
 *   npx tsx src/scripts/probeNxtQuote.ts [종목코드...]
 */

import { getKisAccount } from '../config.js';
import { probeRawQuery } from '../kis/rest.js';

const symbols = process.argv.slice(2);
const targets = symbols.length > 0 ? symbols : ['005930', '000660', '035420'];

const prodId = process.env.KIS_OPEN_DAY_CREDENTIAL_ID;
const account = prodId ? getKisAccount(prodId) : null;
if (!account) {
  console.error('실전 조회 자격증명(KIS_OPEN_DAY_CREDENTIAL_ID)이 필요하다.');
  process.exit(1);
}

/** 마지막이 대조군이다 — 통과하면 이 TR은 필드를 안 본다는 뜻이다 */
const MARKET_CODES: Array<{ code: string; label: string; control?: boolean }> = [
  { code: 'J', label: 'KRX (지금 쓰는 값)' },
  { code: 'NX', label: 'NXT' },
  { code: 'UN', label: '통합' },
  { code: 'ZZ', label: '★ 대조군 (없는 코드)', control: true },
];

console.log(`자격증명 ${account.id}(조회 전용) · ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST\n`);

for (const symbol of targets) {
  console.log(`── ${symbol} ${'─'.repeat(56)}`);
  const seen = new Map<string, string>();
  for (const { code, label, control } of MARKET_CODES) {
    try {
      const body = await probeRawQuery(
        account,
        '/uapi/domestic-stock/v1/quotations/inquire-price',
        'FHKST01010100',
        { FID_COND_MRKT_DIV_CODE: code, FID_INPUT_ISCD: symbol },
      );
      const rt = String(body.rt_cd ?? '');
      const msg = String(body.msg1 ?? '').trim();
      const out = (body.output ?? {}) as Record<string, string>;
      // 현재가·누적거래량 둘을 함께 본다. 값이 다르면 다른 시장을 본 것이다.
      const price = String(out.stck_prpr ?? '').trim();
      const volume = String(out.acml_vol ?? '').trim();
      const fingerprint = `${price}/${volume}`;
      if (rt === '0' && price) seen.set(code, fingerprint);
      console.log(
        `  ${code.padEnd(3)} ${label.padEnd(20)} rt_cd=${rt || '?'}`
        + `  현재가 ${(price || '—').padStart(9)}  누적거래량 ${(volume || '—').padStart(12)}`
        + (msg && rt !== '0' ? `  · ${msg}` : '')
        + (control && rt === '0' && price ? '  ← ★ 없는 코드인데 통과했다' : ''),
      );
    } catch (error) {
      console.log(`  ${code.padEnd(3)} ${label.padEnd(20)} 던짐: ${(error as Error).message.slice(0, 70)}`);
    }
  }

  const krx = seen.get('J');
  const nxt = seen.get('NX');
  const control = seen.get('ZZ');
  console.log();
  if (control !== undefined) {
    console.log('  ▶ 판정 불가 — 대조군이 통과했다. 이 TR은 거래소 코드를 검사하지 않는다.');
  } else if (nxt === undefined) {
    console.log('  ▶ NX는 거절됐다. 이 TR로는 NXT를 못 본다.');
  } else if (krx !== undefined && krx === nxt) {
    console.log('  ▶ NX가 통과했지만 **값이 KRX와 같다** — 코드를 무시하고 KRX를 준 것이다.');
  } else {
    console.log('  ▶ ★ NX가 KRX와 다른 값을 준다. 진짜로 다른 시장을 보고 있다.');
  }
  console.log();
}

console.log('★ 지금은 정규장 시간이라 두 시장이 함께 돌고 있다. 여기서 갈린다고 해서');
console.log('  08:00~08:50(KRX 휴장·NXT 프리마켓)에도 값이 온다는 보장은 없다 — 그건 그 시각에 다시 재야 한다.');

process.exit(0);
