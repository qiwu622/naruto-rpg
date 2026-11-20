import { isWorldbookEntryEnabled, normalizeWorldbookActivation, worldbookKeys } from './activation.js';
import { canonicalCharacterName, normalizeWorldbookTitle, parseLegacyValidity } from './schema-v2.js';

export const BUILTIN_WORLDBOOK_OVERRIDES_KEY = 'naruto_worldbook_builtin_overrides_v1';

let cachedRaw = null;
let cachedStore = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function getBuiltinWorldbookKey(entryOrTitle) {
  const raw = typeof entryOrTitle === 'string'
    ? entryOrTitle
    : (entryOrTitle?._builtinKey || entryOrTitle?._originalTitle || entryOrTitle?.originalTitle || entryOrTitle?.title || '');
  return normalizeWorldbookTitle(raw).toLocaleLowerCase('zh-CN');
}

export function readBuiltinWorldbookOverridesRaw() {
  try {
    if (typeof localStorage === 'undefined') return '';
    return localStorage.getItem(BUILTIN_WORLDBOOK_OVERRIDES_KEY) || '';
  } catch {
    return '';
  }
}

export function normalizeBuiltinOverrideRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = {};
  if (!isWorldbookEntryEnabled(raw)) record.enabled = false;
  if (typeof raw.title === 'string' && raw.title.trim()) {
    record.title = normalizeWorldbookTitle(raw.title);
  }
  if (Array.isArray(raw.keys) || typeof raw.keys === 'string') {
    record.keys = worldbookKeys(raw.keys);
  }
  if (typeof raw.content === 'string') {
    record.content = raw.content;
  }
  if (raw.activation && typeof raw.activation === 'object') {
    const activationKeys = record.keys ?? raw.activation.keys ?? [];
    record.activation = normalizeWorldbookActivation({
      keys: activationKeys,
      activation: raw.activation
    });
  }
  if (Object.keys(record).length === 0) return null;
  if (Number.isFinite(Number(raw.updatedAt))) {
    record.updatedAt = Number(raw.updatedAt);
  }
  return record;
}

export function normalizeBuiltinOverridesStore(raw) {
  const sourceEntries = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw.entries && typeof raw.entries === 'object' && !Array.isArray(raw.entries)
        ? raw.entries
        : ('entries' in raw ? {} : raw))
    : {};
  const entries = {};
  for (const [rawKey, rawRecord] of Object.entries(sourceEntries)) {
    const key = getBuiltinWorldbookKey(rawKey);
    if (!key) continue;
    const normalized = normalizeBuiltinOverrideRecord(rawRecord);
    if (normalized) entries[key] = normalized;
  }
  return { version: 1, entries };
}

export function loadBuiltinWorldbookOverrides() {
  const raw = readBuiltinWorldbookOverridesRaw();
  if (cachedRaw === raw && cachedStore) return clone(cachedStore);
  let parsed = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  const store = normalizeBuiltinOverridesStore(parsed);
  cachedRaw = raw;
  cachedStore = store;
  return clone(store);
}

export function saveBuiltinWorldbookOverridesStore(store) {
  const normalized = normalizeBuiltinOverridesStore(store);
  const hasEntries = Object.keys(normalized.entries).length > 0;
  try {
    if (typeof localStorage !== 'undefined') {
      if (hasEntries) {
        const raw = JSON.stringify(normalized);
        localStorage.setItem(BUILTIN_WORLDBOOK_OVERRIDES_KEY, raw);
        cachedRaw = raw;
      } else {
        localStorage.removeItem(BUILTIN_WORLDBOOK_OVERRIDES_KEY);
        cachedRaw = '';
      }
    } else {
      cachedRaw = hasEntries ? JSON.stringify(normalized) : '';
    }
    cachedStore = normalized;
  } catch {
    cachedRaw = null;
    cachedStore = null;
  }
  return clone(normalized);
}

