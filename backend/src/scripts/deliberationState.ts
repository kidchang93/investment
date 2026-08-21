/**
 * **회의 한 바퀴에 필요한 것을 한 번에 모은다.**
 *
 * ── 왜 (2026-08-05) ──────────────────────────────────────────────────────
 *
 * 판단자가 러너(알고리즘)에서 에이전트로 바뀌었다. 에이전트가 판단하려면 지금
 * 계좌·보유·미체결·시세를 알아야 하는데, 각자 조회하면 두 문제가 난다.
 *
 *   1. **같은 회의인데 서로 다른 순간을 본다.** 한 에이전트는 14:31 잔고를,
 *      다른 에이전트는 14:36 시세를 보고 이야기하면 결론이 어긋난다
 *   2. 초당 호출 한도를 에이전트 수만큼 곱해서 먹는다
 *
 * 그래서 **한 번 모아서 같은 것을 나눠 본다.** 찍은 시각을 함께 남겨,
 * 나중에 판단을 되짚을 때 그때 무엇을 알고 있었는지 재구성할 수 있게 한다.
 *
 * ── 이 스크립트가 하지 않는 것 ───────────────────────────────────────────
 *
 * **판단하지 않는다.** 값만 모아 찍는다. 여기에 "사야 한다" 같은 것이 들어가면
 * 판단자가 둘이 되고, 에이전트가 그 판단을 그대로 받아 적게 된다.
 *
 * **주문하지 않는다.** 조회 전용이다.
 *
 *   npx tsx src/scripts/deliberationState.ts [계좌id]
 */

import { getKisAccount, config } from '../config.js';
import { getKoreanInstrumentBySymbol } from '../db/instruments.js';
import { getRiskRules } from '../db/riskRules.js';
import {
  DOMESTIC_INDEX_CODES,
  getDomesticIndex,
  getKisDomesticAccountSnapshot,
  getKisDomesticExecutions,
  getKisDomesticOrderability,
  getDomesticTurnoverRanking,
  getInstrumentNews,
  getQuote,
} from '../kis/rest.js';
import { sellableQuantity } from '../trading/positionGuard.js';

const accountId = process.argv[2] ?? 'VTS-ORDINARY';
const account = getKisAccount(accountId);
if (!account) {
  console.error(`등록되지 않은 계좌: ${accountId}`);
  process.exit(1);
}

const at = new Date();
const kst = at.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
console.log(`# 회의 상태 · ${kst} KST · 계좌 ${account.id} · 서버 ${config.env}`);
console.log('★ 값만 모은 것이다. 판단은 들어 있지 않다.\n');

const [snapshot, executionSnapshot, rules, orderability] = await Promise.all([
  getKisDomesticAccountSnapshot(account),
  getKisDomesticExecutions(account, 1).catch(() => null),
  getRiskRules(account.id),
  /*
   * 매수여력. 종목·유형은 아무거나 좋다 — `ord_psbl_cash`는 종목과 무관한
   * 계좌 값이다. 시장가로 물어 지정가 계산에 걸리지 않게 한다.
   */
  getKisDomesticOrderability(account, '005930', 'market', 0).catch(() => null),
]);
/**
 * ★ **오늘 것만 남긴다.** `days=1`은 `어제~오늘`을 준다(2026-08-05 실측: 28건 중
 * 오늘은 10건). 필터 없이 「오늘 주문」으로 찍으면 회의가 어제 18건을 오늘로 세고,
 * "오늘 이미 많이 매매했다"는 거짓 전제로 판단하게 된다.
 *
 * 미체결 계산에는 **전부** 쓴다 — 어제 낸 주문이 아직 살아 있을 수 있고, 그걸
 * 빼먹으면 이미 매도가 나간 물량을 또 팔라고 하게 된다.
 */
const allExecutions = executionSnapshot?.executions ?? [];
const todayKey = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(at).replace(/-/g, '');
const executions = allExecutions.filter((e) => e.orderDate === todayKey);

/*
 * 지수를 **맨 앞에** 둔다. 계좌 손익만 보면 "우리가 잘했나"를 시장과 못 가른다 —
 * 2026-08-05에 KOSPI +4.41%인 날 계좌가 −0.21%였는데, 그 대비가 있어야 읽힌다.
 *
 * ★ **상승/하락 종목 수를 함께 찍는다.** 지수는 시가총액 가중이라 대형주 몇 개가
 * 끌고 간다. 2026-08-06 09:2x 실측: 코스피 −2.09%인데 상승 505 / 하락 334였다 —
 * 지수 숫자만 보면 "다 빠지는 장"으로 읽지만 실제로는 대형주만 빠지고 있었다.
 */
