import { createDecipheriv } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { config } from '../config.js';
import { getApprovalKey } from './auth.js';
import type {
  ClientSubscribeInstrument,
  OrderNotice,
  Trade,
  ConnectionStatus,
  PriceSign,
} from '@invest/shared';

/** 실시간 주식체결가 TR */
const TR_TRADE = 'H0STCNT0';
/** 실시간 주문·체결 통보 TR. 모의투자는 H0STCNI9로 갈린다. */
const TR_ORDER_NOTICE = config.env === 'prod' ? 'H0STCNI0' : 'H0STCNI9';
/**
 * H0STCNI0 필드 순서 (KIS 공식 예제 ccnl_notice.py 기준).
 * 0 CUST_ID · 1 ACNT_NO · 2 ODER_NO · 3 OODER_NO · 4 SELN_BYOV_CLS · 5 RCTF_CLS ·
 * 6 ODER_KIND · 7 ODER_COND · 8 STCK_SHRN_ISCD · 9 CNTG_QTY · 10 CNTG_UNPR ·
 * 11 STCK_CNTG_HOUR · 12 RFUS_YN · 13 CNTG_YN · 14 ACPT_YN · 15 BRNC_NO ·
 * 16 ODER_QTY · 17 ACNT_NAME · 18 ORD_COND_PRC · 19 ORD_EXG_GB · 20 POPUP_YN ·
 * 21 FILLER · 22 CRDT_CLS · 23 CRDT_LOAN_DATE · 24 CNTG_ISNM40 · 25 ODER_PRC
 */
