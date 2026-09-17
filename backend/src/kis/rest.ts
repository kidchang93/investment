import { setTimeout as delay } from 'node:timers/promises';
import {
  config,
  orderServerMismatch,
  readServerMismatch,
  restBaseFor,
  type KisAccountConfig,
  type KisServer,
} from '../config.js';
import { getDomesticInstrumentsBySymbols } from '../db/instruments.js';
import {
  credentialServer,
  getAccessToken,
  primaryCredentials,
  reissueAccessToken,
  type KisCredentials,
} from './auth.js';
import { DEFAULT_EXCHANGE, marketDivCode, type KisExchange } from './exchanges.js';
import { assertVenueUsable, DEFAULT_ORDER_VENUE, type OrderVenue } from './orderVenues.js';
import {
  overseasOrderPayload, overseasOrderTr, type OverseasExchange,
} from './orderOverseas.js';
import {
  isExpiredToken, kisErrorCodeOf, kisErrorKind, kisErrorSuffix,
  KisRequestError, type KisErrorKind,
} from './errorCodes.js';
import { orderCashPayload } from './orderCash.js';
import { CONFIRMED_ORDER_DIVISIONS } from './orderDivisions.js';
import {
  chunkQuoteCodes,
  MULTI_QUOTE_PATH,
  MULTI_QUOTE_TR_ID,
  multiQuoteParams,
  parseMultiQuoteChunk,
} from './multiQuote.js';
import {
  isFutureAssetType,
  isNonNegativeFinite,
  isPositiveFinite,
  kstDaysAgo,
  kstToday,
  optionalNumber,
  parseSign,
  requireNumber,
  toNumber,
  toNumberOrNaN,
} from './normalize.js';
import { unrealizedPnlRateOf } from '@invest/shared';
import type {
  BrokerAccountSnapshot,
  BrokerExecution,
  DomesticIndexQuote,
  BrokerExecutionSnapshot,
  BrokerExecutionStatus,
  BrokerAmendableOrder,
  BrokerOrderability,
  BrokerPosition,
  BrokerReservedOrder,
  BrokerTradeProfitRow,
  BrokerTradeProfitSnapshot,
  OrderSide,
  Candle,
  CandlesResponse,
  ExchangeRate,
  FinancialSnapshot,
  Instrument,
  NewsItem,
  MarketMover,
  MarketMoversSnapshot,
  OrderType,
  PriceSign,
  Quote,
} from '@invest/shared';

/**
 * 한 번의 멀티시세 호출에 들어가는 종목 수(30). 조회 상한을 정하는 쪽이
 * "몇 회가 나가는가"를 계산하려면 이 수를 알아야 한다.
 */
export { MULTI_QUOTE_MAX_CODES } from './multiQuote.js';

/**
 * KIS REST POST 공통 헬퍼. 주문 계열은 전부 POST이고 파라미터를 body로 보낸다.
 * GET과 달리 `hashkey` 헤더는 필수가 아니며, 생략해도 정상 접수된다.
 *
 * ⚠ **주문은 이 실행의 기본 서버(`config.env`)로만 나간다.** 개장일 조회는 모의
 * 환경에서도 실전 서버에 붙는데(`KIS_OPEN_DAY_CREDENTIAL_ID`), 그 자격증명은
 * **조회 전용**이다. 여기로 새면 모의 환경인 줄 알고 실계좌에 주문이 나간다 —
 * 이 레포에서 가장 위험한 실수라 도메인은 `config.restBase`로 고정하고, 서버가
 * 다른 자격증명이 들어오면 **보내기 전에** 던진다.
 */
async function kisPost(
  path: string,
  trId: string,
  body: Record<string, string>,
  credentials: KisCredentials,
): Promise<Record<string, unknown>> {
  const mismatch = orderServerMismatch(credentialServer(credentials), config.env);
  if (mismatch) throw new Error(mismatch);

  const token = await getAccessToken(credentials);
  /*
   * 주문은 재시도하지 않는다. 중복 접수 위험이 조회 실패보다 훨씬 크다.
   *
   * ── ★★ 예외 하나: 초당 한도(2026-09-04) ────────────────────────────────
   *
   * 그날 미체결 정정을 시험하다 이것으로 실패했다:
   *
   *   → 정정: 적정가 10,756원 안이다 — 현재가 9,180원로 붙인다
   *     ✗ 실패 (500): "초당 거래건수를 초과하였습니다." EGW00201
   *
   * ★ **한도 거부는 "답을 못 받은 것"이 아니라 "안 받았다"**이다. 서버가
   *   `rt_cd=1`로 명시적으로 거절했으므로 **접수되지 않은 것이 확실**하다.
   *   재시도해도 중복이 되지 않는다 — 2026-08-14 사고(타임아웃 뒤 재전송으로
   *   같은 주문이 두 번 체결)와는 성격이 다르다. 그때는 서버가 큐에 두고 계속
   *   처리하고 있었고, 보내는 쪽이 그것을 알 방법이 없었다.
   *
   * ★ **모의는 초당 1건**이다(실전 18건, 아래 표 참고). 여기에 여러 프로세스가
   *   각자 큐를 갖고 동시에 두들긴다 — `scheduleKisCall`은 **한 프로세스 안에서만**
   *   줄을 세우므로 손절 감시·적정가 분석·미체결 정리가 서로를 모른다. 그래서
   *   모의 환경에서는 이 충돌이 드물지 않다.
   *
   * ★ 그래도 **한 번만** 다시 보낸다. 계속 두드리면 더 오래 막힌다.
   *
   * 줄은 `config.env` 것에 선다 — 주문은 `config.restBase`에 고정이고
   * (CLAUDE.md 7번) 위에서 `orderServerMismatch`가 이미 짝을 확인했다.
   */
  const send = (): Promise<Record<string, unknown>> => scheduleKisCall(config.env, async () => {
    const res = await fetch(config.restBase + path, {
      method: 'POST',
      // ★ 무한 대기는 큐 전체를 막는다. 중복 접수는 `clientOrderId`가 막는다.
      signal: AbortSignal.timeout(KIS_ORDER_TIMEOUT_MS),
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: credentials.appKey,
        appsecret: credentials.appSecret,
        tr_id: trId,
        custtype: config.custType,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new KisRequestError(
        `KIS POST ${path} 실패 (${res.status}): ${text}${kisErrorSuffix(text)}`,
        kisErrorCodeOf(text),
      );
    }
    return (await res.json()) as Record<string, unknown>;
  });

  try {
    return await send();
  } catch (error) {
    if (!isRateLimitedError(error)) throw error;
    await delay(KIS_RATE_LIMIT_BACKOFF_MS);
    return send();
  }
}

/**
 * 초당 한도를 넘겼을 때 오는 코드. **두 가지다.**
 *
 * | 코드 | 무엇의 한도 | 어디서 |
 * |------|------|------|
 * | `EGW00201` | **개인(앱키) 유량** — 실전 18건/초 · 모의 1건/초 | 모든 TR |
 * | `EGW00215` | **원장 유량 120 TPS** — 개인 유량과 무관하게 걸린다 | 잔고조회·ETF호가 |
 *
 * 예전에는 앞엣것만 봐서, `EGW00215`가 오면 한도로 인식되지 않아 **백오프·재시도를
 * 타지 못하고** 오류가 그대로 위로 흘렀다. 잔고조회는 러너가 매 회차 부르는 경로다.
 * 출처는 KIS 주식잔고조회 API 문서 원문 — *"원장 유량정책에 의거, 개인 고객 유량
 * 무관하게 초당 120 TPS로 제한 … 재시도 처리 부탁드리겠습니다"*.
 */
const KIS_RATE_LIMIT_CODES = new Set(['EGW00201', 'EGW00215']);

/**
 * 호출 사이 최소 간격. **서버마다 다르다.**
 *
 * KIS 공식 유량 안내(2026-04-20 기준)가 명시한다 — REST 실전 **18건/초**, 모의
 * **1건/초**. 18배 차이다. 예전에는 70ms 하나였는데, 그건 실전 기준으로는 맞지만
 * (≒14.3건/초) **모의에서는 14배 초과**라 매 회차 후보의 12.5~37.5%를 조용히
 * 잃고 있었다(2026-08-01 실측: 멀티시세 8묶음 중 1~3묶음이 `EGW00201`).
 *
 * 실전 값은 KIS 권장(*"동시 호출의 경우 100~150ms 텀"*)보다 짧지만 하드 한도
 * 안이고, 기존 실측(10묶음 300종목 1.08초에 `EGW00201` 0건)이 이 값으로 낸 것이라
 * 바꾸지 않는다. 모의는 1건/초라 여유를 두고 **1,100ms**로 잡는다.
 *
 * ⚠ **신규 앱키는 3일간 초당 3건**이다(KIS 공지 2026-03-20, 모의계좌는 해당 없음).
 * 그 기간에는 실전 값도 부족하다 — 걸리면 `EGW00201`이 잦아지는 것으로 드러난다.
 */
const KIS_MIN_CALL_GAP_BY_SERVER: Record<KisServer, number> = {
  prod: 70,
  vts: 1_100,
};

const KIS_RATE_LIMIT_BACKOFF_MS = 400;

/**
 * **서버마다 따로 줄을 선다.**
 *
 * 초당 한도는 서버(와 그 서버에 등록된 앱키)의 것이지 이 프로세스의 것이 아니다.
 * 실전으로 나가는 조회와 모의로 나가는 조회는 서로의 한도를 먹지 않는다.
 */
const kisCallChains: Record<KisServer, Promise<unknown>> = {
  prod: Promise.resolve(),
  vts: Promise.resolve(),
};

/**
 * KIS REST 호출을 줄 세워 최소 간격을 둔다.
 *
 * 포트폴리오 화면이 계좌·체결·예약주문·매매손익을 동시에 띄우면 초당 한도에 걸려
 * 일부 카드만 502로 비는 일이 생긴다. 순서를 지키는 대신 조금 느리게 간다.
 *
 * ── 서버마다 줄을 가른다 (2026-08-05) ────────────────────────────────────
 *
 * 예전에는 줄이 하나였고 간격을 `config.env`로 정했다. 그 주석의 근거는
 * *"개장일 조회 **하나**가 다른 서버로 나가지만 줄은 하나라 느린 쪽에 맞춘다"*
 * 였는데, **그 전제가 깨졌다.** 측정 스크립트가 실전 자격증명으로 조회를 수백 번
 * 낸다(수급 150종목 × 4회 = 600회).
 *
 * `APP_ENV=vts`인 채로 실전 조회를 내면 간격이 1,100ms로 잡혀 **실전 한도(70ms)의
 * 16배**로 기어간다. 2026-08-05 실측: 600회에 **14분**이 걸렸고 그중 11분이 순수
 * 대기였다(CPU는 10분 30초 동안 0.3초만 썼다). 70ms면 같은 일이 3분이다.
 *
 * 한도는 **서버와 그 앱키의 것**이지 이 프로세스의 것이 아니다. 실전으로 나가는
 * 조회와 모의로 나가는 조회는 서로의 한도를 먹지 않으므로 줄을 갈라도 안전하다.
 *
 * ★ 간격은 **그 호출이 실제로 가는 서버**로 정한다(`credentialServer`). 목적지
 * (`restBaseFor`)를 정하는 것과 같은 값이어야 한다 — 어긋나면 빠른 간격으로
 * 느린 서버를 두드려 `EGW00201`을 부른다.
 */
/**
 * ★★ **응답을 이만큼 안 주면 끊는다.**
 *
 * ── 왜 (2026-09-03) ──────────────────────────────────────────────────────
 *
 * `fetch`에 타임아웃이 없었다. KIS가 연결을 받아 두고 응답을 안 주면 **영원히
 * 기다린다.** 그리고 `scheduleKisCall`은 **체인**이라(`chain.then(run, run)`)
 * 하나가 매달리면 **그 서버로 가는 모든 호출이 뒤에서 영구히 막힌다.**
 *
 * 그날 실제로 그랬다: 주문 POST 세 건이 연달아 `incoming request`만 남기고
 * 완료되지 않았다. 백엔드는 살아 있었고(상태 API는 200) KIS 큐만 막혀 있었다.
 * 재시작 말고는 푸는 길이 없었다.
 *
 * ★ 주문에 더 넉넉히 준다. 끊긴다고 안 나간 것이 아니므로(서버는 큐에 두고
 *   계속 처리한다) **끊는 것 자체가 위험**하다 — 다만 무한 대기는 더 위험하다.
 *   끊긴 주문은 `clientOrderId` 멱등 키가 중복 접수를 막는다.
 */
const KIS_READ_TIMEOUT_MS = 15_000;
const KIS_ORDER_TIMEOUT_MS = 30_000;

function scheduleKisCall<T>(server: KisServer, run: () => Promise<T>): Promise<T> {
  const gap = KIS_MIN_CALL_GAP_BY_SERVER[server];
  const result = kisCallChains[server].then(run, run);
  kisCallChains[server] = result.then(
    () => delay(gap),
    () => delay(gap),
  );
  return result;
}

export function isRateLimited(body: Record<string, unknown>): boolean {
  return KIS_RATE_LIMIT_CODES.has(String(body.msg_cd ?? ''));
}

/**
 * 던져진 오류가 **한도 때문**인가.
 *
 * 코드 표가 여기 있으므로 판정도 여기 둔다(`errorCodes.ts`는 "설정을 고쳐야 하는
 * 것"과 "그 서버에 없는 것"을 가르는 표라 성질이 다르다). 오래 도는 수집기가
 * 이것을 일시적 실패로 세려면 필요하다 — 더 기다리면 풀린다.
 */
export function isRateLimitedError(error: unknown): boolean {
  return error instanceof KisRequestError && KIS_RATE_LIMIT_CODES.has(error.msgCode);
}

/** KIS REST GET 공통 헬퍼. tr_id별로 헤더/인증을 채워 호출한다. */
async function kisGet(
  path: string,
  trId: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  return (await kisGetWithHeaders(path, trId, params)).body;
}

/**
 * 조회(GET) 공통 헬퍼.
 *
 * **도메인은 자격증명이 정한다.** 토큰은 발급받은 서버에서만 통하므로 둘이 함께
 * 다녀야 어긋나지 않는다. 지금 기본 서버가 아닌 곳으로 가는 조회는 개장일
 * (`chk-holiday`) 하나뿐이다 — 모의 서버에 그 TR이 없어서다.
 *
 * ⚠ **짝이 어긋난 자격증명은 조회도 보내지 않는다.** 계좌 TR은 이름이 `config.env`로
 * 갈려(`TTTC8434R`/`VTTC8434R`) 어느 도메인으로 보내도 맞지 않고, 보내는 순간 그
 * 서버의 토큰이 발급돼 캐시된다(2026-08-01 실측: `token-prod-VTS-EXTRAORDINARY.json`이
 * 실제로 생겼다). 사유는 `readServerMismatch`에 적어 뒀다. 예외는 개장일 하나이며
 * 호출부가 `crossServerRead`로 밝힌다.
 */
/**
 * **연결 자체가 끊긴 것인가.** 응답이 온 실패(4xx·5xx)와 다르다.
 *
 * ── 왜 (2026-09-03) ──────────────────────────────────────────────────────
 *
 * 미체결 정리가 두 회차 연달아 이것으로 죽었다:
 *
 *   TypeError: fetch failed
 *     [cause] SocketError: other side closed  (UND_ERR_SOCKET)
 *
 * KIS가 keep-alive 연결을 끊은 것이고 **다시 물으면 대개 된다.** 그런데 재시도가
 * 토큰 만료와 한도 초과에만 있어서, 5분마다 도는 작업이 그 회차를 통째로 놓쳤다.
 *
 * ★ 여기서 잡는 것은 **응답을 못 받은 경우**뿐이다. 서버가 답을 준 실패는
 *   아래 기존 경로가 코드별로 처리한다 — 섞으면 "없는 서비스 코드"를
 *   네트워크 탓으로 알고 계속 두드린다.
 */
function isTransientNetworkError(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } })?.cause;
  const code = cause?.code;
  // AbortSignal.timeout은 cause 없이 TimeoutError를 던진다
  if ((error as { name?: string })?.name === 'TimeoutError') return true;
  return code === 'UND_ERR_SOCKET'      // 상대가 연결을 끊었다
    || code === 'UND_ERR_CONNECT_TIMEOUT'
    || code === 'ECONNRESET'
    || code === 'ECONNREFUSED'
    || code === 'EPIPE'
    || code === 'ETIMEDOUT';
}

/** 끊긴 연결이면 한 번만 다시. 그래도 안 되면 그대로 던진다 */
const TRANSIENT_RETRY_DELAY_MS = 400;

