import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { MessagePipeline } from '../js/core/pipeline.js';
import { stateManager } from '../js/core/state-manager.js';
import { CANON_DATABASE, displayCanonTechniqueName, normalizeCanonDate, resolveCanonTechnique } from '../js/data/canon-database.js';
import {
  CANON_PLOT_BEATS,
  CANON_PLOT_DAYS,
  CANON_PLOT_SCENES,
  CANON_RUNTIME_META,
  CANON_TECHNIQUES
} from '../js/data/generated/canon-runtime-data.js';
import { CANON_OVERRIDE_STORAGE_KEYS } from '../js/data/canon-database-overrides.js';
import { KNOWLEDGE_BASE } from '../js/data/knowledge-base.js';
import { DEFAULT_MAIN_PRESET, DEFAULT_MAIN_PRESET_VERSION } from '../js/data/default-preset.js';
import { DEFAULT_VARIABLE_UPDATER_PRESET, DEFAULT_VARIABLE_UPDATER_PRESET_VERSION } from '../js/data/variable-updater-preset.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

const at = calendar => ({
  '世界·时间': calendar,
  '世界·年代': calendar,
  '世界·地点': '木叶隐村',
  '世界·活跃事件': ''
});

const ANNUAL_SNAPSHOT_DATES = Array.from(
  { length: 86 },
  (_, index) => `K${String(index + 1).padStart(3, '0')}-01-01`
);

const legacyTimelineRoot = new URL('../canon-rebuild-output/data/canon/timeline/', import.meta.url);
const legacyManifest = JSON.parse(readFileSync(new URL('manifest.json', legacyTimelineRoot), 'utf8'));
const LEGACY_PLOT_EVENTS = legacyManifest.shards
  .filter(shard => shard.path.startsWith('shards/plot/'))
  .flatMap(shard => JSON.parse(readFileSync(new URL(shard.path, legacyTimelineRoot), 'utf8')).records || []);

test('runtime exposes the multi-era contract with the currently integrated plot', () => {
  assert.equal(CANON_RUNTIME_META.timelineSchemaVersion, 'project.timeline.v2');
  assert.equal(CANON_RUNTIME_META.timelineScope, 'multi_era_incremental');
  assert.deepEqual(CANON_RUNTIME_META.timelineSupportedNamespaces, ['HIST', 'P1', 'P2', 'BOR']);
  assert.deepEqual(CANON_RUNTIME_META.timelineIncludedNamespaces, ['HIST', 'P1', 'P2', 'BOR']);
  assert.deepEqual(CANON_RUNTIME_META.timelineCoverage, { date_start: 'K001-01-01', date_end: 'K086-07-30' });
  assert.equal(CANON_RUNTIME_META.timelineDays, 385);
  assert.equal(CANON_RUNTIME_META.timelineYearSnapshots, 86);
  assert.equal(CANON_RUNTIME_META.timelineScenes, 786);
  assert.equal(CANON_RUNTIME_META.timelineBeats, 2894);
  assert.equal(CANON_RUNTIME_META.techniqueRecords, 741);
  assert.equal(CANON_RUNTIME_META.techniqueBalanceVersion, 'project_balance_v2');
  assert.equal(CANON_PLOT_DAYS.length, CANON_RUNTIME_META.timelineDays);
  assert.equal(CANON_PLOT_SCENES.length, CANON_RUNTIME_META.timelineScenes);
  assert.equal(CANON_PLOT_BEATS.length, CANON_RUNTIME_META.timelineBeats);
  assert.equal(CANON_TECHNIQUES.length, CANON_RUNTIME_META.techniqueRecords);
  assert.equal(LEGACY_PLOT_EVENTS.length, 4226);
  assert.ok([...CANON_PLOT_DAYS, ...CANON_PLOT_SCENES, ...CANON_PLOT_BEATS].every(record => !/^EV-NAR-/.test(record.id)));
  assert.equal(CANON_PLOT_DAYS[0].date, 'K001-01-01');
  assert.equal(CANON_PLOT_DAYS.at(-1).date, 'K086-07-30');
  assert.ok(CANON_TECHNIQUES.every(technique => ['chakra', 'spirit', 'stamina'].includes(technique.resource)));
});

