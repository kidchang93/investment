# CODE_STYLE

기존 코드에서 반복되는 실제 컨벤션이다. 새 코드는 주변 코드와 구분되지 않도록 맞춘다.

## 언어·모듈

- **TypeScript strict + ESM.** 모든 워크스페이스 `"type": "module"`.
- **backend 상대 임포트는 `.js` 확장자 필수.** ESM + tsx 규칙. 예: `import { config } from './config.js';`, `from './kis/rest.js'`.
- **frontend 상대 임포트는 확장자 없음** (Vite 번들러 해석). 예: `from './config'`.
- 공유 타입은 항상 `@invest/shared`에서 임포트. 상대경로로 shared를 파고들지 않는다.
- **타입 임포트는 `import type`** 으로 분리. 예: `import type { Trade, ConnectionStatus } from '@invest/shared';`

## 네이밍

| 대상 | 규칙 | 예시 |
|------|------|------|
| 파일 (backend/로직) | camelCase | `watchlist.ts`, `realtime.ts` |
| 파일 (React 컴포넌트) | PascalCase | `App.tsx`, `Chart.tsx` |
| 훅 | `use` 접두사 | `useStream.ts` |
| 함수/변수 | camelCase | `getDailyCandles`, `approvalKey` |
| 타입/인터페이스/클래스 | PascalCase | `WatchItem`, `KisRealtime` |
| 상수 (모듈 레벨 불변) | UPPER_SNAKE | `TR_TRADE`, `FIELDS_PER_RECORD`, `RECONNECT_MS`, `WATCHLIST` |
| KIS 원본 필드 | KIS 스펙 그대로 (약어) — **단, `kis/` 내부에서만** | `stck_prpr`, `hts_kor_isnm` |

## 주석

- **한국어 주석.** 파일 상단에 그 모듈의 역할·주의점을 블록 주석으로 요약한다 (기존 모든 파일이 이 패턴).
- "왜"를 적는다. KIS 스펙의 함정(필드명 차이, 프레임 포맷, 발급 제한 등)은 반드시 주석으로 남긴다.
- 섹션 구분에 `// ── 제목 ────` 스타일 구분선 사용 (server.ts 참고).

## 함수/타입 스타일

- **명시적 반환 타입.** 공개 함수는 반환 타입을 적는다. 예: `export async function getQuote(code: string): Promise<Quote>`, `function signColor(sign: string): string`.
- 순수 헬퍼는 파일 하단 또는 사용처 근처에 작은 함수로 분리 (`yyyymmdd`, `toCandlestickData`, `formatPrice`).
- 외부 JSON은 `as Record<string, unknown>` / `as Record<string, string>`로 받은 뒤 `Number(...)`로 좁혀 정규화한다. `any` 금지.
- `??`(nullish)와 옵셔널 체이닝 적극 사용. 기본값은 정규화 지점에서 부여.

## React 컨벤션

- 함수형 컴포넌트 + 훅. `export function App(): JSX.Element`.
- `useEffect` 의존성 배열 정확히. cleanup에서 소켓/타이머/차트 정리 (`useStream`, `Chart` 참고).
- WebSocket·차트 인스턴스 등 렌더 사이 유지 대상은 `useRef`. 렌더에 반영할 값만 `useState`.
- 상태 갱신은 불변 업데이트: `setState((s) => ({ ...s, trades: { ...s.trades, [code]: t } }))`.
- 스타일은 `styles.css` 클래스 기반 (BEM 유사: `watch-row__price`). 인라인 스타일은 동적 색상 등 최소한만.

## 금지 패턴

- ❌ `kis/` 밖에서 KIS 원본 필드명 사용
- ❌ 프론트에서 KIS 자격증명/도메인 직접 참조
- ❌ `any` (외부 JSON은 `unknown` 경유 후 좁히기)
- ❌ backend 상대 임포트에서 `.js` 누락
- ❌ vts/prod 도메인·포트 하드코딩 (`config.ts` 경유)
- ❌ 매 요청마다 토큰 재발급 (캐시 우회)
- ❌ `console.log` 디버그 잔여물 (백엔드는 Fastify `app.log`/`req.log` 사용)

## 포맷

- 들여쓰기 2칸, 세미콜론 O, 문자열 작은따옴표, trailing comma O.
- `tsconfig`: `strict`, `noUnusedLocals`, `noUnusedParameters` (frontend). 미사용 변수/파라미터는 빌드 실패로 이어지므로 남기지 않는다.

## 화면 용어

같은 것을 한 가지 말로만 부른다. 예전에는 연습용 계좌 하나를 화면에서
`Paper KRW` · `PAPER` · `paper` · `모의` · `시뮬` · `테스트매매` · `가상`
일곱 가지로 불러, 처음 보는 사람은 이것들이 같은 계좌인지 알 수 없었다.

