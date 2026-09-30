import { imageStudioStyles } from '../../css/components/image-studio.css.js';
import {
  DEFAULT_IMAGE_SETTINGS,
  IMAGE_PROVIDER_IDS,
  NOVELAI_IMAGE_MODELS,
  applyMainApiConfigToImageProvider,
  createImageStudioUIController,
  eventTouchesImageTarget,
  formatImageBytes,
  mergeImageWorldbooks,
  normalizeImageModelCatalog,
  normalizeImageSettings,
  normalizeImageWorldbook,
  normalizeImageWorldbookEntry,
  targetsEqual,
  toSillyTavernImageWorldbook
} from './image-studio-controller.js';

const HTMLElementBase = globalThis.HTMLElement || class {};
const WORKING_JOB_STATES = new Set(['queued', 'planning', 'generating', 'staging', 'uploading', 'binding']);
const MODEL_CATALOG_RENDER_LIMIT = 80;
const JOB_STATE_LABELS = Object.freeze({
  queued: '等待生成', planning: '正在整理画面提示词', generating: '正在绘制', staging: '正在接收图像',
  uploading: '正在同步图库', binding: '正在绑定版本', succeeded: '绘制完成', failed: '绘制失败',
  cancelled: '已取消', interrupted: '任务被中断', blocked: '等待配置'
});

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function attr(value) { return esc(value); }
function asArray(value) { return Array.isArray(value) ? value : []; }
function assetId(asset) { return String(asset?.id ?? asset?.assetId ?? ''); }
function bindingAssetId(binding) { return String(binding?.assetId ?? binding?.selectedAssetId ?? binding?.asset?.id ?? ''); }
function bindingRevision(binding) { return binding?.revision ?? binding?.bindingRevision ?? undefined; }
function providerConnectionFingerprint(provider = {}) {
  return JSON.stringify([
    String(provider.apiUrl || '').trim(),
    String(provider.apiKey || ''),
    String(provider.apiKeyHeader || 'Authorization').trim().toLowerCase()
  ]);
}
function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function safeMediaUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (/^(blob:|data:image\/|https?:\/\/|\/)/i.test(url)) return url;
  if (/^[.]{0,2}\//.test(url)) return url;
  return '';
}

function dateLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

function downloadJSON(value, filename) {
  if (typeof document === 'undefined' || typeof Blob === 'undefined') return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function resolveContainer(container) {
  if (typeof container === 'string') return document.querySelector(container);
  return container;
}

function setElementController(element, options = {}) {
  if (options.controller) element.controller = options.controller;
  else element.controller = createImageStudioUIController(options.imageStudio || null, options.adapter);
  return element;
}

class ImageStudioElement extends HTMLElementBase {
  constructor() {
    super();
    this.attachShadow?.({ mode: 'open' });
    this._controller = createImageStudioUIController(null);
    this._unsubscribe = null;
    this._refreshTimer = null;
    this._objectUrls = new Set();
  }

  set imageStudio(value) { this.controller = createImageStudioUIController(value); }
  get imageStudio() { return this._controller?.imageStudio || null; }
  set controller(value) {
    this._controller = createImageStudioUIController(value);
    if (this.isConnected) {
      this._subscribe();
      this.refresh?.();
    }
  }
  get controller() { return this._controller; }

  connectedCallback() { this._subscribe(); }
  disconnectedCallback() {
    this._unsubscribe?.();
    this._unsubscribe = null;
    clearTimeout(this._refreshTimer);
    this._releaseObjectUrls();
  }

  _subscribe() {
    this._unsubscribe?.();
    this._unsubscribe = this._controller?.subscribe?.((event) => this._onStudioEvent?.(event)) || null;
  }

  _scheduleRefresh(delay = 40) {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this.refresh?.(), delay);
  }

  _releaseObjectUrls() {
    for (const url of this._objectUrls) {
      try { URL.revokeObjectURL(url); } catch (_) { /* noop */ }
    }
    this._objectUrls.clear();
  }

  async _assetUrlMap(assets, variant = 'thumbnail') {
    const urls = new Map();
    await Promise.all(asArray(assets).map(async (asset) => {
      try {
        const url = safeMediaUrl(await this._controller.assetUrl(asset, variant));
        if (url) {
          urls.set(assetId(asset), url);
          if (url.startsWith('blob:')) this._objectUrls.add(url);
        }
      } catch (_) { /* broken assets render as placeholders */ }
    }));
    return urls;
  }

  _viewElementPath(element) {
    const root = this.shadowRoot;
    if (!root || !element) return null;
    const path = [];
    let node = element;
    while (node && node !== root) {
      const parent = node.parentNode;
      if (!parent?.children) return null;
      const index = Array.from(parent.children).indexOf(node);
      if (index < 0) return null;
      path.unshift(index);
      node = parent;
    }
    return node === root ? path : null;
  }

  _viewElementAt(path) {
    if (!this.shadowRoot || !Array.isArray(path)) return null;
    let node = this.shadowRoot;
    for (const index of path) node = node?.children?.[index];
    return node || null;
  }

  _captureViewState() {
    const root = this.shadowRoot;
    if (!root) return null;
    const active = root.activeElement;
    const activePath = this._viewElementPath(active);
    const selection = active && typeof active.selectionStart === 'number'
      ? { start: active.selectionStart, end: active.selectionEnd, direction: active.selectionDirection }
      : null;
    return {
      active: activePath ? { path: activePath, tagName: active.tagName, selection } : null,
      details: [...root.querySelectorAll('details')].map(element => ({
        path: this._viewElementPath(element), open: element.open
      })),
      scrolls: [...root.querySelectorAll('.is-gallery-body, .is-versions, .is-worldbook-list')].map(element => ({
        path: this._viewElementPath(element), top: element.scrollTop, left: element.scrollLeft
      }))
    };
  }

  _restoreViewState(state) {
    if (!state) return;
    for (const detail of state.details || []) {
      const element = this._viewElementAt(detail.path);
      if (element?.tagName === 'DETAILS') element.open = detail.open;
    }
    const active = this._viewElementAt(state.active?.path);
    if (active && active.tagName === state.active?.tagName && !active.disabled) {
      active.focus({ preventScroll: true });
      const selection = state.active.selection;
      if (selection && typeof active.setSelectionRange === 'function') {
        try { active.setSelectionRange(selection.start, selection.end, selection.direction || 'none'); } catch (_) { /* unsupported input type */ }
      }
    }
    const restoreScroll = () => {
      for (const scroll of state.scrolls || []) {
        const element = this._viewElementAt(scroll.path);
        if (!element) continue;
        element.scrollTop = scroll.top;
        element.scrollLeft = scroll.left;
      }
    };
    restoreScroll();
    globalThis.requestAnimationFrame?.(restoreScroll);
  }
}

export class ImageStudioSettings extends ImageStudioElement {
  constructor() {
    super();
    this._settings = normalizeImageSettings(DEFAULT_IMAGE_SETTINGS);
    this._worldbook = normalizeImageWorldbook({});
    this._worldbookScope = 'global';
    this._quota = { usedBytes: 0, limitBytes: 1024 ** 3, assetCount: 0, assetLimit: 500 };
    this._modelCatalog = { models: [], imageModels: [] };
    this._modelSearch = '';
    this._modelRequestRevision = 0;
    this._loading = true;
    this._message = '';
    this._tone = '';
  }

  connectedCallback() {
    super.connectedCallback();
    this.render();
    this.refresh();
  }

  async refresh() {
    if (!this._controller.available) {
      this._loading = false;
      this._message = '文生图运行时尚未接入；现有游戏功能不受影响。';
      this._tone = '';
      this.render();
      return;
    }
    this._loading = true;
    this.render();
    const [settings, worldbook, quota] = await Promise.allSettled([
      this._controller.settings(), this._controller.worldbook(), this._controller.quota()
    ]);
    if (settings.status === 'fulfilled') this._settings = settings.value;
    if (worldbook.status === 'fulfilled') this._worldbook = worldbook.value;
    if (quota.status === 'fulfilled') this._quota = quota.value;
    const failed = [settings, worldbook, quota].filter(result => result.status === 'rejected');
    this._loading = false;
    this._message = failed.length ? `有 ${failed.length} 项配置暂时无法读取，可保存后重试。` : '';
    this._tone = failed.length ? 'error' : '';
    this.render();
  }

  _onStudioEvent(event) {
    if (/asset|quota|gallery/i.test(String(event?.type || ''))) this._scheduleQuotaRefresh();
  }

  _scheduleQuotaRefresh() {
    clearTimeout(this._quotaTimer);
    this._quotaTimer = setTimeout(async () => {
      try { this._quota = await this._controller.quota(); this._renderQuota(); } catch (_) { /* noop */ }
    }, 180);
  }

