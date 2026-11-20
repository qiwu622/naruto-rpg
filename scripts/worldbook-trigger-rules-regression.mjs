import assert from 'node:assert/strict';
import { importWorldbookEntries, normalizeCustomWorldbookEntry, matchesWorldbookActivation, worldbookKeys } from '../js/data/worldbook/activation.js';
import { WorldbookV2Resolver } from '../js/data/worldbook/runtime-resolver.js';
import { KNOWLEDGE_BASE } from '../js/data/knowledge-base.js';

let passed = 0;
const test = (label, fn) => { fn(); passed++; console.log('PASS ' + label); };
const fixture = (overrides = {}) => ({ title: '灯火', keys: ['叶舟'], content: 'CONTENT_SENTINEL。灯火是普通环境描写。', enabled: true, ...overrides });
const resolve = (entries, query = '', options = {}) => new WorldbookV2Resolver({ builtinEntries: [], customLoader: () => entries }).resolve({ query, audience: 'writer', ...options });
const contains = (result, marker) => JSON.stringify(result.entries).includes(marker);

test('disabled aliases override blue and matching keywords in every import shape', () => {
  for (const flag of [{ enabled: false }, { disable: true }, { disabled: true }, { enabled: 'false' }, { disable: 1 }, { status: 'disabled' }, { status: 'quarantined' }]) {
    for (const pack of [rows => rows, rows => ({ custom: rows }), rows => ({ entries: rows }), rows => ({ entries: { 0: rows[0] } })]) {
      const entries = importWorldbookEntries(pack([fixture({ constant: true, ...flag })]));
      assert.equal(entries[0].enabled, false);
      assert.deepEqual(resolve(entries, '叶舟').entries, []);
    }
  }
});

test('green needs a primary key, not a title, body substring or generic relevance', () => {
  const entry = fixture({ title: '叶舟在空地', keys: ['秘密触发词'], content: '空地上等待。灯火明亮。', constant: false });
  assert.deepEqual(resolve([entry], '叶舟在空地上等待灯火').entries, []);
  assert.equal(resolve([entry], '秘密触发词').entries.length, 1);
  assert.deepEqual(resolve([fixture({ keys: [], constant: false })], '灯火').entries, []);
});

test('blue is explicit, manual never auto-injects, and legacy green defaults are preserved', () => {
  assert.equal(resolve([fixture({ isAlwaysOn: true })]).entries.length, 1);
  assert.equal(resolve([fixture({ constant: true })]).custom_always_on_count, 1);
  assert.equal(resolve([fixture({ isAlwaysOn: true, constant: false })]).entries.length, 0);
  assert.equal(resolve([fixture()], '叶舟').custom_always_on_count, 0);
  assert.equal(resolve([fixture()]).entries.length, 0);
  assert.equal(resolve([fixture({ activation: { mode: 'manual' } })], '叶舟').entries.length, 0);
});

test('SillyTavern primary and secondary keywords retain their separate conditions', () => {
  const entry = importWorldbookEntries({ entries: { 0: { comment: '条件条目', key: ['主钥'], keysecondary: ['副钥'], selective: true, constant: false, content: 'CONDITIONAL_SENTINEL' } } })[0];
  assert.deepEqual(entry.keys, ['主钥']);
  assert.deepEqual(entry.activation.secondary_keys, ['副钥']);
  assert.equal(resolve([entry], '主钥').entries.length, 0);
  assert.equal(resolve([entry], '副钥').entries.length, 0);
  assert.equal(resolve([entry], '主钥与副钥').entries.length, 1);
});

test('all four secondary-key logic modes and selective=false behave correctly', () => {
  // ST enum: AND_ANY=0, NOT_ALL=1, NOT_ANY=2, AND_ALL=3.
  const expected = [[false, true, true], [true, true, false], [true, false, false], [false, false, true]];
  for (let logic = 0; logic < 4; logic++) {
    const entry = fixture({ keys: ['主钥'], keysecondary: ['副甲', '副乙'], selective: true, selectiveLogic: logic });
    assert.deepEqual(['主钥', '主钥副甲', '主钥副甲副乙'].map(query => resolve([entry], query).entries.length > 0), expected[logic]);
    assert.equal(resolve([entry], '副甲副乙').entries.length, 0);
  }
  assert.equal(resolve([fixture({ keysecondary: ['副甲'], selective: false })], '叶舟').entries.length, 1);
});

