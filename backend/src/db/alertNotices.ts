/**
 * **경보를 마지막으로 언제 무슨 내용으로 알렸나.**
 *
 * 판정은 `trading/alertNotice.ts`가 순수 함수로 하고, 여기는 그 기억만 맡는다.
 *
 * ★ **DB에 둔다.** 데몬은 20분마다 `checkAlerts`를 **새 프로세스로** 부르므로
 *   메모리에 담으면 매번 비어 있고, 억제가 한 번도 걸리지 않는다.
 *
 * ★ 계좌별로 따로 센다 — 계좌가 다르면 다른 사실이다.
 */

import { pool } from './client.js';
import type { AlertNotice } from '../trading/alertNotice.js';

export async function ensureAlertNoticeSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trading_alert_notices (
      account_id   TEXT        NOT NULL,
      alert_key    TEXT        NOT NULL,
      digest       TEXT        NOT NULL,
      notified_day DATE        NOT NULL,
      notified_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (account_id, alert_key)
    )
  `);
}

/** key → 마지막 알림. 한 번도 안 알린 경보는 여기 없다 */
export async function getAlertNotices(accountId: string): Promise<Map<string, AlertNotice>> {
  await ensureAlertNoticeSchema();
  const { rows } = await pool.query<{ alert_key: string; digest: string; day: string }>(
    `SELECT alert_key, digest, to_char(notified_day, 'YYYY-MM-DD') AS day
       FROM trading_alert_notices WHERE account_id = $1`,
    [accountId],
  );
  return new Map(rows.map((r) => [r.alert_key, { digest: r.digest, day: r.day }]));
}

/**
 * 알렸다고 적는다. **알림을 실제로 띄운 뒤에만 부른다** — 먼저 적으면 알림이
 * 실패했을 때 그 경보가 하루 동안 조용해진다.
 */
export async function markAlertNotified(
  accountId: string,
  alertKey: string,
  digest: string,
  day: string,
): Promise<void> {
  await ensureAlertNoticeSchema();
  await pool.query(
    `INSERT INTO trading_alert_notices (account_id, alert_key, digest, notified_day, notified_at)
     VALUES ($1, $2, $3, $4::date, now())
     ON CONFLICT (account_id, alert_key)
     DO UPDATE SET digest = EXCLUDED.digest,
                   notified_day = EXCLUDED.notified_day,
                   notified_at = EXCLUDED.notified_at`,
    [accountId, alertKey, digest, day],
  );
}
