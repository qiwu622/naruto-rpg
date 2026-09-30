import assert from 'node:assert/strict';
import { createOpeningDraft } from '../js/systems/opening-draft.js';
import { normalizeOpeningDraft } from '../server/multiplayer/persistence/sqlite-core-repositories.js';
import { createNewMultiplayerGenesisState } from '../server/multiplayer/application/genesis-state.js';
import { MultiplayerRoomStore } from '../js/multiplayer/room-store.js';
import { buildWriterPrompt } from '../server/multiplayer/agent/prompts.js';
import { narrativeLengthRequirements, narrativeQualityFindings } from '../server/multiplayer/agent/narrative-quality.js';

const detailed = createOpeningDraft('chunin', {
  identity: { name: '测试凛', secrets: '只属于 A 的身份秘密' },
  power: { attributes: { chakra: 321 } },
  resources: { ryo: 1234 },
  abilities: [{ name: '分身术', type: 'jutsu', rank: 'E', mastery: 60 }],
  relationships: [{ name: '测试导师', relation: '老师', secret: '导师的私人线索' }]
});
const opening = {
  start_time: { year: 52, month: 1, day: 1, phase: 'DAWN' },
  display_name: '测试凛', rank: '中忍', affiliation: '木叶隐村',
  background: '情报班忍者', location: '村口', goal: '查明来信',
  opening_hook: '一名信使带来了沾有泥水的卷轴。', detailed_draft: detailed
};
const normalized = normalizeOpeningDraft(opening);
assert.equal(normalized.detailed_draft.power.attributes.chakra, 321);
assert.deepEqual(normalizeOpeningDraft(normalized), normalized, 'persisted draft must normalize idempotently');
const state = createNewMultiplayerGenesisState({ opening_drafts: {
  A: normalized, B: { ...opening, display_name: '测试陆', detailed_draft: createOpeningDraft('genin_team', { identity: { name: '测试陆' } }) }
} });
assert.equal(state.actors.A.attributes.resources.find(x => x.resource_id === 'chakra').current, 321);
assert.equal(state.actors.A.attributes.resources.find(x => x.resource_id === 'money').current, 1234);
assert.ok(state.actors.A.skills.entries.some(x => x.display_name === '分身术'));
assert.ok(state.actors.A.equipment.entries.length > 0);
assert.ok(JSON.stringify(state.actors.A.private_knowledge).includes('只属于 A 的身份秘密'));
for (const audience of ['shared', 'seat:B']) {
  const prompt = buildWriterPrompt({ audience, audience_projection: {}, canonical_stop_point: 'scene:stop',
    turn_purpose: 'opening_scene', opening_context: { openings: { A: normalized } } });
  assert.ok(!prompt.includes('只属于 A 的身份秘密'));
  assert.ok(!prompt.includes('导师的私人线索'));
}
const store = new MultiplayerRoomStore();
const presetPrompt = JSON.parse(buildWriterPrompt({ audience: 'seat:B', audience_projection: {}, canonical_stop_point: 'scene:stop',
  history: { memories: [{ summary: '上回合的公开线索' }] },
  style_requirements: { player_names: { A: '测试凛', B: '测试陆' }, writer_preset: { source_seat: 'A', preset: {
    name: '宏回归', entries: [{ content: '{{user}} 承接 {{MEMORY}}。' }]
  } } }
}));
assert.match(presetPrompt.trusted_selected_preset.entries[0].content, /测试陆 承接.*上回合的公开线索/u);
const lengthStyle = { minimum_characters: 0, writer_preset: { source_seat: 'B', preset: { name: 'B 篇幅', entries: [
  { enabled: true, content: '正文以 900-1500 字为目标。开场正文写 1500 至 1800 字。' },
  { enabled: false, content: '正文写 300 至 400 字。' },
  { enabled: true, activation: 'variable_updater_disabled', content: '正文至少 3000 字。' }
] } } };
const openingStyle = narrativeLengthRequirements(lengthStyle, 'opening_scene');
assert.equal(openingStyle.minimum_characters, 1500);
assert.equal(narrativeLengthRequirements(lengthStyle, 'player_actions').minimum_characters, 0);
assert.equal(narrativeQualityFindings([{ audience: 'shared', segments: [{ text: '雨'.repeat(1500) }] }], openingStyle).length, 0);
assert.match(narrativeQualityFindings([{ audience: 'shared', segments: [{ text: '雨'.repeat(1200) }] }], openingStyle)[0].message, /至少需要 1500/u);
store.patch({ roomId: 'room:test', room: { room_id: 'room:test', active_epoch_id: 'epoch:test' } });
const committed = { turn_id: 'turn:first', epoch_id: 'epoch:test', turn_no: 1, status: 'COMMITTED', commit: { state: { state_revision: 1 }, shinobi_daily: { headline: '已发布日报' } } };
store.setTurn(committed);
store.setTurn({ turn_id: 'turn:next', epoch_id: 'epoch:test', turn_no: 2, status: 'COLLECTING_ACTIONS' });
assert.deepEqual(store.state.latestCommittedTurn, committed, 'advancing a turn must retain its publication');
store.reset();
assert.equal(store.state.latestCommittedTurn, null);
console.log('Multiplayer detailed opening, private context and committed publication regression passed');