| 개념 | 쓰는 말 | 쓰지 않는 말 |
|------|------|------|
| 실제 돈이 오가는 계좌 | `실계좌` | 실전, LIVE, 라이브 |
| 연습용 계좌 | `모의계좌` | Paper, PAPER, paper, 시뮬, 테스트매매, 가상 |
| 연습용 계좌로 하는 매매 | `모의투자`, `모의 주문`, `모의 매수/매도` | 시뮬레이션, 가상 매수/매도, 테스트매매 |
| 데이터를 다시 받는 동작 | `새로고침` | 갱신(동작), 리프레시 |
| 마지막으로 받은 시각 | `갱신 10:52:57`, `갱신 3초 전` | 조회 3초 전, 마지막 조회 |
| 아직 시세가 안 온 항목 | `시세 대기` | 조회 대기 |
| 계좌·체결 데이터를 아직 안 받음 | `조회 대기` | — |
| 실주문 게이트 상태 | `주문 가능` / `주문 잠김` / `확인 중` | 조회 전용, 조회 전용 세션, 전송 잠김, 전송 가능, 실주문 세션, 게이트 확인 중 |
| KIS 서버 환경 | `실전 서버` / `모의 서버` | prod, vts |

`모의계좌`(우리 연습 계좌)와 `모의 서버`(KIS의 모의투자 서버)는 다른 것이다.
KIS 환경을 가리킬 때는 반드시 `서버`를 붙인다.

코드 내부 식별자(`mode: 'paper'`, `TradingMode`)는 그대로 둔다. 화면에 나가는
문자열만 위 표를 따른다.

한 상태를 여러 화면에서 보여줄 때 각 화면이 제 나름의 말을 붙이지 않는다.
`liveOrderGate.enabled` 하나가 헤더에서는 `조회 전용`, 하단 도크에서는
`조회 전용 세션`, 주문 패널에서는 `전송 잠김`이라 불려 한 화면에 세 이름이
동시에 떠 있었다. 같은 값에서 나오면 같은 말을 쓴다.

`조회`는 계좌·체결 데이터를 불러오는 동작에만 쓴다. 한때 읽기 전용 모드
(`조회 전용`), 시세 수신 시각(`조회 3초 전`), 값 없는 칸(`조회 대기`)까지
같은 말을 써서 세 가지 뜻이 겹쳤다.

화면 글에 영어를 남기지 않는다 — `뉴스 ticker`, `검색 기반 fallback`이 그랬다.
`.env`나 환경변수 이름처럼 운영자가 그대로 입력해야 하는 것은 예외다.

> DB(`trading_accounts`) 기반 모의계좌는 주문 화면과 내 계좌 화면에서 걷어냈다.
> 실계좌를 연결해 쓰는데 연습 계좌가 나란히 놓여 어느 계좌로 주문이 나가는지
> 헷갈렸기 때문이다. 지금 `모의`가 남아 있는 곳은 `발견 > 모의투자` 탭 하나뿐이고,
> 이건 서버 없이 localStorage만 쓰는 별도 연습 도구다.

### 전문용어

처음 보는 사람이 모르는 말은 뜻을 붙인다. 다만 설명을 라벨 옆에 다 적으면
화면이 빽빽해지므로, `App.tsx`의 `GLOSSARY`에 뜻을 등록하고 `<Term>`으로 감싼다.
점선 밑줄로 "설명이 있다"만 보이고 뜻은 툴팁에 있다.

`<option>` 안에는 툴팁을 붙일 수 없으므로 선택지 글 자체로 뜻을 밝힌다.
`DAY` 같은 약어는 그대로 두지 않는다.

    시장가 → 시장가 — 지금 값에 바로
    DAY   → 오늘 안에
    IOC   → 즉시, 안 되면 취소

### 재지 않은 숫자

화면 구성을 보려고 넣어 둔 상수를 실제 값처럼 보여주지 않는다. 종목명이
진짜면 그 옆 숫자도 진짜로 읽힌다 — 히트맵이 `삼성전자 +0.22%`를 고정값으로
띄우고 있었고, 리더보드는 사용자의 실제 손익을 지어낸 참가자들과 같은
순위표에 넣고 있었다.

값을 지우면 화면 구성을 못 보므로, 지우는 대신 `<SampleBadge note="…" />`로
밝힌다. `note`에는 **무엇이 예시인지**를 적는다 — "예시입니다"만으로는
어디까지가 실제인지 알 수 없다.

    <SampleBadge note="my-simulation만 내 기록입니다. 나머지 참가자와 손익은 …" />

붙는 자리는 `.terminal-page__header` 또는 `.terminal-panel__header`다.
상태색(초록/노랑)은 쓰지 않는다. 정상/경고 신호가 아니라 "재지 않은 값"이라는
표시라서, 점선 테두리로 구분만 한다.

데이터가 없는 항목에 순위·점수를 매기지 않는다. 정렬 키에 `?? 0`을 쓰면 값이
없는 쪽이 전부 0으로 묶여 배열 순서가 그대로 등수가 된다. 값이 있는 것만
순위에 넣고, 나머지는 등수 없이 `CollapsibleRows`로 접어 사유와 함께 둔다.
