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
> ## ★★ 출처를 통째로 갈았다 (2026-09-18)
>
> 9/18 08:04 회차의 프리플라이트에서 **`finance.naver.com` 레거시 엔드포인트가 전부
> `HTTP 410 Gone`**으로 나왔다. 9/11에 "검증됨"으로 적어 둔 표가 통째로 무효가 된
> 것이다. 그 회차는 코스피·코스닥·수급·환율·금리·유가·금을 전부 `❓미확보`로 적고
> 미국은 ETF 프록시로만 메웠다 — 브리핑의 절반이 빈 채로 나갔다.
>
> 대체 출처를 실측으로 찾아 넣었다(2026-09-18 로컬 확인):
>
> | 그동안 못 가져오던 것 | 새 출처 |
> |---|---|
> | 코스피·코스닥 종가·등락률 | `m.stock.naver.com/api/index/{KOSPI,KOSDAQ}/price` |
> | **투자자별 수급(개인·외국인·기관)** | `m.stock.naver.com/api/index/{KOSPI,KOSDAQ}/trend` |
> | 원/달러 | Yahoo `USDKRW=X` |
> | **미국 3대 지수 — 포인트 값 자체** | Yahoo `^GSPC` · `^IXIC` · `^DJI` |
> | **미 10년물 금리 — 수치 자체** | Yahoo `^TNX` |
> | 유가 WTI·브렌트 | Yahoo `CL=F` · `BZ=F` |
> | 금·은 | Yahoo `GC=F` · `SI=F` |
> | VIX·달러지수 (새로 추가) | Yahoo `^VIX` · `DX-Y.NYB` |
>
> ★ **대리지표(SPY·QQQ·DIA·IEF)는 이제 1순위가 아니다.** 지수 값 자체가 오므로
> 프록시는 Yahoo가 죽은 회차의 폴백으로만 쓴다.
>
> ## 아직 미확보 — 출처를 못 찾았다
>
> - **프로그램 매매** — `m.stock.naver.com`에 엔드포인트가 없다(404)
> - **국내 금리 3종**(국고채 3년·CD91·콜) — 네이버 모바일 API에 없고, 한국은행
>   ECOS는 API 키가 필요하다(`ecos.bok.or.kr` 자체는 200)
> - **정식 뉴스** — `/news/*`·`n.news.naver.com` 여전히 차단
> - KRX JSON API(`getJsonData.cmd`)는 계속 403이다
>
> ## 검증 범위 — 읽는 사람이 알아야 할 것
>
> 위 표는 **로컬(사용자 맥)에서 잰 값**이다. 클라우드 루틴 환경은 네트워크 정책이
> 달라(네이버가 거기서만 막혔던 전례가 있다) **같으리라는 보장이 없다.** 그래서
> 프롬프트는 출처를 박아 넣지 않고 **프리플라이트로 확인한 뒤 살아 있는 것만 쓴다.**
> 죽었으면 `❓미확보`로 적는 규칙은 그대로다.

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
   UA="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"
   curl -sS -o /dev/null -w "yahoo-idx  %{http_code}\n" --max-time 20 -H "User-Agent: Mozilla/5.0" \
     "https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=5d"
   curl -sS -o /dev/null -w "yahoo-fx   %{http_code}\n" --max-time 20 -H "User-Agent: Mozilla/5.0" \
     "https://query1.finance.yahoo.com/v8/finance/chart/USDKRW=X?interval=1d&range=5d"
   curl -sS -o /dev/null -w "nv-index   %{http_code}\n" --max-time 20 -H "User-Agent: $UA" \
     "https://m.stock.naver.com/api/index/KOSPI/price?pageSize=3&page=1"
   curl -sS -o /dev/null -w "nv-trend   %{http_code}\n" --max-time 20 -H "User-Agent: $UA" \
     "https://m.stock.naver.com/api/index/KOSPI/trend?pageSize=3"
   curl -sS -o /dev/null -w "nv-etf     %{http_code}\n" --max-time 20 \
     "https://finance.naver.com/api/sise/etfItemList.naver"
   curl -sS -o /dev/null -w "sa         %{http_code}\n" --max-time 20 https://stockanalysis.com/etf/schd/
   ```

   `200`이 아니면 그 출처는 죽은 것으로 간주한다. `403`·`410`은 재시도·User-Agent
   변경으로 우회하려 하지 말고 죽은 것으로 처리한다. WebFetch가 `EGRESS_BLOCKED`를
   반환하면 같은 URL을 curl로 받아 파싱해도 된다(동일 출처이므로 규칙 위반 아님).

   결과에 따라 모드를 확정한다:
   - **정상 모드** — 국내 출처(`nv-index` 또는 `nv-etf`) + 해외 출처(`yahoo-idx` 또는 `sa`)
     모두 생존 → 전체 브리핑 작성.
   - **국내 온리 모드** — 국내 출처만 생존 → 미국 섹션을 `❓ 미확보(출처 접근 차단)`로
     표기하고, [2](B)의 '국내·미국 모두 포함' 요건을 **이 실행에 한해 면제**.
     면제 사실을 브리핑에 명시.
   - **해외 온리 모드** — 해외 출처만 생존 → 국내 섹션을 `❓ 미확보`로 적고 해외만
     작성한다. 국내가 통째로 빈 회차임을 **핵심 요약 셋째 줄에 명시**한다.
   - **양쪽 다 사망** — **브리핑을 작성하지 않는다.** 슬랙에 "출처 접근 불가로 이번
     회차를 건너뜁니다"와 프리플라이트 결과만 짧게 남긴다.

3. 데이터 수집 → 4. 작성 → 5. 슬랙 전송.

---

## [1] 출처 규칙

**허용 출처는 넷뿐이다** — `query1.finance.yahoo.com`, `m.stock.naver.com`,
`finance.naver.com/api/sise/etfItemList.naver`, `stockanalysis.com`.
(`data.krx.co.kr`는 메인만 200이고 데이터 API가 403이라 실질적으로 못 쓴다.)
다른 출처를 끌어오지 않는다.

**✅ 검증된 작동 엔드포인트 (2026.09.18 로컬 확인) — 먼저 이것부터 시도한다**

Yahoo는 전부 같은 모양이다. `https://query1.finance.yahoo.com/v8/finance/chart/<심볼>?interval=1d&range=5d`
→ JSON. 값은 `chart.result[0].meta`의 `regularMarketPrice`(종가)와
`chartPreviousClose`(전일 종가)에 있다. `^`는 URL에서 `%5E`로 인코딩한다.

