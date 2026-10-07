import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  SHINOBI_DAILY_DELEGATION_PROMPT,
  SHINOBI_DAILY_EXAMPLE,
  SHINOBI_DAILY_SCHEMA,
  buildShinobiDailyPrompt,
  parseShinobiDailyContract,
  validateShinobiDaily
} from '../js/core/shinobi-daily.js';
import { createNarrativeArtifact, renderNarrativeInstructions } from '../js/core/narrative-artifact.js';
import {
  MAIN_SINGLE_CALL_OUTPUT_PROMPT,
  STRICT_MAIN_OUTPUT_INCOMPLETE,
  assertMainOutputContract,
  validateMainOutputContract
} from '../js/core/main-output-contract.js';
import { MessagePipeline } from '../js/core/pipeline.js';
import {
  buildNarrativeReviewMessages,
  parseNarrativeReviewPreview
} from '../js/core/narrative-review.js';
import {
  buildVariableUpdaterMessages,
  validateVariableUpdaterOutput
} from '../js/core/variable-updater.js';
import {
  DEFAULT_MAIN_PRESET,
  DEFAULT_MAIN_PRESET_VERSION,
  MAIN_PRESET_STORAGE_KEY,
  invalidateMainPresetCache
} from '../js/data/default-preset.js';
import { DEFAULT_VARIABLE_UPDATER_PRESET } from '../js/data/variable-updater-preset.js';
import {
  FEW_SHOT_EXAMPLES,
  MAIN_SINGLE_CALL_NO_CHANGE_EXAMPLE,
  VARIABLE_UPDATER_MIXED_EXAMPLE
} from '../js/data/prompts.js';

if (!globalThis.localStorage) {
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}

const contract = value => `<shinobi_daily>${JSON.stringify(value)}</shinobi_daily>`;
const dailyJson = JSON.stringify(SHINOBI_DAILY_EXAMPLE);

function countOccurrences(source, needle) {
  return String(source || '').split(needle).length - 1;
}

function assertTaggedJsonIsStrict(source) {
  const pattern = /<(state_update|variable|mission|relationship|combat|event|memory|update_manifest|shinobi_daily)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>/g;
  const matches = [...String(source || '').matchAll(pattern)];
  assert.ok(matches.length > 0, 'fixture must contain tagged JSON');
  for (const match of matches) {
    assert.doesNotThrow(() => JSON.parse(match[2].trim()), `<${match[1]}> must contain strict JSON`);
  }
}

await test('the canonical example passes the exact daily schema', () => {
  const result = validateShinobiDaily(SHINOBI_DAILY_EXAMPLE);
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.equal(result.daily.schema, SHINOBI_DAILY_SCHEMA);
  assert.equal(result.daily.world.length, 4);
  assert.equal(result.daily.flavor.length, 3);
  assert.deepEqual(result.daily.missions.map(item => item.rank), ['D', 'C', 'B', 'A']);
  assert.equal(Object.isFrozen(result.daily), true);
});

const dailyTextLimits = [
  ['schema', 10, 48], ['date', 4, 40], ['issue', 3, 20],
  ['headline.title', 8, 64], ['headline.body', 40, 420], ['headline.sig', 4, 48],
  ['world[].tag', 2, 12], ['world[].title', 6, 42], ['world[].text', 24, 240],
  ['flavor[].mark', 1, 1], ['flavor[].title', 5, 42], ['flavor[].text', 20, 220],
  ['missions[].rank', 1, 1], ['missions[].task', 6, 70], ['missions[].pay', 2, 20],
  ['missions[].status', 2, 16], ['quote.text', 6, 100], ['quote.who', 3, 48]
];

function setDailyField(value, field, text) {
  const parts = field.replace('[]', '.0').split('.');
  const leaf = parts.pop();
  const parent = parts.reduce((current, key) => current[key], value);
  parent[leaf] = text;
}