const NOTICE_FIELD = {
  accountNo: 1,
  orderNo: 2,
  originalOrderNo: 3,
  sideCode: 4,
  symbol: 8,
  filledQuantity: 9,
  filledPrice: 10,
  time: 11,
  rejectedYn: 12,
  /** '2'면 체결, '1'이면 주문·정정·취소·거부 접수 */
  filledYn: 13,
  branchNo: 15,
  orderQuantity: 16,
  name: 24,
  orderPrice: 25,
} as const;
const NOTICE_MIN_FIELDS = 26;
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
  /** 체결통보 복호화 키. 구독 등록 응답으로만 받을 수 있다. */
  private noticeAesKey = '';
  private noticeAesIv = '';

  get isConnected(): boolean {
    return this.connected;
  }

  async start(codes: string[]): Promise<void> {
    for (const code of codes) this.addSubscription(TR_TRADE, code);
    /*
     * 주문·체결 통보는 approval_key가 발급된 앱키 기준으로만 온다.
     * 우리 WS는 기본 계좌의 앱키 하나로 연결하므로 통보도 기본 계좌 것만 수신된다.
     * 다른 계좌까지 받으려면 그 계좌 앱키로 WS를 하나 더 열어야 한다.
     */
    const htsId = config.kisAccounts.find((account) => account.id === config.primaryCredentialId)?.htsId;
    if (htsId) this.addSubscription(TR_ORDER_NOTICE, htsId);

    this.approvalKey = await getApprovalKey();
    this.connect();
  }

  /** 기본 계좌에 HTS ID가 설정돼 통보를 구독하는지. */
  get isOrderNoticeEnabled(): boolean {
    return [...this.subscriptions.values()].some((item) => item.trId === TR_ORDER_NOTICE);
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
    // 종목코드는 대문자로 정규화하지만, 통보의 tr_key는 HTS 로그인 ID라 원문을 지켜야 한다.
    const normalized = trId === TR_ORDER_NOTICE ? code.trim() : code.trim().toUpperCase();
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
        const json = JSON.parse(raw) as {
          header?: { tr_id?: string };
          body?: { rt_cd?: string; msg1?: string; output?: { key?: string; iv?: string } };
        };
        if (json.header?.tr_id === 'PINGPONG') {
          this.ws?.send(raw); // 받은 그대로 되돌려 하트비트 응답
          return;
        }
        /*
         * 구독 거부 응답은 tr_id로 거를 수 없다.
         * 잘못된 HTS ID면 KIS가 header.tr_id를 "(null)"로 채워 보내기 때문에
         * tr_id를 먼저 확인하면 오류가 통째로 묻힌다. rt_cd를 먼저 본다.
         *   예: {"header":{"tr_id":"(null)"},"body":{"rt_cd":"9","msg1":"ERROR : htsid가잘못되었습니다"}}
         */
        if (json.body?.rt_cd && json.body.rt_cd !== '0') {
          this.emitStatus({
            kisConnected: this.connected,
            message: `실시간 구독 실패: ${(json.body.msg1 ?? json.body.rt_cd).trim()}`,
          });
          return;
        }
        // 체결통보 구독 응답에만 복호화 키가 실려 온다. 이 한 번을 놓치면 통보를 읽을 수 없다.
        if (json.header?.tr_id === TR_ORDER_NOTICE && json.body?.output?.key && json.body.output.iv) {
          this.noticeAesKey = json.body.output.key;
          this.noticeAesIv = json.body.output.iv;
          this.emit('noticeReady');
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
      return;
    }
    if (parts[1] === TR_ORDER_NOTICE) {
      this.onOrderNoticeFrame(parts);
    }
  }

  /** 체결통보 payload는 AES-256-CBC로 암호화되어 온다. 시세 프레임과 달리 평문이 아니다. */
  private decryptNotice(payload: string): string | null {
    if (!this.noticeAesKey || !this.noticeAesIv) return null;
    try {
      const decipher = createDecipheriv(
        'aes-256-cbc',
        Buffer.from(this.noticeAesKey, 'utf8'),
        Buffer.from(this.noticeAesIv, 'utf8'),
      );
      return decipher.update(payload, 'base64', 'utf8') + decipher.final('utf8');
    } catch {
      return null;
    }
  }

  private onOrderNoticeFrame(parts: string[]): void {
    // parts[0]이 '1'이면 암호화된 payload다.
    const payload = parts.slice(3).join('|');
    const plain = parts[0] === '1' ? this.decryptNotice(payload) : payload;
    if (!plain) return;

    const f = plain.split('^');
    if (f.length < NOTICE_MIN_FIELDS) return;

    const quantityField = f[NOTICE_FIELD.filledYn] === '2' ? NOTICE_FIELD.filledQuantity : NOTICE_FIELD.orderQuantity;
    const priceField = f[NOTICE_FIELD.filledYn] === '2' ? NOTICE_FIELD.filledPrice : NOTICE_FIELD.orderPrice;
    const originalOrderNo = f[NOTICE_FIELD.originalOrderNo] ?? '';

    const notice: OrderNotice = {
      kind: f[NOTICE_FIELD.filledYn] === '2' ? 'filled' : 'accepted',
      // 원본 계좌번호는 밖으로 내보내지 않고 화면용 id로만 바꾼다.
      accountId: this.resolveAccountId(f[NOTICE_FIELD.accountNo] ?? ''),
      orderNo: f[NOTICE_FIELD.orderNo] ?? '',
      originalOrderNo: /^0*$/.test(originalOrderNo) ? undefined : originalOrderNo,
      branchNo: f[NOTICE_FIELD.branchNo] ?? '',
      symbol: (f[NOTICE_FIELD.symbol] ?? '').trim(),
      name: (f[NOTICE_FIELD.name] ?? '').trim(),
      // 매도매수구분코드: 01 매도, 02 매수
      side: f[NOTICE_FIELD.sideCode] === '01' ? 'sell' : 'buy',
      quantity: Number(f[quantityField]) || 0,
      price: Number(f[priceField]) || 0,
      orderQuantity: Number(f[NOTICE_FIELD.orderQuantity]) || 0,
      time: f[NOTICE_FIELD.time] ?? '',
      rejected: f[NOTICE_FIELD.rejectedYn] === '1',
      receivedAt: Date.now(),
    };
    this.emit('orderNotice', notice);
  }

  /** 통보의 계좌번호를 설정된 계좌의 화면용 id로 바꾼다. 원문은 어디에도 남기지 않는다. */
  private resolveAccountId(rawAccountNo: string): string {
    const digits = rawAccountNo.replace(/[^0-9]/g, '');
    if (!digits) return '';
    const matched = config.kisAccounts.find((account) => digits.startsWith(account.cano));
    return matched?.id ?? '';
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
