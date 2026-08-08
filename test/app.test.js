import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { DateTime } from 'luxon';
import { createApp } from '../src/app.js';
import { BUSINESS_ZONE } from '../src/booking-rules.js';

const USER_ID = '6b48f45a-7c9a-4996-a92b-bcbe32ec1964';
const OTHER_ID = 'c2d1268a-b574-4aa0-8e77-b3f5687c21d2';
const PET_ID = '2e6fd5ae-86cb-4f8d-8fd1-03a5a6b2534e';
const POST_ID = 'e19e1223-34c1-4ae4-a2ec-a82d3bf8fa64';
const COMMENT_ID = 'c12b753d-ccce-4836-8e2d-951ed16b65b5';
const PET_REQUEST_ID = '13cc7c18-91f4-4da4-8917-06481628f218';
const fixedNow = () => DateTime.fromISO('2026-07-13T08:00:00', { zone: BUSINESS_ZONE });

function actor(overrides = {}) {
  return { id: USER_ID, displayName: 'Jack', role: 'customer', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z', ...overrides };
}

function pet(overrides = {}) {
  return { id: PET_ID, ownerId: USER_ID, ownerName: 'Jack', name: '豆包', species: 'dog', breed: '柯基', sex: 'male', birthDate: null, weightKg: 12.4, ...overrides };
}

function appointment(overrides = {}) {
  return {
    id: 'cb21a69f-4146-4d4e-95d2-787a2ae52067', referenceCode: 'GH-TEST000001', ownerId: USER_ID,
    petId: PET_ID, petCode: PET_ID, petName: '豆包', petSpecies: 'dog', serviceCode: 'basic_wash',
    scheduledStart: '2026-07-14T02:00:00.000Z', customerName: 'Jack', customerPhone: '13800000000',
    notes: '', status: 'confirmed', cancelledAt: null, createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z', ...overrides
  };
}

function post(overrides = {}) {
  return {
    id: POST_ID, authorId: USER_ID, author: { displayName: 'Jack', role: 'customer' }, petId: PET_ID,
    pet: { name: '豆包', species: 'dog', breed: '柯基' }, phase: 'before', body: '准备洗护', status: 'published',
    moderationReason: '', commentCount: 0, images: [], createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:00.000Z', ...overrides
  };
}

function fakeAppointmentRepository(overrides = {}) {
  return {
    health: async () => ({ now: '2026-07-13T00:00:00.000Z' }), bookedStarts: async () => [], list: async () => [],
    create: async () => ({ appointment: appointment(), reused: false }), update: async () => appointment(),
    cancel: async () => appointment({ status: 'cancelled', cancelledAt: '2026-07-13T01:00:00.000Z' }),
    listAll: async () => [appointment({ ownerName: 'Jack', ownerEmail: 'jack@example.com' })],
    getById: async () => appointment(), updateAsAdmin: async () => appointment(),
    cancelAsAdmin: async () => appointment({ status: 'cancelled', cancelledAt: '2026-07-13T01:00:00.000Z' }),
    ...overrides
  };
}

function fakeAuthService(userOverrides = {}) {
  const token = 'a'.repeat(64);
  const user = { ...actor(userOverrides), email: 'jack@example.com' };
  const session = { token, expiresAt: '2027-01-01T00:00:00.000Z' };
  return {
    resolve: async (value) => value === token ? user : null,
    login: async () => ({ user, session }),
    register: async () => ({ user, session }),
    logout: async () => {}
  };
}

function fakeIdentityRepository(overrides = {}) {
  return {
    getProfile: async (id) => id === USER_ID ? actor() : null,
    getPet: async (id) => id === PET_ID ? pet() : null,
    listPets: async () => [pet()], createPet: async () => pet(), updatePet: async () => pet(), deletePet: async () => true,
    listUsers: async () => [{ ...actor(), email: 'jack@example.com' }],
    updateUserRole: async (_actorId, id, role) => ({ ...actor({ id, role }), email: 'other@example.com' }),
    updatePetAsAdmin: async () => pet(), deletePetAsAdmin: async () => true,
    ...overrides
  };
}

function fakeCommunityRepository(overrides = {}) {
  return {
    listPosts: async () => ({ posts: [post()], hasMore: false }), getPost: async () => post(),
    createPost: async (input) => post({ id: input.id, phase: input.phase, body: input.body, images: input.images }),
    updatePost: async (input) => post(input), deletePost: async () => [], moderatePost: async (_id, input) => post({ status: input.status }),
    listComments: async () => ({ comments: [], hasMore: false }),
    getComment: async () => ({ id: COMMENT_ID, postId: POST_ID, authorId: USER_ID, author: { displayName: 'Jack', role: 'customer' }, body: '真可爱', status: 'published', moderationReason: '', createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z' }),
    createComment: async (_postId, authorId, body) => ({ id: COMMENT_ID, postId: POST_ID, authorId, author: { displayName: 'Jack', role: 'customer' }, body, status: 'published', moderationReason: '', createdAt: '2026-07-13T00:00:00.000Z', updatedAt: '2026-07-13T00:00:00.000Z' }),
    updateComment: async () => null, deleteComment: async () => true, moderateComment: async () => null, ...overrides
  };
}

function fakeImageStorage() {
  return {
    upload: async () => ({ objectPath: 'x.webp', mimeType: 'image/webp', byteSize: 10, width: 1, height: 1 }),
    remove: async () => {}, publicUrl: (path) => `https://images.example/${path}`
  };
}

function buildApp(overrides = {}) {
  return createApp({
    repository: fakeAppointmentRepository(), identityRepository: fakeIdentityRepository(),
    communityRepository: fakeCommunityRepository(), authService: fakeAuthService(),
    imageStorage: fakeImageStorage(), now: fixedNow, ...overrides
  });
}

async function loginAgent(app) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email: 'jack@example.com', password: 'password123' }).expect(200);
  return agent;
}

