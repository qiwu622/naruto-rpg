import { stateManager } from '../core/state-manager.js';
import { eventBus } from '../core/event-bus.js';
import { isCompressedTimelineNode } from '../core/timeline-node-codec.js';
import { formatGameTime, truncate, escHtml, escAttr } from '../utils/format.js';
import { icon } from '../utils/icons.js';
import { timelineStyles } from '../../css/components/timeline-navigator.css.js';

const DEFAULT_BRANCH_COLOR = '#eb613f';
const SAFE_BRANCH_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

class TimelineNavigator extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._nodes = [];
    this._branches = [];
    this._selectedId = null;
    this._unsubs = [];
    this._tlStyle = '';
  }

  connectedCallback() {
    this._load();
    this._unsubs = [
      eventBus.on('timeline:node-created', () => this._load(true)),
      eventBus.on('timeline:node-updated', () => this._load()),
      eventBus.on('timeline:maintenance-attached', () => this._load()),
      eventBus.on('timeline:branch-created', () => this._load()),
      eventBus.on('timeline:branch-switched', () => this._load()),
      eventBus.on('timeline:jumped', () => this._load()),
      eventBus.on('timeline:nodes-deleted', () => this._load()),
      eventBus.on('timeline:branch-promoted', () => this._load()),
      eventBus.on('timeline:branch-deleted', () => this._load()),
      eventBus.on('timeline:branch-renamed', () => this._load()),
      eventBus.on('timeline:imported', () => this._load(true)),
      eventBus.on('state:restored', () => this._load())
    ];
  }

  disconnectedCallback() {
    this._unsubs.forEach(fn => fn?.());
    this._unsubs = [];
  }

  async _load(scrollToEnd = false) {
    try {
      this._nodes = await stateManager.dbGetAll('timeline_nodes') || [];
      this._branches = await stateManager.dbGetAll('timeline_branches') || [];
    } catch { this._nodes = []; this._branches = []; }
    if (scrollToEnd) {
      const curId = stateManager.get('系统·当前节点');
      this._selectedId = this._storyNodeId(curId);
    }
    this._render();
    if (scrollToEnd) {
      requestAnimationFrame(() => {
        const list = this.shadowRoot?.querySelector('.tl');
        if (list) list.scrollTop = list.scrollHeight;
      });
    }
  }

  _render() {
    const curId = this._storyNodeId(stateManager.get('系统·当前节点'));
    const nodes = [...(this._nodes || [])]
      .filter(node => node && typeof node === 'object' && !this._isMaintenanceNode(node))
      .sort((a, b) => (Number(a.turn_number) || 0) - (Number(b.turn_number) || 0)
        || (Number(a.created_at || a.real_timestamp) || 0) - (Number(b.created_at || b.real_timestamp) || 0));
    const branchMain = nodes.filter(n => n.branch_id === 'branch_main');
    const altBranches = (this._branches || []).filter(b => b && b.id !== 'branch_main');
    const altNodes = nodes.filter(n=>n.branch_id!=='branch_main');
    const visibleAltBranches = altBranches.filter(branch => altNodes.some(node => node.branch_id === branch.id));
    if (this._selectedId && !nodes.some(node => node.id === this._selectedId)) this._selectedId = null;

    const tl = this.shadowRoot?.querySelector('.tl');
    const savedScrollTop = tl ? tl.scrollTop : 0;

    this.shadowRoot.innerHTML = `
      <style>${timelineStyles}</style>
      <div class="tl" ${this._tlStyle ? `style="${this._tlStyle}"` : ''}>
        <div class="tl-title">时之卷</div>
        ${branchMain.length>0?`
          <div class="branch">主线编年</div>
          <div class="list">${branchMain.slice(-80).map(node => this._renderNode(node, { currentId: curId })).join('')}</div>
        `:'<div class="empty"><div class="empty-icon">結</div><div class="empty-title">卷轴虚位以待</div><div class="empty-desc">尚未落笔<br><em>结印写下决断</em>，开启你的忍道</div></div>'}
        ${visibleAltBranches.map(b=>{
          const bn = altNodes.filter(n=>n.branch_id===b.id);
          return `
            <div class="branch" style="color:${this._safeColor(b.color)}; border-left-color:${this._safeColor(b.color)}">异世分支·${this._esc(b.name)}</div>
            <div class="list">${bn.slice(-30).map(node => this._renderNode(node, { currentId: curId, color: b.color })).join('')}</div>
          `;
        }).join('')}
        <div class="control-bento">
          <button class="btn-ghost" id="save-library-btn">${icon('archive', 14)} 存档库</button>
          <button class="btn-ghost" id="if-lines-btn">${icon('git-branch', 14)} IF 线管理</button>
        </div>
      </div>
    `;

    this.shadowRoot.querySelectorAll('.node-toggle').forEach(button => {
      button.addEventListener('click', () => {
        this._selectedId = this._selectedId === button.dataset.id ? null : button.dataset.id;
        const nodeData = (this._nodes || []).find(nd => nd && nd.id === button.dataset.id);
        if (nodeData) {
          eventBus.emit('timeline:view-node', { node: nodeData });
        }
        this._render();
      });
    });

    this.shadowRoot.querySelectorAll('.jump-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        eventBus.emit('timeline:jump-request', { nodeId: btn.dataset.id });
        this._selectedId = null;
      });
    });

    this.shadowRoot.querySelectorAll('.reroll-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        eventBus.emit('timeline:reroll-request', { nodeId: btn.dataset.id });
        this._selectedId = null;
      });
    });
    
    this.shadowRoot.querySelector('#save-library-btn')?.addEventListener('click', () => eventBus.emit('app:open-saves'));
    this.shadowRoot.querySelector('#if-lines-btn')?.addEventListener('click', () => eventBus.emit('app:open-saves', { kind: 'if_lines' }));
    this.shadowRoot.querySelectorAll('.fork-btn').forEach(btn => btn.addEventListener('click', () => {
      eventBus.emit('app:open-saves', { kind: 'if_lines', fromNodeId: btn.dataset.id });
    }));

    const newTl = this.shadowRoot?.querySelector('.tl');
    if (newTl) {
      newTl.scrollTop = savedScrollTop;
      this._makeDraggable(newTl);
    }
  }

  _renderNode(node, { currentId = null, color = null } = {}) {
    const selected = node.id === this._selectedId;
    const current = node.id === currentId;
    const records = this._maintenanceRecords(node);
    const time = this._nodeGameTime(node);
    const location = this._nodeLocation(node);
    const summary = this._nodeSummary(node);
    const turn = truncate(String(node.turn_number ?? 0), 20);
    const accent = color ? ` style="--node-accent:${this._safeColor(color)}"` : '';
    const toggleLabel = `${selected ? '收起' : '展开'}第 ${turn} 回详情`;

    return `
      <article class="node${current ? ' cur' : ''}${selected ? ' sel' : ''}" data-id="${escAttr(node.id)}"${accent}>
        <button class="node-toggle" type="button" data-id="${escAttr(node.id)}" aria-expanded="${selected}" aria-label="${escAttr(toggleLabel)}">
          <span class="node-heading">
            <span class="node-chapter">${node.branch_anchor ? `IF 起点 · 第 ${this._esc(turn)} 回` : `第 ${this._esc(turn)} 回`}</span>
            <span class="node-statuses">
              ${current ? '<span class="node-status current-status">当前</span>' : ''}
              ${isCompressedTimelineNode(node) ? '<span class="node-status compressed-status">已压缩</span>' : ''}
              ${records.length ? `<span class="node-status maintenance-status">${icon('database', 11)}有维护记录${records.length > 1 ? ` · ${records.length}` : ''}</span>` : ''}
            </span>
          </span>
          ${(time || location) ? `
            <span class="node-meta">
              ${time ? `<span class="node-meta-item">${icon('timeline', 12)}<span>${this._esc(time)}</span></span>` : ''}
              ${location ? `<span class="node-meta-item">${icon('map', 12)}<span>${this._esc(location)}</span></span>` : ''}
            </span>
          ` : ''}
          <span class="node-summary">${this._esc(summary)}</span>
        </button>
        ${selected ? this._renderNodeDetails({ current, records, summary, nodeId: node.id, branchAnchor: node.branch_anchor }) : ''}
      </article>
    `;
  }

  _renderNodeDetails({ current, records, summary, nodeId, branchAnchor = false }) {
    return `
      <div class="node-details">
        <div class="detail-heading">剧情摘要</div>
        <div class="node-full-summary">${this._esc(summary || '这段记忆已经模糊不清...')}</div>
        ${records.length ? `
          <section class="maintenance-section" aria-label="本回合存档变更">
            <div class="maintenance-heading">
              <span>${icon('database', 13)}本回合存档变更</span>
              <span class="maintenance-count">${records.length} 条</span>
            </div>
            <div class="maintenance-list">
              ${records.map(record => `
                <div class="maintenance-entry">
                  <div class="maintenance-entry-head">
                    <span class="maintenance-label">${this._esc(record.label)}</span>
                    <time class="maintenance-time">${this._esc(this._formatMaintenanceTime(record.createdAt))}</time>
                  </div>
                  <div class="maintenance-reason">${this._esc(record.reason || '未填写修改原因')}</div>
                </div>
              `).join('')}
            </div>
          </section>
        ` : ''}
        <div class="node-actions">
          ${current
            ? '<div class="cur-text">此乃当下此时</div>'
            : `<button class="jump-btn" type="button" data-id="${escAttr(nodeId)}">逆转时间至此</button>`}
          ${branchAnchor ? '' : `<button class="reroll-btn" type="button" data-id="${escAttr(nodeId)}">快速重Roll</button>`}
          <button class="fork-btn" type="button" data-id="${escAttr(nodeId)}">从此创建 IF 线</button>
        </div>
      </div>
    `;
  }

  _isMaintenanceNode(node) {
    // New maintenance writes are metadata attached to a normal story turn.
    // Only legacy standalone checkpoints should be hidden from the timeline.
    if (Array.isArray(node?.maintenance_history) && node.maintenance_history.length > 0) {
      return false;
    }
    return node?.maintenance?.type === 'lingxi-variable-maintenance'
      || (Array.isArray(node?.tags) && node.tags.some(tag => String(tag) === '灵希维护'))
      || node?.tags === '灵希维护';
  }

  _storyNodeId(nodeId) {
    if (!nodeId) return null;
    const visited = new Set();
    let candidateId = nodeId;
    while (candidateId && !visited.has(candidateId)) {
      visited.add(candidateId);
      const node = (this._nodes || []).find(candidate => candidate?.id === candidateId);
      if (!node || !this._isMaintenanceNode(node)) return candidateId;
      candidateId = node.maintenance?.previous_node_id || node.parent_id || null;
    }
    return null;
  }

  _nodeGameTime(node) {
    const direct = this._plainText(node?.game_time);
    if (direct) return truncate(direct, 80);
    if (node?.game_time && typeof node.game_time === 'object') {
      const formatted = this._plainText(formatGameTime(node.game_time));
      if (formatted) return truncate(formatted, 80);
    }
    const snapshot = node?.state_snapshot;
    const raw = snapshot?.['世界·时间'] ?? snapshot?.world_state?.calendar;
    if (raw == null || raw === '') return '';
    return truncate(formatGameTime(raw), 80);
  }

  _nodeLocation(node) {
    const snapshot = node?.state_snapshot;
    for (const value of [
      snapshot?.['世界·地点'],
      snapshot?.world_state?.current_location,
      node?.location
    ]) {
      const text = this._plainText(value);
      if (text) return truncate(text, 80);
    }
    return '';
  }

  _nodeSummary(node) {
    const value = node?.summary || node?.ai_response_summary || node?.player_input || '尚无记载';
    return truncate(this._plainText(value) || '尚无记载', 1000);
  }

  _maintenanceRecords(node) {
    const records = [];
    const seen = new Set();
    const add = (record, sourceNode = node) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) return;
      const legacyLabel = this._plainText(sourceNode?.summary).replace(/^灵希维护\s*[·・:]?\s*/u, '');
      const label = truncate(this._plainText(record.label || record.title) || legacyLabel || '变量维护', 100);
      const reason = truncate(this._plainText(record.reason), 500);
      const createdAt = record.created_at ?? record.createdAt ?? sourceNode?.created_at ?? sourceNode?.real_timestamp ?? null;
      const proposalId = this._plainText(record.proposal_id || record.proposalId);
      const key = proposalId
        ? `proposal:${proposalId}`
        : `record:${String(createdAt ?? '')}:${label}:${reason}`;
      if (seen.has(key)) return;
      seen.add(key);
      records.push({ label, reason, createdAt });
    };

    if (Array.isArray(node?.maintenance_history)) node.maintenance_history.forEach(record => add(record));
    add(node?.maintenance);

    for (const legacyNode of this._nodes || []) {
      if (!this._isMaintenanceNode(legacyNode) || legacyNode.id === node?.id) continue;
      const targetId = this._storyNodeId(legacyNode.maintenance?.previous_node_id || legacyNode.parent_id);
      if (targetId !== node?.id) continue;
      if (Array.isArray(legacyNode.maintenance_history)) {
        legacyNode.maintenance_history.forEach(record => add(record, legacyNode));
      }
      add(legacyNode.maintenance || {
        label: legacyNode.summary,
        created_at: legacyNode.created_at || legacyNode.real_timestamp
      }, legacyNode);
    }

    return records.sort((left, right) => this._maintenanceTimestamp(right.createdAt) - this._maintenanceTimestamp(left.createdAt));
  }

  _maintenanceTimestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value);
    const parsed = Date.parse(String(value ?? ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  _formatMaintenanceTime(value) {
    const timestamp = this._maintenanceTimestamp(value);
    if (!timestamp) return '时间未记录';
    try {
      return new Date(timestamp).toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
      });
    } catch {
      return truncate(this._plainText(value), 40) || '时间未记录';
    }
  }

  _plainText(value) {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
  }

  _makeDraggable(el) {
    let dragging = false, sx, sy, dx, dy, raf;
    const onDown = e => {
      if (e.target.closest('button') || e.target.closest('.node') || e.target.closest('.branch-item') || e.target.closest('.control-bento')) return;
      dragging = true;
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      if (st.position === 'fixed' && st.transform !== 'none') {
        el.style.left = r.left + 'px';
        el.style.top = r.top + 'px';
        el.style.transform = 'none';
        el.style.bottom = 'auto';
        el.style.right = 'auto';
        this._tlStyle = `left: ${r.left}px; top: ${r.top}px; transform: none; transition: none; bottom: auto; right: auto;`;
      }
      const evt = e.touches ? e.touches[0] : e;
      sx = evt.clientX;
      sy = evt.clientY;
      dx = parseFloat(el.style.left) || r.left;
      dy = parseFloat(el.style.top) || r.top;
      el.style.transition = 'none';
    };
    
    const onMove = e => {
      if (!dragging) return;
      e.preventDefault();
      const evt = e.touches ? e.touches[0] : e;
      const nx = dx + evt.clientX - sx;
      const ny = dy + evt.clientY - sy;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        el.style.left = `${nx}px`;
        el.style.top = `${ny}px`;
        this._tlStyle = `left: ${nx}px; top: ${ny}px; transform: none; transition: none; bottom: auto; right: auto;`;
        raf = null;
      });
    };
    
    const onUp = () => { dragging = false; };

    el.addEventListener('mousedown', onDown);
    el.addEventListener('touchstart', onDown, { passive: false });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchend', onUp);
    
    if (this._dragCleanup) this._dragCleanup();
    this._dragCleanup = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchend', onUp);
    };
  }

  _esc(str) {
    return escHtml(str);
  }

  _safeColor(value) {
    return typeof value === 'string' && SAFE_BRANCH_COLOR.test(value)
      ? value
      : DEFAULT_BRANCH_COLOR;
  }
}

customElements.define('timeline-navigator', TimelineNavigator);
export default TimelineNavigator;


