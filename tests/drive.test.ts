import { expect, it } from 'vitest';
import { multipart, hash } from '../src/sync/drive';
it('uses multipart/related with correct boundaries and UTF-8 content', async()=>{
 const part=multipart({name:'课程.md'},new Blob(['你好 🌍'],{type:'text/markdown'}));
 expect(part.contentType).toMatch(/^multipart\/related; boundary=/);
 const text=await part.body.text(); expect(text).toContain('Content-Type: application/json; charset=UTF-8\r\n\r\n{"name":"课程.md"}'); expect(text).toContain('你好 🌍');
 expect(text.endsWith('--\r\n')).toBe(true);
});
it('hashes content deterministically',async()=>{ expect(await hash(new Blob(['abc']))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'); });
