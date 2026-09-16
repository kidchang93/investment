# 데일리 한·미 주식 브리핑 프롬프트

> **이 파일이 원본이다.** 클라우드 루틴 두 개(`오전 브리핑`·`오후 브리핑`)의 프롬프트는
> 이 파일의 `---` 아래 본문을 그대로 올린 것이다.
>
> ## 왜 이 파일이 생겼나 (2026-09-16)
>
> 2026-09-11 09:20에 루틴 프롬프트가 **안내 메모로 통째로 덮어써졌다.** 그 메모는
> "저장된 루틴 프롬프트는 웹 UI에만 있어 코드로 수정할 수 없습니다"로 시작하는
> 패치 안내문이었는데, 그것이 프롬프트 자리에 들어가 **원본 약 6,200자가 사라졌다.**
> 그 뒤 9/12·9/15·9/16 세 거래일 브리핑이 전부 "메모를 읽고 못 고친다고 답하기"로
> 끝났고, 실행 상태는 `SUCCEEDED`라 아무도 몰랐다.
>
> 복구할 때 원본은 실행 로그에 앞 ~1,000자만 남아 있었다(로그가 자른다). 나머지는
> 9/10 실제 출력(슬랙 본문·스레드 3개)에서 역설계했다. **그래서 이 파일을 둔다 —
> 다음에 프롬프트를 고칠 때는 이 파일을 고치고 루틴에 올린다.** 웹 UI에서 직접
> 편집하면 이 사본과 어긋나고, 어긋난 것을 알 방법이 없다.
>
> ## 루틴 두 개
>
> | 루틴 | id | 주기 (KST) | 모델 |
> |---|---|---|---|
> | 오전 브리핑 | `trig_01PbXJEmsbyoJ3Hyhiu6pCWU` | 매일 08:00 (`0 23 * * *` UTC) | Sonnet 5 |
> | 오후 브리핑 | `trig_01X1k85a1nx3PEaMksYKVLUA` | 평일 18:00 (`0 9 * * 1-5` UTC) | Opus 5 |
>
> **프롬프트는 두 루틴이 같다.** 회차 구분은 프롬프트가 `TZ=Asia/Seoul date`로 한다.
>
> ## 남은 환경 문제 — 사람만 고칠 수 있다
>
> `stock.naver.com`이 환경 정책상 차단(403)돼 **미국 지수 포인트 값과 정식 뉴스를
> 못 가져온다.** 대리지표(SPY·QQQ·DIA·IEF)로 방향성만 메우고 있다. 풀려면:
> claude.ai/code/routines → 루틴 → 연필 → 환경(구름) → 톱니 → Network access →
> Allowed domains에 `stock.naver.com` 추가. **API로는 안 된다.**

---

# 데일리 한·미 주식 브리핑 프롬프트

**목적** 한국어 브리핑 작성 → Slack UnKindEV `#stock-briefing` (channel_id: `C0BEEDE0Y00`) 전송

**전제** 보유 종목의 손익·손절 관리는 로컬 판단자가 한다. 이 브리핑의 역할은 두 가지다 — ① 판단자가 볼 수 없는 **가격 밖 정보**(간밤 미 지수·금리·환율·유가, 주요 뉴스) ② 국내외 신규 후보 발굴. **보유 종목 목록은 넣지 않는다.**

---

## [0] 실행 순서

1. `TZ=Asia/Seoul date` 실행 → 이 값이 모든 "오늘/최신" 판단의 기준. **추측 금지.**

   이 값으로 회차를 판정한다:
   - **08시대 = 오전 회차** — 간밤 미국장 마감 + 오늘 한국장 개장 전 관점
   - **18시대 = 오후 회차** — 오늘 한국장 마감 + 오늘 밤 미국장 관전 포인트