await test('daily prompts expose every enforced field limit even without an example', () => {
  for (const producer of ['main', 'secondary']) {
    const prompt = buildShinobiDailyPrompt({ producer, includeExample: false });
    for (const [field, min, max] of dailyTextLimits) {
      assert.ok(prompt.includes(`${field}：${min}-${max} 个字符`), `${producer} must disclose ${field}'s length range`);
    }
    assert.match(prompt, /issue[^\n]*1-8 位阿拉伯数字/);
    assert.match(prompt, /flavor\[\]\.mark[^\n]*一个汉字/);
    assert.match(prompt, /missions\[\]\.rank[^\n]*D、C、B、A/);
    assert.match(prompt, /root[^\n]*schema、date、issue、headline、world、flavor、missions、quote/);
    assert.match(prompt, /headline[^\n]*title、body、sig/);
    assert.match(prompt, /world\[\][^\n]*tag、title、text/);
    assert.match(prompt, /flavor\[\][^\n]*mark、title、text/);
    assert.match(prompt, /missions\[\][^\n]*rank、task、pay、status/);
    assert.match(prompt, /quote[^\n]*text、who/);
    assert.match(prompt, /world 恰好 4 条/);
    assert.match(prompt, /flavor 恰好 3 条/);
    assert.match(prompt, /missions 恰好 4 条/);
    assert.match(prompt, /控制字符/);
  }
});

await test('all daily text bounds remain enforced and ordinary boundary values are accepted', () => {
  const specialFormats = new Set(['schema', 'issue', 'flavor[].mark', 'missions[].rank']);
  for (const [field, min, max] of dailyTextLimits) {
    for (const size of [min - 1, max + 1]) {
      const value = structuredClone(SHINOBI_DAILY_EXAMPLE);
      setDailyField(value, field, '字'.repeat(size));
      const result = validateShinobiDaily(value);
      assert.equal(result.valid, false, `${field} must reject ${size} characters`);
      assert.ok(result.errors.some(error => error.includes(field.replace('[]', '[0]'))), result.errors.join('; '));
    }
    if (specialFormats.has(field)) continue;
    for (const size of [min, max]) {
      const value = structuredClone(SHINOBI_DAILY_EXAMPLE);
      setDailyField(value, field, '字'.repeat(size));
      const result = validateShinobiDaily(value);
      assert.equal(result.valid, true, `${field} must accept its ${size}-character boundary: ${result.errors.join('; ')}`);
    }
  }
});

await test('the reported four-character headline is still rejected with a disclosed correction', () => {
  const value = structuredClone(SHINOBI_DAILY_EXAMPLE);
  value.headline.title = '木叶晨报';
  const result = validateShinobiDaily(value);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors, ['日报.headline.title 长度必须为 8-64 个字符']);
  assert.ok(buildShinobiDailyPrompt({ includeExample: false }).includes('headline.title：8-64 个字符'));
});

await test('few-shot outputs are complete and pass the production contracts', () => {
  assert.equal(FEW_SHOT_EXAMPLES.length, 2);

  const mainArtifact = createNarrativeArtifact(MAIN_SINGLE_CALL_NO_CHANGE_EXAMPLE);
  const mainDaily = parseShinobiDailyContract(MAIN_SINGLE_CALL_NO_CHANGE_EXAMPLE, { required: true });
  const mainValidation = validateMainOutputContract({ artifact: mainArtifact, dailyResult: mainDaily });
  assert.equal(mainValidation.valid, true, mainValidation.errors.join('\n'));
  assert.equal(mainValidation.changed, false);

  const updateObligations = {
    fixed_domains: [],
    present_npcs: [{ npc: '海野伊鲁卡' }],
    active_missions: [{ id: 'M-护送药材' }]
  };
  const updaterValidation = validateVariableUpdaterOutput(VARIABLE_UPDATER_MIXED_EXAMPLE, {
    state: {
      _missions: { active: { 'M-护送药材': { id: 'M-护送药材', status: 'active' } } },
      _relationships: {}
    },
    updateObligations
  });
  assert.equal(updaterValidation.valid, true, updaterValidation.errors.join('\n'));
  assert.equal(parseShinobiDailyContract(VARIABLE_UPDATER_MIXED_EXAMPLE, { required: true }).valid, true);
  assert.match(VARIABLE_UPDATER_MIXED_EXAMPLE, /"path":"progression\.exp"/);
  assert.doesNotMatch(VARIABLE_UPDATER_MIXED_EXAMPLE, /"exp_reward"/);

  for (const example of FEW_SHOT_EXAMPLES) {
    assertTaggedJsonIsStrict(example);
    assert.equal(countOccurrences(example, dailyJson), 1, 'each full example must reuse one canonical daily JSON');
  }
});

