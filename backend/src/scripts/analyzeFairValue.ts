/**
 * **적정가 분석 → 슬랙.** KIS 재무 · 차트 · 뉴스 셋을 합쳐 5분마다 보낸다.
 *
 * ── 왜 (2026-09-03) ──────────────────────────────────────────────────────
 *
 * 사용자가 정했다 — *"분석가는 KIS와 차트분석 및 웹 뉴스 이 세가지를 분석해서
 * 적정가를 슬랙으로 5분마다 메세지 보내줘"*, 그리고 그 앞에 —
 * *"판단자가 그 가격을 보고 매수할지 매도할지 정해서 집행하는 시퀀스."*
 *
 * 그래서 이 스크립트는 **판단하지 않는다.** 적정가만 낸다. 사고파는 결정은
 * 판단자가 이 표를 보고 한다.
 *
 * ── 세 재료 ──────────────────────────────────────────────────────────────
 *
 *   ① KIS      현재가 + 재무(BPS·EPS·ROE) — `getDomesticQuotes`·`getFinancials`
 *   ② 차트     21년 일봉 저장소 — 60일 이동평균 ± 변동성 띠, 과거 배수
 *   ③ 웹 뉴스  네이버 주요 뉴스 — 종목 이름이 걸리면 붙인다
 *
 * ★ **셋을 평균 내지 않는다.** 갈리면 그 자체가 정보다(`trading/fairValue.ts`).
 *
 * ── ★★ 비용을 어떻게 눌렀나 ─────────────────────────────────────────────
 *
 * 5분마다 장중 6.5시간이면 **하루 78회**다. 매번 헤드리스 Claude를 부르면
 * 판단자(하루 1~3회)의 **수십 배**가 된다. 그래서 **Claude를 안 부른다** —
 * 적정가는 재무·차트로 **계산**하고, 뉴스는 제목을 그대로 붙인다.
 *
 * 해석은 판단자가 한다. 그것이 판단자의 일이고, 여기서 또 하면 같은 판단을
 * 두 번 사는 것이다.
 *
 *   비용: KIS 시세 1회 + 종목별 재무 1회(캐시) + 네이버 1페이지. **Claude 0회.**
 *   📈(2026-09-11): 스크리너 시세 10회(거래대금 상위 300) + 📈 종목 뉴스 5회.
 *   📣(2026-09-11): 공시 목록 2회(그날 첫 회차는 이틀치를 채우느라 ~16회) + 기준가 일봉(한 번 구하면 끝)
 *                   + 📣 종목 뉴스 5회.
 *
 * ── 무엇을 안 하나 ───────────────────────────────────────────────────────
 *
 * **주문을 내지 않는다. 판단하지 않는다.** 적정가와 뉴스를 나란히 놓을 뿐이다.
 *
 *   npx tsx src/scripts/analyzeFairValue.ts [계좌id] [--no-judge]
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import '../config.js';

import type { FinancialSnapshot, NewsItem } from '@invest/shared';

import { getKisAccount } from '../config.js';
import { closeDb, pool } from '../db/client.js';
import { getDailyBars } from '../db/dailyBars.js';
import { getKoreanInstrumentBySymbol, getTopTurnoverInstruments } from '../db/instruments.js';
import {
  getDailyCandles, getDomesticQuotes, getFinancials, getInstrumentNews, getKisDomesticAccountSnapshot, probeKisTr,
} from '../kis/rest.js';
import { kstToday } from '../kis/normalize.js';
import { getMainNews } from '../naver/finance.js';
import { escapeMrkdwn, sendSlackBot, slackBotConfigured } from '../notify/slack.js';
import { markAgentActivity } from '../db/agentActivity.js';
import {
  ASSET_KIND_LABEL, ASSET_KIND_METHOD,
  FALLING_GATE, FINANCIAL_TTL_HOURS, MOMENTUM_DAYS, NEUTRAL_BAND,
  chartBand, classifyAsset, combine, describe, fundamentalBand, isFalling, return60,
  type AssetKind, type Bar, type FairValue,
} from '../trading/fairValue.js';
import { MAX_SCREENING_LOOKUPS, runScreening } from '../trading/screening.js';
import {
  baseCloseFor, classifyDisclosure, pickCatalysts, previousWeekday,
  type CatalystPick, type DayClose, type DisclosureRow,
} from '../trading/disclosureCatalyst.js';

/** 한 회차에 볼 보유 종목 수 상한 */
const MAX_SYMBOLS = 12;

/**
 * ── 후보 발굴 (2026-09-03) ───────────────────────────────────────────────
 *
 * 사용자가 정했다 — *"보유하지 않는 종목과 주식에 대해서도 적정가 분석을 하는데
 * 워낙 많을 것이니 적정한 기준을 잡고 그 기준 안에서 추천해주는 것도 있으면
 * 좋을 것 같아."*
 *
 * ★ **기준이 곧 이 상수들이다.** 전 종목 3,900개를 5분마다 잴 수는 없고,
 *   잰다 해도 대부분은 살 수 없는 종목이다(유동성·가격).
 *
 *   ① **거래대금 상위** — 자금이 실제로 도는 곳. 여기 없으면 사도 못 판다
 *   ② **차트 6개월** — 적정가를 낼 수 있어야 후보다(`chartBand`가 없으면 뺀다)
 *   ③ **문턱을 넘게 싸야** 추천한다 — 그냥 목록은 판단자에게 짐이다
 *
 * ★ 개별 주식만 후보로 본다. ETF는 층 배분의 문제이지 "싸서 사는" 것이 아니다.
 */
/**
 * ★★ **KIS 거래대금 순위 TR은 30종목이 상한이다** (2026-09-03 실측: 200을
 *    요청해도 30이 온다). 그 30에서 ETF를 빼면 개별주식이 14종목뿐이고,
 *    그중 기준을 넘는 것이 하나 나올까 말까다 — **후보가 없는 것이 아니라
 *    후보를 안 본 것이었다.**
 *
 * 그래서 소스를 **DB의 20일 평균 거래대금**으로 바꾼다(`getTopTurnoverInstruments`).
 * 일봉 저장소에 21년치가 있으므로 원하는 만큼 넓힐 수 있고 KIS 호출도 0이다.
 *
 * ★ 넓히는 값은 **시세 호출 수**로 정한다. 멀티시세가 30종목에 1회이므로
 *   150종목이면 5회다(2026-07-31 실측: 300종목 10회가 1.08초).
 */
/*
 * ★★ **150에서 900으로 넓혔다** (2026-09-09).
 *
 * 사용자가 물었다 — *"전체 종목을 스캔하는 게 맞아?"* 재보니 국내 개별주식
 * 2,765종목 중 **155종목(5.6%)**만 보고 있었다.
 *
 * ★ 900인 이유는 **유동성**이다. 20일 평균 거래대금 10억 이상이 895종목이고,
 *   총자산 9,600만원에 한 종목 상한 10%(960만원)를 넣으려면 그 정도는 돌아야
 *   한다. 하루 거래대금 1억짜리에 960만원이면 그날 거래의 10%가 되어 사고 파는
 *   값 자체를 우리가 밀어 올린다. 그 아래는 **사도 못 파는 종목**이다.
 *
 * ★ **먼저 재무를 채웠다.** 적정가는 차트·재무 두 축의 평균인데 재무가 없으면
 *   차트 하나로만 내고, 그러면 gap이 곧 낙폭이 된다 — 판단자가 무너진 종목의
 *   순위표를 받는다. 재무 캐시를 168 → 875종목으로 채운 뒤에 넓혔다
 *   (`warmFinancialCache.ts`).
 */
const CANDIDATE_POOL = 900;

/**
 * ── 📈 오늘 오르는 후보 (2026-09-11) ─────────────────────────────────────
 *
 * 사용자가 정했다 — *"정식 회차 발굴기를 빠른 회차에도 보여준다."* 그 앞에 —
 * *"발굴은 분석가가 빠른회차마다 분석해서 보여주는 것이고 … 매매도 빠른회차마다
 * 진행이 되어야 해."*
 *
 * ⭐는 적정가 대비 **싼 것**이라 정의상 떨어진 종목만 올라온다. 빠른 회차가
 * 사고팔게 된 뒤에도 오르는 종목은 판단자 앞에 한 번도 오지 않았다.
 *
 * ★ **정식 회차와 같은 코드**(`runScreening`)로 훑는다 — 거래대금 상위 300 중
 *   유동성·비용·호가 문턱을 통과한 것. 여기서 따로 고르면 두 회차가 서로 다른
 *   후보를 본다.
 * ★ 개별주식만, 보유 제외, **오늘 오른 것**만 많이 오른 순으로 자른다. ETF를 빼는
 *   이유는 ⭐와 같다. 5인 이유도 ⭐와 같다 — 판단자가 한 회차에 볼 수 있는 만큼이다.
 *
 * ★★ **📈로는 판단자를 부르지 않는다** (2026-09-11 12:23, 사용자가 정했다).
 *
 * 📈는 "이미 오른 것"이다. 첫 소집(12:07)에서 판단자가 5종목을 전부 "이미 올라
 * 손절선을 둘 자리가 없다·오른 원인이 없다"로 걸렀고, 사용자가 짚었다 —
 * *"오를만한 것들로 브리핑을 해줘야지 이미 오른 걸 가지고 뭐하려고?"*
 * 화면에는 남기고(참고), 소집하지 않는다. 이 자리는 "재료가 막 나온 종목"이 대신한다.
 */
const RISER_LIMIT = 10;