  _quotaHtml() {
    const q = this._quota;
    const bytePct = q.limitBytes ? Math.min(100, q.usedBytes / q.limitBytes * 100) : 0;
    const countPct = q.assetLimit ? Math.min(100, q.assetCount / q.assetLimit * 100) : 0;
    const pct = Math.max(bytePct, countPct);
    return `<div id="is-quota">
      <div class="is-inline" style="justify-content:space-between;align-items:flex-end;">
        <div class="is-metric"><strong>${formatImageBytes(q.usedBytes)}</strong><span>/ ${formatImageBytes(q.limitBytes)}</span></div>
        <div class="is-metric"><strong>${q.assetCount}</strong><span>/ ${q.assetLimit} 张</span></div>
      </div>
      <div class="is-quota-track" style="--quota:${pct.toFixed(2)}%"><i></i></div>
    </div>`;
  }

  _renderQuota() {
    const old = this.shadowRoot?.getElementById('is-quota');
    if (!old) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = this._quotaHtml();
    old.replaceWith(wrapper.firstElementChild);
  }

  _modelCatalogHtml() {
    const catalog = this._modelCatalog || { models: [], imageModels: [] };
    if (!catalog.models.length) {
      return '<div class="is-model-catalog is-note" data-model-catalog>读取后会在这里列出疑似生图模型和站点的其他模型；不会自动替换手填值。</div>';
    }
    const query = String(this._modelSearch || '').trim().toLocaleLowerCase();
    const matches = query
      ? catalog.models.filter(model => model.toLocaleLowerCase().includes(query))
      : catalog.models;
    const matchSet = new Set(matches);
    const imageMatches = catalog.imageModels.filter(model => matchSet.has(model));
    const visibleImages = imageMatches.slice(0, MODEL_CATALOG_RENDER_LIMIT);
    const visibleModels = matches.slice(0, MODEL_CATALOG_RENDER_LIMIT);
    const buttons = (models, attribute) => models.map(model => `<button class="is-model-option" type="button" ${attribute}="${attr(model)}" title="选择 ${attr(model)}">${esc(model)}</button>`).join('');
    const limitNote = matches.length > MODEL_CATALOG_RENDER_LIMIT
      ? `<div class="is-model-limit">仅显示前 ${MODEL_CATALOG_RENDER_LIMIT} 项，请搜索以缩小范围。</div>`
      : '';
    return `<div class="is-model-catalog" data-model-catalog>
      <div class="is-model-search"><input type="search" data-model-search value="${attr(this._modelSearch)}" aria-label="搜索站点模型" placeholder="搜索模型名称"><span>${matches.length} / ${catalog.models.length}</span></div>
      ${visibleImages.length ? `<section class="is-model-group" data-model-group="image"><div class="is-model-group-title">疑似生图模型 <span>${imageMatches.length}</span></div><div class="is-model-options">${buttons(visibleImages, 'data-model-id')}</div></section>` : '<div class="is-note">当前筛选下没有明显的生图模型，仍可从全部模型中选择。</div>'}
      <details class="is-model-group" data-model-group="all"><summary>全部模型 <span>${matches.length}</span></summary>${visibleModels.length ? `<div class="is-model-options">${buttons(visibleModels, 'data-model-value')}</div>${limitNote}` : '<div class="is-note">没有匹配的模型。</div>'}</details>
    </div>`;
  }

  _bindModelCatalog() {
    const root = this.shadowRoot;
    root?.querySelector('[data-model-search]')?.addEventListener('input', (event) => {
      this._modelSearch = event.currentTarget.value;
      this._renderModelCatalog(true);
    });
    root?.querySelectorAll('[data-model-id], [data-model-value]').forEach(button => button.addEventListener('click', () => {
      const input = root.querySelector('[name="openai.model"]');
      const model = button.dataset.modelId || button.dataset.modelValue || '';
      if (input) input.value = model;
      this._setMessage(`已选择图像模型：${model}。保存后生效。`, 'success');
    }));
  }

  _renderModelCatalog(focusSearch = false) {
    const current = this.shadowRoot?.querySelector('[data-model-catalog]');
    if (!current) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = this._modelCatalogHtml();
    current.replaceWith(wrapper.firstElementChild);
    this._bindModelCatalog();
    if (focusSearch) {
      const search = this.shadowRoot?.querySelector('[data-model-search]');
      search?.focus({ preventScroll: true });
      const end = search?.value?.length || 0;
      try { search?.setSelectionRange(end, end); } catch (_) { /* unsupported search input */ }
    }
  }

  _providerHtml(providerId) {
    const provider = this._settings.providers[providerId] || {};
    if (providerId === 'openai-compatible') return `
      <div class="is-grid is-provider-fields" data-provider-fields="${providerId}">
        <label>API 地址</label><div class="is-field-stack"><div class="is-inline"><input type="url" name="openai.apiUrl" value="${attr(provider.apiUrl)}" placeholder="https://api.openai.com/v1"><button class="is-btn" type="button" data-action="use-main-api">使用正文 API 配置</button></div><span class="is-field-hint">只复制地址、密钥和 Header，不复制正文语言模型。</span></div>
        <label>API Key</label><input type="password" name="openai.apiKey" value="${attr(provider.apiKey)}" autocomplete="off" placeholder="仅保存在当前浏览器/存档配置中">
        <label>API Key Header</label><select name="openai.apiKeyHeader">
          ${['Authorization', 'x-api-key', 'api-key'].map(header => `<option value="${header}" ${provider.apiKeyHeader === header ? 'selected' : ''}>${header}</option>`).join('')}
        </select>
        <label>图像模型</label><div class="is-inline"><input type="text" name="openai.model" value="${attr(provider.model)}" placeholder="gpt-image-1"><button class="is-btn" type="button" data-action="fetch-image-models" ${!this._controller.available ? 'disabled' : ''}>读取模型</button></div>
        <div class="is-span">${this._modelCatalogHtml()}</div>
        <label>默认尺寸</label><select name="openai.size">
          ${['1024x1024', '1024x1536', '1536x1024', 'auto'].map(size => `<option value="${size}" ${provider.size === size ? 'selected' : ''}>${size}</option>`).join('')}
        </select>
      </div>`;
    if (providerId === 'novelai') return `
      <div class="is-grid is-provider-fields" data-provider-fields="${providerId}">
        <label>API 地址</label><input type="url" name="novelai.apiUrl" value="${attr(provider.apiUrl)}" placeholder="https://image.novelai.net">
        <label>API Token</label><div class="is-field-stack"><input type="password" name="novelai.apiKey" value="${attr(provider.apiKey)}" autocomplete="off" placeholder="NovelAI Persistent API Token"><span class="is-field-hint">使用 NovelAI 账户生成的 Persistent API Token；仅保存在当前浏览器/存档配置中。</span></div>
        <label>模型</label><div class="is-field-stack"><input type="text" name="novelai.model" list="novelai-model-options" value="${attr(provider.model)}" placeholder="nai-diffusion-4-5-full"><datalist id="novelai-model-options">${NOVELAI_IMAGE_MODELS.map(item => `<option value="${attr(item.id)}">${esc(item.label)}</option>`).join('')}</datalist><span class="is-field-hint">可从目录选择，也可手动填写以后新增的模型 ID。</span></div>
        <label for="novelai-artist-prompt">画师串</label><div class="is-field-stack"><textarea id="novelai-artist-prompt" name="novelai.artistPrompt" rows="3" spellcheck="false" placeholder="填写画师标签，可包含权重语法" aria-describedby="novelai-artist-prompt-hint">${esc(provider.artistPrompt)}</textarea><span class="is-field-hint" id="novelai-artist-prompt-hint">可多行填写，画师标签和权重语法会原样保留；每次使用 NovelAI 生成时自动追加到正向提示词，留空不追加。</span></div>
        <label>采样器</label><select name="novelai.sampler">
          ${['k_euler_ancestral', 'k_euler', 'k_dpmpp_2m', 'k_dpmpp_2s_ancestral', 'k_dpmpp_sde', 'ddim_v3'].map(sampler => `<option value="${sampler}" ${provider.sampler === sampler ? 'selected' : ''}>${sampler}</option>`).join('')}
        </select>
        <label>噪声计划</label><select name="novelai.noiseSchedule">
          ${['karras', 'native', 'exponential', 'polyexponential'].map(schedule => `<option value="${schedule}" ${provider.noiseSchedule === schedule ? 'selected' : ''}>${schedule}</option>`).join('')}
        </select>
        <label>步数</label><input type="number" name="novelai.steps" min="1" max="50" value="${attr(provider.steps)}">
        <label>默认尺寸</label><div class="is-inline"><input type="number" name="novelai.width" min="64" max="2048" step="64" value="${attr(provider.width)}"><span>×</span><input type="number" name="novelai.height" min="64" max="2048" step="64" value="${attr(provider.height)}"></div>
        <label>Prompt Guidance</label><input type="number" name="novelai.scale" min="0" max="20" step="0.1" value="${attr(provider.scale)}">
        <label>CFG Rescale</label><input type="number" name="novelai.cfgRescale" min="0" max="1" step="0.05" value="${attr(provider.cfgRescale)}">
        <label>质量标签增强</label><div class="is-field-stack"><input type="checkbox" name="novelai.qualityToggle" ${provider.qualityToggle !== false ? 'checked' : ''}><span class="is-field-hint">由 NovelAI 自动追加当前模型的质量标签。</span></div>
      </div>`;
    if (providerId === 'comfyui') {
      const mapping = provider.mapping || {};
      return `<div class="is-grid is-provider-fields" data-provider-fields="${providerId}">
        <label>服务地址</label><input type="url" name="comfy.apiUrl" value="${attr(provider.apiUrl)}" placeholder="http://127.0.0.1:8188">
        <label>API 工作流</label><div class="is-field-stack"><textarea class="is-code" name="comfy.workflow" rows="7" placeholder="粘贴 ComfyUI API-format workflow JSON">${esc(typeof provider.workflow === 'string' ? provider.workflow : JSON.stringify(provider.workflow || '', null, 2))}</textarea><input type="file" data-action="workflow-file" accept="application/json,.json"></div>
        <label>正向提示端口</label><input type="text" name="comfy.map.positive" value="${attr(mapping.positive)}" placeholder="例如 6.inputs.text">
        <label>负向提示端口</label><input type="text" name="comfy.map.negative" value="${attr(mapping.negative)}" placeholder="例如 7.inputs.text">
        <label>Seed 端口</label><input type="text" name="comfy.map.seed" value="${attr(mapping.seed)}" placeholder="例如 3.inputs.seed">
        <label>尺寸端口</label><div class="is-inline"><input type="text" name="comfy.map.width" value="${attr(mapping.width)}" placeholder="width"><input type="text" name="comfy.map.height" value="${attr(mapping.height)}" placeholder="height"></div>
        <label>输出节点</label><input type="text" name="comfy.map.output" value="${attr(mapping.output)}" placeholder="SaveImage 节点 ID">
        <label>参考图端口</label><input type="text" name="comfy.map.reference" value="${attr(mapping.reference)}" placeholder="可选；工作流不支持时自动降级">
      </div>`;
    }
    return `<div class="is-grid is-provider-fields" data-provider-fields="${providerId}">
      <label>服务地址</label><input type="url" name="a1111.apiUrl" value="${attr(provider.apiUrl)}" placeholder="http://127.0.0.1:7860">
      <label>Checkpoint</label><input type="text" name="a1111.model" value="${attr(provider.model)}" placeholder="留空使用服务当前模型">
      <label>采样器</label><input type="text" name="a1111.sampler" value="${attr(provider.sampler)}" placeholder="DPM++ 2M Karras">
      <label>步数</label><input type="number" name="a1111.steps" min="1" max="150" value="${attr(provider.steps)}">
      <label>默认尺寸</label><div class="is-inline"><input type="number" name="a1111.width" min="64" max="8192" step="8" value="${attr(provider.width)}"><span>×</span><input type="number" name="a1111.height" min="64" max="8192" step="8" value="${attr(provider.height)}"></div>
    </div>`;
  }

