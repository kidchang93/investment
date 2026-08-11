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
export type KisErrorKind = 'serverMismatch' | 'trNotOnVts' | 'orderTypeNotOnVts' | 'orderRefused';

const KIS_ERROR_KINDS: Record<string, KisErrorKind> = {
  EGW02007: 'serverMismatch',
  EGW02004: 'serverMismatch',
  EGW02006: 'trNotOnVts',
  /*
   * 2026-08-03 실측. 장후 시간외 주문구분(`06`)으로 모의계좌에 매도를 냈더니
   * 8종목 전부 이 코드로 거절됐다 — *"모의투자에서 제공하지 않는 주문유형입니다."*
   *
   * **`EGW02006`과 가른다.** 그건 TR 자체가 없는 것이고 이건 TR은 있는데 그
   * **주문유형**을 모의가 안 받는 것이다. 고치는 방법은 같다(실전 서버로 가야 한다)
   * 지만 사람에게 할 말이 다르다.
   */
  '40970000': 'orderTypeNotOnVts',
  /*
   * 2026-08-04 15:22~15:27 실측. 매도가 나간 직후 잔고가 아직 안 줄어서 다음
   * 회차가 같은 종목을 또 팔려 했고 이 코드로 거절됐다 — *"모의투자 잔고내역이
   * 없습니다."* 세 번 거절되자 **러너가 연속 실패로 스스로 멈췄다.**
   *
   * 이건 시스템 장애가 아니라 **낼 수 없는 주문**이다. 다시 시도해도 같은 답이고,
   * 그렇다고 서버가 아픈 것도 아니다. 그래서 회차 실패로 세면 안 된다 —
   * 잔고 지연 한 번에 그날 자동매매가 통째로 끝난다.
   */
  '40240000': 'orderRefused',
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
  '40970000':
    '이 주문유형은 모의 서버가 받지 않습니다 — 주문구분 값이 틀린 것이 아닐 수 있습니다.'
    + ' 실전 서버(APP_ENV=prod)에서만 확인할 수 있습니다.',
  '40240000':
    '팔 잔고가 없습니다 — 방금 낸 매도가 아직 잔고에 반영되지 않았을 수 있습니다.'
    + ' 서버 장애가 아니라 낼 수 없는 주문입니다.',
};

export function kisErrorKind(msgCode: string): KisErrorKind | null {
  return KIS_ERROR_KINDS[msgCode] ?? null;
}

/**
 * 토큰이 죽었다는 뜻인가.
 *
 * ★ **`KIS_ERROR_KINDS` 표에 넣지 않는다.** 저 표는 "사람이 설정을 고쳐야 하는 것"과
 * "그 서버에 없는 것"을 가르는 표이고, 이건 **다시 받으면 되는 것**이라 성질이 다르다.
 * 섞으면 호출부가 재발급으로 풀릴 오류에 "APP_ENV를 고치세요"라고 말하게 된다.
 *
 * 만료 시각이 남았는데도 온다 — 같은 앱키로 다른 곳에서 토큰을 새로 받으면
 * 앞의 토큰이 죽는다(2026-08-05 실측). `reissueAccessToken`이 짝이다.
 */
