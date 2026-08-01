import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdentityRepository } from '../src/identity-repository.js';

const ADMIN_ID = '6b48f45a-7c9a-4996-a92b-bcbe32ec1964';
const TARGET_ID = 'c2d1268a-b574-4aa0-8e77-b3f5687c21d2';
const PET_REQUEST_ID = '9d8d0d8f-7a67-4471-93b3-2d269984dc4d';

function rolePool({ actorRole = 'admin', targetRole = 'staff', adminCount = 2 } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (['begin', 'commit', 'rollback', 'lock table public.profiles in share row exclusive mode'].includes(sql)) return { rows: [] };
      if (sql === 'select role from public.profiles where id = $1') {
        return { rows: [{ role: params[0] === ADMIN_ID ? actorRole : targetRole }] };
      }
      if (sql.includes("count(*)::int")) return { rows: [{ count: adminCount }] };
      if (sql.includes('update public.profiles set role')) {
        return { rows: [{
          id: params[0], email: 'target@example.com', display_name: 'Target', role: params[1],
          created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z'
        }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() { calls.push({ sql: 'release', params: [] }); }
  };
  return { connect: async () => client, query: (...args) => client.query(...args), calls };
}

test('serializes role changes and verifies the acting admin inside the transaction', async () => {
  const pool = rolePool();
  const repository = createIdentityRepository(pool);
  const user = await repository.updateUserRole(ADMIN_ID, TARGET_ID, 'admin');

  assert.equal(user.role, 'admin');
  assert.ok(pool.calls.some(({ sql }) => sql.startsWith('lock table public.profiles')));
  assert.ok(pool.calls.some(({ sql }) => sql === 'commit'));
});

test('rejects a stale administrator session before changing another role', async () => {
  const pool = rolePool({ actorRole: 'staff' });
  const repository = createIdentityRepository(pool);

  await assert.rejects(repository.updateUserRole(ADMIN_ID, TARGET_ID, 'customer'), (error) => error.status === 403);
  assert.ok(pool.calls.some(({ sql }) => sql === 'rollback'));
  assert.equal(pool.calls.some(({ sql }) => sql.includes('update public.profiles set role')), false);
});

test('prevents the final administrator from being demoted in the repository', async () => {
  const pool = rolePool({ targetRole: 'admin', adminCount: 1 });
  const repository = createIdentityRepository(pool);

  await assert.rejects(repository.updateUserRole(ADMIN_ID, TARGET_ID, 'staff'), (error) => error.status === 409);
  assert.ok(pool.calls.some(({ sql }) => sql === 'rollback'));
});

test('returns the existing pet when a creation request id is retried', async () => {
  const pets = new Map();
  let insertAttempts = 0;
  const pool = {
    async query(sql, params) {
      if (sql.includes('insert into public.pets')) {
        insertAttempts += 1;
        if (pets.has(params[7])) return { rows: [] };
        const row = {
          id: '2e6fd5ae-86cb-4f8d-8fd1-03a5a6b2534e', owner_id: params[0], name: params[1],
          species: params[2], breed: params[3], sex: params[4], birth_date: params[5], weight_kg: params[6],
          created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z'
        };
        pets.set(params[7], row);
        return { rows: [row] };
      }
      if (sql.includes('from public.pets where client_request_id')) {
        const row = pets.get(params[0]);
        return { rows: row?.owner_id === params[1] ? [row] : [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
  const repository = createIdentityRepository(pool);
  const input = { name: '奶糖', species: 'cat', breed: '英短', sex: 'female', birthDate: null, weightKg: 4.2 };

  const first = await repository.createPet(ADMIN_ID, input, PET_REQUEST_ID);
  const retry = await repository.createPet(ADMIN_ID, input, PET_REQUEST_ID);

  assert.equal(first.id, retry.id);
  assert.equal(pets.size, 1);
  assert.equal(insertAttempts, 2);
});
