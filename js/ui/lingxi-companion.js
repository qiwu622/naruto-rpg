import { lingXiCompanionStyles } from '../../css/components/lingxi-companion.css.js';
import { lingXiController } from '../core/lingxi/lingxi-controller.js';
import {
  captureTrustedApprovalActivation,
  registerTrustedApprovalSubmit
} from '../core/lingxi/approval-broker.js';
import { eventBus } from '../core/event-bus.js';
import { icon } from '../utils/icons.js';

const QUICK_ACTIONS = Object.freeze([
  '这个项目要怎么开始玩？',
  '检查我当前的查克拉变量',
  '解释变量系统和常见修复方式',
  '怎么编写世界书条目？'
]);

const PET_IMAGES = Object.freeze({
  idle: '/img/lingxi/idle.webp',
  listening: '/img/lingxi/listening.webp',
  thinking: '/img/lingxi/listening.webp',
  working: '/img/lingxi/working.webp',
  error: '/img/lingxi/working.webp',
  sleeping: '/img/lingxi/sleeping.webp'
});

const POSITION_STORAGE_KEY = 'naruto_lingxi_position_v1';
const PANEL_POSITION_STORAGE_KEY = 'naruto_lingxi_panel_position_v1';
const MAX_ACTIVITY_EVENTS = 32;
const TOOL_LABELS = Object.freeze({
  search_project_guide: '查找项目说明',
  inspect_cloud_saves: '读取云存档列表',
  inspect_current_state: '读取当前状态',
  inspect_project_state: '读取项目状态',
  inspect_variable: '检查当前变量',
  inspect_settings: '读取设置摘要',
  search_music: '搜索音乐',
  inspect_music_player: '读取播放器状态',
  open_music: '打开音乐',
  control_music: '控制播放器',
  inspect_opening_draft: '读取开局草稿',
  search_worldbook: '检索世界书',
  inspect_story_plan: '读取剧情计划',
  inspect_image_settings: '读取绘图设置',
  inspect_image_gallery: '读取图库',
  inspect_image_target: '读取图片目标',
  open_settings: '打开设置',
  open_image_studio: '打开画面工坊',
  open_profile: '打开个人中心',
  open_workspace: '打开项目工作区',
  stage_variable_change: '准备变量修改',
  stage_settings_change: '准备设置修改',
  stage_opening_draft: '准备开局方案',
  stage_worldbook_entry: '准备世界书条目',
  stage_story_direction: '准备剧情方向',
  stage_equipment_action: '准备装备或物品操作',
  stage_mission_action: '准备任务结算',
  stage_player_action: '准备普通玩家行动',
  stage_combat_action: '准备战斗动作',
  stage_timeline_action: '准备时间线操作',
  stage_image_generation: '准备图片生成',
  stage_image_library_action: '准备图库操作',
  stage_cloud_save_action: '准备云存档操作'
});

const ACTION_IMPACT_TITLES = Object.freeze({
  settings: '设置影响',
  opening: '开局影响',
  worldbook: '世界书影响',
  story: '剧情方向影响',
  equipment: '装备与物品影响',
  mission: '任务结算影响',
  gameplay: '剧情回合影响',
  combat: '战斗与时间线影响',
  timeline: '时间线操作影响',
  image: '图片生成影响',
  'image-library': '图库操作影响',
  'cloud-save': '云存档影响'
});

const MODAL_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