test('K001-K086 annual foundation snapshots expose ages, factions and locations', () => {
  const annualDays = CANON_PLOT_DAYS.filter(day => day.year_snapshot && typeof day.year_snapshot === 'object');

  assert.equal(annualDays.length, CANON_RUNTIME_META.timelineYearSnapshots);
  assert.deepEqual(annualDays.map(day => day.date), ANNUAL_SNAPSHOT_DATES);
  for (const day of annualDays) {
    const snapshot = day.year_snapshot;
    assert.equal(snapshot.as_of, day.date, `${day.id}: snapshot as_of must equal its DAY date`);
    assert.equal(snapshot.kind, 'year_start', `${day.id}: snapshot must be a year-start baseline`);
    assert.ok(Array.isArray(snapshot.characters) && snapshot.characters.length > 0, `${day.id}: structured characters are required`);
    assert.ok(Array.isArray(snapshot.factions) && snapshot.factions.length > 0, `${day.id}: structured factions are required`);
    assert.ok(Array.isArray(snapshot.transitions_this_year), `${day.id}: structured transitions are required`);
    assert.equal(day.scenes.length, 1, `${day.date}: annual snapshot must have exactly one scene`);
    const [scene] = day.scenes;
    assert.equal(scene.resolution_mode, 'offscreen', scene.id);
    assert.equal(scene.beats.length, 3, `${scene.id}: annual snapshot must have exactly three beats`);
    assert.match(scene.beats[0].summary, /人物年龄/, `${scene.id}: first beat must identify character ages`);
    assert.match(scene.beats[1].summary, /势力/, `${scene.id}: second beat must identify active factions`);
    assert.match(scene.beats[2].summary, /位置|驻地/, `${scene.id}: third beat must identify locations`);
  }

  const k001AgeBeat = annualDays[0].scenes[0].beats[0].summary;
  assert.match(k001AgeBeat, /千手柱间[^。；\n]*年初32岁/, 'K001: Hashirama must be 32 at year start');
  const izunaMentions = k001AgeBeat
    .split(/[。；\n]/)
    .filter(segment => segment.includes('泉奈'));
  assert.ok(
    izunaMentions.every(segment => /已故|死亡|不在世|非存活|不列入/.test(segment)),
    'K001: Izuna must not be listed among living characters'
  );

  const k049AgeBeat = annualDays.find(day => day.date === 'K049-01-01').scenes[0].beats[0].summary;
  assert.match(
    k049AgeBeat,
    /旗木卡卡西[^。；\n]*年初11岁[^。；\n]*(?:本年)?生日后12岁/,
    'K049: Kakashi must be 11 at year start and 12 after his birthday'
  );
});

test('annual faction lifecycles retire destroyed institutions without erasing playable remnants', () => {
  const factionsAt = year => CANON_DATABASE
    .getYearSnapshotContext({ state: at(`${year}-01-01`) })
    ?.snapshot?.factions || [];
  const factionAt = (year, id) => factionsAt(year).find(faction => faction.organization_id === id);

  assert.equal(factionAt('K059', 'ORG-UCHIHA')?.lifecycle, 'active');
  assert.equal(factionAt('K059', 'ORG-KONOHA-POLICE')?.lifecycle, 'active');
  assert.match(factionAt('K059', 'ORG-UCHIHA')?.transition_this_year || '', /转为|结束/);
  assert.match(factionAt('K059', 'ORG-KONOHA-POLICE')?.transition_this_year || '', /结束/);

  const postMassacreUchiha = factionAt('K060', 'ORG-UCHIHA');
  assert.equal(postMassacreUchiha?.lifecycle, 'remnant');
  assert.match(postMassacreUchiha?.name || '', /幸存|残存|血脉/);
  assert.equal(factionAt('K060', 'ORG-KONOHA-POLICE'), undefined);

  assert.equal(factionAt('K068', 'ORG-ROOT')?.lifecycle, 'active');
  assert.equal(factionAt('K068', 'ORG-AKATSUKI')?.lifecycle, 'underground');
  assert.match(factionAt('K068', 'ORG-ROOT')?.transition_this_year || '', /转为|结束/);
  assert.match(factionAt('K068', 'ORG-AKATSUKI')?.transition_this_year || '', /转为|结束/);
  assert.equal(factionAt('K069', 'ORG-ROOT')?.lifecycle, 'remnant');
  assert.equal(factionAt('K069', 'ORG-AKATSUKI')?.lifecycle, 'remnant');

  const finalFactions = factionsAt('K086');
  assert.equal(finalFactions.some(faction => faction.organization_id === 'ORG-KONOHA-POLICE'), false);
  assert.equal(finalFactions.some(faction => faction.organization_id === 'ORG-ROOT'), false);
  assert.equal(finalFactions.some(faction => faction.organization_id === 'ORG-AKATSUKI'), false);
  assert.equal(factionAt('K086', 'ORG-UCHIHA')?.lifecycle, 'remnant');
  assert.doesNotMatch(factionAt('K086', 'ORG-UCHIHA')?.name || '', /木叶内部家族/);
});

