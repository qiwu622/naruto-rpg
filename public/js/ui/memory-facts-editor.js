import { stateManager } from '../core/state-manager.js';
import { eventBus } from '../core/event-bus.js';
import { listMemoryFacts, MAX_MEMORY_CORRECTION_TEXT } from '../core/memory-corrections.js';
import { escHtml, escAttr } from '../utils/format.js';
import { icon } from '../utils/icons.js';
import { memoryFactsEditorStyles } from '../../css/components/memory-facts-editor.css.js';

const decoration = (name, size = 16) => `<span aria-hidden="true">${icon(name, size)}</span>`;

const FIELD_LABELS = {
  facts: '事实', long_term: '长期记忆', pins: '置顶记忆', clues: '线索', important_events: '重要事件'
};
const ACTION_LABELS = { correct: '纠正', reject: '否定', pin: '置顶' };
const PAGE_SIZE = 20;
const HTMLElementBase = globalThis.HTMLElement || class {};

export class MemoryFactsEditor extends HTMLElementBase {
  constructor() {
    super();
    this._query = '';
    this._field = 'all';
    this._page = 0;
    this._editing = null;
    this._busy = false;
    this._error = '';
    this._connected = false;
    this._click = event => { void this._onClick(event); };
    this._input = event => this._onInput(event);
    this._change = event => this._onChange(event);
  }

  connectedCallback() {
    if (this._connected) return;
    this._connected = true;
    this.addEventListener('click', this._click);
    this.addEventListener('input', this._input);
    this.addEventListener('change', this._change);
    this._subscriptions = eventBus.createDisposeBag();
    for (const event of ['memory:corrected', 'state:restored']) {
      this._subscriptions.on(event, () => {
        if (this._busy) return;
        this._editing = null;
        this._error = '';
        this.render();
      });
    }
    this.render();
  }

  disconnectedCallback() { this.dispose(); }

  dispose() {
    this._subscriptions?.dispose();
    this._subscriptions = null;
    this.removeEventListener('click', this._click);
    this.removeEventListener('input', this._input);
    this.removeEventListener('change', this._change);
    this._connected = false;
  }

  _expected() {
    return {
      nodeId: this._viewState?._meta?.current_node_id || null,
      branchId: this._viewState?._meta?.active_branch || null,
      memory: JSON.stringify(this._viewState?._memory)
    };
  }

  render() {
    if (!this._connected || this._busy) return;
    this._viewState = stateManager.snapshot();
    const fields = Object.keys(FIELD_LABELS);
    this._facts = listMemoryFacts(this._viewState).sort((a, b) => fields.indexOf(a.field) - fields.indexOf(b.field));
    this.innerHTML = `
      <style>${memoryFactsEditorStyles}</style>
      <section class="mf-shell" aria-label="记忆事实纠错" aria-busy="false">
        <header class="mf-header">
          <span class="mf-emblem" aria-hidden="true">${icon('book-open', 23)}</span>
          <div class="mf-heading"><p class="mf-eyebrow">记忆 · 当前线路</p><h3>记忆卷宗</h3>
          <p class="mf-description">查阅故事留下的事实，修订下一回合的依据。</p></div>
          <div class="mf-count"><strong>${this._facts.length}</strong><span>条记忆</span></div>
        </header>
        <div class="mf-content">
        <div class="mf-toolbar">
          <label class="mf-search"><span class="mf-search-icon" aria-hidden="true">${icon('search', 17)}</span><input type="search" data-memory-search aria-label="搜索记忆事实" placeholder="搜索人物、事件或关键词" value="${escAttr(this._query)}"></label>
          <label class="mf-group">记忆类型<select data-memory-field aria-label="记忆分组">
            <option value="all" ${this._field === 'all' ? 'selected' : ''}>全部记忆</option>
            ${Object.entries(FIELD_LABELS).map(([field, label]) => `<option value="${field}" ${this._field === field ? 'selected' : ''}>${label}</option>`).join('')}
          </select></label>
        </div>
        <div role="alert" data-memory-error>${escHtml(this._error)}</div>
        <div role="status" aria-live="polite" data-memory-status></div>
        <div data-memory-results></div>
        </div>
        ${this._historyHtml()}
      </section>`;
    this._renderResults();
  }

