/**
 * **에이전트 데스크 — 지금 누가 무엇을 보고 무엇을 정했나.**
 *
 * ── 왜 생겼나 (2026-09-07) ───────────────────────────────────────────────
 *
 * 사용자가 정했다 — *"화면 주문은 없이 에이전트가 현재 어떤 분석과 판단을
 * 했는지 화면으로 모니터링할 수 있게 세팅하는 게 좋을 것 같아. 하나의 증권사처럼
 * View를 꾸며주면 좋겠어. 캐릭터 만들어서 pixel 에이전트처럼."*
 *
 * 그전까지 판단은 **DB에만** 있었다. 무엇을 왜 샀는지 보려면 psql을 열거나 슬랙을
 * 뒤져야 했고, 그래서 근거가 사람에게 닿지 않았다. 자동화 카드(`Automation.tsx`)는
 * *"무엇이 언제 도는가"*를 답하지만 *"그래서 무엇을 정했나"*는 답하지 않는다.
 *
 * ★ **주문 버튼이 없다.** 이 화면은 보는 곳이다 — 사람이 끼어들 자리는 자동화
 *   스위치(위 카드)뿐이고, 주문은 에이전트가 낸다.
 */

import { useCallback, useEffect, useState } from 'react';

import { API_BASE } from './config';

// ── 픽셀 캐릭터 ──────────────────────────────────────────────────────────
//
// 12×12 격자. 한 글자가 한 픽셀이고 `PALETTE`가 색을 정한다. `.`은 투명이다.
// SVG `<rect>`로 그리므로 확대해도 뭉개지지 않는다(`shapeRendering="crispEdges"`).

const PALETTE: Record<string, string> = {
  k: '#080b11', // 외곽선
  s: '#f0cba8', // 피부
  e: '#141a24', // 눈
  w: '#e5e7eb', // 흰색
  d: '#1b2330', // 옷 그늘
};

/** 역할색은 캐릭터마다 다르다. `c`(옷)와 `a`(도구)에 들어간다. */
interface Character {
  pixels: string[];
  /** 옷 */
  coat: string;
  /** 손에 든 것 */
  tool: string;
}

/** 공통 몸통에 머리 위·손의 도구만 바꾼 것들. 한 줄에 12칸이다. */
const CHARACTERS: Record<string, Character> = {
  // 분석가 — 돋보기로 값을 들여다본다
  analyst: {
    coat: '#22d3ee', tool: '#7dd3fc',
    pixels: [
      '....aaaa....', '...a....a...', '...a....a...', '....aaaa....',
      '.....kk.....', '...kkssskk..', '..ksseessk..', '..kssssssk..',
      '...kssssk...', '..kcccccck..', '.kcccwwcccck', '..kk....kk..',
    ],
  },
  // 판단자 — 하루 한 번 발굴한다. 왕관을 쓴다
  judge: {
    coat: '#f5c451', tool: '#fde68a',
    pixels: [
      '..a..aa..a..', '..a.aaaa.a..', '..aaaaaaaa..', '...aaaaaa...',
      '.....kk.....', '...kkssskk..', '..ksseessk..', '..kssssssk..',
      '...kssssk...', '..kcccccck..', '.kcccwwcccck', '..kk....kk..',
    ],
  },
  // 종가 판단자 — 장이 닫힐 무렵에만 나온다. 달을 인다
  closeJudge: {
    coat: '#a78bfa', tool: '#c4b5fd',
    pixels: [
      '....aaa.....', '...aa.aa....', '..aa...aa...', '...aa.aa....',
      '.....kk.....', '...kkssskk..', '..ksseessk..', '..kssssssk..',
      '...kssssk...', '..kcccccck..', '.kcccwwcccck', '..kk....kk..',
    ],
  },
  // 집행기 — 정한 것을 주문으로 옮긴다. 도장을 든다
  executor: {
    coat: '#22c55e', tool: '#86efac',
    pixels: [
      '...aaaaaa...', '...a....a...', '....aaaa....', '.....aa.....',
      '.....kk.....', '...kkssskk..', '..ksseessk..', '..kssssssk..',
      '...kssssk...', '..kcccccck..', '.kcccwwcccck', '..kk....kk..',
    ],
  },
  // 파수꾼 — 손절선을 매 분 지킨다. 방패를 든다
  guard: {
    coat: '#e5484d', tool: '#fca5a5',
    pixels: [
      '...aaaaaa...', '...aaaaaa...', '...aaaaaa...', '....aaaa....',
      '.....aa.....', '...kkssskk..', '..ksseessk..', '..kssssssk..',
      '...kssssk...', '..kcccccck..', '.kcccwwcccck', '..kk....kk..',
    ],
  },
  // 정리꾼 — 안 붙는 주문을 5분마다 손본다. 빗자루를 든다
  sweeper: {
    coat: '#3b82f6', tool: '#93c5fd',
    pixels: [
      '......a.....', '.....a......', '....a.......', '...aaa......',
      '..aaaaa.....', '...kkssskk..', '..ksseessk..', '..kssssssk..',
      '...kssssk...', '..kcccccck..', '.kcccwwcccck', '..kk....kk..',
    ],
  },
  // 청산꾼 — 어제 산 것을 아침에 판다. 해를 인다
  closer: {
    coat: '#fb923c', tool: '#fdba74',
    pixels: [
      '..a..a..a...', '...a.a.a....', '....aaa.....', '...aaaaa....',
      '....aaa.....', '...kkssskk..', '..ksseessk..', '..kssssssk..',
      '...kssssk...', '..kcccccck..', '.kcccwwcccck', '..kk....kk..',
    ],
  },
};

