import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// 루트(.env) → backend/.env 순으로 로드 (루트 우선)
loadEnv({ path: resolve(process.cwd(), '../.env') });
loadEnv({ path: resolve(process.cwd(), '.env') });

const isProd = process.env.APP_ENV === 'prod';

/** 상품코드가 따로 없을 때의 기본값. 개인 종합위탁계좌가 01이다. */
const DEFAULT_PRODUCT_CODE = '01';

/**
 * KIS 계좌 1개와 그 계좌를 조회할 수 있는 자격증명 묶음.
 *
 * KIS는 **앱키에 등록된 계좌만** 조회를 허용한다 (다른 계좌를 넣으면 `INVALID_CHECK_ACNO`).
 * 그래서 앱키/시크릿은 전역 값이 아니라 계좌와 반드시 함께 다녀야 한다.
 */
export interface KisAccountConfig {
  /** env 접미사에서 딴 식별자 (`KIS_21_ACCOUNT_NO` → `21`) */
  id: string;
  /** 화면용 이름. 계좌번호는 담지 않는다. */
  label: string;
  appKey: string;
  appSecret: string;
  /** 종합계좌번호 8자리 */
  cano: string;
  /** 상품코드 2자리 */
  productCode: string;
}

function parsePort(raw: string | undefined): number {
  const port = Number(raw ?? 4000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT 값이 올바르지 않습니다: ${raw ?? ''}`);
  }
  return port;
}

function normalizeAccountValue(raw: string | undefined): string {
  return (raw ?? '').replace(/[^0-9]/g, '');
}

/**
 * 계좌번호 문자열에서 종합계좌번호와 상품코드를 뽑는다.
 * `12345678-01`처럼 통합 표기하거나, 8자리만 넣고 상품코드를 따로 줄 수 있다.
 */
function parseAccountNumber(
  rawAccount: string | undefined,
  rawProductCode: string | undefined,
): { cano: string; productCode: string } | null {
  const account = normalizeAccountValue(rawAccount);
  const productCode = normalizeAccountValue(rawProductCode);
  if (account.length >= 10) return { cano: account.slice(0, 8), productCode: account.slice(8, 10) };
  if (account.length === 8) {
    return { cano: account, productCode: productCode.length === 2 ? productCode : DEFAULT_PRODUCT_CODE };
  }
  return null;
}

/** `KIS_<id>_ACCOUNT_NO` + `KIS_APP_KEY_<id>` + `KIS_APP_SECRET_<id>` 3종이 모두 있어야 한 계좌로 인정한다. */
function parseKisAccounts(): KisAccountConfig[] {
  const accounts: KisAccountConfig[] = [];

  for (const key of Object.keys(process.env)) {
    const match = /^KIS_(.+)_ACCOUNT_NO$/.exec(key);
    if (!match) continue;

    const id = match[1];
    const parsed = parseAccountNumber(process.env[key], process.env[`KIS_${id}_ACCOUNT_PRODUCT_CODE`]);
    const appKey = process.env[`KIS_APP_KEY_${id}`] ?? '';
    const appSecret = process.env[`KIS_APP_SECRET_${id}`] ?? '';
    if (!parsed || !appKey || !appSecret) continue;

    accounts.push({ id, label: `KIS ${id}`, appKey, appSecret, ...parsed });
  }

  // env 순회 순서에 의존하지 않도록 정렬한다. 기본 계좌가 실행마다 바뀌면 안 된다.
  accounts.sort((a, b) => a.id.localeCompare(b.id));

  // 접미사 없는 단일 계좌 설정(구버전)도 계속 지원한다.
  const legacy = parseAccountNumber(process.env.KIS_ACCOUNT_NO, process.env.KIS_ACCOUNT_PRODUCT_CODE);
  if (legacy && process.env.KIS_APP_KEY && process.env.KIS_APP_SECRET) {
    accounts.unshift({
      id: 'default',
      label: 'KIS 계좌',
      appKey: process.env.KIS_APP_KEY,
      appSecret: process.env.KIS_APP_SECRET,
      ...legacy,
    });
  }

  return accounts;
}

/**
 * 시세·종목마스터·실시간 WS처럼 계좌와 무관한 호출에 쓸 기본 자격증명.
 * 호출 한도를 한 앱키에 모으려고 계좌를 바꿔도 이 값은 고정한다.
 */
function resolvePrimaryCredentials(accounts: KisAccountConfig[]): {
  id: string;
  appKey: string;
  appSecret: string;
} {
  const explicitId = process.env.KIS_PRIMARY_ACCOUNT_ID?.trim();
  const chosen = (explicitId ? accounts.find((account) => account.id === explicitId) : undefined) ?? accounts[0];
  if (chosen) return { id: chosen.id, appKey: chosen.appKey, appSecret: chosen.appSecret };

  return {
    id: 'default',
    appKey: process.env.KIS_APP_KEY ?? '',
    appSecret: process.env.KIS_APP_SECRET ?? '',
  };
}

const kisAccounts = parseKisAccounts();
const primary = resolvePrimaryCredentials(kisAccounts);

export const config = {
  /** 'vts'(모의) | 'prod'(실전) */
  env: (isProd ? 'prod' : 'vts') as 'prod' | 'vts',
  /** 계좌 무관 호출용 기본 자격증명 */
  appKey: primary.appKey,
  appSecret: primary.appSecret,
  primaryCredentialId: primary.id,
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
  kisAccounts,
  /** 개인(P) / 법인(B). 개인 계정은 'P' */
  custType: 'P' as const,
} as const;

/** accountId 미지정이면 기본 계좌를 쓴다. 없는 id면 null. */
export function getKisAccount(accountId?: string): KisAccountConfig | null {
  if (!accountId) {
    return config.kisAccounts.find((account) => account.id === config.primaryCredentialId) ?? config.kisAccounts[0] ?? null;
  }
  return config.kisAccounts.find((account) => account.id === accountId) ?? null;
}

export function assertCredentials(): void {
  if (!config.appKey || !config.appSecret) {
    throw new Error(
      'KIS 자격증명이 설정되지 않았습니다. KIS_APP_KEY/KIS_APP_SECRET 또는 ' +
        '계좌별 KIS_APP_KEY_<id>/KIS_APP_SECRET_<id>/KIS_<id>_ACCOUNT_NO를 .env에 채워주세요.',
    );
  }
}