  _worldbookHtml() {
    const entries = this._worldbook[this._worldbookScope] || [];
    return `<div class="is-inline" style="justify-content:space-between;flex-wrap:wrap;">
      <select data-action="worldbook-scope" aria-label="图像世界书层级" style="width:auto;">
        <option value="global" ${this._worldbookScope === 'global' ? 'selected' : ''}>全局图像世界书</option>
        <option value="overlay" ${this._worldbookScope === 'overlay' ? 'selected' : ''}>当前存档覆盖层</option>
      </select>
      <div class="is-actions">
        <button class="is-btn is-btn--small" type="button" data-action="worldbook-add">＋ 条目</button>
        <button class="is-btn is-btn--small" type="button" data-action="worldbook-import">导入</button>
        <button class="is-btn is-btn--small" type="button" data-action="worldbook-export-native">导出 JSON</button>
        <button class="is-btn is-btn--small" type="button" data-action="worldbook-export-st">导出酒馆格式</button>
        <input type="file" data-worldbook-file accept="application/json,.json" hidden>
      </div>
    </div>
    <div class="is-worldbook-list">${entries.length ? entries.map((entry, index) => `
      <article class="is-worldbook-entry" data-worldbook-index="${index}">
        <div class="is-worldbook-entry-head">
          <input type="text" data-wb-field="name" value="${attr(entry.name)}" placeholder="条目名称">
          <button class="is-btn is-btn--small is-btn--danger" type="button" data-action="worldbook-delete" data-index="${index}">删除</button>
        </div>
        <div class="is-grid">
          <label>启用</label><input type="checkbox" data-wb-field="enabled" ${entry.enabled ? 'checked' : ''}>
          <label>触发词</label><input type="text" data-wb-field="keywords" value="${attr(entry.keywords.join(', '))}" placeholder="木叶, 夜晚, 卡卡西">
          <label>次级触发词</label><input type="text" data-wb-field="secondaryKeywords" value="${attr((entry.secondaryKeywords || []).join(', '))}" placeholder="可选；主触发词与其中一项同时命中">
          <label>正向补充</label><textarea data-wb-field="prompt" placeholder="命中触发词时追加到画面提示">${esc(entry.prompt)}</textarea>
          <label>负向补充</label><textarea data-wb-field="negativePrompt" placeholder="可选">${esc(entry.negativePrompt)}</textarea>
          <label>优先级</label><input type="number" data-wb-field="priority" value="${attr(entry.priority)}">
        </div>
      </article>`).join('') : '<div class="is-empty">此层还没有图像世界书条目</div>'}</div>`;
  }

  render(viewState = this._captureViewState()) {
    if (!this.shadowRoot) return;
    const s = this._settings;
    const providerNames = {
      'openai-compatible': 'OpenAI 兼容 Images API', novelai: 'NovelAI Diffusion',
      comfyui: '本地 ComfyUI', a1111: '本地 A1111 / Forge'
    };
    this.shadowRoot.innerHTML = `<style>${imageStudioStyles}</style>
      <div class="is-card" aria-busy="${this._loading ? 'true' : 'false'}">
        <section class="is-section">
          <div class="is-section-head"><div><p class="is-eyebrow">IMAGE STUDIO</p><h3>画面生成</h3><p class="is-note">叙事提交后生成插图；绘图任务不会阻塞下一回合。</p></div><input type="checkbox" name="enabled" aria-label="启用文生图" ${s.enabled ? 'checked' : ''}></div>
          ${!this._controller.available ? '<div class="is-unavailable">文生图服务尚未初始化。保存、测试连接和生成按钮会保持禁用，其他游戏功能可照常使用。</div>' : ''}
          <div class="is-grid" style="margin-top:14px;">
            <label>回合插图</label><select name="turnMode"><option value="manual" ${s.turnMode === 'manual' ? 'selected' : ''}>手动选择生成</option><option value="automatic" ${s.turnMode === 'automatic' ? 'selected' : ''}>每回合自动生成</option></select>
            <label>提示词规划</label><select name="promptMode"><option value="main-contract" ${s.promptMode === 'main-contract' ? 'selected' : ''}>正文模型输出隐藏画面契约</option><option value="separate-model" ${s.promptMode === 'separate-model' ? 'selected' : ''}>独立文本模型规划画面</option></select>
          </div>
        </section>
        <section class="is-section" data-separate-model ${s.promptMode === 'separate-model' ? '' : 'hidden'}>
          <div class="is-section-head"><div><h4>独立提示词模型</h4><p class="is-note">只负责把正文整理为结构化画面契约，不参与正文创作。</p></div></div>
          <div class="is-grid">
            <label>API 地址</label><input type="url" name="prompt.apiUrl" value="${attr(s.separatePromptModel.apiUrl)}" placeholder="留空继承正文模型地址">
            <label>API Key</label><input type="password" name="prompt.apiKey" value="${attr(s.separatePromptModel.apiKey)}" autocomplete="off" placeholder="留空继承正文模型密钥">
            <label>模型</label><input type="text" name="prompt.model" value="${attr(s.separatePromptModel.model)}" placeholder="留空继承正文模型">
            <label>Temperature</label><input type="number" name="prompt.temperature" min="0" max="2" step="0.05" value="${attr(s.separatePromptModel.temperature)}">
          </div>
        </section>
        <section class="is-section">
          <div class="is-section-head"><div><h4>绘图后端</h4><p class="is-note">公网接口使用你自己的凭据；支持 OpenAI 兼容站点、NovelAI，以及本地 ComfyUI、A1111 或 Forge。</p></div></div>
          <div class="is-provider">
            <div class="is-inline"><select name="activeProviderId" aria-label="绘图后端">${IMAGE_PROVIDER_IDS.map(providerId => `<option value="${providerId}" ${s.activeProviderId === providerId ? 'selected' : ''}>${providerNames[providerId]}</option>`).join('')}</select><button class="is-btn" type="button" data-action="probe" ${!this._controller.available ? 'disabled' : ''}>测试连接</button></div>
            ${IMAGE_PROVIDER_IDS.map(providerId => this._providerHtml(providerId)).join('')}
          </div>
          <div class="is-warning" style="margin-top:12px;">浏览器不会接收或上传模型权重。NovelAI 测试连接会请求免费标签接口，只验证网络；Token、余额及生图权限会在生成时验证。公网生图依赖运行网站的服务器网络。ComfyUI 仅接受 API 格式工作流 JSON。局域网地址首次连接可能需要浏览器授权。</div>
          <div class="is-grid" style="margin-top:12px;"><label>局域网直连白名单</label><input type="text" name="allowedPrivateOrigins" value="${attr((s.allowedPrivateOrigins || []).join(', '))}" placeholder="例如 http://192.168.1.20:8188（逗号分隔）"></div>
          <div class="is-grid" style="margin-top:12px;"><label>公网明文 HTTP 白名单</label><input type="text" name="allowedPublicHttpOrigins" value="${attr((s.allowedPublicHttpOrigins || []).join(', '))}" placeholder="例如 http://new.fangxiaobai.store:8050（逗号分隔）"><span class="is-note">仅对公网但未启用 HTTPS 的自建中转放行 http；需与服务端 .env 的 AI_PROXY_ALLOW_HTTP_TARGETS 一致。</span></div>
        </section>
        <section class="is-section">
          <div class="is-section-head"><div><h4>图像世界书</h4><p class="is-note">全局层提供统一画风，存档覆盖层优先补充当前角色与服装细节。支持原生与 SillyTavern JSON。</p></div></div>
          ${this._worldbookHtml()}
        </section>
        <section class="is-section">
          <div class="is-section-head"><div><h4>图库配额</h4><p class="is-note">选中版本、已保护版本与活跃任务引用的图片不会被自动清理。</p></div></div>
          ${this._quotaHtml()}
          <div class="is-grid" style="margin-top:14px;"><label>配额满时自动清理</label><input type="checkbox" name="autoEviction" ${s.autoEviction ? 'checked' : ''}></div>
        </section>
        <section class="is-section">
          <div class="is-actions"><button class="is-btn is-btn--primary" type="button" data-action="save" ${!this._controller.available || this._loading ? 'disabled' : ''}>保存画面设置</button><button class="is-btn" type="button" data-action="gallery" ${!this._controller.available ? 'disabled' : ''}>打开图库</button></div>
          <div class="is-status" data-tone="${attr(this._tone)}" role="status">${esc(this._loading ? '正在读取画面设置…' : this._message)}</div>
        </section>
      </div>`;
    this._toggleProviderFields();
    this._bind();
    this._restoreViewState(viewState);
  }

