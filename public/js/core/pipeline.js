import { stateManager } from './state-manager.js';
import { AIClient, aiClient } from './ai-client.js';
import { instructionParser } from './instruction-parser.js';
import { eventBus } from './event-bus.js';
import { ALLOWED_TAGS, generateMainVarInstructions } from '../data/var-schema.js';
import { getMemoryConfig } from '../data/memory-config.js';
import { getMainPreset, normalizePresetActivation, resolvePresetMacros } from '../data/default-preset.js';
import { formatGameTime } from '../utils/format.js';
import { GAME_DATA } from '../data/game-data.js';
import {
  resolveCanonTechnique,
  sanitizeGeneratedStateSkill,
  toCanonicalStateSkill
} from '../data/canon-database.js';
import { AgentPipeline, mergeCharacterMemoryDelta } from './agent-pipeline.js';
import { getAgentConfig } from '../data/agent-config.js';
import { runVariableUpdater } from './variable-updater.js';
import {
  applyNarrativeReview,
  discardNarrativeReview,
  isNarrativeReviewEnabled,
  resolveNarrativeReviewArtifact,
  runNarrativeReviewPreview,
  toNarrativeReviewPreviewView
} from './narrative-review.js';
import { publishPromptTrace } from './prompt-trace.js';
import { equipmentSystem } from '../systems/equipment-system.js';
import { skillSystem } from '../systems/skill-system.js';
import {
  CUSTOM_TALENT_PLACEHOLDER,
  collectOpeningStateRepairs,
  isCustomTalentPlaceholder
} from '../systems/opening-draft.js';
import {
  NPC_SUMMARY_POLICIES,
  findRecoverableNpcSummary,
  inspectNpcSummaryCompletion,
  requestCompleteNpcSummary
} from './npc-summary.js';
import {
  formatOpeningContractPrompt,
  resolveOpeningContract,
  validateOpeningContractWrite
} from '../systems/opening-contract.js';
import { extractImageContract } from './image-studio/contracts.js';
import {
  SHINOBI_DAILY_DELEGATION_PROMPT,
  buildShinobiDailyPrompt,
  parseShinobiDailyContract
} from './shinobi-daily.js';
import { ImageSettingsStore } from './image-studio/settings.js';
import { resolveAICallPolicy } from './ai-call-policy.js';
import { beginTurnCommit } from './turn-commit.js';
import {
  buildUpdaterObligations,
  projectCharacterMemoryDeltaForUpdater,
  TurnEvidenceCompiler,
  renderEvidenceView
} from './turn-evidence.js';
import {
  createNarrativeArtifact,
  renderNarrativeInstructions,
  toPersistedNarrative
} from './narrative-artifact.js';
import {
  MAIN_SINGLE_CALL_DELIVERY_REMINDER,
  MAIN_SINGLE_CALL_OUTPUT_PROMPT,
  assertMainOutputContract
} from './main-output-contract.js';
import { buildContinuityDelta } from './continuity-delta.js';
import { toWriterCharacterDecision } from './agent-contracts.js';
import {
  IMPORTED_PRESET_SINGLE_CALL_NO_CHANGE_EXAMPLE,
  MAIN_SINGLE_CALL_NO_CHANGE_EXAMPLE
} from '../data/prompts.js';
import { applyPresetPromptRegex } from './preset-regex-runtime.js';
import { readLoadedBuild } from '../utils/build-version.js';
import {
  clearImportedPresetDebugLog,
  recordImportedPresetDebugFailure
} from './imported-preset-debug-log.js';
import {
  IMPORTED_PRESET_OUTPUT_INCOMPLETE,
  IMPORTED_PRESET_SINGLE_CALL_DELIVERY_REMINDER,
  assertImportedPresetOutputEnvelope,
  attachImportedAssistantPrefill,
  buildImportedPresetModePrompt,
  buildImportedPresetOutputCompatibilityPrompt,
  inspectImportedPresetOutputProfile,
  repairImportedPresetOutputEnvelope
} from './main-preset-compatibility.js';

const imageSettingsStore = new ImageSettingsStore();

const UPDATER_ENABLED_OWNERSHIP_PATTERN = /(?:变量模型开启时|后台(?:独立|二次)?变量(?:更新)?模型(?:已)?启用|由(?:后台|二次)变量模型(?:独立)?(?:生成|负责))/u;
const UPDATER_DISABLED_OWNERSHIP_PATTERN = /(?:变量模型关闭时|后台变量模型(?:未启用|已关闭)|严格只调用一次主模型|没有后台变量模型补写)/u;
const REASONING_CHECKLIST_MARKERS = Object.freeze([
  '1. 本轮请求原文：',
  '2. 任务拆解与硬约束：',
  '3. 权威证据与不确定项：',
  '4. 时间线、地点与场景：',
  '5. 玩家意图、行动边界与判定：',
  '6. NPC动机、知识边界与关系：',
  '7. 连续性状态：',
  '8. 因果、结果、记账与停止点：'
]);

function containsFullReasoningChecklist(content) {
  const text = String(content || '');
  return text.includes('<reasoning>')
    && REASONING_CHECKLIST_MARKERS.every(marker => text.includes(marker));
}

function conflictsWithEffectiveUpdaterMode(entry, updaterEnabled) {
  if (normalizePresetActivation(entry?.activation) !== 'always') return false;
  const content = String(entry?.content || '');
  return updaterEnabled
    ? UPDATER_DISABLED_OWNERSHIP_PATTERN.test(content)
    : UPDATER_ENABLED_OWNERSHIP_PATTERN.test(content);
}

function normalizeTavernPosition(entry) {
  const position = String(entry?.tavernPosition || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  const absolute = Number(entry?.sourceMeta?.injectionPosition) === 1;
  if (absolute || ['absolute', 'depth', 'in-chat', 'inchat'].includes(position)) return 'depth';
  if (['bottom', 'after-history', 'afterhistory'].includes(position)) return 'bottom';
  return 'top';
}

function normalizeTavernDepth(entry) {
  const value = entry?.tavernDepth ?? entry?.sourceMeta?.injectionDepth;
  const depth = Number(value);
  return Number.isInteger(depth) && depth >= 0 ? depth : 0;
}

function normalizeTavernOrder(entry, fallback = 0) {
  const value = entry?.tavernOrder ?? entry?.sourceMeta?.injectionOrder;
  const order = Number(value);
  return Number.isFinite(order) ? order : fallback;
}

function injectPresetDepthMessages(conversation, injections) {
  const base = Array.isArray(conversation) ? conversation : [];
  if (!Array.isArray(injections) || injections.length === 0) return [...base];

  const slots = new Map();
  for (const injection of injections) {
    const depth = normalizeTavernDepth(injection.entry);
    const anchor = Math.max(0, base.length - Math.min(depth, base.length));
    if (!slots.has(anchor)) slots.set(anchor, []);
    slots.get(anchor).push(injection);
  }
  for (const slot of slots.values()) {
    slot.sort((left, right) => (
      normalizeTavernOrder(left.entry, left.sourceOrder)
      - normalizeTavernOrder(right.entry, right.sourceOrder)
      || left.sourceOrder - right.sourceOrder
    ));
  }

  const merged = [];
  for (let index = 0; index <= base.length; index++) {
    if (slots.has(index)) merged.push(...slots.get(index));
    if (index < base.length) merged.push(base[index]);
  }
  return merged;
}

function filterCharacterMemoryDelta(delta, presentNpcs = []) {
  if (!delta?.changes || typeof delta.changes !== 'object') return delta || null;
  const allowed = new Set((presentNpcs || []).flatMap(item => [item?.npc, ...(item?.aliases || [])])
    .map(value => String(value || '').trim()).filter(Boolean));
  const changes = Object.fromEntries(Object.entries(delta.changes).filter(([name, change]) => (
    allowed.has(String(change?.npcName || name).trim())
  )));
  return Object.keys(changes).length ? { ...delta, changes } : null;
}

const IMAGE_CONTRACT_PROMPT = `【隐藏绘图契约】
当且仅当你完成本回合全部正文和运行时结构标签后，再追加一个 <image_contract version="1"> 标签。标签内容必须是严格 JSON，不得使用 Markdown 代码围栏，不得在正文中提及它。
JSON 格式：
{"schema":"naruto.visual-contract/v1","purpose":"turn_illustration","scene":{"summary":"最值得定格的单一画面","location":"地点","action":"动作与环境","mood":"氛围"},"shot":{"framing":"景别","viewpoint":"视角","composition":"构图","lighting":"光线"},"subjects":[{"id":"稳定角色ID（未知可留空）","name":"姓名","appearance":"仅写已知外观","pose":"姿态","expression":"表情"}],"style":{"positive":["画面风格"],"negative":["应避免的元素"]},"continuity":{"keep":["必须保持的已知特征"],"avoid":["不得出现的错误或剧透"]}}
绘图契约内所有文本字段（scene 的 summary/location/action/mood、shot、subjects 的外观姿态表情、style.positive/negative、continuity.keep/avoid）一律用英文书写，优先采用动漫常见的英文标签词汇；正文叙事仍用中文，二者互不影响。
不得把未公开秘密、NPC心声或推理过程写入绘图契约。`;

const PLAYER_SKILL_TYPES = new Set(['jutsu', 'taijutsu', 'genjutsu', 'support']);
const PLAYER_SKILL_CATEGORIES = new Map([
  ['\u5fcd\u672f', 'jutsu'], ['\u4f53\u672f', 'taijutsu'], ['\u5e7b\u672f', 'genjutsu'], ['\u652f\u63f4', 'support'], ['\u8f85\u52a9', 'support']
]);
const PLAYER_SKILL_FIELDS = new Map([
  ['\u540d\u79f0', 'name'], ['\u7b49\u7ea7', 'rank'], ['\u5c5e\u6027', 'element'], ['\u6d88\u8017', 'cost'],
  ['\u6d88\u8017\u8d44\u6e90', 'resource_type'], ['\u5a01\u529b', 'power'], ['\u719f\u7ec3\u5ea6', 'mastery'],
  ['\u63cf\u8ff0', 'description'], ['\u7c7b\u578b', 'type'], ['\u6570\u636e\u5e93ID', 'technique_id'], ['\u6765\u6e90', 'source'],
  ['name', 'name'], ['rank', 'rank'], ['element', 'element'], ['cost', 'cost'], ['resource', 'resource_type'],
  ['resource_type', 'resource_type'], ['power', 'power'], ['mastery', 'mastery'], ['description', 'description'],
  ['type', 'type'], ['technique_id', 'technique_id'], ['source', 'source']
]);
const PLAYER_SKILL_CATEGORY_NAMES = {
  jutsu: '\u5fcd\u672f', taijutsu: '\u4f53\u672f', genjutsu: '\u5e7b\u672f', support: '\u652f\u63f4'
};
const PLAYER_SKILL_FIELD_NAMES = {
  name: '\u540d\u79f0', rank: '\u7b49\u7ea7', element: '\u5c5e\u6027', cost: '\u6d88\u8017',
  resource_type: '\u6d88\u8017\u8d44\u6e90', power: '\u5a01\u529b', mastery: '\u719f\u7ec3\u5ea6',
  description: '\u63cf\u8ff0', type: '\u7c7b\u578b', technique_id: '\u6570\u636e\u5e93ID', source: '\u6765\u6e90'
};

function normalizePlayerSkillName(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\u00b7:?,??!???()??\-?_]/g, '');
}

function splitSkillField(body, separator) {
  for (const [field, normalized] of PLAYER_SKILL_FIELDS) {
    const suffix = separator + field;
    if (body.endsWith(suffix)) return { name: body.slice(0, -suffix.length), field: normalized };
  }
  return { name: body, field: null };
}

function parseFlatPlayerSkillWrite(update) {
  const prefix = '\u6280\u80fd\u00b7';
  const key = String(update?.key || '');
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  for (const [category, type] of PLAYER_SKILL_CATEGORIES) {
    const categoryPrefix = category + '\u00b7';
    if (!rest.startsWith(categoryPrefix)) continue;
    const parsed = splitSkillField(rest.slice(categoryPrefix.length), '\u00b7');
    return parsed.name ? { ...parsed, type } : null;
  }
  return null;
}

function parsePathPlayerSkillWrite(update) {
  const path = String(update?.path || '');
  if (!path.startsWith('skills.')) return null;
  const rest = path.slice(7);
  const separator = rest.indexOf('.');
  if (separator < 0) return null;
  const type = rest.slice(0, separator);
  if (!PLAYER_SKILL_TYPES.has(type)) return null;
  const parsed = splitSkillField(rest.slice(separator + 1), '.');
  const assignedField = update.op === 'assign' && PLAYER_SKILL_FIELDS.get(String(update.key || ''));
  return parsed.name ? { ...parsed, field: assignedField || parsed.field, type } : null;
}

export function commitGeneratedStoryPlan(manager, storyPlan) {
  if (!storyPlan) return false;
  if (typeof manager?.setSub !== 'function') {
    throw new TypeError('Story plan commit requires stateManager.setSub()');
  }
  manager.setSub('_agent_story_plan', storyPlan);
  manager.setSub('_agent_story_plan_invalidated', false);
  return true;
}

class MessagePipeline {
  constructor({ knowledgeBase, timelineSystem, uiRenderer, combatSystem, missionSystem, relationshipSystem, memorySystem, worldStateSystem }) {
    this.knowledgeBase = knowledgeBase;
    this.timelineSystem = timelineSystem;
    this.uiRenderer = uiRenderer;
    this.combatSystem = combatSystem;
    this.missionSystem = missionSystem;
    this.relationshipSystem = relationshipSystem;
    this.memorySystem = memorySystem;
    this.worldStateSystem = worldStateSystem;
    this.chatHistory = [];
    this.isProcessing = false;
    this._cancelled = false;
    this._lastImportedPresetProfile = inspectImportedPresetOutputProfile(null);
    this._lastImportedPresetRevision = '';
    this._lastAssistantPrefill = '';
    this._npcSummaryInFlight = new Set();
    this._onPresetEdited = () => {
      this._staticSystemPrompt = null;
      this._lastImportedPresetProfile = inspectImportedPresetOutputProfile(null);
      this._lastImportedPresetRevision = '';
      this._lastAssistantPrefill = '';
      this._lastPromptTrace = null;
    };
    eventBus.on('preset:edited', this._onPresetEdited);
    eventBus.on('timeline:branch-switched', () => this._agentContextBroker?.invalidate());
    eventBus.on('timeline:jumped', () => this._agentContextBroker?.invalidate());
    eventBus.on('state:restored', () => this._agentContextBroker?.invalidate());
  }

  cancel() {
    this._cancelled = true;
    aiClient.cancel();
    if (this._secondaryClient) {
      this._secondaryClient.cancel();
      this._secondaryClient = null;
    }
    if (this._reviewClient) {
      this._reviewClient.cancel();
      this._reviewClient = null;
    }
    if (this._agentPipeline) {
      this._agentPipeline.abort();
      this._agentPipeline = null;
    }
  }

  async _requestVariableRecoveryDecision({ error, attempt, recovery, failedOutput = '' }) {
    const safeAppliedCount = Math.max(0, Number(
      recovery?.keptOperationCount ?? recovery?.appliedCount
    ) || 0);
    const safeDroppedCount = Math.max(0, Number(
      recovery?.droppedOperationCount ?? recovery?.droppedCount
    ) || 0);
    const canApplySafe = Boolean(recovery?.output && safeAppliedCount > 0);
    const rejectedOutput = String(failedOutput || '').trim();
    try {
      const decision = await eventBus.request('pipeline:variable-recovery-decision', {
        error: String(error?.message || error || '未知变量错误'),
        code: String(error?.code || ''),
        failureKind: String(error?.failureKind || ''),
        repairStage: String(error?.repairContext?.stage || 'full'),
        diagnosticId: String(error?.attemptDiagnostic?.id || ''),
        attempt: Math.max(1, Number(attempt) || 1),
        canRepair: Boolean(rejectedOutput),
        canApplySafe,
        safeAppliedCount,
        safeDroppedCount,
        recoveryErrors: Array.isArray(recovery?.errors) ? [...recovery.errors] : [],
        unmetObligations: Array.isArray(recovery?.unmetObligations) ? [...recovery.unmetObligations] : [],
        failedOutput: rejectedOutput
      });
      const action = String(decision?.action || '').trim().toLowerCase();
      if (action === 'repair') return rejectedOutput ? { action } : { action: 'regenerate' };
      if (action === 'regenerate' || action === 'skip') return { action };
      if (action === 'apply-safe') return canApplySafe ? { action } : { action: 'skip' };
      return { action: canApplySafe ? 'apply-safe' : 'skip' };
    } catch (decisionError) {
      // Headless runs have no one to ask; the safe subset only contains
      // individually validated updates, so best-effort recovery beats losing
      // the turn's state (locked in by variable-updater-recovery-regression).
      console.warn('[Pipeline] Variable recovery UI unavailable; using safe fallback:', decisionError?.message);
      return { action: canApplySafe ? 'apply-safe' : 'skip' };
    }
  }