  _historyHtml() {
    const history = (Array.isArray(this._viewState?._memory?.corrections) ? this._viewState._memory.corrections : [])
      .filter(rule => rule && typeof rule.id === 'string' && ACTION_LABELS[rule.action]).slice(0, 100);
    if (!history.length) return '';
    return `<details class="mf-history-wrap"><summary>${decoration('timeline')}<span>修订记录（${history.length}）</span><span class="mf-history-chevron" aria-hidden="true">${icon('chevron-down', 15)}</span></summary>
      <p class="mf-hint">撤销会同时撤销该事实之后的纠正、否定和置顶。不会回退此后的剧情与新记忆；要恢复当时的全部进度，请读取修订前的时间线节点。</p>
      <div class="mf-history">${history.slice().reverse().map(rule => `<div class="mf-history-item">
        <div class="mf-meta">${ACTION_LABELS[rule.action]} · 第 ${Number(rule.createdTurn) || 0} 回合</div>
        <p class="mf-history-text"><span class="mf-history-before">${escHtml(String(rule.targetText || '').slice(0, 2000))}</span>${rule.action === 'correct' ? `<span class="mf-history-after">→ ${escHtml(String(rule.replacement || '').slice(0, 2000))}</span>` : ''}</p>
        <button type="button" class="btn ghost btn-xs" data-action="undo" data-correction-id="${escAttr(rule.id)}">${decoration('refresh-cw', 14)}撤销此修订</button>
      </div>`).join('')}</div></details>`;
  }

  _renderResults() {
    const result = this.querySelector('[data-memory-results]');
    if (!result) return;
    const query = this._query.trim().toLocaleLowerCase();
    const facts = (this._facts || []).filter(fact => (this._field === 'all' || fact.field === this._field)
      && (!query || fact.text.toLocaleLowerCase().includes(query)));
    const pages = Math.max(1, Math.ceil(facts.length / PAGE_SIZE));
    this._page = Math.max(0, Math.min(this._page, pages - 1));
    const visible = facts.slice(this._page * PAGE_SIZE, (this._page + 1) * PAGE_SIZE);
    let field = null;
    const cards = visible.map(fact => {
      const heading = field !== fact.field ? `<h4>${FIELD_LABELS[fact.field]}</h4>` : '';
      field = fact.field;
      const edit = this._editing?.id === fact.id;
      return `${heading}<article class="mf-card${fact.pinned ? ' is-pinned' : ''}${edit ? ' is-editing' : ''}" data-fact-id="${escAttr(fact.id)}">
        <p class="mf-text">${escHtml(fact.text)}</p>
        <div class="mf-meta">${fact.pinned ? `<span class="mf-pinned">${decoration('check', 12)}已置顶</span><span aria-hidden="true">·</span>` : ''}${fact.nodeId
          ? `第 ${Number.isInteger(fact.turn) ? fact.turn : '?'} 回合留存` : '来源未知 · 旧记忆未保留来源'}</div>
        ${edit ? `<label class="mf-edit-label">纠正内容<textarea data-memory-draft aria-label="纠正内容" maxlength="${MAX_MEMORY_CORRECTION_TEXT}">${escHtml(this._editing.text)}</textarea></label>
          <div class="mf-actions"><button type="button" class="btn btn-xs" data-action="save" data-fact-id="${escAttr(fact.id)}">${decoration('check', 14)}保存纠正</button>
          <button type="button" class="btn ghost btn-xs" data-action="cancel">取消</button></div>`
          : `<div class="mf-actions">
          <button type="button" class="btn ghost btn-xs" data-action="edit" data-fact-id="${escAttr(fact.id)}">${decoration('pencil', 14)}修改</button>
          <button type="button" class="btn ghost btn-xs" data-action="reject" data-fact-id="${escAttr(fact.id)}">${decoration('close', 14)}否定</button>
          <button type="button" class="btn ghost btn-xs" data-action="pin" data-fact-id="${escAttr(fact.id)}" ${fact.pinned ? 'disabled' : ''}>${fact.pinned ? '已置顶' : '置顶'}</button>
          ${fact.nodeId ? `<button type="button" class="btn ghost btn-xs" data-action="source" data-node-id="${escAttr(fact.nodeId)}">${decoration('book-open', 14)}查看来源</button>` : ''}
        </div>`}
      </article>`;
    }).join('');
    result.innerHTML = `<div class="mf-result-info"><span>${query || this._field !== 'all' ? '找到' : '已收录'} ${facts.length} 条记忆</span><span>随当前线路保存</span></div>
      <div class="mf-list">${cards || `<div class="mf-empty"><span class="mf-empty-icon" aria-hidden="true">${icon(query ? 'search' : 'book-open', 28)}</span><strong>${query || this._field !== 'all' ? '没有找到这段记忆' : '故事即将留下痕迹'}</strong><p>${query || this._field !== 'all' ? '试试其他关键词，或切换记忆类型。' : '推进剧情后，已记录的事实会出现在这里。'}</p></div>`}</div>
      <nav class="mf-pagination" aria-label="记忆分页">
        <button type="button" class="btn ghost btn-xs" data-action="previous" ${this._page === 0 ? 'disabled' : ''}>上一页</button>
        <span>${this._page + 1} / ${pages}</span>
        <button type="button" class="btn ghost btn-xs" data-action="next" ${this._page + 1 >= pages ? 'disabled' : ''}>下一页</button>
      </nav>`;
  }

