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
