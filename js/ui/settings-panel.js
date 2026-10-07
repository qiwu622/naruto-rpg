import { stateManager } from '../core/state-manager.js';
import { aiClient } from '../core/ai-client.js';
import { eventBus } from '../core/event-bus.js';
import { getAgentConfig, saveAgentConfig } from '../data/agent-config.js';
import { settingsStyles } from '../../css/components/settings-panel.css.js';
import { escHtml, escAttr } from '../utils/format.js';
import GameModal from './modal.js';
import { bindCustomSelects } from './custom-select.js';
import { getVariableUpdaterPreset } from '../data/variable-updater-preset.js';
import { VARIABLE_UPDATER_DEFAULT_TEMPERATURE } from '../core/variable-updater.js';
import './memory-panel.js';
import { CANON_DATABASE } from '../data/canon-database.js';
import './canon-database-editor.js';
import './worldbook-editor.js';
import './main-preset-editor.js';
import './variable-updater-preset-editor.js';
import { imageStudio } from '../core/image-studio/index.js';
import { ImageSettingsStore } from '../core/image-studio/settings.js';
import { getMemoryConfig } from '../data/memory-config.js';
import { resolveAICallPolicy } from '../core/ai-call-policy.js';
import { openImageGallery } from './image-studio.js';
import './api-config-form.js';
import { settingsConfigGateway } from './settings-config-gateway.js';
import { icon } from '../utils/icons.js';
import { musicService } from '../core/music-service.js';
import { musicPlayback } from '../core/music-playback.js';
import { usesProjectServerFeatures } from '../core/runtime-platform.js';
import { fetchProjectServer } from '../core/project-server.js';

const callPolicyImageSettingsStore = new ImageSettingsStore();
const SUPPORT_AFDIAN_URL = 'https://www.ifdian.net/a/2608_1?utm_source=copylink&utm_medium=link';
const SUPPORT_WECHAT_QR_URL = new URL('../../img/wechat-reward.png', import.meta.url).href;
const SUPPORT_GITHUB_URL = 'https://github.com/qiwu622/naruto-rpg';
const SUPPORT_ISSUES_URL = `${SUPPORT_GITHUB_URL}/issues`;

const THEME_PRESETS = {
  konoha: { label: '木叶卷轴', textColor: '#e8e4d9', accentColor: '#eb613f', goldColor: '#c69c6d', backgroundColor: '#070a0e',
    inkDeep: '7, 10, 14', ink: '11, 14, 19', paper: '255, 255, 255', washi: '244, 241, 234',
    dialogueColor: '#bae6fd', thoughtColor: '#c4b5fd', markColor: '#CE93D8' },
  anbu: { label: '暗部夜行', textColor: '#e6edf5', accentColor: '#6aa4ff', goldColor: '#9fb7d9', backgroundColor: '#080d16',
    inkDeep: '6, 10, 18', ink: '10, 16, 26', paper: '255, 255, 255', washi: '230, 237, 245',
    dialogueColor: '#a8c8ff', thoughtColor: '#b8a8e8', markColor: '#8fb8ff' },
  akatsuki: { label: '晓之绯云', textColor: '#f1e8e8', accentColor: '#d7263d', goldColor: '#e0b15a', backgroundColor: '#12070a',
    inkDeep: '18, 7, 10', ink: '24, 12, 15', paper: '255, 255, 255', washi: '241, 232, 232',
    dialogueColor: '#f0a8a8', thoughtColor: '#d8a8c8', markColor: '#e8a0b0' },
  scroll: { label: '古旧卷轴', textColor: '#3b2a18', accentColor: '#9a4b24', goldColor: '#8a5f2a', backgroundColor: '#ead7a8',
    inkDeep: '226, 208, 164', ink: '240, 228, 196', paper: '80, 58, 32', washi: '70, 52, 30',
    dialogueColor: '#8a4b1e', thoughtColor: '#6b5a9e', markColor: '#9a3b2e' },
  mist: { label: '雾隐冷雨', textColor: '#e8f3f5', accentColor: '#6bc7d9', goldColor: '#a8d8df', backgroundColor: '#0b1a1f',
    inkDeep: '8, 20, 25', ink: '12, 26, 32', paper: '255, 255, 255', washi: '232, 243, 245',
    dialogueColor: '#a8e0ea', thoughtColor: '#b0c8e8', markColor: '#8fd8e8' }
};

const FONT_PRESETS = {
  system: { label: '系统黑体', family: "'Noto Sans SC','Microsoft YaHei UI','PingFang SC','Segoe UI',system-ui,sans-serif" },
  serif: { label: '宋明体', family: "'Noto Serif SC','Source Han Serif SC','Songti SC','SimSun',serif" },
  kai: { label: '楷体手札', family: "'Kaiti SC','STKaiti','KaiTi',cursive" },
  mono: { label: '等宽字体', family: "'JetBrains Mono','Fira Code','Noto Sans SC',monospace" },
  round: { label: '圆润黑体', family: "'Noto Sans SC','Microsoft YaHei UI','PingFang SC',sans-serif" },
  song: { label: '中文宋体', family: "'Noto Serif SC','SimSun','Songti SC',serif" },
  fangsong: { label: '仿宋卷文', family: "'FangSong','STFangsong','Noto Serif SC',serif" },
  brush: { label: '毛笔手写', family: "'Kaiti SC','STKaiti','KaiTi',cursive" },
  custom: { label: '自定义', family: '' }
};

const DEFAULT_SETTINGS = stateManager.getDefaultState()._ui.settings;
const localAudio = musicPlayback;
const PLAYER_SECTION_ORDER = Object.freeze(['appearance', 'gameplay', 'connection', 'media']);
const PLAYER_SECTION_FIELDS = Object.freeze({
  appearance: Object.freeze(['themePreset', 'fontPreset', 'fontFamily', 'fontSize', 'lineHeight', 'chatMaxWidth', 'paragraphIndent', 'aiCardStyle', 'textColor', 'accentColor', 'goldColor', 'backgroundColor', 'backgroundImage', 'backgroundOpacity']),
  gameplay: Object.freeze(['showVariableSummary', 'reasoningOpen', 'tacticalCombat', 'autoArchive']),
  media: Object.freeze(['musicEnabled', 'musicVolume', 'musicLoop', 'musicShuffle'])
});

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function normalizeAudioList(list) {
  return (Array.isArray(list) ? list : []).map(item => {
    if (typeof item === 'string') return { title: '', url: item.trim() };
    return { title: item.title || '', url: String(item.url || '').trim() };
  }).filter(item => item.url);
}

function mergeSettings(settings = {}) {
  const next = { ...DEFAULT_SETTINGS, ...settings };
  if (!THEME_PRESETS[next.themePreset]) next.themePreset = DEFAULT_SETTINGS.themePreset;
  if (!FONT_PRESETS[next.fontPreset]) next.fontPreset = DEFAULT_SETTINGS.fontPreset || 'system';
  next.fontSize = clamp(next.fontSize, 12, 24, DEFAULT_SETTINGS.fontSize);
  next.lineHeight = clamp(next.lineHeight, 1.2, 2.4, DEFAULT_SETTINGS.lineHeight);
  next.chatMaxWidth = clamp(next.chatMaxWidth, 560, 1400, DEFAULT_SETTINGS.chatMaxWidth);
  next.backgroundOpacity = clamp(next.backgroundOpacity, 0.2, 1, DEFAULT_SETTINGS.backgroundOpacity);
  next.musicVolume = clamp(next.musicVolume, 0, 100, DEFAULT_SETTINGS.musicVolume);
  return next;
}

function esc(value) {
  return escHtml(value);
}

class SettingsPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  disconnectedCallback() {
    document.removeEventListener('keydown', this._onKeyDown);
    this._editorObserver?.disconnect();
    clearTimeout(this._toastTimer);
    queueMicrotask(() => {
      document.body?.classList.toggle(
        'settings-panel-open',
        Boolean(document.querySelector('settings-panel'))
      );
    });
  }

  connectedCallback() {
    document.body?.classList.add('settings-panel-open');
    this._mode = this.getAttribute('mode') === 'creator' ? 'creator' : 'player';
    this._settings = mergeSettings(stateManager.getSub('_ui').settings);
    this._nowPlayingSong = localAudio.currentTrack || this._nowPlayingSong || null;
    this._activeSection = this._activeSection || this.getAttribute('section') || 'appearance';
    this._activeTool = this._activeTool || this.getAttribute('tool') || 'pipeline';
    this._dirtySections = this._dirtySections || new Set();
    this._dirtyRevisions = this._dirtyRevisions || new Map();
    this._draftSideEffects = {
      musicLoop: localStorage.getItem('naruto_music_loop'),
      musicShuffle: localStorage.getItem('naruto_music_shuffle')
    };
    this._onKeyDown = (e) => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('keydown', this._onKeyDown);
    this.render();
    const imageSettings = this.shadowRoot.querySelector('image-studio-settings');
    if (imageSettings) imageSettings.imageStudio = imageStudio;
    this._hydrate();
    bindCustomSelects(this.shadowRoot);
    if (this._mode === 'creator') this._selectTool(this._activeTool, { focus: false });
    else this._selectSection(this._activeSection, { focus: false });
  }

  open({ section = 'appearance', anchor = '', tool = '', resourceId = '' } = {}) {
    if (this._mode === 'creator' || tool) {
      if (this.shadowRoot?.querySelector('.workbench-editor-layer.active > *')) return this;
      const nextTool = tool || this._activeTool || 'pipeline';
      if (this.shadowRoot?.querySelector('.panel') && nextTool === this._activeTool && !resourceId) return this;
      this._activeTool = nextTool;
      this._resourceId = resourceId;
      if (this.shadowRoot?.querySelector('.panel')) this._selectTool(this._activeTool, { resourceId });
    } else {
      if (this.shadowRoot?.querySelector('.panel') && section === this._activeSection && !anchor) return this;
      this._activeSection = section;
      if (this.shadowRoot?.querySelector('.panel')) this._selectSection(section, { anchor });
    }
    return this;
  }

  render() {
    const s = this._settings;
    const isCreator = this._mode === 'creator';
    const projectServerFeatures = usesProjectServerFeatures();
    const apiConfig = stateManager.getAPIConfig() || {};
    const agentConfig = getAgentConfig();
    const callPolicy = resolveAICallPolicy({
      apiConfig,
      agentConfig,
      memoryConfig: getMemoryConfig(),
      imageSettings: callPolicyImageSettingsStore.load()
    });
    const variablePreset = getVariableUpdaterPreset();
    const plotStats = CANON_DATABASE.getStats('plot');
    const techniqueStats = CANON_DATABASE.getStats('techniques');
    const imagePlayerSettings = callPolicyImageSettingsStore.load();
    this.shadowRoot.innerHTML = `
      <style>${settingsStyles}</style>
      <div class="backdrop" data-close="true">
        <div class="panel${isCreator ? ' creator' : ''}" role="dialog" aria-modal="true" aria-label="${isCreator ? '创作者工作台' : '玩家设置'}">
          <div class="inner-bg"></div>
          <div class="head">
            <div class="title"><span>${isCreator ? '編' : '巻'}</span><div>${isCreator ? '创作者工作台' : '玩家设置'}<small>${isCreator ? '叙事资源与生成运行时' : '阅读、游玩与连接'}</small></div></div>
            <div class="head-actions">
              <button class="workbench-link" type="button" data-action="${isCreator ? 'open-player-settings' : 'open-creator-workbench'}">${isCreator ? '玩家设置' : '创作者工作台'}</button>
              <button class="close" data-action="close" aria-label="关闭设置">×</button>
            </div>
          </div>
          <div class="layout">
            <aside class="sidebar">
              ${isCreator ? `
                <button class="tab-btn active" data-tool="pipeline" data-targets="tab-agent,tab-variable">生成管线</button>
                <button class="tab-btn" data-tool="knowledge" data-targets="tab-lore">提示词与知识</button>
                <button class="tab-btn" data-tool="canon" data-targets="tab-canon-plot,tab-canon-techniques">原作数据库</button>
                <button class="tab-btn" data-tool="image" data-targets="tab-image">画面工坊</button>
                <button class="tab-btn" data-tool="memory" data-targets="tab-memory">记忆运行时</button>
              ` : `
                <button class="tab-btn active" data-section="appearance" data-target="tab-visual">外观与阅读</button>
                <button class="tab-btn" data-section="gameplay" data-target="tab-system">游玩与输出</button>
                <button class="tab-btn" data-section="connection" data-target="tab-connection">AI 连接</button>
                <button class="tab-btn" data-section="media" data-target="tab-audio">声音与画面</button>
                <button class="tab-btn support-tab" data-section="support" data-target="tab-support">支持项目</button>
              `}
            </aside>
            <main class="content">
              ${isCreator ? `<div class="connection-strip"><span class="connection-dot${apiConfig.model ? ' online' : ''}"></span><span>${apiConfig.model ? `主连接 · ${escHtml(apiConfig.model)}` : '主连接尚未配置'}</span><button type="button" data-action="open-player-connection">${apiConfig.model ? '查看连接' : '前往配置'}</button></div>` : ''}
              
              <!-- Tab 1: 视觉与环境 -->
              <div class="tab-pane active" id="tab-visual">
                <div class="pane-grid">
                  <section data-anchor="typography" tabindex="-1">
                    <h3>排版与视觉</h3>
                    <div class="grid">
                      <label>视觉主题</label>
                      <select name="themePreset">${Object.entries(THEME_PRESETS).map(([k,v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
                      <label>字体预设</label>
                      <select name="fontPreset">${Object.entries(FONT_PRESETS).map(([k,v]) => `<option value="${k}">${v.label}</option>`).join('')}</select>
                      <label>自定义字体</label>
                      <input type="text" name="fontFamily" value="${escAttr(s.fontFamily)}" placeholder="'Noto Sans SC', sans-serif">
                      <label>阅读字号</label>
                      <input type="number" name="fontSize" min="12" max="24" value="${s.fontSize}">
                      <label>行间距</label>
                      <input type="number" name="lineHeight" min="1.2" max="2.4" step="0.05" value="${s.lineHeight}">
                      <label>正文宽度 (px)</label>
                      <input type="number" name="chatMaxWidth" min="560" max="1400" value="${s.chatMaxWidth}">
                      <label>首行缩进</label>
                      <input type="checkbox" name="paragraphIndent">
                      <label>对话框风格</label>
                      <select name="aiCardStyle">
                        <option value="line">朱印侧线</option>
                        <option value="card">卷轴卡片</option>
                        <option value="plain">极简留白</option>
                      </select>
                    </div>
                  </section>
                  <section data-anchor="colors" tabindex="-1">
                    <h3>色彩与环境</h3>
                    <div class="grid">
                      <label>正文颜色</label>
                      <div class="color-picker-wrap"><input type="color" name="textColor" value="${s.textColor}"></div>
                      <label>强调色 (朱)</label>
                      <div class="color-picker-wrap"><input type="color" name="accentColor" value="${s.accentColor}"></div>
                      <label>金印色 (金)</label>
                      <div class="color-picker-wrap"><input type="color" name="goldColor" value="${s.goldColor}"></div>
                      <label>背景底色 (墨)</label>
                      <div class="color-picker-wrap"><input type="color" name="backgroundColor" value="${s.backgroundColor}"></div>
                      <label>背景图链接</label>
                      <input type="text" name="backgroundImage" value="${escAttr(s.backgroundImage)}" placeholder="https://...">
                      <label>本地背景图</label>
                      <input class="file-input" name="backgroundFile" type="file" accept="image/*">
                      <label>背景昏暗度</label>
                      <input type="number" name="backgroundOpacity" min="0" max="1" step="0.05" value="${s.backgroundOpacity}">
                    </div>
                  </section>
                </div>
              </div>

              <div class="tab-pane" id="tab-connection">
                <section class="connection-section" data-anchor="main-connection" tabindex="-1">
                  <div class="section-heading">
                    <div><span class="eyebrow">MAIN CONNECTION</span><h3>主 AI 连接</h3></div>
                    <span class="owner-badge">唯一配置入口</span>
                  </div>
                  <p class="setting-note">正文生成使用此连接。创作者工作台中的辅助模型默认继承这里的地址、密钥与模型。</p>
                  <api-config-form config='${escAttr(JSON.stringify(apiConfig))}' show-advanced show-schemes></api-config-form>
                </section>
              </div>

              <div class="tab-pane" id="tab-image">
                <image-studio-settings></image-studio-settings>
              </div>

              <!-- Tab 2: 引擎与代理 -->
              <div class="tab-pane" id="tab-agent">
                <section>
                  <h3>AI 调用策略</h3>
                  <div class="config-card">
                    <label class="config-card-toggle">
                      <input type="checkbox" name="strictSingleCall" ${callPolicy.strictSingleCall ? 'checked' : ''}>
                      <strong>严格单模型 · 单调用</strong>
                    </label>
                    <p class="setting-note" style="margin:10px 0 8px;">开启后每个游戏回合固定只发送一次主文本请求：暂停 Agent、二次变量、正文复检、AI 记忆整理、NPC AI 总结以及自动图片规划/生成。失败后只显示手动重试，不会透明重发。主动勾选 Agent、二次变量或正文复检时会退出严格模式；设置页手动整理记忆或手动生成图片仍可单独调用。</p>
                    <div id="ai-call-estimate" role="status" class="config-card-estimate">${escHtml(callPolicy.estimateText)}</div>
                    <div id="ai-call-blocked" class="config-card-blocked">${callPolicy.blockedFeatures.length ? `当前暂停：${escHtml(callPolicy.blockedFeatures.map(item => item.label).join('、'))}` : ''}</div>
                  </div>
                </section>
                <section>
                   <h3>Agent 高质量正文模式</h3>
                   <div class="config-card">
                     <p class="config-card-note">
                       开启后每回合由多个AI Agent协作生成：场景节拍→详细写作大纲→终审→正文定稿→变量结算。<br>
                       完整模式增加头脑风暴和角色代理。建议战斗/重要场景开启，日常关闭。
                     </p>
                     <div class="grid config-card-grid">
                       <label>启用 Agent 模式</label>
                       <input type="checkbox" name="agentEnabled" ${getAgentConfig().enabled ? 'checked' : ''}>
                       <label>生成模式</label>
                       <select name="agentMode">
                         <option value="standard" ${getAgentConfig().mode === 'standard' ? 'selected' : ''}>标准模式 (+3-5次调用, 约30-75s)</option>
                         <option value="full" ${getAgentConfig().mode === 'full' ? 'selected' : ''}>完整模式 (+8-13次调用, 约90-210s)</option>
                       </select>
                       <label>战斗自动升级完整模式</label>
                       <input type="checkbox" name="agentAutoUpgrade" ${getAgentConfig().autoUpgrade !== false ? 'checked' : ''}>
                       <label class="config-label-sub">并发上限 (1-10)</label>
                       <input type="number" name="agentMaxConcurrency" min="1" max="10" step="1" value="${Number(getAgentConfig().maxConcurrency) || 10}" title="同时进行的 AI 请求数上限。并发高会让回合更快但更易触发上游限流，4090 走代理时可保持 10。">
                       <label class="config-label-sub">Agent 模型 (留空=主模型)</label>
                       <div class="inline-field">
                         <input type="text" name="agentModel" value="${getAgentConfig().agentModel || ''}" placeholder="留空使用主模型" list="settings-agent-datalist">
                         <button type="button" class="btn ghost btn-xs" data-action="fetch-models" data-target="agentModel">读取</button>
                       </div>
                       <datalist id="settings-agent-datalist"></datalist>
                       <label class="config-label-sub">Critic 模型 (建议廉价模型)</label>
                       <div class="inline-field">
                         <input type="text" name="criticModel" value="${getAgentConfig().criticModel || ''}" placeholder="留空使用主模型" list="settings-critic-datalist">
                         <button type="button" class="btn ghost btn-xs" data-action="fetch-models" data-target="criticModel">读取</button>
                       </div>
                       <datalist id="settings-critic-datalist"></datalist>
                     </div>
                   </div>
                 </section>
                 <section>
                   <h3>正文双阶段复检</h3>
                   <p class="setting-note">默认关闭。开启后先静默生成草稿，再由复检模型依据当前安全证据生成一份“尚未提交”的预览。你可以应用预览、填写反馈反复重试，或保留原稿；作出选择前不会修改变量、记忆或时间线，审校记录永不显示和入库。留空项继承主模型。</p>
                   <div class="grid variable-grid">
                     <label>启用正文复检</label>
                     <input type="checkbox" name="narrativeReviewEnabled" ${apiConfig.narrativeReview?.enabled ? 'checked' : ''}>
                     <label>后端类型</label>
                     <select name="narrativeReviewBackend">
                       <option value="inherit">跟随主模型</option>
                       <option value="openai">OpenAI 兼容</option>
                       <option value="claude">Claude / Anthropic</option>
                       <option value="deepseek">DeepSeek</option>
                       <option value="custom">自定义兼容</option>
                       <option value="tavern">酒馆环境</option>
                     </select>
                     <label>API 地址</label>
                     <input type="text" name="narrativeReviewApiUrl" value="${escAttr(apiConfig.narrativeReview?.apiUrl || '')}" placeholder="留空继承主 API 地址">
                     <label>API Key</label>
                     <input type="password" name="narrativeReviewApiKey" value="${escAttr(apiConfig.narrativeReview?.apiKey || '')}" placeholder="留空继承主 API Key">
                     <label>复检模型</label>
                     <div class="inline-field">
                       <input type="text" name="narrativeReviewModel" value="${escAttr(apiConfig.narrativeReview?.model || '')}" placeholder="留空继承主模型">
                       <button type="button" class="btn ghost btn-xs" data-action="fetch-models" data-target="narrativeReviewModel">读取</button>
                     </div>
                     <label>Temperature</label>
                     <input type="number" name="narrativeReviewTemperature" min="0" max="2" step="0.05" value="${apiConfig.narrativeReview?.temperature ?? 0.25}">
                     <label>Max Tokens</label>
                     <input type="number" name="narrativeReviewMaxTokens" min="1024" max="65536" step="1024" value="${apiConfig.narrativeReview?.maxTokens ?? 16384}">
                     <label>流式接收复检预览</label>
                     <input type="checkbox" name="narrativeReviewStreaming" ${apiConfig.narrativeReview?.streaming !== false ? 'checked' : ''}>
                   </div>
                 </section>
               </div>

              <!-- Tab 3: 变量更新 -->
              <div class="tab-pane" id="tab-variable">
                <div class="pane-grid">
                  <section>
                    <h3>变量更新模型</h3>
                    <p class="setting-note">与主叙事模型完全分离。留空的 API、Key、模型与后端会实时继承主模型配置。</p>
                    <div class="grid variable-grid">
                      <label>启用变量更新</label>
                      <input type="checkbox" name="varUpdaterEnabled" ${apiConfig.variableUpdater?.enabled ? 'checked' : ''}>
                      <label>后端类型</label>
                      <select name="varUpdaterBackend">
                        <option value="inherit">跟随主模型</option>
                        <option value="openai">OpenAI 兼容</option>
                        <option value="claude">Claude / Anthropic</option>
                        <option value="deepseek">DeepSeek</option>
                        <option value="custom">自定义兼容</option>
                      </select>
                      <label>API 地址</label>
                      <input type="text" name="varUpdaterApiUrl" value="${escAttr(apiConfig.variableUpdater?.apiUrl || '')}" placeholder="留空继承主 API 地址">
                      <label>API Key</label>
                      <input type="password" name="varUpdaterApiKey" value="${escAttr(apiConfig.variableUpdater?.apiKey || '')}" placeholder="留空继承主 API Key">
                      <label>变量模型</label>
                      <div class="inline-field">
                        <input type="text" name="varUpdaterModel" value="${escAttr(apiConfig.variableUpdater?.model || '')}" placeholder="留空继承主模型">
                        <button type="button" class="btn ghost btn-xs" data-action="fetch-models" data-target="varUpdaterModel">读取</button>
                      </div>
                      <label>Temperature</label>
                      <input type="number" name="varUpdaterTemperature" min="0" max="2" step="0.05" value="${apiConfig.variableUpdater?.temperature ?? VARIABLE_UPDATER_DEFAULT_TEMPERATURE}">
                      <label>Max Tokens</label>
                      <input type="number" name="varUpdaterMaxTokens" min="256" max="32768" step="256" value="${apiConfig.variableUpdater?.maxTokens ?? 8192}">
                      <label>流式传输</label>
                      <input type="checkbox" name="varUpdaterStreaming" ${apiConfig.variableUpdater?.streaming !== false ? 'checked' : ''}>
                    </div>
                  </section>
                  <section>
                    <h3>变量更新预设</h3>
                    <div class="prompt-preset-card">
                      <strong id="variable-preset-name">${escHtml(variablePreset.name || '未命名变量更新预设')}</strong>
                      <span id="variable-preset-count">${variablePreset.entries?.length || 0} 个预设条目 · ${variablePreset.entries?.filter(entry => entry.enabled !== false).length || 0} 个已启用</span>
                      <p>可查看并编辑真实 system/user role 链，支持保存、JSON 导入、JSON 导出、增删排序和恢复默认。运行时直接读取此预设，不再使用隐藏硬编码内容。</p>
                      <button class="btn primary" type="button" data-action="open-variable-updater-preset-editor">编辑 / 导入 / 导出</button>
                    </div>
                  </section>
                </div>
              </div>

              <!-- Tab 4: 世界书与预设 -->
              <div class="tab-pane" id="tab-lore">
                <section style="margin-bottom: 32px;">
                   <h3>世界书管理 · 知识库</h3>
                   <div class="config-card config-card-center">
                     <p class="config-card-note">使用可视化的编辑器管理、导入和导出游戏内的世界书条目。</p>
                     <button class="btn primary" type="button" data-action="open-worldbook-editor">打开世界书编辑器</button>
                   </div>
                </section>
                <section>
                   <h3>预设管理</h3>
                   <div class="config-card">
                     <p class="config-card-title">主预设 · Narutomech</p>
                     <p class="config-card-note">管理文风破限、角色扮演、CoT回映等高级预设条目。支持开关、增删、修改、拖拽排序。</p>
                     <button class="btn primary" type="button" data-action="open-main-preset-editor">打开主预设编辑器</button>
                   </div>
                </section>
              </div>

              <div class="tab-pane" id="tab-canon-plot" data-resource-id="plot" tabindex="-1">
                <section>
                  <h3>剧情数据库 · DAY / SCN / EV</h3>
                  <div class="database-summary">
                    <div class="database-metrics" id="canon-plot-summary">
                      <span><strong>${plotStats.effective}</strong>启用</span><span><strong>${plotStats.modified}</strong>修改</span><span><strong>${plotStats.custom}</strong>新增</span><span><strong>${plotStats.disabled}</strong>停用</span>
                    </div>
                    <button class="btn primary" type="button" data-action="open-canon-plot-editor">管理剧情日</button>
                  </div>
                </section>
              </div>

              <div class="tab-pane" id="tab-canon-techniques" data-resource-id="techniques" tabindex="-1">
                <section>
                  <h3>忍术数据库 · JT</h3>
                  <div class="database-summary">
                    <div class="database-metrics" id="canon-techniques-summary">
                      <span><strong>${techniqueStats.effective}</strong>启用</span><span><strong>${techniqueStats.modified}</strong>修改</span><span><strong>${techniqueStats.custom}</strong>新增</span><span><strong>${techniqueStats.disabled}</strong>停用</span>
                    </div>
                    <button class="btn primary" type="button" data-action="open-canon-techniques-editor">管理忍术记录</button>
                  </div>
                </section>
              </div>


              <!-- Tab 4: 忍道音律 -->
              <div class="tab-pane" id="tab-audio">
                <section class="media-image-section" data-anchor="image-generation" tabindex="-1">
                  <div class="section-heading">
                    <div><span class="eyebrow">ILLUSTRATION</span><h3>回合插图</h3></div>
                    <button class="btn ghost" type="button" data-action="open-creator-image">画面工坊</button>
                  </div>
                  <p class="setting-note">这里仅控制游玩时是否生成插图。绘图后端、工作流和图像世界书在创作者工作台中配置。</p>
                  <div class="grid compact-grid">
                    <label>启用插图</label>
                    <input type="checkbox" name="imageEnabled" ${imagePlayerSettings.enabled ? 'checked' : ''}>
                    <label>生成时机</label>
                    <select name="imageTurnMode">
                      <option value="manual" ${imagePlayerSettings.turnMode === 'manual' ? 'selected' : ''}>手动生成</option>
                      <option value="auto" ${imagePlayerSettings.turnMode === 'auto' ? 'selected' : ''}>每回合自动</option>
                    </select>
                    <span></span><button class="btn" type="button" data-action="open-image-gallery">打开图库</button>
                  </div>
                </section>
                <section data-anchor="music-library" tabindex="-1">
                   <h3>音乐库 · 忍道韵律</h3>
                   <div class="music-panel">
                      <div class="music-player-bar">
                        <div class="music-info">
                          <span class="music-now" id="music-now">尚未选择曲目</span>
                          <span class="music-status" id="music-playing-artist"></span>
                        </div>
                        <div class="music-controls">
                          <label><input type="checkbox" name="musicEnabled"> 启用</label>
                          <label><input type="checkbox" name="musicLoop"> 轮播</label>
                          <label><input type="checkbox" name="musicShuffle"> 随机</label>
                          <label>音量 <input type="range" name="musicVolume" min="0" max="100" value="${s.musicVolume}"></label>
                          <button class="btn ghost btn-xs" type="button" data-action="toggle-lyrics">歌词</button>
                          ${projectServerFeatures ? '<button class="btn ghost btn-xs" type="button" data-action="sync-favorites-up" title="上传收藏到云端">☁↑</button><button class="btn ghost btn-xs" type="button" data-action="sync-favorites-down" title="从云端下载收藏">☁↓</button>' : ''}
                          <span class="music-sync-status" id="music-sync-status"></span>
                        </div>
                      </div>
                     <div class="music-search-row">
                       <input type="text" name="musicSearch" placeholder="搜索全球音乐库，例如：火影忍者 青鸟">
                       <button class="btn" type="button" data-action="search-music">探索</button>
                     </div>
                     <div class="music-tabs"><button class="music-tab active" data-tab="search">搜索结果</button><button class="music-tab" data-tab="playlist">播放历史</button><button class="music-tab" data-tab="favorites">收藏曲目</button></div>
                     <div class="music-result-list" id="music-result-list">
                        <div class="music-empty-hint">在上方输入歌名或歌手，例如「火影忍者 青鸟」，按下探索</div>
                     </div>
                   </div>
                </section>
              </div>

              <!-- Tab: 记忆编年 -->
              <div class="tab-pane" id="tab-memory">
                <memory-panel></memory-panel>
              </div>

              <!-- Tab 5: 游玩与输出 -->
              <div class="tab-pane" id="tab-system">
                <section data-anchor="output" tabindex="-1">
                  <h3>输出显示</h3>
                  <div class="setting-cards">
                    <label class="setting-card">
                      <span class="sc-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M8 14h8"/><path d="M8 17h5"/></svg></span>
                      <span class="sc-main">
                        <span class="sc-title">变量摘要</span>
                        <span class="sc-desc">回合结束后展示属性、物品与羁绊的变化清单，便于追踪成长轨迹</span>
                      </span>
                      <input type="checkbox" name="showVariableSummary">
                    </label>
                    <label class="setting-card">
                      <span class="sc-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 3"/><path d="M17 3l4 4-4 4"/></svg></span>
                      <span class="sc-main">
                        <span class="sc-title">思维链展开</span>
                        <span class="sc-desc">默认展开 AI 的推理过程折叠块，关闭后需手动点开查看</span>
                      </span>
                      <input type="checkbox" name="reasoningOpen">
                    </label>
                    <label class="setting-card">
                      <span class="sc-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><path d="M19 21l2-2"/></svg></span>
                      <span class="sc-main">
                        <span class="sc-title">打开战斗面板</span>
                        <span class="sc-desc">也可用顶部「战斗」按钮开启。打开后启用招式、命中与战报规则；关闭后按普通正文推进，不加入面板专用规则。</span>
                      </span>
                      <input type="checkbox" name="tacticalCombat">
                    </label>
                  </div>
                </section>
                <section class="storage-section" data-anchor="storage" tabindex="-1">
                  <div class="section-heading">
                    <div><span class="eyebrow">LOCAL TIMELINE</span><h3>存档与空间</h3></div>
                    <span class="owner-badge">本地时间线</span>
                  </div>
                  <p class="setting-note">超过 20 回后，最近 20 层保持可即时点开；更早的回合会 gzip 压缩存进浏览器。点进这些回合时会自动解压，跳转、检查点、导出导入和 IF 线都会保留。</p>
                  <div class="storage-tool">
                    <label class="archive-toggle-row">
                      <span class="storage-tool-icon">${icon('database', 18)}</span>
                      <span class="storage-toggle-copy">
                        <strong>自动压缩旧回合</strong>
                        <span>最近 20 层保持明文，更早的回合 gzip 压缩，点进去再解压</span>
                      </span>
                      <input type="checkbox" name="autoArchive">
                    </label>
                    <div class="storage-status" id="storage-info" role="status" aria-live="polite">等待统计...</div>
                    <div class="storage-actions">
                      <button class="btn primary" type="button" data-action="save-library">${icon('book-open', 15)}<span>本地存档库</span></button>
                      <button class="btn ghost" type="button" data-action="check-storage" title="刷新存档空间统计">${icon('database', 15)}<span>刷新统计</span></button>
                      <button class="btn ghost" type="button" data-action="manual-archive" title="立即压缩旧时间线回合">${icon('timeline', 15)}<span>立即压缩</span></button>
                      <button class="btn primary" type="button" data-action="export-save" title="导出无损 gzip 压缩存档">${icon('export', 15)}<span>压缩导出</span></button>
                      <button class="btn ghost" type="button" data-action="export-save-json" title="导出未压缩的普通 JSON 存档">${icon('file-text', 15)}<span>普通 JSON</span></button>
                    </div>
                  </div>
                </section>
              </div>

              <div class="tab-pane" id="tab-support">
                <section class="support-section" data-anchor="support" tabindex="-1">
                  <div class="section-heading">
                    <div><span class="eyebrow">KEEP THE STORY GOING</span><h3>支持忍者手记持续开发</h3></div>
                    <span class="owner-badge support-badge">开源 · 独立维护</span>
                  </div>
                  <div class="support-story">
                    <div class="support-meta" aria-label="项目概况">
                      <span>${icon('developer', 14)}个人独立开发</span>
                      <span>${icon('book-open', 14)}开源 RPG</span>
                      <span>${icon('timeline', 14)}持续维护</span>
                    </div>
                    <p class="support-lead">忍者手记是一款由个人独立开发并持续维护的开源 RPG 项目。</p>
                    <p>项目从最初的创意开始，经历了玩法设计、系统开发、测试优化以及持续迭代。目前已经拥有约 1700 名注册用户，每天都有新玩家进入游戏体验。</p>
                    <p>作为一个个人开发项目，忍者手记的运行和成长离不开持续投入。服务器维护、开发工具、测试环境以及新内容制作，都需要投入时间与资源。</p>
                  </div>
                  <div class="support-impact">
                    <div class="support-block-heading"><span>FUNDING USE</span><h4>你的支持将用于</h4></div>
                    <ul class="support-use-list">
                      <li><span class="support-use-icon" aria-hidden="true">${icon('cloud', 17)}</span><span>项目服务器及运行环境维护</span></li>
                      <li><span class="support-use-icon" aria-hidden="true">${icon('developer', 17)}</span><span>新玩法与功能开发</span></li>
                      <li><span class="support-use-icon" aria-hidden="true">${icon('settings', 17)}</span><span>游戏体验优化</span></li>
                      <li><span class="support-use-icon" aria-hidden="true">${icon('timeline', 17)}</span><span>项目长期维护与更新</span></li>
                    </ul>
                  </div>
                  <p class="support-recognition">每一份支持，都是对独立开发创作的认可，也会帮助忍者手记继续成长。</p>
                  <div class="support-block-heading support-options-heading"><span>SUPPORT OPTIONS</span><h4>选择支持方式</h4></div>
                  <div class="support-methods">
                    <article class="support-method support-method-afdian">
                      <span class="support-method-icon" aria-hidden="true">${icon('heart', 20)}</span>
                      <div class="support-method-copy">
                        <span class="support-method-kicker">爱发电</span>
                        <strong>持续支持开发</strong>
                        <p>通过爱发电选择适合你的支持方式。</p>
                      </div>
                      <a class="btn primary support-primary-link" href="${escAttr(SUPPORT_AFDIAN_URL)}" target="_blank" rel="noopener noreferrer">
                        <span>前往爱发电</span>${icon('external-link', 15)}
                      </a>
                    </article>
                    <article class="support-method support-method-wechat">
                      <div class="support-method-overview">
                        <span class="support-method-icon" aria-hidden="true">${icon('mobile', 20)}</span>
                        <div class="support-method-copy">
                          <span class="support-method-kicker">微信赞赏</span>
                          <strong>扫码支持</strong>
                          <p>使用微信赞赏码直接支持项目维护。</p>
                        </div>
                      </div>
                      <div class="support-qr">
                        <a class="support-qr-frame" href="${escAttr(SUPPORT_WECHAT_QR_URL)}" target="_blank" rel="noopener noreferrer" aria-label="在新窗口查看微信赞赏码原图">
                          <img src="${escAttr(SUPPORT_WECHAT_QR_URL)}" alt="微信赞赏码" width="1210" height="1210" loading="lazy" decoding="async">
                        </a>
                        <div class="support-image-actions">
                          <a href="${escAttr(SUPPORT_WECHAT_QR_URL)}" target="_blank" rel="noopener noreferrer">${icon('external-link', 14)}<span>查看原图</span></a>
                          <a href="${escAttr(SUPPORT_WECHAT_QR_URL)}" download="naruto-rpg-wechat-reward.png">${icon('download', 14)}<span>保存图片</span></a>
                        </div>
                      </div>
                    </article>
                  </div>
                  <div class="support-community">
                    <p>即使不进行赞助，你也可以通过体验游戏、提出建议、反馈问题或关注项目进展来帮助忍者手记发展。</p>
                    <div class="support-community-actions">
                      <a class="btn ghost support-community-link" href="https://www.qiwu.asia/announcements.html" target="_blank" rel="noopener noreferrer">${icon('book-open', 15)}<span>更新公告与历史版本</span>${icon('external-link', 13)}</a>
                      <a class="btn ghost support-community-link" href="${escAttr(SUPPORT_GITHUB_URL)}" target="_blank" rel="noopener noreferrer">${icon('book-open', 15)}<span>查看开源项目</span>${icon('external-link', 13)}</a>
                      <a class="btn ghost support-community-link" href="${escAttr(SUPPORT_ISSUES_URL)}" target="_blank" rel="noopener noreferrer">${icon('developer', 15)}<span>提交建议或问题</span>${icon('external-link', 13)}</a>
                    </div>
                  </div>
                  <p class="support-gratitude">感谢每一位参与忍者手记成长过程的玩家。</p>
                </section>
              </div>

            </main>
            ${isCreator ? '<div class="workbench-editor-layer" aria-live="polite"></div>' : ''}
          </div>
          <div class="actions">
            <span class="save-state" role="status">当前页面的修改尚未应用</span>
            <button class="btn ghost" data-action="close">${isCreator ? '返回游戏' : '放弃'}</button>
            <button class="btn primary" data-action="save">${isCreator ? '应用管线' : '应用'}</button>
          </div>
        </div>
      </div>`;
    this._bind();
  }

  _hydrate() {
    const s = this._settings;
    for (const [name, value] of Object.entries(s)) {
      if (name === 'bgmList' || name === 'ambientList' || name === 'backgroundFile' || name === 'musicSearch') continue;
      this._set(name, Array.isArray(value) ? JSON.stringify(value, null, 2) : value);
    }
    this._set('fontPreset', s.fontPreset || this._inferFontPreset(s.fontFamily));
    if (localStorage.getItem('naruto_music_loop') !== null) this._set('musicLoop', this._getLoop());
    if (localStorage.getItem('naruto_music_shuffle') !== null) this._set('musicShuffle', this._getShuffle());
    this._set('varUpdaterBackend', stateManager.getAPIConfig()?.variableUpdater?.backend || 'inherit');
    this._set('narrativeReviewBackend', stateManager.getAPIConfig()?.narrativeReview?.backend || 'inherit');
  }

  _set(name, value) {
    const el = this.shadowRoot.querySelector(`[name="${name}"]`);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = value ?? '';
  }

  _get(name, fallback = '') {
    const el = this.shadowRoot.querySelector(`[name="${name}"]`);
    if (!el) return fallback;
    return el.type === 'checkbox' ? el.checked : el.value;
  }

  _bind() {
    this.shadowRoot.querySelector('.backdrop').addEventListener('click', e => { if (e.target.dataset.close) this.close(); });
    this.shadowRoot.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', (e) => this._handle(btn.dataset.action, e)));
    this.shadowRoot.querySelector('[name="themePreset"]').addEventListener('change', () => this._applyThemeToFields());
    this.shadowRoot.querySelector('[name="fontPreset"]').addEventListener('change', () => this._applyFontPreset());
    this.shadowRoot.querySelector('[name="musicEnabled"]').addEventListener('change', () => this._syncAudio());
    this.shadowRoot.querySelector('[name="musicLoop"]').addEventListener('change', () => { this._setLoop(this._get('musicLoop')); this._syncAudio(); });
    this.shadowRoot.querySelector('[name="musicShuffle"]').addEventListener('change', () => { this._setShuffle(this._get('musicShuffle')); });
    this.shadowRoot.querySelector('[name="musicVolume"]').addEventListener('input', () => this._syncAudio());
    for (const name of ['strictSingleCall', 'agentEnabled', 'agentMode', 'narrativeReviewEnabled', 'varUpdaterEnabled']) {
      this.shadowRoot.querySelector(`[name="${name}"]`)?.addEventListener('change', event => {
        if (['agentEnabled', 'narrativeReviewEnabled', 'varUpdaterEnabled'].includes(name) && event.target.checked) {
          const strict = this.shadowRoot.querySelector('[name="strictSingleCall"]');
          if (strict) strict.checked = false;
        }
        this._refreshAICallEstimate();
      });
    }
    this.shadowRoot.addEventListener('memory-config:changed', () => this._refreshAICallEstimate());
    this.shadowRoot.querySelectorAll('.music-tab').forEach(t => t.addEventListener('click', () => this._switchMusicTab(t.dataset.tab)));
    const syncUpBtn = this.shadowRoot.querySelector('[data-action="sync-favorites-up"]');
    if (syncUpBtn) syncUpBtn.addEventListener('click', () => this._syncFavoritesToServer());
    const syncDownBtn = this.shadowRoot.querySelector('[data-action="sync-favorites-down"]');
    if (syncDownBtn) syncDownBtn.addEventListener('click', () => this._syncFavoritesFromServer());
    this.shadowRoot.querySelector('[name="backgroundFile"]')?.addEventListener('change', event => this._importBackgroundFile(event));

    this.shadowRoot.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (this._mode === 'creator') this._selectTool(btn.dataset.tool || 'pipeline');
        else this._selectSection(btn.dataset.section || 'appearance');
        const mp = this.shadowRoot.querySelector('memory-panel');
        if ((btn.dataset.target === 'tab-memory' || btn.dataset.tool === 'memory') && mp) mp.refreshStats();
      });
    });

    const markContentDirty = (event) => {
      const origin = event.composedPath?.()[0] || event.target;
      if (this._mode === 'player' && origin?.name === 'musicSearch') return;
      this._markDirty(this._mode === 'creator' ? this._activeTool : this._activeSection);
    };
    this.shadowRoot.querySelector('.content')?.addEventListener('input', markContentDirty);
    this.shadowRoot.querySelector('.content')?.addEventListener('change', markContentDirty);

  }

  _getScrollContainer() {
    const layout = this.shadowRoot.querySelector('.layout');
    return layout && /auto|scroll/.test(getComputedStyle(layout).overflowY)
      ? layout
      : this.shadowRoot.querySelector('.content');
  }

  _selectSection(section, { focus = true, anchor = '' } = {}) {
    const button = this.shadowRoot.querySelector(`.tab-btn[data-section="${section}"]`)
      || this.shadowRoot.querySelector('.tab-btn');
    if (!button) return;
    this._activeSection = button.dataset.section || 'appearance';
    this.shadowRoot.querySelectorAll('.tab-btn').forEach(item => item.classList.toggle('active', item === button));
    this.shadowRoot.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
    this.shadowRoot.getElementById(button.dataset.target)?.classList.add('active');
    const content = this._getScrollContainer();
    if (content) content.scrollTop = 0;
    const target = anchor
      ? [...this.shadowRoot.querySelectorAll('[data-anchor]')].find(item => item.dataset.anchor === anchor)
        || this.shadowRoot.getElementById(anchor)
      : null;
    if (target) {
      target.scrollIntoView({ block: 'start', inline: 'nearest' });
      if (content) {
        const contentTop = content.getBoundingClientRect().top;
        const targetTop = target.getBoundingClientRect().top;
        content.scrollTop += targetTop - contentTop - 12;
      }
      target.focus?.({ preventScroll: true });
    }
    else if (focus) button.focus({ preventScroll: true });
    if (this._activeSection === 'gameplay') this._checkStorage();
    const informational = this._activeSection === 'support';
    const saveButton = this.shadowRoot.querySelector('.actions > [data-action="save"]');
    const closeButton = this.shadowRoot.querySelector('.actions > [data-action="close"]');
    if (saveButton) saveButton.hidden = informational;
    if (closeButton) closeButton.textContent = informational ? '关闭' : '放弃';
    this._updateSaveState();
  }

  _selectTool(tool, { focus = true, resourceId = '' } = {}) {
    const button = this.shadowRoot.querySelector(`.tab-btn[data-tool="${tool}"]`)
      || this.shadowRoot.querySelector('.tab-btn[data-tool]');
    if (!button) return;
    this._activeTool = button.dataset.tool || 'pipeline';
    this._resourceId = resourceId || this._resourceId || '';
    this.shadowRoot.querySelectorAll('.tab-btn').forEach(item => item.classList.toggle('active', item === button));
    this.shadowRoot.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
    for (const id of String(button.dataset.targets || '').split(',').filter(Boolean)) {
      this.shadowRoot.getElementById(id)?.classList.add('active');
    }
    const content = this._getScrollContainer();
    if (content) content.scrollTop = 0;
    const resourceTarget = this._resourceId
      ? [...this.shadowRoot.querySelectorAll('[data-resource-id]')].find(item => item.dataset.resourceId === this._resourceId)
      : null;
    if (resourceTarget) {
      resourceTarget.scrollIntoView({ block: 'start', inline: 'nearest' });
      if (content) {
        const contentTop = content.getBoundingClientRect().top;
        const targetTop = resourceTarget.getBoundingClientRect().top;
        content.scrollTop += targetTop - contentTop - 12;
      }
      resourceTarget.focus({ preventScroll: true });
    }
    const saveButton = this.shadowRoot.querySelector('.actions > [data-action="save"]');
    if (saveButton) saveButton.hidden = this._activeTool !== 'pipeline';
    const memory = this.shadowRoot.querySelector('memory-panel');
    if (this._activeTool === 'memory') memory?.refreshStats?.();
    if (focus && !resourceTarget) button.focus({ preventScroll: true });
    this._updateSaveState();
  }

  _markDirty(section) {
    const allowed = this._mode === 'creator'
      ? section === 'pipeline'
      : PLAYER_SECTION_ORDER.includes(section);
    if (!allowed) return;
    this._dirtySections.add(section);
    this._dirtyRevisions.set(section, (this._dirtyRevisions.get(section) || 0) + 1);
    this._updateSaveState();
  }

  _updateSaveState(message = '') {
    const status = this.shadowRoot.querySelector('.save-state');
    if (!status) return;
    const activeKey = this._mode === 'creator' ? this._activeTool : this._activeSection;
    if (this._mode === 'player' && activeKey === 'support' && !message) {
      status.textContent = this._dirtySections.size
        ? `${this._dirtySections.size} 个设置页有未应用的修改`
        : '赞助完全自愿，不影响游戏功能';
      return;
    }
    status.textContent = message || (this._dirtySections.has(activeKey)
      ? '当前页面有未应用的修改'
      : '当前页面没有未应用的修改');
  }

  _showToast(message) {
    let toast = this.shadowRoot.querySelector('.settings-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'settings-toast';
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
      this.shadowRoot.querySelector('.panel')?.appendChild(toast);
    }
    toast.textContent = String(message || '');
    toast.classList.add('visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => toast?.classList.remove('visible'), 2400);
  }

  async _handle(action, event) {
    if (action === 'close') return this.close();
    if (action === 'save') return this._save();
    if (action === 'open-creator-workbench') {
      if (!await this.close()) return false;
      return eventBus.emit('app:open-creator-workbench', { tool: 'pipeline' });
    }
    if (action === 'open-player-settings') {
      if (!await this.close()) return false;
      return eventBus.emit('app:open-settings', { section: 'appearance' });
    }
    if (action === 'open-player-connection') {
      if (!await this.close()) return false;
      return eventBus.emit('app:open-settings', { section: 'connection' });
    }
    if (action === 'open-creator-image') {
      if (!await this.close()) return false;
      return eventBus.emit('app:open-creator-workbench', { tool: 'image' });
    }
    if (action === 'open-image-gallery') return openImageGallery({ imageStudio });
    if (action === 'reset') return this._reset();
    if (action === 'export') {
      const json = JSON.stringify(mergeSettings(stateManager.getSub('_ui').settings), null, 2);
      return GameModal.prompt({ title: '复制配置 JSON', message: '选中下方文本框内容，按 Ctrl+C 复制', value: json, multiline: true, rows: 10, okLabel: '关闭', cancelLabel: '取消' });
    }
    if (action === 'import') return this._import();
    if (action === 'search-music') return this._searchMusic();
    if (action === 'toggle-lyrics') return this._toggleLyrics();
    
    if (action === 'open-main-preset-editor') {
      const editor = document.createElement('main-preset-editor');
      if (this._mode === 'creator') return this._mountCreatorEditor(editor, { opener: event?.currentTarget });
      (document.getElementById('app') || document.body).appendChild(editor);
      return;
    }

    if (action === 'open-variable-updater-preset-editor') {
      const editor = document.createElement('variable-updater-preset-editor');
      editor.addEventListener('preset-saved', () => this._refreshVariablePresetSummary(), { once: true });
      if (this._mode === 'creator') return this._mountCreatorEditor(editor, { opener: event?.currentTarget });
      (document.getElementById('app') || document.body).appendChild(editor);
      return;
    }

    if (action === 'open-worldbook-editor') {
      const editor = document.createElement('worldbook-editor');
      if (this._mode === 'creator') return this._mountCreatorEditor(editor, { opener: event?.currentTarget });
      (document.getElementById('app') || document.body).appendChild(editor);
      return;
    }
    if (action === 'open-canon-plot-editor' || action === 'open-canon-techniques-editor') {
      const kind = action === 'open-canon-plot-editor' ? 'plot' : 'techniques';
      const editor = document.createElement('canon-database-editor');
      editor.databaseKind = kind;
      editor.addEventListener('database-saved', () => this._refreshCanonDatabaseSummaries());
      if (this._mode === 'creator') return this._mountCreatorEditor(editor, { opener: event?.currentTarget });
      document.body.appendChild(editor);
      return;
    }


    if (action === 'check-storage') return this._checkStorage(event?.currentTarget);
    if (action === 'manual-archive') return this._manualArchive(event?.currentTarget);
    if (action === 'export-save') return eventBus.emit('timeline:export-request', { compression: 'auto' });
    if (action === 'save-library') return eventBus.emit('app:open-saves');
    if (action === 'export-save-json') return eventBus.emit('timeline:export-request', { compression: 'json' });
    if (action === 'fetch-models') return this._fetchModelsFor(event.target);
  }

  _mountCreatorEditor(editor, { opener = null } = {}) {
    const layer = this.shadowRoot.querySelector('.workbench-editor-layer');
    if (!layer) return;
    const content = this._getScrollContainer();
    const layout = this.shadowRoot.querySelector('.layout');
    this._editorContext = {
      opener,
      scrollTop: content?.scrollTop || 0
    };
    if (content) content.scrollTop = 0;
    layout?.classList.add('editor-open');
    editor.setAttribute('embedded', '');
    layer.replaceChildren(editor);
    layer.classList.add('active');
    this.shadowRoot.querySelectorAll('.tab-btn').forEach(button => { button.disabled = true; });
    this._editorObserver?.disconnect();
    this._editorObserver = new MutationObserver(() => {
      if (!layer.children.length) {
        layer.classList.remove('active');
        layout?.classList.remove('editor-open');
        this.shadowRoot.querySelectorAll('.tab-btn').forEach(button => { button.disabled = false; });
        const context = this._editorContext;
        this._editorContext = null;
        if (content && context) content.scrollTop = context.scrollTop;
        context?.opener?.focus?.({ preventScroll: true });
        this._editorObserver?.disconnect();
        this._editorObserver = null;
      }
    });
    this._editorObserver.observe(layer, { childList: true });
    return editor;
  }

  async _checkStorage(button = null) {
    const info = this.shadowRoot.querySelector('#storage-info');
    if (info) info.textContent = '统计中...';
    if (button) button.disabled = true;
    try {
      const { timelineSystem } = await import('../systems/timeline-system.js');
      const stats = await timelineSystem.getStorageStats();
      const kb = Math.round(stats.estimatedBytes / 1024);
      const mb = (stats.estimatedBytes / 1024 / 1024).toFixed(2);
      const compressed = Number.isFinite(stats.compressedCount) ? stats.compressedCount : stats.archivedCount;
      const text = `节点 ${stats.totalNodes} (可即时点开 ${stats.activeCount} / 已压缩 ${compressed}) · ${kb >= 1024 ? mb + ' MB' : kb + ' KB'}`;
      if (info) info.textContent = text;
    } catch (e) {
      if (info) info.textContent = '查询失败: ' + e.message;
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  }

  async _manualArchive(button = null) {
    const confirmed = await customElements.get('game-modal').confirm({
      title: '立即压缩旧回合',
      message: '将把最近 20 层以外的旧回合压缩为 gzip 存入浏览器。点进这些回合时会自动解压，跳转、检查点、导出导入和 IF 线都会保留。继续?',
      okLabel: '确认压缩',
      cancelLabel: '取消'
    });
    if (!confirmed) return;
    if (button) button.disabled = true;
    try {
      const { timelineSystem } = await import('../systems/timeline-system.js');
      const result = await timelineSystem.manualArchive();
      if (result.running) {
        await this._checkStorage();
        return;
      }
      this._showToast(`已压缩 ${result.compressed || result.archived || 0} 个旧回合`);
      await this._checkStorage();
    } catch (error) {
      this._showToast(`归档失败：${error?.message || '未知错误'}`);
      await this._checkStorage();
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  }

  async _fetchModelsFor(btn) {
    const targetName = btn?.dataset?.target;
    if (!targetName) return;
    const mainConfig = stateManager.getAPIConfig() || {};
    let apiConfig = mainConfig;
    if (targetName === 'varUpdaterModel') {
      apiConfig = {
        ...mainConfig,
        ...(mainConfig.variableUpdater || {}),
        backend: this._get('varUpdaterBackend') === 'inherit' ? mainConfig.backend : this._get('varUpdaterBackend'),
        apiUrl: this._get('varUpdaterApiUrl') || mainConfig.apiUrl,
        apiKey: this._get('varUpdaterApiKey') || mainConfig.apiKey
      };
    } else if (targetName === 'narrativeReviewModel') {
      apiConfig = {
        ...mainConfig,
        ...(mainConfig.narrativeReview || {}),
        backend: this._get('narrativeReviewBackend') === 'inherit' ? mainConfig.backend : this._get('narrativeReviewBackend'),
        apiUrl: this._get('narrativeReviewApiUrl') || mainConfig.apiUrl,
        apiKey: this._get('narrativeReviewApiKey') || mainConfig.apiKey
      };
    }
    if (!apiConfig.apiUrl) {
      this._showToast('请先在契约卷轴中配置 API 地址');
      return;
    }
    btn.disabled = true;
    btn.textContent = '读取中...';
    try {
      const { default: aiClient } = await import('../core/ai-client.js');
      const models = await aiClient.listModels(apiConfig);
      if (!models.length) throw new Error('空模型列表');
      const input = this.shadowRoot.querySelector(`[name="${targetName}"]`);
      if (!input) return;
      // Find or create model list container
      let listEl = this.shadowRoot.querySelector(`#list-${targetName}`);
      if (!listEl) {
        listEl = document.createElement('div');
        listEl.id = `list-${targetName}`;
        listEl.style.cssText = 'max-height:180px;overflow-y:auto;margin-top:4px;border:1px solid rgba(198,156,109,0.2);border-radius:6px;background:rgba(7,10,14,0.95);';
        input.parentElement.appendChild(listEl);
      }
      listEl.innerHTML = models.map(id =>
        `<div style="padding:7px 10px;cursor:pointer;font-size:12px;color:#a39f98;border-bottom:1px solid rgba(255,255,255,0.04);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" data-model="${escAttr(id)}">${escHtml(id)}</div>`
      ).join('');
      listEl.querySelectorAll('div').forEach(item => {
        item.addEventListener('click', () => {
          input.value = item.dataset.model;
          this._markDirty(this._mode === 'creator' ? 'pipeline' : this._activeSection);
          listEl.querySelectorAll('div').forEach(i => i.style.cssText = i.style.cssText.replace(/border-left:.*?;/, ''));
          item.style.cssText += ';background:rgba(235,97,63,0.12);color:#ff8a65;border-left:3px solid #eb613f;';
        });
        item.addEventListener('mouseenter', () => { item.style.background = 'rgba(198,156,109,0.1)'; item.style.color = '#e8e4d9'; });
        item.addEventListener('mouseleave', () => {
          if (!item.style.cssText.includes('border-left')) { item.style.background = ''; item.style.color = ''; }
        });
      });
      if (!input.value && models[0]) {
        input.value = models[0];
        this._markDirty(this._mode === 'creator' ? 'pipeline' : this._activeSection);
        listEl.querySelector('div')?.setAttribute('style', listEl.querySelector('div')?.getAttribute('style') + ';background:rgba(235,97,63,0.12);color:#ff8a65;border-left:3px solid #eb613f;');
      }
      this._showToast(`已读取 ${models.length} 个模型`);
    } catch (e) {
      this._showToast('模型读取失败: ' + (e.message || '未知错误'));
    } finally {
      btn.disabled = false;
      btn.textContent = '读取';
    }
  }

  _collect() {
    return mergeSettings({
      themePreset: this._get('themePreset'), fontPreset: this._get('fontPreset'), fontFamily: this._resolveFontFamily(), fontSize: this._get('fontSize'), lineHeight: this._get('lineHeight'), chatMaxWidth: this._get('chatMaxWidth'),
      paragraphIndent: this._get('paragraphIndent'), aiCardStyle: this._get('aiCardStyle'), textColor: this._get('textColor'), accentColor: this._get('accentColor'), goldColor: this._get('goldColor'),
      backgroundColor: this._get('backgroundColor'), backgroundImage: this._get('backgroundImage'), backgroundOpacity: this._get('backgroundOpacity'), showVariableSummary: this._get('showVariableSummary'), reasoningOpen: this._get('reasoningOpen'), tacticalCombat: this._get('tacticalCombat'), autoArchive: this._get('autoArchive'),
      musicEnabled: this._get('musicEnabled'), musicVolume: this._get('musicVolume'), musicLoop: this._get('musicLoop'), musicShuffle: this._get('musicShuffle')
    });
  }

  async _save({ section = '', announce = true } = {}) {
    if (this._savePromise) return false;
    const saveKey = section || (this._mode === 'creator' ? this._activeTool : this._activeSection);
    const saveButton = this.shadowRoot.querySelector('.actions > [data-action="save"]');
    if (saveButton) saveButton.disabled = true;
    this._savePromise = this._saveSection(saveKey, { announce }).finally(() => {
      this._savePromise = null;
      if (saveButton?.isConnected) saveButton.disabled = false;
    });
    return this._savePromise;
  }

  async _saveSection(saveKey, { announce = true } = {}) {
    const revision = this._dirtyRevisions.get(saveKey) || 0;
    try {
      if (this._mode === 'creator') {
        if (saveKey !== 'pipeline') return false;
        this._saveAgentConfig();
        await this._saveNarrativeReviewConfig();
        await this._saveVariableUpdaterConfig();
        await this._saveAICallPolicyConfig();
        const cleared = this._clearDirtyRevision(saveKey, revision);
        if (announce) this._updateSaveState(cleared ? '生成管线已应用' : '已保存较早版本，当前页面仍有新修改');
        eventBus.emit('settings:changed', { section: 'pipeline' });
        return true;
      }

      if (saveKey === 'connection') {
        const form = this.shadowRoot.querySelector('api-config-form');
        const config = form?.getConfig();
        if (!config) {
          this._selectSection('connection');
          this._showToast('请填写完整的 API 地址和模型名称');
          return false;
        }
        const savedConfig = await settingsConfigGateway.saveMainAIConnection(config);
        aiClient.configure(savedConfig);
        const cleared = this._clearDirtyRevision(saveKey, revision);
        if (announce) this._updateSaveState(cleared ? 'AI 连接已应用' : '已保存较早版本，当前页面仍有新修改');
        eventBus.emit('settings:changed', { section: 'connection', apiConfig: savedConfig });
        return true;
      }

      const fields = PLAYER_SECTION_FIELDS[saveKey];
      if (!fields) return false;
      const allSettings = this._collect();
      const patch = {};
      for (const field of fields) patch[field] = allSettings[field];
      if (Object.hasOwn(patch, 'tacticalCombat')
        && patch.tacticalCombat !== Boolean(stateManager.getSub('_ui')?.settings?.tacticalCombat)
        && document.querySelector('.app-shell.is-processing')) {
        this._updateSaveState('请等本回合完成后再切换战斗面板');
        return false;
      }
      const imageSettings = saveKey === 'media' ? {
        enabled: this._get('imageEnabled', false),
        turnMode: this._get('imageTurnMode', 'manual')
      } : null;
      const settings = mergeSettings(await settingsConfigGateway.saveUISettings(patch));
      if (imageSettings) {
        callPolicyImageSettingsStore.update(imageSettings);
        this._draftSideEffects = {
          musicLoop: localStorage.getItem('naruto_music_loop'),
          musicShuffle: localStorage.getItem('naruto_music_shuffle')
        };
      }

      applyLocalSettings(settings);
      this._settings = settings;
      const cleared = this._clearDirtyRevision(saveKey, revision);
      if (announce) this._updateSaveState(cleared ? '当前页面已应用' : '已保存较早版本，当前页面仍有新修改');
      eventBus.emit('settings:changed', settings);
      return true;
    } catch (error) {
      if (this._mode === 'player' && PLAYER_SECTION_ORDER.includes(saveKey)) {
        this._selectSection(saveKey);
      }
      console.error('[SettingsPanel] 保存设置失败:', error);
      this._showToast(`设置保存失败：${error?.message || '未知错误'}`);
      this._updateSaveState('保存失败，修改仍保留');
      return false;
    }
  }

  _clearDirtyRevision(section, revision) {
    if ((this._dirtyRevisions.get(section) || 0) !== revision) return false;
    this._dirtySections.delete(section);
    this._dirtyRevisions.delete(section);
    return true;
  }

  async _saveAllDirtySections() {
    const order = this._mode === 'creator' ? ['pipeline'] : PLAYER_SECTION_ORDER;
    const dirtySections = order.filter(section => this._dirtySections.has(section));
    if (this._mode === 'player' && dirtySections.includes('connection')) {
      const config = this.shadowRoot.querySelector('api-config-form')?.getConfig();
      if (!config) {
        this._selectSection('connection');
        this._showToast('请填写完整的 API 地址和模型名称');
        return false;
      }
    }
    for (const section of dirtySections) {
      const saved = await this._save({ section, announce: false });
      if (!saved) {
        if (this._mode === 'creator') this._selectTool(section);
        else this._selectSection(section);
        return false;
      }
    }
    const remaining = order.find(section => this._dirtySections.has(section));
    if (remaining) {
      if (this._mode === 'creator') this._selectTool(remaining);
      else this._selectSection(remaining);
      this._showToast('保存期间检测到新的修改，请再次应用后退出');
      return false;
    }
    return true;
  }

  _saveAgentConfig() {
    const root = this.shadowRoot;
    const rawConcurrency = Number(root.querySelector('[name="agentMaxConcurrency"]')?.value);
    saveAgentConfig({
      enabled: root.querySelector('[name="agentEnabled"]')?.checked ?? false,
      mode: root.querySelector('[name="agentMode"]')?.value || 'standard',
      autoUpgrade: root.querySelector('[name="agentAutoUpgrade"]')?.checked ?? true,
      agentModel: (root.querySelector('[name="agentModel"]')?.value || '').trim(),
      criticModel: (root.querySelector('[name="criticModel"]')?.value || '').trim(),
      maxConcurrency: Number.isFinite(rawConcurrency)
        ? Math.max(1, Math.min(10, Math.trunc(rawConcurrency)))
        : 10
    });
  }

  async _saveVariableUpdaterConfig() {
    const root = this.shadowRoot;
    const enabled = root.querySelector('[name="varUpdaterEnabled"]')?.checked ?? false;
    const model = (root.querySelector('[name="varUpdaterModel"]')?.value || '').trim();
    const apiUrl = (root.querySelector('[name="varUpdaterApiUrl"]')?.value || '').trim();
    const apiKey = (root.querySelector('[name="varUpdaterApiKey"]')?.value || '').trim();
    const temperature = Number(root.querySelector('[name="varUpdaterTemperature"]')?.value);
    await settingsConfigGateway.saveAuxiliaryConfig('variableUpdater', {
      enabled,
      backend: root.querySelector('[name="varUpdaterBackend"]')?.value || 'inherit',
      apiUrl,
      apiKey,
      model,
      temperature: Number.isFinite(temperature) ? Math.max(0, Math.min(2, temperature)) : VARIABLE_UPDATER_DEFAULT_TEMPERATURE,
      maxTokens: Math.max(256, Number(root.querySelector('[name="varUpdaterMaxTokens"]')?.value) || 8192),
      streaming: root.querySelector('[name="varUpdaterStreaming"]')?.checked ?? true
    });
  }

  async _saveNarrativeReviewConfig() {
    const root = this.shadowRoot;
    const temperature = Number(root.querySelector('[name="narrativeReviewTemperature"]')?.value);
    await settingsConfigGateway.saveAuxiliaryConfig('narrativeReview', {
      enabled: root.querySelector('[name="narrativeReviewEnabled"]')?.checked ?? false,
      backend: root.querySelector('[name="narrativeReviewBackend"]')?.value || 'inherit',
      apiUrl: (root.querySelector('[name="narrativeReviewApiUrl"]')?.value || '').trim(),
      apiKey: (root.querySelector('[name="narrativeReviewApiKey"]')?.value || '').trim(),
      model: (root.querySelector('[name="narrativeReviewModel"]')?.value || '').trim(),
      temperature: Number.isFinite(temperature) ? Math.max(0, Math.min(2, temperature)) : 0.25,
      maxTokens: Math.max(1024, Number(root.querySelector('[name="narrativeReviewMaxTokens"]')?.value) || 16384),
      streaming: root.querySelector('[name="narrativeReviewStreaming"]')?.checked ?? true
    });
  }

  _resolveDisplayedAICallPolicy() {
    const root = this.shadowRoot;
    const apiConfig = stateManager.getAPIConfig() || {};
    return resolveAICallPolicy({
      apiConfig: {
        ...apiConfig,
        aiCallPolicy: {
          ...apiConfig.aiCallPolicy,
          strictSingleCall: root.querySelector('[name="strictSingleCall"]')?.checked ?? true
        },
        variableUpdater: {
          ...apiConfig.variableUpdater,
          enabled: root.querySelector('[name="varUpdaterEnabled"]')?.checked ?? false
        },
        narrativeReview: {
          ...apiConfig.narrativeReview,
          enabled: root.querySelector('[name="narrativeReviewEnabled"]')?.checked ?? false
        }
      },
      agentConfig: {
        ...getAgentConfig(),
        enabled: root.querySelector('[name="agentEnabled"]')?.checked ?? false,
        mode: root.querySelector('[name="agentMode"]')?.value || 'standard'
      },
      memoryConfig: getMemoryConfig(),
      imageSettings: callPolicyImageSettingsStore.load()
    });
  }

  _refreshAICallEstimate() {
    const policy = this._resolveDisplayedAICallPolicy();
    const estimate = this.shadowRoot.querySelector('#ai-call-estimate');
    const blocked = this.shadowRoot.querySelector('#ai-call-blocked');
    if (estimate) estimate.textContent = policy.estimateText;
    if (blocked) blocked.textContent = policy.blockedFeatures.length
      ? `当前暂停：${policy.blockedFeatures.map(item => item.label).join('、')}`
      : '';
  }

  async _saveAICallPolicyConfig() {
    await settingsConfigGateway.saveAuxiliaryConfig('aiCallPolicy', {
      strictSingleCall: this.shadowRoot.querySelector('[name="strictSingleCall"]')?.checked ?? true
    });
  }

  _refreshVariablePresetSummary() {
    const preset = getVariableUpdaterPreset();
    const name = this.shadowRoot.querySelector('#variable-preset-name');
    const count = this.shadowRoot.querySelector('#variable-preset-count');
    if (name) name.textContent = preset.name || '未命名变量更新预设';
    if (count) count.textContent = `${preset.entries?.length || 0} 个预设条目 · ${preset.entries?.filter(entry => entry.enabled !== false).length || 0} 个已启用`;
  }

  _refreshCanonDatabaseSummaries() {
    for (const kind of ['plot', 'techniques']) {
      const stats = CANON_DATABASE.getStats(kind);
      const container = this.shadowRoot.querySelector(`#canon-${kind}-summary`);
      if (!container) continue;
      container.innerHTML = [
        ['启用', stats.effective],
        ['修改', stats.modified],
        ['新增', stats.custom],
        ['停用', stats.disabled]
      ].map(([label, value]) => `<span><strong>${value}</strong>${label}</span>`).join('');
    }
  }

  async _reset() {
    const confirmed = await customElements.get('game-modal').confirm({
      title: '恢复默认设置',
      message: '确定恢复所有系统设置到默认值吗？此操作不会影响 API 配置和存档。',
      okLabel: '恢复默认',
      cancelLabel: '取消'
    });
    if (!confirmed) return;
    stateManager.update([{ key: '_ui.settings', op: '=', value: DEFAULT_SETTINGS }]);
    await stateManager.saveUIPrefs?.();
    applyLocalSettings(DEFAULT_SETTINGS);
    this._settings = mergeSettings(DEFAULT_SETTINGS);
    this._dirtySections.clear();
    this._dirtyRevisions.clear();
    await this.close({ force: true });
  }

  async _import() {
    const text = await GameModal.prompt({ title: '粘贴配置 JSON', message: '将配置 JSON 粘贴到下方文本框', placeholder: '{ ... }', multiline: true, rows: 10, okLabel: '导入', cancelLabel: '取消' });
    if (!text) return;
    try {
      const settings = mergeSettings(JSON.parse(text));
      stateManager.update([{ key: '_ui.settings', op: '=', value: settings }]);
      await stateManager.saveUIPrefs?.();
      applyLocalSettings(settings);
      this._settings = settings;
      this._dirtySections.clear();
      this._dirtyRevisions.clear();
      await this.close({ force: true });
    } catch { GameModal.alert({ title: '导入失败', message: '配置 JSON 不合法' }); }
  }

  _applyThemeToFields() {
    const preset = THEME_PRESETS[this._get('themePreset')];
    if (!preset) return;
    this._set('textColor', preset.textColor); this._set('accentColor', preset.accentColor); this._set('goldColor', preset.goldColor); this._set('backgroundColor', preset.backgroundColor);
  }

  _applyFontPreset() {
    const preset = FONT_PRESETS[this._get('fontPreset')];
    if (preset?.family) this._set('fontFamily', preset.family);
  }

  async _importBackgroundFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return GameModal.alert({ title: '文件类型错误', message: '请选择图片文件' });
    const dataUrl = await this._fileToCompressedDataUrl(file);
    this._set('backgroundImage', dataUrl);
    this._preview = dataUrl;
    document.body.style.backgroundImage = `linear-gradient(rgba(0,0,0,0.28),rgba(0,0,0,0.28)),url("${dataUrl}")`;
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundAttachment = 'fixed';
    document.body.style.backgroundRepeat = 'no-repeat';
    document.body.dataset.bgMode = 'image';
    GameModal.alert({ title: '背景图已导入', message: '已即时预览。请点击"封印保存"将其持久化。' });
  }

  async _fileToCompressedDataUrl(file) {
    const objectUrl = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = objectUrl;
      });
      const maxSide = 1920;
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const width = Math.max(1, Math.round(img.width * scale));
      const height = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      return canvas.toDataURL('image/jpeg', 0.82);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  _resolveFontFamily() {
    const preset = this._get('fontPreset', 'system');
    if (preset === 'custom') return this._get('fontFamily');
    return FONT_PRESETS[preset]?.family || FONT_PRESETS.system.family;
  }

  _inferFontPreset(fontFamily = '') {
    if (fontFamily.includes('Shippori') || fontFamily.includes('Songti') || fontFamily.includes('SimSun')) return 'serif';
    if (fontFamily.includes('Klee') || fontFamily.includes('Kaiti') || fontFamily.includes('KaiTi')) return 'kai';
    if (fontFamily.includes('JetBrains') || fontFamily.includes('monospace')) return 'mono';
    if (fontFamily.includes('FangSong') || fontFamily.includes('STFangsong')) return 'fangsong';
    if (fontFamily.includes('Ma Shan')) return 'brush';
    if (fontFamily.includes('SimSun')) return 'song';
    return 'system';
  }

  _musicTrackSummary(track = localAudio.currentTrack || this._nowPlayingSong) {
    if (!track) return null;
    return {
      id: track.mid || track.url_id || track.id || '',
      name: track.name || track.title || track.song || '未知曲目',
      artist: Array.isArray(track.artist) ? track.artist.join(' / ') : (track.artist || track.singer || '')
    };
  }

  getMusicPlayerState(status = '') {
    const audio = localAudio.bgm;
    return {
      status: status || localAudio.status || (audio ? (audio.paused ? 'paused' : 'playing') : 'idle'),
      track: this._musicTrackSummary(),
      enabled: Boolean(this._get('musicEnabled')),
      paused: audio ? Boolean(audio.paused) : true,
      volume: Number.parseInt(this._get('musicVolume'), 10) || 0
    };
  }

  async openMusic({ query = '', tracks = [], track = null, autoplay = false, reveal = true } = {}) {
    if (reveal) this.open({ section: 'media', anchor: 'music-library' });
    const input = this.shadowRoot.querySelector('[name="musicSearch"]');
    if (input && query) input.value = String(query).slice(0, 160);
    const normalizedTracks = (Array.isArray(tracks) ? tracks : []).map(item => {
      try { return musicService.rememberTrack(item); } catch { return null; }
    }).filter(Boolean);
    let selected = null;
    if (track) {
      try { selected = musicService.rememberTrack(track); } catch { selected = null; }
    }
    if (selected && !normalizedTracks.some(item => item.id === selected.id)) normalizedTracks.unshift(selected);
    if (normalizedTracks.length) this._searchCache = normalizedTracks.slice(0, 20);
    this._activeTab = 'search';
    this.shadowRoot.querySelectorAll('.music-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === 'search');
    });
    this._renderMusicList(this._searchCache || [], 'search');
    if (!selected) return this.getMusicPlayerState();
    this._preparedMusicTrack = selected;
    if (autoplay) return this._playSong(selected);
    if (!localAudio.bgm) {
      localAudio.currentTrack = selected;
      localAudio.status = 'ready';
      this._nowPlayingSong = selected;
      const nowEl = this.shadowRoot.querySelector('#music-now');
      const artistEl = this.shadowRoot.querySelector('#music-playing-artist');
      if (nowEl) nowEl.textContent = `♪ 已准备：${selected.name}`;
      if (artistEl) artistEl.textContent = selected.artist || '';
    }
    return {
      ...this.getMusicPlayerState(),
      preparedTrack: this._musicTrackSummary(selected)
    };
  }

  _getAdjacentMusicTrack(direction) {
    const favorites = this._getFavorites();
    const list = favorites.length ? favorites : (this._searchCache || []);
    if (!list.length) return null;
    const current = localAudio.currentTrack || this._nowPlayingSong;
    const currentId = current?.url_id || current?.mid || current?.id;
    const currentIndex = list.findIndex(item => (item.url_id || item.mid || item.id) === currentId);
    if (direction === 'previous') {
      return list[currentIndex > 0 ? currentIndex - 1 : list.length - 1] || null;
    }
    return list[currentIndex >= 0 && currentIndex + 1 < list.length ? currentIndex + 1 : 0] || null;
  }

  async controlMusic(action) {
    if (action === 'next' || action === 'previous') {
      const nextTrack = this._getAdjacentMusicTrack(action);
      if (!nextTrack) return this.getMusicPlayerState('empty-queue');
      return this._playSong(nextTrack);
    }
    const audio = localAudio.bgm;
    if (!audio) {
      const prepared = this._preparedMusicTrack || localAudio.currentTrack;
      if ((action === 'play' || action === 'toggle') && prepared) return this._playSong(prepared);
      return this.getMusicPlayerState('no-track');
    }
    const shouldPlay = action === 'play' || (action === 'toggle' && audio.paused);
    if (!shouldPlay) {
      audio.pause();
      localAudio.status = 'paused';
      this._syncPlayBtn();
      return this.getMusicPlayerState();
    }
    try {
      await audio.play();
      localAudio.status = 'playing';
    } catch {
      localAudio.status = 'blocked';
    }
    this._syncPlayBtn();
    return this.getMusicPlayerState();
  }

  async _searchMusic() {
    const query = this._get('musicSearch').trim();
    if (!query) return GameModal.alert({ title: '提示', message: '请输入搜索关键词' });
    this._activeTab = 'search';
    this.shadowRoot.querySelectorAll('.music-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'search'));
    const list = this.shadowRoot.querySelector('#music-result-list');
    list.innerHTML = '<div class="music-empty-hint">正在结印搜索中...</div>';
    try {
      const tracks = await musicService.search(query, { limit: 20 });
      list.innerHTML = '';
      if (!tracks.length) {
        list.innerHTML = '<div class="music-empty-hint">未找到相关音乐，换个关键词试试</div>';
        return;
      }
      this._searchCache = tracks;
      this._renderMusicList(this._searchCache, 'search');
    } catch (e) { list.innerHTML = `<div class="music-empty-hint">搜索失败: ${esc(e.message)}</div>`; }
  }

  _switchMusicTab(tab) {
    this._activeTab = tab;
    this.shadowRoot.querySelectorAll('.music-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    const list = this.shadowRoot.querySelector('#music-result-list');
    if (tab === 'search') this._renderMusicList(this._searchCache || [], 'search');
    else if (tab === 'playlist') this._renderMusicList(this._getPlaylist(), 'playlist');
    else if (tab === 'favorites') {
      this._renderMusicList(this._getFavorites(), 'favorites');
      if (usesProjectServerFeatures() && !this._favoritesTabVisited) {
        this._favoritesTabVisited = true;
        this._syncFavoritesFromServer();
      }
    }
  }

  _getPlaylist() {
    try { return JSON.parse(localStorage.getItem('naruto_music_playlist') || '[]'); } catch { return []; }
  }
  _savePlaylist(songs) { localStorage.setItem('naruto_music_playlist', JSON.stringify(songs.slice(-50))); }

  _getLoop() { return localStorage.getItem('naruto_music_loop') === 'true'; }
  _setLoop(v) { localStorage.setItem('naruto_music_loop', !!v); }
  _getShuffle() { return localStorage.getItem('naruto_music_shuffle') === 'true'; }
  _setShuffle(v) { localStorage.setItem('naruto_music_shuffle', !!v); }

  _getFavorites() {
    try { return JSON.parse(localStorage.getItem('naruto_music_favorites') || '[]'); } catch { return []; }
  }
  _saveFavorites(songs) { localStorage.setItem('naruto_music_favorites', JSON.stringify(songs.slice(-100))); }
  _isFavorited(song) { return this._getFavorites().some(f => (f.url_id || f.mid || f.id) === (song.url_id || song.mid || song.id)); }
  _toggleFavorite(song) {
    const favs = this._getFavorites();
    const sid = song.url_id || song.mid || song.id;
    const idx = favs.findIndex(f => (f.url_id || f.mid || f.id) === sid);
    const wasRemoved = idx >= 0;
    if (wasRemoved) {
      favs.splice(idx, 1);
      if (usesProjectServerFeatures()) this._removeFavoriteFromServer(sid);
    } else {
      favs.push(song);
      if (usesProjectServerFeatures()) this._pushFavoriteToServer(song);
    }
    this._saveFavorites(favs);
    if (this._activeTab === 'favorites') this._renderMusicList(favs, 'favorites');
    else this._renderMusicList(this._activeTab === 'playlist' ? this._getPlaylist() : (this._searchCache || []), this._activeTab || 'search');
  }

  _setSyncStatus(msg, isError) {
    const el = this.shadowRoot?.querySelector('#music-sync-status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? '#f87171' : '#81C784';
    if (msg) setTimeout(() => { if (el.textContent === msg) { el.textContent = ''; } }, 3000);
  }

  async _fetchWithAuth(url, options = {}) {
    if (!usesProjectServerFeatures()) return null;
    try {
      const res = await fetchProjectServer(url, { ...options, credentials: 'same-origin' });
      if (res.status === 401) return null;
      if (res.ok) return res;
      return null;
    } catch { return null; }
  }

  async _pushFavoriteToServer(song) {
    const res = await this._fetchWithAuth('/api/music/favorites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ song })
    });
    if (res) this._setSyncStatus('已同步');
  }

  async _removeFavoriteFromServer(songId) {
    const res = await this._fetchWithAuth(`/api/music/favorites/${encodeURIComponent(songId)}`, { method: 'DELETE' });
    if (res) this._setSyncStatus('已同步');
  }

  async _syncFavoritesToServer() {
    this._setSyncStatus('上传中...');
    const favs = this._getFavorites();
    if (!favs.length) { this._setSyncStatus('收藏为空', true); return; }
    const res = await this._fetchWithAuth('/api/music/favorites', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorites: favs })
    });
    if (res) {
      const data = await res.json().catch(() => ({}));
      this._setSyncStatus(`已上传 ${data.count || favs.length} 首`);
    } else {
      this._setSyncStatus('上传失败(未登录或网络错误)', true);
    }
  }

  async _syncFavoritesFromServer() {
    this._setSyncStatus('下载中...');
    const res = await this._fetchWithAuth('/api/music/favorites');
    if (!res) { this._setSyncStatus('下载失败(未登录或网络错误)', true); return; }
    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.favorites)) { this._setSyncStatus('数据格式错误', true); return; }
    const serverSongs = data.favorites;
    if (!serverSongs.length) { this._setSyncStatus('云端无收藏', true); return; }
    const local = this._getFavorites();
    const localIds = new Set(local.map(s => s.url_id || s.mid || s.id));
    const merged = [...local];
    let added = 0;
    for (const s of serverSongs) {
      const sid = s.url_id || s.mid || s.id;
      if (!localIds.has(sid)) { merged.push(s); localIds.add(sid); added++; }
    }
    this._saveFavorites(merged.slice(0, 100));
    this._setSyncStatus(`已下载 ${serverSongs.length} 首，新增 ${added} 首`);
    if (this._activeTab === 'favorites') this._renderMusicList(this._getFavorites(), 'favorites');
  }

  _renderMusicList(songs, source) {
    const list = this.shadowRoot.querySelector('#music-result-list');
    if (!songs || !songs.length) { list.innerHTML = '<div class="music-empty-hint">此处空空如也——搜索并播放后，曲目会留在此处</div>'; return; }
    const favs = this._getFavorites();
    list.innerHTML = '';
    songs.forEach(song => {
      const songId = song.url_id || song.mid || song.id || '';
      const isFav = favs.some(f => (f.url_id || f.mid || f.id) === songId);
      const name = song.name || song.title || song.song || '?';
      const artist = Array.isArray(song.artist) ? song.artist.join(' / ') : (song.artist || song.singer || '');
      const item = document.createElement('div');
      item.className = 'music-item';
      item.innerHTML = `<div class="music-item-info"><span class="music-item-name">${esc(name)}</span><span class="music-item-artist">${esc(artist)}</span></div><span class="music-item-fav${isFav?' favorited':''}" data-action="fav" style="font-size:15px;cursor:pointer;">★</span><span class="music-play-icon">▶</span>`;
      item.querySelector('.music-play-icon').addEventListener('click', e => { e.stopPropagation(); this._playSong(song); });
      item.querySelector('.music-item-fav').addEventListener('click', e => { e.stopPropagation(); this._toggleFavorite(song); });
      item.addEventListener('click', () => this._playSong(song));
      list.appendChild(item);
    });
  }

  async _playSong(song) {
    if (!this._get('musicEnabled')) return this.getMusicPlayerState('disabled');
    let track;
    try {
      track = musicService.rememberTrack(song);
    } catch {
      return this.getMusicPlayerState('invalid-track');
    }
    const loadToken = (this._musicLoadToken || 0) + 1;
    this._musicLoadToken = loadToken;
    const name = track.name;
    const artist = track.artist || '';
    this._nowPlayingSong = track;
    this._nowPlaying = name;
    localAudio.currentTrack = track;
    localAudio.status = 'resolving';
    const nowEl = this.shadowRoot.querySelector('#music-now');
    const artistEl = this.shadowRoot.querySelector('#music-playing-artist');
    if (nowEl) nowEl.textContent = '♪ 加载中...';
    if (artistEl) artistEl.textContent = '';

    let playUrl = '';
    try {
      playUrl = await musicService.resolveStreamUrl(track);
    } catch (e) {
      if (this._musicLoadToken !== loadToken) return this.getMusicPlayerState('superseded');
      localAudio.status = 'error';
      if (nowEl) nowEl.textContent = `解析失败: ${e.message || '未知错误'}`;
      if (artistEl) artistEl.textContent = '';
      return this.getMusicPlayerState();
    }
    if (this._musicLoadToken !== loadToken) return this.getMusicPlayerState('superseded');

    localAudio.bgm?.pause();
    const audio = new Audio(playUrl);
    audio.volume = (parseInt(this._get('musicVolume')) || 45) / 100;
    this._lyrics = [];
    localAudio.bgm = audio;
    localAudio.currentTrack = track;
    localAudio.status = 'loading';

    audio.addEventListener('canplay', async () => {
      if (localAudio.bgm !== audio) return;
      if (nowEl) nowEl.textContent = `♪ ${name}`;
      if (artistEl) artistEl.textContent = artist;
      try {
        await audio.play();
        localAudio.status = 'playing';
      } catch {
        localAudio.status = 'blocked';
        if (nowEl) nowEl.textContent = `♪ ${name}（点击播放）`;
      }
      this._syncPlayBtn();
      this._updateLyricsWindow(name, artist);
      await this._fetchMetingLyrics(track);
    }, { once: true });

    audio.addEventListener('timeupdate', () => {
      const idx = this._findLyricIndex(audio.currentTime);
      const active = idx >= 0 ? this._lyrics[idx].txt : '';
      this._updateLyricsWindow(active || name, artist);
    });

    audio.addEventListener('pause', () => {
      if (localAudio.bgm === audio && localAudio.status !== 'blocked') localAudio.status = 'paused';
      this._syncPlayBtn();
    });
    audio.addEventListener('play', () => {
      if (localAudio.bgm === audio) localAudio.status = 'playing';
      this._syncPlayBtn();
    });
    audio.addEventListener('ended', () => {
      localAudio.status = 'ended';
      this._syncPlaylist(track);
      this._syncPlayBtn();
      const loop = this._getLoop();
      const shuffle = this._getShuffle();
      if (loop && !shuffle) audio.play().catch(() => {});
      else { localAudio.bgm = null; this._playNextQueued(); }
    });

    audio.addEventListener('error', () => {
      const codes = { 1: '加载中止', 2: '网络错误', 3: '解码失败', 4: '格式不支持' };
      const errMsg = codes[audio.error?.code] || audio.error?.message || '未知错误';
      localAudio.status = 'error';
      if (nowEl) nowEl.textContent = `播放失败: ${errMsg}`;
      this._playNextQueued();
    });

    this._syncAudio();
    this._syncPlaylist(track);
    return this.getMusicPlayerState();
  }

  _syncPlaylist(song) {
    if (!song) return;
    const list = this._getPlaylist();
    const id = song.url_id || song.mid || song.id;
    const exists = list.findIndex(item => (item.url_id || item.mid || item.id) === id);
    if (exists >= 0) list.splice(exists, 1);
    list.unshift(song);
    this._savePlaylist(list);
  }

  _playNextQueued() {
    const favs = this._getFavorites();
    if (!favs.length) return;
    const shuffle = this._getShuffle();
    const sid = this._nowPlayingSong?.url_id || this._nowPlayingSong?.mid || this._nowPlayingSong?.id;
    const curIdx = sid ? favs.findIndex(s => (s.url_id || s.mid || s.id) === sid) : -1;
    if (shuffle) {
      let next = favs[Math.floor(Math.random() * favs.length)];
      if (favs.length > 1 && (next.url_id || next.mid || next.id) === sid) {
        const others = favs.filter(s => (s.url_id || s.mid || s.id) !== sid);
        next = others[Math.floor(Math.random() * others.length)];
      }
      if (next) this._playSong(next);
    } else {
      const nextIdx = (curIdx >= 0 && curIdx + 1 < favs.length) ? curIdx + 1 : 0;
      const next = favs[nextIdx];
      if (next && (next.url_id || next.mid || next.id) !== sid) this._playSong(next);
    }
  }

  _syncAudio() {
    const audio = localAudio.bgm;
    if (!audio) return;
    audio.volume = (parseInt(this._get('musicVolume')) || 45) / 100;
    audio.muted = !this._get('musicEnabled');
  }

  async _fetchMetingLyrics(song) {
    try {
      const rawTitle = song.name || song.title || song.song || '';
      const artist = Array.isArray(song.artist) ? song.artist[0] : (song.artist || song.singer || '');
      if (!rawTitle) { this._lyrics = []; return; }

      const cleanTitles = [rawTitle];
      const stripped = rawTitle.replace(/[（(].*?[）)]/g, '').replace(/\s*-\s*(Live|Remix|Cover|Acoustic|Instrumental).*/i, '').trim();
      if (stripped && stripped !== rawTitle) cleanTitles.push(stripped);
      const short = rawTitle.replace(/[（(].*?[）)]/g, '').trim();
      if (short && short !== rawTitle && short !== stripped) cleanTitles.push(short);

      let lrc = '';
      for (const title of cleanTitles) {
        try {
          const r = await fetch(`https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist || '')}&track_name=${encodeURIComponent(title)}`);
          if (r.ok) {
            const j = await r.json();
            if (j?.syncedLyrics) { lrc = j.syncedLyrics; break; }
            if (j?.plainLyrics) { lrc = j.plainLyrics; break; }
          }
        } catch { /* next */ }
      }

      if (!lrc) { this._lyrics = []; return; }
      this._lyrics = [];
      for (const line of lrc.split('\n')) {
        const m = line.match(/\[(\d{2,}):(\d{2})(?:\.(\d{2,3}))?\](.*)/);
        if (m) { const t = parseInt(m[1])*60 + parseInt(m[2]) + (parseInt(m[3]||'0')/(m[3]?.length===3?1000:100)); const txt = m[4].trim(); if (txt) this._lyrics.push({ time: t, txt }); }
      }
      this._lyrics.sort((a, b) => a.time - b.time);
    } catch { this._lyrics = []; console.warn('[Settings] Lyrics parse failed for:', song?.name); }
  }

  _fmtTime(s) { const m = Math.floor(s / 60); const sec = Math.floor(s % 60); return `${m}:${String(sec).padStart(2, '0')}`; }

  _findLyricIndex(time) {
    const lyrics = this._lyrics;
    if (!lyrics?.length) return -1;
    let lo = 0, hi = lyrics.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (lyrics[mid].time <= time) { idx = mid; lo = mid + 1; }
      else { hi = mid - 1; }
    }
    return idx;
  }

  _updateLyricsWindow(text, sub) {
    let el = this._lyricEl;
    if (this._lyricsHidden) { if (el) el.style.display = 'none'; return; }
    if (!el) {
      el = document.getElementById('naruto-desktop-lyrics');
      if (!el) {
        el = document.createElement('div');
        el.id = 'naruto-desktop-lyrics'; el.className = 'desktop-lyrics';
        (document.getElementById('app') || document.body).appendChild(el);
        this._buildLyricControls(el); this._makeDraggable(el);
      }
      this._lyricEl = el;
      this._lyricTextEl = el.querySelector('.lyric-text');
      this._lyricSliderEl = el.querySelector('.lyric-slider');
      this._lyricTimeEl = el.querySelector('.lyric-time');
    } else if (el.style.display !== 'block') {
      el.style.display = 'block';
    }

    const textChanged = this._lastLyricLine !== text;
    if (textChanged) {
      this._lastLyricLine = text;
      if (this._lyricTextEl) this._lyricTextEl.textContent = text || '🎵 忍者手记';
      const artistElement = el.querySelector('.music-floating-artist');
      if (artistElement) artistElement.textContent = sub || '';
    }

    const audio = localAudio.bgm;
    if (audio && isFinite(audio.duration) && !this._lyricSeeking) {
      const dur = audio.duration;
      const cur = audio.currentTime;
      const durFloor = Math.floor(dur);
      if (this._lastDuration !== durFloor && this._lyricSliderEl) {
        this._lastDuration = durFloor;
        this._lyricSliderEl.max = durFloor;
      }
      const now = performance.now();
      if (textChanged || now - this._lastSliderUpdate > 450) {
        this._lastSliderUpdate = now;
        if (this._lyricSliderEl) this._lyricSliderEl.value = Math.floor(cur);
        if (this._lyricTimeEl) this._lyricTimeEl.textContent = `${this._fmtTime(cur)} / ${this._fmtTime(dur)}`;
      }
    }
  }

  _getSvgIcon(name) {
    const icons = {
      shuffle: `<svg viewBox="0 0 24 24"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>`,
      prev: `<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>`,
      play: `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`,
      pause: `<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`,
      next: `<svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>`,
      loop: `<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>`,
      minimize: `<svg viewBox="0 0 24 24"><path d="M19 13H5v-2h14v2z"/></svg>`,
      close: `<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`
    };
    return icons[name] || '';
  }

  _buildLyricControls(el) {
    el.innerHTML = `
    <div class="lyric-header">
      <div class="lyric-drag-handle"></div>
      <div class="lyric-window-controls">
        <button class="lyric-win-btn" data-lyric="minimize" title="最小化/恢复">${this._getSvgIcon('minimize')}</button>
        <button class="lyric-win-btn" data-lyric="close" title="关闭">${this._getSvgIcon('close')}</button>
      </div>
    </div>
    <div class="lyric-body">
      <div class="lyric-text">🎵</div><div class="lyric-slider-wrap"><input type="range" class="lyric-slider" min="0" max="100" value="0" step="1"></div><div class="lyric-time">0:00 / 0:00</div><div class="lyric-controls">
        <button class="lyric-btn" data-lyric="shuffle" title="随机播放">${this._getSvgIcon('shuffle')}</button>
        <button class="lyric-btn" data-lyric="prev" title="上一首">${this._getSvgIcon('prev')}</button>
        <button class="lyric-btn lyric-play-btn" data-lyric="play" title="播放/暂停">${this._getSvgIcon('pause')}</button>
        <button class="lyric-btn" data-lyric="next" title="下一首">${this._getSvgIcon('next')}</button>
        <button class="lyric-btn" data-lyric="loop" title="列表循环">${this._getSvgIcon('loop')}</button>
      </div>
    </div>`;

    el.querySelector('[data-lyric="minimize"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      el.classList.toggle('minimized');
    });
    el.querySelector('[data-lyric="close"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleLyrics();
    });

    if (this._getShuffle()) el.querySelector('[data-lyric="shuffle"]').classList.add('active');
    if (this._getLoop()) el.querySelector('[data-lyric="loop"]').classList.add('active');

    const slider = el.querySelector('.lyric-slider');
    slider.addEventListener('mousedown', e => { e.stopPropagation(); this._lyricSeeking = true; });
    slider.addEventListener('touchstart', e => { e.stopPropagation(); this._lyricSeeking = true; }, { passive: true });

    slider.addEventListener('input', () => {
      const t = Number(slider.value);
      const idx = this._findLyricIndex(t);
      const active = idx >= 0 ? this._lyrics[idx].txt : '';
      const textEl = this._lyricTextEl || el.querySelector('.lyric-text');
      if (textEl) textEl.textContent = active || '🎵';
      if (this._lyricTimeEl) this._lyricTimeEl.textContent = `${this._fmtTime(t)} / ${this._fmtTime(localAudio.bgm?.duration || 0)}`;
    });

    slider.addEventListener('change', () => {
      if (localAudio.bgm) localAudio.bgm.currentTime = Number(slider.value);
      this._lyricSeeking = false;
    });

    slider.addEventListener('pointerup', () => {
      if (localAudio.bgm) localAudio.bgm.currentTime = Number(slider.value);
      this._lyricSeeking = false;
    });
    slider.addEventListener('touchend', () => {
      if (localAudio.bgm) localAudio.bgm.currentTime = Number(slider.value);
      this._lyricSeeking = false;
    });

    el.querySelectorAll('.lyric-btn').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const cmd = b.dataset.lyric;
      if (cmd === 'play') { this._togglePlay(b); }
      if (cmd === 'prev' || cmd === 'next') { const list = this._getFavorites(); const sid = this._nowPlayingSong?.url_id||this._nowPlayingSong?.mid||this._nowPlayingSong?.id; const cur = list.findIndex(s => (s.url_id||s.mid||s.id) === sid); const next = cmd === 'next' ? (cur+1 < list.length ? list[cur+1] : list[0]) : (cur>0 ? list[cur-1] : list[list.length-1]); if (next && (next.url_id||next.mid||next.id) !== sid) this._playSong(next); }
      if (cmd === 'loop') { this._setLoop(!this._getLoop()); this._set('musicLoop', this._getLoop()); this._syncAudio(); b.classList.toggle('active', this._getLoop()); }
      if (cmd === 'shuffle') { this._setShuffle(!this._getShuffle()); this._set('musicShuffle', this._getShuffle()); b.classList.toggle('active', this._getShuffle()); }
    }));

  }

  _togglePlay(btn) {
    this.controlMusic('toggle').then(() => {
      if (btn) btn.innerHTML = localAudio.bgm && !localAudio.bgm.paused
        ? this._getSvgIcon('pause')
        : this._getSvgIcon('play');
    });
  }

  _syncPlayBtn() {
    const el = this._lyricEl || document.getElementById('naruto-desktop-lyrics');
    if (!el) return;
    const btn = el.querySelector('[data-lyric="play"]');
    if (btn) btn.innerHTML = localAudio.bgm && !localAudio.bgm.paused ? this._getSvgIcon('pause') : this._getSvgIcon('play');
  }

  _toggleLyrics() {
    this._lyricsHidden = !this._lyricsHidden;
    const el = this._lyricEl || document.getElementById('naruto-desktop-lyrics');
    if (el) { el.style.display = this._lyricsHidden ? 'none' : 'block'; this._syncPlayBtn(); }
    if (this._lyricsHidden && localAudio.bgm) {
      localAudio.bgm.pause();
    }
  }

  _play(type) { /* empty: old API */ }
  _pause(type) { /* empty: old API */ }

  _restoreDraftSideEffects() {
    const settings = mergeSettings(stateManager.getSub('_ui').settings);
    applyLocalSettings(settings);
    this._settings = settings;
    const restoreStorage = (key, value) => {
      if (value === null || value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    };
    restoreStorage('naruto_music_loop', this._draftSideEffects?.musicLoop);
    restoreStorage('naruto_music_shuffle', this._draftSideEffects?.musicShuffle);
    this._set('musicEnabled', settings.musicEnabled);
    this._set('musicVolume', settings.musicVolume);
    this._set('musicLoop', this._draftSideEffects?.musicLoop === null
      ? settings.musicLoop
      : this._draftSideEffects?.musicLoop === 'true');
    this._set('musicShuffle', this._draftSideEffects?.musicShuffle === null
      ? settings.musicShuffle
      : this._draftSideEffects?.musicShuffle === 'true');
    this._syncAudio();
  }

  async close(options = {}) {
    if (this._closePromise) return this._closePromise;
    this._closePromise = this._performClose(options).finally(() => {
      this._closePromise = null;
    });
    return this._closePromise;
  }

  async _performClose({ force = false } = {}) {
    if (!this.isConnected) return true;
    if (this._savePromise) await this._savePromise;
    if (!this.isConnected) return true;
    if (!force) {
      const embeddedEditor = this.shadowRoot.querySelector('.workbench-editor-layer.active > *');
      if (embeddedEditor) {
        const closeSelector = {
          'WORLDBOOK-EDITOR': '#btn-close',
          'MAIN-PRESET-EDITOR': '#mpe-close',
          'VARIABLE-UPDATER-PRESET-EDITOR': '[data-action="close"]',
          'CANON-DATABASE-EDITOR': '[data-action="close"]'
        }[embeddedEditor.tagName];
        embeddedEditor.shadowRoot?.querySelector(closeSelector)?.click();
        return false;
      }
    }
    if (!force && this._dirtySections?.size) {
      const action = await GameModal.choice({
        title: '保存修改后退出？',
        message: '当前设置中仍有未应用的修改。你可以先应用全部修改，也可以放弃后退出。',
        dismissValue: 'continue',
        choices: [
          { label: '放弃并退出', value: 'discard' },
          { label: '继续编辑', value: 'continue', autofocus: true },
          { label: '应用并退出', value: 'apply', primary: true }
        ]
      });
      if (action === 'continue') return false;
      if (action === 'discard') {
        this._restoreDraftSideEffects();
        this._dirtySections.clear();
        this._dirtyRevisions.clear();
        this.remove();
        return true;
      }
      if (action === 'apply') {
        const saved = await this._saveAllDirtySections();
        if (!saved) return false;
        this.remove();
        return true;
      }
      return false;
    }
    this.remove();
    return true;
  }

  _stopAllAudio() {
    if (localAudio.bgm) {
      localAudio.bgm.pause();
      localAudio.bgm.src = '';
      localAudio.bgm.load();
      localAudio.bgm = null;
    }
    localAudio.currentTrack = null;
    localAudio.status = 'idle';
    if (localAudio.ambient) {
      localAudio.ambient.pause();
      localAudio.ambient.src = '';
      localAudio.ambient.load();
      localAudio.ambient = null;
    }
    const el = this._lyricEl || document.getElementById('naruto-desktop-lyrics');
    if (el && el.parentNode) el.parentNode.removeChild(el);
    this._lyricEl = null;
    this._lyricTextEl = null;
    this._lyricSliderEl = null;
    this._lyricTimeEl = null;
  }

  _cleanupDragHandlers() {
    if (this._dragCleanup) {
      this._dragCleanup.forEach(fn => fn?.());
      this._dragCleanup = null;
    }
  }

  _makeDraggable(el) {
    let dragging = false, sx, sy, dx, dy, raf;
    const onDown = e => {
      if (e.target.closest('button') || e.target.tagName === 'INPUT') return;
      dragging = true;
      const r = el.getBoundingClientRect();
      if (!el.classList.contains('dragging')) {
        el.style.left = r.left + 'px';
        el.style.top = r.top + 'px';
        el.style.transform = 'none';
        el.style.bottom = 'auto';
        el.style.right = 'auto';
        el.classList.add('dragging');
      }
      const evt = e.touches ? e.touches[0] : e;
      sx = evt.clientX;
      sy = evt.clientY;
      dx = parseFloat(el.style.left) || r.left;
      dy = parseFloat(el.style.top) || r.top;
    };
    const onMove = e => {
      if (!dragging) return;
      e.preventDefault();
      const evt = e.touches ? e.touches[0] : e;
      const nx = dx + evt.clientX - sx;
      const ny = dy + evt.clientY - sy;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        el.style.left = `${nx}px`;
        el.style.top = `${ny}px`;
        raf = null;
      });
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
    };

    el.addEventListener('mousedown', onDown);
    el.addEventListener('touchstart', onDown, { passive: false });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchend', onUp);

    this._dragCleanup = this._dragCleanup || [];
    this._dragCleanup.push(
      () => el.removeEventListener('mousedown', onDown),
      () => el.removeEventListener('touchstart', onDown),
      () => document.removeEventListener('mousemove', onMove),
      () => document.removeEventListener('touchmove', onMove),
      () => document.removeEventListener('mouseup', onUp),
      () => document.removeEventListener('touchend', onUp)
    );
  }
}