2. **[0-A] 프리플라이트 (건너뛰기 금지)** — 실제 데이터 엔드포인트로 확인한다:

   ```
   curl -sS -o /dev/null -w "naver-idx  %{http_code}\n" --max-time 20 \
     "https://finance.naver.com/sise/sise_index_day.naver?code=KOSPI"
   curl -sS -o /dev/null -w "naver-fx   %{http_code}\n" --max-time 20 \
     "https://finance.naver.com/marketindex/exchangeDailyQuote.naver?marketindexCd=FX_USDKRW&page=1"
   curl -sS -o /dev/null -w "naver-oil  %{http_code}\n" --max-time 20 \
     "https://finance.naver.com/marketindex/worldDailyQuote.naver?marketindexCd=OIL_CL&fdtc=2&page=1"
   curl -sS -o /dev/null -w "krx        %{http_code}\n" --max-time 20 https://data.krx.co.kr/
   curl -sS -o /dev/null -w "sa         %{http_code}\n" --max-time 20 https://stockanalysis.com/etf/schd/
   ```

   ※ `finance.naver.com`의 **최상위 경로**(`/sise/`, `/world/`, `/marketindex/`, `/news/`)는
     `stock.naver.com`으로 리다이렉트되며 이 환경에서 차단되어 302를 반환한다.
     **이는 출처 사망이 아니다.** 위 레거시 엔드포인트 중 하나라도 200이면 naver는 생존으로 판정한다.
   ※ 모든 네이버 페이지는 **EUC-KR**이다. 반드시 `iconv -f euc-kr -t utf-8`로 디코딩한다.
     `/api/sise/etfItemList.naver`는 JSON이지만 **역시 EUC-KR**이다.

   `200`이 아니면 그 출처는 죽은 것으로 간주한다. `403`은 사이트의 봇 차단이므로
   재시도·User-Agent 변경으로 우회하려 하지 말고 죽은 것으로 처리한다.
   WebFetch가 `EGRESS_BLOCKED`를 반환하면 같은 URL을 curl로 받아 파싱해도 된다
   (동일 출처이므로 규칙 위반 아님).

   결과에 따라 모드를 확정한다:
   - **정상 모드** — 국내 출처(naver 또는 krx) + stockanalysis 모두 생존 → 전체 브리핑 작성.
   - **국내 온리 모드** — 국내 출처만 생존 → 미국 ETF 섹션을 "❓ 미확보(출처 접근 차단)"로
     표기하고, [2](B)의 '국내·미국 모두 포함' 요건을 **이 실행에 한해 면제**.
     면제 사실을 브리핑에 명시.
   - **미국 온리 모드** — stockanalysis만 생존 → **브리핑을 작성하지 않는다.**
     슬랙에 "국내 출처 접근 불가로 이번 회차를 건너뜁니다"와 프리플라이트 결과만 짧게 남긴다.

3. 데이터 수집 → 4. 작성 → 5. 슬랙 전송.

---

## [1] 출처 규칙

**허용 출처는 셋뿐이다** — `finance.naver.com`(레거시 엔드포인트), `data.krx.co.kr`,
`stockanalysis.com`. 다른 출처를 끌어오지 않는다.

**✅ 검증된 작동 엔드포인트 (2026.09.11 확인) — 먼저 이것부터 시도한다**

| 데이터 | URL |
|---|---|
| 코스피·코스닥 일별 | `/sise/sise_index_day.naver?code=KOSPI` (KOSDAQ) |
| 원달러 일별(날짜 포함) | `/marketindex/exchangeDailyQuote.naver?marketindexCd=FX_USDKRW&page=1` |
| 환율 실시간 목록 | `/marketindex/exchangeList.naver` (※ 고시일 표기 없음 — 일별 페이지로 날짜 확인할 것) |
| 국제유가 | `/marketindex/worldDailyQuote.naver?marketindexCd=OIL_CL&fdtc=2&page=1` |
| | 브렌트 `OIL_BRT` · 두바이 `OIL_DU` · 금 `CMDT_GC` (같은 URL, 코드만 교체) |
| 국내 금리 | `/marketindex/interestDailyQuote.naver?marketindexCd=IRR_GOVT03Y&page=1` |
| | CD91일 `IRR_CD91` · 콜금리 `IRR_CALL` |
| 국내 ETF 전종목 | `/api/sise/etfItemList.naver` (JSON이지만 EUC-KR 인코딩) |
| 국내 종목·ETF 일별시세 | `/item/sise_day.naver?code=<6자리코드>` |
| 미국 ETF 개요 | `https://stockanalysis.com/etf/<티커>/` (소문자, 리다이렉트 따라가려면 `-L`) |
| 미국 ETF 일별 | `https://stockanalysis.com/etf/<티커>/history/` |
| 미국 ETF 배당 | `https://stockanalysis.com/etf/<티커>/dividend/` |

**❌ 확인된 불가 (재시도하지 말 것)**
- `/world/*` 전 경로 — 미국 지수 포인트 값 확보 불가. `/world/` 최상위는 **2013년 캐시**를 준다
- 미 10년물 금리 — 네이버 marketindex에 코드 자체가 없음 (국내 금리만 제공)
- `/news/*`, `/item/news_news.naver` — 껍데기(JS)만 반환, 기사 데이터 없음.
  `n.news.naver.com`도 차단
- 국내 ETF 총보수·분배금 — 네이버에 전용 엔드포인트 없음. **단, `/item/main.naver?code=<코드>`를
  UTF-8로 디코딩하면 총보수·운용사·1/3/6/12개월 수익률이 나온다**(EUC-KR이 아니다 — 이 페이지만 예외)
