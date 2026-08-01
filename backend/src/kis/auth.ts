import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { config, restBaseFor, type KisServer } from '../config.js';

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
   * 지금 이 값을 명시하는 곳은 개장일 조회 하나뿐이고 **조회 전용**이다.
   */
  server?: KisServer;
}

/** 이 자격증명이 붙는 서버. 안 적혀 있으면 그 실행의 기본 서버다. */
export function credentialServer(credentials: KisCredentials): KisServer {
  return credentials.server ?? config.env;
}

/** 계좌 무관 호출(시세·실시간)에 쓰는 기본 자격증명 */
export const primaryCredentials: KisCredentials = {
  id: config.primaryCredentialId,
  appKey: config.appKey,
  appSecret: config.appSecret,
};

interface TokenCache {
  accessToken: string;
  expiresAt: number; // epoch ms
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
    throw new Error(`토큰 발급 실패 (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  const cache: TokenCache = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 86_400) * 1000,
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
    throw new Error(`approval_key 발급 실패 (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { approval_key: string };
  approvalKeys.set(key, json.approval_key);
  return json.approval_key;
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
