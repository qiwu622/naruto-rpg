import { eventBus } from '../core/event-bus.js';
import { DEFAULT_MAIN_PRESET, DEFAULT_MAIN_PRESET_VERSION, PRESET_ACTIVATIONS, getMainPreset, invalidateMainPresetCache } from '../data/default-preset.js';
import { compileMainPresetImport, summarizeMainPresetImport } from '../data/main-preset-import.js';
import { escHtml, escAttr } from '../utils/format.js';
import GameModal from './modal.js';
import { bindCustomSelects } from './custom-select.js';

class MainPresetEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._preset = null;
    this._expandedIdx = -1;
    this._editingNameIdx = -1;
  }

  connectedCallback() {
    this._load();
    this._render();
  }

  _load() {
    this._preset = JSON.parse(JSON.stringify(getMainPreset()));
  }

  _save(message = '主预设已保存') {
    try {
      localStorage.setItem('naruto_main_preset', JSON.stringify(this._preset));
      invalidateMainPresetCache();
      eventBus.emit('app:toast', message);
      return true;
    } catch (e) {
      eventBus.emit('app:toast', '保存失败: ' + e.message);
      return false;
    }
  }

  _render() {
    const entries = this._preset.entries || [];
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: flex; position: fixed; inset: 0; background: rgba(7,10,14,0.95); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); z-index: calc(var(--z-fullscreen) + 1); font-family: 'Noto Sans SC',system-ui,sans-serif; color: #e8e4d9; justify-content: center; align-items: center; padding: 20px; }
        :host([embedded]) { position: relative; inset: auto; z-index: auto; width: 100%; height: 100%; padding: 0; background: transparent; backdrop-filter: none; -webkit-backdrop-filter: none; }
        :host([embedded]) .mpe-container { max-width: none; max-height: none; border: 0; border-radius: 0; }
        .mpe-container { width: 100%; max-width: 1000px; height: 100%; max-height: 85vh; background: #111418; border: 1px solid rgba(198,156,109,0.2); border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; }
        .mpe-header { padding: 14px 18px; border-bottom: 1px solid rgba(198,156,109,0.15); display: flex; justify-content: space-between; align-items: center; background: rgba(20,25,30,0.8); flex-shrink: 0; }
        .mpe-title { font-size: 16px; font-weight: 700; color: #f4efe4; font-family: 'Noto Serif SC',serif; letter-spacing: 2px; }
        .mpe-actions { display: flex; gap: 8px; flex-wrap: wrap; }
        .btn { padding: 6px 14px; background: rgba(232,228,217,0.05); color: #e8e4d9; border: 1px solid rgba(232,228,217,0.15); border-radius: 6px; cursor: pointer; font-size: 13px; transition: all 0.2s; white-space: nowrap; }
        .btn:hover { background: rgba(232,228,217,0.1); border-color: rgba(198,156,109,0.5); }
        .btn.primary { background: #eb613f; border-color: #eb613f; color: #fff; font-weight: bold; }
        .btn.primary:hover { background: #d65130; }
        .btn.danger { border-color: #ef5350; color: #ef5350; }
        .btn.danger:hover { background: rgba(239,83,80,0.1); }
        .btn.sm { padding: 3px 8px; font-size: 11px; }
        .btn.ghost { background: transparent; border-color: transparent; color: #a39f98; }
        .btn.ghost:hover { color: #eb613f; }
        .mpe-bar { padding: 10px 14px; border-bottom: 1px solid rgba(232,228,217,0.05); display: flex; gap: 8px; align-items: center; flex-shrink: 0; background: rgba(0,0,0,0.15); flex-wrap: wrap; }
        .mpe-name-input { flex: 1; min-width: 120px; padding: 6px 10px; background: #070a0e; border: 1px solid rgba(198,156,109,0.3); border-radius: 4px; color: #e8e4d9; font-size: 13px; outline: none; }
        .mpe-name-input:focus { border-color: #eb613f; }
        .mpe-body { flex: 1; overflow-y: auto; overflow-anchor: none; padding: 8px 14px; }
        .mpe-body::-webkit-scrollbar { width: 6px; }
        .mpe-body::-webkit-scrollbar-thumb { background: rgba(232,228,217,0.2); border-radius: 3px; }
        .mpe-item { margin-bottom: 0; border-bottom: 1px solid rgba(255,255,255,0.03); overflow: hidden; transition: background 0.2s; border-left: 2px solid transparent; }
        .mpe-item:hover { background: rgba(255,255,255,0.02); }
        .mpe-item.expanded { background: rgba(0,0,0,0.2); border-left-color: #eb613f; }
        .mpe-item-header { display: flex; align-items: center; gap: 8px; padding: 12px; cursor: pointer; user-select: none; transition: background 0.2s; }
        .mpe-item-header:hover { background: rgba(255,255,255,0.02); }
        .mpe-toggle { width: 34px; height: 18px; border-radius: 9px; background: rgba(255,255,255,0.1); position: relative; cursor: pointer; transition: 0.3s; border: none; flex-shrink: 0; }
        .mpe-toggle.on { background: rgba(235,97,63,0.3); }
        .mpe-toggle.on::after { left: 17px; background: #eb613f; }
        .mpe-toggle::after { content: ''; position: absolute; width: 12px; height: 12px; border-radius: 50%; top: 3px; left: 3px; background: #a39f98; transition: 0.3s; }
        .mpe-item-name { flex: 1; font-size: 13px; font-weight: 500; color: #e8e4d9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mpe-item-name.disabled { color: #6e6a65; text-decoration: line-through; }
        .mpe-item-role { font-size: 10px; color: #a39f98; padding: 2px 6px; border: 1px solid rgba(255,255,255,0.1); border-radius: 3px; flex-shrink: 0; }
        .mpe-item-mode { font-size: 10px; color: #81c784; padding: 2px 6px; border: 1px solid rgba(129,199,132,0.25); border-radius: 3px; flex-shrink: 0; }
        .mpe-item-idx { font-size: 10px; color: #555; width: 24px; text-align: center; flex-shrink: 0; }
        .mpe-item-btns { display: flex; gap: 4px; flex-shrink: 0; opacity: 0; transition: opacity 0.2s; }
        .mpe-item:hover .mpe-item-btns, .mpe-item.expanded .mpe-item-btns { opacity: 1; }
        .mpe-item-body { display: none; padding: 0 12px 16px 44px; }
        .mpe-item.expanded .mpe-item-body { display: block; }
        .mpe-field-row { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; }
        .mpe-field-row label { font-size: 12px; color: #a39f98; width: 50px; flex-shrink: 0; }
        .mpe-field-input { flex: 1; padding: 6px 8px; background: transparent; border: none; border-bottom: 1px solid rgba(255,255,255,0.1); border-radius: 0; color: #e8e4d9; font-size: 13px; outline: none; transition: border-color 0.2s; }
        .mpe-field-input:focus { border-bottom-color: #eb613f; }
        .mpe-field-select { padding: 5px 8px; background: #070a0e; border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; color: #e8e4d9; font-size: 12px; outline: none; }
        .mpe-textarea { width: 100%; box-sizing: border-box; min-height: 100px; background: rgba(0,0,0,0.15); border: 1px solid transparent; border-bottom: 1px solid rgba(255,255,255,0.1); border-radius: 4px 4px 0 0; color: #e8e4d9; font: 13px/1.6 'Noto Sans SC',monospace; padding: 12px; resize: vertical; outline: none; transition: border-color 0.2s; }
        .mpe-textarea:focus { border-bottom-color: #eb613f; }
        .mpe-empty { text-align: center; color: #6e6a65; padding: 60px 20px; font-size: 14px; }
        .mpe-footer { padding: 10px 14px; border-top: 1px solid rgba(198,156,109,0.15); display: flex; justify-content: space-between; align-items: center; flex-shrink: 0; background: rgba(20,25,30,0.8); }
        .mpe-footer-info { font-size: 11px; color: #6e6a65; }
        input[type="file"] { display: none; }
        .drag-over { border-color: #eb613f !important; background: rgba(235,97,63,0.05); }
        @media(max-width:640px){
          :host{padding:0;box-sizing:border-box}
          .mpe-container{max-height:100dvh;border-radius:0;border-left:0;border-right:0}
          .mpe-header{flex-direction:column;align-items:stretch;gap:10px;padding:12px}
          .mpe-actions{width:100%;justify-content:flex-start;gap:6px}
          .mpe-bar{padding:8px;gap:6px}
          .mpe-name-input{flex-basis:100%;min-width:0}
          .mpe-body{padding:6px 8px}
          .mpe-item-header{flex-wrap:wrap;gap:6px;padding:10px 8px}
          .mpe-item-name{flex:1 1 140px;min-width:0}
          .mpe-item-mode,.mpe-item-role{order:1}
          .mpe-item-btns{display:none;order:2;width:100%;justify-content:flex-end;opacity:1}
          .mpe-item.expanded .mpe-item-btns{display:flex}
          .mpe-item-body{padding:0 8px 14px}
          .mpe-field-row{align-items:flex-start}
        }
      </style>
      <div class="mpe-container">
        <div class="mpe-header">
          <span class="mpe-title">主预设编辑器</span>
          <div class="mpe-actions">
            <input type="file" id="mpe-import-file" accept=".json" />
            <button class="btn sm" id="mpe-import">导入JSON</button>
            <button class="btn sm" id="mpe-export">导出</button>
            <button class="btn sm" id="mpe-reset-default">恢复默认</button>
            <button class="btn sm primary" id="mpe-save">保存</button>
            <button class="btn sm" id="mpe-close">关闭</button>
          </div>
        </div>
        <div class="mpe-bar">
          <input class="mpe-name-input" id="mpe-preset-name" value="${this._escAttr(this._preset.name || '')}" placeholder="预设名称" />
          <button class="btn sm" id="mpe-enable-all">全开</button>
          <button class="btn sm" id="mpe-disable-all">全关</button>
          <button class="btn sm" id="mpe-add-entry" style="background:rgba(76,175,80,0.15);border-color:rgba(76,175,80,0.4);color:#81c784;">+ 新增条目</button>
        </div>
        <div class="mpe-body" id="mpe-body">
          ${entries.length === 0 ? '<div class="mpe-empty">尚未导入主预设。点击「导入JSON」或「恢复默认」加载预设。</div>' : ''}
          ${entries.map((entry, idx) => `
            <div class="mpe-item${this._expandedIdx === idx ? ' expanded' : ''}" data-idx="${idx}" draggable="true">
              <div class="mpe-item-header" tabindex="-1">
                <span class="mpe-item-idx">${idx + 1}</span>
                <button class="mpe-toggle${entry.enabled !== false ? ' on' : ''}" data-idx="${idx}" data-action="toggle"></button>
                <span class="mpe-item-name${entry.enabled === false ? ' disabled' : ''}">${this._esc(entry.name || '未命名条目')}</span>
                <span class="mpe-item-mode">${this._esc(PRESET_ACTIVATIONS[entry.activation || 'always'] || PRESET_ACTIVATIONS.always)}</span>
                <span class="mpe-item-role">${this._esc(entry.role || 'system')}</span>
                <div class="mpe-item-btns">
                  <button class="btn ghost sm" data-idx="${idx}" data-action="move-up" title="上移">\u25B2</button>
                  <button class="btn ghost sm" data-idx="${idx}" data-action="move-down" title="下移">\u25BC</button>
                  <button class="btn ghost sm" data-idx="${idx}" data-action="duplicate" title="复制">+</button>
                  <button class="btn ghost sm" data-idx="${idx}" data-action="delete" title="删除" style="color:#ef5350;">\u2716</button>
                </div>
              </div>
              <div class="mpe-item-body">
                <div class="mpe-field-row">
                  <label>名称</label>
                  <input class="mpe-field-input" data-idx="${idx}" data-field="name" value="${this._escAttr(entry.name || '')}" />
                </div>
                <div class="mpe-field-row">
                  <label>角色</label>
                  <select class="mpe-field-select" data-idx="${idx}" data-field="role">
                    <option value="system"${entry.role === 'system' ? ' selected' : ''}>system</option>
                    <option value="assistant"${entry.role === 'assistant' ? ' selected' : ''}>assistant</option>
                    <option value="user"${entry.role === 'user' ? ' selected' : ''}>user</option>
                  </select>
                </div>
                <div class="mpe-field-row">
                  <label>生效</label>
                  <select class="mpe-field-select" data-idx="${idx}" data-field="activation">
                    ${Object.entries(PRESET_ACTIVATIONS).map(([value, label]) => `<option value="${value}"${(entry.activation || 'always') === value ? ' selected' : ''}>${label}</option>`).join('')}
                  </select>
                </div>
                <textarea class="mpe-textarea" data-idx="${idx}" data-field="content" rows="${Math.max(4, Math.min(15, (entry.content || '').split('\\n').length + 1))}">${this._esc(entry.content || '')}</textarea>
              </div>
            </div>
          `).join('')}
        </div>
        <div class="mpe-footer">
          <span class="mpe-footer-info">共 ${entries.length} 条 / 已启用 ${entries.filter(e => e.enabled !== false).length} 条</span>
          <span class="mpe-footer-info">${this._esc(this._preset.name || '未命名')}</span>
        </div>
      </div>
    `;
    this._bindEvents();
    bindCustomSelects(this.shadowRoot);
  }

  _captureViewState() {
    const root = this.shadowRoot;
    const body = root?.querySelector('#mpe-body');
    const active = root?.activeElement;
    const activeItem = active?.closest?.('.mpe-item');
    const activeIndex = Number(activeItem?.dataset.idx);
    let selector = '';
    if (active?.id) selector = `#${active.id}`;
    else if (active?.dataset.action) selector = `[data-action="${active.dataset.action}"]`;
    else if (active?.dataset.field) selector = `[data-field="${active.dataset.field}"]`;

    return {
      scrollTop: body?.scrollTop || 0,
      scrollLeft: body?.scrollLeft || 0,
      active: active && selector ? {
        entry: Number.isInteger(activeIndex) ? this._preset.entries[activeIndex] : null,
        selector,
        selectionStart: typeof active.selectionStart === 'number' ? active.selectionStart : null,
        selectionEnd: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
        scrollTop: active.scrollTop || 0,
        scrollLeft: active.scrollLeft || 0
      } : null
    };
  }

  _renderPreservingView({ state = this._captureViewState(), focusEntry = null, focusSelector = '', reveal = false } = {}) {
    this._render();
    const root = this.shadowRoot;
    const body = root.querySelector('#mpe-body');
    if (body) {
      body.scrollTop = state.scrollTop;
      body.scrollLeft = state.scrollLeft;
    }

    const focusState = focusSelector ? { entry: focusEntry, selector: focusSelector } : state.active;
    let focusTarget = null;
    if (focusState?.entry) {
      const index = this._preset.entries.indexOf(focusState.entry);
      focusTarget = index >= 0
        ? root.querySelector(`.mpe-item[data-idx="${index}"] ${focusState.selector}`)
        : null;
    } else if (focusState?.selector) {
      focusTarget = root.querySelector(focusState.selector);
    }

    if (!focusTarget) return;
    focusTarget.focus({ preventScroll: true });
    if (focusState === state.active) {
      if (focusState.selectionStart !== null && typeof focusTarget.setSelectionRange === 'function') {
        focusTarget.setSelectionRange(focusState.selectionStart, focusState.selectionEnd);
      }
      focusTarget.scrollTop = focusState.scrollTop;
      focusTarget.scrollLeft = focusState.scrollLeft;
    }
    if (reveal) focusTarget.closest('.mpe-item')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  _bindEvents() {
    const root = this.shadowRoot;

    root.querySelector('#mpe-close')?.addEventListener('click', () => this.remove());
    root.querySelector('#mpe-save')?.addEventListener('click', () => {
      this._syncAll();
      if (this._save()) this.remove();
    });

    root.querySelector('#mpe-reset-default')?.addEventListener('click', () => {
      if (confirm('恢复为默认 Narutomech 预设？当前修改将丢失。')) {
        this._preset = JSON.parse(JSON.stringify(DEFAULT_MAIN_PRESET));
        this._preset._version = DEFAULT_MAIN_PRESET_VERSION;
        this._expandedIdx = -1;
        this._render();
      }
    });

    root.querySelector('#mpe-export')?.addEventListener('click', () => {
      this._syncAll();
      const json = JSON.stringify(this._preset, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `main_preset_${Date.now()}.json`; a.click();
      URL.revokeObjectURL(url);
    });

    const fileInput = root.querySelector('#mpe-import-file');
    root.querySelector('#mpe-import')?.addEventListener('click', () => fileInput.click());
    fileInput?.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const raw = JSON.parse(reader.result);
          const imported = compileMainPresetImport(raw, { fileName: file.name });
          const summary = summarizeMainPresetImport(imported);
          this._preset = imported;
          const saved = this._save(
            `预设已导入并启用：${summary.enabledPromptCount}/${summary.promptCount} 条提示词，${summary.enabledRegexCount}/${summary.regexCount} 条正则`
          );
          if (!saved) throw new Error('浏览器存储空间不足，原运行预设未能切换');
          this._expandedIdx = -1;
          this._render();
        } catch (err) { GameModal.alert({ title: '解析失败', message: err.message }); }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    root.querySelector('#mpe-enable-all')?.addEventListener('click', () => {
      const viewState = this._captureViewState();
      this._syncAll();
      (this._preset.entries || []).forEach(e => e.enabled = true);
      this._renderPreservingView({ state: viewState });
    });
    root.querySelector('#mpe-disable-all')?.addEventListener('click', () => {
      const viewState = this._captureViewState();
      this._syncAll();
      (this._preset.entries || []).forEach(e => e.enabled = false);
      this._renderPreservingView({ state: viewState });
    });

    root.querySelector('#mpe-add-entry')?.addEventListener('click', () => {
      const viewState = this._captureViewState();
      this._syncAll();
      const newEntry = {
        id: `custom_${Date.now()}`,
        name: '新条目',
        enabled: true,
        role: 'system',
        activation: 'always',
        content: ''
      };
      this._preset.entries.push(newEntry);
      this._expandedIdx = this._preset.entries.length - 1;
      this._renderPreservingView({
        state: viewState,
        focusEntry: newEntry,
        focusSelector: '[data-field="name"]',
        reveal: true
      });
    });

    root.querySelectorAll('[data-action="toggle"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx);
        const entry = this._preset.entries[idx];
        entry.enabled = !entry.enabled;
        btn.classList.toggle('on', entry.enabled);
        const nameEl = btn.parentElement.querySelector('.mpe-item-name');
        if (nameEl) nameEl.classList.toggle('disabled', !entry.enabled);
      });
    });

    root.querySelectorAll('[data-action="move-up"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx);
        if (idx <= 0) return;
        const viewState = this._captureViewState();
        this._syncAll();
        const movedEntry = this._preset.entries[idx];
        [this._preset.entries[idx - 1], this._preset.entries[idx]] = [this._preset.entries[idx], this._preset.entries[idx - 1]];
        if (this._expandedIdx === idx) this._expandedIdx = idx - 1;
        else if (this._expandedIdx === idx - 1) this._expandedIdx = idx;
        this._renderPreservingView({ state: viewState, focusEntry: movedEntry, focusSelector: '[data-action="move-up"]' });
      });
    });

    root.querySelectorAll('[data-action="move-down"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx);
        if (idx >= this._preset.entries.length - 1) return;
        const viewState = this._captureViewState();
        this._syncAll();
        const movedEntry = this._preset.entries[idx];
        [this._preset.entries[idx], this._preset.entries[idx + 1]] = [this._preset.entries[idx + 1], this._preset.entries[idx]];
        if (this._expandedIdx === idx) this._expandedIdx = idx + 1;
        else if (this._expandedIdx === idx + 1) this._expandedIdx = idx;
        this._renderPreservingView({ state: viewState, focusEntry: movedEntry, focusSelector: '[data-action="move-down"]' });
      });
    });

    root.querySelectorAll('[data-action="duplicate"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx);
        const viewState = this._captureViewState();
        this._syncAll();
        const source = this._preset.entries[idx];
        const clone = { ...JSON.parse(JSON.stringify(source)), id: `custom_${Date.now()}`, name: source.name + ' (副本)' };
        this._preset.entries.splice(idx + 1, 0, clone);
        this._expandedIdx = idx + 1;
        this._renderPreservingView({
          state: viewState,
          focusEntry: clone,
          focusSelector: '[data-field="name"]',
          reveal: true
        });
      });
    });

    root.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx);
        const entry = this._preset.entries[idx];
        const viewState = this._captureViewState();
        if (!confirm(`删除条目「${entry.name}」？`)) return;
        this._syncAll();
        const neighbor = this._preset.entries[idx + 1] || this._preset.entries[idx - 1] || null;
        this._preset.entries.splice(idx, 1);
        if (this._expandedIdx === idx) this._expandedIdx = -1;
        else if (this._expandedIdx > idx) this._expandedIdx--;
        this._renderPreservingView({ state: viewState, focusEntry: neighbor, focusSelector: '.mpe-item-header' });
      });
    });

    root.querySelectorAll('.mpe-item-header').forEach(header => {
      header.addEventListener('click', (e) => {
        if (e.target.closest('[data-action]') || e.target.closest('.mpe-toggle')) return;
        const item = header.closest('.mpe-item');
        const idx = parseInt(item.dataset.idx);
        const body = root.querySelector('#mpe-body');
        const scrollTop = body?.scrollTop || 0;
        this._syncAll();
        const nextExpandedIdx = this._expandedIdx === idx ? -1 : idx;
        root.querySelector('.mpe-item.expanded')?.classList.remove('expanded');
        this._expandedIdx = nextExpandedIdx;
        if (nextExpandedIdx >= 0) item.classList.add('expanded');
        if (body) body.scrollTop = scrollTop;
      });
    });

    root.querySelectorAll('.mpe-field-input[data-field="name"]').forEach(input => {
      input.addEventListener('input', () => {
        const idx = parseInt(input.dataset.idx);
        if (this._preset.entries[idx]) {
          this._preset.entries[idx].name = input.value;
          const nameEl = input.closest('.mpe-item-body')?.previousElementSibling?.querySelector('.mpe-item-name');
          if (nameEl) nameEl.textContent = input.value || '未命名条目';
        }
      });
    });

    root.querySelectorAll('.mpe-field-select[data-field="role"]').forEach(sel => {
      sel.addEventListener('change', () => {
        const idx = parseInt(sel.dataset.idx);
        if (this._preset.entries[idx]) {
          this._preset.entries[idx].role = sel.value;
          const roleEl = sel.closest('.mpe-item-body')?.previousElementSibling?.querySelector('.mpe-item-role');
          if (roleEl) roleEl.textContent = sel.value;
        }
      });
    });

    root.querySelectorAll('.mpe-field-select[data-field="activation"]').forEach(sel => {
      sel.addEventListener('change', () => {
        const idx = parseInt(sel.dataset.idx);
        if (this._preset.entries[idx]) {
          this._preset.entries[idx].activation = sel.value;
          const modeEl = sel.closest('.mpe-item-body')?.previousElementSibling?.querySelector('.mpe-item-mode');
          if (modeEl) modeEl.textContent = PRESET_ACTIVATIONS[sel.value] || PRESET_ACTIVATIONS.always;
        }
      });
    });

    this._bindDrag();
  }

  _bindDrag() {
    const root = this.shadowRoot;
    let dragIdx = -1;
    root.querySelectorAll('.mpe-item[draggable]').forEach(item => {
      item.addEventListener('dragstart', (e) => {
        dragIdx = parseInt(item.dataset.idx);
        e.dataTransfer.effectAllowed = 'move';
        item.style.opacity = '0.4';
      });
      item.addEventListener('dragend', () => {
        item.style.opacity = '1';
        root.querySelectorAll('.mpe-item').forEach(i => i.classList.remove('drag-over'));
      });
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        item.classList.add('drag-over');
      });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('drag-over');
        const dropIdx = parseInt(item.dataset.idx);
        if (dragIdx === dropIdx || dragIdx < 0) return;
        const viewState = this._captureViewState();
        this._syncAll();
        const [moved] = this._preset.entries.splice(dragIdx, 1);
        this._preset.entries.splice(dropIdx, 0, moved);
        if (this._expandedIdx === dragIdx) this._expandedIdx = dropIdx;
        else if (dragIdx < this._expandedIdx && dropIdx >= this._expandedIdx) this._expandedIdx--;
        else if (dragIdx > this._expandedIdx && dropIdx <= this._expandedIdx) this._expandedIdx++;
        dragIdx = -1;
        this._renderPreservingView({
          state: viewState,
          focusEntry: moved,
          focusSelector: '.mpe-item-header',
          reveal: true
        });
      });
    });
  }

  _syncAll() {
    const root = this.shadowRoot;
    if (!root || !this._preset) return;
    const nameInput = root.querySelector('#mpe-preset-name');
    if (nameInput) this._preset.name = nameInput.value.trim() || '未命名';
    root.querySelectorAll('.mpe-textarea[data-field="content"]').forEach(ta => {
      const idx = parseInt(ta.dataset.idx);
      if (this._preset.entries[idx]) this._preset.entries[idx].content = ta.value;
    });
    root.querySelectorAll('.mpe-field-input[data-field="name"]').forEach(input => {
      const idx = parseInt(input.dataset.idx);
      if (this._preset.entries[idx]) this._preset.entries[idx].name = input.value;
    });
    root.querySelectorAll('.mpe-field-select[data-field="role"]').forEach(sel => {
      const idx = parseInt(sel.dataset.idx);
      if (this._preset.entries[idx]) this._preset.entries[idx].role = sel.value;
    });
    root.querySelectorAll('.mpe-field-select[data-field="activation"]').forEach(sel => {
      const idx = parseInt(sel.dataset.idx);
      if (this._preset.entries[idx]) this._preset.entries[idx].activation = sel.value;
    });
  }

  _esc(text) {
    return escHtml(text);
  }
  _escAttr(text) { return escAttr(text); }
}

customElements.define('main-preset-editor', MainPresetEditor);
export default MainPresetEditor;
