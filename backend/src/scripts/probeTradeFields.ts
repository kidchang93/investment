/**
 * H0STCNT0 한 레코드가 실제로 몇 필드인가 — 문서가 46→47로 바뀌었다(2026-09-11).
 *
 * 판정은 **여러 체결이 붙은 프레임**에서만 된다. 필드 총수 ÷ 건수가 레코드 길이이고,
 * 두 번째 레코드의 첫 칸(종목코드)이 46번째에 오나 47번째에 오나로 교차 확인한다.
 * 조회 전용. 주문 경로를 부르지 않는다.
 *
 * ★ 백엔드가 기본 앱키(VTS-ORDINARY)로 실시간 세션을 잡고 있으니 **다른 앱키로** 붙는다.
 *   2026-09-15 결과: 모의(VTS-EXTRAORDINARY)·실전(21) 각 1분, 프레임 512·515개 전부 47필드,
 *   여러 건 붙은 프레임 295개에서 두 번째 레코드 종목코드가 전부 47번째에 왔다. 47번째 값은 `2`(정규장).
 *
 *   cd backend && APP_ENV=prod KIS_PRIMARY_ACCOUNT_ID=21 npx tsx src/scripts/probeTradeFields.ts 60
 *   cd backend && APP_ENV=vts KIS_PRIMARY_ACCOUNT_ID=VTS-EXTRAORDINARY npx tsx src/scripts/probeTradeFields.ts 60
 */
import WebSocket from 'ws';

import { config } from '../config.js';
import { getApprovalKey } from '../kis/auth.js';

const seconds = Number(process.argv[2] ?? 60);
const codes = ['005930', '000660', '069500'];
const approvalKey = await getApprovalKey();
const tag = `${config.env}/${config.primaryCredentialId}`;

const perLen = new Map<number, number>(); // 레코드 길이 → 프레임 수
let frames = 0;
let multi = 0;
let stride46 = 0;
let stride47 = 0;
let sample = '';
const marketCls = new Map<string, number>();

const ws = new WebSocket(config.wsBase);
ws.on('open', () => {
  for (const code of codes) {
    ws.send(JSON.stringify({
      header: { approval_key: approvalKey, custtype: config.custType, tr_type: '1', 'content-type': 'utf-8' },
      body: { input: { tr_id: 'H0STCNT0', tr_key: code } },
    }));
  }
});
ws.on('message', (buf) => {
  const raw = buf.toString();
  if (raw.startsWith('{')) {
    const j = JSON.parse(raw);
    if (j.header?.tr_id === 'PINGPONG') { ws.send(raw); return; }
    console.log(`[${tag}] 응답 rt_cd=${j.body?.rt_cd} ${String(j.body?.msg1 ?? '').trim()}`);
    return;
  }
  const parts = raw.split('|');
  if (parts[1] !== 'H0STCNT0') return;
  const count = Number(parts[2]) || 1;
  const fields = parts[3].split('^');
  frames++;
  const len = fields.length / count;
  perLen.set(len, (perLen.get(len) ?? 0) + 1);
  if (len === 47) marketCls.set(fields[46], (marketCls.get(fields[46]) ?? 0) + 1);
  if (count >= 2) {
    multi++;
    if (fields[46] === fields[0]) stride46++;
    if (fields[47] === fields[0]) stride47++;
    if (!sample) sample = `건수 ${count} · 총 ${fields.length}필드 · [45..48]=${JSON.stringify(fields.slice(45, 49))}`;
  }
});
ws.on('error', (e) => console.log(`[${tag}] 오류 ${e.message}`));

setTimeout(() => {
  console.log(`[${tag}] 프레임 ${frames} · 여러 건 붙은 프레임 ${multi}`);
  console.log(`[${tag}] 레코드 길이(총필드÷건수) 분포 ${JSON.stringify([...perLen])}`);
  console.log(`[${tag}] 두 번째 레코드 종목코드 위치 — 46번째 ${stride46} · 47번째 ${stride47}`);
  console.log(`[${tag}] 47번째 필드 값 분포 ${JSON.stringify([...marketCls])}`);
  if (sample) console.log(`[${tag}] 예 ${sample}`);
  for (const code of codes) {
    ws.send(JSON.stringify({
      header: { approval_key: approvalKey, custtype: config.custType, tr_type: '2', 'content-type': 'utf-8' },
      body: { input: { tr_id: 'H0STCNT0', tr_key: code } },
    }));
  }
  setTimeout(() => { ws.close(); process.exit(0); }, 500);
}, seconds * 1000);