  async process(userInput) {
    if (this.isProcessing) return null;
    this.isProcessing = true;
    this._cancelled = false;
    this._lastUserInput = userInput;
    let turnCommit = null;
    let modelRawResponse = '';
    let importedProjectedResponse = '';
    let importedValidationResponse = '';
    let importedValidationStage = '';
    clearImportedPresetDebugLog();
    stateManager.resetLevelUpGuard();
    this.knowledgeBase?.invalidateCache?.();
    eventBus.emit('pipeline:processing', { userInput });

    try {
      let state = stateManager.get();
      const migratedContract = resolveOpeningContract(state);
      if (!state._opening_contract && migratedContract) {
        state._opening_contract = migratedContract;
        stateManager.setSub('_opening_contract', migratedContract);
      }
      const openingRepairs = collectOpeningStateRepairs(state);
      if (openingRepairs.length) {
        stateManager.update(openingRepairs);
        state = stateManager.get();
        eventBus.emit('opening:state-repaired', { updates: openingRepairs });
      }
      if (state['玩家·存活'] === '否') {
        this.isProcessing = false;
        const cause = state['玩家·死因'] || '不明原因';
        eventBus.emit('player:died', { cause, alreadyDead: true });
        return null;
      }

      const dice = this._rollDice();
      const enrichedInput = this._preprocessInput(userInput, state) + this._formatDiceBlock(dice);
      const mainConfig = stateManager.getAPIConfig?.() || {};
      const callPolicy = resolveAICallPolicy({
        apiConfig: mainConfig,
        agentConfig: {
          enabled: AgentPipeline.isEnabled(),
          mode: AgentPipeline.getMode()
        },
        memoryConfig: getMemoryConfig(),
        imageSettings: imageSettingsStore.load()
      });
      this._activeCallPolicy = callPolicy;
      eventBus.emit('pipeline:call-policy', callPolicy);

      // Agent turns always delegate variables, memory and the daily report to
      // their continuity updater.  Freeze that ownership before constructing
      // the main prompt so the writer and commit path cannot disagree.
      const agentWillRun = callPolicy.features.agents && Boolean(state['玩家·姓名']);
      const updaterOwnedTurn = callPolicy.features.variableUpdater || agentWillRun;

      const messages = this._buildPrompt(enrichedInput, state, userInput, {
        updaterEnabled: updaterOwnedTurn,
        strictSingleCall: callPolicy.strictSingleCall
      });
      const importedPresetProfile = this._lastImportedPresetProfile;
      const importedAssistantPrefill = this._lastAssistantPrefill;
      const projectImportedResponse = response => importedPresetProfile?.active
        ? attachImportedAssistantPrefill(response, importedAssistantPrefill)
        : String(response || '');

      let fullResponse = '';
      let shinobiDaily = null;
      let pendingCharacterMemoryDelta = null;
      let pendingStoryPlan = null;
      let agentAudit = null;
      let agentEvidenceRefs = [];
      const reviewRequested = callPolicy.features.narrativeReview
        && isNarrativeReviewEnabled(mainConfig);
      // NarrativeReview intentionally reconstructs a safe display artifact and
      // therefore cannot preserve arbitrary imported XML/regex envelopes.  Keep
      // the imported response intact; its deterministic contract validators
      // still run before any state is committed.
      const reviewEnabled = reviewRequested && !importedPresetProfile?.active;
      if (reviewRequested && importedPresetProfile?.active) {
        eventBus.emit('pipeline:warning', {
          warning: '当前回合使用用户导入预设；为保留其原生输出 wrapper 与正则展示，已跳过正文二次复检。'
        });
      }
      const generationOptions = {
        ...this._getGenerationOptions(),
        ...callPolicy.mainGenerationOptions
      };
      let directTracePublished = false;

      const generateDirect = async () => {
        if (!directTracePublished) {
          publishPromptTrace({
            kind: 'main',
            title: '主叙事模型请求',
            userInput,
            model: mainConfig.model,
            updaterEnabled: callPolicy.features.variableUpdater,
            callMode: callPolicy.mode,
            strictSingleCall: callPolicy.strictSingleCall,
            generationOptions,
            messages,
            messageSources: this._lastPromptTrace?.messageSources,
            injections: this._lastPromptTrace?.injections
          });
          directTracePublished = true;
        }
        if (reviewEnabled || mainConfig.disableStreaming) {
          modelRawResponse = String(await aiClient.chat(messages, generationOptions) || '');
          const response = projectImportedResponse(modelRawResponse);
          if (!reviewEnabled) eventBus.emit('pipeline:chunk', { chunk: response, response });
          return modelRawResponse;
        }
        let streamed = '';
        const response = await aiClient.chatStream(messages, generationOptions, chunk => {
          streamed += chunk;
          const projected = projectImportedResponse(streamed);
          eventBus.emit('pipeline:chunk', { chunk, response: projected });
        });
        modelRawResponse = String(response || streamed || '');
        return modelRawResponse;
      };

      let agentModeActivated = false;
      let agentSelfUpdater = false;
      if (agentWillRun) {
        agentModeActivated = true;
        this._agentPipeline = new AgentPipeline({
          pipeline: this,
          memorySystem: this.memorySystem
        });

        const onProgress = (stage, detail) => {
          eventBus.emit('agent:progress', { stage, detail });
        };

        const activeAgentPipeline = this._agentPipeline;
        try {
          const agentResult = await activeAgentPipeline.execute(state, userInput, onProgress, messages);
          if (!String(agentResult || '').trim()) {
            const error = new Error('Agent 未返回有效正文，本回合已中止');
            error.code = 'AGENT_PIPELINE_EMPTY_RESULT';
            throw error;
          }
          pendingCharacterMemoryDelta = activeAgentPipeline.consumePendingCharacterMemoryDelta?.() || null;
          pendingStoryPlan = activeAgentPipeline.consumePendingStoryPlan?.() || null;
          agentAudit = activeAgentPipeline.getLastAgentAudit?.() || null;
          agentEvidenceRefs = activeAgentPipeline.getLastEvidenceRefs?.() || [];
          modelRawResponse = String(agentResult || '');
          fullResponse = modelRawResponse;
          agentSelfUpdater = activeAgentPipeline.didAgentProduceUpdaterTags?.() || false;
          // Agent 模式通过 agent:stream 事件实时流式推送正文。
        } catch (error) {
          activeAgentPipeline.discardPendingCharacterMemoryDelta?.();
          activeAgentPipeline.discardPendingStoryPlan?.();
          throw error;
        } finally {
          if (this._agentPipeline === activeAgentPipeline) this._agentPipeline = null;
        }
      } else {
        fullResponse = await generateDirect();
      }

      fullResponse = projectImportedResponse(fullResponse);
      importedProjectedResponse = fullResponse;

      if (!fullResponse) {
        this.isProcessing = false;
        throw new Error('AI 未返回有效回复');
      }

      importedValidationStage = 'initial-envelope';
      importedValidationResponse = fullResponse;
      fullResponse = repairImportedPresetOutputEnvelope(fullResponse, importedPresetProfile);
      importedValidationResponse = fullResponse;
      assertImportedPresetOutputEnvelope(fullResponse, importedPresetProfile, {
        draftResponse: instructionParser.cleanupResponse(fullResponse)
      });

      // 只保留主叙事模型本回合显式输出的可展示推演摘要。
      // 它通过完成事件交给 UI，但不会进入正文、聊天历史或时间线存档。
      const currentTurnThinkContent = instructionParser.extractThinkContent(
        fullResponse,
        importedPresetProfile?.privateWrappers
      );
      let acceptedArtifact = createNarrativeArtifact(fullResponse, {
        evidenceRefs: agentEvidenceRefs
      });
      if (reviewEnabled) {
        if (this._cancelled) {
          this.isProcessing = false;
          eventBus.emit('pipeline:cancelled', { partialResponse: '' });
          return { cancelled: true, partialResponse: '' };
        }
        acceptedArtifact = await this._resolveNarrativeReview({
          mainConfig,
          state,
          userInput,
          candidateArtifact: acceptedArtifact,
          agentAudit
        });
        fullResponse = [
          acceptedArtifact.displayText,
          renderNarrativeInstructions(acceptedArtifact)
        ].filter(Boolean).join('\n\n');
        // 只有用户最终选择后的安全正文可以进入普通聊天流。
        eventBus.emit('pipeline:chunk', { chunk: acceptedArtifact.displayText, response: acceptedArtifact.displayText });
      }

      if (this._cancelled) {
        this.isProcessing = false;
        const safeCancelled = instructionParser.cleanupPartialResponse(fullResponse);
        eventBus.emit('pipeline:cancelled', { partialResponse: safeCancelled });
        return { cancelled: true, partialResponse: safeCancelled };
      }

      // 绘图契约必须在任何正文、记忆、历史或时间线写入之前提取并剥离。
      const imageContractResult = extractImageContract(fullResponse);
      fullResponse = imageContractResult.cleanText;
      const imageContract = imageContractResult.contract;
      if (imageContractResult.error) {
        console.warn('[Pipeline] Invalid image contract ignored:', imageContractResult.error.message);
        eventBus.emit('image:contract-invalid', { error: imageContractResult.error.message });
      }

      // 调用策略在回合开始时冻结，避免生成职责与提交职责在中途切换。
      // Agent 模式无条件启用二次变量更新：writing-outline 先产出详纲，
      // final-writer 结合详纲和建议生成正文，标签由后续二次模型产出。
      // 若 agent 已用连续性更新代理产出标签(agentSelfUpdater)，则不剥离、由 createNarrativeArtifact 直接应用。
      const updaterEnabledTurn = updaterOwnedTurn;
      let mainDailyResult = null;
      if (updaterEnabledTurn && !agentSelfUpdater) fullResponse = this._stripUpdaterOwnedTags(fullResponse);
      else {
        mainDailyResult = parseShinobiDailyContract(fullResponse, { required: true });
        if (mainDailyResult.valid) shinobiDaily = mainDailyResult.daily;
      }

      // Image-contract extraction and updater-tag stripping both rewrite the
      // response.  Revalidate imported single-root/wrapper contracts after
      // those rewrites so a truncated updater tag cannot consume the preset's
      // closing envelope and then reach the commit boundary unnoticed.
      importedValidationStage = 'post-machine-processing';
      importedValidationResponse = fullResponse;
      fullResponse = repairImportedPresetOutputEnvelope(fullResponse, importedPresetProfile);
      importedValidationResponse = fullResponse;
      assertImportedPresetOutputEnvelope(fullResponse, importedPresetProfile, {
        draftResponse: instructionParser.cleanupResponse(fullResponse)
      });

      acceptedArtifact = createNarrativeArtifact(fullResponse, {
        evidenceRefs: acceptedArtifact.evidenceRefs
      });
      const instructionText = renderNarrativeInstructions(acceptedArtifact);
      const displayResponse = toPersistedNarrative(acceptedArtifact).replace(/极其|共犯/g, '');
      const instructions = instructionParser.parse(instructionText);
      if (!updaterEnabledTurn) {
        assertMainOutputContract({
          artifact: acceptedArtifact,
          dailyResult: mainDailyResult,
          playerName: state['玩家·姓名'],
          draftResponse: displayResponse
        });
      }
      const obligationState = stateManager.get();
      const obligationEvidence = updaterEnabledTurn
        ? this._compileUpdaterEvidence({
          state: obligationState,
          userInput,
          narrativeResponse: displayResponse
        })
        : this._lastTurnEvidencePacket;
      const updaterCharacterMemoryDelta = projectCharacterMemoryDeltaForUpdater(
        pendingCharacterMemoryDelta
      );
      const updateObligations = buildUpdaterObligations({
        state: obligationState,
        narrativeResponse: displayResponse,
        evidencePacket: obligationEvidence,
        characterMemoryDelta: updaterCharacterMemoryDelta
      });
      pendingCharacterMemoryDelta = filterCharacterMemoryDelta(
        pendingCharacterMemoryDelta,
        updateObligations.present_npcs
      );

      // 之后的状态、记忆与历史写入必须和时间线节点同生共死。
      // 草稿生成及可选复检位于此边界之外，失败内容不会污染运行态。
      turnCommit = beginTurnCommit({ stateManager, chatHistory: this.chatHistory });
      if (pendingCharacterMemoryDelta) {
        const mergedAgentMemories = mergeCharacterMemoryDelta(
          stateManager.getSub('_agent_memories') || {},
          pendingCharacterMemoryDelta
        );
        stateManager.setSub('_agent_memories', mergedAgentMemories);
      }
      commitGeneratedStoryPlan(stateManager, pendingStoryPlan);
      if (agentAudit) {
        stateManager.setSub('_agent_last_audit', {
          schema: agentAudit.schema,
          valid: agentAudit.valid,
          errors: [...(agentAudit.errors || [])],
          warnings: [...(agentAudit.warnings || [])].slice(0, 20),
          checks: agentAudit.checks,
          evidenceRefs: [...(agentAudit.evidenceRefs || [])].slice(0, 120),
          auditedAt: agentAudit.auditedAt || Date.now()
        });
      }
      let finalMemorySummary = null;

      this._applyInstructions(instructions);

      // 解析 <recall> 协议 — 主模型声明需要哪些实体的历史记忆
      if (this.memorySystem && getMemoryConfig().recallEnabled) {
        this.memorySystem.parseRecallTags(instructionText);
      }

      const memories = this._instructionList(instructions.memories, instructions.memory);
      let memoryRecorded = false;
      if (memories.length) {
        const mergedMem = this._mergeMemoryUpdates(memories);
        if (mergedMem.summary) finalMemorySummary = mergedMem.summary;
        this._applyMemoryUpdate(mergedMem, userInput, displayResponse);
        memoryRecorded = true;
      } else if (!updaterEnabledTurn || agentSelfUpdater) {
        // 二次模型未启用，或 agent 自带了更新但未产出 <memory> 标签时，走本地兜底，
        // 保证回合记忆总是被记录(否则提交审计会因记忆缺失而整回合失败)。
        this._rememberRecentTurn(userInput, displayResponse);
        memoryRecorded = true;
      }

      const hasHUD = instructionParser.hasStatusQuery(instructionText);
      const cleanResponse = displayResponse;

      this.chatHistory.push({ role: 'user', content: `[玩家操作]\n${userInput}` });
      this.chatHistory.push({ role: 'assistant', content: displayResponse });
      this._trimHistory();

      // B-13: 等待 secondary updater 完成后再创建 timeline 节点
      let secondarySuccess = false;
      let secondaryDegraded = false;
      // 若 agent 已自行产出更新标签，则不再运行主流水线二次变量系统。
      let shouldRunSecondary = updaterEnabledTurn && !agentSelfUpdater;
      let retryCount = 0;
      const maxRetries = 2;
      let secondaryInstructions = null;
      let secondaryThinkContent = '';
      let secondaryCorrectionInstruction = '';
      let secondaryRepairCandidate = '';
      let secondaryRepairContext = null;

      const applySecondaryResponse = (response, recoveryNote = '') => {
        const payload = typeof response === 'string' ? { output: response, shinobiDaily: null } : (response || {});
        const output = String(payload.output || '');
        const candidateSecondaryThinkContent = instructionParser.extractVarThinkContent(output);
        const extra = instructionParser.parse(output);
        secondaryInstructions = extra;
        if (payload.shinobiDaily) shinobiDaily = payload.shinobiDaily;
        this._applyInstructions(extra, true);
        const secMemories = this._instructionList(extra.memories, extra.memory);
        if (secMemories.length) {
          const secMergedMem = this._mergeMemoryUpdates(secMemories);
          if (secMergedMem.summary) finalMemorySummary = secMergedMem.summary;
          this._applyMemoryUpdate(secMergedMem, userInput, displayResponse);
          memoryRecorded = true;
        }
        eventBus.emit('pipeline:vars-updated');
        secondaryThinkContent = [candidateSecondaryThinkContent, recoveryNote].filter(Boolean).join('\n\n');
      };
      
      while (shouldRunSecondary && !secondarySuccess && !this._cancelled) {
        const secondaryPromise = this._runSecondaryVariableUpdate({
          userInput,
          enrichedInput,
          state,
          narrativeResponse: displayResponse,
          updateObligations,
          correctionInstruction: secondaryCorrectionInstruction,
          repairCandidate: secondaryRepairCandidate,
          repairContext: secondaryRepairContext,
          forceEnabled: agentModeActivated
        });

        try {
          const additionalResponse = await secondaryPromise;
          if (additionalResponse) {
            applySecondaryResponse(additionalResponse);
            secondarySuccess = true;
          } else {
            secondaryDegraded = true;
            secondarySuccess = true; // Disabled or missing config
          }
        } catch (err) {
          console.warn('[Pipeline] Background variable updater failed:', err?.message);
          // A later repair attempt may regress only the daily contract. Keep the
          // latest already-validated edition until a newer valid one replaces it.
          if (err?.shinobiDaily) shinobiDaily = err.shinobiDaily;
          if (err?.repairContext) secondaryRepairContext = err.repairContext;
          retryCount++;
          const candidateRecovery = err?.recovery || (err?.safeOutput
            ? { output: err.safeOutput, appliedCount: 0, droppedCount: 0, errors: [] }
            : null);
          if (err?.code === 'VARIABLE_UPDATER_OUTPUT_INCONSISTENT' && retryCount < maxRetries) {
            secondaryCorrectionInstruction = err.message;
            secondaryRepairCandidate = String(err?.failedOutput || '') || secondaryRepairCandidate;
            const target = secondaryRepairContext?.stage === 'daily' ? '日报'
              : secondaryRepairContext?.stage === 'state' ? '变量与记忆' : '失败输出';
            eventBus.emit('pipeline:warning', { warning: `正在自动修复${target}，已通过校验的部分保留在回合草稿中。` });
            continue;
          }
          const decision = await this._requestVariableRecoveryDecision({
            error: err,
            attempt: retryCount,
            recovery: candidateRecovery,
            failedOutput: err?.failedOutput || ''
          });
          if (decision.action === 'regenerate') {
            secondaryCorrectionInstruction = '';
            secondaryRepairCandidate = '';
            secondaryRepairContext = null;
            eventBus.emit('pipeline:warning', { warning: '正在重新生成本回合二次变量。' });
            continue;
          }
          if (decision.action === 'repair') {
            secondaryCorrectionInstruction = err?.message || '变量输出未通过本地校验';
            // A failed repair may itself return tag-free garbage; keep repairing
            // the last substantive rejected output instead of losing it.
            secondaryRepairCandidate = String(err?.failedOutput || '') || secondaryRepairCandidate;
            eventBus.emit('pipeline:warning', { warning: '正在调用 AI 定向修复错误变量。' });
            continue;
          }
          if (decision.action === 'apply-safe' && candidateRecovery?.output) {
            secondaryDegraded = true;
            const keptCount = candidateRecovery.keptOperationCount ?? candidateRecovery.appliedCount ?? 0;
            const droppedCount = candidateRecovery.droppedOperationCount ?? candidateRecovery.droppedCount ?? 0;
            const recoveryNote = `【二次变量降级】已按你的选择安全保留 ${keptCount} 项可执行更新，丢弃 ${droppedCount} 项无效标签。`;
            try {
              applySecondaryResponse(candidateRecovery.output, recoveryNote);
              if (err?.shinobiDaily) shinobiDaily = err.shinobiDaily;
              eventBus.emit('pipeline:warning', { warning: recoveryNote });
              console.warn('[Pipeline] Secondary updater safe subset applied:', recoveryNote);
            } catch (recoveryError) {
              console.warn('[Pipeline] Secondary updater recovery rejected:', recoveryError?.message);
              eventBus.emit('pipeline:warning', { warning: `二次变量降级恢复失败，已跳过：${recoveryError?.message || '未知错误'}` });
            }
          } else if (decision.action === 'skip') {
            secondaryDegraded = true;
            if (err?.shinobiDaily) shinobiDaily = err.shinobiDaily;
            eventBus.emit('pipeline:warning', { warning: '已跳过本回合二次变量更新，正文将正常提交。' });
          }
          secondarySuccess = true;
        }
      }

      if (this._cancelled) {
        turnCommit.rollback();
        this.isProcessing = false;
        eventBus.emit('pipeline:cancelled', { partialResponse: '' });
        return { cancelled: true, partialResponse: '' };
      }

      // 二次模型超时/跳过时，用本地兜底记忆
      if (shouldRunSecondary && !memoryRecorded) {
        this._rememberRecentTurn(userInput, displayResponse);
        memoryRecorded = true;
      }

      if (agentAudit) {
        const commitAudit = this._buildAgentCommitAudit({
          agentAudit,
          displayResponse,
          // agent 自带标签时按“主模型变量结构”审计（标签在 primaryInstructions 中）。
          updaterEnabled: updaterEnabledTurn && !agentSelfUpdater,
          primaryInstructions: instructions,
          secondaryInstructions,
          secondarySuccess,
          secondaryDegraded,
          memoryRecorded,
          shinobiDaily,
          storyPlan: stateManager.getSub('_agent_story_plan')
        });
        stateManager.setSub('_agent_last_audit', commitAudit);
        eventBus.emit('agent:commit-audit', commitAudit);
        if (!commitAudit.valid) {
          turnCommit.rollback();
          const auditError = new Error(`Agent 提交前系统审计失败：${commitAudit.errors.join('；')}`);
          auditError.code = 'AGENT_TURN_SYSTEM_AUDIT_FAILED';
          auditError.details = commitAudit;
          throw auditError;
        }
      }

      const previousTurn = Math.max(0, Number(stateManager.get('系统·回合数')) || 0);
      const currentTurn = previousTurn + 1;
      stateManager.update([
        { key: '系统·回合数', op: '=', value: currentTurn }
      ]);
      let timelineNode = null;
      if (this.timelineSystem) {
        try {
          const continuityDelta = buildContinuityDelta({
            beforeState: turnCommit.stateSnapshot,
            afterState: stateManager.snapshot(),
            displayText: displayResponse,
            memorySummary: finalMemorySummary,
            turn: currentTurn,
            evidenceRefs: acceptedArtifact.evidenceRefs
          });
          timelineNode = await this.timelineSystem.createNode({
            turnNumber: currentTurn,
            playerInput: userInput,
            aiResponse: displayResponse,
            cleanResponse,
            stateSnapshot: stateManager.snapshot(),
            chatHistory: this.chatHistory,
            memorySummary: finalMemorySummary,
            imageContract,
            shinobiDaily,
            continuityDelta
          });
          turnCommit.commit();
          this._lastTimelineError = null;
        } catch (timelineErr) {
          console.error('[Pipeline] Timeline node creation failed:', timelineErr.message);
          this._lastTimelineError = timelineErr.message;
          turnCommit.rollback();
          const commitError = new Error(`回合未提交，状态与记忆已回滚：${timelineErr.message}`);
          commitError.code = 'TURN_COMMIT_FAILED';
          commitError.cause = timelineErr;
          throw commitError;
        }
      } else {
        // 无时间线的兼容模式以运行态写入作为提交边界。
        turnCommit.commit();
      }

      // AI 记忆任务全部是显式可选功能。严格单调用时只保留本地压缩/投影，绝不发后台请求。
      if (this.memorySystem && callPolicy.allowBackgroundMemoryAI) {
        const mainCfg = stateManager.getAPIConfig() || {};
        const updaterCfg = mainCfg.variableUpdater;
        const memoryCfg = getMemoryConfig();
        const compressCfg = (updaterCfg?.enabled && updaterCfg.model)
          ? {
              backend: (updaterCfg.backend && updaterCfg.backend !== 'inherit') ? updaterCfg.backend : mainCfg.backend,
              apiUrl: updaterCfg.apiUrl || mainCfg.apiUrl,
              apiKey: updaterCfg.apiKey || mainCfg.apiKey,
              model: updaterCfg.model || mainCfg.model
            }
          : mainCfg;
        if (memoryCfg.aiCompressionEnabled && compressCfg.model) {
          const compressClient = new AIClient();
          compressClient.configure(compressCfg);
          this.memorySystem.aiCompress(compressClient).catch((e) => {
            console.warn('[Pipeline] Memory compression failed:', e?.message);
          });
        }

        // 深度整理: 每 N 回合(可配置)用主模型清洗全库
        if (this.memorySystem.shouldDeepConsolidate?.()) {
          const deepCfg = memoryCfg;
          const useUpdater = deepCfg.deepModel === 'updater'
            && updaterCfg?.enabled && updaterCfg.model;
          const deepAcfg = useUpdater
            ? {
                backend: (updaterCfg.backend && updaterCfg.backend !== 'inherit') ? updaterCfg.backend : mainCfg.backend,
                apiUrl: updaterCfg.apiUrl || mainCfg.apiUrl,
                apiKey: updaterCfg.apiKey || mainCfg.apiKey,
                model: updaterCfg.model || mainCfg.model
              }
            : mainCfg;
          if (deepAcfg.model) {
            const deepClient = new AIClient();
            deepClient.configure(deepAcfg);
            this.memorySystem.deepConsolidate(deepClient).catch((e) => {
              console.warn('[Pipeline] Deep consolidation failed:', e?.message);
            });
          }
        }

        // ── 置顶NPC自动总结 ──
        const npcMemCfg = memoryCfg;
        if (npcMemCfg.npcSummaryEnabled) {
          this._checkPinnedNpcSummaries(mainCfg).catch(e => {
            console.warn('[Pipeline] Pinned NPC summary failed:', e?.message);
          });
        }
      }

      if (timelineNode?.id) {
        eventBus.emit('turn:committed', {
          nodeId: timelineNode.id,
          turnCount: currentTurn,
          hasImageContract: Boolean(imageContract),
          allowAuxiliaryAI: callPolicy.allowAuxiliaryAI,
          callMode: callPolicy.mode
        });
      }

      const thinkContent = this._buildTurnVerificationSummary({
        mainReasoning: currentTurnThinkContent,
        variableReasoning: secondaryThinkContent,
        primaryInstructions: instructions,
        secondaryInstructions,
        updaterEnabled: updaterEnabledTurn,
        committed: true,
        timelineEnabled: Boolean(this.timelineSystem)
      });
      eventBus.emit('pipeline:complete', {
        rawResponse: fullResponse,
        cleanResponse,
        thinkContent,
        hasHUD,
        instructions,
        turnCount: currentTurn,
        timelineError: this._lastTimelineError || null,
        timelineNodeId: timelineNode?.id || null,
        shinobiDaily
      });

      this.isProcessing = false;
      return { cleanResponse, rawResponse: fullResponse, hasHUD, instructions, shinobiDaily, timelineNodeId: timelineNode?.id || null };

    } catch (error) {
      this.isProcessing = false;

      if (turnCommit?.isActive) {
        try {
          turnCommit.rollback();
        } catch (rollbackError) {
          console.error('[Pipeline] Turn rollback failed:', rollbackError);
        }
      }

      if (this._cancelled) {
        const hideDraft = isNarrativeReviewEnabled(stateManager.getAPIConfig?.() || {});
        const partialResponse = hideDraft ? '' : instructionParser.cleanupPartialResponse(error?.partialResponse || '');
        eventBus.emit('pipeline:cancelled', { partialResponse });
        return { cancelled: true, partialResponse };
      }

      const rawPartial = error?.partialResponse
        ? (this._lastImportedPresetProfile?.active
            ? attachImportedAssistantPrefill(error.partialResponse, this._lastAssistantPrefill)
            : error.partialResponse)
        : '';
      const partial = rawPartial ? instructionParser.cleanupPartialResponse(rawPartial) : null;
      const isTruncated = Boolean(rawPartial);
      const errorMessage = isTruncated
        ? `生成被截断（安全正文 ${partial?.length || 0} 字），请检查网络后重试。`
        : (error.message || 'AI 生成失败');

      const buildDiagnostic = globalThis.__NARUTO_BUILD_DIAGNOSTIC__ || {};
      const importedPresetDiagnostic = {
        build: String(buildDiagnostic.loadedBuild || readLoadedBuild() || 'dev'),
        latestBuild: String(buildDiagnostic.latestBuild || ''),
        staleBuild: Boolean(buildDiagnostic.stale),
        adapterId: String(this._lastImportedPresetProfile?.adapterId || 'fallback'),
        presetRevision: String(this._lastImportedPresetRevision || ''),
        structureErrors: Array.isArray(error?.details?.errors) ? [...error.details.errors] : [],
        debugLogAvailable: false,
        debugLogStage: ''
      };
      if (error?.code === IMPORTED_PRESET_OUTPUT_INCOMPLETE
        && this._lastImportedPresetProfile?.active) {
        const debugRecord = recordImportedPresetDebugFailure({
          ...importedPresetDiagnostic,
          stage: importedValidationStage || 'envelope-validation',
          error,
          rawResponse: modelRawResponse,
          projectedResponse: importedProjectedResponse,
          validationResponse: importedValidationResponse
        });
        importedPresetDiagnostic.debugLogAvailable = Boolean(debugRecord);
        importedPresetDiagnostic.debugLogStage = String(debugRecord?.stage || '');
      }
      console.warn('[Pipeline] Error:', error.message, {
        partialLength: partial?.length,
        isTruncated,
        ...importedPresetDiagnostic
      });

      const hasPartialContent = partial && partial.trim().length > 50;
      if (hasPartialContent) {
        this._lastStreamedContent = partial;
        this._displayPartialResponse(partial);
      }

      eventBus.emit('pipeline:error', {
        error: errorMessage,
        code: error?.code || '',
        details: error?.details
          ? { ...error.details, importedPresetDiagnostic }
          : { importedPresetDiagnostic },
        missingContracts: error?.missingContracts || [],
        draftResponse: error?.draftResponse || '',
        isTruncated,
        partialResponse: partial,
        lastUserInput: this._lastUserInput
      });

      if (hasPartialContent && isTruncated) return { partialResponse: partial };
      if (errorMessage === error?.message) throw error;
      const surfacedError = new Error(errorMessage);
      surfacedError.cause = error;
      if (error?.code) surfacedError.code = error.code;
      if (error?.details) surfacedError.details = error.details;
      if (error?.missingContracts) surfacedError.missingContracts = error.missingContracts;
      throw surfacedError;
    }
  }