const validPayload = {
  requestId: '9d8d0d8f-7a67-4471-93b3-2d269984dc4d', petId: PET_ID, serviceCode: 'basic_wash',
  date: '2026-07-14', time: '10:00', customerName: 'Jack', customerPhone: '13800000000', notes: ''
};

test('serves health, availability, and the complete application page', async () => {
  const app = buildApp();
  await request(app).get('/api/health').expect(200).expect(({ body }) => assert.equal(body.ok, true));
  await request(app).get('/api/appointments/availability?date=2026-07-14').expect(200).expect(({ body }) => assert.equal(body.slots.length, 9));
  await request(app).get('/').expect(200).expect('Content-Type', /html/).expect(({ text }) => {
    assert.match(text, /养护动态/);
    assert.match(text, /洗护预约/);
    assert.match(text, /登录 \/ 注册/);
    assert.match(text, /管理后台/);
  });
  await request(app).get('/styles.css').expect(200).expect('Content-Type', /css/).expect(({ text }) => {
    assert.match(text, /\.toast\{pointer-events:none\}/);
  });
  await request(app).get('/app.js').expect(200).expect('Content-Type', /javascript/);
});

test('returns a stable message when availability cannot reach the database', async (context) => {
  context.mock.method(console, 'error', () => {});
  const app = buildApp({
    repository: fakeAppointmentRepository({
      bookedStarts: async () => { throw new Error('Connection terminated due to connection timeout'); }
    })
  });

  await request(app)
    .get('/api/appointments/availability?date=2026-07-14')
    .expect(503)
    .expect(({ body }) => assert.equal(body.error, '数据库连接暂时不稳定，请稍后重试'));
});

test('sets HttpOnly session cookies and exposes the current profile', async () => {
  const app = buildApp();
  const response = await request(app).post('/api/auth/login').send({ email: 'jack@example.com', password: 'password123' }).expect(200);
  assert.equal(response.body.user.displayName, 'Jack');
  assert.match(response.headers['set-cookie'].join(';'), /pet_care_session=/);
  assert.match(response.headers['set-cookie'].join(';'), /HttpOnly/);
  assert.match(response.headers['set-cookie'].join(';'), /SameSite=Strict/);
  const agent = await loginAgent(app);
  await agent.get('/api/auth/session').expect(200).expect(({ body }) => assert.equal(body.user.id, USER_ID));
});

test('registers and signs in immediately without an email confirmation flow', async () => {
  const app = buildApp();
  const response = await request(app).post('/api/auth/register').send({
    displayName: 'Jack', email: 'jack@example.com', password: 'password123'
  }).expect(201);
  assert.equal(response.body.user.email, 'jack@example.com');
  assert.equal('needsEmailConfirmation' in response.body, false);
  assert.match(response.headers['set-cookie'].join(';'), /pet_care_session=/);
});

test('requires login for pets, appointments, posts, and comments writes', async () => {
  const app = buildApp();
  await request(app).get('/api/pets').expect(401);
  await request(app).post('/api/appointments').send(validPayload).expect(401);
  await request(app).post('/api/posts').field('petId', PET_ID).field('phase', 'before').field('body', 'hello').expect(401);
  await request(app).post(`/api/posts/${POST_ID}/comments`).send({ body: 'hello' }).expect(401);
});