  _toggleProviderFields() {
    const selected = this.shadowRoot?.querySelector('[name="activeProviderId"]')?.value || this._settings.activeProviderId;
    this.shadowRoot?.querySelectorAll('[data-provider-fields]').forEach(element => {
      element.hidden = element.dataset.providerFields !== selected;
    });
  }

  _collectSettings() {
    const root = this.shadowRoot;
    if (!root) return this._settings;
    const value = (name) => root.querySelector(`[name="${name}"]`)?.value ?? '';
    const checked = (name) => Boolean(root.querySelector(`[name="${name}"]`)?.checked);
    const previous = normalizeImageSettings(this._settings);
    return normalizeImageSettings({
      ...previous,
      enabled: checked('enabled'),
      turnMode: value('turnMode'), promptMode: value('promptMode'), activeProviderId: value('activeProviderId'),
      autoEviction: checked('autoEviction'),
      allowedPrivateOrigins: value('allowedPrivateOrigins').split(/[,，\n]/).map(item => item.trim()).filter(Boolean),
      allowedPublicHttpOrigins: value('allowedPublicHttpOrigins').split(/[,，\n]/).map(item => item.trim()).filter(Boolean),
      separatePromptModel: {
        ...previous.separatePromptModel, apiUrl: value('prompt.apiUrl').trim(), apiKey: value('prompt.apiKey'),
        model: value('prompt.model').trim(), temperature: clamp(value('prompt.temperature'), 0, 2, .25)
      },
      providers: {
        ...previous.providers,
        'openai-compatible': { ...previous.providers['openai-compatible'], apiUrl: value('openai.apiUrl').trim(), apiKey: value('openai.apiKey'), apiKeyHeader: value('openai.apiKeyHeader'), model: value('openai.model').trim(), size: value('openai.size') },
        novelai: { ...previous.providers.novelai, apiUrl: value('novelai.apiUrl').trim(), apiKey: value('novelai.apiKey'), apiKeyHeader: 'Authorization', model: value('novelai.model').trim(), artistPrompt: value('novelai.artistPrompt'), sampler: value('novelai.sampler'), noiseSchedule: value('novelai.noiseSchedule'), steps: clamp(value('novelai.steps'), 1, 50, 28), width: clamp(value('novelai.width'), 64, 2048, 832), height: clamp(value('novelai.height'), 64, 2048, 1216), scale: clamp(value('novelai.scale'), 0, 20, 5), cfgRescale: clamp(value('novelai.cfgRescale'), 0, 1, 0), qualityToggle: checked('novelai.qualityToggle') },
        comfyui: { ...previous.providers.comfyui, apiUrl: value('comfy.apiUrl').trim(), workflow: value('comfy.workflow'), mapping: { positive: value('comfy.map.positive').trim(), negative: value('comfy.map.negative').trim(), seed: value('comfy.map.seed').trim(), width: value('comfy.map.width').trim(), height: value('comfy.map.height').trim(), output: value('comfy.map.output').trim(), reference: value('comfy.map.reference').trim() } },
        a1111: { ...previous.providers.a1111, apiUrl: value('a1111.apiUrl').trim(), model: value('a1111.model').trim(), sampler: value('a1111.sampler').trim(), steps: clamp(value('a1111.steps'), 1, 150, 28), width: clamp(value('a1111.width'), 64, 8192, 768), height: clamp(value('a1111.height'), 64, 8192, 1024) }
      }
    });
  }

  _captureWorldbookEntry(element) {
    const index = Number(element.dataset.worldbookIndex);
    const entries = this._worldbook[this._worldbookScope] || [];
    const current = entries[index];
    if (!current) return;
    const field = (name) => element.querySelector(`[data-wb-field="${name}"]`);
    entries[index] = normalizeImageWorldbookEntry({ ...current,
      name: field('name')?.value, enabled: field('enabled')?.checked,
      keywords: field('keywords')?.value, prompt: field('prompt')?.value,
      secondaryKeywords: field('secondaryKeywords')?.value,
      negativePrompt: field('negativePrompt')?.value, priority: field('priority')?.value
    }, current.id);
  }

  _captureWorldbook() {
    this.shadowRoot?.querySelectorAll('[data-worldbook-index]').forEach(element => this._captureWorldbookEntry(element));
  }

  _setMessage(message, tone = '') {
    this._message = message; this._tone = tone;
    const status = this.shadowRoot?.querySelector('.is-status');
    if (status) { status.textContent = message; status.dataset.tone = tone; }
  }

  async _save() {
    this._settings = this._collectSettings();
    this._captureWorldbook();
    this._setMessage('正在保存画面设置…', 'working');
    try {
      await Promise.all([this._controller.saveSettings(this._settings), this._controller.saveWorldbook(this._worldbook)]);
      this._setMessage('画面设置与图像世界书已保存。', 'success');
    } catch (error) { this._setMessage(error?.message || '保存失败，请稍后重试。', 'error'); }
  }

  async _probe() {
    this._settings = this._collectSettings();
    const providerId = this._settings.activeProviderId;
    this._setMessage('正在探测绘图后端…', 'working');
    try {
      const result = await this._controller.probeProvider(providerId, this._settings.providers[providerId]);
      const detail = result?.message || result?.model || result?.status || '连接成功';
      const prefix = result?.verified === false
        ? (result?.status === 'connected' ? '绘图网络已连通' : '绘图配置已识别')
        : '绘图后端可用';
      this._setMessage(`${prefix}：${detail}`, 'success');
    } catch (error) { this._setMessage(error?.message || '连接失败。请检查服务地址、CORS 与凭据。', 'error'); }
  }

  async _fetchImageModels() {
    this._settings = this._collectSettings();
    const requestRevision = ++this._modelRequestRevision;
    const provider = this._settings.providers['openai-compatible'];
    const connectionFingerprint = providerConnectionFingerprint(provider);
    const button = this.shadowRoot?.querySelector('[data-action="fetch-image-models"]');
    if (button) { button.disabled = true; button.textContent = '读取中…'; }
    this._setMessage('正在读取站点模型目录…', 'working');
    try {
      const result = await this._controller.probeProvider('openai-compatible', provider);
      if (requestRevision !== this._modelRequestRevision) {
        if (button?.isConnected) { button.disabled = false; button.textContent = '读取模型'; }
        return;
      }
      const latestSettings = this._collectSettings();
      const latestProvider = latestSettings.providers['openai-compatible'];
      this._settings = latestSettings;
      if (providerConnectionFingerprint(latestProvider) !== connectionFingerprint) {
        this._setMessage('API 连接信息已修改；已忽略旧目录，请重新读取。', '');
        if (button?.isConnected) { button.disabled = false; button.textContent = '读取模型'; }
        return;
      }
      const discovered = normalizeImageModelCatalog(result);
      if (!discovered.models.length) throw new Error('站点没有返回可用模型');
      this._modelCatalog = normalizeImageModelCatalog(result, latestProvider.model);
      this._modelSearch = '';
      this._captureWorldbook();
      this._message = `已读取 ${discovered.models.length} 个模型；请自行选择生图模型。`;
      this._tone = 'success';
      this.render();
    } catch (error) {
      if (requestRevision !== this._modelRequestRevision) {
        if (button?.isConnected) { button.disabled = false; button.textContent = '读取模型'; }
        return;
      }
      this._setMessage(error?.message || '模型目录读取失败；已保留手填值与上次目录。', 'error');
      if (button) { button.disabled = false; button.textContent = '读取模型'; }
    }
  }