async function kisGetWithHeaders(
  path: string,
  trId: string,
  params: Record<string, string>,
  trCont = '',
  credentials: KisCredentials = primaryCredentials,
): Promise<{ body: Record<string, unknown>; headers: Headers }> {
  if (!credentials.crossServerRead) {
    const mismatch = readServerMismatch(credentialServer(credentials), config.env);
    /*
     * 토큰을 받기 **전에** 세운다. 발급 자체가 다른 서버에 값을 남기는 일이라서다.
     * 보간한 값 뒤에 조사를 붙이지 않는다 — 경로도 id도 끝 글자가 매번 다르다.
     */
    if (mismatch) throw new Error(`KIS 조회를 보내지 않았습니다 (${path}, 자격증명 ${credentials.id}). ${mismatch}`);
  }

  const url = new URL(restBaseFor(credentialServer(credentials)) + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const headers: Record<string, string> = {
    authorization: `Bearer ${await getAccessToken(credentials)}`,
    appkey: credentials.appKey,
    appsecret: credentials.appSecret,
    tr_id: trId,
    custtype: config.custType,
  };
  if (trCont) headers.tr_cont = trCont;

  /*
   * 한도 초과가 두 가지 모양으로 온다.
   *
   * 보통은 200 + `rt_cd: 1` + `msg_cd: EGW00201`인데, 부하가 몰리면 같은 내용이
   * **500**으로 온다. 예전에는 non-OK면 바로 throw해서 500으로 온 한도 초과가
   * 백오프를 타지 못했다. 백테스트에서 종목 8개를 페이징으로 받다가 실제로
   * 여기서 끊겼다. 상태 코드가 아니라 본문의 msg_cd로 판단한다.
   */
  async function callOnce(): Promise<{ body: Record<string, unknown>; headers: Headers }> {
    const res = await fetch(url, { headers: { ...headers }, signal: AbortSignal.timeout(KIS_READ_TIMEOUT_MS) });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = {};
    }
    if (!res.ok && !isRateLimited(body) && !isExpiredToken(body)) {
      // 짝이 어긋났다는 뜻의 코드면 그렇게 말해 준다. 아니면 덧말이 빈 문자열이다.
      throw new KisRequestError(
        `KIS GET ${path} 실패 (${res.status}): ${text}${kisErrorSuffix(body)}`,
        kisErrorCodeOf(body),
        res.status,
      );
    }
    return { body, headers: res.headers };
  }

  // 목적지를 정하는 값과 같은 것으로 줄을 고른다. 어긋나면 한도를 잘못 먹는다.
  const server = credentialServer(credentials);

  /*
   * ★★ **연결이 끊긴 경우만 한 번 다시 부른다.**
   *
   * ★ 이 함수는 **GET 전용**이라 안전하다. 같은 조회를 두 번 해도 값이 같다.
   *   **주문(POST)에는 절대 이것을 붙이지 않는다** — 2026-08-14에 타임아웃 뒤
   *   손으로 재전송했다가 **같은 주문이 두 번 체결됐다.** 서버는 큐에 두고
   *   계속 처리하고 있었다. 보내는 쪽은 "안 갔다"와 "답을 못 받았다"를 구별할
   *   수 없으므로, 부작용이 있는 요청은 멱등 키로 막지 재시도로 풀지 않는다.
   */
  async function callWithReconnect(): Promise<{ body: Record<string, unknown>; headers: Headers }> {
    try {
      return await scheduleKisCall(server, callOnce);
    } catch (error) {
      if (!isTransientNetworkError(error)) throw error;
      await delay(TRANSIENT_RETRY_DELAY_MS);
      return scheduleKisCall(server, callOnce);
    }
  }

  let first = await callWithReconnect();

  /*
   * 토큰이 죽었으면 **한 번만** 다시 받아 재시도한다. 캐시의 만료 시각이 남아 있어도
   * 온다 — 같은 앱키로 다른 곳에서 새 토큰을 받으면 앞의 토큰이 죽는다.
   *
   * 이걸 안 하면 무인 운용이 조용히 멈춘다: 모든 조회가 실패하고, 리스크 룰이
   * 개장일을 못 물어 매매가 통째로 보류된 채 사람이 붙을 때까지 그대로다.
   *
   * ★ 재시도는 한 번뿐이다. 발급에는 횟수 제한이 있어 실패마다 부르면 그게 더 큰 사고다.
   */
  if (isExpiredToken(first.body)) {
    headers.authorization = `Bearer ${await reissueAccessToken(credentials)}`;
    first = await callWithReconnect();
    if (isExpiredToken(first.body)) {
      throw new KisRequestError(
        `KIS GET ${path} 실패: 토큰을 다시 받았는데도 만료라고 합니다 (자격증명 ${credentials.id}).`,
        kisErrorCodeOf(first.body),
      );
    }
  }
  // 한도에 걸리면 잠시 쉬고 한 번만 더 시도한다. 계속 두드리면 더 오래 막힌다.
  if (!isRateLimited(first.body)) return first;
  await delay(KIS_RATE_LIMIT_BACKOFF_MS);
  const second = await callWithReconnect();
  /*
   * 두 번째도 한도면 그대로 넘기지 않는다. 빈 본문이 정상 응답처럼 흘러가면
   * 호출한 쪽은 `캔들 0건`을 사실로 받아들인다 — 이번 작업 내내 고쳐 온 그
   * 모양이다. 실패는 실패로 알린다.
   */
  if (isRateLimited(second.body)) {
    /*
     * 코드를 실어 던진다. 두 번 쉬고도 막혔다는 것은 **더 오래 기다리면 풀릴
     * 일**이라, 밤새 도는 수집기가 이것을 일시적 실패로 알아볼 수 있어야 한다
     * (`isRateLimitedError`). 평범한 `Error`면 메시지를 정규식으로 뒤져야 한다.
     */
    throw new KisRequestError(
      `KIS GET ${path} 실패: 초당 호출 한도를 넘었습니다 (${String(second.body.msg_cd ?? '')})`,
      kisErrorCodeOf(second.body),
    );
  }
  return second;
}

function yyyymmdd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** KIS 날짜 `YYYYMMDD` → 그날 00:00 UTC epoch 초 (`Candle.time`의 일봉 규약) */
function ymdToUtcSec(ymd: string): number {
  return Math.floor(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8))) / 1000);
}

/** 시각이 숫자이고 시고저종이 양수, 거래량이 음수가 아닌 봉만 남긴다 */
function isValidCandle(c: Candle): boolean {
  return (
    Number.isFinite(c.time) &&
    isPositiveFinite(c.open) &&
    isPositiveFinite(c.high) &&
    isPositiveFinite(c.low) &&
    isPositiveFinite(c.close) &&
    isNonNegativeFinite(c.volume ?? 0)
  );
}

/** 계좌 조회 응답이 실패(`rt_cd`가 있고 `0`이 아님)면 KIS가 한 말을 담아 던진다 */
function assertRtOk(body: Record<string, unknown>, label: string): void {
  if (body.rt_cd && body.rt_cd !== '0') {
    throw new Error(`KIS ${label} 실패: ${String(body.msg1 ?? body.msg_cd ?? '알 수 없는 오류')}`);
  }
}

/**
 * 계좌 조회의 페이지 넘김. `tr_cont`가 `M`/`F`인 동안 `CTX_AREA_FK100`·`NK100`을
 * 물려 이어 받는다(최대 10쪽). 쪽마다 `rt_cd`를 보고, 행은 쪽 순서대로 이어 붙인다.
 * 합계 줄(`output2`)은 배열·객체 어느 모양으로 와도 한 줄로 받고, 마지막으로 온 것을 쓴다.
 */
async function kisPages(
  account: KisAccountConfig,
  path: string,
  trId: string,
  params: Record<string, string>,
  label: string,
  rowsKey: 'output1' | 'output' = 'output1',
): Promise<{ rows: Array<Record<string, string>>; summary: Record<string, string> }> {
  const rows: Array<Record<string, string>> = [];
  let summary: Record<string, string> = {};
  let fk100 = '';
  let nk100 = '';
  let trCont = '';

  for (let depth = 0; depth < 10; depth += 1) {
    const { body, headers } = await kisGetWithHeaders(
      path,
      trId,
      { ...params, CTX_AREA_FK100: fk100, CTX_AREA_NK100: nk100 },
      trCont,
      toCredentials(account),
    );
    assertRtOk(body, label);

    const pageRows = body[rowsKey];
    if (Array.isArray(pageRows)) rows.push(...(pageRows as Array<Record<string, string>>));
    const output2 = Array.isArray(body.output2)
      ? (body.output2[0] as Record<string, string> | undefined)
      : body.output2 && typeof body.output2 === 'object'
        ? (body.output2 as Record<string, string>)
        : undefined;
    summary = output2 ?? summary;

    trCont = headers.get('tr_cont') ?? '';
    fk100 = String(body.ctx_area_fk100 ?? '');
    nk100 = String(body.ctx_area_nk100 ?? '');
    if (trCont !== 'M' && trCont !== 'F') break;
  }

  return { rows, summary };
}

function signFromChange(change: number): PriceSign {
  if (change > 0) return '2';
  if (change < 0) return '5';
  return '3';
}

function maskKisAccount(cano: string, productCode: string): string {
  return `****${cano.slice(-4)}-${productCode}`;
}

const MISSING_ACCOUNT_MESSAGE =
  'KIS 계좌 설정이 없습니다. KIS_<id>_ACCOUNT_NO / KIS_APP_KEY_<id> / KIS_APP_SECRET_<id>를 함께 채워주세요.';

/**
 * 계좌 조회는 그 계좌가 등록된 앱키로만 가능하다. 계좌 설정에서 자격증명만 뽑아 쓴다.
 *
 * **서버 표기(`server`)를 반드시 함께 싣는다.** 예전에는 `{id, appKey, appSecret}`만
 * 넘겨서 `credentialServer()`가 늘 `config.env`를 돌려줬고, 그 결과
 * `orderServerMismatch(config.env, config.env)`가 **언제나 null**이라 주문 가드가
 * 정상 경로에서 한 번도 걸리지 않았다. 도달 불가능한 방어선이었다.
 *
 * 시험에서 부르므로 내보낸다 — 짝을 싣는지가 이 함수의 계약이다.
 */
export function toCredentials(account: KisAccountConfig): KisCredentials {
  return { id: account.id, appKey: account.appKey, appSecret: account.appSecret, server: account.server };
}

/**
 * 일봉 한 페이지 (국내주식 기간별시세, tr_id: FHKST03010100).
 *
 * KIS는 요청한 날짜 범위와 무관하게 **한 번에 100건까지만** 준다. days를 100,
 * 250, 600으로 줘도 셋 다 100건이었다. 범위 안 거래일이 100일을 넘을 때 어느
 * 쪽을 버리는지는 스펙에 없으므로, 창은 100거래일 아래로 잡아 추측을 피한다.
 */
async function fetchDailyCandlePage(
  code: string,
  start: Date,
  end: Date,
): Promise<{ name: string; candles: Candle[] }> {
  const json = await kisGet(
    '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice',
    'FHKST03010100',
    {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: yyyymmdd(start),
      FID_INPUT_DATE_2: yyyymmdd(end),
      FID_PERIOD_DIV_CODE: 'D',
      FID_ORG_ADJ_PRC: '0', // 0: 수정주가
    },
  );

  const output1 = (json.output1 ?? {}) as Record<string, string>;
  const output2 = (json.output2 ?? []) as Array<Record<string, string>>;
  const name = output1.hts_kor_isnm ?? code;

  const candles: Candle[] = output2
    .filter((r) => r.stck_bsop_date)
    .map((r) => {
      /*
       * 거래대금(`acml_tr_pbmn`)은 **없으면 undefined로 둔다.** 0으로 채우면
       * "그날 한 주도 안 거래됐다"가 지어진다 — `toNumberOrNaN`이 있는 이유다.
       */
      const turnover = toNumberOrNaN(r.acml_tr_pbmn);
      return {
        time: ymdToUtcSec(r.stck_bsop_date),
        open: toNumber(r.stck_oprc),
        high: toNumber(r.stck_hgpr),
        low: toNumber(r.stck_lwpr),
        close: toNumber(r.stck_clpr),
        volume: toNumber(r.acml_vol),
        turnover: isNonNegativeFinite(turnover) ? turnover : undefined,
      };
    })
    .filter(isValidCandle)
    .sort((a, b) => a.time - b.time);

  return { name, candles };
}

/**
 * 일봉 시세. 화면에서 쓰는 기본 경로 — KIS 호출 1회다.
 */
export async function getDailyCandles(code: string, days = 120): Promise<CandlesResponse> {
  const end = new Date();
  const start = new Date();
  // 주말·공휴일을 감안해 여유 있게 과거로 잡는다.
  start.setDate(start.getDate() - Math.ceil(days * 1.7));
  const page = await fetchDailyCandlePage(code, start, end);
  return { code, name: page.name, candles: page.candles };
}

/** 한 페이지에 요청할 달력 일수. 약 90거래일이라 100건 상한에 걸리지 않는다. */
export const DAILY_PAGE_CALENDAR_DAYS = 130;

/**
 * 일봉 창 하나. **페이징을 부르는 쪽이 들고 있어야 할 때** 쓴다.
 *
 * `getDailyCandleHistory`는 페이지를 내부에서 다 돌기 때문에, 중간에 소켓이
 * 끊기면 그때까지 받은 페이지가 통째로 버려진다. 21년치(60페이지)를 받는
 * 수집기에서는 그게 치명적이다 — 2026-08-11에 KIS가 종목 세 개째에서
 * `UND_ERR_SOCKET`으로 끊었고, 60페이지 안에 한 번이라도 끊기면 그 종목은
 * 영영 끝나지 않는다. 그래서 수집기는 창 단위로 받아 **페이지마다** 재시도한다.
 *
 * 화면 경로는 그대로 `getDailyCandles`(1회)를 쓴다.
 */
export async function getDailyCandleWindow(
  code: string,
  start: Date,
  end: Date,
): Promise<CandlesResponse> {
  const page = await fetchDailyCandlePage(code, start, end);
  return { code, name: page.name, candles: page.candles };
}

/** 페이지 사이 간격. 백테스트는 느려도 되니 넉넉히 둔다. */
const KIS_PAGE_GAP_MS = 250;

/**
 * 일봉을 여러 번 나눠 받아 더 길게 만든다.
 *
 * 백테스트 전용이다. 화면 경로에서 쓰면 종목 하나당 KIS 호출이 여러 번 나가
 * 조회 한도를 빨리 쓴다. 100봉으로는 in/out-of-sample을 나눠 잴 수 없어서
 * (뒤 구간이 30봉이면 MA(20)의 판단 기회가 9번뿐이다) 이 경로를 따로 둔다.
 *
 * 창을 과거로 옮겨 가며 부르고, 받은 것 중 가장 오래된 날의 하루 전으로 다음
 * 창의 끝을 잡는다. 같은 날이 겹쳐 오면 날짜로 중복을 걷는다.
 */
export async function getDailyCandleHistory(
  code: string,
  targetBars = 300,
  maxPages = 5,
): Promise<CandlesResponse> {
  const byTime = new Map<number, Candle>();
  let name = code;
  let end = new Date();

  for (let page = 0; page < maxPages && byTime.size < targetBars; page += 1) {
    const start = new Date(end);
    start.setDate(start.getDate() - DAILY_PAGE_CALENDAR_DAYS);

    /*
     * 페이지 사이에 간격을 둔다. scheduleKisCall이 70ms를 보장하지만, 종목
     * 여러 개를 연달아 받으면 그것만으로는 초당 한도에 걸렸다 — 8종목을
     * 돌리다 다섯째 종목에서 EGW00201로 끊겼다.
     */
    if (page > 0) await delay(KIS_PAGE_GAP_MS);

    const result = await fetchDailyCandlePage(code, start, end);
    if (page === 0) name = result.name;
    // 더 옛날 구간이 비어 있으면(상장 전 등) 멈춘다. 안 그러면 빈 창을 계속 부른다.
    if (result.candles.length === 0) break;

    for (const candle of result.candles) byTime.set(candle.time, candle);

    const oldest = result.candles[0].time;
    end = new Date(oldest * 1000);
    end.setDate(end.getDate() - 1);
  }

  const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  return { code, name, candles };
}

function kstDateTimeToTimestamp(date: string, time: string): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(4, 6));
  const d = Number(date.slice(6, 8));
  const hh = Number(time.slice(0, 2));
  const mm = Number(time.slice(2, 4));
  return Math.floor(Date.UTC(y, m - 1, d, hh - 9, mm, 0) / 1000);
}

function optionalKstDateTimeToTimestamp(date: string | undefined, time: string | undefined): number | undefined {
  if (!/^\d{8}$/.test(date ?? '') || !/^\d{6}$/.test(time ?? '')) return undefined;
  const timestamp = kstDateTimeToTimestamp(date as string, time as string);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

interface TradingViewFields {
  close: number;
  change?: number;
  change_abs?: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  currency?: string;
}

/**
 * TradingView 응답 + **받은 시각**.
 *
 * 야간 환산가는 이 값 둘(원주·환율)과 국내 현재가 하나를 합쳐 만든다. 합친 값의
 * 나이는 셋 중 가장 묵은 것이라, 부분마다 시각을 들고 있어야 그걸 낼 수 있다.
 */
interface TradingViewQuote extends TradingViewFields {
  fetchedAt: number;
}

const NIGHT_PROXY_SPECS: Record<
  string,
  { underlyingCode: string; sourceSymbol: string; fxSymbol: string; ratio: number }
> = {
  'KR:NIGHT_PROXY:005930': {
    underlyingCode: '005930',
    sourceSymbol: 'LSE:BC94',
    fxSymbol: 'FX_IDC:USDKRW',
    ratio: 25,
  },
};

const COMMODITY_CANDLE_SPECS: Record<string, Pick<Instrument, 'providerSymbol' | 'exchangeCode'>> = {
  'GLOBAL:TV_COMMODITY:GOLD': { providerSymbol: 'GCQ26', exchangeCode: 'CME' },
  'GLOBAL:TV_COMMODITY:SILVER': { providerSymbol: 'SIU26', exchangeCode: 'CME' },
  'GLOBAL:TV_COMMODITY:WTI': { providerSymbol: 'CLQ26', exchangeCode: 'CME' },
  'GLOBAL:TV_COMMODITY:NATGAS': { providerSymbol: 'NGQ26', exchangeCode: 'CME' },
};

async function fetchTradingViewQuote(symbol: string): Promise<TradingViewQuote> {
  const url = new URL('https://scanner.tradingview.com/symbol');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('fields', 'close,change,change_abs,open,high,low,volume,currency');

  // 신호는 본문을 다 읽을 때까지 살아 있다 — 응답 머리만 오고 본문이 멈춰도 5초에 끊긴다.
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    throw new Error(`TradingView 조회 실패 (${res.status})`);
  }
  const json = (await res.json()) as Partial<TradingViewFields> & { code?: string; errmsg?: string };
  const fetchedAt = Date.now();
  if (json.code || !Number.isFinite(json.close)) {
    throw new Error(`TradingView 응답이 올바르지 않습니다: ${symbol}`);
  }
  return { ...(json as TradingViewFields), fetchedAt };
}

