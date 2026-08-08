import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';

const allowedFormats = new Set(['jpeg', 'png', 'webp']);

export function createStorageClient({
  url = process.env.SUPABASE_URL,
  secretKey = process.env.SUPABASE_SECRET_KEY,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
} = {}) {
  const serverKey = secretKey || serviceRoleKey;
  if (!url || !serverKey) return null;
  return createClient(url, serverKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

export function createImageStorage({ supabase, bucket = process.env.SUPABASE_STORAGE_BUCKET || 'care-dynamics' } = {}) {
  if (!supabase) return null;
  const storage = supabase.storage.from(bucket);

  return {
    async upload(file, { userId, postId }) {
      if (!file?.buffer?.length) throw inputError('图片内容为空');
      if (file.size > 8 * 1024 * 1024) throw inputError('单张图片不能超过 8 MB');

      let sourceMetadata;
      try {
        sourceMetadata = await sharp(file.buffer).metadata();
      } catch {
        throw inputError('无法识别图片内容');
      }
      if (!allowedFormats.has(sourceMetadata.format)) throw inputError('仅支持 JPEG、PNG 和 WebP 图片');

      const { data, info } = await sharp(file.buffer, { failOn: 'error' })
        .rotate()
        .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 84 })
        .toBuffer({ resolveWithObject: true });
      const objectPath = `${userId}/${postId}/${crypto.randomUUID()}.webp`;
      const { error } = await storage.upload(objectPath, data, {
        contentType: 'image/webp',
        cacheControl: '31536000',
        upsert: false
      });
      if (error) throw storageError(error.message);
      return {
        objectPath,
        url: storage.getPublicUrl(objectPath).data.publicUrl,
        mimeType: 'image/webp',
        byteSize: data.length,
        width: info.width,
        height: info.height
      };
    },

    async remove(objectPath) {
      const { error } = await storage.remove([objectPath]);
      if (error) throw storageError(error.message);
    },

    publicUrl(objectPath) {
      return storage.getPublicUrl(objectPath).data.publicUrl;
    }
  };
}

function inputError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function storageError(message) {
  const error = new Error(`图片存储失败：${message}`);
  error.status = 503;
  return error;
}