/**
 * 걷는 프레임. **마지막 줄(다리)만 바꾼다** — 픽셀 캐릭터의 걸음은 다리 두 칸이
 * 벌어졌다 모였다 하는 것이 전부다. 몸통까지 다시 그리면 두 그림이 미세하게
 * 어긋나 캐릭터가 떨리는 것처럼 보인다.
 */
const WALK_LEGS = '...kk..kk...';

function PixelSprite({ id, size = 6, frame = 0 }: {
  id: string; size?: number; frame?: 0 | 1;
}): JSX.Element | null {
  const ch = CHARACTERS[id];
  if (!ch) return null;
  const palette: Record<string, string> = { ...PALETTE, c: ch.coat, a: ch.tool };
  const pixels = frame === 1
    ? [...ch.pixels.slice(0, -1), WALK_LEGS]
    : ch.pixels;
  return (
    <svg
      className="agent-sprite"
      viewBox="0 0 12 12"
      width={12 * size}
      height={12 * size}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {pixels.flatMap((row, y) =>
        row.split('').map((glyph, x) => {
          const fill = palette[glyph];
          return fill ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill} /> : null;
        }),
      )}
    </svg>
  );
}

// ── 서버가 주는 것 ───────────────────────────────────────────────────────

interface TaskState {
  name: string;
  label: string;
  window: [number, number];
  trading: boolean;
  daily: boolean;
  doneToday: boolean;
  lastRunAt: string | null;
  running: boolean;
  inWindow: boolean;
}

interface AutomationStatus {
  settings: { enabled: boolean; tradingEnabled: boolean };
  ticking: boolean;
  now: string;
  tasks: TaskState[];
}

interface Decision {
  symbol: string;
  name: string;
  action: 'buy' | 'sell' | 'hold' | 'amend' | 'cancel';
  quantity: number;
  rationale: string;
  limitPrice?: number;
  layer?: 'etf' | 'short' | 'bet';
  plan?: {
    targetPrice: number; stopPrice: number; horizonDays: number;
    expectedReturn: number; basis: string;
  };
}

