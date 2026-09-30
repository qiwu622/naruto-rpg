import { eventBus } from './event-bus.js';
import { AgentRunner, AgentAbortError, resolveAgentSystemPrompt, mapWithConcurrency } from './agent-runner.js';
import { getAgentConfig } from '../data/agent-config.js';
import { stateManager } from './state-manager.js';
import { AgentContextBroker } from './agent-context-broker.js';
import { AgentToolRuntime, createNarrativeAgentTools } from './agent-tool-runtime.js';
import {
  assertCharacterDecision,
  assertSceneBrief,
  assertStoryArcPlan,
  auditTurnEnvelope,
  createTurnEnvelope,
  toWriterCharacterDecision
} from './agent-contracts.js';
import { createNarrativeArtifact } from './narrative-artifact.js';
import { CANON_DATABASE, normalizeCanonDate } from '../data/canon-database.js';
import { parseShinobiDailyContract } from './shinobi-daily.js';
import { validateVariableUpdaterOutput } from './variable-updater.js';
import { buildUpdaterObligations } from './turn-evidence.js';
import {
  IMPORTED_PRESET_OUTPUT_COMPATIBILITY_PROMPT,
  attachImportedAssistantPrefill,
  buildImportedPresetOutputCompatibilityPrompt,
  insertProjectMachineTail
} from './main-preset-compatibility.js';

export const CHARACTER_MEMORY_DELTA_SCHEMA = 'naruto.character-memory-delta/v1';
export const AGENT_PIPELINE_REVISION = 'narrative-soft-guidance-v2';

// 阶段断点续跑缓存：键 = branch|回合|输入哈希；值 = { complete, data }。
// 回合失败时保留缓存，用户重试时复用上方已完成阶段，从失败阶段直接续跑。
const agentStageCache = new Map();

function hashAgentInput(value) {
  const text = String(value || '');
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return String(hash);
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeCandidateResult(result) {
  const source = Array.isArray(result?.candidates)
    ? result.candidates.filter(candidate => (
        candidate
        && typeof candidate === 'object'
        && String(candidate.direction || '').trim()
      ))
    : [];
  const recommendedIndex = source.findIndex(candidate => (
    String(candidate?.id) === String(result?.recommended)
  ));
  const candidates = source.map((candidate, index) => ({
    id: index + 1,
    direction: String(candidate.direction || '').trim(),
    reason: String(candidate.reason || '').trim(),
    risk: ['low', 'medium', 'high'].includes(candidate.risk) ? candidate.risk : 'medium'
  }));
  return {
    candidates,
    recommended: candidates.length ? Math.min(recommendedIndex >= 0 ? recommendedIndex + 1 : 1, candidates.length) : null
  };
}

function normalizeOutlineResult(result) {
  const source = Array.isArray(result?.beats)
    ? result.beats.filter(beat => beat && typeof beat === 'object')
    : [];
  return {
    estimatedLength: Math.max(400, Number(result?.estimatedLength) || 1200),
    variableSummary: cleanMemoryText(result?.variableSummary, 800),
    beats: source.map((beat, index) => ({
      id: index + 1,
      scene: cleanMemoryText(beat.scene, 1200),
      tension: cleanMemoryText(beat.tension, 600),
      participants: [...new Set((Array.isArray(beat.participants) ? beat.participants : [])
        .map(value => cleanMemoryText(value, 80)).filter(Boolean))],
      openQuestion: cleanMemoryText(beat.openQuestion ?? beat.open_question, 600),
      mood: ['紧张', '轻松', '热血', '悲伤', '日常', '诡异'].includes(beat.mood)
        ? beat.mood
        : '日常',
      variables: [...new Set((Array.isArray(beat.variables) ? beat.variables : [])
        .filter(value => ['variable', 'combat', 'relationship', 'memory', 'mission', 'event'].includes(value)))]
    })).filter(beat => beat.scene)
  };
}

const WRITING_OUTLINE_FORBIDDEN_KEYS = new Set([
  'action', 'actions', 'dialogue', 'prose', 'body', 'paragraph', 'paragraphs',
  'narrativeText', 'finalText', 'reasoning', 'outcome', 'result'
]);

function findForbiddenWritingOutlineKeys(value, path = '$', findings = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenWritingOutlineKeys(item, `${path}[${index}]`, findings));
    return findings;
  }
  if (!value || typeof value !== 'object') return findings;
  for (const [key, nested] of Object.entries(value)) {
    if (WRITING_OUTLINE_FORBIDDEN_KEYS.has(key)) findings.push(`${path}.${key}`);
    findForbiddenWritingOutlineKeys(nested, `${path}.${key}`, findings);
  }
  return findings;
}

function normalizeWritingOutlineList(value, maxItems = 24, maxChars = 600) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(item => cleanMemoryText(item, maxChars))
    .filter(Boolean))].slice(0, maxItems);
}

export function normalizeWritingOutlineResult(result, {
  decisionIds = [], fallbackOutline = null, sceneBrief = null
} = {}) {
  const advisories = normalizeWritingOutlineList(result?.advisories);
  if (!result || typeof result !== 'object' || Array.isArray(result)) result = {};
  const forbidden = findForbiddenWritingOutlineKeys(result);
  if (forbidden.length) {
    advisories.push('详纲中的正文或行动扩展字段未作为既成事实使用；作家可结合场景组织合理回应。');
  }

  const allowedDecisionIds = new Set(normalizeWritingOutlineList(decisionIds, 80, 180));
  let source = Array.isArray(result.beats)
    ? result.beats.filter(beat => beat && typeof beat === 'object' && !Array.isArray(beat))
    : [];
  source = source.filter(beat => cleanMemoryText(beat.scene, 1200));
  if (!source.length) {
    advisories.push('详细大纲暂不可用，参考已有场景与玩家输入直接完成叙事。');
    source = Array.isArray(fallbackOutline?.beats)
      ? fallbackOutline.beats.filter(beat => beat && cleanMemoryText(beat.scene, 1200))
      : [];
    if (!source.length) source = [{
      scene: sceneBrief?.location || '当前场景',
      narrativeGoal: sceneBrief?.playerIntent || '承接玩家输入，展开合理的世界回应',
      participants: sceneBrief?.participants || []
    }];
  }
  const beats = source.slice(0, 8).map((beat, index) => ({
    id: index + 1,
    sourceBeatId: cleanMemoryText(beat.sourceBeatId ?? beat.source_beat_id ?? beat.id ?? index + 1, 80),
    scene: cleanMemoryText(beat.scene, 1200),
    narrativeGoal: cleanMemoryText(beat.narrativeGoal ?? beat.narrative_goal ?? beat.openQuestion ?? beat.tension, 800)
      || '承接玩家输入，展开合理的世界回应',
    participants: normalizeWritingOutlineList(beat.participants, 32, 80),
    decisionRefs: normalizeWritingOutlineList(beat.decisionRefs ?? beat.decision_refs, 80, 180),
    environmentBeats: normalizeWritingOutlineList(
      beat.environmentBeats ?? beat.environment_beats,
      16,
      600
    ),
    continuityChecks: normalizeWritingOutlineList(
      beat.continuityChecks ?? beat.continuity_checks,
      20,
      700
    ),
    variableEvidence: normalizeWritingOutlineList(
      beat.variableEvidence ?? beat.variable_evidence,
      20,
      700
    ),
    playerBoundary: cleanMemoryText(beat.playerBoundary ?? beat.player_boundary, 800),
    stopPoint: cleanMemoryText(beat.stopPoint ?? beat.stop_point, 800)
  }));

  const invalidRefs = [...new Set(beats.flatMap(beat => beat.decisionRefs))]
    .filter(id => !allowedDecisionIds.has(id));
  if (invalidRefs.length) {
    advisories.push('部分角色引用未匹配到素材；结合已知人物设定与场景补充合理反应。');
    for (const beat of beats) beat.decisionRefs = beat.decisionRefs.filter(id => allowedDecisionIds.has(id));
  }
  const referenced = new Set(beats.flatMap(beat => beat.decisionRefs));
  const missingRefs = [...allowedDecisionIds].filter(id => !referenced.has(id));
  if (missingRefs.length) {
    advisories.push('角色素材按当前剧情需要选用，无需让所有提供素材的角色逐一登场或表演。');
  }
  const incomplete = beats
    .filter(beat => !beat.playerBoundary || !beat.stopPoint)
    .map(beat => beat.id);
  if (incomplete.length) {
    advisories.push('未填写的玩家边界和停止点采用通用建议，由作家结合当前剧情安排。');
    for (const beat of beats) {
      beat.playerBoundary ||= '根据玩家明确表达的意图推进，将新的关键选择交还玩家。';
      beat.stopPoint ||= '在适合玩家回应的位置自然收束。';
    }
  }
  const estimatedLength = Number(result.estimatedLength ?? fallbackOutline?.estimatedLength);

  return Object.freeze({
    schema: 'naruto.writing-outline/v1',
    beats: Object.freeze(beats.map(beat => Object.freeze(beat))),
    estimatedLength: Number.isFinite(estimatedLength) && estimatedLength > 0 ? estimatedLength : 1200,
    advisories: Object.freeze(normalizeWritingOutlineList(advisories)),
    variableEvidence: Object.freeze(normalizeWritingOutlineList(
      result.variableEvidence ?? result.variable_evidence,
      32,
      700
    )),
    finalChecks: Object.freeze(normalizeWritingOutlineList(
      result.finalChecks ?? result.final_checks,
      32,
      700
    ))
  });
}

function isWritingOutlineText(value) {
  try {
    const parsed = JSON.parse(String(value || '').trim());
    return Boolean(parsed && typeof parsed === 'object'
      && parsed.schema === 'naruto.writing-outline/v1'
      && Array.isArray(parsed.beats));
  } catch {
    return false;
  }
}

function cleanMemoryText(value, max = 600) {
  return String(value || '').trim().slice(0, max);
}

function currentStoryDate(state) {
  const raw = cleanMemoryText(state?.['世界·时间'] || state?.['世界·年代'], 120);
  const normalized = normalizeCanonDate(raw);
  if (normalized) return normalized;
  return raw.match(/^.*?日/)?.[0] || raw;
}

function activeStoryBranch(state) {
  return cleanMemoryText(
    state?._meta?.active_branch || state?.['系统·当前分支'] || 'branch_main',
    160
  ) || 'branch_main';
}

function normalizeStoryDirectionList(value) {
  const source = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[\r\n,，;；]+/) : []);
  return [...new Set(source
    .map(item => cleanMemoryText(item, 300))
    .filter(Boolean))].slice(0, 12);
}

function storyDirectionSource(raw, branchId) {
  if (!raw || typeof raw !== 'object') return null;
  if (Array.isArray(raw)) {
    return raw.find(item => (
      item && typeof item === 'object'
      && cleanMemoryText(item.branchId ?? item.branch_id, 160) === branchId
    )) || null;
  }

  const nested = raw.byBranch || raw.branches || raw.directions;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested[branchId] && typeof nested[branchId] === 'object'
      ? nested[branchId]
      : null;
  }
  if (raw[branchId] && typeof raw[branchId] === 'object') return raw[branchId];

  const boundBranch = cleanMemoryText(raw.branchId ?? raw.branch_id, 160);
  return boundBranch === branchId ? raw : null;
}

function normalizeStoryDirection(state) {
  const branchId = activeStoryBranch(state);
  const source = storyDirectionSource(state?._story_direction, branchId);
  if (!source) return null;
  const direction = cleanMemoryText(
    source.direction ?? source.summary ?? source.preference ?? source.intent,
    1200
  );
  const goals = normalizeStoryDirectionList(source.goals ?? source.targets);
  const avoid = normalizeStoryDirectionList(
    source.avoid ?? source.avoidances ?? source.exclusions
  );
  if (!direction && !goals.length && !avoid.length) return null;
  return {
    branchId,
    direction,
    goals,
    avoid,
    updatedAt: cleanMemoryText(source.updatedAt ?? source.updated_at, 120)
  };
}