  _displayPartialResponse(partial) {
    const projectedPartial = this._lastImportedPresetProfile?.active
      ? attachImportedAssistantPrefill(partial, this._lastAssistantPrefill)
      : partial;
    const cleanResponse = instructionParser.cleanupPartialResponse(projectedPartial);
    const instructions = instructionParser.parse('');
    eventBus.emit('pipeline:complete', {
      rawResponse: cleanResponse,
      cleanResponse,
      thinkContent: this._buildTurnVerificationSummary({
        mainReasoning: instructionParser.extractThinkContent(
          projectedPartial,
          this._lastImportedPresetProfile?.privateWrappers
        ),
        primaryInstructions: instructions,
        updaterEnabled: false,
        committed: false,
        timelineEnabled: false
      }),
      hasHUD: false,
      instructions,
      turnCount: stateManager.get('系统·回合数') || 1,
      isPartial: true,
      timelineNodeId: null
    });
  }

  _compileUpdaterEvidence({
    state,
    userInput = '',
    narrativeResponse = '',
    updateObligations = null,
    useLatestRuntimeState = false
  }) {
    this._turnEvidenceCompiler ||= new TurnEvidenceCompiler();
    const currentState = useLatestRuntimeState
      ? (stateManager.get() || state || {})
      : (state || stateManager.get() || {});
    const query = [userInput, narrativeResponse].map(value => String(value || '').trim()).filter(Boolean).join('\n\n');
    const packet = this._turnEvidenceCompiler.compile({
      state: currentState,
      userInput: query,
      updateObligations
    });
    const updaterEvidence = this._turnEvidenceCompiler.project(packet, { audience: 'updater' });
    this._lastTurnEvidenceViews ||= {};
    this._lastTurnEvidenceViews.updater = updaterEvidence;
    return updaterEvidence;
  }

