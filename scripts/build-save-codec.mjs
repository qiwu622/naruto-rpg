import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, readFile, writeFile, mkdir } from 'node:fs/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'js/vendor/save-codec.js');
let build;
try { ({ build } = await import('esbuild')); }
catch (error) {
  try { await access(outfile); console.warn('esbuild unavailable; using the committed save codec bundle.'); process.exit(0); }
  catch { throw new Error('Install development dependencies to build the save codec.', { cause: error }); }
}
await mkdir(path.dirname(outfile), { recursive: true });
await build({
  entryPoints: [path.join(root, 'scripts/vendor/save-codec-entry.js')], outfile,
  bundle: true, format: 'iife', globalName: 'NarutoSaveCodec', platform: 'browser',
  target: ['es2022'], minify: true, sourcemap: false, legalComments: 'inline',
  footer: { js: 'globalThis.NarutoSaveCodec = NarutoSaveCodec;' }
});
// The streamparser npm tarball omits its repository license. Keep that MIT
// notice locally so builds do not need a network request to preserve it.
const licenses = await Promise.all([
  ['@noble/hashes', 'node_modules/@noble/hashes/LICENSE'],
  ['@streamparser/json', 'scripts/vendor/streamparser-json.LICENSE.txt']
].map(async ([name, file]) => `${name}\n\n${await readFile(path.join(root, file), 'utf8')}`));
await writeFile(path.join(root, 'js/vendor/save-codec.LICENSE.txt'), licenses.join('\n\n'));
console.log('Built browser streaming save codec (SHA-256 and JSON parser).');