function storyDirectionFingerprint(direction) {
  if (!direction) return 'none';
  return hashAgentInput(JSON.stringify({
    branchId: direction.branchId,
    direction: direction.direction,
    goals: direction.goals,
    avoid: direction.avoid,
    updatedAt: direction.updatedAt
  }));
}

function storyDirectionPrompt(direction) {
  if (!direction) return '';
  return [
    '[用户已批准的剧情方向偏好]',
    JSON.stringify(direction),
    '以上内容只是对未来可能走向的可撤销偏好，不是已经发生的剧情，也不是角色命令。',
    '可在条件自然成立时提高相关机会的权重，并避开 avoid 项；不得因此强迫玩家或 NPC 行动、决定、说话或得到预定结果。'
  ].join('\n');
}

function storyPlanDirectionFingerprint(plan) {
  const match = cleanMemoryText(plan?.id, 160).match(/:sd-([^:]+)$/);
  return match?.[1] || null;
}

export function buildCharacterMemoryDelta(characterInputs = [], { turn = 0 } = {}) {
  const changes = {};
  for (const input of Array.isArray(characterInputs) ? characterInputs : []) {
    const npcName = cleanMemoryText(input?.npcName || input?.npc, 80);
    if (!npcName) continue;
    const action = cleanMemoryText(input.action);
    const dialogue = cleanMemoryText(input.dialogue);
    const innerThought = cleanMemoryText(input.innerThought);
    const moodShift = cleanMemoryText(input.moodShift, 160);
    const towardsPlayer = cleanMemoryText(input.towardsPlayer, 240);
    const change = changes[npcName] || {
      npcName,
      currentMood: null,
      knownFactsAppend: [],
      recentActionsAppend: [],
      privateIntentAppend: [],
      relationShift: null
    };
    if (moodShift) change.currentMood = moodShift;
    if (action) change.knownFactsAppend.push(action);
    if (action || dialogue) change.recentActionsAppend.push({
      turn: Math.max(0, Number(turn) || 0),
      action,
      dialogue
    });
    if (innerThought) change.privateIntentAppend.push({
      turn: Math.max(0, Number(turn) || 0),
      thought: innerThought
    });
    if (towardsPlayer) change.relationShift = towardsPlayer;
    changes[npcName] = change;
  }
  return {
    schema: CHARACTER_MEMORY_DELTA_SCHEMA,
    turn: Math.max(0, Number(turn) || 0),
    changes
  };
}

export function mergeCharacterMemoryDelta(baseMemories = {}, delta = null) {
  const merged = cloneJson(baseMemories && typeof baseMemories === 'object' ? baseMemories : {}) || {};
  if (!delta || delta.schema !== CHARACTER_MEMORY_DELTA_SCHEMA) return merged;
  for (const [npcName, change] of Object.entries(delta.changes || {})) {
    const existing = merged[npcName] && typeof merged[npcName] === 'object'
      ? cloneJson(merged[npcName])
      : {
          npcName,
          personality: '',
          currentMood: '平静',
          privateGoals: [],
          knownFacts: [],
          relationToPlayer: {},
          recentActions: [],
          privateIntentHistory: []
        };
    existing.npcName = existing.npcName || npcName;
    existing.knownFacts = Array.isArray(existing.knownFacts) ? existing.knownFacts : [];
    existing.recentActions = Array.isArray(existing.recentActions) ? existing.recentActions : [];
    existing.privateIntentHistory = Array.isArray(existing.privateIntentHistory) ? existing.privateIntentHistory : [];
    existing.relationToPlayer = existing.relationToPlayer && typeof existing.relationToPlayer === 'object'
      ? existing.relationToPlayer
      : {};
    if (change.currentMood) existing.currentMood = change.currentMood;
    existing.knownFacts.push(...(change.knownFactsAppend || []));
    existing.recentActions.push(...(change.recentActionsAppend || []));
    existing.privateIntentHistory.push(...(change.privateIntentAppend || []));
    if (change.relationShift) existing.relationToPlayer.lastShift = change.relationShift;
    existing.knownFacts = existing.knownFacts.slice(-15);
    existing.recentActions = existing.recentActions.slice(-8);
    existing.privateIntentHistory = existing.privateIntentHistory.slice(-8);
    merged[npcName] = existing;
  }
  return merged;
}

class AgentPipeline {
  constructor({ pipeline, memorySystem, contextBroker = null }) {
    this.pipeline = pipeline;
    this.memorySystem = memorySystem;
    this.runner = new AgentRunner({ pipeline });
    this._aborted = false;
    this._abortReason = null;
    this._pendingCharacterMemoryDelta = null;
    this._pendingStoryPlan = null;
    this._lastAgentAudit = null;
    this._lastSceneBrief = null;
    this._characterDecisions = [];
    this._agentSelfUpdater = false;
    this._activeToolRuntimes = new Set();
    this._turnController = null;
    this.contextBroker = contextBroker || pipeline?._agentContextBroker || new AgentContextBroker();
    this.contextBroker.configure({
      pipeline,
      memorySystem,
      timelineSystem: pipeline?.timelineSystem
    });
    if (pipeline) pipeline._agentContextBroker = this.contextBroker;
  }

  static isEnabled() {
    return getAgentConfig().enabled === true;
  }

  static getMode() {
    return getAgentConfig().mode || 'standard';
  }

  abort(reason = new AgentAbortError()) {
    this._aborted = true;
    this._abortReason = reason instanceof Error ? reason : new AgentAbortError();
    this._turnController?.abort(this._abortReason);
    this.runner.abort(this._abortReason);
    for (const runtime of this._activeToolRuntimes) runtime.abort(this._abortReason);
    this._activeToolRuntimes.clear();
  }

  _getStoryDirection(state) {
    return normalizeStoryDirection(state);
  }

  _storyDirectionFingerprint(state) {
    return storyDirectionFingerprint(this._getStoryDirection(state));
  }

  _storyPlanId(state) {
    const branchHash = hashAgentInput(activeStoryBranch(state));
    const turn = Math.max(0, Number(state?.['系统·回合数']) || 0);
    return `story-plan:${branchHash}:${turn}:sd-${this._storyDirectionFingerprint(state)}`;
  }

  _stageCacheKey(state, userInput) {
    const promptFingerprint = hashAgentInput([
      resolveAgentSystemPrompt('WRITER_OUTLINE'),
      resolveAgentSystemPrompt('WRITER')
    ].join('\n'));
    return `${AGENT_PIPELINE_REVISION}|${activeStoryBranch(state)}|${state?.['系统·回合数'] || 0}|${hashAgentInput(userInput)}|story-direction:${this._storyDirectionFingerprint(state)}|prompts:${promptFingerprint}`;
  }

  // 开始阶段缓存：获取(或新建)本回合的缓存条目，并同步 _stageCacheKeyRef。
  _beginStageCache(state, userInput) {
    const key = this._stageCacheKey(state, userInput);
    this._stageCacheKeyRef = key;
    let entry = agentStageCache.get(key);
    if (!entry) {
      entry = { complete: new Set(), data: {} };
      agentStageCache.set(key, entry);
    }
    return { key, entry };
  }

  _storeStage(entry, stage, data) {
    entry.complete.add(stage);
    Object.assign(entry.data, data);
    agentStageCache.set(this._stageCacheKeyRef, entry);
  }

  _clearStageCache() {
    if (this._stageCacheKeyRef) agentStageCache.delete(this._stageCacheKeyRef);
  }

  async execute(state, userInput, onProgress = () => {}, mainMessages = null) {
    this._aborted = false;
    this._abortReason = null;
    this._turnController = new AbortController();
    this._pendingCharacterMemoryDelta = null;
    this._pendingStoryPlan = null;
    this._lastAgentAudit = null;
    this._lastSceneBrief = null;
    this._characterDecisions = [];
    this._currentStage = null;
    this._stageCacheKeyRef = this._stageCacheKey(state, userInput);
    this.runner.configure();

    const mode = AgentPipeline.getMode();
    const isCombat = !!state._combat?.is_active;
    const agentCfg = getAgentConfig();
    const isFullMode = mode === 'full' || (agentCfg.autoUpgrade && isCombat);

    try {
      const result = await this._run(state, userInput, onProgress, isFullMode, isCombat, mainMessages);
      // 完整成功才清缓存；失败保留，供重试从失败阶段续跑。
      this._clearStageCache();
      return result;
    } catch (err) {
      if (!this._aborted) this.abort(err);
      if (!err.stage) err.stage = this._currentStage || null;
      this.discardPendingCharacterMemoryDelta();
      this.discardPendingStoryPlan();
      console.error('[AgentPipeline] Pipeline failed; turn aborted:', err.message);
      eventBus.emit('agent:failed', { reason: err.message, code: err.code || '', stage: err.stage });
      onProgress('error', `Agent 回合已中止: ${err.message}`);
      throw err;
    }
  }