  async _runSecondaryVariableUpdate({
    userInput, enrichedInput, state, narrativeResponse, updateObligations = null,
    correctionInstruction = '', repairCandidate = '', repairContext = null, forceEnabled = false
  }) {
    const currentState = stateManager.get() || state || {};
    const updaterEvidence = this._compileUpdaterEvidence({
      state: currentState,
      userInput,
      narrativeResponse,
      updateObligations,
      useLatestRuntimeState: true
    });
    const evidenceContext = renderEvidenceView({ ...updaterEvidence, opening_contract: '' }, { stage: 'variable-updater' });
    let shinobiDaily = null;
    const configuredMain = stateManager.getAPIConfig() || {};
    const configuredUpdater = configuredMain.variableUpdater || {};
    const mainConfig = forceEnabled && configuredMain.variableUpdater?.enabled !== true
      ? {
          ...configuredMain,
          variableUpdater: {
            enabled: true,
            // Agent continuity fallback uses the main provider/account.  An
            // updater that is currently disabled may retain stale credentials
            // and a stale provider/model from an older setup; none of those
            // transport fields are safe to revive implicitly.
            backend: 'inherit',
            model: getAgentConfig().agentModel || configuredMain.model || '',
            temperature: configuredUpdater.temperature,
            maxTokens: configuredUpdater.maxTokens,
            streaming: configuredUpdater.streaming
          }
        }
      : configuredMain;
    const output = await runVariableUpdater({
      mainConfig,
      userInput,
      enrichedInput,
      state: currentState,
      narrativeResponse,
      compactState: updaterEvidence.current_state,
      openingContract: updaterEvidence.opening_contract,
      memoryContext: '',
      knowledgeContext: evidenceContext,
      updateObligations: updaterEvidence.update_obligations || updateObligations,
      correctionInstruction,
      repairCandidate,
      repairContext,
      onClient: (client) => { this._secondaryClient = client; },
      onShinobiDaily: (daily) => { shinobiDaily = daily; }
    });
    return output ? { output, shinobiDaily } : null;
  }

  _buildAgentCommitAudit({
    agentAudit,
    displayResponse,
    updaterEnabled,
    primaryInstructions,
    secondaryInstructions,
    secondarySuccess,
    secondaryDegraded,
    memoryRecorded,
    shinobiDaily,
    storyPlan
  }) {
    const errors = [];
    const warnings = [...(agentAudit?.warnings || [])];
    const narrativePresent = Boolean(String(displayResponse || '').trim());
    const variableStagePresent = updaterEnabled
      ? Boolean(secondaryInstructions)
      : Boolean(primaryInstructions);
    const dailyPresent = Boolean(shinobiDaily);
    const storyPlanPresent = Boolean(storyPlan?.schema === 'naruto.story-arc-plan/v1'
      && Array.isArray(storyPlan.days) && storyPlan.days.length === 3);

    if (!agentAudit?.valid) errors.push('正文交付结构校验未通过');
    if (!narrativePresent) errors.push('缺少可见正文');
    if (!memoryRecorded) errors.push('回合记忆尚未更新');
    if (!storyPlanPresent) warnings.push('三日条件故事计划暂缺，可在后续回合补充');
    if (updaterEnabled && !secondarySuccess) errors.push('二次变量阶段未完成');
    if (!variableStagePresent) {
      const message = updaterEnabled ? '二次变量输出未形成可解析结构' : '主模型变量结构缺失';
      if (secondaryDegraded) warnings.push(message);
      else errors.push(message);
    }
    if (!dailyPresent) {
      errors.push('忍界日报未形成可提交数据');
    }
    if (secondaryDegraded) warnings.push('变量阶段按用户选择或兼容策略降级');
    for (const decision of agentAudit?.envelope?.characterDecisions || []) {
      const privateThought = String(decision?.private?.thought || '').trim();
      if (privateThought.length >= 8 && String(displayResponse || '').includes(privateThought)) {
        warnings.push(`最终正文与 ${decision.npc || 'NPC'} 的角色代理私有想法有文字重合，请结合剧情核对`);
      }
    }

    return Object.freeze({
      schema: 'naruto.agent-commit-audit/v1',
      valid: errors.length === 0,
      errors: Object.freeze([...new Set(errors)]),
      warnings: Object.freeze([...new Set(warnings)].slice(0, 40)),
      checks: Object.freeze({
        narrative: narrativePresent,
        preset: agentAudit?.checks?.preset !== false,
        npcProvenance: agentAudit?.checks?.npcProvenance === true,
        variables: variableStagePresent,
        memory: Boolean(memoryRecorded),
        shinobiDaily: dailyPresent,
        storyPlan: storyPlanPresent,
        atomicCommitPending: true
      }),
      evidenceRefs: Object.freeze([...(agentAudit?.evidenceRefs || [])].slice(0, 120)),
      auditedAt: Date.now()
    });
  }

  getTurnEvidenceView(audience = 'writer', { state = null, userInput = '', entityId = null, npcName = '' } = {}) {
    this._turnEvidenceCompiler ||= new TurnEvidenceCompiler();
    const currentState = state || stateManager.get();
    const packet = this._lastTurnEvidencePacket
      || this._turnEvidenceCompiler.compile({ state: currentState, userInput });
    const view = this._turnEvidenceCompiler.project(packet, { audience, entityId, npcName });
    this._lastTurnEvidenceViews ||= {};
    this._lastTurnEvidenceViews[audience === 'npc' ? `npc:${entityId || npcName}` : audience] = view;
    return view;
  }

  async _resolveNarrativeReview({ mainConfig, state, userInput, candidateArtifact, agentAudit = null }) {
    const reviewerEvidence = this.getTurnEvidenceView('reviewer', { state, userInput });
    const sourceMessages = [
      {
        role: 'system',
        content: renderEvidenceView(reviewerEvidence, { stage: 'narrative-review' })
      },
      {
        role: 'user',
        content: `[玩家本回合原始操作 · 仅表示意图或声称]\n${String(userInput || '')}`
      }
    ];
    const characterDecisions = agentAudit?.envelope?.characterDecisions || [];
    if (characterDecisions.length) {
      sourceMessages.push({
        role: 'system',
        content: `[命名 NPC 的角色代理决定 · 仅可观察投影]\n${JSON.stringify(
          characterDecisions.map(toWriterCharacterDecision)
        )}\n这些是可选写作素材，可结合既有设定补充合理的人物反应与台词，无需逐一使用所有素材。`
      });
    }
    let transaction = null;
    let feedback = '';
    const transactionId = `turn-review:${state?._meta?.current_node_id || 'root'}:${state?.['系统·回合数'] || 0}`;

    while (!this._cancelled) {
      transaction = await runNarrativeReviewPreview({
        transaction,
        transactionId,
        feedback,
        mainConfig,
        sourceMessages,
        candidateArtifact,
        onClient: client => { this._reviewClient = client; }
      });
      if (this._cancelled) return candidateArtifact;

      const previewView = toNarrativeReviewPreviewView(transaction);
      eventBus.emit('pipeline:review-preview-ready', previewView);
      const decision = await eventBus.request('pipeline:review-decision', previewView);
      const action = decision?.action;
      if (action === 'retry') {
        feedback = String(decision?.feedback || '').trim();
        continue;
      }
      if (action === 'apply') {
        transaction = applyNarrativeReview(transaction);
      } else if (action === 'discard') {
        transaction = discardNarrativeReview(transaction);
      } else {
        throw new Error(`未知正文复检操作: ${String(action || 'empty')}`);
      }
      const accepted = resolveNarrativeReviewArtifact(transaction);
      if (!accepted) throw new Error('正文复检尚未得到可提交选择');
      eventBus.emit('pipeline:review-resolved', {
        id: transaction.id,
        decision: transaction.decision,
        attempts: transaction.activeAttempt
      });
      return accepted;
    }
    return candidateArtifact;
  }

  _stripUpdaterOwnedTags(text) {
    let cleaned = String(text || '');
    for (const tag of [
      'var', 'variable', 'var_thinking', 'variable_thinking', 'update_manifest',
      'combat', 'mission', 'relationship', 'memory', 'state_update', 'event', 'shinobi_daily'
    ]) {
      cleaned = cleaned.replace(new RegExp(`<${tag}(?:\\s+[^>]*)?>[\\s\\S]*?(?:<\\/${tag}>|$)`, 'gi'), '');
    }
    return cleaned.replace(/<status_query\s*\/>/gi, '').trim();
  }

  _applyInstructions(instructions, silent = false) {
    const flatVars = [];
    const pathVars = [];
    const combats = [];
    const missions = [];
    const relationships = [];
    const events = [];
    const entityRemovals = [];

    const seenHashes = new Set();
    const equipmentTypeByChinese = {
      '武器': 'weapons', '防具': 'armor', '道具': 'tools', '消耗品': 'consumables'
    };
    const equipmentChineseByType = {
      weapons: '武器', armor: '防具', tools: '道具', consumables: '消耗品'
    };

    const queueEntityRemoval = (path, key) => {
      const normalizedKey = String(key || '').trim();
      if (!normalizedKey) return false;
      const hash = `r:${path}|${normalizedKey}`;
      if (!seenHashes.has(hash)) {
        seenHashes.add(hash);
        entityRemovals.push({ path, op: 'remove', key: normalizedKey });
      }
      return true;
    };

    const replaceCustomTalentPlaceholder = writePath => {
      const flat = String(writePath || '').match(/^技能·(?:天赋|血继限界)·(.+?)(?:·|$)/);
      const nested = String(writePath || '').match(/^skills\.(?:talents|kekkei_genkai)\.([^\.]+)/);
      const talentName = flat?.[1] || nested?.[1] || '';
      if (talentName && !isCustomTalentPlaceholder(talentName)) {
        queueEntityRemoval('skills.talents', CUSTOM_TALENT_PLACEHOLDER);
      }
    };

    const shouldRemoveDepletedItem = (category, itemName, op, value) => {
      const amount = Number(value);
      if (!Number.isFinite(amount)) return false;
      if (op === 'set' || op === '=') return amount <= 0;
      if (op !== 'sub' && op !== '-') return false;
      if (amount <= 0) return false;

      const chineseType = equipmentChineseByType[category];
      const baseKey = `物品·${chineseType}·${itemName}`;
      const storedQuantity = stateManager.get(`${baseKey}·数量`);
      if (storedQuantity != null && Number.isFinite(Number(storedQuantity))) {
        return Number(storedQuantity) <= amount;
      }
      return amount >= 1 && Object.keys(stateManager.state)
        .some(key => key === baseKey || key.startsWith(`${baseKey}·`));
    };

    // Helper to route any JSON object extracted from AI output
    // Same-NPC relationship instructions may legitimately differ (affection vs
    // trust deltas); dedup must ignore key order and prose-only wording so a
    // re-echoed identical change cannot double-apply.
    const RELATIONSHIP_PROSE_FIELDS = new Set(['reason', 'interaction', 'inner_thoughts', 'history', 'info']);
    const relationshipHash = (obj) => {
      const keys = Object.keys(obj).filter(key => !RELATIONSHIP_PROSE_FIELDS.has(key)).sort();
      return 'r:' + obj.npc + '|' + JSON.stringify(keys.map(key => [key, obj[key]]));
    };
    const routeObject = (obj, sourceKind = '') => {
      if (!obj || typeof obj !== 'object') return;

      const isProjectTimelineId = /^(?:DAY|SCN|EV)-[A-Z0-9-]+$/.test(String(obj.id || ''));
      if ((sourceKind === 'event' || isProjectTimelineId) && obj.id && (obj.status || obj.desc || obj.description)) {
        const hash = 'e:' + obj.id + '|' + String(obj.status || 'triggered') + '|' + JSON.stringify(obj.reschedule_to || '');
        if (!seenHashes.has(hash)) { seenHashes.add(hash); events.push(obj); }
        return;
      }

      // 1. Is it a flat variable?
      if (obj.key && ['=', '+', '-'].includes(obj.op)) {
        if (obj.key === '系统·回合数') return;
        const contractCheck = validateOpeningContractWrite(resolveOpeningContract(stateManager.get()), obj.key, obj.value, {
          turn: stateManager.get('系统·回合数'),
          op: obj.op
        });
        if (!contractCheck.allowed) {
          console.warn('[Pipeline] Opening contract rejected variable write:', contractCheck);
          eventBus.emit('state:invalid-write', contractCheck);
          return;
        }
        replaceCustomTalentPlaceholder(obj.key);

        const flatQuantityMatch = obj.key.match(/^物品·(武器|防具|道具|消耗品)·(.+)·数量$/);
        if (flatQuantityMatch) {
          const category = equipmentTypeByChinese[flatQuantityMatch[1]];
          const itemName = flatQuantityMatch[2];
          if (shouldRemoveDepletedItem(category, itemName, obj.op, obj.value)) {
            queueEntityRemoval(`equipment.${category}`, itemName);
            return;
          }
        }

        const hash = 'k:' + obj.key + '|' + obj.op + '|' + JSON.stringify(obj.value);
        if (!seenHashes.has(hash)) { seenHashes.add(hash); flatVars.push(obj); }
        return;
      }

      // 2. Is it a path variable?
      if (typeof obj.path === 'string' && obj.path.trim() && ['set','add','sub','assign','push','remove'].includes(obj.op)) {
        if (obj.path === '系统·回合数') return;
        const writePath = (obj.op === 'assign' || obj.op === 'remove') && obj.key
          ? `${obj.path}.${obj.key}`
          : obj.path;
        const contractCheck = validateOpeningContractWrite(resolveOpeningContract(stateManager.get()), writePath, obj.value, {
          turn: stateManager.get('系统·回合数'),
          op: obj.op
        });
        if (!contractCheck.allowed) {
          console.warn('[Pipeline] Opening contract rejected path write:', contractCheck);
          eventBus.emit('state:invalid-write', contractCheck);
          return;
        }
        replaceCustomTalentPlaceholder(writePath);


        const collectionSkillRemoval = obj.op === 'remove'
          ? obj.path.match(/^skills\.(jutsu|taijutsu|genjutsu|support|talents|kekkei_genkai)$/)
          : null;
        if (collectionSkillRemoval && obj.key) {
          queueEntityRemoval(obj.path, obj.key);
          return;
        }

        const collectionEquipmentRemoval = obj.op === 'remove'
          ? obj.path.match(/^equipment\.(weapons|armor|tools|consumables)$/)
          : null;
        if (collectionEquipmentRemoval && obj.key) {
          queueEntityRemoval(obj.path, obj.key);
          return;
        }

        const specificSkillRemoval = obj.op === 'remove' && !obj.key
          ? obj.path.match(/^skills\.(jutsu|taijutsu|genjutsu|support|talents|kekkei_genkai)\.(.+)$/)
          : null;
        if (specificSkillRemoval) {
          queueEntityRemoval(`skills.${specificSkillRemoval[1]}`, specificSkillRemoval[2]);
          return;
        }

        const specificEquipmentRemoval = obj.op === 'remove' && !obj.key
          ? obj.path.match(/^equipment\.(weapons|armor|tools|consumables)\.(.+?)(?:\.quantity)?$/)
          : null;
        if (specificEquipmentRemoval) {
          queueEntityRemoval(`equipment.${specificEquipmentRemoval[1]}`, specificEquipmentRemoval[2]);
          return;
        }

        const pathQuantityMatch = obj.path.match(/^equipment\.(weapons|armor|tools|consumables)\.(.+)\.quantity$/);
        if (pathQuantityMatch && shouldRemoveDepletedItem(
          pathQuantityMatch[1], pathQuantityMatch[2], obj.op, obj.value
        )) {
          queueEntityRemoval(`equipment.${pathQuantityMatch[1]}`, pathQuantityMatch[2]);
          return;
        }

        const hash = 'p:' + obj.path + '|' + obj.op + '|' + JSON.stringify(obj.key) + '|' + JSON.stringify(obj.value);
        if (!seenHashes.has(hash)) {
          seenHashes.add(hash);
          pathVars.push(obj);
        }
        return;
      }

      // 3. Is it a mission? (Must have id and status)
      if (obj.id && obj.status) {
        const hash = 'm:' + obj.id + '|' + obj.status;
        if (!seenHashes.has(hash)) { seenHashes.add(hash); missions.push(obj); }
        return;
      }

      // 4. Is it a relationship? (Must have npc)
      if (obj.npc) {
        const hash = relationshipHash(obj);
        if (!seenHashes.has(hash)) { seenHashes.add(hash); relationships.push(obj); }
        return;
      }

      // 5. Is it a combat state?
      if (obj.state && ['start', 'round_start', 'player_turn', 'enemy_turn', 'in_progress', 'victory', 'defeat', 'retreat'].includes(obj.state)) {
        const hash = 'c:' + JSON.stringify(obj);
        if (!seenHashes.has(hash)) {
          seenHashes.add(hash);
          combats.push(obj);
        }
        return;
      }

      // 6. Is it an event? (Has id and desc, but no status)
      if (obj.id && obj.desc && !obj.status) {
        events.push(obj);
        return;
      }
    };

    // Pool all objects together from all tags to handle AI mis-tagging
    const allLists = [
      { list: instructions.variables, kind: 'variable' },
      { list: instructions.combats, kind: 'combat' }, { list: instructions.combat, kind: 'combat' },
      { list: instructions.missions, kind: 'mission' }, { list: instructions.mission, kind: 'mission' },
      { list: instructions.relationships, kind: 'relationship' }, { list: instructions.relationship, kind: 'relationship' },
      { list: instructions.events, kind: 'event' }, { list: instructions.event, kind: 'event' }
    ];

    for (const { list, kind } of allLists) {
      if (Array.isArray(list)) list.forEach(item => routeObject(item, kind));
      else routeObject(list, kind);
    }

    this._canonicalizeNewPlayerSkillWrites(flatVars, pathVars);

    const hasAuthoritativePlayerAction = combats.some(combat => (
      combat.state === 'player_turn'
      || (combat.state === 'in_progress' && combat.actor === 'player')
    ) && (combat.action_name || combat.chakra_cost !== undefined));
    if (hasAuthoritativePlayerAction) {
      const flatResources = new Map([
        ['属性·当前查克拉', Number(stateManager.get('属性·当前查克拉')) || 0],
        ['属性·当前精神力', Number(stateManager.get('属性·当前精神力')) || 0],
        ['属性·当前体力', Number(stateManager.get('属性·当前体力')) || 0]
      ]);
      const pathResources = new Map([
        ['attributes.chakra_current', flatResources.get('属性·当前查克拉')],
        ['attributes.spirit_current', flatResources.get('属性·当前精神力')],
        ['attributes.stamina_current', flatResources.get('属性·当前体力')]
      ]);
      const isFlatActionCost = update => flatResources.has(update.key) && (
        update.op === '-' || (update.op === '=' && Number(update.value) < flatResources.get(update.key))
      );
      const isPathActionCost = update => pathResources.has(update.path) && (
        update.op === 'sub' || (update.op === 'set' && Number(update.value) < pathResources.get(update.path))
      );
      for (let i = flatVars.length - 1; i >= 0; i--) {
        if (isFlatActionCost(flatVars[i])) flatVars.splice(i, 1);
      }
      for (let i = pathVars.length - 1; i >= 0; i--) {
        if (isPathActionCost(pathVars[i])) pathVars.splice(i, 1);
      }
    }

    if (flatVars.length) stateManager.update(flatVars);
    if (pathVars.length) stateManager.batchUpdate(pathVars);
    for (const removal of entityRemovals) {
      const skillMatch = removal.path.match(/^skills\.(jutsu|taijutsu|genjutsu|support|talents|kekkei_genkai)$/);
      if (skillMatch) {
        skillSystem.forgetSkill(skillMatch[1], removal.key);
        continue;
      }
      const equipmentMatch = removal.path.match(/^equipment\.(weapons|armor|tools|consumables)$/);
      if (equipmentMatch) {
        equipmentSystem.removeItem(equipmentMatch[1], removal.key, Number.MAX_SAFE_INTEGER);
      }
    }

    if (relationships.length && typeof this.relationshipSystem?.processInstructions === 'function') {
      this.relationshipSystem.processInstructions(relationships);
    } else {
      for (const rel of relationships) this.relationshipSystem?.processInstruction(rel);
    }
    for (const combat of combats) this.combatSystem?.processInstruction(combat);
    for (const mission of missions) this.missionSystem?.processInstruction(mission);
    for (const event of events) this.worldStateSystem?.triggerEvent(event);

    if (!silent && flatVars.length + pathVars.length + entityRemovals.length < (instructions.variables?.length || 0) && !hasAuthoritativePlayerAction) {
      console.warn('[Pipeline] Some variables were invalid or duplicated');
    }

    return instructions;
  }

