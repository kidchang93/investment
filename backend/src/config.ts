import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// 루트(.env) → backend/.env 순으로 로드 (루트 우선)
loadEnv({ path: resolve(process.cwd(), '../.env') });
loadEnv({ path: resolve(process.cwd(), '.env') });

const isProd = process.env.APP_ENV === 'prod';

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
  port: Number(process.env.PORT ?? 4000),
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