export function applyLocalSettings(settings = stateManager.getSub('_ui').settings) {
  const s = mergeSettings(settings);
  const root = document.documentElement;
  root.style.setProperty('--font-body', s.fontFamily);
  root.style.setProperty('--text-base', `${s.fontSize}px`);
  root.style.setProperty('--chat-font-size', `${s.fontSize}px`);
  root.style.setProperty('--chat-line-height', String(s.lineHeight));
  root.style.setProperty('--leading-relaxed', String(s.lineHeight));
  root.style.setProperty('--chat-max-w', `${s.chatMaxWidth}px`);
  root.style.setProperty('--text-primary', s.textColor);
  root.style.setProperty('--c-shuiro', s.accentColor);
  root.style.setProperty('--c-kin', s.goldColor);
  // 主题基调通道 + 文本美化色：取自当前主题预设，让玻璃质感/描边/对话色随主题整体切换
  const preset = THEME_PRESETS[s.themePreset] || THEME_PRESETS.konoha;
  root.style.setProperty('--ink-deep-rgb', preset.inkDeep);
  root.style.setProperty('--ink-rgb', preset.ink);
  root.style.setProperty('--paper-rgb', preset.paper);
  root.style.setProperty('--washi-rgb', preset.washi);
  root.style.setProperty('--chat-dialogue-color', preset.dialogueColor);
  root.style.setProperty('--chat-thought-color', preset.thoughtColor);
  root.style.setProperty('--chat-mark-color', preset.markColor);
  document.body.style.backgroundColor = s.backgroundColor;
  document.body.dataset.bgMode = 'image';
  if (s.backgroundImage && s.backgroundImage !== 'img/bg-home.png') {
    document.body.style.setProperty('--custom-bg-image', `url("${s.backgroundImage}")`);
  } else {
    document.body.style.removeProperty('--custom-bg-image');
  }
  document.body.style.setProperty('--custom-bg-opacity', String(s.backgroundOpacity));
  document.body.dataset.aiCardStyle = s.aiCardStyle;
  document.body.dataset.paragraphIndent = String(s.paragraphIndent);
}

customElements.define('settings-panel', SettingsPanel);
export default SettingsPanel;