await test('the tagged contract parses exactly once and normalizes whitespace', () => {
  const value = structuredClone(SHINOBI_DAILY_EXAMPLE);
  value.headline.title = '  木叶任务发布所完成春季委托名录复核  ';
  const result = parseShinobiDailyContract(`正文\n${contract(value)}`, { required: true });
  assert.equal(result.valid, true, result.errors.join('; '));
  assert.equal(result.daily.headline.title, '木叶任务发布所完成春季委托名录复核');
  assert.match(result.raw, /^<shinobi_daily>/);

  const duplicate = parseShinobiDailyContract(`${contract(value)}\n${contract(value)}`, { required: true });
  assert.equal(duplicate.valid, false);
  assert.match(duplicate.errors.join('\n'), /只能输出一个/);
});

await test('daily contracts inside private reasoning blocks never become public instructions', () => {
  for (const [label, hiddenSource] of [
    ['private', `<private>${contract(SHINOBI_DAILY_EXAMPLE)}</private>`],
    ['audit', `<audit_internal>${contract(SHINOBI_DAILY_EXAMPLE)}</audit_internal>`],
    ['thinking', `<variable_thinking>${contract(SHINOBI_DAILY_EXAMPLE)}</variable_thinking>`],
    ['truncated private', `<private>${contract(SHINOBI_DAILY_EXAMPLE)}`],
    ['private attribute', `<context visibility="private">${contract(SHINOBI_DAILY_EXAMPLE)}`]
  ]) {
    const hidden = parseShinobiDailyContract(hiddenSource, { required: true });
    assert.equal(hidden.valid, false, label);
    assert.match(hidden.errors.join('\n'), /缺少顶层/);
  }

  const publicContract = parseShinobiDailyContract([
    contract(SHINOBI_DAILY_EXAMPLE),
    `<private>${contract(SHINOBI_DAILY_EXAMPLE)}</private>`
  ].join('\n'), { required: true });
  assert.equal(publicContract.valid, true, publicContract.errors.join('; '));
});

await test('invalid counts, mission order, extra fields and markup are rejected', () => {
  const wrongCount = structuredClone(SHINOBI_DAILY_EXAMPLE);
  wrongCount.world.pop();
  assert.match(validateShinobiDaily(wrongCount).errors.join('\n'), /恰好包含 4 条/);

  const wrongRank = structuredClone(SHINOBI_DAILY_EXAMPLE);
  [wrongRank.missions[0], wrongRank.missions[1]] = [wrongRank.missions[1], wrongRank.missions[0]];
  assert.match(validateShinobiDaily(wrongRank).errors.join('\n'), /rank 必须是 D/);

  const extra = structuredClone(SHINOBI_DAILY_EXAMPLE);
  extra.html = '<style>body{display:none}</style>';
  assert.match(validateShinobiDaily(extra).errors.join('\n'), /未定义字段 html/);

  const markup = structuredClone(SHINOBI_DAILY_EXAMPLE);
  markup.headline.title = '<img src=x onerror=alert(1)>木叶任务发布所公告';
  assert.match(validateShinobiDaily(markup).errors.join('\n'), /不得包含 HTML/);
});

await test('daily JSON is hidden from visible and persisted narrative projections', () => {
  const artifact = createNarrativeArtifact([
    '公开正文。',
    '<state_update>{"changed":false}</state_update>',
    contract(SHINOBI_DAILY_EXAMPLE)
  ].join('\n'));
  assert.equal(artifact.displayText, '公开正文。');
  assert.deepEqual(artifact.instructions.map(item => item.tag), ['state_update', 'shinobi_daily']);
  assert.match(renderNarrativeInstructions(artifact), /naruto\.shinobi-daily\/v1/);
  assert.doesNotMatch(artifact.displayText, /headline|任务发布所|shinobi_daily|state_update/);
});

