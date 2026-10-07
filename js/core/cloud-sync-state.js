// Session-scoped sync status. Payloads and account details are never persisted.
export const cloudScopeKey = scope => JSON.stringify([String(scope?.userId || ''), String(scope?.saveKey || '')]);

export class CloudSyncState {
  constructor() {
    this.active = { userId: '', saveKey: '' };
    this.states = new Map();
    this.listeners = new Set();
  }

  setContext(scope = {}) {
    this.active = { userId: String(scope.userId || ''), saveKey: String(scope.saveKey || '') };
    this.emit();
    return this.get();
  }

  get(scope = this.active) {
    return this.states.get(cloudScopeKey(scope)) || Object.freeze({
      userId: String(scope.userId || ''), saveKey: String(scope.saveKey || ''),
      status: 'local', message: '本地已保存', canRetry: false, canKeepBoth: false
    });
  }

  set(scope, patch) {
    const state = Object.freeze({ ...this.get(scope), ...patch, updatedAt: Date.now() });
    this.states.set(cloudScopeKey(scope), state);
    this.emit();
    return state;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    listener(this.get());
    return () => this.listeners.delete(listener);
  }

  emit() {
    for (const listener of this.listeners) {
      try { listener(this.get()); } catch (error) { console.warn('[CloudSave] 状态订阅失败', error); }
    }
  }
}

export const cloudSyncState = new CloudSyncState();
