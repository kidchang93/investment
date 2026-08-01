import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

// 루트(.env) → backend/.env 순으로 로드 (루트 우선)
loadEnv({ path: resolve(process.cwd(), '../.env') });
loadEnv({ path: resolve(process.cwd(), '.env') });

const isProd = process.env.APP_ENV === 'prod';

/** KIS 서버. 도메인도 계좌 TR_ID 접두어도 여기서 갈린다. */
export type KisServer = 'prod' | 'vts';

const env: KisServer = isProd ? 'prod' : 'vts';

/**
 * REST 도메인 표. **도메인을 다른 곳에서 짜지 않는다** — 분기는 이 표 하나뿐이다.
 */
const REST_BASES: Record<KisServer, string> = {
  prod: 'https://openapi.koreainvestment.com:9443',
  vts: 'https://openapivts.koreainvestment.com:29443',
};

export function restBaseFor(server: KisServer): string {
  return REST_BASES[server];
}

/** 로그·오류 문구에 쓰는 이름. 화면 용어를 따른다(`docs/CODE_STYLE.md`). */
const SERVER_LABELS: Record<KisServer, string> = {
  prod: '실전 서버',
  vts: '모의 서버',
};

export function kisServerLabel(server: KisServer): string {
  return SERVER_LABELS[server];
}

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
  /**
   * HTS 로그인 ID. 실시간 주문·체결 통보(H0STCNI0) 구독의 `tr_key`로 쓴다.
   * 종목코드가 아니라 사람의 로그인 ID다. 없으면 통보를 구독하지 않는다.
   */
  htsId?: string;
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

/** KIS 종합계좌번호(`CANO`)의 자릿수. 이보다 짧으면 무엇을 채울지 알 수 없다. */
const CANO_LENGTH = 8;

/**
 * 계좌번호 문자열에서 종합계좌번호와 상품코드를 뽑는다.
 * `12345678-01`처럼 통합 표기하거나, 8자리만 넣고 상품코드를 따로 줄 수 있다.
 *
 * **짧은 계좌번호를 채워 주지 않는다.** 7자리 계좌번호를 받았을 때 (그대로 ·
 * 왼쪽 0 채움 · 오른쪽 0 채움) × 상품코드 7가지 = **21개 조합을 KIS에 실제로
 * 물어봤고 전부 `INVALID_CHECK_ACNO`였다**(2026-08-01,
 * `probeAccountNumberForm.ts`). 무엇을 채워야 하는지 알 수 없다는 뜻이라,
 * 짐작해서 채우면 **틀린 계좌번호로 조회를 계속 시도하게 된다.**
 *
 * 대신 **왜 못 쓰는지 말한다**(`skippedKisAccounts`). 예전에는 이 자리에서 그냥
 * `null`을 돌려줘 계좌가 아무 말 없이 사라졌다.
 */
export function parseAccountNumber(
  rawAccount: string | undefined,
  rawProductCode: string | undefined,
): { cano: string; productCode: string } | null {
  const account = normalizeAccountValue(rawAccount);
  const productCode = normalizeAccountValue(rawProductCode);
  if (account.length >= 10) return { cano: account.slice(0, 8), productCode: account.slice(8, 10) };
  if (account.length === CANO_LENGTH) {
    return { cano: account, productCode: productCode.length === 2 ? productCode : DEFAULT_PRODUCT_CODE };
  }
  return null;
}

/**
 * 설정하려 했는데 못 쓴 계좌. **왜 빠졌는지**를 들고 있다.
 *
 * 예전에는 그냥 `continue`였다. 그래서 `KIS_VTS_ACCOUNT_NO`의 숫자가 7자리
 * (8도 10도 아님)였을 때 그 계좌가 **아무 말 없이 사라졌고**, 화면에는 나머지
 * 계좌만 떴다. 넣은 사람은 오타를 낸 줄 모르고 "왜 안 보이지"만 남는다.
 *
 * 자격증명이 아니라 **무엇이 모자란지**만 담는다 — 로그로 나가는 값이다.
 */
