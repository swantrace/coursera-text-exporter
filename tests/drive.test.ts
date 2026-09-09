import { expect, it } from 'vitest';
import { hash, multipart } from '../src/sync/drive';

it('uses multipart/related with correct boundaries and UTF-8 content', async () => {
  const part = multipart(
    { name: 'course.md' },
    new Blob(['Hello world 🌍'], { type: 'text/markdown' }),
  );
  expect(part.contentType).toMatch(/^multipart\/related; boundary=/);
  const text = await part.body.text();
  expect(text).toContain(
    'Content-Type: application/json; charset=UTF-8\r\n\r\n{"name":"course.md"}',
  );
  expect(text).toContain('Hello world 🌍');
  expect(text.endsWith('--\r\n')).toBe(true);
});
it('hashes content deterministically', async () => {
  expect(await hash(new Blob(['abc']))).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});
