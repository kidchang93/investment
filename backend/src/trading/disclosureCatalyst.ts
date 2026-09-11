/**
 * **재료가 막 나온 종목** — 공시 제목을 가르고, 공시 직전 종가를 고르고, 목록을 조립한다.
 *
 * ── 왜 (2026-09-11) ──────────────────────────────────────────────────────
 *
 * 사용자가 정했다 — *"오를만한 것들로 브리핑을 해줘야지 이미 오른 걸 가지고
 * 뭐하려고?"* 그리고 고른 기준이 **"재료가 막 나온 종목"**이다. 그 전의 📈(오늘
 * 오른 순)는 첫 세 회차가 전부 *"이미 올라 손절선을 둘 자리가 없다"*로 걸렀다.
 *
 * ★ **공시를 재료로 쓴다.** KIS 뉴스 제목 TR을 종목코드 없이 부르면 전 종목 기사가
 *   오지만 40건이 15분치이고 종목코드가 붙은 것은 5~19건이다(2026-09-11 탐침).
 *   **제목 검색 칸은 무시된다** — 무슨 단어를 넣어도 같은 결과가 왔다. 반면 제공업체를
 *   거래소 공시(`F`)·코스닥 공시(`G`)로 걸면 40건이 반나절치이고 거의 전부 종목코드가
 *   붙는다. 공시 제목은 **정해진 이름**("단일판매ㆍ공급계약체결")이라 단어로 가를 수 있다.
 *
 * ★ 이 파일은 **판단하지 않는다.** "재료가 나왔는데 값이 덜 움직였다"까지 고르고,
 *   그 재료가 값을 다시 매길 만한지는 판단자가 원문을 보고 정한다. 공급계약은 제목에
 *   금액이 없다 — 매출 대비 몇 %인지가 핵심인데 그것은 원문에만 있다.
 *
 * ★ 스크립트가 아니라 이 파일에 둔 이유는 `judgeGate.ts`와 같다 — 스크립트는
 *   import만 해도 `main()`이 돌아 시험을 붙일 수 없다.
 */

export type CatalystTone = 'good' | 'bad';

interface DisclosureRule {
  /** 공백을 뺀 제목에 이 중 하나가 들어 있으면 맞는다 */
  match: string[];
  label: string;
  tone: CatalystTone;
}

/**
 * 공시 제목 → 재료 종류.
 *
 * ★★ **악재를 먼저 본다.** "유무상증자결정"은 "무상증자결정"을 품고, "단일판매ㆍ
 *    공급계약해지"는 "공급계약"을 품는다. 호재부터 보면 희석·해지가 호재로 읽힌다.
 * ★ 악재는 후보에서 **빼지 않고** ⚠로 붙인다 — 같은 기간에 공급계약과 전환사채가
 *   함께 났다면 판단자가 둘을 같이 봐야 한다.
 * ★ 실적 공시는 방향이 제목에 없다. 호재 칸에 두되 **"방향은 원문"**이라고 적는다.
 */
