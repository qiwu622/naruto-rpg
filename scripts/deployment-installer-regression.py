from pathlib import Path
import hashlib, importlib.util, json, shutil, subprocess, tempfile, urllib.parse

root=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('release',root/'deploy/apply-release.py')
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
passed=0

def fixture(root, fail_public=False, frontend_only=False):
 backend=root/'backend'; stage=root/'stage'; prod=root/'prod'; work=root/'release'
 module.BACKEND=backend; module.STATIC={'staging':stage,'production':prod}; module.BACKUPS=root/'backups'
 module.OPS={name:root/'ops-live'/Path(name).name for name in module.OPS}
 originals={
  'backend/server/index.js':b'old server', 'backend/server/obsolete.js':b'old code',
  'backend/js/obsolete.js':b'old shared code', 'backend/node_modules/old.marker':b'old dependencies',
  'backend/.env':b'keep private configuration', 'backend/server/data/room.sqlite':b'keep room data',
  'backend/server/data/runtime.sql':b'keep runtime .sql', 'backend/server/db/users.json':b'keep accounts',
  'backend/server/db/saves/cloud.bin':b'keep cloud content', 'stage/index.html':b'old front', 'prod/index.html':b'production front',
 }
 for relative,bytes in originals.items():
  p=root/relative; p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(bytes)
 for p in module.OPS.values(): p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(b'old ops')
 payload={
  'static/index.html':b'new front', 'static/login.html':b'new login', 'static/version.json':b'{"build":"2609301300"}',
  'static/announcements.html':b'<html data-release-version="3.6.0">Release notes</html>',
  'static/js/app.js':b'new app','static/js/ui/save-library-panel.js':b'new library',
  'static/js/core/save-library-cloud.js':b'new cloud','static/js/data/worldbook/activation.js':b'new worldbook',
  'static/img/logo.png':b'image asset', 'backend/server/index.js':b'new server',
  'backend/server/new.js':b'new module', 'backend/server/multiplayer/persistence/migrations/0008-room-opening-drafts.sql':b'new migration',
  'backend/js/data/worldbook/runtime-resolver.js':b'new dependency', 'backend/package.json':b'{}', 'backend/package-lock.json':b'{}',
  **{name:b'new ops' for name in module.OPS},
 }
 files={}
 for relative,bytes in payload.items():
  p=work/relative; p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(bytes)
  files[relative]={'sha256':sha(p),'bytes':len(bytes)}
 (work/'release-manifest.json').write_text(json.dumps({'schema':'naruto.deploy-release/v1','mode':'staging','build':'2609301300','release_id':'fixture','version':'3.6.0','files':files}))
 class Response:
  status=200
  headers={'X-Staging':'true'}
  def __init__(self,url): self.url=url
  def __enter__(self): return self
  def __exit__(self,*args): pass
  def read(self):
   if '/health/ready' in self.url: return b'{"status":"ready"}'
   relative=urllib.parse.urlparse(self.url).path.lstrip('/') or 'login.html'
   if fail_public and relative=='js/app.js': raise RuntimeError('injected public verification failure')
   return (stage/relative).read_bytes()
  def geturl(self): return 'https://www.qiwu.asia:8080/login.html' if self.url.endswith('/') else self.url
 module.urllib.request.urlopen=lambda request,timeout:Response(request.full_url if hasattr(request,'full_url') else request)
 class FixtureInstaller(module.Installer):
  starts=0
  dependency_runs=0
  operations=[]
  readiness=[]
  def ready(self):
   if type(self).readiness: return type(self).readiness.pop(0)
   return super().ready()
  def prepare_dependencies(self):
   type(self).dependency_runs+=1
   p=self.work/'backend/node_modules/new.marker'; p.parent.mkdir(parents=True); p.write_bytes(b'new dependencies')
  def run(self,args,**kwargs):
   type(self).operations.append(args)
   if args[:3]==['systemctl','start','naruto-rpg.service']: type(self).starts+=1
   return subprocess.CompletedProcess(args,1 if 'is-active' in args else 0,'')
 return FixtureInstaller(work,'staging','2609301300',frontend_only),originals

