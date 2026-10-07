import { authClient } from './auth-client.js';
import { isNativeAndroidApp } from './runtime-platform.js';
import { cloudConnectionEnabled, setCloudConnection } from './project-server.js';

/** Detached checks: no startup, turn commit or local save awaits this service. */
export function startAppCloudChecks() {
  if (!isNativeAndroidApp()) return () => {};
  let stopped = false, running = false, timer;
  const check = async () => {
    if (stopped || running || !cloudConnectionEnabled()) return;
    running = true;
    try {
      const pending = authClient.getPendingLogin();
      if (pending) await authClient.pollAppLogin();
      else await authClient.checkAuth(true);
    } catch (error) { setCloudConnection('offline', error.message); }
    finally { running = false; }
  };
  const tick = () => {
    if (stopped) return;
    if (document.visibilityState !== 'hidden') void check();
    timer = setTimeout(tick, authClient.getPendingLogin() ? 5000 : 30_000);
  };
  const resume = () => { if (document.visibilityState !== 'hidden') void check(); };
  window.addEventListener('online', resume);
  document.addEventListener('visibilitychange', resume);
  // First check begins only after the shared game shell is already usable.
  timer = setTimeout(tick, 0);
  return () => { stopped = true; clearTimeout(timer); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume); };
}