export interface SkippedKisAccount {
  id: string;
  reason: string;
}

const skippedKisAccounts: SkippedKisAccount[] = [];

/**
 * 계좌 하나를 가리키는 env 키를 뜯는다.
 *
 *   KIS_21_ACCOUNT_NO                  → 자격증명 21 · 계좌 id `21`
 *   KIS_VTS_ACCOUNT_ORDINARY_NO        → 자격증명 VTS · 계좌 id `VTS-ORDINARY`
 *   KIS_VTS_ACCOUNT_EXTRAORDINARY_NO   → 자격증명 VTS · 계좌 id `VTS-EXTRAORDINARY`
 *
 * **한 앱키에 계좌가 여럿일 수 있다.** KIS 모의투자가 그렇다 — 주식 계좌와
 * 선물옵션 계좌가 같은 앱키에 함께 등록된다. 예전에는 `KIS_<id>_ACCOUNT_NO`
 * 하나만 읽어서, 종류를 붙여 적은 계좌가 **정규식에 안 걸려 통째로 무시됐다.**
 * 그것도 아무 말 없이 — `skippedKisAccounts`에도 안 남았다.
 *
 * 앱키는 **종류를 뗀 쪽**(`credentialId`)에서 찾는다. 계좌마다 앱키를 따로 적게
 * 하면 같은 값을 두 번 쓰게 된다.
 */
export function parseAccountKey(key: string): { credentialId: string; accountId: string; kind?: string } | null {
  const plain = /^KIS_(.+)_ACCOUNT_NO$/.exec(key);
  if (plain) return { credentialId: plain[1], accountId: plain[1] };
  const kinded = /^KIS_(.+)_ACCOUNT_([A-Z]+)_NO$/.exec(key);
  if (kinded) {
    return { credentialId: kinded[1], accountId: `${kinded[1]}-${kinded[2]}`, kind: kinded[2] };
  }
  return null;
}

/** 계좌 종류의 화면 이름. 모르는 종류는 코드를 그대로 쓴다 — 지어내지 않는다. */
const ACCOUNT_KIND_LABELS: Record<string, string> = {
  ORDINARY: '주식',
  EXTRAORDINARY: '선물옵션',
};

/** 계좌번호 + 앱키 + 시크릿 3종이 모두 있어야 한 계좌로 인정한다. */
function parseKisAccounts(): KisAccountConfig[] {
  const accounts: KisAccountConfig[] = [];

  for (const key of Object.keys(process.env)) {
    const parsedKey = parseAccountKey(key);
    if (!parsedKey) continue;

    const { credentialId, accountId, kind } = parsedKey;
    const id = accountId;
    const parsed = parseAccountNumber(
      process.env[key],
      process.env[`KIS_${accountId}_ACCOUNT_PRODUCT_CODE`] ?? process.env[`KIS_${credentialId}_ACCOUNT_PRODUCT_CODE`],
    );
    const appKey = process.env[`KIS_APP_KEY_${credentialId}`] ?? '';
    const appSecret = process.env[`KIS_APP_SECRET_${credentialId}`] ?? '';

    if (!parsed) {
      /*
       * 자릿수를 적는다. 계좌번호 자체는 자격증명에 준하므로 값은 남기지 않는다 —
       * 몇 자리인지만 알면 무엇을 고쳐야 하는지 알 수 있다.
       */
      const digits = normalizeAccountValue(process.env[key]).length;
      skippedKisAccounts.push({
        id,
        reason:
          `${key}의 숫자가 ${digits}자리입니다.`
          + ' 8자리(종합계좌번호)이거나 10자리 이상(종합계좌번호 8 + 상품코드 2)이어야 합니다.',
      });
      continue;
    }
    if (!appKey || !appSecret) {
      const missing = [
        !appKey && `KIS_APP_KEY_${credentialId}`,
        !appSecret && `KIS_APP_SECRET_${credentialId}`,
      ]
        .filter(Boolean)
        .join(' · ');
      skippedKisAccounts.push({ id, reason: `${missing}가 없습니다.` });
      continue;
    }

    // HTS ID는 계좌별로 두되, 사람이 하나만 쓰는 경우가 흔해 전역값도 허용한다.
    const htsId = (
      process.env[`KIS_${accountId}_HTS_ID`]
      ?? process.env[`KIS_${credentialId}_HTS_ID`]
      ?? process.env.KIS_HTS_ID
      ?? ''
    ).trim();
    /*
     * 화면 이름에 종류를 한국어로 붙인다. `KIS VTS-ORDINARY`는 내부 식별자라
     * 읽는 사람이 무슨 계좌인지 알 수 없다(`docs/CODE_STYLE.md`).
     */
    const kindLabel = kind ? ` ${ACCOUNT_KIND_LABELS[kind] ?? kind}` : '';
    accounts.push({
      id,
      label: `KIS ${credentialId}${kindLabel}`,
      appKey,
      appSecret,
      htsId: htsId || undefined,
      ...parsed,
    });
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
      htsId: process.env.KIS_HTS_ID?.trim() || undefined,
      ...legacy,
    });
  }

  return accounts;
}

