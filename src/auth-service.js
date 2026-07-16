import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { requirePool } from './db.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export const SESSION_COOKIE = 'pet_care_session';

export function createAuthService(pool) {
  return {
    async register({ email, password, displayName }) {
      const db = requirePool(pool);
      const client = await db.connect();
      const normalizedEmail = email.trim().toLowerCase();
      const passwordHash = await hashPassword(password);
      try {
        await client.query('begin');
        const inserted = await client.query(
          `insert into public.profiles (email, password_hash, display_name)
           values ($1,$2,$3)
           returning id, email, display_name, role, created_at, updated_at`,
          [normalizedEmail, passwordHash, displayName]
        );
        const session = await insertSession(client, inserted.rows[0].id);
        await client.query('commit');
        return { user: mapUser(inserted.rows[0]), session };
      } catch (error) {
        await client.query('rollback');
        if (error?.code === '23505') throw conflict('该邮箱已经注册');
        throw error;
      } finally {
        client.release();
      }
    },

    async login({ email, password }) {
      const db = requirePool(pool);
      const result = await db.query(
        `select id, email, password_hash, display_name, role, created_at, updated_at
         from public.profiles where email = $1`,
        [email.trim().toLowerCase()]
      );
      const row = result.rows[0];
      if (!row?.password_hash || !(await verifyPassword(password, row.password_hash))) {
        throw unauthorized('邮箱或密码不正确');
      }
      return { user: mapUser(row), session: await insertSession(db, row.id) };
    },

    async resolve(token) {
      if (!/^[a-f0-9]{64}$/.test(token || '')) return null;
      const db = requirePool(pool);
      const result = await db.query(
        `select p.id, p.email, p.display_name, p.role, p.created_at, p.updated_at
         from public.user_sessions s
         join public.profiles p on p.id = s.user_id
         where s.token_hash = $1 and s.expires_at > now()`,
        [tokenHash(token)]
      );
      return result.rows[0] ? mapUser(result.rows[0]) : null;
    },

    async logout(token) {
      if (!/^[a-f0-9]{64}$/.test(token || '')) return;
      const db = requirePool(pool);
      await db.query('delete from public.user_sessions where token_hash = $1', [tokenHash(token)]);
    }
  };
}

export function setSessionCookie(response, session) {
  response.cookie(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: Math.max(60_000, new Date(session.expiresAt).getTime() - Date.now()),
    path: '/'
  });
}

export function clearSessionCookie(response) {
  response.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: '/'
  });
}

async function insertSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.query(
    `insert into public.user_sessions (user_id, token_hash, expires_at) values ($1,$2,$3)`,
    [userId, tokenHash(token), expiresAt.toISOString()]
  );
  return { token, expiresAt: expiresAt.toISOString() };
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 32 * 1024 * 1024
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

async function verifyPassword(password, encoded) {
  try {
    const [algorithm, n, r, p, salt, expected] = encoded.split('$');
    if (algorithm !== 'scrypt' || !salt || !expected) return false;
    const expectedBuffer = Buffer.from(expected, 'base64url');
    const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expectedBuffer.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 32 * 1024 * 1024
    });
    return expectedBuffer.length === actual.length && crypto.timingSafeEqual(expectedBuffer, actual);
  } catch {
    return false;
  }
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function mapUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function conflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}

function unauthorized(message) {
  return Object.assign(new Error(message), { status: 401 });
}
