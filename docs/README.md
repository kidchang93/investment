# docs 색인

이 레포의 문서 세트를 한 줄씩 정리한다. 각 문서를 열기 전에 여기서 어떤 걸
읽어야 하는지부터 확인한다 (레포 루트 `CLAUDE.md`의 "docs/ 인덱스" 표와 같은
매핑을 문서 쪽에서 다시 정리한 것).

## 문서 목록

| 문서 | 담는 내용 |
|------|------|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | 모듈 구조(백엔드 `kis/` 레이어, 프론트 화면 구성), 데이터 흐름(REST/WS), 다계좌 자격증명 모델 |
| [`DESIGN.md`](./DESIGN.md) | 설계 원칙(경계에서 정규화, 타입 우선 계약), 주요 설계 결정과 이유, `shared` 도메인 모델, 새 기능 추가 패턴 |
| [`CODE_STYLE.md`](./CODE_STYLE.md) | 네이밍·포맷·언어별 컨벤션, 화면 용어 통일 규칙, 재지 않은 숫자·조회 실패 처리 같은 화면 문구 기준 |
| [`REVIEW.md`](./REVIEW.md) | 머지 전 필수 통과 조건(`npm test`/`typecheck`/`build`), 리뷰 체크리스트, 흔한 실수 |
| [`SUBAGENTS.md`](./SUBAGENTS.md) | 서브에이전트 역할 분담, 병렬화해도 안전한 작업과 순차로 해야 하는 작업, 결과물 검수 기준 |
| [`TRADING_API.md`](./TRADING_API.md) | KIS 매매 API 구현 현황(조회·주문), 실주문 게이트, 리스크 룰, 막혀 있는 항목과 해결 방법(장운영 구분 코드, TR_ID 개편 대응표 포함) |
| [`TRADING_ROADMAP.md`](./TRADING_ROADMAP.md) | 매매 기능 목표·DB 설계·구현 순서, 전략 백테스트 판정이 여러 번 뒤집힌 과정, 자동매매 후보 거르기(3중 필터) 근거 |
| [`USER_FINDINGS.md`](./USER_FINDINGS.md) | 실제 주문자 관점으로 앱을 써보며 찾은 문제·요구사항 기록(1차·2차). 규범 문서가 아니라 관찰 기록 — 다른 docs와 충돌하면 다른 docs가 기준 |
| [`manual.html`](./manual.html) | `MANUAL.md`를 읽기 좋게 옮긴 웹 페이지(아티팩트 원본). 자기완결 HTML이라 그대로 열면 된다. **내용의 출처는 `MANUAL.md`이니 고칠 때는 그쪽을 먼저 고친다** |
| [`MANUAL.md`](./MANUAL.md) | 초보자용 사용 설명서. 화면 세 개(종목/내 계좌/발견) 안내, 안전 장치(게이트·리스크 룰·확인 단계), 주문 내는 법, 자동매매, 전략 판정 읽는 법, 확인된 값과 어림값 구분, 차단 문구 대처표 |

## 작업 유형별로 먼저 읽을 문서

레포 루트 `CLAUDE.md`의 표와 같은 내용이다. 여기서는 `MANUAL.md`·`USER_FINDINGS.md`를
포함해 다시 정리했다.

| 작업 | 먼저 읽을 문서 |
|------|------|
| 모듈/데이터 흐름 파악, 새 파일 위치 결정 | `ARCHITECTURE.md` |
| KIS 연동·정규화·타입 추가/변경 | `DESIGN.md` |
| 코드 작성 (네이밍/패턴/화면 문구) | `CODE_STYLE.md` |
| 리뷰·머지 전 점검 | `REVIEW.md` |
| 서브에이전트로 작업 분배 | `SUBAGENTS.md` |
| 매매 API 추가·주문 전송·차단 사유 확인 | `TRADING_API.md` |
| 매매 기능 로드맵·DB 설계·백테스트 판정 근거 | `TRADING_ROADMAP.md` |
| 실제 사용자 관점에서 뭐가 걸렸는지 확인 | `USER_FINDINGS.md` |
| 앱을 처음 쓰는 사람에게 설명하기 | `MANUAL.md` |

## 문서 간 관계

- `USER_FINDINGS.md`는 **관찰 기록**이고 `ARCHITECTURE.md`·`DESIGN.md`·`CODE_STYLE.md`는
  **규범**이다. 둘이 어긋나면 규범 문서가 맞고, `USER_FINDINGS.md`가 그 어긋남을
  지적하는 쪽이다(문서 자체에 명시돼 있다).
- `MANUAL.md`는 위 모든 문서를 코드·화면과 대조해 초보자용으로 옮긴 결과물이다.
  안전 장치·주문 흐름 설명은 `TRADING_API.md`·`TRADING_ROADMAP.md`의 최신 상태를
  따르므로, 두 문서가 바뀌면 `MANUAL.md`도 함께 봐야 한다.
- `TRADING_ROADMAP.md`의 백테스트 판정(`no_edge`/`unproven`)은 코드
  (`backend/src/trading/strategy.ts`의 `backtestNote`/`verdict`)가 최신 값의 출처다.
  로드맵 문서에는 판정이 바뀌어 온 과정이 남아 있고, 화면에 뜨는 문장은 항상
  코드 쪽 값이다.
