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

  disconnectedCallback() {
    this._offUsage?.(); this._offUsage = null;
    if (this._onOutsideModelClick) {
      document.removeEventListener('click', this._onOutsideModelClick);
      this._onOutsideModelClick = null;
    }
  }

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
        :host {
          display: block; width: 100%;
          color: var(--ui-ink, #f0ece2);
          color-scheme: var(--ui-color-scheme, dark);
        }
        *, *::before, *::after { box-sizing: border-box; }
        .settings-form { display: grid; gap: 18px; text-align: left; }
        [hidden] { display: none !important; }
        .ns-select-wrapper:has(select:disabled) { opacity: .45; pointer-events: none; }
        .usage-report {
          overflow-wrap: anywhere;
          padding: 10px 12px; border-radius: 8px;
          background: var(--ui-surface-1, #12161d);
          border: 1px solid var(--ui-border, rgba(244,241,234,0.09));
          color: var(--ui-ink-muted, #aba69b) !important;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 11px !important; line-height: 1.6 !important;
        }
        .settings-row { display: grid; gap: 7px; }
        .settings-row label {
          color: var(--ui-gold, #c69c6d); font-size: 12px; font-weight: 600;
        }
        .settings-input, .settings-select {
          width: 100%; min-height: 38px; box-sizing: border-box; padding: 8px 12px;
          border: 1px solid var(--ui-border, rgba(244,241,234,0.12));
          border-radius: 8px;
          background: var(--ui-surface-2, #181d26);
          color: var(--ui-ink, #f0ece2);
          font: 13px/1.4 var(--font-body, 'Noto Sans SC','Microsoft YaHei UI','PingFang SC', system-ui, sans-serif);
          outline: none; transition: border-color .16s ease, box-shadow .16s ease, background .16s ease;
        }
        .settings-input:focus, .settings-select:focus {
          border-color: var(--ui-accent, #eb613f);
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-accent, #eb613f) 16%, transparent);
          background: var(--ui-surface-elevated, #1e2430);
        }
        .settings-input::placeholder { color: var(--ui-ink-faint, #757168); }
        .settings-hint { color: var(--ui-ink-faint, #757168); font-size: 12px; line-height: 1.6; }
        .settings-model-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; }
        .settings-check { display: flex; gap: 10px; align-items: center; color: var(--ui-ink, #f0ece2); font-size: 13px; cursor: pointer; }
        .settings-check input {
          appearance: none; -webkit-appearance: none; width: 40px; height: 22px; flex-shrink: 0;
          border-radius: 999px; position: relative; cursor: pointer; margin: 0;
          background: var(--ui-surface-elevated, #1e2430);
          border: 1px solid var(--ui-border-strong, rgba(244,241,234,0.18));
          transition: background .18s ease, border-color .18s ease;
        }
        .settings-check input::after {
          content: ''; position: absolute; width: 16px; height: 16px; border-radius: 50%;
          top: 2px; left: 2px; background: var(--ui-ink-muted, #aba69b);
          transition: transform .18s ease, background .18s ease;
        }
        .settings-check input:checked { background: var(--ui-accent, #eb613f); border-color: var(--ui-accent, #eb613f); }
        .settings-check input:checked::after { transform: translateX(18px); background: var(--ui-accent-ink, #fff); }
        .settings-subcard {
          border: 1px solid var(--ui-border, rgba(244,241,234,0.10));
          background: var(--ui-surface-1, #12161d);
          padding: 16px 18px; display: grid; gap: 14px; border-radius: 12px;
        }
        .scheme-row { display: grid; grid-template-columns: auto minmax(0,1fr) auto; gap: 10px; align-items: center; }
        .scheme-row label { margin-bottom: 0; color: var(--ui-gold, #c69c6d); font-size: 12px; font-weight: 600; }
        .scheme-save-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 10px; align-items: center; }
        .scheme-panel .settings-hint { margin-top: -4px; }
        .settings-fetch {
          min-height: 38px; padding: 7px 14px; border-radius: 8px;
          border: 1px solid color-mix(in srgb, var(--ui-gold, #c69c6d) 36%, transparent);
          background: color-mix(in srgb, var(--ui-gold, #c69c6d) 10%, var(--ui-surface-2, #181d26));
          color: var(--ui-ink, #f0ece2);
          font: 500 12px/1.2 var(--font-body, 'Noto Sans SC', system-ui, sans-serif);
          cursor: pointer; white-space: nowrap; transition: background .16s ease, border-color .16s ease;
        }
        .settings-fetch:hover:not(:disabled) {
          border-color: var(--ui-gold, #c69c6d);
          background: color-mix(in srgb, var(--ui-gold, #c69c6d) 18%, var(--ui-surface-2, #181d26));
        }
        .settings-fetch:disabled { opacity: .42; cursor: not-allowed; }

        .model-list-wrap {
          display: none; max-height: 230px; overflow-y: auto; overflow-x: hidden;
          margin-top: 6px; border: 1px solid var(--ui-border-strong, rgba(244,241,234,0.20));
          border-radius: 10px;
          background: var(--ui-surface-elevated, #1e2430);
          box-shadow: var(--ui-shadow, 0 12px 32px rgba(0,0,0,0.45));
        }
        .model-list-wrap.open { display: block; }
        .model-filter-bar {
          position: sticky; top: 0; z-index: 2; padding: 8px;
          background: var(--ui-surface-elevated, #1e2430);
          border-bottom: 1px solid var(--ui-border, rgba(244,241,234,0.10));
        }
        .model-filter-input {
          width: 100%; padding: 6px 10px; border-radius: 6px; font-size: 12px; outline: none;
          background: var(--ui-surface-2, #181d26);
          border: 1px solid var(--ui-border, rgba(244,241,234,0.12));
          color: var(--ui-ink, #f0ece2);
        }
        .model-filter-input:focus { border-color: var(--ui-accent, #eb613f); }
        .model-item {
          padding: 8px 12px; cursor: pointer; font-size: 13px; color: var(--ui-ink-muted, #aba69b);
          border-bottom: 1px solid var(--ui-border, rgba(244,241,234,0.05));
          transition: background .14s ease, color .14s ease;
          font-family: var(--font-body, 'Noto Sans SC', system-ui, sans-serif);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .model-item:hover { background: var(--ui-surface-2, #181d26); color: var(--ui-ink, #f0ece2); }
        .model-item.selected {
          background: color-mix(in srgb, var(--ui-accent, #eb613f) 14%, transparent);
          color: var(--ui-accent, #eb613f); font-weight: 600;
          border-left: 3px solid var(--ui-accent, #eb613f);
        }
        .model-count { font-size: 11px; color: var(--ui-gold, #c69c6d); margin-top: 4px; }

        /* 简易模式下的额外样式 */
        .simple-mode .settings-input, .simple-mode .settings-select { font-size: 14px; }
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
      const filterBar = models.length > 8
        ? '<div class="model-filter-bar"><input class="model-filter-input" type="search" placeholder="筛选模型名称..." aria-label="筛选模型名称"></div>'
        : '';
      const itemsHtml = models.map(id =>
        `<div class="model-item${inputEl?.value === id ? ' selected' : ''}" data-model="${this._escAttr(id)}">${this._escAttr(id)}</div>`
      ).join('');
      listEl.innerHTML = filterBar + itemsHtml;
      listEl.classList.add('open');

      const filterInput = listEl.querySelector('.model-filter-input');
      filterInput?.addEventListener('input', () => {
        const q = filterInput.value.trim().toLowerCase();
        listEl.querySelectorAll('.model-item').forEach(item => {
          item.hidden = Boolean(q && !item.dataset.model.toLowerCase().includes(q));
        });
      });

      listEl.querySelectorAll('.model-item').forEach(item => {
        item.addEventListener('click', () => {
          if (inputEl) {
            inputEl.value = item.dataset.model;
            inputEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          }
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
    mainInput?.addEventListener('focus', () => { if (mainList?.querySelector('.model-item')) mainList.classList.add('open'); });
    this._onOutsideModelClick = (event) => {
      if (!mainList?.classList.contains('open')) return;
      const path = event.composedPath ? event.composedPath() : [event.target];
      if (!path.includes(mainList) && !path.includes(mainInput) && !path.includes(mainFetch)) {
        mainList.classList.remove('open');
      }
    };
    document.addEventListener('click', this._onOutsideModelClick);

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
