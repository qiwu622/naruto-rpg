import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [payloadArg, mode, build, releaseId] = process.argv.slice(2);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (payloadArg === '--check-source') {
  const manifest = JSON.parse(await fs.readFile(path.join(path.resolve(mode), 'release-manifest.json'), 'utf8'));
  for (const [relative, expected] of Object.entries(manifest.source_hashes)) {
    const target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep) || hash(await fs.readFile(target)) !== expected) throw new Error('Source changed after packaging: ' + relative);
  }
  console.log('SOURCE_UNCHANGED=true; SOURCE_FINGERPRINT=' + hash(JSON.stringify(manifest.source_hashes)));
  process.exit(0);
}
if (!payloadArg || !['staging', 'production'].includes(mode) || !/^\d{10,14}$/.test(build || '') || !/^[\w.-]+$/.test(releaseId || '')) throw new Error('Invalid deployment manifest arguments');
const payload = path.resolve(payloadArg);
const files = {};
const sourceHashes = {};
async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Deployment cannot contain symlinks: ' + target);
    if (entry.isDirectory()) { await walk(target); continue; }
    const relative = path.relative(payload, target).replaceAll(path.sep, '/');
    if (relative === 'release-manifest.json') continue;
    if (!/^(static|backend|ops)\//.test(relative) || /(^|\/)(?:\.env(?:\.|$)|node_modules|\.git|server\/data)(?:\/|$)|\.(?:db|db-wal|db-shm|upload|tmp)$/.test(relative)) throw new Error('Forbidden release file: ' + relative);
    const bytes = await fs.readFile(target);
    files[relative] = { sha256: hash(bytes), bytes: bytes.length };
    if (relative.startsWith('backend/')) {
      const source = relative.slice(8); sourceHashes[source] = hash(await fs.readFile(path.join(root, source)));
      if (sourceHashes[source] !== hash(bytes)) throw new Error('Backend source changed while packaging: ' + source);
    } else if (/^static\/(js|css|app)\//.test(relative)) {
      const source = relative.slice(7);
      const actual = hash(await fs.readFile(path.join(root, source)));
      if (actual !== hash(bytes)) throw new Error(`public/ is stale for ${source}; rebuild before deploying`);
      sourceHashes[source] = actual;
    } else if (relative.startsWith('ops/')) {
      const source = 'deploy/' + relative.slice(4);
      sourceHashes[source] = hash(await fs.readFile(path.join(root, source)));
      if (sourceHashes[source] !== hash(bytes)) throw new Error('Operations source changed while packaging: ' + source);
    }
  }
}
await walk(payload);
for (const relative of ['index.html', 'manifest.json', 'sw.js', 'announcements.html']) {
  const bytes = await fs.readFile(path.join(root, relative));
  const expected = relative.endsWith('.html') ? Buffer.from(bytes.toString().replace(/\?v=\d+/g, '?v=' + build)) : bytes;
  if (hash(expected) !== files['static/' + relative]?.sha256) throw new Error('Stale static entry: ' + relative);
  sourceHashes[relative] = hash(bytes);
}
// Validate the actual server entry's relative ESM closure, including new imports.
const seen = new Set();
async function closure(file) {
  if (seen.has(file)) return; seen.add(file);
  const text = await fs.readFile(file, 'utf8');
  for (const match of text.matchAll(/(?:from\s*|import\s*(?:\(\s*)?)["'](\.{1,2}\/[^"']+)["']/g)) {
    const target = path.resolve(path.dirname(file), match[1]);
    if (!target.startsWith(path.join(payload, 'backend') + path.sep)) throw new Error('Server import leaves the backend package: ' + match[1]);
    if (target.endsWith('.js')) await closure(target);
    else await fs.access(target);
  }
}
await closure(path.join(payload, 'backend/server/index.js'));
for (const name of await fs.readdir(path.join(root, 'server/multiplayer/persistence/migrations'))) {
  if (name.endsWith('.sql') && !files[`backend/server/multiplayer/persistence/migrations/${name}`]) throw new Error('Missing SQLite migration: ' + name);
}
const version = JSON.parse(await fs.readFile(path.join(payload, 'static/version.json'), 'utf8'));
if (version.build !== build || version.environment !== mode) throw new Error('Release metadata differs from requested target');
const announcement = await fs.readFile(path.join(payload, 'static/announcements.html'), 'utf8');
if (!announcement.includes(`data-release-version="${version.version}"`)) throw new Error('Website announcement is missing or belongs to another release');
await fs.writeFile(path.join(payload, 'release-manifest.json'), JSON.stringify({ schema: 'naruto.deploy-release/v1', mode, build, release_id: releaseId, version: version.version, files, source_hashes: sourceHashes }, null, 2) + '\n');
console.log(`RELEASE_FILES=${Object.keys(files).length}; BACKEND_IMPORTS=${seen.size}; SOURCE_FINGERPRINT=${hash(JSON.stringify(sourceHashes))}`);
