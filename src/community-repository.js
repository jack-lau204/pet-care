import { requirePool } from './db.js';
import { hasStaffAccess } from './roles.js';

const postColumns = `
  p.id, p.author_id, p.pet_id, p.phase, p.body, p.status, p.moderation_reason,
  p.created_at, p.updated_at, author.display_name as author_name, author.role as author_role,
  pet.name as pet_name, pet.species as pet_species, pet.breed as pet_breed,
  (select count(*)::int from public.care_comments c
   where c.post_id = p.id and c.status = 'published') as comment_count
`;

export function createCommunityRepository(pool) {
  return {
    async listPosts({ actor = null, phase = null, petId = null, cursor = null, limit = 12 } = {}) {
      const db = requirePool(pool);
      const values = [];
      const conditions = [];
      if (!hasStaffAccess(actor?.role)) {
        if (actor) {
          values.push(actor.id);
          conditions.push(`(p.status = 'published' or p.author_id = $${values.length})`);
        } else {
          conditions.push(`p.status = 'published'`);
        }
      }
      if (phase) {
        values.push(phase);
        conditions.push(`p.phase = $${values.length}`);
      }
      if (petId) {
        values.push(petId);
        conditions.push(`p.pet_id = $${values.length}`);
      }
      if (cursor) {
        values.push(cursor.createdAt, cursor.id);
        conditions.push(`(p.created_at, p.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
      }
      values.push(limit + 1);
      const result = await db.query(
        `select ${postColumns}
         from public.care_posts p
         join public.profiles author on author.id = p.author_id
         join public.pets pet on pet.id = p.pet_id
         ${conditions.length ? `where ${conditions.join(' and ')}` : ''}
         order by p.created_at desc, p.id desc limit $${values.length}`,
        values
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const posts = rows.map(mapPost);
      await attachImages(db, posts);
      return { posts, hasMore };
    },

    async getPost(id) {
      const db = requirePool(pool);
      const result = await db.query(
        `select ${postColumns}
         from public.care_posts p
         join public.profiles author on author.id = p.author_id
         join public.pets pet on pet.id = p.pet_id where p.id = $1`,
        [id]
      );
      if (!result.rows[0]) return null;
      const post = mapPost(result.rows[0]);
      await attachImages(db, [post]);
      return post;
    },

    async createPost({ id, authorId, petId, phase, body, images }) {
      const db = requirePool(pool);
      const client = await db.connect();
      try {
        await client.query('begin');
        await client.query(
          `insert into public.care_posts (id, author_id, pet_id, phase, body) values ($1,$2,$3,$4,$5)`,
          [id, authorId, petId, phase, body]
        );
        await insertImages(client, id, images);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
      return this.getPost(id);
    },

    async updatePost({ id, petId, phase, body, images }) {
      const db = requirePool(pool);
      const client = await db.connect();
      try {
        await client.query('begin');
        const updated = await client.query(
          `update public.care_posts set pet_id=$2, phase=$3, body=$4 where id=$1 returning id`,
          [id, petId, phase, body]
        );
        if (!updated.rows[0]) {
          await client.query('rollback');
          return null;
        }
        await client.query('delete from public.care_post_images where post_id=$1', [id]);
        await insertImages(client, id, images);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
      return this.getPost(id);
    },

    async deletePost(id) {
      const db = requirePool(pool);
      const client = await db.connect();
      try {
        await client.query('begin');
        const images = await client.query(
          'select object_path from public.care_post_images where post_id=$1 order by sort_order',
          [id]
        );
        const result = await client.query('delete from public.care_posts where id=$1 returning id', [id]);
        await client.query('commit');
        return result.rows[0] ? images.rows.map((row) => row.object_path) : null;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async moderatePost(id, { status, reason, moderatorId }) {
      const db = requirePool(pool);
      const result = await db.query(
        `update public.care_posts set status=$2, moderation_reason=$3, moderated_by=$4
         where id=$1 returning id`,
        [id, status, status === 'hidden' ? reason : '', moderatorId]
      );
      return result.rows[0] ? this.getPost(id) : null;
    },

    async listComments({ postId, actor = null, cursor = null, limit = 30 }) {
      const db = requirePool(pool);
      const values = [postId];
      const conditions = ['c.post_id = $1'];
      if (!hasStaffAccess(actor?.role)) {
        if (actor) {
          values.push(actor.id);
          conditions.push(`(c.status='published' or c.author_id=$${values.length})`);
        } else conditions.push(`c.status='published'`);
      }
      if (cursor) {
        values.push(cursor.createdAt, cursor.id);
        conditions.push(`(c.created_at, c.id) > ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
      }
      values.push(limit + 1);
      const result = await db.query(
        `select c.id, c.post_id, c.author_id, c.body, c.status, c.moderation_reason,
                c.created_at, c.updated_at, pr.display_name as author_name, pr.role as author_role
         from public.care_comments c join public.profiles pr on pr.id=c.author_id
         where ${conditions.join(' and ')} order by c.created_at asc, c.id asc limit $${values.length}`,
        values
      );
      const hasMore = result.rows.length > limit;
      return { comments: result.rows.slice(0, limit).map(mapComment), hasMore };
    },

    async getComment(id) {
      const db = requirePool(pool);
      const result = await db.query(
        `select c.id, c.post_id, c.author_id, c.body, c.status, c.moderation_reason,
                c.created_at, c.updated_at, pr.display_name as author_name, pr.role as author_role
         from public.care_comments c join public.profiles pr on pr.id=c.author_id where c.id=$1`,
        [id]
      );
      return result.rows[0] ? mapComment(result.rows[0]) : null;
    },

    async createComment(postId, authorId, body, requestId) {
      const db = requirePool(pool);
      const result = await db.query(
        `with inserted as (
           insert into public.care_comments (post_id, author_id, body, client_request_id)
           values ($1,$2,$3,$4)
           on conflict (client_request_id) do nothing
           returning id
         )
         select id from inserted
         union all
         select id from public.care_comments
         where client_request_id=$4 and author_id=$2
         limit 1`,
        [postId, authorId, body, requestId]
      );
      if (!result.rows[0]) {
        const error = new Error('评论请求标识已被使用');
        error.status = 409;
        throw error;
      }
      return this.getComment(result.rows[0].id);
    },

    async updateComment(id, body) {
      const db = requirePool(pool);
      const result = await db.query('update public.care_comments set body=$2 where id=$1 returning id', [id, body]);
      return result.rows[0] ? this.getComment(id) : null;
    },

    async deleteComment(id) {
      const db = requirePool(pool);
      const result = await db.query('delete from public.care_comments where id=$1 returning id', [id]);
      return Boolean(result.rows[0]);
    },

    async moderateComment(id, { status, reason, moderatorId }) {
      const db = requirePool(pool);
      const result = await db.query(
        `update public.care_comments set status=$2, moderation_reason=$3, moderated_by=$4
         where id=$1 returning id`,
        [id, status, status === 'hidden' ? reason : '', moderatorId]
      );
      return result.rows[0] ? this.getComment(id) : null;
    }
  };
}

async function attachImages(db, posts) {
  if (!posts.length) return;
  const result = await db.query(
    `select id, post_id, object_path, sort_order, mime_type, byte_size, width, height
     from public.care_post_images where post_id = any($1::uuid[]) order by post_id, sort_order`,
    [posts.map((post) => post.id)]
  );
  const byPost = new Map(posts.map((post) => [post.id, post]));
  for (const row of result.rows) byPost.get(row.post_id)?.images.push(mapImage(row));
}

async function insertImages(client, postId, images) {
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    await client.query(
      `insert into public.care_post_images
       (id, post_id, object_path, sort_order, mime_type, byte_size, width, height)
       values (coalesce($1::uuid, gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8)`,
      [image.id || null, postId, image.objectPath, index, image.mimeType, image.byteSize, image.width, image.height]
    );
  }
}

function mapPost(row) {
  return {
    id: row.id,
    authorId: row.author_id,
    author: { displayName: row.author_name, role: row.author_role },
    petId: row.pet_id,
    pet: { name: row.pet_name, species: row.pet_species, breed: row.pet_breed || '' },
    phase: row.phase,
    body: row.body,
    status: row.status,
    moderationReason: row.moderation_reason || '',
    commentCount: Number(row.comment_count || 0),
    images: [],
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function mapImage(row) {
  return {
    id: row.id,
    objectPath: row.object_path,
    sortOrder: row.sort_order,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height
  };
}

function mapComment(row) {
  return {
    id: row.id,
    postId: row.post_id,
    authorId: row.author_id,
    author: { displayName: row.author_name, role: row.author_role },
    body: row.body,
    status: row.status,
    moderationReason: row.moderation_reason || '',
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}