/**
 * 자격증명 id로 계좌를 찾는다.
 *
 * **정확히 일치하는 계좌를 먼저 보고, 없으면 그 자격증명을 쓰는 첫 계좌를 쓴다.**
 * 계좌에 종류가 붙으면 id가 `VTS-ORDINARY`가 되는데 사람은 `VTS`라고 적는 것이
 * 자연스럽다 — 고르는 것은 계좌가 아니라 **앱키**이고, 종류가 달라도 앱키는 같다.
 *
 * `KIS_PRIMARY_ACCOUNT_ID`와 `KIS_OPEN_DAY_CREDENTIAL_ID`가 같은 규칙을 쓴다.
 * 두 곳이 각자 들고 있으면 한쪽만 고쳐진다.
 */
export function findKisCredentialById<T extends { id: string }>(
  accounts: readonly T[],
  credentialId: string,
): T | undefined {
  return (
    accounts.find((account) => account.id === credentialId)
    ?? accounts.find((account) => account.id.startsWith(`${credentialId}-`))
  );
}

/** 계좌와 함께 다니지 않는, 앱키만 뽑은 묶음. */
export interface KisCredentialPair {
  id: string;
  appKey: string;
  appSecret: string;
}

/**
 * 시세·종목마스터·실시간 WS처럼 계좌와 무관한 호출에 쓸 기본 자격증명.
 * 호출 한도를 한 앱키에 모으려고 계좌를 바꿔도 이 값은 고정한다.
 */
function resolvePrimaryCredentials(accounts: KisAccountConfig[]): KisCredentialPair {
  const explicitId = process.env.KIS_PRIMARY_ACCOUNT_ID?.trim();
  /*
   * 이 값이 없으면 `KIS_PRIMARY_ACCOUNT_ID`가 조용히 무시되고 id 오름차순 첫 계좌가
   * 기본이 된다 — 실계좌 id가 숫자면 모의 환경인데 실계좌 앱키가 기본이 되어
   * 시세가 통째로 죽는다.
   */
  const chosen = (explicitId ? findKisCredentialById(accounts, explicitId) : undefined) ?? accounts[0];
  if (chosen) return { id: chosen.id, appKey: chosen.appKey, appSecret: chosen.appSecret };

  return {
    id: 'default',
    appKey: process.env.KIS_APP_KEY ?? '',
    appSecret: process.env.KIS_APP_SECRET ?? '',
  };
}