  async _useMainApiConfig() {
    this._settings = this._collectSettings();
    const requestRevision = ++this._modelRequestRevision;
    const button = this.shadowRoot?.querySelector('[data-action="use-main-api"]');
    if (button) { button.disabled = true; button.textContent = '读取中…'; }
    this._setMessage('正在读取正文 API 配置…', 'working');
    try {
      const mainConfig = await this._controller.mainApiConfig();
      if (requestRevision !== this._modelRequestRevision) {
        if (button?.isConnected) { button.disabled = false; button.textContent = '使用正文 API 配置'; }
        return;
      }
      if (!mainConfig.apiUrl) throw new Error('正文模型尚未配置可复用的 API 地址');
      this._settings = this._collectSettings();
      this._settings.providers['openai-compatible'] = applyMainApiConfigToImageProvider(
        this._settings.providers['openai-compatible'], mainConfig
      );
      this._modelCatalog = { models: [], imageModels: [] };
      this._modelSearch = '';
      this._captureWorldbook();
      this._message = '已复制正文 API 地址、密钥和 Header；图像模型保持不变，请读取目录后自行选择。';
      this._tone = 'success';
      this.render();
    } catch (error) {
      if (requestRevision !== this._modelRequestRevision) {
        if (button?.isConnected) { button.disabled = false; button.textContent = '使用正文 API 配置'; }
        return;
      }
      this._setMessage(error?.message || '正文 API 配置读取失败。', 'error');
      if (button) { button.disabled = false; button.textContent = '使用正文 API 配置'; }
    }
  }

  _rerenderPreservingForm() {
    this._settings = this._collectSettings();
    this._captureWorldbook();
    this.render();
  }

  async _importWorldbook(file) {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      this._captureWorldbook();
      this._worldbook = mergeImageWorldbooks(this._worldbook, payload, { scope: this._worldbookScope });
      this._message = `已合并 ${file.name}，保存后生效。`;
      this._tone = 'success';
      this.render();
    } catch (error) {
      this._setMessage(`世界书导入失败：${error?.message || 'JSON 格式无效'}`, 'error');
    }
  }

  _bind() {
    const root = this.shadowRoot;
    root?.querySelector('[name="activeProviderId"]')?.addEventListener('change', () => this._toggleProviderFields());
    root?.querySelector('[name="promptMode"]')?.addEventListener('change', (event) => {
      root.querySelector('[data-separate-model]').hidden = event.target.value !== 'separate-model';
    });
    root?.querySelector('[data-action="workflow-file"]')?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        root.querySelector('[name="comfy.workflow"]').value = JSON.stringify(parsed, null, 2);
        this._setMessage(`已载入工作流 ${file.name}，请测试连接。`, 'success');
      } catch (error) { this._setMessage(`工作流不是有效 JSON：${error.message}`, 'error'); }
    });
    root?.querySelector('[data-action="save"]')?.addEventListener('click', () => this._save());
    root?.querySelector('[data-action="probe"]')?.addEventListener('click', () => this._probe());
    root?.querySelector('[data-action="fetch-image-models"]')?.addEventListener('click', () => this._fetchImageModels());
    root?.querySelector('[data-action="use-main-api"]')?.addEventListener('click', () => this._useMainApiConfig());
    this._bindModelCatalog();
    const clearCatalog = () => {
      if (!this._modelCatalog.models.length) return;
      this._modelCatalog = { models: [], imageModels: [] };
      this._modelSearch = '';
      this._renderModelCatalog();
    };
    root?.querySelector('[name="openai.apiUrl"]')?.addEventListener('input', clearCatalog);
    root?.querySelector('[name="openai.apiKey"]')?.addEventListener('input', clearCatalog);
    root?.querySelector('[name="openai.apiKeyHeader"]')?.addEventListener('change', clearCatalog);
    root?.querySelector('[data-action="gallery"]')?.addEventListener('click', () => openImageGallery({ controller: this._controller }));
    root?.querySelector('[data-action="worldbook-scope"]')?.addEventListener('change', (event) => {
      this._settings = this._collectSettings(); this._captureWorldbook(); this._worldbookScope = event.target.value; this.render();
    });
    root?.querySelector('[data-action="worldbook-add"]')?.addEventListener('click', () => {
      this._settings = this._collectSettings(); this._captureWorldbook();
      this._worldbook[this._worldbookScope].push(normalizeImageWorldbookEntry({ name: '新条目', enabled: true }));
      this.render();
      const index = this._worldbook[this._worldbookScope].length - 1;
      const entry = this.shadowRoot?.querySelector(`[data-worldbook-index="${index}"]`);
      entry?.scrollIntoView({ block: 'nearest' });
      entry?.querySelector('[data-wb-field="name"]')?.focus({ preventScroll: true });
    });
    root?.querySelectorAll('[data-action="worldbook-delete"]').forEach(button => button.addEventListener('click', () => {
      this._settings = this._collectSettings(); this._captureWorldbook();
      const index = Number(button.dataset.index);
      const entries = this._worldbook[this._worldbookScope];
      entries.splice(index, 1);
      this.render();
      const neighborIndex = Math.min(index, entries.length - 1);
      const neighbor = this.shadowRoot?.querySelector(`[data-worldbook-index="${neighborIndex}"]`);
      neighbor?.scrollIntoView({ block: 'nearest' });
      neighbor?.querySelector('[data-wb-field="name"]')?.focus({ preventScroll: true });
    }));
    root?.querySelector('[data-action="worldbook-import"]')?.addEventListener('click', () => root.querySelector('[data-worldbook-file]')?.click());
    root?.querySelector('[data-worldbook-file]')?.addEventListener('change', (event) => this._importWorldbook(event.target.files?.[0]));
    root?.querySelector('[data-action="worldbook-export-native"]')?.addEventListener('click', () => {
      this._captureWorldbook(); downloadJSON(this._worldbook, 'naruto-image-worldbook.json');
    });
    root?.querySelector('[data-action="worldbook-export-st"]')?.addEventListener('click', () => {
      this._captureWorldbook(); downloadJSON(toSillyTavernImageWorldbook(this._worldbook, { scope: this._worldbookScope }), 'naruto-image-worldbook-sillytavern.json');
    });
  }
}

class ImageTargetElement extends ImageStudioElement {
  constructor() {
    super();
    this._target = null;
    this._targetState = { binding: null, assets: [], jobs: [] };
    this._assetUrls = new Map();
    this._loading = true;
    this._busy = false;
    this._error = '';
    this.contract = null;
    this.prompt = '';
    this.negativePrompt = '';
    this.mode = 'manual';
  }

  set target(value) {
    this._target = value ? { ...value } : null;
    if (this.isConnected) this.refresh();
  }
  get target() { return this._target; }

  connectedCallback() {
    super.connectedCallback();
    this.render();
    this.refresh();
  }

  _onStudioEvent(event) {
    if (eventTouchesImageTarget(event, this._target)) this._scheduleRefresh();
  }

  async refresh() {
    if (!this._controller.available || !this._target) {
      this._loading = false;
      this.render();
      return;
    }
    try {
      const targetState = await this._controller.target(this._target);
      this._releaseObjectUrls();
      this._assetUrls = await this._assetUrlMap(targetState.assets, 'thumbnail');
      this._targetState = targetState;
      this._error = '';
    } catch (error) {
      this._error = error?.message || '无法读取图片状态';
    } finally {
      this._loading = false;
      this._busy = false;
      this.render();
    }
  }

  get _activeJob() {
    return [...this._targetState.jobs].reverse().find(job => WORKING_JOB_STATES.has(job?.state)) || null;
  }

  get _failedJob() {
    return [...this._targetState.jobs].reverse().find(job => ['failed', 'interrupted', 'blocked'].includes(job?.state)) || null;
  }

  get _selectedAsset() {
    const selectedId = bindingAssetId(this._targetState.binding);
    if (this._targetState.binding && !selectedId) return null;
    return this._targetState.assets.find(asset => assetId(asset) === selectedId)
      || this._targetState.binding?.asset
      || this._targetState.assets[0]
      || null;
  }

  async _run(command) {
    if (this._busy || !this._controller.available) return null;
    this._busy = true;
    this._error = '';
    this.render();
    try {
      const result = await this._controller.execute(command);
      await this.refresh();
      return result;
    } catch (error) {
      this._busy = false;
      this._error = error?.message || '操作失败，请稍后重试';
      this.render();
      return null;
    }
  }

  _generate(extra = {}) {
    return this._run({
      type: 'generate', target: this._target, mode: this.mode || 'manual',
      contract: this.contract || undefined, prompt: this.prompt || undefined,
      negativePrompt: this.negativePrompt || undefined,
      bindingRevision: bindingRevision(this._targetState.binding), ...extra
    });
  }

  _cancel() {
    if (!this._activeJob?.id) return null;
    return this._run({ type: 'cancel', jobId: this._activeJob.id });
  }

