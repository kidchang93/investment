# REVIEW

## 머지 전 필수 통과 조건

```bash
npm test                       # node:test — 통과 필수
npm run typecheck              # backend tsc --noEmit — 통과 필수
npm run typecheck -w frontend  # frontend tsc --noEmit — 통과 필수
npm run build                  # frontend vite build — 통과 필수
```

네 명령 모두 오류 0이어야 머지한다. (frontend는 `noUnusedLocals`/`noUnusedParameters`로 미사용 심볼도 실패 처리됨)

### 화면을 고쳤으면 콘솔도 본다

렌더 결과만 보면 놓치는 게 있다. 콘솔을 비우고 새로고침한 뒤 오류가 0인지
확인한다.

개발 중에는 Vite가 편집 중인 파일을 핫리로드해 `ReferenceError`가 잠깐 쌓인다.
파일을 다 쓰기 전에 저장되면 그렇다. 그건 실제 결함이 아니므로 **콘솔을 비우고
새로 로드해서** 다시 나는지로 가른다 — 실제로 86건이 쌓여 있었는데 전부
편집 중간 상태였고, 지우고 새로 로드하니 0이었다.

## 리뷰 체크리스트

### Correctness
- [ ] KIS 원본 필드 인덱스/이름이 스펙과 일치하는가 (`realtime.ts`의 `f[n]`, `rest.ts`의 필드명)
- [ ] 복수 응답을 요청 순서에 **그냥 붙이지** 않았는가 — 코드로 검산했는가 (`multiQuote.ts`). 한 칸 밀려도 다른 종목의 그럴듯한 가격이 나와 형식 검사로는 안 걸린다
- [ ] 빈 문자열을 `Number()`로 읽지 않았는가 (`Number('')`은 0이다 → `toNumberOrNaN`)
- [ ] `Candle.time`이 UTC epoch **seconds** 인가 (ms 아님). `Date.UTC(...)/1000`
- [ ] 캔들 배열을 **오름차순**으로 정규화했는가 (KIS output2는 내림차순)
- [ ] `Number(...)` 변환 후 `NaN`/0 유입 가능성 (예: `Number.isFinite` + `> 0` 필터)
- [ ] WebSocket/타이머/차트 인스턴스의 cleanup이 있는가 (재접속·언마운트 누수 방지)
- [ ] 재접속 시 구독 재등록이 보장되는가 (`KisRealtime.connect`의 open 핸들러)
- [ ] `ServerMessage` 유니언을 추가했다면 프론트 소비부(`useStream`)도 갱신했는가

### 경계·설계
- [ ] KIS 원본 필드/엔드포인트가 `kis/` 밖으로 새지 않았는가
- [ ] 프론트가 KIS 스펙에 의존하지 않는가 (오직 `@invest/shared`)
- [ ] 새 계약이 `shared`에 타입으로 먼저 정의됐는가
- [ ] `server.ts`에 비즈니스 로직이 아니라 wiring만 있는가

### 보안
- [ ] `.env` / `.cache/` 가 커밋에 포함되지 않았는가 (`.gitignore` 확인)
- [ ] 자격증명·토큰이 로그/응답 body에 노출되지 않는가
- [ ] 두 인증 엔드포인트 시크릿 필드명이 올바른가 (`appsecret` vs `secretkey`)
- [ ] CORS/포트 등 배포 설정이 하드코딩 아닌 env 기반인가

### 스타일
- [ ] backend 상대 임포트에 `.js` 확장자
- [ ] `import type` 분리, `any` 미사용
- [ ] 한국어 파일 상단 주석 + "왜"에 대한 설명
- [ ] 네이밍 규칙 (컴포넌트 PascalCase, 훅 use-, 상수 UPPER_SNAKE)

## 리뷰 시 흔한 실수

1. **backend에서 `.js` 확장자 누락** → 런타임 모듈 해석 실패 (typecheck는 통과할 수 있음).
2. **캔들 `time`을 ms로** 넣어 차트가 안 그려짐.
3. **KIS output2 정렬 미처리** — 내림차순 그대로 넣으면 lightweight-charts가 거부.
4. **토큰 재발급 남발** — 캐시 로직을 우회해 발급 제한에 걸림.
5. **`appsecret`/`secretkey` 혼동** — approval_key 발급이 조용히 실패.
6. **cleanup 누락** — 종목 전환/재접속 시 소켓·차트·타이머 누수.
7. **유니언 추가 후 프론트 미갱신** — 새 메시지가 무시됨.
