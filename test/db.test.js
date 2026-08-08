import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool, isTransientDatabaseError, queryWithRetry } from '../src/db.js';

test('requires the Supabase transaction pooler host and port', async () => {
  assert.throws(
    () => createPool('postgresql://postgres:secret@db.example.supabase.co:5432/postgres?sslmode=require'),
    /6543/
  );
  assert.throws(
    () => createPool('postgresql://postgres.project:secret@aws-0-region.pooler.supabase.com:5432/postgres?sslmode=require'),
    /6543/
  );

  const pool = createPool('postgresql://postgres.project:secret@aws-0-region.pooler.supabase.com:6543/postgres?sslmode=require');
  assert.ok(pool);
  assert.equal(pool.options.min, 1);
  assert.equal(pool.options.connectionTimeoutMillis, 15_000);
  assert.equal(pool.options.keepAlive, true);
  await pool.end();
});

test('retries one transient connection failure for a safe query', async () => {
  let calls = 0;
  const pool = {
    async query() {
      calls += 1;
      if (calls === 1) throw new Error('Connection terminated due to connection timeout');
      return { rows: [{ now: '2026-08-01T00:00:00.000Z' }] };
    }
  };

  const result = await queryWithRetry(pool, 'select now() as now');
  assert.equal(calls, 2);
  assert.equal(result.rows[0].now, '2026-08-01T00:00:00.000Z');
});

test('does not retry non-transient database errors', async () => {
  let calls = 0;
  const error = Object.assign(new Error('invalid input syntax'), { code: '22P02' });
  const pool = { query: async () => { calls += 1; throw error; } };

  await assert.rejects(() => queryWithRetry(pool, 'select broken'), error);
  assert.equal(calls, 1);
  assert.equal(isTransientDatabaseError(error), false);
});