test('case, whole words, regex keys and malformed regex survive the actual resolver', () => {
  assert.deepEqual(worldbookKeys('叶舟, /leaf\\s+\\d{1,3}/i, /a[\\/,]b/i，星海'), ['叶舟', '/leaf\\s+\\d{1,3}/i', '/a[\\/,]b/i', '星海']);
  assert.equal(resolve([fixture({ keys: ['Leaf'], caseSensitive: true })], 'leaf').entries.length, 0);
  assert.equal(resolve([fixture({ keys: ['Leaf'], caseSensitive: true })], 'Leaf').entries.length, 1);
  assert.equal(resolve([fixture({ keys: ['king'], matchWholeWords: true })], 'liking').entries.length, 0);
  assert.equal(resolve([fixture({ keys: ['king'], matchWholeWords: true })], 'the king.').entries.length, 1);
  assert.equal(resolve([fixture({ keys: ['/leaf\\s+\\d{1,3}/i'] })], 'LEAF 42').entries.length, 1);
  assert.equal(resolve([fixture({ keys: ['/[/'] })], 'anything').entries.length, 0);
});

test('same-title custom siblings never merge disabled content or different triggers', () => {
  const entries = [
    fixture({ keys: ['甲'], content: 'ENABLED_SIBLING' }),
    fixture({ keys: ['乙'], content: 'DISABLED_SIBLING', enabled: false }),
    fixture({ keys: ['丙'], content: 'UNMATCHED_SIBLING' })
  ];
  const result = resolve(entries, '甲');
  assert.equal(result.entries.length, 1);
  assert.equal(contains(result, 'ENABLED_SIBLING'), true);
  assert.equal(contains(result, 'DISABLED_SIBLING'), false);
  assert.equal(contains(result, 'UNMATCHED_SIBLING'), false);
});

test('custom always-on and first oversized entries cannot bypass entry or character limits', () => {
  const rows = Array.from({ length: 100 }, (_, i) => fixture({ title: '常驻条目' + i, keys: [], constant: true, content: '内容。'.repeat(500) }));
  const bounded = resolve(rows, '', { maxEntries: 3, budget: 5000 });
  assert.ok(bounded.entries.length > 0 && bounded.entries.length <= 3);
  assert.ok(JSON.stringify(bounded.entries).length <= 5000);
  assert.ok(bounded.budget_skipped_ids.length > 0);
  assert.equal(bounded.custom_always_on_count, bounded.entries.length);
  assert.deepEqual(resolve(rows, '', { maxEntries: 0 }).entries, []);
  assert.deepEqual(resolve(rows, '', { budget: 0 }).entries, []);
  const large = fixture({ constant: true, content: 'HUGE_SENTINEL' + '大'.repeat(20_000) });
  assert.equal(contains(resolve([large], '', { budget: 1000 }), 'HUGE_SENTINEL'), false);
  assert.equal(contains(resolve([large, fixture({ title: '小条目', constant: true, content: 'SMALL_SENTINEL' })], '', { budget: 2000 }), 'SMALL_SENTINEL'), true);
});

test('native export and reimport preserve switches, mode and secondary conditions', () => {
  const entries = importWorldbookEntries({ entries: {
    0: { comment: '常驻', constant: true, key: [], content: '常驻正文' },
    1: { comment: '条件', constant: false, key: ['主'], keysecondary: ['次'], selectiveLogic: 2, content: '条件正文' },
    2: { comment: '关闭', constant: true, disable: true, key: [], content: '关闭正文' }
  } });
  const roundTrip = importWorldbookEntries(JSON.parse(JSON.stringify({ custom: entries })));
  assert.deepEqual(roundTrip, entries);
  assert.equal(matchesWorldbookActivation(roundTrip[1], '主次'), false);
  assert.equal(matchesWorldbookActivation(roundTrip[1], '主'), true);
});

