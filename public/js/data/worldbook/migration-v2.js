import { TIMELINE_ENTRIES } from './timeline.js';
import { DETAILED_TIMELINE_ENTRIES } from './timeline-detailed.js';
import { CHARACTER_ENTRIES } from './characters.js';
import { LOCATION_ORGANIZATION_ENTRIES } from './locations-organizations.js';
import { ARC_ENTRIES } from './arcs.js';
import { SYSTEM_ENTRIES } from './systems.js';
import { EXPANDED_CHARACTER_ENTRIES } from './expanded-characters.js';
import { CHARACTER_DETAIL_ENTRIES } from './character-details.js';
import { CHARACTER_DETAIL_ENTRIES_2 } from './character-details-2.js';
import { CHARACTER_APPEARANCE_ENTRIES } from './character-appearances.js';
import { SHINOBI_ROSTER_ENTRIES_2 } from './shinobi-roster-2.js';
import { BORUTO_ERA_ENTRIES, BORUTO_MISSION_ENTRIES } from './boruto-era.js';
import { ERA_CONSISTENCY_ENTRIES } from './era-consistency.js';
import { WORLD_EXPANSION_ENTRIES } from './world-expansion.js';
import {
  buildStableWorldbookId,
  normalizeWorldbookEntryV2,
  normalizeWorldbookTitle,
  sanitizeWorldbookContent,
  stableWorldbookHash,
  toRuntimeWorldbookEntry,
  validateWorldbookEntryV2
} from './schema-v2.js';

export const LEGACY_WORLD_BOOK_SOURCES = Object.freeze([
  source('timeline.js', 'TIMELINE_ENTRIES', TIMELINE_ENTRIES, 'timeline_reference'),
  source('timeline-detailed.js', 'DETAILED_TIMELINE_ENTRIES', DETAILED_TIMELINE_ENTRIES, 'timeline_reference'),
  source('era-consistency.js', 'ERA_CONSISTENCY_ENTRIES', ERA_CONSISTENCY_ENTRIES, 'era_rule'),
  source('arcs.js', 'ARC_ENTRIES', ARC_ENTRIES, 'plot_reference'),
  source('characters.js', 'CHARACTER_ENTRIES', CHARACTER_ENTRIES, 'character_profile'),
  source('shinobi-roster-2.js', 'SHINOBI_ROSTER_ENTRIES_2', SHINOBI_ROSTER_ENTRIES_2, 'character_profile'),
  source('character-details.js', 'CHARACTER_DETAIL_ENTRIES', CHARACTER_DETAIL_ENTRIES, 'character_profile'),
  source('character-details-2.js', 'CHARACTER_DETAIL_ENTRIES_2', CHARACTER_DETAIL_ENTRIES_2, 'character_profile'),
  source('character-appearances.js', 'CHARACTER_APPEARANCE_ENTRIES', CHARACTER_APPEARANCE_ENTRIES, 'character_profile'),
  source('expanded-characters.js', 'EXPANDED_CHARACTER_ENTRIES', EXPANDED_CHARACTER_ENTRIES, 'character_profile'),
  source('boruto-era.js', 'BORUTO_ERA_ENTRIES', BORUTO_ERA_ENTRIES, 'character_profile'),
  source('boruto-era.js', 'BORUTO_MISSION_ENTRIES', BORUTO_MISSION_ENTRIES, 'plot_reference'),
  source('locations-organizations.js', 'LOCATION_ORGANIZATION_ENTRIES', LOCATION_ORGANIZATION_ENTRIES, 'location_organization'),
  source('world-expansion.js', 'WORLD_EXPANSION_ENTRIES', WORLD_EXPANSION_ENTRIES, 'world_reference'),
  source('systems.js', 'SYSTEM_ENTRIES', SYSTEM_ENTRIES, 'world_rule')
]);

function source(file, exportName, entries, category) {
  return Object.freeze({ file, exportName, entries, category });
}

export function flattenLegacyWorldbookSources(sources = LEGACY_WORLD_BOOK_SOURCES) {
  const records = [];
  let globalIndex = 0;
  for (const group of sources) {
    for (const [sourceIndex, entry] of group.entries.entries()) {
      records.push({
        entry,
        sourceFile: group.file,
        exportName: group.exportName,
        sourceIndex,
        globalIndex: globalIndex++,
        category: group.category
      });
    }
  }
  return records;
}