/**
 * 개장일 조회(`chk-holiday` / `CTCA0903R`)를 **어느 자격증명으로 어느 서버에** 물을지.
 *
 * **모의 서버에는 이 TR이 없다.** `APP_ENV=vts`로 물으면 HTTP 500 +
 * `EGW02006 모의투자 TR 이 아닙니다`가 온다(2026-08-01 실측). 조회가 실패하면
 * 리스크 룰이 "보류"로 막으므로 그대로 두면 **모의 환경에서는 리스크 룰을 통과하는
 * 주문이 존재할 수 없다** — 월요일 장중에도 똑같이 막힌다.
 *
 * 개장일은 계좌와 무관한 **시장 사실**이라 실전 서버에 물어도 답이 같다(2026-08-01
 * 실측: 20260731 `Y` · 20260801 `N` · 20260803 `Y`). 그래서
 * `KIS_OPEN_DAY_CREDENTIAL_ID`에 실전 자격증명 id를 주면 **이 조회 하나만** 그
 * 앱키로 실전 도메인에 보낸다.
 *
 * ⚠ **조회 전용이다. 주문에 절대 쓰지 않는다.** 이 자격증명이 주문 경로로 새면
 * 모의 환경인 줄 알고 실계좌에 주문이 나간다 — 이 레포에서 가장 위험한 실수라
 * `orderServerMismatch()`가 한 겹 더 막는다.
 *
 * 값이 없으면 **지금 동작 그대로**다(모의에서는 보류). 없는 설정을 추측해서 아무
 * 앱키나 쓰지 않는다. 실전 환경에서는 이 우회가 아예 동작하지 않는다 — 이미 실전
 * 서버에 붙어 있고 같은 TR이 그대로 동작한다.
 */
export interface MarketOpenDayLookup {
  credentials: KisCredentialPair;
  /** 이 조회를 보낼 서버 */
  server: KisServer;
  /** 모의 환경인데 실전 서버로 물어보는 중인가. 서버 시작 로그와 판정 사유가 이걸 적는다 */
  viaProdServer: boolean;
  /** 설정이 있는데 못 썼거나 쓸 자리가 아닌 이유. 조용히 무시하지 않는다 */
  problem: string | null;
}

export function resolveMarketOpenDayLookup(input: {
  env: KisServer;
  credentialId: string | undefined;
  accounts: readonly KisCredentialPair[];
  primary: KisCredentialPair;
}): MarketOpenDayLookup {
  const credentialId = input.credentialId?.trim() ?? '';
  const asIs: MarketOpenDayLookup = {
    credentials: input.primary,
    server: input.env,
    viaProdServer: false,
    problem: null,
  };

  // 실전 환경에서는 우회가 없다. 지금 경로 그대로 간다.
  if (input.env === 'prod') {
    if (!credentialId) return asIs;
    return {
      ...asIs,
      problem:
        'KIS_OPEN_DAY_CREDENTIAL_ID는 모의(APP_ENV=vts)에서만 씁니다.'
        + ' 실전에서는 이미 실전 서버에 붙어 있어 무시합니다.',
    };
  }

  if (!credentialId) return asIs;

  const found = findKisCredentialById(input.accounts, credentialId);
  if (!found) {
    return {
      ...asIs,
      problem:
        `KIS_OPEN_DAY_CREDENTIAL_ID에 적힌 자격증명을 찾지 못했습니다 (${credentialId}).`
        + ' 그 id로 KIS_APP_KEY_<id> · KIS_APP_SECRET_<id> · KIS_<id>_ACCOUNT_NO가 함께 있어야 합니다.',
    };
  }

  return {
    credentials: { id: found.id, appKey: found.appKey, appSecret: found.appSecret },
    server: 'prod',
    viaProdServer: true,
    problem: null,
  };
}

