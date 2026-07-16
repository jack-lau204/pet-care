import { DateTime } from 'luxon';
import { z } from 'zod';

export const BUSINESS_ZONE = 'Asia/Shanghai';
export const SERVICE_LABELS = Object.freeze({
  basic_wash: '基础洗护',
  deep_care: '深度护理',
  wash_and_style: '洗护造型'
});
export const SLOT_TIMES = Object.freeze(
  Array.from({ length: 9 }, (_, index) => `${String(index + 9).padStart(2, '0')}:00`)
);

const phonePattern = /^[+\d][\d\s-]{6,19}$/;
const appointmentSchema = z.object({
  petId: z.string().uuid('宠物标识无效'),
  serviceCode: z.enum(['basic_wash', 'deep_care', 'wash_and_style']),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.enum(SLOT_TIMES),
  customerName: z.string().trim().min(1, '请填写联系人').max(50, '联系人不能超过 50 个字符'),
  customerPhone: z.string().trim().regex(phonePattern, '请填写有效的联系电话'),
  notes: z.string().trim().max(500, '备注不能超过 500 个字符').default('')
});

export const createAppointmentSchema = appointmentSchema.extend({
  requestId: z.string().uuid('请求标识无效')
});

export const updateAppointmentSchema = appointmentSchema;

export function localNow() {
  return DateTime.now().setZone(BUSINESS_ZONE);
}

export function parseBookableDate(date, now = localNow()) {
  const parsed = DateTime.fromISO(date, { zone: BUSINESS_ZONE }).startOf('day');
  if (!parsed.isValid) throw ruleError('日期格式无效');
  if (parsed < now.startOf('day')) throw ruleError('不能预约过去的日期');
  if (parsed > now.plus({ days: 30 }).endOf('day')) throw ruleError('只能预约未来 30 天内的日期');
  if (parsed.weekday > 5) throw ruleError('周末暂不开放预约');
  return parsed;
}

export function parseScheduledStart(date, time, now = localNow()) {
  parseBookableDate(date, now);
  const start = DateTime.fromISO(`${date}T${time}`, { zone: BUSINESS_ZONE });
  if (!start.isValid || !SLOT_TIMES.includes(time)) throw ruleError('预约时段无效');
  if (start < now.plus({ hours: 2 })) throw ruleError('请至少提前 2 小时预约');
  return start;
}

export function validateCreatePayload(payload, now = localNow()) {
  const parsed = createAppointmentSchema.safeParse(payload);
  if (!parsed.success) throw validationError(parsed.error.issues);
  const scheduledStart = parseScheduledStart(parsed.data.date, parsed.data.time, now);
  return enrichAppointment(parsed.data, scheduledStart);
}

export function validateUpdatePayload(payload, now = localNow()) {
  const parsed = updateAppointmentSchema.safeParse(payload);
  if (!parsed.success) throw validationError(parsed.error.issues);
  const scheduledStart = parseScheduledStart(parsed.data.date, parsed.data.time, now);
  return enrichAppointment(parsed.data, scheduledStart);
}

function enrichAppointment(data, scheduledStart) {
  return {
    ...data,
    scheduledStart: scheduledStart.toUTC().toISO()
  };
}

function validationError(issues) {
  const error = new Error(issues[0]?.message || '表单内容无效');
  error.status = 400;
  error.details = issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message }));
  return error;
}

function ruleError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}