  _canonicalizeNewPlayerSkillWrites(flatVars, pathVars) {
    const groups = new Map();
    const addUpdate = (update, collection, parsed) => {
      if (!parsed || !parsed.name) return;
      const key = parsed.type + '|' + normalizePlayerSkillName(parsed.name);
      const group = groups.get(key) || { type: parsed.type, name: parsed.name, refs: [] };
      group.refs.push({ update, collection, parsed });
      groups.set(key, group);
    };
    for (const update of flatVars) addUpdate(update, flatVars, parseFlatPlayerSkillWrite(update));
    for (const update of pathVars) addUpdate(update, pathVars, parsePathPlayerSkillWrite(update));
    if (!groups.size) return;

    const existingKeys = new Set();
    const existingByTechniqueId = new Map();
    for (const key of Object.keys(stateManager.state || {})) {
      const parsed = parseFlatPlayerSkillWrite({ key });
      if (!parsed) continue;
      existingKeys.add(parsed.type + '|' + normalizePlayerSkillName(parsed.name));
      const resolution = resolveCanonTechnique(parsed.name);
      if (resolution.status === 'matched' && !existingByTechniqueId.has(resolution.technique.id)) {
        existingByTechniqueId.set(resolution.technique.id, { type: parsed.type, name: parsed.name });
      }
    }

    const removals = new Set();
    const additions = new Map();
    for (const group of groups.values()) {
      const candidate = { type: group.type, name: group.name };
      for (const { update, parsed } of group.refs) {
        if (!parsed.field && update.value && typeof update.value === 'object') Object.assign(candidate, update.value);
        else if (parsed.field) candidate[parsed.field] = update.value;
      }
      const proposedName = candidate.name || candidate['\u540d\u79f0'] || group.name;
      const resolution = resolveCanonTechnique(proposedName);
      const addressedExisting = existingKeys.has(group.type + '|' + normalizePlayerSkillName(group.name));
      if (addressedExisting) continue;

      const existing = resolution.status === 'matched'
        ? existingByTechniqueId.get(resolution.technique.id)
        : null;
      if (existing) {
        for (const { update, collection, parsed } of group.refs) {
          if (collection === flatVars) {
            const category = PLAYER_SKILL_CATEGORY_NAMES[existing.type] || PLAYER_SKILL_CATEGORY_NAMES[group.type];
            const field = parsed.field ? `\u00b7${PLAYER_SKILL_FIELD_NAMES[parsed.field] || parsed.field}` : '';
            update.key = `\u6280\u80fd\u00b7${category}\u00b7${existing.name}${field}`;
          } else {
            const field = parsed.field && update.op !== 'assign' ? `.${parsed.field}` : '';
            update.path = `skills.${existing.type}.${existing.name}${field}`;
          }
          if (!parsed.field && update.value && typeof update.value === 'object') {
            update.value = { ...update.value, name: existing.name, type: existing.type };
            if ('\u540d\u79f0' in update.value) update.value['\u540d\u79f0'] = existing.name;
          }
        }
        continue;
      }

      let skill;
      if (resolution.status === 'matched') {
        skill = toCanonicalStateSkill(resolution.technique, { mastery: candidate.mastery ?? candidate['\u719f\u7ec3\u5ea6'] });
      } else {
        skill = sanitizeGeneratedStateSkill(candidate, { typeHint: group.type });
        if (resolution.status === 'ambiguous') {
          const diagnostic = { name: proposedName, candidates: resolution.candidates.map(item => item.id) };
          console.warn('[Pipeline] Ambiguous canonical technique alias:', diagnostic);
          eventBus.emit('canon:ambiguous-technique', diagnostic);
        }
      }
      for (const ref of group.refs) removals.add(ref.update);
      additions.set(skill.type + '|' + normalizePlayerSkillName(skill.name), {
        path: 'skills.' + skill.type + '.' + skill.name, op: 'set', value: skill
      });
    }

    for (let index = flatVars.length - 1; index >= 0; index--) if (removals.has(flatVars[index])) flatVars.splice(index, 1);
    for (let index = pathVars.length - 1; index >= 0; index--) if (removals.has(pathVars[index])) pathVars.splice(index, 1);
    pathVars.push(...additions.values());
  }

  _sanitizeVariableUpdaterOutput(text) {
    if (!text) return '';
    const tags = [];
    for (const tag of ALLOWED_TAGS) {
      const regex = new RegExp(`<${tag}(?:\\s+[^>]*)?>[\\s\\S]*?(?:<\\/${tag}>|$)`, 'gi');
      const matches = text.match(regex);
      if (matches) tags.push(...matches);
    }
    return tags.join('\n').trim();
  }

  _instructionList(list, fallback) {
    if (Array.isArray(list) && list.length) return list;
    return fallback ? [fallback] : [];
  }

  _buildTurnVerificationSummary({
    mainReasoning = '',
    variableReasoning = '',
    primaryInstructions = null,
    secondaryInstructions = null,
    updaterEnabled = false,
    committed = false,
    timelineEnabled = false
  } = {}) {
    const sections = [];
    const reasoning = String(mainReasoning || '').trim();
    if (reasoning) sections.push(`### 主模型推演\n${reasoning}`);
    const updaterReasoning = String(variableReasoning || '').trim();
    if (updaterReasoning) sections.push(`### 二次变量自检\n${updaterReasoning}`);

    const instructionSets = [primaryInstructions, secondaryInstructions].filter(Boolean);
    const counters = [
      ['状态变量', 'variables'],
      ['关系', 'relationships'],
      ['任务', 'missions'],
      ['战斗', 'combats'],
      ['事件', 'events'],
      ['记忆', 'memories']
    ].map(([label, key]) => [
      label,
      instructionSets.reduce((total, instructions) => (
        total + (Array.isArray(instructions?.[key]) ? instructions[key].length : 0)
      ), 0)
    ]).filter(([, count]) => count > 0);
    const updateSummary = counters.length
      ? counters.map(([label, count]) => `${label} ${count} 项`).join('、')
      : '未检测到需要写入的结构化状态变化';
    const updaterSummary = updaterEnabled
      ? (secondaryInstructions ? '后台变量核对已完成' : '后台变量核对未返回额外更新，已采用本地兜底')
      : '后台变量更新未启用，本回合由主流程处理';
    const commitSummary = committed
      ? `正文与状态已作为同一回合提交${timelineEnabled ? '至时间线' : '至运行态'}`
      : '当前仅显示未完整提交的部分回复';

    sections.push([
      '### 本回合核对摘要',
      '- 正文：已分离可见叙事与内部、结构化标签。',
      `- 状态：${updateSummary}。`,
      `- 变量更新：${updaterSummary}。`,
      `- 提交：${commitSummary}。`
    ].join('\n'));
    return sections.join('\n\n');
  }

  _mergeMemoryUpdates(memories) {
    if (!Array.isArray(memories) || memories.length <= 1) return memories?.[0] || {};
    const merged = {};
    for (const memory of memories) {
      if (!memory || typeof memory !== 'object') continue;
      for (const [key, value] of Object.entries(memory)) {
        if (Array.isArray(value)) {
          merged[key] = [...(Array.isArray(merged[key]) ? merged[key] : []), ...value];
        } else if (value && typeof value === 'object') {
          merged[key] = { ...(merged[key] || {}), ...value };
        } else if (value !== undefined && value !== null && value !== '') {
          merged[key] = merged[key] && key === 'summary' ? `${merged[key]}\n${value}` : value;
        }
      }
    }
    return merged;
  }

  _preprocessInput(userInput, state) {
    const summaries = [];
    const name = state['玩家·姓名'];
    if (name) {
      summaries.push(`角色: ${name} | ${state['玩家·忍阶']} | ${state['玩家·查克拉属性'] || '未选择'}`);
      summaries.push(`生命力${state['属性·当前生命力']}/${state['属性·生命力']} | 查克拉${state['属性·当前查克拉']}/${state['属性·查克拉']}`);
      summaries.push(`体力${state['属性·当前体力']}/${state['属性·体力']} | 精神力${state['属性·当前精神力']}/${state['属性·精神力']} | 速度${state['属性·速度'] || 0}`);
      summaries.push(`位置: ${state['世界·地点'] || '木叶隐村'} | ${formatGameTime(state['世界·时间'])}`);
    }
    const missions = state._missions;
    if (missions?.active && Object.keys(missions.active).length > 0) {
      summaries.push(`任务: ${Object.values(missions.active).map(m => m.title).join(', ')}`);
    }
    if (state._combat?.is_active) {
      summaries.push(`战斗中: ${state._combat.enemy_name}`);
    }
    return summaries.join('\n');
  }

  _rollDice() {
    const values = Array.from({ length: 6 }, () => Math.floor(Math.random() * 100) + 1);
    this._lastDice = values;
    eventBus.emit('pipeline:dice', { values });
    return values;
  }

  _formatDiceBlock(dice) {
    const names = ['壹', '贰', '叁', '肆', '伍', '陆'];
    return `\n\n〈卦象·本回合命运〉\n${dice.map((v, i) => `${names[i]}:[${v}]`).join('\n')}\n——取用需严格按序，已取之卦不可复用——`;
  }