await test('single-call output accepts explicit changed and unchanged bookkeeping', () => {
  const memory = '<memory>{"summary":"玩家完成检查，下一回合继续行动。","facts":[],"clues":[],"pins":[],"npc_notes":{}}</memory>';
  const validate = source => validateMainOutputContract({
    artifact: createNarrativeArtifact(source),
    dailyResult: parseShinobiDailyContract(source, { required: true })
  });
  const unchanged = [
    '玩家留在原地观察。',
    '<state_update>{"changed":false}</state_update>',
    memory,
    contract(SHINOBI_DAILY_EXAMPLE)
  ].join('\n');
  const changed = [
    '玩家抵达火影楼。',
    '<var>世界·地点 = 火影楼</var>',
    '<state_update>{"changed":true}</state_update>',
    memory,
    contract(SHINOBI_DAILY_EXAMPLE)
  ].join('\n');

  assert.equal(validate(unchanged).valid, true, validate(unchanged).errors.join('; '));
  assert.equal(validate(unchanged).changed, false);
  assert.equal(validate(changed).valid, true, validate(changed).errors.join('; '));
  assert.equal(validate(changed).changed, true);
});

await test('single-call output rejects omissions, invalid updates and false bookkeeping claims', () => {
  const memory = '<memory>{"summary":"玩家完成检查，下一回合继续行动。"}</memory>';
  const daily = contract(SHINOBI_DAILY_EXAMPLE);
  const validate = source => validateMainOutputContract({
    artifact: createNarrativeArtifact(source),
    dailyResult: parseShinobiDailyContract(source, { required: true })
  });

  const missing = validate('只有正文，没有任何结构契约。');
  assert.equal(missing.valid, false);
  assert.deepEqual([...missing.missingContracts].sort(), ['memory', 'shinobi_daily', 'state_update']);

  const falseClaim = validate([
    '<var>世界·地点 = 火影楼</var>',
    '<state_update>{"changed":false}</state_update>',
    memory,
    daily
  ].join('\n'));
  assert.match(falseClaim.errors.join('\n'), /changed:false/);

  const emptyClaim = validate([
    '<state_update>{"changed":true}</state_update>',
    memory,
    daily
  ].join('\n'));
  assert.match(emptyClaim.errors.join('\n'), /没有任何变量业务标签/);

  const invalidUpdate = validate([
    '<var>这不是有效变量行</var>',
    '<state_update>{"changed":true}</state_update>',
    memory,
    daily
  ].join('\n'));
  assert.match(invalidUpdate.errors.join('\n'), /未形成有效更新/);

  const partiallyInvalidUpdate = validate([
    '<var>世界·地点 = 火影楼\n这不是有效变量行</var>',
    '<state_update>{"changed":true}</state_update>',
    memory,
    daily
  ].join('\n'));
  assert.match(partiallyInvalidUpdate.errors.join('\n'), /未形成有效更新/);

  for (const emptyTag of ['<mission>{}</mission>', '<event>{}</event>']) {
    const emptyBusinessUpdate = validate([
      emptyTag,
      '<state_update>{"changed":true}</state_update>',
      memory,
      daily
    ].join('\n'));
    assert.match(emptyBusinessUpdate.errors.join('\n'), /未形成有效更新/, emptyTag);
  }

  const contradictedByNarrative = validate([
    '玩家离开训练场赶到火影楼，施术耗去大量查克拉，并接下了一份护送任务。',
    '<state_update>{"changed":false}</state_update>',
    memory,
    daily
  ].join('\n'));
  assert.match(contradictedByNarrative.errors.join('\n'), /正文已明确发生/);
  assert.deepEqual(
    contradictedByNarrative.narrativeSignals.map(item => item.id).sort(),
    ['location', 'missions', 'resources']
  );

  const partiallyCoveredNarrative = validate([
    '玩家离开训练场赶到火影楼，施术耗去大量查克拉，并接下了一份护送任务。',
    '<var>世界·地点 = 火影楼</var>',
    '<state_update>{"changed":true}</state_update>',
    memory,
    daily
  ].join('\n'));
  assert.match(partiallyCoveredNarrative.errors.join('\n'), /正文变化缺少对应变量业务标签/);
  assert.match(partiallyCoveredNarrative.errors.join('\n'), /资源数值/);
  assert.match(partiallyCoveredNarrative.errors.join('\n'), /任务状态/);

  const proposedOnly = validate([
    '玩家没有离开训练场，也未消耗查克拉，只打算询问是否可以接取任务。',
    '<state_update>{"changed":false}</state_update>',
    memory,
    daily
  ].join('\n'));
  assert.equal(proposedOnly.valid, true, proposedOnly.errors.join('; '));

  assert.throws(
    () => assertMainOutputContract({
      artifact: createNarrativeArtifact('只有正文'),
      dailyResult: parseShinobiDailyContract('只有正文', { required: true })
    }),
    error => error?.code === STRICT_MAIN_OUTPUT_INCOMPLETE
      && error.missingContracts.includes('shinobi_daily')
      && /本回合未提交/.test(error.message)
  );
});

