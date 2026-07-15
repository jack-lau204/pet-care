import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../src/db.js';

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
  await pool.end();
});
