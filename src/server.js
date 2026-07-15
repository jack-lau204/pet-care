import 'dotenv/config';
import { createApp } from './app.js';
import { createAppointmentRepository } from './appointment-repository.js';
import { createPool } from './db.js';

const port = Number(process.env.PORT || 3000);
const pool = createPool();
const repository = createAppointmentRepository(pool);
const app = createApp({ repository });
const server = app.listen(port, () => {
  console.log(`宠物养护服务已启动：http://localhost:${port}`);
  if (!pool) console.warn('DATABASE_URL 未配置，预约接口将返回 503');
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    if (pool) await pool.end();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