/**
 * ── 📣 재료가 막 나온 종목 (2026-09-11) ──────────────────────────────────
 *
 * 사용자가 정했다 — *"오를만한 것들로 브리핑을 해줘야지 이미 오른 걸 가지고
 * 뭐하려고?"* 그리고 고른 기준이 "재료가 막 나온 종목"이다. 최근 2거래일 공시에
 * 호재가 붙었는데 **공시 직전 종가 대비 아직 덜 움직인** 종목을 보인다.
 * 판정 규칙과 탐침 기록은 `trading/disclosureCatalyst.ts` 머리 주석에 있다.
 */
/**
 * 📣 켜고 끄기. 2026-09-11 13:38에 껐다가(분석가가 12:41부터 끝나지 않았다) 시간 예산
 * (`CATALYST_BUDGET_MS`)과 끊긴 채우기 잇기(`syncDisclosures`)를 넣고 13:45에 다시 켰다.
 */
const CATALYSTS_ENABLED = true;
const CATALYST_LIMIT = 20;
/** 공시 직전 종가 대비 이보다 더 올랐으면 "이미 반영됐다"로 본다 */
const CATALYST_MAX_MOVE = 0.05;
/** 📣를 훑은 기록 이름. `risers-scan`과 같은 규칙으로 0건·실패를 가른다 */
const CATALYSTS_HEARTBEAT = 'catalyst-scan';
/** KIS 뉴스 제목 TR의 제공업체 코드 — 거래소 공시(`F`)·코스닥 공시(`G`). 2026-09-11 탐침 */
const DISCLOSURE_PROVIDERS = ['F', 'G'];
/** 한 회차에 거슬러 갈 최대 쪽수(쪽당 40건). 이틀치를 채우는 데 업체마다 7~8쪽이 들었다 */
const DISCLOSURE_MAX_PAGES = 10;
/** 공시 쪽 사이 간격 — 700ms에서 초당 한도(`EGW00201`)에 걸렸다(분석가·판단자와 겹친 탓) */
const DISCLOSURE_GAP_MS = 1100;
/** 한 회차에 기준가를 구하려고 부를 일봉 수 상한. 구한 값은 표에 남아 다시 안 부른다 */
const CATALYST_MAX_CANDLE_CALLS = 20;
const CANDLE_GAP_MS = 600;
/**
 * 📣 채우기(공시 쪽·기준가 일봉)에 쓰는 시간 상한. 넘기면 멈추고 가진 것으로 고른다 —
 * 채우던 것은 다음 회차가 잇는다.
 *
 * ★★ 없어서 났다 (2026-09-11 12:41). 첫 실행이 공시를 채우다 끝나지 않았고, 스케줄러의
 *    20분 시한은 셸만 끊어 `node`가 13:35까지 남았다 — 그동안 분석가·⭐·판단자 소집이 전부
 *    멈췄다. 같은 시간 `open-orders`도 12:49~13:22 기록이 없어 KIS가 느렸던 것으로 보이지만,
 *    출력이 남지 않아 확인하지 못했다.
 */
const CATALYST_BUDGET_MS = 60_000;
/** 📈를 훑은 기록 이름. 몇 건이었는지·못 훑었는지를 판단자 화면이 여기서 읽는다 */
const RISERS_HEARTBEAT = 'risers-scan';
/** `scripts/deliberate.sh`가 잡는 락. 판단자가 도는 중인지 여기서 본다 */
const DELIBERATE_LOCK = '.cron-logs/deliberate.lock';
/** 이보다 싸야 **절대 기준**으로 추천한다. 판단자를 부르는 문턱(−7%)보다 엄하게 잡는다 */
const RECOMMEND_GAP = -0.10;
/**
 * 분석가에게 넘기는 ⭐ 수. 2026-09-15에 5 → 20 — 사용자가 *"모든 종목에 대한 내용을 봐줘야"*라고 했다.
 * 문턱 통과는 하루 100건을 넘는다(9/15 117건)라 전부는 한 바퀴에 못 본다 — 싼 순으로 자른다.
 */
const RECOMMEND_LIMIT = 20;
/** 슬랙 브리핑에는 목록마다 이만큼만 — 분석가 루프가 4분마다 보내므로 길면 소음이 된다 */
const SLACK_SHOWN = 5;

/**
 * ── ★★ 두 번째 기준: **오늘 후보 사이의 순위** (2026-09-03) ────────────
 *
 * 처음엔 절대 기준 하나만 두었다. 그날 재보니 **13종목 중 추천 0건**이었고,
 * 가장 싼 것이 −4.4%(삼성전자우), 나머지는 +1.6% ~ +145.1%였다.
 *
 * ★★ **문턱을 잘못 잡은 것이 아니라 잼는 법이 그렇다.** 차트 축은 6개월
 *    분포 대비로 재는데, 시장이 6개월간 올랐으면 **지금 값이 항상 그 위에 있다.**
 *    삼성전자 +43%는 "고평가"가 아니라 "6개월 전보다 많이 올랐다"는 말이다.
 *    이미 빠른 판단자 프롬프트에 적어 둔 경고가 실제로 일어난 것이다.
 *
 * 그래서 **같은 날 후보끼리 줄을 세운다.** 시장 전체의 오르내림은 모두에게
 * 같이 얽혀 있으므로, 서로 빼면 상쇄된다. 이 레포가 21년 측정에서 쓴
 * 분위 나누기와 같은 원리다.
 *
 * ★ **그래도 절대 기준을 안 버린다.** 둘 중 하나라도 맞으면 올리고, **어느
 *   기준으로 올라왔는지를 적는다.** 하락장이 오면 상대 기준은 반대로
 *   고장난다 — 전부 싸다고 할 때 가장 덜 싼 것을 골라 올린다. 두 기준이
 *   서로의 구멍을 메운다.
 */
/** 오늘 후보 중 싸기 하위 이만큼을 상대 기준으로 올린다 */
const RECOMMEND_PERCENTILE = 0.2;
/** 분포가 이보다 적으면 "하위 20%"가 뜻이 없다 — 상대 기준을 안 쓴다 */
const MIN_CANDIDATES_FOR_RANK = 8;
/**
 * ★ 상대 기준에도 **천장**이 있다. 첫 판에서 알테오젠이 **+2.2%(비싸다)**인데
 *   하위 20%라는 이유로 ⭐를 달고 올라왔다 — 줄에는 "비싸다"고 적혀 있는데
 *   추천이라 부르면 그 둘 중 하나는 거짓말이다.
 *
 * ★★ **순위가 아무리 낮아도 비싼 것은 추천하지 않는다.** 후보 전부가 비싼
 *    날에는 추천이 0건인 것이 맞다 — 그것이 그날의 사실이다. `describe()`가
 *    "비싸다"를 붙이는 문턱 그 자체(`NEUTRAL_BAND`)를 가져다 쓴다 — 숫자를
 *    베껴 적었더니 5% vs 2%로 어긋나 같은 종목이 "비싸다"이면서 추천이었다.
 */
const RELATIVE_CEILING = NEUTRAL_BAND;

/*
 * ★ 재무 캐시 TTL은 `trading/fairValue.ts`에 있다 — 받는 쪽
 *   (`warmFinancialCache.ts`)과 같은 값을 써야 해서 한 곳에 모았다.
 *   프로세스가 매번 새로 뜨므로 **DB에 캐시한다** — 메모리 캐시는 소용없다.
 */