test('year snapshot retrieval stays within the current K year and never carries forward', () => {
  const first = CANON_DATABASE.getYearSnapshotContext({ state: at('K001-01-01') });
  assert.equal(first?.snapshot_date, 'K001-01-01');
  assert.equal(first?.day.id, 'DAY-HIST-ANNUAL-001');
  assert.equal(first?.reference_only, true);

  const laterSameYear = CANON_DATABASE.getYearSnapshotContext({ state: at('K001-12-30') });
  assert.equal(laterSameYear?.snapshot_date, 'K001-01-01');
  assert.equal(laterSameYear?.day.id, first.day.id);
  assert.ok(laterSameYear.days_since > 0);

  const finalCoveredYear = CANON_DATABASE.getYearSnapshotContext({ state: at('K086-12-30') });
  assert.equal(finalCoveredYear?.snapshot_date, 'K086-01-01');
  assert.equal(finalCoveredYear?.day.id, 'DAY-HIST-ANNUAL-086');

  assert.equal(CANON_DATABASE.getYearSnapshotContext({ state: at('K050-01-01') })?.snapshot_date, 'K050-01-01');
  assert.equal(CANON_DATABASE.getYearSnapshotContext({ state: at('K064-04-06') })?.snapshot_date, 'K064-01-01');
});

test('year snapshots serialize through their own read-only channel without legacy annual beats', () => {
  const annualDay = CANON_PLOT_DAYS.find(day => day.id === 'DAY-HIST-ANNUAL-003');
  const text = CANON_DATABASE.buildContext({ state: at('K003-06-01'), maxTechniques: 0 });

  assert.match(text, /<<< YEAR_SNAPSHOT_START current=K003-06-01 as_of=K003-01-01 >>>/);
  assert.match(text, /PUBLIC_STATE/);
  assert.match(text, /BACKSTAGE_TRUTH/);
  assert.match(text, /<<< YEAR_SNAPSHOT_END >>>/);
  assert.match(text, /不推进日期|不推进时间/);
  assert.match(text, /不是剧情事件|不是剧情节点/);

  const legacyAnnualNodeIds = [
    annualDay.id,
    ...annualDay.scenes.flatMap(scene => [scene.id, ...scene.beats.map(beat => beat.id)])
  ];
  for (const id of legacyAnnualNodeIds) {
    assert.ok(!text.includes(id), `${id}: legacy annual DAY/SCN/EV must not enter context`);
  }

  const plotContext = CANON_DATABASE.getPlotDayContext({ state: at('K003-01-01') });
  assert.ok(plotContext?.day && !plotContext.day.year_snapshot);
  assert.notEqual(plotContext.day.id, annualDay.id);
});

test('annual DAY, SCN and EV nodes are read-only while ordinary plot remains writable', () => {
  const annualDay = CANON_PLOT_DAYS.find(day => day.id === 'DAY-HIST-ANNUAL-003');
  const annualScene = annualDay.scenes[0];
  const annualBeat = annualScene.beats[0];
  for (const id of [annualDay.id, annualScene.id, annualBeat.id]) {
    const result = CANON_DATABASE.validateTimelineEventUpdate(
      { id, status: 'occurred', description: '不应写入的年度档案结算' },
      { state: at('K003-06-01') }
    );
    assert.equal(result.allowed, false, id);
    assert.equal(result.timeline, true, id);
    assert.equal(result.referenceOnly, true, id);
    assert.match(result.reason, /年度快照.*只读|只读.*年度快照/, id);
  }

  const ordinaryContext = CANON_DATABASE.getPlotDayContext({ state: at('K064-04-06') });
  assert.equal(ordinaryContext?.day.id, 'DAY-P1-CRUSH-406');
  assert.equal(ordinaryContext?.is_future, false);
  const ordinaryWrite = CANON_DATABASE.validateTimelineEventUpdate(
    { id: 'SCN-P1-CRUSH-GAARA-01', status: 'altered', description: '普通剧情分支仍可结算' },
    { state: at('K064-04-06') }
  );
  assert.equal(ordinaryWrite.allowed, true);
  assert.equal(ordinaryWrite.nodeType, 'scene');
});