const RULES: DisclosureRule[] = [
  { match: ['유무상증자결정', '유상증자결정'], label: '유상증자', tone: 'bad' },
  { match: ['전환사채권발행결정'], label: '전환사채', tone: 'bad' },
  { match: ['신주인수권부사채권발행결정'], label: '신주인수권부사채', tone: 'bad' },
  { match: ['교환사채권발행결정'], label: '교환사채', tone: 'bad' },
  { match: ['추가상장'], label: '추가상장(희석)', tone: 'bad' },
  { match: ['자기주식처분결정'], label: '자사주 처분', tone: 'bad' },
  { match: ['공급계약해지'], label: '계약 해지', tone: 'bad' },
  { match: ['감자결정'], label: '감자', tone: 'bad' },
  { match: ['투자경고', '투자위험', '투자주의'], label: '투자주의·경고', tone: 'bad' },
  { match: ['단기과열'], label: '단기과열', tone: 'bad' },
  { match: ['공매도과열'], label: '공매도 과열', tone: 'bad' },
  { match: ['관리종목', '불성실공시', '상장폐지', '매매거래정지'], label: '관리·거래정지', tone: 'bad' },
  { match: ['횡령', '배임', '소송'], label: '횡령·배임·소송', tone: 'bad' },

  { match: ['공급계약체결'], label: '공급계약', tone: 'good' },
  { match: ['주식소각결정'], label: '주식소각', tone: 'good' },
  { match: ['자기주식취득결정', '자기주식취득신탁계약체결결정'], label: '자사주 취득', tone: 'good' },
  { match: ['영업(잠정)실적'], label: '잠정실적(방향은 원문)', tone: 'good' },
  { match: ['매출액또는손익구조'], label: '실적 변동(방향은 원문)', tone: 'good' },
  { match: ['임상시험계획승인', '임상시험결과', '품목허가'], label: '임상·허가', tone: 'good' },
  { match: ['기술이전계약', '기술도입계약'], label: '기술이전', tone: 'good' },
  { match: ['신규시설투자'], label: '시설투자', tone: 'good' },
  { match: ['무상증자결정'], label: '무상증자', tone: 'good' },
];

export interface DisclosureKind {
  label: string;
  tone: CatalystTone;
  /** 정정 공시인가 — 예전 공시의 숫자를 고친 것이라 새 재료가 아닐 수 있다 */
  correction: boolean;
}

/** 공시 제목을 가른다. 어느 규칙에도 안 맞으면 `null`(재료로 안 센다) */
export function classifyDisclosure(title: string): DisclosureKind | null {
  const flat = title.replace(/\s+/g, '');
  const rule = RULES.find((r) => r.match.some((m) => flat.includes(m)));
  if (!rule) return null;
  return { label: rule.label, tone: rule.tone, correction: /[([]정정[)\]]/.test(flat) };
}

/** 하루 종가 한 칸. `day`는 `YYYYMMDD` */
export interface DayClose { day: string; close: number }

/** 장 마감 시각(`HHMMSS`). 이 뒤에 난 공시는 그날 종가가 기준이다 */
export const MARKET_CLOSE_TIME = '153000';

/**
 * **공시 직전 종가.** 장 마감 전에 난 공시는 **그 전 거래일** 종가, 마감 뒤에 난 것은
 * **그날** 종가다. 오늘 진행 중인 봉(`today` 이상)은 쓰지 않는다 — 아직 종가가 아니다.
 *
 * ★ 장중에 난 공시는 그날 공시 전 움직임까지 "공시 뒤 움직임"에 섞인다. 공시 시각의
 *   값을 따로 받지 않는 한 피할 수 없고, 그만큼 **덜 움직였다고 볼 여지를 줄인다**
 *   (보수 쪽 오차다).
 */
export function baseCloseFor(
  closes: DayClose[], publishedDay: string, publishedTime: string, today: string,
): DayClose | null {
  const afterClose = publishedTime >= MARKET_CLOSE_TIME;
  let best: DayClose | null = null;
  for (const c of closes) {
    if (c.day >= today) continue;
    if (afterClose ? c.day > publishedDay : c.day >= publishedDay) continue;
    if (best === null || c.day > best.day) best = c;
  }
  return best;
}

export interface DisclosureRow {
  symbol: string;
  name: string;
  title: string;
  /** `YYYYMMDD` */
  publishedDay: string;
  /** `HHMMSS` */
  publishedTime: string;
}

export interface CatalystPick {
  symbol: string;
  name: string;
  /** 창 안의 호재 종류 전부(최신 순, 겹치면 한 번) */
  labels: string[];
  /** 가장 최근 호재 공시 */
  latest: DisclosureRow & { correction: boolean };
  base: DayClose;
  price: number;
  /** 공시 직전 종가 대비 지금 값 (0.03 = +3%) */
  move: number;
  /** 같은 창 안의 악재 종류 — 빼지 않고 붙인다 */
  warnings: string[];
}

