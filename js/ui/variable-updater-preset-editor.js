import {
  DEFAULT_VARIABLE_UPDATER_PRESET,
  VARIABLE_UPDATER_MACROS,
  getVariableUpdaterPreset,
  normalizeVariableUpdaterPreset,
  saveVariableUpdaterPreset
} from '../data/variable-updater-preset.js';
import { escHtml, escAttr } from '../utils/format.js';
import GameModal from './modal.js';

class VariableUpdaterPresetEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._preset = null;
    this._expanded = 0;
  }

  connectedCallback() {
    this._preset = getVariableUpdaterPreset();
    this._render();
  }

  _render() {
    const entries = this._preset?.entries || [];
    this.shadowRoot.innerHTML = `
      <style>
        :host { position:fixed; inset:0; z-index:calc(var(--z-fullscreen) + 2); display:flex; align-items:center; justify-content:center; padding:20px; box-sizing:border-box; color:#e8e4d9; font-family:'Noto Sans SC',system-ui,sans-serif; background:rgba(3,5,8,.94); backdrop-filter:blur(10px); }
        :host([embedded]) { position:relative; inset:auto; z-index:auto; width:100%; height:100%; padding:0; background:transparent; backdrop-filter:none; }
        :host([embedded]) .editor { width:100%; height:100%; border:0; border-radius:0; box-shadow:none; }
        .editor { width:min(1040px,100%); height:min(88vh,900px); display:flex; flex-direction:column; overflow:hidden; background:#0d1117; border:1px solid rgba(198,156,109,.24); border-radius:12px; box-shadow:0 24px 80px rgba(0,0,0,.55); }
        header,.toolbar,footer { flex:none; display:flex; align-items:center; gap:8px; padding:12px 16px; border-bottom:1px solid rgba(255,255,255,.07); }
        header { justify-content:space-between; }
        footer { border-top:1px solid rgba(255,255,255,.07); border-bottom:0; justify-content:space-between; color:#777; font-size:11px; }
        h2 { margin:0; font:700 16px/1.3 'Noto Serif SC',serif; letter-spacing:2px; }
        .actions,.toolbar { display:flex; gap:8px; flex-wrap:wrap; }
        .toolbar input { flex:1; min-width:220px; }
        button,input,select,textarea { box-sizing:border-box; font:inherit; }
        button { border:1px solid rgba(255,255,255,.14); border-radius:6px; padding:7px 12px; color:#ddd; background:rgba(255,255,255,.04); cursor:pointer; }
        button:hover { border-color:rgba(235,97,63,.65); background:rgba(235,97,63,.08); }
        button.primary { color:#fff; background:#eb613f; border-color:#eb613f; font-weight:700; }
        button.danger { color:#ef7774; }
        input,select,textarea { color:#e8e4d9; background:#070a0e; border:1px solid rgba(255,255,255,.12); border-radius:6px; padding:9px 10px; outline:none; }
        input:focus,select:focus,textarea:focus { border-color:#eb613f; }
        .macro-bar { padding:10px 16px; color:#999; font-size:11px; line-height:1.8; border-bottom:1px solid rgba(255,255,255,.06); }
        code { margin-right:8px; color:#ffad8f; user-select:all; }
        main { flex:1; min-height:0; overflow:auto; overflow-anchor:none; padding:10px 16px 24px; }
        .entry { border-bottom:1px solid rgba(255,255,255,.06); border-left:2px solid transparent; }
        .entry.open { border-left-color:#eb613f; background:rgba(255,255,255,.018); }
        .entry-head { display:flex; align-items:center; gap:9px; padding:12px 10px; cursor:pointer; }
        .index { width:24px; color:#666; font-size:11px; text-align:center; }
        .toggle { width:34px; height:19px; border:0; border-radius:10px; padding:0; background:#34383d; position:relative; }
        .toggle::after { content:''; position:absolute; width:13px; height:13px; border-radius:50%; top:3px; left:3px; background:#aaa; transition:.2s; }
        .toggle.on { background:rgba(235,97,63,.4); }
        .toggle.on::after { left:18px; background:#eb613f; }
        .entry-name { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .entry-name.off { color:#666; text-decoration:line-through; }
        .role { color:#999; font-size:10px; border:1px solid rgba(255,255,255,.1); border-radius:4px; padding:2px 6px; }
        .entry-tools { display:flex; gap:5px; }
        .entry-tools button { padding:4px 8px; font-size:11px; }
        .entry-body { display:none; padding:0 12px 16px 44px; }
        .entry.open .entry-body { display:block; }
        .field { display:grid; grid-template-columns:60px 1fr; gap:10px; align-items:center; margin-bottom:10px; color:#999; font-size:12px; }
        textarea { width:100%; min-height:260px; resize:vertical; font:12px/1.65 'JetBrains Mono',Consolas,monospace; white-space:pre-wrap; }
        .empty { padding:60px 20px; text-align:center; color:#777; }
        input[type=file] { display:none; }
        @media(max-width:700px) {
          :host{padding:0}
          .editor{height:100dvh;border-radius:0;border-left:0;border-right:0}
          header{flex-direction:column;align-items:stretch;padding:10px 12px}
          .actions{width:100%;justify-content:flex-start;gap:6px}
          .toolbar{align-items:stretch;padding:10px 12px;gap:6px}
          .toolbar input{flex:1 1 100%;min-width:0}
          .macro-bar{padding:8px 12px}
          main{padding:6px 8px 18px}
          .entry-head{flex-wrap:wrap;gap:6px;padding:10px 8px}
          .index,.toggle{flex:none}
          .entry-name{flex:1 1 130px}
          .role{order:1}
          .entry-tools{display:none;order:2;width:100%;justify-content:flex-end}
          .entry.open .entry-tools{display:flex}
          .entry-body{padding:0 8px 14px}
          .field{grid-template-columns:1fr}
          footer{flex-wrap:wrap;padding:9px 12px}
          textarea{min-height:220px}
        }
      </style>
      <section class="editor" role="dialog" aria-modal="true" aria-label="变量更新预设编辑器">
        <header>
          <div><h2>变量更新预设</h2></div>
          <div class="actions">
            <input id="import-file" type="file" accept=".json,application/json">
            <button data-action="import">导入</button>
            <button data-action="export">导出</button>
            <button data-action="reset">恢复默认</button>
            <button class="primary" data-action="save">保存</button>
            <button data-action="close">关闭</button>
          </div>
        </header>
        <div class="toolbar">
          <input id="preset-name" value="${escAttr(this._preset?.name || '')}" placeholder="预设名称">
          <button data-action="add">+ 新增预设条目</button>
        </div>
        <div class="macro-bar">
          可用动态宏：${VARIABLE_UPDATER_MACROS.map(item => `<code>{{${escHtml(item.key)}}}</code>${escHtml(item.label)}`).join('　')}
        </div>
        <main>
          ${entries.length ? entries.map((entry, index) => this._renderEntry(entry, index)).join('') : '<div class="empty">当前预设没有条目。</div>'}
        </main>
        <footer><span>共 ${entries.length} 条，启用 ${entries.filter(entry => entry.enabled !== false).length} 条</span><span>运行时按当前顺序组成真实 role 链</span></footer>
      </section>`;
    this._bind();
  }

  _captureViewState() {
    const root = this.shadowRoot;
    const main = root?.querySelector('main');
    const active = root?.activeElement;
    const activeItem = active?.closest?.('.entry');
    const activeIndex = Number(activeItem?.dataset.index);
    let selector = '';
    if (active?.id) selector = `#${active.id}`;
    else if (active?.dataset.action) selector = `[data-action="${active.dataset.action}"]`;
    else if (active?.dataset.field) selector = `[data-field="${active.dataset.field}"]`;

    return {
      scrollTop: main?.scrollTop || 0,
      scrollLeft: main?.scrollLeft || 0,
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
    const main = root.querySelector('main');
    if (main) {
      main.scrollTop = state.scrollTop;
      main.scrollLeft = state.scrollLeft;
    }

    const focusState = focusSelector ? { entry: focusEntry, selector: focusSelector } : state.active;
    let focusTarget = null;
    if (focusState?.entry) {
      const index = this._preset.entries.indexOf(focusState.entry);
      focusTarget = index >= 0
        ? root.querySelector(`.entry[data-index="${index}"] ${focusState.selector}`)
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
    if (reveal) focusTarget.closest('.entry')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  _renderEntry(entry, index) {
    const open = this._expanded === index;
    return `
      <article class="entry${open ? ' open' : ''}" data-index="${index}">
        <div class="entry-head" tabindex="-1">
          <span class="index">${index + 1}</span>
          <button class="toggle${entry.enabled !== false ? ' on' : ''}" data-action="toggle" title="启用/停用"></button>
          <span class="entry-name${entry.enabled === false ? ' off' : ''}">${escHtml(entry.name || '未命名条目')}</span>
          <span class="role">${escHtml(entry.role || 'system')}</span>
          <span class="entry-tools">
            <button data-action="up" title="上移">▲</button>
            <button data-action="down" title="下移">▼</button>
            <button class="danger" data-action="delete" title="删除">删除</button>
          </span>
        </div>
        <div class="entry-body">
          <label class="field"><span>名称</span><input data-field="name" value="${escAttr(entry.name || '')}"></label>
          <label class="field"><span>Role</span><select data-field="role">
            <option value="system"${entry.role === 'system' ? ' selected' : ''}>system</option>
            <option value="user"${entry.role === 'user' ? ' selected' : ''}>user</option>
            <option value="assistant"${entry.role === 'assistant' ? ' selected' : ''}>assistant</option>
          </select></label>
          <textarea data-field="content" spellcheck="false">${escHtml(entry.content || '')}</textarea>
        </div>
      </article>`;
  }

  _bind() {
    const root = this.shadowRoot;
    root.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', event => {
      event.stopPropagation();
      this._handle(button.dataset.action, button.closest('.entry'));
    }));
    root.querySelectorAll('.entry-head').forEach(head => head.addEventListener('click', event => {
      if (event.target.closest('[data-action]')) return;
      const main = root.querySelector('main');
      const scrollTop = main?.scrollTop || 0;
      this._sync();
      this._expanded = Number(head.closest('.entry').dataset.index);
      root.querySelector('.entry.open')?.classList.remove('open');
      head.closest('.entry').classList.add('open');
      if (main) main.scrollTop = scrollTop;
    }));
    root.querySelector('#import-file')?.addEventListener('change', event => this._importFile(event.target.files?.[0]));
  }

  async _handle(action, entryElement) {
    if (action === 'close') return this.remove();
    if (action === 'save') {
      this._sync();
      try {
        this._preset = saveVariableUpdaterPreset(this._preset);
        this.dispatchEvent(new CustomEvent('preset-saved', { bubbles: true, composed: true, detail: this._preset }));
        this.remove();
      } catch (error) {
        GameModal.alert({ title: '保存失败', message: error.message });
      }
      return;
    }
    if (action === 'import') return this.shadowRoot.querySelector('#import-file')?.click();
    if (action === 'export') return this._export();
    if (action === 'reset') {
      const confirmed = await GameModal.confirm({ title: '恢复默认', message: '当前未保存修改将被默认变量更新预设覆盖。' });
      if (!confirmed) return;
      this._preset = JSON.parse(JSON.stringify(DEFAULT_VARIABLE_UPDATER_PRESET));
      this._expanded = 0;
      return this._render();
    }
    if (action === 'add') {
      const viewState = this._captureViewState();
      this._sync();
      const newEntry = { id: `custom_${Date.now()}`, name: '新预设条目', enabled: true, role: 'system', content: '' };
      this._preset.entries.push(newEntry);
      this._expanded = this._preset.entries.length - 1;
      return this._renderPreservingView({
        state: viewState,
        focusEntry: newEntry,
        focusSelector: '[data-field="name"]',
        reveal: true
      });
    }

    const index = Number(entryElement?.dataset.index);
    if (!Number.isInteger(index)) return;
    const viewState = this._captureViewState();
    this._sync();
    if (action === 'toggle') {
      const entry = this._preset.entries[index];
      entry.enabled = entry.enabled === false;
      entryElement.querySelector('.toggle')?.classList.toggle('on', entry.enabled);
      entryElement.querySelector('.entry-name')?.classList.toggle('off', !entry.enabled);
      return;
    }
    if (action === 'up') {
      if (index <= 0) return;
      const movedEntry = this._preset.entries[index];
      [this._preset.entries[index - 1], this._preset.entries[index]] = [this._preset.entries[index], this._preset.entries[index - 1]];
      this._expanded = index - 1;
      return this._renderPreservingView({
        state: viewState,
        focusEntry: movedEntry,
        focusSelector: '[data-action="up"]'
      });
    }
    if (action === 'down') {
      if (index >= this._preset.entries.length - 1) return;
      const movedEntry = this._preset.entries[index];
      [this._preset.entries[index + 1], this._preset.entries[index]] = [this._preset.entries[index], this._preset.entries[index + 1]];
      this._expanded = index + 1;
      return this._renderPreservingView({
        state: viewState,
        focusEntry: movedEntry,
        focusSelector: '[data-action="down"]'
      });
    }
    if (action === 'delete') {
      const confirmed = await GameModal.confirm({ title: '删除预设条目', message: `确认删除「${this._preset.entries[index].name}」？` });
      if (!confirmed) return;
      const neighbor = this._preset.entries[index + 1] || this._preset.entries[index - 1] || null;
      this._preset.entries.splice(index, 1);
      this._expanded = Math.min(index, this._preset.entries.length - 1);
      return this._renderPreservingView({
        state: viewState,
        focusEntry: neighbor,
        focusSelector: '.entry-head'
      });
    }
    this._render();
  }

  _sync() {
    const root = this.shadowRoot;
    if (!root || !this._preset) return;
    this._preset.name = root.querySelector('#preset-name')?.value.trim() || '未命名变量更新预设';
    root.querySelectorAll('.entry').forEach(element => {
      const entry = this._preset.entries[Number(element.dataset.index)];
      if (!entry) return;
      entry.name = element.querySelector('[data-field=name]')?.value || entry.name;
      entry.role = element.querySelector('[data-field=role]')?.value || entry.role;
      entry.content = element.querySelector('[data-field=content]')?.value ?? entry.content;
    });
  }

  _export() {
    this._sync();
    const blob = new Blob([JSON.stringify(this._preset, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `variable_updater_preset_${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  _importFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        this._preset = normalizeVariableUpdaterPreset(JSON.parse(reader.result));
        this._expanded = this._preset.entries.length ? 0 : -1;
        this._render();
      } catch (error) {
        GameModal.alert({ title: '导入失败', message: error.message });
      }
    };
    reader.readAsText(file);
  }
}

customElements.define('variable-updater-preset-editor', VariableUpdaterPresetEditor);
export default VariableUpdaterPresetEditor;
