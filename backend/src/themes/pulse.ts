/**
 * 테마 등락률 — "분야별로 지금 어디에 돈이 도는지".
 *
 * `db/themes.ts`가 명단을 주고 `kis/rest.ts`가 시세를 준다. 이 모듈은 둘을
 * 붙여 **테마 하나가 지금 어떻게 움직이는지**를 낸다. 집계는 순수 함수
 * (`aggregateThemePulse`)로 떼어 두어 DB·네트워크 없이 시험할 수 있다 —
 * `multiQuote.ts`를 `rest.ts`에서 떼어 둔 것과 같은 이유다.
 *
 * ## 대표값을 중앙값으로 정한 이유
 *
 * `ThemePulse` 주석에 적었다. 요약하면 셋(중앙값·단순평균·거래대금 가중평균)을
 * 다 담되 대표는 중앙값이다. 테마 종목 수가 1~110으로 제각각이라(실측) 작은
 * 테마에서는 한 종목의 상한가가 단순평균을 통째로 끌어가고, 큰 테마에서는
 * 거래대금 가중이 대형주 하나의 등락률로 수렴한다.
 *
 * ## 호가가 빈 종목은 표본에서 뺀다
 *
 * 거래정지 종목의 등락률은 언제나 정확히 0%인데 그건 "안 움직였다"가 아니라
 * **"오늘 값이 없다"**다. 예전에는 이 0%가 중앙값·단순평균·보합 수에 들어가고
 * 가중평균에서만 빠져서, 넷 중 하나만 다른 표본을 보고 있었다. 판정은
 * `@invest/shared`의 `hasEmptyOrderBook`이고 실측 근거는 그 주석에 있다.
 *
 * ## 예산은 종목 수가 아니라 호출 수로 잡는다
 *
 * 30종목이 1회다. 종목 수로 상한을 잡으면 몇 회가 나가는지 아무도 모른다
 * (`screening.ts`·`universe.ts`가 같은 이유로 호출 수를 쓴다). 예산을 넘기면
 * **테마 단위로 통째로 뺀다** — 110종목 중 30종목만 보고 낸 값을 "반도체 테마
 * 등락률"이라 부를 수 없다.
 *
 * ## 여러 테마를 한 번에 받는 이유
 *
 * 테마끼리 종목이 겹친다(종목당 평균 2.37개 테마). 테마마다 따로 부르면 삼성전자를
 * 16번 묻는다. 합집합을 한 번에 받아 테마별로 나눠 담으면 겹치는 만큼 호출이 준다.
 */

import { getThemeMembers } from '../db/themes.js';
import { canBatchQuote, getInstrumentQuotes, MULTI_QUOTE_MAX_CODES } from '../kis/rest.js';
import { hasEmptyOrderBook, oldestFetchedAt } from '@invest/shared';
import type {
  Instrument,
  Quote,
  ThemeMembers,
  ThemePulse,
  ThemePulseBatch,
  ThemePulseMember,
  ThemePulseSkip,
} from '@invest/shared';

/**
 * 한 요청이 낼 수 있는 시세 조회 상한. 8회 = 최대 240종목.
 *
 * 실측된 상한은 10묶음(300종목 1.08초, `docs/DESIGN.md`)이고 그보다 낮게 잡는다.
 * 8이면 가장 큰 테마인 반도체(101종목 4회)에 다른 테마 하나를 더 얹을 수 있다.
 * `universe.ts`의 `MAX_PRICE_LOOKUP_CALLS`와 같은 값이다.
 */
export const THEME_PULSE_MAX_CALLS = 8;

/**
 * 한 번에 물을 수 있는 테마 수.
 *
 * 호출 예산과 별개로 둔다 — 종목이 하나도 없는 테마는 호출이 0회라 예산으로는
 * 무한히 넣을 수 있는데, DB 질의는 테마마다 두 번씩 나간다.
 */
export const THEME_PULSE_MAX_THEMES = 12;

/** 중앙값. 짝수면 가운데 둘의 평균이다. 빈 배열은 값이 없다 — 0이 아니다. */
function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * 테마 하나를 집계한다. **순수 함수다** — 넘겨받은 것 말고는 아무것도 안 본다.
 *
 * @param members  `getThemeMembers`가 준 명단 (못 찾은 종목코드 포함)
 * @param quotes   `Instrument.id` → 시세. 이 테마 밖의 종목이 섞여 있어도 된다
 * @param blank    자리는 왔는데 값이 비어 온 종목 id
 * @param failures 묶음째 못 받은 종목 id → 사유
 */