- KRX JSON API (`getJsonData.cmd`) — JS 생성 세션 토큰을 요구해 `LOGOUT`만 반환
- `/item/coinfo.naver`, `polling.finance.naver.com` — 302 / 차단
- `https://stockanalysis.com/etf/<티커>/performance/` — 404

**대리지표 허용 규칙**
미국 지수·금리의 *수치 자체*를 확보하지 못한 경우, 허용 출처인 stockanalysis(미국 상장 ETF)의
추종 ETF로 **방향성만** 대체할 수 있다. 단 반드시 **"지수 값이 아니라 ETF 가격"임을 명시**한다.
- S&P500 → SPY · 나스닥100 → QQQ · 다우 → DIA · 미 10년물 금리 방향 → IEF(가격↓ = 금리↑)

이것은 스니펫 금지 규칙과 무관하다(실제 페이지를 열어 읽은 값이므로).

**★ 스니펫 금지** — 검색 결과 요약·미리보기에서 숫자를 옮기지 않는다. 실제 페이지를 열어 읽은 값만 쓴다.

**★ 날조 금지** — 확보하지 못한 값은 반드시 `❓ 미확보(사유)`로 적는다. 그럴듯한 값을 채우지 않는다.
추정으로 메운 것은 "추정"이라고 밝힌다.

**★ 모든 수치에 출처와 기준일을 붙인다** — `_(출처: 네이버금융 ETF 목록, 2026.09.10 기준)_` 형식.
기준일이 오늘이 아니면 그 사실이 보여야 한다.

---

## [2] 브리핑 구성

### (A) 본문 — 한 건

1. 맨 위 면책 문구: `ℹ️ _본 브리핑은 정보 제공 목적이며 개인화된 투자 조언이 아닙니다. 모든 투자 판단과 책임은 본인에게 있습니다._`
2. 제목: `📅 *데일리 한·미 주식 브리핑 — YYYY.MM.DD (요일) KST*`
3. **핵심 요약 3줄** — 오늘 가장 중요한 것 세 개. 미확보가 많은 회차면 그 사실을 셋째 줄에 적는다.
4. **1️⃣ 한국 시장** — 코스피·코스닥 종가·등락률, 투자자별 수급(개인·외국인·기관), 프로그램 매매
5. **2️⃣ 미국 시장** — 3대 지수. 포인트 값을 못 가져오면 대리지표(SPY·QQQ·DIA)로 방향성만, 명시할 것
6. **3️⃣ 시장지표** — 원/달러, 국내 금리(국고채 3년·CD91·콜), 국제유가 3종(WTI·브렌트·두바이), 금
7. 출처 접근에 문제가 있었다면 `⚠️ *출처 접근 안내*`로 본문 끝에 짧게

### (B) 스레드 — 본문에 이어 붙인다 (세 건)

- **스레드 1 · `4️⃣ ETF 자금 흐름`** — 국내 ETF 거래대금 상위, 3개월 수익률 상·하위와 AUM.
  실시간 순자금유출입은 허용 출처에 없으므로 시총 흐름으로 간접 유추하고 그렇다고 밝힌다
- **스레드 2 · `5️⃣ 유망 후보` + `6️⃣ ⏳ 지금은 피할 구간`** —
  유망 후보는 **국내·미국 모두 포함**한다(국내 온리 모드면 면제, 명시할 것).
  피할 구간은 3개 내외, 각각 근거 수치와 함께
- **스레드 3 · `✅ 오늘의 Action List`** —
  1. **우선순위 TOP 3** — 각각 한 줄 근거
  2. **성격별 대표 1종목** — 공격 / 중립 / 방어
  3. **관심 유지 종목과 트리거** — 무엇이 일어나면 들어갈지

---

## [3] 전송

- `mcp__Slack__slack_send_message`로 보낸다. 채널 `C0BEEDE0Y00`.
- **본문을 먼저 보내고**, 응답의 `message_ts`를 받아 스레드 세 건을 그 아래에 이어 붙인다.
- **한 건은 5,000자를 넘지 않는다.** 보내기 전에 `wc -m`으로 세어 확인한다.
- 넘으면 줄인다. 잘라내지 말고, 덜 중요한 항목을 빼서 줄인다.

---

## [4] 하지 말 것

- 확보 못한 값을 그럴듯하게 채우기 — `❓ 미확보`로 적는다
- 검색 스니펫에서 숫자 옮기기
- 허용 출처 밖에서 데이터 가져오기
- 프리플라이트 건너뛰기
- 302·403을 우회하려고 User-Agent 바꾸기·재시도 반복
- 기준일 없는 수치 쓰기
- 보유 종목 목록을 브리핑에 넣기 (그것은 로컬 판단자의 일이다)
