#!/usr/bin/env python3
"""Publish an already tested APK without replacing or restarting the game server.

The upload directory contains naruto-rpg.apk, update.json, verification.json,
device-verification.json, safe-area-verification.json, login.html and
naruto-rpg-android-download.conf.
Run with --check first. Full website releases do not manage APK binaries.
"""
from pathlib import Path
import argparse, fcntl, hashlib, json, os, re, shutil, signal, subprocess, time

DOWNLOADS = Path('/var/www/naruto-rpg-downloads')
SITES = [Path('/var/www/naruto-rpg'), Path('/var/www/naruto-rpg-staging')]
CONFIGS = [Path('/etc/nginx/sites-enabled/naruto-rpg'), Path('/etc/nginx/sites-enabled/naruto-rpg-staging')]
SNIPPET = Path('/etc/nginx/snippets/naruto-rpg-android-download.conf')
INCLUDE = '    include /etc/nginx/snippets/naruto-rpg-android-download.conf;'
APK_URL = 'https://www.qiwu.asia/app/android/naruto-rpg.apk'


def sha(file):
    with Path(file).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def section(text, first, last):
    if text.count(first) != 1 or text.count(last) != 1:
        raise ValueError('Missing or duplicate download section')
    start, end = text.index(first), text.index(last) + len(last)
    if end <= start:
        raise ValueError('Invalid section order')
    return text[start:end]


def patch_login(text, template):
    for first, last, anchor in [
        ('/* Android download styles begin */', '/* Android download styles end */', '/* ========== Hint Text ========== */'),
        ('<!-- Android download begin -->', '<!-- Android download end -->', '<div class="error-msg" id="errorMsg">'),
    ]:
        block = section(template, first, last)
        if first in text:
            old = section(text, first, last)
            text = text.replace(old, block, 1)
        elif text.count(anchor) == 1:
            text = text.replace(anchor, block + '\n\n    ' + anchor, 1)
        else:
            raise ValueError('Login page changed; inspect before publishing')
    return text