/**
 * 에이전트가 **지금** 하는 일. 서버의 `trading_agent_activity`가 준다.
 * 하트비트는 "끝났다"를 남기므로 10~15분짜리 회차 동안 비어 있고, 그 사이를
 * 이것이 채운다.
 */
interface Activity {
  agent: string;
  activity: 'gathering' | 'screening' | 'researching' | 'writing' | 'ordering' | 'measuring' | 'idle';
  detail: string;
  updatedAt: number;
}

/** 활동별 한 마디와 머리 위 아이콘. 참조한 픽셀 사무실이 자세를 가르는 방식이다. */
const ACTIVITY_FACE: Record<Activity['activity'], { label: string; icon: string }> = {
  gathering: { label: '자료 모으는 중', icon: '📋' },
  screening: { label: '후보 훑는 중', icon: '🔎' },
  researching: { label: '뉴스 찾는 중', icon: '🌐' },
  writing: { label: '판단 적는 중', icon: '✍️' },
  ordering: { label: '주문 내는 중', icon: '📮' },
  measuring: { label: '값 재는 중', icon: '📐' },
  idle: { label: '자리 지키는 중', icon: '' },
};

/** 아직 안 붙은 주문. 정리꾼이 5분마다 손보는 대상이다. */
interface OpenOrder {
  orderNo: string;
  symbol: string;
  name: string;
  side: string;
  quantity: number;
  filledQuantity?: number;
  remainingQuantity?: number;
  price?: number;
}

interface Round {
  id: number;
  tradingDay: string;
  /** 에이전트가 스스로 적는 값이라 **믿지 않는다**. 아래 `groupByDay` 참고 */
  startedAt: number;
  /** DB가 찍은 기록 시각. 에이전트가 못 건드리므로 시각 표시는 이것을 쓴다 */
  recordedAt: number;
  trigger: string;
  triggerReason: string;
  equity: number;
  findings: Array<{ agent: string; summary: string }>;
  decisions: Decision[];
  falsifier: string;
  unknowns: string[];
  executions: Array<{ symbol: string; action: string; quantity: number; orderNo: string; blockedBy?: string[] }>;
}

// ── 에이전트 명단 ────────────────────────────────────────────────────────
//
// ★ 화면이 자기 시간표를 들고 있지 않는다. 창·주기·상태는 전부 서버가 주는
//   `tasks`에서 읽는다 — 여기 박아 두면 `tasks.ts`를 고친 날 조용히 틀린 말을 한다.

type Room = 'think' | 'act';

/**
 * 자리와 가구는 **격자 좌표**로 놓는다 — `[열, 행]`, 열은 방마다 다르고 행은 6이다.
 * 한 줄로 늘어놓지 않는 이유는 그것이 사무실이 아니라 목록이기 때문이다.
 */
interface Spot { col: number; row: number; }

const ROSTER: Array<{
  id: string; task: string; name: string; job: string; room: Room; at: Spot;
}> = [
  { id: 'analyst', task: 'fair-value', name: '분석가', job: '적정가를 계산해 슬랙으로 보낸다', room: 'think', at: { col: 1, row: 1 } },
  { id: 'judge', task: 'deliberate', name: '판단자', job: '후보를 훑고 오늘 살 것을 정한다', room: 'think', at: { col: 3, row: 1 } },
  { id: 'closeJudge', task: 'close-judge', name: '종가 판단자', job: '밤사이 오를 것을 종가에 산다', room: 'think', at: { col: 1, row: 4 } },
  { id: 'executor', task: 'close-execute', name: '집행기', job: '정한 것을 주문으로 옮긴다', room: 'act', at: { col: 1, row: 1 } },
  { id: 'closer', task: 'overnight-exit', name: '청산꾼', job: '어제 산 것을 아침에 판다', room: 'act', at: { col: 3, row: 1 } },
  { id: 'guard', task: 'stop-loss', name: '파수꾼', job: '손절선을 매 분 지킨다', room: 'act', at: { col: 1, row: 4 } },
  { id: 'sweeper', task: 'open-orders', name: '정리꾼', job: '안 붙는 주문을 손본다', room: 'act', at: { col: 3, row: 4 } },
];

