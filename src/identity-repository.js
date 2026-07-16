import { requirePool } from './db.js';

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

    async listPets(actor, query = '') {
      const db = requirePool(pool);
      const values = [];
      const conditions = [];
      if (actor.role !== 'staff') {
        values.push(actor.id);
        conditions.push(`p.owner_id = $${values.length}`);
      }
      if (query) {
        values.push(`%${query}%`);
        conditions.push(`(p.name ilike $${values.length} or p.breed ilike $${values.length})`);
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

    async createPet(ownerId, input) {
      const db = requirePool(pool);
      const result = await db.query(
        `insert into public.pets (owner_id, name, species, breed, sex, birth_date, weight_kg)
         values ($1,$2,$3,$4,$5,$6,$7)
         returning id, owner_id, name, species, breed, sex, birth_date, weight_kg, created_at, updated_at`,
        [ownerId, input.name, input.species, input.breed, input.sex, input.birthDate, input.weightKg]
      );
      return mapPet(result.rows[0]);
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

    async deletePet(id, ownerId) {
      const db = requirePool(pool);
      const result = await db.query('delete from public.pets where id=$1 and owner_id=$2 returning id', [id, ownerId]);
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
