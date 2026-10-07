import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Exercise automatic, allocation-driven GC in a real native SQLite process.
// Explicit global.gc() and short backup tests did not reproduce Node #65446:
// Statements built with Node 24.19 ObjectWrap aborted during weak cleanup.
const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
  import assert from 'node:assert/strict';
  import Database from 'better-sqlite3';
  const database = new Database(':memory:');
  try {
    let allocations = [];
    for (let index = 0; index < 300_000; index += 1) {
      const row = database.prepare('SELECT ? AS value').get(index);
      assert.equal(row.value, index);
      allocations.push({ index });
      if (allocations.length > 1_000) allocations = [];
    }
  } finally {
    database.close();
  }
  assert.equal(database.open, false);
  console.log('native statement allocation and close passed');
`], {
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  encoding: 'utf8',
  timeout: 60_000,
  maxBuffer: 1024 * 1024
});

assert.ifError(result.error);
assert.equal(result.status, 0,
  `Native SQLite lifecycle failed (signal=${result.signal ?? 'none'}):\n${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /native statement allocation and close passed/u);
console.log('multiplayer SQLite native lifecycle regression: allocation-driven GC and close passed');
