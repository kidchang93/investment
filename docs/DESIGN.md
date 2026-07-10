# DESIGN

## 설계 원칙

1. **경계에서 정규화(Anti-Corruption Layer).** KIS 원본 스펙(약어 필드, TR_ID, 프레임 포맷)은 `backend/src/kis/`에 격리한다. 바깥은 `@invest/shared`의 명시적 타입만 안다. → KIS 스펙이 바뀌어도 파장이 `kis/`에 갇힌다.
2. **타입 우선(Type-first) 계약.** 백엔드↔프론트의 계약은 `shared/src/index.ts`의 인터페이스가 유일한 진실이다. 새 필드는 여기서 먼저 정의하고 양쪽을 맞춘다.
3. **프론트는 KIS를 모른다.** 프론트가 KIS 자격증명·엔드포인트·필드명을 참조하는 순간 설계 위반이다.
4. **단일 상류 연결, 다중 하류 팬아웃.** KIS 실시간 WS는 서버당 1개만 맺고, 프론트 N명에게 broadcast한다. 프론트가 늘어도 KIS 연결은 1개다.

## 주요 설계 결정과 이유

| 결정 | 이유 |
|------|------|
| `shared`를 빌드 없이 소스(`src/index.ts`) 직접 참조 | 타입 전용 패키지라 컴파일 산출물이 불필요. tsx/vite가 소스를 그대로 소비 |
| `access_token`을 파일 캐시(`.cache/token-{env}.json`) | KIS 발급 횟수 제한. 24h 유효, 만료 1분 전까지 재사용 |
| `approval_key`는 메모리 캐시 | WS 접속용, 프로세스 수명 동안만 유효하면 충분 |
| REST 헬퍼 `kisGet(path, trId, params)` 공통화 | 모든 조회가 동일한 인증 헤더 + tr_id 패턴. 중복 제거 |
| `KisRealtime`을 `EventEmitter`로 | 파싱(체결/상태)과 중계(broadcast)를 느슨하게 분리. 서버는 `'trade'`/`'status'`만 구독 |
| 실시간 체결로 "오늘 캔들"을 `update` | H0STCNT0 프레임에 당일 시/고/저/현재가가 모두 담겨 있어 추가 조회 없이 마지막 캔들 갱신 가능 |
| 프론트에서 종목별 **최신 체결만** 유지 (`trades[code]`) | 렌더링에 필요한 건 최신값. 전체 히스토리를 메모리에 쌓지 않는다 |
| 자동 재접속 (백엔드 KIS·프론트 스트림 양쪽) | 3초 후 재연결, 재접속 시 구독 전량 재등록 |

## 도메인 모델 (shared 타입)

| 타입 | 의미 | 생성 위치 |
|------|------|------|
| `WatchItem` | 감시 종목 `{code, name}` | `watchlist.ts` |
| `Candle` | 캔들 1개. `time`은 lightweight-charts용 **UTC epoch seconds** | `rest.ts` |
| `CandlesResponse` | 일봉 조회 응답 | `rest.ts` |
| `Trade` | 실시간 체결 1건 (H0STCNT0 정규화) | `realtime.ts` |
| `Quote` | 현재가 스냅샷 (inquire-price 정규화) | `rest.ts` |
| `ServerMessage` | WS 스트림 판별 유니언 `trade \| status` | `server.ts` broadcast |
| `ConnectionStatus` | KIS 연결 상태 | `realtime.ts` |

### 부호(sign) 규약 (KIS 공통)
`1`=상한, `2`=상승, `3`=보합, `4`=하한, `5`=하락. 색상 매핑은 상승계열(1/2) 빨강, 하락계열(4/5) 파랑 — **한국 관례(상승=적색)** 를 따른다.

## 새 기능 추가 시 따라야 할 패턴

### 새 KIS 조회 추가
1. `shared/src/index.ts`에 응답 타입 정의
2. `backend/src/kis/rest.ts`에서 `kisGet()`로 호출 → 원본을 새 타입으로 정규화
3. `server.ts`에 라우트 추가 (로직 X, 위임만)
4. `frontend/src/api.ts`에 fetch 함수 추가

### 새 실시간 TR 구독 추가
1. `shared`에 정규화 타입 + `ServerMessage` 유니언에 variant 추가
2. `realtime.ts`에 TR_ID 상수·구독·프레임 파서 추가 → 새 이벤트 emit
3. `server.ts`에서 이벤트 → broadcast 연결
4. `useStream.ts`에서 새 메시지 타입 소비

> 규칙: 원본 필드는 `kis/`를 넘지 않는다. 유니언 추가 시 프론트의 `switch`도 함께 갱신(exhaustive).