/** TradingView 값의 전일 대비. `change_abs`·`change`가 없으면 시가 대비로 물러선다 */
function tradingViewChange(quote: TradingViewQuote): { change: number; changeRate: number } {
  const change = Number((quote.change_abs ?? quote.close - (quote.open ?? quote.close)).toFixed(4));
  const changeRate = Number((quote.change ?? (quote.open ? change / quote.open * 100 : 0)).toFixed(2));
  return { change, changeRate };
}

export async function getUsdKrwExchangeRate(): Promise<ExchangeRate> {
  const quote = await fetchTradingViewQuote('FX_IDC:USDKRW');
  return {
    pair: 'USD/KRW',
    baseCurrency: 'USD',
    quoteCurrency: 'KRW',
    rate: quote.close,
    ...tradingViewChange(quote),
    // 응답을 받은 시각. `Date.now()`를 여기서 다시 부르면 계산 시간만큼 새 값처럼 보인다.
    fetchedAt: quote.fetchedAt,
  };
}

function convertGdrPrice(price: number | undefined, fx: number, ratio: number): number | undefined {
  if (!Number.isFinite(price ?? NaN)) return undefined;
  return Number(((price as number) * fx / ratio).toFixed(2));
}

function todayUtcSeconds(): number {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
}

/**
 * 국내주식 1분봉 한 창 (주식일별분봉조회, tr_id: FHKST03010230).
 *
 * `endHour`(`HHMMSS`)에서 **뒤로 최대 120봉**을 준다. 하루 정규장은 391분이라
 * 한 창으로는 하루가 안 덮인다 — `getDomesticDayMinuteCandles`가 창을 이어 붙인다.
 *
 * **`onlyDate`를 넘기면 그 날짜 봉만 남긴다.** 그 날짜에 봉이 하나도 없으면
 * KIS는 오류도 빈 응답도 아닌 **이전 거래일 120봉**을 `MCA00000 정상처리`로
 * 돌려준다(2026-07-31 실측: 일요일 `20260726`을 물었더니 `20260724` 120봉).
 * 과거를 재구성할 때 이걸 안 거르면 없는 날의 값을 지어내게 된다.
 */
async function fetchDomesticMinuteWindow(
  instrument: Instrument,
  endHour: string,
  date: string,
  onlyDate?: string,
): Promise<Candle[]> {
  const json = await kisGet(
    '/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice',
    'FHKST03010230',
    {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: instrument.providerSymbol,
      FID_INPUT_HOUR_1: endHour,
      FID_INPUT_DATE_1: date,
      FID_PW_DATA_INCU_YN: 'N',
      FID_FAKE_TICK_INCU_YN: '',
    },
  );

  const output2 = (json.output2 ?? []) as Array<Record<string, string>>;
  return output2
    .filter((r) => /^\d{8}$/.test(r.stck_bsop_date ?? '') && /^\d{6}$/.test(r.stck_cntg_hour ?? ''))
    .filter((r) => onlyDate === undefined || r.stck_bsop_date === onlyDate)
    .map((r) => ({
      time: kstDateTimeToTimestamp(r.stck_bsop_date, r.stck_cntg_hour),
      open: toNumber(r.stck_oprc),
      high: toNumber(r.stck_hgpr),
      low: toNumber(r.stck_lwpr),
      close: toNumber(r.stck_prpr),
      volume: toNumber(r.cntg_vol),
    }))
    .filter(isValidCandle)
    .sort((a, b) => a.time - b.time);
}

/**
 * 정규장 391분을 덮는 창 다섯 개. 한 번에 120봉이라 겹쳐 가며 이어 붙인다.
 *
 *   093000 → 0900~0930 · 110000 → 0901~1100 · 130000 → 1101~1300
 *   150000 → 1301~1500 · 235959 → 1321~1530
 *
 * 09:00 봉을 위해 `093000`이 따로 있다 — 개장 동시호가가 거기 들어간다.
 * 이 값은 2026-07-31에 실제로 받아 보고 정했다(`docs/USER_FINDINGS.md`).
 */
const MINUTE_WINDOW_HOURS = ['093000', '110000', '130000', '150000', '235959'];

/** 한 종목·하루를 덮는 데 드는 KIS 호출 수. 부르는 쪽이 예산을 세울 수 있어야 한다. */
export const MINUTE_CALLS_PER_DAY = MINUTE_WINDOW_HOURS.length;

/**
 * 국내주식 하루치 1분봉. **과거 날짜를 받는다.**
 *
 * 창 다섯 개를 이어 붙이고 겹친 봉은 시각으로 합친다. 받아진 가장 오래된 날짜는
 * 2025-10-31이었다(`scripts/probeIntradayHistory.ts`).
 *
 * **이어 붙인 것이 맞는지는 부르는 쪽이 일봉 고가·저가와 대조한다.** 한 창이라도
 * 빠지면 하루 고저가 달라지므로 봉 수를 세는 것보다 엄한 검사다. 여기서 하지 않는
 * 이유는 일봉을 또 받아야 해서다 — 여러 날을 재는 쪽은 일봉을 한 번만 받아 두고
 * 쓴다.
 *
 * `gapMs`는 창 사이 간격이다. KIS 초당 한도(EGW00201)를 태우지 않게 둔다 —
 * 백엔드도 같은 앱키를 쓰고 있다.
 */
