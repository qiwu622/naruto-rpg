// Shared by import, storage and prompt resolution. Being a custom entry is
// provenance, never permission to ignore its enabled flag or trigger rules.
const MODES = new Set(['keyword', 'always', 'manual']);
const LOGIC = ['and_any', 'not_all', 'not_any', 'and_all'];
const isTrue = value => value === true || value === 1 || value === 'true' || value === '1';
const isFalse = value => value === false || value === 0 || value === 'false' || value === '0';

export function worldbookKeys(value) {
  let values = Array.isArray(value) ? value : [];
  if (typeof value === 'string') {
    values = [];
    let token = '', regex = false, escaped = false, charClass = false;
    for (const char of value) {
      if (char === '/' && !token.trim()) { regex = true; token += char; continue; }
      if (regex) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '[') charClass = true;
        else if (char === ']') charClass = false;
        else if (char === '/' && !charClass) regex = false;
      } else if (/[,，\n]/u.test(char)) {
        values.push(token); token = ''; continue;
      }
      token += char;
    }
    values.push(token);
  }
  return [...new Set(values.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))];
}

export function isWorldbookEntryEnabled(entry = {}) {
  return !isFalse(entry.enabled) && !isTrue(entry.disable) && !isTrue(entry.disabled)
    && entry.status !== 'disabled' && entry.status !== 'quarantined';
}

export function normalizeWorldbookActivation(entry = {}) {
  const supplied = entry.activation || {};
  const keys = worldbookKeys(entry.keys ?? entry.key ?? supplied.keys);
  const secondaryKeys = worldbookKeys(supplied.secondary_keys ?? entry.keysecondary ?? entry.secondary_keys);
  const suppliedLogic = supplied.selective_logic ?? entry.selectiveLogic ?? entry.extensions?.selectiveLogic ?? 0;
  const logic = LOGIC.includes(suppliedLogic) ? suppliedLogic : (LOGIC[Number(suppliedLogic)] || 'and_any');
  return {
    mode: MODES.has(supplied.mode) ? supplied.mode
      : (isTrue(entry.constant ?? entry.isAlwaysOn) ? 'always' : 'keyword'),
    keys,
    secondary_keys: secondaryKeys,
    selective: !isFalse(supplied.selective ?? entry.selective) && secondaryKeys.length > 0,
    selective_logic: logic,
    case_sensitive: isTrue(supplied.case_sensitive ?? entry.caseSensitive ?? entry.case_sensitive ?? entry.extensions?.case_sensitive),
    match_whole_words: isTrue(supplied.match_whole_words ?? entry.matchWholeWords ?? entry.extensions?.match_whole_words)
  };
}

export function normalizeCustomWorldbookEntry(entry = {}, index = 0) {
  const activation = normalizeWorldbookActivation(entry);
  const normalized = {
    ...entry,
    title: [entry.title, entry.comment, entry.name, activation.keys[0]].find(value => typeof value === 'string' && value.trim())?.trim() || `导入条目 ${index + 1}`,
    keys: [...activation.keys],
    content: String(entry.content || ''),
    enabled: isWorldbookEntryEnabled(entry),
    activation,
    source: 'custom'
  };
  // Canonical fields are the editable truth after import; stale aliases must
  // not override a later enable/disable or keyword edit.
  for (const key of ['disable', 'disabled', 'constant', 'isAlwaysOn', 'key', 'keysecondary', 'secondary_keys',
    'selective', 'selectiveLogic', 'caseSensitive', 'case_sensitive', 'matchWholeWords']) delete normalized[key];
  if (normalized.status === 'disabled') delete normalized.status;
  if (normalized.id != null && !/^wb2-[a-z_]+-[a-f0-9]{8}(?:-[a-f0-9]{8})?$/u.test(normalized.id)) delete normalized.id;
  return normalized;
}

export function importWorldbookEntries(value) {
  const collection = Array.isArray(value) ? value : (value?.custom ?? value?.entries ?? value?.character_book?.entries);
  if (!collection || typeof collection !== 'object') throw new Error('无效的世界书格式');
  return (Array.isArray(collection) ? collection : Object.values(collection))
    .filter(entry => entry && typeof entry === 'object' && typeof entry.content === 'string')
    .map(normalizeCustomWorldbookEntry);
}

function matchesKey(key, text, activation) {
  // Invalid regex keys fail closed, instead of becoming an always-on entry.
  if (key.startsWith('/')) {
    const delimiter = key.lastIndexOf('/');
    if (delimiter > 0) {
      try { return new RegExp(key.slice(1, delimiter), key.slice(delimiter + 1)).test(text); }
      catch { return false; }
    }
  }
  const fold = value => activation.case_sensitive ? value.normalize('NFKC') : value.normalize('NFKC').toLocaleLowerCase('zh-CN');
  const needle = fold(key);
  const haystack = fold(text);
  if (!activation.match_whole_words) return haystack.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(haystack);
}

export function matchesWorldbookActivation(entry, text = '') {
  if (!isWorldbookEntryEnabled(entry)) return false;
  const activation = normalizeWorldbookActivation(entry);
  if (activation.mode === 'manual') return false;
  if (activation.mode === 'always') return true;
  const matches = key => matchesKey(key, String(text), activation);
  if (!activation.keys.some(matches)) return false;
  if (!activation.selective || !activation.secondary_keys.length) return true;
  const secondary = activation.secondary_keys.map(matches);
  switch (activation.selective_logic) {
    case 'and_all': return secondary.every(Boolean);
    case 'not_any': return !secondary.some(Boolean);
    case 'not_all': return !secondary.every(Boolean);
    default: return secondary.some(Boolean);
  }
}
