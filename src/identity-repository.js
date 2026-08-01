import { requirePool } from './db.js';
import { hasStaffAccess } from './roles.js';

export function createIdentityRepository(pool) {
  return {
    async getProfile(id) {
      const db = requirePool(pool);
      const result = await db.query(
        `select id, email, display_name, role, created_at, updated_at
         from public.profiles where id = $1`,
        [id]
      );
      return result.rows[0] ? mapProfile(result.rows[0]) : null;
    },

    async listUsers(query = '') {
      const db = requirePool(pool);
      const values = [];
      const conditions = [];
      if (query) {
        values.push(`%${query}%`);
        conditions.push(`(email ilike $1 or display_name ilike $1)`);
      }
      const result = await db.query(
        `select id, email, display_name, role, created_at, updated_at
         from public.profiles
         ${conditions.length ? `where ${conditions.join(' and ')}` : ''}
         order by created_at desc, id desc limit 100`,
        values
      );
      return result.rows.map(mapProfile);
    },

    async updateUserRole(actorId, id, role) {
      const db = requirePool(pool);
      const client = await db.connect();
      try {
        await client.query('begin');
        await client.query('lock table public.profiles in share row exclusive mode');
        const actorResult = await client.query('select role from public.profiles where id = $1', [actorId]);
        if (actorResult.rows[0]?.role !== 'admin') throw roleError('仅管理员可以调整用户角色', 403);
        const targetResult = await client.query('select role from public.profiles where id = $1', [id]);
        if (!targetResult.rows[0]) {
          await client.query('commit');
          return null;
        }
        if (actorId === id && role !== 'admin') throw roleError('不能降低当前登录管理员的权限', 409);
        if (targetResult.rows[0].role === 'admin' && role !== 'admin') {
          const countResult = await client.query("select count(*)::int as count from public.profiles where role = 'admin'");
          if (countResult.rows[0].count <= 1) throw roleError('系统必须至少保留一名管理员', 409);
        }
        const result = await client.query(
          `update public.profiles set role = $2 where id = $1
           returning id, email, display_name, role, created_at, updated_at`,
          [id, role]
        );
        await client.query('commit');
        return mapProfile(result.rows[0]);
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async listPets(actor, query = '') {
      const db = requirePool(pool);
      const values = [];
      const conditions = [];
      if (!hasStaffAccess(actor.role)) {
        values.push(actor.id);
        conditions.push(`p.owner_id = $${values.length}`);
      }
      if (query) {
        values.push(`%${query}%`);
        conditions.push(`(p.name ilike $${values.length} or p.breed ilike $${values.length}
          or pr.display_name ilike $${values.length} or pr.email ilike $${values.length})`);
      }
      const result = await db.query(
        `select p.id, p.owner_id, p.name, p.species, p.breed, p.sex, p.birth_date,
                p.weight_kg, p.created_at, p.updated_at, pr.display_name as owner_name
         from public.pets p join public.profiles pr on pr.id = p.owner_id
         ${conditions.length ? `where ${conditions.join(' and ')}` : ''}
         order by p.name asc, p.created_at asc limit 100`,
        values
      );
      return result.rows.map(mapPet);
    },

    async getPet(id) {
      const db = requirePool(pool);
      const result = await db.query(
        `select p.id, p.owner_id, p.name, p.species, p.breed, p.sex, p.birth_date,
                p.weight_kg, p.created_at, p.updated_at, pr.display_name as owner_name
         from public.pets p join public.profiles pr on pr.id = p.owner_id where p.id = $1`,
        [id]
      );
      return result.rows[0] ? mapPet(result.rows[0]) : null;
    },

    async createPet(ownerId, input, requestId) {
      const db = requirePool(pool);
      const result = await db.query(
        `insert into public.pets (owner_id, name, species, breed, sex, birth_date, weight_kg, client_request_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (client_request_id) where client_request_id is not null do nothing
         returning id, owner_id, name, species, breed, sex, birth_date, weight_kg, created_at, updated_at`,
        [ownerId, input.name, input.species, input.breed, input.sex, input.birthDate, input.weightKg, requestId]
      );
      if (result.rows[0]) return mapPet(result.rows[0]);
      const existing = await db.query(
        `select id, owner_id, name, species, breed, sex, birth_date, weight_kg, created_at, updated_at
         from public.pets where client_request_id = $1 and owner_id = $2`,
        [requestId, ownerId]
      );
      return existing.rows[0] ? mapPet(existing.rows[0]) : null;
    },

    async updatePet(id, ownerId, input) {
      const db = requirePool(pool);
      const result = await db.query(
        `update public.pets set name=$3, species=$4, breed=$5, sex=$6, birth_date=$7, weight_kg=$8
         where id=$1 and owner_id=$2
         returning id, owner_id, name, species, breed, sex, birth_date, weight_kg, created_at, updated_at`,
        [id, ownerId, input.name, input.species, input.breed, input.sex, input.birthDate, input.weightKg]
      );
      return result.rows[0] ? mapPet(result.rows[0]) : null;
    },

    async updatePetAsAdmin(id, input) {
      const db = requirePool(pool);
      const result = await db.query(
        `update public.pets set name=$2, species=$3, breed=$4, sex=$5, birth_date=$6, weight_kg=$7
         where id=$1
         returning id, owner_id, name, species, breed, sex, birth_date, weight_kg, created_at, updated_at`,
        [id, input.name, input.species, input.breed, input.sex, input.birthDate, input.weightKg]
      );
      if (!result.rows[0]) return null;
      const ownerResult = await db.query('select display_name from public.profiles where id = $1', [result.rows[0].owner_id]);
      return mapPet({ ...result.rows[0], owner_name: ownerResult.rows[0]?.display_name || '' });
    },

    async deletePet(id, ownerId) {
      const db = requirePool(pool);
      const result = await db.query('delete from public.pets where id=$1 and owner_id=$2 returning id', [id, ownerId]);
      return Boolean(result.rows[0]);
    },

    async deletePetAsAdmin(id) {
      const db = requirePool(pool);
      const result = await db.query('delete from public.pets where id=$1 returning id', [id]);
      return Boolean(result.rows[0]);
    }
  };
}

function mapProfile(row) {
  return {
    id: row.id,
    email: row.email || '',
    displayName: row.display_name,
    role: row.role,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function mapPet(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerName: row.owner_name || '',
    name: row.name,
    species: row.species,
    breed: row.breed || '',
    sex: row.sex,
    birthDate: row.birth_date ? String(row.birth_date).slice(0, 10) : null,
    weightKg: row.weight_kg === null || row.weight_kg === undefined ? null : Number(row.weight_kg),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function roleError(message, status) {
  return Object.assign(new Error(message), { status });
}