| 데이터 | 심볼 |
|---|---|
| S&P500 · 나스닥 · 다우 | `^GSPC` · `^IXIC` · `^DJI` |
| 미 10년물 금리(%) | `^TNX` |
| VIX · 달러지수 | `^VIX` · `DX-Y.NYB` |
| 원/달러 | `USDKRW=X` |
| WTI · 브렌트 | `CL=F` · `BZ=F` |
| 금 · 은 | `GC=F` · `SI=F` |
| 코스피 · 코스닥 (보조) | `^KS11` · `^KQ11` |

네이버 모바일 API — `User-Agent`에 모바일 문자열을 넣는다. 응답은 UTF-8 JSON이다
(레거시 페이지의 EUC-KR 처리는 더 이상 필요 없다).

| 데이터 | URL |
|---|---|
| 코스피·코스닥 일별 시세 | `https://m.stock.naver.com/api/index/{KOSPI\|KOSDAQ}/price?pageSize=5&page=1` |
| **투자자별 수급(개인·외국인·기관)** | `https://m.stock.naver.com/api/index/{KOSPI\|KOSDAQ}/trend?pageSize=5` |
| 지수 기본 정보 | `https://m.stock.naver.com/api/index/{KOSPI\|KOSDAQ}/basic` |
| 종목별 수급·외국인 지분율 | `https://m.stock.naver.com/api/stock/<6자리코드>/trend?pageSize=5` |
| 국내 ETF 전종목 | `https://finance.naver.com/api/sise/etfItemList.naver` (JSON, **EUC-KR** — `iconv -f euc-kr -t utf-8`) |
| 미국 ETF 개요 | `https://stockanalysis.com/etf/<티커>/` (HTML 안의 `quote:{...}` 객체에 `p`=현재가 `cp`=등락률 `cl`=전일종가 `u`=기준시각) |
| 미국 ETF 일별 · 배당 | `https://stockanalysis.com/etf/<티커>/history/` · `/dividend/` |

**❌ 확인된 불가 (재시도하지 말 것)**
- **`finance.naver.com`의 레거시 엔드포인트 전부 — `HTTP 410 Gone`** (2026.09.18 확인).
  `/sise/sise_index_day.naver`·`/marketindex/*`(환율·유가·금리)·`/item/sise_day.naver`가
  모두 죽었다. **`/api/sise/etfItemList.naver` 하나만 살아 있다.**
