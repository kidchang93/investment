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
 */

const CACHE_FILE = resolve(process.cwd(), '.cache', `token-${config.env}.json`);

interface TokenCache {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let approvalKey: string | null = null;

async function readTokenCache(): Promise<TokenCache | null> {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, 'utf8')) as TokenCache;
  } catch {
    return null;
  }
}

async function writeTokenCache(cache: TokenCache): Promise<void> {
  await fs.mkdir(resolve(process.cwd(), '.cache'), { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache), 'utf8');
}

export async function getAccessToken(): Promise<string> {
  const cached = await readTokenCache();
  // 만료 1분 전까지는 재사용
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const res = await fetch(`${config.restBase}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: config.appKey,
      appsecret: config.appSecret,
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
  await writeTokenCache(cache);
  return cache.accessToken;
}

export async function getApprovalKey(): Promise<string> {
  if (approvalKey) return approvalKey;

  const res = await fetch(`${config.restBase}/oauth2/Approval`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      appkey: config.appKey,
      secretkey: config.appSecret,
    }),
  });
  if (!res.ok) {
    throw new Error(`approval_key 발급 실패 (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { approval_key: string };
  approvalKey = json.approval_key;
  return approvalKey;
}
