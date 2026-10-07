import { AgentToolRuntime } from '../agent-tool-runtime.js';
import { stateManager as defaultStateManager } from '../state-manager.js';
import { eventBus } from '../event-bus.js';
import { timelineSystem as defaultTimelineSystem } from '../../systems/timeline-system.js';
import { cloudSave as defaultCloudSave } from '../cloud-save.js';
import { LINGXI_ASSISTANT_DEFINITION } from '../../data/lingxi-persona.js';
import { createToolApprovalBroker } from './approval-broker.js';
import { LingXiActionError, canonicalStringify } from './action-proposal.js';
import { classifyProposalApproval } from './proposal-approval-policy.js';
import {
  LINGXI_VARIABLE_PATCH_TOOL,
  createStateVariableActionAdapter
} from './adapters/state-adapter.js';
import {
  LINGXI_OPENING_TOOL,
  LINGXI_SETTINGS_TOOL,
  LINGXI_STORY_DIRECTION_TOOL,
  LINGXI_WORLDBOOK_TOOL,
  createProjectWriteAdapters
} from './adapters/project-write-adapters.js';
import {
  LINGXI_IMAGE_GENERATION_TOOL,
  LINGXI_IMAGE_LIBRARY_ACTION_TOOL,
  createImageLibraryActionAdapter,
  createImageStudioActionAdapter
} from './adapters/image-studio-adapter.js';
import {
  LINGXI_EQUIPMENT_ACTION_TOOL,
  LINGXI_MISSION_ACTION_TOOL,
  createGameplayActionAdapters
} from './adapters/gameplay-action-adapters.js';
import { equipmentSystem as defaultEquipmentSystem } from '../../systems/equipment-system.js';
import { missionSystem as defaultMissionSystem } from '../../systems/mission-system.js';
import {
  LINGXI_COMBAT_ACTION_TOOL,
  createCombatActionAdapter
} from './adapters/combat-action-adapter.js';
import {
  LINGXI_PLAYER_ACTION_TOOL,
  createPlayerActionAdapter
} from './adapters/player-action-adapter.js';
import {
  LINGXI_TIMELINE_ACTION_TOOL,
  createTimelineActionAdapter
} from './adapters/timeline-action-adapter.js';
import {
  LINGXI_CLOUD_SAVE_ACTION_TOOL,
  createCloudSaveActionAdapter
} from './adapters/cloud-save-action-adapter.js';
import { lingXiMusicAdapter } from './adapters/music-adapter.js';
import { LingXiContextBroker } from './lingxi-context-broker.js';
import { createLingXiResearchGate, inferNarrativeResearchKinds } from './research-gate.js';
import { createLingXiTools, redactLingXiSecrets } from './lingxi-tools.js';
import { getApiScheme, listApiSchemes } from '../api-schemes.js';
import { usesProjectServerFeatures } from '../runtime-platform.js';

const SESSION_KEY = 'naruto_lingxi_session_v1';
const API_CHOICE_KEY = 'naruto_lingxi_api_choice_v1';
const MAIN_API_CHOICE = 'main';
const MAX_STORED_MESSAGES = 30;
const MAX_CONTEXT_MESSAGES = 14;
const MAX_CONTEXT_CHARS = 20000;
const MAX_STORED_ACTIVITY = 32;

const INITIAL_MESSAGE = Object.freeze({
  role: 'assistant',
  content: '（灵希轻轻握住折扇“听风”，在晨光里呼出一口气，抬眼望向你）好啦，灵希来啦 (｡•̀ᴗ-)✧\n\n这个重启了很多次的木叶又转动起来了，不过这一次，我在这里，也会好好陪着你。\n\n项目玩法、变量修复、开局、世界书、普通剧情行动、音乐和画面工坊都可以交给我哦。小范围、可撤销的修改会在后台直接完成；删除、付费、剧情推进等高风险操作，我会先把影响摆给你看，你点一次“确认修改”就好。\n\n灵希要开始啦，让我看看今天的风，会带我们去哪里呢～'
});

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.has(String(key)) ? values.get(String(key)) : null,
    setItem: (key, value) => values.set(String(key), String(value)),
    removeItem: key => values.delete(String(key))
  };
}

function supportsProjectWriteAdapters(manager) {
  return [
    'getAPIConfig', 'saveAPIConfig', 'getSub', 'update', 'saveUIPrefs',
    'snapshot', 'restore', 'setSub'
  ].every(method => typeof manager?.[method] === 'function');
}