- 프로그램 매매 — 네이버 모바일 API에 엔드포인트 없음(404)
- 국내 금리(국고채 3년·CD91·콜) — 네이버 모바일 API에 없음(404). 한국은행 ECOS는
  API 키가 필요해 이 환경에서 못 쓴다
- `/news/*`, `/item/news_news.naver`, `n.news.naver.com` — 차단
- KRX JSON API (`getJsonData.cmd`) — 403
- `https://stockanalysis.com/etf/<티커>/performance/` — 404

**대리지표 — 폴백 전용**
Yahoo가 죽은 회차에 한해, stockanalysis(미국 상장 ETF)의 추종 ETF로 **방향성만**
대체할 수 있다. 단 반드시 **"지수 값이 아니라 ETF 가격"임을 명시**한다.
- S&P500 → SPY · 나스닥100 → QQQ · 다우 → DIA · 미 10년물 금리 방향 → IEF(가격↓ = 금리↑)

**Yahoo가 살아 있으면 지수 값을 그대로 쓴다. 프록시로 대체하지 않는다.**

**★ 스니펫 금지** — 검색 결과 요약·미리보기에서 숫자를 옮기지 않는다. 실제 페이지를 열어 읽은 값만 쓴다.

**★ 날조 금지** — 확보하지 못한 값은 반드시 `❓ 미확보(사유)`로 적는다. 그럴듯한 값을 채우지 않는다.
추정으로 메운 것은 "추정"이라고 밝힌다.

**★ 모든 수치에 출처와 기준일을 붙인다** — `_(출처: Yahoo Finance ^GSPC, 2026.09.17 종가)_` 형식.
기준일이 오늘이 아니면 그 사실이 보여야 한다. 네이버 모바일 API는 `localTradedAt`,
Yahoo는 `meta.regularMarketTime`, stockanalysis는 `quote`의 `u` 값이 기준일이다.

**★ 출처 목록이 틀렸으면 그 사실을 보고한다** — 프리플라이트에서 위 표의 엔드포인트가
죽어 있으면, 브리핑 끝의 `⚠️ *출처 접근 안내*`에 **어느 URL이 몇 번 코드로 죽었는지**
적는다. 이 표는 실측으로만 갱신된다(2026.09.11 표가 09.18에 통째로 410이 된 전례).

---

## [2] 브리핑 구성

### (A) 본문 — 한 건

1. 맨 위 면책 문구: `ℹ️ _본 브리핑은 정보 제공 목적이며 개인화된 투자 조언이 아닙니다. 모든 투자 판단과 책임은 본인에게 있습니다._`
2. 제목: `📅 *데일리 한·미 주식 브리핑 — YYYY.MM.DD (요일) KST*`
3. **핵심 요약 3줄** — 오늘 가장 중요한 것 세 개. 미확보가 많은 회차면 그 사실을 셋째 줄에 적는다.
4. **1️⃣ 한국 시장** — 코스피·코스닥 종가·등락률, **투자자별 수급(개인·외국인·기관)**,
   프로그램 매매(출처 없음 → `❓ 미확보`)
5. **2️⃣ 미국 시장** — 3대 지수 **포인트 값과 등락률**. Yahoo가 죽었을 때만 대리지표로
   방향성, 그 경우 명시할 것. 미 10년물 금리(`^TNX`)와 VIX를 함께 적는다
6. **3️⃣ 시장지표** — 원/달러, 달러지수, 국제유가(WTI·브렌트), 금·은.
   국내 금리 3종은 출처가 없으므로 `❓ 미확보(출처 없음)`로 둔다
7. 출처 접근에 문제가 있었다면 `⚠️ *출처 접근 안내*`로 본문 끝에 짧게

### (B) 스레드 — 본문에 이어 붙인다 (세 건)

- **스레드 1 · `4️⃣ ETF 자금 흐름`** — 국내 ETF 거래대금 상위, 3개월 수익률 상·하위와 AUM.
  실시간 순자금유출입은 허용 출처에 없으므로 시총 흐름으로 간접 유추하고 그렇다고 밝힌다.
  ★ 개장 전(오전 회차)에는 `quant`·`amonut`이 0으로 오므로 **전일 기준임을 밝힌다**
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
- 403·410을 우회하려고 User-Agent 바꾸기·재시도 반복 (네이버 모바일 API에 모바일
  UA를 넣는 것은 우회가 아니라 그 API의 정상 호출 방식이다)
- 기준일 없는 수치 쓰기
- 보유 종목 목록을 브리핑에 넣기 (그것은 로컬 판단자의 일이다)
- Yahoo가 살아 있는데 프록시(SPY·QQQ·DIA)로 미국 지수를 대신하기
