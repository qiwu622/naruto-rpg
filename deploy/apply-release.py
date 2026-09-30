#!/usr/bin/env python3
"""Apply a checked release, preserving runtime data and an independent rollback.

Both Windows and WSL deployers call this installer. A successful receipt makes
retries idempotent even when SSH disconnects before the result reaches a client.
"""
from pathlib import Path
import argparse, fcntl, hashlib, json, os, shutil, signal, subprocess, time, urllib.request

BACKEND = Path('/opt/naruto-rpg')
STATIC = {'staging': Path('/var/www/naruto-rpg-staging'), 'production': Path('/var/www/naruto-rpg')}
BACKUPS = Path('/var/backups/naruto-rpg')
NODE = '/opt/naruto-runtime/node-v22.23.2-linux-x64/bin/node'
NPM = '/opt/naruto-runtime/node-v22.23.2-linux-x64/lib/node_modules/npm/bin/npm-cli.js'
OPS = {
 'ops/systemd/naruto-rpg.service.d/limits.conf': Path('/etc/systemd/system/naruto-rpg.service.d/limits.conf'),
 'ops/systemd/naruto-rpg.service.d/runtime.conf': Path('/etc/systemd/system/naruto-rpg.service.d/runtime.conf'),
 'ops/systemd/naruto-rpg.service.d/cloud-slots.conf': Path('/etc/systemd/system/naruto-rpg.service.d/cloud-slots.conf'),
 'ops/sysctl/90-naruto-rpg-memory.conf': Path('/etc/sysctl.d/90-naruto-rpg-memory.conf'),
 'ops/nginx/naruto-rpg-staging.conf': Path('/etc/nginx/sites-enabled/naruto-rpg-staging'),
 'ops/nginx/naruto-rpg-android-download.conf': Path('/etc/nginx/snippets/naruto-rpg-android-download.conf'),
}
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
def managed_server(relative): return relative.startswith('server/') and not relative.startswith(('server/data/', 'server/db/saves/')) and relative.endswith(('.js', '.sql'))