export function aggregateThemePulse(
  members: ThemeMembers,
  quotes: ReadonlyMap<string, Quote>,
  blank: ReadonlySet<string>,
  failures: ReadonlyMap<string, string>,
): ThemePulse {
  const rows: ThemePulseMember[] = [];
  const blankSymbols: string[] = [];
  const noOrderBookSymbols: string[] = [];
  const failedSymbols: string[] = [];
  const failureMessages: string[] = [];

  for (const instrument of members.instruments) {
    const quote = quotes.get(instrument.id);
    if (!quote) {
      /*
       * 못 받은 것을 0으로 채우지 않는다. 채우면 등락률 0%짜리 종목이 생겨
       * 중앙값도 보합 수도 조용히 틀어진다. 왜 없는지는 갈라서 담는다 —
       * 값이 비어 온 것과 조회가 깨진 것은 다른 사실이다.
       */
      if (blank.has(instrument.id)) {
        blankSymbols.push(instrument.symbol);
        continue;
      }
      /*
       * 묶음째 못 받은 것, 그리고 셋 중 어디에도 없는 것. 뒤쪽은 "묻지 않았다"는
       * 뜻이라 빈 값 쪽에 섞으면 안 된다 — 그러면 예산 계산이 어긋나 통째로 빠진
       * 종목이 "값 없는 종목"으로 보이고, 사람은 그걸 KIS 탓으로 읽는다.
       */
      const message = failures.get(instrument.id) ?? '이 요청에서 시세를 묻지 않았습니다.';
      failedSymbols.push(instrument.symbol);
      if (!failureMessages.includes(message)) failureMessages.push(message);
      continue;
    }
    /*
     * 호가가 양쪽 다 빈 종목은 등락률 표본에서 뺀다. 이런 종목의 등락률은
     * 언제나 정확히 0%인데 그건 "안 움직였다"가 아니라 **"오늘 값이 없다"**다.
     *
     * 2026-07-31 실측: 2차전지 테마는 **보합 4종목이 전부 거래 0원**이라 진짜
     * 보합이 0종목이었고, 이 넷을 빼면 중앙값이 +0.810 → +1.090으로 0.28%p
     * 움직였다. 가중평균은 예전부터 `turnover > 0`으로 빼고 있어서 넷 중 하나만
     * 다른 표본을 보고 있었다.
     *
     * **거래대금 0원을 기준으로 빼지는 않는다.** 같은 날 실측에서 거래대금이
     * 0인 8종목 중 2종목(`0000Y0`·`001067`)은 호가가 살아 있는 정상 종목이었다 —
     * 오늘 아직 체결이 없을 뿐이고, 그 0%는 진짜 보합에 가깝다.
     */
    if (hasEmptyOrderBook(quote) === true) {
      noOrderBookSymbols.push(instrument.symbol);
      continue;
    }
    rows.push({
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      name: instrument.name,
      price: quote.price,
      change: quote.change,
      changeRate: quote.changeRate,
      sign: quote.sign,
      // 어림하지 않는다. 없으면 가중평균과 거래대금 합에서 빠지고 그 수를 밝힌다.
      ...(quote.turnover !== undefined ? { turnover: quote.turnover } : {}),
    });
  }

  rows.sort((a, b) => b.changeRate - a.changeRate);

  const rates = rows.map((row) => row.changeRate);
  const withTurnover = rows.filter(
    (row): row is ThemePulseMember & { turnover: number } => row.turnover !== undefined && row.turnover > 0,
  );
  const turnoverSum = withTurnover.reduce((sum, row) => sum + row.turnover, 0);
  const middle = median(rates);
  const average = mean(rates);

  return {
    theme: members.theme,
    members: rows,
    missingSymbols: members.missingSymbols,
    blankSymbols,
    noOrderBookSymbols,
    failedSymbols,
    failureMessages,
    quotedCount: rows.length,
    // 시세가 하나도 없으면 값 자체를 담지 않는다. 0%는 "안 움직였다"는 다른 사실이다.
    ...(middle !== undefined ? { changeRateMedian: middle } : {}),
    ...(average !== undefined ? { changeRateMean: average } : {}),
    ...(turnoverSum > 0
      ? {
          changeRateWeighted:
            withTurnover.reduce((sum, row) => sum + row.changeRate * row.turnover, 0) / turnoverSum,
          turnover: turnoverSum,
        }
      : {}),
    turnoverCount: withTurnover.length,
    advancing: rows.filter((row) => row.changeRate > 0).length,
    declining: rows.filter((row) => row.changeRate < 0).length,
    unchanged: rows.filter((row) => row.changeRate === 0).length,
  };
}