  _retry() {
    if (!this._failedJob?.id) return null;
    return this._run({ type: 'retry', jobId: this._failedJob.id });
  }

  _select(selectedAssetId) {
    if (!selectedAssetId) return null;
    return this._run({
      type: 'select', target: this._target, assetId: selectedAssetId,
      expectedRevision: bindingRevision(this._targetState.binding)
    });
  }

  async _download(asset = this._selectedAsset) {
    if (!asset) return;
    try {
      const url = safeMediaUrl(await this._controller.assetUrl(asset, 'content'));
      if (!url) throw new Error('图片内容暂不可用');
      const link = document.createElement('a');
      link.href = url;
      link.download = asset.filename || `naruto-${assetId(asset) || 'image'}.png`;
      link.rel = 'noopener';
      link.click();
      if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      this._error = error?.message || '下载失败';
      this.render();
    }
  }

  _openGallery() { return openImageGallery({ controller: this._controller, target: this._target }); }

  _versionsHtml() {
    const assets = this._targetState.assets;
    if (assets.length < 2) return '';
    const selectedId = bindingAssetId(this._targetState.binding) || assetId(this._selectedAsset);
    return `<div class="is-versions" aria-label="图片版本">${assets.map((asset, index) => {
      const id = assetId(asset);
      const url = this._assetUrls.get(id);
      return `<button class="is-version" type="button" data-action="select" data-asset-id="${attr(id)}" aria-label="选择版本 ${index + 1}" aria-pressed="${id === selectedId}">${url ? `<img src="${attr(url)}" alt="版本 ${index + 1}" loading="lazy">` : `<span>${index + 1}</span>`}</button>`;
    }).join('')}</div>`;
  }

  _bindTargetActions() {
    const root = this.shadowRoot;
    root?.querySelector('[data-action="generate"]')?.addEventListener('click', () => this._generate());
    root?.querySelector('[data-action="reroll"]')?.addEventListener('click', () => this._generate({ reroll: true }));
    root?.querySelector('[data-action="cancel"]')?.addEventListener('click', () => this._cancel());
    root?.querySelector('[data-action="retry"]')?.addEventListener('click', () => this._retry());
    root?.querySelector('[data-action="gallery"]')?.addEventListener('click', () => this._openGallery());
    root?.querySelectorAll('[data-action="download"]').forEach(button => button.addEventListener('click', () => this._download()));
    root?.querySelectorAll('[data-action="select"]').forEach(button => button.addEventListener('click', () => this._select(button.dataset.assetId)));
  }
}

export class ImageTurnIllustration extends ImageTargetElement {
  static get observedAttributes() { return ['node-id']; }

  attributeChangedCallback(name, oldValue, value) {
    if (name === 'node-id' && value !== oldValue) this.target = value ? { kind: 'turn', nodeId: value } : null;
  }

  connectedCallback() {
    if (!this._target && this.getAttribute?.('node-id')) this._target = { kind: 'turn', nodeId: this.getAttribute('node-id') };
    super.connectedCallback();
  }

  render(viewState = this._captureViewState()) {
    if (!this.shadowRoot) return;
    const active = this._activeJob;
    const failed = this._failedJob;
    const selected = this._selectedAsset;
    const selectedUrl = selected ? this._assetUrls.get(assetId(selected)) : '';
    const working = Boolean(active || this._busy);
    const state = working ? 'working' : this._error || failed ? 'error' : selected ? 'success' : '';
    const stateLabel = this._busy && !active ? '正在提交任务' : active
      ? JOB_STATE_LABELS[active.state] || active.state
      : this._error || failed?.error?.message || failed?.error || (selected ? '本回插图已就绪' : '可为本回合生成一张场景插图');
    const unavailable = !this._controller.available;
    this.shadowRoot.innerHTML = `<style>${imageStudioStyles}</style>
      <div class="is-card is-turn">
        ${selectedUrl ? `<div class="is-preview"><img src="${attr(selectedUrl)}" alt="本回合生成插图" loading="lazy"><div class="is-preview-tools"><button class="is-btn is-btn--small" type="button" data-action="download">下载</button><button class="is-btn is-btn--small" type="button" data-action="gallery">图库</button></div></div>` : ''}
        ${this._versionsHtml()}
        <div class="is-turn-main">
          <div class="is-turn-copy"><div class="is-turn-title"><span class="is-dot" data-state="${state}"></span>回合插图</div><div class="is-turn-detail" title="${attr(stateLabel)}">${esc(unavailable ? '文生图尚未配置' : this._loading ? '正在读取图片状态…' : stateLabel)}</div></div>
          <div class="is-actions">
            ${working ? `<button class="is-btn is-btn--danger" type="button" data-action="cancel" ${!active?.id ? 'disabled' : ''}>取消</button>` : selected ? `<button class="is-btn" type="button" data-action="reroll" ${unavailable ? 'disabled' : ''}>重新绘制</button>` : `<button class="is-btn is-btn--primary" type="button" data-action="generate" ${unavailable || !this._target ? 'disabled' : ''}>生成本回插图</button>`}
            ${failed && !working ? '<button class="is-btn" type="button" data-action="retry">重试</button>' : ''}
            <button class="is-btn" type="button" data-action="gallery" ${unavailable ? 'disabled' : ''}>图库</button>
          </div>
        </div>
      </div>`;
    this._bindTargetActions();
    this._restoreViewState(viewState);
  }
}

export class ImagePortraitControls extends ImageTargetElement {
  static get observedAttributes() { return ['subject-id', 'subject-name']; }

  constructor() {
    super();
    this.subjectName = '';
    this._profile = { appearance: '', outfit: '', style: '', negativePrompt: '', lockedTraits: [] };
    this._profileDraft = null;
    this.onProfileChange = null;
  }

  set profile(value) {
    const source = value && typeof value === 'object' ? value : {};
    this._profile = {
      ...this._profile, ...source,
      lockedTraits: Array.isArray(source.lockedTraits)
        ? source.lockedTraits.map(String)
        : String(source.lockedTraits || '').split(/[,，\n]/).map(item => item.trim()).filter(Boolean)
    };
    this._profileDraft = null;
    if (this.isConnected) this.render();
  }
  get profile() { return { ...this._profile, lockedTraits: [...this._profile.lockedTraits] }; }

  attributeChangedCallback(name, oldValue, value) {
    if (value === oldValue) return;
    if (name === 'subject-id') this.target = value ? { kind: 'portrait', subjectId: value } : null;
    if (name === 'subject-name') { this.subjectName = value || ''; if (this.isConnected) this.render(); }
  }

  connectedCallback() {
    if (!this._target && this.getAttribute?.('subject-id')) this._target = { kind: 'portrait', subjectId: this.getAttribute('subject-id') };
    if (!this.subjectName) this.subjectName = this.getAttribute?.('subject-name') || '';
    super.connectedCallback();
  }

  _collectProfile() {
    const root = this.shadowRoot;
    const field = (name) => root?.querySelector(`[name="profile.${name}"]`)?.value ?? '';
    return {
      ...this._profile,
      appearance: field('appearance').trim(), outfit: field('outfit').trim(), style: field('style').trim(),
      negativePrompt: field('negativePrompt').trim(),
      lockedTraits: field('lockedTraits').split(/[,，\n]/).map(item => item.trim()).filter(Boolean)
    };
  }

  _captureProfileDraft() {
    const root = this.shadowRoot;
    const field = (name) => root?.querySelector(`[name="profile.${name}"]`)?.value;
    if (field('appearance') == null) return;
    this._profileDraft = {
      appearance: field('appearance'), outfit: field('outfit'), style: field('style'),
      lockedTraits: field('lockedTraits'), negativePrompt: field('negativePrompt')
    };
  }

  _bindProfileDraft() {
    this.shadowRoot?.querySelectorAll('[name^="profile."]').forEach(field => {
      field.addEventListener('input', () => this._captureProfileDraft());
    });
  }

  _saveProfile() {
    this._profile = this._collectProfile();
    this._profileDraft = null;
    const detail = { target: this._target, profile: this.profile };
    this.dispatchEvent(new CustomEvent('image-profile-change', { detail, bubbles: true, composed: true }));
    if (typeof this.onProfileChange === 'function') this.onProfileChange(detail.profile, detail.target);
    const status = this.shadowRoot?.querySelector('.is-status');
    if (status) { status.textContent = '视觉档案已更新。'; status.dataset.tone = 'success'; }
  }

  _generatePortrait(reroll = false) {
    this._profile = this._collectProfile();
    this._profileDraft = null;
    return this._generate({ reroll, profile: this.profile });
  }