/**
 * 개장일을 확인하지 못했을 때 **무엇을 해야 하는지** 한 줄로 알려 준다. 할 말이 없으면 null.
 *
 * 이 말이 없으면 모의 환경에서는 `개장일을 확인할 수 없어 주문을 보류합니다`만 보이고,
 * 그게 설정 문제인지 KIS 장애인지 구별할 방법이 없다. 환경변수 이름은 운영자가 그대로
 * 입력해야 하는 값이라 화면에 영어로 나가도 된다(`docs/CODE_STYLE.md`).
 */
export function marketOpenDayHint(lookup: MarketOpenDayLookup): string | null {
  /*
   * 실전 서버로 나가는 조회는 이 설정과 무관하게 동작한다. 그런데도 실패했다면
   * 원인이 다른 데 있으므로, 여기서 설정 이야기를 꺼내면 엉뚱한 곳을 보게 만든다.
   */
  if (lookup.server !== 'vts') return null;
  if (lookup.problem) return lookup.problem;
  return (
    '모의 서버에는 개장일 조회가 없습니다.'
    + ' KIS_OPEN_DAY_CREDENTIAL_ID에 실전 자격증명 id를 넣으면 개장일만 실전 서버로 확인합니다.'
  );
}

/**
 * 주문 경로에 다른 서버의 자격증명이 섞였는지 본다. 어긋나면 사유, 맞으면 null.
 *
 * 개장일 조회용 실전 자격증명은 **조회 전용**이다. 이게 주문 POST로 새면 모의
 * 환경인 줄 알고 실계좌에 주문이 나간다. 코드 경로상 섞일 일이 없더라도 한 겹
 * 더 막아 둔다 — 되돌릴 수 없는 실수라서다.
 */
export function orderServerMismatch(credentialServer: KisServer, env: KisServer): string | null {
  if (credentialServer === env) return null;
  // 두 라벨이 모두 `서버`로 끝나 뒤에 붙는 조사가 갈리지 않는다. 라벨을 늘리면 다시 본다.
  return (
    `주문은 ${SERVER_LABELS[env]}로만 보냅니다.`
    + ` ${SERVER_LABELS[credentialServer]} 자격증명이 주문 경로에 들어왔습니다 — 조회 전용 자격증명은 주문에 쓸 수 없습니다.`
  );
}

const kisAccounts = parseKisAccounts();
const primary = resolvePrimaryCredentials(kisAccounts);

export const config = {
  /** 'vts'(모의) | 'prod'(실전) */
  env,
  /** 계좌 무관 호출용 기본 자격증명 */
  appKey: primary.appKey,
  appSecret: primary.appSecret,
  primaryCredentialId: primary.id,
  /** REST 도메인 */
  restBase: restBaseFor(env),
  /** 실시간 WebSocket 도메인 */
  wsBase: isProd
    ? 'ws://ops.koreainvestment.com:21000'
    : 'ws://ops.koreainvestment.com:31000',
  port: parsePort(process.env.PORT),
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://kis:kis_local@localhost:55432/kis',
  kisAccounts,
  /** 설정하려 했는데 못 쓴 계좌와 그 사유. 서버가 뜰 때 로그로 알린다 */
  skippedKisAccounts,
  /**
   * 개장일 조회를 어느 자격증명·어느 서버로 보낼지. **조회 전용이다** —
   * 주문에는 절대 쓰지 않는다(`resolveMarketOpenDayLookup` 주석 참고).
   */
  marketOpenDay: resolveMarketOpenDayLookup({
    env,
    credentialId: process.env.KIS_OPEN_DAY_CREDENTIAL_ID,
    accounts: kisAccounts,
    primary,
  }),
  /**
   * 실주문 전송 허용 여부. **기본값은 항상 false**다.
   * 명시적으로 `KIS_LIVE_ORDER_ENABLED=true`를 넣어야 열린다.
   */
  liveOrderEnabled: process.env.KIS_LIVE_ORDER_ENABLED === 'true',
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