  _onInput(event) {
    if (this._busy) return;
    if (event.target.matches('[data-memory-search]')) {
      this._query = event.target.value;
      this._page = 0;
      this._renderResults();
    } else if (event.target.matches('[data-memory-draft]') && this._editing) {
      this._editing.text = event.target.value;
    }
  }

  _onChange(event) {
    if (this._busy || !event.target.matches('[data-memory-field]')) return;
    this._field = Object.hasOwn(FIELD_LABELS, event.target.value) ? event.target.value : 'all';
    this._page = 0;
    this._renderResults();
  }

  async _onClick(event) {
    const button = event.target.closest('[data-action]');
    if (!button || !this.contains(button) || button.disabled || this._busy) return;
    const action = button.dataset.action;
    const factId = button.dataset.factId;
    if (action === 'previous' || action === 'next') {
      this._page += action === 'next' ? 1 : -1;
      this._renderResults();
      return;
    }
    if (action === 'edit') {
      const fact = this._facts.find(item => item.id === factId);
      if (!fact) return;
      this._editing = { id: factId, text: fact.text, expected: this._expected() };
      this._renderResults();
      this.querySelector('[data-memory-draft]')?.focus();
      return;
    }
    if (action === 'cancel') { this._editing = null; this._renderResults(); return; }
    if (action === 'source') {
      await this._request('memory:source-requested', { nodeId: button.dataset.nodeId }, '正在打开来源…');
      return;
    }
    if (action === 'save' && this._editing?.id === factId) {
      await this._request('memory:correction-requested', {
        action: 'correct', factId, text: this._editing.text, expected: this._editing.expected
      });
    } else if (action === 'reject' || action === 'pin') {
      await this._request('memory:correction-requested', { action, factId, expected: this._expected() });
    } else if (action === 'undo') {
      await this._request('memory:correction-requested', {
        action, correctionId: button.dataset.correctionId, expected: this._expected()
      });
    }
  }

  async _request(event, payload, message = '正在保存修订…') {
    if (this._busy) return;
    this._busy = true;
    this._error = '';
    this.querySelector('[data-memory-error]').textContent = '';
    this.querySelector('[data-memory-status]').textContent = message;
    this.querySelector('section')?.setAttribute('aria-busy', 'true');
    for (const element of this.querySelectorAll('button,input,select,textarea')) element.disabled = true;
    try {
      await eventBus.request(event, payload);
      this._editing = null;
    } catch (error) {
      this._error = error?.message || '操作失败，请重试。';
    } finally {
      this._busy = false;
      this.render();
    }
  }
}

if (globalThis.customElements && !customElements.get('memory-facts-editor')) {
  customElements.define('memory-facts-editor', MemoryFactsEditor);
}
export default MemoryFactsEditor;
