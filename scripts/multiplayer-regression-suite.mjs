import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const tests = (await readdir(scriptsDirectory))
  .filter(name => name.startsWith('multiplayer-') && name.endsWith('-regression.mjs'))
  .sort();

if (tests.length === 0) {
  throw new Error('No multiplayer regression scripts were found');
}

for (const test of tests) {
  console.log(`\n=== ${test} ===`);
  const result = spawnSync(process.execPath, [path.join(scriptsDirectory, test)], {
    cwd: path.resolve(scriptsDirectory, '..'),
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test' }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`Multiplayer regression failed: ${test} (${result.signal ?? `exit ${result.status}`})`);
    process.exit(result.status ?? 1);
  }
}

console.log(`\nMultiplayer regression suite passed (${tests.length} scripts).`);
