import { useCallback, useEffect, useRef, useState } from 'react';
import { STREAM_URL } from './config';
import type {
  ClientMessage,
  ClientSubscribeInstrument,
  OrderNotice,
  ServerMessage,
  Trade,
} from '@invest/shared';

const RECONNECT_MS = 3_000;
const MAX_RECENT_TRADES = 80;
const MAX_ORDER_NOTICES = 50;

function assertNever(value: never): never {
  throw new Error(`처리하지 않은 스트림 메시지입니다: ${JSON.stringify(value)}`);
}

export interface StreamState {
  /** 실시간 시세 연결 상태 (백엔드가 중계) */
  kisConnected: boolean;
  /** 프론트 ↔ 백엔드 WebSocket 연결 상태 */
  socketOpen: boolean;
  /** 종목코드 → 최신 체결. 렌더링은 코드 단위로 최신값만 필요하다. */
  trades: Record<string, Trade>;
  /** 최근 체결 테이프. 하단 패널에서 최신순으로 보여준다. */
  recentTrades: Trade[];
  /** 실시간 주문·체결 통보. 최신순. HTS ID가 없으면 항상 빈 배열이다. */
  orderNotices: OrderNotice[];
  /** 상태/에러 메시지 (있을 때) */
  message?: string;
  /** 국내 종목 실시간 체결 구독 추가 */
  subscribe: (instruments: ClientSubscribeInstrument[]) => void;
}

/**
 * 백엔드 /stream WebSocket을 구독하는 훅.
 * 체결은 종목코드별 최신값만 유지하고, 끊기면 자동 재접속한다.
 */
export function useStream(): StreamState {
  const [state, setState] = useState<StreamState>({
    kisConnected: false,
    socketOpen: false,
    trades: {},
    recentTrades: [],
    orderNotices: [],
    subscribe: () => undefined,
  });
  // 재접속·언마운트 사이에서 소켓/타이머를 안전하게 정리하기 위한 ref
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscribedInstrumentsRef = useRef<Map<string, ClientSubscribeInstrument>>(new Map());

  const sendSubscribe = useCallback((ws: WebSocket, instruments: ClientSubscribeInstrument[]): void => {
    if (instruments.length === 0) return;
    const msg: ClientMessage = { type: 'subscribe', instruments };
    ws.send(JSON.stringify(msg));
  }, []);

  const subscribe = useCallback(
    (instruments: ClientSubscribeInstrument[]): void => {
      const nextInstruments = instruments
        .map((instrument) => ({ ...instrument, code: instrument.code.trim().toUpperCase() }))
        .filter((instrument) => /^[0-9A-Z]{6,9}$/.test(instrument.code) && !subscribedInstrumentsRef.current.has(instrument.code));
      if (nextInstruments.length === 0) return;

      for (const instrument of nextInstruments) subscribedInstrumentsRef.current.set(instrument.code, instrument);
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) sendSubscribe(ws, nextInstruments);
    },
    [sendSubscribe],
  );

  useEffect(() => {
    let disposed = false;

    function connect(): void {
      const ws = new WebSocket(STREAM_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        setState((s) => ({ ...s, socketOpen: true }));
        sendSubscribe(ws, [...subscribedInstrumentsRef.current.values()]);
      };

      ws.onmessage = (ev) => {
        if (disposed) return;
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data as string) as ServerMessage;
        } catch {
          return;
        }
        switch (msg.type) {
          case 'trade': {
            const t = msg.data;
            setState((s) => ({
              ...s,
              trades: { ...s.trades, [t.code]: t },
              recentTrades: [t, ...s.recentTrades].slice(0, MAX_RECENT_TRADES),
            }));
            break;
          }
          case 'orderNotice': {
            const notice = msg.data;
            setState((s) => ({
              ...s,
              orderNotices: [notice, ...s.orderNotices].slice(0, MAX_ORDER_NOTICES),
            }));
            break;
          }
          case 'status':
            setState((s) => ({
              ...s,
              kisConnected: msg.data.kisConnected,
              message: msg.data.message,
            }));
            break;
          default:
            assertNever(msg);
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        setState((s) => ({ ...s, socketOpen: false, kisConnected: false }));
        scheduleReconnect();
      };

      ws.onerror = () => {
        // onclose가 이어서 호출되므로 재접속은 거기서 처리한다.
        ws.close();
      };
    }

    function scheduleReconnect(): void {
      if (timerRef.current || disposed) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        connect();
      }, RECONNECT_MS);
    }

    connect();

    return () => {
      disposed = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [sendSubscribe]);

  return { ...state, subscribe };
}
