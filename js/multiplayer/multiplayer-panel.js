import { multiplayerPanelStyles } from '../../css/components/multiplayer-panel.css.js';
import { turnProgressLabel } from './contracts.js';
import { detailedOpeningDraft, multiplayerOpeningDraft } from './opening-draft-bridge.js';
import {
  MultiplayerSessionController,
  normalizeGuestCharacterCandidate,
  normalizeSaveImportCandidate,
  unwrapProfile
} from './session-controller.js';
import { multiplayerErrorMessage } from './error-presentation.js';
import {
  normalizeLatestSourceSaveImportCandidate
} from './latest-source-import.js';
import {
  listMainPanelApiSchemes,
  loadMainPanelApiScheme
} from './main-api-scheme-bridge.js';
import {
  TIMELINE_FILE_ACCEPT,
  decodeTimelineSaveFile
} from '../core/timeline-file-codec.js';
import {
  actionSubmissionUnavailableMessage,
  canSubmitProjectedAction,
  isProjectedOpeningTurn,
  projectedActionCards,
  projectedGenerationProgress
} from './ui-projection.js';
import { icon } from '../utils/icons.js';
import { localRoomHistory } from './local-room-history.js';

const HTMLElementBase = globalThis.HTMLElement ?? class {};

function text(value, fallback = '—') {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function credentialValue(item) {
  return item?.credential ?? item;
}

function bindingConfigMatchesProfile(binding, profile) {
  return binding?.configured === true
    && profile?.profile_id
    && binding.profile_revision === profile.config_revision
    && binding.adapter === profile.adapter
    && binding.model === profile.model;
}

function proposalValue(value) {
  return value?.proposal ?? value;
}

function audienceDiffSummaries(diff) {
  const summaries = (diff?.sections ?? []).flatMap(section => (
    (section?.entries ?? []).map(entry => entry?.summary)
  )).filter(summary => typeof summary === 'string' && summary.trim());
  return summaries.length > 0 ? summaries.join('\n') : '尚无可确认的差异';
}

const CREDENTIAL_POLICY_LABELS = Object.freeze({
  A_ONLY: '只使用 A 的凭证',
  B_ONLY: '只使用 B 的凭证',
  ALTERNATE: 'A/B 每回合交替'
});

function requiredCredentialSeats(policy) {
  if (policy === 'A_ONLY') return ['A'];
  if (policy === 'B_ONLY') return ['B'];
  return policy === 'ALTERNATE' ? ['A', 'B'] : [];
}

function credentialPayerSeat(policy, turnNo) {
  if (policy === 'A_ONLY') return 'A';
  if (policy === 'B_ONLY') return 'B';
  if (policy !== 'ALTERNATE' || !Number.isSafeInteger(turnNo) || turnNo < 1) return null;
  return turnNo % 2 === 1 ? 'A' : 'B';
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value);
}

function normalizeEnteredRoomId(value) {
  const roomId = String(value ?? '').trim();
  return roomId.startsWith('room_') ? roomId : roomId.toUpperCase();
}

function normalizeEnteredInviteCode(value) {
  return String(value ?? '').trim();
}

