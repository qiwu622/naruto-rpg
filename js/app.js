import { stateManager } from './core/state-manager.js';
import { listPersonaProfiles, deletePersonaProfile } from './core/persona-profiles.js';
import { aiClient, isTavernEnv } from './core/ai-client.js';
import { eventBus } from './core/event-bus.js';
import { MessagePipeline } from './core/pipeline.js';
import { timelineSystem } from './systems/timeline-system.js';
import { combatSystem } from './systems/combat-system.js';
import { listTacticalMoves } from './systems/tactical-combat.js';
import { inferTacticalMoveId, tacticalSourceFingerprint } from './systems/tactical-combat-session.js';
import {
  buildCombatPlayerActionMessage,
  combatPlayerActionDefinition
} from './systems/combat-action.js';
import { missionSystem } from './systems/mission-system.js';
import { relationshipSystem } from './systems/relationship-system.js';
import { memorySystem } from './systems/memory-system.js';
import { cloudSave } from './core/cloud-save.js';
import { personalSaveLibrary } from './core/personal-save-library.js';
import { saveLibraryCloud } from './core/save-library-cloud.js';
import { continuationSaveScope } from './core/continuation-save.js';
import { ROOM_SAVE_KIND, SAVE_PACKAGE_SCHEMA } from './core/save-library.js';
import { localRoomHistory } from './multiplayer/local-room-history.js';
import { openSaveLibrary } from './ui/save-library-panel.js';
import { authClient } from './core/auth-client.js';
import { startAppCloudChecks } from './core/app-cloud.js';
import { cloudConnectionEnabled } from './core/project-server.js';
import './ui/app-cloud-panel.js';
import { worldStateSystem } from './systems/world-state-system.js';
import { errorHandler } from './utils/error-handler.js';
import { loadingIndicator } from './utils/loading-indicator.js';
import { swNotifier } from './utils/sw-notifier.js';
import { resolveOpeningContract } from './systems/opening-contract.js';
import { buildOpeningPrompt } from './systems/opening-prompt.js';
import { migrateStorage } from './core/storage-migrations.js';
import { imageFeatureIntegration } from './core/image-studio/integration.js';
import { resolveAICallPolicy } from './core/ai-call-policy.js';
import { TIMELINE_FILE_ACCEPT, decodeTimelineSaveFile } from './core/timeline-file-codec.js';
import { inspectRuntimeBuild, showStaleBuildNotice } from './utils/build-version.js';
import { isNativeAndroidApp, usesProjectServerFeatures, isMultiplayerEntryVisible } from './core/runtime-platform.js';
import {
  ANDROID_APP_DOWNLOAD_URL,
  ANDROID_APP_VERSION,
  formatAndroidUpdateMessage,
  appUpdateService
} from './core/app-update.js';

import { appShell } from './ui/app-shell.js';
import { atmosphereManager } from './ui/atmosphere-manager.js';
import { escAttr } from './utils/format.js';
import { KNOWLEDGE_BASE } from './data/knowledge-base.js';
import './ui/hud.js';
import './ui/combat-arena.js';
import './ui/character-creator.js';
import './ui/panel.js';
import './ui/modal.js';
import './ui/timeline-navigator.js';
import './ui/api-config-form.js';
import './ui/display-config-form.js';
import './ui/worldbook-editor.js';
import './ui/main-preset-editor.js';
import './ui/variable-updater-preset-editor.js';
import './ui/agent-progress.js';
import './ui/map-modal.js';
import './ui/image-studio.js';
import './ui/lingxi-companion.js';
import SettingsPanel, { applyLocalSettings } from './ui/settings-panel.js';
import { openMultiplayerOverlay } from './ui/multiplayer-overlay.js';
import {
  actionSubmissionUnavailableMessage,
  canSubmitProjectedAction,
  isProjectedOpeningTurn,
  projectedNarrativeDeliveries
} from './multiplayer/ui-projection.js';
import { musicPlayback } from './core/music-playback.js';
import {
  bindMusicFloatingPlayer,
  controlMusicWithFloatingPlayer,
  openMusicWithFloatingPlayer
} from './ui/music-floating-player.js';

const MULTIPLAYER_ROOM_STORAGE_KEY = 'naruto_multiplayer_last_room';
const MULTIPLAYER_INVITE_SESSION_KEY = 'naruto_multiplayer_session_invite';
const MULTIPLAYER_ROOM_ID_PATTERN = /^[A-Za-z][A-Za-z0-9:_-]{1,255}$/u;

function readRememberedMultiplayerRoomId() {
  try {
    const roomId = globalThis.localStorage?.getItem(multiplayerRoomStorageKey())?.trim()
      ?? globalThis.localStorage?.getItem(MULTIPLAYER_ROOM_STORAGE_KEY)?.trim() ?? '';
    return MULTIPLAYER_ROOM_ID_PATTERN.test(roomId) ? roomId : null;
  } catch {
    return null;
  }
}