test('creates account-owned appointments and rejects pets owned by another user', async () => {
  let captured;
  const repository = fakeAppointmentRepository({ create: async (...args) => { captured = args; return { appointment: appointment(), reused: false }; } });
  const app = buildApp({ repository });
  const agent = await loginAgent(app);
  await agent.post('/api/appointments').send(validPayload).expect(201);
  assert.equal(captured[1], USER_ID);
  assert.equal(captured[2].id, PET_ID);

  const denied = buildApp({ identityRepository: fakeIdentityRepository({ getPet: async () => pet({ ownerId: OTHER_ID }) }) });
  const deniedAgent = await loginAgent(denied);
  await deniedAgent.post('/api/appointments').send(validPayload).expect(403);
});

test('allows public feed reads and authenticated text post and comment creation', async () => {
  const app = buildApp();
  await request(app).get('/api/posts').expect(200).expect(({ body }) => {
    assert.equal(body.posts[0].body, '准备洗护');
    assert.equal(body.posts[0].canEdit, false);
  });
  const agent = await loginAgent(app);
  await agent.post('/api/posts').field('petId', PET_ID).field('phase', 'after').field('body', '洗护完成').expect(201).expect(({ body }) => {
    assert.equal(body.post.phase, 'after');
    assert.equal(body.post.canEdit, true);
  });
  await agent.post(`/api/posts/${POST_ID}/comments`).send({ body: '真可爱' }).expect(201);
});

test('enforces author and employee moderation boundaries', async () => {
  const otherPostApp = buildApp({ communityRepository: fakeCommunityRepository({ getPost: async () => post({ authorId: OTHER_ID }) }) });
  const customer = await loginAgent(otherPostApp);
  await customer.delete(`/api/posts/${POST_ID}`).expect(403);
  await customer.post(`/api/posts/${POST_ID}/moderation`).send({ status: 'hidden', reason: '违规' }).expect(403);

  const staff = await loginAgent(buildApp({ authService: fakeAuthService({ role: 'staff' }) }));
  await staff.post(`/api/posts/${POST_ID}/moderation`).send({ status: 'hidden', reason: '违规内容' }).expect(200);

  const admin = await loginAgent(buildApp({ authService: fakeAuthService({ role: 'admin' }) }));
  await admin.post(`/api/posts/${POST_ID}/moderation`).send({ status: 'hidden', reason: '管理员审核' }).expect(200);
});

test('protects admin APIs from anonymous, customer, and staff accounts', async () => {
  await request(buildApp()).get('/api/admin/users').expect(401);

  const customer = await loginAgent(buildApp());
  await customer.get('/api/admin/users').expect(403);

  const staff = await loginAgent(buildApp({ authService: fakeAuthService({ role: 'staff' }) }));
  await staff.get('/api/admin/users').expect(403);
  await staff.get('/api/admin/appointments').expect(403);
  await staff.get('/api/admin/pets').expect(403);
});

test('allows admins to search users and change roles but not demote themselves', async () => {
  let search;
  let changed;
  const identityRepository = fakeIdentityRepository({
    listUsers: async (query) => {
      search = query;
      return [{ ...actor({ id: OTHER_ID, role: 'staff' }), email: 'staff@example.com' }];
    },
    updateUserRole: async (actorId, id, role) => {
      changed = { actorId, id, role };
      return { ...actor({ id, role }), email: 'staff@example.com' };
    }
  });
  const admin = await loginAgent(buildApp({ authService: fakeAuthService({ role: 'admin' }), identityRepository }));

  await admin.get('/api/admin/users?query=staff').expect(200).expect(({ body }) => {
    assert.equal(body.users[0].role, 'staff');
  });
  assert.equal(search, 'staff');

  await admin.patch(`/api/admin/users/${OTHER_ID}/role`).send({ role: 'admin' }).expect(200);
  assert.deepEqual(changed, { actorId: USER_ID, id: OTHER_ID, role: 'admin' });
  await admin.patch(`/api/admin/users/${USER_ID}/role`).send({ role: 'staff' }).expect(409);
  await admin.patch(`/api/admin/users/${OTHER_ID}/role`).send({ role: 'owner' }).expect(400);
});