test('year snapshot retrieval immediately respects plot overrides and disabled records', () => {
  const previousStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(key)
  };
  try {
    const original = CANON_PLOT_DAYS.find(day => day.id === 'DAY-HIST-ANNUAL-003');
    const changed = structuredClone(original);
    changed.year_snapshot.transitions_this_year = [
      ...(changed.year_snapshot.transitions_this_year || []),
      '用户覆盖的年度变迁标记'
    ];
    CANON_DATABASE.saveRecord('plot', changed);

    let context = CANON_DATABASE.getYearSnapshotContext({ state: at('K003-06-01') });
    assert.ok(context.snapshot.transitions_this_year.includes('用户覆盖的年度变迁标记'));

    CANON_DATABASE.setRecordEnabled('plot', original.id, false);
    context = CANON_DATABASE.getYearSnapshotContext({ state: at('K003-06-01') });
    assert.equal(context, null, 'disabled K003 snapshot must not fall back to K002');

    CANON_DATABASE.resetRecord('plot', original.id);
    context = CANON_DATABASE.getYearSnapshotContext({ state: at('K003-06-01') });
    assert.equal(context?.day.id, original.id);
    assert.ok(!context.snapshot.transitions_this_year.includes('用户覆盖的年度变迁标记'));
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('project and translated source dates all use the 30-day calendar', () => {
  for (const record of [...CANON_PLOT_DAYS, ...CANON_PLOT_SCENES, ...CANON_PLOT_BEATS]) {
    assert.equal(normalizeCanonDate(record.date), record.date, `${record.id}: ${record.date}`);
  }
  for (const event of LEGACY_PLOT_EVENTS) {
    const date = event.when?.scheduled_start;
    assert.equal(normalizeCanonDate(date), date, `${event.id}: ${date}`);
  }
});

test('explicit next-day source beats use separate project dates', () => {
  const byId = new Map(LEGACY_PLOT_EVENTS.map(event => [event.id, event]));
  const expected = new Map([
    ['EV-NAR-P1-WAVES-0072', 'K064-01-04'],
    ['EV-NAR-P1-WAVES-0177', 'K064-01-27'],
    ['EV-NAR-P2-TENCHI-0076', 'K067-02-13'],
    ['EV-NAR-P2-AKATSUKI-0046', 'K067-03-05'],
    ['EV-NAR-P2-ITACHI-0066', 'K067-04-07'],
    ['EV-NAR-P2-ITACHI-0094', 'K067-04-10'],
    ['EV-NAR-P2-COUNTDOWN-0057', 'K067-10-24'],
    ['EV-NAR-P2-CONFRONT-0120', 'K068-01-02'],
    ['EV-BOR-MOMOSHIKI-0258', 'K083-03-15'],
    ['EV-BOR-SARADA-0107', 'K082-08-10']
  ]);
  for (const [id, date] of expected) assert.equal(byId.get(id)?.when?.scheduled_start, date, id);
});

test('standard event instructions are routed to world state instead of missions', () => {
  const routed = { events: [], missions: [] };
  const pipeline = new MessagePipeline({
    worldStateSystem: { triggerEvent: event => routed.events.push(event) },
    missionSystem: { processInstruction: mission => routed.missions.push(mission) }
  });
  pipeline._applyInstructions({
    event: [{ id: 'EV-P1-TEST-01', status: 'occurred', description: '测试事件' }]
  }, true);
  assert.equal(routed.events.length, 1);
  assert.equal(routed.missions.length, 0);
});

test('a Chinese alias update targets the already learned canonical technique', () => {
  stateManager.reset();
  stateManager.state['技能·忍术·修罗之攻'] = {
    name: '修罗之攻', type: 'jutsu', mastery: 20,
    technique_id: 'JT-DOJUTSU-0002', description: '保留现有技能说明'
  };
  const pipeline = new MessagePipeline({});
  pipeline._applyInstructions({
    variables: [{ path: 'skills.jutsu.修罗攻击.mastery', op: 'set', value: 60 }]
  }, true);
  const skills = stateManager.get().skills.jutsu;
  assert.equal(skills['修罗之攻'].mastery, 60);
  assert.equal(skills['修罗之攻'].description, '保留现有技能说明');
  assert.equal(skills['修罗攻击'], undefined);
});

test('every project day and scene has complete branchable authoring fields', () => {
  const allIds = new Set();
  for (const day of CANON_PLOT_DAYS) {
    assert.match(day.id, /^DAY-(?:HIST|P1|P2|BOR)-/);
    assert.ok(day.scenes.length >= 1 && day.scenes.length <= 8, day.id);
    assert.ok(day.day_goal && day.start_state.length && day.end_state.length && day.transition, day.id);
    assert.ok(Array.isArray(day.reference_facts), day.id);
    assert.ok(!allIds.has(day.id)); allIds.add(day.id);
    for (const scene of day.scenes) {
      assert.match(scene.id, /^SCN-(?:HIST|P1|P2|BOR)-/);
      assert.match(scene.thread_id, /^THR-(?:HIST|P1|P2|BOR)-/);
      assert.ok(scene.location && scene.participants.length && scene.setup && scene.stop_condition, scene.id);
      assert.ok(['interactive', 'offscreen', 'conditional'].includes(scene.resolution_mode), scene.id);
      for (const key of ['requirements', 'blockers', 'beats', 'outcomes', 'state_changes', 'fallbacks', 'source_material']) {
        assert.ok(scene[key].length > 0, `${scene.id}/${key}`);
      }
      assert.ok(Array.isArray(scene.reference_facts), scene.id);
      assert.ok(!allIds.has(scene.id)); allIds.add(scene.id);
      for (const beat of scene.beats) {
        assert.match(beat.id, /^EV-(?:HIST|P1|P2|BOR)-/);
        assert.ok(!allIds.has(beat.id)); allIds.add(beat.id);
      }
    }
  }
});

test('every Chinese technique display name uniquely resolves to its JT record', () => {
  const records = CANON_DATABASE.getRecords('techniques');
  assert.equal(records.length, 741);
  for (const technique of records) {
    const displayName = displayCanonTechniqueName(technique);
    assert.doesNotMatch(displayName, /[A-Za-zぁ-んァ-ヺ々]/, `${technique.id}: ${displayName}`);
    const resolution = resolveCanonTechnique(displayName);
    assert.equal(resolution.status, 'matched', `${technique.id}: ${displayName}`);
    assert.equal(resolution.technique?.id, technique.id, `${technique.id}: ${displayName}`);
  }
});

test('current date returns the complete day with every same-day scene', () => {
  const context = CANON_DATABASE.getPlotDayContext({ state: at('木叶64年4月6日·清晨') });
  assert.equal(context.is_future, false);
  assert.equal(context.date_relation, 'current');
  assert.equal(context.day.id, 'DAY-P1-CRUSH-406');
  assert.equal(context.day.scenes.length, 8);
  assert.deepEqual(context.day.scenes.map(scene => scene.id), [
    'SCN-P1-CRUSH-FINAL-NARUTO-01',
    'SCN-P1-CRUSH-FINAL-SHINO-01',
    'SCN-P1-CRUSH-FINAL-SHIKAMARU-01',
    'SCN-P1-CRUSH-FINAL-SASUKE-01',
    'SCN-P1-CRUSH-TRIGGER-01',
    'SCN-P1-CRUSH-ARENA-DEFENSE-01',
    'SCN-P1-CRUSH-HIRUZEN-01',
    'SCN-P1-CRUSH-GAARA-01'
  ]);
});

test('blank dates return the complete nearest future day with exact distance', () => {
  const context = CANON_DATABASE.getPlotDayContext({ state: at('木叶64年2月30日·深夜') });
  assert.equal(context.is_future, true);
  assert.equal(context.date_relation, 'future');
  assert.equal(context.current_date, 'K064-02-30');
  assert.equal(context.target_date, 'K064-03-01');
  assert.equal(context.days_until, 1);
  assert.equal(context.day.id, 'DAY-P1-EXAM-301');
  assert.equal(context.day.scenes.length, 2);
});

test('calendar objects retain exact month and day for project plot retrieval', () => {
  const state = at({ era: '木叶', year: 64, month: 3, day: 1, time_of_day: '清晨' });
  const context = CANON_DATABASE.getPlotDayContext({ state });
  assert.equal(context.day.id, 'DAY-P1-EXAM-301');
  assert.equal(context.is_future, false);
});

test('full-day serialization never truncates scene boundaries or database rules', () => {
  const text = CANON_DATABASE.buildContext({
    state: at('木叶64年4月6日·上午'), query: '千鸟', maxTechniques: 1, budget: 80
  });
  assert.match(text, /\[数据库使用边界\]/);
  assert.equal((text.match(/=== SCENE_START/g) || []).length, 8);
  assert.equal((text.match(/=== SCENE_END/g) || []).length, 8);
  assert.match(text, /SCN-P1-CRUSH-GAARA-01/);
  assert.match(text, /<<< CURRENT_PLOT_END >>>/);
  assert.match(text, /reference_facts/);
  assert.doesNotMatch(text, /连续场景窗口|第 \d+-\d+ 条/);
});

test('nearest future day is serialized as ordinary current plot context', () => {
  const text = CANON_DATABASE.buildContext({
    state: at('木叶64年2月30日·深夜'), query: '', maxTechniques: 0, budget: 1
  });
  assert.match(text, /<<< CURRENT_PLOT_START current=K064-02-30 target=K064-03-01 days_until=1 date_relation=future >>>/);
  assert.match(text, /DAY-P1-EXAM-301/);
  assert.match(text, /SCN-P1-EXAM-WRITTEN-01/);
  assert.match(text, /可作为当前分支的普通剧情上下文引用、推进和改写/);
  assert.match(text, /<<< CURRENT_PLOT_END >>>/);
  assert.doesNotMatch(text, /FUTURE_ONLY|不得出现在当前沉浸式正文|到达目标日期前/);
});

test('reference facts remain a separate non-executable channel', () => {
  const day = CANON_PLOT_DAYS.find(item => item.id === 'DAY-P1-START-001');
  assert.ok(day.reference_facts.some(value => value.includes('背景事实')));
  assert.ok(day.scenes.every(scene => scene.beats.every(beat => !day.reference_facts.includes(beat.summary))));
  const text = CANON_DATABASE.buildContext({ state: at(day.date), maxTechniques: 0 });
  assert.match(text, /参考事实（背景\/回顾，禁止作为本日新事件执行）/);
});

test('settled days advance retrieval without replaying the original date', () => {
  const state = at('木叶64年1月1日·夜晚');
  state['世界·活跃事件'] = JSON.stringify({ id: 'DAY-P1-START-001', status: 'altered', description: '玩家分支已结算毕业日' });
  const context = CANON_DATABASE.getPlotDayContext({ state });
  assert.equal(context.is_future, true);
  assert.equal(context.day.id, 'DAY-P1-START-003');
  assert.equal(context.days_until, 2);
});

test('future project nodes can be settled while malformed writes remain rejected', () => {
  const state = at('木叶64年4月6日');
  const future = CANON_DATABASE.validateTimelineEventUpdate({
    id: 'EV-P1-SASUKE-VALLEY-01-01', status: 'occurred'
  }, { state });
  assert.equal(future.allowed, true);
  assert.ok(future.nodeDate.localeCompare('K064-04-06') > 0);

  const current = CANON_DATABASE.validateTimelineEventUpdate({
    id: 'SCN-P1-CRUSH-GAARA-01', status: 'altered', description: '玩家改变追击战'
  }, { state });
  assert.equal(current.allowed, true);
  assert.equal(current.nodeType, 'scene');

  const badPostpone = CANON_DATABASE.validateTimelineEventUpdate({
    id: 'SCN-P1-CRUSH-GAARA-01', status: 'postponed', reschedule_to: 'K064-04-06'
  }, { state });
  assert.equal(badPostpone.allowed, false);
  assert.match(badPostpone.reason, /晚于当前日期/);

  const validPostpone = CANON_DATABASE.validateTimelineEventUpdate({
    id: 'SCN-P1-CRUSH-GAARA-01', status: 'postponed', reschedule_to: 'K064-04-07'
  }, { state });
  assert.equal(validPostpone.allowed, true);
});

test('unknown era-scoped IDs cannot bypass the timeline guard', () => {
  const result = CANON_DATABASE.validateTimelineEventUpdate({
    id: 'EV-P2-UNKNOWN-RUNTIME-NODE-01', status: 'occurred'
  }, { state: at('木叶67年1月1日') });
  assert.equal(result.timeline, true);
  assert.equal(result.allowed, false);
  assert.match(result.reason, /运行时不存在/);
});

test('technique aliases still resolve with database-owned resource and cost', () => {
  const resolved = CANON_DATABASE.resolveTechnique("Banshō Ten'in");
  assert.equal(resolved?.id, 'JT-DOJUTSU-0004');
  const sourceRecord = CANON_TECHNIQUES.find(technique => technique.id === resolved.id);
  assert.equal(resolved.cost, sourceRecord.cost);
  assert.equal(resolved.resource, sourceRecord.resource);
  assert.ok(resolved.cost > 0);
});

test('plot overrides use a fresh v2 store and edit complete nested days', () => {
  assert.equal(CANON_OVERRIDE_STORAGE_KEYS.plot, 'naruto_project_timeline_overrides_v2');
  const previousStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(key)
  };
  try {
    const original = CANON_PLOT_DAYS.find(day => day.id === 'DAY-P1-START-003');
    const changed = structuredClone(original);
    changed.scenes[0].setup = '用户修改后的分班开场态势';
    CANON_DATABASE.saveRecord('plot', changed);
    let context = CANON_DATABASE.getPlotDayContext({ state: at(original.date) });
    assert.equal(context.day.scenes[0].setup, '用户修改后的分班开场态势');
    assert.equal(CANON_DATABASE.getOverrideStore('plot').version, 2);

    CANON_DATABASE.setRecordEnabled('plot', original.id, false);
    context = CANON_DATABASE.getPlotDayContext({ state: at(original.date) });
    assert.notEqual(context.day.id, original.id);

    CANON_DATABASE.resetRecord('plot', original.id);
    context = CANON_DATABASE.getPlotDayContext({ state: at(original.date) });
    assert.equal(context.day.scenes[0].setup, original.scenes[0].setup);
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('technique overrides remain compatible and immediately affect resolution', () => {
  const previousStorage = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(key)
  };
  try {
    const original = CANON_TECHNIQUES.find(technique => technique.id === 'JT-DOJUTSU-0004');
    CANON_DATABASE.saveRecord('techniques', { ...original, aliases: [...original.aliases, '测试引力术'], cost: original.cost + 17 });
    assert.equal(CANON_DATABASE.resolveTechnique('测试引力术')?.cost, original.cost + 17);
    CANON_DATABASE.resetRecord('techniques', original.id);
    assert.equal(CANON_DATABASE.resolveTechnique("Banshō Ten'in")?.cost, original.cost);
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('knowledge cache separates worldbook-only and canon-enabled requests', () => {
  KNOWLEDGE_BASE.invalidateCache();
  const state = at('木叶64年3月1日·清晨');
  const options = { query: "Banshō Ten'in", state, memory: {}, maxEntries: 3, budget: 1800 };
  const worldbookOnly = KNOWLEDGE_BASE.buildContext({ ...options, includeCanon: false });
  const withCanon = KNOWLEDGE_BASE.buildContext({ ...options, includeCanon: true });
  assert.doesNotMatch(worldbookOnly, /DAY-P1-EXAM-301/);
  assert.match(withCanon, /DAY-P1-EXAM-301/);
  assert.match(withCanon, /JT-DOJUTSU-0004/);
});

test('knowledge cache invalidates when branch timeline decisions change', () => {
  KNOWLEDGE_BASE.invalidateCache();
  const state = at('木叶64年1月1日·夜晚');
  const first = KNOWLEDGE_BASE.buildContext({ query: '毕业', state, memory: {}, maxEntries: 2, budget: 1200 });
  assert.match(first, /DAY-P1-START-001/);
  state['世界·活跃事件'] = JSON.stringify({ id: 'DAY-P1-START-001', status: 'occurred', description: '毕业日已结算' });
  const next = KNOWLEDGE_BASE.buildContext({ query: '毕业', state, memory: {}, maxEntries: 2, budget: 1200 });
  assert.match(next, /DAY-P1-START-003/);
  assert.doesNotMatch(next, /DAY: DAY-P1-START-001/);
});

test('secondary updater receives the complete day instead of a 1000/2000 character fragment', () => {
  const state = at('木叶64年4月6日·清晨');
  const pipeline = new MessagePipeline({ knowledgeBase: KNOWLEDGE_BASE });
  const evidence = pipeline._compileUpdaterEvidence({
    state,
    userInput: '千鸟',
    narrativeResponse: '玩家在木叶隐村继续调查。'
  });
  const context = JSON.stringify(evidence.current_plot);
  assert.equal(evidence.current_plot.day_id, 'DAY-P1-CRUSH-406');
  assert.equal(evidence.current_plot.scenes.length, evidence.current_plot.total_scene_count);
  assert.match(context, /SCN-P1-CRUSH-GAARA-01/);
  assert.ok(context.length > 2000);
});

test('editable presets expose V2 lifecycle and unchanged JT authority', () => {
  const main = DEFAULT_MAIN_PRESET.entries.map(entry => entry.content).join('\n');
  const updater = DEFAULT_VARIABLE_UPDATER_PRESET.entries.map(entry => entry.content).join('\n');
  assert.match(DEFAULT_MAIN_PRESET_VERSION, /relationship-rename-v18/);
  assert.equal(DEFAULT_VARIABLE_UPDATER_PRESET_VERSION, 19);
  for (const text of [main, updater]) {
    assert.match(text, /DAY-\{HIST\|P1\|P2\|BOR\}-\*/);
    assert.match(text, /SCN-\{HIST\|P1\|P2\|BOR\}-\*/);
    assert.match(text, /EV-\{HIST\|P1\|P2\|BOR\}-\*/);
    assert.match(text, /reference_facts/);
    assert.match(text, /occurred.*altered.*skipped.*postponed/s);
  }
  assert.doesNotMatch(main, /NEXT_ANCHOR|FUTURE_ONLY|受保护未来|未来事件隔离/);
  assert.match(main, /最近一个项目剧情日[\s\S]*普通分支素材[\s\S]*引用、推进、改写和结算/);
  assert.match(main, /当天全部独立场景/);
  assert.match(main, /不等于本回合必须演完一天/);
  assert.match(main, /每回合.*<memory>/s);
  assert.match(main, /(?:必须|需要|请).*输出[^\n]*<reasoning>/);
  assert.match(main, /<state_update>\{"changed":true\}<\/state_update>/);
  assert.match(main, /<state_update>\{"changed":false\}<\/state_update>/);
  assert.match(main, /<reasoning> 内禁止出现任何机器标签/);
  assert.match(updater, /reschedule_to/);
  assert.match(updater, /known_users[\s\S]*不证明任何角色当前掌握/);
  assert.match(updater, /数据库未命中[\s\S]*不得伪造 JT-\*/);
  assert.match(updater, /(?:必须|需要|请).*输出[^\n]*<variable_thinking>/);
});

test('settings editor exposes day to scene to beat editing and keeps technique controls', () => {
  const settings = readFileSync(new URL('../js/ui/settings-panel.js', import.meta.url), 'utf8');
  const editor = readFileSync(new URL('../js/ui/canon-database-editor.js', import.meta.url), 'utf8');
  assert.match(settings, /data-tool="canon" data-targets="tab-canon-plot,tab-canon-techniques"/);
  assert.match(settings, /data-resource-id="plot"/);
  assert.match(settings, /data-resource-id="techniques"/);
  assert.match(settings, /open-canon-plot-editor[\s\S]*?document\.body\.appendChild\(editor\)/);
  assert.match(editor, /timeline-day-form/);
  assert.match(editor, /data-action="add-scene"/);
  assert.match(editor, /data-action="add-beat"/);
  assert.match(editor, /reference_facts/);
  assert.match(editor, /resolution_mode/);
  assert.match(editor, /source_material/);
  assert.match(editor, /TIMELINE_NAMESPACE_OPTIONS = \['HIST', 'P1', 'P2', 'BOR'\]/);
  assert.match(editor, /replaceTimelineNamespace/);
  assert.match(editor, /\.db-shell\{box-sizing:border-box;/);
  for (const action of ['save', 'toggle', 'reset-one', 'reset-all', 'import', 'export-overrides', 'export-effective', 'new']) {
    assert.match(editor, new RegExp(`data-action=\\"${action}\\"`));
  }
});

test('world-state application calls the local timeline write guard before persistence', () => {
  const sourceText = readFileSync(new URL('../js/systems/world-state-system.js', import.meta.url), 'utf8');
  const guardAt = sourceText.indexOf('validateTimelineEventUpdate');
  const persistAt = sourceText.indexOf("stateManager.update([", guardAt);
  assert.ok(guardAt > 0 && persistAt > guardAt);
  assert.match(sourceText.slice(guardAt, persistAt), /if \(!timelineCheck\.allowed\)[\s\S]*return null/);
});

console.log(`PASS ${passed} canon runtime regression checks.`);
