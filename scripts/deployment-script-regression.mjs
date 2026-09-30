import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(root, file), 'utf8');
const ps = read('deploy.ps1'), wsl = read('deploy-wsl.sh');
const installer = read('deploy/apply-release.py');
const hash = file => existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null;
const baseline = ['public/index.html', 'public/login.html', 'public/version.json'].map(file => hash(path.join(root, file)));
assert.deepEqual([...readFileSync(path.join(root,'deploy.ps1')).subarray(0,3)], [239,187,191], 'PowerShell 5.1 requires UTF-8 BOM');
for (const file of ['部署测试站.bat','部署正式站.bat']) {
  const bytes = readFileSync(path.join(root,file));
  assert.deepEqual([...bytes.subarray(0,5)], [...Buffer.from('@echo')]);
  assert.doesNotMatch(bytes.toString('binary'), /(?<!\r)\n|\r(?!\n)/, 'batch line endings must stay CRLF');
  assert.match(bytes.toString('utf8'), /set "PSModulePath=%SystemRoot%\\System32\\WindowsPowerShell/);
  assert.match(bytes.toString('utf8'), /pushd "%SystemRoot%"/);
}
assert.match(read('部署测试站.bat'), /-Mode\s+staging/);
assert.match(read('部署正式站.bat'), /-ConfirmProduction/);
assert.match(ps, /Extension -notin @\('\.js', '\.sql'\)/);
assert.ok(ps.includes("Join-Path $ProjectDir 'js'"), 'Windows packages the complete shared dependency tree');
for (const source of [ps,wsl]) {
  for (const required of ['deploy-manifest.mjs', 'apply-release.py', 'cloud-slots.conf', 'sha256', '--cleanup', '--check-source']) assert.ok(source.toLowerCase().includes(required), required);
  assert.doesNotMatch(source, /npm install --omit=dev --silent/, 'live dependencies must not be installed with an unpinned runtime');
}
assert.match(installer, /node-v22\.23\.2-linux-x64/);
assert.match(installer, /db\.backup/);
assert.match(installer, /flock/);
assert.match(installer, /def rollback/);
assert.match(installer, /node_modules\.before/);
assert.match(installer, /health\/ready/);
assert.doesNotMatch(installer, /CERT_NONE|unverified_context/, 'public verification must keep TLS validation');
assert.match(read('deploy-v3.sh'), /exec bash .*deploy-wsl\.sh.*production/);
assert.match(read('deploy.sh'), /exec bash .*deploy-wsl\.sh/);
assert.doesNotMatch(read('deploy.sh'), /--exclude=.*png/);
const limits = read('deploy/systemd/naruto-rpg.service.d/limits.conf');
for (const setting of ['MemoryLow=192M','MemoryHigh=320M','MemoryMax=448M','MemorySwapMax=32M','TimeoutStopSec=45s','Restart=on-failure']) assert.ok(limits.includes(setting));
assert.match(read('deploy/systemd/naruto-rpg.service.d/runtime.conf'), /NODE_OPTIONS=--max-old-space-size=256/);
assert.match(read('deploy/systemd/naruto-rpg.service.d/cloud-slots.conf'), /MAX_SAVE_SLOTS=5/);

function run(command,args,timeout=90_000) {
  const isCmd = process.platform === 'win32' && command.toLowerCase().endsWith('cmd.exe');
  const result = spawnSync(command,args,{cwd:isCmd ? process.env.SystemRoot : root,windowsVerbatimArguments:isCmd,encoding:'utf8',timeout,maxBuffer:4*1024*1024,env:{...process.env,NARUTO_DEPLOY_NO_PAUSE:'1'}});
  const output = (result.stdout || '') + '\n' + (result.stderr || '');
  assert.equal(result.status,0,output || result.error?.message);
  return output;
}
const sourceFixture = mkdtempSync(path.join(tmpdir(), 'naruto-deploy-source-'));
try {
  writeFileSync(path.join(sourceFixture, 'release-manifest.json'), JSON.stringify({ source_hashes: { 'package.json': hash(path.join(root, 'package.json')) } }));
  assert.match(run(process.execPath, ['scripts/deploy-manifest.mjs', '--check-source', sourceFixture]), /SOURCE_UNCHANGED=true/);
  writeFileSync(path.join(sourceFixture, 'release-manifest.json'), JSON.stringify({ source_hashes: { 'package.json': 'outdated-source' } }));
  const drift = spawnSync(process.execPath, ['scripts/deploy-manifest.mjs', '--check-source', sourceFixture], { cwd: root, encoding: 'utf8' });
  assert.notEqual(drift.status, 0);
  assert.match(drift.stdout + drift.stderr, /Source changed after packaging/);
} finally { rmSync(sourceFixture, { recursive: true, force: true }); }
if (process.platform !== 'win32') {
  for (const script of ['deploy-wsl.sh','deploy-v3.sh','deploy.sh']) run('bash',['-n',script]);
  for (const mode of ['staging','production']) {
    const out = run('bash',['deploy-wsl.sh',mode,'--dry-run','--skip-build']);
    assert.ok(out.includes('DRY_RUN_OK='+mode));
    assert.match(out,/RELEASE_FILES=\d+; BACKEND_IMPORTS=\d+/);
    assert.match(out,/RUNTIME_DATA_EXCLUDED=true/);
  }
  assert.match(run('bash',['deploy.sh','staging','--dry-run','--skip-build']),/DRY_RUN_OK=staging/);
  assert.match(run('bash',['deploy-v3.sh','--dry-run','--skip-build']),/DRY_RUN_OK=production/);
  const denied = spawnSync('bash',['deploy-wsl.sh','production','--skip-build'],{cwd:root,encoding:'utf8'});
  assert.notEqual(denied.status,0);
  assert.match(denied.stdout + denied.stderr,/--confirm-production/);
  const test = run('python3',['scripts/deployment-installer-regression.py']);
  assert.match(test,/4 groups passed/);
} else {
  const powershell = path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
  for (const mode of ['staging','production']) assert.ok(run(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','deploy.ps1','-Mode',mode,'-DryRun','-SkipBuild']).includes('DRY_RUN_OK='+mode));
  for (const [file, mode] of [['部署测试站.bat', 'staging'], ['部署正式站.bat', 'production']]) {
    assert.match(run(process.env.ComSpec, ['/d', '/c', 'call "' + path.join(root, file) + '" -DryRun -SkipBuild']), new RegExp('DRY_RUN_OK=' + mode));
  }
  const denied = spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','deploy.ps1','-Mode','production','-SkipBuild'],{cwd:root,encoding:'utf8'});
  assert.notEqual(denied.status,0);
  assert.match(denied.stdout + denied.stderr,/ConfirmProduction/);
}
assert.deepEqual(['public/index.html','public/login.html','public/version.json'].map(file => hash(path.join(root,file))), baseline, 'packaging cannot change local HTML/build metadata');
console.log('deployment-script-regression: passed; full dependency closure, offline Windows/WSL packages and failure rollback');
