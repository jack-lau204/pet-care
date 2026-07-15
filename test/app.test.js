import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { DateTime } from 'luxon';
import { createApp } from '../src/app.js';
import { BUSINESS_ZONE } from '../src/booking-rules.js';

const fixedNow = () => DateTime.fromISO('2026-07-13T08:00:00', { zone: BUSINESS_ZONE });

function appointment(overrides = {}) {
  return {
    id: 'cb21a69f-4146-4d4e-95d2-787a2ae52067',
    referenceCode: 'GH-TEST000001', petCode: 'doubao', petName: '豆包', petSpecies: 'dog',
    serviceCode: 'basic_wash', scheduledStart: '2026-07-14T02:00:00.000Z',
    customerName: 'Jack', customerPhone: '13800000000', notes: '', status: 'confirmed',
    cancelledAt: null, createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z',
    ...overrides
  };
}

function fakeRepository(overrides = {}) {
  return {
    health: async () => ({ now: '2026-07-13T00:00:00.000Z' }),
    bookedStarts: async () => [],
    list: async () => [],
    create: async () => ({ appointment: appointment(), reused: false }),
    update: async () => appointment(),
    cancel: async () => appointment({ status: 'cancelled', cancelledAt: '2026-07-13T01:00:00.000Z' }),
    ...overrides
  };
}

const validPayload = {
  requestId: '9d8d0d8f-7a67-4471-93b3-2d269984dc4d',
  petCode: 'doubao', serviceCode: 'basic_wash', date: '2026-07-14', time: '10:00',
  customerName: 'Jack', customerPhone: '13800000000', notes: ''
};

test('serves health and availability responses', async () => {
  const app = createApp({ repository: fakeRepository(), now: fixedNow });
  await request(app).get('/api/health').expect(200).expect(({ body }) => assert.equal(body.ok, true));
  await request(app).get('/api/appointments/availability?date=2026-07-14').expect(200).expect(({ body }) => {
    assert.equal(body.slots.length, 9);
    assert.equal(body.slots[0].time, '09:00');
  });
});

test('creates a booking and returns the management cookie', async () => {
  const app = createApp({ repository: fakeRepository(), now: fixedNow });
  const response = await request(app).post('/api/appointments').send(validPayload).expect(201);
  assert.equal(response.body.appointment.referenceCode, 'GH-TEST000001');
  assert.match(response.headers['set-cookie'][0], /pet_booking_manager=/);
  assert.match(response.headers['set-cookie'][0], /HttpOnly/);
  assert.match(response.headers['set-cookie'][0], /SameSite=Strict/);
});

test('isolates anonymous managers with different cookie hashes', async () => {
  const hashes = [];
  const app = createApp({ repository: fakeRepository({ list: async (hash) => { hashes.push(hash); return []; } }), now: fixedNow });
  await request(app).get('/api/appointments').expect(200);
  await request(app).get('/api/appointments').expect(200);
  assert.equal(hashes.length, 2);
  assert.notEqual(hashes[0], hashes[1]);
  assert.match(hashes[0], /^[a-f0-9]{64}$/);
});

test('maps validation, slot conflict, and inaccessible records to stable statuses', async () => {
  const conflict = Object.assign(new Error('duplicate'), { code: '23505', constraint: 'grooming_appointments_active_slot_uidx' });
  const conflictApp = createApp({ repository: fakeRepository({ create: async () => { throw conflict; } }), now: fixedNow });
  await request(conflictApp).post('/api/appointments').send(validPayload).expect(409);

  const missingApp = createApp({ repository: fakeRepository({ update: async () => null, cancel: async () => null }), now: fixedNow });
  await request(missingApp).patch('/api/appointments/cb21a69f-4146-4d4e-95d2-787a2ae52067').send({ ...validPayload, requestId: undefined }).expect(404);
  await request(missingApp).post('/api/appointments/cb21a69f-4146-4d4e-95d2-787a2ae52067/cancel').send({}).expect(404);

  await request(missingApp).post('/api/appointments').send({ ...validPayload, date: '2026-07-18' }).expect(400);
  await request(missingApp).post('/api/appointments/not-a-uuid/cancel').send({}).expect(400);
});

test('serves the complete booking page from the application root', async () => {
  const app = createApp({ repository: fakeRepository(), now: fixedNow });
  await request(app).get('/').expect(200).expect('Content-Type', /html/).expect(({ text }) => {
    assert.match(text, /洗护预约/);
    assert.match(text, /我的预约/);
  });
});