await test('single-call runtime prompt requires a verifiable bookkeeping acknowledgement', () => {
  assert.match(MAIN_SINGLE_CALL_OUTPUT_PROMPT, /系统不会自动发起第二次请求/);
  assert.match(MAIN_SINGLE_CALL_OUTPUT_PROMPT, /<reasoning> 内禁止出现、引用、规划或示范任何机器标签/);
  assert.match(MAIN_SINGLE_CALL_OUTPUT_PROMPT, /<state_update>\{"changed":true\}<\/state_update>/);
  assert.match(MAIN_SINGLE_CALL_OUTPUT_PROMPT, /<state_update>\{"changed":false\}<\/state_update>/);
  assert.match(MAIN_SINGLE_CALL_OUTPUT_PROMPT, /两行只能二选一/);
  assert.doesNotMatch(MAIN_SINGLE_CALL_OUTPUT_PROMPT, /<state_update>严格 JSON<\/state_update>/);
  assert.match(MAIN_SINGLE_CALL_OUTPUT_PROMPT, /<memory>/);
  assert.match(MAIN_SINGLE_CALL_OUTPUT_PROMPT, /<shinobi_daily>/);
});

await test('assembled single-call prompt keeps the hard delivery checklist after custom prefill', () => {
  const preset = structuredClone(DEFAULT_MAIN_PRESET);
  preset.entries.push(
    {
      id: 'custom_bottom_marker',
      name: '⬆️回映层⬆️',
      enabled: true,
      isMarker: true,
      role: 'system',
      activation: 'always',
      content: ''
    },
    {
      id: 'custom_reasoning_prefill',
      name: '旧预设续写前缀',
      enabled: true,
      role: 'assistant',
      activation: 'always',
      content: '<reasoning>'
    }
  );
  preset._version = DEFAULT_MAIN_PRESET_VERSION;
  localStorage.setItem(MAIN_PRESET_STORAGE_KEY, JSON.stringify(preset));
  invalidateMainPresetCache();

  try {
    const pipeline = new MessagePipeline({});
    const messages = pipeline._buildPrompt('继续调查', {}, '继续调查', { updaterEnabled: false });
    const sources = pipeline._lastPromptTrace.messageSources;
    const prefillIndex = sources.findIndex(item => item.source === '主预设 Prefill');
    const contractIndex = sources.findLastIndex(item => item.source === '单次主模型记账');
    const currentUser = messages.find((message, index) => (
      message.role === 'user' && sources[index]?.source === '本回合聚合上下文'
    ));

    assert.ok(prefillIndex >= 0, 'fixture must include a custom assistant prefill');
    assert.ok(contractIndex > prefillIndex, 'runtime contract must override a stale custom prefill');
    assert.equal(sources.at(-1)?.label, '最终交付复核');
    assert.doesNotMatch(currentUser?.content || '', /单次交付硬约束/);
    const finalContract = messages.at(-1)?.content || '';
    assert.match(finalContract, /单次交付最后检查/);
    assert.match(messages.at(-1)?.content || '', /接近输出上限时.*缩短正文.*不得省略/);
    assert.match(finalContract, /<state_update>\{"changed":true\}<\/state_update>/);
    assert.match(finalContract, /<state_update>\{"changed":false\}<\/state_update>/);
    assert.match(finalContract, /<reasoning> 内不得出现任何机器标签/);
  } finally {
    localStorage.removeItem(MAIN_PRESET_STORAGE_KEY);
    localStorage.removeItem('naruto_main_preset_version');
    invalidateMainPresetCache();
  }
});

