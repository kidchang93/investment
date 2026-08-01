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

/**
 * `KIS_<id>_SERVER`에 적힌 값. **코드는 앱키가 어느 서버용인지 알 수 없다** —
 * KIS가 알려주지 않고 앱키 문자열에도 표시가 없다. 그래서 사람이 적을 수 있게 하고,
 * 적었으면 그것을 지킨다. 안 적었으면 지금처럼 `APP_ENV`로 추정한다(하위 호환).
 *
 * 적었는데 못 읽은 것을 **조용히 없는 것으로 보지 않는다.** 그러면 안전장치를 켰다고
 * 믿는 사람이 켜지지 않은 채로 돌게 된다 — 계좌가 아무 말 없이 사라졌던 전례와 같다.
 */
export interface DeclaredKisServer {
  /** 읽어낸 서버. 안 적었거나 못 읽으면 null */
  server: KisServer | null;
  /** 적었는데 못 읽은 이유. 환경변수 이름은 부르는 쪽이 앞에 붙인다 */
  problem: string | null;
}

export function parseDeclaredServer(raw: string | undefined): DeclaredKisServer {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return { server: null, problem: null };
  if (value === 'prod' || value === 'vts') return { server: value, problem: null };
  /*
   * 보간한 값 뒤에 조사를 붙이지 않는다(`docs/CODE_STYLE.md`). 적힌 값은 괄호로 뺀다.
   */
  return {
    server: null,
    problem: `값을 알아볼 수 없습니다 (${raw?.trim() ?? ''}). prod(실전 서버) 또는 vts(모의 서버)만 씁니다.`,
  };
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
  /**
   * 이 자격증명이 붙는 서버(`KIS_<id>_SERVER`). **사람이 적었을 때만 값이 있다** —
   * 없으면 `config.env`로 추정한다. 명시와 추정을 갈라 두는 이유는 시작 로그가
   * "적힌 것"과 "짐작한 것"을 구별해 말해야 하기 때문이다.
   */
  server?: KisServer;
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

/**
 * 앱키·시크릿을 찾을 env 이름 후보를 **찾을 순서대로** 만든다.
 *
 * **계좌마다 앱키가 다를 수 있다.** KIS 모의투자를 종류별로 따로 신청하면 앱키도
 * 계좌도 각각 나온다 — 그러면 공용 앱키(`KIS_APP_KEY_VTS`)가 **아예 없다.**
 * 반대로 한 신청에 계좌가 둘 딸려 오면 앱키는 하나다. 둘 다 되게 한다.
 *
 *   KIS_VTS_ACCOUNT_ORDINARY_NO 의 앱키를 찾는 순서
 *     1. KIS_APP_KEY_ORDINARY_VTS   ← 계좌별 앱키 (종류가 앞)
 *     2. KIS_APP_KEY_VTS_ORDINARY   ← 계좌별 앱키 (계좌 키와 같은 순서)
 *     3. KIS_APP_KEY_VTS            ← 공용 앱키
 *
 * 두 순서를 다 보는 이유는 계좌 키가 `<id>_ACCOUNT_<종류>_NO`라서 어느 쪽이
 * 자연스러운지 사람마다 다르게 읽기 때문이다. 실제로 갈렸다 — 계좌는
 * `VTS_ACCOUNT_ORDINARY_NO`인데 앱키는 `APP_KEY_ORDINARY_VTS`로 들어왔다.
 *
 * **계좌별 앱키가 먼저다.** 공용이 함께 있으면 더 구체적인 쪽이 이긴다.
 */
export function credentialEnvNames(prefix: string, credentialId: string, kind?: string): string[] {
  if (!kind) return [`${prefix}_${credentialId}`];
  return [`${prefix}_${kind}_${credentialId}`, `${prefix}_${credentialId}_${kind}`, `${prefix}_${credentialId}`];
}

/** 후보 이름을 순서대로 보고 **값이 있는 첫 번째**를 쓴다. 없으면 빈 문자열. */
function readCredentialEnv(prefix: string, credentialId: string, kind?: string): string {
  for (const name of credentialEnvNames(prefix, credentialId, kind)) {
    const value = process.env[name];
    if (value) return value;
  }
  return '';
}

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
    const appKey = readCredentialEnv('KIS_APP_KEY', credentialId, kind);
    const appSecret = readCredentialEnv('KIS_APP_SECRET', credentialId, kind);

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
      /*
       * **찾아본 이름을 전부 적는다.** 하나만 적으면 "그 이름으로 넣었는데 왜
       * 안 되지"가 남는다 — 실제로 앱키를 `KIS_APP_KEY_ORDINARY_VTS`로 넣었는데
       * 사유가 `KIS_APP_KEY_VTS가 없습니다`라고만 말한 적이 있다.
       */
      const missing = [
        !appKey && `KIS_APP_KEY (${credentialEnvNames('KIS_APP_KEY', credentialId, kind).join(' 또는 ')})`,
        !appSecret && `KIS_APP_SECRET (${credentialEnvNames('KIS_APP_SECRET', credentialId, kind).join(' 또는 ')})`,
      ]
        .filter(Boolean)
        .join(' · ');
      skippedKisAccounts.push({ id, reason: `${missing} 중 하나가 있어야 합니다.` });
      continue;
    }

    /*
     * 이 자격증명이 붙는 서버. 계좌별(`KIS_VTS-ORDINARY_SERVER`)을 먼저 보고
     * 자격증명별(`KIS_VTS_SERVER`)로 떨어진다 — 앱키가 자격증명 단위라 보통 뒤엣것을 쓴다.
     *
     * **적었는데 못 읽으면 그 계좌를 쓰지 않는다.** 이 값의 목적이 "짝이 어긋난 채로
     * 조용히 붙는 것"을 막는 것인데, 오타를 무시하고 추정으로 되돌아가면 켰다고 믿는
     * 안전장치가 꺼진 채로 돈다.
     */
    const serverEnvName =
      process.env[`KIS_${accountId}_SERVER`] !== undefined
        ? `KIS_${accountId}_SERVER`
        : `KIS_${credentialId}_SERVER`;
    const declaredServer = parseDeclaredServer(process.env[serverEnvName]);
    if (declaredServer.problem) {
      skippedKisAccounts.push({ id, reason: `${serverEnvName} ${declaredServer.problem}` });
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
      server: declaredServer.server ?? undefined,
      ...parsed,
    });
  }

  // env 순회 순서에 의존하지 않도록 정렬한다. 기본 계좌가 실행마다 바뀌면 안 된다.
  accounts.sort((a, b) => a.id.localeCompare(b.id));

  // 접미사 없는 단일 계좌 설정(구버전)도 계속 지원한다. 서버 표기는 `KIS_ACCOUNT_SERVER`다.
  const legacy = parseAccountNumber(process.env.KIS_ACCOUNT_NO, process.env.KIS_ACCOUNT_PRODUCT_CODE);
  const legacyServer = parseDeclaredServer(process.env.KIS_ACCOUNT_SERVER);
  if (legacy && process.env.KIS_APP_KEY && process.env.KIS_APP_SECRET) {
    if (legacyServer.problem) {
      skippedKisAccounts.push({ id: 'default', reason: `KIS_ACCOUNT_SERVER ${legacyServer.problem}` });
    } else {
      accounts.unshift({
        id: 'default',
        label: 'KIS 계좌',
        appKey: process.env.KIS_APP_KEY,
        appSecret: process.env.KIS_APP_SECRET,
        htsId: process.env.KIS_HTS_ID?.trim() || undefined,
        server: legacyServer.server ?? undefined,
        ...legacy,
      });
    }
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
  /** 이 앱키가 붙는 서버(`KIS_<id>_SERVER`). 사람이 적었을 때만 값이 있다 */
  server?: KisServer;
}