  async _run(state, userInput, onProgress, isFullMode, isCombat, mainMessages) {
    const timings = {};
    const t0 = Date.now();

    // 阶段断点续跑：恢复本回合已完成的阶段输出，从失败阶段直接续跑(复用上方正确环节)。
    const cached = this._beginStageCache(state, userInput).entry;
    let storyPlan = state?._agent_story_plan || null;
    let selectedDirection = null;
    let outline = null;
    let outlineReviews = null;
    let reviewedOutline = null;
    let characterInputs = [];
    let writingOutline = null;
    if (cached.complete.has('story_plan')) storyPlan = cached.data.storyPlan;
    if (cached.complete.has('brainstorm')) selectedDirection = cached.data.selectedDirection;
    if (cached.complete.has('outline')) outline = cached.data.outline;
    if (cached.complete.has('outline_review')) {
      outline = cached.data.outline;
      outlineReviews = cached.data.outlineReviews || null;
      reviewedOutline = cached.data.reviewedOutline;
    }
    if (cached.complete.has('character_agents')) characterInputs = cached.data.characterInputs;
    if (cached.complete.has('writing_outline')) writingOutline = cached.data.writingOutline;

    // ── Stage 1: 强制历史检索 + 无行动场景简报 ──
    onProgress('context_search', '检索人物、对话与世界历史...');
    const contextStartedAt = Date.now();
    const preflight = await this.contextBroker.preflight({
      state,
      query: userInput,
      audience: 'planner',
      limit: 12
    });
    timings.context_search = Date.now() - contextStartedAt;
    eventBus.emit('agent:context-ready', {
      sources: preflight.sources,
      cache: preflight.cache,
      durationMs: preflight.durationMs
    });
    const sceneBrief = this._buildSceneBrief(state, userInput, preflight);
    this._lastSceneBrief = sceneBrief;
    eventBus.emit('agent:scene-brief', sceneBrief);
    timings.state_snap = Date.now() - t0;
    this._checkAbort();

    // ── Stage 2: 三日条件故事线（日期/分支/重大分歧时刷新） ──
    this._currentStage = 'story_plan';
    const currentStoryPlan = state?._agent_story_plan || null;
    if (cached.complete.has('story_plan')) {
      storyPlan = cached.data.storyPlan;
      this._pendingStoryPlan = storyPlan;
      eventBus.emit('agent:story-plan', { plan: storyPlan, refreshed: true });
    } else if (this._shouldRefreshStoryPlan(state, userInput, currentStoryPlan)) {
      const planStartedAt = Date.now();
      onProgress('story_plan', '规划未来三日条件故事线...');
      storyPlan = await this._generateStoryPlan(state, userInput, sceneBrief, preflight);
      this._pendingStoryPlan = storyPlan;
      this._storeStage(cached, 'story_plan', { storyPlan });
      timings.story_plan = Date.now() - planStartedAt;
      eventBus.emit('agent:story-plan', { plan: storyPlan, refreshed: true });
    } else {
      eventBus.emit('agent:story-plan', { plan: storyPlan, refreshed: false });
    }
    this._checkAbort();

    // ── Stage 3: 头脑风暴（完整模式 + 非战斗） ──
    this._currentStage = 'brainstorm';
    if (isFullMode && !isCombat) {
      const t1 = Date.now();
      if (!cached.complete.has('brainstorm')) {
        onProgress('brainstorm', '头脑风暴中...');
        try {
          selectedDirection = await this._brainstorm(state, userInput);
          this._storeStage(cached, 'brainstorm', { selectedDirection });
          timings.brainstorm = Date.now() - t1;
        } catch (err) {
          console.warn('[AgentPipeline] Brainstorm failed, skipping:', err.message);
          eventBus.emit('agent:stage-skip', { stage: 'brainstorm', reason: err.message });
          timings.brainstorm = Date.now() - t1;
        }
      }
      this._checkAbort();
    }

    // ── Stage 4: 规划场景节拍 ──
    this._currentStage = 'outline';
    const t2 = Date.now();
    if (!cached.complete.has('outline')) {
      onProgress('outline', '构建叙事大纲...');
      try {
        outline = await this._generateOutline(state, userInput, selectedDirection, {
          sceneBrief, storyPlan, preflight
        });
      } catch (error) {
        this._checkAbort();
        if (error?.name === 'AbortError' || error instanceof AgentAbortError) throw error;
        eventBus.emit('agent:stage-skip', { stage: 'outline', reason: error.message });
        outline = normalizeOutlineResult({ beats: [{
          scene: sceneBrief.location,
          participants: sceneBrief.participants,
          openQuestion: sceneBrief.playerIntent
        }] });
      }
      this._storeStage(cached, 'outline', { outline });
    }
    timings.outline = Date.now() - t2;
    this._checkAbort();
    eventBus.emit('agent:outline', { outline });

    // ── Stage 5: 场景节拍建议（并行） ──
    this._currentStage = 'outline_review';
    const t3 = Date.now();
    if (!cached.complete.has('outline_review')) {
      onProgress('review_outline', '收集场景与人物建议...');
      try {
        outlineReviews = await this._reviewOutline(state, outline);
      } catch (error) {
        this._checkAbort();
        if (error?.name === 'AbortError' || error instanceof AgentAbortError) throw error;
        outlineReviews = new Map([['outline-review', { success: false, error: error.message }]]);
      }
      reviewedOutline = this._mergeOutlineReviews(outline, outlineReviews);
      this._storeStage(cached, 'outline_review', { outline, outlineReviews, reviewedOutline });
    }
    timings.review_outline = Date.now() - t3;
    this._checkAbort();

    // ── Stage 6: 收集角色参考素材；缺失素材不阻断正文 ──
    this._currentStage = 'character_agents';
    const involvedNPCs = this._extractInvolvedNPCs(sceneBrief, outline, state, userInput);
    if (involvedNPCs.length > 0 && !cached.complete.has('character_agents')) {
      const t4 = Date.now();
      onProgress('character_agents', `角色代理运行中 (${involvedNPCs.length})...`);
      try {
        characterInputs = await this._runCharacterAgents(
          state,
          userInput,
          involvedNPCs,
          sceneBrief,
          reviewedOutline,
          storyPlan
        );
        this._storeStage(cached, 'character_agents', { characterInputs });
        timings.character_agents = Date.now() - t4;
      } catch (err) {
        this._checkAbort();
        if (err?.name === 'AbortError' || err instanceof AgentAbortError) throw err;
        console.warn('[AgentPipeline] Character material unavailable; writer will use scene context:', err.message);
        eventBus.emit('agent:stage-skip', { stage: 'character_agents', reason: err.message });
        timings.character_agents = Date.now() - t4;
        characterInputs = this._characterDecisions.map(toWriterCharacterDecision);
        this._storeStage(cached, 'character_agents', { characterInputs });
      }
      this._checkAbort();
    }

    if (writingOutline) {
      try {
        writingOutline = normalizeWritingOutlineResult(writingOutline, {
          decisionIds: characterInputs.map(item => item.decisionId).filter(Boolean),
          fallbackOutline: reviewedOutline,
          sceneBrief
        });
      } catch (error) {
        // A cached outline from an older schema must never reach final-writer.
        cached.complete.delete('writing_outline');
        writingOutline = null;
        console.warn('[AgentPipeline] Discarding incompatible cached writing outline:', error.message);
      }
    }

    // ── Stage 7: 详细写作大纲（作为作家的参考材料） ──
    this._currentStage = 'writing';
    const t5 = Date.now();
    if (!cached.complete.has('writing_outline')) {
      onProgress('writing', '编织详细写作大纲...');
      writingOutline = await this._writeWritingOutline(
        state,
        userInput,
        sceneBrief,
        storyPlan,
        reviewedOutline,
        outlineReviews,
        characterInputs
      );
      this._storeStage(cached, 'writing_outline', { writingOutline });
    }
    timings.writing = Date.now() - t5;
    this._checkAbort();
    eventBus.emit('agent:writing-outline', { outline: cloneJson(writingOutline) });

    // ── Stage 8: 收集详细写作大纲的改进建议 ──
    this._currentStage = 'review_draft';
    const t6 = Date.now();
    onProgress('review_draft', '收集详纲改进建议...');
    let outlineDraftReviews;
    try {
      outlineDraftReviews = await this._reviewWritingOutline(state, writingOutline, {
        final: false,
        isFullMode
      });
      timings.review_draft = Date.now() - t6;
    } catch (err) {
      this._checkAbort();
      if (err?.name === 'AbortError' || err instanceof AgentAbortError) throw err;
      console.warn('[AgentPipeline] Writing outline review failed, skipping:', err.message);
      outlineDraftReviews = new Map();
      timings.review_draft = Date.now() - t6;
    }
    this._checkAbort();

    // 意见直接交给最终作家权衡，不因评分或 approved:false 循环重写详纲。
    // ── Stage 10: 整理写作建议与诊断 ──
    this._currentStage = 'final_audit';
    const auditStartedAt = Date.now();
    onProgress('final_audit', '整理人物与连续性写作建议...');
    const finalReviews = new Map([...outlineReviews, ...outlineDraftReviews]);
    try {
      for (const [key, value] of await this._reviewFinalWritingOutline(state, writingOutline)) {
        finalReviews.set(key, value);
      }
    } catch (error) {
      this._checkAbort();
      if (error?.name === 'AbortError' || error instanceof AgentAbortError) throw error;
      finalReviews.set('final-preset-and-character', { success: false, error: error.message });
    }
    // 可搜索的剧情合理性意见也仅供参考。
    const searchReview = await this._reviewWithSearch(
      state,
      userInput,
      writingOutline,
      { outline: true }
    );
    if (searchReview) finalReviews.set('critic-search', searchReview);

    const agentAudit = this._auditFinalOutput({
      state,
      finalText: JSON.stringify(writingOutline),
      sceneBrief,
      storyPlan,
      involvedNPCs,
      reviews: finalReviews
    });
    timings.final_audit = Date.now() - auditStartedAt;
    eventBus.emit('agent:audit', {
      phase: 'writing-outline',
      schema: agentAudit.schema,
      valid: agentAudit.valid,
      errors: [...agentAudit.errors],
      warnings: [...agentAudit.warnings],
      checks: agentAudit.checks,
      auditedAt: agentAudit.auditedAt
    });
    this._checkAbort();

    // ── Stage 11: 结合参考材料单次生成正文 ──
    this._currentStage = 'final_write';
    const finalWriteStartedAt = Date.now();
    onProgress('final_write', '结合详纲与建议生成正文...');
    let finalText = await this._writeFinalText(
      state,
      userInput,
      sceneBrief,
      storyPlan,
      writingOutline,
      finalReviews,
      characterInputs,
      mainMessages
    );
    finalText = attachImportedAssistantPrefill(
      finalText,
      this.pipeline?._lastImportedPresetProfile?.active
        ? this.pipeline?._lastAssistantPrefill
        : ''
    );
    timings.final_write = Date.now() - finalWriteStartedAt;
    this._checkAbort();

    // 正文生成后只做确定性完整性校验，不再把未经审查的正文交给另一个润色模型。
    this._lastAgentAudit = this._auditFinalOutput({
      state,
      finalText,
      sceneBrief,
      storyPlan,
      involvedNPCs,
      reviews: finalReviews,
      // The planning-artifact guard applies to the final narrative only.
      // The preceding audit intentionally receives the structured outline.
      rejectPlanningArtifact: true
    });
    eventBus.emit('agent:audit', {
      phase: 'final-narrative',
      schema: this._lastAgentAudit.schema,
      valid: this._lastAgentAudit.valid,
      errors: [...this._lastAgentAudit.errors],
      warnings: [...this._lastAgentAudit.warnings],
      checks: this._lastAgentAudit.checks,
      auditedAt: this._lastAgentAudit.auditedAt
    });
    if (!this._lastAgentAudit.valid) {
      const error = new Error(`Agent 最终正文校验失败: ${this._lastAgentAudit.errors.join('；')}`);
      error.code = 'AGENT_FINAL_OUTPUT_INVALID';
      throw error;
    }

    // ── Stage 12: 连续性更新代理(记忆/变量/历史)，替代主流水线二次变量系统 ──
    // 终稿校验通过后才运行；产出的 <var>/<relationship>/<memory> 标签追加到正文末尾，
    // 由主流水线 createNarrativeArtifact + _applyInstructions 统一应用。
    this._currentStage = 'continuity_updater';
    onProgress('continuity_updater', '根据最终正文生成变量与连续性更新...');
    this._agentSelfUpdater = false;
    finalText = await this._appendContinuityUpdates(state, userInput, finalText, involvedNPCs, sceneBrief);

    // ── Stage 13: 只建立待提交记忆增量 ──
    this._currentStage = 'archive';
    const t8 = Date.now();
    onProgress('archive', '归档记忆...');
    // 这里只建立待提交增量。主 Pipeline 必须等 NarrativeArtifact 最终 apply 后，
    // 在 TurnCommitGuard 内原子合并；失败、取消或 discard 时丢弃。
    if (this._characterDecisions.length > 0) {
      this._pendingCharacterMemoryDelta = buildCharacterMemoryDelta(this._characterDecisions.map(decision => ({
        npcName: decision.npc,
        ...decision.observable,
        innerThought: decision.private.thought
      })), {
        turn: state['系统·回合数'] || 0
      });
    }
    timings.archive = Date.now() - t8;

    timings.total = Date.now() - t0;
    eventBus.emit('agent:pipeline-complete', { timings, mode: isFullMode ? 'full' : 'standard' });
    console.log('[AgentPipeline] Timings:', timings);

    if (!String(createNarrativeArtifact(finalText).displayText || '').trim()) {
      const error = new Error('Agent 正文为空(终审后 final-writer 可能被截断)，本回合已中止，请重试');
      error.code = 'AGENT_EMPTY_BODY';
      throw error;
    }

    onProgress('done', '生成完成');
    return finalText;
  }

