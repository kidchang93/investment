import pg from 'pg';
import type { PoolClient } from 'pg';
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

/** 한 트랜잭션. `fn`이 던지면 되돌리고 그 오류를 그대로 다시 던진다. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