function normalizeMigrationRecord(record, index, options) {
  const descriptor = record?.entry && typeof record.entry === 'object' ? record : { entry: record };
  const entry = descriptor.entry && typeof descriptor.entry === 'object' ? descriptor.entry : {};
  return {
    entry,
    sourceFile: String(descriptor.sourceFile || options.sourceFile || ''),
    exportName: String(descriptor.exportName || options.exportName || ''),
    sourceIndex: Number.isInteger(descriptor.sourceIndex) ? descriptor.sourceIndex : index,
    globalIndex: Number.isInteger(descriptor.globalIndex) ? descriptor.globalIndex : index,
    category: String(descriptor.category || options.defaultCategory || inferLegacyCategory(entry)),
    sourceKind: String(descriptor.sourceKind || options.sourceKind || 'builtin')
  };
}

function inferLegacyCategory(entry) {
  const title = String(entry?.title || '');
  const text = `${title}\n${(entry?.keys || []).join(' ')}`;
  if (/(?:性格|说话方式|外貌|角色|人物|人柱力|火影|忍者|影】)/.test(text)) return 'character_profile';
  if (/(?:时间线|木叶\d+年|年代|纪年|历史|忍界大战)/.test(text)) return 'timeline_reference';
  if (/(?:篇章|篇$|任务模板)/.test(title)) return 'plot_reference';
  if (/(?:村|国家|组织|一族|地点)/.test(text)) return 'location_organization';
  if (/(?:规则|体系|忍术|体术|幻术|查克拉|血继|封印)/.test(text)) return 'world_rule';
  return 'world_reference';
}

function normalizeIdentityTitle(title) {
  return normalizeWorldbookTitle(title).toLocaleLowerCase('zh-CN');
}

function fragmentId(record) {
  return `wb1-fragment-${stableWorldbookHash([
    record.sourceKind,
    record.sourceFile,
    record.exportName,
    record.sourceIndex,
    record.entry.title
  ].join('|'))}`;
}

function buildSourceFragment(record, sanitized, disposition, duplicateOf = null) {
  return {
    fragment_id: fragmentId(record),
    source: {
      kind: record.sourceKind,
      file: record.sourceFile,
      export_name: record.exportName,
      entry_index: record.sourceIndex,
      global_index: record.globalIndex
    },
    legacy_title: normalizeWorldbookTitle(record.entry.title),
    original_keys: Array.isArray(record.entry.keys) ? [...record.entry.keys] : [],
    original_content: String(record.entry.content || ''),
    original_enabled: record.entry.enabled !== false,
    original_always_on: Boolean(record.entry.isAlwaysOn),
    runtime_content: sanitized.content,
    disposition,
    duplicate_of: duplicateOf,
    safety: {
      sanitized: sanitized.changed,
      minor_context: sanitized.minor_context,
      removed_fragment_count: sanitized.removed_fragments.length,
      reasons: sanitized.reasons,
      removed_fragments: sanitized.removed_fragments.map(item => ({
        reason: item.reason,
        fragment_hash: item.fragment_hash,
        original_fragment: item.fragment
      }))
    }
  };
}

function sameLegacyPayload(left, right) {
  return String(left.entry.content || '') === String(right.entry.content || '')
    && JSON.stringify(left.entry.keys || []) === JSON.stringify(right.entry.keys || [])
    && Boolean(left.entry.isAlwaysOn) === Boolean(right.entry.isAlwaysOn);
}