/** 방 이름. **판단과 집행을 가른 것이 이 시스템의 뼈대**라 공간도 그렇게 나눈다. */
const ROOM_LABEL: Record<Room, string> = { think: '판단실', act: '집행·감시실' };

/**
 * 방마다 격자 열 수. 행은 8이고 한 자리가 **2열 × 4행**을 쓴다 —
 * ★ 처음 3행으로 잡았더니 이름·상태가 아래 자리 캐릭터 위로 겹쳤다.
 *   자리 하나의 실제 높이가 책상 12 + 모니터 16 + 캐릭터 72 + 글자 42 ≈ 145px다.
 */
const ROOM_COLS: Record<Room, number> = { think: 5, act: 6 };

/**
 * 사람이 앉지 않는 것들 — 회의 테이블·소파·화분·카펫·서류함·정수기·화이트보드.
 *
 * ★ **자리와 겹치지 않는 칸에만 둔다.** 자리는 1~4열을 쓰므로 가구는 5열(판단실)·
 *   5~6열(집행실)과 자리가 비는 칸으로 간다. 겹치면 이름이 소파에 파묻힌다.
 * ★ 카펫이 목록 맨 앞이라 가장 아래에 깔린다.
 */
const PROPS: Array<{ room: Room; kind: string; col: number; row: number; w?: number; h?: number; label?: string }> = [
  // 판단실 — 오른쪽 열이 회의·보드 자리
  { room: 'think', kind: 'meeting', col: 3, row: 4, w: 2, h: 2, label: '회의' },
  { room: 'think', kind: 'board', col: 5, row: 1, w: 1, h: 2, label: '' },
  { room: 'think', kind: 'cabinet', col: 5, row: 3 },
  { room: 'think', kind: 'plant', col: 5, row: 5 },
  // 집행·감시실 — 오른쪽 두 열이 휴게 코너
  { room: 'act', kind: 'coffee', col: 5, row: 1 },
  { room: 'act', kind: 'water', col: 6, row: 1 },
  { room: 'act', kind: 'sofa', col: 5, row: 4, w: 2, h: 2, label: '휴게' },
  { room: 'act', kind: 'plant', col: 5, row: 6 },
  { room: 'act', kind: 'plant', col: 6, row: 6 },
];

/*
 * ★ `loading`을 따로 둔다. 처음에는 상태를 못 받은 동안 `off`로 그렸는데,
 *   새로고침 직후 일곱 자리가 전부 회색 **"꺼짐"**으로 보였다 — 자동화가 꺼진
 *   것과 아직 못 물어본 것은 다른 말이고, 이 화면에서 그것을 헷갈리면
 *   "안 돌고 있다"는 거짓 신호가 된다.
 */
type Stance = 'running' | 'done' | 'waiting' | 'closed' | 'off' | 'loading';

const STANCE_LABEL: Record<Stance, string> = {
  running: '일하는 중',
  done: '오늘 마침',
  waiting: '차례 기다림',
  closed: '창 닫힘',
  off: '꺼짐',
  loading: '확인 중',
};

function stanceOf(task: TaskState | undefined, status: AutomationStatus): Stance {
  if (!task) return 'off';
  if (!status.ticking || !status.settings.enabled) return 'off';
  if (task.trading && !status.settings.tradingEnabled) return 'off';
  if (task.running) return 'running';
  if (task.daily && task.doneToday) return 'done';
  if (task.inWindow) return 'waiting';
  return 'closed';
}

const clock = (hhmm: number): string =>
  `${String(Math.floor(hhmm / 100)).padStart(2, '0')}:${String(hhmm % 100).padStart(2, '0')}`;

const won = (n: number): string => `${Math.round(n).toLocaleString('ko-KR')}원`;

