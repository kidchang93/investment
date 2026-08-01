/**
 * 지금 설정으로 **어느 서버의 어느 계좌가 실제로 붙는지** 확인한다. 조회만 한다.
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────────────
 *
 * `.env` 하나에 실계좌와 모의계좌 자격증명이 함께 산다. 그런데 서버 환경
 * (`APP_ENV`)은 **전역 하나**라 도메인이 통째로 갈린다 — 실전이면
 * `openapi...:9443`, 모의면 `openapivts...:29443`이다.
 *
 * 그래서 짝이 어긋날 수 있다. 모의 도메인에 실계좌 앱키로 붙거나 그 반대다.
 * 그 경우 오류가 조회 시점에야 나오고, 그때는 이미 화면이 "계좌를 못 읽었다"만
 * 말한다 — **왜** 못 읽었는지는 안 나온다.
 *
 * 특히 시세·실시간 WS가 쓰는 **기본 자격증명**(`primaryCredentialId`)이 중요하다.
 * `KIS_PRIMARY_ACCOUNT_ID`를 안 주면 계좌 id 오름차순 첫 번째가 되는데, 실계좌
 * id가 숫자(`21`)이고 모의가 문자(`VTS`)면 **모의 환경인데 실계좌 앱키가 기본**이
 * 된다. 그러면 토큰 발급부터 실패해 시세가 통째로 죽는다.
 *
 * **주문은 내지 않는다.** 잔고 조회뿐이다.
 *
 *   npx tsx src/scripts/probeAccounts.ts
 *   APP_ENV=vts KIS_PRIMARY_ACCOUNT_ID=VTS npx tsx src/scripts/probeAccounts.ts
 */

import { config, getKisAccount } from '../config.js';
import { getKisDomesticAccountSnapshot } from '../kis/rest.js';

function money(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value).toLocaleString('ko-KR')}원`;
}

async function main(): Promise<void> {
  const envLabel = config.env === 'prod' ? '실전 서버' : '모의 서버';
  console.log(`${envLabel} (${config.env}) · ${config.restBase}`);
  console.log(`시세·실시간이 쓰는 기본 자격증명: 계좌 ${config.primaryCredentialId}`);
  console.log(`실주문 게이트: ${config.liveOrderEnabled ? '열림' : '잠김'}`);
  console.log(`계좌 ${config.kisAccounts.length}개 — ${config.kisAccounts.map((a) => a.id).join(', ') || '없음'}`);
  for (const skipped of config.skippedKisAccounts) {
    console.log(`  ⚠ 계좌 ${skipped.id}은(는) 설정에서 빠졌습니다 — ${skipped.reason}`);
  }
  console.log();

  let ok = 0;
  for (const account of config.kisAccounts) {
    try {
      const snapshot = await getKisDomesticAccountSnapshot(getKisAccount(account.id));
      if (!snapshot.configured) {
        console.log(`  ${account.id.padEnd(5)} 미설정 — ${snapshot.message ?? ''}`);
        continue;
      }
      ok += 1;
      console.log(
        `  ${account.id.padEnd(5)} 연결 · 예수금 ${money(snapshot.cashBalance)}`
        + ` · 총평가 ${money(snapshot.totalEvaluation)}`
        + ` · 보유 ${snapshot.positions.length}종목`,
      );
      for (const position of snapshot.positions.slice(0, 5)) {
        console.log(
          `        ${position.symbol} ${position.name.slice(0, 12).padEnd(14)}`
          + ` ${position.quantity}주 · 평단 ${money(position.averagePrice)}`,
        );
      }
    } catch (err) {
      /*
       * 실패도 결과다. 어느 계좌가 이 환경에서 안 붙는지가 알고 싶은 것이라
       * 던지지 않고 사유를 적는다 — 앱키와 서버가 어긋나면 여기서 걸린다.
       */
      console.log(`  ${account.id.padEnd(5)} 실패 — ${(err as Error).message.slice(0, 200)}`);
    }
  }

  console.log(`\n${config.kisAccounts.length}개 중 ${ok}개 연결됨.`);
  if (ok === 0) {
    console.log('하나도 안 붙었으면 APP_ENV와 앱키의 짝을 먼저 본다 — 도메인이 통째로 갈린다.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