function saveBlob({ blob, filename }, fallbackName = 'naruto-multiplayer-export.json') {
  if (!globalThis.URL?.createObjectURL || !globalThis.document) return false;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename || fallbackName;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function openingCardTemplate(seat) {
  return `
    <form class="opening-card card" data-opening-seat="${seat}">
      <div class="opening-card-head">
        <div><span class="seat-mark">${seat}</span><strong>席位 ${seat} 的开局</strong></div>
        <span class="pill" data-opening-status>待保存</span>
      </div>
      <div class="opening-fields">
        <label>角色名<input maxlength="80" data-opening-field="display_name" required></label>
        <label>忍阶<input maxlength="80" data-opening-field="rank" required></label>
        <label>所属<input maxlength="160" data-opening-field="affiliation" required></label>
        <label>起点地点<input maxlength="160" data-opening-field="location" required></label>
        <label class="opening-wide">角色设定<textarea maxlength="2000" data-opening-field="background" required placeholder="身份、能力或重要经历，用一小段话说明即可"></textarea></label>
        <label class="opening-wide">当前目标<textarea maxlength="1000" data-opening-field="goal" required></textarea></label>
        <label class="opening-wide">开场情境<textarea maxlength="2000" data-opening-field="opening_hook" required placeholder="此刻发生了什么？来访者、任务、危机或相遇，从哪里展开第一幕？"></textarea></label>
      </div>
      <div class="opening-readonly-note muted" hidden>这是对方的开局，只读查看。</div>
      <button class="btn btn-primary opening-save" type="submit">保存我的开局</button>
      <button class="btn opening-detailed" type="button">详细开局 · 使用单人配置</button>
      <p class="muted" data-opening-detail-summary></p>
    </form>`;
}

function generationTemplate(prefix) {
  const titleId = prefix === 'turn' ? 'turn-progress' : 'active-generation-title';
  const retryId = prefix === 'turn' ? 'retry-turn' : 'active-retry-turn';
  return `<section id="${prefix}-generation" class="generation-card" data-tone="idle" aria-label="回合生成进度">
    <div class="generation-heading"><span class="generation-indicator" aria-hidden="true"></span><strong id="${titleId}" aria-live="polite">等待回合</strong><span id="${prefix}-generation-time" class="generation-time"></span></div>
    <ol id="${prefix}-generation-steps" class="generation-steps" aria-label="生成阶段"></ol>
    <p id="${prefix === 'turn' ? 'turn-progress-detail' : 'active-generation-detail'}" class="generation-detail"></p>
    <div class="generation-actions">
      <button id="${retryId}" class="btn btn-primary" type="button" hidden>重试未完成步骤</button>
      <button id="${prefix}-refresh-generation" class="btn btn-sm" type="button">刷新状态</button>
      <button id="${prefix}-copy-diagnostics" class="btn btn-sm" type="button">复制诊断</button>
    </div>
    <details class="generation-diagnostics"><summary>查看阶段与错误详情</summary><pre id="${prefix}-generation-diagnostics"></pre></details>
  </section>`;
}

function shellTemplate() {
  return `
    <style>${multiplayerPanelStyles}</style>
    <template id="history-empty-template"><div class="history-empty">${icon('archive', 24)}<div><strong>故事从第一次相遇开始</strong><span>暂无本机记录，连接过的房间会显示在这里。</span></div></div></template>
    <template id="chat-empty-template"><div class="chat-empty">${icon('send', 26)}<strong>暂无聊天消息</strong><span>先打个招呼，一起商量下一步。</span></div></template>
    <div class="panel">
      <header class="panel-header">
        <div class="brand">
          <span class="brand-icon">${icon('zap', 18)}</span>
          <div>
            <span class="eyebrow">SHINOBI / CO-OP</span>
            <h2>双人联机</h2>
            <div class="muted">与同伴，共写一段忍者物语。</div>
          </div>
        </div>
        <div class="header-aside"><strong>两位玩家 · 一个世界</strong><span>共同开局 / 各自选择</span></div>
      </header>

      <section id="setup-view" class="setup">
        <div class="setup-intro"><h3>开启共同的冒险</h3><span class="muted">创建新故事，或赴一位同伴之约。</span></div>
        <div class="setup-grid">
          <form id="create-room-form" class="card">
            <div class="card-title">${icon('plus', 18)}<h3>创建房间</h3><span class="card-index" aria-hidden="true">01</span></div>
            <p class="muted">选择一种方式，开始新的联机跑团。</p>

            <div class="field">
              <span>创建方式</span>
              <div class="segmented" data-target="#origin-type" role="group" aria-label="创建方式">
                <button type="button" data-value="new_multiplayer_save" aria-pressed="true">${icon('plus', 14)}创建全新联机房</button>
                <button type="button" data-value="existing_save_derived" aria-pressed="false">${icon('file-text', 14)}从已有存档创建</button>
              </div>
              <select id="origin-type" class="visually-hidden" tabindex="-1" aria-hidden="true">
                <option value="new_multiplayer_save">创建全新联机房</option>
                <option value="existing_save_derived">从已有存档创建</option>
              </select>
            </div>

            <div id="existing-origin-fields" hidden>
              <label class="field">
                <span>选择来源存档文件</span>
                <input id="source-file" type="file" accept="application/json,.json">
              </label>
              <div id="source-label" class="muted">尚未选择来源节点</div>
              <div class="muted">服务端校验后，双方会在准备阶段确认各自可见的导入摘要。</div>
            </div>

            <div class="field">
              <span>正文视角</span>
              <div class="segmented" data-target="#default-mode" role="group" aria-label="正文视角">
                <button type="button" data-value="shared" aria-pressed="true">${icon('users', 14)}相同正文</button>
                <button type="button" data-value="dual_pov" aria-pressed="false">${icon('user', 14)}双视角</button>
              </div>
              <select id="default-mode" class="visually-hidden" tabindex="-1" aria-hidden="true">
                <option value="shared">相同正文（同一视角）</option>
                <option value="dual_pov">双视角（A/B 分线）</option>
              </select>
            </div>
            <p class="muted">相同正文：两人看同一段故事；双视角：各自生成 A/B 两条视角线。</p>

            <button class="btn btn-primary" type="submit">${icon('plus', 15)}创建房间</button>
          </form>

          <form id="join-room-form" class="card">
            <div class="card-title">${icon('log-in', 18)}<h3>加入房间</h3><span class="card-index" aria-hidden="true">02</span></div>
            <p class="muted">填入房主给你的房间号和房间密码。</p>

            <label class="field">
              <span>房间号</span>
              <input id="join-room-id" required autocomplete="off" spellcheck="false" placeholder="例如 R-ABCD-EFGH-JKLM">
            </label>
            <label class="field">
              <span>房间密码</span>
              <input id="join-token" type="password" autocomplete="current-password" spellcheck="false" placeholder="首次加入时填写；恢复房间可留空">
            </label>
            <details id="guest-character-details" class="custom-codes">
              <summary>从已有存档派生房加入</summary>
              <label class="field">
                <span>我的角色快照</span>
                <input id="guest-character-file" type="file" accept="application/json,.json">
              </label>
              <div id="guest-character-label" class="muted">只导入版本化角色快照，不会合并你的原世界。</div>
            </details>

            <div class="muted">首次加入请填写密码；已经加入过的房间只需房间号。页面重载后会自动尝试恢复。</div>

            <div class="toolbar">
              <button class="btn btn-primary" type="submit">${icon('log-in', 15)}进入房间</button>
            </div>
          </form>
        </div>
        <section class="card history-card" aria-label="本机房间历史">
          <div class="history-head">
            <div class="card-title">${icon('book-open', 18)}<h3>最近的房间</h3></div>
            <button id="manage-room-history" class="btn btn-sm" type="button">全部房间与存档 ${icon('external-link', 13)}</button>
          </div>
          <div id="local-room-history" class="muted">正在读取…</div>
          <div class="history-caption">记录保存在本机当前账号下，可重新进入房间或管理已保存的快照。</div>
        </section>
      </section>

      <div id="room-workspace" hidden>
        <section class="card room-status" aria-label="房间状态">
          <div class="room-meta">
            <div class="room-id-line">${icon('panel', 16)}<strong id="room-id">—</strong></div>
            <div class="pills">
              <span id="viewer-seat" class="pill">席位 —</span>
              <span id="room-lifecycle" class="pill">—</span>
              <span id="connection-status" class="pill">未连接</span>
            </div>
          </div>
          <div id="member-list" class="member-list"></div>
          <div id="member-alert" class="member-alert" hidden aria-live="assertive"></div>
          <div id="invite-box" class="notice" hidden>
            <strong>邀请另一名玩家</strong>
            <div class="share-grid">
              <div class="share-row"><span>房间号</span><code id="invite-room-code"></code><button id="copy-room-code" class="btn btn-sm" type="button">${icon('copy', 13)}复制房间码</button></div>
              <div class="share-row"><span>房间密码</span><code id="invite-code"></code><button id="copy-invite-code" class="btn btn-sm" type="button">${icon('copy', 13)}复制密码</button></div>
            </div>
            <div class="share-actions"><button id="copy-room-invite" class="btn btn-primary btn-sm" type="button">${icon('copy', 13)}复制全部</button><span id="invite-expiry" class="muted"></span></div>
          </div>
          <div id="genesis-review" class="notice" hidden>
            <strong id="genesis-review-status">等待起点导入确认</strong>
            <div id="genesis-review-detail" class="muted"></div>
            <pre id="genesis-audience-diff">等待服务端返回当前成员的受众安全差异</pre>
          </div>
          <div class="toolbar room-actions">
            <button id="ready-room" class="btn btn-primary" type="button">${icon('check', 15)}我已准备</button>
            <button id="exit-room" class="btn btn-danger" type="button">${icon('close', 14)}退出联机</button>
          </div>
        </section>

        <div class="generation-full">${generationTemplate('turn')}</div>
        <nav class="tabs" role="tablist" aria-label="联机功能">
          <button type="button" id="room-settings-tab" data-tab="turn" role="tab" aria-controls="room-settings-view" aria-selected="true" tabindex="0">${icon('settings', 16)}房间设置</button>
          <button type="button" id="room-chat-tab" data-tab="chat" role="tab" aria-controls="room-chat-view" aria-selected="false" tabindex="-1">${icon('send', 16)}聊天 <span id="chat-unread-badge" class="unread-badge" hidden></span></button>
        </nav>

        <section id="room-settings-view" data-view="turn" role="tabpanel" aria-labelledby="room-settings-tab">
          <div class="grid turn-settings-grid">
            <div class="card narrative-card">
              <div class="narrative-mode">
              <div class="card-title">${icon('book-open', 16)}<h3>正文模式</h3></div>
              <div class="toolbar">
                <button id="mode-shared" class="btn btn-sm" type="button">相同正文</button>
                <button id="mode-dual" class="btn btn-sm" type="button">双视角</button>
              </div>
              <div id="mode-note" class="muted"></div>
              </div>
              <div class="narrative-presets">
              <h3 class="subsection">正文预设</h3>
              <p class="muted">使用一位玩家当前主面板的正文预设；双方共用同一份叙事要求。</p>
              <div class="row">
                <button id="preset-seat-a" class="btn btn-sm" type="button">使用 A 的预设</button>
                <button id="preset-seat-b" class="btn btn-sm" type="button">使用 B 的预设</button>
              </div>
              <button id="sync-narrative-preset" class="btn btn-sm" type="button">同步我的正文预设</button>
              <p id="narrative-preset-note" class="muted"></p>
              </div>
            </div>
            <div class="card ai-settings-card">
              <div class="card-title">${icon('settings', 16)}<h3>联机 AI 设置</h3></div>
              <div id="ai-settings-summary" class="ai-settings-summary" hidden>
                <div>
                  <strong id="ai-settings-summary-title">设置已生效</strong>
                  <div id="ai-settings-summary-detail" class="muted"></div>
                </div>
                <button id="edit-ai-settings" class="btn btn-sm" type="button">更改</button>
              </div>
              <div id="ai-settings-editor" class="ai-settings-editor">
              <div class="ai-settings-grid">
                <div>
                  <div class="ai-section-label">使用谁的凭证</div>
                  <div class="credential-policy-options" role="radiogroup" aria-label="联机凭证使用方式">
                    <button type="button" data-credential-policy="A_ONLY" role="radio" aria-checked="false">
                      <strong>仅使用 A</strong><span>所有回合固定使用 A 的凭证</span>
                    </button>
                    <button type="button" data-credential-policy="B_ONLY" role="radio" aria-checked="false">
                      <strong>仅使用 B</strong><span>所有回合固定使用 B 的凭证</span>
                    </button>
                    <button type="button" data-credential-policy="ALTERNATE" role="radio" aria-checked="false">
                      <strong>每回合交替</strong><span>奇数回合 A，偶数回合 B</span>
                    </button>
                  </div>
                </div>
                <div id="room-profile-field" class="ai-profile-field">
                  <label>我的 API 方案与模型 <select id="room-profile"></select></label>
                  <div class="ai-profile-actions">
                    <span id="room-profile-requirement" class="muted">先选择凭证使用方式</span>
                  </div>
                  <div class="scheme-import">
                    <label>从主设置添加方案 <select id="main-api-scheme"><option value="">正在读取已保存方案…</option></select></label>
                    <button id="import-main-api-scheme" class="btn btn-sm" type="button">添加到联机</button>
                  </div>
                  <div id="main-api-scheme-status" class="muted">只在你明确添加时临时读取方案，并将 Key 加密保存到联机服务。</div>
                </div>
              </div>
              <div id="credential-current-turn" class="ai-current-turn">${icon('zap', 14)}<span>选择后自动确定本回合使用的凭证</span></div>
              <div id="credential-policy-status" class="ai-confirmation-status">等待读取房间凭证策略</div>
              <div id="credential-binding-status" class="policy-binding-status"></div>
              <button id="confirm-ai-settings" class="btn btn-primary ai-primary-action" type="button">确认联机设置</button>
              <details id="ai-data-fee-details" class="ai-disclosure">
                <summary>查看数据与费用说明</summary>
                <p>系统只向本回合选定的 API 发送生成所需的行动、房间状态、相关记忆和审查结果，并自动设置单回合请求、Token 与重试上限。更换方案、模型或凭证方式后，双方需要重新确认。</p>
              </details>
              </div>
            </div>
          </div>

        <section id="opening-workspace" class="opening-workspace" hidden aria-label="双方开局设置">
          <div class="opening-intro">
            <div>
              <h3>双方开局</h3>
              <div class="muted">席位 A 设定共同时间；每人只需填写自己的角色设定。保存任何修改后，双方都要重新确认。</div>
            </div>
            <span id="opening-ready-summary" class="pill">等待双方填写</span>
          </div>
          <fieldset id="opening-shared-time" class="card">
            <legend>共同开局时间</legend>
            <div class="opening-time-grid">
              <label>年份<input id="opening-year" type="number" min="0" max="9999" required></label>
              <label>月份<input id="opening-month" type="number" min="1" max="12" required></label>
              <label>日期<input id="opening-day" type="number" min="1" max="31" required></label>
              <label>时段<select id="opening-phase"><option value="DAWN">清晨</option><option value="DAY">白天</option><option value="DUSK">黄昏</option><option value="NIGHT">夜晚</option></select></label>
            </div>
            <div id="opening-time-note" class="muted">由席位 A 设定，席位 B 保存开局时自动沿用。</div>
          </fieldset>
          <div id="opening-conflicts" class="opening-conflicts" aria-live="polite"></div>
          <div class="opening-grid">
            ${openingCardTemplate('A')}
            ${openingCardTemplate('B')}
          </div>
        </section>

          <div class="notice">进入对局后，请直接使用游戏主输入框提交并锁定行动；本页只保留房间级设置。</div>
          <section id="turn-recovery" class="card" hidden>
            <div class="card-title">${icon('settings', 16)}<h3>回合需要处理</h3></div>
            <div id="void-status" class="muted">暂无共同作废提案</div>
            <div class="toolbar">
              <button id="propose-void" class="btn btn-danger btn-sm" type="button">提议共同作废</button>
              <button id="accept-void" class="btn btn-danger btn-sm" type="button">接受共同作废</button>
            </div>
          </section>
        </section>

        <section id="room-chat-view" data-view="chat" role="tabpanel" aria-labelledby="room-chat-tab" hidden>
          <div class="notice">聊天只用于同伴间交流，不会被当作角色行动，也不会写入剧情记忆或日报。</div>
          <button id="load-chat-history" class="btn btn-sm" type="button">${icon('book-open', 14)}加载更早消息</button>
          <div id="chat-messages" class="messages card"></div>
          <form id="chat-form" class="row">
            <input id="chat-text" maxlength="1000" required aria-label="聊天消息" placeholder="和同伴聊聊接下来的计划…">
            <button class="btn btn-primary" type="submit">${icon('send', 15)}发送</button>
          </form>
        </section>

        <details id="room-tools" class="details-group room-tools">
            <summary>${icon('archive', 16)}存档与房间工具${icon('chevron-down', 15)}</summary>
            <div class="details-body">
          <div class="notice">默认使用最新检查点；续接只新增房间纪元，不覆盖旧进度。</div>
          <div class="grid room-tool-grid">
            <div class="card">
              <h3>共同归档</h3>
              <div class="toolbar"><button id="propose-archive" type="button">提议归档</button><button id="accept-archive" type="button">接受归档</button></div>
              <div id="archive-status" class="muted">暂无归档提案</div>
            </div>
            <div class="card">
              <h3>归档后续接</h3>
              <label>方式 <select id="continuation-mode"><option value="resume_room_checkpoint">从联机检查点继续</option><option value="fork_from_latest_source_save">从来源所有者最新本地分支开始</option></select></label>
              <div id="latest-source-controls">
                <label>最新来源导入文件 <input id="latest-source-file" type="file" accept="${TIMELINE_FILE_ACCEPT}"></label>
                <button id="stage-latest-source" type="button">校验最新来源</button>
              </div>
              <div class="toolbar"><button id="propose-continuation" type="button">创建续接提案</button><button id="accept-continuation" type="button">确认角色接管差异并接受</button></div>
              <div id="continuation-status" class="muted">暂无续接提案</div>
            </div>
            <div id="personal-export-card" class="card">
              <h3>个人单机新分支导出</h3>
              <button id="begin-export" type="button">生成我的权限投影副本</button>
              <button id="download-export" type="button">下载我的导出</button>
              <div id="export-status" class="muted">暂无导出</div>
            </div>
          </div>
          </div>
        </details>
      </div>

      <section id="active-session" class="active-session" hidden aria-label="联机状态悬浮窗">
        <header class="active-head">
          <div class="active-title"><span class="live-dot"></span><div><strong>双人联机中</strong><div id="active-turn-label" class="active-turn-label">等待回合</div></div></div>
          <span id="active-connection" class="pill">连接中</span>
        </header>
        <div class="active-body">
          <div id="active-member-alert" class="member-alert" hidden aria-live="assertive"></div>
          ${generationTemplate('active')}
          <div class="compact-actions">
            <div id="active-own-action" class="compact-action"><strong>我的行动</strong><span>尚未发送</span></div>
            <div id="active-other-action" class="compact-action"><strong>对方行动</strong><span>等待发送</span></div>
          </div>
          <div class="compact-toolbar">
            <label>行动可见性<select id="active-action-visibility"><option value="sealed">隐藏具体行动</option><option value="open">向对方公开</option></select></label>
            <button id="active-chat-toggle" class="btn chat-toggle" type="button">${icon('send', 14)}聊天 <span id="active-chat-unread" class="unread-badge" hidden></span></button>
          </div>
          <div id="active-chat" class="active-chat" hidden>
            <div id="active-chat-messages" class="messages"></div>
            <form id="active-chat-form" class="active-chat-form">
              <input id="active-chat-text" maxlength="1000" required aria-label="悬浮窗聊天消息" placeholder="和同伴说点什么…">
              <button class="btn btn-primary" type="submit">发送</button>
            </form>
          </div>
          <div class="active-footer">
            <span id="active-progress" class="muted">等待双方行动</span>
            <div class="toolbar"><button id="show-full-session" class="btn btn-sm" type="button">完整联机设置</button><button id="active-exit-room" class="btn btn-danger btn-sm" type="button">退出联机</button></div>
          </div>
        </div>
      </section>

      <section id="operation-status" class="muted" aria-live="polite"></section>
      <section id="error-output" class="notice error" hidden aria-live="assertive"></section>
    </div>`;
}

export class NarutoMultiplayerPanel extends HTMLElementBase {
  constructor() {
    super();
    this._controller = null;
    this._unsubscribe = null;
    this._existingSaveCandidate = null;
    this._guestCharacterCandidate = null;
    this._latestSourceCandidate = null;
    this._latestSourceImportId = null;
    this._latestAudienceDiffCommitment = null;
    this._latestExportId = null;
    this._latestCheckpointId = null;
    this._connected = false;
    this._busy = false;
    this._mainApiSchemeListVersion = 0;
    this._mainApiSchemeSelectionVersion = 0;
    this._activeAiRoomId = null;
    this._selectedCredentialPolicy = null;
    this._aiSettingsDirty = false;
    this._aiSettingsEditing = false;
    this._activeFull = false;
    this._activeChatOpen = false;
    this._unreadChatCount = 0;
    this._knownChatMessageIds = new Set();
    this._chatInitialized = false;
    this._lastNoticeEventSeq = 0;
    this._lastSessionPhase = 'setup';
    this._openingRenderKeys = Object.create(null);
    if (typeof this.attachShadow === 'function') this.attachShadow({ mode: 'open' });
  }

  set controller(value) {
    if (!value || typeof value.subscribe !== 'function') {
      throw new TypeError('controller must be a MultiplayerSessionController-compatible object');
    }
    this._unsubscribe?.();
    this._controller = value;
    if (this._connected) this._subscribeController();
  }

  get controller() {
    return this._controller;
  }

  get actionOptions() {
    return Object.freeze({
      visibility: this.$('#active-action-visibility')?.value ?? 'sealed',
      narrationPreference: 'full'
    });
  }

  showCompactSession() {
    this._activeFull = false;
    if (this._controller?.state) this._update(this._controller.state);
  }

  showFullSession() {
    this._activeFull = true;
    if (this._controller?.state) this._update(this._controller.state);
  }

  connectedCallback() {
    if (!this.shadowRoot || this._connected) return;
    this._connected = true;
    this.shadowRoot.innerHTML = shellTemplate();
    this._controller ??= new MultiplayerSessionController();
    this._bindEvents();
    this._subscribeController();
    void this._renderRoomHistory();
    this._generationTimer = setInterval(() => {
      if (this._controller?.state) this._renderGeneration(this._controller.state);
    }, 1000);
    void this._loadMainApiSchemes().catch(error => this._controller.store?.setError?.(error));
  }

  disconnectedCallback() {
    clearInterval(this._generationTimer);
    this._connected = false;
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._controller?.disconnect?.({ reset: true });
    this._scrubEphemeralState();
    this.shadowRoot?.replaceChildren();
  }

  connectRoom(roomId, context) {
    return this._controller.connectRoom(roomId, context);
  }

  prefillRoomId(roomId) {
    const input = this.$('#join-room-id');
    if (input) input.value = normalizeEnteredRoomId(roomId);
  }

  disconnectRoom({ reset = true } = {}) {
    this._controller?.disconnect?.({ reset });
  }

  destroy() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._controller?.disconnect?.({ reset: true });
    this._scrubEphemeralState();
    this.shadowRoot?.replaceChildren();
    this.remove?.();
  }

  _scrubEphemeralState() {
    this._mainApiSchemeListVersion += 1;
    this._mainApiSchemeSelectionVersion += 1;
    this._activeAiRoomId = null;
    this._selectedCredentialPolicy = null;
    this._aiSettingsDirty = false;
    this._aiSettingsEditing = false;
    this._activeFull = false;
    this._activeChatOpen = false;
    this._unreadChatCount = 0;
    this._knownChatMessageIds.clear();
    this._chatInitialized = false;
    this._lastNoticeEventSeq = 0;
    this._lastSessionPhase = 'setup';
    this._openingRenderKeys = Object.create(null);
    this._existingSaveCandidate = null;
    this._guestCharacterCandidate = null;
    this._latestSourceCandidate = null;
    this._latestSourceImportId = null;
    this._latestAudienceDiffCommitment = null;
    this._latestExportId = null;
    this._latestCheckpointId = null;
    for (const selector of [
      '#join-token', '#chat-text', '#source-file', '#guest-character-file',
      '#latest-source-file'
    ]) {
      const input = this.$?.(selector);
      if (input) input.value = '';
    }
  }

  setExistingSaveCandidate(candidate) {
    normalizeSaveImportCandidate(candidate);
    this._existingSaveCandidate = candidate;
    this._showSaveCandidate(candidate, 'source');
  }

  setGuestCharacterCandidate(candidate) {
    const normalized = normalizeGuestCharacterCandidate(candidate);
    this._guestCharacterCandidate = normalized;
    this._showSaveCandidate(normalized, 'guest');
  }

  setLatestSourceCandidate(candidate) {
    const normalized = typeof this._controller?.normalizeLatestSourceCandidate === 'function'
      ? this._controller.normalizeLatestSourceCandidate(candidate)
      : normalizeLatestSourceSaveImportCandidate(candidate, {
          lineage: this._controller?.state?.lineage,
          staged: this._controller?.state?.latestSourceImport
        });
    this._latestSourceCandidate = normalized;
    this._showSaveCandidate(normalized, 'latest');
  }

  _subscribeController() {
    this._unsubscribe?.();
    this._unsubscribe = this._controller.subscribe(state => this._update(state));
  }

  $(selector) {
    return this.shadowRoot?.querySelector(selector) ?? null;
  }

  $$(selector) {
    return this.shadowRoot ? [...this.shadowRoot.querySelectorAll(selector)] : [];
  }

  _setOperationStatus(value) {
    const output = this.$('#operation-status');
    if (output) output.textContent = value || '';
  }

  async _copyText(value, label) {
    const textValue = String(value ?? '').trim();
    if (!textValue) throw new TypeError(`暂无可复制的${label}`);
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(textValue);
    } else {
      const input = document.createElement('textarea');
      input.value = textValue;
      input.setAttribute('readonly', '');
      input.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      this.shadowRoot.append(input);
      input.select();
      const copied = document.execCommand?.('copy');
      input.remove();
      if (!copied) throw new TypeError('浏览器未允许复制，请手动选择文本');
    }
    this._setOperationStatus(`${label}已复制`);
    return textValue;
  }

  _requestExit() {
    this.dispatchEvent(new CustomEvent('multiplayer-exit-request', {
      detail: { roomId: this._controller?.state?.roomId ?? null },
      bubbles: true,
      composed: true
    }));
  }

  async _renderRoomHistory() {
    const output = this.$('#local-room-history');
    if (!output) return;
    try {
      const entries = await localRoomHistory.list();
      output.replaceChildren();
      for (const entry of entries.slice(0, 5)) {
        const row = document.createElement('div');
        row.className = 'history-row';
        const description = document.createElement('div');
        description.className = 'history-copy';
        const title = document.createElement('strong');
        title.textContent = entry.label;
        const detail = document.createElement('small');
        detail.textContent = `玩家 ${entry.seat || '—'} · 第 ${entry.turn || 0} 回合 · ${entry.snapshotAt ? '已保存快照' : '房间记录'}`;
        description.append(title, detail);
        const button = document.createElement('button');
        button.className = 'btn btn-sm'; button.type = 'button'; button.textContent = '重新进入';
        button.onclick = () => this._run('重新进入房间', () => localRoomHistory.resume(entry.id, roomId => this.connectRoom(roomId)));
        row.append(description, button); output.append(row);
      }
      if (!entries.length) output.append(this.$('#history-empty-template').content.cloneNode(true));
    } catch (error) { output.textContent = `无法读取本机记录：${error.message}`; }
  }

  async _run(label, operation, {
    clearSecretInputs = [],
    clearAlwaysInputs = []
  } = {}) {
    if (this._busy) return null;
    this._busy = true;
    this._setOperationStatus(`${label}…`);
    this._controller.store?.setError?.(null);
    try {
      const result = await operation();
      for (const selector of clearSecretInputs) {
        const input = this.$(selector);
        if (input) input.value = '';
      }
      this._setOperationStatus(`${label}完成`);
      this.dispatchEvent?.(new CustomEvent('multiplayer-operation-complete', {
        detail: { label, result },
        bubbles: true,
        composed: true
      }));
      return result;
    } catch (error) {
      this._controller.store?.setError?.(error);
      this._setOperationStatus(`${label}失败`);
      this.dispatchEvent?.(new CustomEvent('multiplayer-operation-error', {
        detail: { label, code: error.code ?? 'MULTIPLAYER_UI_ERROR' },
        bubbles: true,
        composed: true
      }));
      return null;
    } finally {
      for (const selector of clearAlwaysInputs) {
        const input = this.$(selector);
        if (input) input.value = '';
      }
      this._busy = false;
    }
  }

  _bindEvents() {
    const on = (selector, type, listener) => this.$(selector)?.addEventListener(type, listener);
    on('#manage-room-history', 'click', () => this._run('打开房间存档', async () => {
      const { openSaveLibrary } = await import('../ui/save-library-panel.js');
      const modal = await openSaveLibrary({ kind: 'multiplayer_room', roomsOnly: true, connectRoom: roomId => this.connectRoom(roomId) });
      const priorDismiss = modal._onDismiss;
      modal._onDismiss = () => { priorDismiss?.(); void this._renderRoomHistory(); };
    }));
    on('#origin-type', 'change', () => this._toggleOriginFields());
    on('#source-file', 'change', event => this._readCandidateFile(event, 'existing'));
    on('#guest-character-file', 'change', event => this._readCandidateFile(event, 'guest'));
    on('#latest-source-file', 'change', event => this._readCandidateFile(event, 'latest'));
    on('#continuation-mode', 'change', () => this._updateRoomToolVisibility());

    this.$$('.tabs [data-tab]').forEach(button => {
      button.addEventListener('click', () => this._selectTab(button.dataset.tab));
      button.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const tabs = this.$$('.tabs [data-tab]');
        const index = tabs.indexOf(button);
        const target = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1)
          : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
        this._selectTab(target.dataset.tab);
        target.focus();
      });
    });

    this.$$('.segmented [data-value]').forEach(button => {
      button.addEventListener('click', () => this._selectSegment(button));
    });
    this.$$('[data-credential-policy]').forEach(button => {
      button.addEventListener('click', () => (
        this._selectCredentialPolicy(button.dataset.credentialPolicy)
      ));
    });

    on('#create-room-form', 'submit', event => {
      event.preventDefault();
      this._handleCreateRoom();
    });
    on('#join-room-form', 'submit', event => {
      event.preventDefault();
      const roomId = normalizeEnteredRoomId(this.$('#join-room-id').value);
      const token = normalizeEnteredInviteCode(this.$('#join-token').value);
      const firstJoin = Boolean(token || this._guestCharacterCandidate);
      this._run(firstJoin ? '加入房间' : '恢复房间', () => (
        firstJoin
          ? this._controller.joinRoom(roomId, token, this._guestCharacterCandidate).then(result => {
              this._guestCharacterCandidate = null;
              this.$('#guest-character-file').value = '';
              return result;
            })
          : this._controller.connectRoom(roomId)
      ), { clearAlwaysInputs: ['#join-token'] });
    });
    on('#copy-room-code', 'click', () => void this._run('复制房间码', () => (
      this._copyText(this.$('#invite-room-code').textContent, '房间码')
    )));
    on('#copy-invite-code', 'click', () => void this._run('复制邀请码', () => (
      this._copyText(this.$('#invite-code').textContent, '邀请码')
    )));
    on('#copy-room-invite', 'click', () => void this._run('复制全部邀请信息', () => {
      const roomCode = this.$('#invite-room-code').textContent.trim();
      const roomPassword = this.$('#invite-code').textContent.trim();
      return this._copyText(`房间号：${roomCode}\n房间密码：${roomPassword}`, '房间号和密码');
    }));
    on('#exit-room', 'click', () => this._requestExit());
    on('#active-exit-room', 'click', () => this._requestExit());
    on('#ready-room', 'click', () => this._run('确认准备', () => this._controller.markReady()));
    this.$$('[data-opening-seat]').forEach(form => {
      form.querySelector('.opening-detailed').addEventListener('click', () => this._editDetailedOpening(form));
      form.addEventListener('submit', event => {
        event.preventDefault();
        if (form.dataset.own !== 'true') return;
        this._run('保存我的开局', () => (
          this._controller.saveOpening(this._openingDraftFromForm(form))
        ));
      });
    });
    on('#mode-shared', 'click', () => this._run('切换相同正文', () => (
      this._controller.changeNarrativeMode('shared')
    )));
    on('#sync-narrative-preset', 'click', () => this._run('同步正文预设', () => this._controller.syncNarrativePreset()));
    for (const seat of ['A', 'B']) on(`#preset-seat-${seat.toLowerCase()}`, 'click', () =>
      this._run('选择正文预设', () => this._controller.changeNarrativePreset(seat)));
    on('#mode-dual', 'click', () => this._run('切换双视角', () => (
      this._controller.changeNarrativeMode('dual_pov')
    )));
    on('#confirm-ai-settings', 'click', () => this._confirmAiSettings());
    on('#edit-ai-settings', 'click', () => this._toggleAiSettingsEditor());
    on('#room-profile', 'change', () => {
      this._aiSettingsEditing = true;
      this._aiSettingsDirty = true;
      this._renderCredentialPolicy(this._controller.state);
    });
    on('#retry-turn', 'click', () => this._run('重试失败阶段', () => this._controller.retryTurn()));
    on('#active-retry-turn', 'click', () => this._run('重试未完成步骤', () => this._controller.retryTurn()));
    for (const prefix of ['turn', 'active']) {
      on(`#${prefix}-refresh-generation`, 'click', () => this._run('刷新生成状态', () => this._controller.refreshTurn()));
      on(`#${prefix}-copy-diagnostics`, 'click', () => this._run('复制诊断', () => (
        navigator.clipboard.writeText(projectedGenerationProgress(this._controller.state).diagnostics)
      )));
    }
    on('#propose-void', 'click', () => this._run('创建共同作废提案', () => (
      this._controller.createTurnVoidProposal()
    )));
    on('#accept-void', 'click', () => this._run('接受共同作废', () => (
      this._controller.acceptTurnVoidProposal()
    )));

    on('#load-chat-history', 'click', () => this._run('加载聊天历史', () => (
      this._controller.loadOlderChat()
    )));
    on('#chat-form', 'submit', event => {
      event.preventDefault();
      this._run('发送聊天', () => this._controller.sendChat(this.$('#chat-text').value), {
        clearSecretInputs: ['#chat-text']
      });
    });
    on('#active-chat-toggle', 'click', () => {
      this._activeChatOpen = !this._activeChatOpen;
      if (this._activeChatOpen) this._clearChatUnread();
      this.$('#active-chat').hidden = !this._activeChatOpen;
      this.$('#active-chat-toggle').setAttribute('aria-expanded', String(this._activeChatOpen));
      if (this._activeChatOpen) this.$('#active-chat-text')?.focus();
    });
    on('#active-chat-form', 'submit', event => {
      event.preventDefault();
      this._run('发送聊天', () => this._controller.sendChat(
        this.$('#active-chat-text').value
      ), { clearSecretInputs: ['#active-chat-text'] });
    });
    on('#show-full-session', 'click', () => this.showFullSession());

    on('#main-api-scheme', 'change', () => {
      const status = this.$('#main-api-scheme-status');
      this.$('#import-main-api-scheme').disabled = !this.$('#main-api-scheme').value;
      if (status) status.textContent = this.$('#main-api-scheme').value
        ? '点击“添加到联机”后才会读取并加密保存该方案。'
        : '请选择主设置中已保存的 API 方案。';
    });
    on('#import-main-api-scheme', 'click', () => this._importSelectedMainApiScheme());

    on('#propose-archive', 'click', () => this._run('创建归档提案', () => (
      this._controller.createArchiveProposal(this._requireLatestCheckpoint())
    )));
    on('#accept-archive', 'click', () => this._run('接受归档', () => (
      this._controller.acceptArchiveProposal()
    )));
    on('#stage-latest-source', 'click', () => this._run('暂存最新来源', async () => {
      if (!this._latestSourceCandidate) throw new TypeError('请先选择最新来源导入文件');
      const result = await this._controller.stageSaveImport(this._latestSourceCandidate);
      const id = result.source_import_id
        ?? result.import_id
        ?? result.import?.source_import_id
        ?? result.import?.import_id
        ?? result.save_import?.source_import_id
        ?? result.save_import?.import_id;
      this._latestSourceImportId = id ?? null;
      this._latestAudienceDiffCommitment = result.audience_diff_commitment
        ?? result.import?.audience_diff_commitment
        ?? result.save_import?.audience_diff_commitment
        ?? null;
      this._latestSourceCandidate = null;
      this.$('#latest-source-file').value = '';
      return result;
    }));
    on('#propose-continuation', 'click', () => this._run('创建续接提案', () => (
      this._controller.createContinuationProposal({
        mode: this.$('#continuation-mode').value,
        checkpointId: this._requireLatestCheckpoint(),
        sourceImportId: this._latestSourceImportId
      })
    )));
    on('#accept-continuation', 'click', () => this._run('接受续接并激活新 epoch', () => (
      this._controller.acceptContinuationProposal({
        audienceDiffCommitment: this._latestAudienceDiffCommitment
      })
    )));
    on('#begin-export', 'click', () => this._run('生成个人单机分支', async () => {
      const result = await this._controller.beginPersonalExport(this._requireLatestCheckpoint());
      const id = result.export?.export_id ?? result.export_id;
      if (id) this._latestExportId = id;
      return result;
    }));
    on('#download-export', 'click', () => this._run('下载个人单机分支', async () => {
      if (!this._latestExportId) throw new TypeError('请先生成个人单机分支');
      const result = await this._controller.downloadPersonalExport(this._latestExportId);
      saveBlob(result);
      return { filename: result.filename, contentType: result.contentType };
    }));

  }

  _toggleOriginFields() {
    const existing = this.$('#origin-type').value === 'existing_save_derived';
    this.$('#existing-origin-fields').hidden = !existing;
  }

  _selectSegment(button) {
    const group = button.closest('.segmented');
    if (!group) return;
    const target = this.$(group.dataset.target);
    if (!target) return;
    target.value = button.dataset.value;
    for (const candidate of group.querySelectorAll('[data-value]')) {
      candidate.setAttribute('aria-pressed', String(candidate === button));
    }
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }

  _selectTab(tab) {
    this.$$('.tabs [data-tab]').forEach(button => {
      button.setAttribute('aria-selected', String(button.dataset.tab === tab));
      button.tabIndex = button.dataset.tab === tab ? 0 : -1;
    });
    this.$$('[data-view]').forEach(view => {
      view.hidden = view.dataset.view !== tab;
    });
    if (tab === 'chat') this._clearChatUnread();
  }

  _clearChatUnread() {
    this._unreadChatCount = 0;
    for (const selector of ['#chat-unread-badge', '#active-chat-unread']) {
      const badge = this.$(selector);
      if (!badge) continue;
      badge.hidden = true;
      badge.textContent = '';
    }
  }

  _openingDraftFromForm(form) {
    const field = name => form.querySelector(`[data-opening-field="${name}"]`)?.value ?? '';
    const seat = form.dataset.openingSeat;
    const current = this._controller.state.room?.opening?.drafts?.[seat]?.draft ?? {};
    return {
      start_time: {
        year: Number(this.$('#opening-year').value),
        month: Number(this.$('#opening-month').value),
        day: Number(this.$('#opening-day').value),
        phase: this.$('#opening-phase').value
      },
      display_name: field('display_name'),
      ...(current.detailed_draft ? { detailed_draft: current.detailed_draft } : {}),
      rank: field('rank') || current.rank || '下忍',
      affiliation: field('affiliation') || current.affiliation || '木叶隐村',
      background: field('background'),
      location: field('location'),
      goal: field('goal'),
      opening_hook: field('opening_hook') || current.opening_hook || '一位来客带着未拆封的委托，在门口停下。'
    };
  }

  async _editDetailedOpening(form) {
    if (form.dataset.own !== 'true') return;
    await this._run('打开详细开局', async () => {
      await import('../ui/character-creator.js');
      const opening = this._openingDraftFromForm(form);
      const dialog = document.createElement('dialog');
      dialog.setAttribute('aria-label', '详细联机开局');
      dialog.style.cssText = 'width:min(1300px,96vw);max-width:96vw;height:94dvh;max-height:94dvh;padding:12px;border:1px solid #705d46;border-radius:16px;background:#11141a;color:#f4f1ea;overflow:auto;';
      const close = document.createElement('button');
      close.type = 'button'; close.className = 'btn'; close.textContent = '返回联机设置';
      close.addEventListener('click', () => dialog.close());
      const note = document.createElement('p');
      note.textContent = '使用与单人相同的模板、身份、实力、资产和羁绊配置。保存后双方重新确认；秘密字段只对本人显示。';
      const creator = document.createElement('character-creator');
      creator.setDraftMode(detailedOpeningDraft(opening));
      creator.addEventListener('opening-draft-saved', event => {
        void this._run('保存详细开局', async () => {
          const room = this._controller.state.room;
          const draft = multiplayerOpeningDraft(event.detail.draft, {
            phase: opening.start_time.phase,
            sharedTime: room.viewer_seat === 'B' ? room.opening.drafts.A.draft.start_time : null
          });
          await this._controller.saveOpening(draft);
          dialog.close();
        });
      });
      dialog.addEventListener('close', () => dialog.remove(), { once: true });
      dialog.append(close, note, creator); this.shadowRoot.append(dialog); dialog.showModal();
    });
  }

  async _readCandidateFile(event, kind) {
    const file = event.target.files?.[0];
    if (!file) return;
    await this._run('读取来源文件', async () => {
      const parsed = kind === 'latest'
        ? await decodeTimelineSaveFile(file)
        : JSON.parse(await file.text());
      const candidate = parsed.request
        ? { ...parsed, label: parsed.label ?? file.name }
        : { request: parsed, label: file.name };
      if (kind === 'existing') this.setExistingSaveCandidate(candidate);
      else if (kind === 'guest') {
        this.setGuestCharacterCandidate({
          ...candidate,
          guest_character: parsed.guest_character
            ?? parsed.request?.guest_character
            ?? parsed.request
            ?? parsed
        });
      } else this.setLatestSourceCandidate(candidate);
      return { file: file.name };
    });
  }

  _showSaveCandidate(candidate, kind) {
    if (!this.shadowRoot) return;
    if (kind === 'source') {
      this.$('#source-label').textContent = candidate.label
        ?? candidate.request?.source_node_id
        ?? candidate.source_node_id
        ?? '已选择来源节点';
    }
    if (kind === 'guest') {
      const snapshot = candidate.state_snapshot ?? {};
      this.$('#guest-character-label').textContent = `已选择版本化客方角色：${text(
        snapshot['玩家·姓名'],
        '未命名角色'
      )}`;
    }
  }

  _handleCreateRoom() {
    const mode = this.$('#default-mode').value;
    if (this.$('#origin-type').value === 'existing_save_derived') {
      this._run('创建已有档派生房', () => {
        if (!this._existingSaveCandidate) throw new TypeError('请先选择来源快照');
        const candidate = this._existingSaveCandidate;
        return this._controller.createExistingSaveRoom(candidate, {
          narrativeMode: mode
        }).then(result => {
          this._existingSaveCandidate = null;
          const fileInput = this.$('#source-file');
          if (fileInput) fileInput.value = '';
          return result;
        });
      });
      return;
    }
    this._run('创建全新联机房', () => this._controller.createNewMultiplayerRoom(
      {},
      { narrativeMode: mode }
    ));
  }

  async _loadMainApiSchemes() {
    const select = this.$('#main-api-scheme');
    const status = this.$('#main-api-scheme-status');
    if (!select) return { count: 0, selectedSchemeId: null };
    const requestVersion = ++this._mainApiSchemeListVersion;
    const previous = select.value;
    if (status) status.textContent = '正在读取主面板已保存的 API 方案…';
    try {
      const { activeId, schemes } = await listMainPanelApiSchemes();
      if (requestVersion !== this._mainApiSchemeListVersion || !this.$('#main-api-scheme')) {
        return { count: schemes.length, selectedSchemeId: null, stale: true };
      }
      select.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = schemes.length ? '— 选择已保存方案 —' : '主面板尚无已保存方案';
      select.append(placeholder);
      for (const scheme of schemes) {
        const option = document.createElement('option');
        option.value = scheme.id;
        option.textContent = [
          scheme.name,
          scheme.backend,
          scheme.model || '未设置模型',
          scheme.hasKey ? '已存 Key' : '免密'
        ].join(' · ');
        select.append(option);
      }
      const selectedSchemeId = schemes.some(scheme => scheme.id === previous)
        ? previous
        : (schemes.some(scheme => scheme.id === activeId) ? activeId : '');
      select.value = selectedSchemeId;
      this.$('#import-main-api-scheme').disabled = !selectedSchemeId;
      if (status) {
        status.textContent = selectedSchemeId
          ? '已选中主面板当前方案；点击“添加到联机”后才会临时读取 Key。'
          : (schemes.length
              ? '选择一个已设置默认模型的方案，然后添加到联机。'
              : '请先在主面板的 API 设置中保存一个方案。');
      }
      return { count: schemes.length, selectedSchemeId: selectedSchemeId || null };
    } catch (error) {
      if (requestVersion === this._mainApiSchemeListVersion && status) {
        status.textContent = `方案列表读取失败：${error.message || '未知错误'}`;
      }
      throw error;
    }
  }

  async _importSelectedMainApiScheme() {
    const schemeId = this.$('#main-api-scheme')?.value || '';
    const status = this.$('#main-api-scheme-status');
    if (!schemeId) {
      const error = new TypeError('请先选择主面板中已保存的 API 方案');
      error.code = 'MULTIPLAYER_API_SCHEME_REQUIRED';
      this._controller.store?.setError?.(error);
      if (status) status.textContent = error.message;
      return null;
    }
    const requestVersion = ++this._mainApiSchemeSelectionVersion;
    return this._run('添加主面板 API 方案', async () => {
      if (status) status.textContent = '正在安全添加联机方案…';
      const connection = await loadMainPanelApiScheme(schemeId);
      if (requestVersion !== this._mainApiSchemeSelectionVersion
        || this.$('#main-api-scheme')?.value !== schemeId) {
        return { schemeId, stale: true };
      }
      if (!connection.model) {
        const error = new TypeError('请先在主面板方案中选择默认模型');
        error.code = 'MULTIPLAYER_MODEL_REQUIRED';
        throw error;
      }

      const normalizedBase = value => String(value || '').replace(/\/+$/u, '');
      let entry = this._controller.state.modelProfiles.find(item => {
        const profile = unwrapProfile(item);
        return item?.status !== 'REVOKED'
          && profile?.adapter === connection.adapter
          && profile?.model === connection.model
          && profile?.auth_scheme === connection.authScheme
          && normalizedBase(profile?.endpoint?.normalized_base_url) === normalizedBase(connection.baseUrl);
      });

      if (!entry) {
        let credentialRef = null;
        if (connection.authScheme !== 'none') {
          if (!connection.apiKey) throw new TypeError('所选方案没有可用的 API Key');
          const createdCredential = credentialValue(await this._controller.createCredential({
            endpointOrigin: connection.endpointOrigin,
            plaintext: connection.apiKey
          }));
          if (!createdCredential?.credential_id) throw new TypeError('联机凭据保存失败');
          credentialRef = {
            credential_id: createdCredential.credential_id,
            credential_revision: createdCredential.credential_revision
          };
        }
        const createdProfile = unwrapProfile(await this._controller.createProfile({
          adapter: connection.adapter,
          base_url: connection.baseUrl,
          model: connection.model,
          auth_scheme: connection.authScheme,
          credential_ref: credentialRef
        }));
        entry = this._controller.state.modelProfiles.find(item => (
          unwrapProfile(item)?.profile_id === createdProfile?.profile_id
        )) ?? createdProfile;
      }

      const profile = unwrapProfile(entry);
      if (!profile?.profile_id) throw new TypeError('联机模型方案创建失败');
      this._renderProfilesAndCredentials(this._controller.state);
      this.$('#room-profile').value = profile.profile_id;
      this._aiSettingsEditing = true;
      this._aiSettingsDirty = true;
      this._renderCredentialPolicy(this._controller.state);
      if (status) {
        status.textContent = `已添加「${connection.name}」· ${connection.model}，请确认联机设置。`;
      }
      return { schemeId: connection.id, profileId: profile.profile_id, model: connection.model };
    });
  }

  _selectCredentialPolicy(policy) {
    if (!Object.prototype.hasOwnProperty.call(CREDENTIAL_POLICY_LABELS, policy)) return;
    const current = this._controller.state.room?.credential_policy;
    this._aiSettingsEditing = true;
    this._selectedCredentialPolicy = policy;
    this._aiSettingsDirty = current?.policy_revision < 1
      || current?.policy !== policy
      || current?.viewer_accepted !== true;
    this._renderCredentialPolicy(this._controller.state);
  }

  _toggleAiSettingsEditor() {
    if (this._aiSettingsEditing) {
      if (this._aiSettingsDirty) {
        const state = this._controller.state;
        const policy = state.room?.credential_policy;
        this._selectedCredentialPolicy = policy?.policy_revision > 0 ? policy.policy : null;
        this._aiSettingsDirty = false;
        const profile = this.$('#room-profile');
        if (profile) profile.value = '';
        this._renderProfilesAndCredentials(state);
      }
      this._aiSettingsEditing = false;
    } else {
      this._aiSettingsEditing = true;
    }
    this._renderCredentialPolicy(this._controller.state);
  }

  _confirmAiSettings() {
    const policy = this._selectedCredentialPolicy;
    if (!Object.prototype.hasOwnProperty.call(CREDENTIAL_POLICY_LABELS, policy)) {
      this._controller.store.setError(new TypeError('请先选择一种凭证使用方式'));
      return;
    }
    const viewerSeat = this._controller.state.room?.viewer_seat;
    const profileRequired = requiredCredentialSeats(policy).includes(viewerSeat);
    const profileId = this.$('#room-profile').value;
    const entry = this._controller.state.modelProfiles.find(item => (
      unwrapProfile(item)?.profile_id === profileId
    ));
    if (profileRequired && !entry) {
      this._controller.store.setError(new TypeError('请先选择自己的 API 方案与模型'));
      return;
    }

    return this._run('确认联机 AI 设置', async () => {
      let binding = null;
      if (profileRequired) {
        const profile = unwrapProfile(entry);
        const ownBinding = this._controller.state.room?.credential_policy?.bindings?.[viewerSeat];
        if (!bindingConfigMatchesProfile(ownBinding, profile)) {
          binding = await this._controller.bindRoomModelProfile(profileId);
        }
      }
      const credentialPolicy = await this._controller.chooseCredentialUsagePolicy(policy);
      if (this._controller.state.room?.lifecycle === 'ACTIVE'
        && this._controller.state.room?.credential_policy?.ready === true
        && typeof this._controller.markReady === 'function') {
        await this._controller.markReady();
      }
      this._selectedCredentialPolicy = policy;
      this._aiSettingsDirty = false;
      this._aiSettingsEditing = false;
      this._renderCredentialPolicy(this._controller.state);
      return { binding, credentialPolicy };
    });
  }

  _update(state) {
    if (!this.shadowRoot) return;
    const historyKey = state.room?.room_id ? [state.room.room_id, state.room.lifecycle, state.room.active_epoch_id, state.turnContext?.turnNo].join(':') : null;
    if (historyKey && historyKey !== this._localHistoryKey && localRoomHistory.owner) {
      this._localHistoryKey = historyKey;
      void localRoomHistory.remember(state).catch(error => {
        this._setOperationStatus(`本机房间记录未保存：${error.message}`);
      });
    }
    if (state.roomId !== this._activeAiRoomId) {
      this._activeAiRoomId = state.roomId ?? null;
      this._latestSourceImportId = null;
      this._latestAudienceDiffCommitment = null;
      this._latestExportId = null;
      this._latestCheckpointId = null;
      this._selectedCredentialPolicy = null;
      this._aiSettingsDirty = false;
      this._aiSettingsEditing = false;
      this._activeFull = false;
      this._activeChatOpen = false;
      this._clearChatUnread();
      this._knownChatMessageIds.clear();
      this._chatInitialized = false;
      this._lastNoticeEventSeq = 0;
      this._openingRenderKeys = Object.create(null);
    }
    const room = state.room;
    const connected = Boolean(state.roomId);
    const active = room?.lifecycle === 'ACTIVE';
    const activeMemberCount = room?.members?.filter(member => member.status === 'ACTIVE').length ?? 0;
    const phase = active ? 'active' : (connected ? 'lobby' : 'setup');
    const activeAiSetupRequired = active
      && room?.credential_policy?.ready !== true
      && (state.turn?.status === 'AWAITING_PAYER_SELECTION'
        || (!state.turn && room?.credential_policy?.current_turn_id));
    if (phase === 'active' && this._lastSessionPhase !== 'active') {
      this._activeFull = activeAiSetupRequired;
    }
    if (activeAiSetupRequired) this._activeFull = true;
    this.dataset.sessionPhase = phase;
    this.dataset.activeLayout = this._activeFull ? 'full' : 'compact';
    this.$('#setup-view').hidden = connected;
    this.$('.panel-header').hidden = active && !this._activeFull;
    this.$('#room-workspace').hidden = !connected || (active && !this._activeFull);
    this.$('#active-session').hidden = !active || this._activeFull;
    const editableOpening = room?.origin_type === 'new_multiplayer_save'
      && room?.active_epoch_id === null
      && room?.opening;
    this.$('#opening-workspace').hidden = !editableOpening;
    this.$('#room-id').textContent = `房间 ${room?.room_code ?? state.roomId ?? '—'}`;
    this.$('#viewer-seat').textContent = `席位 ${room?.viewer_seat ?? '—'}`;
    this.$('#room-lifecycle').textContent = ({ LOBBY: '准备开局', READY: '双方已准备', ACTIVE: '对局中', ARCHIVED: '已归档' })[room?.lifecycle] ?? text(room?.lifecycle, '连接中');
    this.$('#connection-status').textContent = this._connectionLabel(state.connection);
    this.$('#connection-status').dataset.state = state.connection?.status ?? 'idle';
    this._renderMembers(state);
    this._renderPresenceNotice(state);
    this._renderInvite(
      activeMemberCount < 2 ? state.invite : null,
      room?.room_code ?? state.roomId
    );
    this._renderGenesisReview(state);
    this._renderOpening(state);
    this._renderProfilesAndCredentials(state);
    this._renderTurn(state);
    this._renderGeneration(state);
    this._trackChatUnread(state);
    this._renderChat(state);
    this._renderActiveSession(state);
    this._renderLineage(state);
    this._renderError(state.lastError);

    const archived = room?.lifecycle === 'ARCHIVED';
    const readyMember = room?.members?.find(member => member.seat === room.viewer_seat);
    this.$('#ready-room').hidden = active;
    const existingDerived = room?.origin_type === 'existing_save_derived';
    const review = state.genesisReview ?? room?.genesis_review;
    const ownOpening = room?.opening?.drafts?.[room?.viewer_seat];
    const bothPresent = activeMemberCount === 2;
    const aiReady = room?.credential_policy?.ready === true;
    this.$('#ready-room').disabled = archived
      || Boolean(readyMember?.ready_at)
      || !bothPresent
      || !aiReady
      || (existingDerived && !review?.audience_diff_commitment)
      || (editableOpening && (!ownOpening || room.opening.blocking));
    this.$('#ready-room').textContent = readyMember?.ready_at
      ? '已确认，等待对方'
      : (!aiReady
          ? '先完成联机 AI 设置'
      : (existingDerived
          ? '确认本人导入差异并准备'
          : (editableOpening ? '确认开局并生成第一回合' : '我已准备')));
    this.$('#load-chat-history').disabled = !state.chat.nextBefore;
    this.$('#chat-text').disabled = archived;
    this.$('#chat-form button').disabled = archived;
    this.$('#active-chat-text').disabled = archived;
    this.$('#active-chat-form button').disabled = archived;

    if (phase !== this._lastSessionPhase) {
      this._lastSessionPhase = phase;
      this.dispatchEvent(new CustomEvent('multiplayer-phase-change', {
        detail: { phase, state },
        bubbles: true,
        composed: true
      }));
    }
    this.dispatchEvent(new CustomEvent('multiplayer-state-change', {
      detail: { state },
      bubbles: true,
      composed: true
    }));
  }

  _connectionLabel(connection) {
    const labels = {
      idle: '未连接',
      connecting: '连接事件流',
      reconnecting: '断线重连中',
      open: '实时事件已连接',
      closed: '事件流已关闭'
    };
    const base = labels[connection?.status] ?? text(connection?.status, '未连接');
    return connection?.lastEventSeq ? `${base} · #${connection.lastEventSeq}` : base;
  }

  _renderMembers(state) {
    const list = this.$('#member-list');
    list.replaceChildren();
    for (const seat of ['A', 'B']) {
      const member = state.room?.members?.find(item => item.seat === seat);
      const own = seat === state.room?.viewer_seat ? '（你）' : '';
      const draft = state.room?.opening?.drafts?.[seat]?.draft;
      const card = document.createElement('div');
      card.className = 'member-card';
      card.dataset.seat = seat;
      card.dataset.empty = String(!member);
      card.dataset.state = member?.ready_at ? 'ready' : 'waiting';
      const avatar = document.createElement('span');
      avatar.className = 'member-avatar';
      avatar.textContent = seat;
      avatar.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('div');
      copy.className = 'member-copy';
      const name = document.createElement('strong');
      name.className = 'member-name';
      name.textContent = draft?.display_name || (member ? `席位 ${seat}${own}` : '留一席，待同伴');
      const meta = document.createElement('span');
      meta.className = 'member-meta';
      meta.textContent = `玩家 ${seat}${member ? own : ''} · ${!member ? '等待加入' : member.ready_at ? '已确认开局' : '已加入，待确认'}`;
      copy.append(name, meta);
      card.append(avatar, copy);
      list.append(card);
    }
  }

  _renderPresenceNotice(state) {
    if (state.room?.lifecycle === 'ACTIVE') {
      for (const selector of ['#member-alert', '#active-member-alert']) this.$(selector).hidden = true;
      return;
    }
    const notice = state.notices?.findLast?.(item => (
      item.event_type === 'member.presence_changed'
    )) ?? [...(state.notices ?? [])].reverse().find(item => (
      item.event_type === 'member.presence_changed'
    ));
    if (!notice || notice.event_seq <= this._lastNoticeEventSeq) return;
    this._lastNoticeEventSeq = notice.event_seq;
    const payload = notice.payload ?? {};
    const seat = payload.member_seat ?? payload.seat ?? '—';
    const message = payload.ready === true
      ? `玩家 ${seat} 已确认开局${payload.lifecycle === 'READY' ? '，双方均已确认，正在开局。' : '，正在等待另一位玩家。'}`
      : `玩家 ${seat} 已加入房间，现在可以一起核对双方开局。`;
    for (const selector of ['#member-alert', '#active-member-alert']) {
      const output = this.$(selector);
      if (!output) continue;
      output.hidden = false;
      output.textContent = message;
    }
  }

  _renderOpening(state) {
    const opening = state.room?.opening;
    const workspace = this.$('#opening-workspace');
    if (!opening || workspace.hidden) return;
    const viewerSeat = state.room?.viewer_seat;
    const sharedTimeProjection = opening.drafts?.A ?? opening.drafts?.[viewerSeat];
    const sharedTime = sharedTimeProjection?.draft?.start_time;
    const sharedTimeKey = sharedTimeProjection
      ? `${sharedTimeProjection.revision}:${sharedTimeProjection.commitment}`
      : '';
    if (sharedTime && this._openingRenderKeys.sharedTime !== sharedTimeKey) {
      this._openingRenderKeys.sharedTime = sharedTimeKey;
      this.$('#opening-year').value = sharedTime.year;
      this.$('#opening-month').value = sharedTime.month;
      this.$('#opening-day').value = sharedTime.day;
      this.$('#opening-phase').value = sharedTime.phase;
    }
    const canEditSharedTime = viewerSeat === 'A';
    for (const selector of ['#opening-year', '#opening-month', '#opening-day', '#opening-phase']) {
      this.$(selector).disabled = !canEditSharedTime;
    }
    this.$('#opening-time-note').textContent = canEditSharedTime
      ? '你设置的时间会作为双方共同开局时间。'
      : '由席位 A 设定；你保存角色时会自动沿用。';
    for (const seat of ['A', 'B']) {
      const form = this.$(`[data-opening-seat="${seat}"]`);
      const projected = opening.drafts?.[seat];
      if (!form || !projected) continue;
      const own = seat === viewerSeat;
      form.dataset.own = String(own);
      const renderKey = `${projected.revision}:${projected.commitment}`;
      if (this._openingRenderKeys[seat] !== renderKey) {
        this._openingRenderKeys[seat] = renderKey;
        const draft = projected.draft;
        const values = {
          display_name: draft.display_name,
          rank: draft.rank,
          affiliation: draft.affiliation,
          opening_hook: draft.opening_hook,
          background: draft.background,
          location: draft.location,
          goal: draft.goal
        };
        for (const [field, value] of Object.entries(values)) {
          const input = form.querySelector(`[data-opening-field="${field}"]`);
          if (input) input.value = value;
        }
      }
      for (const input of form.querySelectorAll('[data-opening-field]')) input.disabled = !own;
      form.querySelector('.opening-save').hidden = !own;
      form.querySelector('.opening-detailed').hidden = !own;
      const detail = projected.draft.detailed_draft;
      form.querySelector('[data-opening-detail-summary]').textContent = detail
        ? `已配置 ${detail.talents.length} 项天赋 · ${detail.abilities.length} 项技能 · ${detail.equipment.length} 件装备 · ${detail.relationships.length} 段羁绊`
        : '可使用详细开局选择模板，配置外貌、性格、属性、技能、装备和羁绊。';
      form.querySelector('.opening-readonly-note').hidden = own;
      const status = form.querySelector('[data-opening-status]');
      status.textContent = projected.confirmed
        ? '已确认'
        : (own ? '待你确认' : `等待 ${seat} 确认`);
      status.dataset.state = projected.confirmed ? 'ready' : 'waiting';
      if (own) {
        form.querySelector('.opening-save').textContent = projected.confirmed
          ? '保存修改（双方需重新确认）'
          : '保存我的开局';
      }
    }
    const conflicts = this.$('#opening-conflicts');
    conflicts.replaceChildren();
    for (const conflict of opening.conflicts ?? []) {
      const item = document.createElement('div');
      item.className = 'opening-conflict';
      item.dataset.severity = conflict.severity;
      item.textContent = conflict.message;
      conflicts.append(item);
    }
    if (!conflicts.childNodes.length) {
      const item = document.createElement('div');
      item.className = 'opening-conflict';
      item.dataset.severity = 'info';
      item.textContent = '未发现冲突，双方确认后即可开局。';
      conflicts.append(item);
    }
    const confirmed = ['A', 'B'].filter(seat => opening.drafts?.[seat]?.confirmed).length;
    const summary = this.$('#opening-ready-summary');
    summary.textContent = opening.blocking ? '有冲突待处理' : `已确认 ${confirmed}/2`;
    summary.dataset.state = opening.blocking ? 'waiting' : (confirmed === 2 ? 'ready' : 'waiting');
  }

  _trackChatUnread(state) {
    const viewerSeat = state.room?.viewer_seat;
    const fullChatOpen = this.$('.tabs [data-tab="chat"]')?.getAttribute('aria-selected') === 'true'
      && !this.$('#room-workspace')?.hidden;
    let added = 0;
    for (const message of state.chat?.messages ?? []) {
      if (!message?.message_id || this._knownChatMessageIds.has(message.message_id)) continue;
      this._knownChatMessageIds.add(message.message_id);
      if (this._chatInitialized
        && message.sender_seat !== viewerSeat
        && !this._activeChatOpen
        && !fullChatOpen) added += 1;
    }
    this._chatInitialized = true;
    if (added > 0) this._unreadChatCount += added;
    const label = this._unreadChatCount > 99 ? '99+' : String(this._unreadChatCount);
    for (const selector of ['#chat-unread-badge', '#active-chat-unread']) {
      const badge = this.$(selector);
      if (!badge) continue;
      badge.hidden = this._unreadChatCount === 0;
      badge.textContent = this._unreadChatCount ? label : '';
    }
  }

  _renderInvite(invite, roomId) {
    const box = this.$('#invite-box');
    if (!invite?.token) {
      box.hidden = true;
      this.$('#invite-room-code').textContent = '';
      this.$('#invite-code').textContent = '';
      this.$('#invite-expiry').textContent = '';
      return;
    }
    box.hidden = false;
    this.$('#invite-room-code').textContent = roomId ?? invite.room_code ?? invite.room_id ?? '';
    this.$('#invite-code').textContent = invite.token;
    this.$('#invite-expiry').textContent = '可重复使用 · 不占用其他房间的同名密码';
  }

  _renderGenesisReview(state) {
    const container = this.$('#genesis-review');
    const existingDerived = state.room?.origin_type === 'existing_save_derived';
    if (!existingDerived) {
      container.hidden = true;
      this.$('#genesis-review-status').textContent = '';
      this.$('#genesis-review-detail').textContent = '';
      this.$('#genesis-audience-diff').textContent = '';
      return;
    }

    container.hidden = false;
    const review = state.genesisReview ?? state.room?.genesis_review;
    if (!review) {
      this.$('#genesis-review-status').textContent = '等待客方提交版本化角色快照';
      this.$('#genesis-review-detail').textContent = '角色接入完成后，双方会分别看到自己的受众安全导入差异。';
      this.$('#genesis-audience-diff').textContent = '尚无可确认的差异';
      return;
    }
    const accepted = review.accepted_by ?? {};
    this.$('#genesis-review-status').textContent = '起点导入确认';
    this.$('#genesis-review-detail').textContent = [
      `我的确认：${review.accepted_by_viewer ? '已接受' : '待确认'}`,
      `席位 A：${accepted.A ? '已接受' : '待确认'}`,
      `席位 B：${accepted.B ? '已接受' : '待确认'}`
    ].join(' · ');
    this.$('#genesis-audience-diff').textContent = audienceDiffSummaries(review.audience_diff);
  }

  _replaceSelectOptions(select, values, {
    placeholder = '请选择',
    value,
    label,
    dataset = () => ({})
  }) {
    const previous = select.value;
    select.replaceChildren();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = placeholder;
    select.append(empty);
    for (const item of values) {
      const option = document.createElement('option');
      option.value = value(item);
      option.textContent = label(item);
      Object.assign(option.dataset, dataset(item));
      select.append(option);
    }
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  }

  _renderProfilesAndCredentials(state) {
    const profiles = state.modelProfiles
      .map(item => ({ wrapper: item, profile: unwrapProfile(item) }))
      .filter(item => item.profile?.profile_id && item.wrapper?.status !== 'REVOKED');

    const roomProfile = this.$('#room-profile');
    this._replaceSelectOptions(roomProfile, profiles, {
      placeholder: '尚未添加可用方案',
      value: item => item.profile.profile_id,
      label: item => `${item.profile.model} · ${item.profile.endpoint?.normalized_origin ?? ''}`,
      dataset: item => ({
        id: item.profile.profile_id,
        revision: String(item.profile.config_revision)
      })
    });
    if (!roomProfile.value) {
      const viewerSeat = state.room?.viewer_seat;
      const ownBinding = state.room?.credential_policy?.bindings?.[viewerSeat];
      const matching = profiles.find(item => (
        ownBinding?.configured === true
        && item.profile.model === ownBinding.model
        && item.profile.adapter === ownBinding.adapter
        && item.profile.config_revision === ownBinding.profile_revision
      ));
      roomProfile.value = matching?.profile.profile_id
        ?? (profiles.length === 1 ? profiles[0].profile.profile_id : '');
    }
  }

  _renderCredentialPolicy(state) {
    const policy = state.room?.credential_policy;
    const archived = state.room?.lifecycle === 'ARCHIVED';
    if (!this._aiSettingsDirty) {
      this._selectedCredentialPolicy = policy?.policy_revision > 0
        ? policy.policy
        : (policy?.policy ?? 'ALTERNATE');
    }
    const selectedPolicy = this._selectedCredentialPolicy;
    const viewerSeat = state.room?.viewer_seat;
    const requiredSeats = requiredCredentialSeats(selectedPolicy);
    const viewerNeedsProfile = requiredSeats.includes(viewerSeat);
    const policyMatches = Boolean(
      selectedPolicy
      && policy?.policy_revision > 0
      && policy.policy === selectedPolicy
    );

    for (const button of this.$$('[data-credential-policy]')) {
      const selected = button.dataset.credentialPolicy === selectedPolicy;
      button.setAttribute('aria-checked', String(selected));
      button.disabled = archived;
    }

    const profileField = this.$('#room-profile-field');
    const profileSelect = this.$('#room-profile');
    const profileRequirement = this.$('#room-profile-requirement');
    const importScheme = this.$('#import-main-api-scheme');
    const selectedProfile = state.modelProfiles
      .map(item => unwrapProfile(item))
      .find(profile => profile?.profile_id === profileSelect.value);
    const ownPolicyBinding = policy?.bindings?.[viewerSeat];
    profileField.hidden = !viewerNeedsProfile;
    profileSelect.disabled = archived;
    importScheme.disabled = archived || !this.$('#main-api-scheme').value;
    if (viewerNeedsProfile) {
      profileRequirement.textContent = profileSelect.value
        ? `轮到席位 ${viewerSeat} 时使用此方案`
        : '尚无可用方案，请先从主面板添加';
    }

    const status = this.$('#credential-policy-status');
    if (!policy) {
      status.textContent = '等待读取房间凭证策略';
    } else if (!selectedPolicy) {
      status.textContent = '请选择一种凭证使用方式，然后确认设置。';
    } else if (!policyMatches || this._aiSettingsDirty) {
      status.textContent = `${CREDENTIAL_POLICY_LABELS[selectedPolicy]} · 等待双方确认`;
    } else {
      const otherSeat = viewerSeat === 'A' ? 'B' : 'A';
      const viewerStatus = policy.viewer_accepted ? '你已确认' : '等待你确认';
      const otherStatus = policy.accepted_by?.[otherSeat]
        ? `席位 ${otherSeat} 已确认`
        : `等待席位 ${otherSeat} 确认`;
      status.textContent = `${CREDENTIAL_POLICY_LABELS[selectedPolicy]} · ${viewerStatus} · ${otherStatus}`;
    }

    const bindings = this.$('#credential-binding-status');
    bindings.replaceChildren();
    for (const seat of ['A', 'B']) {
      const value = policy?.bindings?.[seat];
      const required = requiredSeats.includes(seat);
      const badge = document.createElement('span');
      badge.className = 'pill';
      badge.dataset.state = !required
        ? 'unused'
        : (value?.configured ? 'ready' : 'waiting');
      badge.textContent = !required
        ? `${seat} 无需配置`
        : (!value?.configured
            ? `${seat} 等待配置方案`
            : `${seat} 已配置 · ${value.model}`);
      bindings.append(badge);
    }

    const turnNo = policy?.current_turn_no ?? state.turn?.turn_no;
    const payerSeat = credentialPayerSeat(selectedPolicy, turnNo);
    const payerBinding = payerSeat ? policy?.bindings?.[payerSeat] : null;
    const currentTurn = this.$('#credential-current-turn span');
    if (!selectedPolicy) {
      currentTurn.textContent = '选择后自动确定本回合使用的凭证';
    } else if (!payerSeat) {
      currentTurn.textContent = `${CREDENTIAL_POLICY_LABELS[selectedPolicy]} · 回合开始后自动确定付款席位`;
    } else {
      const prefix = policyMatches && !this._aiSettingsDirty ? '本回合' : '确认后本回合';
      const model = payerBinding?.configured ? ` · ${payerBinding.model}` : '';
      currentTurn.textContent = `${prefix}使用席位 ${payerSeat} 的凭证${model}`;
    }

    const settingsReady = policyMatches && policy?.ready === true && !this._aiSettingsDirty;
    const summary = this.$('#ai-settings-summary');
    const editor = this.$('#ai-settings-editor');
    summary.hidden = !settingsReady;
    editor.hidden = settingsReady && !this._aiSettingsEditing;
    this.$('#ai-settings-summary-title').textContent = CREDENTIAL_POLICY_LABELS[selectedPolicy]
      ?? '设置已生效';
    this.$('#ai-settings-summary-detail').textContent = payerSeat
      ? `本回合使用席位 ${payerSeat}${payerBinding?.configured ? ` · ${payerBinding.model}` : ''}`
      : '回合开始后自动确定使用的凭证';
    const edit = this.$('#edit-ai-settings');
    edit.disabled = archived;
    edit.textContent = this._aiSettingsEditing
      ? (this._aiSettingsDirty ? '取消更改' : '收起')
      : '更改';

    const ownSelectedProfileReady = !viewerNeedsProfile
      || bindingConfigMatchesProfile(ownPolicyBinding, selectedProfile);
    const requiredBindingsReady = requiredSeats.every(seat => {
      if (seat === viewerSeat && viewerNeedsProfile) return ownSelectedProfileReady;
      const binding = policy?.bindings?.[seat];
      return binding?.configured === true;
    });
    const pendingBindingSeats = requiredSeats.filter(seat => {
      if (seat === viewerSeat && viewerNeedsProfile) return !ownSelectedProfileReady;
      const binding = policy?.bindings?.[seat];
      return binding?.configured !== true;
    });
    const waitingForOtherBinding = ownSelectedProfileReady && !requiredBindingsReady;
    const noFurtherAction = policyMatches
      && !this._aiSettingsDirty
      && policy?.viewer_accepted === true
      && requiredBindingsReady;
    const confirm = this.$('#confirm-ai-settings');
    confirm.disabled = archived
      || !selectedPolicy
      || (viewerNeedsProfile && !profileSelect.value)
      || waitingForOtherBinding
      || noFurtherAction;
    if (archived) confirm.textContent = '房间已归档';
    else if (!selectedPolicy) confirm.textContent = '先选择凭证方式';
    else if (viewerNeedsProfile && !profileSelect.value) confirm.textContent = '先添加 API 方案与模型';
    else if (waitingForOtherBinding) {
      confirm.textContent = `等待席位 ${pendingBindingSeats.join('/')} 配置 API`;
    }
    else if (noFurtherAction) confirm.textContent = policy?.ready ? '设置已生效' : '已确认，等待对方';
    else if (viewerNeedsProfile && !ownSelectedProfileReady) {
      confirm.textContent = '保存方案并确认';
    }
    else confirm.textContent = '确认联机设置';
  }

  _renderGeneration(state) {
    const view = projectedGenerationProgress(state);
    const put = (selector, value) => {
      const node = this.$(selector);
      if (node && node.textContent !== value) node.textContent = value;
    };
    for (const prefix of ['turn', 'active']) {
      const card = this.$(`#${prefix}-generation`);
      if (!card) continue;
      card.hidden = !state.turn;
      card.dataset.tone = view.tone;
      const title = this.$(prefix === 'turn' ? '#turn-progress' : '#active-generation-title');
      title.setAttribute('aria-live', view.tone === 'error' ? 'assertive' : 'polite');
      put(prefix === 'turn' ? '#turn-progress' : '#active-generation-title', view.title);
      put(prefix === 'turn' ? '#turn-progress-detail' : '#active-generation-detail', view.detail);
      const seconds = view.elapsedSeconds;
      put(`#${prefix}-generation-time`, seconds === null ? '' : `${view.running ? '已用时' : '记录用时'} ${Math.floor(seconds / 60)}分${seconds % 60}秒`);
      const steps = this.$(`#${prefix}-generation-steps`);
      const stepKey = view.steps.map(item => item.state).join('|');
      if (steps.dataset.states !== stepKey) {
        steps.dataset.states = stepKey;
        steps.replaceChildren(...view.steps.map(item => {
          const li = document.createElement('li');
          li.dataset.state = item.state;
          li.textContent = `${item.state === 'done' ? '✓ ' : item.state === 'paused' ? '! ' : ''}${item.label}`;
          return li;
        }));
      }
      put(`#${prefix}-generation-diagnostics`, view.diagnostics);
      const retry = this.$(prefix === 'turn' ? '#retry-turn' : '#active-retry-turn');
      retry.hidden = !view.retryable;
      retry.disabled = !view.retryable || this._busy;
    }
  }

  _renderTurn(state) {
    const turn = state.turn;
    const status = turn?.status ?? state.progress.status;
    const preset = state.room?.narrative_preset;
    for (const seat of ['A', 'B']) {
      const button = this.$(`#preset-seat-${seat.toLowerCase()}`);
      button.disabled = !preset?.bindings?.[seat] || state.room?.lifecycle === 'ARCHIVED';
      button.setAttribute('aria-pressed', String(preset?.source_seat === seat));
    }
    this.$('#sync-narrative-preset').disabled = state.room?.lifecycle === 'ARCHIVED';
    const source = preset?.source_seat ?? 'A';
    const names = ['A', 'B'].map(seat => `${seat}：${preset?.bindings?.[seat]?.name ?? '尚未同步'}`).join('；');
    const current = preset?.current_turn;
    this.$('#narrative-preset-note').textContent = `${names}。${current
      ? `本回合已固定使用 ${current.source_seat} · ${current.name}；修改应用于下一回合。`
      : `下一次生成使用 ${source} 的预设；确认开局时会自动同步本人预设。`}`;

    const mode = turn?.active_narrative_mode
      ?? turn?.narrative_mode
      ?? state.room?.active_narrative_mode;
    const queued = state.room?.queued_narrative_mode;
    const lockedCount = projectedActionCards(turn).filter(action => action.locked).length;
    const archived = state.room?.lifecycle === 'ARCHIVED';
    this.$('#mode-shared').disabled = archived;
    this.$('#mode-dual').disabled = archived;
    this.$('#mode-shared').setAttribute('aria-pressed', String(mode === 'shared'));
    this.$('#mode-dual').setAttribute('aria-pressed', String(mode === 'dual_pov'));
    this.$('#mode-note').textContent = queued
      ? `本回合已冻结为 ${mode}；下一回合已排队 ${queued}。双视角会增加一份 Writer 调用。`
      : (lockedCount > 0
          ? `本回合已冻结为 ${mode}；后续切换只排到下一回合。`
          : `当前 ${mode ?? '—'}；零行动锁定时立即生效。双视角也使用本回合选定的同一席位凭证。`);
    this._renderCredentialPolicy(state);

    const voidProposal = proposalValue(state.proposals.void);
    const retryable = ['RETRYABLE_FAILED', 'REPAIR_PAUSED'].includes(status);
    const consistencyFault = status === 'CONSISTENCY_FAULT';
    const recovery = this.$('#turn-recovery');
    recovery.hidden = !(retryable || consistencyFault || voidProposal?.proposal_id);
    this.$('#retry-turn').hidden = !retryable;
    this.$('#retry-turn').disabled = !retryable;
    this.$('#propose-void').disabled = archived || Boolean(voidProposal?.proposal_id);
    this.$('#accept-void').disabled = archived || !voidProposal?.proposal_id;
    this.$('#void-status').textContent = voidProposal?.proposal_id
      ? '已有共同作废提案，需另一名玩家确认后才会生效。'
      : '本回合未能正常继续，可重试有效阶段或提议双方共同作废。';
  }

  _renderChat(state) {
    const viewerSeat = state.room?.viewer_seat;
    for (const selector of ['#chat-messages', '#active-chat-messages']) {
      const container = this.$(selector);
      if (!container) continue;
      container.replaceChildren();
      for (const message of state.chat.messages) {
        const item = document.createElement('div');
        item.className = 'message';
        item.dataset.own = String(message.sender_seat === viewerSeat);
        const meta = document.createElement('small');
        meta.textContent = `玩家 ${message.sender_seat} · ${formatTime(message.created_at)}`;
        const body = document.createElement('div');
        body.style.whiteSpace = 'pre-wrap';
        body.textContent = message.text;
        item.append(meta, body);
        container.append(item);
      }
      if (!state.chat.messages.length) container.append(this.$('#chat-empty-template').content.cloneNode(true));
      queueMicrotask(() => { container.scrollTop = container.scrollHeight; });
    }
  }

  _renderActiveSession(state) {
    if (state.room?.lifecycle !== 'ACTIVE') return;
    const turn = state.turn;
    const viewerSeat = turn?.viewer_seat ?? state.room?.viewer_seat;
    const otherSeat = viewerSeat === 'A' ? 'B' : 'A';
    const actions = Object.fromEntries(projectedActionCards(turn).map(action => [action.seat, action]));
    const own = actions[viewerSeat] ?? { locked: false, text: null };
    const other = actions[otherSeat] ?? { locked: false, text: null };
    const openingTurn = isProjectedOpeningTurn(state);
    this.$('#active-turn-label').textContent = openingTurn
      ? `第一回合 · ${projectedGenerationProgress(state).title}`
      : (turn?.turn_no
      ? `第 ${turn.turn_no} 回合 · 你是玩家 ${viewerSeat}`
      : `你是玩家 ${viewerSeat} · 等待回合`);
    this.$('#active-connection').dataset.state = state.connection?.status ?? 'idle';
    this.$('#active-connection').textContent = this._connectionLabel(state.connection)
      .replace(/ · #\d+$/u, '');
    const ownCard = this.$('#active-own-action');
    ownCard.dataset.state = openingTurn || own.locked ? 'sent' : 'waiting';
    ownCard.querySelector('strong').textContent = openingTurn ? '我的开局' : '我的行动';
    ownCard.querySelector('span').textContent = openingTurn
      ? '开局资料已确认'
      : (own.locked ? '已发送' : '尚未发送');
    const otherCard = this.$('#active-other-action');
    otherCard.dataset.state = openingTurn || other.locked ? 'sent' : 'waiting';
    otherCard.querySelector('strong').textContent = openingTurn ? '对方开局' : '对方行动';
    otherCard.querySelector('span').textContent = openingTurn
      ? '开局资料已确认'
      : (!other.locked
      ? '等待发送'
      : (other.text ? other.text : '已发送（具体行动已隐藏）'));
    const canSubmit = canSubmitProjectedAction(state);
    this.$('#active-progress').textContent = canSubmit
      ? (other.locked
          ? '对方已发送，请在主输入框提交行动'
          : '请在主输入框提交本回合行动')
      : (['REPAIR_PAUSED', 'RETRYABLE_FAILED'].includes(turn?.status)
          ? '可直接重试上方未完成步骤'
          : actionSubmissionUnavailableMessage(state));
    this.$('#active-chat').hidden = !this._activeChatOpen;
    this.$('#active-chat-toggle').setAttribute('aria-expanded', String(this._activeChatOpen));
  }

  _renderLineage(state) {
    const checkpoints = state.lineage?.checkpoints ?? [];
    const latestCheckpoint = checkpoints.reduce((latest, checkpoint) => (
      !latest || Number(checkpoint.turn_no) > Number(latest.turn_no) ? checkpoint : latest
    ), null);
    this._latestCheckpointId = latestCheckpoint?.checkpoint_id ?? null;

    const archiveProposal = proposalValue(state.proposals.archive);
    const continuationProposal = proposalValue(state.proposals.continuation);
    this.$('#archive-status').textContent = archiveProposal?.proposal_id
      ? '已有归档提案，等待另一名玩家确认。'
      : '将以最新检查点归档，双方确认后生效。';
    this.$('#continuation-status').textContent = continuationProposal?.proposal_id
      ? '已有续接提案，等待另一名玩家确认角色接管差异。'
      : '房间归档后可从最新检查点继续。';
    const stagedImport = state.latestSourceImport?.import
      ?? state.latestSourceImport?.save_import
      ?? state.latestSourceImport;
    const recoveredImport = [...(state.lineage?.source_imports ?? [])]
      .reverse()
      .find(item => item?.source?.derived_from_export_id);
    this._latestSourceImportId = stagedImport?.source_import_id
      ?? stagedImport?.import_id
      ?? recoveredImport?.source_import_id
      ?? state.latestSourceImport?.source_import_id
      ?? state.latestSourceImport?.import_id
      ?? this._latestSourceImportId;
    this._latestAudienceDiffCommitment = stagedImport?.audience_diff_commitment
      ?? recoveredImport?.audience_diff_commitment
      ?? this._latestAudienceDiffCommitment;
    this._latestExportId = state.latestExport?.export_id
      ?? state.latestExport?.export?.export_id
      ?? this._latestExportId;
    this.$('#export-status').textContent = this._latestExportId
      ? '个人单机分支已生成，可以下载。'
      : '尚未生成个人单机分支。';

    const archived = state.room?.lifecycle === 'ARCHIVED';
    this.$('#propose-archive').disabled = archived || !this._latestCheckpointId || Boolean(archiveProposal?.proposal_id);
    this.$('#accept-archive').disabled = archived || !archiveProposal?.proposal_id;
    this.$('#propose-continuation').disabled = !archived
      || !this._latestCheckpointId
      || Boolean(continuationProposal?.proposal_id);
    this.$('#accept-continuation').disabled = !archived || !continuationProposal?.proposal_id;
    const existingDerived = (state.lineage?.origin_type ?? state.room?.origin_type)
      === 'existing_save_derived';
    const latestSourceOption = this.$('#continuation-mode option[value="fork_from_latest_source_save"]');
    latestSourceOption.disabled = !existingDerived;
    if (!existingDerived && this.$('#continuation-mode').value === 'fork_from_latest_source_save') {
      this.$('#continuation-mode').value = 'resume_room_checkpoint';
    }
    this.$('#personal-export-card').hidden = !existingDerived;
    this.$('#begin-export').disabled = !existingDerived || !this._latestCheckpointId;
    this.$('#download-export').disabled = !existingDerived || !this._latestExportId;
    this._updateRoomToolVisibility();
  }

  _updateRoomToolVisibility() {
    const existingDerived = (
      this._controller.state.lineage?.origin_type ?? this._controller.state.room?.origin_type
    ) === 'existing_save_derived';
    const latestSource = this.$('#continuation-mode').value === 'fork_from_latest_source_save';
    this.$('#latest-source-controls').hidden = !existingDerived || !latestSource;
  }

  _requireLatestCheckpoint() {
    if (!this._latestCheckpointId) throw new TypeError('当前房间还没有可用检查点');
    return this._latestCheckpointId;
  }

  _renderError(error) {
    const output = this.$('#error-output');
    if (!error) {
      output.hidden = true;
      output.textContent = '';
      return;
    }
    output.hidden = false;
    output.textContent = multiplayerErrorMessage(error);
  }
}

export const MULTIPLAYER_PANEL_TAG = 'naruto-multiplayer-panel';

if (globalThis.customElements && !globalThis.customElements.get(MULTIPLAYER_PANEL_TAG)) {
  globalThis.customElements.define(MULTIPLAYER_PANEL_TAG, NarutoMultiplayerPanel);
}
