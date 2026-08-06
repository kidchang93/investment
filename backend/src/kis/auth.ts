import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { config, restBaseFor, type KisServer } from '../config.js';
import { kisErrorSuffix } from './errorCodes.js';

/**
 * KIS 인증 토큰 관리.
 *
 * - access_token: REST 호출용. 유효기간 24h. 발급 횟수 제한이 있어 파일 캐시로 재사용한다.
 * - approval_key: 실시간 WebSocket 접속용. 프로세스 메모리에만 보관.
 *
 * 두 발급 엔드포인트는 시크릿 필드명이 다르다:
 *   /oauth2/tokenP    → appsecret
 *   /oauth2/Approval  → secretkey
 *
 * 계좌마다 앱키가 다르므로 토큰·approval_key는 **자격증명 id별로** 따로 캐시한다.
 * 한 캐시를 공유하면 다른 앱키의 토큰으로 호출해 계좌 조회가 조용히 실패한다.
 *
 * **캐시는 앱키만이 아니라 "어느 서버에서 받은 토큰인가"로도 갈린다.** 토큰은 발급받은
 * 서버에서만 통하는데, 개장일 조회는 모의 환경에서도 실전 서버에 붙는다
 * (`KIS_OPEN_DAY_CREDENTIAL_ID`). 파일 이름에 `config.env`를 박아 두면 실전 서버에서
 * 받은 토큰이 `token-vts-21.json`에 저장돼 **이름이 거짓말을 하고**, 나중에 같은 캐시를
 * 모의 도메인 호출이 재사용하면 모의 서버에 실전 토큰을 보내게 된다.
 */

export interface KisCredentials {
  id: string;
  appKey: string;
  appSecret: string;
  /**
   * 이 자격증명이 붙는 서버. 생략하면 `config.env`(= 그 실행의 기본 서버)다.
   *
   * 값은 두 곳에서 온다 — 사람이 적은 `KIS_<id>_SERVER`(계좌 자격증명)와, 개장일
   * 조회가 스스로 정하는 `'prod'`다. **코드는 앱키가 어느 서버용인지 알 수 없으므로**
   * 적히지 않은 것을 짐작하지 않는다.
   */
  server?: KisServer;
  /**
   * **이 실행의 기본 서버가 아닌 곳으로 일부러 보내는 조회인가.**
   *
   * 짝이 어긋난 자격증명은 조회도 막지만(`readServerMismatch`), 개장일
   * (`chk-holiday` / `CTCA0903R`)만은 예외다 — TR 이름이 서버로 갈리지 않고 답도
   * 계좌와 무관한 시장 사실이라 실전 서버에 물어도 같다. 그 하나를 위해 호출부가
   * 명시한다. **주문에는 쓰지 않는다** — 주문은 `orderServerMismatch`가 따로 막는다.
   */
  crossServerRead?: boolean;
}

/** 이 자격증명이 붙는 서버. 안 적혀 있으면 그 실행의 기본 서버다. */
export function credentialServer(credentials: KisCredentials): KisServer {
  return credentials.server ?? config.env;
}

/**
 * 계좌 무관 호출(시세·실시간)에 쓰는 기본 자격증명.
 *
 * 서버 표기(`KIS_<id>_SERVER`)를 그대로 들고 다닌다. 짝이 어긋나면 `assertCredentials`가
 * 서버를 못 뜨게 하므로, 여기 값이 `config.env`와 다른 채로 도는 일은 없다.
 */
export const primaryCredentials: KisCredentials = {
  id: config.primaryCredentialId,
  appKey: config.appKey,
  appSecret: config.appSecret,
  server: config.primaryCredentialServer,
};

