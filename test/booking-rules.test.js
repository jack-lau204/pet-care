import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import {
  BUSINESS_ZONE,
  parseBookableDate,
  parseScheduledStart,
  validateCreatePayload
} from '../src/booking-rules.js';

const now = DateTime.fromISO('2026-07-13T08:00:00', { zone: BUSINESS_ZONE });
const petId = '2e6fd5ae-86cb-4f8d-8fd1-03a5a6b2534e';

test('accepts a valid weekday slot at least two hours ahead', () => {
  const result = validateCreatePayload({
    requestId: '9d8d0d8f-7a67-4471-93b3-2d269984dc4d',
    petId,
    serviceCode: 'basic_wash',
    date: '2026-07-13',
    time: '10:00',
    customerName: 'Jack',
    customerPhone: '138 0000 0000',
    notes: ''
  }, now);

  assert.equal(result.petId, petId);
  assert.equal(result.scheduledStart, '2026-07-13T02:00:00.000Z');
});

test('rejects weekends, past dates, distant dates, and short notice', () => {
  assert.throws(() => parseBookableDate('2026-07-18', now), /周末/);
  assert.throws(() => parseBookableDate('2026-07-12', now), /过去/);
  assert.throws(() => parseBookableDate('2026-08-13', now), /未来 30 天/);
  assert.throws(() => parseScheduledStart('2026-07-13', '09:00', now), /提前 2 小时/);
});

test('rejects invalid services, slots, and contact details', () => {
  const base = {
    requestId: '9d8d0d8f-7a67-4471-93b3-2d269984dc4d',
    petId, serviceCode: 'basic_wash', date: '2026-07-14',
    time: '10:00', customerName: 'Jack', customerPhone: '13800000000', notes: ''
  };
  assert.throws(() => validateCreatePayload({ ...base, serviceCode: 'spa' }, now));
  assert.throws(() => validateCreatePayload({ ...base, time: '10:30' }, now));
  assert.throws(() => validateCreatePayload({ ...base, customerPhone: '12' }, now));
});
