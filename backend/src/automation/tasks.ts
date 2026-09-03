/**
 * **자동화 작업표.** 데몬이 셸에서 하던 일을 여기로 옮긴다.
 *
 * ── 왜 옮기나 (2026-09-02) ───────────────────────────────────────────────
 *
 * 사용자가 말했다 — *"웹에서 컨트롤하고 싶은데 데몬 이런 게 아니라."*
 *
 * 데몬(`scripts/daemon.sh`)은 터미널에 묶여 있어서 **켜고 끄는 것도, 지금 무엇이
 * 도는지 보는 것도 명령어를 쳐야** 한다. 그런데 데몬이 실제로 하는 일은
 * **"시각을 보고 스크립트를 부르는 것"** 하나뿐이다. 그 일은 이미 상주하는
 * 백엔드가 할 수 있고, 그러면 웹에서 REST로 제어된다.
 *
 * ★ **로직을 복제하지 않는다.** 각 작업은 데몬이 부르던 것과 **같은 명령**을
 *   부른다. 옮기는 것은 "언제 부를까"뿐이다 — 실제 일은 그대로 그 스크립트가
 *   한다. 두 곳에 같은 로직을 두면 한쪽만 고쳤을 때 조용히 갈라진다.
 *
 * ★ **하트비트도 같은 표를 쓴다**(`trading_heartbeats`). 데몬 시절 기록과
 *   이어지고, `status.sh`·경보·화면이 이미 그 표를 읽는다.
 *
 * ── 창이 넓은 이유 ───────────────────────────────────────────────────────
 *
 * 늦게 켜도 그날 것을 한 번은 하기 위해서다. 08:59에 켜면 브리핑과 판단자가
 * 09:20에라도 돈다 — 하트비트에 몇 시에 했는지 적히므로 "제때 했나"는 그것으로
 * 판별한다. (2026-08-19에 재부팅으로 08:59에 뜬 날 브리핑을 통째로 건너뛴 적이
 * 있어 넓혔다.)
 */

/** `HHMM` 정수. 09:05는 905다 */
export type Clock = number;

export interface TaskSpec {
  /** 하트비트 이름. **이것이 "오늘 했나"의 유일한 근거다** */
  name: string;
  label: string;
  /** 실행 가능한 시각 창 `[시작, 끝]`. 끝은 포함하지 않는다 */
  window: [Clock, Clock];
  /**
   * 새로 사고파는 일인가. `true`면 **매매 없음 모드에서 건너뛴다.**
   *
   * ★ 손절은 여기 `false`다 — `plan.stopPrice`는 판단자가 사기 전에 스스로 적은
   *   값이라, 지키는 것은 새 매매가 아니라 **약속을 지키는 것**이다.
   */
  trading: boolean;
  /**
   * 하루 한 번인가. `false`면 창 안에서 `slot`마다 한 번씩 돈다(감시·손절).
   */
  daily: boolean;
  /**
   * 몇 분마다 도나(`daily: false`일 때만). 하트비트 이름에 슬롯이 붙는다.
   * 손절처럼 하트비트를 남기지 않는 것은 `0`이다.
   */
  everyMinutes?: number;
  /** 셸에서 부를 명령. 레포 루트에서 돈다 */
  command: string;
  /**
   * 오래 걸려 루프를 막으면 안 되는 작업. 백그라운드로 띄우고 바로 넘어간다.
   * (일봉 수집 3시간 · 단일가 수집 13분)
   */
  background?: boolean;
  /**
   * 성공해도 하트비트를 남기지 않는다. 손절이 그렇다 — 매 분 돌면 하루 390건이
   * 쌓인다. 실제로 집행됐을 때만 따로 남긴다.
   */
  noHeartbeat?: boolean;
  /**
   * ★★ **밖에서 같은 일이 이미 돌고 있나**를 보는 `pgrep -f` 패턴.
   *
   * 2026-09-03에 판단자가 **두 벌 떴다.** 사람이 08:46에 손으로 소집했는데
   * 그것이 아직 하트비트를 안 남긴 상태에서, 08:48에 매매를 켜자 스케줄러가
   * 08:49 회차에 *"오늘 아직 안 했다"*고 읽고 또 불렀다. **헤드리스 Claude 두
   * 벌이 같은 계좌를 판단했고**, 그대로 뒀으면 회차가 둘 남아 집행기가 각각
   * 주문을 냈을 것이다.
   *
   * 스케줄러의 `running` 집합은 **자기가 띄운 것만** 안다. 사람이 손으로 돌린
   * 것·이전 인스턴스가 남긴 것은 프로세스를 직접 봐야 알 수 있다.
   *
   * ★ 비싸거나 부작용이 있는 작업에만 건다. 손절처럼 멱등한 것은 필요 없다.
   */
  guard?: string;
}

