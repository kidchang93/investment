import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';

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
 */

export interface KisCredentials {
  id: string;
  appKey: string;
  appSecret: string;
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

function cacheFile(credentialId: string): string {
  // 구버전 단일 계좌 캐시 파일명을 그대로 유지해 재발급을 피한다.
  const suffix = credentialId === 'default' ? '' : `-${credentialId}`;
  return resolve(process.cwd(), '.cache', `token-${config.env}${suffix}.json`);
}

async function readTokenCache(credentialId: string): Promise<TokenCache | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(cacheFile(credentialId), 'utf8')) as unknown;
    if (!isTokenCache(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeTokenCache(credentialId: string, cache: TokenCache): Promise<void> {
  await fs.mkdir(resolve(process.cwd(), '.cache'), { recursive: true });
  await fs.writeFile(cacheFile(credentialId), JSON.stringify(cache), 'utf8');
}

async function issueAccessToken(credentials: KisCredentials): Promise<string> {
  const res = await fetch(`${config.restBase}/oauth2/tokenP`, {
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
  await writeTokenCache(credentials.id, cache);
  return cache.accessToken;
}

export async function getAccessToken(credentials: KisCredentials = primaryCredentials): Promise<string> {
  const cached = await readTokenCache(credentials.id);
  // 만료 1분 전까지는 재사용
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const pending = inFlightTokens.get(credentials.id);
  if (pending) return pending;

  const issuing = issueAccessToken(credentials).finally(() => inFlightTokens.delete(credentials.id));
  inFlightTokens.set(credentials.id, issuing);
  return issuing;
}

export async function getApprovalKey(credentials: KisCredentials = primaryCredentials): Promise<string> {
  const cached = approvalKeys.get(credentials.id);
  if (cached) return cached;

  const res = await fetch(`${config.restBase}/oauth2/Approval`, {
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
  approvalKeys.set(credentials.id, json.approval_key);
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