export interface CatalystResult {
  picks: CatalystPick[];
  /** 호재 공시가 난 종목 중 후보 풀(거래대금 상위·보유 제외) 안의 수 */
  eligible: number;
  /** 풀 밖이라 뺀 수 — 사도 못 파는 종목 */
  outside: number;
  /** 공시 뒤 이미 `maxMove`보다 많이 오른 수 */
  tooMoved: number;
  /** 기준 종가·현재가를 몰라 못 잰 수 */
  unmeasured: number;
}

/**
 * 창 안의 공시로 **재료는 나왔는데 값이 덜 움직인 종목**을 고른다.
 *
 * ★ 가장 최근 호재 공시가 기준이다. 한 종목에 호재가 여럿이면 종류는 다 적고,
 *   값의 움직임은 가장 최근 것부터 잰다 — "막 나온" 것이 이 목록의 뜻이다.
 * ★ 순서는 **최근 공시 순**이다. 오래된 재료일수록 이미 값에 들어갔을 공산이 크다.
 * ★ 뺀 것을 센다(`outside`·`tooMoved`·`unmeasured`) — 안 세면 "재료가 없다"와
 *   "재료는 있는데 다 올랐다"가 화면에서 구별되지 않는다.
 */
export function pickCatalysts(input: {
  rows: DisclosureRow[];
  eligible: (symbol: string) => boolean;
  price: (symbol: string) => number | undefined;
  base: (row: DisclosureRow) => DayClose | null;
  maxMove: number;
  limit: number;
}): CatalystResult {
  const bySymbol = new Map<string, Array<DisclosureRow & DisclosureKind>>();
  for (const row of input.rows) {
    const kind = classifyDisclosure(row.title);
    if (!kind) continue;
    const list = bySymbol.get(row.symbol) ?? [];
    list.push({ ...row, ...kind });
    bySymbol.set(row.symbol, list);
  }

  const result: CatalystResult = { picks: [], eligible: 0, outside: 0, tooMoved: 0, unmeasured: 0 };
  const stamp = (r: DisclosureRow): string => `${r.publishedDay}${r.publishedTime}`;
  for (const [symbol, list] of bySymbol) {
    const goods = list.filter((r) => r.tone === 'good').sort((a, b) => stamp(b).localeCompare(stamp(a)));
    if (goods.length === 0) continue;
    if (!input.eligible(symbol)) { result.outside += 1; continue; }
    result.eligible += 1;

    const latest = goods[0];
    const base = input.base(latest);
    const price = input.price(symbol);
    if (base === null || price === undefined || !(price > 0) || !(base.close > 0)) {
      result.unmeasured += 1;
      continue;
    }
    const move = price / base.close - 1;
    if (move > input.maxMove) { result.tooMoved += 1; continue; }

    result.picks.push({
      symbol,
      name: latest.name,
      labels: [...new Set(goods.map((g) => g.label))],
      latest: {
        symbol, name: latest.name, title: latest.title,
        publishedDay: latest.publishedDay, publishedTime: latest.publishedTime, correction: latest.correction,
      },
      base,
      price,
      move,
      warnings: [...new Set(list.filter((r) => r.tone === 'bad').map((r) => r.label))],
    });
  }
  result.picks.sort((a, b) => stamp(b.latest).localeCompare(stamp(a.latest)));
  result.picks = result.picks.slice(0, input.limit);
  return result;
}

/**
 * `YYYYMMDD`의 **전 평일**. 📣의 창("최근 2거래일")이 여기서 시작한다.
 *
 * ★ 공휴일은 모른다 — 연휴 다음 날에는 창이 짧아진다(연휴 중 공시가 빠진다).
 *   개장일 TR은 모의 서버에 없어(`docs/TRADING_API.md`) 여기서 부르지 않는다.
 */
export function previousWeekday(day: string): string {
  const d = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6, 8))));
  do { d.setUTCDate(d.getUTCDate() - 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}