const TRIGGER_LABEL: Record<string, string> = {
  scheduled: '발굴 회차',
  'fair-value': '적정가 반응',
  close: '종가 회차',
  event: '사건',
  manual: '사람이 부름',
};

const ACTION_LABEL: Record<string, string> = {
  buy: '매수', sell: '매도', hold: '보유', amend: '정정', cancel: '취소',
};

const LAYER_LABEL: Record<string, string> = { etf: 'ETF', short: '단기', bet: '유망주' };

function timeOf(ms: number): string {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(ms));
}

/** KST 오늘 `YYYY-MM-DD`. 회차의 `tradingDay`와 같은 축이다. */
function todayKst(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
}

/** `2026-09-07` → `9월 7일 (월)`. 오늘이면 `오늘`. */
function dayLabel(tradingDay: string): string {
  if (tradingDay === todayKst()) return '오늘';
  const [y, m, d] = tradingDay.split('-').map(Number);
  const weekday = ['일', '월', '화', '수', '목', '금', '토'][new Date(y, m - 1, d).getDay()];
  return `${m}월 ${d}일 (${weekday})`;
}

/**
 * 날짜별로 묶는다. **묶음 안에서 다시 정렬하지 않는다.**
 *
 * ★★ **서버가 준 순서를 그대로 쓴다**(`id` 내림차순). 처음에는 `startedAt`으로
 *    정렬했는데 순서가 무너졌다 — 그 값은 **에이전트가 스스로 적는 것**이라
 *    믿을 수 없다. 2026-09-07에 회차 101·102가 **4일 뒤**를 적었고
 *    (`1789085160000` = 09-11 09:06, `tradingDay`는 09-07), 화면에서 09:13이
 *    10:02보다 위에 올라앉았다.
 *
 *    서버는 2026-09-03에 같은 사고를 겪고 이미 `id`로 정렬하도록 고쳐 뒀다
 *    (그때는 집행기가 미래 시각 회차를 보고 "낼 것 없음"으로 끝냈다).
 *    **화면이 다시 정렬하면 그 방어가 그대로 풀린다.**
 */
function groupByDay(rounds: Round[]): Array<{ day: string; rounds: Round[] }> {
  const byDay = new Map<string, Round[]>();
  for (const r of rounds) {
    const list = byDay.get(r.tradingDay) ?? [];
    list.push(r);
    byDay.set(r.tradingDay, list);
  }
  return [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([day, list]) => ({ day, rounds: list }));
}