test('updated top-level keys take precedence over old activation keys', () => {
  const entry = fixture({ keys: ['新钥'], activation: { mode: 'keyword', keys: ['旧钥'] } });
  assert.equal(resolve([entry], '旧钥').entries.length, 0);
  assert.equal(resolve([entry], '新钥').entries.length, 1);
});

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
const reset = () => { storage.clear(); KNOWLEDGE_BASE.invalidateCache(); };
try {
  test('old global worldbook migration preserves disabled state without opening the editor', () => {
    reset();
    localStorage.setItem('naruto_worldbook', JSON.stringify([fixture({ enabled: false }), fixture({ title: '旧常驻', isAlwaysOn: true, content: 'LEGACY_BLUE' })]));
    const resolver = new WorldbookV2Resolver({ builtinEntries: [] });
    const result = resolver.resolve({ query: '叶舟' });
    assert.equal(contains(result, 'CONTENT_SENTINEL'), false);
    assert.equal(contains(result, 'LEGACY_BLUE'), true);
    assert.equal(JSON.parse(localStorage.getItem('naruto_worldbook_custom'))[0].enabled, false);
  });

  test('legacy knowledge search obeys the same green and disabled rules', () => {
    reset();
    KNOWLEDGE_BASE.saveCustomEntries([fixture(), fixture({ title: '常驻', constant: true, enabled: false, content: 'DISABLED_SENTINEL' })]);
    assert.equal(JSON.stringify(KNOWLEDGE_BASE.search('灯火是普通环境描写')).includes('CONTENT_SENTINEL'), false);
    assert.equal(JSON.stringify(KNOWLEDGE_BASE.search('叶舟')).includes('CONTENT_SENTINEL'), true);
    assert.equal(JSON.stringify(KNOWLEDGE_BASE.search('叶舟')).includes('DISABLED_SENTINEL'), false);
  });

  test('saving or changing storage invalidates both search and prompt caches immediately', () => {
    reset();
    const active = normalizeCustomWorldbookEntry(fixture({ content: 'CACHE_SENTINEL' }));
    KNOWLEDGE_BASE.saveCustomEntries([active]);
    const options = { query: '叶舟', includeCanon: false, budget: 100_000, maxEntries: 30 };
    assert.match(KNOWLEDGE_BASE.buildContext(options), /CACHE_SENTINEL/);
    KNOWLEDGE_BASE.saveCustomEntries([{ ...active, enabled: false }]);
    assert.doesNotMatch(KNOWLEDGE_BASE.buildContext(options), /CACHE_SENTINEL/);
    localStorage.setItem('naruto_worldbook_custom', JSON.stringify([active]));
    assert.match(KNOWLEDGE_BASE.buildContext(options), /CACHE_SENTINEL/);
    localStorage.setItem('naruto_worldbook_custom', JSON.stringify([{ ...active, enabled: false }]));
    assert.doesNotMatch(KNOWLEDGE_BASE.buildContext(options), /CACHE_SENTINEL/);
  });

  test('legacy context cannot force custom blue entries past its budget', () => {
    reset();
    KNOWLEDGE_BASE.saveCustomEntries([fixture({ isAlwaysOn: true, content: 'OVER_BUDGET_BLUE' + '大'.repeat(50_000) })]);
    assert.doesNotMatch(KNOWLEDGE_BASE.buildContext({ query: '叶舟', includeCanon: false, budget: 5000 }), /OVER_BUDGET_BLUE/);
  });

  test('builtin entries can be disabled individually including core always-on entries', () => {
    reset();
    const v2Resolver = new WorldbookV2Resolver({ customLoader: () => [] });
    const baseV2 = v2Resolver.resolve({ query: '漩涡鸣人', currentDate: 'K052-06-01', audience: 'writer', maxEntries: 30, budget: 100_000 });
    assert.equal(baseV2.entries.some(e => e.title === '【早期】漩涡鸣人'), true);
    assert.equal(baseV2.entries.some(e => e.title === '火影时间线总览'), true);
    assert.equal(baseV2.entries.some(e => e.title === '查克拉基础'), true);

    KNOWLEDGE_BASE.setBuiltinEntryEnabled('【早期】漩涡鸣人', false);
    KNOWLEDGE_BASE.setBuiltinEntryEnabled('火影时间线总览', false);
    KNOWLEDGE_BASE.setBuiltinEntryEnabled('查克拉基础', false);

    assert.equal(KNOWLEDGE_BASE.search('漩涡鸣人').some(e => e.title === '【早期】漩涡鸣人'), false);
    const kbCtx = KNOWLEDGE_BASE.buildContext({ query: '漩涡鸣人', state: { '世界·时间': { year: '木叶52年' } }, includeCanon: false, maxEntries: 30, budget: 100_000 });
    assert.equal(kbCtx.includes('### 【早期】漩涡鸣人'), false);
    assert.equal(kbCtx.includes('### 火影时间线总览'), false);
    assert.equal(kbCtx.includes('### 查克拉基础'), false);

    const disabledV2 = v2Resolver.resolve({ query: '漩涡鸣人', currentDate: 'K052-06-01', audience: 'writer', maxEntries: 30, budget: 100_000 });
    assert.equal(disabledV2.entries.some(e => e.title === '【早期】漩涡鸣人'), false);
    assert.equal(disabledV2.entries.some(e => e.title === '火影时间线总览'), false);
    assert.equal(disabledV2.entries.some(e => e.title === '查克拉基础'), false);
  });

  test('editing builtin entry title, keys, mode and content takes effect in both KNOWLEDGE_BASE and V2 resolver', () => {
    reset();
    const v2Resolver = new WorldbookV2Resolver({ customLoader: () => [] });
    KNOWLEDGE_BASE.saveBuiltinEntry('【早期】漩涡鸣人', {
      title: '鸣人自定义改版',
      keys: ['拉面暗号'],
      activation: { mode: 'keyword', secondary_keys: ['一乐'], selective: true, selective_logic: 'and_any' },
      content: 'BUILTIN_OVERRIDE_VERBATIM_BODY'
    });

    assert.equal(v2Resolver.resolve({ query: '漩涡鸣人', currentDate: 'K052-06-01', audience: 'writer', budget: 100_000 }).entries.some(e => e.title === '鸣人自定义改版'), false);
    assert.equal(v2Resolver.resolve({ query: '拉面暗号', currentDate: 'K052-06-01', audience: 'writer', budget: 100_000 }).entries.some(e => e.title === '鸣人自定义改版'), false);

    const hitV2 = v2Resolver.resolve({ query: '拉面暗号 一乐', currentDate: 'K052-06-01', audience: 'writer', maxEntries: 30, budget: 100_000 });
    const edited = hitV2.entries.find(e => e.title === '鸣人自定义改版');
    assert.ok(edited);
    assert.equal(edited.content, 'BUILTIN_OVERRIDE_VERBATIM_BODY');
    assert.match(KNOWLEDGE_BASE.buildContext({ query: '拉面暗号 一乐', includeCanon: false, maxEntries: 30, budget: 100_000 }), /BUILTIN_OVERRIDE_VERBATIM_BODY/);

    KNOWLEDGE_BASE.saveBuiltinEntry('【早期】漩涡鸣人', {
      title: '鸣人自定义改版',
      keys: ['拉面暗号'],
      activation: { mode: 'manual' },
      content: 'BUILTIN_OVERRIDE_VERBATIM_BODY'
    });
    assert.equal(v2Resolver.resolve({ query: '拉面暗号 一乐', currentDate: 'K052-06-01', audience: 'writer', budget: 100_000 }).entries.some(e => e.title === '鸣人自定义改版'), false);
    assert.equal(KNOWLEDGE_BASE.search('拉面暗号 一乐').some(e => e.title === '鸣人自定义改版'), false);

    KNOWLEDGE_BASE.saveBuiltinEntry('【早期】漩涡鸣人', {
      title: '鸣人自定义改版',
      keys: ['拉面暗号'],
      activation: { mode: 'always' },
      content: 'BUILTIN_OVERRIDE_ALWAYS_BODY'
    });
    assert.match(KNOWLEDGE_BASE.buildContext({ query: '', includeCanon: false, maxEntries: 30, budget: 100_000 }), /BUILTIN_OVERRIDE_ALWAYS_BODY/);
    assert.equal(v2Resolver.resolve({ query: '', currentDate: 'K052-06-01', audience: 'writer', maxEntries: 30, budget: 100_000 }).entries.some(e => e.content === 'BUILTIN_OVERRIDE_ALWAYS_BODY'), true);
  });

  test('builtin bulk toggle preserves content edits, reset restores defaults, and direct storage changes invalidate cache', () => {
    reset();
    KNOWLEDGE_BASE.saveBuiltinEntry('木叶隐村', {
      title: '木叶隐村',
      keys: ['木叶'],
      content: 'EDITED_KONOHA_BODY'
    });
    KNOWLEDGE_BASE.setAllBuiltinEnabled(false);
    assert.equal(KNOWLEDGE_BASE.getBuiltinEntries({ includeDisabled: false }).length, 0);
    KNOWLEDGE_BASE.setAllBuiltinEnabled(true);
    const konoha = KNOWLEDGE_BASE.getBuiltinEntries().find(e => e._builtinKey === '木叶隐村');
    assert.equal(konoha.enabled, true);
    assert.equal(konoha.content, 'EDITED_KONOHA_BODY');

    KNOWLEDGE_BASE.resetBuiltinEntry('木叶隐村');
    assert.equal(KNOWLEDGE_BASE.getBuiltinEntries().find(e => e._builtinKey === '木叶隐村')._hasOverride, false);
    assert.equal(localStorage.getItem('naruto_worldbook_builtin_overrides_v1'), null);

    assert.match(KNOWLEDGE_BASE.buildContext({ query: '木叶隐村', includeCanon: false, maxEntries: 30, budget: 100_000 }), /火之国五大忍村/);
    localStorage.setItem('naruto_worldbook_builtin_overrides_v1', JSON.stringify({
      version: 1,
      entries: { '木叶隐村': { enabled: false } }
    }));
    assert.doesNotMatch(KNOWLEDGE_BASE.buildContext({ query: '木叶隐村', includeCanon: false, maxEntries: 30, budget: 100_000 }), /### 木叶隐村 \|/);
    KNOWLEDGE_BASE.clearBuiltinOverrides();
    assert.equal(localStorage.getItem('naruto_worldbook_builtin_overrides_v1'), null);
  });
} finally { delete globalThis.localStorage; KNOWLEDGE_BASE.invalidateCache(); }
console.log(passed + ' worldbook trigger regression groups passed.');