console.log('## 지수');
for (const code of [DOMESTIC_INDEX_CODES.kospi, DOMESTIC_INDEX_CODES.kosdaq]) {
  try {
    const idx = await getDomesticIndex(code);
    console.log(
      `- ${idx.name} ${idx.value.toFixed(2)}`
      + ` · ${idx.changeRate >= 0 ? '+' : ''}${idx.changeRate.toFixed(2)}%`
      + ` · 상승 ${idx.advancing} / 하락 ${idx.declining} / 보합 ${idx.unchanged}`,
    );
  } catch (e) {
    console.log(`- ${code} 조회 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log('\n## 계좌');
const won = (n: number | null | undefined): string =>
  n === null || n === undefined ? '—' : `${Math.round(n).toLocaleString('ko-KR')}원`;
console.log(`총평가 ${won(snapshot.totalEvaluation)} · 주식 ${won(snapshot.stockEvaluation)}`
  + ` · 예수금 ${won(snapshot.cashBalance)} · 매수여력 ${won(orderability?.cashAvailable ?? 0)}`
  + `${orderability === null ? ' (매수여력 조회 실패)' : ''}`);
/*
 * ★ **예수금으로 자리 크기를 정하면 낼 수 없는 주문을 적게 된다.**
 *   `cashBalance`(D+0)에는 오늘 체결된 것도, 미체결이 묶어 둔 것도 아직 안 빠져
 *   있다. 2026-08-20에 예수금 19,649,294원인데 매수여력은 **984,524원**이었다.
 */
/*
 * 없는 값을 0%로 적지 않는다 — `평가손익률 0.00%`는 "본전이었다"로 읽힌다.
 *
 * 이 자리는 한때 KIS의 자산증감수익률(`asst_icdc_erng_rt`)을 평가손익률이라고
 * 적고 있었다. 개장 전에는 자산이 안 움직여 0으로 오므로, 실제 손익률이
 * −0.17%인 아침에 판단자가 `0.00%`를 읽었다(2026-08-12 실측).
 */
const rate = (value: number | undefined): string =>
  value === undefined ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
console.log(`평가손익 ${won(snapshot.unrealizedPnl)} (${rate(snapshot.unrealizedPnlRate)})`);
// 자산증감수익률은 다른 것을 재는 값이라 이름을 갈라 적는다 (전일 총자산 대비).
console.log(`전일 대비 자산증감 ${rate(snapshot.assetChangeRate)}`);

console.log('\n## 보유');
if (snapshot.positions.length === 0) {
  console.log('없음 (전액 현금)');
} else {
  for (const p of snapshot.positions) {
    /*
     * **팔 수 있는 수량을 함께 찍는다.** 보유 수량만 보고 판단하면 이미 매도가
     * 나가 있는 물량을 또 팔라고 하게 된다 — 8/4에 그것으로 판단자가 죽었다.
     */
    /*
     * ★ **주문 조회가 실패했으면 수량을 찍지 않는다.** 빈 목록으로 계산하면
     * 미체결 매도가 있어도 "전량 팔 수 있다"가 나온다 — 모르는 것이 아는 것처럼
     * 보이는 이 모양이 8/4에 판단자를 죽인 바로 그것이다.
     */
    const sellable =
      executionSnapshot === null
        ? '알 수 없음 (주문 조회 실패)'
        : `${sellableQuantity(p.symbol, snapshot.positions, allExecutions)}주`;
    console.log(
      `- ${p.symbol} ${p.name} · ${p.quantity}주 (팔 수 있는 수량 ${sellable})`
      + ` · 평단 ${won(p.averagePrice)} · 현재 ${won(p.currentPrice)}`
      + ` · 손익 ${won(p.unrealizedPnl)} (${rate(p.unrealizedPnlRate)})`,
    );
  }
}

console.log(
  executionSnapshot === null
    ? '\n## 오늘 주문'
    : `\n## 오늘(${todayKey}) 주문 — 어제분 ${allExecutions.length - executions.length}건은 뺐다`,
);
if (executionSnapshot === null) {
  console.log('★ 조회 실패 — 미체결을 모른다. 매도 판단에 이 사실을 넣어야 한다.');
} else if (executions.length === 0) {
  console.log('없음');
} else {
  for (const e of executions) {
    console.log(
      /*
       * ★ **주문번호를 반드시 함께 찍는다.** 앞 숫자는 주문**시각**이라, 그것을
       *   주문번호로 읽고 `amend`·`cancel`에 적으면 정정·취소가 조용히 안 나간다.
       *   2026-08-20 회차 22가 이 자리에서 걸려 DB를 직접 뒤져야 했다.
       */
      `- ${e.orderTime ?? e.orderDate} ${e.symbol} ${e.name}`
      + ` ${e.side === 'buy' ? '매수' : '매도'} ${e.orderQuantity}주 (${e.orderTypeLabel})`
      + ` · 체결 ${e.filledQuantity} · 잔량 ${e.remainQuantity} · ${e.status}`
      + ` · 주문번호 ${e.orderNo}`,
    );
  }
}

console.log('\n## 관문 (여기 걸리면 주문이 안 나간다)');
console.log(`거래 시간 ${rules.sessionStart}~${rules.sessionEnd} · 1회 금액 ${won(rules.maxOrderNotional)}`
  + ` · 1회 수량 ${rules.maxOrderQuantity.toLocaleString('ko-KR')}주`);
console.log(`일일 금액 ${won(rules.dailyNotionalLimit)} · 일일 건수 ${rules.dailyOrderCountLimit}건`
  + ` · 시장가 ${rules.allowMarketOrder ? '허용' : '차단'}`);
console.log(`보유 한도 ${rules.maxPositions || '제한 없음'}종목`
  + ` · 최소 보유 ${rules.minHoldMinutes || 0}분`
  + ` · 중단선 ${rules.stopEquity > 0 ? won(rules.stopEquity) : '없음'}`);
if (rules.symbolAllowlist.length > 0) console.log(`허용 종목만: ${rules.symbolAllowlist.join(', ')}`);
if (rules.symbolBlocklist.length > 0) console.log(`차단 종목: ${rules.symbolBlocklist.join(', ')}`);

/*
 * 후보는 **거래소 거래대금 순위**로 가져온다. 우리 DB를 코드순으로 훑으면
 * 6% 조각 안에서만 정렬돼 삼성전자가 406번째로 나온다(2026-08-04 실측).
 */
console.log('\n## 오늘 거래대금 상위 (후보군)');
try {
  const ranked = await getDomesticTurnoverRanking(12);
  const quotes = await Promise.all(
    ranked.map((symbol) => getQuote(symbol).then((q) => ({ symbol, q })).catch(() => null)),
  );
  for (const row of quotes) {
    if (!row) continue;
    const { symbol, q } = row;
    console.log(
      `- ${symbol} · ${won(q.price)}`
      + ` · ${q.changeRate >= 0 ? '+' : ''}${q.changeRate.toFixed(2)}%`
      + (q.turnover !== undefined ? ` · 거래대금 ${Math.round(q.turnover / 100_000_000)}억` : ''),
    );
  }
} catch (e) {
  console.log(`★ 조회 실패: ${e instanceof Error ? e.message : String(e)}`);
}

/*
 * ## 보유 종목 공시·뉴스
 *
 * ★ **여기 없어서 판단자가 웹을 헤맸다.** 2026-08-21까지 이 스크립트는
 *   *"뉴스는 여기 없다. 필요하면 따로 조사해야 한다"*고 적어 뒀는데, 정작
 *   `getInstrumentNews`(KIS `FHKST01011800`)가 이미 있었다. 판단자는 회차
 *   22·23·24에서 세 번 연속 "티에스이 8/20 공시 확인"을 반증 조건으로 걸고
 *   세 번 다 실패했다 — 네이버는 차단, DART 검색은 빈 결과였다.
 *
 * 공시를 못 보면 *"악재가 없어서 들고 간다"*가 근거 없는 문장이 된다.
 *
 * ★ 조회가 실패해도 회차를 막지 않는다. 못 본 것은 못 봤다고 적는다.
 */
console.log('\n## 보유 종목 공시·뉴스 (최근 5건)');
if (snapshot.positions.length === 0) {
  console.log('보유 없음');
} else {
  for (const position of snapshot.positions) {
    const instrument = await getKoreanInstrumentBySymbol(position.symbol).catch(() => null);
    if (!instrument) {
      console.log(`- ${position.symbol} ${position.name} — 종목 마스터에 없어 조회 못 함`);
      continue;
    }
    try {
      const news = await getInstrumentNews(instrument);
      if (news.length === 0) {
        console.log(`- ${position.symbol} ${position.name} — 최근 공시·뉴스 없음`);
        continue;
      }
      console.log(`- ${position.symbol} ${position.name}`);
      for (const item of news.slice(0, 5)) {
        // ★ `publishedAt`은 **초** 단위다(차트 라이브러리가 초를 쓴다). 밀리초로 읽으면
        //   1970년이 나온다 — 처음 쓸 때 그렇게 틀렸다.
        const when = item.publishedAt
          ? new Date(item.publishedAt * 1000).toLocaleString('ko-KR', {
              timeZone: 'Asia/Seoul',
              month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
            })
          : '시각 없음';
        console.log(`    ${when} [${item.source}] ${item.title}`);
      }
    } catch (e) {
      console.log(
        `- ${position.symbol} ${position.name} — ★ 조회 실패:`
        + ` ${e instanceof Error ? e.message : String(e)} (못 본 것은 unknowns에 적을 것)`,
      );
    }
  }
}

console.log('\n## 이 회의에서 알 수 없는 것 — 결론에 반드시 적을 것');
console.log('- 위 공시·뉴스는 KIS가 주는 제목뿐이다. 본문과 DART 원문은 따로 봐야 한다');
console.log('- 미체결 조회는 모의 서버에서 안 된다(오늘 주문 목록이 전부일 수 있다)');
console.log('- 이 값들은 위 시각의 것이다. 몇 분 지나면 다르다');

process.exit(0);