/**
 * 예산 안에서 잴 수 있는 테마만 고른다. **부르기 전에** 센다.
 *
 * 합집합이 커질수록 호출이 는다. 테마를 하나씩 넣어 보면서 합집합의 호출 수가
 * 상한을 넘으면 그 테마는 통째로 뺀다 — 반쪽으로 재느니 안 잰다.
 */
export function planThemeQuotes(
  loaded: ThemeMembers[],
  maxCalls: number,
): { measured: ThemeMembers[]; skipped: ThemePulseSkip[]; instruments: Instrument[] } {
  const measured: ThemeMembers[] = [];
  const skipped: ThemePulseSkip[] = [];
  const byId = new Map<string, Instrument>();

  for (const members of loaded) {
    const next = new Map(byId);
    for (const instrument of members.instruments) next.set(instrument.id, instrument);
    if (estimateQuoteCalls([...next.values()]) > maxCalls) {
      skipped.push({
        code: members.theme.code,
        name: members.theme.name,
        reason: `이 요청의 시세 조회 상한 ${maxCalls}회를 넘습니다 (${members.theme.instrumentCount}종목). 테마를 줄여 다시 재세요.`,
      });
      continue;
    }
    measured.push(members);
    for (const [id, instrument] of next) byId.set(id, instrument);
  }

  return { measured, skipped, instruments: [...byId.values()] };
}

/** 이 종목들을 물으면 몇 회가 나가는가. 묶이는 것은 30종목당 1회, 나머지는 1회씩. */
export function estimateQuoteCalls(instruments: Instrument[]): number {
  const batchable = new Set(
    instruments.filter(canBatchQuote).map((instrument) => instrument.providerSymbol),
  );
  const single = instruments.filter((instrument) => !canBatchQuote(instrument)).length;
  return Math.ceil(batchable.size / MULTI_QUOTE_MAX_CODES) + single;
}

/**
 * 테마 여러 개의 지금 등락률.
 *
 * **사용자가 부를 때만 돈다.** 탭을 열 때마다 자동으로 돌리면 반도체 하나에
 * 4회씩 나간다. 화면은 호출 수(`quoteCalls`)를 버튼 옆에 적는다.
 */
export async function getThemePulses(codes: string[]): Promise<ThemePulseBatch> {
  const wanted = [...new Set(codes.map((code) => code.trim()).filter((code) => code.length > 0))];
  const skipped: ThemePulseSkip[] = [];

  const inBudget = wanted.slice(0, THEME_PULSE_MAX_THEMES);
  for (const code of wanted.slice(THEME_PULSE_MAX_THEMES)) {
    // 잘린 것을 조용히 버리지 않는다. 안 물어본 테마와 못 잰 테마는 다르다.
    skipped.push({ code, reason: `한 번에 ${THEME_PULSE_MAX_THEMES}개까지만 잽니다.` });
  }

  const loaded: ThemeMembers[] = [];
  for (const code of inBudget) {
    const members = await getThemeMembers(code);
    if (!members) {
      skipped.push({ code, reason: '그런 테마 코드가 없습니다.' });
      continue;
    }
    loaded.push(members);
  }

  const plan = planThemeQuotes(loaded, THEME_PULSE_MAX_CALLS);
  skipped.push(...plan.skipped);

  const batch =
    plan.instruments.length > 0
      ? await getInstrumentQuotes(plan.instruments)
      : { quotes: new Map<string, Quote>(), blank: [], failed: [], calls: 0 };

  const failures = new Map<string, string>();
  for (const failure of batch.failed) {
    for (const id of failure.instrumentIds) failures.set(id, failure.message);
  }
  const blank = new Set(batch.blank);

  return {
    /*
     * 이 회차는 **가장 묵은 시세만큼 묵었다.** 마지막 호출이 끝난 시각(`Date.now()`)을
     * 적으면 8묶음을 도는 동안 앞 묶음이 얼마나 묵었는지가 지워진다. 화면은 이 시각을
     * `HH:MM:SS에 잰 값`으로 그대로 적는다.
     *
     * 시세가 하나도 없으면 잴 대상이 없으니 회차 시각을 쓴다.
     */
    measuredAt: oldestFetchedAt([...batch.quotes.values()]) ?? Date.now(),
    quoteCalls: batch.calls,
    maxQuoteCalls: THEME_PULSE_MAX_CALLS,
    pulses: plan.measured.map((members) => aggregateThemePulse(members, batch.quotes, blank, failures)),
    skipped,
  };
}