  _createToolRuntime() {
    const runtime = new AgentToolRuntime({ contextBroker: this.contextBroker });
    const baseConfig = stateManager.getAPIConfig?.() || {};
    const agentConfig = getAgentConfig();
    runtime.configure({
      ...baseConfig,
      model: agentConfig.agentModel || baseConfig.model || ''
    });
    this._activeToolRuntimes.add(runtime);
    return runtime;
  }

  _releaseToolRuntime(runtime) {
    this._activeToolRuntimes.delete(runtime);
  }

  _buildSceneBrief(state, userInput, preflight) {
    const playerName = cleanMemoryText(state?.['玩家·姓名'], 80) || '玩家';
    const location = cleanMemoryText(state?.['世界·地点'], 240) || '未知地点';
    const participants = new Set([playerName]);
    const addParticipant = value => {
      const name = cleanMemoryText(value, 80);
      if (!name || /^(?:玩家|主角|路人|路人A|中忍|下忍|上忍|守卫|敌人|众人)$/.test(name)) return;
      participants.add(name);
    };
    addParticipant(state?._combat?.enemy_name);

    const packetPlot = this.pipeline?._lastTurnEvidencePacket?.current_plot || null;
    const matchedSceneIds = new Set(packetPlot?.matched_scene_ids || []);
    const plotSources = packetPlot ? [{
      scenes: (packetPlot.scenes || []).filter(scene => (
        matchedSceneIds.size ? matchedSceneIds.has(scene.id) : (packetPlot.scenes || []).length === 1
      ))
    }] : [];
    // 剧情场景的参与者只在该场景地点与玩家当前位置匹配时才视为在场，
    // 避免把整片区域的常驻角色(如木叶的鸣人/水木/伊鲁卡)误当成本回合在场。
    const locationOverlaps = (sceneLocation) => {
      const a = String(sceneLocation || '');
      const b = String(location || '');
      return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
    };
    for (const plot of plotSources) {
      for (const scene of plot.scenes || []) {
        if (!locationOverlaps(scene.location)) continue;
        for (const name of scene.participants || []) addParticipant(name);
      }
    }

    const recentDialogue = (preflight?.domains?.dialogue?.items || [])
      .slice(0, 6).map(item => item.summary).join('\n');
    // 角色代理只授予“确实被点名”的角色：玩家输入或近期对话明确提到。
    // 不再依据“关系档案里 location 与玩家同一地点”判定在场——那会把整片区域的
    // 常驻 NPC 每回合都拉进角色代理，即使他们并不在当前场景。
    for (const [name] of Object.entries(state?._relationships || {})) {
      if (String(userInput || '').includes(name) || recentDialogue.includes(name)) addParticipant(name);
    }

    const facts = (preflight?.domains?.world?.items || [])
      .slice(0, 8)
      .map(item => cleanMemoryText(item.summary, 700))
      .filter(Boolean);
    if (!facts.length) facts.push(`当前地点：${location}`);
    const evidenceRefs = (preflight?.sources || []).map(source => (
      `${source.kind || 'source'}:${source.id || 'unknown'}`
    ));
    return assertSceneBrief({
      id: `scene:${state?._meta?.active_branch || 'branch_main'}:${state?.['系统·回合数'] || 0}`,
      location,
      time: state?.['世界·时间'] || state?.['世界·年代'] || '',
      participants: [...participants],
      playerIntent: userInput,
      facts,
      constraints: [
        '玩家输入只代表意图，不预设成功或失败',
        '角色代理提供参考，作家可结合既有设定补充合理的人物反应',
        '只使用授权历史和当前分支证据'
      ],
      tensions: (preflight?.domains?.world?.items || [])
        .filter(item => item.id?.includes('current-plot'))
        .slice(0, 4)
        .map(item => cleanMemoryText(item.summary, 500)),
      evidenceRefs
    });
  }

  _shouldRefreshStoryPlan(state, userInput, plan) {
    if (!plan) return true;
    try { assertStoryArcPlan(plan); } catch { return true; }
    const branchId = activeStoryBranch(state);
    const currentDate = currentStoryDate(state);
    if (plan.branchId !== branchId) return true;
    if (currentDate && plan.startDate && plan.startDate !== currentDate) return true;
    if (!Array.isArray(plan.days) || plan.days.length !== 3) return true;
    if (state?._agent_story_plan_invalidated === true) return true;
    const currentDirection = this._getStoryDirection(state);
    const currentDirectionFingerprint = storyDirectionFingerprint(currentDirection);
    const plannedDirectionFingerprint = storyPlanDirectionFingerprint(plan);
    if (currentDirection && plannedDirectionFingerprint !== currentDirectionFingerprint) return true;
    if (!currentDirection && plannedDirectionFingerprint && plannedDirectionFingerprint !== 'none') return true;
    if (/(?:改走|改变计划|拒绝|放弃|背叛|逃离|杀死|另一路线|切换分支)/.test(String(userInput || ''))) {
      return true;
    }
    return (plan.refreshTriggers || []).some(trigger => (
      trigger && String(userInput || '').includes(trigger)
    ));
  }

  _fallbackStoryPlan(state, sceneBrief, reason = '') {
    const date = currentStoryDate(state) || '当前日期';
    const pressure = sceneBrief.tensions[0] || `若局势继续发展，${sceneBrief.location}的现有矛盾可能升级`;
    const storyDirection = this._getStoryDirection(state);
    const preference = storyDirection?.direction || storyDirection?.goals?.[0] || '';
    const avoidance = storyDirection?.avoid?.length
      ? `若推进会触及用户希望避开的内容（${storyDirection.avoid.join('、')}），该推进失效并应重新规划`
      : '';
    return assertStoryArcPlan({
      id: this._storyPlanId(state),
      branchId: activeStoryBranch(state),
      basedOnNodeId: state?._meta?.current_node_id || '',
      startDate: date,
      premise: `围绕${sceneBrief.location}当前局势保持开放推进${preference ? `，将“${preference}”作为可撤销的未来倾向而非既成事实` : ''}${reason ? `（规划代理降级：${reason}）` : ''}`,
      days: [0, 1, 2].map(dayOffset => ({
        dayOffset,
        date: dayOffset === 0 ? date : `当前日期后第${dayOffset}日`,
        pressures: [dayOffset === 0 ? pressure : '若前一日矛盾未解决，相关势力会调整应对方式'],
        opportunities: [preference
          ? `若玩家与相关角色各自的选择自然形成条件，可出现接近“${preference}”的探索机会`
          : '若玩家主动调查或交涉，可获得新的分支信息'],
        triggers: ['玩家选择继续接触当前人物、地点或事件时'],
        invalidationConditions: [
          '玩家离开当前故事线、关键前提改变或切换时间线分支时',
          ...(avoidance ? [avoidance] : [])
        ]
      })),
      refreshTriggers: ['日期变化', '重大分歧', '切换分支']
    }, {
      branchId: activeStoryBranch(state),
      nodeId: state?._meta?.current_node_id || '',
      startDate: date,
      turn: state?.['系统·回合数'] || 0
    });
  }

  async _generateStoryPlan(state, userInput, sceneBrief, preflight) {
    const storyDirection = this._getStoryDirection(state);
    const directionContext = storyDirectionPrompt(storyDirection);
    const runtime = this._createToolRuntime();
    const tools = createNarrativeAgentTools({
      contextBroker: this.contextBroker,
      state,
      userInput,
      audience: 'planner',
      getStoryPlan: () => state?._agent_story_plan || null
    });
    let rawPlan = null;
    try {
      eventBus.emit('agent:subagent-start', { subagent: 'story-planner' });
      const result = await runtime.runAgent({
        definition: {
          id: 'story-planner',
          instructions: resolveAgentSystemPrompt('STORY_PLANNER')
        },
        messages: [{
          role: 'user',
          content: `根据无行动场景简报与已检索历史，设计从当前日期开始的三日条件故事线。\n${JSON.stringify(sceneBrief)}${directionContext ? `\n\n${directionContext}` : ''}`
        }],
        tools,
        outputSchema: { type: 'object' },
        budget: { maxSteps: 7, maxOutputTokens: 2400, temperature: 0.45 },
        state,
        userInput,
        audience: 'planner'
      });
      rawPlan = result.output;
      eventBus.emit('agent:subagent-end', { subagent: 'story-planner', success: true });
    } catch (error) {
      eventBus.emit('agent:subagent-end', {
        subagent: 'story-planner', success: false, error: error.message
      });
      console.warn('[AgentPipeline] Tool story planner failed; using compatibility agent:', error.message);
      try {
        rawPlan = await this.runner.run('story-planner', {
          state,
          userInput,
          taskPrompt: `输出从当前日期开始的三日条件故事线；不得强迫玩家或 NPC 行动。${directionContext ? `\n\n${directionContext}` : ''}`,
          extraContext: {
            sceneBrief,
            storyDirection,
            contextPacket: {
              sources: preflight?.sources || [],
              cache: preflight?.cache || null,
              items: preflight?.items?.slice?.(0, 20) || []
            },
            _pipeline: this.pipeline
          },
          options: { temperature: 0.45, max_tokens: 2400 }
        });
      } catch (fallbackError) {
        console.warn('[AgentPipeline] Story planner unavailable:', fallbackError.message);
        return this._fallbackStoryPlan(state, sceneBrief, fallbackError.message);
      }
    } finally {
      this._releaseToolRuntime(runtime);
    }
    try {
      return assertStoryArcPlan({
        ...rawPlan,
        id: this._storyPlanId(state),
        branchId: activeStoryBranch(state),
        basedOnNodeId: state?._meta?.current_node_id || '',
        startDate: currentStoryDate(state),
        createdAt: Date.now()
      }, {
        branchId: activeStoryBranch(state),
        nodeId: state?._meta?.current_node_id || '',
        startDate: currentStoryDate(state),
        turn: state?.['系统·回合数'] || 0
      });
    } catch (error) {
      console.warn('[AgentPipeline] Story plan contract rejected:', error.message);
      return this._fallbackStoryPlan(state, sceneBrief, error.message);
    }
  }

  // ── Stage Implementations ──

  async _brainstorm(state, userInput) {
    const storyDirection = this._getStoryDirection(state);
    const directionContext = storyDirectionPrompt(storyDirection);
    const rawResult = await this.runner.run('brainstormer', {
      state,
      userInput,
      taskPrompt: `请根据当前状态和玩家输入，提出 3-5 条剧情走向候选。${directionContext ? `\n\n${directionContext}` : ''}`,
      extraContext: {
        storyDirection,
        _pipeline: this.pipeline
      },
      options: { temperature: 0.9, max_tokens: 1024 },
      onChunk: (chunk) => eventBus.emit('agent:stream', { agent: 'brainstormer', chunk })
    });

    this._assertPlannerOutputSafe(rawResult, 'brainstormer');
    const result = normalizeCandidateResult(rawResult);

    if (!result?.candidates?.length) return null;

    const rec = result.recommended || 1;
    const selected = result.candidates.find(c => c.id === rec) || result.candidates[0];
    eventBus.emit('agent:brainstorm', { candidates: result.candidates, selected });
    return selected;
  }

