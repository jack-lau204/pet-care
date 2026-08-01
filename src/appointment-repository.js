import { requirePool } from './db.js';

const publicColumns = `
  id, reference_code, owner_id, pet_id, pet_code, pet_name, pet_species, service_code,
  scheduled_start, customer_name, customer_phone, notes, status,
  cancelled_at, created_at, updated_at
`;

const adminColumns = `
  a.id, a.reference_code, a.owner_id, a.pet_id, a.pet_code, a.pet_name, a.pet_species,
  a.service_code, a.scheduled_start, a.customer_name, a.customer_phone, a.notes, a.status,
  a.cancelled_at, a.created_at, a.updated_at, p.display_name as owner_name, p.email as owner_email
`;

export function createAppointmentRepository(pool) {
  return {
    async health() {
      const db = requirePool(pool);
      const result = await db.query('select now() as now');
      return result.rows[0];
    },

    async bookedStarts(dayStart, dayEnd) {
      const db = requirePool(pool);
      const result = await db.query(
        `select scheduled_start from public.grooming_appointments
         where status = 'confirmed' and scheduled_start >= $1 and scheduled_start < $2`,
        [dayStart, dayEnd]
      );
      return result.rows.map((row) => new Date(row.scheduled_start).toISOString());
    },

    async create(input, ownerId, pet) {
      const db = requirePool(pool);
      const client = await db.connect();
      try {
        await client.query('begin');
        const inserted = await client.query(
          `insert into public.grooming_appointments (
             client_request_id, owner_id, pet_id, pet_code, pet_name, pet_species,
             service_code, scheduled_start, customer_name, customer_phone, notes
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           on conflict (client_request_id) do nothing
           returning ${publicColumns}`,
          [
            input.requestId, ownerId, pet.id, pet.id, pet.name, pet.species,
            input.serviceCode, input.scheduledStart, input.customerName,
            input.customerPhone, input.notes
          ]
        );

        if (inserted.rows[0]) {
          await client.query('commit');
          return { appointment: mapRow(inserted.rows[0]), reused: false };
        }

        const existing = await client.query(
          `select ${publicColumns} from public.grooming_appointments
           where client_request_id = $1 and owner_id = $2`,
          [input.requestId, ownerId]
        );
        await client.query('commit');
        if (!existing.rows[0]) return null;
        return { appointment: mapRow(existing.rows[0]), reused: true };
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async list(ownerId) {
      const db = requirePool(pool);
      const result = await db.query(
        `select ${publicColumns} from public.grooming_appointments
         where owner_id = $1
         order by
           case when status = 'confirmed' and scheduled_start >= now() then 0
                when status = 'confirmed' then 1 else 2 end,
           scheduled_start asc`,
        [ownerId]
      );
      return result.rows.map(mapRow);
    },

    async listAll() {
      const db = requirePool(pool);
      const result = await db.query(
        `select ${adminColumns}
         from public.grooming_appointments a
         left join public.profiles p on p.id = a.owner_id
         order by
           case when a.status = 'confirmed' and a.scheduled_start >= now() then 0
                when a.status = 'confirmed' then 1 else 2 end,
           a.scheduled_start asc`
      );
      return result.rows.map(mapRow);
    },

    async getById(id) {
      const db = requirePool(pool);
      const result = await db.query(
        `select ${adminColumns}
         from public.grooming_appointments a
         left join public.profiles p on p.id = a.owner_id
         where a.id = $1`,
        [id]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async update(id, input, ownerId, pet) {
      const db = requirePool(pool);
      const result = await db.query(
        `update public.grooming_appointments set
           pet_id = $3, pet_code = $3, pet_name = $4, pet_species = $5, service_code = $6,
           scheduled_start = $7, customer_name = $8, customer_phone = $9, notes = $10
         where id = $1 and owner_id = $2 and status = 'confirmed'
           and scheduled_start > now()
         returning ${publicColumns}`,
        [
          id, ownerId, pet.id, pet.name, pet.species,
          input.serviceCode, input.scheduledStart, input.customerName,
          input.customerPhone, input.notes
        ]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async updateAsAdmin(id, input, pet) {
      const db = requirePool(pool);
      const result = await db.query(
        `update public.grooming_appointments set
           pet_id = $2, pet_code = $2, pet_name = $3, pet_species = $4, service_code = $5,
           scheduled_start = $6, customer_name = $7, customer_phone = $8, notes = $9
         where id = $1 and status = 'confirmed' and scheduled_start > now()
         returning ${publicColumns}`,
        [
          id, pet.id, pet.name, pet.species, input.serviceCode, input.scheduledStart,
          input.customerName, input.customerPhone, input.notes
        ]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async cancel(id, ownerId) {
      const db = requirePool(pool);
      const result = await db.query(
        `update public.grooming_appointments
         set status = 'cancelled', cancelled_at = now()
         where id = $1 and owner_id = $2 and status = 'confirmed'
           and scheduled_start > now()
         returning ${publicColumns}`,
        [id, ownerId]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    },

    async cancelAsAdmin(id) {
      const db = requirePool(pool);
      const result = await db.query(
        `update public.grooming_appointments
         set status = 'cancelled', cancelled_at = now()
         where id = $1 and status = 'confirmed' and scheduled_start > now()
         returning ${publicColumns}`,
        [id]
      );
      return result.rows[0] ? mapRow(result.rows[0]) : null;
    }
  };
}

function mapRow(row) {
  return {
    id: row.id,
    referenceCode: row.reference_code,
    ownerId: row.owner_id,
    ownerName: row.owner_name || '',
    ownerEmail: row.owner_email || '',
    petId: row.pet_id,
    petCode: row.pet_code,
    petName: row.pet_name,
    petSpecies: row.pet_species,
    serviceCode: row.service_code,
    scheduledStart: new Date(row.scheduled_start).toISOString(),
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    notes: row.notes || '',
    status: row.status,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}