function displayValue(value) {
  if (value === undefined) return '未定义';
  if (typeof value === 'string') return value || '空字符串';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function displayPath(path) {
  return String(path || '/')
    .replace(/^\//, '')
    .split('/')
    .map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .join(' · ') || '状态根';
}

function appendInlineMarkdown(parent, source) {
  const text = String(source || '');
  const pattern = /(\*\*([^*\n]+)\*\*|`([^`\n]+)`|\*([^*\n]+)\*)/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) parent.appendChild(document.createTextNode(text.slice(cursor, match.index)));
    const element = document.createElement(match[2] !== undefined ? 'strong' : match[3] !== undefined ? 'code' : 'em');
    element.textContent = match[2] ?? match[3] ?? match[4] ?? '';
    parent.appendChild(element);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parent.appendChild(document.createTextNode(text.slice(cursor)));
}

function renderMarkdown(container, source) {
  container.replaceChildren();
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  let list = null;
  let listType = '';
  let code = null;

  const closeList = () => { list = null; listType = ''; };
  const appendCode = () => {
    if (!code) return;
    const pre = document.createElement('pre');
    const codeElement = document.createElement('code');
    codeElement.textContent = code.join('\n');
    pre.appendChild(codeElement);
    container.appendChild(pre);
    code = null;
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      closeList();
      if (code) appendCode();
      else code = [];
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = line.match(/^\s*#{1,4}\s+(.+)$/);
    if (heading) {
      closeList();
      const element = document.createElement('h3');
      appendInlineMarkdown(element, heading[1]);
      container.appendChild(element);
      continue;
    }
    const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)、]\s+(.+)$/);
    if (unordered || ordered) {
      const nextType = ordered ? 'ol' : 'ul';
      if (!list || listType !== nextType) {
        closeList();
        listType = nextType;
        list = document.createElement(nextType);
        container.appendChild(list);
      }
      const item = document.createElement('li');
      appendInlineMarkdown(item, (ordered || unordered)[1]);
      list.appendChild(item);
      continue;
    }
    closeList();
    const quote = line.match(/^\s*>\s?(.*)$/);
    const element = document.createElement(quote ? 'blockquote' : 'p');
    appendInlineMarkdown(element, quote ? quote[1] : line);
    container.appendChild(element);
  }
  appendCode();
}

function normalizeActivity(event = {}) {
  const detail = event.detail && typeof event.detail === 'object' ? event.detail : {};
  const rawStep = detail.step ?? event.step;
  const step = Number.isInteger(Number(rawStep)) ? Math.max(0, Number(rawStep)) : null;
  return {
    type: String(event.type || '').slice(0, 60),
    tool: String(event.tool || '').slice(0, 100),
    success: typeof event.success === 'boolean' ? event.success : null,
    durationMs: Number.isFinite(event.durationMs) ? Math.max(0, Math.round(event.durationMs)) : null,
    detail: {
      mode: String(detail.mode || '').slice(0, 60),
      step
    }
  };
}

function describeProposalImpact(proposal) {
  const timeline = proposal?.context?.timelineImpact;
  const hasTimelineImpact = timeline?.operation === 'create-maintenance-checkpoint'
    && typeof timeline.parentNodeId === 'string'
    && typeof timeline.activeBranchId === 'string'
    && timeline.createsIfBranch === false
    && timeline.createsTurn === false
    && timeline.updatesNode === true;
  if (hasTimelineImpact) {
    return {
      valid: true,
      title: '时间线影响',
      primary: `更新当前回合存档详情（节点 ${timeline.parentNodeId}），不创建新回合或分支。`,
      secondary: `维护记录将原地附加到节点 ${timeline.parentNodeId}（分支 ${timeline.activeBranchId}）。`
    };
  }

  const impact = proposal?.context?.actionImpact;
  const kind = String(impact?.kind || '').trim();
  const summary = String(impact?.summary || '').trim();
  const valid = impact?.schema === 'naruto.lingxi-action-impact/v1'
    && ['settings', 'opening', 'worldbook', 'story', 'equipment', 'mission', 'gameplay', 'combat', 'timeline', 'image', 'image-library', 'cloud-save'].includes(kind)
    && summary.length > 0;
  const details = Array.isArray(impact?.details)
    ? impact.details.map(item => String(item || '').trim()).filter(Boolean).slice(0, 6)
    : [];
  return {
    valid,
    title: ACTION_IMPACT_TITLES[kind] || '写入影响',
    primary: valid ? summary : '写入影响未绑定，这份提案不能执行。',
    secondary: valid ? details.join('\n') : ''
  };
}

function activityLabel(event) {
  const tool = TOOL_LABELS[event.tool] || event.tool || '项目工具';
  if (event.type === 'context-search-start') return '正在读取项目与当前状态';
  if (event.type === 'context-search-end') return event.success === false ? '读取上下文失败' : '已读取项目与当前状态';
  if (event.type === 'agent-start') return '正在安排处理步骤';
  if (event.type === 'step-start') return event.detail?.step !== null
    ? `开始第 ${event.detail.step + 1} 步`
    : '开始下一步';
  if (event.type === 'step-end') return '这一步处理完成';
  if (event.type === 'tool-start') return `正在${tool}`;
  if (event.type === 'tool-end') return event.success === false ? `${tool}失败` : `${tool}完成`;
  if (event.type === 'agent-fallback') return '正在切换兼容连接方式';
  if (event.type === 'agent-end') return event.success === false ? '本轮处理没有完成' : '调用流程完成';
  return '正在处理';
}

class LingXiCompanion extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.controller = lingXiController;
    this._open = false;
    this._busy = false;
    this._proposal = null;
    this._approvalProposal = null;
    this._approvalActivationEvidence = null;
    this._receipt = null;
    this._newChatReturnFocus = null;
    this._errorMessage = '';
    this._unsubs = [];
    this._sleepTimer = null;
    this._liveActivity = [];
    this._streamText = '';
    this._renderFrame = null;
    this._drag = null;
    this._panelDrag = null;
    this._suppressClick = false;
    this._onDragMove = event => this._moveDrag(event);
    this._onDragEnd = event => this._endDrag(event);
    this._onPanelDragMove = event => this._movePanelDrag(event);
    this._onPanelDragEnd = event => this._endPanelDrag(event);
    this._onViewportResize = () => {
      this._restorePosition({ clampOnly: true });
      this._positionPanel();
    };
  }

  connectedCallback() {
    if (this._connected) return;
    this._connected = true;
    if (!this._initialized) {
      this._render();
      this._bind();
      this._initialized = true;
    }
    this._subscribe();
    this._restorePosition();
    void this._refreshApiChoices();
    this._renderMessages();
    this._syncBusyState();
    document.body.classList.toggle('lingxi-companion-open', this._open);
    if (this._open) this._positionPanel();
    this._resetSleepTimer();
    globalThis.addEventListener?.('resize', this._onViewportResize);
  }

  disconnectedCallback() {
    this._connected = false;
    this._unsubs.forEach(unsub => unsub?.());
    this._unsubs = [];
    clearTimeout(this._sleepTimer);
    if (this._renderFrame) cancelAnimationFrame(this._renderFrame);
    this._renderFrame = null;
    this._removeDragListeners();
    this._removePanelDragListeners();
    this._drag = null;
    this._panelDrag = null;
    globalThis.removeEventListener?.('resize', this._onViewportResize);
    document.body.classList.remove('lingxi-companion-open');
  }

  _render() {
    this.shadowRoot.innerHTML = `
      <style>${lingXiCompanionStyles}</style>
      <div class="dock">
        <button class="pet-button" type="button" data-state="idle" aria-expanded="false" aria-controls="lingxi-panel" title="与灵希对话">
          <img class="pet-image" src="${PET_IMAGES.idle}" alt="灵希桌宠" draggable="false">
          <span class="pet-name">灵希 · 听风</span>
          <span class="pet-signal" aria-hidden="true"></span>
        </button>

        <section class="panel" id="lingxi-panel" role="dialog" aria-label="灵希助手" hidden>
          <header class="panel-header">
            <button class="profile-button" type="button" title="查看灵希档案" aria-label="查看灵希档案">
              <img src="/img/lingxi/avatar.webp" alt="">
            </button>
            <div class="identity"><strong>灵希</strong><span>听风之灵 · 特别上忍</span></div>
            <div class="header-actions">
              <button class="icon-button settings-button" type="button" title="AI 连接设置" aria-label="打开 AI 连接设置">${icon('settings', 18)}</button>
              <button class="icon-button clear-button" type="button" title="新建对话" aria-label="新建灵希对话">${icon('file-text', 18)}</button>
              <button class="icon-button close-button" type="button" title="收起灵希" aria-label="收起灵希">${icon('close', 19)}</button>
            </div>
          </header>

          <label class="api-choice">
            <span>灵希模型</span>
            <select class="api-choice-select" aria-label="选择灵希使用的 API 方案">
              <option value="main">跟随主 API</option>
            </select>
          </label>

          <div class="messages" role="log" aria-live="polite" aria-relevant="additions text"></div>

          <div class="proposal-band" hidden>
            <div class="proposal-copy"><strong>差异卷轴待确认</strong><span class="proposal-summary"></span></div>
            <button class="proposal-review" type="button">${icon('check', 15)}审阅</button>
          </div>

          <div>
            <div class="quick-actions" aria-label="常用问题">
              ${QUICK_ACTIONS.map((label, index) => `<button class="quick-action" type="button" data-index="${index}">${label}</button>`).join('')}
            </div>
            <form class="composer">
              <textarea rows="1" maxlength="12000" placeholder="问问灵希……" aria-label="发送给灵希的消息"></textarea>
              <button class="icon-button composer-send" type="submit" title="发送" aria-label="发送给灵希">${icon('send', 18)}</button>
            </form>
          </div>
        </section>

        <div class="approval-overlay" hidden>
          <form class="approval-dialog" role="dialog" aria-modal="true" aria-labelledby="lingxi-approval-title" tabindex="-1">
            <header class="approval-head">
              <strong id="lingxi-approval-title">灵希 · 修改审批</strong>
              <button class="icon-button approval-close" type="button" title="拒绝并关闭" aria-label="拒绝并关闭">${icon('close', 18)}</button>
            </header>
            <div class="approval-body">
              <p class="approval-note">请逐项核对旧值、新值和实际写入影响。本次批准只绑定这份提案；目标数据变化、超时或关闭窗口都会使它失效。</p>
              <section class="approval-impact" aria-label="写入影响">
                <strong class="impact-title">写入影响</strong>
                <p class="impact-checkpoint"></p>
                <p class="impact-branch"></p>
              </section>
              <div class="diff-list"></div>
              <p class="approval-error" id="lingxi-approval-error" role="alert"></p>
            </div>
            <footer class="approval-actions">
              <button class="approval-button approval-cancel" type="button">拒绝</button>
              <button class="approval-button approval-confirm" type="submit">${icon('check', 15)}确认修改</button>
            </footer>
          </form>
        </div>

        <div class="profile-overlay" hidden>
          <section class="profile-dialog" role="dialog" aria-modal="true" aria-labelledby="lingxi-profile-title" tabindex="-1">
            <header class="profile-head">
              <strong id="lingxi-profile-title">灵希 · 听风之灵</strong>
              <button class="icon-button profile-close" type="button" title="关闭档案" aria-label="关闭档案">${icon('close', 18)}</button>
            </header>
            <img class="profile-image" src="/img/lingxi/profile.webp" alt="灵希角色设定图">
          </section>
        </div>

        <div class="new-chat-overlay" hidden>
          <form class="new-chat-dialog" role="dialog" aria-modal="true" aria-labelledby="lingxi-new-chat-title" tabindex="-1">
            <header class="new-chat-head">
              <strong id="lingxi-new-chat-title">灵希 · 新开对话</strong>
              <button class="icon-button new-chat-close" type="button" title="取消新建" aria-label="取消新建对话">${icon('close', 18)}</button>
            </header>
            <div class="new-chat-body">
              <p class="new-chat-note">当前聊天记录会被清空，项目存档和界面设置不会改变。</p>
              <p class="new-chat-pending" hidden>尚未批准的修改提案也会一并作废。</p>
              <p class="new-chat-error" role="alert"></p>
            </div>
            <footer class="new-chat-actions">
              <button class="approval-button new-chat-cancel" type="button">继续当前对话</button>
              <button class="approval-button new-chat-confirm" type="submit">${icon('file-text', 15)}新开对话</button>
            </footer>
          </form>
        </div>
      </div>
    `;

    this.$ = selector => this.shadowRoot.querySelector(selector);
    this._dock = this.$('.dock');
    this._petButton = this.$('.pet-button');
    this._petImage = this.$('.pet-image');
    this._panel = this.$('.panel');
    this._messages = this.$('.messages');
    this._input = this.$('.composer textarea');
    this._sendButton = this.$('.composer-send');
    this._apiChoice = this.$('.api-choice-select');
    this._proposalBand = this.$('.proposal-band');
    this._approvalOverlay = this.$('.approval-overlay');
    this._approvalError = this.$('.approval-error');
    this._profileOverlay = this.$('.profile-overlay');
    this._newChatOverlay = this.$('.new-chat-overlay');
    this._approvalReturnFocus = null;
    this._profileReturnFocus = null;
  }

  _bind() {
    this._petButton.addEventListener('click', event => {
      if (this._suppressClick) {
        event.preventDefault();
        this._suppressClick = false;
        return;
      }
      this.toggle();
    });
    this._petButton.addEventListener('pointerdown', event => this._startDrag(event));
    this.$('.panel-header').addEventListener('pointerdown', event => this._startPanelDrag(event));
    this.$('.close-button').addEventListener('click', () => this.toggle(false));
    this.$('.settings-button').addEventListener('click', () => {
      this.toggle(false);
      eventBus.emit('app:open-settings', { section: 'connection' });
    });
    this.$('.clear-button').addEventListener('click', () => this._showNewChat());
    this._apiChoice.addEventListener('change', () => {
      this.controller.setSelectedApiChoice?.(this._apiChoice.value);
      void this._refreshApiChoices();
    });
    this.$('.profile-button').addEventListener('click', () => this._showProfile());
    this.$('.profile-close').addEventListener('click', () => this._hideProfile());
    this._profileOverlay.addEventListener('click', event => {
      if (event.target === this._profileOverlay) this._hideProfile();
    });
    this.$('.new-chat-close').addEventListener('click', () => this._closeNewChat());
    this.$('.new-chat-cancel').addEventListener('click', () => this._closeNewChat());
    this.$('.new-chat-dialog').addEventListener('submit', event => {
      event.preventDefault();
      this._confirmNewChat();
    });
    this._newChatOverlay.addEventListener('click', event => {
      if (event.target === this._newChatOverlay) this._closeNewChat();
    });
    this.$('.composer').addEventListener('submit', event => {
      event.preventDefault();
      void this._sendCurrentInput();
    });
    this._input.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void this._sendCurrentInput();
      }
    });
    this._input.addEventListener('focus', () => this._setPetState('listening'));
    this._input.addEventListener('blur', () => {
      if (!this._busy) this._setPetState('idle');
    });
    this.shadowRoot.querySelectorAll('.quick-action').forEach(button => {
      button.addEventListener('click', () => {
        this._input.value = QUICK_ACTIONS[Number(button.dataset.index)] || '';
        void this._sendCurrentInput();
      });
    });
    this.$('.proposal-review').addEventListener('click', () => this._openApproval());
    this.$('.approval-close').addEventListener('click', () => this._closeApproval({ discard: true }));
    this.$('.approval-cancel').addEventListener('click', () => this._closeApproval({ discard: true }));
    this.$('.approval-confirm').addEventListener('click', event => {
      if (!event.isTrusted || !this._approvalProposal) return;
      this._approvalActivationEvidence = captureTrustedApprovalActivation({
        event,
        form: this.$('.approval-dialog'),
        element: event.currentTarget,
        proposalId: this._approvalProposal.id
      });
    });
    this.$('.approval-dialog').addEventListener('submit', event => void this._submitApproval(event));
    this._approvalOverlay.addEventListener('click', event => {
      if (event.target === this._approvalOverlay) this._closeApproval({ discard: true });
    });
    this.shadowRoot.addEventListener('keydown', event => {
      if (event.key === 'Tab' && this._trapModalFocus(event)) return;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (!this._approvalOverlay.hidden) this._closeApproval({ discard: true });
      else if (!this._profileOverlay.hidden) this._hideProfile();
      else if (!this._newChatOverlay.hidden) this._closeNewChat();
      else if (this._open) this.toggle(false);
    });
  }

  _subscribe() {
    this._unsubs.push(
      eventBus.on('lingxi:proposal-staged', ({ proposal }) => this._setProposal(proposal)),
      eventBus.on('lingxi:proposal-applied', ({ receipt } = {}) => {
        if (!receipt) return;
        this._receipt = receipt;
        if (this._proposal?.id === receipt.proposalId) this._setProposal(null);
        this._renderMessages();
      }),
      eventBus.on('lingxi:proposal-discarded', ({ proposalId } = {}) => {
        if (!proposalId || this._proposal?.id === proposalId) this._setProposal(null);
      }),
      eventBus.on('lingxi:history-cleared', () => {
        this._setProposal(null);
        this._receipt = null;
        this._renderMessages();
      }),
      eventBus.on('settings:changed', () => void this._refreshApiChoices())
    );
  }

  toggle(force) {
    this._open = typeof force === 'boolean' ? force : !this._open;
    this._panel.hidden = !this._open;
    this._dock.classList.toggle('open', this._open);
    this._petButton.setAttribute('aria-expanded', String(this._open));
    document.body.classList.toggle('lingxi-companion-open', this._open);
    if (this._open) {
      this._setPetState('listening');
      this._renderMessages();
      void this._refreshApiChoices();
      queueMicrotask(() => {
        this._positionPanel();
        this._input.focus();
      });
    } else {
      this._setPetState('idle');
      this._petButton.focus();
    }
    this._resetSleepTimer();
  }

  _showNewChat() {
    if (this._busy || this.controller?.isActive || !this._newChatOverlay) return;
    this._newChatReturnFocus = this.shadowRoot.activeElement || this.$('.clear-button');
    const pending = this.controller.approvalBroker?.listPendingProposals?.() || [];
    this.$('.new-chat-pending').hidden = pending.length === 0 && !this._proposal;
    this.$('.new-chat-error').textContent = '';
    this._newChatOverlay.hidden = false;
    this._syncModalInertState();
    queueMicrotask(() => this.$('.new-chat-cancel').focus());
  }

  _closeNewChat({ restoreFocus = true } = {}) {
    if (!this._newChatOverlay) return;
    this._newChatOverlay.hidden = true;
    this.$('.new-chat-error').textContent = '';
    this._syncModalInertState();
    const returnFocus = this._newChatReturnFocus;
    this._newChatReturnFocus = null;
    if (restoreFocus) this._restoreModalFocus(returnFocus);
  }

  _confirmNewChat() {
    if (this._busy || this.controller?.isActive) return;
    try {
      if (!this._approvalOverlay.hidden) this._closeApproval({ discard: true });
      const reset = typeof this.controller.startNewConversation === 'function'
        ? () => this.controller.startNewConversation()
        : () => this.controller.clearHistory();
      reset();
      this._setProposal(null);
      this._receipt = null;
      this._errorMessage = '';
      this._liveActivity = [];
      this._streamText = '';
      this._input.value = '';
      this._closeNewChat({ restoreFocus: false });
      this._renderMessages();
      this._input.focus();
    } catch (error) {
      this.$('.new-chat-error').textContent = error?.message || '新对话暂时无法打开，请稍后再试。';
    }
  }

  async _refreshApiChoices() {
    if (!this._apiChoice || typeof this.controller.listApiChoices !== 'function') return;
    const selected = this.controller.getSelectedApiChoice?.() || 'main';
    try {
      const choices = await this.controller.listApiChoices();
      const fragment = document.createDocumentFragment();
      for (const choice of choices || []) {
        const option = document.createElement('option');
        option.value = String(choice.id || 'main');
        const model = String(choice.model || '').trim();
        option.textContent = `${choice.label || '未命名方案'}${model ? ` · ${model}` : ''}`;
        fragment.appendChild(option);
      }
      this._apiChoice.replaceChildren(fragment);
      const available = [...this._apiChoice.options].some(option => option.value === selected);
      this._apiChoice.value = available ? selected : 'main';
    } catch {
      this._apiChoice.replaceChildren(new Option('跟随主 API', 'main'));
      this._apiChoice.value = 'main';
    }
  }

  _startDrag(event) {
    if (event.button !== 0 || !event.isPrimary) return;
    const rect = this.getBoundingClientRect();
    this._drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      currentLeft: rect.left,
      currentTop: rect.top,
      moved: false
    };
    globalThis.addEventListener?.('pointermove', this._onDragMove, { passive: false });
    globalThis.addEventListener?.('pointerup', this._onDragEnd);
    globalThis.addEventListener?.('pointercancel', this._onDragEnd);
    this._petButton.classList.add('dragging');
  }

  _moveDrag(event) {
    if (!this._drag || event.pointerId !== this._drag.pointerId) return;
    const dx = event.clientX - this._drag.startX;
    const dy = event.clientY - this._drag.startY;
    if (!this._drag.moved && Math.hypot(dx, dy) < 6) return;
    this._drag.moved = true;
    event.preventDefault();
    const position = this._clampPosition(this._drag.left + dx, this._drag.top + dy);
    this._drag.currentLeft = position.left;
    this._drag.currentTop = position.top;
    this._petButton.style.transform = `translate3d(${position.left - this._drag.left}px, ${position.top - this._drag.top}px, 0)`;
  }

  _endDrag(event) {
    if (!this._drag || event.pointerId !== this._drag.pointerId) return;
    const { moved, currentLeft, currentTop } = this._drag;
    this._drag = null;
    this._removeDragListeners();
    this._petButton.style.removeProperty('transform');
    void this._petButton.offsetWidth;
    this._petButton.classList.remove('dragging');
    if (!moved) return;
    this._suppressClick = true;
    this._applyPosition(currentLeft, currentTop);
    this._positionPanel();
    this._savePosition();
  }

  _removeDragListeners() {
    globalThis.removeEventListener?.('pointermove', this._onDragMove);
    globalThis.removeEventListener?.('pointerup', this._onDragEnd);
    globalThis.removeEventListener?.('pointercancel', this._onDragEnd);
  }

  _clampPosition(left, top) {
    const style = getComputedStyle(document.documentElement);
    const topbar = Number.parseFloat(style.getPropertyValue('--topbar-h')) || 0;
    const statusbar = Number.parseFloat(style.getPropertyValue('--statusbar-h')) || 0;
    const width = this.offsetWidth || (innerWidth <= 768 ? 62 : 96);
    const height = this.offsetHeight || (innerWidth <= 768 ? 70 : 122);
    return {
      left: Math.min(Math.max(8, Number(left) || 0), Math.max(8, innerWidth - width - 8)),
      top: Math.min(Math.max(topbar + 8, Number(top) || 0), Math.max(topbar + 8, innerHeight - statusbar - height - 8))
    };
  }

  _applyPosition(left, top) {
    const position = this._clampPosition(left, top);
    this.style.left = `${Math.round(position.left)}px`;
    this.style.top = `${Math.round(position.top)}px`;
    this.style.right = 'auto';
    this.style.bottom = 'auto';
  }

  _savePosition() {
    try {
      const rect = this.getBoundingClientRect();
      const maxX = Math.max(1, innerWidth - rect.width);
      const maxY = Math.max(1, innerHeight - rect.height);
      localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify({
        version: 1,
        x: Math.min(1, Math.max(0, rect.left / maxX)),
        y: Math.min(1, Math.max(0, rect.top / maxY))
      }));
    } catch { /* private browsing can disable storage */ }
  }

  _restorePosition({ clampOnly = false } = {}) {
    if (clampOnly && this.style.left) {
      this._applyPosition(Number.parseFloat(this.style.left), Number.parseFloat(this.style.top));
      return;
    }
    try {
      const saved = JSON.parse(localStorage.getItem(POSITION_STORAGE_KEY) || 'null');
      if (saved?.version !== 1 || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return;
      const width = this.offsetWidth || (innerWidth <= 768 ? 62 : 96);
      const height = this.offsetHeight || (innerWidth <= 768 ? 70 : 122);
      this._applyPosition(saved.x * Math.max(1, innerWidth - width), saved.y * Math.max(1, innerHeight - height));
    } catch { /* ignore invalid or unavailable storage */ }
  }

  _startPanelDrag(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (innerWidth <= 768
      || event.button !== 0
      || !event.isPrimary
      || target?.closest('button, input, select, textarea, a, [data-no-drag]')) return;
    const rect = this._panel.getBoundingClientRect();
    this._panelDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
      moved: false
    };
    globalThis.addEventListener?.('pointermove', this._onPanelDragMove, { passive: false });
    globalThis.addEventListener?.('pointerup', this._onPanelDragEnd);
    globalThis.addEventListener?.('pointercancel', this._onPanelDragEnd);
    this.$('.panel-header').classList.add('dragging');
    event.preventDefault();
  }

  _movePanelDrag(event) {
    if (!this._panelDrag || event.pointerId !== this._panelDrag.pointerId) return;
    const dx = event.clientX - this._panelDrag.startX;
    const dy = event.clientY - this._panelDrag.startY;
    if (!this._panelDrag.moved && Math.hypot(dx, dy) < 6) return;
    this._panelDrag.moved = true;
    event.preventDefault();
    this._applyPanelPosition(this._panelDrag.left + dx, this._panelDrag.top + dy);
  }

  _endPanelDrag(event) {
    if (!this._panelDrag || event.pointerId !== this._panelDrag.pointerId) return;
    const moved = this._panelDrag.moved;
    this._panelDrag = null;
    this._removePanelDragListeners();
    this.$('.panel-header').classList.remove('dragging');
    if (moved) this._savePanelPosition();
  }

  _removePanelDragListeners() {
    globalThis.removeEventListener?.('pointermove', this._onPanelDragMove);
    globalThis.removeEventListener?.('pointerup', this._onPanelDragEnd);
    globalThis.removeEventListener?.('pointercancel', this._onPanelDragEnd);
  }

  _panelBounds() {
    const style = getComputedStyle(document.documentElement);
    const minTop = (Number.parseFloat(style.getPropertyValue('--topbar-h')) || 0) + 8;
    const statusbar = (Number.parseFloat(style.getPropertyValue('--statusbar-h')) || 0) + 8;
    const rect = this._panel.getBoundingClientRect();
    return {
      minLeft: 8,
      minTop,
      maxLeft: Math.max(8, innerWidth - rect.width - 8),
      maxTop: Math.max(minTop, innerHeight - statusbar - rect.height)
    };
  }

  _applyPanelPosition(left, top) {
    const bounds = this._panelBounds();
    const nextLeft = Math.min(bounds.maxLeft, Math.max(bounds.minLeft, Number(left) || 0));
    const nextTop = Math.min(bounds.maxTop, Math.max(bounds.minTop, Number(top) || 0));
    this._panel.style.left = `${Math.round(nextLeft)}px`;
    this._panel.style.top = `${Math.round(nextTop)}px`;
    this._panel.style.right = 'auto';
    this._panel.style.bottom = 'auto';
  }

  _savePanelPosition() {
    try {
      const rect = this._panel.getBoundingClientRect();
      localStorage.setItem(PANEL_POSITION_STORAGE_KEY, JSON.stringify({
        version: 1,
        left: Math.round(rect.left),
        top: Math.round(rect.top)
      }));
    } catch { /* private browsing can disable storage */ }
  }

  _restorePanelPosition() {
    try {
      const saved = JSON.parse(localStorage.getItem(PANEL_POSITION_STORAGE_KEY) || 'null');
      if (saved?.version !== 1 || !Number.isFinite(saved.left) || !Number.isFinite(saved.top)) return false;
      this._applyPanelPosition(saved.left, saved.top);
      return true;
    } catch {
      return false;
    }
  }

  _positionPanel() {
    if (!this._open || !this._panel || this._panel.hidden) return;
    if (innerWidth <= 768) {
      for (const property of ['left', 'right', 'top', 'bottom']) this._panel.style.removeProperty(property);
      return;
    }
    if (this._restorePanelPosition()) return;
    const anchor = this.getBoundingClientRect();
    const panel = this._panel.getBoundingClientRect();
    const style = getComputedStyle(document.documentElement);
    const topbar = (Number.parseFloat(style.getPropertyValue('--topbar-h')) || 0) + 8;
    const statusbar = (Number.parseFloat(style.getPropertyValue('--statusbar-h')) || 0) + 8;
    const maxLeft = Math.max(8, innerWidth - panel.width - 8);
    const maxTop = Math.max(topbar, innerHeight - statusbar - panel.height);
    let left = Math.min(maxLeft, Math.max(8, anchor.right - panel.width));
    const preferredAbove = anchor.top - panel.height - 12;
    const preferredBelow = anchor.bottom + 12;
    let top = preferredAbove;
    if (preferredAbove < topbar && preferredBelow <= maxTop) top = preferredBelow;
    top = Math.min(maxTop, Math.max(topbar, top));
    this._panel.style.left = `${Math.round(left)}px`;
    this._panel.style.top = `${Math.round(top)}px`;
    this._panel.style.right = 'auto';
    this._panel.style.bottom = 'auto';
  }

  _handleAgentEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'text-delta') {
      const delta = typeof event.detail?.delta === 'string'
        ? event.detail.delta
        : typeof event.delta === 'string' ? event.delta : '';
      if (delta) this._streamText += delta;
      this._scheduleLiveRender();
      return;
    }
    const normalized = normalizeActivity(event);
    if (!normalized.type || normalized.type === 'reasoning') return;
    let matchingStart = null;
    for (let index = this._liveActivity.length - 1; index >= 0 && !matchingStart; index--) {
      const item = this._liveActivity[index];
      if (normalized.type === 'tool-end' && item.type === 'tool-start' && item.tool === normalized.tool) matchingStart = item;
      if (normalized.type === 'context-search-end' && item.type === 'context-search-start') matchingStart = item;
    }
    if (matchingStart) Object.assign(matchingStart, normalized);
    else this._liveActivity.push(normalized);
    this._liveActivity = this._liveActivity.slice(-MAX_ACTIVITY_EVENTS);
    if (normalized.type === 'tool-start') this._setPetState('working');
    this._scheduleLiveRender();
  }

  _scheduleLiveRender() {
    if (!this._connected || this._renderFrame) return;
    this._renderFrame = requestAnimationFrame(() => {
      this._renderFrame = null;
      this._renderMessages();
    });
  }

  async _sendCurrentInput() {
    const value = this._input.value;
    if (!value.trim() || this._busy) return;
    this._input.value = '';
    this._errorMessage = '';
    this._liveActivity = [];
    this._streamText = '';
    this._busy = true;
    this._syncBusyState();
    this._setPetState('thinking');
    this._renderMessages();
    try {
      const pending = this.controller.send(value, {
        onEvent: event => this._handleAgentEvent(event)
      });
      this._renderMessages();
      const result = await pending;
      if (result.proposal) this._setProposal(result.proposal);
      this._setPetState('idle');
    } catch (error) {
      this._setPetState('error');
      this._errorMessage = error?.message || '感知术式暂时中断，请稍后重试。';
    } finally {
      this._busy = false;
      this._liveActivity = [];
      this._streamText = '';
      this._syncBusyState();
      this._renderMessages();
      this._input.focus();
      this._resetSleepTimer();
    }
  }

  _syncBusyState() {
    const busy = this._busy || Boolean(this.controller?.isActive);
    this._sendButton.disabled = busy;
    if (this._apiChoice) this._apiChoice.disabled = busy;
    const newChatButton = this.$('.clear-button');
    if (newChatButton) newChatButton.disabled = busy;
    this.shadowRoot.querySelectorAll('.quick-action').forEach(button => { button.disabled = busy; });
  }

  _renderMessages() {
    if (!this._messages) return;
    const history = this.controller.getHistory();
    this._messages.replaceChildren();
    for (const message of history) {
      const row = document.createElement('div');
      row.className = `message ${message.role}`;
      if (message.role === 'assistant') {
        const avatar = document.createElement('img');
        avatar.className = 'message-avatar';
        avatar.src = '/img/lingxi/avatar.webp';
        avatar.alt = '';
        row.appendChild(avatar);
      }
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      if (message.role === 'assistant') renderMarkdown(bubble, message.content);
      else bubble.textContent = message.content;
      row.appendChild(bubble);
      this._messages.appendChild(row);
      if (message.role === 'assistant' && Array.isArray(message.activity) && message.activity.length) {
        this._messages.appendChild(this._createActivityTrace(message.activity));
      }
    }
    if (this._receipt) {
      const receipt = document.createElement('div');
      receipt.className = 'receipt';
      receipt.textContent = this._receipt.checkpoint
        ? `已更新当前回合的存档详情，维护记录已原地附加到节点 ${this._receipt.checkpoint.nodeId}`
          + `${this._receipt.checkpoint.previousNodeId ? `（原节点 ${this._receipt.checkpoint.previousNodeId}）` : ''}；未创建新回合或分支。`
        : (this._receipt.summary || '修改已经应用好啦。');
      this._messages.appendChild(receipt);
    }
    if (this._errorMessage) {
      const row = document.createElement('div');
      row.className = 'message assistant';
      const avatar = document.createElement('img');
      avatar.className = 'message-avatar';
      avatar.src = '/img/lingxi/avatar.webp';
      avatar.alt = '';
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = `唔，这次没能完成：${this._errorMessage}`;
      row.append(avatar, bubble);
      this._messages.appendChild(row);
    }
    if (this._busy) {
      if (this._liveActivity.length) {
        const live = this._createActivityTrace(this._liveActivity, { live: true });
        live.classList.add('live-activity');
        this._messages.appendChild(live);
      }
      if (this._streamText) {
        const row = document.createElement('div');
        row.className = 'message assistant streaming-message';
        const avatar = document.createElement('img');
        avatar.className = 'message-avatar';
        avatar.src = '/img/lingxi/avatar.webp';
        avatar.alt = '';
        const bubble = document.createElement('div');
        bubble.className = 'bubble streaming-bubble';
        renderMarkdown(bubble, this._streamText);
        row.append(avatar, bubble);
        this._messages.appendChild(row);
      } else {
        const typing = document.createElement('div');
        typing.className = 'typing';
        typing.textContent = '唔，让灵希听听风里的线索……';
        this._messages.appendChild(typing);
      }
    }
    this._messages.scrollTop = this._messages.scrollHeight;
  }

  _createActivityTrace(events, { live = false } = {}) {
    const details = document.createElement('details');
    details.className = 'activity-trace';
    details.open = live;
    const visible = (events || []).filter(event => event?.type && event.type !== 'text-delta').slice(-MAX_ACTIVITY_EVENTS);
    const summary = document.createElement('summary');
    summary.textContent = live ? '正在调用工具' : `调用流程 · ${visible.length} 步`;
    const list = document.createElement('div');
    list.className = 'activity-list';
    for (const raw of visible) {
      const event = normalizeActivity(raw);
      const item = document.createElement('div');
      item.className = 'activity-item';
      const failed = event.success === false;
      const running = event.type.endsWith('-start');
      item.dataset.status = failed ? 'failed' : running ? 'running' : 'done';
      const dot = document.createElement('span');
      dot.className = 'activity-dot';
      dot.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.textContent = activityLabel(event);
      item.append(dot, label);
      if (event.durationMs !== null) {
        const duration = document.createElement('small');
        duration.textContent = event.durationMs < 1000 ? `${event.durationMs}ms` : `${(event.durationMs / 1000).toFixed(1)}s`;
        item.appendChild(duration);
      }
      list.appendChild(item);
    }
    details.append(summary, list);
    return details;
  }

  _setProposal(proposal) {
    this._proposal = proposal || null;
    this._proposalBand.hidden = !this._proposal;
    if (this._proposal) {
      const count = Array.isArray(this._proposal.diff) ? this._proposal.diff.length : 0;
      this.$('.proposal-summary').textContent = `${count} 项变化 · 90 秒内有效`;
    }
  }

  _openApproval() {
    if (!this._proposal) return;
    this._approvalProposal = this._proposal;
    this._approvalActivationEvidence = null;
    this._approvalReturnFocus = this.shadowRoot.activeElement || this.$('.proposal-review');
    this.$('.approval-dialog').dataset.lingxiProposalId = this._approvalProposal.id;
    const list = this.$('.diff-list');
    list.replaceChildren();
    const impact = describeProposalImpact(this._approvalProposal);
    this.$('.impact-title').textContent = impact.title;
    this.$('.impact-checkpoint').textContent = impact.primary;
    this.$('.impact-branch').textContent = impact.secondary;
    for (const entry of this._approvalProposal.diff || []) {
      const row = document.createElement('div');
      row.className = 'diff-entry';
      const path = document.createElement('div');
      path.className = 'diff-path';
      path.textContent = displayPath(entry.path);
      const values = document.createElement('div');
      values.className = 'diff-values';
      const before = document.createElement('div');
      before.className = 'diff-value';
      before.textContent = displayValue(entry.before);
      const arrow = document.createElement('div');
      arrow.className = 'diff-arrow';
      arrow.textContent = '→';
      const after = document.createElement('div');
      after.className = 'diff-value';
      after.textContent = displayValue(entry.after);
      values.append(before, arrow, after);
      row.append(path, values);
      list.appendChild(row);
    }
    this.$('.approval-confirm').disabled = !impact.valid;
    this._approvalError.textContent = impact.valid ? '' : '请关闭卷轴并重新生成修改提案。';
    this._approvalOverlay.hidden = false;
    this._syncModalInertState();
    queueMicrotask(() => this.$('.approval-confirm').focus());
  }

  async _submitApproval(event) {
    event.preventDefault();
    const proposal = this._approvalProposal;
    if (!proposal) return;
    const button = this.$('.approval-confirm');
    button.disabled = true;
    this._approvalError.textContent = '';
    try {
      registerTrustedApprovalSubmit({
        submitEvent: event,
        form: this.$('.approval-dialog'),
        activationEvidence: this._approvalActivationEvidence,
        proposalId: proposal.id
      });
      const receipt = await this.controller.approveProposal(event, { proposalId: proposal.id });
      this._receipt = receipt;
      if (this._proposal?.id === proposal.id) this._setProposal(null);
      this._closeApproval();
      this._setPetState('idle');
      this._renderMessages();
    } catch (error) {
      this._approvalError.textContent = error?.message || '审批失败，存档未写入。';
      this._setPetState('error');
    } finally {
      button.disabled = false;
    }
  }

  _closeApproval({ discard = false } = {}) {
    const approvalId = this._approvalProposal?.id;
    if (discard && approvalId) this.controller.discardProposal(approvalId);
    this._approvalOverlay.hidden = true;
    this.$('.approval-confirm').disabled = false;
    this._approvalError.textContent = '';
    delete this.$('.approval-dialog').dataset.lingxiProposalId;
    this._approvalProposal = null;
    this._approvalActivationEvidence = null;
    if (discard && this._proposal?.id === approvalId) this._setProposal(null);
    this._syncModalInertState();
    const returnFocus = this._approvalReturnFocus;
    this._approvalReturnFocus = null;
    this._restoreModalFocus(returnFocus);
  }

  _showProfile() {
    this._profileReturnFocus = this.shadowRoot.activeElement || this.$('.profile-button');
    this._profileOverlay.hidden = false;
    this._syncModalInertState();
    queueMicrotask(() => this.$('.profile-close').focus());
  }

  _hideProfile() {
    this._profileOverlay.hidden = true;
    this._syncModalInertState();
    const returnFocus = this._profileReturnFocus;
    this._profileReturnFocus = null;
    this._restoreModalFocus(returnFocus);
  }

  _activeModal() {
    if (this._approvalOverlay && !this._approvalOverlay.hidden) return this.$('.approval-dialog');
    if (this._profileOverlay && !this._profileOverlay.hidden) return this.$('.profile-dialog');
    if (this._newChatOverlay && !this._newChatOverlay.hidden) return this.$('.new-chat-dialog');
    return null;
  }

  _syncModalInertState() {
    const modalOpen = Boolean(this._activeModal());
    for (const element of [this._panel, this._petButton]) {
      if (!element) continue;
      if (modalOpen) element.setAttribute('inert', '');
      else element.removeAttribute('inert');
    }
  }

  _modalFocusableElements(dialog) {
    if (!dialog) return [];
    return [...dialog.querySelectorAll(MODAL_FOCUSABLE_SELECTOR)]
      .filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
  }

  _trapModalFocus(event) {
    const dialog = this._activeModal();
    if (!dialog) return false;
    const focusable = this._modalFocusableElements(dialog);
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus();
      return true;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = this.shadowRoot.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
    return true;
  }

  _restoreModalFocus(preferred) {
    queueMicrotask(() => {
      const candidates = [preferred, this._open ? this._input : null, this._petButton];
      const target = candidates.find(element => element?.isConnected
        && !element.disabled
        && !element.closest('[hidden]')
        && element.getClientRects().length > 0);
      target?.focus();
    });
  }

  _setPetState(state) {
    const next = PET_IMAGES[state] ? state : 'idle';
    this._petButton.dataset.state = next;
    this._petImage.src = PET_IMAGES[next];
  }

  _resetSleepTimer() {
    clearTimeout(this._sleepTimer);
    if (this._open || this._busy) return;
    this._sleepTimer = setTimeout(() => this._setPetState('sleeping'), 120_000);
  }
}

if (!customElements.get('lingxi-companion')) {
  customElements.define('lingxi-companion', LingXiCompanion);
}

export { LingXiCompanion };
export default LingXiCompanion;
