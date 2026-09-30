import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {
  WORLD_BOOK_ENTRIES,
  WORLD_BOOK_V2_JSON_SCHEMA,
  WORLD_BOOK_V2_ENTRIES,
  WORLD_BOOK_V2_RUNTIME_ENTRIES,
  WORLD_BOOK_V2_MIGRATION_REPORT,
  normalizeWorldbookEntryV2,
  validateWorldbookEntryV2,
  sanitizeWorldbookContent,
  migrateCustomWorldbookEntriesV1ToV2,
  toRuntimeWorldbookEntry
} from '../js/data/worldbook/index.js';
import {
  flattenLegacyWorldbookSources,
  migrateWorldbookEntriesV1ToV2
} from '../js/data/worldbook/migration-v2.js';
import { WorldbookV2Resolver } from '../js/data/worldbook/runtime-resolver.js';

const records = flattenLegacyWorldbookSources();
const uniqueLegacyTitles = new Set(records.map(record => String(record.entry.title || '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN')));
const titleGroups = new Map();
for (const record of records) {
  const key = String(record.entry.title || '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
  if (!titleGroups.has(key)) titleGroups.set(key, []);
  titleGroups.get(key).push(record);
}
const expectedDuplicateGroups = [...titleGroups.values()].filter(group => group.length > 1);

assert.equal(records.length, WORLD_BOOK_ENTRIES.length, 'V2 source inventory must cover every legacy builtin entry');
assert.equal(WORLD_BOOK_V2_ENTRIES.length, uniqueLegacyTitles.size, 'one V2 entry must exist per normalized legacy title');
assert.equal(WORLD_BOOK_V2_MIGRATION_REPORT.input_count, records.length);
assert.equal(WORLD_BOOK_V2_MIGRATION_REPORT.output_count, uniqueLegacyTitles.size);
assert.equal(WORLD_BOOK_V2_MIGRATION_REPORT.source_fragment_count, records.length);
assert.equal(WORLD_BOOK_V2_MIGRATION_REPORT.accounted_input_count, records.length);
assert.equal(WORLD_BOOK_V2_MIGRATION_REPORT.duplicate_group_count, expectedDuplicateGroups.length);
assert.equal(WORLD_BOOK_V2_MIGRATION_REPORT.validation_error_count, 0);

const ids = WORLD_BOOK_V2_ENTRIES.map(entry => entry.id);
assert.equal(new Set(ids).size, ids.length, 'V2 stable IDs must be unique');
const validateJsonSchema = new Ajv({ allErrors: true }).compile(WORLD_BOOK_V2_JSON_SCHEMA);
for (const entry of WORLD_BOOK_V2_ENTRIES) {
  assert.equal(validateJsonSchema(entry), true, `${entry.title}: ${JSON.stringify(validateJsonSchema.errors)}`);
  const validation = validateWorldbookEntryV2(entry);
  assert.equal(validation.valid, true, `${entry.title}: ${validation.errors.join('; ')}`);
  assert.equal(entry.migration.provenance_complete, true);
  assert.equal(entry.source_fragments.length, entry.migration.input_fragment_count);
}

// 每个旧片段都可按文件、导出名和下标原样追溯；净化只影响 runtime_content。
const provenance = new Map();
for (const entry of WORLD_BOOK_V2_ENTRIES) {
  for (const fragment of entry.source_fragments) {
    const key = `${fragment.source.file}|${fragment.source.export_name}|${fragment.source.entry_index}`;
    assert.equal(provenance.has(key), false, `duplicate provenance key: ${key}`);
    provenance.set(key, fragment);
  }
}
for (const record of records) {
  const key = `${record.sourceFile}|${record.exportName}|${record.sourceIndex}`;
  const fragment = provenance.get(key);
  assert.ok(fragment, `missing provenance: ${key}`);
  assert.equal(fragment.original_content, String(record.entry.content || ''));
  assert.deepEqual(fragment.original_keys, record.entry.keys || []);
}

// 重复标题必须具有显式去向，不能由 Map 覆盖后静默消失。
for (const duplicate of WORLD_BOOK_V2_MIGRATION_REPORT.duplicate_groups) {
  assert.ok(['deduplicated_exact', 'merged_complementary'].includes(duplicate.disposition));
  assert.equal(duplicate.source_fragments.length, duplicate.input_count);
}
assert.ok(WORLD_BOOK_V2_MIGRATION_REPORT.entry_dispositions.deduplicated_exact > 0);
assert.ok(WORLD_BOOK_V2_MIGRATION_REPORT.entry_dispositions.merged_complementary > 0);

// 同一批输入重复执行迁移时，ID 和处置结果必须稳定。
const rebuilt = migrateWorldbookEntriesV1ToV2(records);
assert.deepEqual(
  rebuilt.entries.map(entry => [entry.title, entry.id, entry.migration.disposition]),
  WORLD_BOOK_V2_ENTRIES.map(entry => [entry.title, entry.id, entry.migration.disposition])
);

const forbiddenRuntime = /(?:乳头|乳晕|双乳|巨乳|阴毛|小穴|大阴唇|小阴唇|后穴|穴口|爱液|媚肉|花壶|蜜穴|肉棒|阴茎|阴囊|龟头|包皮|阴蒂|性器|床笫|发情|性交|交媾|强奸|奸淫|高潮|勃起|乳交|肛交|痴女|肉欲|情欲|性感|妖娆|火辣|惹火|撩人|肉感|少妇)/i;
assert.ok(WORLD_BOOK_V2_MIGRATION_REPORT.sanitized_entry_count > 0, 'polluted legacy fragments should be detected');
assert.ok(WORLD_BOOK_V2_MIGRATION_REPORT.removed_fragment_count > 0, 'unsafe fragments should be removed');
for (const entry of WORLD_BOOK_V2_RUNTIME_ENTRIES) {
  assert.equal(forbiddenRuntime.test(entry.content), false, `unsafe runtime content: ${entry.title}`);
  assert.equal(forbiddenRuntime.test(JSON.stringify(entry.character_profile || {})), false, `unsafe runtime profile: ${entry.title}`);
  assert.equal('source_fragments' in entry, false, 'runtime projection must hide original fragments');
  assert.equal('migration' in entry, false, 'runtime projection must hide migration internals');
  assert.deepEqual(Object.keys(entry.source), ['kind'], 'runtime source must expose provenance kind only');
  const validation = validateWorldbookEntryV2(entry, { runtime: true });
  assert.equal(validation.valid, true, `${entry.title}: ${validation.errors.join('; ')}`);
}
const serializedRuntime = JSON.stringify(WORLD_BOOK_V2_RUNTIME_ENTRIES);
assert.equal(serializedRuntime.includes('original_content'), false);
assert.equal(serializedRuntime.includes('original_fragment'), false);

const minorFixture = `[测试角色]\n核心性格：谨慎、善良，遇到同伴受伤时会主动帮忙。\n当前状态：12岁，仍在忍校学习。\n外貌特征：黑色短发，穿整洁的训练服。她尚未发育的小穴被描写得十分露骨。\n行为边界：不会无理由伤害同学。`;
const sanitizedMinor = sanitizeWorldbookContent(minorFixture, { title: '测试角色', keys: ['测试角色'] });
assert.equal(sanitizedMinor.changed, true);
assert.ok(sanitizedMinor.reasons.includes('minor_sexualization'));
assert.match(sanitizedMinor.content, /谨慎、善良/);
assert.match(sanitizedMinor.content, /不会无理由伤害同学/);
assert.doesNotMatch(sanitizedMinor.content, forbiddenRuntime);

const narutoProfile = WORLD_BOOK_V2_ENTRIES.find(entry => entry.title === '漩涡鸣人·性格细节')?.character_profile;
assert.ok(narutoProfile, 'legacy character persona must become a structured profile');
assert.ok(narutoProfile.personality_core.some(value => value.includes('渴望被认可')));
assert.ok(narutoProfile.speech_style.some(value => value.includes('直白')));
assert.ok(narutoProfile.goals.some(value => value.includes('被村子承认')));
assert.ok(narutoProfile.weaknesses.some(value => value.includes('冲动')));
assert.ok(narutoProfile.era_states.some(value => value.label === '木叶52年' && value.from === 'K052-01-01'));

const earlyNaruto = WORLD_BOOK_V2_ENTRIES.find(entry => entry.title === '【早期】漩涡鸣人');
assert.ok(toRuntimeWorldbookEntry(earlyNaruto, { audience: 'writer', date: 'K052-05-01' }));
assert.equal(toRuntimeWorldbookEntry(earlyNaruto, { audience: 'writer', date: 'K064-01-01' }), null);

const secretFixture = normalizeWorldbookEntryV2({
  title: '后台秘密',
  keys: ['后台秘密'],
  content: '只有规划器应当读取。',
  knowledge: { visibility: 'secret', audience: ['planner'], reveal_conditions: ['剧情揭示后'] }
});
assert.equal(toRuntimeWorldbookEntry(secretFixture, { audience: 'writer' }), null);
assert.ok(toRuntimeWorldbookEntry(secretFixture, { audience: 'planner' }));

const customMigration = migrateCustomWorldbookEntriesV1ToV2([{
  title: '玩家自定义角色',
  keys: ['自定义角色'],
  enabled: false,
  content: '核心性格：沉稳，信守承诺。\n当前状态：16岁。\n露骨内容：她的小穴不应进入运行时。'
}]);
assert.equal(customMigration.entries.length, 1);
const custom = customMigration.entries[0];
assert.equal(custom.enabled, false, 'migration must preserve the disabled switch');
assert.equal(custom.status, 'legacy_trusted_public');
assert.equal(custom.activation.mode, 'keyword');
assert.equal(custom.knowledge.visibility, 'public');
assert.ok(custom.knowledge.audience.includes('writer'));
assert.match(custom.source_fragments[0].original_content, /小穴/, 'custom original must remain auditable');
assert.equal(toRuntimeWorldbookEntry(custom, { audience: 'writer' }), null);
const customRuntime = toRuntimeWorldbookEntry({ ...custom, enabled: true }, { audience: 'writer' });
assert.ok(customRuntime);
assert.doesNotMatch(customRuntime.content, forbiddenRuntime);
assert.equal('source_fragments' in customRuntime, false);

const stateAwareResolver = new WorldbookV2Resolver({ customLoader: () => [] });
const flatBloodlineResolution = stateAwareResolver.resolve({
  query: '',
  state: {
    '技能·血继限界·冰遁·名称': '冰遁',
    '技能·血继限界·冰遁·描述': '融合水与风形成冰晶。'
  },
  currentDate: 'K052-01-01',
  audience: 'planner',
  maxEntries: 30,
  budget: 100_000
});
assert.ok(
  flatBloodlineResolution.entries.some(entry => entry.title === '血继家族年代处理'),
  'empty queries must use legacy flat bloodline state to retrieve Ice Release / Yuki clan context'
);
assert.ok(
  flatBloodlineResolution.entries.some(entry => entry.title === '【雪之少年】白'),
  'flat Ice Release state must retrieve related canonical character context'
);

const nestedBloodlineResolution = stateAwareResolver.resolve({
  query: '',
  state: {
    skills: {
      kekkei_genkai: {
        冰遁: { name: '冰遁', description: '水与风的血继限界。' }
      }
    }
  },
  currentDate: 'K052-01-01',
  audience: 'planner',
  maxEntries: 30,
  budget: 100_000
});
assert.ok(
  nestedBloodlineResolution.entries.some(entry => entry.title === '血继家族年代处理'),
  'empty queries must also use nested skills.kekkei_genkai state'
);

const budgetTrimmedCharacters = stateAwareResolver.resolve({
  query: '宇智波佐助、春野樱与旗木卡卡西都在训练场等待。',
  state: {},
  currentDate: 'K052-07-15',
  audience: 'planner',
  maxEntries: 1,
  budget: 1
});
const mentionedCharacterNames = new Set(
  (budgetTrimmedCharacters.character_mentions || []).map(item => item.canonical_name)
);
for (const name of ['宇智波佐助', '春野樱', '旗木卡卡西']) {
  assert.equal(mentionedCharacterNames.has(name), true, `${name} must survive prompt-budget trimming as a trusted mention`);
}
const selectedCharacterNames = new Set(
  budgetTrimmedCharacters.entries.flatMap(entry => entry.character_profile?.names || [])
);
assert.ok(
  ['宇智波佐助', '春野樱', '旗木卡卡西'].some(name => !selectedCharacterNames.has(name)),
  'fixture must actually trim at least one mentioned character profile from prompt entries'
);

const descriptiveKeywords = stateAwareResolver.resolve({
  query: '医疗忍者用怪力拦住了复仇者。',
  state: {},
  currentDate: 'K052-07-15',
  audience: 'planner',
  maxEntries: 1,
  budget: 1
});
assert.deepEqual(descriptiveKeywords.character_mentions, [], 'profile aliases and keywords are not trusted identities');

console.log(`worldbook-v2-regression: OK (${records.length} legacy fragments -> ${WORLD_BOOK_V2_ENTRIES.length} V2 entries, ${WORLD_BOOK_V2_MIGRATION_REPORT.removed_fragment_count} unsafe fragments isolated)`);