test('allows admins to create, edit, and delete pets for any valid owner', async () => {
  const calls = [];
  const identityRepository = fakeIdentityRepository({
    getProfile: async (id) => id === OTHER_ID ? actor({ id: OTHER_ID }) : null,
    createPet: async (ownerId, input, requestId) => { calls.push(['create', ownerId, input, requestId]); return pet({ ownerId }); },
    updatePetAsAdmin: async (id, input) => { calls.push(['update', id, input]); return pet(input); },
    deletePetAsAdmin: async (id) => { calls.push(['delete', id]); return true; }
  });
  const admin = await loginAgent(buildApp({ authService: fakeAuthService({ role: 'admin' }), identityRepository }));
  const payload = { ownerId: OTHER_ID, requestId: PET_REQUEST_ID, name: '奶糖', species: 'cat', breed: '英短', sex: 'female', birthDate: null, weightKg: 4.2 };

  await admin.post('/api/admin/pets').send(payload).expect(201);
  await admin.patch(`/api/admin/pets/${PET_ID}`).send({ ...payload, ownerId: undefined }).expect(200);
  await admin.delete(`/api/admin/pets/${PET_ID}`).expect(204);
  assert.equal(calls[0][1], OTHER_ID);
  assert.equal(calls[0][3], PET_REQUEST_ID);
  assert.equal(calls[1][1], PET_ID);
  assert.deepEqual(calls[2], ['delete', PET_ID]);

  await admin.post('/api/admin/pets').send({ ...payload, ownerId: '13cc7c18-91f4-4da4-8917-06481628f218' }).expect(404);
});

test('allows admins to list, update, and cancel all future appointments with owner matching', async () => {
  let updated;
  let cancelled;
  const repository = fakeAppointmentRepository({
    updateAsAdmin: async (id, input, selectedPet) => { updated = { id, input, selectedPet }; return appointment(); },
    cancelAsAdmin: async (id) => { cancelled = id; return appointment({ status: 'cancelled' }); }
  });
  const admin = await loginAgent(buildApp({ authService: fakeAuthService({ role: 'admin' }), repository }));
  const payload = { ...validPayload };
  delete payload.requestId;

  await admin.get('/api/admin/appointments').expect(200).expect(({ body }) => assert.equal(body.appointments.length, 1));
  await admin.patch(`/api/admin/appointments/${appointment().id}`).send(payload).expect(200);
  assert.equal(updated.id, appointment().id);
  assert.equal(updated.selectedPet.ownerId, USER_ID);
  await admin.post(`/api/admin/appointments/${appointment().id}/cancel`).send({}).expect(200);
  assert.equal(cancelled, appointment().id);

  const wrongPetRepository = fakeIdentityRepository({ getPet: async () => pet({ ownerId: OTHER_ID }) });
  const denied = await loginAgent(buildApp({ authService: fakeAuthService({ role: 'admin' }), identityRepository: wrongPetRepository }));
  await denied.patch(`/api/admin/appointments/${appointment().id}`).send(payload).expect(403);

  const unavailable = await loginAgent(buildApp({
    authService: fakeAuthService({ role: 'admin' }),
    repository: fakeAppointmentRepository({ updateAsAdmin: async () => null, cancelAsAdmin: async () => null })
  }));
  await unavailable.patch(`/api/admin/appointments/${appointment().id}`).send(payload).expect(404);
  await unavailable.post(`/api/admin/appointments/${appointment().id}/cancel`).send({}).expect(404);
});

test('validates post content, comments, cursor, and image count limits', async () => {
  const app = buildApp();
  const agent = await loginAgent(app);
  await agent.post('/api/posts').field('petId', PET_ID).field('phase', 'before').field('body', '').expect(400);
  await agent.post(`/api/posts/${POST_ID}/comments`).send({ body: '' }).expect(400);
  await request(app).get('/api/posts?cursor=bad').expect(400);
  // Multer rejects before storage is invoked; one-byte buffers are sufficient for this route-level limit test.
  let uploadRequest = agent.post('/api/posts').field('petId', PET_ID).field('phase', 'before').field('body', '很多图片');
  for (let index = 0; index < 7; index += 1) uploadRequest = uploadRequest.attach('images', Buffer.from([index]), `image-${index}.jpg`);
  await uploadRequest.expect(400);
});

test('maps slot conflicts, foreign-key use, and inaccessible records to stable statuses', async () => {
  const conflict = Object.assign(new Error('duplicate'), { code: '23505', constraint: 'grooming_appointments_active_slot_uidx' });
  const app = buildApp({ repository: fakeAppointmentRepository({ create: async () => { throw conflict; } }) });
  const agent = await loginAgent(app);
  await agent.post('/api/appointments').send(validPayload).expect(409);

  const used = Object.assign(new Error('used'), { code: '23503' });
  const petApp = buildApp({ identityRepository: fakeIdentityRepository({ deletePet: async () => { throw used; } }) });
  const petAgent = await loginAgent(petApp);
  await petAgent.delete(`/api/pets/${PET_ID}`).expect(409);
});
