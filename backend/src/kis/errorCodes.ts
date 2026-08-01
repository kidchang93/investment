/**
 * KIS 오류 코드에 **이름을 붙인다.**
 *
 * 예전에는 전부 그냥 오류 문자열로 흘렀다. 그래서 `앱키와 서버의 짝이 어긋난 것`과
 * `모의 서버에 그 기능이 없는 것`이 같은 모양으로 보였고, 사람이 원인을 가를 수 없었다.
 * 둘은 고치는 방법이 전혀 다르다 — 앞은 `APP_ENV`/`KIS_<id>_SERVER`를 맞추는 일이고,
 * 뒤는 그 서버에 애초에 없는 기능이라 설정으로 못 고친다.
 *
 * **실측한 것만 적는다** (2026-08-01).
 *
 * | 코드 | 무엇 | 어떻게 봤나 |
 * |------|------|------|
 * | `EGW02007` | 실전 앱키를 모의 서버에 | *"해당 앱키는 모의투자용 앱키가 아닙니다"* |
 * | `EGW02004` | 모의 앱키를 실전 서버에 | 분봉 조회에서 관측 |
 * | `EGW02006` | 그 TR이 모의 서버에 없다 | `chk-holiday`가 HTTP 500 + *"모의투자 TR 이 아닙니다"* |
 *
 * `EGW02006`을 앞의 둘과 섞지 않는다. **기능이 없는 것이지 앱키가 틀린 게 아니다.**
 * 섞으면 개장일 우회(`KIS_OPEN_DAY_CREDENTIAL_ID`)를 켜 둔 사람에게 "앱키가 틀렸다"고
 * 말하게 된다 — 앱키는 멀쩡하다.
 *
 * 한도 코드(`EGW00201`·`EGW00215`)는 여기서 다루지 않는다. 그건 재시도로 풀리는
 * 것이라 판정이 따로 있다(`rest.ts`의 `isRateLimited`).
 */

/** 오류의 성질. 삼항 사슬 대신 표로 가른다(`docs/CODE_STYLE.md`). */
export type KisErrorKind = 'serverMismatch' | 'trNotOnVts';

const KIS_ERROR_KINDS: Record<string, KisErrorKind> = {
  EGW02007: 'serverMismatch',
  EGW02004: 'serverMismatch',
  EGW02006: 'trNotOnVts',
};

/**
 * 사람에게 할 말. **어느 쪽 앱키가 어느 서버에 갔는지**까지 적는다 —
 * "짝이 어긋났다"만으로는 어느 값을 고쳐야 하는지 알 수 없다.
 */
const KIS_ERROR_HINTS: Record<string, string> = {
  EGW02007:
    '실전 서버용 앱키를 모의 서버에 보냈습니다 — 앱키와 서버의 짝이 어긋났습니다.'
    + ' APP_ENV와 KIS_<id>_SERVER를 맞추세요.',
  EGW02004:
    '모의 서버용 앱키를 실전 서버에 보냈습니다 — 앱키와 서버의 짝이 어긋났습니다.'
    + ' APP_ENV와 KIS_<id>_SERVER를 맞추세요.',
  EGW02006:
    '이 기능은 모의 서버에 없습니다 — 앱키가 틀린 것이 아닙니다.'
    + ' 실전 서버(APP_ENV=prod)에서만 쓸 수 있습니다.',
};

export function kisErrorKind(msgCode: string): KisErrorKind | null {
  return KIS_ERROR_KINDS[msgCode] ?? null;
}

export function kisErrorHint(msgCode: string): string | null {
  return KIS_ERROR_HINTS[msgCode] ?? null;
}

/**
 * 응답 본문에서 `msg_cd`를 꺼낸다. 없으면 빈 문자열.
 *
 * 본문이 **문자열로 남아 있는 자리**가 있다(POST 실패·토큰 발급 실패는 `res.text()`를
 * 그대로 들고 throw한다). 그래서 파싱된 객체와 원문 둘 다 받는다.
 */
export function kisErrorCodeOf(body: unknown): string {
  if (typeof body === 'string') {
    try {
      return kisErrorCodeOf(JSON.parse(body) as unknown);
    } catch {
      return '';
    }
  }
  if (!body || typeof body !== 'object') return '';
  const code = (body as Record<string, unknown>).msg_cd;
  return typeof code === 'string' ? code : '';
}

/** 오류 문구 뒤에 덧붙일 한 마디. 짚을 것이 없으면 빈 문자열이라 그대로 이어 붙여도 된다. */
export function kisErrorSuffix(body: unknown): string {
  const hint = kisErrorHint(kisErrorCodeOf(body));
  return hint ? ` — ${hint}` : '';
}
