# SUBAGENTS

이 레포에서 서브에이전트(Agent 도구 / Workflow)를 운영하는 방식.

## 프롬프트 필수 컨텍스트 (전파 규칙)

모든 서브에이전트 프롬프트에 다음을 반드시 포함한다:

- 루트 `CLAUDE.md` 경로
- 작업 관련 docs 경로 (아래 매핑)
- "KIS 원본 필드는 `backend/src/kis/` 밖으로 노출 금지, 계약은 `@invest/shared` 타입 기준" 이라는 핵심 제약

| 작업 유형 | 함께 전달할 docs |
|------|------|
| 구조 파악/파일 위치 | `docs/ARCHITECTURE.md` |
| KIS 연동/타입/정규화 | `docs/DESIGN.md` + `docs/ARCHITECTURE.md` |
| 코드 작성 | `docs/CODE_STYLE.md` |
| 리뷰 | `docs/REVIEW.md` |

## 이 레포 전용 에이전트 (`.claude/agents/`)

역할별로 다섯을 정의해 두었다. 각자 자기 시스템 프롬프트·도구·금지사항을 갖고 격리된
컨텍스트에서 돈다. **주문 권한은 `live-trader` 하나뿐이다.**

| # | 에이전트 | 하는 일 | 도구 | 주문 |
|---|------|------|------|------|
| 1 | `market-researcher` | 타사 앱·KIS API·제도를 **출처로 확인**. 레포 밖 사실 | 읽기 + 웹 | ✗ |
| 2 | `data-analyst` | 시세·체결·손익·화면이 **실제로 무엇인지 측정** | 읽기 + Bash | ✗ |
| 3 | `trading-dev` | 구현하고 test·typecheck·build까지 통과시킨다 | 쓰기 포함 | ✗ |
| 4 | `quant-strategist` | 전략 설계와 **백테스트 결과 해석·판단** | 읽기 + Bash + **임시 스크립트 작성** | ✗ |
| 5 | `live-trader` | 실주문 전송·정정·취소·예약주문 | 읽기 + Bash | **○** |

2번과 4번의 경계는 **재는 쪽 vs 해석하는 쪽**이다. 2번이 "승률 41%가 실측값이다"를 내놓으면
4번이 "이 전략을 쓸지"를 판단한다.

`live-trader`에게도 **게이트를 여는 권한은 없다.** `KIS_LIVE_ORDER_ENABLED`는 사용자가 연다
(`docs/TRADING_API.md` §실주문 게이트).

## 에이전트를 엮는 스킬 (`.claude/skills/`)

에이전트 파일은 "누가 무엇을 하나"만 정한다. **"언제 어떤 순서로 부르나"는 스킬이 정한다.**

| 스킬 | 범위 |
|------|------|
| `trading-loop` | 한 바퀴 전체 — 조사 → 측정 → 판단 → 구현 → **검수** → (실행) → 기록 |
| `broker-gap` | 그중 앞부분만 — 타사 조사 → 우리 앱 대조 → Notion 요구사항 축적 |

**검수는 스킬이 하지 에이전트가 하지 않는다.** 서브에이전트 산출물을 그대로 믿지 않는 것이
이 구조의 핵심이다(아래 검수 기준).

## 범용 에이전트

| 역할 | 에이전트 | 용도 |
|------|------|------|
| 탐색 | `Explore` | 파일/심볼 위치, 네이밍 관례 조사. 읽기 전용, 결론만 회수 |
| 설계 | `Plan` | 새 기능 구현 전략, 트레이드오프 정리 |
| 구현/조사 | `general-purpose` | 위 다섯에 안 맞는 다단계 작업 |
| 리뷰 | `/code-review` 스킬 | 변경 diff의 correctness/스타일 점검 |

## 병렬화해도 안전한 작업

레이어가 명확히 분리돼 있어 다음은 병렬 팬아웃에 적합하다:

- **워크스페이스별 독립 조사** — `shared` / `backend` / `frontend`는 서로 의존하지 않으므로 동시에 읽어도 안전.
- **읽기 전용 탐색** — 여러 관점(구조/컨벤션/도메인)으로 동시에 `Explore`.
- **문서 생성** — 각 docs 파일은 독립적으로 작성 가능.

## 순차로 해야 하는 작업 (경계 있음)

- **`shared` 타입 변경 → backend/frontend 반영** — 계약이 먼저다. 타입을 바꾼 뒤에야 양쪽을 수정한다. 동시에 하면 불일치.
- **`ServerMessage` 유니언 추가** — shared → realtime/server(emit·broadcast) → useStream(소비) 순서 의존.
- **같은 파일 동시 편집 금지** — 병렬 구현이 필요하면 `isolation: 'worktree'`로 격리하거나 파일 단위로 분할.

## 결과물 검수 기준

서브에이전트 산출물은 반영 전 반드시 확인한다:

1. `docs/CODE_STYLE.md` 준수 (`.js` 확장자, `import type`, 네이밍, 한국어 주석)
2. `docs/REVIEW.md` 체크리스트 통과
3. `npm run typecheck` (backend/frontend) + `npm run build` 오류 0
4. KIS 원본 필드가 `kis/` 밖으로 새지 않았는지 확인