  _buildPrompt(enrichedInput, state, userInput, options = {}) {
    const messages = [];
    const messageSources = [];
    const injections = [];
    const appendMessage = (message, source, label = '') => {
      messages.push(message);
      messageSources.push({ source, label });
    };

    const updaterEnabled = typeof options.updaterEnabled === 'boolean'
      ? options.updaterEnabled
      : stateManager.getAPIConfig()?.variableUpdater?.enabled === true;
    const strictSingleCall = options.strictSingleCall === true;
    this._turnEvidenceCompiler ||= new TurnEvidenceCompiler();
    const evidencePacket = this._turnEvidenceCompiler.compile({ state, userInput });
    const writerEvidence = this._turnEvidenceCompiler.project(evidencePacket, {
      audience: 'writer',
      includeOperationalIds: !updaterEnabled
    });
    const writerEvidenceText = renderEvidenceView(writerEvidence, { stage: 'main-writer' });
    this._lastTurnEvidencePacket = evidencePacket;
    this._lastTurnEvidenceViews = { writer: writerEvidence };
    const openingContract = resolveOpeningContract(state);
    const openingContractPrompt = formatOpeningContractPrompt(openingContract);
    if (openingContractPrompt) {
      appendMessage({ role: 'system', content: openingContractPrompt }, '开局契约', '完整约束');
    }

    const {
      top,
      bottom,
      depth: depthPresetMessages,
      prefill,
      regexScripts,
      sourceFormat,
      compatibilityProfile
    } = this._buildMainPresetMessages(state, userInput, updaterEnabled);
    this._lastImportedPresetProfile = compatibilityProfile;
    try {
      this._lastImportedPresetRevision = String(localStorage.getItem('naruto_main_preset_version') || '');
    } catch {
      this._lastImportedPresetRevision = '';
    }
    const presetRegexContext = {
      playerName: state['玩家·姓名'] || '玩家',
      charName: state['玩家·姓名'] || '',
      lastUserMessage: userInput
    };
    const presetRegexTrace = { appliedScripts: [], warnings: [], scriptTrace: [] };
    const projectPromptCopy = (content, placement, depth) => {
      if (!Array.isArray(regexScripts) || regexScripts.length === 0) return String(content || '');
      const result = applyPresetPromptRegex(content, regexScripts, {
        placement,
        depth,
        macroContext: presetRegexContext
      });
      presetRegexTrace.appliedScripts.push(...result.appliedScripts);
      presetRegexTrace.warnings.push(...result.warnings);
      presetRegexTrace.scriptTrace.push(...(result.scriptTrace || []));
      return result.text;
    };
    const projectedPrefill = prefill
      ? { ...prefill, content: projectPromptCopy(prefill.content, 2, 0) }
      : null;
    this._lastAssistantPrefill = compatibilityProfile?.active
      ? String(projectedPrefill?.content || '')
      : '';
    if (top.length > 0) {
      top.forEach((message, index) => appendMessage(message, '主预设 Top', `条目 ${index + 1}`));
    }

    const ctxParts = [enrichedInput];
    injections.push({ name: '预处理输入与骰子', content: enrichedInput });

    const promptUserInput = projectPromptCopy(userInput, 1, 0);
    const finalUserContent = [
      `${ctxParts.join('\n\n')}\n\n[玩家操作]\n${promptUserInput}`
    ].filter(Boolean).join('\n\n');
    this._lastFullUserContent = finalUserContent;
    injections.push({ name: '玩家本轮原始输入', content: userInput });

    const historyLength = this.chatHistory.length;
    const conversation = this.chatHistory.map((message, index) => {
      const role = message?.role;
      const placement = role === 'user' ? 1 : (role === 'assistant' ? 2 : null);
      const depth = historyLength - index;
      const projected = placement === null
        ? String(message?.content || '')
        : projectPromptCopy(message?.content, placement, depth);
      return {
        message: { ...message, content: projected },
        source: '对话历史',
        label: `消息 ${index + 1}`,
        sourceOrder: index
      };
    });
    conversation.push({
      message: { role: 'user', content: finalUserContent },
      source: '本回合聚合上下文',
      label: '玩家请求',
      currentUser: true,
      sourceOrder: historyLength
    });

    const assembledConversation = injectPresetDepthMessages(conversation, depthPresetMessages);
    for (const row of assembledConversation) {
      if (row.currentUser) {
        appendMessage({ role: 'system', content: writerEvidenceText }, '统一回合证据', 'writer 投影');
        injections.push({ name: '统一回合证据 · writer', content: writerEvidenceText });
      }
      appendMessage(row.message, row.source || '主预设 Depth', row.label || '深度注入');
    }

    if (Number(state['进度·突破待处理']) > 0) {
      const btContent = updaterEnabled
        ? '【系统强制指令：历练突破】玩家历练值已满！请在本回合正文中触发实力突破剧情。提升需有侧重点，幅度克制。（数值由后台自动处理）'
        : '【系统强制指令：历练突破】玩家历练值已满！请在正文触发突破剧情，在 <var> 标签中增加对应属性上限键和技能熟练度，并将 进度·突破待处理 -1。';
      appendMessage({ role: 'system', content: btContent }, '运行时强制规则', '历练突破');
    }

    // Bottom preset entries go AFTER user input (like SillyTavern depth=0)
    if (bottom.length > 0) {
      bottom.forEach((message, index) => appendMessage(message, '主预设 Bottom', `条目 ${index + 1}`));
    }

    // Preserve the established native-preset ordering. Imported replacement
    // presets use true assistant continuation semantics and are appended only
    // after the runtime bridge below.
    if (projectedPrefill && !compatibilityProfile?.active) {
      appendMessage(projectedPrefill, '主预设 Prefill', '助手续写前缀');
    }

    const compactContract = formatOpeningContractPrompt(openingContract, { compact: true });
    if (compactContract) appendMessage({ role: 'system', content: compactContract }, '开局契约', '末尾重申');

    if (compatibilityProfile?.active) {
      const modePrompt = buildImportedPresetModePrompt({
        updaterEnabled,
        profile: compatibilityProfile
      });
      appendMessage(
        { role: 'system', content: modePrompt },
        '用户导入预设',
        updaterEnabled ? '后续变量模型职责桥接' : '单模型职责桥接'
      );
      injections.push({ name: '用户导入预设 · 项目最小运行条目', content: modePrompt });
    }

    if (!updaterEnabled) {
      const outputPrompt = compatibilityProfile?.active
        ? generateMainVarInstructions(false)
        : MAIN_SINGLE_CALL_OUTPUT_PROMPT;
      appendMessage({ role: 'system', content: outputPrompt }, '单次主模型记账', '固定完整性契约');
      injections.push({ name: '单次主模型结构化记账确认', content: outputPrompt });
      const noChangeExample = compatibilityProfile?.active
        ? IMPORTED_PRESET_SINGLE_CALL_NO_CHANGE_EXAMPLE
        : MAIN_SINGLE_CALL_NO_CHANGE_EXAMPLE;
      const exampleTitle = compatibilityProfile?.active
        ? '【单次主模型无变化示例 · 仅示范项目机器尾部，禁止复制示例事实或替换预设 wrapper】'
        : '【单次主模型完整无变化示例 · 仅示范输出结构，禁止复制示例事实】';
      const examplePrompt = `${exampleTitle}\n${noChangeExample}`;
      appendMessage({ role: 'system', content: examplePrompt }, '单次主模型记账', '完整无变化示例');
      injections.push({ name: '单次主模型完整无变化示例', content: examplePrompt });
    }

    const shinobiDailyPrompt = updaterEnabled
      ? SHINOBI_DAILY_DELEGATION_PROMPT
      : buildShinobiDailyPrompt({ producer: 'main', includeExample: false });
    appendMessage({ role: 'system', content: shinobiDailyPrompt }, '忍界日报', updaterEnabled ? '委托二次变量生成' : '固定结构契约');
    injections.push({ name: '忍界日报结构契约', content: shinobiDailyPrompt });

    const imageSettings = imageSettingsStore.load();
    if (!strictSingleCall && imageSettings.enabled && imageSettings.promptMode === 'main-contract') {
      appendMessage({ role: 'system', content: IMAGE_CONTRACT_PROMPT }, '文生图', '隐藏绘图契约');
      injections.push({ name: '文生图隐藏契约规则', content: IMAGE_CONTRACT_PROMPT });
    }

    if (!updaterEnabled) {
      const deliveryReminder = compatibilityProfile?.active
        ? IMPORTED_PRESET_SINGLE_CALL_DELIVERY_REMINDER
        : MAIN_SINGLE_CALL_DELIVERY_REMINDER;
      appendMessage(
        { role: 'system', content: deliveryReminder },
        '单次主模型记账',
        '最终交付复核'
      );
    }

    if (compatibilityProfile?.active) {
      const compatibilityPrompt = buildImportedPresetOutputCompatibilityPrompt(compatibilityProfile);
      appendMessage(
        { role: 'system', content: compatibilityPrompt },
        '外部主预设',
        '展示 wrapper 与机器尾部兼容'
      );
      injections.push({
        name: '用户导入预设输出展示兼容',
        content: compatibilityPrompt
      });
    }

    // Assistant prefill must remain the final conversational turn.  System
    // contracts above it are hoisted by direct providers, while Tavern/Agent
    // adapters can continue the exact imported prefix without reordering.
    if (projectedPrefill && compatibilityProfile?.active) {
      appendMessage(projectedPrefill, '主预设 Prefill', '助手续写前缀');
    }

    this._lastPromptTrace = {
      messageSources,
      injections,
      presetRegex: {
        appliedScripts: [...new Set(presetRegexTrace.appliedScripts)],
        warnings: [...new Set(presetRegexTrace.warnings)],
        scriptTrace: presetRegexTrace.scriptTrace
      },
      importedPresetProfile: compatibilityProfile,
      sourceFormat
    };
    return messages;
  }

