import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createImageStorage } from '../src/image-storage.js';

function fakeSupabase(captured) {
  return {
    storage: {
      from(bucket) {
        captured.bucket = bucket;
        return {
          async upload(path, data, options) {
            captured.path = path;
            captured.data = data;
            captured.options = options;
            return { error: null };
          },
          async remove(paths) {
            captured.removed = paths;
            return { error: null };
          },
          getPublicUrl(path) {
            return { data: { publicUrl: `https://images.example/${path}` } };
          }
        };
      }
    }
  };
}

test('validates, rotates, resizes, and converts uploaded photos to WebP', async () => {
  const captured = {};
  const storage = createImageStorage({ supabase: fakeSupabase(captured), bucket: 'care-dynamics' });
  const source = await sharp({ create: { width: 3000, height: 1200, channels: 3, background: '#4b8064' } }).png().toBuffer();
  const result = await storage.upload(
    { buffer: source, size: source.length, mimetype: 'image/png' },
    { userId: '6b48f45a-7c9a-4996-a92b-bcbe32ec1964', postId: 'e19e1223-34c1-4ae4-a2ec-a82d3bf8fa64' }
  );
  assert.equal(captured.bucket, 'care-dynamics');
  assert.equal(captured.options.contentType, 'image/webp');
  assert.equal(result.width, 2048);
  assert.equal(result.height, 819);
  assert.match(result.objectPath, /\.webp$/);
  assert.equal((await sharp(captured.data).metadata()).format, 'webp');
});

test('rejects invalid image bytes and removes one explicit object path', async () => {
  const captured = {};
  const storage = createImageStorage({ supabase: fakeSupabase(captured) });
  await assert.rejects(
    storage.upload({ buffer: Buffer.from('not-an-image'), size: 12 }, { userId: 'u', postId: 'p' }),
    /无法识别图片内容/
  );
  await storage.remove('u/p/image.webp');
  assert.deepEqual(captured.removed, ['u/p/image.webp']);
});