export function isExpiredToken(body: unknown): boolean {
  return kisErrorCodeOf(body) === 'EGW00123';
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

/**
 * KIS가 거절한 요청. **코드를 들고 다닌다.**
 *
 * 예전에는 평범한 `Error`에 본문을 문자열로 이어 붙여 던졌다. 그래서 호출부가
 * 원인을 가르려면 메시지를 정규식으로 뒤져야 했고, 실제로는 아무도 안 갈랐다 —
 * 라우트가 전부 502로 뭉갰다.
 *
 * 화면에 `KIS 예약주문 조회 실패: 502`가 계속 떴는데 실제 원인은 `EGW02006`,
 * **모의 서버에 그 TR이 없는 것**이었다. 장애가 아니라 이 환경에 없는 기능이고,
 * 502는 "게이트웨이가 맛이 갔다"는 뜻이라 사람을 엉뚱한 곳으로 보낸다.
 */
export class KisRequestError extends Error {
  constructor(
    message: string,
    /** KIS `msg_cd`. 못 읽었으면 빈 문자열 */
    readonly msgCode: string,
    /**
     * HTTP 상태. 모르면 `undefined`다.
     *
     * **0으로 채우지 않는다** — 상태를 못 본 것과 0인 것은 다른 사실이고,
     * 재시도 판정(`isRetriableTransportError`)이 5xx만 다시 시도하기 때문에
     * 모르는 것이 0이 되면 "서버 잘못이 아니다"로 읽힌다.
     */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'KisRequestError';
  }
}

/**
 * 잠깐 아픈 것인가 — **다시 보내면 될 오류인가.**
 *
 * ── 왜 필요한가 (2026-08-11 실측) ────────────────────────────────────────
 *
 * 일봉을 종목당 4페이지씩 연달아 받다가 세 번째 종목에서 KIS가 소켓을 끊었다.
 *
 *     TypeError: fetch failed
 *       cause: SocketError: other side closed (UND_ERR_SOCKET)
 *
 * 이건 **그 종목에 문제가 있는 것이 아니다.** 그런데 오류 하나로 종목을 건너뛰면
 * 전 종목 21년치를 받는 밤샘 작업이 구멍 뚫린 채 끝나고, 구멍이 어디인지는
 * 나중에 알 수 없다. 잠깐 아픈 것과 애초에 안 되는 것을 갈라야 한다.
 *
 * **가르는 기준은 "다시 보내면 답이 달라질 수 있는가" 하나다.**
 * `EGW02006`(그 서버에 없는 기능)·`EGW02004`(짝 불일치)는 백 번 보내도 같은
 * 답이라 여기서 거짓이다. 한도(`EGW00201`)는 성질이 달라 `rest.ts`가 가른다.
 */
const RETRIABLE_TRANSPORT_CODES = new Set([
  'UND_ERR_SOCKET', // 상대가 소켓을 닫았다 (실측)
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN', // DNS가 잠깐 안 되는 것
]);

export function isRetriableTransportError(error: unknown): boolean {
  /*
   * KIS가 5xx로 답한 것은 서버 쪽 사정이라 다시 보내 볼 값이 있다. 단, 코드에
   * 이름이 붙은 것(짝 불일치·기능 없음)은 500으로 와도 다시 보내지 않는다 —
   * `chk-holiday`가 실제로 HTTP 500 + `EGW02006`으로 온다.
   */
  if (error instanceof KisRequestError) {
    if (kisErrorKind(error.msgCode)) return false;
    return typeof error.status === 'number' && error.status >= 500;
  }
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;

  /*
   * undici는 원인을 `cause`에 감싼다. 몇 겹까지 감싸는지는 판마다 다르므로
   * 사슬을 따라 내려가며 본다 — 겉면은 늘 `TypeError: fetch failed`다.
   */
  let cause: unknown = error;
  for (let depth = 0; cause instanceof Error && depth < 5; depth += 1) {
    const code = (cause as Error & { code?: unknown }).code;
    if (typeof code === 'string' && RETRIABLE_TRANSPORT_CODES.has(code)) return true;
    cause = (cause as Error & { cause?: unknown }).cause;
  }
  // 원인을 못 읽어도 `fetch failed`는 네트워크가 끊긴 것이다. 지어내지 않는 선에서 여기까지.
  return error.message.includes('fetch failed');
}

/**
 * 이 서버에 **애초에 없는 기능**이라 실패한 것인가.
 *
 * 설정으로 못 고친다 — `APP_ENV=prod`로 가야만 쓸 수 있다. 그래서 재시도할 것도,
 * 장애로 알릴 것도 아니다. 화면은 "이 환경에 없다"고만 말하면 된다.
 */
export function isTrUnavailableOnServer(error: unknown): boolean {
  if (!(error instanceof KisRequestError)) return false;
  return kisErrorKind(error.msgCode) === 'trNotOnVts';
}

/**
 * 이 **주문유형**을 이 서버가 안 받는가.
 *
 * 재시도해도 같은 답이다. 보유 8종목에 같은 주문을 8번 내 볼 이유가 없다 —
 * 2026-08-03에 실제로 8번 냈고 8번 다 같은 말을 들었다.
 */
export function isOrderTypeUnavailableOnServer(error: unknown): boolean {
  if (!(error instanceof KisRequestError)) return false;
  return kisErrorKind(error.msgCode) === 'orderTypeNotOnVts';
}


/**
 * KIS가 **주문 자체를 거절**한 것인가. 서버가 아픈 것과 가른다.
 *
 * ── 왜 갈라야 하나 (2026-08-04 실측) ─────────────────────────────────────
 *
 * 15:21:41에 매도가 나갔고, 잔고가 아직 안 줄어 다음 세 회차가 같은 종목을 또
 * 팔려 했다. KIS는 `40240000`(잔고 없음)으로 거절했고 **세 번 만에 러너가
 * 연속 실패로 멈췄다** — 마감 3분 전이었다.
 *
 * 연속 실패 정지는 *"같은 오류로 무한히 주문을 시도하지 않게"* 만든 장치다.
 * 그런데 거절은 그 대상이 아니다 — 주문 하나가 안 나간 것이지 러너가 계속
 * 돌면 안 되는 상태가 아니다. 다음 회차에는 잔고가 맞춰져 정상으로 돌아간다.
 *
 * **네트워크·인증 실패는 여전히 세야 한다.** 그건 진짜로 시스템이 아픈 것이고,
 * 그때는 멈추는 쪽이 안전하다.
 */
export function isOrderRefused(error: unknown): boolean {
  if (!(error instanceof KisRequestError)) return false;
  const kind = kisErrorKind(error.msgCode);
  return kind === 'orderRefused' || kind === 'orderTypeNotOnVts';
}