import 'dotenv/config';
import { createPool } from '../src/db.js';
import { createStorageClient } from '../src/image-storage.js';

const REQUIRED_ENVIRONMENT_VARIABLES = [
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY'
];

const missingVariables = REQUIRED_ENVIRONMENT_VARIABLES.filter((name) => !process.env[name]);
if (missingVariables.length > 0) {
  throw new Error(`缺少 Supabase 检查所需环境变量：${missingVariables.join(', ')}`);
}

const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'care-dynamics';
const pool = createPool();

try {
  const result = await pool.query('select 1 as ok');
  if (result.rowCount !== 1 || result.rows[0]?.ok !== 1) {
    throw new Error('数据库只读检查未返回预期结果');
  }
  console.log('Supabase 数据库只读连接检查通过');

  const supabase = createStorageClient();
  const { data, error } = await supabase.storage.getBucket(bucket);
  if (error) throw new Error(`Storage bucket 只读检查失败：${error.message}`);
  if (data?.id !== bucket) throw new Error('Storage bucket 只读检查未返回预期 bucket');
  console.log(`Supabase Storage bucket 检查通过：${bucket}`);
} finally {
  await pool.end();
}
