import { CANON_DATABASE, displayCanonTechniqueName, normalizeCanonDate } from '../data/canon-database.js';
import { escHtml, escAttr } from '../utils/format.js';
import { eventBus } from '../core/event-bus.js';
import GameModal from './modal.js';

const PAGE_SIZE = 40;
const KIND_META = Object.freeze({
  plot: { title: '剧情数据库', idPrefix: 'DAY-P1-CUSTOM', search: '搜索日期、DAY/SCN/EV、线程、地点或剧情内容' },
  techniques: { title: '忍术数据库', idPrefix: 'JT-CUSTOM', search: '搜索 JT、术名、别名、类别或属性' }
});
const TYPE_OPTIONS = ['jutsu', 'genjutsu', 'taijutsu', 'support'];
const RESOURCE_OPTIONS = ['chakra', 'spirit', 'stamina'];
const RESOLUTION_OPTIONS = ['interactive', 'offscreen', 'conditional'];
const BEAT_ROLE_OPTIONS = ['setup', 'pressure', 'choice', 'turn', 'resolution', 'transition'];
const TIMELINE_NAMESPACE_OPTIONS = ['HIST', 'P1', 'P2', 'BOR'];

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function linesToArray(value) { return String(value || '').split(/[,，\n]/).map(item => item.trim()).filter(Boolean); }
function arrayToLines(value) { return (Array.isArray(value) ? value : []).join('\n'); }
function number(value, fallback = 0) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function json(value) { return JSON.stringify(value ?? [], null, 2); }
function timelineNamespace(value) {
  return String(value || '').match(/^(?:DAY|SCN|EV|THR|ARC)-(HIST|P1|P2|BOR)-/)?.[1] || 'P1';
}
function replaceTimelineNamespace(value, namespace) {
  return String(value || '').replace(/^((?:DAY|SCN|EV|THR|ARC))-(?:HIST|P1|P2|BOR)-/, `$1-${namespace}-`);
}

class CanonDatabaseEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._page = 0;
    this._query = '';
    this._selectedId = '';
    this._draft = null;
    this._isNew = false;
    this._idCounter = 0;
    this._dirty = false;
  }

  connectedCallback() {
    this._kind = this.databaseKind || this.getAttribute('database-kind') || 'plot';
    if (!KIND_META[this._kind]) this._kind = 'plot';
    this._render();
  }

  _records() {
    const records = CANON_DATABASE.getRecords(this._kind, { includeDisabled: true });
    const query = this._query.normalize('NFKC').toLowerCase().trim();
    const filtered = !query ? records : records.filter(record => this._searchText(record).includes(query));
    return [...filtered].sort((a, b) => this._kind === 'plot'
      ? String(a.date || '').localeCompare(String(b.date || '')) || a.id.localeCompare(b.id)
      : String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN') || a.id.localeCompare(b.id));
  }

  _searchText(record) {
    const parts = this._kind === 'plot'
      ? [
          record.id, record.date, record.title, record.arc_id, record.day_goal, record.transition,
          JSON.stringify(record.year_snapshot),
          ...(record.start_state || []), ...(record.end_state || []), ...(record.reference_facts || []),
          ...(record.scenes || []).flatMap(scene => [
            scene.id, scene.title, scene.thread_id, scene.location, scene.setup, scene.stop_condition,
            ...(scene.participants || []), ...(scene.requirements || []), ...(scene.blockers || []),
            ...(scene.outcomes || []), ...(scene.state_changes || []), ...(scene.reference_facts || []),
            ...(scene.beats || []).flatMap(beatItem => [beatItem.id, beatItem.summary, beatItem.causal_role])
          ])
        ]
      : [record.id, record.name, record.type, record.rank, record.resource, record.summary, ...(record.aliases || []), ...(record.classes || []), ...(record.elements || [])];
    return parts.filter(Boolean).join(' ').normalize('NFKC').toLowerCase();
  }

  _render() {
    const meta = KIND_META[this._kind];
    const records = this._records();
    const stats = CANON_DATABASE.getStats(this._kind);
    const pageCount = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
    this._page = Math.min(this._page, pageCount - 1);
    const pageRecords = records.slice(this._page * PAGE_SIZE, (this._page + 1) * PAGE_SIZE);
    const current = this._draft || (this._selectedId ? CANON_DATABASE.getRecord(this._kind, this._selectedId, { includeDisabled: true }) : null);
    this.shadowRoot.innerHTML = `
      <style>${this._styles()}</style>
      <div class="db-shell" role="dialog" aria-modal="true" aria-label="${meta.title}">
        <header class="db-head">
          <div class="db-heading"><strong>${meta.title}</strong><span>${stats.effective} 条启用 · ${stats.modified} 条修改 · ${stats.custom} 条新增 · ${stats.disabled} 条停用</span></div>
          <div class="db-actions">
            <input id="db-import-file" type="file" accept=".json,application/json">
            <button class="btn" data-action="import">导入修改</button>
            <button class="btn" data-action="export-overrides">导出修改</button>
            <button class="btn" data-action="export-effective">导出有效数据</button>
            <button class="btn danger" data-action="reset-all">全部恢复</button>
            <button class="btn" data-action="close">关闭</button>
          </div>
        </header>
        <div class="db-body">
          <aside class="db-sidebar">
            <div class="db-search"><input id="db-search" value="${escAttr(this._query)}" placeholder="${meta.search}"><button class="btn primary" data-action="new">新增</button></div>
            <div class="db-list">${pageRecords.length ? pageRecords.map(record => this._listItem(record)).join('') : '<div class="empty">没有匹配记录</div>'}</div>
            <div class="db-pager"><button class="icon-btn" data-action="prev" title="上一页" ${this._page <= 0 ? 'disabled' : ''}>‹</button><span>${this._page + 1} / ${pageCount} · ${records.length} 条</span><button class="icon-btn" data-action="next" title="下一页" ${this._page >= pageCount - 1 ? 'disabled' : ''}>›</button></div>
          </aside>
          <main class="db-editor">${current ? this._form(current) : '<div class="empty editor-empty">选择左侧记录，或新增一条记录</div>'}</main>
        </div>
      </div>`;
    this._bind();
  }

  _listItem(record) {
    const status = CANON_DATABASE.getRecordStatus(this._kind, record.id);
    const title = this._kind === 'plot' ? record.title || record.day_goal || record.id : displayCanonTechniqueName(record) || record.id;
    const meta = this._kind === 'plot' ? `${record.date || '无日期'} · ${record.scenes?.length || 0} 个场景` : `${record.type || 'jutsu'} · ${record.rank || '特'} · cost ${record.cost ?? 0}`;
    const selected = record.id === this._selectedId;
    return `<button class="db-item${selected ? ' active' : ''}${status.disabled ? ' disabled' : ''}" data-select="${escAttr(record.id)}">
      <span class="item-main"><strong>${escHtml(title)}</strong><small>${escHtml(record.id)} · ${escHtml(meta)}</small></span>
      ${status.custom ? '<i class="tag custom">新增</i>' : status.overridden ? '<i class="tag changed">已修改</i>' : ''}
      ${status.disabled ? '<i class="tag off">停用</i>' : ''}
    </button>`;
  }

  _form(record) {
    const status = this._isNew ? { custom: true, overridden: false, disabled: false } : CANON_DATABASE.getRecordStatus(this._kind, record.id);
    return `<div class="editor-head"><div><strong>${escHtml(record.id)}</strong><span>${status.custom ? '自定义记录' : status.overridden ? '已覆盖生成数据' : '生成数据'}</span></div>
      <div class="editor-actions">
        ${!this._isNew && !status.custom && (status.overridden || status.disabled) ? '<button class="btn" data-action="reset-one">恢复此条</button>' : ''}
        ${!this._isNew ? `<button class="btn ${status.disabled ? 'good' : 'danger'}" data-action="toggle">${status.disabled ? '启用' : '停用'}</button>` : ''}
        ${!this._isNew && status.custom ? '<button class="btn danger" data-action="delete">删除</button>' : ''}
        <button class="btn primary" data-action="save">保存记录</button>
      </div></div>
      <div class="form-scroll">${this._kind === 'plot' ? this._plotForm(record) : this._techniqueForm(record)}</div>`;
  }

  _field(label, name, value, options = {}) {
    const input = options.type === 'textarea'
      ? `<textarea data-field="${name}" rows="${options.rows || 4}">${escHtml(value ?? '')}</textarea>`
      : options.options
        ? `<select data-field="${name}">${options.options.map(option => `<option value="${escAttr(option)}"${String(value) === option ? ' selected' : ''}>${escHtml(option)}</option>`).join('')}</select>`
        : `<input data-field="${name}" type="${options.type || 'text'}" value="${escAttr(value ?? '')}"${options.min !== undefined ? ` min="${options.min}"` : ''}${options.readonly ? ' readonly' : ''}>`;
    return `<label class="field${options.wide ? ' wide' : ''}"><span>${label}</span>${input}</label>`;
  }

  _plotForm(record) {
    const namespace = timelineNamespace(record.id);
    return `<div class="timeline-day-form">
      <section class="day-fields form-grid">
        ${this._field('剧情日 ID', 'id', record.id, { wide: true, readonly: true })}
        ${this._field('时代命名空间', 'timeline_namespace', namespace, this._isNew ? { options: TIMELINE_NAMESPACE_OPTIONS } : { readonly: true })}
        ${this._field('日期', 'date', record.date)}
        ${this._field('篇章 ID', 'arc_id', record.arc_id)}
        ${this._field('日标题', 'title', record.title, { wide: true })}
        ${this._field('当日叙事目标', 'day_goal', record.day_goal, { type: 'textarea', rows: 4, wide: true })}
        ${this._field('日初世界状态（每行一项）', 'start_state', arrayToLines(record.start_state), { type: 'textarea', rows: 5 })}
        ${this._field('日终基准状态（每行一项）', 'end_state', arrayToLines(record.end_state), { type: 'textarea', rows: 5 })}
        ${this._field('后续转场', 'transition', record.transition, { type: 'textarea', rows: 4, wide: true })}
        ${this._field('日级参考事实（仅背景，每行一项）', 'reference_facts', arrayToLines(record.reference_facts), { type: 'textarea', rows: 4, wide: true })}
        ${record.year_snapshot !== undefined ? this._field('年度快照 JSON', 'year_snapshot', JSON.stringify(record.year_snapshot, null, 2), { type: 'textarea', rows: 24, wide: true }) : ''}
      </section>
      <div class="section-bar"><div><strong>独立场景</strong><span>${record.scenes?.length || 0} / 8</span></div><button class="btn" data-action="add-scene" type="button" ${(record.scenes?.length || 0) >= 8 ? 'disabled' : ''}>新增场景</button></div>
      <div class="scene-list">${(record.scenes || []).map((sceneItem, index) => this._plotSceneForm(sceneItem, index)).join('')}</div>
    </div>`;
  }

  _plotSceneForm(sceneItem, sceneIndex) {
    const prefix = `scene.${sceneIndex}`;
    return `<section class="scene-card" data-scene-card="${sceneIndex}">
      <div class="scene-head"><div><strong>场景 ${sceneIndex + 1} · ${escHtml(sceneItem.title || '未命名')}</strong><span>${escHtml(sceneItem.id || '')}</span></div><button class="btn danger" data-action="remove-scene" data-scene-index="${sceneIndex}" type="button">移除场景</button></div>
      <div class="form-grid scene-fields">
        ${this._field('场景 ID', `${prefix}.id`, sceneItem.id, { wide: true, readonly: true })}
        ${this._field('场景标题', `${prefix}.title`, sceneItem.title)}
        ${this._field('线程 ID', `${prefix}.thread_id`, sceneItem.thread_id)}
        ${this._field('地点', `${prefix}.location`, sceneItem.location)}
        ${this._field('结算方式', `${prefix}.resolution_mode`, sceneItem.resolution_mode || 'interactive', { options: RESOLUTION_OPTIONS })}
        ${this._field('参与者（每行一个）', `${prefix}.participants`, arrayToLines(sceneItem.participants), { type: 'textarea', rows: 4, wide: true })}
        ${this._field('前置条件（每行一项）', `${prefix}.requirements`, arrayToLines(sceneItem.requirements), { type: 'textarea', rows: 4 })}
        ${this._field('阻断条件（每行一项）', `${prefix}.blockers`, arrayToLines(sceneItem.blockers), { type: 'textarea', rows: 4 })}
        ${this._field('开场态势', `${prefix}.setup`, sceneItem.setup, { type: 'textarea', rows: 5, wide: true })}
        ${this._field('基准结果（每行一项）', `${prefix}.outcomes`, arrayToLines(sceneItem.outcomes), { type: 'textarea', rows: 4 })}
        ${this._field('状态变化（每行一项）', `${prefix}.state_changes`, arrayToLines(sceneItem.state_changes), { type: 'textarea', rows: 4 })}
        ${this._field('停止条件', `${prefix}.stop_condition`, sceneItem.stop_condition, { type: 'textarea', rows: 3, wide: true })}
        ${this._field('分支回退 JSON', `${prefix}.fallbacks`, json(sceneItem.fallbacks), { type: 'textarea', rows: 9, wide: true })}
        ${this._field('来源材料 JSON', `${prefix}.source_material`, json(sceneItem.source_material), { type: 'textarea', rows: 7, wide: true })}
        ${this._field('设计理由', `${prefix}.design_rationale`, sceneItem.design_rationale, { type: 'textarea', rows: 4, wide: true })}
        ${this._field('场景参考事实（仅背景，每行一项）', `${prefix}.reference_facts`, arrayToLines(sceneItem.reference_facts), { type: 'textarea', rows: 4, wide: true })}
      </div>
      <div class="beat-section">
        <div class="section-bar compact"><div><strong>原子节拍</strong><span>${sceneItem.beats?.length || 0} 条</span></div><button class="btn" data-action="add-beat" data-scene-index="${sceneIndex}" type="button">新增节拍</button></div>
        <div class="beat-list">${(sceneItem.beats || []).map((beatItem, beatIndex) => this._plotBeatForm(beatItem, sceneIndex, beatIndex)).join('')}</div>
      </div>
    </section>`;
  }

  _plotBeatForm(beatItem, sceneIndex, beatIndex) {
    const prefix = `scene.${sceneIndex}.beat.${beatIndex}`;
    return `<div class="beat-card" data-beat-card="${beatIndex}" data-scene-index="${sceneIndex}">
      <div class="beat-index">${beatIndex + 1}</div>
      <div class="beat-fields">
        ${this._field('节拍 ID', `${prefix}.id`, beatItem.id, { readonly: true })}
        ${this._field('顺序', `${prefix}.order`, beatItem.order ?? (beatIndex + 1) * 10, { type: 'number', min: 1 })}
        ${this._field('因果角色', `${prefix}.causal_role`, beatItem.causal_role || 'setup', { options: BEAT_ROLE_OPTIONS })}
        ${this._field('节拍内容', `${prefix}.summary`, beatItem.summary, { type: 'textarea', rows: 3, wide: true })}
      </div>
      <button class="icon-btn danger" data-action="remove-beat" data-scene-index="${sceneIndex}" data-beat-index="${beatIndex}" type="button" title="移除节拍">×</button>
    </div>`;
  }

  _techniqueForm(record) {
    const access = record.access || {};
    const availability = record.availability || {};
    return `<div class="form-grid">
      ${this._field('忍术 ID', 'id', record.id, { wide: true, readonly: true })}
      ${this._field('中文显示名', 'displayNamePreview', displayCanonTechniqueName(record), { wide: true, readonly: true })}
      ${this._field('原始检索名', 'name', record.name)}
      ${this._field('类别', 'type', record.type || 'jutsu', { options: TYPE_OPTIONS })}
      ${this._field('等级', 'rank', record.rank || '特')}
      ${this._field('资源', 'resource', record.resource || 'chakra', { options: RESOURCE_OPTIONS })}
      ${this._field('消耗 cost', 'cost', record.cost ?? 0, { type: 'number', min: 0 })}
      ${this._field('威力 power', 'power', record.power ?? 0, { type: 'number', min: 0 })}
      ${this._field('威力模式', 'powerMode', record.powerMode || 'none')}
      ${this._field('审核标记', 'review', record.review)}
      ${this._field('检索别名（可含原文/英文，每行一个）', 'aliases', arrayToLines(record.aliases), { type: 'textarea', rows: 5, wide: true })}
      ${this._field('类别标签（每行一个）', 'classes', arrayToLines(record.classes), { type: 'textarea', rows: 4 })}
      ${this._field('属性（每行一个）', 'elements', arrayToLines(record.elements), { type: 'textarea', rows: 4 })}
      ${this._field('机制摘要', 'summary', record.summary, { type: 'textarea', rows: 8, wide: true })}
      ${this._field('限制（每行一个）', 'limitations', arrayToLines(record.limitations), { type: 'textarea', rows: 5, wide: true })}
      ${this._field('学习限制', 'restriction', access.restriction || 'unknown', { wide: true })}
      ${this._field('所需血继（每行一个）', 'requiredBloodlines', arrayToLines(access.required_bloodlines), { type: 'textarea', rows: 4 })}
      ${this._field('前置术（每行一个）', 'requiredTechniques', arrayToLines(access.required_techniques), { type: 'textarea', rows: 4 })}
      ${this._field('所需契约（每行一个）', 'requiredContracts', arrayToLines(access.required_contracts), { type: 'textarea', rows: 4 })}
      ${this._field('已确认使用者 ID', 'users', arrayToLines(record.users), { type: 'textarea', rows: 4 })}
      ${this._field('最早确认日期', 'earliestDate', availability.earliest_confirmed_date || '')}
      ${this._field('首次确认事件', 'firstEventId', availability.first_confirmed_event_id || '')}
      ${this._field('消耗设计 JSON', 'costDesign', record.costDesign ? JSON.stringify(record.costDesign, null, 2) : '', { type: 'textarea', rows: 8, wide: true })}
    </div>`;
  }

  _value(name) { return this.shadowRoot.querySelector(`[data-field="${name}"]`)?.value ?? ''; }

  _jsonValue(name, label, fallback = []) {
    const value = this._value(name).trim();
    if (!value) return clone(fallback);
    try { return JSON.parse(value); }
    catch { throw new Error(`${label} JSON 格式无效`); }
  }

  _readPlotRecord({ validate = true } = {}) {
    const base = clone(this._draft || CANON_DATABASE.getRecord('plot', this._selectedId, { includeDisabled: true }) || {});
    delete base._database;
    const yearSnapshotField = this.shadowRoot.querySelector('[data-field="year_snapshot"]');
    if (yearSnapshotField) {
      try { base.year_snapshot = JSON.parse(yearSnapshotField.value); }
      catch { throw new Error('年度快照 JSON 格式无效'); }
    }
    const date = normalizeCanonDate(this._value('date'));
    if (!date) throw new Error('日期必须使用 K064-03-01 或木叶64年3月1日格式，且每月只有30天');
    const sceneCards = [...this.shadowRoot.querySelectorAll('[data-scene-card]')];
    const scenes = sceneCards.map((card, sceneIndex) => {
      const prefix = `scene.${sceneIndex}`;
      const beatCards = [...this.shadowRoot.querySelectorAll(`[data-beat-card][data-scene-index="${sceneIndex}"]`)];
      const beats = beatCards.map((beatCard, beatIndex) => {
        const beatPrefix = `${prefix}.beat.${beatIndex}`;
        return {
          id: this._value(`${beatPrefix}.id`).trim(),
          order: Math.max(1, Math.round(number(this._value(`${beatPrefix}.order`), (beatIndex + 1) * 10))),
          summary: this._value(`${beatPrefix}.summary`).trim(),
          causal_role: this._value(`${beatPrefix}.causal_role`) || 'setup'
        };
      });
      return {
        id: this._value(`${prefix}.id`).trim(),
        title: this._value(`${prefix}.title`).trim(),
        thread_id: this._value(`${prefix}.thread_id`).trim(),
        location: this._value(`${prefix}.location`).trim(),
        participants: linesToArray(this._value(`${prefix}.participants`)),
        resolution_mode: this._value(`${prefix}.resolution_mode`) || 'interactive',
        requirements: linesToArray(this._value(`${prefix}.requirements`)),
        blockers: linesToArray(this._value(`${prefix}.blockers`)),
        setup: this._value(`${prefix}.setup`).trim(),
        beats,
        outcomes: linesToArray(this._value(`${prefix}.outcomes`)),
        state_changes: linesToArray(this._value(`${prefix}.state_changes`)),
        stop_condition: this._value(`${prefix}.stop_condition`).trim(),
        fallbacks: this._jsonValue(`${prefix}.fallbacks`, `场景 ${sceneIndex + 1} 的分支回退`),
        source_material: this._jsonValue(`${prefix}.source_material`, `场景 ${sceneIndex + 1} 的来源材料`),
        design_rationale: this._value(`${prefix}.design_rationale`).trim(),
        reference_facts: linesToArray(this._value(`${prefix}.reference_facts`))
      };
    });
    const record = {
      ...base,
      id: this._value('id').trim(),
      date,
      title: this._value('title').trim(),
      arc_id: this._value('arc_id').trim(),
      day_goal: this._value('day_goal').trim(),
      start_state: linesToArray(this._value('start_state')),
      scenes,
      end_state: linesToArray(this._value('end_state')),
      transition: this._value('transition').trim(),
      reference_facts: linesToArray(this._value('reference_facts'))
    };
    if (this._isNew) {
      const namespace = TIMELINE_NAMESPACE_OPTIONS.includes(this._value('timeline_namespace'))
        ? this._value('timeline_namespace') : timelineNamespace(record.id);
      record.id = replaceTimelineNamespace(record.id, namespace);
      record.arc_id = replaceTimelineNamespace(record.arc_id, namespace);
      for (const sceneItem of record.scenes) {
        sceneItem.id = replaceTimelineNamespace(sceneItem.id, namespace);
        sceneItem.thread_id = replaceTimelineNamespace(sceneItem.thread_id, namespace);
        for (const beatItem of sceneItem.beats) beatItem.id = replaceTimelineNamespace(beatItem.id, namespace);
      }
    }
    if (!validate) return record;
    if (!record.id || !record.title || !record.arc_id || !record.day_goal || !record.transition) throw new Error('剧情日 ID、标题、篇章、目标和转场不能为空');
    if (!record.start_state.length || !record.end_state.length) throw new Error('日初与日终状态都至少需要一项');
    if (record.scenes.length < 1 || record.scenes.length > 8) throw new Error('每个剧情日必须包含1至8个独立场景');
    const ids = new Set([record.id]);
    for (const [sceneIndex, sceneItem] of record.scenes.entries()) {
      if (!sceneItem.id || !sceneItem.title || !sceneItem.thread_id || !sceneItem.location || !sceneItem.setup || !sceneItem.stop_condition || !sceneItem.design_rationale) {
        throw new Error(`场景 ${sceneIndex + 1} 缺少 ID、标题、线程、地点、态势、停止条件或设计理由`);
      }
      if (ids.has(sceneItem.id)) throw new Error(`重复 ID: ${sceneItem.id}`); ids.add(sceneItem.id);
      for (const key of ['participants', 'requirements', 'blockers', 'outcomes', 'state_changes', 'fallbacks', 'source_material', 'beats']) {
        if (!Array.isArray(sceneItem[key]) || !sceneItem[key].length) throw new Error(`场景 ${sceneIndex + 1} 的 ${key} 至少需要一项`);
      }
      let priorOrder = 0;
      for (const [beatIndex, beatItem] of sceneItem.beats.entries()) {
        if (!beatItem.id || !beatItem.summary) throw new Error(`场景 ${sceneIndex + 1} 的节拍 ${beatIndex + 1} 缺少 ID 或内容`);
        if (ids.has(beatItem.id)) throw new Error(`重复 ID: ${beatItem.id}`); ids.add(beatItem.id);
        if (beatItem.order <= priorOrder) throw new Error(`场景 ${sceneIndex + 1} 的节拍顺序必须严格递增`);
        priorOrder = beatItem.order;
      }
    }
    return record;
  }

  _readRecord() {
    const base = clone(this._draft || CANON_DATABASE.getRecord(this._kind, this._selectedId, { includeDisabled: true }) || {});
    delete base._database;
    if (this._kind === 'plot') return this._readPlotRecord();
    if (!this._value('name').trim()) throw new Error('准确术名不能为空');
    let costDesign = base.costDesign || null;
    const costDesignText = this._value('costDesign').trim();
    if (costDesignText) { try { costDesign = JSON.parse(costDesignText); } catch { throw new Error('消耗设计 JSON 格式无效'); } }
    return {
      ...base, id: this._value('id').trim(), name: this._value('name').trim(), aliases: linesToArray(this._value('aliases')),
      type: this._value('type'), classes: linesToArray(this._value('classes')), rank: this._value('rank').trim() || '特',
      elements: linesToArray(this._value('elements')), resource: this._value('resource'), cost: Math.max(0, number(this._value('cost'))),
      costDesign, power: Math.max(0, number(this._value('power'))), powerMode: this._value('powerMode').trim() || 'none',
      summary: this._value('summary').trim(), limitations: linesToArray(this._value('limitations')), users: linesToArray(this._value('users')), review: this._value('review').trim(),
      access: { ...(base.access || {}), restriction: this._value('restriction').trim() || 'unknown', required_bloodlines: linesToArray(this._value('requiredBloodlines')), required_techniques: linesToArray(this._value('requiredTechniques')), required_contracts: linesToArray(this._value('requiredContracts')) },
      availability: { ...(base.availability || {}), earliest_confirmed_date: normalizeCanonDate(this._value('earliestDate')) || null, first_confirmed_event_id: this._value('firstEventId').trim() || null }
    };
  }

  _bind() {
    const root = this.shadowRoot;
    root.querySelector('[data-action="close"]')?.addEventListener('click', () => this._close());
    root.querySelector('#db-search')?.addEventListener('input', event => {
      const value = event.target.value;
      if (this._dirty && !confirm('放弃当前未保存的修改并开始搜索？')) { event.target.value = this._query; return; }
      this._query = value; this._page = 0; this._selectedId = ''; this._draft = null; this._isNew = false; this._dirty = false;
      this._render();
      const next = this.shadowRoot.querySelector('#db-search');
      next?.focus();
      next?.setSelectionRange(value.length, value.length);
    });
    root.querySelectorAll('[data-select]').forEach(button => button.addEventListener('click', () => this._select(button.dataset.select)));
    root.querySelector('[data-action="prev"]')?.addEventListener('click', () => { this._page--; this._render(); });
    root.querySelector('[data-action="next"]')?.addEventListener('click', () => { this._page++; this._render(); });
    root.querySelector('[data-action="new"]')?.addEventListener('click', () => this._newRecord());
    this._bindEditor();
    root.querySelector('[data-action="reset-all"]')?.addEventListener('click', () => this._resetAll());
    root.querySelector('[data-action="export-overrides"]')?.addEventListener('click', () => this._export(false));
    root.querySelector('[data-action="export-effective"]')?.addEventListener('click', () => this._export(true));
    const file = root.querySelector('#db-import-file');
    root.querySelector('[data-action="import"]')?.addEventListener('click', () => file?.click());
    file?.addEventListener('change', event => this._import(event));
  }

  _bindEditor() {
    const root = this.shadowRoot.querySelector('.db-editor');
    if (!root) return;
    root.querySelector('[data-action="save"]')?.addEventListener('click', () => this._save());
    root.querySelector('[data-action="toggle"]')?.addEventListener('click', () => this._toggle());
    root.querySelector('[data-action="reset-one"]')?.addEventListener('click', () => this._resetOne());
    root.querySelector('[data-action="delete"]')?.addEventListener('click', () => this._delete());
    this._bindForm();
  }

  _bindForm() {
    const root = this.shadowRoot.querySelector('.form-scroll');
    if (!root) return;
    root.querySelector('[data-action="add-scene"]')?.addEventListener('click', () => this._addScene());
    root.querySelectorAll('[data-action="remove-scene"]').forEach(button => button.addEventListener('click', () => this._removeScene(number(button.dataset.sceneIndex))));
    root.querySelectorAll('[data-action="add-beat"]').forEach(button => button.addEventListener('click', () => this._addBeat(number(button.dataset.sceneIndex))));
    root.querySelectorAll('[data-action="remove-beat"]').forEach(button => button.addEventListener('click', () => this._removeBeat(number(button.dataset.sceneIndex), number(button.dataset.beatIndex))));
    root.querySelectorAll('[data-field]').forEach(input => {
      input.addEventListener('input', () => { this._dirty = true; });
      input.addEventListener('change', () => { this._dirty = true; });
    });
  }

  _renderEditor() {
    const editor = this.shadowRoot.querySelector('.db-editor');
    if (!editor) return;
    const current = this._draft || (this._selectedId ? CANON_DATABASE.getRecord(this._kind, this._selectedId, { includeDisabled: true }) : null);
    editor.innerHTML = current ? this._form(current) : '<div class="empty editor-empty">选择左侧记录，或新增一条记录</div>';
    this._bindEditor();
  }

  _renderPlotDraft(focusField) {
    const detail = this.shadowRoot.querySelector('.form-scroll');
    if (!detail || this._kind !== 'plot' || !this._draft) {
      this._renderEditor();
      return;
    }
    detail.innerHTML = this._plotForm(this._draft);
    this._bindForm();
    const target = focusField ? detail.querySelector(`[data-field="${focusField}"]`) : null;
    target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    target?.focus({ preventScroll: true });
  }

  _select(id) {
    if (this._dirty && !confirm('放弃当前未保存的修改？')) return;
    this._selectedId = id; this._draft = null; this._isNew = false; this._dirty = false;
    let selectedButton = null;
    this.shadowRoot.querySelectorAll('[data-select]').forEach(button => {
      const selected = button.dataset.select === id;
      button.classList.toggle('active', selected);
      if (selected) selectedButton = button;
    });
    this._renderEditor();
    selectedButton?.focus({ preventScroll: true });
  }

  _nextSuffix() { return `${Date.now()}-${++this._idCounter}`; }

  _newPlotScene(namespace = 'P1') {
    const suffix = this._nextSuffix();
    return {
      id: `SCN-${namespace}-CUSTOM-${suffix}`,
      title: '自定义场景',
      thread_id: `THR-${namespace}-CUSTOM-${suffix}`,
      location: '待填写地点',
      participants: ['待填写参与者'],
      resolution_mode: 'interactive',
      requirements: ['当前日期已到达，且场景前置仍成立。'],
      blockers: ['玩家造成的分支使该冲突无法照常成立。'],
      setup: '填写本场景开始时已经成立的局势。',
      beats: [{ id: `EV-${namespace}-CUSTOM-${suffix}-01`, order: 10, summary: '填写一个会改变局势的原子节拍。', causal_role: 'setup' }],
      outcomes: ['填写本场景的基准结果。'],
      state_changes: ['填写本场景造成的状态变化。'],
      stop_condition: '填写本场景应该停止并交还玩家的边界。',
      fallbacks: [{ condition: '玩家改变了场景前置。', status: 'altered', direction: '依据当前存档重建局部冲突，不恢复已失效细节。', preserves: '保留仍成立的因果压力。' }],
      source_material: [{ kind: 'original', reference: '用户自定义项目正史', contribution: '提供自定义剧情线。' }],
      design_rationale: '说明该场景为何需要独立存在，以及它承担的游玩功能。',
      reference_facts: []
    };
  }

  _capturePlotDraft() {
    try {
      this._draft = this._readPlotRecord({ validate: false });
      return true;
    } catch (error) {
      GameModal.alert({ title: '无法调整结构', message: error.message });
      return false;
    }
  }

  _addScene() {
    if (this._kind !== 'plot' || !this._capturePlotDraft()) return;
    if (this._draft.scenes.length >= 8) return;
    this._draft.scenes.push(this._newPlotScene(timelineNamespace(this._draft.id)));
    this._dirty = true;
    this._renderPlotDraft(`scene.${this._draft.scenes.length - 1}.title`);
  }

  _removeScene(sceneIndex) {
    if (this._kind !== 'plot' || !this._capturePlotDraft()) return;
    if (this._draft.scenes.length <= 1) {
      GameModal.alert({ title: '无法移除', message: '剧情日至少需要一个场景。' });
      return;
    }
    this._draft.scenes.splice(sceneIndex, 1);
    const neighborIndex = Math.min(sceneIndex, this._draft.scenes.length - 1);
    this._dirty = true;
    this._renderPlotDraft(`scene.${neighborIndex}.title`);
  }

  _addBeat(sceneIndex) {
    if (this._kind !== 'plot' || !this._capturePlotDraft()) return;
    const sceneItem = this._draft.scenes[sceneIndex];
    if (!sceneItem) return;
    const suffix = this._nextSuffix();
    const priorOrder = sceneItem.beats.at(-1)?.order || 0;
    sceneItem.beats.push({ id: `EV-${timelineNamespace(sceneItem.id)}-CUSTOM-${suffix}`, order: priorOrder + 10, summary: '填写新的原子节拍。', causal_role: 'transition' });
    this._dirty = true;
    this._renderPlotDraft(`scene.${sceneIndex}.beat.${sceneItem.beats.length - 1}.summary`);
  }

  _removeBeat(sceneIndex, beatIndex) {
    if (this._kind !== 'plot' || !this._capturePlotDraft()) return;
    const sceneItem = this._draft.scenes[sceneIndex];
    if (!sceneItem) return;
    if (sceneItem.beats.length <= 1) {
      GameModal.alert({ title: '无法移除', message: '每个场景至少需要一个原子节拍。' });
      return;
    }
    sceneItem.beats.splice(beatIndex, 1);
    const neighborIndex = Math.min(beatIndex, sceneItem.beats.length - 1);
    this._dirty = true;
    this._renderPlotDraft(`scene.${sceneIndex}.beat.${neighborIndex}.summary`);
  }

  _newRecord() {
    if (this._dirty && !confirm('放弃当前未保存的修改？')) return;
    const id = `${KIND_META[this._kind].idPrefix}-${Date.now()}`;
    this._selectedId = id;
    this._draft = this._kind === 'plot'
      ? { id, date: 'K064-01-01', title: '自定义剧情日', arc_id: 'ARC-P1-CUSTOM', day_goal: '填写当日的游玩目标与核心因果。', start_state: ['填写日初世界状态。'], scenes: [this._newPlotScene()], end_state: ['填写日终基准状态。'], transition: '填写下一剧情日或自由行动阶段的转场。', reference_facts: [] }
      : { id, name: '', aliases: [], type: 'jutsu', classes: [], rank: 'D', elements: [], resource: 'chakra', cost: 1, costDesign: null, power: 0, powerMode: 'none', summary: '', limitations: [], access: { restriction: 'unknown', required_bloodlines: [], required_techniques: [], required_contracts: [] }, users: [], availability: { earliest_confirmed_date: null, first_confirmed_event_id: null }, review: 'user-edited' };
    this._isNew = true; this._dirty = true; this._render();
  }

  _save() {
    try {
      const record = this._readRecord();
      CANON_DATABASE.saveRecord(this._kind, record);
      this._selectedId = record.id; this._draft = null; this._isNew = false; this._dirty = false;
      this._notify('数据库记录已保存'); this._render();
    } catch (error) { GameModal.alert({ title: '无法保存', message: error.message }); }
  }

  _toggle() {
    const status = CANON_DATABASE.getRecordStatus(this._kind, this._selectedId);
    if (this._dirty && !confirm('放弃当前未保存的修改并切换启用状态？')) return;
    CANON_DATABASE.setRecordEnabled(this._kind, this._selectedId, status.disabled);
    this._draft = null; this._isNew = false; this._dirty = false; this._notify(status.disabled ? '记录已启用' : '记录已停用'); this._render();
  }

  _resetOne() {
    if (this._dirty && !confirm('放弃当前未保存的修改并恢复此记录？')) return;
    if (!confirm('恢复此记录的生成数据？')) return;
    CANON_DATABASE.resetRecord(this._kind, this._selectedId); this._draft = null; this._isNew = false; this._dirty = false; this._notify('记录已恢复'); this._render();
  }

  _delete() {
    if (this._dirty && !confirm('放弃当前未保存的修改并删除此记录？')) return;
    if (!confirm('删除这条自定义记录？')) return;
    CANON_DATABASE.resetRecord(this._kind, this._selectedId); this._selectedId = ''; this._draft = null; this._isNew = false; this._dirty = false; this._notify('自定义记录已删除'); this._render();
  }

  _resetAll() {
    if (!confirm(`清除${KIND_META[this._kind].title}的全部本地修改？`)) return;
    CANON_DATABASE.clearOverrides(this._kind); this._selectedId = ''; this._draft = null; this._isNew = false; this._dirty = false; this._notify('全部本地修改已清除'); this._render();
  }

  _download(payload, suffix) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `naruto_${this._kind}_${suffix}_${Date.now()}.json`; link.click(); URL.revokeObjectURL(url);
  }

  _export(effective) {
    const schema = this._kind === 'plot'
      ? `project.timeline.${effective ? 'effective' : 'overrides'}.v2`
      : `naruto.canon.${effective ? 'effective' : 'overrides'}.v1`;
    const payload = effective
      ? { schema, kind: this._kind, records: CANON_DATABASE.getRecords(this._kind).map(({ _database, ...record }) => record) }
      : { schema, kind: this._kind, ...CANON_DATABASE.getOverrideStore(this._kind) };
    this._download(payload, effective ? 'effective' : 'overrides');
  }

  _import(event) {
    const file = event.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const payload = JSON.parse(reader.result);
        if (payload.kind && payload.kind !== this._kind) throw new Error('导入文件的数据库类型不匹配');
        let store;
        if (payload.records && !Array.isArray(payload.records)) store = { version: payload.version || (this._kind === 'plot' ? 2 : 1), records: payload.records };
        else {
          const records = Array.isArray(payload) ? payload : payload.records;
          if (!Array.isArray(records)) throw new Error('缺少 records 数组或覆盖记录对象');
          store = CANON_DATABASE.getOverrideStore(this._kind);
          for (const record of records) {
            if (!record?.id) continue;
            const status = CANON_DATABASE.getRecordStatus(this._kind, record.id);
            store.records[record.id] = { disabled: false, custom: !CANON_DATABASE.getRecord(this._kind, record.id) || status.custom, value: record };
          }
        }
        if (!confirm('导入会替换当前数据库修改，是否继续？')) return;
        CANON_DATABASE.replaceOverrideStore(this._kind, store);
        this._selectedId = ''; this._draft = null; this._isNew = false; this._dirty = false; this._notify('数据库修改已导入'); this._render();
      } catch (error) { GameModal.alert({ title: '导入失败', message: error.message }); }
    };
    reader.readAsText(file); event.target.value = '';
  }

  _notify(message) {
    eventBus.emit('app:toast', message);
    this.dispatchEvent(new CustomEvent('database-saved', { bubbles: true, composed: true, detail: { kind: this._kind } }));
  }

  _close() {
    if (this._dirty && !confirm('放弃当前未保存的修改并关闭？')) return;
    this.remove();
  }

  _styles() { return `
    :host{position:fixed;inset:0;z-index:calc(var(--z-fullscreen) + 3);display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(3,4,6,.9);color:#e8e4d9;font-family:'Noto Sans SC',system-ui,sans-serif;box-sizing:border-box}
    :host([embedded]){position:relative;inset:auto;z-index:auto;width:100%;height:100%;padding:0;background:transparent}
    :host([embedded]) .db-shell{width:100%;height:100%;border:0;border-radius:0;box-shadow:none}
    .db-shell{box-sizing:border-box;width:min(1320px,100%);height:min(880px,100%);display:flex;flex-direction:column;background:#0b0e13;border:1px solid rgba(198,156,109,.24);border-radius:8px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.55)}
    .db-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.07);background:#11151b}.db-heading{display:flex;flex-direction:column;gap:4px;min-width:0}.db-heading strong{font:700 17px 'Noto Serif SC',serif;letter-spacing:1px}.db-heading span{font-size:11px;color:#8f8b84}.db-actions,.editor-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end}input[type=file]{display:none}
    .btn,.icon-btn{border:1px solid rgba(232,228,217,.16);background:rgba(255,255,255,.04);color:#e8e4d9;border-radius:5px;padding:7px 11px;font:12px inherit;cursor:pointer}.btn:hover,.icon-btn:hover{background:rgba(255,255,255,.09);border-color:rgba(198,156,109,.55)}.btn.primary{background:#eb613f;border-color:#eb613f;color:#fff;font-weight:700}.btn.danger,.icon-btn.danger{color:#ef8b88;border-color:rgba(239,83,80,.42)}.btn.good{color:#9bd49d;border-color:rgba(129,199,132,.38)}.btn:disabled{opacity:.35;cursor:default}
    .db-body{display:grid;grid-template-columns:390px minmax(0,1fr);flex:1;min-height:0}.db-sidebar{display:flex;flex-direction:column;min-height:0;border-right:1px solid rgba(255,255,255,.06);background:#0d1117}.db-search{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:10px;border-bottom:1px solid rgba(255,255,255,.05)}
    input,select,textarea{box-sizing:border-box;width:100%;border:1px solid rgba(255,255,255,.11);border-radius:4px;background:#080b0f;color:#e8e4d9;padding:9px 10px;font:12px/1.45 inherit;outline:none}input:focus,select:focus,textarea:focus{border-color:#eb613f}input[readonly]{color:#817d76;background:#0b0e13}textarea{resize:vertical;min-height:78px;font-family:'JetBrains Mono','Consolas',monospace}
    .db-list{flex:1;min-height:0;overflow-y:auto;padding:4px}.db-item{width:100%;display:flex;align-items:center;gap:7px;text-align:left;border:0;border-left:2px solid transparent;background:transparent;color:inherit;padding:9px 10px;cursor:pointer}.db-item:hover{background:rgba(255,255,255,.035)}.db-item.active{background:rgba(235,97,63,.08);border-left-color:#eb613f}.db-item.disabled{opacity:.5}.item-main{display:flex;flex:1;min-width:0;flex-direction:column;gap:3px}.item-main strong,.item-main small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.item-main strong{font-size:12px}.item-main small{font-size:10px;color:#77736d}.tag{font-style:normal;font-size:9px;padding:2px 4px;border-radius:3px;white-space:nowrap}.tag.changed{color:#e9c27a;background:rgba(198,156,109,.12)}.tag.custom{color:#91ca94;background:rgba(129,199,132,.12)}.tag.off{color:#ef8b88;background:rgba(239,83,80,.1)}
    .db-pager{display:grid;grid-template-columns:34px 1fr 34px;align-items:center;gap:6px;padding:8px 10px;border-top:1px solid rgba(255,255,255,.05);font-size:11px;color:#8f8b84;text-align:center}.icon-btn{height:30px;padding:0;font-size:20px}.icon-btn:disabled{opacity:.25;cursor:default}
    .db-editor{display:flex;flex-direction:column;min-width:0;min-height:0;background:#070a0e}.editor-head{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:13px 18px;border-bottom:1px solid rgba(255,255,255,.06)}.editor-head>div:first-child{display:flex;flex-direction:column;gap:3px;min-width:0}.editor-head strong{font-size:13px;overflow:hidden;text-overflow:ellipsis}.editor-head span{font-size:10px;color:#817d76}.form-scroll{overflow-y:auto;padding:18px;min-height:0}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px 18px}.field{display:flex;flex-direction:column;gap:6px;min-width:0}.field.wide{grid-column:1/-1}.field>span{font-size:11px;color:#c69c6d;font-weight:700;letter-spacing:.5px}.empty{padding:40px 18px;text-align:center;color:#716d67;font-size:12px}.editor-empty{display:flex;align-items:center;justify-content:center;height:100%}
    .timeline-day-form{display:flex;flex-direction:column;gap:20px}.day-fields{padding-bottom:4px}.section-bar,.scene-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.section-bar{padding:11px 0;border-top:1px solid rgba(198,156,109,.28);border-bottom:1px solid rgba(255,255,255,.07)}.section-bar.compact{border-top:0;padding:9px 0}.section-bar>div,.scene-head>div{display:flex;flex-direction:column;gap:2px}.section-bar strong,.scene-head strong{font-size:12px}.section-bar span,.scene-head span{font-size:10px;color:#77736d}.scene-list{display:flex;flex-direction:column}.scene-card{padding:18px 0 22px;border-bottom:1px solid rgba(255,255,255,.12)}.scene-card:first-child{padding-top:0}.scene-head{margin-bottom:15px}.scene-fields{padding-left:12px;border-left:2px solid rgba(235,97,63,.35)}.beat-section{margin:16px 0 0 14px}.beat-list{display:flex;flex-direction:column}.beat-card{display:grid;grid-template-columns:28px minmax(0,1fr) 32px;align-items:start;gap:10px;padding:13px 0;border-top:1px solid rgba(255,255,255,.07)}.beat-index{display:flex;align-items:center;justify-content:center;width:24px;height:24px;border:1px solid rgba(198,156,109,.3);color:#c69c6d;font-size:11px}.beat-fields{display:grid;grid-template-columns:minmax(0,1.5fr) 90px minmax(120px,.7fr);gap:10px}.beat-fields .field.wide{grid-column:1/-1}.beat-card>.icon-btn{width:30px;height:30px;font-size:16px}.beat-fields textarea{min-height:66px}
    @media(max-width:820px){:host{padding:0}.db-shell{width:100%;height:100%;border-radius:0}.db-head{align-items:flex-start}.db-actions{max-width:60%}.db-body{grid-template-columns:1fr;grid-template-rows:280px minmax(0,1fr)}.db-sidebar{border-right:0;border-bottom:1px solid rgba(255,255,255,.07)}.form-grid{grid-template-columns:1fr}.field.wide{grid-column:auto}.editor-head{align-items:flex-start;flex-direction:column}.editor-actions{justify-content:flex-start}.scene-fields{padding-left:8px}.beat-section{margin-left:4px}.beat-card{grid-template-columns:24px minmax(0,1fr) 30px}.beat-fields{grid-template-columns:1fr}.beat-fields .field.wide{grid-column:auto}}
  `; }
}

if (!customElements.get('canon-database-editor')) customElements.define('canon-database-editor', CanonDatabaseEditor);

export default CanonDatabaseEditor;
