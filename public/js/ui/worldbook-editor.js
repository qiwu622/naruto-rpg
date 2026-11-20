import { KNOWLEDGE_BASE } from '../data/knowledge-base.js';
import { importWorldbookEntries, normalizeCustomWorldbookEntry, normalizeWorldbookActivation, worldbookKeys } from '../data/worldbook/activation.js';
import { normalizeWorldbookTitle } from '../data/worldbook/schema-v2.js';
import { eventBus } from '../core/event-bus.js';
import { escHtml, escAttr } from '../utils/format.js';
import { icon } from '../utils/icons.js';
import GameModal from './modal.js';
import { worldbookStyles } from '../../css/components/worldbook-editor.css.js';

const BUILTIN_CATEGORY_LABELS = Object.freeze({
  all: '全部内置分类',
  character_profile: '角色档案',
  timeline_reference: '时间线参考',
  plot_reference: '剧情参考',
  world_rule: '世界规则',
  location_organization: '地点与组织',
  world_reference: '世界百科',
  era_rule: '时代规则',
  other: '综合设定'
});

const FILTER_OPTIONS = Object.freeze([
  ['all', '全部'],
  ['modified', '已改'],
  ['disabled', '已关闭'],
  ['always', '蓝灯常驻']
]);

function formatContentStats(text) {
  const len = String(text || '').length;
  const estTokens = Math.max(0, Math.ceil(len * 0.65));
  return `${len} 字 · 约 ${estTokens} tokens`;
}

function renderKeyChipsHtml(keys) {
  return (Array.isArray(keys) ? keys : [])
    .filter(Boolean)
    .slice(0, 16)
    .map(k => `<span class="wb-key-chip">${escHtml(k)}</span>`)
    .join('');
}