  async _generateOutline(state, userInput, direction, {
    sceneBrief = null,
    storyPlan = null,
    preflight = null,
    feedback = []
  } = {}) {
    const storyDirection = this._getStoryDirection(state);
    const directionContext = storyDirectionPrompt(storyDirection);
    const hint = direction
      ? `\n\n[选定的剧情走向] ${direction.direction}\n理由: ${direction.reason}`
      : '';
    const feedbackText = Array.isArray(feedback) && feedback.length
      ? `\n\n【大纲审查意见，请据此修正大纲，不要重复这些问题】\n${feedback.slice(0, 8).join('\n')}`
      : '';

    const rawResult = await this.runner.run('outliner', {
      state,
      userInput,
      taskPrompt: `请根据当前状态规划场景与世界回应，人物反应可作为建议，尚未发生的行动与结果不作为既成事实。${hint}${directionContext ? `\n\n${directionContext}` : ''}${feedbackText}`,
      extraContext: {
        sceneBrief,
        storyPlan,
        storyDirection,
        contextPacket: preflight ? {
          sources: preflight.sources,
          cache: preflight.cache
        } : null,
        _pipeline: this.pipeline
      },
      options: { temperature: 0.7, max_tokens: 2048 },
      onChunk: (chunk) => eventBus.emit('agent:stream', { agent: 'outliner', chunk })
    });

    this._assertPlannerOutputSafe(rawResult, 'outliner');
    const result = normalizeOutlineResult(rawResult);

    return result.beats.length ? result : normalizeOutlineResult({ beats: [{
      scene: sceneBrief?.location || state?.['世界·地点'] || '当前场景',
      participants: sceneBrief?.participants || [],
      openQuestion: cleanMemoryText(userInput, 600)
    }] });
  }

  async _reviewOutline(state, outline) {
    const results = await this.runner.runParallel([
      {
        type: 'critic-realism',
        key: 'critic-realism',
        params: {
          state,
          taskPrompt: '请审查以下叙事大纲的世界观合理性。',
          extraContext: { outline },
          options: { temperature: 0.3, max_tokens: 1024 },
          onChunk: (chunk) => eventBus.emit('agent:stream', { agent: 'critic-realism', chunk })
        }
      },
      {
        type: 'critic-character',
        key: 'critic-character',
        params: {
          state,
          taskPrompt: '请审查以下叙事大纲中角色行为的一致性。',
          extraContext: { outline },
          options: { temperature: 0.3, max_tokens: 1024 },
          onChunk: (chunk) => eventBus.emit('agent:stream', { agent: 'critic-character', chunk })
        }
      }
    ]);
    return results;
  }

  _mergeOutlineReviews(outline, reviews) {
    const merged = JSON.parse(JSON.stringify(outline));
    merged._writingGuidance = [];

    for (const [, result] of reviews) {
      if (!result?.success || !Array.isArray(result.data?.issues)) continue;
      for (const issue of result.data.issues) {
        if (issue?.beatId) {
          const beat = merged.beats.find(b => b.id === issue.beatId);
          if (beat) {
            beat._reviews = beat._reviews || [];
            beat._reviews.push(issue);
            merged._writingGuidance.push(
              `[Beat ${issue.beatId}] ${issue.rule}: ${issue.suggestion || issue.description}`
            );
          }
        }
      }
    }
    return merged;
  }

  async _writeWritingOutline(
    state,
    userInput,
    sceneBrief,
    storyPlan,
    outline,
    reviews,
    characterInputs,
    { feedback = [] } = {}
  ) {
    const reviewSummary = reviews instanceof Map
      ? [...reviews.entries()].map(([agent, result]) => ({
          agent,
          success: result?.success === true,
          ...(result?.data && typeof result.data === 'object' ? result.data : {}),
          ...(result?.error ? { error: cleanMemoryText(result.error, 500) } : {})
        }))
      : [];
    const boundedFeedback = (Array.isArray(feedback) ? feedback : [])
      .slice(0, 12)
      .map(item => ({
        severity: item?.severity === 'error' ? 'error' : 'warning',
        dimension: cleanMemoryText(item?.dimension || item?.from, 80),
        description: cleanMemoryText(item?.description, 300),
        suggestion: cleanMemoryText(item?.suggestion, 300)
      }));
    let result;
    try {
      result = await this.runner.run('writer-outline', {
        state,
        userInput,
        taskPrompt: [
          '把场景节拍和角色素材组织成结构化详细写作大纲，角色素材按需选用。',
          '只输出约定 JSON；不得输出剧情正文、连续段落、Markdown、推理块或变量标签。',
          boundedFeedback.length
            ? `结合当前剧情权衡这些建议：${JSON.stringify(boundedFeedback)}`
            : ''
        ].filter(Boolean).join('\n'),
        extraContext: {
          sceneBrief,
          storyPlan,
          outline,
          reviews: reviewSummary,
          characterInputs: characterInputs.length > 0 ? characterInputs : undefined,
          _pipeline: this.pipeline
        },
        options: { temperature: 0.45, max_tokens: 4096 },
        onChunk: chunk => eventBus.emit('agent:stream', { agent: 'writer-outline', chunk })
      });
    } catch (error) {
      this._checkAbort();
      if (error?.name === 'AbortError' || error instanceof AgentAbortError) throw error;
      console.warn('[AgentPipeline] Writing outline unavailable; reusing scene plan:', error.message);
      eventBus.emit('agent:stage-skip', { stage: 'writing', reason: error.message });
    }
    return normalizeWritingOutlineResult(result, {
      decisionIds: characterInputs.map(item => item.decisionId).filter(Boolean),
      fallbackOutline: outline,
      sceneBrief
    });
  }

  async _writeFinalText(
    state,
    userInput,
    sceneBrief,
    storyPlan,
    outline,
    reviews,
    characterInputs,
    mainMessages
  ) {
    const reviewSummary = [];
    for (const [type, result] of reviews) {
      if (!result?.success || !result.data) continue;
      reviewSummary.push({ agent: type, ...result.data });
    }
    if (outline._writingGuidance?.length) {
      reviewSummary.push({ agent: 'writing-guidance', constraints: outline._writingGuidance });
    }

    const writerExtraContext = {
      sceneBrief,
      storyPlan,
      writingOutline: outline,
      reviews: reviewSummary,
      characterInputs: characterInputs.length > 0 ? characterInputs : undefined,
      _pipeline: this.pipeline,
      _inheritFromMainPipeline: true,
      _mainMessages: mainMessages
    };
    const characterGuidance = '【角色与写作参考】\n角色代理提供可选素材，不是出场名单或行为许可表。根据已知设定、当前场景与玩家意图安排合理的 NPC 反应，可补充必要人物、行动和台词；无需逐一使用所有素材。意见有冲突或依据不足时自行权衡。将不合理的行动诉求转化为情境内合理的尝试、阻力或结果；面向玩家只写故事，不解释审核、引用编号或代理工作流程。';
    const runtime = this._createToolRuntime();
    const tools = createNarrativeAgentTools({
      contextBroker: this.contextBroker,
      state,
      userInput,
      audience: 'writer',
      getStoryPlan: () => storyPlan,
      delegates: {
        delegate_character: async ({ npc }) => {
          const decision = this._characterDecisions.find(item => item.npc === npc);
          if (!decision) {
            return { found: false, available: this._characterDecisions.map(item => item.npc) };
          }
          return { found: true, decision: toWriterCharacterDecision(decision) };
        },
        delegate_story_planner: async () => cloneJson(storyPlan),
        delegate_reviewer: async ({ task }) => ({
          scheduled: true,
          stage: 'final_audit',
          request: cleanMemoryText(task, 500)
        })
      }
    });
    try {
      const constraint = this.runner._buildWriterConstraint(writerExtraContext, state);
      const inheritedMessages = Array.isArray(mainMessages) ? mainMessages : [];
      const compatibilityText = this.pipeline?._lastImportedPresetProfile?.active
        ? buildImportedPresetOutputCompatibilityPrompt(this.pipeline._lastImportedPresetProfile)
        : IMPORTED_PRESET_OUTPUT_COMPATIBILITY_PROMPT;
      const importedPreset = inheritedMessages.some(message => (
        message?.content === compatibilityText
      ));
      const importedPrefill = importedPreset
        ? String(this.pipeline?._lastAssistantPrefill || '')
        : '';
      const inheritedWithoutCompatibility = inheritedMessages.filter(message => (
        message.content !== compatibilityText
      ));
      let prefillMessage = null;
      if (importedPrefill) {
        for (let index = inheritedWithoutCompatibility.length - 1; index >= 0; index--) {
          const message = inheritedWithoutCompatibility[index];
          if (message?.role === 'assistant' && message.content === importedPrefill) {
            prefillMessage = inheritedWithoutCompatibility.splice(index, 1)[0];
            break;
          }
        }
      }
      // Imported Tavern prompts rely on the compiled cross-role order. Native
      // prompts retain the stable system/history prefix before volatile rules.
      const writerMessages = importedPreset
        ? [
            ...inheritedWithoutCompatibility,
            { role: 'system', content: constraint },
            { role: 'system', content: characterGuidance },
            {
              role: 'user',
              content: '结合详纲、人物素材与改进建议生成本回合完整正文，可为合理性和叙事流畅调整安排。沿用玩家的主预设、篇幅与格式。变量与记忆标签由后续连续性更新器负责。'
            },
            { role: 'system', content: compatibilityText },
            ...(prefillMessage ? [prefillMessage] : [])
          ]
        : [
            ...inheritedWithoutCompatibility.filter(message => message.role === 'system'),
            ...inheritedWithoutCompatibility.filter(message => message.role !== 'system'),
            { role: 'system', content: constraint },
            { role: 'system', content: characterGuidance },
            {
              role: 'user',
              content: '结合详纲、人物素材与改进建议生成本回合完整正文，可为合理性和叙事流畅调整安排。沿用玩家的主预设、篇幅与格式。变量与记忆标签由后续连续性更新器负责。'
            }
          ];
      const result = await runtime.runAgent({
        definition: { id: 'final-writer', instructions: resolveAgentSystemPrompt('WRITER') },
        messages: writerMessages,
        tools,
        budget: { maxSteps: 10, maxOutputTokens: 8192, temperature: 0.82 },
        state,
        userInput,
        audience: 'writer'
      });
      if (result.text?.trim()) {
        const projected = attachImportedAssistantPrefill(result.text, importedPrefill);
        eventBus.emit('agent:stream', { agent: 'final-writer', chunk: projected });
        return projected;
      }
      throw new Error('Tool final-writer returned empty text');
    } catch (error) {
      if (this._aborted) throw error;
      console.warn('[AgentPipeline] Tool final-writer failed; using compatibility writer:', error.message);
      eventBus.emit('agent:writer-fallback', { reason: error.message });
    } finally {
      this._releaseToolRuntime(runtime);
    }

    const importedPrefill = this.pipeline?._lastImportedPresetProfile?.active
      ? String(this.pipeline?._lastAssistantPrefill || '')
      : '';
    const result = await this.runner.run('final-writer', {
      state,
      userInput,
      taskPrompt: `结合详纲、人物素材与改进建议生成完整正文，可按剧情需要调整安排；沿用玩家的主预设、篇幅与格式。变量与记忆标签交给后续连续性更新器。\n${characterGuidance}`,
      extraContext: writerExtraContext,
      options: { temperature: 0.85, max_tokens: 8192 },
      onChunk: importedPrefill
        ? () => {}
        : (chunk) => eventBus.emit('agent:stream', { agent: 'final-writer', chunk })
    });

    const rawResult = typeof result === 'string'
      ? result
      : (result?._raw || result?.text || '');
    if (rawResult) {
      const projected = attachImportedAssistantPrefill(rawResult, importedPrefill);
      if (importedPrefill) {
        eventBus.emit('agent:stream', { agent: 'final-writer', chunk: projected });
      }
      return projected;
    }
    throw new Error('Final writer 未能生成有效正文');
  }

