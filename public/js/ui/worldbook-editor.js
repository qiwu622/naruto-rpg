import { KNOWLEDGE_BASE } from '../data/knowledge-base.js';
import { importWorldbookEntries, normalizeCustomWorldbookEntry, normalizeWorldbookActivation, worldbookKeys } from '../data/worldbook/activation.js';
import { eventBus } from '../core/event-bus.js';
import { escHtml, escAttr } from '../utils/format.js';
import GameModal from './modal.js';
import { worldbookStyles } from '../../css/components/worldbook-editor.css.js';

export class WorldbookEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._builtin = [];
    this._custom = [];
    this._selectedType = null;
    this._selectedIndex = -1;
    this._searchQuery = '';
    this._builtinExpanded = false;
  }

  connectedCallback() {
    this._load();
    this._render();
    this._bindEvents();
  }

  _load() {
    this._builtin = KNOWLEDGE_BASE.getDefaultEntries();
    this._custom = KNOWLEDGE_BASE.getCustomEntries().map((e, i) => ({ ...normalizeCustomWorldbookEntry(e, i), _idx: i }));
  }

  _save() {
    KNOWLEDGE_BASE.saveCustomEntries(this._custom.map(e => {
      const { _idx, ...entry } = e;
      return entry;
    }));
    eventBus.emit('app:toast', `已保存 ${this._custom.length} 条自定义世界书，下一次生成生效`);
  }

  _captureCurrentEdit() {
    if (this._selectedType !== 'custom' || this._selectedIndex < 0 || this._selectedIndex >= this._custom.length) return false;
    const root = this.shadowRoot;
    const titleEl = root.querySelector('#entry-title');
    const keysEl = root.querySelector('#entry-keys');
    const contentEl = root.querySelector('#entry-content');
    if (!titleEl || !keysEl || !contentEl) return false;

    const activation = normalizeWorldbookActivation(this._custom[this._selectedIndex]);
    const keys = worldbookKeys(keysEl.value);
    this._custom[this._selectedIndex] = {
      ...this._custom[this._selectedIndex],
      title: titleEl.value.trim(),
      keys,
      activation: {
        ...activation,
        keys,
        mode: root.querySelector('#entry-mode')?.value || activation.mode,
        secondary_keys: worldbookKeys(root.querySelector('#entry-secondary-keys')?.value || ''),
        selective: root.querySelector('#entry-selective')?.value !== 'off',
        selective_logic: root.querySelector('#entry-selective')?.value === 'off' ? activation.selective_logic : (root.querySelector('#entry-selective')?.value || activation.selective_logic)
      },
      content: contentEl.value
    };
    return true;
  }

  _captureViewState() {
    const root = this.shadowRoot;
    const active = root.activeElement;
    return {
      listScrollTop: root.querySelector('#entry-list')?.scrollTop || 0,
      editorScrollTop: root.querySelector('.wb-editor')?.scrollTop || 0,
      focusId: active?.id || '',
      focusAction: active?.dataset?.action || '',
      focusIndex: active?.dataset?.idx || '',
      selectionStart: typeof active?.selectionStart === 'number' ? active.selectionStart : null,
      selectionEnd: typeof active?.selectionEnd === 'number' ? active.selectionEnd : null
    };
  }

  _rerenderWithView({
    snapshot = this._captureViewState(),
    listScrollTop = snapshot.listScrollTop,
    editorScrollTop = snapshot.editorScrollTop,
    focusSelector = '',
    revealActive = false
  } = {}) {
    this._render();
    this._bindEvents();

    const root = this.shadowRoot;
    const list = root.querySelector('#entry-list');
    const editor = root.querySelector('.wb-editor');
    if (list) list.scrollTop = listScrollTop;
    if (editor) editor.scrollTop = editorScrollTop;
    if (revealActive) root.querySelector('.wb-item.active')?.scrollIntoView({ block: 'nearest' });

    let focusTarget = focusSelector ? root.querySelector(focusSelector) : null;
    if (!focusTarget && snapshot.focusId) focusTarget = root.getElementById(snapshot.focusId);
    if (!focusTarget && snapshot.focusAction && snapshot.focusIndex !== '') {
      focusTarget = root.querySelector(`[data-action="${snapshot.focusAction}"][data-idx="${snapshot.focusIndex}"]`);
    }
    focusTarget?.focus({ preventScroll: true });
    if (focusTarget && snapshot.selectionStart !== null && typeof focusTarget.setSelectionRange === 'function') {
      const end = snapshot.selectionEnd ?? snapshot.selectionStart;
      focusTarget.setSelectionRange(snapshot.selectionStart, end);
    }
    if (!revealActive && list) list.scrollTop = listScrollTop;
    if (editor) editor.scrollTop = editorScrollTop;
  }

  _export() {
    const data = JSON.stringify({
      builtinCount: this._builtin.length,
      custom: this._custom.map(e => { const { _idx, ...entry } = e; return entry; })
    }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `worldbook_custom_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  _import(file) {
    this._captureCurrentEdit();
    const snapshot = this._captureViewState();
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result);
        const imported = importWorldbookEntries(json);
        let added = 0, updated = 0;
        const handled = new Set();
        for (const entry of imported) {
          if (!entry.title) continue;
          const clean = { ...entry, _idx: this._custom.length };
          const existed = this._custom.findIndex((e, index) => !handled.has(index) && e.title === clean.title
            && (e.uid == null || clean.uid == null || e.uid === clean.uid));
          if (existed >= 0) { this._custom[existed] = clean; handled.add(existed); updated++; }
          else { handled.add(this._custom.length); this._custom.push(clean); added++; }
        }
        this._custom.forEach((e, i) => e._idx = i);
        this._save();
        this._rerenderWithView({ snapshot, focusSelector: '#btn-import' });
        GameModal.alert({ title: '导入完成', message: `新增 ${added} 条，更新 ${updated} 条自定义条目。` });
      } catch (e) {
        GameModal.alert({ title: '导入失败', message: e.message });
      }
    };
    reader.readAsText(file);
  }

  _convertTavernEntries(entries) {
    return importWorldbookEntries({ entries });
  }

  _toggleAllCustom(enable) {
    this._captureCurrentEdit();
    const snapshot = this._captureViewState();
    this._custom.forEach(e => e.enabled = enable);
    this._save();
    this._rerenderWithView({
      snapshot,
      focusSelector: enable ? '#btn-enable-all' : '#btn-disable-all'
    });
  }

  _restoreDefaults() {
    GameModal.confirm({
      title: '恢复默认',
      message: '这将删除所有自定义世界书条目并恢复内置条目。确定继续？',
      okLabel: '确定', cancelLabel: '取消'
    }).then(confirmed => {
      if (confirmed) {
        this._custom = [];
        this._save();
        this._selectedType = null;
        this._selectedIndex = -1;
        this._rerenderWithView({ listScrollTop: 0, editorScrollTop: 0, focusSelector: '#btn-add' });
      }
    });
  }

  _render() {
    const builtinSearch = this._searchQuery ? this._builtin.filter(b =>
      (b.title || '').toLowerCase().includes(this._searchQuery.toLowerCase()) ||
      (b.keys || []).some(k => k.toLowerCase().includes(this._searchQuery.toLowerCase()))
    ) : this._builtin;
    const customSearch = this._searchQuery ? this._custom.filter(c =>
      (c.title || '').toLowerCase().includes(this._searchQuery.toLowerCase()) ||
      (c.keys || []).some(k => k.toLowerCase().includes(this._searchQuery.toLowerCase()))
    ) : this._custom;
    const enabledCount = this._custom.filter(e => e.enabled !== false).length;

    const selectedEntry = this._selectedType === 'custom' && this._selectedIndex >= 0 && this._selectedIndex < this._custom.length
      ? this._custom[this._selectedIndex] : (this._selectedType === 'builtin' && this._selectedIndex >= 0 && this._selectedIndex < this._builtin.length
      ? this._builtin[this._selectedIndex] : null);
    const isBuiltin = this._selectedType === 'builtin';
    const activation = selectedEntry ? normalizeWorldbookActivation(selectedEntry) : null;

    this.shadowRoot.innerHTML = `
      <style>${worldbookStyles}</style>
      <div class="wb-container">
        <div class="wb-header">
          <h2 class="wb-title">世界书编辑器 <span>| 内置 ${this._builtin.length} 条 + 自定义 ${this._custom.length} 条${enabledCount !== this._custom.length ? ` (启用 ${enabledCount}/${this._custom.length})` : ''}</span></h2>
          <div class="wb-actions">
            <button class="btn" id="btn-export">导出</button>
            <button class="btn" id="btn-import">导入</button>
            <button class="btn danger sm" id="btn-restore">恢复默认</button>
            <button class="btn" id="btn-close">返回</button>
            <input type="file" id="file-import" accept=".json" hidden />
          </div>
        </div>
        <div class="wb-body">
          <div class="wb-sidebar">
            <div class="wb-search-bar">
              <input type="text" class="wb-search-input" id="search-input" placeholder="搜索条目..." value="${escAttr(this._searchQuery)}">
            </div>
            <div class="wb-list" id="entry-list">
              <div class="wb-section-hdr" id="toggle-builtin" role="button" tabindex="0" aria-expanded="${this._builtinExpanded}">
                内置世界书 <span class="count">${builtinSearch.length} 条 · 只读</span>
                <span style="font-size:10px;color:rgba(232,228,217,0.3);">${this._builtinExpanded ? '▾' : '▸'}</span>
              </div>
              ${this._builtinExpanded ? builtinSearch.map(e => `
                <div class="wb-item${this._selectedType === 'builtin' && this._selectedIndex === this._builtin.indexOf(e) ? ' active' : ''}" data-type="builtin" data-idx="${this._builtin.indexOf(e)}" role="button" tabindex="0" aria-selected="${this._selectedType === 'builtin' && this._selectedIndex === this._builtin.indexOf(e)}">
                  <span class="wb-builtin-tag">内置</span>
                  <span class="wb-item-title">${escHtml(e.title || '无标题')}</span>
                  <span class="wb-item-meta">${(e.keys||[]).length} 关键词</span>
                </div>`).join('') : ''}
              <div class="wb-section-hdr" style="margin-top:2px;">
                自定义世界书 <span class="count">${customSearch.length} 条${customSearch.length ? ` · 启用 ${customSearch.filter(e=>e.enabled!==false).length}` : ''}</span>
              </div>
              ${customSearch.map(e => `
                <div class="wb-item${this._selectedType === 'custom' && this._selectedIndex === e._idx ? ' active' : ''}" data-type="custom" data-idx="${e._idx}" role="button" tabindex="0" aria-selected="${this._selectedType === 'custom' && this._selectedIndex === e._idx}">
                  <div class="wb-item-toggle ${e.enabled !== false ? 'on' : ''}" data-action="toggle" data-idx="${e._idx}" role="switch" tabindex="0" aria-checked="${e.enabled !== false}" title="${e.enabled !== false ? '已启用' : '已禁用'}"></div>
                  <span class="wb-item-title">${escHtml(e.title || '无标题')}</span>
                  <span class="wb-item-meta" data-mode="${escAttr(e.activation?.mode || 'keyword')}">${e.activation?.mode === 'always' ? '蓝灯 · 常驻' : e.activation?.mode === 'manual' ? '手动' : `绿灯 · ${(e.keys||[]).length} 关键词`}</span>
                </div>`).join('')}
              ${customSearch.length === 0 ? '<div style="padding:12px;text-align:center;color:rgba(232,228,217,0.15);font-size:12px;">暂无自定义条目<br>点击「导入」或下方按钮添加</div>' : ''}
            </div>
            <div class="wb-sidebar-foot">
              <button class="btn sm" id="btn-add">+ 新建</button>
              <button class="btn sm good" id="btn-enable-all">全部启用</button>
              <button class="btn sm" id="btn-disable-all" style="opacity:0.6;">全部禁用</button>
            </div>
          </div>
          <div class="wb-editor">
            ${selectedEntry ? `
              ${isBuiltin ? `<div class="wb-readonly-banner">🔒 这是内置条目，无法编辑。如需修改可复制内容到自定义条目。</div>
                <div style="margin-top:8px;margin-bottom:4px;">
                  <button class="btn" id="btn-copy-to-custom">复制到自定义条目</button>
                </div>` : ''}
              <div class="wb-form-group">
                <label class="wb-form-label">标题</label>
                <input type="text" class="wb-input" id="entry-title" value="${escAttr(selectedEntry.title || '')}" placeholder="条目名称" ${isBuiltin ? 'disabled' : ''}>
              </div>
              ${!isBuiltin ? `
              <div class="wb-form-group" style="display:flex;align-items:center;gap:12px;">
                <label class="wb-form-label" style="margin:0;">挂载状态:</label>
                <div class="wb-item-toggle ${selectedEntry.enabled !== false ? 'on' : ''}" id="entry-toggle" role="switch" tabindex="0" aria-checked="${selectedEntry.enabled !== false}" style="cursor:pointer;" title="${selectedEntry.enabled !== false ? '已启用挂载' : '已禁用挂载'}"></div>
                <span style="font-size:12px;color:rgba(232,228,217,0.5);">${selectedEntry.enabled !== false ? '已挂载 · AI 可匹配此条目' : '未挂载 · AI 不会读取此条目'}</span>
              </div>` : ''}
              <div class="wb-form-group">
                <label class="wb-form-label">触发关键词 (逗号分隔)</label>
                <input type="text" class="wb-input" id="entry-keys" value="${escAttr((selectedEntry.keys || []).join(', '))}" placeholder="关键词1, 关键词2" ${isBuiltin ? 'disabled' : ''}>
              </div>
              ${!isBuiltin ? `
              <div class="wb-form-group">
                <label class="wb-form-label" for="entry-mode">触发模式</label>
                <select class="wb-input" id="entry-mode">
                  <option value="keyword" ${activation.mode === 'keyword' ? 'selected' : ''}>绿灯 · 关键词触发</option>
                  <option value="always" ${activation.mode === 'always' ? 'selected' : ''}>蓝灯 · 常驻</option>
                  <option value="manual" ${activation.mode === 'manual' ? 'selected' : ''}>手动 · 不自动注入</option>
                </select>
                <div style="font-size:12px;opacity:0.65;margin-top:6px;line-height:1.6;">关闭条目不会注入；绿灯需命中主关键词，无关键词时不触发。蓝灯优先注入，仍受上下文预算限制。旧导入缺少蓝灯标记时，可在此设为常驻或重新导入原文件。</div>
              </div>
              <div class="wb-form-group">
                <label class="wb-form-label" for="entry-secondary-keys">次关键词过滤 (逗号分隔)</label>
                <input class="wb-input" id="entry-secondary-keys" value="${escAttr(activation.secondary_keys.join(', '))}" placeholder="先命中主关键词，再判断此处条件">
                <select class="wb-input" id="entry-selective" style="margin-top:6px;">
                  ${[['off', '不使用次关键词'], ['and_any', '至少命中一个次关键词'], ['and_all', '必须命中全部次关键词'], ['not_any', '不得命中任何次关键词'], ['not_all', '不能同时命中全部次关键词']].map(([value, label]) => `<option value="${value}" ${(!activation.selective ? value === 'off' : value === activation.selective_logic) ? 'selected' : ''}>${label}</option>`).join('')}
                </select>
                ${activation.case_sensitive || activation.match_whole_words ? `<div style="font-size:12px;opacity:0.65;margin-top:6px;">已保留导入规则：${[activation.case_sensitive && '区分大小写', activation.match_whole_words && '完整词匹配'].filter(Boolean).join('、')}。</div>` : ''}
              </div>` : ''}
              <div class="wb-form-group" style="flex:1; display:flex; flex-direction:column;">
                <label class="wb-form-label">内容</label>
                <textarea class="wb-input wb-textarea" id="entry-content" style="flex:1;" placeholder="条目内容..." ${isBuiltin ? 'disabled' : ''}>${escHtml(selectedEntry.content || '')}</textarea>
              </div>
              ${!isBuiltin ? `
              <div style="display:flex; gap:8px; margin-top:8px;">
                <button class="btn danger" id="btn-delete">删除此条目</button>
              </div>` : ''}
            ` : `<div class="wb-editor-empty">选择左侧条目查看详情<br><span style="font-size:11px;color:rgba(232,228,217,0.1);">内置条目只读 · 自定义条目可编辑</span></div>`}
          </div>
        </div>
      </div>
    `;
  }

  _bindEvents() {
    const root = this.shadowRoot;
    for (const id of ['entry-mode', 'entry-selective', 'entry-secondary-keys', 'entry-keys']) {
      root.querySelector(`#${id}`)?.addEventListener('change', () => {
        this._saveCurrentEdit();
        if (id === 'entry-mode' || id === 'entry-selective') this._rerenderWithView();
      });
    }

    root.querySelector('#btn-close')?.addEventListener('click', () => {
      this._saveCurrentEdit();
      this.remove();
    });

    root.querySelector('#btn-export')?.addEventListener('click', () => {
      this._saveCurrentEdit();
      this._export();
    });
    root.querySelector('#btn-restore')?.addEventListener('click', () => this._restoreDefaults());

    const fileInput = root.querySelector('#file-import');
    root.querySelector('#btn-import')?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', (e) => {
      if (e.target.files?.[0]) this._import(e.target.files[0]);
      e.target.value = '';
    });

    root.querySelector('#search-input')?.addEventListener('input', (e) => {
      this._captureCurrentEdit();
      const snapshot = this._captureViewState();
      this._searchQuery = e.target.value;
      this._rerenderWithView({ snapshot, listScrollTop: 0, focusSelector: '#search-input' });
    });

    root.querySelector('#toggle-builtin')?.addEventListener('click', () => {
      this._captureCurrentEdit();
      const snapshot = this._captureViewState();
      this._builtinExpanded = !this._builtinExpanded;
      this._rerenderWithView({ snapshot, focusSelector: '#toggle-builtin' });
    });

    root.querySelector('#btn-add')?.addEventListener('click', () => {
      this._captureCurrentEdit();
      this._custom.push({ title: '新条目', keys: [], content: '', source: 'custom', enabled: true, _idx: this._custom.length });
      this._selectedType = 'custom';
      this._selectedIndex = this._custom.length - 1;
      this._searchQuery = '';
      this._save();
      this._rerenderWithView({ listScrollTop: 0, editorScrollTop: 0, focusSelector: '#entry-title', revealActive: true });
    });

    root.querySelector('#btn-enable-all')?.addEventListener('click', () => this._toggleAllCustom(true));
    root.querySelector('#btn-disable-all')?.addEventListener('click', () => this._toggleAllCustom(false));

    root.querySelector('#btn-delete')?.addEventListener('click', async () => {
      if (this._selectedType !== 'custom' || this._selectedIndex < 0) return;
      const confirmed = await GameModal.confirm({ title: '删除条目', message: '确定删除此自定义条目？不可撤销。', okLabel: '删除', cancelLabel: '取消' });
      if (confirmed) {
        this._custom.splice(this._selectedIndex, 1);
        this._custom.forEach((e, i) => e._idx = i);
        this._selectedIndex = Math.min(this._selectedIndex, this._custom.length - 1);
        if (this._custom.length === 0) { this._selectedType = null; this._selectedIndex = -1; }
        this._save();
        this._rerenderWithView({
          listScrollTop: 0,
          editorScrollTop: 0,
          focusSelector: this._selectedType === 'custom' ? '#entry-title' : '#btn-add',
          revealActive: this._selectedType === 'custom'
        });
      }
    });

    root.querySelector('#btn-copy-to-custom')?.addEventListener('click', () => {
      if (this._selectedType !== 'builtin' || this._selectedIndex < 0 || this._selectedIndex >= this._builtin.length) return;
      const builtin = this._builtin[this._selectedIndex];
      this._custom.push({
        title: builtin.title + ' (副本)',
        keys: [...(builtin.keys || [])],
        content: builtin.content || '',
        activation: normalizeWorldbookActivation(builtin),
        source: 'custom',
        enabled: true,
        _idx: this._custom.length
      });
      this._selectedType = 'custom';
      this._selectedIndex = this._custom.length - 1;
      this._searchQuery = '';
      this._save();
      this._rerenderWithView({ listScrollTop: 0, editorScrollTop: 0, focusSelector: '#entry-title', revealActive: true });
    });

    root.querySelector('#entry-toggle')?.addEventListener('click', () => {
      if (this._selectedType !== 'custom' || this._selectedIndex < 0) return;
      this._captureCurrentEdit();
      const snapshot = this._captureViewState();
      this._custom[this._selectedIndex].enabled = !this._custom[this._selectedIndex].enabled;
      this._save();
      this._rerenderWithView({ snapshot, focusSelector: '#entry-toggle' });
    });

    const allItems = root.querySelectorAll('.wb-item');
    allItems.forEach(item => {
      item.addEventListener('click', (e) => {
        const toggleEl = e.target.closest('.wb-item-toggle');
        if (toggleEl) return;
        const captured = this._captureCurrentEdit();
        const snapshot = this._captureViewState();
        if (captured) this._save();
        const type = item.dataset.type;
        if (type === 'builtin') {
          const idx = parseInt(item.dataset.idx, 10);
          if (idx >= 0) { this._selectedType = 'builtin'; this._selectedIndex = idx; }
        } else if (type === 'custom') {
          const idx = parseInt(item.dataset.idx, 10);
          if (idx >= 0 && idx < this._custom.length) { this._selectedType = 'custom'; this._selectedIndex = idx; }
        }
        this._rerenderWithView({
          snapshot,
          editorScrollTop: 0,
          focusSelector: this._selectedType === 'custom' ? '#entry-title' : '#btn-copy-to-custom'
        });
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          item.click();
        }
      });
    });

    const toggles = root.querySelectorAll('.wb-item-toggle');
    toggles.forEach(t => {
      t.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(t.dataset.idx, 10);
        if (idx >= 0 && idx < this._custom.length) {
          this._captureCurrentEdit();
          const snapshot = this._captureViewState();
          this._custom[idx].enabled = !this._custom[idx].enabled;
          if (this._selectedType === 'custom' && this._selectedIndex === idx) {
            this._selectedEntry = this._custom[idx];
          }
          this._save();
          this._rerenderWithView({ snapshot, focusSelector: `.wb-item-toggle[data-idx="${idx}"]` });
        }
      });
      t.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          t.click();
        }
      });
    });

    root.querySelector('#toggle-builtin')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.currentTarget.click();
      }
    });
  }

  _saveCurrentEdit() {
    if (this._captureCurrentEdit()) this._save();
  }
}

customElements.define('worldbook-editor', WorldbookEditor);