export function computeBuiltinOverridePatch(baseEntry, editedEntry) {
  if (!baseEntry || typeof baseEntry !== 'object') return null;
  const defaultTitle = normalizeWorldbookTitle(baseEntry.title || '');
  const defaultActivation = normalizeWorldbookActivation(baseEntry);
  const defaultKeys = [...defaultActivation.keys];
  const defaultContent = String(baseEntry.content ?? '');

  const nextEnabled = editedEntry?.enabled !== false;
  const nextTitle = normalizeWorldbookTitle(editedEntry?.title ?? defaultTitle) || defaultTitle;
  const rawEditedKeys = editedEntry?.keys !== undefined
    ? worldbookKeys(editedEntry.keys)
    : (editedEntry?.activation?.keys !== undefined ? worldbookKeys(editedEntry.activation.keys) : [...defaultKeys]);
  const nextActivation = normalizeWorldbookActivation({
    ...baseEntry,
    ...editedEntry,
    keys: rawEditedKeys,
    activation: {
      ...defaultActivation,
      ...(editedEntry?.activation || {}),
      keys: rawEditedKeys
    }
  });
  const nextKeys = [...nextActivation.keys];
  const nextContent = editedEntry?.content !== undefined ? String(editedEntry.content) : defaultContent;

  const record = {};
  if (!nextEnabled) record.enabled = false;
  if (nextTitle !== defaultTitle) record.title = nextTitle;
  if (JSON.stringify(nextKeys) !== JSON.stringify(defaultKeys)) record.keys = nextKeys;
  if (nextContent !== defaultContent) record.content = nextContent;
  if (JSON.stringify(nextActivation) !== JSON.stringify(defaultActivation)) record.activation = nextActivation;

  if (Object.keys(record).length === 0) return null;
  record.updatedAt = Date.now();
  return record;
}

export function applyBuiltinWorldbookOverride(baseEntry, override) {
  const builtinKey = getBuiltinWorldbookKey(baseEntry);
  const defaultActivation = normalizeWorldbookActivation(baseEntry);
  if (!override || typeof override !== 'object') {
    return {
      ...baseEntry,
      _builtinKey: builtinKey,
      _originalTitle: baseEntry.title,
      source: 'builtin',
      enabled: true,
      keys: [...defaultActivation.keys],
      content: String(baseEntry.content ?? ''),
      activation: defaultActivation,
      isAlwaysOn: defaultActivation.mode === 'always',
      _overridden: false,
      _activationOverridden: false,
      _disabled: false,
      _hasOverride: false
    };
  }

  const hasTitleOverride = typeof override.title === 'string' && Boolean(override.title.trim());
  const hasKeysOverride = Array.isArray(override.keys) || Array.isArray(override.activation?.keys);
  const hasContentOverride = typeof override.content === 'string';
  const hasActivationOverride = Boolean(override.activation && typeof override.activation === 'object');
  const keys = Array.isArray(override.keys)
    ? worldbookKeys(override.keys)
    : (Array.isArray(override.activation?.keys) ? worldbookKeys(override.activation.keys) : [...defaultActivation.keys]);
  const activation = normalizeWorldbookActivation({
    ...baseEntry,
    keys,
    activation: {
      ...defaultActivation,
      ...(hasActivationOverride ? override.activation : {}),
      keys
    }
  });
  const enabled = override.enabled !== false;

  return {
    ...baseEntry,
    _builtinKey: builtinKey,
    _originalTitle: baseEntry.title,
    source: 'builtin',
    enabled,
    title: hasTitleOverride ? normalizeWorldbookTitle(override.title) : baseEntry.title,
    keys,
    content: hasContentOverride ? override.content : String(baseEntry.content ?? ''),
    activation,
    isAlwaysOn: activation.mode === 'always',
    _overridden: hasTitleOverride || hasKeysOverride || hasContentOverride || hasActivationOverride,
    _activationOverridden: hasKeysOverride || hasActivationOverride,
    _disabled: !enabled,
    _hasOverride: true
  };
}