  async _reviewWritingOutline(state, writingOutline, { final = false, isFullMode = false } = {}) {
    const taskPrompt = final
      ? '为这份详纲提出有依据的玩家意图、人物合理性、连续性与因果建议。编号缺失或没有用完角色素材本身不构成问题；意见供作家取舍，不作为出文条件。不要生成正文。'
      : `为这份详纲提出改进建议，不要求逐条采纳，不决定能否生成正文。${isFullMode ? '同时检查战斗空间、感官与环境提示是否充分，但不要撰写这些内容。' : ''}`;
    return this.runner.runParallel([{
      type: 'critic-writing-outline',
      key: final ? 'final-preset-and-character' : 'writing-outline-quality',
      params: {
        state,
        taskPrompt,
        extraContext: { writingOutline, _pipeline: this.pipeline },
        options: { temperature: 0.15, max_tokens: 1600 },
        onChunk: chunk => eventBus.emit('agent:stream', {
          agent: final ? 'critic-writing-outline-final' : 'critic-writing-outline',
          chunk
        })
      }
    }]);
  }

  async _reviewFinalWritingOutline(state, writingOutline) {
    return this._reviewWritingOutline(state, writingOutline, { final: true });
  }

  async _reviewDraft(state, draft, isFullMode) {
    const agents = [
      {
        type: 'critic-character',
        key: 'critic-contract',
        params: {
          state,
          taskPrompt: '请审查正文是否违反玩家开局契约、擅自改写玩家人设，或让NPC无故知道玩家秘密。所有冲突都按 error 报告，并给出可直接执行的改写建议。',
          extraContext: { draft },
          options: { temperature: 0.2, max_tokens: 1024 },
          onChunk: (chunk) => eventBus.emit('agent:stream', { agent: 'critic-contract', chunk })
        }
      },
      {
        type: 'critic-style',
        key: 'critic-style',
        params: {
          state,
          taskPrompt: '请审查以下正文的风格和节奏。',
          extraContext: { draft },
          options: { temperature: 0.3, max_tokens: 1024 },
          onChunk: (chunk) => eventBus.emit('agent:stream', { agent: 'critic-style', chunk })
        }
      }
    ];
    if (isFullMode) {
      agents.push({
        type: 'critic-detail',
        key: 'critic-detail',
        params: {
          state,
          taskPrompt: '请审查以下正文的感官描写和战斗细节质量。',
          extraContext: { draft },
          options: { temperature: 0.3, max_tokens: 1024 },
          onChunk: (chunk) => eventBus.emit('agent:stream', { agent: 'critic-detail', chunk })
        }
      });
    }
    return await this.runner.runParallel(agents);
  }

  _hasSignificantSuggestions(reviews) {
    for (const [, result] of reviews) {
      if (!result.success) continue;
      const score = result.data?.score;
      if (typeof score === 'number' && score < 8) return true;
      if (result.data?.suggestions?.length >= 2) return true;
      if (result.data?.issues?.length >= 1) return true;
    }
    return false;
  }

  async _polishDraft(state, userInput, draft, draftReviews, mainMessages) {
    const suggestions = [];
    for (const [type, result] of draftReviews) {
      if (result.success && result.data?.suggestions) {
        suggestions.push(...result.data.suggestions.map(s => ({ ...s, from: type })));
      }
      if (result.success && result.data?.issues) {
        suggestions.push(...result.data.issues.map(issue => ({
          location: issue.location || (issue.beatId ? `Beat ${issue.beatId}` : '正文相关段落'),
          type: 'opening_contract',
          description: issue.description || issue.rule || '违反玩家开局契约',
          suggestion: issue.suggestion || '按玩家开局契约重写冲突内容',
          from: type
        })));
      }
    }
    if (!suggestions.length) return draft;

    const characterGuidance = '可结合人物设定补充合理反应和台词，角色素材仅供参考，不必逐一使用。';

    const result = await this.runner.run('writer-polish', {
      state,
      userInput,
      taskPrompt: `请权衡审查建议润色正文，保持既有事实和变量标签，改善叙事质量。${characterGuidance}`,
      extraContext: { draft, suggestions, _inheritFromMainPipeline: true, _mainMessages: mainMessages },
      options: { temperature: 0.75, max_tokens: 8192 },
      onChunk: (chunk) => eventBus.emit('agent:stream', { agent: 'writer-polish', chunk })
    });

    const text = typeof result === 'string' ? result : (result?._raw || null);
    return text && text.length > draft.length * 0.5 ? text : draft;
  }

  // 汇总终审(含可搜索审查)里带可执行建议的问题，用于修复重写。
  _collectFinalIssues(reviews) {
    const issues = [];
    for (const [type, result] of reviews) {
      if (!result?.success) continue;
      const data = result.data;
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
      for (const item of [
        ...(Array.isArray(data.issues) ? data.issues : []),
        ...(Array.isArray(data.suggestions) ? data.suggestions : [])
      ]) {
        if (!item || typeof item !== 'object') continue;
        issues.push({
          severity: item.severity === 'error' ? 'error' : 'warning',
          dimension: String(item.dimension || item.rule || item.type || '').slice(0, 80),
          description: String(item.description || item.summary || '').slice(0, 300),
          suggestion: String(item.suggestion || '').slice(0, 300),
          from: String(type || '')
        });
      }
    }
    return issues;
  }

  // 可选润色助手；建议不构成发布门槛，失败时保留原稿。
  async _repairFinalText(state, userInput, draft, issues, mainMessages) {
    const characterGuidance = '可结合人物设定补充合理反应和台词，角色素材仅供参考，不必逐一使用。';
    const issueText = issues
      .filter(issue => issue.severity === 'error')
      .map(issue => `- [${issue.from || issue.dimension || '终审'}] ${issue.description}${issue.suggestion ? ` → 建议：${issue.suggestion}` : ''}`)
      .join('\n');
    if (!issueText) return draft;
    try {
      const result = await this.runner.run('writer-polish', {
        state,
        userInput,
        taskPrompt: `请结合当前情境取舍以下建议，自然改进正文，保持既定事实与结构标签。${characterGuidance}\n\n【改进建议】\n${issueText}`,
        extraContext: { draft, suggestions: issues, _inheritFromMainPipeline: true, _mainMessages: mainMessages },
        options: { temperature: 0.75, max_tokens: 8192 },
        onChunk: (chunk) => eventBus.emit('agent:stream', { agent: 'writer-polish', chunk })
      });
      const text = typeof result === 'string' ? result : (result?._raw || null);
      // 修复稿必须仍有可见正文；若被重写成了纯推理/标签(显示正文为空)，保留原稿。
      if (!text || text.length < draft.length * 0.5) return draft;
      if (!String(createNarrativeArtifact(text).displayText || '').trim()) return draft;
      return text;
    } catch (error) {
      console.warn('[AgentPipeline] Repair rewrite failed, keeping original:', error?.message);
      return draft;
    }
  }

  async _reviewFinalOutput(state, finalText) {
    return this.runner.runParallel([
      {
        type: 'critic-character',
        key: 'final-preset-and-character',
        params: {
          state,
          taskPrompt: '最终审查：正文是否符合玩家预设与开局契约，且所有命名 NPC 行为均可由提供的角色决定支持。严重问题按 error 报告。',
          extraContext: {
            draft: finalText,
            characterInputs: this._characterDecisions.map(toWriterCharacterDecision),
            _pipeline: this.pipeline
          },
          options: { temperature: 0.15, max_tokens: 1200 }
        }
      },
      {
        type: 'critic-realism',
        key: 'final-world-and-state',
        params: {
          state,
          taskPrompt: '最终审查：检查正文可见结果是否违背当前分支事实、人物认知、资源守恒或实力边界。严重问题按 error 报告。',
          extraContext: { draft: finalText, _pipeline: this.pipeline },
          options: { temperature: 0.15, max_tokens: 1200 }
        }
      },
      {
        type: 'critic-style',
        key: 'final-output-shape',
        params: {
          state,
          taskPrompt: '最终审查：确认存在可见正文、自然交互停点和系统要求的尾部结构，不要改写正文。',
          extraContext: { draft: finalText, _pipeline: this.pipeline },
          options: { temperature: 0.15, max_tokens: 1000 }
        }
      }
    ]);
  }

  // 可搜索的剧情合理性审查：用检索工具核对最终正文的时间/记忆一致性。
  // 失败降级为 warning，不中断回合。
  async _reviewWithSearch(state, userInput, finalText, { outline = false } = {}) {
    const reviewTarget = outline && finalText && typeof finalText === 'object'
      ? JSON.stringify(finalText)
      : String(finalText || '');
    const runtime = this._createToolRuntime();
    const tools = createNarrativeAgentTools({
      contextBroker: this.contextBroker,
      state,
      userInput,
      audience: 'reviewer'
    });
    try {
      const result = await runtime.runAgent({
        definition: {
          id: outline ? 'critic-outline-search' : 'critic-search',
          instructions: resolveAgentSystemPrompt(outline ? 'CRITIC_OUTLINE_SEARCH' : 'CRITIC_SEARCH')
        },
        messages: [{
          role: 'user',
          content: outline
            ? `审查以下最终写作大纲的时间、记忆与世界书一致性。必要时使用检索工具核实，不要生成正文或泄露私有信息。\n\n${reviewTarget.slice(0, 12000)}`
            : `审查以下最终正文的剧情合理性，重点核对时间与记忆一致性。必要时使用检索工具核实，不要仅凭正文或预训练知识臆断。\n\n${reviewTarget.slice(0, 12000)}`
        }],
        tools,
        outputSchema: { type: 'object' },
        budget: { maxSteps: 4, maxOutputTokens: 1400, temperature: 0.15 },
        state,
        userInput,
        audience: 'reviewer'
      });
      const output = result?.output;
      return output && typeof output === 'object'
        ? { success: true, data: output }
        : { success: false, error: 'critic-search 未返回结构化结果' };
    } catch (error) {
      if (this._aborted) throw error;
      console.warn('[AgentPipeline] Search review failed, downgraded to warning:', error.message);
      return { success: false, error: error.message };
    } finally {
      this._releaseToolRuntime(runtime);
    }
  }

  // 运行连续性更新代理并把产出的结构标签追加到正文末尾；失败/无标签时原样返回。
  async _appendContinuityUpdates(state, userInput, finalText, involvedNPCs, sceneBrief) {
    try {
      // The updater is a public-fact consumer. Imported presets may wrap their
      // visible prose in private planning/driver blocks, so never let the raw
      // writer envelope become evidence or updater prompt material.
      const safeNarrative = String(createNarrativeArtifact(finalText).displayText || '').trim();
      const characterMemoryDelta = buildCharacterMemoryDelta(this._characterDecisions.map(decision => ({
        npcName: decision.npc,
        ...decision.observable
      })), { turn: state?.['系统·回合数'] || 0 });
      const preliminaryObligations = buildUpdaterObligations({
        state,
        narrativeResponse: safeNarrative,
        evidencePacket: this.pipeline?._lastTurnEvidencePacket || null,
        characterMemoryDelta
      });
      const evidenceView = this.pipeline?._compileUpdaterEvidence?.({
        state,
        userInput,
        narrativeResponse: safeNarrative,
        updateObligations: preliminaryObligations
      }) || this.pipeline?.getTurnEvidenceView?.('updater', { state, userInput }) || null;
      const obligations = evidenceView?.update_obligations || preliminaryObligations;
      const updaterTags = await this._runContinuityUpdater(
        state,
        userInput,
        safeNarrative,
        involvedNPCs,
        sceneBrief,
        evidenceView,
        obligations
      );
      const validation = validateVariableUpdaterOutput(updaterTags, {
        state,
        updateObligations: obligations,
        narrativeResponse: safeNarrative,
        strictRuntimeRequirements: true
      });
      const dailyResult = parseShinobiDailyContract(updaterTags, { required: true });
      if (validation.valid && dailyResult.valid) {
        const enrichedText = insertProjectMachineTail(
          finalText,
          updaterTags,
          this.pipeline?._lastImportedPresetProfile
        );
        this._agentSelfUpdater = true;
        return enrichedText;
      }
      const issues = [...validation.errors, ...dailyResult.errors];
      console.warn('[AgentPipeline] Continuity updater rejected, falling back to pipeline updater:', issues.join('；'));
    } catch (error) {
      console.warn('[AgentPipeline] Continuity updater failed, falling back to pipeline updater:', error?.message);
    }
    return finalText;
  }

