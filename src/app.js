import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import multer from 'multer';
import { DateTime } from 'luxon';
import { z } from 'zod';
import {
  SESSION_COOKIE,
  clearSessionCookie,
  setSessionCookie
} from './auth-service.js';
import {
  BUSINESS_ZONE,
  SLOT_TIMES,
  localNow,
  parseBookableDate,
  validateAdminUpdatePayload,
  validateCreatePayload,
  validateUpdatePayload
} from './booking-rules.js';
import { isTransientDatabaseError } from './db.js';
import { hasAdminAccess, hasStaffAccess, ROLES } from './roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const uuidSchema = z.string().uuid('标识无效');
const authSchema = z.object({
  email: z.string().trim().email('请填写有效邮箱').max(254),
  password: z.string().min(8, '密码至少需要 8 位').max(72, '密码不能超过 72 位'),
  displayName: z.string().trim().min(1, '请填写昵称').max(50)
});
const petSchema = z.object({
  name: z.string().trim().min(1, '请填写宠物名字').max(50),
  species: z.enum(['dog', 'cat', 'other']),
  breed: z.string().trim().max(80).default(''),
  sex: z.enum(['male', 'female', 'unknown']).default('unknown'),
  birthDate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal(''), z.null()]).optional(),
  weightKg: z.union([z.number().positive().max(9999), z.null()]).optional()
});
const petCreateSchema = petSchema.extend({ requestId: uuidSchema.optional() });
const postSchema = z.object({
  petId: z.string().uuid('宠物标识无效'),
  phase: z.enum(['before', 'after'], { error: '请选择养护前或养护后' }),
  body: z.string().trim().max(2000, '动态正文不能超过 2000 字').default('')
});
const commentBodySchema = z.object({ body: z.string().trim().min(1, '评论不能为空').max(500, '评论不能超过 500 字') });
const commentCreateSchema = commentBodySchema.extend({
  requestId: z.string().uuid('评论请求标识无效').optional()
});
const moderationSchema = z.object({
  status: z.enum(['published', 'hidden']),
  reason: z.string().trim().max(300, '审核原因不能超过 300 字').default('')
});
const roleUpdateSchema = z.object({ role: z.enum(ROLES) });
const adminPetCreateSchema = petCreateSchema.extend({ ownerId: uuidSchema });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 6, fileSize: 8 * 1024 * 1024, fields: 20, fieldSize: 64 * 1024 }
});

