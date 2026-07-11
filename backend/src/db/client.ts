import pg from 'pg';
import { config } from '../config.js';

/**
 * 로컬 Postgres 연결.
 * 종목 마스터와 관심종목은 KIS API 호출 전 라우팅 기준이 되므로 백엔드에서만 관리한다.
 */
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
});

export async function closeDb(): Promise<void> {
  await pool.end();
}
