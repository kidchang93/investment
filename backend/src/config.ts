import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// 루트(.env) → backend/.env 순으로 로드 (루트 우선)
loadEnv({ path: resolve(process.cwd(), '../.env') });
loadEnv({ path: resolve(process.cwd(), '.env') });

const isProd = process.env.APP_ENV === 'prod';

function parsePort(raw: string | undefined): number {
  const port = Number(raw ?? 4000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT 값이 올바르지 않습니다: ${raw ?? ''}`);
  }
  return port;
}

function normalizeAccountValue(raw: string): string {
  return raw.replace(/[^0-9]/g, '');
}

function parseKisAccount(rawAccount: string | undefined, rawProductCode: string | undefined): {
  cano: string;
  productCode: string;
} | null {
  const account = normalizeAccountValue(rawAccount ?? '');
  const productCode = normalizeAccountValue(rawProductCode ?? '');
  if (account.length === 8 && productCode.length === 2) return { cano: account, productCode };
  if (account.length >= 10) return { cano: account.slice(0, 8), productCode: account.slice(8, 10) };
  return null;
}

const kisAccount = parseKisAccount(process.env.KIS_ACCOUNT_NO, process.env.KIS_ACCOUNT_PRODUCT_CODE);

export const config = {
  /** 'vts'(모의) | 'prod'(실전) */
  env: (isProd ? 'prod' : 'vts') as 'prod' | 'vts',
  appKey: process.env.KIS_APP_KEY ?? '',
  appSecret: process.env.KIS_APP_SECRET ?? '',
  /** REST 도메인 */
  restBase: isProd
    ? 'https://openapi.koreainvestment.com:9443'
    : 'https://openapivts.koreainvestment.com:29443',
  /** 실시간 WebSocket 도메인 */
  wsBase: isProd
    ? 'ws://ops.koreainvestment.com:21000'
    : 'ws://ops.koreainvestment.com:31000',
  port: parsePort(process.env.PORT),
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://kis:kis_local@localhost:55432/kis',
  kisAccount,
  /** 개인(P) / 법인(B). 개인 계정은 'P' */
  custType: 'P' as const,
} as const;

export function assertCredentials(): void {
  if (!config.appKey || !config.appSecret) {
    throw new Error(
      'KIS_APP_KEY / KIS_APP_SECRET가 설정되지 않았습니다. .env.example을 복사해 .env를 채워주세요.',
    );
  }
}