  // 连续性更新代理：根据最终正文 + 角色记忆增量 + 当前关系，产出 <var>/<relationship>/<memory> 标签，
  // 替代主流水线的二次变量系统。失败由调用方降级。
  async _runContinuityUpdater(
    state,
    userInput,
    finalText,
    involvedNPCs,
    sceneBrief,
    evidenceView = null,
    updateObligations = null
  ) {
    const characterInputs = (involvedNPCs || []).map(npcName => {
      const relationship = state?._relationships?.[npcName] || {};
      const history = Array.isArray(relationship.history) ? relationship.history : [];
      return {
        npcName,
        currentAffection: relationship.affection,
        currentTrust: relationship.trust,
        currentRespect: relationship.respect,
        innerThoughts: Array.isArray(relationship.inner_thoughts)
          ? relationship.inner_thoughts.join('；')
          : (relationship.inner_thoughts || ''),
        history: history.slice(0, 5).map(entry => entry?.summary || entry)
      };
    });
    const result = await this.runner.run('continuity-updater', {
      state,
      userInput,
      taskPrompt: `根据最终正文与角色记忆增量，输出本回合完整的 <variable_thinking>、<update_manifest>、必要业务标签、唯一 <memory> 和唯一 <shinobi_daily>。人物只写有可靠依据的字段；在场已认识 NPC：${(involvedNPCs || []).join('、') || '(无)'}`,
      extraContext: {
        sceneBrief,
        draft: finalText,
        characterInputs,
        evidenceView,
        updateObligations,
        _pipeline: this.pipeline
      },
      options: { temperature: 0.4, max_tokens: 4096 },
      onChunk: (chunk) => eventBus.emit('agent:stream', { agent: 'continuity-updater', chunk })
    });
    return typeof result === 'string' ? result : (result?._raw || result?.text || '');
  }

  // 是否已由连续性更新代理产出结构标签（供主流水线跳过二次变量系统）。
  didAgentProduceUpdaterTags() {
    return this._agentSelfUpdater === true;
  }

  _buildKnownNpcIdentityIndex(state, sceneBrief, involvedNPCs = []) {
    const playerName = cleanMemoryText(state?.['玩家·姓名'], 80);
    const candidates = new Map();
    const add = (value, canonical = value) => {
      const name = cleanMemoryText(value, 80);
      const canonicalName = cleanMemoryText(canonical, 80);
      const length = [...name].length;
      if (!name || !canonicalName || length < 2 || length > 40) return;
      if (/^(?:玩家|主角|路人|路人A|中忍|下忍|上忍|守卫|敌人|众人|村民)$/.test(name)) return;
      candidates.set(name, canonicalName);
    };

    for (const name of involvedNPCs || []) add(name);
    for (const name of sceneBrief?.participants || []) add(name);
    for (const [name, relationship] of Object.entries(state?._relationships || {})) {
      add(name);
      for (const alias of relationship?.aliases || []) add(alias, name);
    }
    for (const name of Object.keys(state?._agent_memories || {})) add(name);

    const npcNotes = state?._memory?.npc_notes;
    if (npcNotes && typeof npcNotes === 'object' && !Array.isArray(npcNotes)) {
      for (const name of Object.keys(npcNotes)) add(name);
    } else {
      for (const line of String(npcNotes || '').split(/\r?\n/)) {
        const match = line.match(/^([^:：]{2,40})\s*[:：]/);
        if (match) add(match[1]);
      }
    }

    add(state?._combat?.enemy_name);
    add(state?._combat?.enemyName);
    for (const enemy of state?._combat?.enemies || []) add(enemy?.name || enemy?.npcName || enemy);

    const evidencePacket = this.pipeline?._lastTurnEvidencePacket;
    const currentPlot = evidencePacket?.current_plot;
    for (const scene of currentPlot?.scenes || []) {
      for (const name of scene?.participants || []) add(name);
    }
    for (const mention of evidencePacket?.character_mentions || []) {
      const names = Array.isArray(mention?.names) ? mention.names : [];
      const canonicalName = cleanMemoryText(mention?.canonical_name || names[0], 80);
      add(canonicalName);
      for (const name of names) add(name, canonicalName);
    }
    for (const entry of evidencePacket?.worldbook_entries || []) {
      const names = Array.isArray(entry?.character_profile?.names)
        ? entry.character_profile.names
        : [];
      const canonicalName = cleanMemoryText(names[0], 80);
      add(canonicalName);
      for (const name of names) add(name, canonicalName);
    }

    try {
      const snapshot = CANON_DATABASE.getYearSnapshotContext({ state })?.snapshot;
      for (const character of snapshot?.characters || []) add(character?.name);
    } catch (error) {
      console.warn('[AgentPipeline] Canon NPC audit inventory unavailable:', error.message);
    }

    const playerNames = new Set(playerName ? [playerName] : []);
    const playerCanonical = playerName ? (candidates.get(playerName) || playerName) : '';
    if (playerCanonical) {
      for (const [surfaceName, canonicalName] of candidates) {
        if (surfaceName === playerName
          || canonicalName === playerName
          || canonicalName === playerCanonical) {
          playerNames.add(surfaceName);
          playerNames.add(canonicalName);
        }
      }
      for (const name of playerNames) candidates.delete(name);
    }

    return { candidates, playerNames };
  }

  _extractKnownNpcMentions(
    state,
    finalText,
    sceneBrief,
    involvedNPCs = [],
    identityIndex = null
  ) {
    const index = identityIndex || this._buildKnownNpcIdentityIndex(
      state,
      sceneBrief,
      involvedNPCs
    );
    const visibleText = createNarrativeArtifact(finalText).displayText;
    const mentioned = new Set();
    for (const [surfaceName, canonicalName] of [...index.candidates.entries()]
      .sort((a, b) => [...b[0]].length - [...a[0]].length)) {
      if (visibleText.includes(surfaceName)) mentioned.add(canonicalName);
    }
    return [...mentioned];
  }