/**
 * ★ 순서가 곧 우선순위다. 한 회차에 여러 개가 걸리면 위에서부터 돈다.
 *   브리핑이 판단자보다 먼저인 것은 그 결과를 재료로 쓰기 때문이다.
 */
export const TASKS: TaskSpec[] = [
  {
    name: 'premarket',
    label: '개장 전 브리핑',
    window: [812, 1530],
    trading: false,
    daily: true,
    command: 'zsh scripts/premarket.sh',
  },
  {
    name: 'auction-open',
    label: '시가 단일가 수집',
    window: [830, 835],
    trading: false,
    daily: true,
    background: true,
    guard: 'measureAuctionSlippage.ts --open',
    command: 'cd backend && npx tsx src/scripts/measureAuctionSlippage.ts --open',
  },
  {
    name: 'deliberate',
    label: '판단자 소집',
    window: [820, 1530],
    trading: true,
    daily: true,
    // 헤드리스 Claude라 두 벌이 뜨면 비용도 두 배이고 회차도 둘 남는다.
    guard: 'deliberate.sh',
    command: 'zsh scripts/deliberate.sh',
  },
   {
    /*
     * ★ **매 분 돈다.** 급락에 판단자를 부르면 1~2분이 걸리고 그 지연이 치명적이라
     *   규칙이 즉시 집행한다. 주문은 `clientOrderId`(`stop-{종목}-{날짜}`)로 서버가
     *   하루 한 번만 통과시키므로 매 분 돌아도 안전하다.
     */
    name: 'stop-loss',
    label: '손절 감시',
    window: [901, 1520],
    trading: false,
    daily: false,
    everyMinutes: 1,
    noHeartbeat: true,
    command: 'cd backend && npx tsx src/scripts/enforceStops.ts VTS-ORDINARY --execute',
  },
  {
    name: 'watch',
    label: '장중 감시·경보',
    window: [910, 1521],
    trading: false,
    daily: false,
    everyMinutes: 20,
    command: 'zsh scripts/watch.sh && (cd backend && npx tsx src/scripts/checkAlerts.ts --notify)',
  },
  {
    /*
     * ★★ **적정가 분석** (2026-09-03). 사용자가 정했다 — *"분석가는 KIS와
     *    차트분석 및 웹 뉴스 이 세가지를 분석해서 적정가를 슬랙으로 5분마다
     *    메세지 보내줘"*, 그리고 *"판단자가 그 가격을 보고 매수할지 매도할지
     *    정해서 집행하는 시퀀스."*
     *
     * ★ **Claude를 안 부른다.** 5분마다면 하루 78회라 헤드리스로 돌리면 판단자의
     *   수십 배가 된다. 적정가는 재무·차트로 **계산**하고 뉴스는 제목을 붙인다 —
     *   해석은 판단자의 일이고, 여기서 또 하면 같은 판단을 두 번 사는 것이다.
     */
    name: 'fair-value',
    label: '적정가 분석',
    window: [905, 1520],
    trading: false,
    daily: false,
    everyMinutes: 5,
    command: 'cd backend && npx tsx src/scripts/analyzeFairValue.ts VTS-ORDINARY',
  },
  {
    name: 'auction-close',
    label: '종가 단일가 수집',
    window: [1520, 1525],
    trading: false,
    daily: true,
    background: true,
    guard: 'measureAuctionSlippage.ts --close',
    command: 'cd backend && npx tsx src/scripts/measureAuctionSlippage.ts --close',
  },
  {
    /*
     * ★★ **미체결 정리** (2026-09-03). 사용자가 정했다 — *"미체결 건은 5분 이상
     *    미체결이면 가격을 조정해서 주문을 넣어야 되는데 적정가 수준에서 주문
     *    넣어야 돼. 그게 아니라면 철회하는 게 맞아."*
     *
     * ★ 그날 **20일 묵은 미체결 두 건**이 나왔다(8/14 KODEX 200 45주 ·
     *   ACE KRX금현물 170주). 모의에서 미체결 조회가 늘 실패해 아무도 몰랐고,
     *   예수금이 그만큼 묶인 채 **값이 닿으면 3주 전 판단으로 체결될** 참이었다.
     *
     * ★ 적정가 분석 **뒤에** 둔다 — 정정 기준이 그 값이라 최신이어야 한다.
     */
    name: 'open-orders',
    label: '미체결 정리',
    window: [905, 1520],
    trading: true,
    daily: false,
    everyMinutes: 5,
    guard: 'manageOpenOrders.ts',
    command: 'cd backend && npx tsx src/scripts/manageOpenOrders.ts VTS-ORDINARY --execute',
  },
  {
    /*
     * ★ `layerSync`에 `--layer`를 주지 않는다. 층 모르는 체결을 자동으로 ETF에
     *   넣지 않기 위해서다(2026-08-22) — 그런 체결이 있으면 exit 3으로 알려 오고
     *   사람이 층을 정해야 한다. 자동이 짐작하면 두 층의 손익이 함께 거짓이 되고
     *   잔고 대조로는 안 걸린다.
     */
    name: 'close',
    label: '마감 정리',
    window: [1540, 1620],
    trading: false,
    daily: true,
    command:
      'zsh scripts/close.sh; cd backend'
      + ' && npx tsx src/scripts/layerSync.ts VTS-ORDINARY --apply'
      + ' ; npx tsx src/scripts/layerReport.ts',
  },
  {
    /*
     * ★ **장중에는 절대 돌리지 않는다.** 2026-08-18에 13:50에 돌렸더니 5분 만에
     *   화면과 경보가 502를 받았다 — 수집이 1.2초마다 KIS를 두드려 잔고 조회와
     *   유량을 다툰다. 스크립트에도 가드가 있지만 여기서도 그 시간을 피한다.
     */
    name: 'daily-bars',
    label: '일봉 수집',
    window: [1545, 1700],
    trading: false,
    daily: true,
    background: true,
    guard: 'collectDailyBars.ts',
    command: 'cd backend && npx tsx src/scripts/collectDailyBars.ts --refresh',
  },
];

/** 이 시각에 돌아야 하는 작업인가 */
export function isInWindow(task: TaskSpec, clock: Clock): boolean {
  return clock >= task.window[0] && clock < task.window[1];
}

/**
 * 이 회차의 하트비트 이름. 주기 작업은 슬롯이 붙는다.
 *
 * ★ 슬롯을 `시 * 100 + 분/주기`로 만든다 — 데몬이 쓰던 `watch-HHs` 방식과
 *   같은 모양이라 기록이 이어진다.
 */
export function heartbeatName(task: TaskSpec, clock: Clock): string {
  if (task.daily || !task.everyMinutes) return task.name;
  const hour = Math.floor(clock / 100);
  const minute = clock % 100;
  return `${task.name}-${hour}${Math.floor(minute / task.everyMinutes)}`;
}