async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_financial_cache (
      symbol     TEXT PRIMARY KEY,
      payload    JSONB NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    /*
     * 적정가를 남긴다. **나중에 채점하려면 그때 무엇이라고 했는지가 있어야 한다** —
     * 30일 뒤 실제 주가와 대조해 "이 적정가가 값어치가 있었나"를 답한다.
     */
    CREATE TABLE IF NOT EXISTS trading_fair_values (
      symbol       TEXT NOT NULL,
      measured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      price        DOUBLE PRECISION NOT NULL,
      chart_mid    DOUBLE PRECISION,
      fundamental_mid DOUBLE PRECISION,
      gap          DOUBLE PRECISION,
      basis        TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (symbol, measured_at)
    );
    CREATE INDEX IF NOT EXISTS trading_fair_values_time_idx
      ON trading_fair_values (measured_at DESC);
    /*
     * ★★ **급락 판정을 함께 남긴다** (2026-09-10).
     *
     * 그전에는 이 판정을 계산해 ⭐추천에서 빼는 데만 쓰고 **버렸다.** 그래서
     * 판단자 화면(showFairValues.ts)은 gap 오름차순 25칸을 그냥 찍었고,
     * 그 25칸은 정의상 **가장 많이 떨어진 것들**이 독점했다. 판단자가 회차마다
     * 같은 말을 남긴 이유다 — *"가장 싼 여섯은 전부 '떨어졌다'이지 '싸다'가 아니다."*
     *
     * ★ 남겨야 **나중에 채점할 수 있다.** 이 필터가 옳았는지는 "그때 급락이라고
     *   판정한 것들이 그 뒤 어떻게 됐나"로만 답할 수 있고, 그러려면 그때의
     *   판정이 있어야 한다. 이 표가 적정가를 남기는 이유와 같다.
     */
    ALTER TABLE trading_fair_values ADD COLUMN IF NOT EXISTS falling BOOLEAN NOT NULL DEFAULT false;
    -- ★★ 종목별 뉴스(2026-09-11). 별표 종목과 보유 개별주식에만 채운다.
    --   배열이면 받은 기사, failed 객체면 못 받은 것, NULL이면 안 받은 것이다 — 셋을 섞지 않는다.
    ALTER TABLE trading_fair_values ADD COLUMN IF NOT EXISTS news JSONB;

    /*
     * ★★ **⭐ 추천을 남긴다** (2026-09-09).
     *
     * 그전에는 추천을 계산해 **슬랙으로 보내고 버렸다.** 그래서 판단자가 보는
     * 화면(showFairValues.ts)에는 ⭐가 없었고, 판단자는 155줄짜리 적정가 표를
     * 눈으로 훑어야 했다. 회차 542·543이 연달아 그것을 적었다 —
     * "화면이 ⭐ 추천 섹션을 찍지 않는다.".
     *
     * 후보를 900종목으로 넓히면 그 표가 900줄이 된다. 남기지 않으면 넓히는 것이
     * 판단자에게는 **짐만 늘리는 일**이 된다.
     *
     * ★ rule을 함께 넣는다. "하위 20%"는 *싸다*가 아니라 *오늘 후보 중 덜
     *   비싸다*이고, 그 문장이 없으면 판단자가 ⭐를 매수 신호로 읽는다.
     */
    CREATE TABLE IF NOT EXISTS trading_fair_value_picks (
      measured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      symbol      TEXT NOT NULL,
      standard    TEXT NOT NULL,
      rule        TEXT NOT NULL DEFAULT '',
      gap         DOUBLE PRECISION,
      PRIMARY KEY (measured_at, symbol)
    );
    CREATE INDEX IF NOT EXISTS trading_fair_value_picks_time_idx
      ON trading_fair_value_picks (measured_at DESC);

    /*
     * ★★ 📈 오늘 오르는 후보 (2026-09-11). 정식 회차와 같은 스크리너(runScreening)가
     * 통과시킨 것 중 개별주식·보유 제외·오늘 오른 순. 판단자 화면(showFairValues.ts)이 읽는다.
     *
     * ★ 한 회차가 한 measured_at을 공유한다. 0건이었는지·못 훑었는지는 이 표가 아니라
     *   trading_heartbeats의 risers-scan 기록이 말하고, 성공 기록의 ran_at이 이 measured_at과 같다.
     * ★ 남겨야 나중에 채점할 수 있다 — "그때 오르던 것을 샀으면 어땠나".
     */
    CREATE TABLE IF NOT EXISTS trading_screening_risers (
      measured_at TIMESTAMPTZ NOT NULL,
      symbol      TEXT NOT NULL,
      name        TEXT NOT NULL,
      price       DOUBLE PRECISION NOT NULL,
      change_rate DOUBLE PRECISION NOT NULL,
      turnover    DOUBLE PRECISION NOT NULL,
      range_rate  DOUBLE PRECISION,
      rule        TEXT NOT NULL DEFAULT '',
      news        JSONB,
      PRIMARY KEY (measured_at, symbol)
    );
    CREATE INDEX IF NOT EXISTS trading_screening_risers_time_idx
      ON trading_screening_risers (measured_at DESC);

    /*
     * ★★ 공시를 쌓는다 (2026-09-11, 📣 재료가 막 나온 종목). KIS 뉴스 제목 TR의
     * 거래소·코스닥 공시만. srno는 KIS의 내용 조회용 일련번호다.
     * ★ base_close는 공시 직전 종가 — 한 번 구하면 바뀌지 않으므로 여기 남겨 다시 안 부른다.
     */
    CREATE TABLE IF NOT EXISTS trading_disclosures (
      srno           TEXT PRIMARY KEY,
      provider       TEXT NOT NULL,
      published_day  TEXT NOT NULL,
      published_time TEXT NOT NULL,
      symbol         TEXT NOT NULL,
      name           TEXT NOT NULL DEFAULT '',
      title          TEXT NOT NULL,
      base_day       TEXT,
      base_close     DOUBLE PRECISION,
      fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS trading_disclosures_day_idx
      ON trading_disclosures (published_day DESC, published_time DESC);
    -- 업체별로 공시를 빈틈없이 가진 구간(YYYYMMDDHHMMSS). complete_from~complete_to 사이는 다 받았다.
    CREATE TABLE IF NOT EXISTS trading_disclosure_sync (
      provider      TEXT PRIMARY KEY,
      complete_from TEXT NOT NULL,
      complete_to   TEXT NOT NULL,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    /*
     * 📣 한 회차의 목록. 0건·못 훑음은 trading_heartbeats의 catalyst-scan 기록이 말하고,
     * 성공 기록의 ran_at이 이 measured_at과 같다(📈와 같은 규칙).
     * ★ 남겨야 나중에 채점할 수 있다 — "재료가 나왔는데 덜 움직인 것을 샀으면 어땠나".
     */
    CREATE TABLE IF NOT EXISTS trading_catalyst_picks (
      measured_at    TIMESTAMPTZ NOT NULL,
      symbol         TEXT NOT NULL,
      name           TEXT NOT NULL,
      labels         TEXT NOT NULL,
      title          TEXT NOT NULL,
      published_day  TEXT NOT NULL,
      published_time TEXT NOT NULL,
      correction     BOOLEAN NOT NULL DEFAULT false,
      base_day       TEXT NOT NULL,
      base_close     DOUBLE PRECISION NOT NULL,
      price          DOUBLE PRECISION NOT NULL,
      move           DOUBLE PRECISION NOT NULL,
      warnings       TEXT NOT NULL DEFAULT '',
      rule           TEXT NOT NULL DEFAULT '',
      news           JSONB,
      PRIMARY KEY (measured_at, symbol)
    );
    CREATE INDEX IF NOT EXISTS trading_catalyst_picks_time_idx
      ON trading_catalyst_picks (measured_at DESC);
  `);
}

async function cachedFinancials(symbol: string): Promise<FinancialSnapshot[]> {
  const { rows } = await pool.query<{ payload: FinancialSnapshot[] }>(
    `SELECT payload FROM trading_financial_cache
      WHERE symbol = $1 AND fetched_at > now() - ($2 || ' hours')::interval`,
    [symbol, String(FINANCIAL_TTL_HOURS)],
  );
  if (rows[0]) return rows[0].payload;
  const fresh = await getFinancials(symbol, 8).catch(() => [] as FinancialSnapshot[]);
  await pool.query(
    `INSERT INTO trading_financial_cache (symbol, payload, fetched_at) VALUES ($1, $2, now())
     ON CONFLICT (symbol) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
    [symbol, JSON.stringify(fresh)],
  );
  return fresh;
}

/**
 * **그 종목 자신의 과거 배수**를 일봉과 BPS·EPS로 낸다.
 *
 * ★ 업종 평균을 쓰지 않는 이유는 `trading/fairValue.ts`에 적었다.
 * ★ 과거 재무는 분기 시점의 것인데 우리는 **최신 BPS 하나**만 쓴다 —
 *   그래서 이 배수는 **근사**다. 그 사실을 `basis`에 적어 판단자가 알게 한다.
 */
function pastMultiples(bars: Bar[], value: number | undefined):
{ low: number; mid: number; high: number } | null {
  if (value === undefined || !(value > 0) || bars.length < 120) return null;
  // 최근 2년(약 492거래일)의 배수 분포. 그보다 옛날은 회사가 다른 회사다.
  const recent = bars.slice(-492).map((b) => b.close / value).filter((r) => r > 0);
  if (recent.length < 120) return null;
  const sorted = [...recent].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.floor((sorted.length - 1) * q)];
  return { low: at(0.25), mid: at(0.5), high: at(0.75) };
}

/**
 * **시장 전체의 60일 수익률 중앙값.** 추세 축의 기준선이다.
 *
 * ★★ **후보 집합이 아니라 전 종목에서 낸다** (2026-09-03에 고쳤다).
 *
 * 처음에는 오늘 후보(거래대금 상위 150)의 중앙값을 썼다. 그런데 그 값이
 * **−12.3%**로 전 종목 중앙 **−7.6%**보다 훨씬 낮았다 — 거래대금 상위는
 * 대형주 편향이 있어 그날 더 빠져 있었다. 문턱(−20%p)은 전 종목 분포를 재서
 * 정한 값이라, 기준선이 4.7%p 내려앉은 만큼 **문턱이 느슨해져** 걸러야 할
 * 리가켐바이오(−18.0%p)·현대로템(−19.6%p)이 그대로 통과했다.
 *
 * ★ 쿼리 한 번이고 일봉은 이미 DB에 있다 — 정확한 쪽이 싸다.
 */
async function marketMedianReturn60(): Promise<number | null> {
  const { rows } = await pool.query<{ med: string | null }>(
    `WITH ranked AS (
       SELECT symbol, close,
              row_number() OVER (PARTITION BY symbol ORDER BY trading_day DESC) AS rn
         FROM trading_daily_bars
        WHERE trading_day >= to_char(current_date - 300, 'YYYYMMDD')
     ), pivot AS (
       SELECT symbol,
              max(close) FILTER (WHERE rn = 1) AS c0,
              max(close) FILTER (WHERE rn = $1) AS cn
         FROM ranked WHERE rn IN (1, $1) GROUP BY symbol
     )
     SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY c0 / cn - 1)::text AS med
       FROM pivot WHERE c0 > 0 AND cn > 0`,
    [MOMENTUM_DAYS + 1],
  );
  const med = rows[0]?.med;
  return med === null || med === undefined ? null : Number(med);
}

/**
 * ── ★★ 종목별 뉴스 (2026-09-11) ─────────────────────────────────────────
 *
 * 빠른 회차 지침은 *"웹서치를 하지 마세요 — 뉴스는 적정가 표에 붙어 옵니다"*라고
 * 약속했는데 **표에는 뉴스 칸이 없었다.** 뉴스는 슬랙으로만 갔고, 그마저 네이버
 * 주요 뉴스 12건을 종목 이름으로 대조하는 방식이라 900종목 앞에서는 거의 늘 비었다.
 * 판단자가 회차 1311~1363 내내 같은 말을 남겼다 — *"⭐ 종목이 왜 떨어졌는지 판단할
 * 재료가 없고, 뉴스가 없는 한 ⭐는 계속 걸러질 것입니다."*
 */