def write_atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    old = path.stat() if path.exists() else None
    temp = path.with_name('.' + path.name + '.android-upload')
    with temp.open('wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temp, old.st_mode & 0o777 if old else 0o644)
    if old and os.geteuid() == 0:
        os.chown(temp, old.st_uid, old.st_gid)
    os.replace(temp, path)


def run(args):
    return subprocess.run(args, check=True, capture_output=True, timeout=60).stdout


def validate(work):
    manifest = json.loads((work/'update.json').read_text())
    proof = json.loads((work/'verification.json').read_text())
    device = json.loads((work/'device-verification.json').read_text())
    safe = json.loads((work/'safe-area-verification.json').read_text())
    digest = sha(work/'naruto-rpg.apk')
    if manifest.get('platform') != 'android' or manifest.get('apkUrl') != APK_URL:
        raise ValueError('Wrong Android download endpoint')
    code = manifest.get('versionCode')
    if type(code) is not int or code <= 0 or proof.get('version') != manifest.get('version') or proof.get('versionCode') != code:
        raise ValueError('APK version and update manifest differ')
    if proof.get('sha256') != digest or device.get('apkSha256') != digest:
        raise ValueError('Uploaded APK differs from the tested build')
    if not all(proof.get(key) is True for key in ['signatureVerified', 'privateFilesExcluded', 'nativeUnitTestsPassed']):
        raise ValueError('Required build checks did not pass')
    if not device.get('passed') or device.get('failed'):
        raise ValueError('Device verification did not pass')
    if safe.get('apkSha256') != digest or len(safe.get('states', [])) < 4:
        raise ValueError('Native system bar and cutout checks are missing')
    keyboard = safe.get('keyboard', {})
    if not 0 < keyboard.get('keyboardHeight', 0) < keyboard.get('fullHeight', 0):
        raise ValueError('Native keyboard check did not pass')
    template = (work/'login.html').read_text()
    if APK_URL not in template:
        raise ValueError('Login download URL differs')
    changes = {SNIPPET: (work/'naruto-rpg-android-download.conf').read_bytes()}
    for config in CONFIGS:
        original = config.read_text()
        if INCLUDE.strip() not in original:
            original, count = re.subn(r'(?m)^(    root /var/www/naruto-rpg(?:-staging)?;)$', r'\1\n'+INCLUDE, original)
            if count != 1:
                raise ValueError('Cannot locate website root in ' + str(config))
        changes[config.resolve()] = original.encode()
    for site in SITES:
        login = site/'login.html'
        changes[login] = patch_login(login.read_text(), template).encode()
    manifest.update(sha256=digest, sizeBytes=(work/'naruto-rpg.apk').stat().st_size, channel=proof.get('variant', 'test'))
    return manifest, device, changes


def publish(work):
    manifest, device, changes = validate(work)
    live = DOWNLOADS/'android'
    if live.exists() and not live.is_symlink():
        raise ValueError('Download directory already exists; inspect before replacing it')
    previous = os.readlink(live) if live.is_symlink() else None
    release = str(manifest['versionCode']) + '-' + manifest['sha256'][:16]
    version = DOWNLOADS/'releases'/release
    version.mkdir(parents=True, exist_ok=True)
    if (version/'naruto-rpg.apk').exists():
        if sha(version/'naruto-rpg.apk') != manifest['sha256']:
            raise ValueError('A release already exists with different APK bytes')
    else:
        write_atomic(version/'naruto-rpg.apk', (work/'naruto-rpg.apk').read_bytes())
        os.chmod(version/'naruto-rpg.apk', 0o644)
        if sha(version/'naruto-rpg.apk') != manifest['sha256']:
            raise ValueError('APK copy verification failed')
    if (version/'update.json').exists() and json.loads((version/'update.json').read_text()) != manifest:
        raise ValueError('A published update manifest cannot be rewritten under the same release ID')
    write_atomic(version/'update.json', (json.dumps(manifest, indent=2)+'\n').encode())
    backup = Path('/var/backups/naruto-rpg')/('android-'+time.strftime('%Y%m%d-%H%M%S')+'-'+str(os.getpid()))
    backup.mkdir(parents=True, mode=0o700)
    originals = {}
    for index, target in enumerate(changes):
        saved = backup/str(index)
        originals[str(target)] = str(saved) if target.exists() else None
        if target.exists():
            shutil.copy2(target, saved)
    (backup/'originals.json').write_text(json.dumps({'files': originals, 'previousRelease': previous}, indent=2))
    applied = []
    switched = False
    try:
        for target, data in changes.items():
            write_atomic(target, data)
            applied.append(target)
        run(['nginx', '-t'])
        temporary = DOWNLOADS/'.android-next'
        temporary.unlink(missing_ok=True)
        temporary.symlink_to('releases/'+release)
        os.replace(temporary, live)
        switched = True
        run(['systemctl', 'reload', 'nginx'])
        downloaded = work/'origin-download.apk'
        headers = work/'origin-download-headers.txt'
        # A successful reload only queues a graceful worker transition.
        for attempt in range(6):
            run(['curl', '--fail', '--silent', '--show-error', '--max-time', '45', '--resolve', 'www.qiwu.asia:443:127.0.0.1', '--output', str(downloaded), '--dump-header', str(headers), APK_URL])
            if sha(downloaded) == manifest['sha256']:
                break
            time.sleep(1)
        else:
            raise ValueError('Website APK mismatch: '+headers.read_text().splitlines()[0]+'; bytes='+str(downloaded.stat().st_size)+'; sha256='+sha(downloaded))
        report = {**manifest, 'deviceGroupsPassed': len(device['passed']), 'backup': str(backup), 'releaseDirectory': str(version), 'publishedAt': time.strftime('%Y-%m-%dT%H:%M:%S%z')}
        write_atomic(work/'published.json', (json.dumps(report, indent=2)+'\n').encode())
        write_atomic(backup/'published.json', (json.dumps(report, indent=2)+'\n').encode())
        print(json.dumps(report), flush=True)
    except BaseException:
        if switched:
            if previous:
                restore = DOWNLOADS/'.android-restore'
                restore.unlink(missing_ok=True)
                restore.symlink_to(previous)
                os.replace(restore, live)
            else:
                live.unlink(missing_ok=True)
        for target in reversed(applied):
            saved = originals[str(target)]
            if saved:
                shutil.copy2(saved, target)
            else:
                target.unlink(missing_ok=True)
        run(['nginx', '-t'])
        run(['systemctl', 'reload', 'nginx'])
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    work = Path(args.work).resolve()
    with Path('/var/lock/naruto-rpg-full-release.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.check:
            manifest, device, changes = validate(work)
            print(json.dumps({'sha256': manifest['sha256'], 'version': manifest['version'], 'deviceGroupsPassed': len(device['passed']), 'changedFiles': [str(file) for file in changes]}))
        else:
            publish(work)


if __name__ == '__main__':
    main()