export function createApp({
  repository,
  identityRepository,
  communityRepository,
  authService,
  imageStorage,
  now = localNow
} = {}) {
  if (!repository) throw new Error('repository is required');
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser());
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-8' }));
  app.use('/api/auth', rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8' }));
  app.use('/api', rejectCrossSiteMutation);
  app.use('/api', async (request, response, next) => {
    request.actor = null;
    if (!authService) return next();
    try {
      request.actor = await authService.resolve(request.cookies[SESSION_COOKIE]);
      return next();
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/health', async (_request, response, next) => {
    try {
      const result = await repository.health();
      response.json({ ok: true, databaseTime: result.now });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/register', async (request, response, next) => {
    try {
      requireDependency(authService, '认证服务尚未配置');
      const input = parse(authSchema, request.body);
      const result = await authService.register(input);
      setSessionCookie(response, result.session);
      response.status(201).json({ user: publicActor(result.user) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/login', async (request, response, next) => {
    try {
      requireDependency(authService, '认证服务尚未配置');
      const input = parse(authSchema.omit({ displayName: true }), request.body);
      const result = await authService.login(input);
      setSessionCookie(response, result.session);
      response.json({ user: publicActor(result.user) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/logout', async (request, response, next) => {
    try {
      if (authService) await authService.logout(request.cookies[SESSION_COOKIE]);
      clearSessionCookie(response);
      response.status(204).end();
    } catch (error) {
      clearSessionCookie(response);
      next(error);
    }
  });

  app.get('/api/auth/session', (request, response) => {
    response.json({ user: request.actor ? publicActor(request.actor) : null });
  });

  app.get('/api/admin/users', requireAdmin, async (request, response, next) => {
    try {
      requireDependency(identityRepository, '用户资料服务尚未配置');
      const query = String(request.query.query || '').trim().slice(0, 80);
      response.json({ users: await identityRepository.listUsers(query) });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/admin/users/:id/role', requireAdmin, async (request, response, next) => {
    try {
      requireDependency(identityRepository, '用户资料服务尚未配置');
      validateUuid(request.params.id);
      const { role } = parse(roleUpdateSchema, request.body);
      if (request.params.id === request.actor.id && role !== 'admin') {
        throw conflict('不能降低当前登录管理员的权限');
      }
      const user = await identityRepository.updateUserRole(request.actor.id, request.params.id, role);
      if (!user) return response.status(404).json({ error: '用户不存在' });
      return response.json({ user: publicActor(user) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/pets', requireActor, async (request, response, next) => {
    try {
      requireDependency(identityRepository, '宠物资料服务尚未配置');
      const query = String(request.query.query || '').trim().slice(0, 80);
      response.json({ pets: await identityRepository.listPets(request.actor, query) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/pets', requireActor, async (request, response, next) => {
    try {
      const { requestId, ...petInput } = parse(petCreateSchema, request.body);
      const pet = await identityRepository.createPet(
        request.actor.id,
        normalizePet(petInput),
        requestId || crypto.randomUUID()
      );
      if (!pet) throw conflict('请求标识已被使用');
      response.status(201).json({ pet });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/pets/:id', requireActor, async (request, response, next) => {
    try {
      validateUuid(request.params.id);
      const input = normalizePet(parse(petSchema, request.body));
      const pet = await identityRepository.updatePet(request.params.id, request.actor.id, input);
      if (!pet) return response.status(404).json({ error: '宠物不存在或无权修改' });
      return response.json({ pet });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/pets/:id', requireActor, async (request, response, next) => {
    try {
      validateUuid(request.params.id);
      const deleted = await identityRepository.deletePet(request.params.id, request.actor.id);
      if (!deleted) return response.status(404).json({ error: '宠物不存在或无权删除' });
      return response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/admin/pets', requireAdmin, async (request, response, next) => {
    try {
      requireDependency(identityRepository, '宠物资料服务尚未配置');
      const query = String(request.query.query || '').trim().slice(0, 80);
      response.json({ pets: await identityRepository.listPets(request.actor, query) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/pets', requireAdmin, async (request, response, next) => {
    try {
      requireDependency(identityRepository, '宠物资料服务尚未配置');
      const { ownerId, requestId, ...petInput } = parse(adminPetCreateSchema, request.body);
      if (!await identityRepository.getProfile(ownerId)) return response.status(404).json({ error: '宠物主人不存在' });
      const pet = await identityRepository.createPet(
        ownerId,
        normalizePet(petInput),
        requestId || crypto.randomUUID()
      );
      if (!pet) throw conflict('请求标识已被使用');
      response.status(201).json({ pet });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/admin/pets/:id', requireAdmin, async (request, response, next) => {
    try {
      requireDependency(identityRepository, '宠物资料服务尚未配置');
      validateUuid(request.params.id);
      const input = normalizePet(parse(petSchema, request.body));
      const pet = await identityRepository.updatePetAsAdmin(request.params.id, input);
      if (!pet) return response.status(404).json({ error: '宠物不存在' });
      return response.json({ pet });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/admin/pets/:id', requireAdmin, async (request, response, next) => {
    try {
      requireDependency(identityRepository, '宠物资料服务尚未配置');
      validateUuid(request.params.id);
      const deleted = await identityRepository.deletePetAsAdmin(request.params.id);
      if (!deleted) return response.status(404).json({ error: '宠物不存在' });
      return response.status(204).end();
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
        return { time, available: start >= current.plus({ hours: 2 }) && !booked.has(start.toUTC().toISO()) };
      });
      response.json({ date, slots });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/appointments', requireActor, async (request, response, next) => {
    try {
      response.json({ appointments: await repository.list(request.actor.id) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/appointments', requireActor, async (request, response, next) => {
    try {
      const input = validateCreatePayload(request.body, now());
      const pet = await ownedPet(identityRepository, request.actor, input.petId);
      const result = await repository.create(input, request.actor.id, pet);
      if (!result) return response.status(409).json({ error: '请求标识已被使用' });
      return response.status(result.reused ? 200 : 201).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/appointments/:id', requireActor, async (request, response, next) => {
    try {
      validateUuid(request.params.id);
      const input = validateUpdatePayload(request.body, now());
      const pet = await ownedPet(identityRepository, request.actor, input.petId);
      const appointment = await repository.update(request.params.id, input, request.actor.id, pet);
      if (!appointment) return response.status(404).json({ error: '预约不存在或当前不可修改' });
      return response.json({ appointment });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/appointments/:id/cancel', requireActor, async (request, response, next) => {
    try {
      validateUuid(request.params.id);
      const appointment = await repository.cancel(request.params.id, request.actor.id);
      if (!appointment) return response.status(404).json({ error: '预约不存在或当前不可取消' });
      return response.json({ appointment });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/admin/appointments', requireAdmin, async (_request, response, next) => {
    try {
      response.json({ appointments: await repository.listAll() });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/admin/appointments/:id', requireAdmin, async (request, response, next) => {
    try {
      requireDependency(identityRepository, '宠物资料服务尚未配置');
      validateUuid(request.params.id);
      const current = await repository.getById(request.params.id);
      if (!current) return response.status(404).json({ error: '预约不存在' });
      const input = validateAdminUpdatePayload(request.body, now());
      const pet = await identityRepository.getPet(input.petId);
      if (!pet) return response.status(404).json({ error: '宠物不存在' });
      if (pet.ownerId !== current.ownerId) throw forbidden('预约只能选择该顾客的宠物');
      const appointment = await repository.updateAsAdmin(current.id, input, pet);
      if (!appointment) return response.status(404).json({ error: '预约不存在或当前不可修改' });
      return response.json({ appointment });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/appointments/:id/cancel', requireAdmin, async (request, response, next) => {
    try {
      validateUuid(request.params.id);
      const appointment = await repository.cancelAsAdmin(request.params.id);
      if (!appointment) return response.status(404).json({ error: '预约不存在或当前不可取消' });
      return response.json({ appointment });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/posts', async (request, response, next) => {
    try {
      requireDependency(communityRepository, '动态服务尚未配置');
      const phase = request.query.phase ? parse(z.enum(['before', 'after']), request.query.phase) : null;
      const petId = request.query.petId ? parse(uuidSchema, request.query.petId) : null;
      const cursor = request.query.cursor ? decodeCursor(request.query.cursor) : null;
      const result = await communityRepository.listPosts({ actor: request.actor, phase, petId, cursor });
      const posts = result.posts.map((post) => serializePost(post, request.actor, imageStorage));
      response.json({
        posts,
        nextCursor: result.hasMore && posts.length ? encodeCursor(posts.at(-1)) : null
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/posts', requireActor, requireImageServices, upload.array('images', 6), async (request, response, next) => {
    const uploaded = [];
    try {
      const input = parse(postSchema, request.body);
      await permittedPet(identityRepository, request.actor, input.petId);
      if (!input.body && !request.files.length) throw badRequest('动态需要文字或至少一张图片');
      const postId = crypto.randomUUID();
      for (const file of request.files) uploaded.push(await imageStorage.upload(file, { userId: request.actor.id, postId }));
      const post = await communityRepository.createPost({
        id: postId,
        authorId: request.actor.id,
        ...input,
        images: uploaded
      });
      response.status(201).json({ post: serializePost(post, request.actor, imageStorage) });
    } catch (error) {
      await cleanupUploaded(imageStorage, uploaded);
      next(error);
    }
  });

  app.patch('/api/posts/:id', requireActor, requireImageServices, upload.array('images', 6), async (request, response, next) => {
    const uploaded = [];
    try {
      validateUuid(request.params.id);
      const existing = await communityRepository.getPost(request.params.id);
      if (!existing) return response.status(404).json({ error: '动态不存在' });
      if (existing.authorId !== request.actor.id) return response.status(403).json({ error: '只能编辑自己发布的动态' });
      const input = parse(postSchema, request.body);
      await permittedPet(identityRepository, request.actor, input.petId);
      const removeIds = parseJsonIdList(request.body.removeImageIds, '待删除图片');
      const kept = existing.images.filter((image) => !removeIds.includes(image.id));
      if (kept.length + request.files.length > 6) throw badRequest('每条动态最多保留 6 张图片');
      if (!input.body && kept.length + request.files.length === 0) throw badRequest('动态需要文字或至少一张图片');
      for (const file of request.files) uploaded.push(await imageStorage.upload(file, { userId: request.actor.id, postId: existing.id }));
      const order = parseJsonIdList(request.body.imageOrder, '图片顺序', true);
      const orderedKept = order.length
        ? [...order.map((id) => kept.find((image) => image.id === id)).filter(Boolean), ...kept.filter((image) => !order.includes(image.id))]
        : kept;
      const post = await communityRepository.updatePost({ id: existing.id, ...input, images: [...orderedKept, ...uploaded] });
      const removed = existing.images.filter((image) => !kept.some((item) => item.id === image.id));
      await cleanupUploaded(imageStorage, removed, false);
      response.json({ post: serializePost(post, request.actor, imageStorage) });
    } catch (error) {
      await cleanupUploaded(imageStorage, uploaded);
      next(error);
    }
  });

  app.delete('/api/posts/:id', requireActor, requireImageServices, async (request, response, next) => {
    try {
      validateUuid(request.params.id);
      const post = await communityRepository.getPost(request.params.id);
      if (!post) return response.status(404).json({ error: '动态不存在' });
      if (post.authorId !== request.actor.id && !hasStaffAccess(request.actor.role)) {
        return response.status(403).json({ error: '无权删除这条动态' });
      }
      const paths = await communityRepository.deletePost(post.id);
      for (const objectPath of paths || []) await safeRemove(imageStorage, objectPath);
      return response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/posts/:id/moderation', requireStaff, async (request, response, next) => {
    try {
      validateUuid(request.params.id);
      const input = parse(moderationSchema, request.body);
      if (input.status === 'hidden' && !input.reason) throw badRequest('隐藏内容时请填写原因');
      const post = await communityRepository.moderatePost(request.params.id, {
        ...input,
        moderatorId: request.actor.id
      });
      if (!post) return response.status(404).json({ error: '动态不存在' });
      return response.json({ post: serializePost(post, request.actor, imageStorage) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/posts/:id/comments', async (request, response, next) => {
    try {
      validateUuid(request.params.id);
      const post = await readablePost(communityRepository, request.params.id, request.actor);
      if (!post) return response.status(404).json({ error: '动态不存在' });
      const cursor = request.query.cursor ? decodeCursor(request.query.cursor) : null;
      const result = await communityRepository.listComments({ postId: post.id, actor: request.actor, cursor });
      response.json({
        comments: result.comments.map((comment) => serializeComment(comment, request.actor)),
        nextCursor: result.hasMore && result.comments.length ? encodeCursor(result.comments.at(-1)) : null
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/posts/:id/comments', requireActor, async (request, response, next) => {
    try {
      validateUuid(request.params.id);
      const post = await communityRepository.getPost(request.params.id);
      if (!post || post.status !== 'published') return response.status(404).json({ error: '动态不存在或当前不可评论' });
      const input = parse(commentCreateSchema, request.body);
      const comment = await communityRepository.createComment(
        post.id,
        request.actor.id,
        input.body,
        input.requestId || crypto.randomUUID()
      );
      response.status(201).json({ comment: serializeComment(comment, request.actor) });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/comments/:id', requireActor, async (request, response, next) => {
    try {
      validateUuid(request.params.id);
      const current = await communityRepository.getComment(request.params.id);
      if (!current) return response.status(404).json({ error: '评论不存在' });
      if (current.authorId !== request.actor.id) return response.status(403).json({ error: '只能编辑自己的评论' });
      const input = parse(commentBodySchema, request.body);
      const comment = await communityRepository.updateComment(current.id, input.body);
      response.json({ comment: serializeComment(comment, request.actor) });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/comments/:id', requireActor, async (request, response, next) => {
    try {
      validateUuid(request.params.id);
      const comment = await communityRepository.getComment(request.params.id);
      if (!comment) return response.status(404).json({ error: '评论不存在' });
      if (comment.authorId !== request.actor.id && !hasStaffAccess(request.actor.role)) {
        return response.status(403).json({ error: '无权删除这条评论' });
      }
      await communityRepository.deleteComment(comment.id);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/comments/:id/moderation', requireStaff, async (request, response, next) => {
    try {
      validateUuid(request.params.id);
      const input = parse(moderationSchema, request.body);
      if (input.status === 'hidden' && !input.reason) throw badRequest('隐藏内容时请填写原因');
      const comment = await communityRepository.moderateComment(request.params.id, {
        ...input,
        moderatorId: request.actor.id
      });
      if (!comment) return response.status(404).json({ error: '评论不存在' });
      response.json({ comment: serializeComment(comment, request.actor) });
    } catch (error) {
      next(error);
    }
  });

  app.use(express.static(path.join(projectRoot, 'public'), { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
  app.get('/', (_request, response) => response.sendFile(path.join(projectRoot, 'public', 'index.html')));

  app.use((error, _request, response, _next) => {
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? '单张图片不能超过 8 MB' : '图片数量或表单大小超出限制';
      return response.status(400).json({ error: message });
    }
    if (error?.code === '23505' && error?.constraint === 'grooming_appointments_active_slot_uidx') {
      return response.status(409).json({ error: '这个时段刚刚被预约，请选择其他时段' });
    }
    if (error?.code === '23503') return response.status(409).json({ error: '该记录已被预约或动态使用，暂不能删除' });
    if (error?.code === '42P01') return response.status(503).json({ error: '数据库迁移尚未完成，请先执行最新迁移' });
    if (isTransientDatabaseError(error)) {
      console.error(error);
      return response.status(503).json({ error: '数据库连接暂时不稳定，请稍后重试' });
    }
    const status = error.status || (isDatabaseError(error) ? 503 : 500);
    if (status >= 500) console.error(error);
    return response.status(status).json({
      error: status === 500 ? '服务暂时不可用，请稍后再试' : error.message,
      ...(error.details ? { details: error.details } : {})
    });
  });

  return app;

  function requireImageServices(request, response, next) {
    if (!communityRepository || !imageStorage || !identityRepository) {
      return response.status(503).json({ error: '动态图片服务尚未配置' });
    }
    return next();
  }
}

function requireActor(request, response, next) {
  if (!request.actor) return response.status(401).json({ error: '请先登录' });
  return next();
}

function requireStaff(request, response, next) {
  if (!request.actor) return response.status(401).json({ error: '请先登录' });
  if (!hasStaffAccess(request.actor.role)) return response.status(403).json({ error: '仅员工可以执行审核操作' });
  return next();
}

function requireAdmin(request, response, next) {
  if (!request.actor) return response.status(401).json({ error: '请先登录' });
  if (!hasAdminAccess(request.actor.role)) return response.status(403).json({ error: '仅管理员可以执行此操作' });
  return next();
}

function rejectCrossSiteMutation(request, response, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
  const origin = request.get('origin');
  if (!origin) return next();
  try {
    if (new URL(origin).host === request.get('host')) return next();
  } catch {
    // Fall through to a stable forbidden response.
  }
  return response.status(403).json({ error: '拒绝跨站请求' });
}

async function permittedPet(identityRepository, actor, petId) {
  requireDependency(identityRepository, '宠物资料服务尚未配置');
  const pet = await identityRepository.getPet(petId);
  if (!pet) throw notFound('宠物不存在');
  if (!hasStaffAccess(actor.role) && pet.ownerId !== actor.id) throw forbidden('只能选择自己的宠物');
  return pet;
}

async function ownedPet(identityRepository, actor, petId) {
  requireDependency(identityRepository, '宠物资料服务尚未配置');
  const pet = await identityRepository.getPet(petId);
  if (!pet) throw notFound('宠物不存在');
  if (pet.ownerId !== actor.id) throw forbidden('预约只能选择自己的宠物');
  return pet;
}

async function readablePost(repository, id, actor) {
  const post = await repository.getPost(id);
  if (!post) return null;
  if (post.status === 'published' || hasStaffAccess(actor?.role) || actor?.id === post.authorId) return post;
  return null;
}

function serializePost(post, actor, imageStorage) {
  return {
    ...post,
    images: post.images.map(({ objectPath, ...image }) => ({
      ...image,
      url: imageStorage ? imageStorage.publicUrl(objectPath) : ''
    })),
    canEdit: Boolean(actor && actor.id === post.authorId),
    canDelete: Boolean(actor && (actor.id === post.authorId || hasStaffAccess(actor.role))),
    canModerate: hasStaffAccess(actor?.role)
  };
}

function serializeComment(comment, actor) {
  return {
    ...comment,
    canEdit: Boolean(actor && actor.id === comment.authorId),
    canDelete: Boolean(actor && (actor.id === comment.authorId || hasStaffAccess(actor.role))),
    canModerate: hasStaffAccess(actor?.role)
  };
}

function publicActor(actor) {
  return { id: actor.id, email: actor.email || '', displayName: actor.displayName, role: actor.role };
}

function normalizePet(input) {
  return {
    ...input,
    birthDate: input.birthDate || null,
    weightKg: input.weightKg ?? null
  };
}

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const error = badRequest(result.error.issues[0]?.message || '提交内容无效');
  error.details = result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }));
  throw error;
}

function parseJsonIdList(value, label, optional = false) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return parse(z.array(z.string().uuid()).max(6), parsed);
  } catch (error) {
    if (error.status) throw error;
    if (optional) return [];
    throw badRequest(`${label}格式无效`);
  }
}

function encodeCursor(item) {
  return Buffer.from(JSON.stringify({ createdAt: item.createdAt, id: item.id })).toString('base64url');
}

function decodeCursor(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!uuidSchema.safeParse(parsed.id).success || !Number.isFinite(Date.parse(parsed.createdAt))) throw new Error();
    return { id: parsed.id, createdAt: new Date(parsed.createdAt).toISOString() };
  } catch {
    throw badRequest('分页游标无效');
  }
}

function validateUuid(id) {
  parse(uuidSchema, id);
}

async function cleanupUploaded(storage, images, logFailures = true) {
  if (!storage) return;
  for (const image of images) {
    try {
      await storage.remove(image.objectPath);
    } catch (error) {
      if (logFailures) console.error(error);
    }
  }
}

async function safeRemove(storage, objectPath) {
  try {
    await storage.remove(objectPath);
  } catch (error) {
    console.error(error);
  }
}

function requireDependency(value, message) {
  if (!value) throw serviceError(message);
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function conflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}

function forbidden(message) {
  return Object.assign(new Error(message), { status: 403 });
}

function notFound(message) {
  return Object.assign(new Error(message), { status: 404 });
}

function serviceError(message) {
  return Object.assign(new Error(message), { status: 503 });
}

function isDatabaseError(error) {
  const networkCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']);
  return Boolean(error?.code && (/^[0-9A-Z]{5}$/.test(error.code) || networkCodes.has(error.code)))
    || /数据库|connection timeout|connection terminated|ECONNRESET/i.test(error?.message || '');
}