function mergeUniqueStrings(...collections) {
  const seen = new Set();
  const result = [];
  for (const collection of collections) {
    for (const value of Array.isArray(collection) ? collection : []) {
      const normalized = String(value || '').trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function mergeSafeContent(left, right) {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a) return b;
  if (!b || a === b || a.includes(b)) return a;
  if (b.includes(a)) return b;
  return `${a}\n\n${b}`;
}

function mergeProfiles(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  const result = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (key === 'era_states' && Array.isArray(value)) {
      const states = [...(Array.isArray(result[key]) ? result[key] : []), ...value];
      const seen = new Set();
      result[key] = states.filter(state => {
        const identity = JSON.stringify(state);
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      }).map(state => ({ ...state }));
    } else if (Array.isArray(value)) result[key] = mergeUniqueStrings(result[key], value);
    else if (!result[key] && value) result[key] = value;
  }
  return result;
}

function mergeValidity(left, right) {
  if (!left) return right;
  if (!right) return left;
  // null 表示无限边界，因此合并范围时优先 null。
  const from = left.from == null || right.from == null
    ? null
    : (left.from < right.from ? left.from : right.from);
  const until = left.until == null || right.until == null
    ? null
    : (left.until > right.until ? left.until : right.until);
  return {
    from,
    until,
    precision: left.precision === right.precision ? left.precision : 'unbounded',
    source_text: mergeUniqueStrings([left.source_text, right.source_text]).join(' | ') || null
  };
}

function mergeNormalizedEntries(base, addition) {
  base.keys = mergeUniqueStrings(base.keys, addition.keys);
  base.activation.keys = mergeUniqueStrings(base.activation.keys, addition.activation.keys);
  base.activation.mode = base.activation.mode === 'always' || addition.activation.mode === 'always'
    ? 'always'
    : base.activation.mode;
  base.content = mergeSafeContent(base.content, addition.content);
  base.entity_ids = mergeUniqueStrings(base.entity_ids, addition.entity_ids);
  base.organization_ids = mergeUniqueStrings(base.organization_ids, addition.organization_ids);
  base.validity = mergeValidity(base.validity, addition.validity);
  base.knowledge.audience = mergeUniqueStrings(base.knowledge.audience, addition.knowledge.audience);
  base.knowledge.reveal_conditions = [
    ...base.knowledge.reveal_conditions,
    ...addition.knowledge.reveal_conditions
  ];
  base.character_profile = mergeProfiles(base.character_profile, addition.character_profile);
  base.safety.sanitized ||= addition.safety.sanitized;
  base.safety.minor_context ||= addition.safety.minor_context;
  base.safety.removed_fragment_count += addition.safety.removed_fragment_count;
  base.safety.reasons = mergeUniqueStrings(base.safety.reasons, addition.safety.reasons);
  base.safety.removed_fragment_hashes = mergeUniqueStrings(
    base.safety.removed_fragment_hashes,
    addition.safety.removed_fragment_hashes
  );
  return base;
}

function ensureUniqueStableId(entry, identity, occupied) {
  const existingIdentity = occupied.get(entry.id);
  if (!existingIdentity || existingIdentity === identity) {
    occupied.set(entry.id, identity);
    return entry.id;
  }
  const collisionSuffix = stableWorldbookHash(`${identity}|collision`);
  entry.id = `${buildStableWorldbookId(entry.title, entry.category)}-${collisionSuffix}`;
  occupied.set(entry.id, identity);
  return entry.id;
}

export function migrateWorldbookEntriesV1ToV2(records, options = {}) {
  const normalizedRecords = (Array.isArray(records) ? records : [])
    .map((record, index) => normalizeMigrationRecord(record, index, options));
  const groups = new Map();
  for (const record of normalizedRecords) {
    // Custom entries may share a memo but have different switches/conditions.
    // Merging their bodies can leak a disabled sibling through an enabled one.
    const titleIdentity = normalizeIdentityTitle(record.entry.title || `未命名条目-${record.globalIndex}`);
    const identity = record.sourceKind === 'custom' ? `${titleIdentity}|custom:${record.globalIndex}` : titleIdentity;
    if (!groups.has(identity)) groups.set(identity, []);
    groups.get(identity).push(record);
  }

  const entries = [];
  const duplicateGroups = [];
  const occupiedIds = new Map();
  const entryDispositionCounts = {
    migrated: 0,
    deduplicated_exact: 0,
    merged_complementary: 0
  };
  const inputDispositionCounts = {
    migrated: 0,
    migrated_primary: 0,
    merged_exact_duplicate: 0,
    merged_complementary: 0
  };

  for (const [identity, group] of groups) {
    const primary = group[0];
    let merged = null;
    const sourceFragments = [];
    const exactGroup = group.length > 1 && group.slice(1).every(record => sameLegacyPayload(primary, record));
    let entryDisposition = 'migrated';
    if (group.length > 1) entryDisposition = exactGroup ? 'deduplicated_exact' : 'merged_complementary';
    entryDispositionCounts[entryDisposition] += 1;

    for (const [groupIndex, record] of group.entries()) {
      const sanitized = sanitizeWorldbookContent(record.entry.content, {
        title: record.entry.title,
        keys: record.entry.keys
      });
      const isPrimary = groupIndex === 0;
      const disposition = group.length === 1
        ? 'migrated'
        : (isPrimary
            ? 'migrated_primary'
            : (sameLegacyPayload(primary, record) ? 'merged_exact_duplicate' : 'merged_complementary'));
      inputDispositionCounts[disposition] += 1;
      sourceFragments.push(buildSourceFragment(
        record,
        sanitized,
        disposition,
        isPrimary ? null : fragmentId(primary)
      ));

      const normalized = normalizeWorldbookEntryV2(record.entry, {
        sourceKind: record.sourceKind,
        sourceFile: record.sourceFile,
        exportName: record.exportName,
        sourceIndex: record.sourceIndex,
        category: record.category
      });
      merged = merged ? mergeNormalizedEntries(merged, normalized) : normalized;
    }

    ensureUniqueStableId(merged, identity, occupiedIds);
    merged.source_fragments = sourceFragments;
    merged.migration = {
      disposition: entryDisposition,
      input_fragment_count: group.length,
      original_title: primary.entry.title,
      original_content_preserved: true,
      provenance_complete: sourceFragments.length === group.length
    };
    entries.push(merged);

    if (group.length > 1) {
      duplicateGroups.push({
        title: primary.entry.title,
        output_id: merged.id,
        input_count: group.length,
        disposition: entryDisposition,
        source_fragments: sourceFragments.map(fragment => fragment.fragment_id)
      });
    }
  }

  const validationErrors = [];
  for (const entry of entries) {
    const result = validateWorldbookEntryV2(entry);
    if (!result.valid) validationErrors.push({ id: entry.id, title: entry.title, errors: result.errors });
  }

  const sourceFragmentCount = entries.reduce((sum, entry) => sum + entry.source_fragments.length, 0);
  const sanitizedEntries = entries.filter(entry => entry.safety.sanitized);
  const removedFragmentCount = entries.reduce(
    (sum, entry) => sum + Number(entry.safety.removed_fragment_count || 0),
    0
  );
  const report = {
    schema_version: '2.0',
    input_count: normalizedRecords.length,
    output_count: entries.length,
    source_fragment_count: sourceFragmentCount,
    accounted_input_count: Object.values(inputDispositionCounts).reduce((sum, count) => sum + count, 0),
    entry_dispositions: entryDispositionCounts,
    input_dispositions: inputDispositionCounts,
    duplicate_group_count: duplicateGroups.length,
    duplicate_groups: duplicateGroups,
    sanitized_entry_count: sanitizedEntries.length,
    removed_fragment_count: removedFragmentCount,
    sanitized_entry_ids: sanitizedEntries.map(entry => entry.id),
    validation_error_count: validationErrors.length,
    validation_errors: validationErrors
  };

  if (options.strict !== false) {
    if (report.input_count !== report.source_fragment_count || report.input_count !== report.accounted_input_count) {
      throw new Error(`Worldbook V2 migration lost provenance: input=${report.input_count}, fragments=${report.source_fragment_count}, accounted=${report.accounted_input_count}`);
    }
    if (validationErrors.length) {
      throw new Error(`Worldbook V2 migration produced invalid entries: ${JSON.stringify(validationErrors.slice(0, 5))}`);
    }
  }
  return { entries, report };
}

export function migrateCustomWorldbookEntriesV1ToV2(entries, options = {}) {
  const records = (Array.isArray(entries) ? entries : []).map((entry, index) => ({
    entry,
    sourceKind: 'custom',
    sourceFile: String(options.sourceFile || 'localStorage:naruto_worldbook_custom'),
    exportName: 'CUSTOM_WORLD_BOOK_ENTRIES',
    sourceIndex: index,
    globalIndex: index,
    category: entry?.category || inferLegacyCategory(entry)
  }));
  return migrateWorldbookEntriesV1ToV2(records, {
    ...options,
    sourceKind: 'custom'
  });
}

export function buildWorldbookV2Catalog({ audience = 'writer', date = null } = {}) {
  const records = flattenLegacyWorldbookSources();
  const migration = migrateWorldbookEntriesV1ToV2(records);
  const runtimeEntries = migration.entries
    .map(entry => toRuntimeWorldbookEntry(entry, { audience, date }))
    .filter(Boolean);
  return {
    entries: migration.entries,
    runtime_entries: runtimeEntries,
    report: {
      ...migration.report,
      runtime_entry_count: runtimeEntries.length,
      runtime_audience: audience,
      runtime_date: date
    }
  };
}

export const WORLD_BOOK_V2_CATALOG = buildWorldbookV2Catalog();
export const WORLD_BOOK_V2_ENTRIES = WORLD_BOOK_V2_CATALOG.entries;
export const WORLD_BOOK_V2_RUNTIME_ENTRIES = WORLD_BOOK_V2_CATALOG.runtime_entries;
export const WORLD_BOOK_V2_MIGRATION_REPORT = WORLD_BOOK_V2_CATALOG.report;