function rememberMultiplayerRoomId(roomId) {
  if (!MULTIPLAYER_ROOM_ID_PATTERN.test(String(roomId ?? ''))) return false;
  try {
    globalThis.localStorage?.setItem(multiplayerRoomStorageKey(), roomId);
    if (authClient.getUser()?.id) globalThis.localStorage?.removeItem(MULTIPLAYER_ROOM_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

function multiplayerRoomStorageKey() {
  const userId = authClient.getUser()?.id;
  return userId ? `${MULTIPLAYER_ROOM_STORAGE_KEY}:${userId}` : MULTIPLAYER_ROOM_STORAGE_KEY;
}

function rememberMultiplayerInvite(invite) {
  if (!invite?.room_id || !invite?.token) return false;
  try {
    globalThis.sessionStorage?.setItem(MULTIPLAYER_INVITE_SESSION_KEY, JSON.stringify({
      room_id: invite.room_id,
      room_code: invite.room_code ?? null,
      token: invite.token
    }));
    return true;
  } catch {
    return false;
  }
}

function readRememberedMultiplayerInvite(roomId) {
  try {
    const value = JSON.parse(
      globalThis.sessionStorage?.getItem(MULTIPLAYER_INVITE_SESSION_KEY) ?? 'null'
    );
    if (!value || value.room_id !== roomId || typeof value.token !== 'string') return null;
    return Object.freeze(value);
  } catch {
    return null;
  }
}

function forgetRememberedMultiplayerSession() {
  try { globalThis.localStorage?.removeItem(multiplayerRoomStorageKey()); } catch { /* no-op */ }
  try { globalThis.localStorage?.removeItem(MULTIPLAYER_ROOM_STORAGE_KEY); } catch { /* no-op */ }
  try { globalThis.sessionStorage?.removeItem(MULTIPLAYER_INVITE_SESSION_KEY); } catch { /* no-op */ }
}

function forgetRememberedMultiplayerInvite() {
  try { globalThis.sessionStorage?.removeItem(MULTIPLAYER_INVITE_SESSION_KEY); } catch { /* no-op */ }
}

class NarutoRPGApp {
  constructor() {
    this.pipeline = null;
    this._state = 'init';
    this._settingsTransition = Promise.resolve();
    this._profileModal = null;
    this._musicGestureCleanup = null;
    this._musicPlayerStateCleanup = null;
    this._multiplayerOverlay = null;
    this._multiplayerActiveRoomId = null;
    this._multiplayerRenderedCommit = null;
    this._multiplayerNoticeSeq = 0;
    this._appUpdateCheckScheduled = false;
  }

  async init() {
    migrateStorage();

    const container = document.getElementById('app');
    if (!container) {
      console.error('[NarutoRPG] #app element not found');
      return;
    }

    this._musicGestureCleanup ||= musicPlayback.bindUserGestureUnlock(document);
    this._musicPlayerStateCleanup ||= bindMusicFloatingPlayer(musicPlayback);

    appShell.init(container);
    if (!isNativeAndroidApp()) void this._checkRuntimeBuild();
    if (!container.querySelector('lingxi-companion')) {
      container.appendChild(document.createElement('lingxi-companion'));
    }
    atmosphereManager.init();
    
    let dbOk = false;
    try {
      await stateManager.initDB();
      dbOk = true;
    } catch(e) {
      console.error('[NarutoRPG] Failed to init DB:', e);
    }

    await stateManager.loadUIPrefs();
    applyLocalSettings();
    this._applyDisplayConfig(stateManager.getDisplayConfig());
    this._bindEvents();

    try {
      await timelineSystem.init();
    } catch (e) {
      console.warn('[NarutoRPG] IndexedDB init failed, running without persistence:', e.message);
    }

    try {
      await imageFeatureIntegration.init();
    } catch (error) {
      console.warn('[NarutoRPG] Image Studio init failed; narrative remains available:', error.message);
    }

    this.pipeline = new MessagePipeline({
      knowledgeBase: KNOWLEDGE_BASE,
      timelineSystem: dbOk ? timelineSystem : null,
      uiRenderer: null,
      combatSystem,
      missionSystem,
      relationshipSystem,
      memorySystem,
      worldStateSystem
    });
    memorySystem.bindEvents();

    // 使用加密加载（解密 API Key + 强制代理模式）
    const apiConfig = await stateManager.getAPIConfigAsync();
    if (apiConfig) {
      aiClient.configure(apiConfig);
    } else if (isTavernEnv) {
      // 酒馆环境自动使用酒馆模型，无需手动配置 API
      const tavernConfig = { backend: 'tavern', model: 'tavern-default', apiUrl: '', apiKey: '' };
      aiClient.configure(tavernConfig);
      console.log('[NarutoRPG] 酒馆环境检测到，自动使用酒馆模型');
    }
    const isConfigured = aiClient.isConfigured();
    if (isConfigured) {
      if (dbOk) {
        try {
          await this._checkSavedGame();
          this._registerServiceWorker();
          this._state = 'ready';
          console.log('[NarutoRPG] App initialized');
          this._scheduleMultiplayerRestore();
          this._scheduleAppUpdateCheck();
          this._startAppCloudChecks();
          return;
        } catch (e) {
          console.warn('[NarutoRPG] Failed to restore saved game:', e.message);
        }
      }
      appShell.showCharacterCreator();
    } else {
      appShell.showAPIForm();
    }

    this._registerServiceWorker();
    this._state = 'ready';
    console.log('[NarutoRPG] App initialized');
    this._scheduleMultiplayerRestore();
    this._scheduleAppUpdateCheck();
    this._startAppCloudChecks();
  }

  _startAppCloudChecks() {
    if (this._stopAppCloudChecks) return;
    this._stopAppCloudChecks = startAppCloudChecks();
  }

  async _resumeNativeCloudSync() {
    if (!isNativeAndroidApp() || !cloudConnectionEnabled() || authClient.getCloudError()
      || this.pipeline?.isProcessing || this._saveTransition || localStorage.getItem('naruto_auto_cloud_sync') !== 'true') return;
    const scope = await this._refreshCloudSyncContext();
    if (scope?.userId && scope.saveKey) await this._queueCloudSave(scope);
  }

  _scheduleAppUpdateCheck() {
    if (!isNativeAndroidApp() || this._appUpdateCheckScheduled) return false;
    this._appUpdateCheckScheduled = true;
    this._stopAppUpdateChecks = appUpdateService.startAutomaticChecks({
      onResult: result => this._presentAppUpdate(result, { automatic: true }),
      onError: error => {
        console.warn('[AppUpdate] Automatic update check failed:', error.message);
      }
    });
    return true;
  }

  async _checkAppUpdate({ automatic = false } = {}) {
    const result = await appUpdateService.check();
    return this._presentAppUpdate(result, { automatic });
  }

  async _presentAppUpdate(result, { automatic = false } = {}) {
    this._refreshProfileUpdateIndicator(result);
    if (!result.updateAvailable) return result;
    if (automatic && (!appUpdateService.shouldPromptAutomatically(result)
      || this.pipeline?.isProcessing || this._saveTransition || document.visibilityState === 'hidden')) return result;
    if (this._appUpdatePromptOpen) return result;

    this._appUpdatePromptOpen = true;
    try {
      const accepted = await customElements.get('game-modal').confirm({
        title: `Android ${result.latestVersion} 更新公告`,
        message: formatAndroidUpdateMessage(result),
        okLabel: '下载更新',
        cancelLabel: '稍后提醒'
      });
      if (accepted) await appUpdateService.openDownload();
      else appUpdateService.snoozeAutomaticPrompt(result);
    } finally { this._appUpdatePromptOpen = false; }
    return result;
  }

  _refreshProfileUpdateIndicator(result = appUpdateService.getLastResult()) {
    const available = result?.updateAvailable === true;
    const profileButton = document.getElementById('btn-profile');
    if (isNativeAndroidApp() && profileButton) {
      profileButton.dataset.updateAvailable = String(available);
      profileButton.title = available ? '个人中心 · 发现新版本' : '个人中心';
    }
    const root = this._profileModal?.shadowRoot;
    if (!root) return;
    const dot = root.querySelector('#pf-app-update-dot');
    if (dot) dot.hidden = !available;
    const status = root.querySelector('#pf-app-update-status');
    if (status) {
      status.textContent = available
        ? `发现新版本 ${result.latestVersion}`
        : `当前版本 ${ANDROID_APP_VERSION}`;
    }
  }

  _scheduleMultiplayerRestore() {
    if (!usesProjectServerFeatures() || !isMultiplayerEntryVisible()) return false;
    setTimeout(() => {
      void (async () => {
        // Account-specific resume keys can only be selected after auth resolves.
        if (!await authClient.checkAuth()) return;
        const roomId = readRememberedMultiplayerRoomId();
        if (!roomId) return;
        await eventBus.request('app:open-multiplayer', { roomId, autoRestore: true });
      })().catch(error => console.warn('[Multiplayer] Automatic room reconnect failed:', error.message));
    }, 0);
    return true;
  }

  _bindEvents() {
    eventBus.on('auth:cloud-ready', () => { void this._resumeNativeCloudSync().catch(error => console.warn('[CloudSave] 本地已保存，恢复同步待重试:', error.message)); });
    eventBus.on('auth:changed', () => {
      if (isNativeAndroidApp()) this._multiplayerOverlay?.panel?.controller?.disconnect({ reset: true });
      this._clearCloudSyncContext();
      void this._refreshCloudSyncContext().catch(error => console.warn('[CloudSave] 账号同步状态更新失败:', error.message));
      if (isNativeAndroidApp()) void this._resumeNativeCloudSync().catch(error => console.warn('[CloudSave] 本地已保存，恢复同步待重试:', error.message));
    });
    eventBus.on('timeline:node-created', node => this._markPersistedCloudLocal(node?.id));
    eventBus.on('pipeline:complete', result => {
      if (result?.isPartial || result?.timelineError || !result?.timelineNodeId) return;
      return this._syncCommittedCloudSave(result.timelineNodeId);
    });
    eventBus.on('timeline:imported', () => {
      if (this._saveTransition) return;
      this._clearCloudSyncContext();
      return this._refreshCloudSyncContext({ resetBinding: true });
    });
    eventBus.on('memory:correction-requested', request => this._personalSaveOperation(async () => {
      const node = await timelineSystem.commitMemoryCorrection(request);
      const history = await timelineSystem._reconstructChatHistory(node);
      this.pipeline?.setHistory(history);
      appShell.restoreChatHistory(history, node.clean_response || node.ai_response_summary || '记忆已修订。', { timelineNodeId: node.id });
      eventBus.emit('app:toast', '记忆修订已保存；原时间线节点仍可读取。');
      return node;
    }));
    eventBus.on('memory:source-requested', async ({ nodeId } = {}) => {
      const raw = nodeId ? await stateManager.dbGet('timeline_nodes', nodeId) : null;
      const node = raw ? await timelineSystem._hydrateNode(raw) : null;
      if (!node) throw new Error('此来源节点未包含在当前存档中；精简续玩档可能未保留旧正文。');
      const content = document.createElement('div');
      content.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8;max-height:60vh;overflow:auto';
      content.textContent = node.clean_response || node.ai_response_summary || '此节点没有保留正文。';
      const modal = document.createElement('game-modal');
      (document.getElementById('app') || document.body).appendChild(modal);
      modal.show({ title: `记忆来源 · 第 ${node.turn_number} 回合`, content: '<div data-memory-source></div>',
        buttons: [{ label: '关闭', onClick: () => modal.close() }] });
      modal.shadowRoot.querySelector('[data-memory-source]').appendChild(content);
      return { nodeId: node.id };
    });
    eventBus.on('app:open-saves', async (options = {}) => {
      await this._refreshCloudSyncContext();
      // Capture the legacy working timeline on first use, without replacing it.
      let migrationError = null;
      if (!this.pipeline?.isProcessing && !this._saveTransition && !this._multiplayerOverlay?.panel?.controller?.state?.roomId) {
        try { await this._personalSaveOperation(() => personalSaveLibrary.capture({ reason: 'library-open' })); }
        catch (error) { migrationError = error; }
      }
      const modal = await openSaveLibrary(options);
      if (migrationError) eventBus.emit('app:toast', `当前个人档未备份：${migrationError.message}`);
      return modal;
    });
    eventBus.on('app:save-personal', () => this._personalSaveOperation(() => personalSaveLibrary.capture()));
    eventBus.on('app:create-continuation-save', (options = {}) => this._personalSaveOperation(() => personalSaveLibrary.createContinuation(options)));
    eventBus.on('app:load-personal-save', ({ id }) => this._personalSaveOperation(async () => {
      this._clearCloudSyncContext();
      let node;
      try { node = await personalSaveLibrary.load(id); }
      catch (error) { await this._refreshCloudSyncContext(); throw error; }
      await this._refreshCloudSyncContext({ resetBinding: true, source: saveLibraryCloud.getSource(id) });
      const history = await timelineSystem._reconstructChatHistory(node);
      this.pipeline?.setHistory(history);
      appShell.showGame();
      appShell.restoreChatHistory(history, node?.clean_response || node?.ai_response_summary || '存档已读取。', { timelineNodeId: node?.id });
      eventBus.emit('app:toast', '已读取个人存档；切换前的进度已保留在本地存档库。');
      return node;
    }));
    eventBus.on('app:new-personal-save', () => this._startNewPersonalSave());
    eventBus.on('app:if-line-action', options => this._manageIfLine(options));
    eventBus.on('app:api-config', async (config) => {
      await stateManager.saveAPIConfig(config);
      aiClient.configure(config);
      appShell.showCharacterCreator();
    });

    eventBus.on('app:timeline-import-file', async ({ file }) => {
      try {
        const data = await decodeTimelineSaveFile(file);
        if (data?.schema === SAVE_PACKAGE_SCHEMA && data.kind === ROOM_SAVE_KIND) {
          if (usesProjectServerFeatures()) await authClient.checkAuth();
          await localRoomHistory.importPackage(data);
          await openSaveLibrary({ kind: ROOM_SAVE_KIND });
        } else {
          const imported = await personalSaveLibrary.importData(data);
          saveLibraryCloud.forgetSource(imported.id);
          await eventBus.request('app:open-saves');
        }
        eventBus.emit('app:toast', '存档已加入本地存档库，选择“读取”即可继续；当前进度没有被覆盖。');
      } catch (error) {
        this._sendSystemMessage(`导入失败: ${error.message}`);
      }
    });

    eventBus.on('character:created', async (payload = {}) => {
      appShell.showGame();
      this._sendSystemMessage('角色创建完成！正在生成开场剧情...');

      try {
        const state = stateManager.get();
        const contract = state._opening_contract || payload.contract || resolveOpeningContract(state);
        const apiCfg = stateManager.getAPIConfig() || {};
        const updaterEnabled = resolveAICallPolicy({ apiConfig: apiCfg }).features.variableUpdater;
        const startPrompt = buildOpeningPrompt({ state, contract, updaterEnabled });
        this._pendingStartPrompt = startPrompt;
        await this.pipeline.process(startPrompt);
        this._pendingStartPrompt = null;
      } catch (error) {
        this._showStartupErrorModal(error);
      }
    });

    eventBus.on('user:submit', ({ text, accept }) => this._handleUserInput(text, accept));
    eventBus.on('user:input', (text) => this._handleUserInput(text));

    eventBus.on('combat:player-action', ({ action }) => this._submitCombatAction(action));
    eventBus.on('combat:select-action', ({ moveId, message } = {}) => {
      const state = stateManager.get();
      if (this.pipeline?.isProcessing || !state._combat?.is_active) return;
      const move = listTacticalMoves(state).find(candidate => candidate.id === moveId);
      this._selectedCombatAction = move
        ? { moveId: move.id, name: move.name, sourceFingerprint: tacticalSourceFingerprint(state) } : null;
      const input = appShell.element?.querySelector('#chat-input');
      if (input && move) {
        input.value = message || `我使用${move.name}。`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
      }
    });
    eventBus.on('combat:submit-action', async ({ moveId, message } = {}) => {
      const state = stateManager.get();
      const move = listTacticalMoves(state).find(candidate => candidate.id === moveId);
      if (!state._combat?.is_active || !move || this.pipeline?.isProcessing) return;
      this._selectedCombatAction = { moveId, name: move.name, sourceFingerprint: tacticalSourceFingerprint(state) };
      const input = appShell.element?.querySelector('#chat-input');
      if (input) {
        // Submit the same draft as the main send button, including any tactics
        // the player added or changed after selecting a card.
        if (!input.value.trim()) input.value = message || `我使用${move.name}。`;
        await appShell._sendMessage();
      } else {
        await this._handleUserInput(message || `我使用${move.name}。`);
      }
    });
    eventBus.on('app:execute-combat-action', ({ action }) => this._submitCombatAction(action));
    eventBus.on('app:execute-player-action', ({ text }) => this._submitPlayerAction(text));

    eventBus.on('pipeline:cancel', () => {
      this.pipeline?.cancel();
    });

    const syncPersistedImage = () => {
      if (!usesProjectServerFeatures()) return;
      if (localStorage.getItem('naruto_auto_cloud_sync') !== 'true') return;
      const scope = this._cloudSyncScope;
      const epoch = this._cloudContextEpoch;
      clearTimeout(this._imageCloudSyncTimer);
      this._imageCloudSyncTimer = setTimeout(() => {
        if (epoch !== this._cloudContextEpoch) return;
        void this._syncCloudSaveAfterImage(scope).catch(error => {
          console.warn('[CloudSave] 图片绑定后的二次同步失败:', error.message);
        });
      }, 800);
    };
    eventBus.on('timeline:media-changed', syncPersistedImage);
    eventBus.on('timeline:image-state-synced', syncPersistedImage);

    eventBus.on('timeline:reroll-request', async ({ nodeId }) => {
      try {
        const node = await stateManager.dbGet('timeline_nodes', nodeId);
        if (!node) return;
        if (!node.parent_id) {
          this._sendSystemMessage('初始节点无法快速重推衍，如需重新开局请点击底部重置按钮。');
          return;
        }
        if (!node.player_input) {
          this._sendSystemMessage('该节点缺少玩家输入，无法重推衍。');
          return;
        }

        const choice = await this._showRerollChoice();
        if (choice === 'cancel') return;

        const mode = choice === 'prune' ? 'replace' : 'branch';
        const prepared = await timelineSystem.prepareReroll(nodeId, { mode });
        this.pipeline?.setHistory(prepared.history);

        const actionLabel = mode === 'replace' ? '重新推衍' : '平行重推衍';
        this._sendSystemMessage(`正在${actionLabel}：${prepared.playerInput}`);
        await this.pipeline.process(prepared.playerInput);
      } catch (error) {
        console.error('[App] Reroll failed:', error);
        this._sendSystemMessage(`重推衍失败: ${error.message}`);
      }
    });

    eventBus.on('timeline:jump-request', async ({ nodeId }) => {
      const allNodes = await stateManager.dbGetAll('timeline_nodes') || [];
      const countDescendants = (nid) => {
        let count = 0;
        const node = allNodes.find(n => n.id === nid);
        if (node && Array.isArray(node.children_ids)) {
          for (const childId of node.children_ids) {
            count += 1 + countDescendants(childId);
          }
        }
        return count;
      };
      const prunedCount = countDescendants(nodeId);

      let warningMessage = '逆转时间将永久删除此节点之后的所有回合，该操作无法撤销。确定继续？';
      if (prunedCount > 0) {
        const turnLabel = prunedCount === 1 ? '个回合' : '个回合';
        warningMessage = `逆转时间至此将永久删除后续 ${prunedCount} ${turnLabel}的记录。此操作不可撤销，被删除的内容无法恢复。确定继续？`;
      }

      const confirmed = await customElements.get('game-modal').confirm({
        title: '⚠ 逆转时间 · 不可撤销',
        message: warningMessage,
        okLabel: '确认删除',
        cancelLabel: '取消'
      });
      if (confirmed) {
        try {
          const result = await timelineSystem.pruneForward(nodeId);
          const node = await timelineSystem.getCurrentNode();
          const history = await timelineSystem._reconstructChatHistory(node);
          this.pipeline?.setHistory(history);
          const pruned = result?.pruned || 0;
          appShell.renderSinglePage(node?.clean_response || node?.ai_response_summary || '时间线已逆转，后续记录已被清除。', { timelineNodeId: node?.id });
          this._sendSystemMessage(pruned > 0
            ? `时间线已逆转。已删除 ${pruned} 个后续回合，当前回合计为终末。`
            : '已回到当前回合。');
        } catch (error) {
          this._sendSystemMessage(`逆转失败: ${error.message}`);
        }
      }
    });

    eventBus.on('timeline:view-node', async ({ node }) => {
      if (!node?.id) return;
      try {
        await timelineSystem.jumpToNode(node.id);
        const current = await timelineSystem.getCurrentNode();
        const history = await timelineSystem._reconstructChatHistory(current);
        this.pipeline?.setHistory(history);
        appShell.renderSinglePage(
          current?.clean_response || current?.ai_response_summary || '此处记忆残缺...',
          { timelineNodeId: current?.id }
        );
      } catch (err) {
        this._sendSystemMessage(err.message);
      }
    });

    eventBus.on('timeline:export-request', async ({ compression = 'auto' } = {}) => {
      try {
        const result = await timelineSystem.exportTimeline({ compression });
        if (result.cancelled) { this._sendSystemMessage('已取消导出，原存档仍保留。'); return; }
        this._sendSystemMessage(result.fallbackReason
          ? `浏览器未能创建 gzip，已改为导出普通 JSON：${result.fallbackReason}`
          : `本地存档已导出（${result.format === 'gzip' ? 'gzip 压缩' : '普通 JSON'}）。`);
      } catch (e) {
        this._sendSystemMessage(`导出失败: ${e.message}`);
      }
    });

    eventBus.on('game:restart', async () => {
      try { await this._startNewPersonalSave(); }
      catch (error) { this._sendSystemMessage(`未开始新档：${error.message}`); }
    });

    eventBus.on('app:reset', async () => {
      try {
        await this._startNewPersonalSave();
      } catch (err) {
        window.location.reload();
      }
    });

    eventBus.on('timeline:delete-branch', async ({ branchId }) => {
      try {
        await this._manageIfLine({ action: 'delete', branchId });
      } catch(e) {
        this._sendSystemMessage('剪定失败: ' + e.message);
      }
    });

    eventBus.on('timeline:promote-branch', async ({ branchId }) => {
      try {
        await this._manageIfLine({ action: 'promote', branchId });
      } catch(e) {
        this._sendSystemMessage('收束失败: ' + e.message);
      }
    });

    eventBus.on('app:open-settings', (options = {}) => {
      const route = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
      return this._openSettings({
        mode: 'player',
        section: typeof route.section === 'string' && route.section ? route.section : 'appearance',
        anchor: typeof route.anchor === 'string' ? route.anchor : ''
      });
    });

    eventBus.on('app:open-multiplayer', async (options = {}) => {
      if (!usesProjectServerFeatures() || !isMultiplayerEntryVisible()) return null;
      const request = options && typeof options === 'object' ? options : {};
      // The staging site serves this shell through an Nginx auth_request
      // subrequest, whose Set-Cookie response is not forwarded to the browser.
      // Refresh the browser-facing session before mounting multiplayer so an
      // existing login also receives the double-submit CSRF cookie.
      const user = await authClient.checkAuth(true);
      if (!user) {
        if (isNativeAndroidApp()) {
          eventBus.emit('app:toast', '联机需要连接云端账号；本地进度仍保留。');
          await eventBus.request('app:open-profile', { loadRemote: false });
          return null;
        }
        window.location.href = '/login.html';
        return null;
      }
      const currentRoomId = this._multiplayerOverlay?.panel?.controller?.state?.roomId;
      if (request.roomId && currentRoomId && currentRoomId !== request.roomId) {
        const exited = await this._multiplayerOverlay.exit();
        if (!exited) throw new Error('尚未退出当前房间，已取消切换');
      }
      await this._personalResumeAfterExit;
      if (this._multiplayerOverlay?.element?.isConnected) this._multiplayerOverlay.show();
      else {
        this._multiplayerOverlay = openMultiplayerOverlay({
          host: document.getElementById('app') || document.body,
          onStateChange: (state, panel) => this._handleMultiplayerState(state, panel),
          onClose: ({ forgetSession = false, savedRoom = false } = {}) => {
            if (forgetSession) {
              forgetRememberedMultiplayerSession();
              eventBus.emit('app:toast', savedRoom ? '房间已保存到本机历史，已退出联机。' : '已退出联机；可在本机房间历史重新进入。');
            }
            this._multiplayerOverlay = null;
            this._multiplayerActiveRoomId = null;
            this._multiplayerRenderedCommit = null;
            appShell.setMultiplayerSessionState(null);
            if (forgetSession) this._personalResumeAfterExit = this._checkSavedGame()
              .catch(error => this._sendSystemMessage(`个人进度恢复失败：${error.message}`));
          }
        });
      }
      const roomId = request.roomId ?? readRememberedMultiplayerRoomId();
      const panel = this._multiplayerOverlay.panel;
      if (roomId && panel.controller?.state?.roomId !== roomId) {
        try {
          await panel.connectRoom(roomId);
          const invite = readRememberedMultiplayerInvite(roomId);
          const members = panel.controller?.state?.room?.members ?? [];
          if (invite && members.length < 2) panel.controller.store.patch({ invite });
          else if (members.length >= 2) forgetRememberedMultiplayerInvite();
        } catch (error) {
          panel.prefillRoomId?.(roomId);
          if (request.autoRestore) {
            eventBus.emit('app:toast', '自动重连未成功，房间号已为你保留，可点击恢复');
          }
          if (request.roomId && !request.autoRestore) throw error;
        }
      }
      return this._multiplayerOverlay;
    });

    eventBus.on('app:open-creator-workbench', (options = {}) => {
      const route = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
      return this._openSettings({
        mode: 'creator',
        tool: typeof route.tool === 'string' ? route.tool : '',
        resourceId: typeof route.resourceId === 'string' ? route.resourceId : ''
      });
    });

    eventBus.on('app:music-state', () => {
      return musicPlayback.getState();
    });

    eventBus.on('app:music-open', (options = {}) => {
      const payload = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
      return openMusicWithFloatingPlayer(payload, { playback: musicPlayback });
    });

    eventBus.on('app:music-control', ({ action } = {}) => {
      return controlMusicWithFloatingPlayer(action, { playback: musicPlayback });
    });

    eventBus.on('app:open-profile', (options = {}) => this._openProfilePanel({
      loadRemote: usesProjectServerFeatures() && options?.loadRemote !== false
    }));

    eventBus.on('app:open-info-panel', (options = {}) => {
      const tab = options && typeof options.tab === 'string' ? options.tab : 'attributes';
      return appShell.openInfoPanel(tab);
    });

    eventBus.on('app:open-timeline', () => appShell.openTimeline());

    eventBus.on('app:open-map', () => appShell.openMap());

    eventBus.on('app:execute-timeline-action', options => this._executeTimelineAction(options));

    eventBus.on('app:open-api-settings', () => this._openSettings({ mode: 'player', section: 'connection' }));
  }

  _handleMultiplayerState(state) {
    if (!state?.roomId) return;
    const room = state.room;
    if (room?.room_id) rememberMultiplayerRoomId(room.room_id);
    if (state.invite?.token) rememberMultiplayerInvite(state.invite);
    if ((room?.members?.length ?? 0) >= 2) forgetRememberedMultiplayerInvite();
    const notice = [...(state.notices ?? [])].reverse().find(item => (
      item.event_type === 'member.presence_changed'
      && item.event_seq > this._multiplayerNoticeSeq
    ));
    if (notice) {
      this._multiplayerNoticeSeq = notice.event_seq;
      const seat = notice.payload?.member_seat ?? notice.payload?.seat ?? '—';
      eventBus.emit('app:toast', notice.payload?.ready === true
        ? `玩家 ${seat} 已确认开局`
        : `玩家 ${seat} 已加入联机房间`);
    }
    if (room?.lifecycle !== 'ACTIVE') {
      appShell.setMultiplayerSessionState(null);
      return;
    }
    if (this._multiplayerActiveRoomId !== room.room_id) {
      this._multiplayerActiveRoomId = room.room_id;
      this._multiplayerRenderedCommit = null;
      const openingPending = isProjectedOpeningTurn(state)
        || (room.origin_type === 'new_multiplayer_save' && room.state_revision === 0);
      appShell.renderSinglePage(openingPending
        ? [
            '双方开局已确认。',
            '',
            '正在根据双方填写的角色、地点、目标与开场钩子生成第一回合……',
            '角色、世界、资源、地图、时间与记忆变量将由服务端一并初始化。'
          ].join('\n')
        : '双人联机已连接。请在下方主输入框提交本回合行动。');
    }
    appShell.setMultiplayerSessionState(state);
    const publication = state.latestCommittedTurn ?? state.turn;
    const deliveries = projectedNarrativeDeliveries(publication);
    const commitId = publication?.commit?.checkpoint?.commit_id
      ?? publication?.commit?.checkpoint?.checkpoint_id
      ?? publication?.checkpoint_id
      ?? null;
    if (commitId && deliveries.length > 0 && commitId !== this._multiplayerRenderedCommit) {
      this._multiplayerRenderedCommit = commitId;
      appShell.renderMultiplayerPublication(publication);
      appShell.setMultiplayerSessionState(state);
    }
  }

  async _handleUserInput(text, accept = null) {
    if (this._saveTransition) { this._sendSystemMessage('正在保存或切换个人存档，请稍候。'); return false; }
    const multiplayerPanel = this._multiplayerOverlay?.panel;
    const multiplayer = multiplayerPanel?.controller;
    if (multiplayer?.state?.room?.lifecycle === 'ACTIVE') {
      if (!canSubmitProjectedAction(multiplayer.state)) {
        this._sendSystemMessage(actionSubmissionUnavailableMessage(multiplayer.state));
        return false;
      }
      const options = multiplayerPanel.actionOptions;
      await multiplayer.lockAction({
        text,
        visibility: options.visibility,
        narrationPreference: options.narrationPreference
      });
      accept?.();
      appShell.setMultiplayerSessionState(multiplayer.state);
      eventBus.emit('app:toast', '联机行动已发送，提交后不可单方修改');
      return true;
    }
    if (!this.pipeline || !aiClient.isConfigured()) {
      this._sendSystemMessage('请先配置 API 连接。');
      return false;
    }
    if (this.pipeline.isProcessing) {
      this._sendSystemMessage('上一道结印尚未完成，请稍候。');
      return false;
    }

    const currentId = stateManager.get()['_meta']?.current_node_id;
    if (currentId) {
      const currentNode = await stateManager.dbGet('timeline_nodes', currentId);
      if (currentNode && Array.isArray(currentNode.children_ids) && currentNode.children_ids.length > 0) {
        const choice = await this._showBranchChoice();
        if (choice === 'branch') {
          timelineSystem._pendingBranchFrom = currentId;
        } else if (choice === 'prune') {
          await timelineSystem.pruneForward(currentId);
          const node = await timelineSystem.getCurrentNode();
          const history = await timelineSystem._reconstructChatHistory(node);
          this.pipeline?.setHistory(history);
          appShell.renderSinglePage(node?.clean_response || node?.ai_response_summary || '时间线已逆转。', { timelineNodeId: node?.id });
        } else {
          return false;
        }
      }
    }

    accept?.();
    try {
      if (this._pendingStartPrompt) {
        this._sendSystemMessage('正在重试生成开场剧情...');
        await this.pipeline.process(this._pendingStartPrompt);
        this._pendingStartPrompt = null;
      } else {
        const selected = this._selectedCombatAction;
        const options = selected?.sourceFingerprint === tacticalSourceFingerprint(stateManager.get())
          && inferTacticalMoveId(stateManager.get(), text) === selected.moveId
          ? { combatMoveId: selected.moveId } : {};
        const result = await this.pipeline.process(text, options);
        if (result?.cancelled || result?.partialResponse) return false;
        this._selectedCombatAction = null;
      }

    } catch (error) {
      if (this._pendingStartPrompt) this._showStartupErrorModal(error);
      else console.error('[App] Pipeline process failed:', error);
      return false;
    }
    return true;
  }

  _clearCloudSyncContext() {
    this._cloudContextEpoch = (this._cloudContextEpoch || 0) + 1;
    clearTimeout(this._imageCloudSyncTimer);
    this._cloudSyncScope = { userId: String(authClient.getUser()?.id || ''), saveKey: '' };
    cloudSave.setSyncContext(this._cloudSyncScope);
  }

  async _refreshCloudSyncContext({ resetBinding = false, source = null } = {}) {
    const user = isNativeAndroidApp() ? authClient.getUser() : usesProjectServerFeatures() ? await authClient.checkAuth() : null;
    const epoch = this._cloudContextEpoch || 0;
    const meta = await stateManager.dbGet('timeline_meta', 'root');
    if (epoch !== (this._cloudContextEpoch || 0)) return null;
    const scope = { userId: String(user?.id || ''), saveKey: String(meta?.value?.root_id || '') };
    this._cloudSyncScope = scope;
    cloudSave.setSyncContext(scope);
    if (resetBinding && scope.saveKey) {
      cloudSave.bindSyncSave({ ...scope, ...(source?.userId === scope.userId ? source : {}) });
    }
    return scope;
  }

  async _markPersistedCloudLocal(nodeId) {
    if (!nodeId || this._multiplayerOverlay?.panel?.controller?.state?.roomId) return null;
    const epoch = this._cloudContextEpoch || 0;
    const scope = await this._refreshCloudSyncContext();
    if (!scope?.saveKey) return null;
    const node = await stateManager.dbGet('timeline_nodes', nodeId);
    const meta = await stateManager.dbGet('timeline_meta', 'root');
    if (epoch !== (this._cloudContextEpoch || 0) || !node || meta?.value?.root_id !== scope.saveKey || meta?.value?.current_id !== nodeId) return null;
    cloudSave.markLocalSaved(scope);
    return scope;
  }

  async _syncCommittedCloudSave(nodeId) {
    const scope = await this._markPersistedCloudLocal(nodeId);
    if (!scope?.userId || !usesProjectServerFeatures() || localStorage.getItem('naruto_auto_cloud_sync') !== 'true') return;
    try { await this._queueCloudSave(scope); }
    catch (error) { console.warn('[CloudSave] 本地回合已保存，云端同步未完成:', error.message); }
  }

  async _syncCloudSaveAfterImage(scope = this._cloudSyncScope) {
    if (!usesProjectServerFeatures()) return null;
    if (!scope?.saveKey) return null;
    cloudSave.markLocalSaved(scope);
    return this._queueCloudSave(scope);
  }

  async _queueCloudSave(scope = null) {
    if (this._multiplayerOverlay?.panel?.controller?.state?.roomId) throw new Error('联机房间请使用房间本地存档；云端快捷备份只保存个人档');
    if (!cloudConnectionEnabled()) throw new Error('云端连接已暂停，本地进度已保存');
    scope ||= await this._refreshCloudSyncContext();
    if (!scope?.userId || !scope.saveKey) throw new Error('请先登录并保存当前个人进度');
    return cloudSave.scheduleQuickSave('默认云存档', async () => {
      const data = await timelineSystem.getExportData({ includeArchive: true });
      if (data.meta?.value?.root_id !== scope.saveKey) throw new Error('当前个人存档已切换，已取消旧存档的云端同步');
      const current = data.nodes.find(node => node.id === data.meta?.value?.current_id);
      const state = current?.state_snapshot || {};
      const continuation = continuationSaveScope(data);
      return {
        saveData: data,
        previewData: {
          name: state.player?.name || state['玩家·姓名'] || '未知',
          location: state.world_state?.current_location || state['世界·地点'] || '未知',
          time: Date.now(),
          turn: current?.turn_number ?? 0,
          branch_count: data.branches.filter(branch => branch.id !== 'branch_main').length,
          branch_name: data.branches.find(branch => branch.id === data.meta?.value?.active_branch)?.name || '主线',
          ...(continuation ? { continuation: { from_turn: continuation.from_turn, through_turn: continuation.through_turn } } : {})
        }
      };
    }, scope);
  }

  async _checkSavedGame() {
    await this._refreshCloudSyncContext();
    const meta = await stateManager.dbGet('timeline_meta', 'root');
    if (meta?.value?.current_id) {
      const currentNode = await timelineSystem.getCurrentNode()
        || await timelineSystem._hydratePersistedNode(meta.value.current_id);
      if (currentNode) {
        try {
          if (currentNode.state_snapshot) {
            stateManager.commitPreparedRestore(timelineSystem._prepareNodeRestore(currentNode));
          } else {
            await timelineSystem._replayStateFromAncestor(currentNode);
          }
          const history = await timelineSystem._reconstructChatHistory(currentNode);
          this.pipeline?.setHistory(history);
          const metaObj = stateManager.getSub('_meta');
          metaObj.current_node_id = meta.value.current_id;
          stateManager.setSub('_meta', metaObj);
          appShell.showGame();
          if (currentNode.clean_response) {
            appShell.renderSinglePage(currentNode.clean_response, { timelineNodeId: currentNode.id });
          }
          this._sendSystemMessage('欢迎回来！已恢复上次冒险。');
          return;
        } catch (err) {
          console.error('[NarutoRPG] Restore saved game failed:', err);
          // 恢复过程出错，但仍然显示游戏界面，让用户能看到存档内容
          // 而不是悄无声息地回退到角色创建界面
          appShell.showGame();
          appShell.renderSinglePage(currentNode.clean_response || currentNode.ai_response_summary || '存档数据存在但恢复过程遇到问题。\n\n请尝试：\n1. 刷新页面重试\n2. 从时间线中选择其他节点\n3. 导出存档后重新导入', { timelineNodeId: currentNode.id });
          this._sendSystemMessage(`存档恢复异常: ${err.message}。部分状态可能未能完全恢复，建议检查角色面板。`);
          const metaObj = stateManager.getSub('_meta');
          metaObj.current_node_id = meta.value.current_id;
          stateManager.setSub('_meta', metaObj);
          return;
        }
      } else {
        console.warn('[NarutoRPG] Save game node not found in timeline_nodes.');
        // 元数据存在但节点丢失：尝试查找任意可用的节点
        const allNodes = await stateManager.dbGetAll('timeline_nodes');
        if (allNodes && allNodes.length > 0) {
          console.log('[NarutoRPG] Attempting recovery using fallback node...');
          const fallbackRaw = allNodes.sort((a, b) => (b.turn_number || 0) - (a.turn_number || 0))[0];
          try {
            const fallbackNode = await timelineSystem._hydratePersistedNode(fallbackRaw.id) || fallbackRaw;
            if (!fallbackNode.state_snapshot) throw new Error('备用节点缺少完整状态快照');
            stateManager.commitPreparedRestore(timelineSystem._prepareNodeRestore(fallbackNode));
            const history = await timelineSystem._reconstructChatHistory(fallbackNode);
            this.pipeline?.setHistory(history);
            const mObj = stateManager.getSub('_meta');
            mObj.current_node_id = fallbackNode.id;
            stateManager.setSub('_meta', mObj);
            // 更新 meta 以指向这个恢复节点
            meta.value.current_id = fallbackNode.id;
            await stateManager.dbPut('timeline_meta', meta);
            appShell.showGame();
            appShell.renderSinglePage(fallbackNode.clean_response || fallbackNode.ai_response_summary || '已恢复到最近的存档节点。', { timelineNodeId: fallbackNode.id });
            this._sendSystemMessage('元数据丢失，已自动恢复到最近的存档节点。');
            return;
          } catch (e) {
            console.error('[NarutoRPG] Fallback recovery also failed:', e.message);
          }
        }
      }
    } else {
      console.log('[NarutoRPG] No saved game metadata found.');
    }
    console.log('[NarutoRPG] Showing character creator.');
    appShell.showCharacterCreator();
  }

  _sendSystemMessage(text) {
    appShell.addSystemMessage?.(text);
  }

  async _checkRuntimeBuild() {
    try {
      const result = await inspectRuntimeBuild();
      globalThis.__NARUTO_BUILD_DIAGNOSTIC__ = result;
      console.info(`[Build] loaded=${result.loadedBuild || 'dev'} latest=${result.latestBuild || 'unknown'} stale=${result.stale}`);
      if (result.stale) showStaleBuildNotice(result);
    } catch (error) {
      console.warn('[Build] version.json check failed:', error.message);
    }
  }

  _registerServiceWorker() {
    if (isNativeAndroidApp() || !usesProjectServerFeatures()) return;
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;

    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloadStarted = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloadStarted) return;
      reloadStarted = true;
      console.log('[SW] New version activated, reloading...');
      window.location.reload();
    }, { once: true });

    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then((registration) => {
      registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
      return registration.update();
    }).catch((error) => {
      console.warn('[NarutoRPG] Service worker registration failed:', error.message);
    });
  }

  _showStartupErrorModal(error) {
    const Modal = customElements.get('game-modal');
    if (!Modal) return;
    const modal = new Modal();
    (document.getElementById('app') || document.body).appendChild(modal);
    modal.show({
      title: '结印失败',
      content: `
        <div style="padding: 16px 24px; color: var(--text-secondary); line-height: 1.8; font-size: 14px; text-align: center;">
          <div style="font-size: 32px; margin-bottom: 16px; opacity: 0.8; filter: grayscale(1);">🥀</div>
          <div style="color: var(--c-kokihi); font-family: var(--font-title); letter-spacing: 2px; margin-bottom: 12px; font-size: 16px;">开场剧情生成失败</div>
          <div style="background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px; border: 1px dashed rgba(255,255,255,0.08); font-family: monospace; font-size: 12px; margin-bottom: 24px; color: var(--text-tertiary); word-break: break-all;">${String(error?.message || error).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
          <div style="color: var(--text-primary);">请检查 API 节点是否连通，或模型配置是否正确。</div>
        </div>
      `,
      buttons: [
        {
          label: '⚙️ 调整阵眼 (API设置)',
          primary: false,
          close: true,
          onClick: () => {
            setTimeout(() => this._openApiSettings(), 100);
          }
        },
        {
          label: '🗡️ 再次结印 (重试)',
          primary: true,
          close: true,
          onClick: () => {
            setTimeout(() => eventBus.emit('user:input', '重试结印'), 100);
          }
        },
        {
          label: '↻ 轮回转生 (重新开始)',
          primary: false,
          close: true,
          onClick: () => window.location.reload()
        }
      ]
    });
  }

  _openProfilePanel({ loadRemote = true } = {}) {
    const Modal = customElements.get('game-modal');
    if (!Modal) return;
    if (this._profileModal?.isConnected) return this._profileModal;
    const nativeAndroid = isNativeAndroidApp();
    loadRemote = loadRemote && (!nativeAndroid || (Boolean(authClient.getUser()) && !authClient.getCloudError() && cloudConnectionEnabled()));
    const state = stateManager.get();
    const player = state.player || {};
    const attrs = state.attributes || {};
    const prog = state.progression || {};
    const world = state.world_state || {};
    const apiConfig = stateManager.getAPIConfig() || {};
    let autoSync = localStorage.getItem('naruto_auto_cloud_sync') === 'true';
    const knownAppUpdate = nativeAndroid && appUpdateService.hasKnownUpdate();

    // 四维百分比（纯展示计算）
    const pctOf = (cur, max) => {
      const c = Number(cur) || 0;
      const m = Number(max) || 0;
      return m > 0 ? Math.min(100, Math.round((c / m) * 100)) : 0;
    };
    const chakraPct = pctOf(attrs.chakra_current, attrs.chakra);
    const vitalityPct = pctOf(attrs.vitality_current, attrs.vitality);
    const staminaPct = pctOf(attrs.stamina_current, attrs.stamina);
    const spiritPct = pctOf(attrs.spirit_current, attrs.spirit);

    const modal = new Modal();
    this._profileModal = modal;
    (document.getElementById('app') || document.body).appendChild(modal);
    modal.show({
      title: '个人中心 · 忍道卷轴',
      content: `
        <style>
          /* ── 忍道卷轴 · 作用域样式（Shadow DOM 内生效；全部 token 化，随主题切换） ── */
          .pf { display: flex; flex-direction: column; gap: 22px; padding: 4px 0 2px; }
          .pf-sec { animation: pf-rise 0.45s cubic-bezier(0.16, 1, 0.3, 1) both; }
          @keyframes pf-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

          /* 节标题：金色小字 + 右侧渐隐线（面板 sec-title 语言） */
          .pf-sec-title {
            display: flex; align-items: center; gap: 12px; margin-bottom: 12px;
            font-size: 10px; font-weight: 700; letter-spacing: 4px;
            font-family: var(--font-title, serif); color: var(--c-kin);
          }
          .pf-sec-title::after {
            content: ''; flex: 1; height: 1px;
            background: linear-gradient(to right, rgba(var(--paper-rgb), 0.08), transparent);
          }

          /* ── 卷首 · 身份 ── */
          .pf-hero {
            text-align: center; padding: 22px 18px 18px; position: relative; overflow: hidden;
            background: radial-gradient(circle at 50% 0%, rgba(198,156,109,0.09), transparent 60%), rgba(var(--paper-rgb), 0.02);
            background: radial-gradient(circle at 50% 0%, color-mix(in srgb, var(--c-kin) 10%, transparent), transparent 60%), rgba(var(--paper-rgb), 0.02);
            border: 1px solid rgba(var(--paper-rgb), 0.06);
            border-radius: 14px;
          }
          .pf-hero::before {
            content: ''; position: absolute; top: 0; left: 10%; right: 10%; height: 1px;
            background: linear-gradient(to right, transparent, rgba(var(--paper-rgb), 0.15), transparent);
          }
          .pf-avatar-ring { position: relative; width: 72px; height: 72px; margin: 0 auto 14px; }
          .pf-avatar-ring::before {
            content: ''; position: absolute; inset: -4px; border-radius: 50%;
            background: conic-gradient(from 0deg,
              transparent 0%, var(--c-shuiro) 14%, transparent 30%,
              transparent 55%, var(--c-kin) 70%, transparent 86%);
            animation: pf-spin 8s linear infinite;
          }
          .pf-avatar-ring::after {
            content: ''; position: absolute; inset: -1px; border-radius: 50%;
            border: 1px solid rgba(var(--paper-rgb), 0.1); pointer-events: none;
          }
          @keyframes pf-spin { to { transform: rotate(360deg); } }
          .pf-avatar {
            position: absolute; inset: 2px; border-radius: 50%; overflow: hidden;
            background: rgba(var(--ink-deep-rgb), 0.85);
            display: flex; align-items: center; justify-content: center;
          }
          .pf-avatar-char { font-family: var(--font-brush, cursive); font-size: 28px; color: var(--c-shuiro); }
          .pf-avatar-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
          .pf-name {
            font-family: var(--font-brush, cursive); font-size: 26px; letter-spacing: 3px; line-height: 1.25;
            background: linear-gradient(90deg, var(--c-kin-bright) 0%, #fff 50%, var(--c-kin-bright) 100%);
            background-size: 200% auto;
            -webkit-background-clip: text; background-clip: text;
            color: transparent; -webkit-text-fill-color: transparent;
            animation: pf-shine 5s linear infinite;
          }
          @keyframes pf-shine { to { background-position: 200% center; } }
          .pf-rank { margin-top: 7px; font-size: 12px; color: var(--text-secondary); letter-spacing: 2px; font-family: var(--font-title, serif); }
          .pf-loc { margin-top: 5px; font-size: 11px; letter-spacing: 1px; color: rgba(198,156,109,0.7); color: color-mix(in srgb, var(--c-kin) 70%, transparent); }

          /* ── 卷身 · 四维 ── */
          .pf-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
          .pf-stat {
            position: relative; overflow: hidden; padding: 12px 14px;
            background: rgba(var(--paper-rgb), 0.02);
            border: 1px solid rgba(var(--paper-rgb), 0.06);
            border-radius: 10px;
            transition: background 0.2s ease;
          }
          .pf-stat::before {
            content: ''; position: absolute; top: 0; left: 10%; right: 10%; height: 1px;
            background: linear-gradient(to right, transparent, rgba(var(--paper-rgb), 0.12), transparent);
          }
          .pf-stat:hover { background: rgba(var(--paper-rgb), 0.045); }
          .pf-stat-label { font-size: 10px; letter-spacing: 2px; margin-bottom: 5px; font-family: var(--font-title, serif); }
          .pf-stat-val { font-family: var(--font-mono, monospace); font-size: 16px; font-weight: 700; color: var(--text-primary); }
          .pf-stat-bar { margin-top: 8px; height: 2px; border-radius: 1px; background: rgba(var(--paper-rgb), 0.08); overflow: hidden; }
          .pf-stat-fill { height: 100%; border-radius: 1px; position: relative; box-shadow: 0 0 6px currentColor; transition: width 0.6s ease; }
          .pf-stat-fill::after {
            content: ''; position: absolute; inset: 0; pointer-events: none;
            background: linear-gradient(90deg, transparent, rgba(255,255,255,0.4), transparent);
            background-size: 200% 100%; background-repeat: no-repeat;
            animation: pf-sheen 3.2s linear infinite;
          }
          @keyframes pf-sheen { from { background-position: 150% 0; } to { background-position: -150% 0; } }

          /* ── 卷尾 · 云存档与本地管理 ── */
          .pf-cloud {
            padding: 14px; border-radius: 10px;
            background: rgba(var(--paper-rgb), 0.02);
            border: 1px solid rgba(var(--paper-rgb), 0.05);
          }
          .pf-cloud-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
          .pf-cloud-title { font-size: 12px; font-weight: 600; letter-spacing: 1px; color: var(--text-primary); font-family: var(--font-title, serif); }
          .pf-sync { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 11px; color: var(--text-secondary); }
          .pf-sync input { accent-color: var(--c-shuiro); }
          .pf-meter-text { display: flex; justify-content: space-between; font-size: 10px; margin-bottom: 5px; color: var(--text-secondary); }
          .pf-meter { height: 5px; border-radius: 3px; background: rgba(var(--paper-rgb), 0.08); overflow: hidden; }
          .pf-meter-fill { width: 0%; height: 100%; border-radius: 3px; background: linear-gradient(90deg, var(--c-kin), var(--c-kin-bright)); transition: width 0.4s ease; }
          .pf-meter-warning { font-size: 10px; color: var(--c-quality-legendary); margin-top: 5px; display: none; }
          .pf-actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-top: 12px; }
          .pf-persona-list { display: grid; gap: 8px; }
          .pf-persona-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid rgba(var(--paper-rgb), 0.06); border-radius: 8px; background: rgba(var(--paper-rgb), 0.02); }
          .pf-persona-name { flex: 1; font-size: 13px; color: var(--c-ink, #e8e4d9); }
          .pf-persona-time { font-size: 11px; color: var(--c-ink, #a39f98); }
          .pf-persona-empty { color: var(--c-ink, #a39f98); font-size: 12px; padding: 6px 2px; }
          .pf-persona-hint { color: var(--c-ink, #a39f98); font-size: 11px; margin-top: 10px; }
          .pf-btn {
            padding: 7px 10px; font-size: 11px; border-radius: 6px; cursor: pointer; letter-spacing: 1px;
            border: 1px solid rgba(var(--paper-rgb), 0.12); background: rgba(var(--paper-rgb), 0.04);
            color: var(--text-primary); transition: all 0.15s ease; font-family: var(--font-title, serif);
            text-decoration: none; text-align: center;
          }
          .pf-btn:hover { border-color: rgba(var(--paper-rgb), 0.25); background: rgba(var(--paper-rgb), 0.08); }
          .pf-btn:disabled { opacity: 0.5; cursor: not-allowed; }
          .pf-btn-gold { border-color: rgba(198,156,109,0.35); background: rgba(198,156,109,0.12); color: var(--c-kin); }
          .pf-btn-gold:hover { border-color: rgba(198,156,109,0.6); background: rgba(198,156,109,0.18); }
          .pf-btn-danger { color: var(--c-quality-legendary); }
          .pf-btn-danger:hover { border-color: rgba(239,83,80,0.4); background: rgba(239,83,80,0.08); }
          .pf-divider { height: 1px; margin: 12px 0; background: rgba(var(--paper-rgb), 0.05); }
          .pf-local { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
          .pf-local-label { font-size: 10px; color: var(--text-tertiary); letter-spacing: 1px; }
          .pf-btn-sm { padding: 4px 10px; font-size: 10px; }
          .pf-local-right { margin-left: auto; display: flex; gap: 6px; }
          .pf-api-status { margin-top: 12px; font-size: 10px; color: var(--text-tertiary); display: flex; align-items: center; gap: 6px; letter-spacing: 0.5px; }
          .pf-dot { width: 6px; height: 6px; border-radius: 50%; background: rgba(var(--paper-rgb), 0.25); flex-shrink: 0; }
          .pf-dot.on { background: var(--c-moegi); box-shadow: 0 0 6px var(--c-moegi); }
          .pf-app-row { display: flex; align-items: center; gap: 10px; }
          .pf-app-row .pf-btn { flex: 1; }
          .pf-app-status { font-size: 10px; color: var(--text-tertiary); white-space: nowrap; }
          .pf-update-label { display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
          .pf-update-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--c-shuiro); box-shadow: 0 0 7px var(--c-shuiro); }
          .pf-update-dot[hidden], .pf-server-only[hidden] { display: none !important; }

          @media (prefers-reduced-motion: reduce), (max-width: 768px) {
            .pf-stat-fill::after, .pf-avatar-ring::before { animation: none; }
            .pf-name { animation: none; }
          }
        </style>

        <div class="pf">
          <!-- 卷首 · 身份 -->
          <section class="pf-hero pf-sec" style="animation-delay: 0ms;">
            <div class="pf-avatar-ring">
              <div class="pf-avatar" id="pf-avatar"><span class="pf-avatar-char">忍</span></div>
            </div>
            <div class="pf-name">${this._escAttr(player.name || '未创建角色')}</div>
            <div class="pf-rank">${this._escAttr(player.rank || '-')} · ${this._escAttr(player.official_rank || '-')}</div>
            <div class="pf-loc">${this._escAttr(world.current_location || '-')} · ${this._escAttr(world.calendar || '-')}</div>
          </section>

          <!-- 卷身 · 核心状态 -->
          <section class="pf-sec" style="animation-delay: 70ms;">
            <div class="pf-sec-title"><span>核心状态</span></div>
            <div class="pf-grid">
              <div class="pf-stat">
                <div class="pf-stat-label" style="color: var(--c-ruri);">查克拉</div>
                <div class="pf-stat-val">${attrs.chakra_current || 0}/${attrs.chakra || 0}</div>
                <div class="pf-stat-bar"><div class="pf-stat-fill" style="width: ${chakraPct}%; background: var(--c-ruri); color: var(--c-ruri);"></div></div>
              </div>
              <div class="pf-stat">
                <div class="pf-stat-label" style="color: #66BB6A;">生命力</div>
                <div class="pf-stat-val">${attrs.vitality_current || 0}/${attrs.vitality || 0}</div>
                <div class="pf-stat-bar"><div class="pf-stat-fill" style="width: ${vitalityPct}%; background: #66BB6A; color: #66BB6A;"></div></div>
              </div>
              <div class="pf-stat">
                <div class="pf-stat-label" style="color: var(--c-quality-legendary);">体力</div>
                <div class="pf-stat-val">${attrs.stamina_current || 0}/${attrs.stamina || 0}</div>
                <div class="pf-stat-bar"><div class="pf-stat-fill" style="width: ${staminaPct}%; background: var(--c-quality-legendary); color: var(--c-quality-legendary);"></div></div>
              </div>
              <div class="pf-stat">
                <div class="pf-stat-label" style="color: var(--c-spirit);">精神力</div>
                <div class="pf-stat-val">${attrs.spirit_current || 0}/${attrs.spirit || 0}</div>
                <div class="pf-stat-bar"><div class="pf-stat-fill" style="width: ${spiritPct}%; background: var(--c-spirit); color: var(--c-spirit);"></div></div>
              </div>
              <div class="pf-stat">
                <div class="pf-stat-label" style="color: var(--c-kin-bright);">金钱</div>
                <div class="pf-stat-val">${prog.ryo || state['进度·金钱'] || 0}両</div>
              </div>
            </div>
          </section>

          <!-- 卷尾 · 存档管理 -->
          <section class="pf-sec" style="animation-delay: 140ms;">
            <div class="pf-sec-title"><span>云存档与同步</span></div>
            ${nativeAndroid ? '<app-cloud-panel></app-cloud-panel>' : ''}
            <div class="pf-cloud">
              <div class="pf-cloud-head pf-server-only">
                <div class="pf-cloud-title">云端存档</div>
                <label class="pf-sync">
                  <input type="checkbox" id="cb-auto-sync" ${autoSync ? 'checked' : ''}>
                  <span>自动云同步</span>
                </label>
              </div>

              <div class="pf-server-only">
                <div class="pf-meter-text" id="cloud-size-text">
                  <span>本账号云存档</span>
                  <span>${loadRemote ? '加载中...' : '未自动连接'}</span>
                </div>
                <div class="pf-meter"><div class="pf-meter-fill" id="cloud-size-bar"></div></div>
                <div class="pf-meter-warning" id="cloud-size-warning">槽位已满，可在存档库中备份旧云档后删除，或选择覆盖已有槽位。</div>
              </div>

              <div class="pf-actions pf-server-only">
                <button class="pf-btn pf-btn-gold" id="btn-cloud-manage" type="button">管理云存档</button>
              </div>

              <div class="pf-divider pf-server-only"></div>

              <div class="pf-local">
                <span class="pf-local-label">游戏存档</span>
                <button class="pf-btn pf-btn-sm" id="btn-export-save" type="button">导出游戏存档</button>
                <button class="pf-btn pf-btn-sm" id="btn-import-cloud" type="button">导入游戏存档</button>
              </div>

              <div class="pf-api-status">
                <span class="pf-dot${apiConfig.model ? ' on' : ''}"></span>
                <span>${apiConfig.model ? '已连接 · ' + this._escAttr(apiConfig.model) : '未配置 API 连接'}</span>
              </div>
            </div>
          </section>

          <!-- Android 下载与 App 更新 -->
          <section class="pf-sec" style="animation-delay: 180ms;">
            <div class="pf-sec-title"><span>${nativeAndroid ? 'App 更新' : 'Android App'}</span></div>
            <div class="pf-cloud">
              ${nativeAndroid ? `
                <div class="pf-app-row">
                  <button class="pf-btn pf-btn-gold" id="btn-check-app-update" type="button">
                    <span class="pf-update-label">检测更新<span class="pf-update-dot" id="pf-app-update-dot" ${knownAppUpdate ? '' : 'hidden'}></span></span>
                  </button>
                  <span class="pf-app-status" id="pf-app-update-status">${knownAppUpdate ? '发现新版本' : `当前版本 ${ANDROID_APP_VERSION}`}</span>
                </div>
              ` : `
                <div class="pf-app-row">
                  <a class="pf-btn pf-btn-gold" href="${this._escAttr(ANDROID_APP_DOWNLOAD_URL)}" target="_blank" rel="noopener noreferrer">下载 Android App</a>
                </div>
              `}
            </div>
          </section>

          <!-- 人设方案 -->
          <section class="pf-sec" style="animation-delay: 220ms;">
            <div class="pf-sec-title"><span>人设方案</span></div>
            <div id="pf-persona-list" class="pf-persona-list">加载中...</div>
            <div class="pf-persona-hint">人设长期保存在本地；切换人设请在「编写你的忍者开局」向导中选择。</div>
          </section>
        </div>
      `,
      onDismiss: () => {
        if (this._profileModal === modal) this._profileModal = null;
      },
      buttons: [
        { label: '关闭', primary: true, close: true }
      ]
    });

    modal.shadowRoot?.querySelector('#btn-cloud-manage')?.addEventListener('click', async () => {
      modal.close();
      try { await eventBus.request('app:open-saves', { cloud: true }); }
      catch (error) { this._sendSystemMessage('打开云存档失败: ' + error.message); }
    });
    modal.addEventListener('cloud-local', () => modal.close());

    setTimeout(() => {
      // Discord 头像异步填充（加载失败自动回退为「忍」字印）
      if (loadRemote) {
        authClient.checkAuth().then(user => {
          const url = authClient.getAvatarUrl(user, 128);
          const av = modal.shadowRoot?.querySelector('#pf-avatar');
          if (url && av) {
            const img = document.createElement('img');
            img.className = 'pf-avatar-img';
            img.alt = '';
            img.decoding = 'async';
            img.onerror = () => img.remove();
            img.src = url;
            av.appendChild(img);
          }
        }).catch(() => {});
      }

      // Capacity is per account; the limit applies to each archive, not their total.
      if (loadRemote) Promise.all([cloudSave.listSaves(), cloudSave.getStorage()]).then(([saves, storage]) => {
        const root = modal.shadowRoot;
        if (!root) return;
        const bytes = storage?.used_uncompressed_bytes ?? saves.reduce((sum, save) => sum + (Number(save.size_bytes) || 0), 0);
        const used = storage?.used_slots ?? saves.length;
        const max = storage?.max_slots;
        const full = max != null && used >= max;
        const txt = root.querySelector('#cloud-size-text');
        if (txt) txt.children[1].textContent = `${used}${max != null ? ' / ' + max : ''} 个槽位 · ${(bytes / 1024 / 1024).toFixed(2)} MB`;
        const bar = root.querySelector('#cloud-size-bar');
        if (bar) bar.style.width = max ? `${Math.min(100, used / max * 100)}%` : '0%';
        const warn = root.querySelector('#cloud-size-warning');
        if (warn) warn.style.display = full ? 'block' : 'none';
      }).catch(() => {
        const txt = modal.shadowRoot?.querySelector('#cloud-size-text');
        if (txt) txt.children[1].textContent = '获取失败';
      });

      this._renderProfilePersonas(modal);

      modal.shadowRoot?.querySelector('#btn-check-app-update')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const status = modal.shadowRoot?.querySelector('#pf-app-update-status');
        if (button) button.disabled = true;
        if (status) status.textContent = '正在检测...';
        try {
          const result = await this._checkAppUpdate({ automatic: false });
          if (status && !result.updateAvailable) status.textContent = `当前版本 ${ANDROID_APP_VERSION}，已是最新版`;
        } catch (error) {
          if (status) status.textContent = '检测失败';
          this._sendSystemMessage(`检测更新失败: ${error.message}`);
        } finally {
          if (button) button.disabled = false;
        }
      });

      modal.shadowRoot?.querySelector('#cb-auto-sync')?.addEventListener('change', (e) => {
        localStorage.setItem('naruto_auto_cloud_sync', e.target.checked);
        if (e.target.checked) this._sendSystemMessage('已开启自动云同步，将在剧情推进时自动保存。');
        else this._sendSystemMessage('已关闭自动云同步。');
      });

      modal.shadowRoot?.querySelector('#btn-export-save')?.addEventListener('click', async () => {
        try {
          const result = await timelineSystem.exportTimeline();
          if (result.cancelled) { this._sendSystemMessage('已取消导出，原存档仍保留。'); return; }
          this._sendSystemMessage(result.fallbackReason
            ? `浏览器未能创建 gzip，已改为导出普通 JSON：${result.fallbackReason}`
            : '本地压缩存档已导出。');
        }
        catch(e) { this._sendSystemMessage('导出失败: ' + e.message); }
      });
      modal.shadowRoot?.querySelector('#btn-import-cloud')?.addEventListener('click', () => {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = TIMELINE_FILE_ACCEPT;
        fileInput.onchange = (e) => {
          const file = e.target.files?.[0];
          if (file) eventBus.emit('app:timeline-import-file', { file });
        };
        fileInput.click();
      });
    }, 150);
    return modal;
  }

  async _renderProfilePersonas(modal) {
    const root = modal?.shadowRoot;
    const listEl = root?.querySelector('#pf-persona-list');
    if (!listEl) return;
    const profiles = await listPersonaProfiles();
    if (!profiles.length) {
      listEl.innerHTML = '<div class="pf-persona-empty">还没有保存过的人设。在「编写你的忍者开局」向导中点击「保存当前人设」即可长期保存。</div>';
      return;
    }
    listEl.innerHTML = profiles.map(profile => `
      <div class="pf-persona-item">
        <span class="pf-persona-name">${this._escAttr(profile.name)}</span>
        <span class="pf-persona-time">${new Date(profile.savedAt).toLocaleString()}</span>
        <button class="pf-btn pf-btn-sm pf-btn-danger" type="button" data-persona-delete="${this._escAttr(profile.id)}">删除</button>
      </div>
    `).join('');
    listEl.querySelectorAll('[data-persona-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        await deletePersonaProfile(btn.dataset.personaDelete);
        this._renderProfilePersonas(modal);
      });
    });
  }

  _openSettings(options = {}) {
    const request = options && typeof options === 'object' && !Array.isArray(options)
      ? { ...options }
      : {};
    request.mode = request.mode === 'creator' ? 'creator' : 'player';

    const transition = this._settingsTransition.then(() => this._performSettingsTransition(request));
    this._settingsTransition = transition.catch(() => null);
    return transition;
  }

  async _performSettingsTransition(options) {
    const mode = options.mode;
    const mount = document.getElementById('app') || document.body;

    while (true) {
      const current = mount.querySelector('settings-panel');
      if (!current) break;

      const currentMode = current.getAttribute('mode') === 'creator' ? 'creator' : 'player';
      if (currentMode === mode) {
        current.open(options);
        return current;
      }

      const closed = await current.close();
      if (!closed) return null;
      if (current.isConnected) current.remove();
    }

    const panel = new SettingsPanel();
    if (mode === 'creator') panel.setAttribute('mode', 'creator');
    mount.appendChild(panel);
    panel.open(options);
    return panel;
  }

  _openDisplaySettings() {
    return this._openSettings({ mode: 'player', section: 'appearance' });
  }

  _applyDisplayConfig(config) {
    let style = document.getElementById('dynamic-display-colors');
    const dHex = config?.dialogueColor;
    const tHex = config?.thoughtColor;
    // 用户未自定义时：移除注入，回退到主题预设注入的 --chat-dialogue-color / --chat-thought-color
    if (!dHex && !tHex) {
      if (style) style.remove();
      return;
    }
    if (!config) return;
    if (!style) {
      style = document.createElement('style');
      style.id = 'dynamic-display-colors';
      document.head.appendChild(style);
    }
    const dVal = dHex || '#bae6fd';
    const tVal = tHex || '#c4b5fd';
    
    const hexToRgba = (hex, alpha) => {
      let c;
      if(/^#([A-Fa-f0-9]{3}){1,2}$/.test(hex)){
          c= hex.substring(1).split('');
          if(c.length== 3){
              c= [c[0], c[0], c[1], c[1], c[2], c[2]];
          }
          c= '0x'+c.join('');
          return 'rgba('+[(c>>16)&255, (c>>8)&255, c&255].join(',')+','+alpha+')';
      }
      return `rgba(255,255,255,${alpha})`;
    };

    style.textContent = `:root {
      --color-dialogue: ${dVal};
      --color-dialogue-shadow: ${hexToRgba(dVal, 0.3)};
      --color-thought: ${tVal};
      --color-thought-shadow: ${hexToRgba(tVal, 0.2)};
    }`;
  }

  _openApiSettings() {
    return this._openSettings({ mode: 'player', section: 'connection' });
  }

  _escAttr(value) {
    return escAttr(value);
  }

  async _personalSaveOperation(operation) {
    if (this._multiplayerOverlay?.panel?.controller?.state?.roomId) throw new Error('请先退出联机房间，再保存或切换个人档');
    if (this.pipeline?.isProcessing || this._saveTransition) throw new Error('正文正在生成或存档正在切换，请等待完成后再操作');
    this._saveTransition = true;
    try { return await operation(); } finally { this._saveTransition = false; }
  }

  async _startNewPersonalSave() {
    return this._personalSaveOperation(async () => {
      const confirmed = await customElements.get('game-modal').confirm({
        title: '保留旧档并开始新冒险',
        message: '当前完整时间线将先保存到本地存档库，再开始创建新角色。你可以随时读取旧档。',
        okLabel: '保存并开新档', cancelLabel: '取消'
      });
      if (!confirmed) return false;
      this._clearCloudSyncContext();
      try { await personalSaveLibrary.startNew(); }
      finally { await this._refreshCloudSyncContext(); }
      this.pipeline?.clearHistory();
      this._pendingStartPrompt = null;
      appShell.showCharacterCreator();
      eventBus.emit('app:toast', '旧进度已保留在本地存档库，可以开始新的冒险。');
      return true;
    });
  }

  async _manageIfLine({ action, branchId, fromNodeId, name, description } = {}) {
    return this._personalSaveOperation(async () => {
      if (!['create', 'switch', 'rename', 'promote', 'delete'].includes(action)) throw new Error('未知的 IF 线操作');
      if (action === 'delete' || action === 'promote') {
        if (branchId === 'branch_main') throw new Error('主线不能删除或重复升格');
        const branches = await timelineSystem.getAllBranches();
        const branch = branches.find(item => item.id === branchId);
        if (!branch) throw new Error('线路不存在，请刷新后重试');
        const confirmed = await customElements.get('game-modal').confirm({
          title: action === 'delete' ? '删除 IF 线' : '设为主线',
          message: action === 'delete'
            ? `删除「${branch.name}」及从它继续分出的子线？操作前会将完整进度备份到个人存档，之后可从备份找回。`
            : `将「${branch.name}」设为主线？原主线的后续剧情会保留为 IF 线；操作前会备份完整进度。`,
          okLabel: action === 'delete' ? '备份并删除' : '备份并设为主线', cancelLabel: '取消'
        });
        if (!confirmed) return false;
      }
      return personalSaveLibrary.exclusive(async () => {
        await personalSaveLibrary.capture({ reason: `before-if-${action}` });
        let result;
        if (action === 'create') result = await timelineSystem.createIfBranch({ fromNodeId, name, description });
        if (action === 'switch') result = await timelineSystem.switchBranch(branchId);
        if (action === 'rename') result = await timelineSystem.renameBranch(branchId, { name, description });
        if (action === 'promote') result = await timelineSystem.promoteBranchToMain(branchId);
        if (action === 'delete') result = await timelineSystem.deleteBranch(branchId);
        if (action !== 'rename') {
          const node = await timelineSystem.getCurrentNode();
          const history = await timelineSystem._reconstructChatHistory(node);
          this.pipeline?.setHistory(history);
          appShell.showGame();
          appShell.restoreChatHistory(history, node?.clean_response || node?.ai_response_summary || '线路已切换。', { timelineNodeId: node?.id });
        }
        return result ?? true;
      });
    });
  }

  async _confirmEmergencyReset(settingsModal) {
    try {
      if (await this._startNewPersonalSave()) settingsModal?.close();
    } catch (error) {
      this._sendSystemMessage(`重置失败: ${error.message}`);
    }
  }

  async _showBranchChoice() {
    return new Promise(resolve => {
      const modal = document.createElement('game-modal');
      (document.getElementById('app') || document.body).appendChild(modal);
      modal.show({
        title: '时间线分叉',
        content: `<p>当前回合已有后续剧情。<br/>请选择你希望如何处理：</p>`,
        buttons: [
          { label: '取消', onClick: () => resolve('cancel') },
          { label: '回退并删除后续', onClick: () => resolve('prune') },
          { label: '创建新的IF线', primary: true, onClick: () => resolve('branch') }
        ]
      });
    });
  }

  async _showRerollChoice() {
    return new Promise(resolve => {
      const modal = document.createElement('game-modal');
      (document.getElementById('app') || document.body).appendChild(modal);
      modal.show({
        title: '平行推衍',
        content: `<p>你选择重新推衍本回合。<br/>请选择如何处理本回及之后的剧情：</p>`,
        buttons: [
          { label: '取消', onClick: () => resolve('cancel') },
          { label: '删除本回及后续', primary: true, onClick: () => resolve('prune') },
          { label: '保存为IF线', onClick: () => resolve('branch') }
        ]
      });
    });
  }

  _buildCombatActionMessage(action) {
    return buildCombatPlayerActionMessage(action);
  }

  async _submitCombatAction(action) {
    const definition = combatPlayerActionDefinition(action);
    if (!definition) return { accepted: false, code: 'COMBAT_ACTION_INVALID' };
    if (!stateManager.getSub('_combat')?.is_active) {
      return { accepted: false, code: 'COMBAT_NOT_ACTIVE' };
    }
    if (this.pipeline?.isProcessing) {
      return { accepted: false, code: 'PIPELINE_BUSY' };
    }
    const beforeNodeId = stateManager.getSub('_meta')?.current_node_id || null;
    const accepted = await this._handleUserInput(definition.message);
    return {
      accepted: accepted === true,
      action: definition.action,
      label: definition.label,
      beforeNodeId,
      nodeId: stateManager.getSub('_meta')?.current_node_id || null
    };
  }

  async _submitPlayerAction(text) {
    const playerAction = String(text || '').replace(/\u0000/g, '').trim().slice(0, 4000);
    if (!playerAction) return { accepted: false, code: 'PLAYER_ACTION_INVALID' };
    if (stateManager.getSub('_combat')?.is_active) {
      return { accepted: false, code: 'COMBAT_ACTION_REQUIRED' };
    }
    if (this.pipeline?.isProcessing) {
      return { accepted: false, code: 'PIPELINE_BUSY' };
    }
    const beforeNodeId = stateManager.getSub('_meta')?.current_node_id || null;
    const accepted = await this._handleUserInput(playerAction, () => {
      appShell._addUserMessage?.(playerAction);
    });
    const nodeId = stateManager.getSub('_meta')?.current_node_id || null;
    return {
      accepted: accepted === true && Boolean(nodeId) && nodeId !== beforeNodeId,
      text: playerAction,
      beforeNodeId,
      nodeId,
      ...(accepted === true && nodeId === beforeNodeId ? { code: 'PIPELINE_NO_COMMIT' } : {})
    };
  }

  async _syncTimelinePresentation(fallback = '时间线状态已更新。') {
    const node = await timelineSystem.getCurrentNode();
    if (node) {
      const history = await timelineSystem._reconstructChatHistory(node);
      this.pipeline?.setHistory(history);
      appShell.renderSinglePage(node.clean_response || node.ai_response_summary || fallback, { timelineNodeId: node.id });
    }
    return node;
  }

  async _executeTimelineAction(options = {}) {
    const action = String(options?.action || '').trim();
    const nodeId = String(options?.nodeId || '').trim();
    const branchId = String(options?.branchId || '').trim();
    if (!['jump', 'rewind', 'reroll_branch', 'reroll_replace', 'switch_branch', 'promote_branch', 'delete_branch'].includes(action)) {
      return { applied: false, code: 'TIMELINE_ACTION_INVALID' };
    }

    if (action === 'jump') {
      await timelineSystem.jumpToNode(nodeId);
      const node = await this._syncTimelinePresentation('已跳转到选定回合。');
      return { applied: true, action, nodeId: node?.id || nodeId };
    }
    if (action === 'rewind') {
      const result = await timelineSystem.pruneForward(nodeId);
      const node = await this._syncTimelinePresentation('时间线已逆转。');
      return { applied: true, action, nodeId: node?.id || nodeId, pruned: Math.max(0, Number(result?.pruned) || 0) };
    }
    if (action === 'switch_branch') {
      await timelineSystem.switchBranch(branchId);
      const node = await this._syncTimelinePresentation('已切换时间线分支。');
      return { applied: true, action, branchId, nodeId: node?.id || null };
    }
    if (action === 'promote_branch') {
      await timelineSystem.promoteBranchToMain(branchId);
      const node = await this._syncTimelinePresentation('时间线收束完成，新的主线已确立。');
      return { applied: true, action, branchId, nodeId: node?.id || null };
    }
    if (action === 'delete_branch') {
      await timelineSystem.deleteBranch(branchId);
      const node = await this._syncTimelinePresentation('时间线分支已剪除。');
      return { applied: true, action, branchId, nodeId: node?.id || null };
    }

    if (this.pipeline?.isProcessing) return { applied: false, code: 'PIPELINE_BUSY' };
    const mode = action === 'reroll_replace' ? 'replace' : 'branch';
    const prepared = await timelineSystem.prepareReroll(nodeId, { mode });
    this.pipeline?.setHistory(prepared.history);
    const actionLabel = mode === 'replace' ? '重新推衍' : '平行重推衍';
    this._sendSystemMessage(`正在${actionLabel}：${prepared.playerInput}`);
    await this.pipeline.process(prepared.playerInput);
    const node = await timelineSystem.getCurrentNode();
    return {
      applied: Boolean(node?.id && node.id !== prepared.parentNodeId),
      action,
      nodeId: node?.id || null,
      parentNodeId: prepared.parentNodeId,
      pruned: prepared.pruned
    };
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new NarutoRPGApp();
  app.init().catch(err => {
    console.error('[NarutoRPG] Fatal error:', err);
    const container = document.getElementById('app');
    if (container) {
      container.innerHTML = `<div style="padding:40px;color:#e8e4d9;font-family:serif;text-align:center;">
        <h2 style="letter-spacing:4px;">忍者手记</h2>
        <p style="color:#eb613f;margin-top:16px;">初始化失败: ${err.message}</p>
        <p style="color:#a39f98;font-size:12px;margin-top:8px;">请检查浏览器控制台获取详细信息</p>
      </div>`;
    }
  });
});

export { NarutoRPGApp };
export default NarutoRPGApp;