  _auditFinalOutput({
    state,
    finalText,
    sceneBrief,
    storyPlan,
    involvedNPCs,
    reviews,
    rejectPlanningArtifact = false
  }) {
    const evidenceRefs = [
      ...sceneBrief.evidenceRefs,
      ...this._characterDecisions.map(decision => decision.id)
    ];
    const artifact = createNarrativeArtifact(finalText, { evidenceRefs });
    const tags = artifact.instructions || [];
    // Agent 模式：变量/记忆/日报一律由后续二次变量更新在 commit 边界内产出，
    // 因此审计始终按 deferred-until-commit 处理，writer 无需自附标签。
    const updaterEnabled = true;
    const businessTags = new Set(['var', 'variable', 'combat', 'mission', 'relationship', 'event']);
    const staged = updaterEnabled
      ? {
          variableUpdates: { owner: 'variable-updater', status: 'deferred-until-commit' },
          memory: { owner: 'variable-updater', status: 'deferred-until-commit' },
          shinobiDaily: { owner: 'variable-updater', status: 'deferred-until-commit' }
        }
      : {
          variableUpdates: tags.some(block => businessTags.has(block.tag))
            || tags.some(block => block.tag === 'state_update')
            ? { owner: 'main', status: 'present' }
            : null,
          memory: tags.some(block => block.tag === 'memory')
            ? { owner: 'main', status: 'present' }
            : null,
          shinobiDaily: tags.some(block => block.tag === 'shinobi_daily')
            ? { owner: 'main', status: 'present' }
            : null
        };
    const envelope = createTurnEnvelope({
      turnId: `turn:${state?._meta?.active_branch || 'branch_main'}:${state?.['系统·回合数'] || 0}`,
      branchId: state?._meta?.active_branch || 'branch_main',
      nodeId: state?._meta?.current_node_id || '',
      sceneBrief,
      narrativeArtifact: artifact,
      characterDecisions: this._characterDecisions,
      characterDecisionRefs: this._characterDecisions.map(decision => decision.id),
      staged,
      storyPlan,
      trace: []
    });
    const modelFindings = [];
    let presetCompliant = true;
    let finalPresetReviewerSeen = false;
    for (const [reviewer, result] of reviews || []) {
      const presetReviewer = reviewer === 'final-preset-and-character';
      if (presetReviewer) finalPresetReviewerSeen = true;
      if (!result?.success) {
        if (presetReviewer) presetCompliant = false;
        modelFindings.push({ reviewer, severity: 'warning', description: result?.error || 'reviewer unavailable' });
        continue;
      }
      if (presetReviewer) {
        const data = result.data;
        const parseFailed = /(?:JSON\s*)?解析失败|parse\s+failed/i.test(String(data?.summary || ''));
        let invalidReason = '';
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          invalidReason = 'reviewer returned no structured data';
        } else if (parseFailed) {
          invalidReason = data.summary;
        } else if (data.approved !== true) {
          invalidReason = data.approved === false
            ? 'reviewer suggested changes'
            : 'reviewer omitted an assessment';
        }
        if (invalidReason) {
          presetCompliant = false;
          modelFindings.push({ reviewer, severity: 'warning', description: invalidReason });
        }
      }
      const findings = [
        ...(Array.isArray(result.data?.issues) ? result.data.issues : []),
        ...(Array.isArray(result.data?.suggestions) ? result.data.suggestions : [])
      ];
      for (const finding of findings) {
        if (!finding || typeof finding !== 'object') continue;
        if ((reviewer === 'final-preset-and-character' || reviewer === 'critic-contract')
          && finding.severity === 'error') presetCompliant = false;
        modelFindings.push({ ...cloneJson(finding), reviewer, severity: 'warning' });
      }
    }
    if (!finalPresetReviewerSeen) {
      presetCompliant = false;
      modelFindings.push({
        reviewer: 'final-preset-and-character',
        severity: 'warning',
        description: 'reviewer unavailable'
      });
    }
    const identityIndex = this._buildKnownNpcIdentityIndex(state, sceneBrief, involvedNPCs);
    const mentionedNPCs = this._extractKnownNpcMentions(
      state,
      finalText,
      sceneBrief,
      involvedNPCs,
      identityIndex
    );
    const canonicalIdentity = value => {
      const name = cleanMemoryText(value, 80);
      return identityIndex.candidates.get(name) || name;
    };
    const decisionsByIdentity = new Map(this._characterDecisions.map(decision => (
      [canonicalIdentity(decision.npc), decision]
    )));
    const requiredNpcs = [...new Set([...(involvedNPCs || []), ...mentionedNPCs])]
      .filter(name => !identityIndex.playerNames.has(name))
      .map(name => decisionsByIdentity.get(canonicalIdentity(name))?.npc || name);
    const base = auditTurnEnvelope(envelope, {
      requiredNpcs: [...new Set(requiredNpcs)],
      requireVariables: true,
      requireMemory: true,
      requireDaily: true,
      requireStoryPlan: true,
      presetCompliant
    });
    const errors = [...base.errors];
    const warnings = [...base.warnings];
    if (rejectPlanningArtifact && isWritingOutlineText(finalText)) {
      errors.push('final-writer returned the planning outline instead of visible narrative');
    }
    for (const finding of modelFindings) {
      warnings.push(`${finding.reviewer}: ${finding.description || finding.suggestion || finding.rule || '写作建议'}`);
    }
    for (const decision of this._characterDecisions) {
      const privateThought = cleanMemoryText(decision.private?.thought, 800);
      if (privateThought.length >= 8 && String(finalText).includes(privateThought)) {
        // 字符串重合不足以确定泄密；私有字段在进入作家上下文前已过滤。
        warnings.push(`正文与 ${decision.npc} 的角色代理私有想法有文字重合，请结合剧情核对`);
      }
    }
    return Object.freeze({
      ...base,
      valid: errors.length === 0,
      errors: Object.freeze([...new Set(errors)]),
      warnings: Object.freeze([...new Set(warnings)]),
      modelFindings: Object.freeze(modelFindings),
      mentionedNPCs: Object.freeze(mentionedNPCs),
      envelope,
      evidenceRefs: Object.freeze(evidenceRefs)
    });
  }

  // ── 角色代理 ──

  _extractInvolvedNPCs(sceneBrief, outline, state, userInput) {
    // 角色代理是昂贵的子代理，只授予“可靠在场/已知”的角色：
    // 关系档案已认识、当前战斗敌人、或玩家输入明确点名的 NPC。
    // 场景简报里凭空出现的陌生 NPC（例如 canon 毕业场景 SCN-P1-START-GRAD-01 的
    // 漩涡鸣人/水木/海野伊鲁卡/本届毕业生）不再授予角色代理。
    const known = new Set(Object.keys(state?._relationships || {}));
    const enemy = cleanMemoryText(state?._combat?.enemy_name, 80);
    const inputText = String(userInput || '');
    const npcSet = new Set();
    if (enemy) npcSet.add(enemy);
    for (const name of sceneBrief?.participants || []) {
      const trimmed = String(name || '').trim();
      if (known.has(trimmed) || inputText.includes(trimmed)) npcSet.add(trimmed);
    }
    for (const name of Object.keys(state?._relationships || {})) npcSet.add(String(name || '').trim());
    const playerName = state['玩家·姓名'];
    if (playerName) npcSet.delete(playerName);
    npcSet.delete('玩家');
    return [...npcSet].filter(name => (
      name.length >= 2
      && name.length <= 40
      && !/^(?:主角|路人|路人A|中忍|下忍|上忍|守卫|敌人|众人|村民|本届毕业生)$/.test(name)
    ));
  }

  async _runCharacterAgents(state, userInput, npcNames, sceneBrief, outline, storyPlan) {
    // 所有 NPC 子代理共享同一个并发闸门，避免同时爆发大量上游请求触发限流。
    // 单个素材失败可跳过；取消时停止排队任务，不能伪装成正常降级。
    const decisions = await mapWithConcurrency(
      npcNames,
      async npcName => {
        try {
          return await this._runOneCharacterAgent({
            state, userInput, npcName, sceneBrief, outline, storyPlan
          });
        } catch (error) {
          this._checkAbort();
          if (error?.name === 'AbortError' || error instanceof AgentAbortError) throw error;
          console.warn(`[AgentPipeline] Character material unavailable for ${npcName}:`, error.message);
          eventBus.emit('agent:character-fallback', { npc: npcName, reason: error.message });
          return null;
        }
      },
      {
        maxConcurrency: this.runner.maxConcurrency,
        stopOnError: true,
        signal: this._turnController?.signal
      }
    );
    this._characterDecisions = decisions.filter(Boolean);
    return this._characterDecisions.map(decision => ({
      npcName: decision.npc,
      npc: decision.npc,
      decisionId: decision.id,
      provenance: decision.provenance,
      fallbackReason: decision.fallbackReason,
      ...cloneJson(decision.observable)
    }));
  }

  async _runOneCharacterAgent({ state, userInput, npcName, sceneBrief, outline, storyPlan }) {
    const runtime = this._createToolRuntime();
    const taskPrompt = this._buildCharacterTaskPrompt(
      npcName, state, userInput, sceneBrief, outline, storyPlan
    );
    const tools = createNarrativeAgentTools({
      contextBroker: this.contextBroker,
      state,
      userInput,
      audience: 'npc',
      npcName,
      getStoryPlan: () => null
    });
    let nativeError = null;
    eventBus.emit('agent:subagent-start', { subagent: 'character', npc: npcName });
    try {
      const result = await runtime.runAgent({
        definition: {
          id: `character:${npcName}`,
          instructions: resolveAgentSystemPrompt('CHARACTER_AGENT')
        },
        messages: [{ role: 'user', content: taskPrompt }],
        tools,
        outputSchema: { type: 'object' },
        budget: { maxSteps: 6, maxOutputTokens: 1200, temperature: 0.75 },
        state,
        userInput,
        audience: 'npc',
        npcName
      });
      const decision = assertCharacterDecision({
        ...result.output,
        npc: npcName,
        sceneId: sceneBrief.id,
        evidenceRefs: [
          ...(result.output?.evidenceRefs || []),
          ...(result.preflight?.sources || []).map(source => `${source.kind}:${source.id}`)
        ]
      });
      eventBus.emit('agent:character', {
        npc: npcName,
        response: toWriterCharacterDecision(decision)
      });
      eventBus.emit('agent:subagent-end', {
        subagent: 'character', npc: npcName, success: true, decisionId: decision.id
      });
      return decision;
    } catch (error) {
      nativeError = error;
      this._checkAbort();
      if (error?.name === 'AbortError' || error instanceof AgentAbortError) throw error;
      console.warn(`[AgentPipeline] Tool character agent ${npcName} failed:`, error.message);
    } finally {
      this._releaseToolRuntime(runtime);
    }

    try {
      const result = await this.runner.run('character', {
        state,
        userInput,
        taskPrompt,
        extraContext: { npcName, sceneBrief, storyPlan, _pipeline: this.pipeline },
        options: { temperature: 0.75, max_tokens: 1200 },
        // Character JSON can contain private thought. It is parsed internally and
        // never streamed onto the shared event bus.
      });
      const decision = assertCharacterDecision({
        ...result,
        npc: npcName,
        sceneId: sceneBrief.id,
        evidenceRefs: sceneBrief.evidenceRefs
      });
      eventBus.emit('agent:character', {
        npc: npcName,
        response: toWriterCharacterDecision(decision)
      });
      eventBus.emit('agent:subagent-end', {
        subagent: 'character', npc: npcName, success: true,
        decisionId: decision.id, compatibilityFallback: true
      });
      return decision;
    } catch (compatibilityError) {
      this._checkAbort();
      if (compatibilityError?.name === 'AbortError' || compatibilityError instanceof AgentAbortError) throw compatibilityError;
      const fallbackReason = [nativeError?.message, compatibilityError?.message]
        .filter(Boolean).join(' | ').slice(0, 500);
      console.warn(`[AgentPipeline] Skipping unavailable character material for ${npcName}: ${fallbackReason}`);
      eventBus.emit('agent:character-fallback', {
        npc: npcName,
        reason: fallbackReason
      });
      eventBus.emit('agent:subagent-end', {
        subagent: 'character', npc: npcName, success: false,
        fallback: 'writer'
      });
      return null;
    }
  }

  _buildCharacterTaskPrompt(npcName, state, userInput, sceneBrief, outline, storyPlan) {
    const rel = state._relationships?.[npcName];
    const rawNpcNotes = state._memory?.npc_notes;
    const npcNotes = typeof rawNpcNotes === 'string'
      ? rawNpcNotes.split('\n')
          .filter(line => line.startsWith(`${npcName}: `))
          .slice(-3)
          .map(line => line.slice(npcName.length + 2))
          .join(' | ')
      : (rawNpcNotes?.[npcName] || '');
    const charMemory = state._agent_memories?.[npcName];

    let prompt = `你现在是「${npcName}」。\n`;
    if (rel) {
      prompt += `与玩家(${state['玩家·姓名'] || '玩家'})的关系: 好感${rel.affection || 0} 信任${rel.trust || 0} 尊重${rel.respect || 0}`;
      if (rel.role) prompt += ` 角色:${rel.role}`;
      prompt += '\n';
    }
    if (npcNotes) prompt += `GM备注: ${npcNotes}\n`;
    if (charMemory) {
      prompt += `你的私有记忆:\n`;
      if (charMemory.personality) prompt += `- 性格: ${charMemory.personality}\n`;
      if (charMemory.currentMood) prompt += `- 当前情绪: ${charMemory.currentMood}\n`;
      if (charMemory.privateGoals?.length) prompt += `- 目标: ${charMemory.privateGoals.join(', ')}\n`;
      if (charMemory.knownFacts?.length) prompt += `- 近期记忆: ${charMemory.knownFacts.slice(-5).join('; ')}\n`;
      if (charMemory.privateIntentHistory?.length) {
        prompt += `- 仅你本人知道的近期意图: ${charMemory.privateIntentHistory.slice(-3).map(item => item.thought).filter(Boolean).join('; ')}\n`;
      }
    }
    prompt += `\n无行动场景简报（导演没有替你决定行为）:\n${JSON.stringify(sceneBrief)}\n`;
    prompt += `\n场景节拍只描述事实、压力和待回答问题:\n${JSON.stringify(outline)}\n`;
    if (storyPlan?.days?.[0]) {
      prompt += `\n今日条件压力与机会（不是强制剧情）:\n${JSON.stringify(storyPlan.days[0])}\n`;
    }
    prompt += `\n玩家输入只是意图：${String(state['玩家·姓名'] || '玩家')}提出了“${cleanMemoryText(userInput, 500)}”。`;
    prompt += `\n现在仅由你本人决定「${npcName}」的可观察行为和台词，并把私有想法放入 innerThought。`;
    return prompt;
  }

  peekPendingCharacterMemoryDelta() {
    return cloneJson(this._pendingCharacterMemoryDelta);
  }

  consumePendingCharacterMemoryDelta() {
    const delta = this.peekPendingCharacterMemoryDelta();
    this._pendingCharacterMemoryDelta = null;
    return delta;
  }

  discardPendingCharacterMemoryDelta() {
    this._pendingCharacterMemoryDelta = null;
  }

  peekPendingStoryPlan() {
    return cloneJson(this._pendingStoryPlan);
  }

  consumePendingStoryPlan() {
    const plan = this.peekPendingStoryPlan();
    this._pendingStoryPlan = null;
    return plan;
  }

  discardPendingStoryPlan() {
    this._pendingStoryPlan = null;
  }

  getLastAgentAudit() {
    return this._lastAgentAudit;
  }

  getLastEvidenceRefs() {
    return [...(this._lastAgentAudit?.evidenceRefs || [])];
  }

  // ── Utility ──

  _assertPlannerOutputSafe(value, stage) {
    const packet = this.pipeline?._lastTurnEvidencePacket;
    const restrictedWorldbook = (packet?.worldbook_entries || []).filter(entry => (
      entry?.knowledge?.visibility === 'secret' || entry?.knowledge?.visibility === 'backstage'
    ));
    if (!restrictedWorldbook.length || value == null) return;
    const serialized = JSON.stringify(value);
    const markers = new Set();
    for (const entry of restrictedWorldbook) {
      if (entry.id) markers.add(entry.id);
      if (String(entry.title || '').trim().length >= 4) markers.add(String(entry.title).trim());
      for (const fragment of String(entry.content || '').split(/[\n。！？；]+/)) {
        if (fragment.trim().length >= 10) markers.add(fragment.trim());
      }
    }
    const hit = [...markers].find(marker => serialized.includes(marker));
    if (hit) throw new Error(`${stage} 输出泄露受限制的私密内容: ${hit}`);
  }

  _checkAbort() {
    if (this._aborted) throw (this._abortReason || new AgentAbortError());
  }
}

export { AgentPipeline };
