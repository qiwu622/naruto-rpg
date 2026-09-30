import { eventBus } from '../core/event-bus.js';
import { stateManager } from '../core/state-manager.js';
import { icon } from '../utils/icons.js';
import { escHtml, escAttr, formatGameTime } from '../utils/format.js';
import { getAgentConfig } from '../data/agent-config.js';
import { getMainPreset } from '../data/default-preset.js';
import { instructionParser } from '../core/instruction-parser.js';
import { isNarrativeReviewEnabled } from '../core/narrative-review.js';
import { buildPresetPresentation } from '../core/preset-regex-runtime.js';
import { inspectImportedPresetOutputProfile } from '../core/main-preset-compatibility.js';
import { readImportedPresetDebugLog } from '../core/imported-preset-debug-log.js';
import { imageStudio } from '../core/image-studio/index.js';
import { TIMELINE_FILE_ACCEPT } from '../core/timeline-file-codec.js';
import { mountTurnIllustration } from './image-studio.js';
import { mountPresetOutputSandbox } from './preset-output-sandbox.js';
import { createShinobiDailyTrigger } from './shinobi-daily-modal.js';
import { atmosphereManager } from './atmosphere-manager.js';
import { isNativeAndroidApp, isMultiplayerEntryVisible } from '../core/runtime-platform.js';
import {
  actionSubmissionUnavailableMessage,
  canSubmitProjectedAction,
  projectedNarrativeDeliveries,
  projectedDaily,
  projectedAuthoritativeState
} from '../multiplayer/ui-projection.js';
import './multiplayer-character-panel.js';

class AppShell {
  constructor() {
    this.element = null;
    this._streamingEl = null;
    this._isProcessing = false;
    this._recentInputs = [];
    this._recentInputIdx = -1;
    this._captureUpdates = false;
    this._lastDice = null;
    this._agentReasoningText = '';
    this._agentReasoningAgent = null;
    this._lastSubmittedInput = '';
    this._multiplayerSessionState = null;
  }

  init(container) {
    this.element = document.createElement('div');
    this.element.className = 'app-shell';
    this.element.id = 'app-shell';
    container.appendChild(this.element);
    this._loadRecentInputs();
    this._renderShell();
    this._bindEvents();
  }

