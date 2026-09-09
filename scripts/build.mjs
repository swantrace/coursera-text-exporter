import { build } from 'esbuild';
import { mkdir, readFile, writeFile, cp, access } from 'node:fs/promises';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
await mkdir('.local', { recursive: true });
let publicKey;
try { publicKey = (await readFile('.local/extension-public-key.txt', 'utf8')).trim(); }
catch {
  publicKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  await writeFile('.local/extension-public-key.txt', publicKey);
}
let config = {};
try { config = JSON.parse(await readFile('config.local.json', 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
const assetOrigins = config.assetOrigins ?? [];
for (const origin of assetOrigins) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('assetOrigins must be exact HTTPS origins');
}
await mkdir('dist', { recursive: true });
const manifest = JSON.parse(await readFile('public/manifest.json', 'utf8'));
manifest.key = publicKey;
manifest.host_permissions.push(...assetOrigins.map(origin => `${origin}/*`));
if (config.googleClientId) manifest.oauth2 = {
  client_id: config.googleClientId,
  scopes: ['https://www.googleapis.com/auth/drive.file']
};
await writeFile('dist/manifest.json', JSON.stringify(manifest, null, 2));
await build({
  entryPoints: ['src/background/service-worker.ts', 'src/popup/popup.ts', 'src/offscreen/offscreen.ts'],
  outdir: 'dist', outbase: 'src', bundle: true, format: 'esm', target: 'chrome120',
  conditions: ['worker'], sourcemap: true, define: { __ASSET_ORIGINS__: JSON.stringify(assetOrigins) }
});
await build({ entryPoints: ['src/content/course-context.ts'], outdir: 'dist/content', bundle: true, format: 'iife', target: 'chrome120' });
for (const name of ['popup', 'offscreen']) await cp(`src/${name}/${name}.html`, `dist/${name}/${name}.html`);
execFileSync(process.execPath, ['node_modules/@tailwindcss/cli/dist/index.mjs', '-i', 'src/popup/popup.css', '-o', 'dist/popup/popup.css', '--minify'], { stdio: 'inherit' });
const id = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
console.log(`Load unpacked: ${process.cwd()}/dist\nExtension ID: ${id}\nDrive OAuth: ${config.googleClientId ? 'configured' : 'not configured (local export works)'}`);