  _buildMainPresetMessages(state, userInput, updaterEnabled = false) {
    try {
      const preset = getMainPreset();
      if (!preset || !Array.isArray(preset.entries) || preset.entries.length === 0) {
        return {
          top: [], bottom: [], depth: [], prefill: null, regexScripts: [], sourceFormat: '',
          compatibilityProfile: inspectImportedPresetOutputProfile(null)
        };
      }

      const lastChatMessage = [...this.chatHistory]
        .reverse()
        .find(message => typeof message?.content === 'string' && message.content.trim())?.content || '';
      const context = {
        playerName: state['玩家·姓名'] || '玩家',
        charName: state['玩家·姓名'] || '',
        lastUserMessage: userInput,
        lastChatMessage,
        variableUpdaterEnabled: updaterEnabled
      };

      const explicitPrefillMarker = Symbol('importedAssistantPrefill');
      const entriesToResolve = [...preset.entries];
      if (typeof preset.assistantPrefill === 'string' && preset.assistantPrefill.trim()) {
        entriesToResolve.push({
          id: '__naruto_imported_assistant_prefill__',
          name: '预设 assistant_prefill',
          enabled: true,
          role: 'assistant',
          activation: 'always',
          content: preset.assistantPrefill,
          tavernPosition: 'prefill',
          [explicitPrefillMarker]: true
        });
      }
      // Resolve the explicit assistant prefill in the same variable-macro pass as
      // the ordered entries so {{getvar::...}} observes preceding setvar calls.
      const allResolved = resolvePresetMacros(entriesToResolve, context);

      const enableCoT = stateManager.getAPIConfig()?.enableVariableCoT !== false;
      const sourceFormat = String(preset._sourceFormat || '').toLowerCase();
      const legacyBottomIds = new Set();
      // Native presets historically used this editor marker to declare the
      // assistant prefill area. Keep that fallback for existing user presets;
      // imported Tavern presets use their compiled tavernPosition metadata.
      if (sourceFormat !== 'sillytavern') {
        let legacySplitIndex = -1;
        for (let index = 0; index < preset.entries.length; index++) {
          const entry = preset.entries[index];
          if (entry?.isMarker && String(entry.name || '').includes('回映层')) legacySplitIndex = index;
        }
        if (legacySplitIndex >= 0) {
          for (let index = legacySplitIndex + 1; index < preset.entries.length; index++) {
            if (preset.entries[index]?.id) legacyBottomIds.add(preset.entries[index].id);
          }
        }
      }
      const top = [];
      const bottomRaw = [];
      const depth = [];
      let explicitPrefillContent = '';

      const sanitizeEntryContent = rawContent => {
        let content = String(rawContent || '');
        // The secondary updater owns project machine tags. Imported display and
        // planning wrappers remain untouched so their prompt/output regexes can
        // still recognize the model response.
        if (updaterEnabled) {
          content = content
            .replace(/<var_thinking>[\s\S]*?<\/var_thinking>\s*/g, '')
            .replace(/<var>[\s\S]*?<\/var>/g, '')
            .replace(/<status_query\s*\/>/g, '')
            .replace(/<var>\s*\$\{[^}]*\}\s*<\/var>/g, '')
            .replace(/<var>\s*Handmade[\s\S]*?<\/var>/g, '')
            .replace(/【关四：账册核签[\s\S]*?审议结论：\[通过\] \/ \[补充：___\]/g, '')
            .replace(/• 历练exp[\s\S]*?必须包含[\s\S]*?战斗数值/g, '')
            .replace(/<memory>[\s\S]*?<\/memory>/g, '')
            .replace(/<variable_thinking>[\s\S]*?<\/variable_thinking>/g, '')
            .replace(/<update_manifest>[\s\S]*?<\/update_manifest>/g, '');
        }
        if (!enableCoT) {
          content = content.replace(/<var_thinking>[\s\S]*?<\/var_thinking>\s*/g, '');
        }
        return content;
      };

      for (let index = 0; index < allResolved.length; index++) {
        const entry = allResolved[index];
        // The immutable runtime contract owns the eight-item reasoning block
        // in strict mode. Drop duplicate full copies from built-in, custom, or
        // imported presets so weak models reserve space for the required tail.
        if (!updaterEnabled && containsFullReasoningChecklist(entry.content)) {
          if (entry.id !== 'main_builtin_review_evidence') {
            console.warn(`[Preset] Skipped duplicate reasoning checklist in strict mode: ${entry.name || entry.id || 'unnamed'}`);
          }
          continue;
        }
        if (conflictsWithEffectiveUpdaterMode(entry, updaterEnabled)) {
          console.warn(`[Preset] Skipped always-on ownership rule conflicting with updater=${updaterEnabled}: ${entry.name || entry.id || 'unnamed'}`);
          continue;
        }
        const role = entry.role === 'assistant' ? 'assistant' : (entry.role === 'user' ? 'user' : 'system');
        const content = sanitizeEntryContent(entry.content);
        if (!content.trim()) continue;
        if (entry[explicitPrefillMarker] === true) {
          explicitPrefillContent = content;
          continue;
        }

        const message = { role, content };
        const sourceOrder = Number.isFinite(Number(entry.sourceOrder)) ? Number(entry.sourceOrder) : index;
        const record = { message, entry, sourceOrder };
        const position = legacyBottomIds.has(entry.id) ? 'bottom' : normalizeTavernPosition(entry);
        if (position === 'depth') {
          depth.push({
            ...record,
            source: '主预设 Depth',
            label: `${entry.name || entry.id || `条目 ${index + 1}`} @ ${normalizeTavernDepth(entry)}`
          });
        } else if (position === 'bottom') {
          bottomRaw.push(record);
        } else {
          top.push(message);
        }
      }

      // Extract the last assistant message from bottom as prefill
      let orderedPrefillContent = '';
      for (let i = bottomRaw.length - 1; i >= 0; i--) {
        if (bottomRaw[i].message.role === 'assistant') {
          orderedPrefillContent = bottomRaw.splice(i, 1)[0].message.content;
          break;
        }
      }

      const prefillParts = [orderedPrefillContent, explicitPrefillContent]
        .filter((content, index, values) => content && values.indexOf(content) === index);
      const prefill = prefillParts.length
        ? { role: 'assistant', content: prefillParts.join('\n') }
        : null;
      const bottom = bottomRaw.map(record => record.message);
      const compatibilityProfile = inspectImportedPresetOutputProfile({
        ...preset,
        entries: allResolved,
        assistantPrefill: prefill?.content || ''
      });

      console.log(`[Preset] Split: ${top.length} top, ${bottom.length} bottom, ${depth.length} depth, prefill=${!!prefill}, updater=${updaterEnabled}`);
      return {
        top,
        bottom,
        depth,
        prefill,
        regexScripts: Array.isArray(preset.regexScripts) ? preset.regexScripts : [],
        sourceFormat: String(preset._sourceFormat || ''),
        compatibilityProfile
      };
    } catch (e) {
      console.warn('[Pipeline] Main preset loading failed:', e.message);
      return {
        top: [], bottom: [], depth: [], prefill: null, regexScripts: [], sourceFormat: '',
        compatibilityProfile: inspectImportedPresetOutputProfile(null)
      };
    }
  }

  _getGenerationOptions() {
    const config = stateManager.getAPIConfig?.() || {};
    return {
      temperature: config.temperature ?? 0.9,
      // 0 means "omit max_tokens" for OpenAI-compatible adapters (including DeepSeek).
      // Providers that require the field apply their own model-side default in AIClient.
      max_tokens: 0,
      top_p: config.top_p ?? 0.9,
      top_k: config.top_k ?? 200,
      frequency_penalty: config.frequency_penalty ?? 0.2,
      presence_penalty: config.presence_penalty ?? 0
    };
  }

  _buildDynamicContext(state) {
    const name = state['玩家·姓名'];
    if (!name) {
      return `\n[游戏阶段: 角色尚未创建。请引导玩家完成角色创建，使用<var>标签记录创建完成状态。]\n`;
    }
    const timelineContext = this._buildTimelineContext(state);
    const skills = this._scanFlatSkills(state);
    const items = this._scanFlatItems(state);
    const missions = state._missions || {};
    const activeMissions = missions.active ? Object.values(missions.active) : [];
    const combat = state._combat;
    const rels = state._relationships || {};
    const eventsStr = state['世界·活跃事件'] || '';
    const events = eventsStr ? eventsStr.split('\n').filter(Boolean) : [];
    const isCombat = !!combat?.is_active;

    const parts = [];

    // ── Tier 1: 始终注入 ──
    parts.push(`[动态游戏状态]
## 时代约束
${timelineContext}
- 核心规则: 不要默认玩家处于疾风传开始时间。必须按当前时间线判断人物年龄、组织公开程度、事件是否已发生、忍术/科技/称号是否可用。
- 年代事实: "已灭亡、已死亡、已叛逃、已加入组织、事件已发生"等结论必须按当前年份判断，禁止把疾风传/未来结果倒灌到早期时间线。

## 玩家角色
- 姓名: ${name}
- 性别: ${state['玩家·性别'] === '男性' ? '男' : state['玩家·性别'] === '女性' ? '女' : state['玩家·性别'] || '未设定'}
- 忍阶: ${state['玩家·忍阶']}
- 公开身份: ${state['玩家·公开身份'] || state['玩家·忍阶']}
- 出身: ${state['玩家·出身']}
- 核心人设: ${state['玩家·个性'] || '未设定'}
- 查克拉属性: ${state['玩家·查克拉属性'] || '未选择'}
- 当前目标: ${state['玩家·当前目标'] || '未设定'}
- 声望标签: ${state['玩家·声望标签'] || '无'}`);

    // ── Tier 2: 属性 + 精简技能/装备 ──
    parts.push(`## 当前属性
- 查克拉: ${state['属性·当前查克拉']}/${state['属性·查克拉']}
- 生命力: ${state['属性·当前生命力']}/${state['属性·生命力']}
- 精神力: ${state['属性·当前精神力']}/${state['属性·精神力']}
- 体力: ${state['属性·当前体力']}/${state['属性·体力']}
- 速度: ${state['属性·速度']}
- 幸运: ${state['属性·幸运']}

## 技能摘要
${isCombat ? this._summarizeSkills(skills) : this._summarizeSkillsCompact(skills, 5)}

## 装备
${isCombat ? this._summarizeEquipmentFull(items) : this._summarizeEquipmentCompact(items)}`);

    // ── Tier 3: 仅战斗时注入 ──
    if (isCombat) {
      parts.push(`## 派生战力参考
${this._summarizeDerivedStats(state)}`);
    }

    parts.push(`## 任务进度
${this._summarizeMissionsCompact(activeMissions)}

## 人际关系
${isCombat ? this._summarizeRelationships(rels) : this._summarizeRelationshipsCompact(rels)}

## 世界状态
- 时间: ${formatGameTime(state['世界·时间'])}
- 位置: ${state['世界·地点'] || '木叶隐村'}
- 天气: ${state['世界·天气'] || '晴'}
- 进行中的世界事件: ${this._summarizeEventsStr(events)}
- 已探索区域: ${state['世界·已探索区域'] || '无'}
- 已知地标: ${Object.keys(state._map?.known_locations || {}).join('、') || '无'}

## 战斗状态
${isCombat ? `【战斗中】对手: ${combat.enemy_name} | 忍阶/战力: ${combat.enemy_rank || '未知'}/${combat.enemy_combat_level || '未评定'} | 生命力: ${combat.enemy_vitality}/${combat.enemy_vitality_max} | 查克拉: ${combat.enemy_chakra}/${combat.enemy_chakra_max} | 体力: ${combat.enemy_stamina}/${combat.enemy_stamina_max} | 精神力: ${combat.enemy_spirit}/${combat.enemy_spirit_max}\n- 已知招式: ${(combat.enemy_jutsu || []).map(item => `${item.名称}(${item.等级}级/${item.消耗资源 || '查克拉'}${item.消耗})`).join(' | ') || '无可靠记录'}\n- 结算规则: 忍术/幻术/体术分别消耗查克拉/精神力/体力，具体点数以每条招式数据库的 cost 为准，玩家与NPC统一结算；只在 <combat> 报告行动。` : '无战斗'}`);

    return parts.join('\n');
  }

  _buildTimelineContext(state) {
    const timeline = state['世界·年代'] || '木叶48年';
    const calendar = state['世界·时间'] || '';
    const label = formatGameTime(calendar);
    const year = this._currentKonohaYear(state);
    const eraNote = Number.isFinite(year)
      ? this._eraNoteForYear(year)
      : '年份无法解析时，先询问或按动态状态中最明确的时代信息处理；不要假定疾风传。';
    return [
      `- 当前时代: ${timeline}`,
      `- 当前日历: ${label}`,
      `- 当前木叶纪年判定: ${Number.isFinite(year) ? `木叶${year}年` : '未明确'}`,
      `- 年代合理性摘要: ${eraNote}`,
      `- 时间线优先级: 动态状态/存档 > 玩家本回合明确指定 > 世界书条目 > 默认木叶48年。`
    ].join('\n');
  }

  _currentKonohaYear(state) {
    const values = [
      state['世界·时间'],
      state['世界·年代'],
      state._memory?.recent_summary,
      state._memory?.compressed_summary
    ];
    for (const value of values) {
      const year = this._extractKonohaYear(value);
      if (Number.isFinite(year)) return year;
    }
    return 48;
  }

  _extractKonohaYear(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const match = String(value || '').match(/木叶\s*(\d+)\s*年/);
    return match ? Number(match[1]) : null;
  }

  _eraNoteForYear(year) {
    if (year < 0) return '远古/忍宗相关时代，现代忍村、五影、晓和原作角色通常不存在。';
    if (year < 20) return '忍村制度早期或第一次忍界大战前后，许多后世组织与角色尚未出现。';
    if (year < 35) return '第二次忍界大战前后，三忍、雨之国创伤和早期晓理念可作为时代重点。';
    if (year < 48) return '第三次忍界大战及战后余波阶段，九尾之乱和鸣人出生可能尚未发生或刚发生。';
    if (year < 55) return '木叶战后重建期，鸣人/佐助幼年，卡卡西暗部期，宇智波灭族尚未发生。';
    if (year < 60) return '原作第一部前后，宇智波灭族可能已发生；晓仍未全面公开捕捉尾兽。';
    if (year < 63) return '疾风传前后，晓公开行动、尾兽捕捉、佩恩袭击和五影会谈需按具体日期判断。';
    return '战后/新时代阶段，需区分六代、七代火影与博人时代科技化进程。';
  }

  _summarizeEquipment(items) {
    if (!items || Object.keys(items).length === 0) return '无';
    return Object.entries(items).map(([name, info]) => {
      if (typeof info === 'object') return `${name}×${info.quantity || 1}(${info.quality || '普通'})`;
      return name;
    }).join(' | ');
  }

  _summarizeEquipmentFull(items) {
    return [
      `- 武器: ${this._summarizeEquipment(items.weapons)}`,
      `- 忍具: ${this._summarizeEquipment(items.tools)}`,
      `- 消耗品: ${this._summarizeEquipment(items.consumables)}`,
      `- 金钱: ${items.ryo || 0}两`
    ].join('\n');
  }

  _summarizeEquipmentCompact(items) {
    const equipped = Object.entries(items.equipped || {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
    return [
      equipped.length ? `已装备: ${equipped.join(' | ')}` : '已装备: 无',
      `- 金钱: ${items.ryo || 0}两`
    ].join('\n');
  }

  _summarizeMissions(activeMissions) {
    if (!activeMissions || activeMissions.length === 0) return '无进行中的任务';
    return activeMissions.map(m => `[${m.rank || 'D'}] ${m.title}`).join('\n');
  }

  _summarizeMissionsCompact(activeMissions) {
    if (!activeMissions || activeMissions.length === 0) return '无进行中的任务';
    return activeMissions.slice(0, 4).map(m => `[${m.rank || 'D'}] ${m.title}${m.status ? ' ' + m.status : ''}`).join(' | ');
  }

  _summarizePromotion(state) {
    return [
      `- 经验: ${state['进度·经验'] || 0}/${state['进度·下一级经验'] || 100}`,
      `- 已完成任务: ${state['进度·已完成任务'] || 0}`,
      `- 突破待处理: ${state['进度·突破待处理'] || 0}`
    ].join('\n');
  }

  _summarizeDerivedStats(state) {
    const skills = this._scanFlatSkills(state);
    const best = (group) => Math.max(0, ...Object.values(group || {}).map(item => Number(item?.mastery) || 0));
    const jutsu = best(skills.jutsu);
    const taijutsu = best(skills.taijutsu);
    const genjutsu = best(skills.genjutsu);
    const derived = {
      ninjutsu: Math.round((state['属性·查克拉'] || 0) * 0.45 + (state['属性·精神力'] || 0) * 0.25 + jutsu * 0.7),
      taijutsu: Math.round((state['属性·体力'] || 0) * 0.45 + (state['属性·速度'] || 0) * 0.9 + taijutsu * 0.9),
      genjutsu: Math.round((state['属性·精神力'] || 0) * 0.75 + (state['属性·查克拉'] || 0) * 0.2 + genjutsu * 0.9),
      defense: Math.round((state['属性·生命力'] || 0) * 0.18 + (state['属性·体力'] || 0) * 0.25),
      initiative: Math.round((state['属性·速度'] || 0) * 0.8 + (state['属性·精神力'] || 0) * 0.15 + (state['属性·幸运'] || 0) * 0.5)
    };
    const rank = state['玩家·忍阶'] || '下忍';
    const benchmark = GAME_DATA.getRankBenchmark(rank);
    return [
      `- 忍术战力: ${derived.ninjutsu}`,
      `- 体术战力: ${derived.taijutsu}`,
      `- 幻术战力: ${derived.genjutsu}`,
      `- 防御韧性: ${derived.defense}`,
      `- 先手/反应: ${derived.initiative}`,
      `- 当前忍阶参考区间: 查克拉${benchmark.chakra[0]}-${benchmark.chakra[1]} | 生命力${benchmark.vitality[0]}-${benchmark.vitality[1]} | 体力${benchmark.stamina[0]}-${benchmark.stamina[1]} | 速度${benchmark.speed[0]}-${benchmark.speed[1]}`
    ].join('\n');
  }

  _summarizeSkills(skills = {}) {
    const sections = [
      ['忍术', skills.jutsu],
      ['体术', skills.taijutsu],
      ['幻术', skills.genjutsu],
      ['辅助', skills.support],
      ['天赋', skills.talents]
    ];
    const lines = [];
    const bloodlines = this._formatBloodlineEntries(skills.kekkei_genkai);
    if (bloodlines.length) lines.push(`- 血继限界: ${bloodlines.join(' | ')}`);
    for (const [label, group] of sections) {
      const items = this._topSkillEntries(group);
      lines.push(`- ${label}: ${items.length ? items.join(' | ') : '无'}`);
    }
    return lines.join('\n');
  }

  _topSkillEntries(group) {
    if (!group || typeof group !== 'object') return [];
    return Object.entries(group)
      .map(([name, data]) => `${name}${data.mastery != null ? '(' + data.mastery + ')' : ''}`)
      .slice(0, 8);
  }

  _formatBloodlineEntries(group, { compact = false } = {}) {
    if (group == null || group === '') return [];
    if (typeof group !== 'object' || Array.isArray(group)) return [String(group)];

    const formatEntry = (fallbackName, data) => {
      if (data == null) return fallbackName;
      if (typeof data !== 'object' || Array.isArray(data)) return `${fallbackName}: ${String(data)}`;
      const name = data.name || data['名称'] || fallbackName;
      const rank = data.rank ?? data['等级'];
      const mastery = data.mastery ?? data['熟练度'];
      const description = data.description ?? data['描述'] ?? data['说明'];
      const status = [
        rank ? String(rank) : '',
        mastery != null && mastery !== '' ? `熟练${mastery}` : ''
      ].filter(Boolean).join('/');
      const base = `${name}${status ? `[${status}]` : ''}`;
      if (!description) return base;
      const limit = compact ? 80 : 160;
      const detail = String(description).trim();
      return `${base}：${detail.length > limit ? `${detail.slice(0, limit)}…` : detail}`;
    };

    const isSingleRecord = ['name', '名称', 'rank', '等级', 'mastery', '熟练度', 'description', '描述']
      .some(field => Object.prototype.hasOwnProperty.call(group, field));
    if (isSingleRecord) return [formatEntry(group.name || group['名称'] || '血继限界', group)];
    return Object.entries(group).map(([name, data]) => formatEntry(name, data));
  }

  _summarizeSkillsCompact(skills = {}, topN = 5) {
    const allEntries = [];
    const categories = [
      ['忍', skills.jutsu], ['体', skills.taijutsu],
      ['幻', skills.genjutsu], ['辅', skills.support],
      ['天赋', skills.talents]
    ];
    for (const [label, group] of categories) {
      if (!group || typeof group !== 'object') continue;
      for (const [name, data] of Object.entries(group)) {
        allEntries.push({ label, name, mastery: Number(data?.mastery) || 0 });
      }
    }
    allEntries.sort((a, b) => b.mastery - a.mastery);
    const top = allEntries.slice(0, topN);
    const sections = [];
    const bloodlines = this._formatBloodlineEntries(skills.kekkei_genkai, { compact: true });
    if (bloodlines.length) sections.push(`血继: ${bloodlines.join(' | ')}`);
    const skillLine = top.map(e => `${e.name}(${e.label}${e.mastery})`).join(' | ');
    if (skillLine) sections.push(skillLine);
    return sections.join(' | ') || '无';
  }

  _trackLabel(track) {
    const labels = {
      balanced: '均衡型',
      ninjutsu: '忍术型',
      taijutsu: '体术型',
      genjutsu: '幻术型',
      medical: '医疗/辅助型',
      sensory: '感知/情报型',
      command: '指挥型',
      infiltration: '潜入/暗杀型'
    };
    return labels[track] || track;
  }

  async _checkPinnedNpcSummaries(apiCfg) {
    const rels = stateManager.getSub('_relationships') || {};
    const cfg = getMemoryConfig();
    const freq = cfg.npcSummaryFrequency || 10;
    let legacyRepairAttempted = false;

    for (const [npcName, rel] of Object.entries(rels)) {
      if (!rel.pinned) continue;
      const counter = Number(rel.summary_turn_counter) || 0;
      const existingSummaries = Array.isArray(rel.summaries) ? rel.summaries : [];
      const repairCandidate = legacyRepairAttempted
        ? null
        : findRecoverableNpcSummary(existingSummaries, rel.history);
      const completeSummaryCount = existingSummaries.filter(summary => (
        inspectNpcSummaryCompletion(summary?.content, NPC_SUMMARY_POLICIES.stage).complete
      )).length;
      const stageSummaryDue = counter >= freq;
      const grandSummaryDue = completeSummaryCount >= 10;
      if (!repairCandidate && !stageSummaryDue && !grandSummaryDue) continue;
      if (this._npcSummaryInFlight.has(npcName)) continue;
      this._npcSummaryInFlight.add(npcName);

      try {
        const client = new AIClient();
        client.configure(apiCfg);
        const playerName = stateManager.get('玩家·姓名') || '玩家';

        const buildStagePrompt = (historyEntries) => {
          const historyText = historyEntries.map((entry, index) => {
            const time = entry.time || `第${entry.turn}回合`;
            return `${index + 1}. [${time}] ${entry.summary}`;
          }).join('\n');
          return `你是一个RPG游戏的记忆管理器。请将以下「${npcName}」与「${playerName}」的${historyEntries.length}次互动历史和心理活动总结成一段完整、精炼的叙事摘要(100-200字)。

保留：关键情节转折、感情变化、重要承诺、秘密、矛盾冲突。
去除：重复的日常寒暄、无关紧要的细节。

互动记录：
${historyText}

请直接输出总结内容，不要添加任何标签或前缀，并以完整句子结束。`;
        };

        // 旧存档中已经截断的摘要，只有还能对应到原始互动记录时才允许重建。
        if (repairCandidate) {
          legacyRepairAttempted = true;
          const repairResult = await requestCompleteNpcSummary(
            client,
            [{ role: 'user', content: buildStagePrompt(repairCandidate.historyEntries) }],
            NPC_SUMMARY_POLICIES.stage
          );
          if (repairResult.text) {
            const allRels = stateManager.getSub('_relationships') || {};
            const currentRel = allRels[npcName];
            const summaries = Array.isArray(currentRel?.summaries) ? [...currentRel.summaries] : [];
            const target = summaries[repairCandidate.index];
            if (target?.content === repairCandidate.summary?.content) {
              summaries[repairCandidate.index] = { ...target, content: repairResult.text };
              currentRel.summaries = summaries;
              stateManager.setSub('_relationships', allRels);
              console.log(`[Pipeline] Rebuilt truncated NPC summary for ${npcName}`);
            }
          } else if (!repairResult.text) {
            console.warn(`[Pipeline] NPC summary repair for ${npcName} remained incomplete: ${repairResult.reason}`);
          }
        }

        const beforeStageRels = stateManager.getSub('_relationships') || {};
        const beforeStageRel = beforeStageRels[npcName];
        const latestCounter = Number(beforeStageRel?.summary_turn_counter) || 0;
        if (latestCounter >= freq) {
          const historyEntries = Array.isArray(beforeStageRel?.history)
            ? beforeStageRel.history.slice(0, freq)
            : [];
          if (historyEntries.length) {
            console.log(`[Pipeline] Summarizing pinned NPC: ${npcName} (${latestCounter} interactions)`);
            const stageResult = await requestCompleteNpcSummary(
              client,
              [{ role: 'user', content: buildStagePrompt(historyEntries) }],
              NPC_SUMMARY_POLICIES.stage
            );

            if (stageResult.text) {
              const summaryEntry = {
                turn: stateManager.get('系统·回合数') || 0,
                time: stateManager.get('世界·时间') || '',
                content: stageResult.text,
                covered_turns: historyEntries.map(e => e.turn)
              };

              const allRels = stateManager.getSub('_relationships') || {};
              const currentRel = allRels[npcName];
              if (currentRel) {
                const summaries = Array.isArray(currentRel.summaries) ? currentRel.summaries : [];
                currentRel.summaries = [...summaries, summaryEntry];
                const currentCounter = Number(currentRel.summary_turn_counter) || 0;
                const consumed = Math.min(latestCounter, historyEntries.length);
                currentRel.summary_turn_counter = Math.max(0, currentCounter - consumed);
                stateManager.setSub('_relationships', allRels);
                console.log(`[Pipeline] NPC stage summary saved for ${npcName}`);
              }
            } else if (!stageResult.text) {
              console.warn(`[Pipeline] NPC summary for ${npcName} remained incomplete: ${stageResult.reason}`);
            }
          }
        }

        // 只合并验证完整的阶段摘要。生成失败时保留全部阶段记录，供下次重试。
        const beforeGrandRels = stateManager.getSub('_relationships') || {};
        const beforeGrandRel = beforeGrandRels[npcName];
        const currentSummaries = Array.isArray(beforeGrandRel?.summaries) ? beforeGrandRel.summaries : [];
        const summaryBatch = currentSummaries.filter(summary => (
          inspectNpcSummaryCompletion(summary?.content, NPC_SUMMARY_POLICIES.stage).complete
        )).slice(0, 10);
        if (summaryBatch.length >= 10) {
          console.log(`[Pipeline] Triggering grand summary for ${npcName} (${currentSummaries.length} summaries)`);
          const previousGrandSummary = beforeGrandRel.grand_summary || '';
          const grandPrompt = `你是一个RPG游戏的记忆管理器。请将以下关于「${npcName}」与「${playerName}」的10次阶段性总结，合并为一篇完整的人物关系编年史(200-400字)。

保留：整体关系演变脉络、关键转折点、当前关系状态、未解决的悬念。
风格：第三人称叙事，简洁而有画面感。

${summaryBatch.map((summary, index) => `第${index + 1}次总结: ${summary.content}`).join('\n\n')}

${previousGrandSummary ? `此前的关系编年史: ${previousGrandSummary}\n请将旧编年史与新内容合并。` : ''}

请直接输出完整的编年史内容，不要添加标签或前缀，并以完整句子结束。`;

          const grandResult = await requestCompleteNpcSummary(
            client,
            [{ role: 'user', content: grandPrompt }],
            NPC_SUMMARY_POLICIES.grand
          );
          if (grandResult.text) {
            const allRels = stateManager.getSub('_relationships') || {};
            const currentRel = allRels[npcName];
            if (currentRel) {
              const removals = new Map();
              const summaryKey = (summary) => JSON.stringify([
                summary?.turn,
                summary?.time,
                summary?.content,
                summary?.covered_turns
              ]);
              for (const summary of summaryBatch) {
                const key = summaryKey(summary);
                removals.set(key, (removals.get(key) || 0) + 1);
              }
              const latestSummaries = Array.isArray(currentRel.summaries) ? currentRel.summaries : [];
              currentRel.summaries = latestSummaries.filter(summary => {
                const key = summaryKey(summary);
                const count = removals.get(key) || 0;
                if (!count) return true;
                removals.set(key, count - 1);
                return false;
              });
              currentRel.grand_summary = grandResult.text;
              stateManager.setSub('_relationships', allRels);
              console.log(`[Pipeline] NPC grand summary saved for ${npcName}`);
            }
          } else if (!grandResult.text) {
            console.warn(`[Pipeline] NPC grand summary for ${npcName} remained incomplete: ${grandResult.reason}`);
          }
        }
      } catch (err) {
        console.warn(`[Pipeline] NPC summary for ${npcName} failed:`, err?.message);
      } finally {
        this._npcSummaryInFlight.delete(npcName);
      }
    }
  }

  _summarizeRelationships(relationships) {
    if (!relationships || Object.keys(relationships).length === 0) return '暂无特别关系';
    const parts = [];
    const pinnedParts = [];

    for (const [name, rel] of Object.entries(relationships)) {
      if (rel.pinned) {
        pinnedParts.push(this._buildPinnedNpcBlock(name, rel));
      } else {
        const a = rel.affection || 0, t = rel.trust || 0, r = rel.respect || 0;
        parts.push(`${name}: ${a > 30 ? '友好' : a < -30 ? '敌意' : '中立'}(${a}) 信${t} 敬${r}${rel.role ? ' ' + rel.role : ''}`);
      }
    }

    let result = '';
    if (pinnedParts.length) result += pinnedParts.join('\n');
    if (parts.length) result += (result ? '\n' : '') + parts.join(' | ');
    return result || '暂无特别关系';
  }

  _summarizeRelationshipsCompact(relationships) {
    if (!relationships || Object.keys(relationships).length === 0) return '暂无特别关系';
    const parts = [];
    const pinnedParts = [];

    for (const [name, rel] of Object.entries(relationships)) {
      if (rel.pinned) {
        pinnedParts.push(this._buildPinnedNpcBlock(name, rel));
      } else {
        const a = rel.affection || 0;
        if (Math.abs(a) >= 30 || (rel.role && rel.role !== '路人')) {
          parts.push(`${name}: ${a > 30 ? '友好' : a < -30 ? '敌意' : '中立'}(${a})`);
        }
      }
    }

    let result = '';
    if (pinnedParts.length) result += pinnedParts.join('\n');
    if (parts.length) result += (result ? '\n' : '') + parts.slice(0, 6).join(' | ');
    return result || '暂无特别关系';
  }

  _buildPinnedNpcBlock(name, rel) {
    const a = rel.affection || 0, t = rel.trust || 0, r = rel.respect || 0;
    const lines = [`<pinned_npc name="${name}">`];
    lines.push(`关系数值: 好感${a} 信任${t} 敬畏${r}`);
    if (rel.role) lines.push(`身份: ${rel.role}`);
    if (rel.faction) lines.push(`阵营: ${rel.faction}`);
    if (rel.info) lines.push(`简介: ${rel.info}`);

    // 大总结
    if (rel.grand_summary) {
      lines.push(`[关系编年史] ${rel.grand_summary}`);
    }

    // 阶段性总结
    if (Array.isArray(rel.summaries) && rel.summaries.length > 0) {
      lines.push(`[近期阶段总结]`);
      for (const s of rel.summaries) {
        lines.push(`- ${s.content}`);
      }
    }

    // 最新未总结的历史
    if (Array.isArray(rel.history) && rel.history.length > 0) {
      lines.push(`[最新互动]`);
      for (const h of rel.history.slice(0, 10)) {
        lines.push(`- [${h.time || ''}] ${h.summary}`);
      }
    }

    // 战斗数据
    if (rel.combat_stats) {
      const cs = rel.combat_stats;
      const statStr = Object.entries(cs)
        .filter(([k]) => !['忍术', '查克拉属性'].includes(k))
        .map(([k, v]) => `${k}:${v}`).join(' ');
      if (statStr) lines.push(`[战斗数据] ${statStr}`);
      if (Array.isArray(cs.忍术) && cs.忍术.length) {
        lines.push(`[已知招式] ${cs.忍术.map(item => `${item.名称}(${item.等级}/消耗${item.消耗})`).join('、')}`);
      }
    }

    // 标签 / 秘密
    if (Array.isArray(rel.tags) && rel.tags.length) lines.push(`标签: ${rel.tags.join('、')}`);
    if (Array.isArray(rel.known_secrets) && rel.known_secrets.length) lines.push(`已知秘密: ${rel.known_secrets.join('、')}`);

    lines.push('</pinned_npc>');
    return lines.join('\n');
  }

  _summarizeEventsStr(events) {
    if (!Array.isArray(events) || !events.length) return '无';
    return events.filter(Boolean).join('；') || '无';
  }

  _scanFlatSkills(state) {
    const result = { jutsu: {}, taijutsu: {}, genjutsu: {}, support: {}, talents: {}, kekkei_genkai: {} };
    const fieldMap = {
      '名称': 'name', '等级': 'rank', '属性': 'element', '消耗': 'cost', '消耗资源': 'resource_type',
      '威力': 'power', '熟练度': 'mastery', '描述': 'description', '类型': 'type',
      '数据库ID': 'technique_id', '来源': 'source'
    };
    for (const key of Object.keys(state)) {
      const m = key.match(/^技能·(忍术|体术|幻术|支援|天赋|血继限界)·(.+)·(名称|等级|属性|消耗|消耗资源|威力|熟练度|描述|类型|数据库ID|来源)$/);
      if (m) {
        const [, cat, name, field] = m;
        const catKey = cat === '忍术' ? 'jutsu' : cat === '体术' ? 'taijutsu' : cat === '幻术' ? 'genjutsu' : cat === '支援' ? 'support' : cat === '血继限界' ? 'kekkei_genkai' : 'talents';
        if (!result[catKey][name]) result[catKey][name] = { name };
        result[catKey][name][fieldMap[field] || field] = state[key];
      }
    }
    if (state['技能·血继限界'] && Object.keys(result.kekkei_genkai).length === 0) {
      result.kekkei_genkai = state['技能·血继限界'];
    }
    return result;
  }

  _scanFlatItems(state) {
    const result = { weapons: {}, armor: {}, tools: {}, consumables: {}, ryo: state['进度·金钱'] || 0, equipped: {} };
    const catMap = { '道具': 'tools', '消耗品': 'consumables', '武器': 'weapons', '防具': 'armor' };
    for (const key of Object.keys(state)) {
      const m = key.match(/^物品·(道具|消耗品|武器|防具)·(.+)·(数量|品质|描述|说明)$/);
      if (m) {
        const [, cat, name, field] = m;
        const catKey = catMap[cat];
        const fieldRev = { '数量': 'quantity', '品质': 'quality', '描述': 'description', '说明': 'description' };
        if (!result[catKey][name]) result[catKey][name] = {};
        result[catKey][name][fieldRev[field] || field] = state[key];
      }
    }
    for (const slot of ['武器', '防具', '饰品1', '饰品2']) {
      const val = state[`物品·已装备·${slot}`];
      if (val) result.equipped[slot] = val;
    }
    return result;
  }

  _summarizeEvents(events) {
    if (!Array.isArray(events) || !events.length) return '无';
    return events.slice(-6).map(event => {
      if (typeof event === 'string') return event;
      if (!event || typeof event !== 'object') return '';
      const title = event.title || event.name || event.id || '未命名事件';
      const status = event.status ? `(${event.status})` : '';
      const detail = event.description || event.detail || event.location || '';
      return [title + status, detail].filter(Boolean).join(': ');
    }).filter(Boolean).join('；') || '无';
  }

  _buildMemoryContext(memory, userInput = '') {
    if (this.memorySystem) {
      const ctx = this.memorySystem.buildPromptContext(memory, { userInput });
      if (!ctx) return '';
      if (!getMemoryConfig().recallEnabled) return ctx;
      return ctx + '\n\n[记忆协议] 当你需要剧情中已提及但你当前不掌握的信息时，在回复末尾输出 <recall entities="实体名1,实体名2"/>。系统中永久保留的历史记录将以检索词触达。';
    }
    return '';
  }

  _applyMemoryUpdate(update, userInput, aiResponse) {
    if (this.memorySystem) {
      this.memorySystem.apply(update, { source: 'ai', userInput, aiResponse });
      return;
    }
  }

  _rememberRecentTurn(userInput, aiResponse) {
    if (this.memorySystem) this.memorySystem.rememberRecentTurn(userInput, aiResponse);
  }

  _trimHistory() {
    // 渐进压缩: 保留30条,越旧压缩越狠。句子边界截断,避免碎在半句话中间
    const MAX = 34;
    if (this.chatHistory.length > MAX) {
      const keep = this.chatHistory.slice(-MAX);
      for (let i = 0; i < keep.length; i++) {
        if (keep[i].role !== 'assistant' || typeof keep[i].content !== 'string') continue;
        const limit = i <= 8 ? 120 : i <= 18 ? 300 : Infinity;
        if (keep[i].content.length > limit) {
          keep[i] = { ...keep[i], content: this._sentenceTruncate(keep[i].content, limit) };
        }
      }
      this.chatHistory.splice(0, this.chatHistory.length, ...keep);
    }

    if (this.chatHistory.length > 80) {
      const overflow = this.chatHistory.slice(0, -30);
      if (this.memorySystem) {
        this.memorySystem.apply({
          facts: ['历史归档: 早期对话已清理'],
          events: [`${formatGameTime(stateManager.get('世界·时间'))} 历史对话归档 (${overflow.length}条)`]
        }, { source: 'system' });
      }
      const recent = this.chatHistory.slice(-30);
      this.chatHistory.splice(0, this.chatHistory.length, ...recent);
    }
  }

  _sentenceTruncate(text, limit) {
    if (text.length <= limit) return text;
    // 优先在。！？\n 处截断,其次在，处,兜底硬截
    const cut = text.slice(0, limit);
    const strongBreak = cut.match(/^.*[。！？\n]/);
    if (strongBreak && strongBreak[0].length > limit * 0.5) return strongBreak[0];
    const softBreak = cut.match(/^.*[，,]/);
    if (softBreak && softBreak[0].length > limit * 0.4) return softBreak[0];
    return cut;
  }

  clearHistory() {
    this.chatHistory = [];
    this._staticSystemPrompt = null;
    this._mainPresetCache = null;
  }

  setHistory(history) {
    this.chatHistory = history || [];
  }

  getHistory() {
    return [...this.chatHistory];
  }
}

export { MessagePipeline };
export default MessagePipeline;