await test('main and secondary prompts enforce one fixed data-only renderer contract', () => {
  const main = buildShinobiDailyPrompt({ producer: 'main' });
  const secondary = buildShinobiDailyPrompt({ producer: 'secondary' });
  const withoutExample = buildShinobiDailyPrompt({ producer: 'secondary', includeExample: false });
  for (const prompt of [main, secondary]) {
    assert.match(prompt, /固定前端数据源/);
    assert.match(prompt, /world 恰好 4 条/);
    assert.match(prompt, /D、C、B、A/);
    assert.match(prompt, /不得泄露私密意图/);
    assert.match(prompt, /仅示范结构与写法/);
  }
  assert.match(main, /完成可见正文/);
  assert.match(main, /只有绘图契约可以紧随日报之后/);
  assert.match(secondary, /完成全部变量标签后/);
  assert.doesNotMatch(withoutExample, /规范示例/);
  assert.equal(countOccurrences(withoutExample, dailyJson), 0);
  assert.match(SHINOBI_DAILY_DELEGATION_PROMPT, /由二次变量模型独立生成/);
});

await test('main single-call request receives its validated full example exactly once', () => {
  const pipeline = new MessagePipeline({});
  const messages = pipeline._buildPrompt('查看公告', {}, '查看公告', { updaterEnabled: false });
  const prompt = messages.map(message => message.content).join('\n\n');
  assert.ok(messages.some(message => message.content.includes(MAIN_SINGLE_CALL_NO_CHANGE_EXAMPLE)));
  assert.equal(countOccurrences(prompt, dailyJson), 1);
});

await test('secondary updater always receives the daily contract after custom preset content', () => {
  const messages = buildVariableUpdaterMessages(DEFAULT_VARIABLE_UPDATER_PRESET, {
    state: { _ui: { settings: { tacticalCombat: true } } }, compactState: {}, userInput: '查看公告', enrichedInput: '查看公告',
    narrativeResponse: '玩家在公开栏前停下。'
  });
  const prompt = messages.map(message => message.content).join('\n\n');
  assert.match(prompt, /忍界日报结构契约/);
  assert.match(prompt, /完成全部变量标签后/);
  assert.match(prompt, /naruto\.shinobi-daily\/v1/);
  assert.ok(prompt.includes(VARIABLE_UPDATER_MIXED_EXAMPLE));
  assert.equal(countOccurrences(prompt, dailyJson), 1);
});

await test('narrative review is told to preserve a valid daily as a machine contract', () => {
  const messages = buildNarrativeReviewMessages({
    sourceMessages: [{ role: 'system', content: 'E1：公开告示已经发布。' }],
    candidateResponse: `<final>公开正文。</final>${contract(SHINOBI_DAILY_EXAMPLE)}`
  });
  const prompt = messages.map(message => message.content).join('\n\n');
  assert.match(prompt, /忍界日报复检规则/);
  assert.match(prompt, /只能保留一个完整日报契约/);
  assert.match(prompt, /<shinobi_daily>/);
});

