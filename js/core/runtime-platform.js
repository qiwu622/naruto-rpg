function capacitorBridge() {
  return globalThis?.Capacitor || null;
}

export function getRuntimePlatform() {
  const capacitor = capacitorBridge();
  try {
    const platform = capacitor?.getPlatform?.();
    if (typeof platform === 'string' && platform) return platform.toLowerCase();
  } catch { /* malformed or unavailable native bridge */ }
  return 'web';
}

export function isNativeApp() {
  const capacitor = capacitorBridge();
  try {
    if (typeof capacitor?.isNativePlatform === 'function') {
      return capacitor.isNativePlatform() === true;
    }
  } catch { /* fall through to the platform check */ }
  return getRuntimePlatform() !== 'web';
}

export function isNativeAndroidApp() {
  return isNativeApp() && getRuntimePlatform() === 'android';
}

export function usesProjectServerFeatures() {
  return true; // Optional cloud services also work in the bundled Android UI.
}

// Shared entry gate for the toolbar, room history and session restoration.
export function isMultiplayerEntryVisible() {
  return true;
}

export default Object.freeze({
  getRuntimePlatform,
  isNativeApp,
  isNativeAndroidApp,
  usesProjectServerFeatures,
  isMultiplayerEntryVisible
});
