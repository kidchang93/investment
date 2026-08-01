/**
 * 계좌번호를 KIS `CANO`에 **어떤 형태로** 넣어야 맞는지 시험한다. 조회만 한다.
 *
 * ── 왜 ────────────────────────────────────────────────────────────────────
 *
 * KIS 모의투자 계좌번호가 7자리로 발급되는데 `CANO`는 8자리 고정 필드다.
 * 왼쪽에 0을 채워 봤더니 `INVALID_CHECK_ACNO`였다 — 앱키는 통과했으니
 * (`EGW02007`이 아니었다) **계좌번호 형태만 틀린 것**이다.
 *
 * 어느 형태가 맞는지는 KIS 문서로 확정할 수 없어 **직접 시험한다.** 잔고 조회는
 * 주문이 아니라서 틀린 형태를 보내도 거절만 돌아온다.
 *
 * **계좌번호 값은 화면에 찍지 않는다.** 어느 형태가 통했는지만 적는다.
 *
 *   APP_ENV=vts npx tsx src/scripts/probeAccountNumberForm.ts VTS
 */

import { config, type KisAccountConfig } from '../config.js';
import { getKisDomesticAccountSnapshot } from '../kis/rest.js';

/**
 * 계좌번호를 넣을 후보 형태. **이름만 화면에 나가고 값은 안 나간다.**
 *
 * 짧은 계좌번호는 어디를 채워야 하는지 알 수 없어 셋을 다 본다. 7자리에서
 * 왼쪽·오른쪽 0 채움과 그대로가 전부 거부된 적이 있어(2026-08-01), 이제
 * 상품코드도 함께 훑는다 — `INVALID_CHECK_ACNO`는 계좌번호와 상품코드를 **함께**
 * 보고 내는 오류라 어느 쪽이 틀렸는지 메시지만으로는 못 가른다.
 */
function canoForms(digits: string): Array<{ label: string; cano: string }> {
  const forms = [{ label: `그대로 ${digits.length}자리`, cano: digits }];
  if (digits.length < 8) {
    forms.push({ label: '왼쪽 0 채움 → 8자리', cano: digits.padStart(8, '0') });
    forms.push({ label: '오른쪽 0 채움 → 8자리', cano: digits.padEnd(8, '0') });
  }
  return forms;
}

/**
 * 훑을 상품코드.
 *
 * 01 종합위탁 · 02 수익증권 · 03 국내선물옵션 · 22 연금저축 · 29 해외선물옵션이
 * 흔하다. 모의투자가 어느 것으로 열리는지 확인된 바가 없어 앞쪽을 훑는다.
 */
const PRODUCT_CODES = ['01', '02', '03', '04', '05', '22', '29'];

function candidates(digits: string): Array<{ label: string; cano: string; productCode: string }> {
  const out: Array<{ label: string; cano: string; productCode: string }> = [];
  for (const form of canoForms(digits)) {
    for (const productCode of PRODUCT_CODES) {
      out.push({ label: `${form.label} + 상품코드 ${productCode}`, cano: form.cano, productCode });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const targetId = process.argv[2] ?? 'VTS';

  /*
   * 설정에 잡힌 계좌면 그것을 쓰고, 아니면 `.env`를 직접 읽는다.
   *
   * 후자가 필요한 이유는 이 스크립트가 시험하려는 대상이 바로 **형태를 정할 수
   * 없어 설정에서 빠진 계좌**이기 때문이다. 빠진 계좌는 `config.kisAccounts`에
   * 없다.
   */
  const known = config.kisAccounts.find((item) => item.id === targetId);
  const rawAccount = known
    ? known.cano
    : (process.env[`KIS_${targetId}_ACCOUNT_NO`] ?? '').replace(/[^0-9]/g, '');
  const credentialId = targetId.split('-')[0];
  const appKey = known?.appKey ?? process.env[`KIS_APP_KEY_${credentialId}`] ?? '';
  const appSecret = known?.appSecret ?? process.env[`KIS_APP_SECRET_${credentialId}`] ?? '';
  if (!rawAccount || !appKey || !appSecret) {
    console.log(`계좌 ${targetId}의 계좌번호나 앱키를 찾지 못했습니다.`);
    console.log(`설정된 계좌: ${config.kisAccounts.map((a) => a.id).join(', ') || '없음'}`);
    for (const skipped of config.skippedKisAccounts) {
      console.log(`  빠진 계좌 ${skipped.id} — ${skipped.reason}`);
    }
    return;
  }

  const account: KisAccountConfig = {
    id: targetId,
    label: `KIS ${targetId}`,
    appKey,
    appSecret,
    cano: rawAccount,
    productCode: known?.productCode ?? '01',
  };

  const envLabel = config.env === 'prod' ? '실전 서버' : '모의 서버';
  console.log(`${envLabel} · 계좌 ${targetId}`);
  console.log(`.env에 적힌 숫자 ${rawAccount.length}자리 — 값은 찍지 않는다\n`);

  const digits = rawAccount;

  for (const form of candidates(digits)) {
    /*
     * 후보 사이를 띄운다. 한도(EGW00201)에 걸린 시도는 **판정이 아니라 못 잰
     * 것**인데, 붙여 돌리면 그게 `✗`로 보여 맞는 형태를 지나칠 수 있다.
     * 실제로 한 번 그랬다.
     */
    await new Promise((resolve) => setTimeout(resolve, 700));
    const trial: KisAccountConfig = { ...account, cano: form.cano, productCode: form.productCode };
    try {
      const snapshot = await getKisDomesticAccountSnapshot(trial);
      console.log(
        `  ✅ ${form.label.padEnd(26)} 통과`
        + ` · 예수금 ${snapshot.cashBalance === undefined ? '—' : `${Math.round(snapshot.cashBalance).toLocaleString('ko-KR')}원`}`
        + ` · 보유 ${snapshot.positions.length}종목`,
      );
      console.log(`\n이 형태를 쓰면 됩니다 — CANO ${form.cano.length}자리 · 상품코드 ${form.productCode}`);
      return;
    } catch (err) {
      const message = (err as Error).message;
      // 한도 초과는 판정이 아니다 — 못 잰 것과 틀린 것을 같은 기호로 적지 않는다.
      const rateLimited = /EGW00201|초당 호출 한도/.test(message);
      const code = rateLimited
        ? '한도 초과로 못 쟀다 (다시 시도 필요)'
        : /INVALID_CHECK_ACNO/.test(message)
          ? '계좌번호 불일치'
          : /EGW02007/.test(message)
            ? '앱키가 이 서버용이 아님'
            : message.slice(0, 80);
      console.log(`  ${rateLimited ? '?' : '✗'} ${form.label.padEnd(26)} ${code}`);
    }
  }

  console.log('\n어느 형태도 통과하지 못했습니다. 계좌번호 자체를 다시 확인해야 합니다.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