/** 종목당 붙일 기사 수 — 목록형 기사("기술적 분석 특징주")가 섞여 오므로 넉넉히 */
const NEWS_PER_SYMBOL = 6;
/** 이보다 오래된 기사는 "왜 지금 이 값인가"에 답하지 못한다 */
const NEWS_MAX_AGE_DAYS = 14;
/** 종목 사이 간격 — 간격 없이 부르면 12종목 중 2종목을 초당 한도로 잃었다(2026-09-03 장중 뉴스 감시) */
const NEWS_GAP_MS = 250;

/** 배열이면 받은 기사, `{failed}`면 못 받은 것 — "0건"과 "못 받음"을 섞지 않는다 */
type NewsCell = Array<{ title: string; source: string; publishedAt?: number }> | { failed: string };

async function fetchNewsCell(symbol: string): Promise<NewsCell> {
  const instrument = await getKoreanInstrumentBySymbol(symbol);
  if (!instrument) return { failed: '종목 마스터에 없다' };
  try {
    // ★ publishedAt은 **초**다 — 밀리초로 읽으면 1970년이 나온다(NewsItem 주석).
    const cutoff = Date.now() / 1000 - NEWS_MAX_AGE_DAYS * 86_400;
    return (await getInstrumentNews(instrument))
      .filter((n: NewsItem) => n.publishedAt === undefined || n.publishedAt >= cutoff)
      .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
      .slice(0, NEWS_PER_SYMBOL)
      .map((n) => ({ title: n.title, source: n.source, publishedAt: n.publishedAt }));
  } catch (error) {
    return { failed: (error as Error).message.slice(0, 80) };
  }
}

/** 📈 한 줄 */
interface Riser {
  symbol: string;
  name: string;
  price: number;
  /** 등락률(%) */
  changeRate: number;
  /** 오늘 거래대금(원) */
  turnover: number;
  /** 오늘 변동폭(%). 모르면 undefined */
  rangeRate?: number;
}

/**
 * 📈 오늘 오르는 후보를 뽑아 **남긴다** (위 `RISER_LIMIT` 주석).
 *
 * ★★ **"0건"과 "못 훑었다"를 가른다.** 회차마다 `RISERS_HEARTBEAT` 기록 한 줄에
 *    어느 쪽인지 적는다 — 0건이면 줄은 없고 기록만 있다. 섞으면 판단자는
 *    "오르는 게 없구나"로 읽는다.
 * ★ 성공 기록의 `ran_at`을 줄들의 `measured_at`과 **같은 시각**으로 적는다. 화면이
 *   그 시각의 줄만 읽으므로, 0건인 회차에 옛 회차의 줄이 오늘 것처럼 보이지 않는다.
 * ★ 실패해도 적정가·⭐는 막지 않는다. 이 회차는 📈 없이 끝나고 `null`을 돌려준다.
 */
async function discoverRisers(held: Set<string>, cash: number | null): Promise<Riser[] | null> {
  const record = (status: 'ok' | 'failed', note: string, at: Date): Promise<unknown> => pool.query(
    'INSERT INTO trading_heartbeats (name, status, note, ran_at) VALUES ($1, $2, $3, $4)',
    [RISERS_HEARTBEAT, status, note, at],
  ).catch(() => undefined);

  if (cash === null) {
    await record('failed', '계좌를 못 읽어 예수금을 모른다 — 훑지 않았다', new Date());
    return null;
  }
  const started = Date.now();
  /*
   * ★ **300으로 부른다** — 정식 회차가 `screenCandidates <계좌> 300`으로 부르는 그 값이다.
   *   기본값(`DEFAULT_SCREENING_LOOKUPS`)은 120이라, 첫 실행이 "거래대금 상위 120"만 봤다.
   */
  const result = await runScreening(cash, MAX_SCREENING_LOOKUPS).catch((error: Error) => error);
  if (result instanceof Error) {
    await record('failed', result.message.slice(0, 80), new Date());
    return null;
  }

  // ★ 이미 등락률 내림차순이다(`runScreening`이 정렬해 돌려준다).
  const passed = result.rows.filter((row) => row.verdict === 'pass');
  const risers: Riser[] = [];
  for (const row of passed) {
    if (risers.length >= RISER_LIMIT || row.changeRate <= 0) break;
    if (held.has(row.symbol)) continue;
    const instrument = await getKoreanInstrumentBySymbol(row.symbol);
    if (classifyAsset(row.name, instrument?.assetType) !== 'stock') continue;
    risers.push({
      symbol: row.symbol, name: row.name, price: row.price, changeRate: row.changeRate,
      turnover: row.turnover, rangeRate: row.rangeRate,
    });
  }

  const rule = `거래대금 상위 ${result.poolSize}(스크리너 통과 ${passed.length}) 중`
    + ` 개별주식·보유 제외·오늘 오른 순 ${RISER_LIMIT}건`;
  const stamped = new Date();
  for (const r of risers) {
    // ★ "왜 오르나"를 판단자가 여기서 본다 — ⭐의 "왜 떨어졌나"와 같은 칸이다.
    const cell = await fetchNewsCell(r.symbol);
    await pool.query(
      `INSERT INTO trading_screening_risers
         (measured_at, symbol, name, price, change_rate, turnover, range_rate, rule, news)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (measured_at, symbol) DO NOTHING`,
      [stamped, r.symbol, r.name, r.price, r.changeRate, r.turnover, r.rangeRate ?? null, rule,
        JSON.stringify(cell)],
    );
    await sleep(NEWS_GAP_MS);
  }
  await record('ok', `${risers.length}건 · ${rule} · ${Math.round((Date.now() - started) / 1000)}초`, stamped);
  return risers;
}

/**
 * 판단자가 지금 도는 중인가 — `scripts/deliberate.sh`의 락(`mkdir` + pid)을 그대로 읽는다.
 *
 * ★★ 도는 중에 부르면 새 판단자는 "이미 돌고 있다 — 건너뛴다"로 끝나는데, 이쪽은
 *    그 신호를 **보여 준 것으로 적어 버린다.** 그러면 다음 회차에는 "직전과 같다"가
 *    되어 그 신호가 판단자 앞에 영영 안 온다. 📈는 오늘 보여 준 이름을 다시 안
 *    부르므로 이 구멍이 더 크다.
 * ★ 죽은 락(pid가 없는 것)은 도는 중으로 치지 않는다 — `deliberate.sh`가 스스로 걷는다.
 */