  render(viewState = this._captureViewState()) {
    if (!this.shadowRoot) return;
    const active = this._activeJob;
    const failed = this._failedJob;
    const selected = this._selectedAsset;
    const selectedUrl = selected ? this._assetUrls.get(assetId(selected)) : '';
    const working = Boolean(active || this._busy);
    const unavailable = !this._controller.available;
    const label = this._busy && !active ? '正在提交任务' : active
      ? JOB_STATE_LABELS[active.state] || active.state
      : this._error || failed?.error?.message || failed?.error || (selected ? '已选用此肖像' : '尚未生成人物肖像');
    const p = this._profile;
    const draft = this._profileDraft;
    this.shadowRoot.innerHTML = `<style>${imageStudioStyles}</style>
      <div class="is-card is-section">
        <div class="is-portrait">
          <div>
            <div class="is-portrait-visual">${selectedUrl ? `<img src="${attr(selectedUrl)}" alt="${attr(this.subjectName || '人物')}的生成肖像">` : `<div class="is-portrait-letter">${esc((this.subjectName || '?').slice(0, 1))}</div>`}<span class="is-portrait-badge">${selectedUrl ? '生成肖像' : '文字头像'}</span></div>
            ${this._targetState.assets.length > 1 ? this._versionsHtml() : ''}
          </div>
          <div class="is-portrait-copy">
            <h4>${esc(this.subjectName || '人物肖像')}</h4>
            <p class="is-note">固定视觉特征和角色专属 seed，重绘时保留人物一致性。</p>
            <div class="is-actions" style="margin-top:12px;">
              ${working ? `<button class="is-btn is-btn--danger" type="button" data-action="cancel" ${!active?.id ? 'disabled' : ''}>取消</button>` : `<button class="is-btn is-btn--primary" type="button" data-action="portrait-generate" ${unavailable || !this._target ? 'disabled' : ''}>${selected ? '重新绘制' : '生成肖像'}</button>`}
              ${failed && !working ? '<button class="is-btn" type="button" data-action="retry">重试</button>' : ''}
              ${selected ? '<button class="is-btn" type="button" data-action="download">下载</button>' : ''}
              <button class="is-btn" type="button" data-action="gallery" ${unavailable ? 'disabled' : ''}>人物图库</button>
            </div>
            <div class="is-status" data-tone="${this._error || failed ? 'error' : working ? 'working' : selected ? 'success' : ''}" role="status">${esc(unavailable ? '文生图尚未配置' : this._loading ? '正在读取肖像状态…' : label)}</div>
            <details class="is-profile">
              <summary>编辑视觉档案与锁定特征</summary>
              <div class="is-grid">
                <label>外貌</label><textarea name="profile.appearance" placeholder="发色、瞳色、年龄感、伤痕等">${esc(draft?.appearance ?? p.appearance)}</textarea>
                <label>常用服装</label><textarea name="profile.outfit" placeholder="服装、护额、武器与配饰">${esc(draft?.outfit ?? p.outfit)}</textarea>
                <label>画面风格</label><input type="text" name="profile.style" value="${attr(draft?.style ?? p.style)}" placeholder="动漫设定稿、电影感等">
                <label>锁定特征</label><textarea name="profile.lockedTraits" placeholder="逗号分隔；例如 银发, 左眼伤疤">${esc(draft?.lockedTraits ?? p.lockedTraits.join(', '))}</textarea>
                <label>负向提示</label><textarea name="profile.negativePrompt" placeholder="该角色专属排除项">${esc(draft?.negativePrompt ?? p.negativePrompt)}</textarea>
                <span></span><button class="is-btn" type="button" data-action="profile-save">保存视觉档案</button>
              </div>
            </details>
          </div>
        </div>
      </div>`;
    this._bindTargetActions();
    this._bindProfileDraft();
    this.shadowRoot.querySelector('[data-action="portrait-generate"]')?.addEventListener('click', () => this._generatePortrait(Boolean(selected)));
    this.shadowRoot.querySelector('[data-action="profile-save"]')?.addEventListener('click', () => this._saveProfile());
    this._restoreViewState(viewState);
  }
}

export class ImageGalleryModal extends ImageStudioElement {
  constructor() {
    super();
    this._target = null;
    this.filters = {};
    this._items = [];
    this._total = 0;
    this._limit = 40;
    this._quota = { usedBytes: 0, limitBytes: 1024 ** 3, assetCount: 0, assetLimit: 500 };
    this._binding = null;
    this._assetUrls = new Map();
    this._loading = true;
    this._message = '';
    this._tone = '';
    this._busyAssetId = '';
    this._pendingDeleteId = '';
  }

  set target(value) { this._target = value ? { ...value } : null; if (this.isConnected) this.refresh(); }
  get target() { return this._target; }

  connectedCallback() {
    super.connectedCallback();
    this.classList?.add('is-gallery-host');
    this._onKeyDown = (event) => { if (event.key === 'Escape') this.close(); };
    document.addEventListener('keydown', this._onKeyDown);
    this.render();
    this.refresh();
  }

  disconnectedCallback() {
    document.removeEventListener('keydown', this._onKeyDown);
    super.disconnectedCallback();
  }

  close() {
    this.dispatchEvent(new CustomEvent('image-gallery-close', { bubbles: true, composed: true }));
    this.remove();
  }

  _onStudioEvent(event) {
    if (this._busyAssetId) return;
    if (/asset|gallery|binding|job|quota|select|protect|delete/i.test(String(event?.type || ''))) this._scheduleRefresh(90);
  }

  _captureFilters() {
    const root = this.shadowRoot;
    if (!root) return;
    const value = (name) => root.querySelector(`[name="filter.${name}"]`)?.value.trim() || '';
    this.filters = {
      campaignId: value('campaign'), turnNodeId: value('turn'), subjectId: value('character')
    };
  }

  async refresh({ append = false, viewState = null } = {}) {
    if (!this._controller.available) {
      this._loading = false;
      this._message = '文生图服务尚未初始化。';
      this._tone = 'error';
      this.render();
      return;
    }
    const preservedViewState = viewState || this._captureViewState();
    const galleryBody = this.shadowRoot?.querySelector('.is-gallery-body');
    const preservedScrollTop = append ? galleryBody?.scrollTop ?? 0 : null;
    this._loading = true;
    if (append) {
      this.shadowRoot?.querySelector('.is-gallery-dialog')?.setAttribute('aria-busy', 'true');
      const moreButton = this.shadowRoot?.querySelector('[data-action="more"]');
      if (moreButton) moreButton.disabled = true;
    } else {
      this.render(preservedViewState);
    }
    try {
      const filters = { ...this.filters };
      if (this._target?.kind === 'turn') filters.turnNodeId = String(this._target.nodeId);
      if (this._target?.kind === 'portrait') filters.subjectId = String(this._target.subjectId);
      const offset = append ? this._items.length : 0;
      const requests = [this._controller.gallery(filters, offset, this._limit), this._controller.quota()];
      if (this._target) requests.push(this._controller.target(this._target));
      const [gallery, quota, targetState] = await Promise.all(requests);
      this._releaseObjectUrls();
      if (append) {
        const knownIds = new Set(this._items.map(assetId));
        this._items = [...this._items, ...gallery.items.filter(asset => !knownIds.has(assetId(asset)))];
      } else {
        this._items = gallery.items;
      }
      this._total = gallery.total;
      this._quota = quota;
      this._binding = targetState?.binding || null;
      this._assetUrls = await this._assetUrlMap(this._items, 'thumbnail');
      this._message = '';
      this._tone = '';
    } catch (error) {
      this._message = error?.message || '图库读取失败';
      this._tone = 'error';
    } finally {
      this._loading = false;
      this._busyAssetId = '';
      this.render(preservedViewState);
      if (preservedScrollTop != null) {
        const body = this.shadowRoot?.querySelector('.is-gallery-body');
        if (body) {
          const restoreScroll = () => { body.scrollTop = preservedScrollTop; };
          restoreScroll();
          globalThis.requestAnimationFrame?.(restoreScroll);
        }
      }
    }
  }

  async _executeAsset(command, id = '') {
    if (this._busyAssetId) return;
    const viewState = this._captureViewState();
    const previousIndex = command.type === 'delete'
      ? this._items.findIndex(asset => assetId(asset) === id)
      : -1;
    this._busyAssetId = id;
    this._message = '正在更新图库…';
    this._tone = 'working';
    this.render(viewState);
    try {
      await this._controller.execute(command);
      this._pendingDeleteId = '';
      await this.refresh({ viewState });
      if (command.type === 'delete' && previousIndex >= 0) {
        const neighbor = this._items[Math.min(previousIndex, this._items.length - 1)];
        const neighborId = assetId(neighbor);
        const action = [...(this.shadowRoot?.querySelectorAll('[data-action="asset-delete"]') || [])]
          .find(button => button.dataset.assetId === neighborId);
        action?.closest('.is-asset')?.scrollIntoView({ block: 'nearest' });
        action?.focus({ preventScroll: true });
      }
    } catch (error) {
      this._busyAssetId = '';
      this._message = error?.message || '图库操作失败';
      this._tone = 'error';
      this.render(viewState);
    }
  }

  _select(asset) {
    const target = this._target || asset?.target;
    if (!target) {
      this._message = '请从回合插图或人物档案打开图库，再选择版本。';
      this._tone = 'error';
      this.render();
      return;
    }
    return this._executeAsset({
      type: 'select', target, assetId: assetId(asset),
      expectedRevision: targetsEqual(target, this._target) ? bindingRevision(this._binding) : undefined
    }, assetId(asset));
  }

  _protect(asset) {
    const protectedValue = Boolean(asset.protected ?? asset.isProtected);
    return this._executeAsset({ type: 'protect', assetId: assetId(asset), protected: !protectedValue }, assetId(asset));
  }