export function AgentDesk({ accountId }: { accountId: string | null }): JSX.Element {
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [rounds, setRounds] = useState<Round[] | null>(null);
  const [openOrders, setOpenOrders] = useState<OpenOrder[] | null>(null);
  const [activities, setActivities] = useState<Map<string, Activity>>(new Map());
  /*
   * ★ **처음 한 번만 걸어 들어온다.** 참조한 픽셀 사무실이 *"캐릭터가 자기 책상까지
   *   걸어가 앉는다"*고 한 그 연출이다. 자리마다 조금씩 늦게 출발해 줄지어 들어온다.
   *   상태가 바뀔 때마다 다시 걷게 하면 5분마다 사무실이 술렁여 읽기가 어렵다.
   */
  const [arriving, setArriving] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openRound, setOpenRound] = useState<number | null>(null);

  const load = useCallback(() => {
    /*
     * ★ 활동은 **자주 본다**(아래 8초). 30초로 두면 2~3분짜리 빠른 회차가
     *   통째로 지나가 화면이 그 자세를 한 번도 못 그린다.
     */
    fetch(`${API_BASE}/api/agents/activity`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { activities: Activity[] }) =>
        setActivities(new Map(d.activities.map((a) => [a.agent, a]))))
      .catch(() => setActivities(new Map()));

    fetch(`${API_BASE}/api/automation/status`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`상태 조회 실패: ${r.status}`))))
      .then((d: AutomationStatus) => { setStatus(d); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

    const query = accountId ? `?accountId=${encodeURIComponent(accountId)}&limit=12` : '?limit=12';
    fetch(`${API_BASE}/api/deliberations${query}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`판단 기록 조회 실패: ${r.status}`))))
      .then((d: { rounds: Round[] }) => setRounds(d.rounds))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

    /*
     * ★ 미체결은 **모의 서버에 그 TR이 없다**(`EGW02006`). 실패를 오류로 올리지
     *   않고 `null`로 둔다 — "없다"와 "못 받았다"는 다른 말이고, 여기서 붉은
     *   글씨를 띄우면 매일 뜨는 소음이 된다.
     */
    if (accountId) {
      fetch(`${API_BASE}/api/broker/kis/open-orders?accountId=${encodeURIComponent(accountId)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: { items?: OpenOrder[] }) => setOpenOrders(d.items ?? []))
        .catch(() => setOpenOrders(null));
    }
  }, [accountId]);

  // 걸어 들어오는 시간(마지막 자리까지 1.5초)만 지나면 자리에 앉은 것으로 둔다.
  useEffect(() => {
    const timer = window.setTimeout(() => setArriving(false), 1600);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    load();
    // 판단자 회차가 10~15분이라 그 안에 상태가 바뀐다. 8초면 단계 전환도 따라간다.
    const timer = window.setInterval(load, 8000);
    return () => window.clearInterval(timer);
  }, [load]);

  const taskByName = new Map((status?.tasks ?? []).map((t) => [t.name, t]));
  const grouped = rounds ? groupByDay(rounds) : [];
  const today = rounds?.filter((r) => r.tradingDay === todayKst()) ?? [];
  const decidedToday = today.reduce((sum, r) => sum + r.decisions.length, 0);

  return (
    <section className="agent-desk" aria-label="에이전트 데스크">
      <header className="agent-desk__head">
        <h2>에이전트 데스크</h2>
        <p>
          {status
            ? `${status.now} · 자동화 ${status.settings.enabled ? '켜짐' : '꺼짐'} · 매매 ${status.settings.tradingEnabled ? '켜짐' : '꺼짐'}`
            : '상태를 읽는 중입니다'}
          {rounds ? ` · 오늘 회차 ${today.length}건 · 결정 ${decidedToday}건` : ''}
        </p>
      </header>

      {error && <p className="agent-desk__error">{error}</p>}

      {/*
        ── 사무실 ──
        사용자가 정했다 — *"UI를 각 캐릭터가 회사에서 일하는 것처럼 만들어줘."*
        긴 트레이딩 데스크 하나에 일곱이 나란히 앉는다. 책상이 캐릭터의 하반신을
        덮어 앉은 것처럼 보이고, 모니터 불빛이 자세를 말한다.
      */}
      <div className="agent-office" data-off={status && (!status.ticking || !status.settings.enabled) ? '' : undefined}>
        <div className="agent-office__wall">
          {/* 벽 장식 — 참조한 픽셀 사무실처럼 책장·시계·액자를 건다 */}
          <span className="agent-office__decor" aria-hidden="true">
            <i data-kind="shelf" /><i data-kind="clock" /><i data-kind="frame" />
          </span>
          <span className="agent-office__board">
            {status ? `KST ${status.now}` : '· · ·'}
            <b data-on={status?.settings.enabled ? '' : undefined}>자동화</b>
            <b data-on={status?.settings.tradingEnabled ? '' : undefined}>매매</b>
          </span>
          <span className="agent-office__tape">
            오늘 회차 {today.length} · 결정 {decidedToday}
          </span>
        </div>

        <div className="agent-office__rooms">
          {(['think', 'act'] as const).map((room) => (
            <section className="agent-room" data-room={room} key={room}>
              <h4 className="agent-room__label">{ROOM_LABEL[room]}</h4>
              <div
                className="agent-room__floor"
                style={{ ['--cols' as string]: String(ROOM_COLS[room]) }}
              >
                {/* 가구가 먼저 깔린다 — 자리보다 뒤에 있어야 캐릭터를 가리지 않는다 */}
                {PROPS.filter((f) => f.room === room).map((f, i) => (
                  <div
                    aria-hidden="true"
                    className="office-prop"
                    data-prop={f.kind}
                    key={`${f.kind}-${i}`}
                    style={{
                      gridColumn: `${f.col} / span ${f.w ?? 1}`,
                      gridRow: `${f.row} / span ${f.h ?? 1}`,
                    }}
                  >
                    {f.label && <span>{f.label}</span>}
                  </div>
                ))}
                {ROSTER.filter((m) => m.room === room).map((member, index) => {
                  const task = taskByName.get(member.task);
                  const stance: Stance = status ? stanceOf(task, status) : 'loading';
                  const act = activities.get(member.id);
                    const doing = act && act.activity !== 'idle' ? act : null;
                    return (
                    <div
                      className="agent-seat"
                      data-stance={stance}
                      data-doing={doing?.activity}
                      data-arriving={arriving ? '' : undefined}
                      key={member.id}
                      style={{
                        ['--seat-order' as string]: String(index),
                        gridColumn: `${member.at.col} / span 2`,
                        gridRow: `${member.at.row} / span 3`,
                      }}
                      title={`${member.job}${task ? ` · ${clock(task.window[0])}–${clock(task.window[1])}` : ''}`}
                    >
                      {/*
                        말풍선은 **하는 일이 있을 때만** 뜬다. 활동 표시가 오면 그
                        한 마디를 그대로 쓰고(판단자가 적은 것), 없으면 「일하는 중」.
                      */}
                      {(doing || stance === 'running') && (
                        <span className="agent-seat__bubble">
                          {doing?.detail || (doing ? ACTIVITY_FACE[doing.activity].label : '일하는 중')}
                        </span>
                      )}
                      {doing && ACTIVITY_FACE[doing.activity].icon && (
                        <span className="agent-seat__icon" aria-hidden="true">
                          {ACTIVITY_FACE[doing.activity].icon}
                        </span>
                      )}
                      {/*
                        ★ 탑다운이라 **책상이 캐릭터 뒤(위)에 있다.** 모니터가 책상 위에
                          놓이고 캐릭터는 그 앞에 앉아 화면을 본다.
                      */}
                      <div className="agent-seat__station" aria-hidden="true">
                        <span className="agent-seat__monitor" />
                        <span className="agent-seat__desk" />
                      </div>
                      <div className="agent-seat__figure">
                        {/* 두 프레임을 겹쳐 두고 걷는 동안만 번갈아 보인다 */}
                        <span className="agent-seat__walker">
                          <PixelSprite id={member.id} size={5} />
                          <PixelSprite id={member.id} size={5} frame={1} />
                        </span>
                        <span className="agent-seat__chair" aria-hidden="true" />
                      </div>
                      <h3>{member.name}</h3>
                      <p className="agent-seat__stance">
                        <i aria-hidden="true" />
                        {STANCE_LABEL[stance]}
                        {task?.lastRunAt ? ` · ${task.lastRunAt}` : ''}
                      </p>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>

      {/* ── 지금 나가 있는 주문 ── */}
      {openOrders !== null && openOrders.length > 0 && (
        <div className="agent-open">
          <h3>지금 나가 있는 주문 <em>정리꾼이 5분마다 본다</em></h3>
          <ul>
            {openOrders.map((o) => (
              <li key={o.orderNo}>
                <b>{ACTION_LABEL[o.side] ?? o.side}</b> {o.name} <em>{o.symbol}</em>
                {' '}{o.quantity}주 중 {o.filledQuantity ?? 0}주 체결
                {o.price ? ` · 지정가 ${won(o.price)}` : ''}
                <span className="agent-open__no">주문번호 {o.orderNo}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── 판단 기록 ── */}
      <div className="agent-desk__log">
        <h3>무엇을 정했나</h3>
        {rounds === null && <p className="agent-desk__empty">판단 기록을 읽는 중입니다</p>}
        {rounds?.length === 0 && <p className="agent-desk__empty">아직 회차가 없습니다</p>}
        {grouped.map((group) => (
          <div className="agent-day" key={group.day}>
            <h4 className="agent-day__label" data-today={group.day === todayKst() ? '' : undefined}>
              {dayLabel(group.day)}
              <em>회차 {group.rounds.length}건</em>
            </h4>
            {group.rounds.map((round) => {
          const open = openRound === round.id;
          return (
            <article className="agent-round" data-open={open ? '' : undefined} key={round.id}>
              <button
                aria-expanded={open}
                className="agent-round__head"
                onClick={() => setOpenRound(open ? null : round.id)}
                type="button"
              >
                <span className="agent-round__time">{timeOf(round.recordedAt)}</span>
                <span className="agent-round__trigger" data-trigger={round.trigger}>
                  {TRIGGER_LABEL[round.trigger] ?? round.trigger}
                </span>
                <span className="agent-round__gist">
                  {round.decisions.length === 0
                    ? '결정 없음'
                    : round.decisions
                      .map((d) => `${ACTION_LABEL[d.action] ?? d.action} ${d.name} ${d.quantity}주`)
                      .join(' · ')}
                </span>
                <span className="agent-round__equity">{won(round.equity)}</span>
              </button>

              {open && (
                <div className="agent-round__body">
                  {round.decisions.map((d) => (
                    <div className="agent-decision" data-action={d.action} key={`${d.symbol}-${d.action}`}>
                      <h4>
                        {ACTION_LABEL[d.action] ?? d.action} {d.name} <em>{d.symbol}</em>
                        {d.layer && <span className="agent-decision__layer">{LAYER_LABEL[d.layer]}</span>}
                      </h4>
                      <p className="agent-decision__nums">
                        {d.quantity}주
                        {d.limitPrice ? ` · 지정가 ${won(d.limitPrice)}` : ''}
                        {d.plan ? ` · 목표 ${won(d.plan.targetPrice)} / 손절 ${won(d.plan.stopPrice)}` : ''}
                        {d.plan ? ` · ${d.plan.horizonDays}거래일 · 기대 ${(d.plan.expectedReturn * 100).toFixed(2)}%` : ''}
                      </p>
                      <p className="agent-decision__why">{d.rationale}</p>
                      {d.plan?.basis && <p className="agent-decision__basis">근거: {d.plan.basis}</p>}
                    </div>
                  ))}

                  {round.findings.length > 0 && (
                    <div className="agent-findings">
                      <h4>본 것</h4>
                      <ul>
                        {round.findings.map((f, i) => (
                          <li key={`${f.agent}-${i}`}><b>{f.agent}</b> {f.summary}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {round.falsifier && (
                    <p className="agent-falsifier">
                      <b>이것이 사실이면 틀린 판단이다</b> — {round.falsifier}
                    </p>
                  )}

                  {round.unknowns.length > 0 && (
                    <div className="agent-unknowns">
                      <h4>그때 몰랐던 것</h4>
                      <ul>{round.unknowns.map((u, i) => <li key={i}>{u}</li>)}</ul>
                    </div>
                  )}

                  {round.executions.length > 0 && (
                    <div className="agent-executions">
                      <h4>주문으로 나간 것</h4>
                      <ul>
                        {round.executions.map((e, i) => (
                          <li key={i} data-blocked={e.blockedBy?.length ? '' : undefined}>
                            {ACTION_LABEL[e.action] ?? e.action} {e.symbol} {e.quantity}주
                            {e.orderNo ? ` → 주문번호 ${e.orderNo}` : ''}
                            {e.blockedBy?.length ? ` — 막힘: ${e.blockedBy.join(' · ')}` : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </article>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