interface TokenCache {
  accessToken: string;
  expiresAt: number; // epoch ms
  /**
   * 이 토큰을 받은 **앱키의 지문**. 앱키가 바뀌면 캐시를 버린다.
   *
   * 캐시 이름은 `token-{서버}-{자격증명 id}.json`이라 **id가 같고 앱키만 바뀌면
   * 같은 파일**이다. 그러면 옛 앱키로 받은 토큰을 새 앱키로 쓰게 되고 KIS가
   * `EGW00123 기간이 만료된 token 입니다`로 거부한다 — 실제로 겪었다(2026-08-01,
   * 모의 앱키를 계좌별로 나눠 넣었을 때). 만료가 아니라 **다른 앱키의 토큰**인데
   * 오류 문구가 만료라고 말해서 원인을 찾기 어렵다.
   *
   * **앱키 자체를 저장하지 않는다.** 자격증명이 파일에 남을 이유가 없다.
   * 지문이 없는 옛 캐시는 그대로 쓴다 — 버리면 멀쩡한 토큰을 재발급하게 되는데
   * 발급에는 횟수 제한이 있다(1일 1회 원칙).
   */
  appKeyFingerprint?: string;
}

const approvalKeys = new Map<string, string>();
/** 동시 요청이 토큰을 중복 발급하지 않도록 발급 중인 Promise를 공유한다. */
const inFlightTokens = new Map<string, Promise<string>>();

/**
 * 토큰 캐시 파일 이름. **서버와 자격증명 둘 다** 담는다.
 *
 * 구버전 단일 계좌(`default`)는 접미사 없이 `token-vts.json`이던 이름을 그대로 둔다 —
 * 바꾸면 멀쩡한 토큰을 버리고 다시 발급받게 되는데 발급에는 횟수 제한이 있다.
 * 메모리 캐시 키(`tokenCacheKey`)도 같은 두 축으로 갈린다.
 */
export function tokenCacheFileName(credentialId: string, server: KisServer): string {
  const suffix = credentialId === 'default' ? '' : `-${credentialId}`;
  return `token-${server}${suffix}.json`;
}

/** 발급 중 Promise·approval_key를 담는 메모리 캐시 키. 파일 이름과 같은 축으로 가른다. */
export function tokenCacheKey(credentialId: string, server: KisServer): string {
  return `${server}:${credentialId}`;
}

function cacheFile(credentials: KisCredentials): string {
  return resolve(process.cwd(), '.cache', tokenCacheFileName(credentials.id, credentialServer(credentials)));
}

async function readTokenCache(credentials: KisCredentials): Promise<TokenCache | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(cacheFile(credentials), 'utf8')) as unknown;
    if (!isTokenCache(parsed)) return null;
    if (!isSameAppKey(parsed, credentials.appKey)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeTokenCache(credentials: KisCredentials, cache: TokenCache): Promise<void> {
  await fs.mkdir(resolve(process.cwd(), '.cache'), { recursive: true });
  await fs.writeFile(cacheFile(credentials), JSON.stringify(cache), 'utf8');
}

async function issueAccessToken(credentials: KisCredentials): Promise<string> {
  const res = await fetch(`${restBaseFor(credentialServer(credentials))}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: credentials.appKey,
      appsecret: credentials.appSecret,
    }),
  });
  if (!res.ok) {
    /*
     * 짝이 어긋나면 여기서 먼저 드러난다 — 실전 앱키를 모의 서버에 보내면
     * `EGW02007`이 토큰 발급 단계에서 온다. 코드만 적으면 무슨 뜻인지 알 수 없으므로
     * 어느 쪽 앱키가 어느 서버에 갔는지까지 덧붙인다.
     */
    const text = await res.text();
    throw new Error(`토큰 발급 실패 (${res.status}): ${text}${kisErrorSuffix(text)}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  const cache: TokenCache = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 86_400) * 1000,
    appKeyFingerprint: appKeyFingerprint(credentials.appKey),
  };
  await writeTokenCache(credentials, cache);
  return cache.accessToken;
}

export async function getAccessToken(credentials: KisCredentials = primaryCredentials): Promise<string> {
  const cached = await readTokenCache(credentials);
  // 만료 1분 전까지는 재사용
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const key = tokenCacheKey(credentials.id, credentialServer(credentials));
  const pending = inFlightTokens.get(key);
  if (pending) return pending;

  const issuing = issueAccessToken(credentials).finally(() => inFlightTokens.delete(key));
  inFlightTokens.set(key, issuing);
  return issuing;
}

