export function readLoadedBuild(documentRef = globalThis.document) {
  const script = documentRef?.querySelector?.('script[src*="app.js?v="]');
  const source = String(script?.src || script?.getAttribute?.('src') || '');
  if (!source) return '';
  try {
    return new URL(source, globalThis.location?.href || 'http://localhost/').searchParams.get('v') || '';
  } catch {
    return source.match(/[?&]v=([^&#]+)/)?.[1] || '';
  }
}

export async function inspectRuntimeBuild({
  fetchImpl = globalThis.fetch,
  documentRef = globalThis.document,
  locationRef = globalThis.location
} = {}) {
  const loadedBuild = readLoadedBuild(documentRef);
  if (typeof fetchImpl !== 'function' || !locationRef?.href) {
    return Object.freeze({ loadedBuild, latestBuild: '', stale: false, manifest: null });
  }
  const url = new URL('./version.json', locationRef.href);
  url.searchParams.set('_runtime_check', String(Date.now()));
  const response = await fetchImpl(url.href, {
    cache: 'no-store',
    headers: { Accept: 'application/json' }
  });
  if (!response?.ok) throw new Error(`version.json HTTP ${response?.status || 0}`);
  const manifest = await response.json();
  const latestBuild = String(manifest?.build || '').trim();
  return Object.freeze({
    loadedBuild,
    latestBuild,
    stale: Boolean(loadedBuild && latestBuild && loadedBuild !== latestBuild),
    manifest: Object.freeze({ ...manifest })
  });
}

export function showStaleBuildNotice(result, {
  documentRef = globalThis.document,
  locationRef = globalThis.location,
  storageRef
} = {}) {
  const existing = documentRef?.getElementById?.('runtime-build-stale-notice');
  if (!result?.stale) { existing?.remove?.(); return null; }
  if (!documentRef?.createElement) return null;
  const dismissedKey = 'naruto_build_notice_dismissed';
  try {
    storageRef ??= globalThis.sessionStorage;
    if (storageRef?.getItem(dismissedKey) === result.latestBuild) { existing?.remove?.(); return null; }
  } catch { /* Storage restrictions must not block the game or update notice. */ }
  if (existing) return existing;
  const notice = documentRef.createElement('aside');
  notice.id = 'runtime-build-stale-notice';
  notice.setAttribute('role', 'alert');
  notice.style.cssText = 'position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 12px);transform:translateX(-50%);z-index:2147483647;width:min(440px,calc(100vw - 24px));box-sizing:border-box;padding:10px 12px;border:1px solid #eb613f;border-radius:10px;background:rgba(20,16,14,.97);color:#f4eee5;box-shadow:0 8px 30px rgba(0,0,0,.45);font:13px/1.4 system-ui,sans-serif;display:flex;align-items:center;gap:10px;';
  const message = documentRef.createElement('span');
  message.textContent = '有新版本可用';
  message.style.cssText = 'flex:1;min-width:0;overflow-wrap:anywhere;';
  const refresh = documentRef.createElement('button');
  refresh.type = 'button';
  refresh.textContent = '立即刷新';
  refresh.style.cssText = 'flex:none;min-height:36px;border:1px solid #eb613f;border-radius:7px;background:#eb613f;color:white;padding:6px 10px;font:inherit;white-space:nowrap;cursor:pointer;';
  refresh.addEventListener('click', () => {
    if (locationRef?.href && typeof locationRef.replace === 'function') {
      const url = new URL(locationRef.href);
      // A unique URL also forces a new document when a prior refresh URL
      // already has the same build and a fragment (otherwise replace may only
      // navigate within the current document).
      url.searchParams.set('_app_update', `${result.latestBuild}-${Date.now()}`);
      locationRef.replace(url.href);
    } else locationRef?.reload?.();
  });
  const dismiss = documentRef.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = '×';
  dismiss.setAttribute('aria-label', '暂时关闭更新提示');
  dismiss.title = '稍后更新';
  dismiss.style.cssText = 'flex:none;width:36px;min-height:36px;border:0;border-radius:7px;background:transparent;color:#d2c5ba;font:22px/1 system-ui;cursor:pointer;';
  dismiss.addEventListener('click', () => {
    try { storageRef?.setItem(dismissedKey, result.latestBuild); } catch { /* Closing remains available. */ }
    notice.remove();
  });
  notice.append(message, refresh, dismiss);
  (documentRef.body || documentRef.documentElement)?.appendChild(notice);
  return notice;
}
