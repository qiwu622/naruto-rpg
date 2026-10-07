import { aiClient, isTavernEnv, normalizeApiBaseUrl } from '../core/ai-client.js';
import { eventBus } from '../core/event-bus.js';
import { stateManager } from '../core/state-manager.js';
import { escAttr } from '../utils/format.js';
import { bindCustomSelects, refreshCustomSelect } from './custom-select.js';
import { DEEPSEEK_MODEL, DEEPSEEK_URL } from '../core/deepseek-mode.js';
import { getLastAIUsageReport } from '../core/ai-usage-meter.js';
import {
  listApiSchemes,
  getApiScheme,
  saveApiScheme,
  deleteApiScheme,
  setActiveApiScheme,
  getActiveApiSchemeId
} from '../core/api-schemes.js';

export class ApiConfigForm extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._schemeRequestVersion = 0;
  }

  connectedCallback() {
    try {
      this._config = JSON.parse(this.getAttribute('config') || '{}');
    } catch {
      this._config = {};
    }
    this._showAdvanced = this.hasAttribute('show-advanced');
    this._showSchemes = this.hasAttribute('show-schemes');
    this._render();
    this._bindEvents();
    bindCustomSelects(this.shadowRoot);
    if (this._showSchemes) this._loadSchemes();
    this._syncAdaptationControls();
    this._updateUsage();
    this._offUsage?.();
    this._offUsage = eventBus.on('ai:usage', () => this._updateUsage());
  }

  disconnectedCallback() { this._offUsage?.(); this._offUsage = null; }

  _updateUsage() {
    const node = this.shadowRoot.querySelector('#settings-api-usage');
    if (node) node.textContent = getLastAIUsageReport() || '尚无用量报告。生成后显示 API 返回的输入、输出、思考和缓存用量。';
  }

  _syncAdaptationControls() {
    const root = this.shadowRoot;
    const backend = root.querySelector('#settings-api-backend')?.value;
    const select = root.querySelector('#settings-api-adaptation');
    const unsupported = ['tavern', 'claude'].includes(backend);
    if (select) {
      select.disabled = unsupported;
      refreshCustomSelect(select);
    }
    const panel = root.querySelector('#settings-deepseek-options');
    if (panel) panel.hidden = unsupported || select?.value !== 'deepseek';
  }

  _render() {
    const config = this._config;
    const backend = config.backend || 'openai';
    
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; width: 100%; }
        .settings-form { display: grid; gap: 20px; text-align: left; }
        [hidden] { display: none !important; }
        .ns-select-wrapper:has(select:disabled) { opacity: .45; pointer-events: none; }
        .usage-report { overflow-wrap: anywhere; }
        .settings-row { display: grid; gap: 8px; }
        .settings-row label { color: #c69c6d; font-size: 12px; letter-spacing: .08em; font-weight: 500; text-transform: uppercase; }
        .settings-input, .settings-select {
          width: 100%; box-sizing: border-box; padding: 8px 4px;
          border: none; border-bottom: 1px solid rgba(255,255,255,0.1); border-radius: 0; background: transparent;
          color: #e8e4d9; font: 14px/1.4 'Noto Sans SC','Microsoft YaHei UI','PingFang SC', system-ui, sans-serif;
          outline: none; transition: all .3s ease;
        }
        .settings-input:focus, .settings-select:focus { 
          border-bottom-color: rgba(198,156,109,0.8); 
          box-shadow: 0 1px 0 0 rgba(198,156,109,0.3);
          background: rgba(255,255,255,0.02);
        }
        .settings-input::placeholder { color: rgba(232,228,217,0.2); }
        .settings-hint { color: rgba(232,228,217,0.4); font-size: 12px; line-height: 1.6; }
        .settings-model-row { display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: end; }
        .settings-check { display: flex; gap: 8px; align-items: center; color: #e8e4d9; font-size: 13px; }
        .settings-check input { accent-color: #c69c6d; cursor: pointer; }
        .settings-subcard { border: 1px solid rgba(255,255,255,0.05); background: rgba(0,0,0,0.15); padding: 18px; display: grid; gap: 16px; border-radius: 8px; }
        .scheme-row { display: grid; grid-template-columns: auto minmax(0,1fr) auto; gap: 10px; align-items: end; }
        .scheme-row label { margin-bottom: 0; align-self: center; }
        .scheme-save-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 10px; align-items: end; }
        .scheme-panel .settings-hint { margin-top: -6px; }
        .settings-fetch {
          padding: 8px 16px; border: 1px solid rgba(198,156,109,0.3); border-radius: 4px;
          background: rgba(198,156,109,0.05); color: #c69c6d; font: 13px/1.4 'Noto Sans SC', system-ui, sans-serif;
          cursor: pointer; white-space: nowrap; transition: all 0.2s ease;
        }
        .settings-fetch:hover { border-color: rgba(198,156,109,0.8); background: rgba(198,156,109,0.15); box-shadow: 0 0 10px rgba(198,156,109,0.1); }
        .settings-fetch:disabled { opacity: .45; cursor: wait; }

        .model-list-wrap {
          display: none; max-height: 200px; overflow-y: auto; overflow-x: hidden;
          margin-top: 4px; border: 1px solid rgba(198,156,109,0.2); border-radius: 6px;
          background: rgba(7,10,14,0.95); backdrop-filter: blur(12px);
        }
        .model-list-wrap.open { display: block; }
        .model-item {
          padding: 8px 12px; cursor: pointer; font-size: 13px; color: #a39f98;
          border-bottom: 1px solid rgba(255,255,255,0.04); transition: all 0.15s;
          font-family: 'Noto Sans SC', system-ui, sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .model-item:hover { background: rgba(198,156,109,0.1); color: #e8e4d9; }
        .model-item.selected { background: rgba(235,97,63,0.12); color: #ff8a65; border-left: 3px solid #eb613f; }
        .model-count { font-size: 11px; color: rgba(198,156,109,0.6); margin-top: 4px; }
        
        /* 简易模式下的额外样式 */
        .simple-mode .settings-input, .simple-mode .settings-select { font-size: 15px; }
        .simple-mode .settings-row label { font-size: 13px; }
      </style>
      <div class="settings-form ${this._showAdvanced ? '' : 'simple-mode'}" id="settings-form">
        ${this._showSchemes ? `
        <div class="settings-subcard scheme-panel">
          <div class="scheme-row">
            <label for="scheme-select">API 方案</label>
            <select class="settings-select" id="scheme-select">
              <option value="">— 选择已保存方案 —</option>
            </select>
            <button class="settings-fetch" type="button" id="scheme-delete">删除</button>
          </div>
          <div class="scheme-save-row">
            <input class="settings-input" id="scheme-name" placeholder="方案名称，如「DeepSeek 主号」" autocomplete="off" />
            <button class="settings-fetch" type="button" id="scheme-save">保存当前为方案</button>
          </div>
          <div class="settings-hint">选择方案立即切换为当前 AI 连接；辅助模型（二次变量/复检）保留不变。</div>
        </div>` : ''}
        <div class="settings-row">
          <label for="settings-api-url">API 地址</label>
          <input class="settings-input" id="settings-api-url" value="${this._escAttr(config.apiUrl || 'https://api.openai.com/v1')}" placeholder="https://api.openai.com/v1" autocomplete="off" autocapitalize="off" spellcheck="false" />
          ${!this._showAdvanced ? '<div class="settings-hint">支持 OpenAI / Anthropic / DeepSeek / 自定义兼容 API</div>' : ''}
        </div>
        <div class="settings-row">
          <label for="settings-api-key">API Key (免密模型可留空)</label>
          <input class="settings-input" id="settings-api-key" type="password" value="${this._escAttr(config.apiKey || '')}" placeholder="输入密钥 (免密模型可留空)" autocomplete="new-password" autocapitalize="off" spellcheck="false" />
        </div>
        <div class="settings-row">
          <label for="settings-api-model">模型名称</label>
          <div class="settings-model-row">
            <input class="settings-input" id="settings-api-model" value="${this._escAttr(config.model || '')}" placeholder="点击读取模型，或手动输入" autocomplete="off" autocapitalize="off" spellcheck="false" />
            <button class="settings-fetch" type="button" id="settings-fetch-models">读取模型</button>
          </div>
          <div class="model-list-wrap" id="settings-model-list"></div>
          <div class="settings-hint" id="settings-model-status">从当前 API 地址读取 /models 列表。</div>
        </div>
        <div class="settings-row">
          <label for="settings-api-backend">术式类型</label>
          <select class="settings-select" id="settings-api-backend">
            ${isTavernEnv ? this._option('tavern', '🍺 酒馆模型 (推荐)', backend) : ''}
            ${this._option('openai', 'OpenAI 兼容', backend)}
            ${this._option('claude', 'Claude / Anthropic', backend)}
            ${this._option('deepseek', 'DeepSeek', backend)}
            ${this._option('custom', '自定义兼容', backend)}
          </select>
        </div>
        <div class="settings-row">
          <label for="settings-api-adaptation">适配模式</label>
          <select class="settings-select" id="settings-api-adaptation">
            ${this._option('standard', '通用兼容', config.adaptationMode || 'standard')}
            ${this._option('deepseek', 'DeepSeek 专用 · 缓存优化', config.adaptationMode)}
          </select>
          <div class="settings-hint">DeepSeek 官方或兼容中转可选择专用模式；Claude 与酒馆沿用各自协议。</div>
        </div>
        <div class="settings-subcard" id="settings-deepseek-options" hidden>
          <div class="settings-row">
            <label for="settings-deepseek-thinking">思考档位</label>
            <select class="settings-select" id="settings-deepseek-thinking">
              ${this._option('disabled', '关闭思考 · 日常叙事省费', config.deepseekThinking || 'disabled')}
              ${this._option('low', '低 · 轻量推理', config.deepseekThinking)}
              ${this._option('high', '高 · 复杂剧情', config.deepseekThinking)}
              ${this._option('max', '最高 · 更多思考开销', config.deepseekThinking)}
            </select>
          </div>
          <div class="settings-hint">固定规则置前，当前事实与记忆置后；保留预设和正文篇幅。思考越多，输出开销通常越高。缓存由服务端自动命中，不保证每次命中。普通正文请求若无有效回复，不自动重发；Agent 修复流程保持原设置。</div>
          <button class="settings-fetch" type="button" id="settings-deepseek-official">填入官方地址与 Flash 模型</button>
        </div>
        <div class="settings-row">
          <label>最近用量报告</label>
          <div class="settings-hint usage-report" id="settings-api-usage" role="status"></div>
        </div>
        <div class="settings-row">
          <label class="settings-check" style="margin-top: 8px;">
            <input type="checkbox" id="settings-disable-streaming" ${config.disableStreaming ? 'checked' : ''} /> 
            关闭流式输出 (等待生成完毕后一次性显示)
          </label>
          <div class="settings-hint" style="margin-top: -4px;">对于某些不支持流式传输的中转代理 API，开启此项可避免报错。</div>
        </div>
        
      </div>
    `;
  }

  _option(value, label, selected) {
    return `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`;
  }

  _escAttr(value) {
    return escAttr(value);
  }

  _bindEvents() {
    this.shadowRoot.querySelector('#settings-api-backend')?.addEventListener('change', () => this._syncAdaptationControls());
    this.shadowRoot.querySelector('#settings-api-adaptation')?.addEventListener('change', () => this._syncAdaptationControls());
    this.shadowRoot.querySelector('#settings-deepseek-official')?.addEventListener('click', () => {
      this.shadowRoot.querySelector('#settings-api-url').value = DEEPSEEK_URL;
      this.shadowRoot.querySelector('#settings-api-model').value = DEEPSEEK_MODEL;
      const backend = this.shadowRoot.querySelector('#settings-api-backend');
      backend.value = 'deepseek';
      refreshCustomSelect(backend);
      this._syncAdaptationControls();
      this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    });
    // ── Helper: populate a model-list div with fetched models ──
    const populateList = (listEl, models, inputEl, statusEl) => {
      if (!listEl) return;
      listEl.innerHTML = models.map(id =>
        `<div class="model-item" data-model="${this._escAttr(id)}">${this._escAttr(id)}</div>`
      ).join('');
      listEl.classList.add('open');
      // Click handler on list
      listEl.querySelectorAll('.model-item').forEach(item => {
        item.addEventListener('click', () => {
          if (inputEl) {
            inputEl.value = item.dataset.model;
            inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          }
          // Highlight selected
          listEl.querySelectorAll('.model-item').forEach(i => i.classList.remove('selected'));
          item.classList.add('selected');
        });
      });
      if (statusEl) statusEl.textContent = `已读取 ${models.length} 个模型，点击下方列表选择`;
      if (models.length > 0 && inputEl && !inputEl.value) {
        inputEl.value = models[0];
        inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        const firstItem = listEl.querySelector('.model-item');
        if (firstItem) firstItem.classList.add('selected');
      }
    };

    // ── Generic fetcher ──
    const doFetch = async (fetchBtn, listEl, inputEl, statusEl, apiUrlOverride, apiKeyOverride) => {
      const config = this.getConfig(true);
      if (!config) return;
      if (!config?.apiUrl && !apiUrlOverride) {
        eventBus.emit('app:toast', '请先填写 API 地址。');
        return;
      }
      fetchBtn.disabled = true;
      fetchBtn.textContent = '读取中';
      if (statusEl) statusEl.textContent = '正在连接模型端点...';
      try {
        const fetchConfig = {
          ...config,
          apiUrl: apiUrlOverride || config.apiUrl,
          apiKey: apiKeyOverride || config.apiKey
        };
        const models = await aiClient.listModels(fetchConfig);
        if (!models.length) throw new Error('服务返回为空模型列表');
        populateList(listEl, models, inputEl, statusEl);
        eventBus.emit('app:toast', `已读取 ${models.length} 个模型`);
      } catch (error) {
        if (statusEl) statusEl.textContent = '读取失败: ' + (error.message || '未知错误');
        eventBus.emit('app:toast', error.message || '模型列表读取失败');
      } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = '读取模型';
      }
    };

    // ── Main model ──
    const mainFetch = this.shadowRoot.querySelector('#settings-fetch-models');
    const mainInput = this.shadowRoot.querySelector('#settings-api-model');
    const mainList = this.shadowRoot.querySelector('#settings-model-list');
    const mainStatus = this.shadowRoot.querySelector('#settings-model-status');
    mainFetch?.addEventListener('click', () => doFetch(mainFetch, mainList, mainInput, mainStatus));
    // Toggle list on input focus
    mainInput?.addEventListener('focus', () => { if (mainList?.children.length) mainList.classList.add('open'); });
    mainInput?.addEventListener('blur', () => setTimeout(() => mainList?.classList.remove('open'), 200));

    // ── API 方案管理 ──
    if (this._showSchemes) {
      const schemeSelect = this.shadowRoot.querySelector('#scheme-select');
      const schemeSave = this.shadowRoot.querySelector('#scheme-save');
      const schemeDelete = this.shadowRoot.querySelector('#scheme-delete');
      schemeSelect?.addEventListener('change', () => this._applyScheme(schemeSelect.value));
      schemeSave?.addEventListener('click', () => this._saveScheme());
      schemeDelete?.addEventListener('click', () => this._deleteScheme());
      schemeSelect?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') this._applyScheme(schemeSelect.value);
      });
    }
  }

  async _loadSchemes() {
    const requestVersion = this._schemeRequestVersion;
    const select = this.shadowRoot.querySelector('#scheme-select');
    if (!select) return;
    const schemes = await listApiSchemes();
    if (requestVersion !== this._schemeRequestVersion) return;
    const active = getActiveApiSchemeId();
    const current = select.value;
    const currentStillExists = schemes.some(scheme => scheme.id === current);
    const selectedId = currentStillExists
      ? current
      : (schemes.some(scheme => scheme.id === active) ? active : '');
    select.innerHTML = [
      '<option value="">— 选择已保存方案 —</option>',
      ...schemes.map(scheme => {
        const label = `${scheme.name} · ${scheme.backend}${scheme.model ? ' / ' + scheme.model : ''}`;
        return `<option value="${this._escAttr(scheme.id)}" ${scheme.id === selectedId ? 'selected' : ''}>${this._escAttr(label)}</option>`;
      })
    ].join('');
    select.value = selectedId;
    refreshCustomSelect(select);
    const selectedSummary = schemes.find(scheme => scheme.id === selectedId) || null;
    this._syncSchemeControls(selectedSummary);
    if (!selectedSummary) return;

    const selectedScheme = await getApiScheme(selectedId);
    if (requestVersion !== this._schemeRequestVersion || select.value !== selectedId) return;
    if (!selectedScheme) {
      this._loadSchemes();
      return;
    }
    this.setValues(selectedScheme);
    this._syncSchemeControls(selectedScheme);
  }

  async _applyScheme(id) {
    const requestVersion = ++this._schemeRequestVersion;
    if (!id) {
      this._syncSchemeControls(null);
      return;
    }
    const scheme = await getApiScheme(id);
    if (requestVersion !== this._schemeRequestVersion) return;
    if (!scheme) {
      this._loadSchemes();
      return;
    }
    this.setValues(scheme);
    this._syncSchemeControls(scheme);
    const current = stateManager.getAPIConfig?.() || {};
    const config = {
      backend: scheme.backend,
      apiUrl: scheme.apiUrl,
      apiKey: scheme.apiKey || '',
      model: scheme.model,
      disableStreaming: Boolean(scheme.disableStreaming),
      adaptationMode: scheme.adaptationMode || 'standard',
      deepseekThinking: scheme.deepseekThinking || 'disabled',
      variableUpdater: current.variableUpdater,
      narrativeReview: current.narrativeReview,
      aiCallPolicy: current.aiCallPolicy
    };
    try {
      if (typeof stateManager.saveAPIConfig === 'function') {
        await stateManager.saveAPIConfig(config);
      }
      if (requestVersion !== this._schemeRequestVersion) return;
      aiClient.configure(config);
      setActiveApiScheme(id);
      eventBus.emit('settings:changed', { section: 'connection', apiConfig: config });
      eventBus.emit('app:toast', `已切换到方案「${scheme.name}」`);
    } catch (error) {
      if (requestVersion !== this._schemeRequestVersion) return;
      eventBus.emit('app:toast', `切换方案失败：${error?.message || '未知错误'}`);
    }
  }

  async _saveScheme() {
    this._schemeRequestVersion++;
    const root = this.shadowRoot;
    const select = root.querySelector('#scheme-select');
    const name = root.querySelector('#scheme-name')?.value.trim();
    if (!name) {
      eventBus.emit('app:toast', '请先填写方案名称');
      return;
    }
    const config = this.getConfig(true);
    if (!config) {
      eventBus.emit('app:toast', '请先填写完整的 API 地址和模型名称');
      return;
    }
    // 下拉中已选中的方案 → 原地更新(保留原 id)；未选中 → 新建。
    const selectedId = select?.value || '';
    const id = await saveApiScheme({
      id: selectedId || undefined,
      name,
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      model: config.model,
      backend: config.backend,
      disableStreaming: config.disableStreaming,
      adaptationMode: config.adaptationMode,
      deepseekThinking: config.deepseekThinking
    });
    if (!id) {
      eventBus.emit('app:toast', '方案保存失败');
      return;
    }
    const nameInput = root.querySelector('#scheme-name');
    if (nameInput) nameInput.value = '';
    setActiveApiScheme(id);
    await this._loadSchemes();
    eventBus.emit('app:toast', selectedId ? `已更新方案「${name}」` : `已保存方案「${name}」`);
  }

  async _deleteScheme() {
    this._schemeRequestVersion++;
    const select = this.shadowRoot.querySelector('#scheme-select');
    const id = select?.value;
    if (!id) {
      eventBus.emit('app:toast', '请先选择一个方案再删除');
      return;
    }
    await deleteApiScheme(id);
    await this._loadSchemes();
    eventBus.emit('app:toast', '方案已删除');
  }

  _syncSchemeControls(scheme) {
    const selected = Boolean(scheme?.id);
    const nameInput = this.shadowRoot.querySelector('#scheme-name');
    const saveButton = this.shadowRoot.querySelector('#scheme-save');
    const deleteButton = this.shadowRoot.querySelector('#scheme-delete');
    if (nameInput) nameInput.value = selected ? String(scheme.name || '') : '';
    if (saveButton) saveButton.textContent = selected ? '更新当前方案' : '保存当前为方案';
    if (deleteButton) deleteButton.disabled = !selected;
  }

  /** 用方案（或任意主连接配置）回填表单字段，不触发整树重渲染。 */
  setValues(config = {}) {
    const root = this.shadowRoot;
    const url = root.querySelector('#settings-api-url');
    const key = root.querySelector('#settings-api-key');
    const model = root.querySelector('#settings-api-model');
    const backend = root.querySelector('#settings-api-backend');
    const streaming = root.querySelector('#settings-disable-streaming');
    if (url) url.value = config.apiUrl || '';
    if (key) key.value = config.apiKey || '';
    if (model) model.value = config.model || '';
    if (backend) {
      backend.value = config.backend || 'openai';
      refreshCustomSelect(backend);
    }
    if (streaming) streaming.checked = Boolean(config.disableStreaming);
    for (const [selector, value] of [
      ['#settings-api-adaptation', config.adaptationMode || 'standard'],
      ['#settings-deepseek-thinking', config.deepseekThinking || 'disabled']
    ]) {
      const select = root.querySelector(selector);
      if (select) { select.value = value; refreshCustomSelect(select); }
    }
    this._syncAdaptationControls();
  }

  getConfig(allowEmptyModel = false) {
    const root = this.shadowRoot;
    if (!root) return null;
    const apiUrl = root.querySelector('#settings-api-url')?.value.trim();
    const apiKey = root.querySelector('#settings-api-key')?.value.trim();
    const model = root.querySelector('#settings-api-model')?.value.trim();
    const backend = root.querySelector('#settings-api-backend')?.value;
    const preservedOptionalConfig = {
      adaptationMode: ['claude', 'tavern'].includes(backend) ? 'standard' : (root.querySelector('#settings-api-adaptation')?.value || 'standard'),
      deepseekThinking: root.querySelector('#settings-deepseek-thinking')?.value || 'disabled',
      variableUpdater: this._config.variableUpdater,
      narrativeReview: this._config.narrativeReview,
      aiCallPolicy: this._config.aiCallPolicy
    };

    // 酒馆模型不需要 API 地址和密钥
    if (backend === 'tavern') {
      if (!allowEmptyModel && !model) return null;
      return {
        backend: 'tavern', model: model || 'tavern-default', apiUrl: '', apiKey: '', disableStreaming: false,
        ...preservedOptionalConfig
      };
    }

    if (!apiUrl || (!allowEmptyModel && !model)) return null;

    let finalApiUrl = normalizeApiBaseUrl(apiUrl, backend);
    if (backend === 'deepseek' && !apiUrl) finalApiUrl = 'https://api.deepseek.com/v1';
    if (backend === 'claude' && !apiUrl) finalApiUrl = 'https://api.anthropic.com/v1';

    const disableStreaming = root.querySelector('#settings-disable-streaming')?.checked || false;
    const config = { apiUrl: finalApiUrl, apiKey, model, backend, disableStreaming, ...preservedOptionalConfig };
    
    return config;
  }
}

customElements.define('api-config-form', ApiConfigForm);