await test('narrative review locally rejects a missing or duplicated required daily', () => {
  const narrative = '任务发布所完成当日公开名录核对，值班忍者将已经确认的通行安排逐项张贴。玩家只阅读告示，没有替任何委托作出决定。';
  const candidateArtifact = createNarrativeArtifact(`${narrative}\n${contract(SHINOBI_DAILY_EXAMPLE)}`);
  const preview = daily => [
    '<audit_internal>已依据候选正文逐项复核公开事实、玩家行动边界与日报结构，未引入私密情报。</audit_internal>',
    `<final>${narrative}${daily}</final>`
  ].join('');

  assert.throws(
    () => parseNarrativeReviewPreview(preview(''), { candidateArtifact }),
    /未保留唯一有效的忍界日报契约/
  );
  assert.throws(
    () => parseNarrativeReviewPreview(preview(`${contract(SHINOBI_DAILY_EXAMPLE)}${contract(SHINOBI_DAILY_EXAMPLE)}`), { candidateArtifact }),
    /未保留唯一有效的忍界日报契约/
  );

  const accepted = parseNarrativeReviewPreview(preview(contract(SHINOBI_DAILY_EXAMPLE)), { candidateArtifact });
  assert.equal(accepted.instructions.filter(item => item.tag === 'shinobi_daily').length, 1);
});

await test('pipeline routes ownership and persists the validated daily separately', async () => {
  const [pipelineSource, timelineSource, appShellSource] = await Promise.all([
    readFile(new URL('../js/core/pipeline.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/systems/timeline-system.js', import.meta.url), 'utf8'),
    readFile(new URL('../js/ui/app-shell.js', import.meta.url), 'utf8')
  ]);
  assert.match(pipelineSource, /updaterEnabled\s*\?\s*SHINOBI_DAILY_DELEGATION_PROMPT/);
  assert.match(pipelineSource, /parseShinobiDailyContract\(fullResponse, \{ required: true \}\)/);
  assert.match(pipelineSource, /assertMainOutputContract/);
  assert.match(pipelineSource, /MAIN_SINGLE_CALL_OUTPUT_PROMPT/);
  assert.match(pipelineSource, /onShinobiDaily/);
  assert.match(pipelineSource, /timelineNodeId:[\s\S]*shinobiDaily/);
  assert.match(timelineSource, /shinobi_daily:\s*shinobiDaily/);
  assert.match(appShellSource, /STRICT_MAIN_OUTPUT_INCOMPLETE/);
  assert.match(appShellSource, /回合未结算/);
  assert.match(appShellSource, /未保存草稿/);
});

await test('modal registration retries when the module was imported before DOM globals exist', async () => {
  const hadDocument = Object.hasOwn(globalThis, 'document');
  const hadCustomElements = Object.hasOwn(globalThis, 'customElements');
  const originalDocument = globalThis.document;
  const originalCustomElements = globalThis.customElements;

  delete globalThis.document;
  delete globalThis.customElements;
  const modalModule = await import(`../js/ui/shinobi-daily-modal.js?domless=${Date.now()}`);

  const definitions = new Map();
  const modal = {
    openDaily(daily) {
      this.daily = daily;
    }
  };
  const createElement = tagName => {
    if (tagName === 'shinobi-daily-modal') return modal;
    const listeners = new Map();
    return {
      dataset: {},
      setAttribute() {},
      append() {},
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      click() {
        listeners.get('click')?.();
      }
    };
  };

  globalThis.customElements = {
    get: name => definitions.get(name),
    define: (name, constructor) => definitions.set(name, constructor)
  };
  globalThis.document = {
    querySelector: () => null,
    createElement,
    body: { appendChild() {} }
  };

  try {
    assert.equal(definitions.has('shinobi-daily-modal'), false);
    const trigger = modalModule.createShinobiDailyTrigger(SHINOBI_DAILY_EXAMPLE);
    trigger.click();
    assert.equal(definitions.get('shinobi-daily-modal'), modalModule.ShinobiDailyModal);
    assert.deepEqual(modal.daily, SHINOBI_DAILY_EXAMPLE);
  } finally {
    if (hadDocument) globalThis.document = originalDocument;
    else delete globalThis.document;
    if (hadCustomElements) globalThis.customElements = originalCustomElements;
    else delete globalThis.customElements;
  }
});

console.log(`PASS ${passed} shinobi daily regression checks.`);
