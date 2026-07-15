import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { DateTime } from 'luxon';
import {
  BUSINESS_ZONE,
  SLOT_TIMES,
  localNow,
  parseBookableDate,
  parseScheduledStart,
  validateCreatePayload,
  validateUpdatePayload
} from './booking-rules.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const cookieName = 'pet_booking_manager';

export function createApp({ repository, now = localNow } = {}) {
  if (!repository) throw new Error('repository is required');
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8' }));

  app.get('/api/health', async (_request, response, next) => {
    try {
      const result = await repository.health();
      response.json({ ok: true, databaseTime: result.now });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/appointments/availability', async (request, response, next) => {
    try {
      const date = String(request.query.date || '');
      const current = now();
      const day = parseBookableDate(date, current);
      const dayEnd = day.plus({ days: 1 });
      const booked = new Set(await repository.bookedStarts(day.toUTC().toISO(), dayEnd.toUTC().toISO()));
      const slots = SLOT_TIMES.map((time) => {
        const start = DateTime.fromISO(`${date}T${time}`, { zone: BUSINESS_ZONE });
        const available = start >= current.plus({ hours: 2 }) && !booked.has(start.toUTC().toISO());
        return { time, available };
      });
      response.json({ date, slots });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/appointments', async (request, response, next) => {
    try {
      const identity = ensureManager(request, response);
      const appointments = await repository.list(identity.hash);
      response.json({ appointments });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/appointments', async (request, response, next) => {
    try {
      const identity = ensureManager(request, response);
      const input = validateCreatePayload(request.body, now());
      const result = await repository.create(input, identity.hash);
      if (!result) return response.status(409).json({ error: '请求标识已被使用' });
      return response.status(result.reused ? 200 : 201).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/appointments/:id', async (request, response, next) => {
    try {
      validateAppointmentId(request.params.id);
      const identity = ensureManager(request, response);
      const input = validateUpdatePayload(request.body, now());
      const appointment = await repository.update(request.params.id, input, identity.hash);
      if (!appointment) return response.status(404).json({ error: '预约不存在或当前不可修改' });
      return response.json({ appointment });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/appointments/:id/cancel', async (request, response, next) => {
    try {
      validateAppointmentId(request.params.id);
      const identity = ensureManager(request, response);
      const appointment = await repository.cancel(request.params.id, identity.hash);
      if (!appointment) return response.status(404).json({ error: '预约不存在或当前不可取消' });
      return response.json({ appointment });
    } catch (error) {
      next(error);
    }
  });

  app.get('/', (_request, response) => response.sendFile(path.join(projectRoot, 'public', 'index.html')));

  app.use((error, _request, response, _next) => {
    if (error?.code === '23505' && error?.constraint === 'grooming_appointments_active_slot_uidx') {
      return response.status(409).json({ error: '这个时段刚刚被预约，请选择其他时段' });
    }
    const status = error.status || (isDatabaseError(error) ? 503 : 500);
    if (status >= 500) console.error(error);
    return response.status(status).json({
      error: status === 500 ? '服务暂时不可用，请稍后再试' : error.message,
      ...(error.details ? { details: error.details } : {})
    });
  });

  return app;
}

function ensureManager(request, response) {
  let token = request.cookies[cookieName];
  if (!/^[a-f0-9]{64}$/.test(token || '')) {
    token = crypto.randomBytes(32).toString('hex');
    response.cookie(cookieName, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 180 * 24 * 60 * 60 * 1000,
      path: '/api/appointments'
    });
  }
  return { hash: crypto.createHash('sha256').update(token).digest('hex') };
}

function isDatabaseError(error) {
  const networkCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);
  return Boolean(error?.code && (/^[0-9A-Z]{5}$/.test(error.code) || networkCodes.has(error.code)))
    || /数据库|connection timeout|connection terminated|ECONNRESET/i.test(error?.message || '');
}

function validateAppointmentId(id) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return;
  const error = new Error('预约标识无效');
  error.status = 400;
  throw error;
}
