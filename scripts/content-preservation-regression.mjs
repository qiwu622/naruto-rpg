import assert from 'node:assert/strict';
import { sanitizeNarrativeDisplayText } from '../js/core/narrative-artifact.js';
import { instructionParser } from '../js/core/instruction-parser.js';
import { buildPresetPresentation, applyPresetPromptRegex, applyPresetRegexScripts } from '../js/core/preset-regex-runtime.js';
import { inspectImportedPresetOutputProfile, assertImportedPresetOutputEnvelope, insertProjectMachineTail } from '../js/core/main-preset-compatibility.js';
import { SHINOBI_DAILY_EXAMPLE, validateShinobiDaily } from '../js/core/shinobi-daily.js';
import { runVariableUpdater } from '../js/core/variable-updater.js';
import { resolveLingXiSystemPrompt } from '../js/data/lingxi-persona.js';
import { memorySystem } from '../js/systems/memory-system.js';
import { compressTimelineNode, decompressTimelineNode } from '../js/core/timeline-node-codec.js';
import { sanitizeTimelineNode } from '../js/core/timeline-save-schema.js';
import { encodeTimelineSave, decodeTimelineSaveFile } from '../js/core/timeline-file-codec.js';
import { stateManager } from '../js/core/state-manager.js';
globalThis.localStorage ||= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.customElements ||= { get: () => null };
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const tail = 'TAIL_SENTINEL_完整尾部';
await test('ordinary tag names, words and quoted markers survive final and partial rendering', () => {
  const text = '秘书极其认真地询问共犯，卷轴上写着“[回映结束]”。';
  for (const raw of [text, `<secretary_dialogue>${text}</secretary_dialogue>`]) {
    assert.equal(sanitizeNarrativeDisplayText(raw), text);
    assert.equal(instructionParser.cleanupPartialResponse(raw), text);
    assert.equal(instructionParser.cleanupResponse(raw), text);
    assert.equal(instructionParser.extractThinkContent(raw), '');
    assert.equal(buildPresetPresentation(raw, raw, []).text, text);
  }
  assert.equal(sanitizeNarrativeDisplayText('<think>私有推演</think>公开正文<variable>{}</variable>'), '公开正文');
  assert.equal(sanitizeNarrativeDisplayText('回映摘要\n[回映结束]\n公开正文'), '公开正文');
});
await test('preset regex thresholds warn without truncating input, output or scripts', () => {
  const input = '甲'.repeat(1_500_001) + tail;
  const result = applyPresetPromptRegex(input, []);
  assert.equal(result.text, input);
  assert.ok(result.warnings.length);
  const expanded = applyPresetRegexScripts('A原文', [{ id: 'first', findRegex: 'A', replaceString: 'B' }, { id: 'second', findRegex: 'B', replaceString: '完整扩展'.repeat(5) + tail }], { channel: 'source', maxInputLength: 1, maxOutputLength: 8, maxScripts: 1 });
  assert.equal(expanded.text, '完整扩展'.repeat(5) + tail + '原文');
  assert.equal(expanded.appliedScripts.length, 2);
  assert.ok(expanded.warnings.length >= 3);
});
await test('long actions and every action remain selectable', () => {
  const long = '按约定等待。'.repeat(220) + tail;
  const options = [long, ...Array.from({ length: 70 }, (_, i) => `行动内容${i}`)];
  const view = buildPresetPresentation(`<options>\n${options.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n</options>`, '正文。', []);
  assert.equal(view.actions.length, options.length);
  assert.equal(view.actions[0], long);
  assert.ok(view.warnings.some(warning => warning.includes('选项')));
});
await test('missing thinking or root envelopes warn but preserve usable text and machine tails', () => {
  const profile = inspectImportedPresetOutputProfile({ _importMode: 'replace', entries: [{ enabled: true, name: '输出格式', content: '输出格式：先输出 <think>简洁思考</think>，再输出正文。' }] });
  const result = assertImportedPresetOutputEnvelope('秘书递来卷轴。', profile);
  assert.equal(result.valid, true);
  assert.ok(result.warnings.length);
  const machine = '<memory>{"summary":"完整记忆"}</memory>';
  assert.ok(insertProjectMachineTail('正文。', machine, { active: true, rootWrapper: 'story' }).includes(machine));
});
await test('daily formatting is advisory, preserves original text, extra fields and collection sizes', () => {
  const daily = structuredClone(SHINOBI_DAILY_EXAMPLE);
  daily.headline.title = '木叶晨报';
  daily.headline.body = '  原始排版\n' + '长正文'.repeat(180) + tail;
  daily.world.push({ ...daily.world[0], extra: tail });
  daily.missions.reverse();
  daily.extra = { original: tail };
  const result = validateShinobiDaily(daily);
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.ok(result.warnings.length);
  assert.deepEqual(result.daily, daily);
});
await test('daily short titles do not trigger variable updater retries', async () => {
  const daily = structuredClone(SHINOBI_DAILY_EXAMPLE); daily.headline.title = '木叶交通';
  let calls = 0; let received;
  globalThis.generateRaw = async () => { calls++; return '<variable>{"path":"progression.exp","op":"add","value":3}</variable>\n<memory>{"summary":"训练完成，获得3点经验。"}</memory>\n<shinobi_daily>' + JSON.stringify(daily) + '</shinobi_daily>'; };
  try {
    const output = await runVariableUpdater({ mainConfig: { backend: 'tavern', model: 'mock-main', variableUpdater: { enabled: true, backend: 'inherit', model: 'mock-updater', streaming: false } }, userInput: '完成训练', enrichedInput: '完成训练', narrativeResponse: '训练完成，获得3点经验。', state: { '系统·回合数': 8, _missions: { active: {} }, _relationships: {} }, compactState: { turn: 8 }, onShinobiDaily: value => { received = value; } });
    assert.match(output, /progression.exp/); assert.equal(calls, 1); assert.equal(received.headline.title, '木叶交通');
  } finally { delete globalThis.generateRaw; }
});
await test('LingXi supplement and machine memory strings keep their full content', () => {
  const supplement = '偏好补充。'.repeat(1800) + tail;
  assert.ok(resolveLingXiSystemPrompt(supplement).includes(supplement));
  const summary = `卷轴原文 <secretary_dialogue>${tail}</secretary_dialogue>`;
  const parsed = instructionParser.parse('<memory>' + JSON.stringify({ summary }) + '</memory>');
  assert.equal(parsed.memory.summary, summary);
  let nested = { tail };
  for (let i = 0; i < 30; i++) nested = { nested };
  assert.deepEqual(instructionParser.parse('<memory>' + JSON.stringify({ summary, original: nested }) + '</memory>').memory.original, nested);
});
await test('long facts, pins, events, NPC notes and clues survive save/reload and consolidation', async () => {
  const original = stateManager.snapshot();
  try {
    stateManager.setSub('_memory', null);
    const full = '事实内容。'.repeat(250) + tail;
    const facts = Array.from({ length: 170 }, (_, i) => `${i} ${full}`);
    const update = { original_format: '引用 blob:本地说明 与 data:image/png;base64,EXAMPLE 文本并不代表图片附件', facts, pins: facts.slice(0, 12), add: facts.slice(0, 70), events: facts.slice(0, 45), summary: full, npc_notes: { 同伴: full }, clues: [{ title: '线索'.repeat(30), detail: full, status: '未解' }] };
    memorySystem.apply(update);
    const loaded = memorySystem._loadMemory();
    for (const field of ['facts', 'long_term', 'pins', 'important_events', 'npc_notes', 'clues', 'recent_summary']) assert.ok(loaded[field].includes(tail), field);
    const storedFacts = `${loaded.facts}\n${loaded.archived}`;
    for (const fact of facts) assert.ok(storedFacts.includes(fact));
    const records = memorySystem.getSourceRecords(loaded);
    assert.deepEqual(records.at(-1).update, update);
    const snapshot = JSON.parse(JSON.stringify(stateManager.snapshot()));
    const safeNode = sanitizeTimelineNode({ id: 'preserved_memory', state_snapshot: snapshot });
    assert.deepEqual(safeNode.state_snapshot._memory.source_records.at(-1).update, update);
    const encoded = await encodeTimelineSave({ node: safeNode }, { compression: 'gzip' });
    const decoded = await decodeTimelineSaveFile(encoded.blob);
    assert.deepEqual(decoded.node.state_snapshot._memory.source_records.at(-1).update, update);
    const compressed = await compressTimelineNode(safeNode);
    const restored = await decompressTimelineNode(compressed);
    stateManager.restore(restored.state_snapshot);
    assert.deepEqual(memorySystem.getSourceRecords().at(-1).update, update);
  } finally { stateManager.restore(original); }
});
await test('chapter and volume AI summaries retain complete raw sources and are not repeated', async () => {
  const original = stateManager.snapshot();
  try {
    const raw = '旧章节原文。'.repeat(2000) + tail;
    stateManager.setSub('_memory', { chapters: JSON.stringify([{ id: 1, from: 1, to: 10, raw, summary: '初步摘要' }]), volumes: JSON.stringify([{ id: 1, raw, summary: '卷摘要' }]) });
    let calls = 0;
    const client = { chat: async () => { calls++; return '完整标题\n' + '整理后的摘要。'.repeat(160) + tail; } };
    assert.equal(await memorySystem._aiUpgradeChapter(client), true);
    assert.equal(await memorySystem._aiUpgradeVolume(client), true);
    const memory = memorySystem._loadMemory();
    const chapter = JSON.parse(memory.chapters)[0];
    assert.equal(chapter.raw, raw); assert.ok(chapter.summary.endsWith(tail));
    assert.equal(JSON.parse(memory.volumes)[0].raw, raw);
    assert.equal(await memorySystem._aiUpgradeChapter(client), false);
    assert.equal(await memorySystem._aiUpgradeVolume(client), false);
    assert.equal(calls, 2);
  } finally { stateManager.restore(original); }
});
await test('compression and deep consolidation keep exact source updates without injecting the journal', () => {
  const original = stateManager.snapshot();
  try {
    const input = { facts: ['旧事实全文。'.repeat(120) + tail], pins: ['原置顶。'.repeat(90) + tail], npc_notes: { 同伴: '旧互动。'.repeat(100) + tail } };
    stateManager.setSub('_memory', { facts: input.facts.join('\n'), pins: input.pins.join('\n'), npc_notes: `同伴: ${input.npc_notes.同伴}`, turn_summaries: Array.from({ length: 9 }, (_, i) => `#${i + 1} ${'完整回合。'.repeat(160)}${i}${tail}`).join('\n') });
    const memory = memorySystem._loadMemory();
    const originalTurns = memory.turn_summaries;
    memorySystem.compressTurnSummaries(memory);
    assert.ok(JSON.stringify(memorySystem.getSourceRecords(memory)).includes(tail));
    assert.ok(memorySystem.getSourceRecords(memory).some(record => record.update.turn_summaries?.includes(originalTurns.split('\n')[0])));
    const reviewed = { facts: input.facts, pins: input.pins, npc_notes: [memory.npc_notes] };
    memorySystem._applyDeepConsolidate({ facts: ['整理后的事实'], pins: ['新的提醒'], npc_digest: { 同伴: { history: '完整关系摘要。'.repeat(80) + tail, recent: '近期互动。'.repeat(50) + tail } } }, memory, 50, reviewed);
    const sources = memorySystem.getSourceRecords();
    assert.ok(sources.some(record => record.source === 'legacy' && record.update.facts === input.facts[0]));
    const before = JSON.stringify(stateManager.getSub('_memory'));
    const context = memorySystem.buildPromptContext(undefined, { userInput: '同伴' });
    assert.ok(!context.includes('source_records'));
    assert.equal(JSON.stringify(stateManager.getSub('_memory')), before);
  } finally { stateManager.restore(original); }
});
console.log(`${passed} content preservation groups passed`);
