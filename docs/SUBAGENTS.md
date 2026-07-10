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

## 역할 분담

| 역할 | 에이전트 | 용도 |
|------|------|------|
| 탐색 | `Explore` | 파일/심볼 위치, 네이밍 관례 조사. 읽기 전용, 결론만 회수 |
| 설계 | `Plan` | 새 기능 구현 전략, 트레이드오프 정리 |
| 구현/조사 | `general-purpose` | 다단계 구현, 확신 없는 검색 |
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