function judgeRunning(repoRoot: string): number | null {
  const lock = join(repoRoot, DELIBERATE_LOCK);
  if (!existsSync(lock)) return null;
  try {
    const pid = Number(readFileSync(join(lock, 'pid'), 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

type KisAccount = NonNullable<ReturnType<typeof getKisAccount>>;

/**
 * 거래소·코스닥 공시를 `since`(`YYYYMMDDHHMMSS`)까지 **빈틈없이** 쌓는다.
 *
 * 업체마다 "빈틈없이 가진 구간"(`trading_disclosure_sync`)을 기억하고 두 방향으로 채운다:
 *
 *   ① **머리** — 지금부터 과거로, 가진 구간의 끝(`complete_to`)에 닿을 때까지. 5분마다는
 *      업체당 한 쪽이면 된다. 닿지 못하면(시간·쪽수 상한) 구간을 늘리지 않는다 — 다음
 *      회차가 처음부터 다시 걷는다(받은 행은 남아 있어 헛일이 아니다).
 *   ② **꼬리** — 가진 구간의 시작(`complete_from`)이 `since`보다 뒤면 거기서 더 거슬러 간다.
 *      쪽마다 시작을 옮겨 적으므로 끊겨도 이어진다.
 *
 * ★★ 이 구간이 없던 첫 판(2026-09-11 12:41)에서 코스닥 공시가 3쪽에서 끊겼고, 다음 회차는
 *    첫 쪽에서 "이미 가졌다"로 멈춰 **9/10 16:06 이전이 영영 비었다.**
 * ★ 쪽을 넘기는 시각은 **종목코드 없는 행까지 포함한** 마지막 행으로 잡는다. 코드가 붙은
 *   행만 보고 넘기면 그 사이 행을 건너뛴다.
 * ★ `deadline`을 넘기면 멈추고 `partial`로 알린다.
 * ★ `probeKisTr`로 부른다. 원본 응답이 필요한데 `kisGet`은 `rest.ts` 안에만 있고,
 *   `rest.ts`는 서버가 import해서 장중에 고치면 백엔드가 재시작된다. 장 밖에
 *   `rest.ts`의 조회 함수로 옮길 자리다.
 */
async function syncDisclosures(
  account: KisAccount, since: string, deadline: number,
): Promise<{ added: number; calls: number; failed: string | null; partial: boolean }> {
  let added = 0;
  let calls = 0;
  let partial = false;

  /** 한 쪽(40건)을 받아 쌓는다. 실패면 문구, 빈 쪽이면 `null`, 아니면 쪽의 시각 범위 */
  const fetchPage = async (
    provider: string, date: string, hour: string,
  ): Promise<{ failed: string } | { newest: string; oldest: string } | null> => {
    const params = {
      FID_NEWS_OFER_ENTP_CODE: provider, FID_COND_MRKT_CLS_CODE: '', FID_INPUT_ISCD: '',
      FID_TITL_CNTT: '', FID_INPUT_DATE_1: date ? `00${date}` : '', FID_INPUT_HOUR_1: hour ? `00${hour}` : '',
      FID_RANK_SORT_CLS_CODE: '', FID_INPUT_SRNO: '',
    };
    let res = await probeKisTr(account, '/uapi/domestic-stock/v1/quotations/news-title', 'FHKST01011800', params);
    calls += 1;
    if (!res.ok && res.code === 'EGW00201') {
      // 초당 한도는 기다리면 풀린다. 한 번만 다시 부른다.
      await sleep(DISCLOSURE_GAP_MS * 2);
      res = await probeKisTr(account, '/uapi/domestic-stock/v1/quotations/news-title', 'FHKST01011800', params);
      calls += 1;
    }
    await sleep(DISCLOSURE_GAP_MS);
    if (!res.ok) return { failed: `${provider} ${res.code} ${res.message}`.slice(0, 80) };

    const rows = ((res.body?.output ?? []) as Array<Record<string, string>>).filter((r) => r.data_dt && r.data_tm);
    if (rows.length === 0) return null;
    for (const r of rows) {
      if (!r.cntt_usiq_srno || !r.iscd1) continue;
      const { rowCount } = await pool.query(
        `INSERT INTO trading_disclosures (srno, provider, published_day, published_time, symbol, name, title)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (srno) DO NOTHING`,
        [r.cntt_usiq_srno, provider, r.data_dt, r.data_tm, r.iscd1, r.kor_isnm1 ?? '', r.hts_pbnt_titl_cntt ?? ''],
      );
      added += rowCount ?? 0;
    }
    const stamp = (r: Record<string, string>): string => `${r.data_dt}${r.data_tm}`;
    return { newest: stamp(rows[0]), oldest: stamp(rows[rows.length - 1]) };
  };

  for (const provider of DISCLOSURE_PROVIDERS) {
    const cover = (await pool.query<{ complete_from: string; complete_to: string }>(
      'SELECT complete_from, complete_to FROM trading_disclosure_sync WHERE provider = $1',
      [provider],
    )).rows[0] as { complete_from: string; complete_to: string } | undefined;
    // 가진 구간이 since보다 옛것이면 since까지만 가면 된다.
    const fresh = cover !== undefined && cover.complete_to > since;
    const target = fresh ? cover.complete_to : since;

    // ① 머리 — 지금부터 target까지
    let date = '';
    let hour = '';
    let newest: string | null = null;
    let reached: string | null = null;
    for (let n = 0; n < DISCLOSURE_MAX_PAGES; n += 1) {
      if (Date.now() > deadline) { partial = true; break; }
      const got = await fetchPage(provider, date, hour);
      if (got === null) { reached = target; break; }
      if ('failed' in got) return { added, calls, failed: got.failed, partial };
      if (newest === null) newest = got.newest;
      if (got.oldest <= target) { reached = got.oldest; break; }
      // 제자리 — 같은 시각의 행이 한 쪽을 넘는다. 더 걸어도 같은 쪽이 온다.
      if (got.oldest === `${date}${hour}`) break;
      date = got.oldest.slice(0, 8);
      hour = got.oldest.slice(8);
    }
    let from: string | null = cover?.complete_from ?? null;
    if (reached !== null && newest !== null) {
      from = fresh && cover !== undefined ? cover.complete_from : reached;
      await pool.query(
        `INSERT INTO trading_disclosure_sync (provider, complete_from, complete_to) VALUES ($1,$2,$3)
         ON CONFLICT (provider) DO UPDATE SET complete_from = $2, complete_to = $3, updated_at = now()`,
        [provider, from, newest],
      );
    }

    // ② 꼬리 — 가진 구간의 시작이 since보다 뒤면 거기서부터 더 거슬러 간다
    if (from !== null && from > since) {
      let cursor = from;
      for (let n = 0; n < DISCLOSURE_MAX_PAGES && cursor > since; n += 1) {
        if (Date.now() > deadline) { partial = true; break; }
        const got = await fetchPage(provider, cursor.slice(0, 8), cursor.slice(8));
        if (got === null) break;
        if ('failed' in got) return { added, calls, failed: got.failed, partial };
        if (got.oldest >= cursor) break;
        cursor = got.oldest;
        await pool.query(
          'UPDATE trading_disclosure_sync SET complete_from = $2, updated_at = now() WHERE provider = $1',
          [provider, cursor],
        );
      }
    }
  }
  return { added, calls, failed: null, partial };
}

interface StoredDisclosure {
  srno: string;
  symbol: string;
  name: string;
  title: string;
  published_day: string;
  published_time: string;
  base_day: string | null;
  base_close: number | null;
}

/**
 * 📣 재료가 막 나온 종목을 뽑아 **남긴다** (위 `CATALYST_LIMIT` 주석).
 *
 * ★ 0건·못 훑음을 가르는 법, 기록의 `ran_at` = 줄의 `measured_at`은 `discoverRisers`와 같다.
 * ★ 실패해도 적정가·⭐는 막지 않는다. 이 회차는 📣 없이 끝나고 `null`을 돌려준다.
 */
async function discoverCatalysts(
  account: KisAccount, held: Set<string>, poolSymbols: Set<string>, quotes: Map<string, number>,
): Promise<CatalystPick[] | null> {
  const record = (status: 'ok' | 'failed', note: string, at: Date): Promise<unknown> => pool.query(
    'INSERT INTO trading_heartbeats (name, status, note, ran_at) VALUES ($1, $2, $3, $4)',
    [CATALYSTS_HEARTBEAT, status, note, at],
  ).catch(() => undefined);

  const started = Date.now();
  const today = kstToday();
  const sinceDay = previousWeekday(today);
  const deadline = started + CATALYST_BUDGET_MS;
  const sync = await syncDisclosures(account, `${sinceDay}000000`, deadline);
  if (sync.failed !== null) {
    await record('failed', `공시를 못 받았다 — ${sync.failed}`, new Date());
    return null;
  }

  const { rows: stored } = await pool.query<StoredDisclosure>(
    `SELECT srno, symbol, name, title, published_day, published_time, base_day, base_close
       FROM trading_disclosures WHERE published_day >= $1`,
    [sinceDay],
  );
  const eligible = (symbol: string): boolean => poolSymbols.has(symbol) && !held.has(symbol);

  /*
   * ── 기준가(공시 직전 종가)가 없는 호재 공시만 일봉을 부른다 ──
   *
   * ★ DB 일봉 저장소가 아니라 KIS에 묻는다. 저장소는 전날 봉이 아직 없을 수 있다
   *   (2026-09-11 11시에 가장 최근 봉이 9/9였다).
   */
  const closesBySymbol = new Map<string, DayClose[]>();
  let candleCalls = 0;
  for (const s of stored) {
    if (s.base_close !== null || classifyDisclosure(s.title)?.tone !== 'good' || !eligible(s.symbol)) continue;
    if (!closesBySymbol.has(s.symbol)) {
      if (candleCalls >= CATALYST_MAX_CANDLE_CALLS || Date.now() > deadline) continue;
      candleCalls += 1;
      const candles = await getDailyCandles(s.symbol, 10).then((r) => r.candles).catch(() => []);
      // ★ 캔들의 time은 그 거래일 자정(UTC)의 초다(`fetchDailyCandlePage`).
      closesBySymbol.set(s.symbol, candles.map((c) => ({
        day: new Date(c.time * 1000).toISOString().slice(0, 10).replace(/-/g, ''), close: c.close,
      })));
      await sleep(CANDLE_GAP_MS);
    }
    const base = baseCloseFor(closesBySymbol.get(s.symbol) ?? [], s.published_day, s.published_time, today);
    if (base === null) continue;
    s.base_day = base.day;
    s.base_close = base.close;
    await pool.query(
      'UPDATE trading_disclosures SET base_day = $2, base_close = $3 WHERE srno = $1',
      [s.srno, base.day, base.close],
    );
  }

  const overBudget = sync.partial || Date.now() > deadline;
  const toRow = (s: StoredDisclosure): DisclosureRow => ({
    symbol: s.symbol, name: s.name, title: s.title, publishedDay: s.published_day, publishedTime: s.published_time,
  });
  const keyOf = (r: DisclosureRow): string => `${r.symbol}|${r.publishedDay}|${r.publishedTime}|${r.title}`;
  const bases = new Map<string, DayClose | null>(stored.map((s) => [
    keyOf(toRow(s)),
    s.base_day === null || s.base_close === null ? null : { day: s.base_day, close: s.base_close },
  ]));
  const result = pickCatalysts({
    rows: stored.map(toRow),
    eligible,
    price: (symbol) => quotes.get(symbol),
    base: (row) => bases.get(keyOf(row)) ?? null,
    maxMove: CATALYST_MAX_MOVE,
    limit: CATALYST_LIMIT,
  });

  const rule = `최근 2거래일(${sinceDay}~) 거래소·코스닥 공시 호재 · 공시 직전 종가 대비`
    + ` +${(CATALYST_MAX_MOVE * 100).toFixed(0)}% 이하 · 거래대금 상위 ${CANDIDATE_POOL} 개별주식·보유 제외`
    + ` · 최근 공시 순 ${CATALYST_LIMIT}건 (호재 ${result.eligible}종목 중 이미 오름 ${result.tooMoved}`
    + ` · 못 잼 ${result.unmeasured} · 풀 밖·보유 ${result.outside})`;
  const stamped = new Date();
  for (const p of result.picks) {
    const cell = await fetchNewsCell(p.symbol);
    await pool.query(
      `INSERT INTO trading_catalyst_picks
         (measured_at, symbol, name, labels, title, published_day, published_time, correction,
          base_day, base_close, price, move, warnings, rule, news)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
       ON CONFLICT (measured_at, symbol) DO NOTHING`,
      [stamped, p.symbol, p.name, p.labels.join('·'), p.latest.title, p.latest.publishedDay,
        p.latest.publishedTime, p.latest.correction, p.base.day, p.base.close, p.price, p.move,
        p.warnings.join('·'), rule, JSON.stringify(cell)],
    );
    await sleep(NEWS_GAP_MS);
  }
  await record(
    'ok',
    `${result.picks.length}건 · ${rule} · 공시 +${sync.added}건(호출 ${sync.calls}) · 일봉 ${candleCalls}회`
      + (overBudget ? ` · ★ 시간 예산 ${CATALYST_BUDGET_MS / 1000}초를 넘겨 채우기를 멈췄다 — 다음 회차가 잇는다` : '')
      + ` · ${Math.round((Date.now() - started) / 1000)}초`,
    stamped,
  );
  return result.picks;
}

/** 지금 KST로 장이 닫혔나(09:00~15:30 밖). 슬랙 머리말과 📈가 함께 쓴다 */
function krxClosedNow(): boolean {
  const clock = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date()).replace(':', ''));
  return clock >= 1530 || clock < 900;
}

interface Row {
  symbol: string;
  name: string;
  fv: FairValue;
  news: string[];
  /** 들고 있는 것인가. 브리핑에서 보유와 후보를 갈라 보여준다 */
  held: boolean;
  /** 60거래일 수익률. 못 내면 null */
  ret60: number | null;
}

async function main(): Promise<void> {
  // 화면이 자세를 바꾸는 근거. 실패해도 본 일을 막지 않는다(`db/agentActivity.ts`).
  await markAgentActivity('analyst', 'measuring', '적정가를 재는 중').catch(() => {});
  const args = process.argv.slice(2);
  const accountId = args.find((a) => !a.startsWith('--')) ?? 'VTS-ORDINARY';

  await ensureSchema();

  // ── 대상: 보유 ──
  const symbols: string[] = [];
  const account = getKisAccount(accountId);
  /** 📈 스크리너가 "1주도 못 산다"를 가르는 값. 계좌를 못 읽으면 모른다(`null`) */
  let cash: number | null = null;
  if (account) {
    try {
      const snap = await getKisDomesticAccountSnapshot(account);
      for (const p of snap.positions) if (p.quantity > 0) symbols.push(p.symbol);
      cash = snap.cashBalance ?? null;
    } catch (error) {
      console.log(`계좌를 못 읽었다 — 보유 없이 후보만 본다 (${(error as Error).message.slice(0, 50)})`);
    }
  }
  const held = new Set(symbols);
  const targets = symbols.slice(0, MAX_SYMBOLS);

  /*
   * ── 후보: 거래대금 상위 중 **안 들고 있는 개별 주식** ──
   *
   * ★ 자금이 실제로 도는 곳만 본다. 거래대금 순위 밖이면 사도 못 파는 종목이라
   *   적정가가 싸도 쓸모가 없다 — `universe.ts`가 유동성 문을 두는 것과 같은 이유다.
   *
   * ★ ETF는 후보에서 뺀다. ETF는 **층 배분**의 문제이지 "싸서 사는" 것이 아니다
   *   (오늘 판단자도 KODEX 200이 −10%인데 ETF 층이 60.9%라 안 샀다).
   */
  const candidates: string[] = [];
  try {
    /*
     * ★ `assetTypes`에 'stock'만 준다 — ETF는 애초에 안 딸려 온다. 그래도
     *   `classifyAsset`으로 한 번 더 거른다(레버리지가 stock으로 등록된 경우).
     */
    const ranked = await getTopTurnoverInstruments(['stock'], CANDIDATE_POOL);
    for (const inst of ranked) {
      if (held.has(inst.symbol)) continue;
      if (classifyAsset(inst.name, inst.assetType) !== 'stock') continue;
      candidates.push(inst.symbol);
    }
    console.log(`후보 ${candidates.length}종목 (20일 평균 거래대금 상위 ${CANDIDATE_POOL} 중 개별주식, 보유 제외)`);
  } catch (error) {
    console.log(`후보를 못 뽑았다 — 보유만 본다 (${(error as Error).message.slice(0, 50)})`);
  }

  if (targets.length === 0 && candidates.length === 0) {
    console.log('볼 종목이 없다.');
    return;
  }

  // ── ① KIS 시세 (한 번에) ──
  const quotes = new Map<string, number>();
  try {
    // ★ `quotes`는 배열이 아니라 **Map<종목코드, Quote>**다. 배열로 알고 돌리면
    //   `[code, quote]` 튜플이 와서 `q.price`가 undefined가 된다(2026-09-03에 그랬다).
    const batch = await getDomesticQuotes([...targets, ...candidates]);
    for (const [code, q] of batch.quotes) if (q.price > 0) quotes.set(code, q.price);
    if (batch.blank.length > 0) console.log(`  시세가 빈 종목: ${batch.blank.join(' ')}`);
    const unanswered = batch.failed.flatMap((f) => f.codes).length;
    if (unanswered > 0) console.log(`  시세를 못 받은 종목 ${unanswered}개 — ${batch.failed[0].message.slice(0, 60)}`);
  } catch (error) {
    console.log(`시세를 못 받았다: ${(error as Error).message.slice(0, 60)}`);
  }

  // ── ③ 뉴스 (한 번에) ──
  let news: Array<{ title: string; summary: string }> = [];
  try {
    news = await getMainNews(12);
  } catch {
    // 뉴스가 없어도 적정가는 낸다.
  }

  /*
   * ★ **시장 중앙값을 루프 앞에서 구한다.** 급락 판정을 적정가와 같은 행에
   *   넣어야 하고(아래 INSERT), 그러려면 각 종목을 훑기 전에 기준이 있어야 한다.
   *   쿼리 한 번이고 일봉은 이미 DB에 있다.
   */
  const marketReturn = await marketMedianReturn60();
  const relativeReturn = (ret: number | null): number | null =>
    ret === null || marketReturn === null ? null : ret - marketReturn;

  const rows: Row[] = [];
  for (const symbol of [...targets, ...candidates]) {
    /*
     * ★ **현재가가 없으면 행을 남기지 않는다** (2026-09-17). 남기면 "0원 · 적정가 못 냄"이
     *   이 회차의 측정처럼 읽힌다. 안 남기면 화면이 직전 행을 `⚠N분 전`으로 보여 준다 —
     *   "이번엔 못 쟀다"가 사실이다. 9/16 모의 서버가 죽었을 때 900종목 전부가 0원 행이었다.
     */
    const price = quotes.get(symbol);
    if (price === undefined) continue;
    const instrument = await getKoreanInstrumentBySymbol(symbol);
    const name = instrument?.name ?? symbol;
    const kind = classifyAsset(name, instrument?.assetType);
    const missing: string[] = [];

    // ── ② 차트 ──
    const bars = (await getDailyBars(symbol)).map((b) => ({
      tradingDay: b.tradingDay, close: b.close, high: b.high, low: b.low,
    }));
    const chart = chartBand(bars);
    if (!chart) missing.push(`차트(봉 ${bars.length})`);
    /*
     * ★ **현재가를 종점으로 준다**(2026-09-10). 일봉이 밀리면 옛 종가로 급락을
     *   판정하게 되고, 실제로 SAMG엔터가 그 틈으로 필터를 뚫었다.
     */
    const ret60 = return60(bars, price);

    /*
     * ── ① 재무 — **개별 주식에만 묻는다** ──
     *
     * ★ ETF에 BPS·PER은 뜻이 없다. 그전에는 전 종목에 물어 KODEX 200에
     *   "재무 없음"이 붙었는데, 그건 **빠진 것이 아니라 애초에 없는 것**이다.
     *   둘을 섞으면 판단자가 "자료가 모자란다"로 읽는다.
     */
    let fundamental = null;
    if (kind === 'stock') {
      const fins = await cachedFinancials(symbol);
      const latest = fins[0];
      fundamental = latest
        ? fundamentalBand(
          { bps: latest.bps, eps: latest.eps, roe: latest.roe },
          pastMultiples(bars, latest.bps),
          pastMultiples(bars, latest.eps),
        )
        : null;
      if (!fundamental) missing.push(latest ? '재무 배수 부족' : '재무 없음');
    }

    // ── ③ 이 종목 뉴스 ──
    const hit = news
      .filter((n) => n.title.includes(name) || n.summary.includes(name))
      .slice(0, 2)
      .map((n) => n.title);

    const fv = combine(symbol, kind, price, chart, fundamental, missing);
    rows.push({ symbol, name, fv, news: hit, held: held.has(symbol), ret60 });

    await pool.query(
      `INSERT INTO trading_fair_values
         (symbol, price, chart_mid, fundamental_mid, gap, basis, falling)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        symbol, price, chart?.mid ?? null, fundamental?.mid ?? null, fv.gap,
        [chart?.basis, fundamental?.basis].filter(Boolean).join(' | '),
        isFalling(relativeReturn(ret60)),
      ],
    );
  }

  /*
   * ── 출력 — **갈래로 묶는다** ──
   *
   * 사용자가 짚었다 (2026-09-03) — *"지금은 무슨 기준으로 한지 모르겠어."*
   * 한 줄로 죽 늘어놓으면 KODEX 200과 KB금융이 같은 잣대로 재진 것처럼 보인다.
   * 갈래마다 **무엇으로 냈는지를 머리에 적어** 그 오해를 없앤다.
   */
  const ORDER: AssetKind[] = ['stock', 'indexEtf', 'sectorEtf', 'commodityEtf', 'leveraged'];
  const lines: string[] = [];

  /*
   * ── ★ 추천을 **먼저** 보여준다 ──
   *
   * 보유 현황은 매번 비슷하지만 추천은 바뀐다. 뒤에 두면 안 읽힌다.
   *
   * ★ **문턱을 넘는 것만** 올린다. 그냥 목록은 판단자에게 짐이고, 사람에게는
   *   소음이다 — 40종목을 5분마다 나열하면 아무도 안 본다.
   *
   * ★★ **문턱이 둘이다** — 절대(`RECOMMEND_GAP`)와 상대(`RECOMMEND_PERCENTILE`).
   *    하나만 두면 추세장에서 영영 0건이 된다(2026-09-03 실측). 둘 중 하나라도
   *    맞으면 올리고, **어느 쪽으로 올라왔는지를 줄에 적는다.**
   *
   * ★ **이것은 "사라"가 아니다.** 층 상한·매수여력·`plan`을 세울 수 있는지는
   *   판단자가 본다. 여기서는 *"기준 안에서 싼 것이 이만큼 있다"*까지다.
   */
  const scored = rows.filter((r) => !r.held && r.fv.gap !== null);
  const gapOf = (r: Row): number => r.fv.gap ?? 0;

  /*
   * ── ★★ 세 번째 축: **떨어지는 중인 것을 거른다** ──
   *
   * 사용자가 정했다 — *"급락 종목 걸러내는 축 추가해줘."*
   *
   * 후보를 147종목으로 넓힌 첫 판에서 추천 다섯이 **전부 급락 종목**이었다.
   * 적정가가 6개월 분포 대비라 **떨어진 종목은 자동으로 "싸다"가 된다.**
   *
   * ★ **시장 대비**로 잰다. 그날 시장 전체의 60일 중앙이 −7.6%였다 — 절대
   *   문턱을 두면 시장이 빠지는 날 전부 걸린다. 중앙값은 **오늘 후보 집합**에서
   *   구한다(이미 일봉을 읽었으므로 공짜다).
   */
  const relativeOf = (r: Row): number | null => relativeReturn(r.ret60);
  const falling = new Set(scored.filter((r) => isFalling(relativeOf(r))).map((r) => r.symbol));

  /* ① 절대 기준 — 그 종목 자신의 최근 궤적 대비 싸다 */
  const byAbsolute = new Set(scored.filter((r) => gapOf(r) <= RECOMMEND_GAP).map((r) => r.symbol));

  /*
   * ② 상대 기준 — 오늘 후보 중 싸기 하위 RECOMMEND_PERCENTILE
   *
   * ★ 후보가 MIN_CANDIDATES_FOR_RANK보다 적으면 **쓰지 않는다.** 셋 중 하나를
   *   "하위 20%"라고 부르는 것은 순위가 아니라 그냥 최솟값이다.
   */
  const byRelative = new Set<string>();
  let cutoff: number | null = null;
  if (scored.length >= MIN_CANDIDATES_FOR_RANK) {
    const ascending = [...scored].sort((a, b) => gapOf(a) - gapOf(b));
    const k = Math.max(1, Math.floor(ascending.length * RECOMMEND_PERCENTILE));
    cutoff = gapOf(ascending[k - 1]);
    for (const r of ascending.slice(0, k)) {
      if (gapOf(r) < RELATIVE_CEILING) byRelative.add(r.symbol);
    }
  }

  /*
   * ★★ **몇이 통과했고 몇을 보이는지 갈라 둔다** (2026-09-10).
   *
   * 그전에는 자른 뒤의 다섯만 남겼다. 그래서 판단자가 *"−25% 아래 25종목 중
   * ⭐는 5개뿐"*을 보고 **이유를 잘못 추론했다** — 미결에 *"⭐ 후보를 '거래대금
   * 상위 40 중 개별주식'으로 한정하는 것이 옳은지 아무도 재지 않았다"*고 적었다.
   * 실제 이유는 거래대금이 아니라 `RECOMMEND_LIMIT`(표시 상한)다.
   *
   * ★ 화면이 안 밝히면 판단자는 짐작하고, 짐작은 미결로 쌓인다.
   */
  const eligible = scored
    .filter((r) => byAbsolute.has(r.symbol) || byRelative.has(r.symbol))
    // ★ 떨어지는 중인 것은 "싸다"가 아니라 "떨어졌다"이다. 추천에서 뺀다.
    .filter((r) => !falling.has(r.symbol))
    .sort((a, b) => gapOf(a) - gapOf(b));
  const picks = eligible.slice(0, RECOMMEND_LIMIT);

  /* ★ 어느 기준으로 올라왔는지 — 없으면 판단자가 둘을 같게 읽는다 */
  const standardOf = (symbol: string): string => [
    byAbsolute.has(symbol) ? '절대' : null,
    byRelative.has(symbol) ? '상대' : null,
  ].filter(Boolean).join('+');

  const rule = [
    // ★ 자른 것을 말한다 — 5건인 이유가 문턱이 아니라 표시 상한임을 밝힌다.
    eligible.length > picks.length
      ? `문턱 통과 ${eligible.length}건 중 싼 순 ${RECOMMEND_LIMIT}건만 표시`
      : `문턱 통과 ${eligible.length}건 전부 표시`,
    `절대 ${(RECOMMEND_GAP * 100).toFixed(0)}% 이하`,
    cutoff === null
      ? `상대 순위 미사용(후보 ${scored.length} < ${MIN_CANDIDATES_FOR_RANK})`
      : `상대 하위 ${(RECOMMEND_PERCENTILE * 100).toFixed(0)}%(컷 ${(cutoff * 100).toFixed(1)}%, `
        + `천장 +${(RELATIVE_CEILING * 100).toFixed(0)}%)`,
    marketReturn === null
      ? '추세 축 없음'
      : `추세: 시장 60일 ${(marketReturn * 100).toFixed(1)}% 대비 ${(FALLING_GATE * 100).toFixed(0)}%p 이상 빠진 것 제외`,
  ].join(' · ');

  /*
   * ★ **판단자가 읽을 수 있게 남긴다.** 슬랙은 사람이 보는 것이고, 판단자는
   *   `showFairValues.ts`를 본다. 한 번 계산한 판정을 두 곳이 같이 쓴다.
   *
   *   추천이 0건이면 아무것도 넣지 않는다 — 화면 쪽에서 "적정가 표는 있는데
   *   추천이 없다"와 "분석가가 안 돌았다"를 그 차이로 가른다.
   */
  if (picks.length > 0) {
    const stamped = new Date();
    for (const r of picks) {
      await pool.query(
        `INSERT INTO trading_fair_value_picks (measured_at, symbol, standard, rule, gap)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (measured_at, symbol) DO NOTHING`,
        [stamped, r.symbol, standardOf(r.symbol), rule, gapOf(r)],
      );
    }
  }

  /*
   * ── ★★ 뉴스를 붙인다 — ⭐ 종목과 보유 개별주식 ──
   *
   * ⭐는 *"왜 떨어졌나"*를, 보유는 *"팔 이유(나쁜 뉴스)가 붙었나"*를 묻는 데 쓴다.
   * 판단자 화면(`showFairValues.ts`)이 이 칸을 읽는다 — 이제야 지침의 약속이 참이 된다.
   *
   * ★ **거르지 않는다.** 목록형 기사가 섞여 오지만 짐작으로 버리면 쓸 만한 것이
   *   함께 사라진다 — 날짜·출처를 붙여 넉넉히 넘기고 판단자가 고른다.
   * ★ ETF는 받지 않는다 — 종목 뉴스가 아니라 시황이 붙어 판단에 쓸모가 없다.
   */
  const newsTargets = [
    ...picks.map((r) => r.symbol),
    ...rows.filter((r) => r.held && r.fv.kind === 'stock').map((r) => r.symbol),
  ].filter((s, i, all) => all.indexOf(s) === i);
  const newsBySymbol = new Map<string, NewsCell>();
  for (const symbol of newsTargets) {
    const cell = await fetchNewsCell(symbol);
    newsBySymbol.set(symbol, cell);
    await pool.query(
      `UPDATE trading_fair_values SET news = $2::jsonb
        WHERE symbol = $1
          AND measured_at = (SELECT max(measured_at) FROM trading_fair_values WHERE symbol = $1)`,
      [symbol, JSON.stringify(cell)],
    );
    await sleep(NEWS_GAP_MS);
  }
  const newsFailed = [...newsBySymbol.values()].filter((c) => !Array.isArray(c)).length;
  console.log(`뉴스를 붙였다 — ${newsTargets.length}종목(⭐ ${picks.length} · 보유 개별주식 포함)`
    + `${newsFailed > 0 ? ` · ★ 못 받은 것 ${newsFailed}` : ''}`);

  /*
   * ── 📈 오늘 오르는 후보 (위 `RISER_LIMIT` 주석) ──
   *
   * ★ 장이 닫혔으면 훑지 않는다(`fair-value-after`가 30분마다 돈다) — 볼 판단자가
   *   없고 값도 고정이라, 훑으면 KIS 시세 10회를 그냥 쓴다.
   */
  const risers = krxClosedNow() ? null : await discoverRisers(held, cash);
  console.log(risers === null
    ? '📈 오늘 오르는 후보 — 이번에는 없다(장이 닫혔거나 못 훑었다 · risers-scan 기록 참고)'
    : `📈 오늘 오르는 후보 ${risers.length}건을 남겼다`);

  /*
   * ── 📣 재료가 막 나온 종목 (위 `CATALYST_LIMIT` 주석) ──
   *
   * ★ 장이 닫혔으면 훑지 않는다 — 📈와 같은 이유다. 다음 날 첫 회차가 전 평일
   *   00시부터 거슬러 채우므로 밤사이 공시도 빠지지 않는다.
   */
  const catalysts = !CATALYSTS_ENABLED || krxClosedNow() || !account
    ? null
    : await discoverCatalysts(account, held, new Set(candidates), quotes);
  console.log(catalysts === null
    ? '📣 재료가 막 나온 종목 — 이번에는 없다(장이 닫혔거나 못 훑었다 · catalyst-scan 기록 참고)'
    : `📣 재료가 막 나온 종목 ${catalysts.length}건을 남겼다`);

  if (picks.length > 0) {
    const head = `⭐ *추천* — 거래대금 상위 ${CANDIDATE_POOL} 중 개별주식 ${scored.length}종목에서`;
    console.log(`\n${head}\n   기준: ${rule}`);
    lines.push(head);
    lines.push(`_기준: ${escapeMrkdwn(rule)}_`);
    for (const r of picks.slice(0, SLACK_SHOWN)) {
      const text = `[${standardOf(r.symbol)}] ${describe(r.fv, r.name)}`;
      console.log(`  ⭐ ${text}`);
      lines.push(`⭐ ${escapeMrkdwn(text)}`);
      // ★ 종목별 뉴스(위에서 받은 것)를 붙인다. 주요 뉴스 대조는 900종목 앞에서 거의 늘 비었다.
      const cell = newsBySymbol.get(r.symbol);
      if (Array.isArray(cell)) for (const n of cell.slice(0, 2)) lines.push(`     _${escapeMrkdwn(n.title)}_`);
    }
    /*
     * ★★ **상대 기준의 뜻을 반드시 적는다.** "하위 20%"는 *싸다*가 아니라
     *    *오늘 후보 중 덜 비싸다*이다. 이 줄이 없으면 판단자가 ⭐를 매수
     *    신호로 읽는다 — 시장 전체가 비싸면 그중 가장 덜 비싼 것도 비싸다.
     */
    if (byRelative.size > 0) {
      lines.push('_★ `상대`는 "오늘 후보 중 덜 비싸다"입니다 — 절대적으로 싸다는 뜻이 아닙니다._');
    }
    if (falling.size > 0) {
      lines.push(`_★ 떨어지는 중인 ${falling.size}종목을 뺐습니다 — "싸다"가 아니라 "떨어졌다"입니다._`);
    }
    lines.push('_층 상한·매수여력·계획은 판단자가 봅니다. 이 목록은 "사라"가 아닙니다._');
  } else if (scored.length > 0) {
    console.log(`\n추천 없음 — ${rule}`);
    lines.push(`⭐ _추천 없음 — ${escapeMrkdwn(rule)}_`);
  } else if (rows.some((r) => !r.held)) {
    /*
     * ★ 후보는 있는데 gap을 하나도 못 냈다. **"살 것이 없다"와 다른 사실이다** —
     *   조용히 "추천 없음"으로 적으면 자료가 없는 것을 판단으로 읽는다.
     */
    console.log('\n★ 후보의 적정가를 하나도 못 냈다 — 추천을 낼 수 없다.');
    lines.push('⭐ _★ 후보의 적정가를 하나도 못 냈습니다 — 살 것이 없다는 뜻이 아닙니다._');
  }

  if (catalysts !== null && catalysts.length > 0) {
    const head = '📣 *재료가 막 나온 종목* — 최근 2거래일 공시 호재, 공시 뒤 아직 +5% 이하';
    console.log(`\n${head}`);
    lines.push(`\n${head}`);
    for (const c of catalysts.slice(0, SLACK_SHOWN)) {
      const text = `${c.name} ${Math.round(c.price).toLocaleString('ko-KR')}원`
        + ` · 공시 뒤 ${c.move >= 0 ? '+' : ''}${(c.move * 100).toFixed(1)}% · [${c.labels.join('·')}] ${c.latest.title}`
        + (c.warnings.length > 0 ? ` · ⚠${c.warnings.join('·')}` : '');
      console.log(`  📣 ${text}`);
      lines.push(`📣 ${escapeMrkdwn(text)}`);
    }
    lines.push('_📣는 "재료가 나왔다"이지 "오른다"가 아닙니다. 재료의 크기는 원문에 있고, 판단자가 봅니다._');
  }

  if (risers !== null && risers.length > 0) {
    const head = '📈 *오늘 오르는 후보* — 정식 회차와 같은 스크리너, 개별주식·보유 제외 오른 순';
    console.log(`\n${head}`);
    lines.push(`\n${head}`);
    for (const r of risers.slice(0, SLACK_SHOWN)) {
      const text = `${r.name} ${Math.round(r.price).toLocaleString('ko-KR')}원 · +${r.changeRate.toFixed(2)}%`
        + ` · 거래대금 ${Math.round(r.turnover / 100_000_000).toLocaleString('ko-KR')}억`;
      console.log(`  📈 ${text}`);
      lines.push(`📈 ${escapeMrkdwn(text)}`);
    }
    lines.push('_📈는 "오른다"이지 "더 오른다"가 아닙니다. 오른 이유가 남는지는 판단자가 봅니다._');
  }

  // ── 보유 종목만 갈래별로 ──
  for (const kind of ORDER) {
    const group = rows.filter((r) => r.held && r.fv.kind === kind);
    if (group.length === 0) continue;
    group.sort((a, b) => (a.fv.gap ?? 99) - (b.fv.gap ?? 99));

    console.log(`\n[보유 · ${ASSET_KIND_LABEL[kind]}] ${ASSET_KIND_METHOD[kind]}`);
    lines.push(`\n*보유 · ${ASSET_KIND_LABEL[kind]}*  _${escapeMrkdwn(ASSET_KIND_METHOD[kind])}_`);

    for (const r of group) {
      const text = describe(r.fv, r.name);
      console.log(`  ${text}`);
      const mark = r.fv.gap === null ? '·' : r.fv.gap < -0.05 ? '🟢' : r.fv.gap > 0.05 ? '🔴' : '⚪';
      lines.push(`${mark} ${escapeMrkdwn(text)}`);
      for (const n of r.news) {
        console.log(`      · ${n}`);
        lines.push(`     _${escapeMrkdwn(n)}_`);
      }
    }
  }

  if (!slackBotConfigured()) {
    console.log('\n봇이 설정돼 있지 않다 — BOT_TOKEN·SLACK_BRIEFING_CHANNEL이 필요하다.');
    return;
  }
  const now = new Date().toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  /*
   * ★ **장이 닫혔으면 그렇게 적는다** (2026-09-03).
   *
   * 마감 후에도 30분마다 보내는데(`fair-value-after`), 값이 고정이라 같은 표가
   * 반복된다. 그 사실을 안 적으면 **"왜 값이 안 변하지"**를 시장이 조용한
   * 것으로 읽거나, 브리핑이 고장난 줄로 읽는다.
   */
  const closed = krxClosedNow();

  const header = `💹 *적정가 분석* — ${now}${closed ? ' · _장 마감 후_' : ''}`
    + `\n_지금 값이 **그 종목의 최근 궤적** 대비 어디쯤인가. 예측이 아니라 기준선이다._`
    + (closed
      ? '\n_🌙 장이 닫혀 값이 고정입니다 — 다음 갱신은 내일 09:05입니다._'
      : '\n_🟢 −5% 이하(싸다) · ⚪ 그 사이 · 🔴 +5% 이상(비싸다)_');
  const sent = await sendSlackBot([header, ...lines].join('\n'));
  console.log(sent ? '\nstock-briefing 채널로 보냈다.' : '\n보내지 못했다.');

  if (!args.includes('--no-judge')) await callAnalyst(accountId, risers, catalysts);
}

/**
 * ★★ **계산이 끝날 때마다 분석가를 부른다** (2026-09-15).
 *
 * 사용자가 정했다 — *"5분 간격으로 분석가를 부른다기보단 … 시퀀스를 루프화 시키는게
 * 좋을 것 같아. 빠른 집행을 하기위한 최적의 루프를 만들어줘."* 그래서 부를 이유를 따지던
 * 게이트(적정가 문턱·새 📣 이름, 옛 `trading/judgeGate.ts`)를 걷었다. 분석가(Claude)가
 * 매 바퀴 **모든 종목**을 보고 직전 노트를 이어 쓰므로, 같은 상황을 되풀이해 사는 비용은
 * 노트가 누른다(`prompts/analyst.md`).
 *
 * ★ 게이트 시절 빠른 회차 231번 중 매수는 0건이었다 — 부르는 횟수가 아니라 조사 시간이
 *   막고 있었다. 게이트를 둔 이유(하루 78회 비용)는 사용자가 알고 넘겼다.
 *
 * ★ **띄우기 전에 `fair-value-judge`를 남긴다** — "새 계산 결과가 나왔다"는 표시다.
 *   분석가가 도는 중이면 새로 띄우지 않는다. 그 분석가가 끝날 때 이 표시를 보고 곧바로
 *   한 바퀴 더 돈다(`scripts/deliberate.sh` 끝). 매매 스위치·장 시간도 거기서 본다.
 */
async function callAnalyst(
  accountId: string, risers: Riser[] | null, catalysts: CatalystPick[] | null,
): Promise<void> {
  const names = (list: Array<{ symbol: string }> | null) => (list ? list.map((x) => x.symbol).join(',') : '못 훑음');
  await pool.query(
    `INSERT INTO trading_heartbeats (name, status, note) VALUES ('fair-value-judge', 'ok', $1)`,
    [`📣 ${names(catalysts)} · 📈 ${names(risers)}`],
  );

  const repoRoot = process.cwd().endsWith('backend') ? '..' : '.';
  const running = judgeRunning(repoRoot);
  if (running !== null) {
    console.log(`분석가가 도는 중이다(pid ${running}) — 끝나면 이 결과로 곧바로 한 바퀴 더 돈다.`);
    return;
  }
  console.log('★ 분석가를 부른다');

  // 백그라운드로 띄우고 기다리지 않는다 — 계산 루프가 분석가를 기다리면 두 루프가 한 줄이 된다.
  const child = spawn('zsh', ['scripts/deliberate.sh', '--quick', accountId], {
    cwd: repoRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await markAgentActivity('analyst', 'idle').catch(() => {});
    await closeDb();
  });