export class WorldbookEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._builtin = [];
    this._custom = [];
    this._selectedType = null;
    this._selectedIndex = -1;
    this._searchQuery = '';
    this._filterMode = 'all';
    this._categoryFilter = 'all';
    this._builtinExpanded = false;
    this._mobileShowList = false;
  }

  connectedCallback() {
    this._load();
    this._render();
    this._bindEvents();
  }

  _load() {
    this._builtin = KNOWLEDGE_BASE.getBuiltinEntries({ includeDisabled: true }).map((e, i) => ({ ...e, _idx: i }));
    this._custom = KNOWLEDGE_BASE.getCustomEntries().map((e, i) => ({ ...normalizeCustomWorldbookEntry(e, i), _idx: i }));
  }

  _save() {
    KNOWLEDGE_BASE.saveCustomEntries(this._custom.map(e => {
      const { _idx, ...entry } = e;
      return entry;
    }));
    eventBus.emit('app:toast', `已保存 ${this._custom.length} 条自定义世界书，下一次生成生效`);
  }

  _saveBuiltinIndex(index, { silent = false } = {}) {
    const item = this._builtin[index];
    if (!item) return null;
    const updated = KNOWLEDGE_BASE.saveBuiltinEntry(item._builtinKey || item, item);
    if (updated) {
      this._builtin[index] = { ...updated, _idx: index };
      if (!silent) {
        eventBus.emit('app:toast', `已保存内置条目「${updated.title}」的本地修改，下一次生成生效`);
      }
    }
    return updated;
  }

  _captureCurrentEdit() {
    if (!['custom', 'builtin'].includes(this._selectedType) || this._selectedIndex < 0) return false;
    const root = this.shadowRoot;
    const titleEl = root.querySelector('#entry-title');
    const keysEl = root.querySelector('#entry-keys');
    const contentEl = root.querySelector('#entry-content');
    if (!titleEl || !keysEl || !contentEl) return false;

    const modeEl = root.querySelector('#entry-mode');
    const secondaryEl = root.querySelector('#entry-secondary-keys');
    const selectiveEl = root.querySelector('#entry-selective');

    if (this._selectedType === 'custom') {
      if (this._selectedIndex >= this._custom.length) return false;
      const activation = normalizeWorldbookActivation(this._custom[this._selectedIndex]);
      const keys = worldbookKeys(keysEl.value);
      this._custom[this._selectedIndex] = {
        ...this._custom[this._selectedIndex],
        title: titleEl.value.trim(),
        keys,
        activation: {
          ...activation,
          keys,
          mode: modeEl?.value || activation.mode,
          secondary_keys: worldbookKeys(secondaryEl?.value || ''),
          selective: selectiveEl?.value !== 'off',
          selective_logic: selectiveEl?.value === 'off' ? activation.selective_logic : (selectiveEl?.value || activation.selective_logic)
        },
        content: contentEl.value
      };
      return 'custom';
    }

    if (this._selectedIndex >= this._builtin.length) return false;
    const current = this._builtin[this._selectedIndex];
    const currentActivation = normalizeWorldbookActivation(current);
    const keys = worldbookKeys(keysEl.value);
    const nextTitle = normalizeWorldbookTitle(titleEl.value.trim() || current.title) || current.title;
    const nextActivation = normalizeWorldbookActivation({
      ...current,
      keys,
      activation: {
        ...currentActivation,
        keys,
        mode: modeEl?.value || currentActivation.mode,
        secondary_keys: worldbookKeys(secondaryEl?.value || ''),
        selective: selectiveEl?.value !== 'off',
        selective_logic: selectiveEl?.value === 'off' ? currentActivation.selective_logic : (selectiveEl?.value || currentActivation.selective_logic)
      }
    });
    const nextContent = contentEl.value;
    const changed = nextTitle !== normalizeWorldbookTitle(current.title || '')
      || JSON.stringify(keys) !== JSON.stringify(currentActivation.keys || [])
      || JSON.stringify(nextActivation) !== JSON.stringify(currentActivation)
      || nextContent !== (current.content || '');
    if (!changed) return false;

    this._builtin[this._selectedIndex] = {
      ...current,
      title: nextTitle,
      keys: [...nextActivation.keys],
      activation: nextActivation,
      isAlwaysOn: nextActivation.mode === 'always',
      content: nextContent,
      _overridden: true,
      _hasOverride: true
    };
    return 'builtin';
  }

  _captureViewState() {
    const root = this.shadowRoot;
    const active = root.activeElement;
    return {
      listScrollTop: root.querySelector('#entry-list')?.scrollTop || 0,
      editorScrollTop: root.querySelector('.wb-editor')?.scrollTop || 0,
      focusId: active?.id || '',
      focusAction: active?.dataset?.action || '',
      focusType: active?.dataset?.type || '',
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
    if (revealActive && list) {
      const activeEl = root.querySelector('.wb-item.active');
      if (activeEl) {
        const listRect = list.getBoundingClientRect();
        const itemRect = activeEl.getBoundingClientRect();
        if (itemRect.bottom > listRect.bottom - 4) {
          list.scrollTop += Math.ceil(itemRect.bottom - listRect.bottom + 8);
        } else if (itemRect.top < listRect.top + 4) {
          list.scrollTop -= Math.ceil(listRect.top - itemRect.top + 8);
        }
      }
    }

    let focusTarget = focusSelector ? root.querySelector(focusSelector) : null;
    if (!focusTarget && snapshot.focusId) focusTarget = root.getElementById(snapshot.focusId);
    if (!focusTarget && snapshot.focusAction && snapshot.focusIndex !== '') {
      focusTarget = snapshot.focusType
        ? root.querySelector(`[data-action="${snapshot.focusAction}"][data-type="${snapshot.focusType}"][data-idx="${snapshot.focusIndex}"]`)
        : root.querySelector(`[data-action="${snapshot.focusAction}"][data-idx="${snapshot.focusIndex}"]`);
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
      builtinOverrides: KNOWLEDGE_BASE.getBuiltinOverrides(),
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
    this._saveCurrentEdit({ silent: true });
    const snapshot = this._captureViewState();
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const json = JSON.parse(reader.result);
        let builtinImported = 0;
        if (json && typeof json === 'object' && !Array.isArray(json) && json.builtinOverrides && typeof json.builtinOverrides === 'object') {
          builtinImported = KNOWLEDGE_BASE.importBuiltinOverrides(json.builtinOverrides, { merge: true });
          this._builtin = KNOWLEDGE_BASE.getBuiltinEntries({ includeDisabled: true }).map((e, i) => ({ ...e, _idx: i }));
        }

        const hasCustomPayload = Array.isArray(json)
          || Boolean(json && typeof json === 'object' && (json.custom !== undefined || json.entries !== undefined || json.character_book?.entries !== undefined));
        let added = 0, updated = 0;
        if (hasCustomPayload) {
          const imported = importWorldbookEntries(json);
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
        } else if (!builtinImported) {
          throw new Error('无效的世界书格式');
        }

        this._rerenderWithView({ snapshot, focusSelector: '#btn-import' });
        const summary = [`新增 ${added} 条、更新 ${updated} 条自定义条目`];
        if (builtinImported > 0) summary.push(`导入 ${builtinImported} 条内置条目覆写`);
        GameModal.alert({ title: '导入完成', message: `${summary.join('，')}。` });
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
    const captured = this._captureCurrentEdit();
    const snapshot = this._captureViewState();
    if (captured === 'builtin') this._saveBuiltinIndex(this._selectedIndex, { silent: true });
    this._custom.forEach(e => e.enabled = enable);
    this._save();
    this._rerenderWithView({
      snapshot,
      focusSelector: enable ? '#btn-enable-all' : '#btn-disable-all'
    });
  }

  _toggleAllBuiltin(enable) {
    this._saveCurrentEdit({ silent: true });
    const snapshot = this._captureViewState();
    KNOWLEDGE_BASE.setAllBuiltinEnabled(enable);
    this._builtin = KNOWLEDGE_BASE.getBuiltinEntries({ includeDisabled: true }).map((e, i) => ({ ...e, _idx: i }));
    eventBus.emit('app:toast', enable ? `已全部启用 ${this._builtin.length} 条内置世界书` : `已全部关闭 ${this._builtin.length} 条内置世界书`);
    this._rerenderWithView({
      snapshot,
      focusSelector: enable ? '#btn-builtin-enable-all' : '#btn-builtin-disable-all'
    });
  }

  _restoreDefaults() {
    GameModal.confirm({
      title: '恢复默认',
      message: '这将删除所有自定义世界书条目，并清除对内置条目的全部修改与开关状态。确定继续？',
      okLabel: '确定', cancelLabel: '取消'
    }).then(confirmed => {
      if (confirmed) {
        this._custom = [];
        KNOWLEDGE_BASE.clearBuiltinOverrides();
        this._save();
        this._load();
        this._selectedType = null;
        this._selectedIndex = -1;
        this._mobileShowList = true;
        this._rerenderWithView({ listScrollTop: 0, editorScrollTop: 0, focusSelector: '#btn-add' });
      }
    });
  }

  _matchesFilter(entry, isBuiltin) {
    const mode = entry.activation?.mode || (entry.isAlwaysOn ? 'always' : 'keyword');
    if (this._filterMode === 'modified') {
      if (!isBuiltin || !entry._hasOverride) return false;
    } else if (this._filterMode === 'disabled') {
      if (entry.enabled !== false) return false;
    } else if (this._filterMode === 'always') {
      if (mode !== 'always') return false;
    }
    if (isBuiltin && this._categoryFilter !== 'all') {
      const cat = entry.v2Category || entry.category || 'other';
      if (cat !== this._categoryFilter) return false;
    }
    const query = this._searchQuery.trim().toLowerCase();
    if (!query) return true;
    const cat = entry.v2Category || entry.category || 'other';
    const catLabel = BUILTIN_CATEGORY_LABELS[cat] || '';
    return (entry.title || '').toLowerCase().includes(query)
      || (entry._originalTitle || '').toLowerCase().includes(query)
      || (entry.keys || []).some(k => k.toLowerCase().includes(query))
      || catLabel.toLowerCase().includes(query);
  }

  _render() {
    const query = this._searchQuery.trim().toLowerCase();
    const builtinSearch = this._builtin.filter(b => this._matchesFilter(b, true));
    const customSearch = this._custom.filter(c => this._matchesFilter(c, false));

    const builtinEnabledCount = this._builtin.filter(e => e.enabled !== false).length;
    const builtinModifiedCount = this._builtin.filter(e => e._overridden).length;
    const builtinOverrideCount = this._builtin.filter(e => e._hasOverride).length;
    const builtinSearchEnabled = builtinSearch.filter(e => e.enabled !== false).length;
    const builtinSearchModified = builtinSearch.filter(e => e._overridden).length;
    const enabledCount = this._custom.filter(e => e.enabled !== false).length;

    const hasActiveFilter = this._filterMode !== 'all' || this._categoryFilter !== 'all' || Boolean(query);
    const showBuiltinList = this._builtinExpanded || hasActiveFilter;

    const selectedEntry = this._selectedType === 'custom' && this._selectedIndex >= 0 && this._selectedIndex < this._custom.length
      ? this._custom[this._selectedIndex] : (this._selectedType === 'builtin' && this._selectedIndex >= 0 && this._selectedIndex < this._builtin.length
      ? this._builtin[this._selectedIndex] : null);
    const isBuiltin = this._selectedType === 'builtin';
    const activation = selectedEntry ? normalizeWorldbookActivation(selectedEntry) : null;
    const modeLabel = activation?.mode === 'always'
      ? '蓝灯 · 常驻注入'
      : activation?.mode === 'manual'
        ? '手动 · 仅显式调用'
        : '绿灯 · 关键词激活';
    const mobileViewClass = selectedEntry && !this._mobileShowList ? 'mobile-view-editor' : 'mobile-view-list';
    const categoryKeys = ['all', ...new Set(this._builtin.map(e => e.v2Category || e.category || 'other'))];

    this.shadowRoot.innerHTML = `
      <style>${worldbookStyles}</style>
      <div class="wb-container">
        <div class="wb-header">
          <h2 class="wb-title">
            世界书编辑器
            <span class="wb-stats-pills">
              <span class="wb-stat-pill">内置 ${builtinEnabledCount}/${this._builtin.length}</span>
              ${builtinModifiedCount ? `<span class="wb-stat-pill is-accent">已改 ${builtinModifiedCount}</span>` : ''}
              <span class="wb-stat-pill is-gold">自定义 ${enabledCount}/${this._custom.length}</span>
            </span>
          </h2>
          <div class="wb-actions">
            <button class="btn" id="btn-export" type="button">导出</button>
            <button class="btn" id="btn-import" type="button">导入</button>
            <button class="btn danger" id="btn-restore" type="button">恢复默认</button>
            <button class="btn" id="btn-close" type="button">返回</button>
            <input type="file" id="file-import" accept=".json" hidden />
          </div>
        </div>
        <div class="wb-body ${mobileViewClass}">
          <div class="wb-sidebar">
            <div class="wb-sidebar-top">
              <div class="wb-search-wrap">
                <span class="wb-search-icon" aria-hidden="true">${icon('search', 14)}</span>
                <input type="text" class="wb-search-input" id="search-input" placeholder="搜索标题、关键词或分类..." value="${escAttr(this._searchQuery)}">
                ${this._searchQuery ? '<button class="wb-search-clear" id="btn-clear-search" type="button" title="清空搜索" aria-label="清空搜索">×</button>' : ''}
              </div>
              <div class="wb-filter-pills" role="group" aria-label="条目状态筛选">
                ${FILTER_OPTIONS.map(([key, label]) => `<button type="button" class="wb-filter-pill${this._filterMode === key ? ' active' : ''}" data-filter="${key}">${label}</button>`).join('')}
              </div>
              ${showBuiltinList ? `
                <select class="wb-category-select" id="wb-category-filter" aria-label="内置分类筛选">
                  ${categoryKeys.map(key => `<option value="${escAttr(key)}" ${this._categoryFilter === key ? 'selected' : ''}>${escHtml(BUILTIN_CATEGORY_LABELS[key] || key)}</option>`).join('')}
                </select>
              ` : ''}
            </div>
            <div class="wb-list" id="entry-list">
              <div class="wb-section-hdr" id="toggle-builtin" role="button" tabindex="0" aria-expanded="${showBuiltinList}">
                <span>内置世界书</span>
                <span class="count">${builtinSearch.length} 条 · 启用 ${builtinSearchEnabled}${builtinSearchModified ? ` · 已改 ${builtinSearchModified}` : ''}</span>
                <span class="wb-section-chevron">${showBuiltinList ? '▾' : '▸'}</span>
              </div>
              ${showBuiltinList ? `
                <div class="wb-builtin-toolbar">
                  <button class="btn sm good" id="btn-builtin-enable-all" type="button">内置全开</button>
                  <button class="btn sm" id="btn-builtin-disable-all" type="button">内置全关</button>
                  ${builtinOverrideCount > 0 ? `<button class="btn sm danger" id="btn-builtin-reset-all" type="button">重置内置(${builtinOverrideCount})</button>` : ''}
                </div>
                ${builtinSearch.map(e => {
                  const mode = e.activation?.mode || (e.isAlwaysOn ? 'always' : 'keyword');
                  const isActive = this._selectedType === 'builtin' && this._selectedIndex === e._idx;
                  const cat = BUILTIN_CATEGORY_LABELS[e.v2Category || e.category || 'other'] || '';
                  return `
                <div class="wb-item${isActive ? ' active' : ''}${e.enabled === false ? ' is-disabled' : ''}" data-type="builtin" data-idx="${e._idx}" role="button" tabindex="0" aria-selected="${isActive}">
                  <div class="wb-item-toggle ${e.enabled !== false ? 'on' : ''}" data-action="toggle" data-type="builtin" data-idx="${e._idx}" role="switch" tabindex="0" aria-checked="${e.enabled !== false}" title="${e.enabled !== false ? '已启用' : '已关闭'}"></div>
                  <div class="wb-item-main">
                    <div class="wb-item-top">
                      <span class="wb-item-title">${escHtml(e.title || '无标题')}</span>
                      <span class="wb-builtin-tag${e._overridden ? ' modified' : ''}">${e._overridden ? '已改' : '内置'}</span>
                    </div>
                    <div class="wb-item-sub">
                      <span class="wb-item-meta" data-mode="${escAttr(mode)}">${mode === 'always' ? '蓝灯 · 常驻' : mode === 'manual' ? '手动' : `绿灯 · ${(e.keys || []).length} 关键词`}${cat ? ` · ${escHtml(cat)}` : ''}</span>
                    </div>
                  </div>
                </div>`;
                }).join('')}
                ${builtinSearch.length === 0 ? '<div class="wb-empty-list">没有匹配的内置条目</div>' : ''}
              ` : ''}
              <div class="wb-section-hdr" style="margin-top:6px;">
                <span>自定义世界书</span>
                <span class="count">${customSearch.length} 条${customSearch.length ? ` · 启用 ${customSearch.filter(e => e.enabled !== false).length}` : ''}</span>
              </div>
              ${customSearch.map(e => {
                const mode = e.activation?.mode || 'keyword';
                const isActive = this._selectedType === 'custom' && this._selectedIndex === e._idx;
                return `
                <div class="wb-item${isActive ? ' active' : ''}${e.enabled === false ? ' is-disabled' : ''}" data-type="custom" data-idx="${e._idx}" role="button" tabindex="0" aria-selected="${isActive}">
                  <div class="wb-item-toggle ${e.enabled !== false ? 'on' : ''}" data-action="toggle" data-type="custom" data-idx="${e._idx}" role="switch" tabindex="0" aria-checked="${e.enabled !== false}" title="${e.enabled !== false ? '已启用' : '已禁用'}"></div>
                  <div class="wb-item-main">
                    <div class="wb-item-top">
                      <span class="wb-item-title">${escHtml(e.title || '无标题')}</span>
                    </div>
                    <div class="wb-item-sub">
                      <span class="wb-item-meta" data-mode="${escAttr(mode)}">${mode === 'always' ? '蓝灯 · 常驻' : mode === 'manual' ? '手动' : `绿灯 · ${(e.keys || []).length} 关键词`}</span>
                    </div>
                  </div>
                </div>`;
              }).join('')}
              ${customSearch.length === 0 ? '<div class="wb-empty-list">暂无匹配的自定义条目<br>可点击「导入」或下方「+ 新建」添加</div>' : ''}
            </div>
            <div class="wb-sidebar-foot">
              <button class="btn primary sm" id="btn-add" type="button">+ 新建</button>
              <button class="btn sm good" id="btn-enable-all" type="button">全部启用</button>
              <button class="btn sm ghost" id="btn-disable-all" type="button">全部禁用</button>
            </div>
          </div>
          <div class="wb-editor">
            ${selectedEntry ? `
              <div class="wb-mobile-bar">
                <button class="btn sm ghost" id="btn-mobile-back" type="button">← 返回条目列表</button>
                <span class="wb-source-badge${isBuiltin && selectedEntry._hasOverride ? ' is-modified' : ''}">${isBuiltin ? (selectedEntry._overridden ? '内置 · 已本地改写' : '内置条目') : '自定义条目'}</span>
              </div>
              <div class="wb-editor-head">
                <div class="wb-mount-group">
                  <span class="wb-source-badge${isBuiltin && selectedEntry._hasOverride ? ' is-modified' : ''}">${isBuiltin ? (selectedEntry._overridden ? '内置 · 已改写' : '内置世界书') : '自定义条目'}</span>
                  <div class="wb-item-toggle ${selectedEntry.enabled !== false ? 'on' : ''}" id="entry-toggle" role="switch" tabindex="0" aria-checked="${selectedEntry.enabled !== false}" title="${selectedEntry.enabled !== false ? '已启用挂载' : '已禁用挂载'}"></div>
                  <span class="wb-mount-label">${selectedEntry.enabled !== false ? '已挂载 · 参与上下文匹配' : '已停用 · 不会注入 AI 上下文'}</span>
                </div>
                <div class="wb-editor-actions">
                  ${isBuiltin && selectedEntry._hasOverride ? '<button class="btn sm" id="btn-restore-builtin-entry" type="button">恢复此条默认</button>' : ''}
                  ${isBuiltin ? '<button class="btn sm" id="btn-copy-to-custom" type="button">另存为自定义副本</button>' : '<button class="btn danger sm" id="btn-delete" type="button">删除此条目</button>'}
                </div>
              </div>
              ${isBuiltin ? `<div class="wb-builtin-banner${selectedEntry._hasOverride ? ' modified' : ''}">
                <div class="wb-builtin-banner-copy">
                  <strong>${selectedEntry._overridden ? '已本地改写此内置条目' : (selectedEntry.enabled === false ? '已关闭此内置条目' : '内置世界书条目支持直接编辑与单独开关')}</strong>
                  <span>本地修改与启停不会影响默认设定文件；随时可通过「恢复此条默认」还原。</span>
                </div>
              </div>` : ''}
              <div class="wb-card">
                <div class="wb-form-group">
                  <label class="wb-form-label" for="entry-title">条目标题</label>
                  <input type="text" class="wb-input wb-title-input" id="entry-title" value="${escAttr(selectedEntry.title || '')}" placeholder="条目名称">
                </div>
                <div class="wb-form-group">
                  <label class="wb-form-label" for="entry-mode">触发模式</label>
                  <div class="wb-mode-row">
                    <select class="wb-input" id="entry-mode">
                      <option value="keyword" ${activation.mode === 'keyword' ? 'selected' : ''}>绿灯 · 关键词触发</option>
                      <option value="always" ${activation.mode === 'always' ? 'selected' : ''}>蓝灯 · 常驻</option>
                      <option value="manual" ${activation.mode === 'manual' ? 'selected' : ''}>手动 · 不自动注入</option>
                    </select>
                    <span class="wb-mode-badge" data-mode="${escAttr(activation.mode)}">${modeLabel}</span>
                  </div>
                  <div class="wb-hint">关闭条目不会注入；绿灯需命中主关键词，无关键词时不触发；蓝灯常驻优先注入（仍受上下文预算限制）。</div>
                </div>
                <div class="wb-form-group">
                  <label class="wb-form-label" for="entry-keys">触发关键词（逗号分隔）</label>
                  <input type="text" class="wb-input" id="entry-keys" value="${escAttr((selectedEntry.keys || []).join(', '))}" placeholder="关键词1, 关键词2">
                  <div class="wb-keys-chips" id="entry-keys-preview">${renderKeyChipsHtml(selectedEntry.keys)}</div>
                </div>
                <div class="wb-form-group">
                  <label class="wb-form-label" for="entry-secondary-keys">次关键词过滤与匹配逻辑</label>
                  <div class="wb-secondary-grid">
                    <input class="wb-input" id="entry-secondary-keys" value="${escAttr(activation.secondary_keys.join(', '))}" placeholder="先命中主关键词，再判断此处条件">
                    <select class="wb-input" id="entry-selective">
                      ${[['off', '不使用次关键词'], ['and_any', '至少命中一个次关键词'], ['and_all', '必须命中全部次关键词'], ['not_any', '不得命中任何次关键词'], ['not_all', '不能同时命中全部次关键词']].map(([value, label]) => `<option value="${value}" ${(!activation.selective ? value === 'off' : value === activation.selective_logic) ? 'selected' : ''}>${label}</option>`).join('')}
                    </select>
                  </div>
                  ${activation.case_sensitive || activation.match_whole_words ? `<div class="wb-hint">已保留导入规则：${[activation.case_sensitive && '区分大小写', activation.match_whole_words && '完整词匹配'].filter(Boolean).join('、')}。</div>` : ''}
                </div>
              </div>
              <div class="wb-card wb-content-card">
                <div class="wb-form-row-head">
                  <label class="wb-form-label" for="entry-content">设定正文内容</label>
                  <span class="wb-counter" id="entry-content-stats">${formatContentStats(selectedEntry.content || '')}</span>
                </div>
                <textarea class="wb-input wb-textarea" id="entry-content" placeholder="填写世界观、人物设定、组织规则或补充上下文...">${escHtml(selectedEntry.content || '')}</textarea>
              </div>
            ` : `
              <div class="wb-editor-empty">
                <div class="wb-empty-icon" aria-hidden="true">${icon('book-open', 22)}</div>
                <strong>从左侧选择一个条目开始编辑</strong>
                <span>共内置 ${this._builtin.length} 条预设世界书与 ${this._custom.length} 条自定义条目，均可单独启用、停用或修改内容。</span>
                <div class="wb-empty-actions">
                  <button class="btn primary sm" id="btn-empty-new" type="button">+ 新建自定义条目</button>
                  <button class="btn sm" id="btn-empty-builtin" type="button">${showBuiltinList ? '收起内置条目' : '浏览内置世界书'}</button>
                </div>
              </div>
            `}
          </div>
        </div>
      </div>
    `;
  }

  _bindEvents() {
    const root = this.shadowRoot;
    for (const id of ['entry-mode', 'entry-selective', 'entry-secondary-keys', 'entry-keys', 'entry-title', 'entry-content']) {
      root.querySelector(`#${id}`)?.addEventListener('change', () => {
        const savedType = this._saveCurrentEdit();
        if (id === 'entry-mode' || id === 'entry-selective') {
          this._rerenderWithView();
        } else if (savedType === 'builtin') {
          const activeItem = root.querySelector(`.wb-item[data-type="builtin"][data-idx="${this._selectedIndex}"]`);
          const entry = this._builtin[this._selectedIndex];
          if (activeItem && entry) {
            const titleEl = activeItem.querySelector('.wb-item-title');
            if (titleEl) titleEl.textContent = entry.title || '无标题';
            const tagEl = activeItem.querySelector('.wb-builtin-tag');
            if (tagEl) {
              tagEl.textContent = '已改';
              tagEl.classList.add('modified');
            }
            const metaEl = activeItem.querySelector('.wb-item-meta');
            if (metaEl && entry.activation?.mode === 'keyword') {
              const cat = BUILTIN_CATEGORY_LABELS[entry.v2Category || entry.category || 'other'] || '';
              metaEl.textContent = `绿灯 · ${(entry.keys || []).length} 关键词${cat ? ` · ${cat}` : ''}`;
            }
          }
        } else if (savedType === 'custom') {
          const activeItem = root.querySelector(`.wb-item[data-type="custom"][data-idx="${this._selectedIndex}"]`);
          const entry = this._custom[this._selectedIndex];
          if (activeItem && entry) {
            const titleEl = activeItem.querySelector('.wb-item-title');
            if (titleEl) titleEl.textContent = entry.title || '无标题';
            const metaEl = activeItem.querySelector('.wb-item-meta');
            if (metaEl && entry.activation?.mode === 'keyword') {
              metaEl.textContent = `绿灯 · ${(entry.keys || []).length} 关键词`;
            }
          }
        }
      });
    }

    root.querySelector('#entry-content')?.addEventListener('input', (e) => {
      const counter = root.querySelector('#entry-content-stats');
      if (counter) counter.textContent = formatContentStats(e.target.value);
    });
    root.querySelector('#entry-keys')?.addEventListener('input', (e) => {
      const preview = root.querySelector('#entry-keys-preview');
      if (preview) preview.innerHTML = renderKeyChipsHtml(worldbookKeys(e.target.value));
    });

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

    root.querySelector('#btn-clear-search')?.addEventListener('click', () => {
      this._captureCurrentEdit();
      const snapshot = this._captureViewState();
      this._searchQuery = '';
      this._rerenderWithView({ snapshot, listScrollTop: 0, focusSelector: '#search-input' });
    });

    root.querySelectorAll('.wb-filter-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        this._saveCurrentEdit({ silent: true });
        const snapshot = this._captureViewState();
        this._filterMode = pill.dataset.filter || 'all';
        this._rerenderWithView({ snapshot, listScrollTop: 0, focusSelector: `.wb-filter-pill[data-filter="${this._filterMode}"]` });
      });
    });

    root.querySelector('#wb-category-filter')?.addEventListener('change', (e) => {
      this._saveCurrentEdit({ silent: true });
      const snapshot = this._captureViewState();
      this._categoryFilter = e.target.value || 'all';
      this._rerenderWithView({ snapshot, listScrollTop: 0, focusSelector: '#wb-category-filter' });
    });

    root.querySelector('#toggle-builtin')?.addEventListener('click', () => {
      this._captureCurrentEdit();
      const snapshot = this._captureViewState();
      this._builtinExpanded = !this._builtinExpanded;
      if (!this._builtinExpanded) {
        this._filterMode = 'all';
        this._categoryFilter = 'all';
      }
      this._rerenderWithView({ snapshot, focusSelector: '#toggle-builtin' });
    });

    root.querySelector('#btn-empty-builtin')?.addEventListener('click', () => {
      this._builtinExpanded = !this._builtinExpanded;
      this._rerenderWithView({ listScrollTop: 0, focusSelector: '#toggle-builtin' });
    });
    root.querySelector('#btn-empty-new')?.addEventListener('click', () => {
      root.querySelector('#btn-add')?.click();
    });

    root.querySelector('#btn-mobile-back')?.addEventListener('click', () => {
      this._saveCurrentEdit({ silent: true });
      this._mobileShowList = true;
      this._rerenderWithView({ focusSelector: '#search-input' });
    });

    root.querySelector('#btn-builtin-enable-all')?.addEventListener('click', () => this._toggleAllBuiltin(true));
    root.querySelector('#btn-builtin-disable-all')?.addEventListener('click', () => this._toggleAllBuiltin(false));
    root.querySelector('#btn-builtin-reset-all')?.addEventListener('click', async () => {
      const confirmed = await GameModal.confirm({
        title: '重置全部内置条目',
        message: '将清除所有内置世界书条目的本地修改与开关状态，恢复为默认设定。自定义条目不受影响。继续？',
        okLabel: '确认重置',
        cancelLabel: '取消'
      });
      if (confirmed) {
        const snapshot = this._captureViewState();
        KNOWLEDGE_BASE.clearBuiltinOverrides();
        this._builtin = KNOWLEDGE_BASE.getBuiltinEntries({ includeDisabled: true }).map((e, i) => ({ ...e, _idx: i }));
        eventBus.emit('app:toast', '已将全部内置世界书恢复为默认');
        this._rerenderWithView({ snapshot, focusSelector: '#toggle-builtin' });
      }
    });

    root.querySelector('#btn-add')?.addEventListener('click', () => {
      this._saveCurrentEdit({ silent: true });
      this._custom.push({ title: '新条目', keys: [], content: '', source: 'custom', enabled: true, _idx: this._custom.length });
      this._selectedType = 'custom';
      this._selectedIndex = this._custom.length - 1;
      this._searchQuery = '';
      this._filterMode = 'all';
      this._mobileShowList = false;
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

    root.querySelector('#btn-restore-builtin-entry')?.addEventListener('click', () => {
      if (this._selectedType !== 'builtin' || this._selectedIndex < 0 || this._selectedIndex >= this._builtin.length) return;
      const target = this._builtin[this._selectedIndex];
      const snapshot = this._captureViewState();
      const restored = KNOWLEDGE_BASE.resetBuiltinEntry(target._builtinKey || target);
      if (restored) {
        this._builtin[this._selectedIndex] = { ...restored, _idx: this._selectedIndex };
        eventBus.emit('app:toast', `已恢复内置条目「${restored.title}」为默认`);
      }
      this._rerenderWithView({ snapshot, editorScrollTop: 0, focusSelector: '#entry-title' });
    });

    root.querySelector('#btn-copy-to-custom')?.addEventListener('click', () => {
      if (this._selectedType !== 'builtin' || this._selectedIndex < 0 || this._selectedIndex >= this._builtin.length) return;
      this._saveCurrentEdit({ silent: true });
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
      this._filterMode = 'all';
      this._mobileShowList = false;
      this._save();
      this._rerenderWithView({ listScrollTop: 0, editorScrollTop: 0, focusSelector: '#entry-title', revealActive: true });
    });

    const entryToggle = root.querySelector('#entry-toggle');
    entryToggle?.addEventListener('click', () => {
      if (this._selectedIndex < 0) return;
      if (this._selectedType === 'custom' && this._selectedIndex < this._custom.length) {
        this._captureCurrentEdit();
        const snapshot = this._captureViewState();
        this._custom[this._selectedIndex].enabled = !(this._custom[this._selectedIndex].enabled !== false);
        this._save();
        this._rerenderWithView({ snapshot, focusSelector: '#entry-toggle' });
      } else if (this._selectedType === 'builtin' && this._selectedIndex < this._builtin.length) {
        this._captureCurrentEdit();
        const snapshot = this._captureViewState();
        this._builtin[this._selectedIndex].enabled = !(this._builtin[this._selectedIndex].enabled !== false);
        const updated = this._saveBuiltinIndex(this._selectedIndex, { silent: true });
        eventBus.emit('app:toast', `${updated?.enabled !== false ? '已启用' : '已关闭'}内置条目「${updated?.title || ''}」`);
        this._rerenderWithView({ snapshot, focusSelector: '#entry-toggle' });
      }
    });
    entryToggle?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        entryToggle.click();
      }
    });

    const allItems = root.querySelectorAll('.wb-item');
    allItems.forEach(item => {
      item.addEventListener('click', (e) => {
        const toggleEl = e.target.closest('.wb-item-toggle');
        if (toggleEl) return;
        const prevIndex = this._selectedIndex;
        const captured = this._captureCurrentEdit();
        const snapshot = this._captureViewState();
        if (captured === 'custom') this._save();
        else if (captured === 'builtin') this._saveBuiltinIndex(prevIndex);
        const type = item.dataset.type;
        if (type === 'builtin') {
          const idx = parseInt(item.dataset.idx, 10);
          if (idx >= 0 && idx < this._builtin.length) { this._selectedType = 'builtin'; this._selectedIndex = idx; }
        } else if (type === 'custom') {
          const idx = parseInt(item.dataset.idx, 10);
          if (idx >= 0 && idx < this._custom.length) { this._selectedType = 'custom'; this._selectedIndex = idx; }
        }
        this._mobileShowList = false;
        this._rerenderWithView({
          snapshot,
          editorScrollTop: 0,
          focusSelector: '#entry-title'
        });
      });
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          item.click();
        }
      });
    });

    const toggles = root.querySelectorAll('#entry-list .wb-item-toggle');
    toggles.forEach(t => {
      t.addEventListener('click', (e) => {
        e.stopPropagation();
        const type = t.dataset.type === 'builtin' ? 'builtin' : 'custom';
        const idx = parseInt(t.dataset.idx, 10);
        if (type === 'builtin' && idx >= 0 && idx < this._builtin.length) {
          const prevIndex = this._selectedIndex;
          const captured = this._captureCurrentEdit();
          const snapshot = this._captureViewState();
          if (captured === 'custom') this._save();
          else if (captured === 'builtin' && prevIndex !== idx) this._saveBuiltinIndex(prevIndex);
          this._builtin[idx].enabled = !(this._builtin[idx].enabled !== false);
          const updated = this._saveBuiltinIndex(idx, { silent: true });
          eventBus.emit('app:toast', `${updated?.enabled !== false ? '已启用' : '已关闭'}内置条目「${updated?.title || ''}」`);
          this._rerenderWithView({ snapshot, focusSelector: `.wb-item-toggle[data-type="builtin"][data-idx="${idx}"]` });
        } else if (type === 'custom' && idx >= 0 && idx < this._custom.length) {
          const prevIndex = this._selectedIndex;
          const captured = this._captureCurrentEdit();
          const snapshot = this._captureViewState();
          if (captured === 'builtin') this._saveBuiltinIndex(prevIndex);
          this._custom[idx].enabled = !(this._custom[idx].enabled !== false);
          this._save();
          this._rerenderWithView({ snapshot, focusSelector: `.wb-item-toggle[data-type="custom"][data-idx="${idx}"]` });
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

  _saveCurrentEdit({ silent = false } = {}) {
    const captured = this._captureCurrentEdit();
    if (captured === 'custom') {
      this._save();
      return 'custom';
    }
    if (captured === 'builtin') {
      this._saveBuiltinIndex(this._selectedIndex, { silent });
      return 'builtin';
    }
    return false;
  }
}

customElements.define('worldbook-editor', WorldbookEditor);
