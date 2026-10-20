import assert from 'node:assert/strict';
import {
  normalizeWorldbookEntryV2, sanitizeWorldbookContent,
  validateWorldbookEntryV2, toRuntimeWorldbookEntry
} from '../js/data/worldbook/schema-v2.js';
import { migrateCustomWorldbookEntriesV1ToV2 } from '../js/data/worldbook/migration-v2.js';
import { WorldbookV2Resolver } from '../js/data/worldbook/runtime-resolver.js';

const content = '  [自定义成人档案]\r\n核心性格：谨慎、善良，喜欢火辣的菜肴。\r\n外貌特征：成人礼服采用性感剪裁。\r\n\r\n\r\n附注：保留全部格式、标点和这段未分类说明。  \r\n';
const input = { title: '自定义成人档案', keys: ['成人档案', '性感剪裁'], content };
const cleaned = sanitizeWorldbookContent(content, input);
assert.equal(cleaned.content, content, 'compatibility helper must preserve the complete original text');
assert.equal(cleaned.changed, false);
assert.deepEqual(cleaned.removed_fragments, []);
const normalized = normalizeWorldbookEntryV2(input, { sourceKind: 'custom' });
assert.equal(normalized.content, content);
assert.deepEqual(normalized.keys, input.keys);
assert.equal(validateWorldbookEntryV2(normalized).valid, true);
assert.equal(toRuntimeWorldbookEntry(normalized).content, content);

const profileInput = { ...input, category: 'character_profile', character_profile: {
  personality_core: ['喜欢火辣的菜肴'], safe_appearance: ['成人礼服采用性感剪裁'],
  era_states: [{ label: '木叶52年', from: 'K052-01-01', until: 'K053-01-01', content: '参加成人礼服展，偏爱性感剪裁。' }]
} };
const profile = normalizeWorldbookEntryV2(profileInput, { sourceKind: 'custom' });
assert.deepEqual(profile.character_profile.safe_appearance, profileInput.character_profile.safe_appearance);
assert.deepEqual(profile.character_profile.era_states, profileInput.character_profile.era_states);
assert.equal(validateWorldbookEntryV2(profile).valid, true);

const migrated = migrateCustomWorldbookEntriesV1ToV2([input]);
assert.equal(migrated.entries[0].content, content);
assert.equal(migrated.entries[0].source_fragments[0].original_content, content);
assert.equal(migrated.entries[0].source_fragments[0].runtime_content, content);
const resolver = new WorldbookV2Resolver({ builtinEntries: [], customLoader: () => [profileInput] });
const resolved = resolver.resolve({ query: '成人档案', audience: 'writer', currentDate: 'K052-06-01', budget: 100000 });
assert.equal(resolved.entries.length, 1);
assert.equal(resolved.entries[0].content, content, 'custom character entries must also reach the runtime without being rewritten');
console.log('PASS worldbook content: original bytes, keywords, profile fields, migration and runtime resolver preserved');
