import { stateManager } from '../core/state-manager.js';

const MAIN_AI_CONNECTION_FIELDS = Object.freeze([
  'apiUrl',
  'apiKey',
  'model',
  'backend',
  'disableStreaming',
  'adaptationMode',
  'deepseekThinking'
]);
const AUXILIARY_CONFIG_KEYS = new Set([
  'variableUpdater',
  'narrativeReview',
  'aiCallPolicy'
]);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function assertObjectPatch(patch, label) {
  if (!isRecord(patch)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function mergePatch(current, patch) {
  const next = isRecord(current) ? clone(current) : {};
  for (const key of Object.keys(patch)) {
    if (UNSAFE_KEYS.has(key)) throw new TypeError(`Unsafe configuration key: ${key}`);
    const value = patch[key];
    if (value === undefined) continue;
    next[key] = isRecord(value) ? mergePatch(next[key], value) : clone(value);
  }
  return next;
}

export class SettingsConfigGateway {
  constructor(manager = stateManager) {
    if (!manager?.getAPIConfig || !manager?.saveAPIConfig) {
      throw new TypeError('SettingsConfigGateway requires getAPIConfig() and saveAPIConfig()');
    }
    this.manager = manager;
    this._apiCommitTail = Promise.resolve();
    this._uiCommitTail = Promise.resolve();
  }

  async saveMainAIConnection(patch) {
    assertObjectPatch(patch, 'Main AI connection patch');
    return this._enqueueAPICommit(async () => {
      const current = this.manager.getAPIConfig() || {};
      const next = isRecord(current) ? clone(current) : {};
      delete next.futurePlanner;

      for (const field of MAIN_AI_CONNECTION_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(patch, field) && patch[field] !== undefined) {
          next[field] = clone(patch[field]);
        }
      }

      await this.manager.saveAPIConfig(next);
      return next;
    });
  }

  async saveAuxiliaryConfig(section, patch) {
    if (!AUXILIARY_CONFIG_KEYS.has(section)) {
      throw new TypeError(`Unsupported auxiliary API config: ${section}`);
    }
    assertObjectPatch(patch, `${section} patch`);

    return this._enqueueAPICommit(async () => {
      const current = this.manager.getAPIConfig() || {};
      const next = isRecord(current) ? clone(current) : {};
      delete next.futurePlanner;
      next[section] = mergePatch(current[section], patch);

      await this.manager.saveAPIConfig(next);
      return next;
    });
  }

  async saveUISettings(patch) {
    assertObjectPatch(patch, 'UI settings patch');
    if (!this.manager.getSub || !this.manager.update || !this.manager.saveUIPrefs) {
      throw new TypeError('Saving UI settings requires getSub(), update(), and saveUIPrefs()');
    }

    return this._enqueueUICommit(async () => {
      const current = this.manager.getSub('_ui')?.settings || {};
      const next = mergePatch(current, patch);
      this.manager.update([{ key: '_ui.settings', op: '=', value: next }]);
      await this.manager.saveUIPrefs();
      return next;
    });
  }

  _enqueueAPICommit(operation) {
    const result = this._apiCommitTail.then(operation);
    this._apiCommitTail = result.catch(() => {});
    return result;
  }

  _enqueueUICommit(operation) {
    const result = this._uiCommitTail.then(operation);
    this._uiCommitTail = result.catch(() => {});
    return result;
  }
}

export function createSettingsConfigGateway(manager = stateManager) {
  return new SettingsConfigGateway(manager);
}

export const settingsConfigGateway = createSettingsConfigGateway();
