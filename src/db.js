import pg from 'pg';

const { Pool } = pg;

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) return null;

  const url = new URL(connectionString);
  if (url.port !== '6543') {
    throw new Error('DATABASE_URL 必须使用 Supabase transaction pooler 的 6543 端口');
  }
  if (!url.hostname.endsWith('.pooler.supabase.com')) {
    const error = new Error(
      'DATABASE_URL 必须使用 Supabase Shared Pooler，主机名应以 .pooler.supabase.com 结尾'
    );
    error.code = 'DB_CONFIG';
    throw error;
  }

  // Transaction mode requires encrypted transport and must not use named
  // prepared statements. All repository queries are intentionally unnamed.
  url.searchParams.set('uselibpqcompat', 'true');
  url.searchParams.set('sslmode', 'require');

  return new Pool({
    connectionString: url.toString(),
    max: Number(process.env.DB_POOL_MAX || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    application_name: 'pet-care-booking-api'
  });
}

export function requirePool(pool) {
  if (pool) return pool;
  const error = new Error('数据库尚未配置');
  error.status = 503;
  throw error;
}
