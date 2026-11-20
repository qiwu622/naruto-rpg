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
        :host {
          display: flex; position: fixed; inset: 0; z-index: calc(var(--z-fullscreen) + 1);
          justify-content: center; align-items: center; padding: 20px; box-sizing: border-box;
          background: var(--ui-backdrop, rgba(3,5,8,0.84));
          backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
          font-family: var(--font-body, 'Noto Sans SC',system-ui,sans-serif);
          color: var(--ui-ink, #f0ece2);
          color-scheme: var(--ui-color-scheme, dark);
        }
        :host([embedded]) { position: relative; inset: auto; z-index: auto; width: 100%; height: 100%; padding: 0; background: transparent; backdrop-filter: none; -webkit-backdrop-filter: none; }
        :host([embedded]) .mpe-container { max-width: none; max-height: none; border: 0; border-radius: 0; box-shadow: none; }
        .mpe-container {
          width: 100%; max-width: 1040px; height: 100%; max-height: 86vh;
          display: flex; flex-direction: column; overflow: hidden;
          background: var(--ui-canvas, #0b0e13);
          border: 1px solid var(--ui-border-strong, rgba(244,241,234,0.16));
          border-radius: 14px;
          box-shadow: var(--ui-shadow, 0 24px 64px rgba(0,0,0,0.55));
        }
        .mpe-header {
          padding: 13px 18px; flex-shrink: 0;
          display: flex; justify-content: space-between; align-items: center; gap: 12px;
          background: var(--ui-surface-1, #12161d);
          border-bottom: 1px solid var(--ui-border, rgba(244,241,234,0.09));
        }
        .mpe-title { font-size: 16px; font-weight: 700; color: var(--ui-ink, #f0ece2); font-family: var(--font-title, 'Noto Serif SC',serif); letter-spacing: 1px; }
        .mpe-actions { display: flex; gap: 8px; flex-wrap: wrap; }
        .btn {
          padding: 6px 13px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 500; letter-spacing: 0.02em;
          background: var(--ui-surface-2, #181d26); color: var(--ui-ink, #f0ece2);
          border: 1px solid var(--ui-border-strong, rgba(244,241,234,0.16));
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
          transition: background 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease, color 0.16s ease, transform 0.12s ease; white-space: nowrap;
        }
        .btn:hover:not(:disabled) { background: var(--ui-surface-elevated, #1e2430); border-color: color-mix(in srgb, var(--ui-gold, #c69c6d) 50%, transparent); }
        .btn:active:not(:disabled) { transform: translateY(1px); }
        .btn.primary {
          background: var(--ui-btn-primary-bg, #6c3326);
          border-color: var(--ui-btn-primary-border, #9e5341); color: var(--ui-btn-primary-ink, #f6f1e7); font-weight: 500;
          box-shadow: var(--ui-btn-primary-shadow, 0 1px 2px rgba(0,0,0,0.36), inset 0 1px 0 rgba(255,255,255,0.11));
        }
        .btn.primary:hover:not(:disabled) {
          background: var(--ui-btn-primary-bg-hover, #7f3b2c);
          border-color: var(--ui-btn-primary-border-hover, #b8624d);
          box-shadow: var(--ui-btn-primary-shadow-hover, 0 2px 6px rgba(0,0,0,0.44), inset 0 1px 0 rgba(255,255,255,0.15));
        }
        .btn.primary:active:not(:disabled) {
          background: var(--ui-btn-primary-bg-active, #5a2a1f);
          box-shadow: var(--ui-btn-primary-shadow-active, inset 0 1px 2px rgba(0,0,0,0.38));
        }
        .btn.danger { border-color: color-mix(in srgb, var(--ui-state-danger, #e2645a) 45%, transparent); color: var(--ui-state-danger, #e2645a); }
        .btn.danger:hover { background: color-mix(in srgb, var(--ui-state-danger, #e2645a) 10%, transparent); }
        .btn.good { background: color-mix(in srgb, var(--ui-state-on, #58b97c) 12%, transparent); border-color: color-mix(in srgb, var(--ui-state-on, #58b97c) 38%, transparent); color: var(--ui-state-on, #58b97c); }
        .btn.sm { padding: 4px 10px; font-size: 11px; border-radius: 6px; }
        .btn.ghost { background: transparent; border-color: transparent; color: var(--ui-ink-muted, #aba69b); }
        .btn.ghost:hover { color: var(--ui-accent, #eb613f); background: var(--ui-surface-2, #181d26); }
        .mpe-bar {
          padding: 10px 16px; display: flex; gap: 8px; align-items: center; flex-shrink: 0; flex-wrap: wrap;
          background: var(--ui-surface-1, #12161d);
          border-bottom: 1px solid var(--ui-border, rgba(244,241,234,0.09));
        }
        .mpe-name-input {
          flex: 1; min-width: 120px; padding: 7px 11px; border-radius: 8px; font-size: 13px; outline: none;
          background: var(--ui-surface-2, #181d26);
          border: 1px solid var(--ui-border, rgba(244,241,234,0.12));
          color: var(--ui-ink, #f0ece2);
        }
        .mpe-name-input:focus { border-color: var(--ui-accent, #eb613f); }
        .mpe-body { flex: 1; overflow-y: auto; overflow-anchor: none; padding: 8px 14px; }
        .mpe-body::-webkit-scrollbar { width: 6px; }
        .mpe-body::-webkit-scrollbar-thumb { background: var(--ui-border-strong, rgba(244,241,234,0.20)); border-radius: 99px; }
        .mpe-item { margin-bottom: 0; border-bottom: 1px solid var(--ui-border, rgba(244,241,234,0.06)); overflow: hidden; transition: background 0.16s; border-left: 3px solid transparent; border-radius: 6px; }
        .mpe-item:hover { background: color-mix(in srgb, var(--ui-surface-2, #181d26) 60%, transparent); }
        .mpe-item.expanded { background: var(--ui-surface-1, #12161d); border-left-color: var(--ui-accent, #eb613f); }
        .mpe-item-header { display: flex; align-items: center; gap: 8px; padding: 11px 12px; cursor: pointer; user-select: none; }
        .mpe-toggle {
          width: 34px; height: 18px; border-radius: 999px; position: relative; cursor: pointer; flex-shrink: 0;
          background: var(--ui-surface-elevated, #1e2430);
          border: 1px solid var(--ui-border-strong, rgba(244,241,234,0.18));
          transition: background 0.2s, border-color 0.2s;
        }
        .mpe-toggle.on { background: var(--ui-accent, #eb613f); border-color: var(--ui-accent, #eb613f); }
        .mpe-toggle.on::after { left: 17px; background: var(--ui-accent-ink, #fff); }
        .mpe-toggle::after { content: ''; position: absolute; width: 12px; height: 12px; border-radius: 50%; top: 2px; left: 2px; background: var(--ui-ink-muted, #aba69b); transition: 0.2s; }
        .mpe-item-name { flex: 1; font-size: 13px; font-weight: 500; color: var(--ui-ink, #f0ece2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mpe-item-name.disabled { color: var(--ui-ink-faint, #757168); text-decoration: line-through; }
        .mpe-item-role { font-size: 10px; color: var(--ui-ink-muted, #aba69b); padding: 2px 7px; border: 1px solid var(--ui-border, rgba(244,241,234,0.12)); border-radius: 999px; flex-shrink: 0; }
        .mpe-item-mode { font-size: 10px; color: var(--ui-state-on, #58b97c); padding: 2px 7px; border: 1px solid color-mix(in srgb, var(--ui-state-on, #58b97c) 32%, transparent); border-radius: 999px; flex-shrink: 0; }
        .mpe-item-idx { font-size: 11px; color: var(--ui-ink-faint, #757168); width: 24px; text-align: center; flex-shrink: 0; font-variant-numeric: tabular-nums; }
        .mpe-item-btns { display: flex; gap: 4px; flex-shrink: 0; opacity: 0; transition: opacity 0.16s; }
        .mpe-item:hover .mpe-item-btns, .mpe-item.expanded .mpe-item-btns { opacity: 1; }
        .mpe-item-body { display: none; padding: 0 12px 16px 44px; }
        .mpe-item.expanded .mpe-item-body { display: block; }
        .mpe-field-row { display: flex; gap: 10px; margin-bottom: 10px; align-items: center; }
        .mpe-field-row label { font-size: 12px; color: var(--ui-ink-muted, #aba69b); width: 48px; flex-shrink: 0; }
        .mpe-field-input {
          flex: 1; padding: 7px 10px; border-radius: 7px; font-size: 13px; outline: none; transition: border-color 0.16s;
          background: var(--ui-surface-2, #181d26);
          border: 1px solid var(--ui-border, rgba(244,241,234,0.12));
          color: var(--ui-ink, #f0ece2);
        }
        .mpe-field-input:focus { border-color: var(--ui-accent, #eb613f); }
        .mpe-field-select {
          padding: 6px 10px; border-radius: 7px; font-size: 12px; outline: none;
          background: var(--ui-surface-2, #181d26);
          border: 1px solid var(--ui-border, rgba(244,241,234,0.12));
          color: var(--ui-ink, #f0ece2);
        }
        .mpe-textarea {
          width: 100%; box-sizing: border-box; min-height: 100px; padding: 11px 12px; resize: vertical; outline: none;
          background: var(--ui-surface-2, #181d26);
          border: 1px solid var(--ui-border, rgba(244,241,234,0.12));
          border-radius: 8px; color: var(--ui-ink, #f0ece2);
          font: 13px/1.65 var(--font-mono, 'JetBrains Mono',monospace); transition: border-color 0.16s;
        }
        .mpe-textarea:focus { border-color: var(--ui-accent, #eb613f); }
        .mpe-empty { text-align: center; color: var(--ui-ink-faint, #757168); padding: 60px 20px; font-size: 14px; }
        .mpe-footer {
          padding: 10px 16px; display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;
          background: var(--ui-surface-1, #12161d);
          border-top: 1px solid var(--ui-border, rgba(244,241,234,0.09));
        }
        .mpe-footer-info { font-size: 11px; color: var(--ui-ink-faint, #757168); }
        input[type="file"] { display: none; }
        .drag-over { border-color: var(--ui-accent, #eb613f) !important; background: color-mix(in srgb, var(--ui-accent, #eb613f) 6%, transparent); }
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
          <button class="btn sm good" id="mpe-add-entry">+ 新增条目</button>
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
