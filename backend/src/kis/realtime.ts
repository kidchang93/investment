import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { config } from '../config.js';
import { getApprovalKey } from './auth.js';
import type { ClientSubscribeInstrument, Trade, ConnectionStatus, PriceSign } from '@invest/shared';

/** 실시간 주식체결가 TR */
const TR_TRADE = 'H0STCNT0';
/** KRX 야간선물 실시간종목체결 TR */
const TR_KRX_NIGHT_FUTURES_TRADE = 'H0MFCNT0';
/** H0STCNT0 레코드당 필드 수 (여러 체결이 한 프레임에 붙어올 때 분할 기준) */
const FIELDS_PER_RECORD = 46;
const NIGHT_FUTURES_FIELDS_PER_RECORD = 49;
const RECONNECT_MS = 3_000;

function isPriceSign(value: string | undefined): value is PriceSign {
  return value === '1' || value === '2' || value === '3' || value === '4' || value === '5';
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function kstToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
}

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
  private readonly subscriptions = new Map<string, { trId: string; code: string }>();
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  get isConnected(): boolean {
    return this.connected;
  }

  async start(codes: string[]): Promise<void> {
    for (const code of codes) this.addSubscription(TR_TRADE, code);
    this.approvalKey = await getApprovalKey();
    this.connect();
  }

  /** 실행 중 종목 추가 구독 (매매 기능 확장 시 사용). */
  subscribe(code: string): void {
    this.subscribeInstrument({ code, market: 'KOSPI', assetType: 'stock' });
  }

  subscribeInstrument(instrument: ClientSubscribeInstrument): void {
    const trId = this.resolveTradeTrId(instrument);
    if (!trId) return;
    if (!this.addSubscription(trId, instrument.code)) return;
    if (this.connected) this.sendSubscription(trId, instrument.code, '1');
  }

  private connect(): void {
    const ws = new WebSocket(config.wsBase);
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.emitStatus({ kisConnected: true });
      for (const subscription of this.subscriptions.values()) {
        this.sendSubscription(subscription.trId, subscription.code, '1');
      }
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
  private sendSubscription(trId: string, code: string, trType: '1' | '2'): void {
    const msg = {
      header: {
        approval_key: this.approvalKey,
        custtype: config.custType,
        tr_type: trType,
        'content-type': 'utf-8',
      },
      body: { input: { tr_id: trId, tr_key: code } },
    };
    this.ws?.send(JSON.stringify(msg));
  }

  private addSubscription(trId: string, code: string): boolean {
    const normalized = code.trim().toUpperCase();
    const key = `${trId}:${normalized}`;
    if (this.subscriptions.has(key)) return false;
    this.subscriptions.set(key, { trId, code: normalized });
    return true;
  }

  private isFutureAssetType(assetType: ClientSubscribeInstrument['assetType']): boolean {
    return assetType === 'future' || assetType === 'future_spread';
  }

  private resolveTradeTrId(instrument: ClientSubscribeInstrument): string | null {
    if (this.isFutureAssetType(instrument.assetType) && instrument.market === 'KRX_NIGHT') {
      return TR_KRX_NIGHT_FUTURES_TRADE;
    }
    if (!this.isFutureAssetType(instrument.assetType)) return TR_TRADE;
    return null;
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
    if (parts.length < 4) return;
    if (parts[1] === TR_TRADE) {
      this.onStockTradeFrame(parts);
      return;
    }
    if (parts[1] === TR_KRX_NIGHT_FUTURES_TRADE) {
      this.onNightFuturesTradeFrame(parts);
    }
  }

  private onStockTradeFrame(parts: string[]): void {
    const count = Number(parts[2]) || 1;
    const fields = parts[3].split('^');
    for (let i = 0; i < count; i++) {
      const f = fields.slice(i * FIELDS_PER_RECORD, (i + 1) * FIELDS_PER_RECORD);
      if (f.length < FIELDS_PER_RECORD || !isPriceSign(f[3]) || !/^\d{8}$/.test(f[33] ?? '')) {
        continue;
      }
      const price = Number(f[2]);
      const change = Number(f[4]);
      const changeRate = Number(f[5]);
      const open = Number(f[7]);
      const high = Number(f[8]);
      const low = Number(f[9]);
      const volume = Number(f[12]);
      const accVolume = Number(f[13]);
      if (
        !isPositiveFinite(price) ||
        !Number.isFinite(change) ||
        !Number.isFinite(changeRate) ||
        !isPositiveFinite(open) ||
        !isPositiveFinite(high) ||
        !isPositiveFinite(low) ||
        !isNonNegativeFinite(volume) ||
        !isNonNegativeFinite(accVolume)
      ) {
        continue;
      }
      const trade: Trade = {
        code: f[0],
        time: f[1],
        price,
        sign: f[3],
        change,
        changeRate,
        open,
        high,
        low,
        volume,
        accVolume,
        date: f[33],
      };
      this.emit('trade', trade);
    }
  }

  private onNightFuturesTradeFrame(parts: string[]): void {
    const count = Number(parts[2]) || 1;
    const fields = parts[3].split('^');
    for (let i = 0; i < count; i++) {
      const f = fields.slice(i * NIGHT_FUTURES_FIELDS_PER_RECORD, (i + 1) * NIGHT_FUTURES_FIELDS_PER_RECORD);
      if (f.length < NIGHT_FUTURES_FIELDS_PER_RECORD || !isPriceSign(f[3])) continue;

      const price = Number(f[5]);
      const change = Number(f[2]);
      const changeRate = Number(f[4]);
      const open = Number(f[6]);
      const high = Number(f[7]);
      const low = Number(f[8]);
      const volume = Number(f[9]);
      const accVolume = Number(f[10]);
      if (
        !isPositiveFinite(price) ||
        !Number.isFinite(change) ||
        !Number.isFinite(changeRate) ||
        !isPositiveFinite(open) ||
        !isPositiveFinite(high) ||
        !isPositiveFinite(low) ||
        !isNonNegativeFinite(volume) ||
        !isNonNegativeFinite(accVolume)
      ) {
        continue;
      }

      const trade: Trade = {
        code: f[0],
        time: f[1],
        price,
        sign: f[3],
        change,
        changeRate,
        open,
        high,
        low,
        volume,
        accVolume,
        date: kstToday(),
      };
      this.emit('trade', trade);
    }
  }

  private emitStatus(status: ConnectionStatus): void {
    this.emit('status', status);
  }
}