export async function getDomesticDayMinuteCandles(
  instrument: Instrument,
  date: string,
  gapMs = 220,
): Promise<Candle[]> {
  const byTime = new Map<number, Candle>();
  for (const [index, hour] of MINUTE_WINDOW_HOURS.entries()) {
    for (const candle of await fetchDomesticMinuteWindow(instrument, hour, date, date)) {
      byTime.set(candle.time, candle);
    }
    if (index < MINUTE_WINDOW_HOURS.length - 1 && gapMs > 0) {
      await delay(gapMs);
    }
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * 국내주식 1분봉 시세 — **오늘 것 한 창(최대 120봉)**. 화면 차트가 쓴다.
 *
 * 날짜를 안 거른다. 그 날짜에 봉이 없으면(개장 전·휴장일) KIS가 전날 것을 준다.
 */
async function getDomesticIntradayCandles(instrument: Instrument): Promise<CandlesResponse> {
  const candles = await fetchDomesticMinuteWindow(instrument, '235959', kstToday());
  return { code: instrument.id, name: instrument.name, candles };
}

async function getOverseasIntradayCandles(instrument: Instrument): Promise<CandlesResponse> {
  const json = await kisGet('/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice', 'HHDFS76950200', {
    AUTH: '',
    EXCD: instrument.exchangeCode,
    SYMB: instrument.providerSymbol,
    NMIN: '1',
    PINC: '1',
    NEXT: '',
    NREC: '120',
    FILL: '',
    KEYB: '',
  });

  const output2 = (json.output2 ?? []) as Array<Record<string, string>>;
  const candles: Candle[] = output2
    .filter((r) => /^\d{8}$/.test(r.kymd ?? '') && /^\d{6}$/.test(r.khms ?? ''))
    .map((r) => ({
      time: kstDateTimeToTimestamp(r.kymd, r.khms),
      open: toNumber(r.open),
      high: toNumber(r.high),
      low: toNumber(r.low),
      close: toNumber(r.last),
      volume: toNumber(r.evol),
    }))
    .filter(isValidCandle)
    .sort((a, b) => a.time - b.time);

  return { code: instrument.id, name: instrument.name, candles };
}

/**
 * 현재가 스냅샷 (주식현재가 시세, tr_id: FHKST01010100).
 *
 * `exchange`를 생략하면 KRX다 — **기존 호출부의 동작이 그대로여야 한다.**
 * 개장 전(08:00~08:50)에는 KRX가 닫혀 있어 이 함수가 **전일 종가**를 준다.
 * 그 시각의 살아 있는 값은 `'NXT'`로만 나온다(`exchanges.ts`).
 */
export async function getQuote(code: string, exchange: KisExchange = DEFAULT_EXCHANGE): Promise<Quote> {
  const json = await kisGet(
    '/uapi/domestic-stock/v1/quotations/inquire-price',
    'FHKST01010100',
    { FID_COND_MRKT_DIV_CODE: marketDivCode(exchange), FID_INPUT_ISCD: code },
  );
  /*
   * 응답을 받은 순간을 찍는다. KIS는 시세에 시각을 주지 않는다 — 이 응답의
   * output 80필드에 "이 값의 시각"이 없다(2026-07-31 실측). 정규화가 끝난 뒤에
   * 찍어도 실질 차이는 없지만, 뒤에 무거운 계산이 붙으면 그만큼 새 값처럼 보인다.
   */
  const fetchedAt = Date.now();
  const o = (json.output ?? {}) as Record<string, string>;
  /*
   * 누적 거래대금은 단건·멀티시세가 같은 필드명(acml_tr_pbmn)으로 준다. 값을
   * 못 받으면 담지 않는다 — `Number('')`은 0이라 그냥 읽으면 "오늘 한 주도
   * 거래되지 않았다"는 사실이 지어진다.
   */
  const turnover = toNumberOrNaN(o.acml_tr_pbmn);
  /*
   * ★ **가격 0은 시세가 아니다** (2026-08-14 실측).
   *
   * KIS는 없는 종목·상장폐지 종목에도 **오류가 아니라 전 필드 `'0'`으로 정상
   * 응답한다.** `rt_cd=0` · `msg1='정상처리 되었습니다'`이고 `requireNumber`도
   * 통과한다 — `'0'`은 빈 칸이 아니기 때문이다. 그대로 두면 화면이 `0원`이라고
   * 적고, 그 값이 `estimatedPrice`로 주문 경로까지 흘러간다.
   *
   *   000060(2023 폐지)  실전·모의 둘 다  output 72필드 중 42개가 '0'
   *   005930(정상)                        output 80필드 · '0'은 1개
   *
   * 필드 수(80 vs 72)로도 갈리지만 그건 KIS 스펙에 기대는 것이라, **값이 말하는
   * 것**으로 가른다 — 0원에 거래되는 주식은 없다. 이름은 잰 사실(`가격 0`)로
   * 하고 원인(폐지·거래정지)은 추론이라 괄호에 둔다.
   *
   * ★ 멀티시세는 이 길로 오지 않는다(`multiQuote.ts`). 거기서 한 종목이 비면
   * 그 종목만 빠져야지 묶음 전체가 던지면 안 된다.
   */
  const price = requireNumber(o.stck_prpr, 'stck_prpr');
  if (price === 0) {
    throw new Error(
      `현재가가 0원으로 왔습니다: ${code}`
      + ' (상장폐지·거래정지 종목이 이렇게 옵니다. KIS는 오류 대신 전 필드 0을 줍니다)',
    );
  }
  return {
    code,
    fetchedAt,
    price,
    change: requireNumber(o.prdy_vrss, 'prdy_vrss'),
    changeRate: requireNumber(o.prdy_ctrt, 'prdy_ctrt'),
    sign: parseSign(o.prdy_vrss_sign),
    open: requireNumber(o.stck_oprc, 'stck_oprc'),
    high: requireNumber(o.stck_hgpr, 'stck_hgpr'),
    low: requireNumber(o.stck_lwpr, 'stck_lwpr'),
    accVolume: requireNumber(o.acml_vol, 'acml_vol'),
    ...(isNonNegativeFinite(turnover) ? { turnover } : {}),
  };
}

/** 한 묶음이 통째로 실패한 사실. 어느 종목이 왜 안 왔는지 남긴다. */
export interface QuoteBatchFailure {
  codes: string[];
  message: string;
}

/**
 * 여러 종목 시세를 한 번에 받은 결과.
 *
 * **못 받은 것을 빈 값으로 지우지 않는다.** 세 가지를 따로 담는다 —
 * 받은 것(`quotes`), KIS가 자리만 주고 값을 비운 것(`blank`), 묶음째 못 받은 것(`failed`).
 * 하나로 뭉치면 "그런 종목이 없다"와 "조회가 깨졌다"가 구별되지 않는다.
 */
export interface QuoteBatchResult {
  /** 종목코드 → 시세 */
  quotes: Map<string, Quote>;
  blank: string[];
  failed: QuoteBatchFailure[];
  /**
   * 이 결과를 만드는 데 실제로 나간 KIS 호출 수.
   *
   * 부르는 쪽이 화면에 "이 버튼은 4회입니다"라고 적을 수 있어야 한다. 종목 수로
   * 세면 안 된다 — 30종목이 1회고, 캐시에 있던 것은 0회다. 실패한 묶음도 센다.
   * **호출은 이미 나갔기 때문이다.**
   */
  calls: number;
}

/**
 * 국내 주식·ETF 시세를 30종목씩 묶어 받는다 (관심종목 복수시세, tr_id: FHKST11300006).
 *
 * 종목당 1회이던 조회가 30종목당 1회가 된다. 110종목짜리 반도체 테마가 4회로 끝난다.
 *
 * 한 묶음이 실패해도 나머지는 살린다. 대신 **없던 일로 하지 않고** `failed`에 담아
 * 부른 쪽이 "몇 개를 못 봤는지" 적을 수 있게 한다.
 */
export async function getDomesticQuotes(codes: string[]): Promise<QuoteBatchResult> {
  // 같은 코드를 두 번 넣으면 응답도 두 행이 와서 자리 검산이 헷갈린다. 순서는 지킨다.
  const unique = [...new Set(codes.map((code) => code.trim()).filter((code) => code.length > 0))];
  const result: QuoteBatchResult = { quotes: new Map(), blank: [], failed: [], calls: 0 };

  /*
   * ★ **서버가 답을 안 하면 남은 묶음은 묻지 않는다** (2026-09-17).
   *
   * 9/16 14:13부터 KIS 모의 서버가 연결은 받고 응답을 0바이트로 흘렸다. 묶음마다
   * 15초 타임아웃 × 재연결 1회 = 30초라, 900종목(30묶음)을 끝까지 두드리느라
   * 적정가 한 회차가 **17분**을 썼다(14:42~14:59). 응답 없는 묶음이 연달아 둘이면
   * 나머지도 같다고 보고 `failed`에만 적는다. 서버가 답을 준 실패(rt_cd)는 세지 않는다.
   */
  let unansweredInARow = 0;
  for (const chunk of chunkQuoteCodes(unique)) {
    if (unansweredInARow >= 2) {
      result.failed.push({ codes: chunk, message: `앞 묶음 ${unansweredInARow}개가 연달아 응답이 없어 묻지 않았다` });
      continue;
    }
    result.calls += 1;
    try {
      const json = await kisGet(MULTI_QUOTE_PATH, MULTI_QUOTE_TR_ID, multiQuoteParams(chunk));
      // 이 묶음 30종목이 같이 받은 시각. 묶음마다 따로 찍는다 — 앞 묶음과 뒤 묶음은 나이가 다르다.
      const fetchedAt = Date.now();
      /*
       * rt_cd를 먼저 본다. 실패 응답에는 output이 아예 없어 "전부 빈 행"으로 보이는데,
       * 그러면 종목이 없어진 것과 조회가 깨진 것이 같은 모양이 된다.
       */
      if (String(json.rt_cd ?? '') !== '0') {
        throw new Error(`KIS 멀티시세 실패 (${json.msg_cd ?? ''}): ${json.msg1 ?? ''}`);
      }
      const rows = (json.output ?? []) as Array<Record<string, string>>;
      const parsed = parseMultiQuoteChunk(chunk, Array.isArray(rows) ? rows : [], fetchedAt);
      for (const quote of parsed.quotes) result.quotes.set(quote.code, quote);
      result.blank.push(...parsed.blank);
      unansweredInARow = 0;
    } catch (err) {
      unansweredInARow = isTransientNetworkError(err) ? unansweredInARow + 1 : 0;
      result.failed.push({ codes: chunk, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

/**
 * 멀티시세로 묶을 수 있는 종목인가. KRX 현금 종목(주식·ETF·ETN)만 된다.
 *
 * 부르기 **전에** 호출 비용을 어림해야 하는 곳(테마 등락률의 예산 계산)이 있어
 * 내보낸다. 묶이는 것은 30종목이 1회, 나머지는 종목당 1회다.
 */
export function canBatchQuote(instrument: Instrument): boolean {
  if (instrument.country !== 'KR' || instrument.provider !== 'kis') return false;
  return instrument.assetType === 'stock' || instrument.assetType === 'etf' || instrument.assetType === 'etn';
}

/** 여러 종목 시세를 받은 결과. 키는 `Instrument.id`다 (`getInstrumentQuote`와 같은 규약). */
export interface InstrumentQuoteBatchResult {
  quotes: Map<string, Quote>;
  blank: string[];
  failed: Array<{ instrumentIds: string[]; message: string }>;
  /**
   * 실제로 나간 KIS 호출 수. 묶음 호출은 정확하고, **묶을 수 없는 종목은
   * 종목당 1회로 센다** — 야간 환산가처럼 안에서 환율까지 더 부르는 경로가 있어
   * 그쪽은 하한이다. 테마 종목은 전부 국내 주식이라 묶음 쪽만 쓰인다.
   */
  calls: number;
}

/**
 * 종목 목록의 시세를 한꺼번에 받는다.
 *
 * KRX 현금 종목은 30개씩 묶어 멀티시세로, 나머지(해외·선물·원자재·야간 환산가)는
 * 묶을 수 없어 하나씩 부른다. 반환 키를 `Instrument.id`로 맞춰 부른 쪽이
 * `getInstrumentQuote`와 같은 값을 쓰게 한다.
 */
/**
 * 거래소가 매긴 **거래대금 상위 종목코드.** 한 번 호출로 전 종목 순위가 온다.
 *
 * ── 왜 필요했나 (2026-08-04 실측) ────────────────────────────────────────
 *
 * 러너는 종목 마스터를 **코드순으로 240개씩** 훑으며 거래대금을 쌓아 순위를
 * 만들고 있었다. 그런데 그 240개는 풀 3,929종목의 **6.1%**이고, 거래대금 상위
 * 20종목 중 그 안에 든 것은 **SK하이닉스 하나**였다.
 *
 *   005930 삼성전자   풀 406번째      035420 NAVER      풀 1,131번째
 *   009150 삼성전기   풀 540번째      475150 SK이터닉스  풀 3,702번째
 *
 * 회차마다 60종목씩 밀어 약 17분이면 한 바퀴 돌게 해 뒀지만, **서버가 재기동되면
 * 그 진행이 0으로 돌아간다**(모듈 상태). 오늘 아침에만 4번 재기동됐고 한 바퀴를
 * 돈 적이 없다. 결과적으로 "거래대금 순 정렬"이 **코드순 앞 6% 슬라이스 안에서만**
 * 작동했다 — 러너의 2순위 후보(대한전선 245억)가 시장 20위(784억)에도 못 미쳤다.
 *
 * 거래소에 직접 물으면 이 문제가 통째로 사라진다. 훑을 필요가 없다.
 *
 * ── 무엇을 주고 무엇을 안 주나 ───────────────────────────────────────────
 *
 * `fid_blng_cls_code`가 무엇으로 줄 세울지 정한다. `3`이 거래금액순이다.
 * 응답은 **상위 몇십 종목까지**다 — 전 종목 순위표가 아니다. 후보를 고르는 데는
 * 그것으로 충분하지만, "이 목록에 없으면 거래대금이 낮다"고 읽으면 안 된다.
 *
 * 여기서는 **종목코드만** 돌려준다. 가격·잔량은 부른 쪽이 멀티시세로 받는다 —
 * 이 TR의 값은 필드 이름이 다르고, 같은 사실을 두 경로로 읽으면 갈린다.
 */
/** 하루치 투자자별 순매수. **수량이 아니라 금액**이 필요하면 부른 쪽이 값을 곱한다. */
export interface InvestorFlowDay {
  /** 거래일 `YYYYMMDD` */
  tradingDay: string;
  /** 그날 종가. 수급을 가격과 맞춰 보려면 같은 응답의 값을 써야 어긋나지 않는다 */
  close: number;
  /** 개인 순매수 수량(주). 음수면 순매도 */
  individual: number;
  foreign: number;
  institution: number;
}

/**
 * 하루치 시세·공매도. **한 번 호출에 100거래일**이 온다.
 *
 * 필드 이름은 실제로 찍어 확인했다(`scripts/probeNewDataApis.ts`, 2026-08-05).
 */
export interface DailyMarketBar {
  /** 거래일 `YYYYMMDD` */
  tradingDay: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 거래량(주) */
  volume: number;
  /** 거래대금(원) */
  turnover: number;
  /** 그날 거래량 중 공매도 비중(%). KIS가 계산해 준 값이다 */
  shortRatio: number;
  /** 공매도 체결 수량(주) */
  shortVolume: number;
  /** 그날 거래량 가중 평균가. 체결 비용을 재는 데 쓸 수 있다 */
  vwap: number;
}

/**
 * 종목별 일별 시세 + 공매도 — `FHPST04830000`.
 *
 * ── 왜 이 TR인가 (2026-08-05) ────────────────────────────────────────────
 *
 * 신호 후보를 늘리려면 종가만으로는 부족하다 — 거래량·고저·거래대금이 있어야
 * 변동성·유동성·범위 계열을 만들 수 있다. 그런데 이 TR 하나가 **OHLC + 거래량
 * + 거래대금 + 공매도 비중**을 한꺼번에 주고, **한 번에 100거래일**이 온다
 * (투자자 매매동향은 30일씩이다).
 *
 * 공매도 비중이 특히 값어치가 있다. 남들이 덜 보는 축이고, "빌려서 파는 쪽이
 * 무엇을 아는가"라는 가설은 수급(사는 쪽)과 다른 정보다.
 *
 * ── 주의 ─────────────────────────────────────────────────────────────────
 *
 * 일별 행은 **`output2`**에 있다. `output1`은 그 종목의 **현재** 요약이라
 * 과거 측정에 쓰면 안 된다 — 처음 찍었을 때 그것만 보고 "1행뿐"이라고 읽을 뻔했다.
 */
export async function getDailyMarketBars(
  symbol: string,
  fromDate: string,
  toDate: string,
  credentials?: KisCredentials,
  /**
   * 어느 거래소의 일봉인가. 생략하면 KRX — **기존 호출부가 그대로여야 한다.**
   *
   * ★ `'UNIFIED'`는 거래량·거래대금·공매도만 합쳐 주고 **OHLC는 NXT 것**을 준다.
   * 가격을 쓸 거면 `'KRX'`나 `'NXT'` 중 뜻하는 쪽을 골라야 한다(`exchanges.ts`).
   *
   * `'NXT'`의 시가는 **08:00 프리마켓 시가**다(2026-08-04 분봉 대조 확인:
   * 005930 일봉 시가 239,000 = 08:00 분봉 시가). 고저종은 20:00까지를 덮는다.
   */
  exchange: KisExchange = DEFAULT_EXCHANGE,
): Promise<DailyMarketBar[]> {
  const { body } = await kisGetWithHeaders(
    '/uapi/domestic-stock/v1/quotations/daily-short-sale',
    'FHPST04830000',
    {
      FID_COND_MRKT_DIV_CODE: marketDivCode(exchange),
      FID_INPUT_ISCD: symbol,
      FID_INPUT_DATE_1: fromDate,
      FID_INPUT_DATE_2: toDate,
    },
    '',
    credentials ?? primaryCredentials,
  );
  const rows = Array.isArray(body.output2) ? (body.output2 as Array<Record<string, string>>) : [];
  const bars: DailyMarketBar[] = [];
  for (const row of rows) {
    const day = String(row.stck_bsop_date ?? '').trim();
    // 빈 자리를 거래일로 세지 않는다. KIS는 응답을 고정 길이로 채울 때가 있다.
    if (!/^\d{8}$/.test(day)) continue;
    bars.push({
      tradingDay: day,
      open: Number(row.stck_oprc ?? 0),
      high: Number(row.stck_hgpr ?? 0),
      low: Number(row.stck_lwpr ?? 0),
      close: Number(row.stck_clpr ?? 0),
      volume: Number(row.acml_vol ?? 0),
      turnover: Number(row.acml_tr_pbmn ?? 0),
      shortRatio: Number(row.ssts_vol_rlim ?? 0),
      shortVolume: Number(row.ssts_cntg_qty ?? 0),
      vwap: Number(row.avrg_prc ?? 0),
    });
  }
  return bars;
}

/**
 * 종목별 투자자 매매동향(일별) — `FHPTJ04160001`.
 *
 * ── 왜 이걸 보나 (2026-08-04) ────────────────────────────────────────────
 *
 * 지금까지 이 레포가 잰 것은 **전부 가격에서 가격을 예측**하는 것이었다
 * (이동평균 교차·변동성 돌파·평균 회귀). 오늘 거울 검증에서 1분봉 축의 방향
 * 정보가 **0**으로 나왔다 — 가격만으로는 그 축에서 아무것도 못 한다는 뜻이다.
 *
 * 수급은 **가격 밖의 정보**다. 사용자가 말한 *"자본이 많이 투입되고 빠져나가고를
 * 반복한다"*를 잴 수 있는 형태로 바꾸면 두 물음이 된다.
 *
 *   ① 유입·유출이 **이어지는가** — 오늘 순매수가 내일을 말해 주는가
 *   ② 그것이 **가격에 남는가** — 순매수 상위를 사서 N일 뒤 팔면 어땠나
 *
 * ①만 참이고 ②가 거짓이면 **이미 값에 반영된 것**이라 우리에게는 0이다.
 * 수급 데이터는 공개돼 있고 무료라, ②를 반드시 재야 한다.
 *
 * ── 주의 ─────────────────────────────────────────────────────────────────
 *
 * **순매수는 수량(주)이다.** 금액이 아니다 — 값이 다른 종목끼리 크기를 견주려면
 * 종가를 곱해야 한다. 그 종가도 같은 응답에 있으니 함께 담아 돌려준다.
 * 다른 경로로 받은 가격과 섞으면 수정주가·거래일 경계에서 어긋난다.
 */
export async function getInvestorFlowDaily(
  symbol: string,
  endDate: string,
  credentials?: KisCredentials,
): Promise<InvestorFlowDay[]> {
  const { body } = await kisGetWithHeaders(
    '/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily',
    'FHPTJ04160001',
    {
      fid_cond_mrkt_div_code: 'J',
      fid_input_iscd: symbol,
      fid_input_date_1: endDate,
      // 0 = 수정주가. 액면분할·병합을 지나면 원주가는 이어지지 않는다.
      fid_org_adj_prc: '0',
      fid_etc_cls_code: '1',
    },
    '',
    credentials ?? primaryCredentials,
  );
  const rows = Array.isArray(body.output2) ? (body.output2 as Array<Record<string, string>>) : [];
  const days: InvestorFlowDay[] = [];
  for (const row of rows) {
    const day = String(row.stck_bsop_date ?? '').trim();
    // 빈 자리를 거래일로 세지 않는다. KIS는 응답을 고정 길이로 채울 때가 있다.
    if (!/^\d{8}$/.test(day)) continue;
    days.push({
      tradingDay: day,
      close: Number(row.stck_clpr ?? 0),
      individual: Number(row.prsn_ntby_qty ?? 0),
      foreign: Number(row.frgn_ntby_qty ?? 0),
      institution: Number(row.orgn_ntby_qty ?? 0),
    });
  }
  return days;
}

/**
 * **조사 전용** 원본 조회. 응답 필드를 짐작하지 않고 찍어 보려고 둔다.
 *
 * 새 TR을 붙일 때마다 필드 이름을 문서에서 베끼면 어긋난다 — 이 레포는 KIS가
 * 값 없는 자리에 빈 문자열을 주고, 문서에 없는 필드를 주고, 문서에 있는 필드를
 * 안 주는 것을 여러 번 겪었다. **먼저 찍고 그 다음 타입을 짓는다.**
 *
 * 제품 경로에서 쓰지 마라. 정규화를 안 하므로 KIS 원본 필드명이 그대로 나온다
 * (CLAUDE.md 1번).
 */
export async function probeRawQuery(
  account: KisAccountConfig,
  path: string,
  trId: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const { body } = await kisGetWithHeaders(path, trId, params, '', {
    ...toCredentials(account),
    crossServerRead: true,
  });
  return body;
}

/**
 * 국내 업종 현재지수 — `FHPUP02100000`.
 *
 * ── 왜 지금 붙었나 (2026-08-06) ──────────────────────────────────────────
 *
 * 판단자가 에이전트로 바뀌면서 **시장 맥락을 스스로 재야 하는데** 이 레포에는
 * 지수 조회가 없었다. 2026-08-05 회의에서 코스피 등락률을 **언론 기사에서 인용**해
 * 판단했다 — 우리가 잰 값이 아니었고, 기사끼리도 값이 갈렸다.
 *
 * ★ **시장 구분 코드가 `'U'`다.** 종목 시세의 `'J'`가 아니다(공식 예제 확인).
 * 섞으면 응답이 빈다. 그래서 `exchanges.ts`의 `KisExchange`를 여기 쓰지 않는다 —
 * 그건 종목 거래소를 고르는 값이고 이건 **업종이라는 다른 축**이다.
 *
 * 모의 서버에서도 된다(2026-08-05 실측).
 */
export const DOMESTIC_INDEX_CODES = {
  kospi: '0001',
  kosdaq: '1001',
  kospi200: '2001',
} as const;

const DOMESTIC_INDEX_NAMES: Record<string, string> = {
  '0001': '코스피',
  '1001': '코스닥',
  '2001': '코스피200',
};

export async function getDomesticIndex(code: string): Promise<DomesticIndexQuote> {
  const json = await kisGet(
    '/uapi/domestic-stock/v1/quotations/inquire-index-price',
    'FHPUP02100000',
    // 업종은 'U'다. 종목의 'J'를 넣으면 빈 응답이 온다.
    { FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: code },
  );
  const o = (json.output ?? {}) as Record<string, string>;
  const value = toNumber(o.bstp_nmix_prpr);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`지수 응답에 현재가가 없습니다 (${code}).`);
  }
  return {
    code,
    name: DOMESTIC_INDEX_NAMES[code] ?? code,
    value,
    change: toNumber(o.bstp_nmix_prdy_vrss),
    changeRate: toNumber(o.bstp_nmix_prdy_ctrt),
    sign: parseSign(o.prdy_vrss_sign),
    advancing: toNumber(o.ascn_issu_cnt),
    declining: toNumber(o.down_issu_cnt),
    unchanged: toNumber(o.stnr_issu_cnt),
    turnover: toNumber(o.acml_tr_pbmn),
    fetchedAt: Date.now(),
  };
}

export async function getDomesticTurnoverRanking(limit = 30): Promise<string[]> {
  const { body } = await kisGetWithHeaders(
    '/uapi/domestic-stock/v1/quotations/volume-rank',
    'FHPST01710000',
    {
      fid_cond_mrkt_div_code: 'J',
      fid_cond_scr_div_code: '20171',
      // `0000`이 전체 시장이다. 특정 업종만 보려면 여기를 바꾼다.
      fid_input_iscd: '0000',
      fid_div_cls_code: '0',
      // 3 = 거래금액순. 0(거래량순)과 다르다 — 값싼 종목이 거래량으로는 위에 온다.
      fid_blng_cls_code: '3',
      fid_trgt_cls_code: '111111111',
      fid_trgt_exls_cls_code: '000000',
      fid_input_price_1: '',
      fid_input_price_2: '',
      fid_vol_cnt: '',
      fid_input_date_1: '',
    },
  );
  const rows = Array.isArray(body.output) ? (body.output as Array<Record<string, string>>) : [];
  const symbols: string[] = [];
  for (const row of rows) {
    const code = String(row.mksc_shrn_iscd ?? '').trim();
    // 빈 자리를 종목으로 세지 않는다. KIS는 응답을 고정 길이로 채워 보낼 때가 있다.
    if (code.length === 0) continue;
    symbols.push(code);
    if (symbols.length >= limit) break;
  }
  return symbols;
}

export async function getInstrumentQuotes(instruments: Instrument[]): Promise<InstrumentQuoteBatchResult> {
  const result: InstrumentQuoteBatchResult = { quotes: new Map(), blank: [], failed: [], calls: 0 };

  const batchable = instruments.filter(canBatchQuote);
  const rest = instruments.filter((instrument) => !canBatchQuote(instrument));

  if (batchable.length > 0) {
    // 한 종목코드가 두 시장에 있을 수 있으므로 코드 하나에 종목 여럿을 매단다.
    const byProviderSymbol = new Map<string, Instrument[]>();
    for (const instrument of batchable) {
      const list = byProviderSymbol.get(instrument.providerSymbol);
      if (list) list.push(instrument);
      else byProviderSymbol.set(instrument.providerSymbol, [instrument]);
    }

    const batch = await getDomesticQuotes([...byProviderSymbol.keys()]);
    const idsOf = (symbols: string[]): string[] =>
      symbols.flatMap((symbol) => (byProviderSymbol.get(symbol) ?? []).map((instrument) => instrument.id));

    for (const [symbol, list] of byProviderSymbol) {
      const quote = batch.quotes.get(symbol);
      if (!quote) continue;
      // 종목 식별자는 우리 것으로 바꿔 담는다. KIS 코드는 kis/ 밖으로 나가지 않는다.
      for (const instrument of list) result.quotes.set(instrument.id, { ...quote, code: instrument.id });
    }
    result.blank.push(...idsOf(batch.blank));
    for (const failure of batch.failed) {
      result.failed.push({ instrumentIds: idsOf(failure.codes), message: failure.message });
    }
    result.calls += batch.calls;
  }

  for (const instrument of rest) {
    result.calls += 1;
    try {
      result.quotes.set(instrument.id, await getInstrumentQuote(instrument));
    } catch (err) {
      result.failed.push({
        instrumentIds: [instrument.id],
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * 거래소 등락률 순위 (국내주식 등락률 순위, tr_id: FHPST01700000).
 *
 * **파라미터 두 개가 정렬 기준을 정한다. 값을 바꾸면 다른 표가 나온다.**
 *   FID_PRC_CLS_CODE      1 = 종가(전일)대비   0 = 저가대비
 *   FID_RANK_SORT_CLS_CODE 0 = 상승률순        1 = 하락률순
 *
 * `0`으로 두면 **저가대비** 상승률로 정렬돼서 전일대비로는 뒤죽박죽이 된다 —
 * 실제로 1위가 +22.28%인데 6위가 +30.00%였다(2026-07-27 실측). `1`로 둬야
 * 전일대비 내림차순이 된다. 30행 전부가 내림차순인 것을 확인하고 넣었다.
 *
 * 한 번에 30행이 온다. **전 종목이 아니라 상위 30이다** — 화면이 그렇게 적어야 한다.
 */
export async function getMarketMovers(direction: 'up' | 'down'): Promise<MarketMoversSnapshot> {
  const json = await kisGet('/uapi/domestic-stock/v1/ranking/fluctuation', 'FHPST01700000', {
    fid_cond_mrkt_div_code: 'J',
    fid_cond_scr_div_code: '20170',
    fid_input_iscd: '0000',
    fid_rank_sort_cls_code: direction === 'up' ? '0' : '1',
    fid_input_cnt_1: '0',
    // 전일 종가 대비. 0(저가대비)으로 두면 정렬이 등락률과 어긋난다.
    fid_prc_cls_code: '1',
    fid_input_price_1: '',
    fid_input_price_2: '',
    fid_vol_cnt: '',
    fid_trgt_cls_code: '0',
    fid_trgt_exls_cls_code: '0',
    fid_div_cls_code: '0',
    fid_rsfl_rate1: '',
    fid_rsfl_rate2: '',
  });

  const raw = (json.output ?? []) as Array<Record<string, string>>;
  const symbols = raw.map((row) => String(row.stck_shrn_iscd ?? '').trim()).filter(Boolean);
  const bySymbol = await getDomesticInstrumentsBySymbols(symbols);

  const rows = raw
    .map((row, index): MarketMover | null => {
      const symbol = String(row.stck_shrn_iscd ?? '').trim();
      const price = toNumber(row.stck_prpr);
      if (!symbol || !Number.isFinite(price)) return null;
      return {
        rank: Number(row.data_rank) || index + 1,
        symbol,
        name: String(row.hts_kor_isnm ?? symbol).trim(),
        price,
        change: toNumber(row.prdy_vrss),
        changeRate: toNumber(row.prdy_ctrt),
        sign: parseSign(row.prdy_vrss_sign),
        accVolume: toNumber(row.acml_vol),
        instrument: bySymbol.get(symbol),
      } satisfies MarketMover;
    })
    .filter((row): row is MarketMover => row !== null);

  return { direction, fetchedAt: Date.now(), rows };
}

/**
 * KIS 재무 API가 "값 없음"에 쓰는 표시.
 *
 * 규모가 전혀 다른 세 회사(삼성전자 매출 133조 / SK하이닉스 52조 / 동화약품
 * 1,306억)가 같은 필드에서 정확히 99.99를 돌려줬다(2026-07-27 실측).
 * 값이 아니라 표시다. 숫자로 읽으면 화면이 거짓말을 한다.
 */
const KIS_FINANCE_MISSING = 99.99;

function financeNumber(value: string | undefined): number | undefined {
  const parsed = toNumber(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed === KIS_FINANCE_MISSING ? undefined : parsed;
}

/** 재무 API 한 종류를 결산연월로 뽑아 온다. 실패하면 빈 맵 — 나머지는 살린다. */
async function fetchFinanceRows(
  path: string,
  trId: string,
  code: string,
): Promise<Map<string, Record<string, string>>> {
  const byPeriod = new Map<string, Record<string, string>>();
  try {
    const json = await kisGet(path, trId, {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: code,
      FID_DIV_CLS_CODE: '1',
    });
    const rows = (json.output ?? []) as Array<Record<string, string>>;
    for (const row of rows) {
      if (typeof row.stac_yymm === 'string') byPeriod.set(row.stac_yymm, row);
    }
  } catch {
    // 한 종류가 실패해도 나머지 지표는 쓸 수 있다.
  }
  return byPeriod;
}

/**
 * 종목 하나의 분기별 재무 지표. 최근 분기가 앞에 온다.
 *
 * 세 엔드포인트(재무비율·손익계산서·대차대조표)를 결산연월로 맞춰 합친다.
 * KIS 원본 필드명은 여기서 끝나고 밖으로는 `@invest/shared` 타입만 나간다.
 */
export async function getFinancials(code: string, limit = 12): Promise<FinancialSnapshot[]> {
  const [ratio, income, balance] = await Promise.all([
    fetchFinanceRows('/uapi/domestic-stock/v1/finance/financial-ratio', 'FHKST66430300', code),
    fetchFinanceRows('/uapi/domestic-stock/v1/finance/income-statement', 'FHKST66430200', code),
    fetchFinanceRows('/uapi/domestic-stock/v1/finance/balance-sheet', 'FHKST66430100', code),
  ]);

  // 결산연월 합집합. 한 종류만 있는 분기도 버리지 않는다.
  const periods = [...new Set([...ratio.keys(), ...income.keys(), ...balance.keys()])]
    .sort((a, b) => b.localeCompare(a))
    .slice(0, limit);

  return periods.map((period) => {
    const r = ratio.get(period) ?? {};
    const i = income.get(period) ?? {};
    const b = balance.get(period) ?? {};
    const revenue = financeNumber(i.sale_account);
    const netIncome = financeNumber(i.thtr_ntin);
    return {
      period,
      roe: financeNumber(r.roe_val),
      eps: financeNumber(r.eps),
      bps: financeNumber(r.bps),
      debtRatio: financeNumber(r.lblt_rate),
      revenueGrowth: financeNumber(r.grs),
      // 순이익률은 KIS가 따로 주지 않아 매출과 순이익으로 계산한다. 둘 다 있을 때만.
      netMargin:
        revenue !== undefined && netIncome !== undefined && revenue > 0
          ? Number(((netIncome / revenue) * 100).toFixed(2))
          : undefined,
      revenue,
      operatingProfit: financeNumber(i.bsop_prti),
      netIncome,
      totalAssets: financeNumber(b.total_aset),
      totalLiabilities: financeNumber(b.total_lblt),
      totalEquity: financeNumber(b.total_cptl),
    };
  });
}

export async function getInstrumentCandles(
  instrument: Instrument,
  days = 120,
): Promise<CandlesResponse> {
  if (instrument.assetType === 'night_proxy') {
    return { code: instrument.id, name: instrument.name, candles: [] };
  }
  if (instrument.assetType === 'commodity') return getCommodityIndicatorCandles(instrument);
  if (isFutureAssetType(instrument.assetType)) {
    if (instrument.market === 'OV_FUT') return getOverseasFutureDailyCandles(instrument);
    return getDomesticFutureDailyCandles(instrument, days);
  }
  if (instrument.country === 'KR') {
    const response = await getDailyCandles(instrument.providerSymbol, days);
    return { ...response, code: instrument.id, name: instrument.name };
  }
  return getOverseasDailyCandles(instrument, days);
}

export async function getInstrumentQuote(instrument: Instrument): Promise<Quote> {
  if (instrument.assetType === 'commodity') {
    return getTradingViewInstrumentQuote(instrument);
  }
  if (instrument.assetType === 'night_proxy') {
    return getNightProxyQuote(instrument);
  }
  if (isFutureAssetType(instrument.assetType)) {
    if (instrument.market === 'OV_FUT') return getOverseasFutureQuote(instrument);
    return getDomesticFutureQuote(instrument);
  }
  if (instrument.country === 'KR') {
    const quote = await getQuote(instrument.providerSymbol);
    return { ...quote, code: instrument.id };
  }
  return getOverseasQuote(instrument);
}

async function getCommodityIndicatorCandles(instrument: Instrument): Promise<CandlesResponse> {
  const spec = COMMODITY_CANDLE_SPECS[instrument.id];
  if (!spec) return { code: instrument.id, name: instrument.name, candles: [] };
  try {
    const response = await getOverseasFutureDailyCandles({
      ...instrument,
      assetType: 'future',
      market: 'OV_FUT',
      provider: 'kis',
      providerSymbol: spec.providerSymbol,
      exchangeCode: spec.exchangeCode,
    });
    return { ...response, code: instrument.id, name: instrument.name };
  } catch {
    const quote = await fetchTradingViewQuote(instrument.providerSymbol);
    return {
      code: instrument.id,
      name: instrument.name,
      candles: [
        {
          time: todayUtcSeconds(),
          open: quote.open ?? quote.close,
          high: quote.high ?? quote.close,
          low: quote.low ?? quote.close,
          close: quote.close,
          volume: quote.volume ?? 0,
        },
      ],
    };
  }
}

async function getTradingViewInstrumentQuote(instrument: Instrument): Promise<Quote> {
  const quote = await fetchTradingViewQuote(instrument.providerSymbol);
  const price = quote.close;
  const { change, changeRate } = tradingViewChange(quote);
  return {
    code: instrument.id,
    fetchedAt: quote.fetchedAt,
    price,
    change,
    changeRate,
    sign: signFromChange(change),
    open: quote.open ?? price,
    high: quote.high ?? price,
    low: quote.low ?? price,
    accVolume: Number.isFinite(quote.volume ?? NaN) ? (quote.volume as number) : 0,
  };
}

async function getNightProxyQuote(instrument: Instrument): Promise<Quote> {
  const spec = NIGHT_PROXY_SPECS[instrument.id];
  if (!spec) {
    throw new Error(`지원하지 않는 야간 환산가입니다: ${instrument.id}`);
  }

  const [source, fx, regularQuote] = await Promise.all([
    fetchTradingViewQuote(spec.sourceSymbol),
    fetchTradingViewQuote(spec.fxSymbol),
    getQuote(spec.underlyingCode),
  ]);
  const price = convertGdrPrice(source.close, fx.close, spec.ratio);
  if (!Number.isFinite(price ?? NaN)) {
    throw new Error(`야간 환산가 계산에 실패했습니다: ${instrument.id}`);
  }

  const regularPrice = regularQuote.price;
  const change = Number(((price as number) - regularPrice).toFixed(2));
  const changeRate = regularPrice > 0 ? Number((change / regularPrice * 100).toFixed(2)) : 0;
  const open = convertGdrPrice(source.open, fx.close, spec.ratio) ?? (price as number);
  const high = convertGdrPrice(source.high, fx.close, spec.ratio) ?? (price as number);
  const low = convertGdrPrice(source.low, fx.close, spec.ratio) ?? (price as number);

  return {
    code: instrument.id,
    /*
     * 셋을 합쳐 만든 값이라 **가장 묵은 부분만큼 묵었다.** 셋을 나란히 부르므로
     * 실제 차이는 작지만, 한쪽이 늦거나 느려지면 그 사실이 여기로 드러나야 한다.
     */
    fetchedAt: Math.min(source.fetchedAt, fx.fetchedAt, regularQuote.fetchedAt),
    price: price as number,
    change,
    changeRate,
    sign: signFromChange(change),
    open,
    high,
    low,
    accVolume: Number.isFinite(source.volume ?? NaN) ? (source.volume as number) : 0,
  };
}

/** 국내 선물옵션 현재가 (선물옵션 시세, tr_id: FHMIF10000000). */
async function getDomesticFutureQuote(instrument: Instrument): Promise<Quote> {
  const json = await kisGet(
    '/uapi/domestic-futureoption/v1/quotations/inquire-price',
    'FHMIF10000000',
    {
      FID_COND_MRKT_DIV_CODE: instrument.exchangeCode || 'F',
      FID_INPUT_ISCD: instrument.providerSymbol,
    },
  );
  const fetchedAt = Date.now();
  const o = (json.output1 ?? {}) as Record<string, string>;
  return {
    code: instrument.id,
    fetchedAt,
    price: requireNumber(o.futs_prpr, 'futs_prpr'),
    change: requireNumber(o.futs_prdy_vrss, 'futs_prdy_vrss'),
    changeRate: requireNumber(o.futs_prdy_ctrt, 'futs_prdy_ctrt'),
    sign: parseSign(o.prdy_vrss_sign),
    open: requireNumber(o.futs_oprc, 'futs_oprc'),
    high: requireNumber(o.futs_hgpr, 'futs_hgpr'),
    low: requireNumber(o.futs_lwpr, 'futs_lwpr'),
    accVolume: requireNumber(o.acml_vol, 'acml_vol'),
  };
}

/** 해외선물 현재가 (해외선물종목현재가, tr_id: HHDFC55010000). */
async function getOverseasFutureQuote(instrument: Instrument): Promise<Quote> {
  const json = await kisGet(
    '/uapi/overseas-futureoption/v1/quotations/inquire-price',
    'HHDFC55010000',
    { SRS_CD: instrument.providerSymbol },
  );
  const fetchedAt = Date.now();
  const rows = json.output1;
  const o = (Array.isArray(rows) ? rows[0] : rows ?? {}) as Record<string, string>;
  return {
    code: instrument.id,
    fetchedAt,
    price: requireNumber(o.last_price, 'last_price'),
    change: requireNumber(o.prev_diff_price, 'prev_diff_price'),
    changeRate: requireNumber(o.prev_diff_rate, 'prev_diff_rate'),
    sign: parseSign(o.prev_diff_flag),
    open: requireNumber(o.open_price, 'open_price'),
    high: requireNumber(o.high_price, 'high_price'),
    low: requireNumber(o.low_price, 'low_price'),
    accVolume: requireNumber(o.vol, 'vol'),
  };
}

async function getDomesticFutureDailyCandles(
  instrument: Instrument,
  days: number,
): Promise<CandlesResponse> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - Math.ceil(days * 1.7));

  const json = await kisGet(
    '/uapi/domestic-futureoption/v1/quotations/inquire-daily-fuopchartprice',
    'FHKIF03020100',
    {
      FID_COND_MRKT_DIV_CODE: instrument.exchangeCode || 'F',
      FID_INPUT_ISCD: instrument.providerSymbol,
      FID_INPUT_DATE_1: yyyymmdd(start),
      FID_INPUT_DATE_2: yyyymmdd(end),
      FID_PERIOD_DIV_CODE: 'D',
    },
  );

  const output2 = (json.output2 ?? []) as Array<Record<string, string>>;
  const candles: Candle[] = output2
    .filter((r) => /^\d{8}$/.test(r.stck_bsop_date ?? ''))
    .map((r) => ({
      time: ymdToUtcSec(r.stck_bsop_date),
      open: toNumber(r.futs_oprc),
      high: toNumber(r.futs_hgpr),
      low: toNumber(r.futs_lwpr),
      close: toNumber(r.futs_prpr),
      volume: toNumber(r.acml_vol),
    }))
    .filter(isValidCandle)
    .sort((a, b) => a.time - b.time);

  return { code: instrument.id, name: instrument.name, candles };
}

async function getOverseasFutureDailyCandles(instrument: Instrument): Promise<CandlesResponse> {
  const json = await kisGet(
    '/uapi/overseas-futureoption/v1/quotations/daily-ccnl',
    'HHDFC55020100',
    {
      SRS_CD: instrument.providerSymbol,
      EXCH_CD: instrument.exchangeCode,
      START_DATE_TIME: '',
      CLOSE_DATE_TIME: yyyymmdd(new Date()),
      QRY_TP: 'Q',
      QRY_CNT: '40',
      QRY_GAP: '',
      INDEX_KEY: '',
    },
  );

  const output2 = (json.output2 ?? []) as Array<Record<string, string>>;
  const candles: Candle[] = output2
    .filter((r) => /^\d{8}$/.test(r.data_date ?? ''))
    .map((r) => ({
      time: ymdToUtcSec(r.data_date),
      open: toNumber(r.open_price),
      high: toNumber(r.high_price),
      low: toNumber(r.low_price),
      close: toNumber(r.last_price),
      volume: toNumber(r.vol),
    }))
    .filter(isValidCandle)
    .sort((a, b) => a.time - b.time);

  return { code: instrument.id, name: instrument.name, candles };
}

export async function getKisDomesticAccountSnapshot(
  account: KisAccountConfig | null,
): Promise<BrokerAccountSnapshot> {
  if (!account) {
    return {
      broker: 'kis',
      configured: false,
      accountId: '',
      accountLabel: 'KIS 계좌 미설정',
      baseCurrency: 'KRW',
      positions: [],
      message: MISSING_ACCOUNT_MESSAGE,
    };
  }

  const trId = config.env === 'prod' ? 'TTTC8434R' : 'VTTC8434R';
  const { rows, summary } = await kisPages(
    account,
    '/uapi/domestic-stock/v1/trading/inquire-balance',
    trId,
    {
      CANO: account.cano,
      ACNT_PRDT_CD: account.productCode,
      AFHR_FLPR_YN: 'N',
      OFL_YN: '',
      INQR_DVSN: '01',
      UNPR_DVSN: '01',
      FUND_STTL_ICLD_YN: 'N',
      FNCG_AMT_AUTO_RDPT_YN: 'N',
      PRCS_DVSN: '00',
    },
    '주식잔고조회',
  );
  const positions = rows.map(rowToBrokerPosition).filter((position) => position.quantity > 0);

  return {
    broker: 'kis',
    configured: true,
    accountId: account.id,
    accountLabel: `${account.label} · ${maskKisAccount(account.cano, account.productCode)}`,
    baseCurrency: 'KRW',
    ...accountTotalsFrom(summary),
    positions,
    updatedAt: Date.now(),
  };
}

/** 주식잔고조회 output2(계좌 합계 한 줄)에서 뽑는 값들. */
type AccountTotals = Pick<
  BrokerAccountSnapshot,
  | 'cashBalance'
  | 'settlementCash'
  | 'totalEvaluation'
  | 'stockEvaluation'
  | 'purchaseAmount'
  | 'unrealizedPnl'
  | 'unrealizedPnlRate'
  | 'assetChangeRate'
>;

/**
 * 주식잔고조회 output2(계좌 합계)를 정규화한다.
 *
 * ── 평가손익률은 **여기서 계산한다** (2026-08-12) ──────────────────────────
 *
 * output2에는 "매입 대비 평가손익률" 칸이 없다. 예전에는 그 자리에
 * `asst_icdc_erng_rt`(자산증감수익률)를 담고 `unrealizedPnlRate`라고 불렀는데,
 * 그건 **전일 총자산 대비 오늘 자산이 얼마나 변했나**라 다른 값이다.
 *
 *   자산증감수익률 0.17474202 = (96,154,944 − 95,987,214) / 95,987,214
 *   실제 평가손익률 +0.1769%  = 84,570 / 47,797,070
 *
 * 그날은 둘 다 ~0.17%라 안 들켰다. **개장 전에는 자산이 안 움직여 0으로 오므로**
 * 그대로 쓰면 평가손익률이 −0.174%인 동안 화면이 `0%`라고 적는다.
 *
 * 자산증감수익률도 버리지 않는다 — 이름을 사실대로 붙여 `assetChangeRate`로 낸다.
 *
 * 순수 함수로 떼어 둔 이유는 시험이다. 실계좌 상태(개장 전·보유 없음)를 화면으로
 * 만들어 낼 수 없어서, KIS가 실제로 준 행을 넣고 경계를 못 박는다.
 */
export function accountTotalsFrom(summary: Record<string, string>): AccountTotals {
  const purchaseAmount = firstNumber(summary, ['pchs_amt_smtl_amt']);
  const unrealizedPnl = firstNumber(summary, ['evlu_pfls_smtl_amt']);
  return {
    cashBalance: firstNumber(summary, ['dnca_tot_amt', 'nxdy_excc_amt']) ?? 0,
    /*
     * 결제 기준 현금. D+2(`prvs_rcdl_excc_amt`)가 오늘 낸 주문까지 반영한 값이고,
     * 없으면 D+1(`nxdy_excc_amt`)로 내려간다. **둘 다 없으면 `undefined`로 둔다** —
     * 여기서 `dnca_tot_amt`로 떨어뜨리면 오늘 산 것이 안 빠진 값이 "쓸 수 있는 돈"인
     * 척하게 되고, 그게 정확히 이 필드를 만든 이유다.
     */
    settlementCash: firstNumber(summary, ['prvs_rcdl_excc_amt', 'nxdy_excc_amt']),
    totalEvaluation: firstNumber(summary, ['tot_evlu_amt']),
    stockEvaluation: firstNumber(summary, ['scts_evlu_amt']),
    purchaseAmount,
    unrealizedPnl,
    unrealizedPnlRate: unrealizedPnlRateOf(unrealizedPnl, purchaseAmount),
    assetChangeRate: firstNumber(summary, ['asst_icdc_erng_rt']),
  };
}

/**
 * 국내주식 매수가능 조회 (tr_id: TTTC8908R 실전 / VTTC8908R 모의).
 *
 * KIS는 주문구분에 따라 계산 근거가 달라진다.
 * - 시장가: ORD_DVSN='01' + ORD_UNPR='0'. 단가를 넣으면 응답이 왜곡된다.
 * - 지정가: ORD_DVSN='00' + 실제 단가. 단가가 없으면 수량이 0으로 내려온다.
 *
 * `nrcvb_*`는 미수(외상) 없는 값, `max_*`는 미수를 포함한 값이라 서로 다르다.
 * 주문 게이트는 보수적으로 미수 없는 값을 기준 삼도록 둘 다 노출한다.
 */
/**
 * 주문구분 코드(`ORD_DVSN`)가 이 계좌에서 받아들여지는지 **주문 없이** 확인한다.
 *
 * 시간외 매도를 만들려면 그 코드를 알아야 하는데, 이 레포가 실측으로 아는 것은
 * `00`(지정가)·`01`(시장가) 둘뿐이다. 공식 GitHub 예제는 값을 열거하지 않고,
 * 웹 검색으로 나오는 표는 옛 eFriend API 것이라 **이 레포가 검증한 값과 어긋난다**
 * (그 표는 `02`를 지정가라 하는데 우리는 `00`이 지정가인 것을 실주문으로 확인했다).
 *
 * 매수가능조회는 `ORD_DVSN`을 인자로 받는 **조회**다. 모르는 코드를 넣었을 때
 * 거절하면 그 코드는 없는 것이고, 정상 응답하면 적어도 그 자리에서는 유효하다.
 *
 * **알 수 있는 것**: 그 코드가 존재하는가.
 * **알 수 없는 것**: 그 코드로 지금 주문이 나가는가 — 시간대·종목 상태에 따라
 * 주문은 따로 거절될 수 있고 그건 실제 주문으로만 확인된다.
 */
/**
 * **이 TR이 이 서버에서 도는가.** 응답 내용이 아니라 **되는지 여부**만 답한다.
 *
 * ── 왜 (2026-09-10) ──────────────────────────────────────────────────────
 *
 * 상품을 넓힐 때(해외주식·선물옵션) 가장 먼저 답해야 하는 것이 *"모의에서
 * 되는가"*다. 이 레포는 그것을 **나중에 알아서** 두 번 크게 헛돌았다 —
 * 스톱지정가(`ORD_DVSN=22`)는 코드를 다 짜고 시험 631개를 통과시킨 뒤에야 모의가
 * 거절한다는 것을 알았고, 개장일 조회(`chk-holiday`)는 리스크 룰이 늘 보류로
 * 막히고 나서야 원인을 찾았다.
 *
 * ★ **주문을 쏘지 않는다.** 조회 TR만 보내고, 그 응답으로 세 가지를 가른다:
 *
 *     ok           rt_cd = 0 — 이 서버에서 돈다
 *     trNotOnVts   EGW02006 — 그 TR이 모의 서버에 없다(기능이 없는 것)
 *     그 밖        오류 코드와 KIS가 한 말을 그대로 남긴다
 *
 * ★ **"TR ID를 잘못 적은 것"과 "모의에 없는 것"은 다르다.** 앞은 KIS가 다른
 *   코드로 답하므로 `code`를 함께 돌려준다 — 그것을 안 보면 오타를 "미지원"으로
 *   기록하게 된다.
 */
export async function probeKisTr(
  account: KisAccountConfig,
  path: string,
  trId: string,
  params: Record<string, string>,
): Promise<{
  ok: boolean; kind: KisErrorKind | null; code: string; message: string;
  /** 성공했을 때의 원본 응답. **탐침이 값도 보게** 한다 — 되는 것과 값이 있는 것은 다르다 */
  body?: Record<string, unknown>;
}> {
  try {
    const { body } = await kisGetWithHeaders(path, trId, params, '', toCredentials(account));
    const record = body as Record<string, unknown>;
    const code = kisErrorCodeOf(body);
    return {
      ok: String(record.rt_cd ?? '') === '0',
      kind: kisErrorKind(code),
      code,
      message: String(record.msg1 ?? '').trim(),
      body: record,
    };
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    // KIS가 한 말만 뽑는다. 본문 전체를 두면 표로 못 읽는다.
    const code = /"msg_cd":"([^"]*)"/.exec(text)?.[1] ?? '';
    return {
      ok: false,
      kind: kisErrorKind(code),
      code,
      message: /"msg1":"([^"]*)"/.exec(text)?.[1] ?? text.slice(0, 90),
    };
  }
}

export async function probeOrderDivision(
  account: KisAccountConfig,
  symbol: string,
  orderDivision: string,
  price: number,
): Promise<{ accepted: boolean; message: string }> {
  const trId = config.env === 'prod' ? 'TTTC8908R' : 'VTTC8908R';
  try {
    const { body } = await kisGetWithHeaders(
      '/uapi/domestic-stock/v1/trading/inquire-psbl-order',
      trId,
      {
        CANO: account.cano,
        ACNT_PRDT_CD: account.productCode,
        PDNO: symbol,
        // 시장가만 단가를 비운다. 지정가 계열은 단가가 없으면 수량이 0으로 내려온다.
        ORD_UNPR: orderDivision === '01' ? '0' : String(Math.floor(price)),
        ORD_DVSN: orderDivision,
        CMA_EVLU_AMT_ICLD_YN: 'N',
        OVRS_ICLD_YN: 'N',
      },
      '',
      toCredentials(account),
    );
    const record = body as Record<string, unknown>;
    return {
      accepted: String(record.rt_cd ?? '') === '0',
      message: String(record.msg1 ?? '').trim(),
    };
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    // KIS가 한 말만 뽑는다. 본문 전체를 그대로 두면 한 줄로 못 읽는다.
    return { accepted: false, message: /"msg1":"([^"]*)"/.exec(text)?.[1] ?? text.slice(0, 80) };
  }
}

export async function getKisDomesticOrderability(
  account: KisAccountConfig | null,
  symbol: string,
  orderType: OrderType,
  price: number,
): Promise<BrokerOrderability> {
  const requestedPrice = orderType === 'limit' && isPositiveFinite(price) ? Math.floor(price) : 0;

  if (!account) {
    return {
      broker: 'kis',
      configured: false,
      accountId: '',
      symbol,
      currency: 'KRW',
      orderType,
      requestedPrice,
      message: MISSING_ACCOUNT_MESSAGE,
    };
  }

  const trId = config.env === 'prod' ? 'TTTC8908R' : 'VTTC8908R';
  const { body } = await kisGetWithHeaders(
    '/uapi/domestic-stock/v1/trading/inquire-psbl-order',
    trId,
    {
      CANO: account.cano,
      ACNT_PRDT_CD: account.productCode,
      PDNO: symbol,
      ORD_UNPR: String(requestedPrice),
      ORD_DVSN: orderType === 'limit' ? '00' : '01',
      CMA_EVLU_AMT_ICLD_YN: 'N',
      OVRS_ICLD_YN: 'N',
    },
    '',
    toCredentials(account),
  );

  assertRtOk(body, '매수가능조회');

  const output = (body.output ?? {}) as Record<string, string>;
  return {
    broker: 'kis',
    configured: true,
    accountId: account.id,
    symbol,
    currency: 'KRW',
    orderType,
    requestedPrice,
    cashAvailable: firstNumber(output, ['ord_psbl_cash']),
    reusableAmount: firstNumber(output, ['ruse_psbl_amt']),
    cashBuyAmount: firstNumber(output, ['nrcvb_buy_amt']),
    cashBuyQuantity: firstNumber(output, ['nrcvb_buy_qty']),
    maxBuyAmount: firstNumber(output, ['max_buy_amt']),
    maxBuyQuantity: firstNumber(output, ['max_buy_qty']),
    calculatedUnitPrice: firstNumber(output, ['psbl_qty_calc_unpr']),
    fetchedAt: Date.now(),
  };
}

/** KIS 체결 진행 상태를 감사용 상태로 정규화한다. 취소·거부도 기록으로 남긴다. */
function toBrokerExecutionStatus(row: Record<string, string>): BrokerExecutionStatus {
  if (row.cncl_yn === 'Y') return 'canceled';

  const orderQuantity = optionalNumber(row.ord_qty) ?? 0;
  const filledQuantity = optionalNumber(row.tot_ccld_qty) ?? 0;
  const rejectedQuantity = optionalNumber(row.rjct_qty) ?? 0;

  if (rejectedQuantity > 0 && filledQuantity === 0) return 'rejected';
  if (filledQuantity > 0 && filledQuantity >= orderQuantity) return 'filled';
  if (filledQuantity > 0) return 'partial';
  return 'open';
}

function rowToBrokerExecution(row: Record<string, string>, index: number): BrokerExecution {
  const orderNo = row.odno ?? '';
  const orderDate = row.ord_dt ?? '';
  // 정정·취소가 아닌 주문의 원주문번호는 전부 0으로 채워져 내려온다. 값 자체는 자르지 않는다.
  const originalOrderNo = row.orgn_odno ?? '';

  return {
    id: `${orderDate}-${orderNo}-${index}`,
    orderNo,
    originalOrderNo: /^0*$/.test(originalOrderNo) ? undefined : originalOrderNo,
    orderDate,
    orderTime: /^\d{6}$/.test(row.ord_tmd ?? '') ? row.ord_tmd : undefined,
    symbol: row.pdno ?? '',
    name: row.prdt_name ?? row.pdno ?? '',
    // 매도매수구분코드: 01=매도, 02=매수
    side: row.sll_buy_dvsn_cd === '01' ? 'sell' : 'buy',
    orderTypeLabel: row.ord_dvsn_name ?? '',
    orderQuantity: optionalNumber(row.ord_qty) ?? 0,
    orderPrice: optionalNumber(row.ord_unpr) ?? 0,
    filledQuantity: optionalNumber(row.tot_ccld_qty) ?? 0,
    filledAmount: optionalNumber(row.tot_ccld_amt) ?? 0,
    // avg_prvs는 체결 평균가다. 미체결이면 0으로 내려온다.
    averageFilledPrice: optionalNumber(row.avg_prvs) ?? 0,
    remainQuantity: optionalNumber(row.rmn_qty) ?? 0,
    rejectedQuantity: optionalNumber(row.rjct_qty) ?? 0,
    /*
     * ★ 정정·취소에 필요한 값. 2026-09-03에 담기 시작했다 — 모의 서버에
     *   정정취소가능주문조회가 없어 이 응답으로 미체결을 대신 읽기 때문이다.
     *   없으면 미체결이 **보이기만 하고 정정은 못 한다.**
     */
    orderBranchNo: row.ord_gno_brno || undefined,
    orderTypeCode: row.ord_dvsn_cd || undefined,
    status: toBrokerExecutionStatus(row),
    currency: 'KRW',
  };
}

/**
 * 국내주식 일별 주문체결 조회 (tr_id: TTTC8001R 실전 / VTTC8001R 모의).
 *
 * KIS는 3개월 이내만 이 tr_id로 조회할 수 있고, 응답이 페이지 단위라
 * tr_cont가 M/F인 동안 CTX_AREA_* 키를 물려 이어 받아야 한다.
 */
export async function getKisDomesticExecutions(
  account: KisAccountConfig | null,
  days = 30,
): Promise<BrokerExecutionSnapshot> {
  const to = kstToday();
  // KIS는 이 tr_id로 3개월 이내만 조회할 수 있어 상한을 90일로 자른다.
  const from = kstDaysAgo(Number.isFinite(days) ? Math.min(Math.max(Math.floor(days), 1), 90) : 30);

  if (!account) {
    return {
      broker: 'kis',
      configured: false,
      accountId: '',
      accountLabel: 'KIS 계좌 미설정',
      from,
      to,
      executions: [],
      message: MISSING_ACCOUNT_MESSAGE,
    };
  }

  // 3개월 이내 조회용 현행 tr_id. 구 TTTC8001R도 아직 응답하지만 문서상 현행은 이쪽이다.
  // 3개월 이전 구간은 CTSC9215R / VTSC9215R로 갈라진다.
  const trId = config.env === 'prod' ? 'TTTC0081R' : 'VTTC0081R';
  const { rows, summary } = await kisPages(
    account,
    '/uapi/domestic-stock/v1/trading/inquire-daily-ccld',
    trId,
    {
      CANO: account.cano,
      ACNT_PRDT_CD: account.productCode,
      INQR_STRT_DT: from,
      INQR_END_DT: to,
      SLL_BUY_DVSN_CD: '00',
      INQR_DVSN: '00',
      PDNO: '',
      CCLD_DVSN: '00',
      ORD_GNO_BRNO: '',
      ODNO: '',
      INQR_DVSN_3: '00',
      INQR_DVSN_1: '',
    },
    '주문체결조회',
  );
  // 행이 쪽 순서대로 이어 붙어 오므로 id 인덱스가 쪽을 넘어 누적된다.
  const executions = rows.map(rowToBrokerExecution);

  return {
    broker: 'kis',
    configured: true,
    accountId: account.id,
    accountLabel: `${account.label} · ${maskKisAccount(account.cano, account.productCode)}`,
    from,
    to,
    executions,
    totalOrderQuantity: firstNumber(summary, ['tot_ord_qty']),
    totalFilledQuantity: firstNumber(summary, ['tot_ccld_qty']),
    totalFilledAmount: firstNumber(summary, ['tot_ccld_amt']),
    updatedAt: Date.now(),
  };
}

/**
 * 국내주식 기간별 매매손익 조회 (tr_id: TTTC8715R, 모의투자 미지원).
 *
 * 체결내역(`inquire-daily-ccld`)과 달리 **매도로 확정된 실현손익**과 수수료·세금을 준다.
 * 합계(output2)는 브로커가 계산해 준 값을 그대로 쓴다. 우리가 다시 더하면 어긋난다.
 */
export async function getKisDomesticTradeProfit(
  account: KisAccountConfig | null,
  days = 30,
): Promise<BrokerTradeProfitSnapshot> {
  const to = kstToday();
  /*
   * `days = 0`이면 from = to = 오늘이라 **오늘 확정된 손익만** 나온다.
   *
   * 예전에는 하한이 1이라 아무리 좁혀도 어제부터였다 — 화면이 `오늘`이라고
   * 적으면서 어제 값을 섞어 보여줄 뻔했다. 체결내역·예약주문 쪽 하한 1은
   * 그대로 둔다. 상한이 90/365/90으로 다른 것처럼 각 API가 보는 것이 다르고,
   * 그쪽에는 "오늘만" 선택지가 없다.
   */
  const from = kstDaysAgo(Number.isFinite(days) ? Math.min(Math.max(Math.floor(days), 0), 365) : 30);

  if (!account) {
    return {
      broker: 'kis',
      configured: false,
      accountId: '',
      from,
      to,
      rows: [],
      message: MISSING_ACCOUNT_MESSAGE,
    };
  }

  const page = await kisPages(
    account,
    '/uapi/domestic-stock/v1/trading/inquire-period-trade-profit',
    'TTTC8715R',
    {
      CANO: account.cano,
      ACNT_PRDT_CD: account.productCode,
      SORT_DVSN: '00',
      INQR_STRT_DT: from,
      INQR_END_DT: to,
      CBLC_DVSN: '00',
      PDNO: '',
    },
    '기간별매매손익조회',
  );
  const summary = page.summary;
  const rows = page.rows.map((row, index): BrokerTradeProfitRow => ({
    id: `${row.trad_dt ?? ''}-${row.pdno ?? ''}-${index}`,
    tradeDate: row.trad_dt ?? '',
    symbol: row.pdno ?? '',
    name: row.prdt_name ?? row.pdno ?? '',
    tradeTypeLabel: row.trad_dvsn_name ?? '',
    sellQuantity: optionalNumber(row.sll_qty) ?? 0,
    sellPrice: optionalNumber(row.sll_pric) ?? 0,
    sellAmount: optionalNumber(row.sll_amt) ?? 0,
    buyQuantity: optionalNumber(row.buy_qty) ?? 0,
    buyPrice: optionalNumber(row.pchs_unpr) ?? 0,
    buyAmount: optionalNumber(row.buy_amt) ?? 0,
    realizedProfit: optionalNumber(row.rlzt_pfls) ?? 0,
    profitRate: optionalNumber(row.pfls_rt) ?? 0,
    fee: optionalNumber(row.fee) ?? 0,
    tax: optionalNumber(row.tl_tax) ?? 0,
    loanInterest: optionalNumber(row.loan_int) ?? 0,
    currency: 'KRW',
  }));

  return {
    broker: 'kis',
    configured: true,
    accountId: account.id,
    from,
    to,
    rows,
    totalRealizedProfit: firstNumber(summary, ['tot_rlzt_pfls']),
    totalProfitRate: firstNumber(summary, ['tot_pftrt']),
    totalFee: firstNumber(summary, ['tot_fee']),
    totalTax: firstNumber(summary, ['tot_tltx']),
    totalTradeAmount: firstNumber(summary, ['tot_tr_amt']),
    updatedAt: Date.now(),
  };
}

/**
 * 국내주식 예약주문 등록 (tr_id: CTSC0008U, 모의투자 미지원).
 *
 * **접수 가능 시간이 15:40 ~ 다음 영업일 07:30이다.** 장 마감 후에 다음 영업일 주문을
 * 미리 걸어두는 기능이라, 현금주문과 달리 장이 닫혀 있어도 접수된다.
 *
 * 등록 응답은 `RSVN_ORD_SEQ`(예약주문순번) 하나뿐이다. 취소에 필요한
 * `RSVN_ORD_ORGNO`는 등록·조회 어느 응답에도 없다(`cancelKisDomesticReservedOrder` 주석 참고).
 */
export async function placeKisDomesticReservedOrder(
  account: KisAccountConfig,
  params: {
    symbol: string;
    side: OrderSide;
    quantity: number;
    limitPrice: number;
    /** 예약 종료일자 YYYYMMDD. 생략하면 익영업일 1회만 */
    endDate?: string;
  },
): Promise<{ reservationSeq: string; message: string }> {
  const body = await kisPost(
    '/uapi/domestic-stock/v1/trading/order-resv',
    'CTSC0008U',
    {
      CANO: account.cano,
      ACNT_PRDT_CD: account.productCode,
      PDNO: params.symbol,
      ORD_QTY: String(Math.floor(params.quantity)),
      ORD_UNPR: String(Math.floor(params.limitPrice)),
      // 매도매수구분코드: 01 매도, 02 매수 (현금주문의 SLL_BUY_DVSN_CD와 같은 규약)
      SLL_BUY_DVSN_CD: params.side === 'sell' ? '01' : '02',
      ORD_DVSN_CD: '00', // 지정가
      ORD_OBJT_CBLC_DVSN_CD: '10', // 현금
      LOAN_DT: '',
      RSVN_ORD_END_DT: params.endDate ?? '',
      LDNG_DT: '',
    },
    toCredentials(account),
  );

  if (body.rt_cd !== '0') {
    throw new Error(`KIS 예약주문 등록 실패: ${String(body.msg1 ?? body.msg_cd ?? '알 수 없는 오류')}`);
  }

  const output = (body.output ?? {}) as Record<string, string>;
  return {
    reservationSeq: output.RSVN_ORD_SEQ ?? '',
    message: String(body.msg1 ?? '예약주문이 등록되었습니다.').trim(),
  };
}

/**
 * 국내주식 예약주문 취소 (tr_id: CTSC0009U, 모의투자 미지원).
 *
 * ⚠ `RSVN_ORD_ORGNO`(예약주문조직번호)가 필수인데 **등록 응답에도, 예약주문 조회 응답에도 없다.**
 * KIS 공식 예제조차 `"123"` / `"001"`처럼 서로 다른 임의값을 쓴다.
 * 그래서 호출부가 값을 넘길 수 있게 열어두고, 없으면 빈 값으로 보낸다.
 * **이 경로로 취소가 실패하면 KIS HTS/MTS 앱에서 직접 취소해야 한다.**
 */
export async function cancelKisDomesticReservedOrder(
  account: KisAccountConfig,
  params: { reservationSeq: string; reservationOrderDate: string; reservationOrgNo?: string },
): Promise<{ processed: boolean; message: string }> {
  const body = await kisPost(
    '/uapi/domestic-stock/v1/trading/order-resv-rvsecncl',
    'CTSC0009U',
    {
      CANO: account.cano,
      ACNT_PRDT_CD: account.productCode,
      RSVN_ORD_SEQ: params.reservationSeq,
      RSVN_ORD_ORGNO: params.reservationOrgNo ?? '',
      RSVN_ORD_ORD_DT: params.reservationOrderDate,
    },
    toCredentials(account),
  );

  if (body.rt_cd !== '0') {
    throw new Error(`KIS 예약주문 취소 실패: ${String(body.msg1 ?? body.msg_cd ?? '알 수 없는 오류')}`);
  }

  const output = (body.output ?? {}) as Record<string, string>;
  return {
    processed: output.nrml_prcs_yn === 'Y' || output.NRML_PRCS_YN === 'Y',
    message: String(body.msg1 ?? '예약주문 취소가 접수되었습니다.').trim(),
  };
}

/**
 * 개장일 판정 캐시. 같은 날짜를 주문마다 다시 묻지 않는다.
 *
 * 답이 계좌·서버와 무관한 시장 사실이라 날짜만으로 가른다. **성공만 담는다** —
 * 실패를 담으면 한 번의 일시적 오류가 그 프로세스가 사는 동안 계속 보류로 막는다.
 */
const marketOpenCache = new Map<string, boolean>();

/**
 * 국내 개장일 여부 (국내휴장일조회, tr_id: CTCA0903R).
 *
 * 시각만 보는 검증으로는 주말·공휴일 주문을 막지 못한다. KIS가
 * "장운영일자가 주문일과 상이합니다"로 거부하기 전에 우리가 먼저 걸러야 한다.
 * `opnd_yn`이 개장일 여부다(영업일 `bzdy_yn`과 다르다 — 영업일이어도 휴장일 수 있다).
 *
 * **이 TR은 모의 서버에 없다**(HTTP 500 + `EGW02006`). 그래서 모의 환경에서는
 * `KIS_OPEN_DAY_CREDENTIAL_ID`로 지정한 실전 자격증명·실전 도메인에 물어본다.
 * 개장일은 계좌와 무관한 시장 사실이라 답이 같다. 설정이 없으면 지금처럼 모의
 * 서버에 물어 실패하고, 리스크 룰이 보류로 막는다.
 *
 * ⚠ **이 우회는 조회 전용이다.** 여기서 쓰는 자격증명을 주문에 넘기면 안 된다
 * (`kisPost`가 한 겹 더 막는다).
 */
export async function isDomesticMarketOpenDay(date = kstToday()): Promise<boolean> {
  const cached = marketOpenCache.get(date);
  if (cached !== undefined) return cached;

  const lookup = config.marketOpenDay;
  const { body } = await kisGetWithHeaders(
    '/uapi/domestic-stock/v1/quotations/chk-holiday',
    'CTCA0903R',
    { BASS_DT: date, CTX_AREA_FK: '', CTX_AREA_NK: '' },
    '',
    /*
     * **짝 검사를 건너뛰는 유일한 조회다.** `CTCA0903R`은 서버로 이름이 갈리지 않고
     * 답도 계좌와 무관한 시장 사실이라, 이 실행이 모의여도 실전 서버에 물어 된다.
     * 다른 TR에 이 표시를 옮겨 붙이지 않는다 — 계좌 TR은 이름부터 갈린다.
     */
    { ...lookup.credentials, server: lookup.server, crossServerRead: true },
  );

  assertRtOk(body, '휴장일조회');

  const rows = Array.isArray(body.output) ? (body.output as Array<Record<string, string>>) : [];
  const today = rows.find((row) => row.bass_dt === date);
  if (!today) throw new Error(`KIS 휴장일조회에 ${date} 항목이 없습니다.`);

  const open = today.opnd_yn === 'Y';
  marketOpenCache.set(date, open);
  return open;
}

/**
 * 국내주식 정정취소가능주문 조회 (tr_id: TTTC0084R, 모의투자 미지원).
 * 정정·취소 전송에는 주문번호(odno)와 **주문채번지점번호(ord_gno_brno)** 가 함께 필요하다.
 */
/**
 * 모의 서버용 미체결 조회 — **일별 주문체결 조회로 대신한다.**
 *
 * 정정취소가능주문조회(`TTTC0084R`)가 모의에 없어서다. 오늘 낸 주문 중
 * `remainQuantity > 0`인 것이 곧 미체결이다.
 *
 * ★ 취소·거부된 주문은 남은 수량이 있어도 미체결이 아니다 — `rejectedQuantity`를
 *   빼고 본다. 2026-08-20에 취소된 주문이 미체결로 남아 판단자를 헛부를 뻔했다.
 */
async function amendableFromExecutions(account: KisAccountConfig): Promise<BrokerAmendableOrder[]> {
  const snapshot = await getKisDomesticExecutions(account);
  /*
   * ★★ **오늘 주문만이 미체결이다** (2026-09-03에 배웠다).
   *
   * 처음에 `remainQuantity > 0`을 전부 미체결로 봤다가 8/14 주문 둘이 나왔고,
   * **"3주 묵은 주문이 걸려 있다"고 잘못 결론냈다.** 정정·취소를 보내니 KIS가
   * *"모의투자 원주문번호가 존재하지 않습니다"*라고 답했다.
   *
   * 한국 주식 주문은 **당일 유효**다 — 안 붙으면 그날 15:30에 실효된다. 체결
   * 조회의 `status='open'`은 *"지금 살아 있다"*가 아니라 **"그 주문이 안 붙은
   * 채로 끝났다"**는 뜻이다. 감사 기록이라 지난 것도 그대로 남는다.
   *
   * ★ 이것을 안 거르면 **매일 지난 주문에 정정·취소를 쏘고 매번 실패한다.**
   */
  const today = kstToday();
  const out: BrokerAmendableOrder[] = [];
  for (const row of snapshot.executions) {
    if (row.orderDate !== today) continue;
    const remain = row.remainQuantity - (row.rejectedQuantity ?? 0);
    if (!(remain > 0)) continue;
    out.push({
      id: `${row.orderBranchNo ?? ''}-${row.orderNo}-${out.length}`,
      orderNo: row.orderNo,
      orderDate: row.orderDate,
      originalOrderNo: undefined,
      orderBranchNo: row.orderBranchNo ?? '',
      symbol: row.symbol,
      name: row.name,
      side: row.side,
      orderTypeLabel: row.orderTypeLabel ?? '',
      orderTypeCode: row.orderTypeCode ?? '00',
      orderQuantity: row.orderQuantity,
      orderPrice: row.orderPrice ?? 0,
      filledQuantity: row.filledQuantity,
      amendableQuantity: remain,
      orderTime: row.orderTime,
      currency: 'KRW',
    });
  }
  return out;
}

export async function getKisDomesticAmendableOrders(
  account: KisAccountConfig | null,
): Promise<BrokerAmendableOrder[]> {
  if (!account) return [];

  /*
   * ★★ **모의 서버에는 이 TR이 없다.** `VTTC0084R`로 바꿔 봤지만 *"없는 서비스
   *    코드"*가 온다(2026-09-03 실측) — 이름 문제가 아니라 **기능이 없는 것**이다
   *    (CLAUDE.md 7-2가 가르는 그 구분이다).
   *
   * 그래서 모의에서는 **일별 주문체결 조회**로 대신한다. 그 응답의
   * `remainQuantity`(미체결 수량)가 정정·취소 대상 수량이고, 정정에 필요한
   * `orderBranchNo`도 함께 온다.
   *
   * ★ 이것을 안 하면 판단자가 **미체결을 모르는 채로 판단한다** — 이미 낸 주문을
   *   또 낼 수 있다. 2026-09-03에 빠른 판단자가 스스로 그 위험을 적어 냈다:
   *   *"주문이 여러 건인 날 같은 오류가 나면 이 회차는 미체결을 모르는 채로
   *   판단하게 됩니다."*
   *
   * ★ 완전한 대체는 아니다 — 체결 조회는 **오늘 낸 주문**만 보므로 어제 걸어 둔
   *   미체결은 안 나온다. 다만 이 계좌는 장 마감에 미체결이 실효되므로
   *   (15:30 이후 주문을 안 낸다) 실질적으로 같다.
   */
  if (config.env !== 'prod') {
    return amendableFromExecutions(account);
  }

  const { rows } = await kisPages(
    account,
    '/uapi/domestic-stock/v1/trading/inquire-psbl-rvsecncl',
    'TTTC0084R',
    {
      CANO: account.cano,
      ACNT_PRDT_CD: account.productCode,
      // 조회구분1: 0 주문 / 1 종목, 조회구분2: 0 전체 / 1 매도 / 2 매수
      INQR_DVSN_1: '1',
      INQR_DVSN_2: '0',
    },
    '정정취소가능주문조회',
    'output',
  );

  return rows.map((row, index): BrokerAmendableOrder => ({
    id: `${row.ord_gno_brno ?? ''}-${row.odno ?? ''}-${index}`,
    orderNo: row.odno ?? '',
    orderDate: /^\d{8}$/.test(row.ord_dt ?? '') ? row.ord_dt : undefined,
    originalOrderNo: /^0*$/.test(row.orgn_odno ?? '') ? undefined : row.orgn_odno,
    orderBranchNo: row.ord_gno_brno ?? '',
    symbol: row.pdno ?? '',
    name: row.prdt_name ?? row.pdno ?? '',
    side: row.sll_buy_dvsn_cd === '01' ? 'sell' : 'buy',
    orderTypeLabel: row.ord_dvsn_name ?? '',
    orderTypeCode: row.ord_dvsn_cd ?? '00',
    orderQuantity: optionalNumber(row.ord_qty) ?? 0,
    orderPrice: optionalNumber(row.ord_unpr) ?? 0,
    filledQuantity: optionalNumber(row.tot_ccld_qty) ?? 0,
    // 이 응답에는 잔여수량(rmn_qty)이 없다. psbl_qty(가능수량)가 정정·취소 대상 수량이다.
    amendableQuantity: optionalNumber(row.psbl_qty) ?? 0,
    orderTime: /^\d{6}$/.test(row.ord_tmd ?? '') ? row.ord_tmd : undefined,
    currency: 'KRW',
  }));
}

/** 국내주식 예약주문 조회 (tr_id: CTSC0004R, 모의투자 미지원). */
export async function getKisDomesticReservedOrders(
  account: KisAccountConfig | null,
  days = 30,
): Promise<BrokerReservedOrder[]> {
  if (!account) return [];

  const { body } = await kisGetWithHeaders(
    '/uapi/domestic-stock/v1/trading/order-resv-ccnl',
    'CTSC0004R',
    {
      RSVN_ORD_ORD_DT: kstDaysAgo(Number.isFinite(days) ? Math.min(Math.max(Math.floor(days), 1), 90) : 30),
      RSVN_ORD_END_DT: kstToday(),
      TMNL_MDIA_KIND_CD: '00',
      CANO: account.cano,
      ACNT_PRDT_CD: account.productCode,
      PRCS_DVSN_CD: '0',
      CNCL_YN: '',
      RSVN_ORD_SEQ: '',
      PDNO: '',
      SLL_BUY_DVSN_CD: '',
    },
    '',
    toCredentials(account),
  );

  assertRtOk(body, '예약주문조회');

  // 예약주문 응답은 일반 주문과 필드명이 다르다.
  // 수량·단가에 rsvn 접두어가 붙고(ord_rsvn_qty / ord_rsvn_unpr), 종목명은 kor_item_shtn_name,
  // 취소 여부는 cncl_yn이 아니라 취소주문일자(cncl_ord_dt) 유무로 판단한다.
  const rows = Array.isArray(body.output) ? (body.output as Array<Record<string, string>>) : [];
  return rows.map((row, index) => ({
    id: `${row.rsvn_ord_seq ?? ''}-${index}`,
    reservationSeq: row.rsvn_ord_seq ?? '',
    orderDate: row.rsvn_ord_ord_dt || row.rsvn_ord_rcit_dt || '',
    endDate: row.rsvn_end_dt || undefined,
    symbol: row.pdno ?? '',
    name: row.kor_item_shtn_name ?? row.pdno ?? '',
    side: row.sll_buy_dvsn_cd === '01' ? 'sell' : 'buy',
    orderQuantity: optionalNumber(row.ord_rsvn_qty) ?? 0,
    orderPrice: optionalNumber(row.ord_rsvn_unpr) ?? 0,
    filledQuantity: optionalNumber(row.tot_ccld_qty) ?? 0,
    statusLabel: row.prcs_rslt || row.ord_dvsn_name || '',
    canceled: Boolean(row.cncl_ord_dt && !/^0*$/.test(row.cncl_ord_dt)),
    currency: 'KRW',
  }));
}

/**
 * 국내주식 현금 주문 전송 (tr_id: 실전 TTTC0012U 매수 / TTTC0011U 매도, 모의 VTTC0012U / VTTC0011U).
 *
 * 주의할 점:
 * - `EXCG_ID_DVSN_CD`(거래소ID구분코드)가 필수다. 국내 정규장은 'KRX'.
 * - 시장가는 `ORD_DVSN='01'` + `ORD_UNPR='0'`, 지정가는 `'00'` + 실제 단가.
 * - 스톱지정가는 `'22'` + `ORD_UNPR`(지정가) + `CNDT_PRIC`(스톱가). 셋이 다 있어야 한다.
 * - `SLL_TYPE`은 매도에만 쓴다(01 일반매도). 매수에는 빈 값을 넣는다.
 * - 응답 output의 `ODNO`(주문번호)와 `KRX_FWDG_ORD_ORGNO`(주문채번지점번호)를 반드시 보관해야
 *   이후 정정·취소를 보낼 수 있다.
 */
/**
 * **해외주식 주문을 보낸다.** 지정가만 보낸다.
 *
 * ── 2026-09-10에 생겼다 ──────────────────────────────────────────────────
 *
 * 사용자가 *"해외주식 먼저 하자"*고 정했고, **주문 코드를 쓰기 전에 조회로
 * 경계를 먼저 쟀다**(`scripts/probeOverseasStock.ts`). 모의에서 잔고·매수가능
 * 금액·미체결·체결기준잔고가 전부 돌고 외화 예수금도 있다는 것을 확인한 뒤에
 * 이 함수를 만들었다 — 순서를 지킨 것이 요점이다.
 *
 * ★ **TR과 본문은 `orderOverseas.ts`가 정한다.** 보내기 전에 던져야 하는 계산이라
 *   네트워크 없이 시험에 태울 수 있어야 한다(`orderCash.ts`와 같은 이유). 특히
 *   **미국 매도 모의 TR은 확인되지 않았다** — 공식 설명(`VTTT1001U`)과 공식
 *   코드(`VTTT1006U`)가 서로 다르다. 그래서 표를 규칙이 아니라 짝으로 두었다.
 *
 * ★ **서버 불일치는 `kisPost`가 막는다.** 국내 주문과 같은 경로이므로 실전
 *   자격증명이 모의 환경에서 주문 경로로 새는 일은 여기서도 일어나지 않는다.
 *
 * ★ 시장가는 만들지 않았다 — 시장마다 주문구분이 달라 아직 확인하지 않았다.
 */
export async function placeKisOverseasOrder(
  account: KisAccountConfig,
  params: {
    exchange: OverseasExchange;
    /** 해외 종목코드. 미국은 티커(`AAPL`) */
    symbol: string;
    side: OrderSide;
    quantity: number;
    /** 지정가. **필수다** — 시장가 경로가 없다 */
    limitPrice: number;
  },
): Promise<{ orderNo: string; orderBranchNo: string; acceptedAt: string; message: string }> {
  const trId = overseasOrderTr(params.exchange, params.side, config.env);
  const body = await kisPost(
    '/uapi/overseas-stock/v1/trading/order',
    trId,
    overseasOrderPayload({
      cano: account.cano,
      productCode: account.productCode,
      exchange: params.exchange,
      symbol: params.symbol,
      side: params.side,
      quantity: params.quantity,
      limitPrice: params.limitPrice,
    }),
    toCredentials(account),
  );

  if (body.rt_cd !== '0') {
    // 국내와 같은 이유로 **코드를 들고** 던진다 — 모의 미지원과 진짜 거절을 가른다.
    throw new KisRequestError(
      `KIS 해외주식 주문 전송 실패: ${String(body.msg1 ?? body.msg_cd ?? '알 수 없는 오류')}`
      + ` (${String(body.msg_cd ?? '코드 없음')})`,
      kisErrorCodeOf(body),
    );
  }

  /*
   * ★ 응답 필드는 국내와 같은 이름을 쓴다고 보고 읽되, **없으면 빈 문자열이다.**
   *   실제 접수 응답을 아직 못 봤으므로(주문을 쏘지 않았다) 여기서 값을
   *   지어내지 않는다 — 첫 주문 때 사람이 확인하고 다르면 고친다.
   */
  const output = (body.output ?? {}) as Record<string, string>;
  return {
    orderNo: output.ODNO ?? '',
    orderBranchNo: output.KRX_FWDG_ORD_ORGNO ?? '',
    acceptedAt: output.ORD_TMD ?? '',
    message: String(body.msg1 ?? '주문이 접수되었습니다.').trim(),
  };
}

export async function placeKisDomesticOrder(
  account: KisAccountConfig,
  params: {
    symbol: string;
    side: OrderSide;
    orderType: OrderType;
    quantity: number;
    limitPrice?: number;
    /**
     * 주문구분을 직접 정한다. 생략하면 `orderType`대로 지정가/시장가다.
     *
     * 시간외처럼 정규장 코드로는 못 내는 주문에 쓴다. **아직 확인되지 않은
     * 값이 올 수 있으므로**(`orderDivisions.ts`) 호출부가 그 사실을 기록에 남긴다.
     */
    orderDivision?: string;
    /**
     * 어느 거래소로 보낼지. 생략하면 `KRX` — **지금까지의 동작 그대로다.**
     *
     * ★ 모의 서버는 KRX만 받으므로 다른 값이면 `assertVenueUsable`이 **보내기 전에**
     * 던진다. 보낸 뒤 거절을 읽으면 "NXT를 못 쓴다"인지 "모의라서 안 되는 것"인지
     * 구분이 안 된다.
     */
    venue?: OrderVenue;
    /**
     * 스톱가(`CNDT_PRIC`). **`orderDivision`이 스톱지정가(`22`)일 때만** 넣는다.
     * 현재가가 이 값에 닿는 순간 `limitPrice`로 주문이 나가고, 그 감시는
     * 우리 서버가 아니라 거래소가 한다.
     *
     * ★ `22`인데 이 값이 없거나, `22`가 아닌데 이 값이 오면 **보내기 전에
     * 던진다**(`orderCash.ts`). 조용히 무시하면 손절을 걸었다고 믿는 주문이
     * 손절 없이 시장에 남는다.
     */
    conditionPrice?: number;
  },
): Promise<{ orderNo: string; orderBranchNo: string; acceptedAt: string; message: string }> {
  const venue = params.venue ?? DEFAULT_ORDER_VENUE;
  assertVenueUsable(venue);
  const isBuy = params.side === 'buy';
  const trId = config.env === 'prod' ? (isBuy ? 'TTTC0012U' : 'TTTC0011U') : isBuy ? 'VTTC0012U' : 'VTTC0011U';
  const isLimit = params.orderType === 'limit';
  const division =
    params.orderDivision
    ?? (isLimit ? CONFIRMED_ORDER_DIVISIONS.limit : CONFIRMED_ORDER_DIVISIONS.market);

  /*
   * 본문 조립과 값 검사는 `orderCash.ts`가 한다 — 보내기 전에 던져야 하는 계산이라
   * 네트워크 없이 시험에 태울 수 있어야 한다. 단가를 `'0'`으로 보내는 규칙,
   * 스톱지정가의 조건가격 검사가 전부 거기 있다.
   */
  const body = await kisPost(
    '/uapi/domestic-stock/v1/trading/order-cash',
    trId,
    orderCashPayload({
      cano: account.cano,
      productCode: account.productCode,
      symbol: params.symbol,
      side: params.side,
      division,
      quantity: params.quantity,
      limitPrice: params.limitPrice,
      venue,
      conditionPrice: params.conditionPrice,
    }),
    toCredentials(account),
  );

  if (body.rt_cd !== '0') {
    /*
     * **코드를 들고 던진다.** 호출부가 "모의 서버에 없는 기능"과 진짜 거절을
     * 갈라야 한다 — 앞은 재시도해도 같은 답이라 그만둬야 하고, 뒤는 사유가 다르다.
     */
    throw new KisRequestError(
      `KIS 주문 전송 실패: ${String(body.msg1 ?? body.msg_cd ?? '알 수 없는 오류')}`
      + ` (${String(body.msg_cd ?? '코드 없음')})`,
      kisErrorCodeOf(body),
    );
  }

  const output = (body.output ?? {}) as Record<string, string>;
  return {
    orderNo: output.ODNO ?? '',
    orderBranchNo: output.KRX_FWDG_ORD_ORGNO ?? '',
    acceptedAt: output.ORD_TMD ?? '',
    message: String(body.msg1 ?? '주문이 접수되었습니다.').trim(),
  };
}

/**
 * 국내주식 주문 정정·취소 (tr_id: 실전 TTTC0013U / 모의 VTTC0013U).
 *
 * - `RVSE_CNCL_DVSN_CD`: 01 정정, 02 취소.
 * - 취소는 단가를 보지 않으므로 `ORD_UNPR='0'`으로 보낸다.
 * - `QTY_ALL_ORD_YN='Y'`면 잔량 전부를 대상으로 하고 `ORD_QTY`는 무시된다.
 * - `ORD_DVSN`은 원주문의 주문구분 코드를 그대로 되돌려줘야 한다.
 */
export async function amendKisDomesticOrder(
  account: KisAccountConfig,
  params: {
    action: 'amend' | 'cancel';
    orderNo: string;
    orderBranchNo: string;
    orderTypeCode: string;
    quantity?: number;
    limitPrice?: number;
    quantityAll: boolean;
    /**
     * **원주문이 나간 거래소여야 한다.** 다른 곳으로 정정·취소를 보내면 그 주문을
     * 못 찾는다. 생략하면 `KRX` — 지금까지 모든 주문이 그리로 갔다.
     */
    venue?: OrderVenue;
  },
): Promise<{ orderNo: string; acceptedAt: string; message: string }> {
  const venue = params.venue ?? DEFAULT_ORDER_VENUE;
  assertVenueUsable(venue);
  const trId = config.env === 'prod' ? 'TTTC0013U' : 'VTTC0013U';
  const isCancel = params.action === 'cancel';

  const body = await kisPost(
    '/uapi/domestic-stock/v1/trading/order-rvsecncl',
    trId,
    {
      CANO: account.cano,
      ACNT_PRDT_CD: account.productCode,
      KRX_FWDG_ORD_ORGNO: params.orderBranchNo,
      ORGN_ODNO: params.orderNo,
      ORD_DVSN: params.orderTypeCode,
      RVSE_CNCL_DVSN_CD: isCancel ? '02' : '01',
      ORD_QTY: params.quantityAll ? '0' : String(Math.floor(params.quantity ?? 0)),
      ORD_UNPR: isCancel ? '0' : String(Math.floor(params.limitPrice ?? 0)),
      QTY_ALL_ORD_YN: params.quantityAll ? 'Y' : 'N',
      EXCG_ID_DVSN_CD: venue,
    },
    toCredentials(account),
  );

  if (body.rt_cd !== '0') {
    throw new Error(`KIS 주문 ${isCancel ? '취소' : '정정'} 실패: ${String(body.msg1 ?? body.msg_cd ?? '알 수 없는 오류')}`);
  }

  const output = (body.output ?? {}) as Record<string, string>;
  return {
    orderNo: output.ODNO ?? params.orderNo,
    acceptedAt: output.ORD_TMD ?? '',
    message: String(body.msg1 ?? '요청이 접수되었습니다.').trim(),
  };
}

export async function getInstrumentIntradayCandles(instrument: Instrument): Promise<CandlesResponse> {
  if (instrument.assetType === 'night_proxy' || instrument.assetType === 'commodity') {
    return { code: instrument.id, name: instrument.name, candles: [] };
  }
  if (instrument.country === 'KR') return getDomesticIntradayCandles(instrument);
  return getOverseasIntradayCandles(instrument);
}

export async function getInstrumentNews(instrument: Instrument): Promise<NewsItem[]> {
  if (instrument.assetType === 'night_proxy' || instrument.assetType === 'commodity') return [];
  if (instrument.country === 'KR') return getDomesticNews(instrument);
  return getOverseasNews(instrument);
}

/**
 * 이름 후보를 앞에서부터 훑어 **값이 있는 첫 칸**을 쓴다. 하나도 없으면 `undefined`.
 *
 * 빈 문자열은 값이 아니라 빈 칸이므로 다음 후보로 넘어간다 — `optionalNumber`가
 * 빈 문자열을 0으로 읽던 동안에는 **첫 후보가 비어 있어도 거기서 멈춰 0을 돌려줬다.**
 * `settlementCash`의 D+2 → D+1 대체가 그 때문에 동작하지 않았다.
 */
function firstNumber(row: Record<string, string>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = optionalNumber(row[key]);
    if (value !== null) return value;
  }
  return undefined;
}

function rowToBrokerPosition(row: Record<string, string>): BrokerPosition {
  return {
    symbol: row.pdno ?? '',
    name: row.prdt_name ?? row.prdt_name_abrv ?? row.pdno ?? '',
    quantity: optionalNumber(row.hldg_qty) ?? 0,
    averagePrice: optionalNumber(row.pchs_avg_pric) ?? 0,
    currentPrice: optionalNumber(row.prpr) ?? undefined,
    purchaseAmount: optionalNumber(row.pchs_amt) ?? undefined,
    marketValue: optionalNumber(row.evlu_amt) ?? undefined,
    unrealizedPnl: optionalNumber(row.evlu_pfls_amt) ?? undefined,
    unrealizedPnlRate: optionalNumber(row.evlu_pfls_rt) ?? undefined,
    currency: 'KRW',
  };
}

async function getDomesticNews(instrument: Instrument): Promise<NewsItem[]> {
  const json = await kisGet('/uapi/domestic-stock/v1/quotations/news-title', 'FHKST01011800', {
    FID_NEWS_OFER_ENTP_CODE: '',
    FID_COND_MRKT_CLS_CODE: '00',
    FID_INPUT_ISCD: instrument.providerSymbol,
    FID_TITL_CNTT: '',
    FID_INPUT_DATE_1: '',
    FID_INPUT_HOUR_1: '',
    FID_RANK_SORT_CLS_CODE: '01',
    FID_INPUT_SRNO: '',
  });
  const rows = (json.output ?? []) as Array<Record<string, string>>;
  return rows
    .map((row, index) => ({
      id: row.cntt_usiq_srno ?? `${instrument.id}-${row.data_dt ?? ''}-${row.data_tm ?? ''}-${index}`,
      title: row.hts_pbnt_titl_cntt ?? '',
      source: row.dorg || row.news_ofer_entp_code || 'KIS',
      publishedAt: optionalKstDateTimeToTimestamp(row.data_dt, row.data_tm),
      symbol: instrument.symbol,
    }))
    .filter((item) => item.title.length > 0)
    .slice(0, 20);
}

async function getOverseasNews(instrument: Instrument): Promise<NewsItem[]> {
  const nationCode = instrument.country === 'US' ? 'US' : instrument.country;
  const json = await kisGet('/uapi/overseas-price/v1/quotations/news-title', 'HHPSTH60100C1', {
    INFO_GB: '',
    CLASS_CD: '',
    NATION_CD: nationCode,
    EXCHANGE_CD: instrument.exchangeCode,
    SYMB: instrument.providerSymbol,
    DATA_DT: '',
    DATA_TM: '',
    CTS: '',
  });
  const rows = (json.outblock1 ?? []) as Array<Record<string, string>>;
  return rows
    .map((row, index) => ({
      id: row.news_key ?? `${instrument.id}-${row.data_dt ?? ''}-${row.data_tm ?? ''}-${index}`,
      title: row.title ?? '',
      source: row.source || row.class_name || 'KIS',
      publishedAt: optionalKstDateTimeToTimestamp(row.data_dt, row.data_tm),
      symbol: row.symb || instrument.symbol,
    }))
    .filter((item) => item.title.length > 0)
    .slice(0, 20);
}

async function getOverseasDailyCandles(
  instrument: Instrument,
  days: number,
): Promise<CandlesResponse> {
  const json = await kisGet('/uapi/overseas-price/v1/quotations/dailyprice', 'HHDFS76240000', {
    AUTH: '',
    EXCD: instrument.exchangeCode,
    SYMB: instrument.providerSymbol,
    GUBN: '0', // 0: 일봉
    BYMD: '',
    MODP: '1', // 1: 수정주가 반영
  });

  const output2 = (json.output2 ?? []) as Array<Record<string, string>>;
  const candles: Candle[] = output2
    .filter((r) => r.xymd)
    .map((r) => ({
      time: ymdToUtcSec(r.xymd),
      open: toNumber(r.open),
      high: toNumber(r.high),
      low: toNumber(r.low),
      close: toNumber(r.clos),
      volume: toNumber(r.tvol),
    }))
    .filter(isValidCandle)
    .sort((a, b) => a.time - b.time)
    .slice(-days);

  return { code: instrument.id, name: instrument.name, candles };
}

async function getOverseasQuote(instrument: Instrument): Promise<Quote> {
  const [priceJson, detailJson] = await Promise.all([
    kisGet('/uapi/overseas-price/v1/quotations/price', 'HHDFS00000300', {
      AUTH: '',
      EXCD: instrument.exchangeCode,
      SYMB: instrument.providerSymbol,
    }),
    kisGet('/uapi/overseas-price/v1/quotations/price-detail', 'HHDFS76200200', {
      AUTH: '',
      EXCD: instrument.exchangeCode,
      SYMB: instrument.providerSymbol,
    }),
  ]);
  // 둘을 나란히 부르므로 늦게 온 쪽이 이 시각이다. 값의 나이는 이보다 크다.
  const fetchedAt = Date.now();
  const priceOutput = (priceJson.output ?? {}) as Record<string, string>;
  const detailOutput = (detailJson.output ?? {}) as Record<string, string>;
  const price = requireNumber(priceOutput.last, 'last');
  return {
    code: instrument.id,
    fetchedAt,
    price,
    change: requireNumber(priceOutput.diff, 'diff'),
    changeRate: requireNumber(priceOutput.rate, 'rate'),
    sign: parseSign(priceOutput.sign),
    open: optionalNumber(detailOutput.open) ?? price,
    high: optionalNumber(detailOutput.high) ?? price,
    low: optionalNumber(detailOutput.low) ?? price,
    accVolume: optionalNumber(priceOutput.tvol) ?? optionalNumber(detailOutput.tvol) ?? 0,
  };
}
