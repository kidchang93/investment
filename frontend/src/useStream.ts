import { useEffect, useRef, useState } from 'react';
import { STREAM_URL } from './config';
import type { ServerMessage, Trade } from '@invest/shared';

const RECONNECT_MS = 3_000;

export interface StreamState {
  /** KIS 실시간 연결 상태 (백엔드가 중계) */
  kisConnected: boolean;
  /** 프론트 ↔ 백엔드 WebSocket 연결 상태 */
  socketOpen: boolean;
  /** 종목코드 → 최신 체결. 렌더링은 코드 단위로 최신값만 필요하다. */
  trades: Record<string, Trade>;
  /** 상태/에러 메시지 (있을 때) */
  message?: string;
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
  });
  // 재접속·언마운트 사이에서 소켓/타이머를 안전하게 정리하기 위한 ref
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let disposed = false;

    function connect(): void {
      const ws = new WebSocket(STREAM_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        setState((s) => ({ ...s, socketOpen: true }));
      };

      ws.onmessage = (ev) => {
        if (disposed) return;
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data as string) as ServerMessage;
        } catch {
          return;
        }
        if (msg.type === 'trade') {
          const t = msg.data;
          setState((s) => ({ ...s, trades: { ...s.trades, [t.code]: t } }));
        } else if (msg.type === 'status') {
          setState((s) => ({
            ...s,
            kisConnected: msg.data.kisConnected,
            message: msg.data.message,
          }));
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
  }, []);

  return state;
}
