import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { config } from '../config.js';
import { getApprovalKey } from './auth.js';
import type { Trade, ConnectionStatus } from '@invest/shared';

/** 실시간 주식체결가 TR */
const TR_TRADE = 'H0STCNT0';
/** H0STCNT0 레코드당 필드 수 (여러 체결이 한 프레임에 붙어올 때 분할 기준) */
const FIELDS_PER_RECORD = 46;
const RECONNECT_MS = 3_000;

/**
 * KIS 실시간 WebSocket 클라이언트.
 * 단일 연결로 감시 종목 전체를 구독하고, 파싱된 체결을 'trade' 이벤트로,
 * 접속 상태를 'status' 이벤트로 방출한다. 연결이 끊기면 자동 재접속하며
 * 재접속 시 기존 구독을 모두 재등록한다.
 *
 * events:
 *   'trade'  (t: Trade)
 *   'status' (s: ConnectionStatus)
 */
export class KisRealtime extends EventEmitter {
  private ws: WebSocket | null = null;
  private approvalKey = '';
  private readonly codes = new Set<string>();
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  get isConnected(): boolean {
    return this.connected;
  }

  async start(codes: string[]): Promise<void> {
    for (const c of codes) this.codes.add(c);
    this.approvalKey = await getApprovalKey();
    this.connect();
  }

  /** 실행 중 종목 추가 구독 (매매 기능 확장 시 사용). */
  subscribe(code: string): void {
    if (this.codes.has(code)) return;
    this.codes.add(code);
    if (this.connected) this.sendSubscription(code, '1');
  }

  private connect(): void {
    const ws = new WebSocket(config.wsBase);
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.emitStatus({ kisConnected: true });
      for (const code of this.codes) this.sendSubscription(code, '1');
    });
    ws.on('message', (buf: WebSocket.RawData) => this.onMessage(buf.toString()));
    ws.on('close', () => {
      this.connected = false;
      this.emitStatus({ kisConnected: false });
      this.scheduleReconnect();
    });
    ws.on('error', (err: Error) => {
      this.emitStatus({ kisConnected: false, message: err.message });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_MS);
  }

  /** tr_type: '1'=등록, '2'=해제 */
  private sendSubscription(code: string, trType: '1' | '2'): void {
    const msg = {
      header: {
        approval_key: this.approvalKey,
        custtype: config.custType,
        tr_type: trType,
        'content-type': 'utf-8',
      },
      body: { input: { tr_id: TR_TRADE, tr_key: code } },
    };
    this.ws?.send(JSON.stringify(msg));
  }

  private onMessage(raw: string): void {
    // JSON 프레임: PINGPONG(하트비트) 또는 구독 등록 응답
    if (raw.startsWith('{')) {
      try {
        const json = JSON.parse(raw) as { header?: { tr_id?: string } };
        if (json.header?.tr_id === 'PINGPONG') {
          this.ws?.send(raw); // 받은 그대로 되돌려 하트비트 응답
        }
      } catch {
        /* 무시 */
      }
      return;
    }

    // 실시간 데이터 프레임: "암호화여부|tr_id|건수|필드^필드^..."
    const parts = raw.split('|');
    if (parts.length < 4 || parts[1] !== TR_TRADE) return;

    const count = Number(parts[2]) || 1;
    const fields = parts[3].split('^');
    for (let i = 0; i < count; i++) {
      const f = fields.slice(i * FIELDS_PER_RECORD, (i + 1) * FIELDS_PER_RECORD);
      if (f.length < 14) continue;
      const trade: Trade = {
        code: f[0],
        time: f[1],
        price: Number(f[2]),
        sign: f[3],
        change: Number(f[4]),
        changeRate: Number(f[5]),
        open: Number(f[7]),
        high: Number(f[8]),
        low: Number(f[9]),
        volume: Number(f[12]),
        accVolume: Number(f[13]),
        date: f[33] ?? '',
      };
      this.emit('trade', trade);
    }
  }

  private emitStatus(status: ConnectionStatus): void {
    this.emit('status', status);
  }
}
