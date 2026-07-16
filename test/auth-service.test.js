import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthService } from '../src/auth-service.js';

const USER_ID = '6b48f45a-7c9a-4996-a92b-bcbe32ec1964';

function fakePool() {
  const users = new Map();
  const sessions = new Map();
  const client = {
    async query(sql, params = []) {
      if (['begin', 'commit', 'rollback'].includes(sql)) return { rows: [] };
      if (sql.includes('insert into public.profiles')) {
        const [email, passwordHash, displayName] = params;
        if (users.has(email)) throw Object.assign(new Error('duplicate'), { code: '23505' });
        const row = {
          id: USER_ID,
          email,
          password_hash: passwordHash,
          display_name: displayName,
          role: 'customer',
          created_at: '2026-07-16T00:00:00.000Z',
          updated_at: '2026-07-16T00:00:00.000Z'
        };
        users.set(email, row);
        return { rows: [row] };
      }
      if (sql.includes('insert into public.user_sessions')) {
        const [userId, tokenHash, expiresAt] = params;
        sessions.set(tokenHash, { userId, expiresAt });
        return { rows: [] };
      }
      if (sql.includes('from public.profiles where email')) {
        const row = users.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('from public.user_sessions s')) {
        const session = sessions.get(params[0]);
        if (!session || new Date(session.expiresAt) <= new Date()) return { rows: [] };
        const row = [...users.values()].find((user) => user.id === session.userId);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('delete from public.user_sessions')) {
        sessions.delete(params[0]);
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() {}
  };
  return {
    connect: async () => client,
    query: (...args) => client.query(...args),
    state: { users, sessions }
  };
}

test('registers a local account with a salted scrypt hash and opaque session', async () => {
  const pool = fakePool();
  const auth = createAuthService(pool);
  const result = await auth.register({ email: 'Jack@Example.com', password: 'password123', displayName: 'Jack' });

  assert.equal(result.user.email, 'jack@example.com');
  assert.match(result.session.token, /^[a-f0-9]{64}$/);
  const stored = pool.state.users.get('jack@example.com');
  assert.notEqual(stored.password_hash, 'password123');
  assert.match(stored.password_hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(pool.state.sessions.size, 1);

  assert.equal((await auth.resolve(result.session.token)).id, USER_ID);
  await auth.logout(result.session.token);
  assert.equal(await auth.resolve(result.session.token), null);
});

test('logs in with the correct password and rejects invalid or duplicate credentials', async () => {
  const pool = fakePool();
  const auth = createAuthService(pool);
  await auth.register({ email: 'jack@example.com', password: 'password123', displayName: 'Jack' });

  const login = await auth.login({ email: 'JACK@example.com', password: 'password123' });
  assert.equal(login.user.id, USER_ID);
  await assert.rejects(auth.login({ email: 'jack@example.com', password: 'wrongpass' }), /邮箱或密码不正确/);
  await assert.rejects(
    auth.register({ email: 'jack@example.com', password: 'another123', displayName: 'Other' }),
    /该邮箱已经注册/
  );
});