function cleanMessageText(value, max = 12000) {
  return String(redactLingXiSecrets(String(value ?? '')))
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, max);
}

function clone(value) {
  if (value == null) return value;
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

function normalizeStoredMessages(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(message => message && (message.role === 'user' || message.role === 'assistant'))
    .map(message => ({
      role: message.role,
      content: cleanMessageText(message.content),
      ...(message.role === 'assistant' && Array.isArray(message.activity)
        ? { activity: normalizeStoredActivity(message.activity) }
        : {})
    }))
    .filter(message => message.content)
    .slice(-MAX_STORED_MESSAGES);
}

function normalizeStoredActivity(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(event => event && typeof event === 'object' && event.type !== 'text-delta')
    .map(event => {
      const rawStep = event?.detail?.step ?? event.step;
      return {
        type: String(event.type || '').slice(0, 60),
        tool: String(event.tool || '').slice(0, 100),
        success: typeof event.success === 'boolean' ? event.success : null,
        durationMs: Number.isFinite(event.durationMs) ? Math.max(0, Math.round(event.durationMs)) : null,
        detail: {
          mode: event.detail && typeof event.detail === 'object'
            ? String(event.detail.mode || '').slice(0, 60)
            : '',
          step: Number.isInteger(Number(rawStep)) ? Math.max(0, Number(rawStep)) : null
        }
      };
    })
    .filter(event => event.type)
    .slice(-MAX_STORED_ACTIVITY);
}

function selectContextMessages(value) {
  const selected = [];
  let remaining = MAX_CONTEXT_CHARS;
  const messages = Array.isArray(value) ? value : [];
  for (let index = messages.length - 1; index >= 0 && selected.length < MAX_CONTEXT_MESSAGES; index--) {
    const message = messages[index];
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const content = cleanMessageText(message.content);
    if (!content) continue;
    if (!selected.length) {
      selected.push({ role: message.role, content: content.slice(-MAX_CONTEXT_CHARS) });
      remaining -= Math.min(content.length, MAX_CONTEXT_CHARS);
      continue;
    }
    if (content.length > remaining) break;
    selected.push({ role: message.role, content });
    remaining -= content.length;
  }
  return selected.reverse();
}

function resolveNarrativeResearchContext(input, messages = []) {
  const direct = inferNarrativeResearchKinds(input);
  if (direct.length) return { kinds: direct, query: String(input || '') };
  if (!/^\s*(?:(?:继续|接着|往下|续上)(?:写|讲|编|描述|展开|推进|下去)?|再来(?:一段|一点)?|再写(?:一段)?|然后呢|下一段)\s*[吧呀呢。！!?]*$/i.test(String(input || ''))) {
    return { kinds: [], query: String(input || '') };
  }
  const previousUsers = [...(Array.isArray(messages) ? messages : [])]
    .reverse()
    .filter(message => message?.role === 'user')
    .slice(0, 6);
  for (const message of previousUsers) {
    const inherited = inferNarrativeResearchKinds(message.content);
    if (inherited.length) {
      return {
        kinds: inherited,
        query: `${String(message.content || '')}\n${String(input || '')}`
      };
    }
  }
  return { kinds: [], query: String(input || '') };
}

function configUsable(config = {}) {
  if (!String(config.model || '').trim()) return false;
  if (String(config.backend || '').toLowerCase() === 'tavern') return true;
  return Boolean(String(config.apiKey || '').trim() || String(config.apiUrl || '').trim());
}

function proposalLabel(proposal) {
  const first = proposal?.diff?.[0];
  if (!first?.path) return '变量维护';
  return String(first.path).replace(/^\//, '').replace(/~1/g, '/').replace(/~0/g, '~');
}

function assertLingXiToolRegistry(tools) {
  const allowedEffects = new Set(LINGXI_ASSISTANT_DEFINITION.permissions.effects);
  for (const [name, tool] of Object.entries(tools || {})) {
    if (!tool || typeof tool.execute !== 'function') {
      throw new TypeError(`灵希工具缺少执行器: ${name}`);
    }
    if (!allowedEffects.has(tool.effect) || tool.effect === 'write') {
      throw new TypeError(`灵希工具权限越界: ${name} (${tool.effect || 'missing-effect'})`);
    }
  }
  return tools;
}

export class LingXiController {
  constructor({
    stateManager = defaultStateManager,
    timelineSystem = defaultTimelineSystem,
    runtime = null,
    approvalBroker = null,
    imageStudio = null,
    musicAdapter = null,
    equipmentSystem = defaultEquipmentSystem,
    missionSystem = defaultMissionSystem,
    executeCombatAction = null,
    executePlayerAction = null,
    executeTimelineAction = null,
    cloudSave = defaultCloudSave,
    isTrustedUserEvent = null,
    autoApplyLowRisk = true,
    researchGate = null,
    storage = globalThis.localStorage
  } = {}) {
    this.stateManager = stateManager;
    this.timelineSystem = timelineSystem;
    this.storage = storage || createMemoryStorage();
    this.runtime = runtime || new AgentToolRuntime({ contextBroker: new LingXiContextBroker() });
    this._active = false;
    this._sendInFlight = false;
    this._approvalInFlight = false;
    this.autoApplyLowRisk = autoApplyLowRisk !== false;
    this._lastStagedProposal = null;
    this.messages = this._loadMessages();
    this.musicAdapter = musicAdapter || lingXiMusicAdapter;
    this.researchGate = researchGate || createLingXiResearchGate();
    this.imageStudioAdapter = createImageStudioActionAdapter({
      ...(imageStudio ? { imageStudio } : {})
    });
    this.imageLibraryAdapter = createImageLibraryActionAdapter({
      ...(imageStudio ? { imageStudio } : {})
    });
    this.combatActionAdapter = typeof this.stateManager?.snapshot === 'function'
      ? createCombatActionAdapter({
          stateManager: this.stateManager,
          ...(typeof executeCombatAction === 'function' ? { executeCombatAction } : {})
        })
      : null;
    this.playerActionAdapter = typeof this.stateManager?.snapshot === 'function'
      ? createPlayerActionAdapter({
          stateManager: this.stateManager,
          ...(typeof executePlayerAction === 'function' ? { executePlayerAction } : {})
        })
      : null;
    this.timelineActionAdapter = typeof this.stateManager?.snapshot === 'function'
      && typeof this.timelineSystem?.getAllNodes === 'function'
      && typeof this.timelineSystem?.getAllBranches === 'function'
      ? createTimelineActionAdapter({
          stateManager: this.stateManager,
          timelineSystem: this.timelineSystem,
          ...(typeof executeTimelineAction === 'function' ? { executeTimelineAction } : {})
        })
      : null;
    this.cloudSaveActionAdapter = usesProjectServerFeatures() && (
      typeof cloudSave?.listSaves === 'function'
      && typeof cloudSave?.uploadSave === 'function'
      && typeof cloudSave?.updateSave === 'function'
      && typeof cloudSave?.deleteSave === 'function'
      && typeof cloudSave?.downloadSave === 'function'
      && typeof this.timelineSystem?.getExportData === 'function'
      && typeof this.timelineSystem?.importTimeline === 'function'
    ) ? createCloudSaveActionAdapter({
        cloudSave,
        timelineSystem: this.timelineSystem,
        stateManager: this.stateManager
      })
      : null;

    if (approvalBroker) {
      this.approvalBroker = approvalBroker;
      if (typeof this.approvalBroker.register === 'function'
        && !this.approvalBroker.adapters?.has?.(LINGXI_IMAGE_GENERATION_TOOL)) {
        this.approvalBroker.register(LINGXI_IMAGE_GENERATION_TOOL, this.imageStudioAdapter);
      }
      if (typeof this.approvalBroker.register === 'function'
        && !this.approvalBroker.adapters?.has?.(LINGXI_IMAGE_LIBRARY_ACTION_TOOL)) {
        this.approvalBroker.register(LINGXI_IMAGE_LIBRARY_ACTION_TOOL, this.imageLibraryAdapter);
      }
      if (this.combatActionAdapter
        && typeof this.approvalBroker.register === 'function'
        && !this.approvalBroker.adapters?.has?.(LINGXI_COMBAT_ACTION_TOOL)) {
        this.approvalBroker.register(LINGXI_COMBAT_ACTION_TOOL, this.combatActionAdapter);
      }
      if (this.playerActionAdapter
        && typeof this.approvalBroker.register === 'function'
        && !this.approvalBroker.adapters?.has?.(LINGXI_PLAYER_ACTION_TOOL)) {
        this.approvalBroker.register(LINGXI_PLAYER_ACTION_TOOL, this.playerActionAdapter);
      }
      if (this.timelineActionAdapter
        && typeof this.approvalBroker.register === 'function'
        && !this.approvalBroker.adapters?.has?.(LINGXI_TIMELINE_ACTION_TOOL)) {
        this.approvalBroker.register(LINGXI_TIMELINE_ACTION_TOOL, this.timelineActionAdapter);
      }
      if (this.cloudSaveActionAdapter
        && typeof this.approvalBroker.register === 'function'
        && !this.approvalBroker.adapters?.has?.(LINGXI_CLOUD_SAVE_ACTION_TOOL)) {
        this.approvalBroker.register(LINGXI_CLOUD_SAVE_ACTION_TOOL, this.cloudSaveActionAdapter);
      }
    } else {
      const stateAdapter = createStateVariableActionAdapter(this.stateManager);
      const checkpointingAdapter = {
        toolName: LINGXI_VARIABLE_PATCH_TOOL,
        stage: async (params, options = {}) => {
          const timelineImpact = await this._previewTimelineImpact();
          return stateAdapter.stage(params, {
            ...options,
            context: { timelineImpact }
          });
        },
        apply: proposal => this._applyCheckpointedStateProposal(stateAdapter, proposal)
      };
      const projectAdapters = supportsProjectWriteAdapters(this.stateManager)
        ? createProjectWriteAdapters({
            stateManager: this.stateManager,
            storage: this.storage
          })
        : [];
      const gameplayAdapters = supportsProjectWriteAdapters(this.stateManager)
        ? createGameplayActionAdapters({
            stateManager: this.stateManager,
            equipmentSystem,
            missionSystem
          }).map(adapter => ({
            toolName: adapter.toolName,
            stage: async (params, options = {}) => {
              const timelineImpact = await this._previewTimelineImpact();
              return adapter.stage(params, {
                ...options,
                context: { timelineImpact }
              });
            },
            apply: proposal => this._applyCheckpointedStateProposal(adapter, proposal)
          }))
        : [];
      this.approvalBroker = createToolApprovalBroker({
        adapters: [
          checkpointingAdapter,
          ...projectAdapters,
          ...gameplayAdapters,
          this.imageStudioAdapter,
          this.imageLibraryAdapter,
          ...(this.combatActionAdapter ? [this.combatActionAdapter] : []),
          ...(this.playerActionAdapter ? [this.playerActionAdapter] : []),
          ...(this.timelineActionAdapter ? [this.timelineActionAdapter] : []),
          ...(this.cloudSaveActionAdapter ? [this.cloudSaveActionAdapter] : [])
        ],
        ...(typeof isTrustedUserEvent === 'function' ? { isTrustedUserEvent } : {})
      });
    }

    this.tools = assertLingXiToolRegistry(createLingXiTools({
      stateManager: this.stateManager,
      stageVariableChange: params => this.stageVariableChange(params),
      stageSettingsChange: params => this.stageSettingsChange(params),
      stageOpeningChange: params => this.stageOpeningChange(params),
      stageWorldbookChange: params => this.stageWorldbookChange(params),
      stageStoryDirectionChange: params => this.stageStoryDirectionChange(params),
      stageEquipmentAction: params => this.stageEquipmentAction(params),
      stageMissionAction: params => this.stageMissionAction(params),
      imageStudioAdapter: this.imageStudioAdapter,
      stageImageGeneration: params => this.stageImageGeneration(params),
      stageImageLibraryAction: params => this.stageImageLibraryAction(params),
      stageCombatAction: params => this.stageCombatAction(params),
      stagePlayerAction: params => this.stagePlayerAction(params),
      stageTimelineAction: params => this.stageTimelineAction(params),
      stageCloudSaveAction: params => this.stageCloudSaveAction(params),
      inspectCloudSaves: params => this.inspectCloudSaves(params),
      musicAdapter: this.musicAdapter,
      researchGate: this.researchGate,
      timelineSystem: this.timelineSystem
    }));
  }

  _loadMessages() {
    try {
      const parsed = JSON.parse(this.storage?.getItem?.(SESSION_KEY) || '[]');
      const messages = normalizeStoredMessages(parsed);
      return messages.length ? messages : [clone(INITIAL_MESSAGE)];
    } catch {
      return [clone(INITIAL_MESSAGE)];
    }
  }

  _saveMessages() {
    try {
      this.storage?.setItem?.(SESSION_KEY, JSON.stringify(this.messages.slice(-MAX_STORED_MESSAGES)));
    } catch {
      // A full or disabled localStorage must not block the assistant conversation.
    }
  }

  getHistory() {
    return clone(this.messages) || [];
  }

  startNewConversation() {
    if (this._active || this._sendInFlight || this._approvalInFlight) {
      throw Object.assign(new Error('灵希正在处理当前消息，请等本轮结束后再新建对话。'), { code: 'LINGXI_BUSY' });
    }
    const pending = this.approvalBroker?.listPendingProposals?.() || [];
    for (const proposal of pending) {
      if (proposal?.id) this.discardProposal(proposal.id);
    }
    this._lastStagedProposal = null;
    this.messages = [clone(INITIAL_MESSAGE)];
    this._saveMessages();
    eventBus.emit('lingxi:history-cleared', { reason: 'new-conversation' });
    return this.getHistory();
  }

  clearHistory() {
    return this.startNewConversation();
  }

  get isActive() {
    return this._active || this._sendInFlight || this._approvalInFlight;
  }

  getSelectedApiChoice() {
    try {
      const value = String(this.storage?.getItem?.(API_CHOICE_KEY) || '').trim();
      return value && value.length <= 240 ? value : MAIN_API_CHOICE;
    } catch {
      return MAIN_API_CHOICE;
    }
  }

  setSelectedApiChoice(choiceId) {
    const value = String(choiceId || MAIN_API_CHOICE).trim().slice(0, 240) || MAIN_API_CHOICE;
    try { this.storage?.setItem?.(API_CHOICE_KEY, value); } catch { /* selection remains main next session */ }
    return value;
  }

  async listApiChoices() {
    const main = await this.stateManager.getAPIConfigAsync?.() || this.stateManager.getAPIConfig?.() || {};
    const schemes = await listApiSchemes();
    return [
      {
        id: MAIN_API_CHOICE,
        label: '跟随主 API',
        model: String(main.model || ''),
        configured: configUsable(main)
      },
      ...schemes.map(scheme => ({
        id: scheme.id,
        label: scheme.name,
        model: scheme.model,
        configured: Boolean(scheme.model && (scheme.hasKey || scheme.apiUrl || scheme.backend === 'tavern'))
      }))
    ];
  }

  async _resolveApiConfig() {
    const selected = this.getSelectedApiChoice();
    if (selected !== MAIN_API_CHOICE) {
      const scheme = await getApiScheme(selected);
      if (scheme) {
        return {
          ...scheme,
          useProxy: String(scheme.backend || '').toLowerCase() !== 'tavern'
        };
      }
      this.setSelectedApiChoice(MAIN_API_CHOICE);
    }
    return await this.stateManager.getAPIConfigAsync?.() || this.stateManager.getAPIConfig?.() || {};
  }

  abort() {
    this.runtime?.abort?.(new Error('Ling Xi request cancelled'));
  }

  _contextIdentity() {
    const meta = this.stateManager.getSub?.('_meta') || this.stateManager.get()?._meta || {};
    return canonicalStringify({ node: meta.current_node_id || null, branch: meta.active_branch || null });
  }

  _assertTurnContext(context = this._turnContext) {
    if (!context) return;
    if (context.invalidated || context.identity !== this._contextIdentity()) {
      context.invalidated = true;
      const error = new LingXiActionError('LINGXI_CONTEXT_CHANGED', '当前存档或时间线已切换，本轮灵希请求已停止。请在新存档中重新提问。');
      this.runtime?.abort?.(error);
      throw error;
    }
  }

  async stageVariableChange({ key, value, reason } = {}) {
    this._assertTurnContext();
    const meta = this.stateManager.getSub?.('_meta') || {};
    if (!meta.current_node_id) {
      const error = new Error('当前还没有可恢复的时间线节点。请先完成开局，再修改存档变量。');
      error.code = 'LINGXI_CHECKPOINT_REQUIRED';
      throw error;
    }
    const proposal = await this.approvalBroker.stageAction(LINGXI_VARIABLE_PATCH_TOOL, {
      updates: [{ key, op: '=', value }],
      reason
    });
    return this._settleStagedProposal(proposal);
  }

  async _stageProjectAction(tool, params) {
    this._assertTurnContext();
    const proposal = await this.approvalBroker.stageAction(tool, params);
    return this._settleStagedProposal(proposal);
  }

  async _settleStagedProposal(proposal) {
    try {
      this._assertTurnContext();
    } catch (error) {
      this.discardProposal(proposal.id);
      throw error;
    }
    const policy = classifyProposalApproval(proposal);
    if (this.autoApplyLowRisk && policy.mode === 'automatic') {
      if (typeof this.approvalBroker?.applyLowRiskProposal !== 'function') {
        throw new LingXiActionError(
          'LINGXI_BROKER_INVALID',
          '审批 Broker 不支持低风险提案的后台执行。'
        );
      }
      const receipt = await this.approvalBroker.applyLowRiskProposal(proposal.id);
      const result = {
        ...clone(proposal),
        approvalMode: 'automatic',
        autoApplied: true,
        receipt: clone(receipt)
      };
      eventBus.emit('lingxi:proposal-applied', {
        receipt: clone(receipt),
        automatic: true,
        policy: clone(policy)
      });
      return result;
    }
    this._lastStagedProposal = proposal;
    eventBus.emit('lingxi:proposal-staged', { proposal: clone(proposal) });
    return { ...clone(proposal), approvalMode: 'confirm', autoApplied: false };
  }

  async stageSettingsChange(params = {}) {
    return this._stageProjectAction(LINGXI_SETTINGS_TOOL, params);
  }

  async stageOpeningChange(params = {}) {
    return this._stageProjectAction(LINGXI_OPENING_TOOL, params);
  }

  async stageWorldbookChange(params = {}) {
    return this._stageProjectAction(LINGXI_WORLDBOOK_TOOL, params);
  }

  async stageStoryDirectionChange(params = {}) {
    return this._stageProjectAction(LINGXI_STORY_DIRECTION_TOOL, params);
  }

  async stageEquipmentAction(params = {}) {
    return this._stageProjectAction(LINGXI_EQUIPMENT_ACTION_TOOL, params);
  }

  async stageMissionAction(params = {}) {
    return this._stageProjectAction(LINGXI_MISSION_ACTION_TOOL, params);
  }

  async stageImageGeneration(params = {}) {
    return this._stageProjectAction(LINGXI_IMAGE_GENERATION_TOOL, params);
  }

  async stageImageLibraryAction(params = {}) {
    return this._stageProjectAction(LINGXI_IMAGE_LIBRARY_ACTION_TOOL, params);
  }

  async stageCombatAction(params = {}) {
    return this._stageProjectAction(LINGXI_COMBAT_ACTION_TOOL, params);
  }

  async stagePlayerAction(params = {}) {
    return this._stageProjectAction(LINGXI_PLAYER_ACTION_TOOL, params);
  }

  async stageTimelineAction(params = {}) {
    return this._stageProjectAction(LINGXI_TIMELINE_ACTION_TOOL, params);
  }

  async stageCloudSaveAction(params = {}) {
    return this._stageProjectAction(LINGXI_CLOUD_SAVE_ACTION_TOOL, params);
  }

  async inspectCloudSaves(params = {}) {
    if (typeof this.cloudSaveActionAdapter?.inspectSaves !== 'function') {
      throw new Error('云存档列表读取功能暂不可用');
    }
    return this.cloudSaveActionAdapter.inspectSaves(params);
  }

  async _applyCheckpointedStateProposal(adapter, proposal) {
    const expectedTimelineImpact = proposal?.context?.timelineImpact;
    if (!expectedTimelineImpact) {
      throw new LingXiActionError('LINGXI_PROPOSAL_INVALID', '存档操作提案缺少已绑定的时间线影响');
    }
    const currentTimelineImpact = await this._previewTimelineImpact();
    if (canonicalStringify(currentTimelineImpact) !== canonicalStringify(expectedTimelineImpact)) {
      throw new LingXiActionError(
        'LINGXI_PROPOSAL_STALE',
        '时间线影响已变化，请重新生成并审阅差异卷轴。',
        { expected: expectedTimelineImpact, current: currentTimelineImpact }
      );
    }
    const before = this.stateManager.snapshot();
    const previousNodeId = before?._meta?.current_node_id || null;
    let receipt;
    let postPatchSnapshot = null;
    let postPatchCanonical = null;
    try {
      receipt = await adapter.apply(proposal);
      postPatchSnapshot = this.stateManager.snapshot();
      postPatchCanonical = canonicalStringify(postPatchSnapshot);
      if (!previousNodeId || typeof this.timelineSystem?.createMaintenanceCheckpoint !== 'function') {
        throw Object.assign(new Error('时间线维护检查点不可用，变量写入已撤销。'), {
          code: 'LINGXI_CHECKPOINT_UNAVAILABLE'
        });
      }
      const checkpoint = await this.timelineSystem.createMaintenanceCheckpoint({
        label: proposalLabel(proposal),
        reason: String(proposal?.params?.reason || '灵希存档维护').slice(0, 500),
        proposalId: proposal.id,
        stateSnapshot: postPatchSnapshot,
        expectedImpact: expectedTimelineImpact
      });
      return {
        ...receipt,
        checkpoint: {
          nodeId: checkpoint.id,
          previousNodeId,
          label: checkpoint.summary,
          undo: { type: 'timeline-node', nodeId: previousNodeId }
        }
      };
    } catch (error) {
      if (postPatchCanonical === null) throw error;
      const current = this.stateManager.snapshot();
      if (canonicalStringify(current) === postPatchCanonical) {
        this.stateManager.restore(before);
        throw error;
      }
      throw new LingXiActionError(
        'LINGXI_ROLLBACK_CONFLICT',
        '检查点失败后检测到新的状态提交；为避免覆盖并发数据，灵希没有自动回滚，请人工检查当前存档。',
        { checkpointError: error?.code || error?.message || 'UNKNOWN_CHECKPOINT_ERROR' }
      );
    }
  }

  async _previewTimelineImpact() {
    if (typeof this.timelineSystem?.previewMaintenanceCheckpoint !== 'function') {
      throw new LingXiActionError(
        'LINGXI_CHECKPOINT_UNAVAILABLE',
        '时间线维护影响无法预览，变量提案未创建。'
      );
    }
    return this.timelineSystem.previewMaintenanceCheckpoint();
  }

  async approveProposal(userEvent, { proposalId } = {}) {
    if (this._approvalInFlight) {
      throw Object.assign(new Error('灵希正在执行上一份已批准提案，请等待执行回执。'), { code: 'LINGXI_BUSY' });
    }
    this._approvalInFlight = true;
    try {
      const receipt = await this.approvalBroker.approveFromUserEvent(userEvent, { proposalId });
      eventBus.emit('lingxi:proposal-applied', { receipt: clone(receipt) });
      return receipt;
    } finally {
      this._approvalInFlight = false;
    }
  }

  discardProposal(proposalId) {
    const discarded = this.approvalBroker.discardProposal(proposalId);
    if (discarded) eventBus.emit('lingxi:proposal-discarded', { proposalId });
    return discarded;
  }

  async send(input, { onEvent = null } = {}) {
    const userText = cleanMessageText(input);
    if (!userText) throw new TypeError('消息不能为空');
    if (this._active || this._sendInFlight || this._approvalInFlight) throw Object.assign(new Error('灵希正在感知上一条消息'), { code: 'LINGXI_BUSY' });
    const narrativeResearch = resolveNarrativeResearchContext(userText, this.messages);
    const narrativeResearchKinds = narrativeResearch.kinds;
    this.researchGate.begin(narrativeResearch.query);
    const pendingBeforeTurn = new Set((this.approvalBroker?.listPendingProposals?.() || [])
      .map(proposal => proposal?.id)
      .filter(Boolean));

    this._sendInFlight = true;
    const turnContext = { identity: this._contextIdentity(), invalidated: false };
    this._turnContext = turnContext;
    const checkContext = () => {
      try { this._assertTurnContext(turnContext); } catch { /* propagated by the active request */ }
    };
    const invalidateContext = () => { turnContext.invalidated = true; checkContext(); };
    const contextUnsubs = [
      eventBus.on('state:restored', checkContext),
      eventBus.on('state:reset', invalidateContext),
      eventBus.on('timeline:imported', invalidateContext),
      eventBus.on('timeline:jumped', checkContext),
      eventBus.on('timeline:branch-switched', checkContext)
    ];
    try {
      this.messages.push({ role: 'user', content: userText });
      this.messages = this.messages.slice(-MAX_STORED_MESSAGES);
      this._saveMessages();

      if (/^yes$/i.test(userText) && this.approvalBroker.listPendingProposals().length) {
        const message = {
          role: 'assistant',
          content: '唔，聊天里的 yes 不能代替真实按钮哦。请打开待确认的差异卷轴，核对后点击“确认修改”；不需要再输入任何短语。现在还没有改动内容呢。'
        };
        this.messages.push(message);
        this._saveMessages();
        return { message: clone(message), proposal: this._lastStagedProposal, mode: 'local-safety' };
      }

      const config = await this._resolveApiConfig();
      this._assertTurnContext(turnContext);
      if (!configUsable(config)) {
        const message = {
          role: 'assistant',
          content: '诶，灵希还没找到能用的模型连接呢。先去“设置 → AI 连接”配好你的 API，或者在上方给灵希选一个已保存方案吧。密钥只会待在连接层，不会跑进聊天里哦。'
        };
        this.messages.push(message);
        this._saveMessages();
        return { message: clone(message), proposal: null, mode: 'not-configured' };
      }

      this._active = true;
      this._lastStagedProposal = null;
      eventBus.emit('lingxi:status', { status: 'thinking' });
      try {
        this.runtime.configure(config);
        const contextMessages = selectContextMessages(this.messages);
        let ungroundedNarrativeSeen = false;
        const guardedOnEvent = event => {
          const ungroundedNarrative = event?.type === 'text-delta'
            && cleanMessageText(event?.delta || event?.text || '')
            && narrativeResearchKinds.some(kind => this.researchGate.missing(kind).length);
          if (ungroundedNarrative) ungroundedNarrativeSeen = true;
          if (!ungroundedNarrative) onEvent?.(event);
        };
        const result = await this.runtime.runAgent({
          definition: LINGXI_ASSISTANT_DEFINITION,
          messages: contextMessages,
          tools: Object.fromEntries(Object.entries(this.tools).map(([name, tool]) => [name, {
            ...tool,
            execute: async (...args) => {
              this._assertTurnContext(turnContext);
              const result = await tool.execute(...args);
              this._assertTurnContext(turnContext);
              return result;
            }
          }])),
          budget: { maxSteps: 12, maxOutputTokens: 2200, temperature: 0.45, topP: 0.9, contextLimit: 1 },
          state: this.stateManager.get() || {},
          userInput: userText,
          audience: 'assistant',
          onEvent: guardedOnEvent
        });
        this._assertTurnContext(turnContext);
        let mode = result.mode;
        let content = cleanMessageText(result.text) || '灵希没有收到完整回应，请再试一次。';
        const missingResearchKinds = narrativeResearchKinds.filter(kind => this.researchGate.missing(kind).length);
        if (ungroundedNarrativeSeen || missingResearchKinds.length) {
          const requirementMessages = [];
          for (const kind of missingResearchKinds) {
            try { this.researchGate.assert(kind); } catch (error) { requirementMessages.push(error.message); }
          }
          if (ungroundedNarrativeSeen) {
            requirementMessages.unshift('灵希在完成本轮项目检索前就开始生成相关正文');
          }
          const requirementMessage = [...new Set(requirementMessages)].join('；');
          for (const proposal of this.approvalBroker?.listPendingProposals?.() || []) {
            if (proposal?.id && !pendingBeforeTurn.has(proposal.id)) this.discardProposal(proposal.id);
          }
          this._lastStagedProposal = null;
          content = `唔，这轮没有完成项目规定的检索，所以灵希没有采用刚才生成的内容，也没有提交任何提案。${requirementMessage}。请再试一次，我会先查证资料再写。`;
          mode = 'research-required';
        } else if (result.mode === 'plain-chat') {
          const attemptedActions = result.toolOutcomes?.some(call => call.effect !== 'read');
          const notice = attemptedActions
            ? '这轮工具连接中断，已返回的结果已保留。操作是否生效请以执行回执为准；待确认的提案仍需点击确认。'
            : '这轮工具链没有跑完，后续内容仅为对话建议；本轮没有修改设置或存档。';
          content = `${content}\n\n小提醒：${notice}`;
        }
        const message = {
          role: 'assistant',
          content,
          activity: normalizeStoredActivity(result.trace)
        };
        this.messages.push(message);
        this.messages = this.messages.slice(-MAX_STORED_MESSAGES);
        this._saveMessages();
        const payload = {
          message: clone(message),
          proposal: clone(this._lastStagedProposal),
          mode,
          usage: clone(result.usage)
        };
        eventBus.emit('lingxi:message', payload);
        return payload;
      } finally {
        this._active = false;
        eventBus.emit('lingxi:status', { status: 'idle' });
      }
    } catch (error) {
      if (turnContext.invalidated) {
        for (const proposal of this.approvalBroker?.listPendingProposals?.() || []) {
          if (proposal?.id && !pendingBeforeTurn.has(proposal.id)) this.discardProposal(proposal.id);
        }
        this._lastStagedProposal = null;
      }
      throw error;
    } finally {
      contextUnsubs.forEach(unsub => unsub());
      this._turnContext = null;
      this._sendInFlight = false;
    }
  }
}

export const lingXiController = new LingXiController();

export default lingXiController;
