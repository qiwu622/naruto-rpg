from pathlib import Path
import hashlib, importlib.util, json, shutil, subprocess, tempfile, urllib.parse

root=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('release',root/'deploy/apply-release.py')
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
passed=0

def fixture(root, fail_public=False):
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
 (work/'release-manifest.json').write_text(json.dumps({'schema':'naruto.deploy-release/v1','mode':'staging','build':'2609301300','release_id':'fixture','files':files}))
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
  def prepare_dependencies(self):
   type(self).dependency_runs+=1
   p=self.work/'backend/node_modules/new.marker'; p.parent.mkdir(parents=True); p.write_bytes(b'new dependencies')
  def run(self,args,**kwargs):
   if args[:3]==['systemctl','start','naruto-rpg.service']: type(self).starts+=1
   return subprocess.CompletedProcess(args,1 if 'is-active' in args else 0,'')
 return FixtureInstaller(work,'staging','2609301300'),originals

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
print(f'Deployment installer regression: {passed} groups passed')