export function applyBuiltinWorldbookOverrideV2(baseV2Entry, override) {
  if (!override || typeof override !== 'object') {
    return { entry: baseV2Entry, overrideMeta: null };
  }

  const enabled = override.enabled !== false;
  const hasTitleOverride = typeof override.title === 'string' && Boolean(override.title.trim());
  const hasKeysOverride = Array.isArray(override.keys) || Array.isArray(override.activation?.keys);
  const hasContentOverride = typeof override.content === 'string';
  const hasActivationOverride = Boolean(override.activation && typeof override.activation === 'object');

  const title = hasTitleOverride ? normalizeWorldbookTitle(override.title) : baseV2Entry.title;
  const keys = Array.isArray(override.keys)
    ? worldbookKeys(override.keys)
    : (Array.isArray(override.activation?.keys) ? worldbookKeys(override.activation.keys) : [...(baseV2Entry.keys || [])]);
  const content = hasContentOverride ? override.content : baseV2Entry.content;
  const activation = normalizeWorldbookActivation({
    ...baseV2Entry,
    keys,
    activation: {
      ...(baseV2Entry.activation || {}),
      ...(hasActivationOverride ? override.activation : {}),
      keys
    }
  });
  const validity = hasContentOverride ? parseLegacyValidity(content) : baseV2Entry.validity;

  let characterProfile = baseV2Entry.character_profile;
  if (characterProfile && hasTitleOverride) {
    const canonical = canonicalCharacterName(title);
    const names = [...new Set([canonical, ...(characterProfile.names || [])].filter(Boolean))];
    characterProfile = {
      ...characterProfile,
      names: names.length ? names : [...(characterProfile.names || [])]
    };
  }

  return {
    entry: {
      ...baseV2Entry,
      title,
      keys,
      content,
      activation,
      validity,
      enabled,
      status: enabled ? (baseV2Entry.status === 'disabled' ? 'active' : baseV2Entry.status) : 'disabled',
      character_profile: characterProfile
    },
    overrideMeta: {
      hasContentOverride,
      hasActivationOverride: hasActivationOverride || hasKeysOverride,
      originalAlwaysOn: baseV2Entry.activation?.mode === 'always'
    }
  };
}

export function setBuiltinWorldbookEntryOverride(baseEntry, editedEntry) {
  const key = getBuiltinWorldbookKey(baseEntry);
  if (!key) return loadBuiltinWorldbookOverrides();
  const store = loadBuiltinWorldbookOverrides();
  const patch = computeBuiltinOverridePatch(baseEntry, editedEntry);
  if (patch) store.entries[key] = patch;
  else delete store.entries[key];
  return saveBuiltinWorldbookOverridesStore(store);
}

export function setBuiltinWorldbookEntryEnabled(baseEntry, enabled) {
  const key = getBuiltinWorldbookKey(baseEntry);
  if (!key) return loadBuiltinWorldbookOverrides();
  const store = loadBuiltinWorldbookOverrides();
  const merged = applyBuiltinWorldbookOverride(baseEntry, store.entries[key] || null);
  merged.enabled = Boolean(enabled);
  const patch = computeBuiltinOverridePatch(baseEntry, merged);
  if (patch) store.entries[key] = patch;
  else delete store.entries[key];
  return saveBuiltinWorldbookOverridesStore(store);
}

export function setAllBuiltinWorldbookEnabled(baseEntries, enabled) {
  const store = loadBuiltinWorldbookOverrides();
  if (enabled) {
    for (const [key, record] of Object.entries(store.entries)) {
      if (!record || typeof record !== 'object') {
        delete store.entries[key];
        continue;
      }
      const next = { ...record };
      delete next.enabled;
      const cleaned = normalizeBuiltinOverrideRecord(next);
      if (cleaned) {
        cleaned.updatedAt = Date.now();
        store.entries[key] = cleaned;
      } else {
        delete store.entries[key];
      }
    }
  } else {
    const now = Date.now();
    for (const baseEntry of baseEntries || []) {
      const key = getBuiltinWorldbookKey(baseEntry);
      if (!key) continue;
      store.entries[key] = {
        ...(store.entries[key] || {}),
        enabled: false,
        updatedAt: now
      };
    }
  }
  return saveBuiltinWorldbookOverridesStore(store);
}

export function resetBuiltinWorldbookEntry(entryOrTitle) {
  const key = getBuiltinWorldbookKey(entryOrTitle);
  const store = loadBuiltinWorldbookOverrides();
  if (key) delete store.entries[key];
  return saveBuiltinWorldbookOverridesStore(store);
}

export function clearBuiltinWorldbookOverrides() {
  return saveBuiltinWorldbookOverridesStore({ version: 1, entries: {} });
}