class Installer:
 def __init__(self, work, mode, build):
  self.work = Path(work).resolve()
  self.manifest = json.loads((self.work/'release-manifest.json').read_text())
  self.mode, self.build = mode, build
  self.backend, self.static, self.backups = BACKEND, STATIC[mode], BACKUPS
  self.ops = OPS
  self.receipt = self.work/'applied.json'
  self.changed = []
  self.old_static = False
  self.static_applied = False
  self.modules_moved = False
  self.service_stopped = False
  self.timer_active = False

 def log(self, message):
  with (self.work/'apply.log').open('a') as output: output.write(message+'\n')
  try: print(message, flush=True)
  except BrokenPipeError: pass

 def run(self, args, *, cwd=None, env=None, timeout=180, check=True):
  result = subprocess.run(args, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
  with (self.work/'apply.log').open('a') as output: output.write(result.stdout)
  if check and result.returncode: raise RuntimeError('Command failed: '+args[0]+' (exit '+str(result.returncode)+')')
  return result

 def validate(self):
  m = self.manifest
  if m.get('schema') != 'naruto.deploy-release/v1' or m.get('mode') != self.mode or m.get('build') != self.build: raise RuntimeError('Release target/build mismatch')
  release = m.get('release_id', '')
  if not release or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._' for c in release): raise RuntimeError('Invalid release ID')
  self.backup = self.backups/('full-'+self.mode+'-'+release)
  self.next_static = self.static.with_name('.'+self.static.name+'-'+release)
  files = m['files']
  acknowledged = self.receipt.exists()
  for relative, record in files.items():
   source = self.work/relative
   if not source.resolve().is_relative_to(self.work) or source.is_symlink() or any(p in ('..','.env','node_modules','.git') for p in Path(relative).parts): raise RuntimeError('Unsafe payload path: '+relative)
   if not relative.startswith(('static/', 'backend/', 'ops/')): raise RuntimeError('Invalid payload scope')
   if relative.startswith('backend/'):
    r = relative[8:]
    if not (managed_server(r) or r.startswith('js/') or r in ('package.json','package-lock.json')): raise RuntimeError('Backend runtime data in payload')
   if relative.startswith('ops/') and relative not in self.ops and relative != 'ops/apply-release.py': raise RuntimeError('Unexpected operations file')
   if relative.startswith('static/') and relative[7:].split('/')[0] in ('server','node_modules','.env','public'): raise RuntimeError('Backend in public payload')
   if not acknowledged and (digest(source) != record['sha256'] or source.stat().st_size != record['bytes']): raise RuntimeError('Payload hash/size mismatch: '+relative)
  for required in ['static/index.html','static/login.html','static/js/app.js','static/version.json','backend/server/index.js','backend/package-lock.json']:
   if required not in files: raise RuntimeError('Missing release file: '+required)
  if acknowledged:
   # Do not silently acknowledge a stale receipt after someone else deploys.
   for relative,record in files.items():
    if relative.startswith('static/'): target=self.static/relative[7:]
    elif relative.startswith('backend/'): target=self.backend/relative[8:]
    elif relative in self.ops: target=self.ops[relative]
    else: continue
    if digest(target) != record['sha256']: raise RuntimeError('Receipt exists but installed files have changed')
   return False
  if json.loads((self.work/'static/version.json').read_text())['build'] != self.build: raise RuntimeError('Wrong static build')
  if self.backup.exists(): raise RuntimeError('Interrupted release has a backup; inspect apply.log and restore before starting a fresh release')
  return True

 def prepare_dependencies(self):
  candidate = self.work/'backend'
  env = os.environ.copy()
  env['PATH'] = str(Path(NODE).parent)+':'+env.get('PATH','')
  env['NODE_OPTIONS'] = '--max-old-space-size=256'
  env['npm_config_jobs'] = '1'
  env['MAKEFLAGS'] = '-j1'
  self.run([NODE,NPM,'ci','--omit=dev','--no-audit','--no-fund','--maxsockets=3'],cwd=candidate,env=env,timeout=600)
  self.run([NODE,'-e',"const Database=require('better-sqlite3'); (async()=>{ const db=new Database(':memory:'); db.exec('CREATE TABLE smoke(value); INSERT INTO smoke VALUES(42)'); await db.backup('sqlite-backup-smoke.db'); db.close(); const copy=new Database('sqlite-backup-smoke.db',{readonly:true}); if(copy.prepare('SELECT value FROM smoke').get().value!==42) process.exit(2); copy.close();})().catch(()=>process.exit(1))"],cwd=candidate)
  (candidate/'sqlite-backup-smoke.db').unlink(missing_ok=True)
  env.update(NODE_ENV='development', AUTH_BYPASS='false')
  self.run([NODE,'--input-type=module','-e',"await import('./server/multiplayer/persistence/sqlite-core-repositories.js'); await import('./server/multiplayer/agent/prompts.js');"],cwd=candidate,env=env)

 def copy_atomic(self, source, target):
  target.parent.mkdir(parents=True, exist_ok=True)
  old = target.stat() if target.exists() else None
  temp = target.with_name('.'+target.name+'.release')
  shutil.copyfile(source,temp)
  os.chmod(temp, (old.st_mode & 0o777) if old else 0o644)
  if os.geteuid() == 0: os.chown(temp,old.st_uid if old else 0,old.st_gid if old else 0)
  with temp.open('rb') as stream: os.fsync(stream.fileno())
  os.replace(temp,target)

 def snapshot(self):
  self.backup.mkdir(parents=True, mode=0o700)
  shutil.copy2(self.work/'release-manifest.json',self.backup/'release-manifest.json')
  # Only code files are managed. JSON accounts/save indexes, blobs, SQLite,
  # credentials and server/data are never candidates for replacement/deletion.
  targets = {self.backend/relative[8:] for relative in self.manifest['files'] if relative.startswith('backend/')}
  for p in (self.backend/'server').rglob('*'):
   if p.is_file() and managed_server(p.relative_to(self.backend).as_posix()): targets.add(p)
  for p in (self.backend/'js').rglob('*'):
   if p.is_file(): targets.add(p)
  targets.update(self.ops[r] for r in self.manifest['files'] if r in self.ops)
  self.originals = {}
  for index,target in enumerate(sorted(targets)):
   saved = self.backup/'original'/str(index)
   if target.is_file():
    saved.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(target,saved)
    self.originals[str(target)] = str(saved)
   else: self.originals[str(target)] = None
  (self.backup/'originals.json').write_text(json.dumps(self.originals,indent=2))
  self.production_before = digest(STATIC['production']/'index.html')
  shutil.copytree(self.work/'static',self.next_static)
  for p in [self.next_static,*self.next_static.rglob('*')]:
   os.chmod(p,0o755 if p.is_dir() else 0o644)
   if os.geteuid() == 0:
    import pwd
    user = pwd.getpwnam('www-data'); os.chown(p,user.pw_uid,user.pw_gid)

 def ready(self):
  try:
   with urllib.request.urlopen('http://127.0.0.1:3000/health/ready',timeout=3) as response: return json.load(response).get('status') == 'ready'
  except Exception: return False

 def stop(self):
  self.timer_active = self.run(['systemctl','is-active','--quiet','naruto-rpg-health-watchdog.timer'],check=False).returncode == 0
  if self.timer_active:
   self.run(['systemctl','stop','naruto-rpg-health-watchdog.timer'])
   self.run(['systemctl','stop','naruto-rpg-health-watchdog.service'],check=False)
  self.run(['systemctl','stop','naruto-rpg.service'],timeout=75)
  self.service_stopped = True
  # A stopped writer provides a consistent emergency backup of small metadata
  # and SQLite files. These are evidence/recovery copies, never auto-restored:
  # subsequent player writes must not be erased by a deployment rollback.
  data_backup = self.backup/'runtime-metadata'
  data_backup.mkdir()
  for directory in [self.backend/'server/data',self.backend/'server/db']:
   if not directory.is_dir(): continue
   for p in directory.rglob('*'):
    if p.is_file() and (p.name in ('users.json','saves_index.json','favorites.json','login_log.json') or p.suffix in ('.sqlite','.db') or p.name.endswith(('-wal','-shm'))):
     relative = p.relative_to(self.backend); target = data_backup/relative
     target.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(p,target)

 def apply(self):
  live = set()
  for relative in self.manifest['files']:
   if relative.startswith('backend/'):
    target = self.backend/relative[8:]; live.add(str(target))
    self.copy_atomic(self.work/relative,target); self.changed.append(str(target))
   elif relative in self.ops:
    target = self.ops[relative]; self.copy_atomic(self.work/relative,target); self.changed.append(str(target))
  for target in self.originals:
   path = Path(target)
   if path.is_relative_to(self.backend) and target not in live:
    path.unlink(missing_ok=True); self.changed.append(target)
  modules = self.backend/'node_modules'
  if modules.exists(): os.rename(modules,self.backup/'node_modules.before')
  self.modules_moved = True
  os.rename(self.work/'backend/node_modules',modules)
  self.run(['nginx','-t'])
  self.run(['systemctl','daemon-reload'])
  self.run(['sysctl','-p','/etc/sysctl.d/90-naruto-rpg-memory.conf'])
  self.run(['systemctl','start','naruto-rpg.service'],timeout=75)
  for _ in range(40):
   if self.ready(): break
   time.sleep(1)
  else: raise RuntimeError('Backend did not become ready')
  if self.static.exists(): os.rename(self.static,self.backup/'static.before'); self.old_static = True
  os.rename(self.next_static,self.static); self.static_applied = True
  self.run(['systemctl','reload','nginx'])

 def verify_public(self):
  base = 'https://www.qiwu.asia'+(':8080' if self.mode == 'staging' else '')+'/'
  for name in ['login.html','version.json','js/app.js','js/ui/save-library-panel.js','js/core/save-library-cloud.js','js/data/worldbook/activation.js']:
   request = urllib.request.Request(base+name+'?release='+self.build,headers={'Cache-Control':'no-cache'})
   with urllib.request.urlopen(request,timeout=20) as response:
    if response.status != 200 or hashlib.sha256(response.read()).hexdigest() != self.manifest['files']['static/'+name]['sha256']: raise RuntimeError('Public resource mismatch: '+name)
  if self.mode == 'staging':
   with urllib.request.urlopen(base,timeout=20) as response:
    if response.geturl().split('?')[0] != base+'login.html' or response.headers.get('X-Staging') != 'true': raise RuntimeError('Staging login protection missing')
   if digest(STATIC['production']/'index.html') != self.production_before: raise RuntimeError('Production frontend unexpectedly changed')
  for relative,record in self.manifest['files'].items():
   if relative.startswith('static/'): target=self.static/relative[7:]
   elif relative.startswith('backend/'): target=self.backend/relative[8:]
   elif relative in self.ops: target=self.ops[relative]
   else: continue
   if digest(target) != record['sha256']: raise RuntimeError('Installed file mismatch: '+relative)
  if not self.ready(): raise RuntimeError('Final readiness check failed')

 def rollback(self):
  self.log('Verification failed; restoring managed code/config/dependencies and frontend.')
  if self.service_stopped: self.run(['systemctl','stop','naruto-rpg.service'],timeout=75,check=False)
  if self.static_applied:
   os.rename(self.static,self.backup/'static.failed')
  if self.old_static: os.rename(self.backup/'static.before',self.static)
  for target in reversed(self.changed):
   saved = self.originals[target]
   if saved: self.copy_atomic(Path(saved),Path(target))
   else: Path(target).unlink(missing_ok=True)
  if self.modules_moved:
   modules = self.backend/'node_modules'
   if modules.exists(): os.rename(modules,self.backup/'node_modules.failed')
   if (self.backup/'node_modules.before').exists(): os.rename(self.backup/'node_modules.before',modules)
  self.run(['systemctl','daemon-reload'],check=False)
  self.run(['sysctl','-p','/etc/sysctl.d/90-naruto-rpg-memory.conf'],check=False)
  self.run(['nginx','-t'],check=False)
  self.run(['systemctl','reload','nginx'],check=False)
  if self.service_stopped: self.run(['systemctl','start','naruto-rpg.service'],timeout=75,check=False)
  (self.backup/'rolled-back').write_text('Managed files restored; runtime data was preserved.\n')

 def execute(self):
  if not self.validate(): self.log(self.receipt.read_text()); return
  self.log('RELEASE_PHASE=dependencies; preparing Node 22 production dependencies before downtime')
  self.prepare_dependencies()
  self.snapshot()
  try:
   self.log('RELEASE_PHASE=apply; stopping the single writer and replacing the checked release')
   self.stop(); self.apply(); self.verify_public()
   report = {'mode':self.mode,'build':self.build,'backup':str(self.backup),'verified_files':len(self.manifest['files']),'health':'ready','runtime_data_preserved':True}
   self.receipt.write_text(json.dumps(report))
   (self.backup/'verified.json').write_text(json.dumps(report,indent=2))
   self.log('DEPLOY_VERIFIED='+json.dumps(report))
  except BaseException as error:
   self.rollback()
   (self.work/'failed.txt').write_text(str(error))
   raise
  finally:
   if self.timer_active: self.run(['systemctl','start','naruto-rpg-health-watchdog.timer'],check=False)
   if self.next_static.exists(): shutil.rmtree(self.next_static)

def main():
 parser=argparse.ArgumentParser()
 parser.add_argument('--mode',choices=['staging','production'],required=True)
 parser.add_argument('--build',required=True)
 parser.add_argument('--cleanup',action='store_true')
 args=parser.parse_args()
 work=Path(__file__).resolve().parent.parent
 signal.signal(signal.SIGHUP,signal.SIG_IGN)
 with Path('/var/lock/naruto-rpg-full-release.lock').open('w') as lock:
  try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError: raise SystemExit('A release is already running; inspect apply.log before retrying')
  installer=Installer(work,args.mode,args.build)
  if args.cleanup:
   if installer.validate(): raise SystemExit('Cannot clean an unacknowledged release')
   for name in ('static','backend'):
    target=work/name
    if target.exists() and target.resolve().is_relative_to(work): shutil.rmtree(target)
   installer.log('RELEASE_PAYLOAD_CLEANED=true; receipt, manifest, log and permanent backup retained')
  else: installer.execute()

if __name__ == '__main__': main()