/**
 * 자격증명 하나가 **어느 서버에 붙는지**와, 그것이 적힌 값인지 짐작한 값인지.
 * 서버 시작 로그가 이걸 그대로 적는다 — **조용히 다른 서버에 붙는 일이 없어야 한다.**
 */
export interface CredentialPairing {
  id: string;
  /** 이 자격증명이 붙는 서버 */
  server: KisServer;
  /** 사람이 `KIS_<id>_SERVER`에 적었나. false면 `APP_ENV`로 추정한 것이다 */
  declared: boolean;
  /** 이 실행의 서버와 짝이 맞나 */
  matchesEnv: boolean;
}

export function describeCredentialPairings(
  credentials: readonly { id: string; server?: KisServer }[],
  env: KisServer,
): CredentialPairing[] {
  return credentials.map((credential) => {
    const server = credential.server ?? env;
    return { id: credential.id, server, declared: credential.server !== undefined, matchesEnv: server === env };
  });
}

/**
 * 시세·종목마스터·실시간 WS처럼 계좌와 무관한 호출에 쓸 기본 자격증명.
 * 호출 한도를 한 앱키에 모으려고 계좌를 바꿔도 이 값은 고정한다.
 *
 * **적어 둔 id를 못 찾으면 조용히 다른 앱키로 넘어가지 않는다.** 예전에는
 * `KIS_PRIMARY_ACCOUNT_ID`가 안 걸리면 아무 말 없이 id 오름차순 첫 계좌가 기본이 됐다 —
 * 모의로 돌리는데 실계좌 앱키가 시세를 맡게 되고, 그게 바로 **다른 서버에 조용히
 * 붙는** 모양이다. 이제는 넘어가되 **사유를 남긴다**(`problem`, 서버 시작 로그).
 *
 * 새로 열린 길이 하나 더 있다. `KIS_<id>_SERVER`에 알아볼 수 없는 값을 적으면 그 계좌가
 * 통째로 빠지므로, 그 계좌를 가리키던 `KIS_PRIMARY_ACCOUNT_ID`가 갑자기 못 찾는 id가 된다.
 */