  _renderShell() {
    const multiplayerEntryVisible = isMultiplayerEntryVisible();
    const nativeAndroid = isNativeAndroidApp();
    this.element.classList.toggle('app-shell--android', nativeAndroid);
    this.element.innerHTML = `
      <header class="app-topbar">
        <div class="topbar-left">
          <span class="topbar-logo${nativeAndroid ? ' topbar-logo--app' : ''}"><img src="${nativeAndroid ? '/img/app-mark.png' : '/img/logo.png'}" class="${nativeAndroid ? 'app-brand-mark' : 'logo-image-small'}" alt="忍者手记">${nativeAndroid ? '<span>忍者手记</span>' : ''}</span>
        </div>
        <div class="topbar-right" aria-label="界面切换">
          ${multiplayerEntryVisible ? '<button class="topbar-btn topbar-btn--multiplayer" id="btn-multiplayer" title="双人联机" aria-pressed="false"><span aria-hidden="true">双</span><span class="topbar-btn-label">联机</span></button><span class="topbar-divider"></span>' : ''}
          <button class="topbar-btn topbar-btn--panel" id="btn-panel" title="角色面板" aria-pressed="true">${icon('panel')}<span class="topbar-btn-label">面板</span></button>
          <span class="topbar-divider"></span>
          <button class="topbar-btn topbar-btn--developer" id="btn-developer" title="提示词查看" aria-pressed="false">${icon('developer')}<span class="topbar-btn-label">提示词查看</span></button>
          <span class="topbar-divider"></span>
          <button class="topbar-btn topbar-btn--timeline" id="btn-timeline" title="时间线" aria-pressed="false">${icon('timeline')}<span class="topbar-btn-label">时间线</span></button>
          <span class="topbar-divider"></span>
          <button class="topbar-btn topbar-btn--mobile" id="btn-mobile" title="手机端预览" aria-pressed="false">${icon('mobile')}<span class="topbar-btn-label">手机</span></button>
          <span class="topbar-divider"></span>
          <button class="topbar-btn topbar-btn--zen" id="btn-zen" title="网页全屏 (隐藏地址栏)">${icon('zen')}<span class="topbar-btn-label">网页全屏</span></button>
          <span class="topbar-divider"></span>
          <button class="topbar-btn topbar-btn--fullscreen" id="btn-fullscreen" title="屏幕全屏 (极致沉浸)">${icon('fullscreen')}<span class="topbar-btn-label">屏幕全屏</span></button>
          <span class="topbar-divider"></span>
          <button class="topbar-btn topbar-btn--map" id="btn-map" title="忍界地图">${icon('map')}<span class="topbar-btn-label">地图</span></button>
          <span class="topbar-divider"></span>
          <button class="topbar-btn topbar-btn--settings" id="btn-settings" title="设置">${icon('settings')}<span class="topbar-btn-label">设置</span></button>
          <span class="topbar-divider"></span>
          <button class="topbar-btn" id="btn-save-library" title="本地存档库：个人存档与联机房间">${icon('book-open')}<span class="topbar-btn-label">存档</span></button>
          <button class="topbar-btn topbar-btn--profile" id="btn-profile" title="个人中心">${icon('user')}<span class="topbar-btn-label">${isNativeAndroidApp() ? '个人' : '账户'}</span></button>
        </div>
      </header>

      <div class="app-main">
        <div class="mobile-scrim" id="mobile-scrim" aria-hidden="true"></div>
        <aside class="app-sidebar app-sidebar--collapsed" id="app-sidebar" aria-hidden="true">
          <timeline-navigator id="timeline-navigator"></timeline-navigator>
        </aside>
        <main class="app-center" id="app-center">
          <div class="chat-container">
            <div class="chat-messages" id="chat-messages"></div>
          </div>
          <div class="chat-input-area" id="chat-input-area" style="display:none;">
            <div class="recent-inputs" id="recent-inputs"></div>
            <div class="input-wrapper">
              <textarea id="chat-input" placeholder="提笔写下你的决断..." rows="1" aria-label="输入行动"></textarea>
              <button id="btn-cancel">✕ 解印</button>
              <button id="btn-send">${icon('send', 16)}结印</button>
            </div>
          </div>
        </main>
        <aside class="app-panel" id="app-panel">
          <info-panel id="info-panel"></info-panel>
          <multiplayer-character-panel id="multiplayer-character-panel" hidden></multiplayer-character-panel>
          <developer-panel id="developer-panel" style="display:none;"></developer-panel>
        </aside>
      </div>

      <footer class="app-statusbar">
        <span id="status-location">木叶隐村</span><span class="sep"></span>
        <span id="status-time">木叶四十八年</span><span class="sep"></span>
        <span id="status-weather">晴</span><span class="sep"></span>
        <span id="status-turn">第 1 回合</span><span class="sep"></span>
        <span id="status-cache" title="缓存命中率" style="cursor:default;">--</span><span class="sep"></span>
        <span id="status-version" title="当前版本">v</span>
      </footer>
    `;

    const sendBtn = this.element.querySelector('#btn-send');
    sendBtn.addEventListener('click', () => this._sendMessage());

    const cancelBtn = this.element.querySelector('#btn-cancel');
    cancelBtn.addEventListener('click', () => eventBus.emit('pipeline:cancel'));

    const textarea = this.element.querySelector('#chat-input');
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this._sendMessage();
        return;
      }
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        if (e.key === 'ArrowUp') this._cycleRecentInput(-1);
        else this._cycleRecentInput(1);
      }
    });

    textarea.addEventListener('input', () => this._resizeInput());

    this.element.querySelector('#btn-multiplayer')?.addEventListener('click', () => {
      eventBus.emit('app:open-multiplayer');
    });
    this.element.querySelector('#btn-panel').addEventListener('click', () => this._togglePanel());
    this.element.querySelector('#btn-developer').addEventListener('click', () => this._toggleDeveloperPanel());
    this.element.querySelector('#btn-timeline').addEventListener('click', () => this._toggleSidebar());
    this.element.querySelector('#btn-save-library')?.addEventListener('click', () => eventBus.emit('app:open-saves'));
    this.element.querySelector('#btn-mobile').addEventListener('click', () => this._toggleMobileView());
    this.element.querySelector('#btn-zen').addEventListener('click', () => this._toggleZenMode());
    this.element.querySelector('#btn-fullscreen').addEventListener('click', () => this._toggleFullscreen());
    this.element.querySelector('#btn-map').addEventListener('click', () => this.openMap());
    this.element.querySelector('#btn-settings').addEventListener('click', () => {
      eventBus.emit('app:open-settings');
    });
    this.element.querySelector('#btn-profile')?.addEventListener('click', () => {
      eventBus.emit('app:open-profile');
    });
    this.element.querySelector('#mobile-scrim')?.addEventListener('click', () => this._closeMobileDrawers());
    eventBus.on('panel:close', () => this._closeMobileDrawers());

    this._bindGlobalShortcuts();

    this._renderRecentInputs();
    this.element.querySelector('#recent-inputs')?.addEventListener('click', (e) => {
      const chip = e.target.closest('.recent-chip');
      if (chip) {
        const textarea = this.element.querySelector('#chat-input');
        if (textarea) {
          textarea.value = chip.dataset.text || '';
          textarea.focus();
          this._resizeInput();
        }
      }
    });

    this._syncResponsiveState();
    this._updateBranchIndicator();
    window.addEventListener('resize', () => this._debouncedResponsiveSync(), { passive: true });

    // 监听浏览器全屏状态变化（用户按 ESC 退出时自动同步按钮状态）
    const onFsChange = () => this._syncFullscreenState();
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);

    const onPageShow = (event) => {
      if (event.persisted) this._syncFullscreenState();
    };
    window.addEventListener('pageshow', onPageShow);

    const onVisibilityChange = () => {
      if (!document.hidden) this._syncFullscreenState();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  _bindGlobalShortcuts() {
    if (this._shortcutsBound) return;
    this._shortcutsBound = true;
    document.addEventListener('keydown', (e) => {
      if (e.isComposing || e.altKey) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      const inEditable = tag === 'textarea' || tag === 'input' || e.target?.isContentEditable;
      if (e.key === 'Escape' && this._isProcessing) {
        e.preventDefault();
        eventBus.emit('pipeline:cancel');
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this._sendMessage();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !inEditable) {
        e.preventDefault();
        this._toggleSidebar();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p' && !inEditable) {
        e.preventDefault();
        this._togglePanel();
      }
    });
  }

  _bindEvents() {
    this._turnUpdates = [];
    this._captureUpdates = false;
    this._reviewDecisionOff?.();
    this._reviewDecisionOff = eventBus.on('pipeline:review-decision', request => {
      const Modal = customElements.get('game-modal');
      if (!Modal?.reviewPreview) throw new Error('正文复检预览界面尚未加载');
      return Modal.reviewPreview(request || {});
    });
    this._variableRecoveryDecisionOff?.();
    this._variableRecoveryDecisionOff = eventBus.on('pipeline:variable-recovery-decision', request => {
      const Modal = customElements.get('game-modal');
      if (!Modal?.variableRecovery) throw new Error('二次变量恢复界面尚未加载');
      return Modal.variableRecovery(request || {});
    });
    eventBus.on('state:batch-changed', (e) => {
      if (this._captureUpdates && e.updates && e.updates.length) this._turnUpdates.push(...e.updates);
    });
    eventBus.on('state:changed', ({ key, value, deleted, batched }) => {
      // Flat update() writes are already represented by state:batch-changed.
      // Capture direct structured-path writes, which do not emit that event.
      this._captureStateChange({ key, value, deleted, batched });
    });
    eventBus.on('relationship:changed', ({ npc, relationship }) => {
      if (this._captureUpdates) {
        if (relationship.history && relationship.history.length > 0) {
          this._turnUpdates.push({
            key: `关系·${npc}·互动摘要`,
            op: '=',
            value: relationship.history[0].summary
          });
        }
        if (typeof relationship.affection === 'number') {
          this._turnUpdates.push({
            key: `关系·${npc}·好感`,
            op: '=',
            value: relationship.affection
          });
        }
      }
    });
    eventBus.on('user:input', () => {
      this._turnUpdates = [];
    });

    // 监听全局点击，利用事件委托处理行动选项 (Innovation)
    this.element.addEventListener('click', (e) => {
      const btn = e.target.closest('.action-option');
      if (btn && !this._isProcessing) {
        const action = btn.dataset.action;
        if (action) {
          const input = this.element.querySelector('#chat-input');
          if (input) {
            input.value = action;
            input.focus();
          }
        }
      }
    });

    eventBus.on('pipeline:processing', () => {
      this._turnUpdates = [];
      this._captureUpdates = true;
      this._agentStreamAgent = null;
      this._agentStreamText = '';
      this._agentReasoningText = '';
      this._setProcessing(true);
      if (getAgentConfig().enabled) {
        this._showAgentProgress();
      }
    });

    eventBus.on('pipeline:chunk', ({ response }) => {
      this._updateStreaming(instructionParser.cleanupPartialResponse(response));
    });

    eventBus.on('pipeline:review-started', () => {
      this._updateStreaming('', '终稿完成 · 正在复检最终正文…');
    });

    // Agent 模式：writer-outline/critic 流只进入代理详情；
    // 只有 final-writer 的输出进入正文流。
    eventBus.on('agent:stream', ({ agent, chunk }) => {
      if (isNarrativeReviewEnabled(stateManager.getAPIConfig() || {})) return;
      if (agent !== 'final-writer') return;
      if (!chunk) return;
      if (this._agentStreamAgent !== agent) {
        this._agentStreamAgent = agent;
        this._agentStreamText = '';
      }
      this._agentStreamText += chunk;
      this._updateStreaming(instructionParser.cleanupPartialResponse(this._agentStreamText));
    });

    // 仅收集 final-writer 的推演摘要；详纲和建议留在代理详情中。
    eventBus.on('agent:reasoning', ({ agent, chunk }) => {
      if (agent !== 'final-writer') return;
      if (!chunk) return;
      if (this._agentReasoningAgent !== agent) {
        this._agentReasoningAgent = agent;
        this._agentReasoningText = '';
      }
      this._agentReasoningText += chunk;
    });

    eventBus.on('pipeline:cancelled', ({ partialResponse }) => {
      this._setProcessing(false);
      this._captureUpdates = false;
      if (this._streamingEl) {
        this._streamingEl.classList.remove('is-streaming');
        const cursor = this._streamingEl.querySelector('.typing-cursor');
        if (cursor) cursor.remove();
        const partial = partialResponse || '';
        if (partial.trim().length > 50) {
          this._streamingEl.querySelector('.chat-content').innerHTML = this._renderMarkdown(partial);
          const note = document.createElement('div');
          note.style.cssText = 'color:#c69c6d;font-size:10px;margin-top:6px;font-style:italic;';
          note.textContent = '⚠ 生成已被取消，以上为已接收的部分内容。';
          this._streamingEl.querySelector('.chat-content').appendChild(note);
        } else {
          this._streamingEl.remove();
          this._streamingEl = null;
          this._addSystemMessage('生成已取消。');
        }
        this._streamingEl = null;
      }
    });

    eventBus.on('pipeline:complete', ({ rawResponse, cleanResponse, thinkContent, turnCount, hasHUD, isPartial, timelineError, timelineNodeId, shinobiDaily }) => {
      // Agent 模式下把 final-writer 捕获到的推演摘要并入最终消息折叠块。
      const mergedThink = this._agentReasoningText
        ? `${thinkContent || ''}\n\n## 主模型思维链\n\n${this._agentReasoningText}`
        : thinkContent;
      this._agentReasoningText = '';
      this._finalizeMessage(cleanResponse, rawResponse, mergedThink, isPartial, hasHUD, this._lastDice, shinobiDaily);
      if (!isPartial && timelineNodeId) void this._mountTurnIllustration(timelineNodeId, cleanResponse);
      // Update turn display inline (method was removed)
      const turnEl = this.element.querySelector('#status-turn');
      if (turnEl) turnEl.textContent = `第 ${Number(stateManager.get('系统·回合数')) || turnCount || 1} 回合`;
      this._updateStatusBar();
      this._setProcessing(false);
      if (timelineError) {
        this._addSystemMessage(`[系统] 时间线存档写入失败: ${timelineError}。当前进度可能丢失，请稍后导出存档。`);
      }
      this._captureUpdates = false;
    });

    eventBus.on('image:contract-ready', ({ nodeId }) => {
      const element = [...(this.element?.querySelectorAll('image-turn-illustration[data-node-id]') || [])]
        .find(candidate => candidate.dataset.nodeId === String(nodeId));
      if (!element) return;
      void stateManager.dbGet('timeline_nodes', nodeId).then(node => {
        element.contract = node?.media?.illustration?.contract || null;
      });
    });

    eventBus.on('pipeline:error', ({
      error,
      code,
      missingContracts,
      draftResponse,
      isTruncated,
      partialResponse,
      lastUserInput
    }) => {
      this._setProcessing(false);
      this._captureUpdates = false;
      this._settleStreamingError();
      const container = this.element?.querySelector('#chat-messages') || this.element;
      if (!container) return;

      const safeInput = lastUserInput ? this._escAttr(lastUserInput) : '';
      const rawErr = String(error || '');
      const hasImportedPresetDebug = code === 'IMPORTED_PRESET_OUTPUT_INCOMPLETE';
      let errTitle, errDetail, errHint;

      if (hasImportedPresetDebug) {
        errTitle = '【导入预设输出未通过校验】';
        errDetail = '已截获本次 AI 返回的完整原始回复；本回合未写入状态、记忆、聊天历史或时间线。';
        errHint = '点击“复制完整 AI 回复”，或打开 F12 控制台搜索 [ImportedPresetDebug] 查看原文与适配阶段。';
      } else if (code === 'STRICT_MAIN_OUTPUT_INCOMPLETE') {
        const contractLabels = {
          state_update: '变量记账确认',
          business_update: '有效变量更新',
          memory: '回合记忆',
          shinobi_daily: '忍界日报'
        };
        const missing = [...new Set(Array.isArray(missingContracts) ? missingContracts : [])]
          .map(item => contractLabels[item] || item)
          .join('、');
        errTitle = '【回合未结算】';
        errDetail = `AI 回复缺少完整结构记录${missing ? `：${missing}` : ''}，本回合未写入状态、记忆或时间线。`;
        errHint = draftResponse
          ? '屏幕正文仅为未保存草稿。可点击下方按钮重新生成完整回合。'
          : '可点击下方按钮重新生成完整回合。';
      } else if (rawErr.includes('Failed to fetch') || rawErr.includes('NetworkError')) {
        errTitle = '【连接中断】';
        errDetail = '感知的查克拉连接已断开，请检查网络或 API 地址是否可达。';
        errHint = '常见原因：API 地址填写错误、后端未启动、浏览器 CORS 限制。';
      } else if (rawErr.includes('429') || rawErr.includes('rate')) {
        errTitle = '【请求限流】';
        errDetail = '短时间内请求过多，API 限流中，请稍等片刻后重试。';
        errHint = '等待 1-2 分钟后重试，或切换到更大的模型限额。';
      } else if (rawErr.includes('401') || rawErr.includes('403') || rawErr.includes('Auth')) {
        errTitle = '【鉴权失败】';
        errDetail = 'API Key 无效或已过期，请检查密钥是否正确。';
        errHint = '前往设置面板确认 API Key，或更换有效的密钥。';
      } else if (rawErr.includes('timeout') || rawErr.includes('超时') || rawErr.includes('AbortError')) {
        errTitle = '【生成超时】';
        errDetail = 'AI 响应时间过长，可能是模型负载过高或生成量过大。';
        errHint = '可尝试：1. 缩短本回合正文目标  2. 换用更快的模型  3. 稍后重试';
      } else if (isTruncated) {
        errTitle = '【生成截断】';
        errDetail = `已收到 ${partialResponse?.length || 0} 字后中断，回复不完整。`;
        errHint = '已保存部分内容到界面，变量可能未完全更新。可继续游戏或重试。';
      } else if (rawErr.includes('500') || rawErr.includes('502') || rawErr.includes('503')) {
        errTitle = '【服务器异常】';
        errDetail = 'API 服务端暂时不可用，请稍后重试。';
        errHint = '服务端临时故障，等待几分钟后再试。';
      } else {
        errTitle = '【系统异常】';
        errDetail = rawErr || '时空乱流干扰了感知...';
        errHint = '请检查控制台日志获取更多信息。';
      }

      const errDiv = document.createElement('div');
      errDiv.className = 'chat-message chat-message--system chat-message--error';
      errDiv.innerHTML = `<div style="background:rgba(239,83,80,0.06);border:1px solid rgba(239,83,80,0.2);border-radius:10px;padding:14px 18px;margin:8px 0;max-width:85%;box-shadow:inset 0 0 20px rgba(239,83,80,0.03);">
        <div style="color:#ef5350;font-size:13px;font-weight:700;display:flex;align-items:center;gap:6px;margin-bottom:6px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          ${this._esc(errTitle)}
        </div>
        <div style="font-size:12px;color:#a39f98;line-height:1.6;margin-bottom:4px;">${this._esc(errDetail)}</div>
        <div style="font-size:11px;color:rgba(163,159,152,0.5);line-height:1.5;">${this._esc(errHint)}</div>
        ${(safeInput || hasImportedPresetDebug) ? `
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:10px;padding-top:8px;border-top:1px dashed rgba(239,83,80,0.12);">
          ${hasImportedPresetDebug ? `
          <button class="preset-debug-copy-btn" type="button" style="background:rgba(235,97,63,0.12);border:1px solid rgba(235,97,63,0.35);color:#eb613f;padding:5px 14px;border-radius:5px;font-size:12px;cursor:pointer;">
            复制完整 AI 回复
          </button>` : ''}
          ${safeInput ? `
          <button class="retry-btn" data-retry="${safeInput}" style="background:rgba(239,83,80,0.12);border:1px solid rgba(239,83,80,0.35);color:#ef5350;padding:5px 14px;border-radius:5px;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px;transition:all 0.2s;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/></svg>
            重新结印 (重试)
          </button>` : ''}
        </div>` : `
        <div style="font-size:11px;color:rgba(163,159,152,0.4);margin-top:8px;">请重新输入行动继续。</div>
        `}
      </div>`;
      const retryBtn = errDiv.querySelector('.retry-btn');
      retryBtn?.addEventListener('click', () => {
        const retryText = retryBtn.dataset.retry;
        errDiv.remove();
        if (retryText) eventBus.emit('user:input', retryText);
      });
      const debugCopyBtn = errDiv.querySelector('.preset-debug-copy-btn');
      debugCopyBtn?.addEventListener('click', async () => {
        const rawResponse = String(readImportedPresetDebugLog()?.rawResponse || '');
        if (!rawResponse) {
          this._showToast('本次完整 AI 回复日志已失效，请重新生成后再复制。');
          return;
        }
        try {
          await navigator.clipboard.writeText(rawResponse);
          this._showToast('已复制本次完整 AI 原始回复');
        } catch (copyError) {
          console.warn('[ImportedPresetDebug] Clipboard copy failed:', copyError?.message);
          this._showToast('自动复制失败，请在 F12 控制台执行 copy(window.__NARUTO_PRESET_DEBUG__.rawResponse)');
        }
      });
      container.appendChild(errDiv);
      this._scroll();
    });

    eventBus.on('pipeline:retrying', ({ attempt, maxRetries }) => {
      this._showToast(`AI 请求失败，第 ${attempt}/${maxRetries} 次重试中...`);
    });

    eventBus.on('pipeline:dice', ({ values }) => {
      this._lastDice = values;
      this._updateDicePool(values);
    });
    eventBus.on('pipeline:processing', () => {
      this._lastDice = null;
      this._updateDicePool(null);
    });

    eventBus.on('player:died', ({ cause, alreadyDead }) => {
      this._showDeathScreen(cause, alreadyDead);
    });

    eventBus.on('state:changed', ({ key }) => {
      if (key && (key.startsWith('世界·') || key.startsWith('属性·'))) {
        this._updateStatusBar();
      }
    });

    eventBus.on('state:restored', () => {
      this._updateStatusBar();
      this._updateBranchIndicator();
    });

    eventBus.on('timeline:branch-created', () => this._updateBranchIndicator());
    eventBus.on('timeline:branch-switched', () => this._updateBranchIndicator());
    eventBus.on('timeline:jumped', () => {
      this._updateStatusBar();
      this._updateBranchIndicator();
      atmosphereManager.flash('rgba(232, 228, 217, 0.5)', 400);
    });

    eventBus.on('ai:usage', (usage) => {
      if (!usage) return;
      let hit = Number(usage.prompt_cache_hit_tokens) || 0;
      let miss = Number(usage.prompt_cache_miss_tokens) || 0;
      // Claude: cache_read = hit, cache_creation = miss (first-time write)
      if (hit + miss === 0) {
        hit = Number(usage.cache_read_input_tokens) || 0;
        miss = Number(usage.cache_creation_input_tokens) || 0;
      }
      const total = hit + miss;
      const el = this.element?.querySelector('#status-cache');
      if (!el) return;
      if (total > 0) {
        const rate = Math.round((hit / total) * 100);
        const color = rate >= 90 ? '#66BB6A' : rate >= 50 ? '#c69c6d' : '#eb613f';
        el.style.color = color;
        el.textContent = `◉ ${rate}%`;
        el.title = `缓存命中: ${hit} tokens / 未命中: ${miss} tokens`;
      } else if (usage.prompt_tokens || usage.input_tokens) {
        el.style.color = '#a39f98';
        el.textContent = `◉ ---`;
        el.title = `本次输入: ${usage.prompt_tokens || usage.input_tokens} tokens（缓存字段缺失）`;
      } else {
        el.style.color = '#6e6a65';
        el.textContent = `◉ ---`;
        el.title = '等待 API 响应...';
      }
    });

    eventBus.on('app:toast', (text) => this._showToast(text));

    eventBus.on('combat:started', (data) => {
      this._showToast(`遭遇战: ${data?.enemy_name || '不明敌人'}`);
    });
    eventBus.on('combat:ended', ({ result }) => {
      const label = result === 'victory' ? '胜利' : result === 'defeat' ? '败北' : result === 'retreat' ? '撤退' : '结束';
      this._showToast(`战斗${label}`);
    });

    eventBus.on('attribute:level-up', ({ exp, needed }) => {
      this._showToast(`历练达成 ${exp}/${needed}，可申请晋升考核`);
    });
    eventBus.on('attribute:power-level-up', ({ level }) => {
      this._showToast(`战力突破: ${level}`);
    });

    eventBus.on('equipment:equipped', ({ slot, name }) => {
      this._showToast(`装备: ${name}`);
      this._addPendingAction(`装备了 ${name}`);
    });
    eventBus.on('equipment:unequipped', ({ name }) => {
      this._showToast(`卸下: ${name}`);
      this._addPendingAction(`卸下了 ${name}`);
    });
    eventBus.on('equipment:used', ({ name, effect }) => {
      this._showToast(`使用: ${name}`);
      let effectText = '';
      if (effect.heal) effectText += `恢复${effect.heal}点生命力 `;
      if (effect.chakra) effectText += `恢复${effect.chakra}点查克拉 `;
      this._addPendingAction(`使用了 ${name}${effectText ? `，${effectText}` : ''}`);
    });

    eventBus.on('mission:added', (mission) => {
      this._showToast(`接取任务: [${mission?.rank || 'D'}] ${mission?.title || ''}`);
      this._captureMissionUpdate(mission, 'added');
    });
    eventBus.on('mission:updated-active', (mission) => {
      this._captureMissionUpdate(mission, 'updated');
    });
    eventBus.on('mission:progress', (mission) => {
      this._captureMissionUpdate(mission, 'progress');
    });
    eventBus.on('mission:completed', (mission) => {
      this._showToast(`完成任务: ${mission?.title || ''}`);
      this._captureMissionUpdate(mission, 'completed');
    });
    eventBus.on('mission:failed', (mission) => {
      this._showToast(`任务失败: ${mission?.title || ''}`);
      this._captureMissionUpdate(mission, 'failed');
    });
    eventBus.on('mission:abandoned', (mission) => {
      this._showToast(`放弃任务: ${mission?.title || ''}`);
      this._captureMissionUpdate(mission, 'abandoned');
    });

    eventBus.on('pipeline:warning', ({ warning }) => {
      this._showToast(warning);
    });
  }

  _captureMissionUpdate(mission, action = 'updated') {
    if (!this._captureUpdates || !mission) return;
    const title = String(mission.title || mission.id || '未命名任务');
    const rank = String(mission.rank || 'D');
    const actionLabels = {
      added: '已接取', updated: '已更新', progress: '进度更新',
      completed: '已完成', failed: '已失败', abandoned: '已放弃'
    };
    const progress = mission.progress && typeof mission.progress === 'object' ? mission.progress : {};
    const progressParts = [];
    if (progress.note) progressParts.push(String(progress.note));
    if (Number.isFinite(Number(progress.current_step)) && Number.isFinite(Number(progress.total_steps)) && Number(progress.total_steps) > 0) {
      progressParts.push(`${Number(progress.current_step)}/${Number(progress.total_steps)}`);
    }
    const objective = mission.objective || mission.description || '';
    const detail = [actionLabels[action] || actionLabels.updated, ...progressParts, objective].filter(Boolean).join(' · ');
    this._turnUpdates ||= [];
    this._turnUpdates.push({
      key: `任务·${mission.id || title}`,
      label: `[${rank}] ${title}`,
      op: '=',
      value: detail,
      _readOnly: true
    });
  }

  _captureStateChange({ key, value, deleted = false, batched = false } = {}) {
    if (!this._captureUpdates || batched || !key || String(key).startsWith('_')) return;
    this._turnUpdates ||= [];
    this._turnUpdates.push({
      key,
      op: deleted ? '-' : '=',
      value: deleted ? undefined : value
    });
  }

  _addPendingAction(actionText) {
    if (!this._pendingActions) this._pendingActions = [];
    this._pendingActions.push(actionText);
    const textarea = this.element.querySelector('#chat-input');
    if (textarea && textarea.value.trim() === '') {
      textarea.placeholder = `(已准备 ${this._pendingActions.length} 个动作，输入指令或直接按回车执行)`;
    }
  }

  async _sendMessage() {
    if (this._isProcessing || this._isSubmitting) return;
    const textarea = this.element.querySelector('#chat-input');
    const text = textarea.value.trim();
    if (!text && !(this._pendingActions && this._pendingActions.length > 0)) return;

    let finalText = text;
    let displayMsg = text;
    if (this._pendingActions && this._pendingActions.length > 0) {
      const actions = this._pendingActions.join('；');
      finalText = text ? `[系统：玩家${actions}]\n${text}` : `[系统：玩家${actions}]`;
      displayMsg = text ? `(系统动作)\n${text}` : `(系统动作已发送)`;
    }

    this._isSubmitting = true;
    textarea.disabled = true;
    const sendButton = this.element.querySelector('#btn-send');
    if (sendButton) sendButton.disabled = true;
    let accepted = false;
    const accept = () => {
      if (accepted) return;
      accepted = true;
      this._lastSubmittedInput = finalText;
      textarea.value = '';
      textarea.placeholder = '提笔写下你的决断...';
      this._resizeInput();
      this._pendingActions = [];
      this._turnUpdates = [];
      if (text) this._addToRecentInputs(text);
      this._addUserMessage(displayMsg);
      this._recentInputIdx = -1;
      this._closeMobileDrawers();
    };

    try {
      await eventBus.request('user:submit', { text: finalText, accept });
    } catch (error) {
      console.error('[AppShell] User submission failed:', error);
      eventBus.emit('app:toast', error.message || '提交行动失败');
    } finally {
      this._isSubmitting = false;
      if (this._multiplayerSessionState) {
        this.setMultiplayerSessionState(this._multiplayerSessionState);
      } else if (!this._isProcessing) {
        textarea.disabled = false;
        if (sendButton) sendButton.disabled = false;
        textarea.focus();
      }
    }
  }

  _setProcessing(isProcessing) {
    this._isProcessing = isProcessing;
    this.element?.classList.toggle('is-processing', isProcessing);
    const textarea = this.element?.querySelector('#chat-input');
    const sendBtn = this.element?.querySelector('#btn-send');
    if (textarea) textarea.disabled = isProcessing;
    if (sendBtn) {
      sendBtn.disabled = isProcessing;
      sendBtn.innerHTML = isProcessing ? `${icon('chakra', 16)}结印中` : `${icon('send', 16)}结印`;
    }
    document.querySelectorAll('combat-arena').forEach(arena => {
      arena.toggleAttribute('data-disabled', isProcessing);
      arena.setActionDisabled?.(isProcessing);
      if (!isProcessing) {
        arena.removeAttribute('data-disabled');
        arena.shadowRoot?.querySelectorAll('.act').forEach(btn => { btn.disabled = false; });
      }
    });
    if (!isProcessing) this._removeAgentProgress();
    if (this._multiplayerSessionState) {
      this.setMultiplayerSessionState(this._multiplayerSessionState);
    }
  }

  _showAgentProgress() {
    this._removeAgentProgress();
    const msgs = this.element?.querySelector('#chat-messages');
    if (!msgs) return;
    const el = document.createElement('agent-progress');
    el.id = 'agent-progress-live';
    msgs.appendChild(el);
    el.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }

  _removeAgentProgress() {
    this.element?.querySelector('#agent-progress-live')?.remove();
  }

  _resizeInput() {
    const textarea = this.element?.querySelector('#chat-input');
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
  }

  _addToRecentInputs(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this._recentInputs[0] === trimmed) return;
    this._recentInputs = [trimmed, ...this._recentInputs.filter(t => t !== trimmed)].slice(0, 2);
    this._saveRecentInputs();
    this._renderRecentInputs();
  }

  _saveRecentInputs() {
    try {
      localStorage.setItem('naruto_recent_inputs', JSON.stringify(this._recentInputs));
    } catch { /* ignore */ }
  }

  _loadRecentInputs() {
    try {
      const raw = localStorage.getItem('naruto_recent_inputs');
      this._recentInputs = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(this._recentInputs)) this._recentInputs = [];
      this._recentInputs = [...new Set(this._recentInputs.filter(Boolean))].slice(0, 2);
    } catch { this._recentInputs = []; }
  }

  _cycleRecentInput(direction) {
    const textarea = this.element?.querySelector('#chat-input');
    if (!textarea || !this._recentInputs.length) return;
    if (this._recentInputIdx === -1) {
      this._savedInput = textarea.value;
    }
    const max = this._recentInputs.length - 1;
    this._recentInputIdx += direction;
    if (this._recentInputIdx > max) {
      this._recentInputIdx = -1;
      textarea.value = this._savedInput || '';
    } else if (this._recentInputIdx < 0) {
      this._recentInputIdx = max;
      textarea.value = this._recentInputs[this._recentInputIdx];
    } else {
      textarea.value = this._recentInputs[this._recentInputIdx];
    }
    this._resizeInput();
  }

  _renderRecentInputs() {
    const container = this.element?.querySelector('#recent-inputs');
    if (!container) return;
    if (!this._recentInputs.length) {
      container.innerHTML = '';
      container.style.display = 'none';
      return;
    }
    container.style.display = 'flex';
    container.innerHTML = this._recentInputs.map((text, i) => {
      const chipLabel = i === 0 ? '上回' : '上上回';
      const textLabel = text.length > 50 ? text.slice(0, 50) + '…' : text;
      return `<span class="recent-chip" data-text="${this._escAttr(text)}" title="${this._escAttr(text)}">
        <span class="recent-chip-label">${chipLabel}</span>${this._esc(textLabel)}
      </span>`;
    }).join('');
  }

  _addUserMessage(text) {
    // Single page paradigm: We do not display user messages in the main view anymore.
    // Instead, we clear the chat to prepare for the AI's response.
    const msgs = this.element.querySelector('#chat-messages');
    if (msgs) {
      msgs.innerHTML = `<div class="chat-message chat-message--system"><div class="chat-bubble">正在结印，请稍候...</div></div>`;
    }
    this._scroll();
  }

  _addSystemMessage(text, type = 'info') {
    const msgs = this.element.querySelector('#chat-messages');
    if (!msgs) return;
    const div = document.createElement('div');
    div.className = `chat-message chat-message--system ${type === 'warning' ? 'chat-message--warning' : ''}`.trim();
    const escaped = this._esc(text)
      .replace(/\n/g, '<br>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>' + '$' + '1</strong>')
      .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.1);padding:2px 4px;border-radius:2px;font-family:var(--font-title);letter-spacing:1px;">' + '$' + '1</code>');
    div.innerHTML = `<div class="chat-bubble">${escaped}</div>`;
    msgs.appendChild(div);
    this._scroll();
  }

  addSystemMessage(text, type = 'info') {
    this._addSystemMessage(text, type);
  }

  renderSinglePage(text, { timelineNodeId = null, multiplayer = false } = {}) {
    this._showGame();
    const msgs = this.element.querySelector('#chat-messages');
    if (!msgs) return;
    msgs.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'chat-message chat-message--ai';
    div.innerHTML = `<div class="chat-content">${this._renderMarkdown(text)}</div>`;
    msgs.appendChild(div);

    // Add combat arena if active and setting is enabled
    const combat = stateManager.getSub('_combat');
    const tacticalCombat = stateManager.getSub('_ui').settings.tacticalCombat;
    if (!multiplayer && combat?.is_active && tacticalCombat) {
      const wrap = document.createElement('div');
      const arena = document.createElement('combat-arena');
      wrap.appendChild(arena);
      msgs.appendChild(wrap);
    }
    if (timelineNodeId) {
      void this._mountTurnIllustration(timelineNodeId, text);
      void this._mountStoredShinobiDaily(timelineNodeId);
    }
    this._scroll();
  }

  restoreChatHistory(history = [], fallbackMessage = '', { timelineNodeId = null } = {}) {
    // Single page paradigm: we ignore the array of history and just use the fallbackMessage (which is node.clean_response)
    this.renderSinglePage(fallbackMessage || '本回没有记录任何回忆...', { timelineNodeId });
  }

  renderMultiplayerPublication(turn) {
    const deliveries = projectedNarrativeDeliveries(turn);
    if (!deliveries.length) return;
    this.renderSinglePage(deliveries.map(delivery => delivery.text).join('\n\n'), { multiplayer: true });
    const projection = projectedAuthoritativeState(turn);
    const content = this.element.querySelector('#chat-messages .chat-content');
    const summary = document.createElement('section');
    summary.dataset.multiplayerPublication = turn.turn_id;
    summary.style.cssText = 'margin:24px 0;padding:16px;border:1px solid rgba(198,156,109,.4);border-radius:12px;background:rgba(10,14,20,.85);color:#f4eadc;font:14px/1.8 var(--font-body,sans-serif)';
    const actor = projection?.actors?.[projection.viewer_seat];
    const labels = { chakra: '查克拉', mental: '精神力', stamina: '体力', vitality: '生命力', money: '资金' };
    const values = (actor?.attributes?.resources ?? []).map(item =>
      `${labels[item.resource_id] ?? item.resource_id} ${item.current}${item.resource_id === 'money' ? '' : ` / ${item.maximum}`}`);
    const text = document.createElement('p');
    text.textContent = `第 ${turn.turn_no} 回合 · 变量已同步${projection?.shared_world?.calendar?.display_date ? ` · ${projection.shared_world.calendar.display_date}` : ''}\n${values.join('　')}`;
    text.style.whiteSpace = 'pre-wrap';
    summary.append(text);
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'btn'; button.textContent = '查看角色与变量';
    button.dataset.multiplayerVariables = 'true';
    button.addEventListener('click', () => {
      this._setRightPanelMode('info');
      const panel = this.element.querySelector('#app-panel');
      panel?.classList.remove('app-panel--collapsed'); panel?.classList.add('panel-open');
      this.element.querySelector('#multiplayer-character-panel')?.openTab('attributes');
    });
    summary.append(button); content.append(summary);
    const daily = projectedDaily(turn);
    this._mountShinobiDaily(Array.isArray(daily) ? daily.at(-1)?.daily : daily);
  }

  _showToast(text) {
    const old = document.querySelector('.toast');
    if (old) old.remove();
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = text;
    (this.element ? (this.element.closest('#app') || document.body) : document.body).appendChild(toast);
    window.setTimeout(() => toast.remove(), 2600);
  }

  _settleStreamingError() {
    const streamingEl = this._streamingEl;
    if (!streamingEl) return;
    streamingEl.querySelector('.typing-cursor')?.remove();
    const content = streamingEl.querySelector('.chat-content');
    if (content?.classList?.contains('streaming-placeholder')) {
      // Hidden thinking/review text has no safe partial body to preserve.
      streamingEl.remove();
    } else {
      streamingEl.classList.remove('is-streaming');
    }
    this._streamingEl = null;
  }

  _updateStreaming(text, placeholder = '流式连接正常 · 正在回映与校验…') {
    if (!this._streamingEl) {
      const msgs = this.element.querySelector('#chat-messages');
      // Single page paradigm: Clear the "正在结印..." system message before streaming
      msgs.innerHTML = '';
      this._streamingEl = document.createElement('div');
      this._streamingEl.className = 'chat-message chat-message--ai is-streaming';
      this._streamingEl.innerHTML = '<div class="chat-content"></div><span class="typing-cursor"></span>';
      msgs.appendChild(this._streamingEl);
    }
    const content = this._streamingEl.querySelector('.chat-content');
    if (text) {
      content.classList.remove('streaming-placeholder');
      content.innerHTML = this._renderMarkdown(text);
    } else {
      // 思考/审校内容仍保持隐藏，但明确告诉用户连接正在持续接收数据。
      content.classList.add('streaming-placeholder');
      content.textContent = placeholder;
    }
    this._scroll();
  }

  async _mountTurnIllustration(nodeId, fallbackPrompt = '') {
    try {
      const settings = await imageStudio.read({ type: 'settings' });
      if (!settings.enabled) return;
      const node = await stateManager.dbGet('timeline_nodes', nodeId);
      if (!node) return;
      const message = [...(this.element?.querySelectorAll('#chat-messages .chat-message--ai') || [])].at(-1);
      const content = message?.querySelector('.chat-content');
      if (!content) return;
      content.querySelector('[data-image-turn-host]')?.remove();
      const host = document.createElement('div');
      host.dataset.imageTurnHost = String(nodeId);
      host.style.marginTop = '14px';
      content.insertBefore(host, content.querySelector('[data-shinobi-daily-host]'));
      const element = mountTurnIllustration(host, {
        imageStudio, nodeId,
        contract: node.media?.illustration?.contract || null,
        prompt: node.media?.illustration?.contract ? '' : (node.clean_response || fallbackPrompt || ''),
        mode: settings.turnMode === 'automatic' ? 'auto' : 'manual'
      });
      element.dataset.nodeId = String(nodeId);
    } catch (error) {
      console.warn('[AppShell] Unable to mount turn illustration:', error.message);
    }
  }

  _mountShinobiDaily(daily) {
    const message = [...(this.element?.querySelectorAll('#chat-messages .chat-message--ai') || [])].at(-1);
    const content = message?.querySelector('.chat-content');
    if (!content) return;
    content.querySelector('[data-shinobi-daily-host]')?.remove();
    const trigger = createShinobiDailyTrigger(daily);
    if (trigger) content.appendChild(trigger);
  }

  _buildPresetPresentation(rawText, cleanText) {
    try {
      const preset = getMainPreset();
      const compatibilityProfile = inspectImportedPresetOutputProfile(preset);
      const playerName = stateManager.get('玩家·姓名') || '玩家';
      return buildPresetPresentation(rawText, cleanText, preset?.regexScripts || [], {
        structuredFallback: true,
        adapterId: compatibilityProfile.adapterId,
        macroContext: {
          playerName,
          charName: playerName,
          lastUserMessage: this._lastSubmittedInput || ''
        }
      });
    } catch (error) {
      console.warn('[AppShell] 预设输出美化失败，已回退到安全正文:', error.message);
      return { kind: 'markdown', text: String(cleanText || ''), warnings: [] };
    }
  }

  _fillPresetAction(action, { append = false } = {}) {
    const input = this.element?.querySelector('#chat-input');
    const text = String(action || '').trim();
    if (!input || !text) return;
    const current = String(input.value || '');
    input.value = append && current.trim() ? `${current.replace(/\s+$/, '')}\n${text}` : text;
    this._resizeInput();
    input.focus({ preventScroll: true });
    input.setSelectionRange?.(input.value.length, input.value.length);
  }

  _appendPresetHostActions(container, actions) {
    const normalized = [];
    const seen = new Set();
    for (const item of Array.isArray(actions) ? actions.slice(0, 32) : []) {
      const action = String(typeof item === 'string'
        ? item
        : (item?.action ?? item?.text ?? item?.value ?? item?.label ?? '')).trim().slice(0, 1000);
      if (!action || seen.has(action)) continue;
      seen.add(action);
      normalized.push({
        action,
        label: String(typeof item === 'object' && item?.label ? item.label : action).trim().slice(0, 200),
        append: Boolean(typeof item === 'object' && item?.append)
      });
    }
    if (!container || normalized.length === 0) return;
    const group = document.createElement('div');
    group.className = 'preset-output-host-actions';
    group.setAttribute('aria-label', '可选行动');
    for (const item of normalized) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'preset-output-host-action';
      button.textContent = item.label || item.action;
      button.addEventListener('click', event => {
        this._fillPresetAction(item.action, { append: item.append || event.shiftKey === true });
      });
      group.appendChild(button);
    }
    container.appendChild(group);
  }

  _renderPresetPresentation(container, presentation, cleanText) {
    if (presentation?.kind === 'sandbox') {
      try {
        mountPresetOutputSandbox(container, presentation.source, {
          onAction: (action, options) => this._fillPresetAction(action, options)
        });
        this._appendPresetHostActions(container, presentation.actions);
        return;
      } catch (error) {
        console.warn('[AppShell] 预设沙箱展示失败，已回退到安全正文:', error.message);
      }
    }
    if (presentation?.kind === 'structured') {
      container.replaceChildren();
      if (presentation.text) {
        const main = document.createElement('div');
        main.className = 'preset-output-structured-main';
        main.innerHTML = this._renderMarkdown(String(presentation.text));
        container.appendChild(main);
      }
      for (const block of Array.isArray(presentation.blocks) ? presentation.blocks : []) {
        const section = document.createElement('section');
        section.className = `preset-output-structured-block preset-output-structured-block--${block.kind || 'status'}`;
        if (block.label) {
          const label = document.createElement('div');
          label.className = 'preset-output-structured-label';
          label.textContent = String(block.label);
          section.appendChild(label);
        }
        const body = document.createElement('div');
        body.className = 'preset-output-structured-body';
        section.appendChild(body);
        if (block.kind === 'sandbox') {
          try {
            mountPresetOutputSandbox(body, block.source, {
              onAction: (action, options) => this._fillPresetAction(action, options)
            });
          } catch (error) {
            console.warn('[AppShell] 结构化预设沙箱展示失败:', error.message);
            body.innerHTML = this._renderMarkdown(String(block.fallbackText || ''));
          }
        } else {
          body.innerHTML = this._renderMarkdown(String(block.text || ''));
        }
        this._appendPresetHostActions(section, block.actions);
        container.appendChild(section);
      }
      this._appendPresetHostActions(container, presentation.actions);
      return;
    }
    const text = presentation?.kind === 'markdown'
      ? presentation.text
      : (presentation?.fallbackText || cleanText || '');
    container.innerHTML = this._renderMarkdown(String(text || ''));
  }

  async _mountStoredShinobiDaily(nodeId) {
    try {
      const node = await stateManager.dbGet('timeline_nodes', nodeId);
      if (!node?.shinobi_daily) return;
      const currentNodeId = stateManager.getSub('_meta')?.current_node_id;
      if (currentNodeId && String(currentNodeId) !== String(nodeId)) return;
      this._mountShinobiDaily(node.shinobi_daily);
    } catch (error) {
      console.warn('[AppShell] Unable to mount shinobi daily:', error.message);
    }
  }

  _finalizeMessage(text, rawText, thinkContent, isPartial = false, hasHUD = false, dice = null, shinobiDaily = null) {
    if (!this._streamingEl) {
      this._updateStreaming(text);
    }
    if (this._streamingEl) {
      this._streamingEl.classList.remove('is-streaming');
      const cursor = this._streamingEl.querySelector('.typing-cursor');
      if (cursor) cursor.remove();

      const contentEl = this._streamingEl.querySelector('.chat-content');
      const updates = this._turnUpdates ? [...this._turnUpdates] : [];
      const hasDice = dice && dice.length > 0;

      // Build the collapsible think block (reasoning + dice only, no variable HUD)
      if (thinkContent || hasDice) {
        const isOpen = stateManager.getSub('_ui').settings.reasoningOpen !== false;

        let toggleLabel = '思维链';
        if (hasDice) toggleLabel += ' · 卦象';
        if (!thinkContent && !hasDice) toggleLabel += ' · 无内容';

        const thinkBlock = document.createElement('div');
        thinkBlock.className = `think-block${isOpen ? '' : ' think-collapsed'}`;
        thinkBlock.innerHTML = `
          <div class="think-toggle">
            <span class="think-arrow">▼</span> ${toggleLabel}
          </div>
          <div class="think-body">${
            hasDice ? `<div class="think-dice">${this._renderDiceCards(dice)}</div>` : ''
          }${
            thinkContent
              ? `<div class="think-reasoning">${this._renderMarkdown(thinkContent)}</div>`
              : (hasDice ? '' : '<div class="think-reasoning" style="color:var(--text-tertiary);font-style:italic;">本回合无推理内容。</div>')
          }</div>`;
        thinkBlock.querySelector('.think-toggle').addEventListener('click', () => {
          thinkBlock.classList.toggle('think-collapsed');
        });
        contentEl.parentElement.insertBefore(thinkBlock, contentEl);
      }

      // rawText 只在当前回合的瞬时展示分支中使用。历史与时间线仍只持久化 text（clean_response）。
      const presentation = this._buildPresetPresentation(rawText, text);
      contentEl.innerHTML = '';
      const presentationHost = document.createElement('div');
      presentationHost.className = 'preset-output-presentation';
      contentEl.appendChild(presentationHost);
      this._renderPresetPresentation(presentationHost, presentation, text);

      // Build the variable update panel — shown when there ARE actual changes
      // (regardless of hasHUD, so secondary updater changes also display)
      const varPanel = this._buildVarUpdatePanel(updates);
      if (varPanel) {
        const panel = document.createElement('div');
        panel.className = 'var-update-panel';
        panel.innerHTML = varPanel;
        contentEl.appendChild(panel);
        this._bindVarPanelEdit(panel);
      }

      const editBar = document.createElement('div');
      editBar.style.cssText = 'display:flex;gap:8px;margin-top:10px;padding-top:8px;border-top:1px dashed rgba(198,156,109,0.15);';
      editBar.innerHTML = `<button class="edit-ai-btn" title="查看原文并编辑" style="padding:3px 10px;font-size:11px;color:#a39f98;background:transparent;border:1px solid rgba(232,228,217,0.15);border-radius:3px;cursor:pointer;font-family:var(--font-title);letter-spacing:1px;">✎ 编辑</button>`;
      editBar.querySelector('.edit-ai-btn').addEventListener('click', () => {
        this._editAIResponse(contentEl, text, editBar);
      });
      contentEl.appendChild(editBar);
      if (isPartial) {
        const note = document.createElement('div');
        note.style.cssText = 'color:#c69c6d;font-size:10px;margin-top:6px;font-style:italic;';
        note.textContent = '⚠ 此回复被截断，变量可能未完全更新。可继续游戏。';
        contentEl.appendChild(note);
      }
      if (shinobiDaily) this._mountShinobiDaily(shinobiDaily);
      this._streamingEl = null;
    }
    const combat = stateManager.getSub('_combat');
    const tacticalCombat = stateManager.getSub('_ui').settings.tacticalCombat;
    if (combat?.is_active && tacticalCombat) {
      const msgs = this.element.querySelector('#chat-messages');
      if (msgs && !msgs.querySelector('combat-arena')) {
        const wrap = document.createElement('div');
        const arena = document.createElement('combat-arena');
        wrap.appendChild(arena);
        msgs.appendChild(wrap);
      }
    }
    this._scroll();
  }

  _buildVarUpdatePanel(updates) {
    if (!updates || updates.length === 0) return null;

    // Filter noise
    const ignoreKeys = ['ai_response_summary', 'timeline_nodes', 'panel_tab', 'memory',
      'memory.recent_summary', 'map.active_pins', '世界·活跃事件'];
    const filtered = updates.filter(u => {
      const k = u.key || u.path || '';
      return !k.startsWith('系统·') && !k.startsWith('_ui')
        && !k.includes('turn_count') && !k.includes('active_branch')
        && !ignoreKeys.includes(k)
        && !k.includes('timeline') && !k.includes('node_id');
    });
    if (filtered.length === 0) return null;

    // Deduplicate merge
    const keyMap = new Map();
    for (const u of filtered) {
      const k = u.key || u.path || '';
      const existing = keyMap.get(k);
      if (!existing) { keyMap.set(k, { ...u }); continue; }
      if (u.op === '=' || u.op === 'set') { keyMap.set(k, { ...u }); continue; }
      if (existing.op === '=' || existing.op === 'set') continue;
      const uSign = (u.op === '+' || u.op === 'add') ? 1 : -1;
      const exSign = (existing.op === '+' || existing.op === 'add') ? 1 : -1;
      const net = exSign * (Number(existing.value) || 0) + uSign * (Number(u.value) || 0);
      existing.value = Math.abs(net);
      existing.op = net >= 0 ? '+' : '-';
    }

    // Collapse skill/item sub-fields into grouped entries
    const skillSubFields = new Set(['名称', '等级', '属性', '消耗', '威力', '熟练度', '描述']);
    const itemSubFields = new Set(['数量', '品质', '描述', '说明', '名称', '类型', '威力', '消耗', '属性']);
    const groupedMap = new Map();
    for (const [k, u] of keyMap) {
      const parts = k.split('·');
      let grouped = false;
      // Check skill sub-fields: 技能·忍术·变身术·消耗
      if (parts.length >= 4 && parts[0] === '技能' && skillSubFields.has(parts[parts.length - 1])) {
        const parentKey = parts.slice(0, -1).join('·');
        if (!groupedMap.has(parentKey)) {
          groupedMap.set(parentKey, { key: parentKey, op: '=', value: '已更新', _subCount: 0 });
        }
        groupedMap.get(parentKey)._subCount++;
        grouped = true;
      }
      // Check item sub-fields: 物品·消耗品·兵粮丸·数量
      if (parts.length >= 4 && parts[0] === '物品' && itemSubFields.has(parts[parts.length - 1])) {
        const parentKey = parts.slice(0, -1).join('·');
        if (!groupedMap.has(parentKey)) {
          groupedMap.set(parentKey, { key: parentKey, op: '=', value: '已更新', _subCount: 0 });
        }
        groupedMap.get(parentKey)._subCount++;
        grouped = true;
      }
      // Check relationship updates (group all into 关系·NPC名)
      if (parts.length >= 3 && parts[0] === '关系') {
        const parentKey = parts.slice(0, 2).join('·');
        if (!groupedMap.has(parentKey)) {
          groupedMap.set(parentKey, { key: parentKey, op: '=', value: '已更新', _subCount: 0 });
        }
        groupedMap.get(parentKey)._subCount++;
        grouped = true;
      }
      if (!grouped) {
        groupedMap.set(k, u);
      }
    }

    // Build panel rows
    let rows = '';
    for (const u of groupedMap.values()) {
      const k = u.key || u.path || '';
      const label = u.label || this._beautifyVarKey(k);
      let curVal = stateManager.get(k);
      if (curVal === undefined) curVal = u.value; // Fallback for synthetic keys

      const isNumeric = typeof curVal === 'number';

      let deltaHtml = '';
      if (u.op === '+' || u.op === 'add') {
        deltaHtml = `<span class="vu-delta vu-up">+${isNumeric ? u.value : ''}</span>`;
      } else if (u.op === '-' || u.op === 'sub') {
        deltaHtml = `<span class="vu-delta vu-down">-${isNumeric ? u.value : ''}</span>`;
      } else {
        deltaHtml = `<span class="vu-delta vu-set">更新</span>`;
      }

      let valDisplay;
      if (u._subCount) {
        valDisplay = `<span class="vu-val vu-val-str">${u._subCount} 项属性</span>`;
      } else if (isNumeric) {
        valDisplay = `<span class="vu-val">${curVal}</span>`;
      } else {
        valDisplay = `<span class="vu-val vu-val-str">${this._esc(String(curVal).slice(0, 60))}</span>`;
      }

      rows += `<div class="vu-row" data-key="${this._escAttr(k)}" data-val="${this._escAttr(String(curVal))}">
        <span class="vu-label">${this._esc(label)}</span>
        <span class="vu-value-cell">${valDisplay}${deltaHtml}</span>
        ${u._readOnly ? '' : `<button class="vu-edit-btn" data-key="${this._escAttr(k)}" title="修正此变量">✎</button>`}
      </div>`;
    }

    return `<div class="vu-header">
      <span class="vu-title">判定结果 · 本回合变动</span>
      <span class="vu-count">${groupedMap.size} 项</span>
    </div><div class="vu-list">${rows}</div>`;
  }

  _bindVarPanelEdit(panel) {
    panel.querySelectorAll('.vu-edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.key;
        const row = btn.closest('.vu-row');
        if (!row) return;
        this._showVarInlineEdit(row, key);
      });
    });
  }

  _showVarInlineEdit(row, key) {
    // Don't double-edit
    if (row.querySelector('.vu-edit-inline')) return;

    // Special logic for editing full NPC object
    const relMatch = key.match(/^关系·(.+)$/);
    if (relMatch) {
      const npcName = relMatch[1];
      const rels = stateManager.getSub('_relationships') || {};
      const npcData = rels[npcName];
      if (!npcData) return;

      const displayVal = JSON.stringify(npcData, null, 2);
      const editHtml = document.createElement('div');
      editHtml.className = 'vu-edit-inline';
      editHtml.style.alignItems = 'flex-start';
      editHtml.innerHTML = `
        <textarea class="vu-edit-input vu-edit-textarea" rows="15" style="width:100%;font-family:monospace;font-size:12px;">${this._esc(displayVal)}</textarea>
        <div style="display:flex; flex-direction:column; gap:6px;">
          <button class="vu-edit-save">✓</button>
          <button class="vu-edit-cancel">✕</button>
        </div>
      `;
      row.appendChild(editHtml);

      const save = () => {
        try {
          const parsed = JSON.parse(editHtml.querySelector('textarea').value);
          const currentRels = stateManager.getSub('_relationships') || {};
          currentRels[npcName] = parsed;
          stateManager.setSub('_relationships', currentRels);
          const deltaEl = row.querySelector('.vu-delta');
          if (deltaEl) { deltaEl.textContent = '已修正'; deltaEl.className = 'vu-delta vu-set'; }
          editHtml.remove();
        } catch (e) {
          alert('JSON格式错误: ' + e.message);
        }
      };
      editHtml.querySelector('.vu-edit-save').addEventListener('click', save);
      editHtml.querySelector('.vu-edit-cancel').addEventListener('click', () => editHtml.remove());
      return;
    }

    let curVal = stateManager.get(key);
    if (curVal === undefined || curVal === null) {
      curVal = row.dataset.val;
      if (!isNaN(Number(curVal)) && curVal.trim() !== '') {
        curVal = Number(curVal);
      }
    }
    const isNum = typeof curVal === 'number';
    const displayVal = isNum ? curVal : (typeof curVal === 'string' ? curVal : JSON.stringify(curVal));
    const isLongText = !isNum && (displayVal.length > 30 || displayVal.includes('\n'));

    const editHtml = document.createElement('div');
    editHtml.className = 'vu-edit-inline';
    if (isLongText) {
      editHtml.style.alignItems = 'flex-start'; // align buttons to top
      editHtml.innerHTML = `
        <textarea class="vu-edit-input vu-edit-textarea" rows="4">${this._esc(String(displayVal))}</textarea>
        <div style="display:flex; flex-direction:column; gap:6px;">
          <button class="vu-edit-save">✓</button>
          <button class="vu-edit-cancel">✕</button>
        </div>
      `;
    } else {
      editHtml.innerHTML = `
        <input class="vu-edit-input" type="${isNum ? 'number' : 'text'}" value="${this._escAttr(String(displayVal))}" />
        <button class="vu-edit-save">✓</button>
        <button class="vu-edit-cancel">✕</button>
      `;
    }
    row.appendChild(editHtml);

    const input = editHtml.querySelector('.vu-edit-input');
    input.focus();
    if (isNum) input.select();

    const save = () => {
      const raw = input.value.trim();
      if (raw === '') {
        // User cleared the input, treat as delete
        stateManager.update([{ key, op: 'del' }]);
        row.remove();
        editHtml.remove();
        return;
      }
      const newVal = isNum ? Number(raw) : raw;
      if (isNum && isNaN(newVal)) return;
      stateManager.update([{ key, op: '=', value: newVal }]);
      // Update the displayed value
      const valEl = row.querySelector('.vu-val');
      if (valEl) valEl.textContent = isNum ? newVal : String(newVal).slice(0, 40);
      const deltaEl = row.querySelector('.vu-delta');
      if (deltaEl) { deltaEl.textContent = '已修正'; deltaEl.className = 'vu-delta vu-set'; }
      // Store new value on row for future edits
      row.dataset.val = String(newVal);
      editHtml.remove();
    };

    const cancel = () => editHtml.remove();

    editHtml.querySelector('.vu-edit-save').addEventListener('click', save);
    editHtml.querySelector('.vu-edit-cancel').addEventListener('click', cancel);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
  }

  _beautifyVarKey(key) {
    const map = {
      '属性·查克拉': '查克拉上限', '属性·当前查克拉': '查克拉',
      '属性·生命力': '生命力上限', '属性·当前生命力': '生命力',
      '属性·体力': '体力上限', '属性·当前体力': '体力',
      '属性·精神力': '精神力上限', '属性·当前精神力': '精神力',
      '属性·速度': '速度', '属性·幸运': '运势',
      '进度·经验': '历练', '进度·下一级经验': '升级需求',
      '进度·忍术熟练度': '忍术造诣', '进度·体术熟练度': '体术造诣',
      '进度·幻术熟练度': '幻术造诣', '进度·防御熟练度': '防御造诣',
      '进度·金钱': '金钱', '进度·已完成任务': '任务完成',
      '进度·突破待处理': '突破进度',
      '世界·地点': '位置', '世界·时间': '时间', '世界·天气': '天气',
      '世界·已探索区域': '探索区域', '世界·年代': '年代',
      '玩家·忍阶': '忍阶', '玩家·战力等级': '战力',
      '玩家·当前目标': '目标', '玩家·声望标签': '声望',
    };
    if (map[key]) return map[key];

    // Dynamic: 技能·忍术·火遁豪火球·熟练度 → 火遁豪火球 熟练度
    const skillM = key.match(/^技能·(?:忍术|体术|幻术|支援)·(.+)·(.+)$/);
    if (skillM) {
      const fieldMap = { '熟练度': '熟练', '等级': '阶', '威力': '威力', '消耗': '消耗' };
      return `${skillM[1]} ${fieldMap[skillM[2]] || skillM[2]}`;
    }
    const talentM = key.match(/^技能·天赋·(.+)·(.+)$/);
    if (talentM) return `${talentM[1]} ${talentM[2]}`;

    // Dynamic: 物品·消耗品·兵粮丸·数量 → 兵粮丸
    const itemM = key.match(/^物品·(?:道具|消耗品|武器|防具)·(.+)·(.+)$/);
    if (itemM) {
      return `${itemM[1]} ${itemM[2] === '数量' ? '' : itemM[2]}`;
    }

    // Dynamic: 进度·声望·木叶隐村 → 木叶声望
    const repM = key.match(/^进度·声望·(.+)$/);
    if (repM) return `${repM[1]}声望`;

    // Dynamic: 关系·铁火 → 铁火 (人物数据)
    const relM = key.match(/^关系·(.+)$/);
    if (relM) return `[人物] ${relM[1]}`;

    const missionM = key.match(/^任务·(.+)$/);
    if (missionM) return `[任务] ${missionM[1]}`;

    return key.split('·').pop() || key;
  }

  _renderDiceCards(dice) {
    if (!dice || dice.length === 0) return '';
    const names = ['壹', '贰', '叁', '肆', '伍', '陆'];
    // 卦值越低越有利：1-20大吉 → 80-100大凶
    const tiers = [
      { max: 20, label: '大吉', color: '#FFB74D', glow: 'rgba(255,183,77,0.3)' },
      { max: 40, label: '吉',   color: '#81C784', glow: 'rgba(129,199,132,0.25)' },
      { max: 60, label: '平',   color: '#a39f98', glow: 'rgba(163,159,152,0.15)' },
      { max: 80, label: '凶',   color: '#ef5350', glow: 'rgba(239,83,80,0.2)' },
      { max: 100,label: '大凶', color: '#c9171e', glow: 'rgba(201,23,30,0.3)' },
    ];
    const getTier = (v) => tiers.find(t => v <= t.max) || tiers[tiers.length - 1];

    let html = '<div class="dice-cards">';
    html += '<div class="dice-title">卦象 · 本回合命运</div>';
    html += '<div class="dice-grid">';
    for (let i = 0; i < dice.length; i++) {
      const v = dice[i];
      const tier = getTier(v);
      html += `<div class="dice-card" style="--dice-color:${tier.color};--dice-glow:${tier.glow}">
        <span class="dice-name">${names[i]}</span>
        <span class="dice-value" style="color:${tier.color}">${v}</span>
        <span class="dice-tier" style="color:${tier.color}">${tier.label}</span>
      </div>`;
    }
    html += '</div></div>';
    return html;
  }

  _editAIResponse(contentEl, currentText, editBar) {
    const isEditing = contentEl.querySelector('.edit-textarea');
    if (isEditing) return;

    const originalHtml = contentEl.innerHTML;
    const shinobiDaily = contentEl.querySelector('[data-shinobi-daily-host]')?.shinobiDaily || null;
    const textarea = document.createElement('textarea');
    textarea.className = 'edit-textarea';
    textarea.value = currentText;
    textarea.style.cssText = 'width:100%;min-height:200px;background:#070a0e;border:1px solid var(--c-shuiro);border-radius:6px;color:#e8e4d9;font:14px/1.7 var(--font-body);padding:14px;resize:vertical;outline:none;box-sizing:border-box;';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:8px;';
    btnRow.innerHTML = `<button class="btn-save-edit" style="padding:6px 16px;background:var(--c-shuiro);color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:700;">保存</button>
      <button class="btn-cancel-edit" style="padding:6px 16px;background:transparent;color:#a39f98;border:1px solid rgba(232,228,217,0.2);border-radius:4px;cursor:pointer;">取消</button>`;

    contentEl.innerHTML = '';
    contentEl.appendChild(textarea);
    contentEl.appendChild(btnRow);
    editBar.style.display = 'none';

    btnRow.querySelector('.btn-save-edit').addEventListener('click', () => {
      const newText = textarea.value;
      contentEl.innerHTML = this._renderMarkdown(newText);
      const newBar = document.createElement('div');
      newBar.className = 'edit-bar';
      newBar.innerHTML = `<button class="edit-ai-btn">✎ 编辑</button>`;
      newBar.querySelector('.edit-ai-btn').addEventListener('click', () => {
        this._editAIResponse(contentEl, newText, newBar);
      });
      contentEl.appendChild(newBar);
      if (shinobiDaily) {
        const trigger = createShinobiDailyTrigger(shinobiDaily);
        if (trigger) contentEl.appendChild(trigger);
      }
      this._updateNodeResponse(newText);
    });

    btnRow.querySelector('.btn-cancel-edit').addEventListener('click', () => {
      contentEl.innerHTML = originalHtml;
      if (shinobiDaily) {
        contentEl.querySelector('[data-shinobi-daily-host]')?.remove();
        const trigger = createShinobiDailyTrigger(shinobiDaily);
        if (trigger) contentEl.appendChild(trigger);
      }
      editBar.style.display = '';
    });
  }

  async _updateNodeResponse(newText) {
    try {
      const nodeId = stateManager.get('系统·当前节点');
      if (!nodeId) return;
      const node = await stateManager.dbGet('timeline_nodes', nodeId);
      if (node) {
        node.clean_response = newText;
        await stateManager.dbPut('timeline_nodes', node);
      }
    } catch { console.warn('[AppShell] Failed to save game state'); }
  }

  // Turn update is now handled inline in the pipeline:complete event handler

  _updateStatusBar() {
    const loc = this.element.querySelector('#status-location');
    const time = this.element.querySelector('#status-time');
    const weather = this.element.querySelector('#status-weather');
    const turn = this.element.querySelector('#status-turn');
    if (loc) loc.textContent = stateManager.get('世界·地点') || '木叶隐村';
    if (time) {
      time.textContent = formatGameTime(stateManager.get('世界·时间')) || '';
    }
    if (weather) weather.textContent = stateManager.get('世界·天气') || '晴';
    if (turn) turn.textContent = '第 ' + (Number(stateManager.get('系统·回合数')) || 1) + ' 回合';
    const ver = this.element.querySelector('#status-version');
    if (ver && !ver.textContent.includes('.')) {
      // 从缓存的版本号读取，或使用 script src 上的 ?v= 参数
      const scriptEl = document.querySelector('script[src*="app.js?v="]');
      const m = scriptEl?.src.match(/v=(\d+)/);
      ver.textContent = 'v' + (m ? m[1] : 'dev');
      ver.title = '当前版本';
    }
  }

  _updateDicePool(_values) { /* removed from status bar */ }

  async _updateBranchIndicator() {
    const el = this.element?.querySelector('#branch-indicator');
    if (!el) return;
    const branchId = stateManager.get('系统·当前分支') || 'branch_main';
    let branch = null;
    try {
      branch = await stateManager.dbGet?.('timeline_branches', branchId);
    } catch { /* DB may not be ready on first paint */ }
    const name = branch?.name || (branchId === 'branch_main' ? '主线' : branchId.replace(/^branch_/, 'IF·'));
    const color = branch?.color || '#eb613f';
    el.textContent = name;
    el.style.setProperty('--branch-color', color);
    el.hidden = false;
  }

  _renderMarkdown(text) {
    if (!text) return '';

    // AI 正文不是受信任的样式来源；完整丢弃样式块，不把 CSS 带入页面或 document.head。
    let processed = text.replace(/\r\n?/g, '\n').replace(/<style(?:\s[^>]*)?>[\s\S]*?<\/style\s*>/gi, '');

    const guaxiangBlocks = [];
    const divinationPattern = /(?:\*\*)?(?:≈\s*卦象判定\s*≈|【\s*卦象判定\s*】)(?:\*\*)?[ \t]*\n*([\s\S]*?)(?:(?:\*\*)?(?:≈\s*卦终\s*≈|【\s*卦终\s*】)(?:\*\*)?|(?=\n[ \t]*(?:(?:[-*•]|\d+[.、])\s*)?(?:\[\s*行动(?:\s*\d+)?\s*\]|【\s*行动(?:选项)?\s*】))|$)/gi;
    processed = processed.replace(divinationPattern, (match, body) => {
      const lines = String(body || '').split('\n');
      const resultIndex = lines.findIndex(line => /^\s*(?:卦象(?:结果)?|判定结果)\s*[:：]/.test(line));
      let action = '';
      let resultLine = '';
      let narrative = '';
      if (resultIndex >= 0) {
        action = lines.slice(0, resultIndex).join('\n').trim();
        resultLine = lines[resultIndex].replace(/^\s*(?:卦象(?:结果)?|判定结果)\s*[:：]\s*/, '').trim();
        narrative = lines.slice(resultIndex + 1).join('\n').trim();
      } else {
        // 兼容旧存档：单行卦象块或“卦象：”出现在行中而非行首。
        const legacy = String(body || '').match(/^([\s\S]*?)(?:卦象(?:结果)?|判定结果)\s*[:：]([^\n]*)\n?([\s\S]*)$/);
        if (!legacy) return match;
        action = legacy[1].trim();
        resultLine = legacy[2].trim();
        narrative = legacy[3].trim();
      }
      let dice = '卦象';
      let result = resultLine.trim();
      const parts = resultLine.split(/\s*(?:→|->|＞|>)\s*/);
      if (parts.length > 1) {
        dice = parts.shift().trim();
        result = parts.join(' → ').trim();
      }

      // \b 对 CJK 无效（只识别 ASCII 词字符），单字结果需用邻字排除法判断。
      const lone = char => new RegExp(`(?:^|[^\\u4e00-\\u9fff])${char}(?:[^\\u4e00-\\u9fff]|$)`).test(result);
      let resClass = 'normal';
      if (/天命|大吉/.test(result)) resClass = 'epic';
      else if (/瞬身|成功/.test(result) || lone('吉')) resClass = 'success';
      else if (/及第|部分达成/.test(result) || lone('平')) resClass = 'normal';
      else if (/大凶|失败/.test(result)) resClass = 'danger';
      else if (/代偿|警示/.test(result) || lone('凶')) resClass = 'warning';
      else if (/转机|新局势|引出/.test(result)) resClass = 'info';

      const esc = this._esc ? this._esc.bind(this) : (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const actionHtml = action.trim() ? `<div class="d-action">${esc(action.trim()).replace(/\n/g, '<br>')}</div>` : '';
      const narrativeHtml = narrative.trim() ? `<div class="d-narrative">${esc(narrative.trim()).replace(/\n/g, '<br>')}</div>` : '';

      const block = `
        <div class="divination-seal-box ${resClass}">
          <div class="d-content-layer">
            <div class="d-header">
              <span class="d-line"></span>
              <span class="d-title">命运判定</span>
              <span class="d-line"></span>
            </div>
            ${actionHtml}
            <div class="d-result-stamp">
              <div class="d-bg-seal"></div>
              <div class="d-dice-text">${esc(dice)}</div>
              <div class="d-seal-text">${esc(result)}</div>
            </div>
            ${narrativeHtml}
          </div>
        </div>`;
      guaxiangBlocks.push(block);
      return `%%%GUAXIANG_${guaxiangBlocks.length - 1}%%%`;
    });

    let html = this._esc(processed);
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, href) => this._renderSafeLink(label, href));
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>' + '$' + '1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>' + '$' + '1</em>');

    html = html.replace(/(“[^”]+”|「[^」]+」)/g, '<span class="text-dialogue">$&</span>');
    html = html.replace(/（([^）]+)）/g, '<span class="text-thought">（$1）</span>');
    html = html.replace(/『([^』]+)』/g, '<span class="text-thought">『$1』</span>');
    html = html.replace(/~([^~]+)~/g, '<span class="text-thought">~$1~</span>');

    html = html.replace(/\n\n+/g, '</p><p>');
    html = html.replace(/\n/g, '<br>');
    html = '<p>' + html + '</p>';
    html = this._unescapeSafeHtml(html);

    html = html.replace(/<p>\s*%%%GUAXIANG_(\d+)%%%\s*<\/p>/g, '%%%GUAXIANG_$1%%%');
    html = html.replace(/<br>\s*%%%GUAXIANG_(\d+)%%%\s*(?:<br>)?/g, '%%%GUAXIANG_$1%%%');
    html = html.replace(/%%%GUAXIANG_(\d+)%%%/g, (match, id) => guaxiangBlocks[id]);

    const actionButton = (prefix, option) => {
      const cleaned = option.replace(/<\/?(?:strong|em)>/g, '');
      const plain = cleaned.replace(/<[^>]+>/g, '').trim();
      // 裸的「【行动选项】」表头没有正文，保持原文（由下方金色【】规则渲染），
      // 不能生成点击后填入空白的无字按钮。
      if (!plain) return null;
      return `${prefix}<button class="action-option" data-action="${this._escAttr(plain)}">
                <span class="action-option__icon">忍</span>
                <span class="action-option__text">${cleaned.trim()}</span>
              </button>`;
    };

    html = html.replace(/(^|<br>|<p>)\s*(?:(?:[-*•]|\d+[.、])\s*)?(?:<strong>|<em>)?\s*(?:\[\s*行动(?:\s*\d+)?\s*\]|【\s*行动(?:选项)?\s*】)\s*(.*?)(?=<br>|<\/p>|$)/g,
      (match, prefix, option) => actionButton(prefix, option) ?? match);

    // 兼容旧存档：老正则不要求行首锚定，行中出现的 [行动] 也曾渲染为按钮。
    html = html.replace(/\[\s*行动(?:\s*\d+)?\s*\]\s*(.*?)(?=<br>|<\/p>|$)/g,
      (match, option) => actionButton('', option) ?? match);

    // 兼容旧存档的选项格式，允许末尾句号但防止跨越多重引号匹配，忽略被前面正则添加的对话span
    html = html.replace(/(^|<br>|<p>)\s*(?:(?:[-*•]|\d+[.、])\s*)?(?:<span class="text-dialogue">)?「([^「」]+)」(?:<\/span>)?\s*[。.．]?\s*(?=<br>|<\/p>|$)/g, (match, prefix, option) => {
      const plain = option.replace(/<[^>]+>/g, '');
      return `${prefix}<button class="action-option" data-action="${this._escAttr(plain.trim())}">
                <span class="action-option__icon">忍</span>
                <span class="action-option__text">${option.trim()}</span>
              </button>`;
    });

    html = html.replace(/(?![^<]*>)【(.+?)】/g, (match, content) => '<span style="color:var(--c-kin);font-size:12px;font-family:var(--font-title);">【' + content + '】</span>');

    return html;
  }

  _unescapeSafeHtml(html) {
    const safeTags = ['div', 'details', 'summary', 'span'];
    for (const tag of safeTags) {
      const openRe = new RegExp(`&lt;${tag}(\\s[^&]*)?&gt;`, 'gi');
      const closeRe = new RegExp(`&lt;/${tag}&gt;`, 'gi');
      html = html.replace(openRe, (m) => `<${tag}${this._sanitizeAttrs(m.slice(5 + tag.length, -4))}>`);
      html = html.replace(closeRe, `</${tag}>`);
    }
    html = html.replace(/&lt;style[^&]*&gt;[\s\S]*?&lt;\/style&gt;/gi, '');
    return html;
  }

  _sanitizeAttrs(_attrString) {
    // AI 原始标签只保留结构；任何属性都可能复用应用现有 CSS/行为形成旁路。
    return '';
  }

  _esc(str) {
    return escHtml(str);
  }

  _renderSafeLink(label, href) {
    const decoded = this._decodeHtml(String(href || '').trim());
    if (!/^(https?:|mailto:)/i.test(decoded)) return label;
    return `<a href="${this._escAttr(decoded)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }

  _decodeHtml(value) {
    const d = document.createElement('textarea');
    d.innerHTML = value;
    return d.value;
  }

  _escAttr(value) {
    return escAttr(value);
  }

  _scroll() {
    const scroller = this.element.querySelector('.chat-container');
    if (scroller) requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
  }

  /* 网页全屏：用 CSS 把 #app 撑满视口，隐藏顶栏/状态栏/侧栏（不依赖浏览器 Fullscreen API） */
  _toggleZenMode() {
    const app = this.element.closest('#app') || this.element;
    if (!app) return;
    const isZen = (this.element ? (this.element.closest('#app') || document.body) : document.body).classList.toggle('web-fullscreen');
    this.element.querySelector('#btn-zen')?.setAttribute('aria-pressed', String(isZen));
    if (isZen) {
      // 保存旧样式
      this._savedAppStyle = app.style.cssText;
      app.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999;border:none;border-radius:0;';
      this._closeMobileDrawers();
    } else {
      // 恢复旧样式
      app.style.cssText = this._savedAppStyle || '';
    }
  }

  /* 屏幕全屏：调用浏览器原生全屏 API（含 webkit/ms 兼容） + 隐藏游戏顶栏 */
  _toggleFullscreen() {
    const el = document.documentElement;
    const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement;

    if (!isFullscreen) {
      // 如果当前处于网页全屏，先退出
      if ((this.element ? (this.element.closest('#app') || document.body) : document.body).classList.contains('web-fullscreen')) {
        this._toggleZenMode();
      }
      const rfs = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
      if (rfs) {
        rfs.call(el).then(() => {
          document.body.classList.add('immersive-fullscreen');
          this._closeMobileDrawers();

          const sidebar = this.element.querySelector('#app-sidebar');
          if (sidebar && !sidebar.classList.contains('app-sidebar--collapsed')) {
            this._toggleSidebar();
          }
          const panel = this.element.querySelector('#app-panel');
          if (panel && !panel.classList.contains('app-panel--collapsed') && !panel.classList.contains('panel-open')) {
            this._togglePanel();
          }

          this.element.querySelector('#btn-fullscreen')?.setAttribute('aria-pressed', 'true');
        }).catch(err => {
          console.warn('[AppShell] 屏幕全屏失败:', err.message);
          this._showToast('全屏失败，浏览器可能不支持');
        });
      }
    } else {
      document.body.classList.remove('immersive-fullscreen');
      const efs = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
      if (efs) efs.call(document);
      this.element.querySelector('#btn-fullscreen')?.setAttribute('aria-pressed', 'false');
    }
  }

  _toggleMobileView() {
    const isForced = (this.element ? (this.element.closest('#app') || document.body) : document.body).classList.toggle('is-mobile-forced');
    this.element.querySelector('#btn-mobile')?.setAttribute('aria-pressed', String(isForced));
    this._syncResponsiveState();
  }

  _togglePanel() {
    this._toggleRightPanel('info');
  }

  openInfoPanel(tab = 'attributes') {
    const multiplayerPanel = this.element?.querySelector('#multiplayer-character-panel');
    const panel = this._multiplayerSessionState ? multiplayerPanel : this.element?.querySelector('#info-panel');
    if (!panel) return { opened: false, area: 'info-panel', tab };
    const result = typeof panel.openTab === 'function'
      ? panel.openTab(tab)
      : { opened: true, area: 'info-panel', tab };
    this._setRightPanelMode('info');
    const appRoot = this.element.closest('#app') || document.body;
    const isMobile = window.matchMedia('(max-width: 768px)').matches
      || appRoot.classList.contains('is-mobile-forced');
    this._openRightPanel(isMobile);
    return result;
  }

  openTimeline() {
    const sidebar = this.element?.querySelector('#app-sidebar');
    if (!sidebar) return { opened: false, area: 'timeline' };
    const appRoot = this.element.closest('#app') || document.body;
    const isMobile = window.matchMedia('(max-width: 768px)').matches
      || appRoot.classList.contains('is-mobile-forced');
    sidebar.classList.remove('app-sidebar--collapsed');
    sidebar.setAttribute('aria-hidden', 'false');
    this.element.querySelector('#btn-timeline')?.setAttribute('aria-pressed', 'true');
    if (isMobile) this._closeRightPanel();
    this._syncMobileScrim();
    return { opened: true, area: 'timeline' };
  }

  openMap() {
    let map = document.querySelector('map-modal');
    if (!map) {
      map = document.createElement('map-modal');
      (this.element ? (this.element.closest('#app') || document.body) : document.body).appendChild(map);
    }
    return { opened: Boolean(map?.isConnected), area: 'map' };
  }

  async _toggleDeveloperPanel() {
    if (!customElements.get('developer-panel')) {
      try { await import('./developer-panel.js'); }
      catch (e) { console.error('[DeveloperPanel] load failed:', e); this._showToast('提示词查看加载失败'); return; }
    }
    this._toggleRightPanel('developer');
  }

  _toggleRightPanel(mode) {
    const panel = this.element.querySelector('#app-panel');
    if (!panel) return;
    const isMobile = window.matchMedia('(max-width: 768px)').matches || (this.element ? (this.element.closest('#app') || document.body) : document.body).classList.contains('is-mobile-forced');
    const currentMode = panel.dataset.mode || 'info';
    const isOpen = isMobile ? panel.classList.contains('panel-open') : !panel.classList.contains('app-panel--collapsed');

    if (isOpen && currentMode === mode) {
      this._closeRightPanel();
      return;
    }

    this._setRightPanelMode(mode);
    this._openRightPanel(isMobile);
  }

  _setRightPanelMode(mode) {
    const panel = this.element?.querySelector('#app-panel');
    if (!panel) return;
    panel.dataset.mode = mode;
    const info = panel.querySelector('#info-panel');
    const multiplayerInfo = panel.querySelector('#multiplayer-character-panel');
    const dev = panel.querySelector('#developer-panel');
    const multiplayerActive = Boolean(this._multiplayerSessionState);
    if (info) info.style.display = mode === 'developer' || multiplayerActive ? 'none' : '';
    if (multiplayerInfo) {
      multiplayerInfo.hidden = mode === 'developer' || !multiplayerActive;
      multiplayerInfo.style.display = mode === 'developer' || !multiplayerActive ? 'none' : '';
    }
    if (dev) dev.style.display = mode === 'developer' ? '' : 'none';
    this._syncRightPanelButtons();
  }

  _openRightPanel(isMobile = window.matchMedia('(max-width: 768px)').matches) {
    const panel = this.element?.querySelector('#app-panel');
    if (!panel) return;
    panel.classList.remove('app-panel--collapsed');
    panel.setAttribute('aria-hidden', 'false');
    if (isMobile) {
      panel.classList.add('panel-open');
      const sidebar = this.element.querySelector('#app-sidebar');
      const timelineBtn = this.element.querySelector('#btn-timeline');
      sidebar?.classList.add('app-sidebar--collapsed');
      sidebar?.setAttribute('aria-hidden', 'true');
      timelineBtn?.setAttribute('aria-pressed', 'false');
      this._syncMobileScrim();
    } else {
      panel.classList.remove('panel-open');
    }
    this._syncRightPanelButtons();
  }

  _closeRightPanel() {
    const panel = this.element?.querySelector('#app-panel');
    if (!panel) return;
    panel.classList.remove('panel-open');
    panel.classList.add('app-panel--collapsed');
    panel.setAttribute('aria-hidden', 'true');
    this._syncRightPanelButtons();
    this._syncMobileScrim();
  }

  _syncRightPanelButtons() {
    const panel = this.element?.querySelector('#app-panel');
    const mode = panel?.dataset.mode || 'info';
    const isOpen = Boolean(panel && (panel.classList.contains('panel-open') || !panel.classList.contains('app-panel--collapsed')));
    this.element?.querySelector('#btn-panel')?.setAttribute('aria-pressed', String(isOpen && mode !== 'developer'));
    this.element?.querySelector('#btn-developer')?.setAttribute('aria-pressed', String(isOpen && mode === 'developer'));
  }

  _toggleSidebar() {
    const sidebar = this.element.querySelector('#app-sidebar');
    const btn = this.element.querySelector('#btn-timeline');
    const isMobile = window.matchMedia('(max-width: 768px)').matches || (this.element ? (this.element.closest('#app') || document.body) : document.body).classList.contains('is-mobile-forced');
    const isCollapsed = sidebar.classList.toggle('app-sidebar--collapsed');
    sidebar.setAttribute('aria-hidden', String(isCollapsed));
    btn?.setAttribute('aria-pressed', String(!isCollapsed));
    if (isMobile && !isCollapsed) {
      const panel = this.element.querySelector('#app-panel');
      const panelBtn = this.element.querySelector('#btn-panel');
      const developerBtn = this.element.querySelector('#btn-developer');
      panel?.classList.remove('panel-open');
      panel?.classList.add('app-panel--collapsed');
      panelBtn?.setAttribute('aria-pressed', 'false');
      developerBtn?.setAttribute('aria-pressed', 'false');
    }
    this._syncMobileScrim();
  }

  _syncResponsiveState() {
    if (!this.element) return;
    const panel = this.element.querySelector('#app-panel');
    const sidebar = this.element.querySelector('#app-sidebar');
    const timelineBtn = this.element.querySelector('#btn-timeline');
    const isMobile = window.matchMedia('(max-width: 768px)').matches || (this.element ? (this.element.closest('#app') || document.body) : document.body).classList.contains('is-mobile-forced');

    (this.element ? (this.element.closest('#app') || document.body) : document.body).classList.toggle('is-mobile-view', isMobile);

    if (isMobile) {
      if (panel && !panel.classList.contains('app-panel--collapsed')) {
        panel.classList.add('panel-open');
      }
      this._syncRightPanelButtons();
    } else if (panel) {
      if (panel.classList.contains('panel-open')) {
        panel.classList.remove('app-panel--collapsed');
      }
      panel.classList.remove('panel-open');
      this._syncRightPanelButtons();
    }

    timelineBtn?.setAttribute('aria-pressed', String(!sidebar?.classList.contains('app-sidebar--collapsed')));
    this._syncMobileScrim();
    this._syncFullscreenState();
  }

  _debouncedResponsiveSync() {
    window.clearTimeout(this._resizeTimer);
    this._resizeTimer = window.setTimeout(() => this._syncResponsiveState(), 160);
  }

  _syncFullscreenState() {
    const isFs = document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement;
    const target = this.element ? (this.element.closest('#app') || document.body) : document.body;
    target.classList.toggle('immersive-fullscreen', !!isFs);
    this.element?.querySelector('#btn-fullscreen')?.setAttribute('aria-pressed', String(!!isFs));
  }

  _closeMobileDrawers() {
    const panel = this.element?.querySelector('#app-panel');
    const sidebar = this.element?.querySelector('#app-sidebar');
    const panelBtn = this.element?.querySelector('#btn-panel');
    const developerBtn = this.element?.querySelector('#btn-developer');
    const timelineBtn = this.element?.querySelector('#btn-timeline');
    panel?.classList.remove('panel-open');
    panel?.classList.add('app-panel--collapsed');
    sidebar?.classList.add('app-sidebar--collapsed');
    sidebar?.setAttribute('aria-hidden', 'true');
    panelBtn?.setAttribute('aria-pressed', 'false');
    developerBtn?.setAttribute('aria-pressed', 'false');
    timelineBtn?.setAttribute('aria-pressed', 'false');
    this._syncMobileScrim();
  }

  _syncMobileScrim() {
    const scrim = this.element?.querySelector('#mobile-scrim');
    if (!scrim) return;
    const isMobile = window.matchMedia('(max-width: 768px)').matches || (this.element ? (this.element.closest('#app') || document.body) : document.body).classList.contains('is-mobile-forced');
    const panelOpen = this.element?.querySelector('#app-panel')?.classList.contains('panel-open');
    const timelineOpen = !this.element?.querySelector('#app-sidebar')?.classList.contains('app-sidebar--collapsed');
    scrim.classList.toggle('is-visible', Boolean(isMobile && (panelOpen || timelineOpen)));
  }

  showAPIForm({ fromSettings = false } = {}) {
    this.element.classList.add('app-shell--setup');
    const center = this.element.querySelector('#app-center');
    const container = center.querySelector('.chat-container');
    const inputArea = center.querySelector('#chat-input-area');
    center.classList.add('app-center--setup');
    inputArea.style.display = 'none';
    const saved = stateManager.getAPIConfig() || {};

    container.innerHTML = `
      <div class="api-setup">
        <div class="api-layout">
          <section class="api-hero" aria-label="开局引导">
            <div class="api-setup-title${isNativeAndroidApp() ? ' api-setup-title--app' : ''}"><img src="${isNativeAndroidApp() ? '/img/app-mark.png' : '/img/logo.png'}" class="${isNativeAndroidApp() ? 'app-brand-mark' : 'logo-image-large'}" alt="忍者手记">${isNativeAndroidApp() ? '<h1 class="app-brand-name">忍者手记</h1>' : ''}</div>
            <div class="api-setup-subtitle">${fromSettings ? '重新校准通灵契约，切换叙事核心与模型' : isNativeAndroidApp() ? '写下属于你的忍者故事' : '从火影之路开始，感受火之意志和爱与羁绊的力量'}</div>
            <div class="api-feature-row">
              <span>自动时间线</span>
              <span>模型自选</span>
              <span>流式叙事</span>
              <span>战斗判定</span>
            </div>
            <div class="api-hero-panel">
              <div class="api-hero-line"><strong>世界状态</strong><span>默认木叶48年 · 可随存档/选择切换</span></div>
              <div class="api-hero-line"><strong>叙事预设</strong><span>Narutomech Alpha-1003 · 主预设统一管理</span></div>
              <div class="api-hero-line"><strong>存档方式</strong><span>IndexedDB 本地时间线</span></div>
              <div class="api-hero-line"><strong>开局流程</strong><span>连接模型 → 创建角色 → 入学试炼</span></div>
            </div>
            <div class="import-card">
              <div>
                <strong>异地续写</strong>
                <span>导入旧 JSON / gzip 到存档库，保留原进度后选择读取</span>
              </div>
              <button type="button" class="btn btn-secondary btn-sm" id="btn-import-save">导入存档</button>
              <input type="file" id="timeline-import-file" accept="${TIMELINE_FILE_ACCEPT}" hidden />
            </div>
          </section>

          <form class="api-setup-form" id="api-setup-form">
          <div class="api-form-heading">
            <span>契约卷轴</span>
            <small id="model-status">填写地址后可读取模型</small>
          </div>
          <div class="card">
            <api-config-form config='${this._escAttr(JSON.stringify(saved))}' show-advanced show-schemes></api-config-form>
            <div class="api-setup-security" style="margin-top: 20px;">
              ${icon('lock', 14)}
              <span>你的印记仅存储在本地，不会外传</span>
            </div>
            <button type="submit" class="btn btn-primary" style="width:100%;letter-spacing:3px;margin-top: 14px;">${fromSettings ? '保存契约' : '缔结契约'}</button>
          </div>
          </form>
        </div>
      </div>
    `;

    const form = container.querySelector('#api-setup-form');
    const importBtn = container.querySelector('#btn-import-save');
    const importFile = container.querySelector('#timeline-import-file');
    const apiConfigForm = container.querySelector('api-config-form');

    importBtn?.addEventListener('click', () => importFile?.click());
    importFile?.addEventListener('change', () => {
      const file = importFile.files?.[0];
      if (!file) return;
      eventBus.emit('app:timeline-import-file', { file });
      importFile.value = '';
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const config = apiConfigForm.getConfig();
      if (!config) {
        this._showToast('请填写完整的 API 信息 (包括模型名称)');
        return;
      }
      eventBus.emit('app:api-config', config);
    });
  }

  showCharacterCreator() {
    this.element.classList.add('app-shell--setup');
    const center = this.element.querySelector('#app-center');
    const container = center.querySelector('.chat-container');
    const inputArea = center.querySelector('#chat-input-area');
    center.classList.add('app-center--setup');
    inputArea.style.display = 'none';
    container.innerHTML = '';
    const creator = document.createElement('character-creator');
    container.appendChild(creator);
  }

  _showGame() {
    this.element.classList.remove('app-shell--setup');
    const center = this.element.querySelector('#app-center');
    const container = center.querySelector('.chat-container');
    center.classList.remove('app-center--setup');
    container.innerHTML = '<div class="chat-messages" id="chat-messages"></div>';
    const inputArea = center.querySelector('#chat-input-area');
    inputArea.style.display = 'flex';
    this._updateStatusBar();
  }

  showGame() {
    this._showGame();
  }

  setMultiplayerSessionState(state) {
    this._multiplayerSessionState = state?.room?.lifecycle === 'ACTIVE' ? state : null;
    const active = Boolean(this._multiplayerSessionState);
    this.element?.classList.toggle('app-shell--multiplayer', active);
    const topButton = this.element?.querySelector('#btn-multiplayer');
    const panelButton = this.element?.querySelector('#btn-panel');
    const multiplayerInfo = this.element?.querySelector('#multiplayer-character-panel');
    topButton?.setAttribute('aria-pressed', String(active));
    if (topButton) topButton.title = active ? '联机进行中 · 打开状态悬浮窗' : '双人联机';
    if (panelButton) panelButton.title = active ? '我的联机角色' : '角色面板';
    multiplayerInfo?.setSessionState?.(this._multiplayerSessionState);
    this._setRightPanelMode(this.element?.querySelector('#app-panel')?.dataset.mode || 'info');
    const textarea = this.element?.querySelector('#chat-input');
    const sendButton = this.element?.querySelector('#btn-send');
    if (!active) {
      if (textarea && !this._isProcessing && !this._isSubmitting) textarea.disabled = false;
      if (textarea) textarea.placeholder = '提笔写下你的决断...';
      if (sendButton && !this._isProcessing && !this._isSubmitting) sendButton.disabled = false;
      return;
    }
    const value = this._multiplayerSessionState;
    const seat = value.room.viewer_seat;
    const turn = value.turn;
    const otherSeat = seat === 'A' ? 'B' : 'A';
    const other = turn?.actions?.[otherSeat];
    const canSubmit = canSubmitProjectedAction(value);
    const unavailableMessage = actionSubmissionUnavailableMessage(value);
    if (textarea) {
      textarea.disabled = !canSubmit || this._isProcessing || this._isSubmitting;
      textarea.placeholder = canSubmit
        ? (other?.locked ? '对方已发送行动，写下你的决断…' : '写下本回合联机行动…')
        : unavailableMessage;
    }
    if (sendButton) {
      sendButton.disabled = !canSubmit || this._isProcessing || this._isSubmitting;
      sendButton.title = canSubmit ? '发送并锁定联机行动' : unavailableMessage;
    }
    const turnStatus = this.element?.querySelector('#status-turn');
    if (turnStatus && turn?.turn_no) turnStatus.textContent = `联机 · 第 ${turn.turn_no} 回合`;
  }

  getShell() { return this.element; }

  _showDeathScreen(cause, alreadyDead) {
    this._setProcessing(false);
    const inputArea = this.element?.querySelector('#chat-input-area');
    if (inputArea) { inputArea.style.display = 'none'; }
    const sendBtn = this.element?.querySelector('#btn-send');
    if (sendBtn) sendBtn.disabled = true;

    const msgs = this.element?.querySelector('#chat-messages');
    if (!msgs) return;
    const div = document.createElement('div');
    div.className = 'chat-message chat-message--system';
    div.innerHTML = `<div style="text-align:center;padding:40px 20px;margin:20px 0;background:rgba(239,83,80,0.06);border:2px solid rgba(239,83,80,0.3);border-radius:12px;">
      <div style="font-size:48px;margin-bottom:16px;">忍</div>
      <div style="font-size:20px;font-weight:800;color:#ef5350;letter-spacing:4px;margin-bottom:12px;">忍者之道，止于此处</div>
      <div style="font-size:13px;color:#a39f98;margin-bottom:8px;">死因：${this._esc(cause || '不明')}</div>
      <div style="font-size:11px;color:rgba(163,159,152,0.5);margin-bottom:20px;">${alreadyDead ? '你已倒下，无法继续行动。' : '你的查克拉消散，生命之火熄灭。'}</div>
      <button class="restart-btn" style="background:rgba(239,83,80,0.15);border:1px solid rgba(239,83,80,0.5);color:#ef5350;padding:8px 24px;border-radius:6px;font-size:14px;cursor:pointer;letter-spacing:2px;">重新开始</button>
    </div>`;
    div.querySelector('.restart-btn')?.addEventListener('click', () => {
      eventBus.emit('app:reset');
    });
    msgs.appendChild(div);
    this._scroll();
  }
}
export const appShell = new AppShell();