/**
 * 캐시를 버리고 **다시 발급받는다.** KIS가 `EGW00123`으로 거부했을 때만 부른다.
 *
 * ── 왜 필요한가 (2026-08-05 실측) ────────────────────────────────────────
 *
 * 캐시의 `expiresAt`이 아직 남았는데도 KIS가 *"기간이 만료된 token 입니다"*로
 * 거부하는 일이 있다. 같은 앱키로 **다른 곳에서 토큰을 새로 받으면 앞의 토큰이
 * 죽기** 때문이다 — 이 레포는 서버와 조사 스크립트가 같은 실전 앱키를 쓰고 있어
 * 조사 스크립트를 돌리는 것만으로 서버의 토큰이 죽는다.
 *
 * 그때 `getAccessToken`은 **여전히 캐시가 유효하다고 보고 죽은 토큰을 계속 준다.**
 * 무인 운용에서는 이게 조용한 정지다: 사람이 붙어 서버를 다시 띄울 때까지 모든
 * 조회가 실패하고, 리스크 룰이 개장일을 못 물어 매매가 통째로 보류된다.
 *
 * ★ **발급 횟수 제한이 있다.** 그래서 오류를 확인한 뒤 한 번만 부른다 —
 * 만료를 앞질러 미리 받거나, 실패할 때마다 반복해서 부르지 않는다.
 */
export async function reissueAccessToken(
  credentials: KisCredentials = primaryCredentials,
): Promise<string> {
  const key = tokenCacheKey(credentials.id, credentialServer(credentials));
  /*
   * 같은 순간에 여러 요청이 죽은 토큰으로 실패한다. 하나만 발급하고 나머지는
   * 그 결과를 기다리게 한다 — 안 그러면 한 번의 만료가 발급 수십 번이 된다.
   */
  const pending = inFlightTokens.get(key);
  if (pending) return pending;

  const issuing = issueAccessToken(credentials).finally(() => inFlightTokens.delete(key));
  inFlightTokens.set(key, issuing);
  return issuing;
}

export async function getApprovalKey(credentials: KisCredentials = primaryCredentials): Promise<string> {
  const key = tokenCacheKey(credentials.id, credentialServer(credentials));
  const cached = approvalKeys.get(key);
  if (cached) return cached;

  const res = await fetch(`${restBaseFor(credentialServer(credentials))}/oauth2/Approval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: credentials.appKey,
      secretkey: credentials.appSecret,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`approval_key 발급 실패 (${res.status}): ${text}${kisErrorSuffix(text)}`);
  }
  const json = (await res.json()) as { approval_key: string };
  approvalKeys.set(key, json.approval_key);
  return json.approval_key;
}

/**
 * 앱키의 지문. **앱키 자체는 어디에도 남기지 않는다.**
 *
 * 12자면 이 용도(같은 파일에 다른 앱키가 왔는지)에 충분하다 — 앱키를 되찾는 데
 * 쓰이는 값이 아니라 "바뀌었는가"만 가르는 값이다.
 */
export function appKeyFingerprint(appKey: string): string {
  return createHash('sha256').update(appKey).digest('hex').slice(0, 12);
}

/**
 * 캐시가 지금 앱키의 것인가.
 *
 * 지문이 없는 옛 캐시는 **통과시킨다.** 앱키가 그대로인 경우가 대부분이고,
 * 버리면 멀쩡한 토큰을 재발급하게 되는데 발급에는 횟수 제한이 있다.
 */
export function isSameAppKey(cache: { appKeyFingerprint?: string }, appKey: string): boolean {
  if (cache.appKeyFingerprint === undefined) return true;
  return cache.appKeyFingerprint === appKeyFingerprint(appKey);
}

function isTokenCache(value: unknown): value is TokenCache {
  if (!value || typeof value !== 'object') return false;
  const cache = value as Record<string, unknown>;
  return (
    typeof cache.accessToken === 'string' &&
    cache.accessToken.length > 0 &&
    typeof cache.expiresAt === 'number' &&
    Number.isFinite(cache.expiresAt)
  );
}