export function resolvePrimaryCredentials(
  accounts: readonly KisCredentialPair[],
  explicitId: string | undefined,
  fallback: KisCredentialPair,
): { credentials: KisCredentialPair; problem: string | null } {
  const wanted = explicitId?.trim() ?? '';
  const found = wanted ? findKisCredentialById(accounts, wanted) : undefined;
  const chosen = found ?? accounts[0];
  const problem =
    wanted && !found
      ? // 보간한 값 뒤에 조사를 붙이지 않는다 — id가 무엇이냐에 따라 `을/를`이 갈린다.
        `KIS_PRIMARY_ACCOUNT_ID에 적힌 자격증명을 찾지 못했습니다 (${wanted}).`
        + ` 대신 시세·실시간을 ${chosen ? `자격증명 ${chosen.id}` : '구버전 단일 계좌 설정'}의 앱키로 돌립니다.`
      : null;

  if (chosen) {
    return {
      credentials: { id: chosen.id, appKey: chosen.appKey, appSecret: chosen.appSecret, server: chosen.server },
      problem,
    };
  }
  return { credentials: fallback, problem };
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

  /*
   * 적어 둔 자격증명이 **모의 서버용이라고 적혀 있으면** 개장일을 물을 수 없다.
   * 이 우회의 전제가 "실전 서버에 물으면 답이 같다"인데, 모의 앱키를 실전 도메인에
   * 보내면 `EGW02004`로 거부될 뿐이다(2026-08-01 실측). 짐작해서 보내지 않는다.
   */
  if (found.server === 'vts') {
    return {
      ...asIs,
      problem:
        `KIS_OPEN_DAY_CREDENTIAL_ID에 적힌 자격증명은 모의 서버용이라고 적혀 있습니다 (${credentialId}).`
        + ' 개장일은 실전 서버에 물어야 하므로 KIS_<id>_SERVER=prod인 자격증명 id를 넣으세요.',
    };
  }

  return {
    credentials: { id: found.id, appKey: found.appKey, appSecret: found.appSecret, server: 'prod' },
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

/**
 * **조회도 막는다.** 짝이 어긋난 자격증명으로 나가는 조회는 사유, 맞으면 null.
 *
 * 조회는 되돌릴 수 없는 동작이 아니라 그냥 둘까 했지만 세 가지 때문에 막는 쪽으로 정했다.
 *
 * 1. **성공할 수 없다.** 계좌 TR은 이름이 `config.env`로 갈린다(`TTTC8434R`/`VTTC8434R`).
 *    도메인만 자격증명 쪽으로 돌리면 이름과 도메인이 어긋나 어느 쪽으로 보내도 맞지 않는다.
 *    실시간 통보(`H0STCNI0`/`H0STCNI9`)도 같다.
 * 2. **보내면 토큰이 발급되고 캐시된다.** 2026-08-01 실측에서 모의 앱키를 실전 도메인에
 *    붙였더니 `backend/.cache/token-prod-VTS-EXTRAORDINARY.json`이 실제로 생겼다.
 *    발급에는 횟수 제한이 있어 이건 값이 나가는 일이다.
 * 3. **반쯤 통과하는 것이 가장 나쁘다.** 같은 실측에서 멀티시세·일봉은 정상 응답했고
 *    분봉만 `EGW02004`로 막혔다. 그 상태로는 다른 서버에 붙은 줄 모른 채 값을 믿게 된다.
 *
 * 막는 값은 **사람이 `KIS_<id>_SERVER`에 적었을 때만** 생긴다. 안 적었으면 `config.env`로
 * 추정하므로 늘 짝이 맞고 지금 동작 그대로다.
 *
 * 예외는 하나 — 개장일(`chk-holiday`)처럼 **서버로 이름이 갈리지 않는 TR을 일부러 다른
 * 서버에 묻는** 조회다. 그건 `KisCredentials.crossServerRead`로 호출부가 밝힌다.
 */
export function readServerMismatch(credentialServer: KisServer, env: KisServer): string | null {
  if (credentialServer === env) return null;
  return (
    `이 실행은 ${SERVER_LABELS[env]}인데 자격증명은 ${SERVER_LABELS[credentialServer]}용이라고 적혀 있습니다`
    + ' (KIS_<id>_SERVER). 짝이 어긋나면 조회도 보내지 않습니다 —'
    + ' 계좌 TR 이름이 APP_ENV로 갈려 어차피 맞지 않고, 보내면 그 서버의 토큰이 발급돼 캐시됩니다.'
  );
}

const kisAccounts = parseKisAccounts();
const { credentials: primary, problem: primaryProblem } = resolvePrimaryCredentials(
  kisAccounts,
  process.env.KIS_PRIMARY_ACCOUNT_ID,
  {
    id: 'default',
    appKey: process.env.KIS_APP_KEY ?? '',
    appSecret: process.env.KIS_APP_SECRET ?? '',
    server: parseDeclaredServer(process.env.KIS_ACCOUNT_SERVER).server ?? undefined,
  },
);

export const config = {
  /** 'vts'(모의) | 'prod'(실전) */
  env,
  /** 계좌 무관 호출용 기본 자격증명 */
  appKey: primary.appKey,
  appSecret: primary.appSecret,
  primaryCredentialId: primary.id,
  /**
   * 기본 자격증명이 붙는 서버. **사람이 적었을 때만 값이 있다** — 없으면 `env`로 추정한다.
   * 시세·종목마스터·실시간 WS가 전부 이 앱키를 쓰므로 짝이 어긋나면 서버를 띄우지 않는다
   * (`assertCredentials`).
   */
  primaryCredentialServer: primary.server,
  /**
   * `KIS_PRIMARY_ACCOUNT_ID`를 적었는데 못 찾아 다른 앱키로 넘어간 사유. 없으면 null.
   * **조용히 넘어가지 않는다** — 그게 다른 서버에 붙는 길 중 하나다.
   */
  primaryCredentialProblem: primaryProblem,
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
  /*
   * **기본 자격증명의 짝이 어긋나면 서버를 띄우지 않는다.** 시세·종목마스터·실시간 WS가
   * 전부 이 앱키 하나를 쓰므로 어긋난 채로 뜨면 전 화면이 깨진다. 그런데 2026-08-01
   * 실측에서는 깨지지도 않았다 — 멀티시세·일봉은 통과하고 분봉만 `EGW02004`로 막혀서,
   * 모의 앱키가 실전 도메인에 붙은 줄 모른 채 값을 믿게 됐다. 반쯤 되는 것이 가장 나쁘다.
   *
   * 여기 걸리려면 사람이 `KIS_<id>_SERVER`에 적어야 한다. 안 적었으면 추정이라 늘 통과다.
   */
  const mismatch = readServerMismatch(config.primaryCredentialServer ?? config.env, config.env);
  if (mismatch) {
    throw new Error(
      `시세·실시간에 쓸 기본 자격증명의 짝이 어긋나 서버를 시작하지 않습니다 (${config.primaryCredentialId}). ${mismatch}`
      + ` APP_ENV를 자격증명 쪽에 맞추거나 (${config.primaryCredentialServer ?? config.env}),`
      + ` KIS_PRIMARY_ACCOUNT_ID에 ${kisServerLabel(config.env)}용 자격증명 id를 지정하세요.`,
    );
  }
}