  _delete(asset) {
    const id = assetId(asset);
    if (this._pendingDeleteId !== id) {
      this._pendingDeleteId = id;
      this._message = '删除会移除此图片版本；再次点击“确认删除”继续。';
      this._tone = 'error';
      this.render();
      return;
    }
    return this._executeAsset({ type: 'delete', assetId: id }, id);
  }

  async _download(asset) {
    try {
      const url = safeMediaUrl(await this._controller.assetUrl(asset, 'content'));
      if (!url) throw new Error('图片内容暂不可用');
      const link = document.createElement('a');
      link.href = url;
      link.download = asset.filename || `naruto-${assetId(asset) || 'image'}.png`;
      link.rel = 'noopener';
      link.click();
      if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      this._message = error?.message || '下载失败'; this._tone = 'error'; this.render();
    }
  }

  _quotaLabel() {
    return `${formatImageBytes(this._quota.usedBytes)} / ${formatImageBytes(this._quota.limitBytes)} · ${this._quota.assetCount} / ${this._quota.assetLimit} 张`;
  }

  _assetHtml(asset, index) {
    const id = assetId(asset);
    const url = this._assetUrls.get(id);
    const isProtected = Boolean(asset.protected ?? asset.isProtected);
    const selected = bindingAssetId(this._binding) === id || Boolean(asset.selected && !this._target);
    const title = asset.title || asset.characterName || asset.subjectName || asset.promptSummary || `图片 ${index + 1}`;
    const detail = [asset.campaignName || asset.campaignId, asset.turnNumber ? `第 ${asset.turnNumber} 回合` : '', dateLabel(asset.createdAt)].filter(Boolean).join(' · ');
    const canSelect = Boolean(this._target && targetsEqual(this._target, asset.target));
    const deleting = this._pendingDeleteId === id;
    const busy = this._busyAssetId === id;
    return `<article class="is-asset" aria-current="${selected}">
      <div class="is-asset-image">${url ? `<img src="${attr(url)}" alt="${attr(title)}" loading="lazy">` : '<div class="is-empty" style="border:0;height:100%;display:grid;place-items:center;">预览不可用</div>'}${isProtected ? '<span class="is-asset-protected">已保护</span>' : ''}</div>
      <div class="is-asset-info">
        <div class="is-asset-title" title="${attr(title)}">${esc(title)}</div>
        <div class="is-asset-meta">${esc(detail || asset.providerId || '')}</div>
        <div class="is-asset-actions">
          ${canSelect ? `<button class="is-btn is-btn--small ${selected ? '' : 'is-btn--primary'}" type="button" data-action="asset-select" data-asset-id="${attr(id)}" ${busy || selected ? 'disabled' : ''}>${selected ? '已选用' : '选用'}</button>` : ''}
          <button class="is-btn is-btn--small" type="button" data-action="asset-download" data-asset-id="${attr(id)}" ${busy ? 'disabled' : ''}>下载</button>
          <button class="is-btn is-btn--small" type="button" data-action="asset-protect" data-asset-id="${attr(id)}" ${busy ? 'disabled' : ''}>${isProtected ? '取消保护' : '保护'}</button>
          <button class="is-btn is-btn--small is-btn--danger" type="button" data-action="asset-delete" data-asset-id="${attr(id)}" ${busy || isProtected || selected ? 'disabled' : ''}>${deleting ? '确认删除' : '删除'}</button>
        </div>
      </div>
    </article>`;
  }

  render(viewState = this._captureViewState()) {
    if (!this.shadowRoot) return;
    const f = this.filters || {};
    this.shadowRoot.innerHTML = `<style>${imageStudioStyles}</style>
      <div class="is-gallery-backdrop" data-action="close-backdrop">
        <section class="is-gallery-dialog" role="dialog" aria-modal="true" aria-label="画面图库" aria-busy="${this._loading}">
          <header class="is-gallery-head"><div><p class="is-eyebrow">IMAGE ARCHIVE</p><h2>画面图库</h2><p class="is-note">保留每次生成版本，手动选择、保护或删除。</p></div><button class="is-close" type="button" data-action="close" aria-label="关闭">×</button></header>
          <div class="is-gallery-filters">
            <input type="text" name="filter.campaign" value="${attr(f.campaignId)}" placeholder="筛选存档 / 战役 ID">
            <input type="text" name="filter.turn" value="${attr(f.turnNodeId)}" placeholder="筛选回合 / 节点 ID" ${this._target?.kind === 'turn' ? 'disabled' : ''}>
            <input type="text" name="filter.character" value="${attr(f.subjectId)}" placeholder="筛选人物 Subject ID" ${this._target?.kind === 'portrait' ? 'disabled' : ''}>
            <button class="is-btn" type="button" data-action="filter">筛选</button>
          </div>
          <main class="is-gallery-body">
            ${this._loading && !this._items.length ? '<div class="is-empty">正在读取图库…</div>' : this._items.length ? `<div class="is-gallery-grid">${this._items.map((asset, index) => this._assetHtml(asset, index)).join('')}</div>` : '<div class="is-empty">图库中还没有生成图片</div>'}
          </main>
          <footer class="is-gallery-foot"><div><div class="is-note">${esc(this._quotaLabel())}</div><div class="is-status" data-tone="${attr(this._tone)}" role="status">${esc(this._message)}</div></div><div class="is-actions">${this._items.length < this._total ? `<button class="is-btn" type="button" data-action="more">加载更多（${this._items.length}/${this._total}）</button>` : `<span class="is-note">共 ${this._total} 张</span>`}</div></footer>
        </section>
      </div>`;
    this._bindGallery();
    this._restoreViewState(viewState);
  }

  _findAsset(id) { return this._items.find(asset => assetId(asset) === String(id)); }

  _bindGallery() {
    const root = this.shadowRoot;
    root?.querySelector('[data-action="close"]')?.addEventListener('click', () => this.close());
    root?.querySelector('[data-action="close-backdrop"]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) this.close();
    });
    root?.querySelector('[data-action="filter"]')?.addEventListener('click', () => {
      this._captureFilters(); this._limit = 40; this.refresh();
    });
    root?.querySelectorAll('[name^="filter."]').forEach(input => input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { this._captureFilters(); this._limit = 40; this.refresh(); }
    }));
    root?.querySelector('[data-action="more"]')?.addEventListener('click', () => {
      this._captureFilters(); this.refresh({ append: true });
    });
    root?.querySelectorAll('[data-asset-id]').forEach(button => button.addEventListener('click', () => {
      const asset = this._findAsset(button.dataset.assetId);
      if (!asset) return;
      if (button.dataset.action === 'asset-select') this._select(asset);
      else if (button.dataset.action === 'asset-download') this._download(asset);
      else if (button.dataset.action === 'asset-protect') this._protect(asset);
      else if (button.dataset.action === 'asset-delete') this._delete(asset);
    }));
  }
}

export function registerImageStudioElements() {
  if (!globalThis.customElements) return;
  const definitions = [
    ['image-studio-settings', ImageStudioSettings],
    ['image-turn-illustration', ImageTurnIllustration],
    ['image-portrait-controls', ImagePortraitControls],
    ['image-gallery-modal', ImageGalleryModal]
  ];
  for (const [name, constructor] of definitions) {
    if (!customElements.get(name)) customElements.define(name, constructor);
  }
}

export function mountImageStudioSettings(container, options = {}) {
  const mount = resolveContainer(container);
  if (!mount) throw new Error('找不到文生图设置挂载容器');
  const element = setElementController(document.createElement('image-studio-settings'), options);
  mount.appendChild(element);
  return element;
}

export function mountTurnIllustration(container, options = {}) {
  const mount = resolveContainer(container);
  if (!mount) throw new Error('找不到回合插图挂载容器');
  const element = setElementController(document.createElement('image-turn-illustration'), options);
  element.target = options.target || (options.nodeId != null ? { kind: 'turn', nodeId: options.nodeId } : null);
  element.contract = options.contract || null;
  element.prompt = options.prompt || '';
  element.negativePrompt = options.negativePrompt || '';
  element.mode = options.mode || 'manual';
  mount.appendChild(element);
  return element;
}

export function mountPortraitImageControls(container, options = {}) {
  const mount = resolveContainer(container);
  if (!mount) throw new Error('找不到人物肖像挂载容器');
  const element = setElementController(document.createElement('image-portrait-controls'), options);
  element.target = options.target || (options.subjectId != null ? { kind: 'portrait', subjectId: options.subjectId } : null);
  element.subjectName = options.name || options.subjectName || '';
  element.profile = options.profile || {};
  element.onProfileChange = options.onProfileChange || null;
  mount.appendChild(element);
  return element;
}

export function openImageGallery(options = {}) {
  const element = setElementController(document.createElement('image-gallery-modal'), options);
  element.target = options.target || null;
  element.filters = { ...(options.filters || {}) };
  const mount = resolveContainer(options.mount) || document.getElementById('app') || document.body;
  mount.appendChild(element);
  return element;
}

registerImageStudioElements();

export default {
  mountImageStudioSettings,
  mountTurnIllustration,
  mountPortraitImageControls,
  openImageGallery,
  registerImageStudioElements
};