with tempfile.TemporaryDirectory(prefix='naruto-release-regression-') as temporary:
 base=Path(temporary)
 instance,originals=fixture(base/'success')
 instance.execute()
 assert (instance.static/'img/logo.png').read_bytes()==b'image asset'
 assert not (instance.backend/'server/obsolete.js').exists()
 assert not (instance.backend/'js/obsolete.js').exists()
 assert (instance.backend/'server/multiplayer/persistence/migrations/0008-room-opening-drafts.sql').exists()
 for relative in ['backend/.env','backend/server/data/room.sqlite','backend/server/data/runtime.sql','backend/server/db/users.json','backend/server/db/saves/cloud.bin','prod/index.html']:
  assert (base/'success'/relative).read_bytes()==originals[relative], relative
 passed+=1; print('PASS full release publishes assets/SQL/shared dependencies, prunes only managed obsolete code and preserves accounts/cloud/rooms/config/production frontend')
 instance.execute()
 assert type(instance).starts==1 and type(instance).dependency_runs==1
 shutil.rmtree(instance.work/'backend'); shutil.rmtree(instance.work/'static')
 instance.execute()
 assert type(instance).starts==1 and type(instance).dependency_runs==1
 (instance.backend/'server/index.js').write_bytes(b'changed by a later release')
 try: instance.execute(); raise AssertionError('expected stale receipt rejection')
 except RuntimeError as error: assert 'installed files have changed' in str(error)
 passed+=1; print('PASS acknowledged retry works after payload cleanup without another restart, and rejects files changed by a later release')

 instance,originals=fixture(base/'rollback',fail_public=True)
 try: instance.execute(); raise AssertionError('expected verification failure')
 except RuntimeError as error: assert 'injected public' in str(error)
 for relative,bytes in originals.items(): assert (base/'rollback'/relative).read_bytes()==bytes, relative
 assert not (instance.backend/'server/new.js').exists()
 assert not (instance.backend/'node_modules/new.marker').exists()
 assert not instance.receipt.exists()
 assert (instance.backup/'rolled-back').exists()
 passed+=1; print('PASS failed public verification restores code/config/dependencies and the frontend while retaining every runtime-data byte')

 instance,_=fixture(base/'corrupt')
 (instance.work/'backend/server/index.js').write_bytes(b'changed after packaging')
 try: instance.execute(); raise AssertionError('expected checksum rejection')
 except RuntimeError as error: assert 'hash/size mismatch' in str(error)
 assert type(instance).starts==0 and type(instance).dependency_runs==0
 passed+=1; print('PASS tampered payload is rejected before dependency install, service stop or publication')

 instance,originals=fixture(base/'frontend',frontend_only=True)
 type(instance).readiness=[False,True]
 instance.execute()
 assert (instance.static/'index.html').read_bytes()==b'new front'
 assert (instance.static/'img/logo.png').read_bytes()==b'image asset'
 for relative,bytes in originals.items():
  if not relative.startswith('stage/'): assert (base/'frontend'/relative).read_bytes()==bytes,relative
 for p in module.OPS.values(): assert p.read_bytes()==b'old ops'
 assert type(instance).dependency_runs==0 and type(instance).operations==[]
 receipt=json.loads(instance.receipt.read_text())
 assert receipt['frontend_only'] is True and receipt['shared_backend_changed'] is False
 assert type(instance).readiness==[], 'publication must tolerate a transient failed readiness probe'
 passed+=1; print('PASS frontend-only publication tolerates transient readiness failure and leaves production, backend, dependencies, data, global configs and services untouched')

 # Later backend changes do not invalidate a frontend-only receipt; another
 # staging release does. Retrying in the wrong scope must also be rejected.
 (instance.backend/'server/index.js').write_bytes(b'later shared backend')
 instance.execute()
 shutil.rmtree(instance.work/'backend'); shutil.rmtree(instance.work/'static')
 instance.execute()
 instance.frontend_only=False
 try: instance.execute(); raise AssertionError('expected release scope rejection')
 except RuntimeError as error: assert 'scope mismatch' in str(error)
 instance.frontend_only=True
 (instance.static/'index.html').write_bytes(b'later staging frontend')
 try: instance.execute(); raise AssertionError('expected stale frontend receipt rejection')
 except RuntimeError as error: assert 'installed files have changed' in str(error)
 assert type(instance).dependency_runs==0 and type(instance).operations==[]
 passed+=1; print('PASS frontend-only retries remain idempotent after payload cleanup, reject scope changes and detect later staging changes')

 instance,originals=fixture(base/'frontend-rollback',fail_public=True,frontend_only=True)
 try: instance.execute(); raise AssertionError('expected frontend verification failure')
 except RuntimeError as error: assert 'injected public' in str(error)
 for relative,bytes in originals.items(): assert (base/'frontend-rollback'/relative).read_bytes()==bytes,relative
 for p in module.OPS.values(): assert p.read_bytes()==b'old ops'
 assert not instance.receipt.exists() and (instance.backup/'rolled-back').exists()
 assert type(instance).dependency_runs==0 and type(instance).operations==[]
 passed+=1; print('PASS frontend-only failure rolls back staging without touching the shared backend or any service')

 instance,originals=fixture(base/'frontend-not-ready',frontend_only=True)
 instance.wait_ready=lambda: False
 try: instance.execute(); raise AssertionError('expected persistent readiness failure')
 except RuntimeError as error: assert 'readiness check failed' in str(error)
 for relative,bytes in originals.items(): assert (base/'frontend-not-ready'/relative).read_bytes()==bytes,relative
 assert not instance.receipt.exists() and (instance.backup/'rolled-back').exists()
 assert type(instance).dependency_runs==0 and type(instance).operations==[]
 passed+=1; print('PASS persistent readiness failure still rolls back staging without changing the shared service')

 try: module.Installer(instance.work,'production','2609301300',True); raise AssertionError('expected frontend-only production rejection')
 except RuntimeError as error: assert 'limited to staging' in str(error)
 passed+=1; print('PASS frontend-only mode cannot target production')
print(f'Deployment installer regression: {passed} groups passed')
