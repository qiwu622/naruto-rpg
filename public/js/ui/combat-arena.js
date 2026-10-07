import { stateManager } from '../core/state-manager.js';
import { eventBus } from '../core/event-bus.js';
import { icon } from '../utils/icons.js';
import { escHtml } from '../utils/format.js';
import { listTacticalMoves, previewTacticalAction } from '../systems/tactical-combat.js';
import { combatStyles } from '../../css/components/combat-arena.css.js';

const BASIC_KINDS = new Set(['guard', 'observe', 'feint', 'retreat']);
const RESULT_LABELS = { victory: '战斗胜利', defeat: '战斗结束', retreat: '已脱离战斗', draw: '战斗结束' };
const STATUS_LABELS = { guard: '戒备', exposed: '破绽', stagger: '失衡', burn: '灼伤', poison: '中毒', bleed: '流血', bind: '束缚', clone: '分身', barrier: '屏障', substitute: '替身准备', observe: '洞察', genjutsu: '幻术干扰' };
const COMBAT_PHASES = {
  resolving: ['正在判定招式与行动顺序', '本回合行动已锁定，正在计算攻防结果。'],
  narrating: ['判定已完成，正在描写本回合', '正在生成战斗正文，判定结果不会因重写而改变。'],
  settled: ['本回合已结算并保存', '正在完成回合收尾，请稍候。']
};
const finite = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const array = value => Array.isArray(value) ? value : [];
const rangeText = (value, suffix = '') => Array.isArray(value) && value.length >= 2
  ? `${Math.round(value[0])}–${Math.round(value[1])}${suffix}`
  : value && finite(value.min) !== null && finite(value.max) !== null ? `${Math.round(value.min)}–${Math.round(value.max)}${suffix}` : '';

class CombatArena extends HTMLElement {
  static get observedAttributes() { return ['data-disabled']; }
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._renderPending = false;
    this._unsubs = [];
    this._selected = null;
    this._expanded = false;
    this._filter = '全部';
    this._busy = false;
    this._phase = '';
    this._error = false;
    this._reportOpen = false;
    this._shortcutKey = null;
    this._shortcuts = null;
    this._shortcutRevision = 0;
    this._shortcutLoading = false;
    this._pinPicker = false;
    this._shortcutNotice = '';
    this._combatPhase = '';
  }
  connectedCallback() {
    this.render();
    void this._refreshShortcutScope();
    this._unsubs = [
      eventBus.on('state:changed', ({ key } = {}) => {
        if (key?.startsWith('_meta')) void this._refreshShortcutScope();
        if (!key || /^(?:_combat|属性·|技能·|物品·|玩家·|attributes\.|skills\.|equipment\.)/.test(key)) this._scheduleRender();
      }),
      eventBus.on('state:reset', () => { this._selected = null; if (!this._shortcutKey) this._shortcuts = null; void this._refreshShortcutScope(); this._scheduleRender(); }),
      eventBus.on('state:restored', () => { this._selected = null; if (!this._shortcutKey) this._shortcuts = null; void this._refreshShortcutScope(); this._scheduleRender(); }),
      eventBus.on('pipeline:processing', () => {
        this._busy = true; this._error = false; this._combatPhase = ''; this._pinPicker = false; this._phase = '正在演绎本回合'; this._scheduleRender();
      }),
      eventBus.on('combat:phase', ({ phase } = {}) => {
        if (!COMBAT_PHASES[phase] || (!this._busy && !this.hasAttribute('data-disabled'))) return;
        this._combatPhase = phase; this._phase = COMBAT_PHASES[phase][0]; this._scheduleRender();
      }),
      eventBus.on('pipeline:vars-updated', () => {
        if (this._busy && !this._combatPhase) { this._phase = '正在记录战况'; this._scheduleRender(); }
      }),
      eventBus.on('pipeline:complete', () => this._finish()),
      eventBus.on('pipeline:cancelled', () => this._finish('生成已停止，当前战况已保留。')),
      eventBus.on('pipeline:error', () => this._finish('本回合生成未完成，可在正文区重试。', true))
    ];
  }
  disconnectedCallback() {
    this._unsubs.forEach(fn => fn?.()); this._unsubs = []; this._renderPending = false; this._shortcutRevision++;
  }
  attributeChangedCallback() { if (this.isConnected) this._scheduleRender(); }
  _finish(message = '', error = false) {
    this._busy = false; this._phase = message; this._error = error; this._combatPhase = '';
    this.removeAttribute('data-disabled'); this._scheduleRender();
  }
  _scheduleRender() {
    if (this._renderPending) return;
    this._renderPending = true;
    requestAnimationFrame(() => { this._renderPending = false; if (this.isConnected) this.render(); });
  }
  async _refreshShortcutScope() {
    const revision = ++this._shortcutRevision;
    const nodeId = stateManager.getSub('_meta')?.current_node_id;
    this._shortcutLoading = true;
    this._scheduleRender();
    let key = null;
    try {
      if (nodeId) {
        const meta = await stateManager.dbGet('timeline_meta', 'root');
        if (meta?.value?.current_id === nodeId && meta.value.root_id) key = `naruto_tactical_shortcuts:v1:${encodeURIComponent(meta.value.root_id)}`;
      }
    } catch { /* A preview without a saved timeline keeps preferences in this panel. */ }
    if (revision !== this._shortcutRevision || !this.isConnected || stateManager.getSub('_meta')?.current_node_id !== nodeId) return;
    this._shortcutLoading = false;
    if (key !== this._shortcutKey) {
      this._shortcutKey = key; this._shortcuts = null; this._pinPicker = false; this._shortcutNotice = '';
      if (key) {
        try {
          const saved = JSON.parse(localStorage.getItem(key) || 'null');
          if (Array.isArray(saved)) this._shortcuts = [...new Set(saved.filter(id => typeof id === 'string'))].slice(0, 4);
        } catch { /* Invalid or unavailable preferences fall back to learned moves. */ }
      }
    }
    this._scheduleRender();
  }
  _saveShortcuts(ids) {
    this._shortcuts = [...new Set(ids)].slice(0, 4);
    this._shortcutNotice = '';
    if (this._shortcutKey) {
      try { localStorage.setItem(this._shortcutKey, JSON.stringify(this._shortcuts)); }
      catch { this._shortcutNotice = '快捷位已在本面板生效，浏览器暂未允许保存偏好。'; }
    } else this._shortcutNotice = '快捷位已在本面板生效，建立角色存档后可记住设置。';
  }
  _quickMoves(moves) {
    const defaults = moves.filter(move => !BASIC_KINDS.has(move.kind)).slice(0, 4);
    if (this._shortcutLoading || this._shortcuts === null) return defaults;
    const valid = this._shortcuts.filter(id => moves.some(move => move.id === id));
    if (valid.length !== this._shortcuts.length) {
      const replacement = valid.length ? [...valid, ...defaults.map(move => move.id).filter(id => !valid.includes(id))].slice(0, this._shortcuts.length) : defaults.map(move => move.id);
      this._saveShortcuts(replacement);
    }
    return this._shortcuts.map(id => moves.find(move => move.id === id)).filter(Boolean);
  }
  _pinControls(move, busy) {
    const quick = this._currentQuick || [];
    const pinned = quick.some(item => item.id === move.id);
    const disabled = busy || this._shortcutLoading;
    return `<div class="pin-controls"><button type="button" class="quiet pin-button" data-pin data-focus="pin" aria-pressed="${pinned}" ${disabled ? 'disabled' : ''}>${pinned ? '取消固定' : quick.length >= 4 ? '替换快捷位' : '固定到快捷栏'}</button><span class="hint">${quick.length} / 4 个快捷位</span></div>${this._pinPicker && !pinned ? `<div class="pin-picker" role="group" aria-label="选择要替换的快捷招式"><p>选择要替换的快捷位</p>${quick.map((item, index) => `<button type="button" class="quiet" data-replace="${index}" data-focus="replace:${index}" ${disabled ? 'disabled' : ''}>${index + 1} · ${escHtml(item.name)}</button>`).join('')}</div>` : ''}${this._shortcutNotice ? `<p class="pin-notice" role="status">${escHtml(this._shortcutNotice)}</p>` : ''}`;
  }
  _resource(label, value, max, color, concealed = false) {
    const current = finite(value), total = finite(max);
    const known = !concealed && current !== null && total !== null && total > 0;
    const percent = known ? Math.max(0, Math.min(100, current / total * 100)) : 0;
    const amount = known ? `${Math.round(current)} / ${Math.round(total)}` : '未探明';
    return `<div class="resource ${known && label === '生命' && percent <= 25 ? 'low' : ''}"><div class="resource-text"><span>${label}</span><strong>${amount}</strong></div><div class="bar" ${known ? `role="meter" aria-label="${label}" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${Math.max(0, Math.min(total, current))}"` : 'aria-hidden="true"'}><i style="--fill:${percent}%;--bar-color:${color}"></i></div></div>`;
  }
  _statuses(values) {
    const seen = new Set();
    const statuses = array(values).map(value => {
      const name = typeof value === 'string' ? value : value?.label || value?.name || value?.type || value?.id;
      if (!name || seen.has(name)) return '';
      seen.add(name);
      const rounds = finite(value?.remaining ?? value?.turns ?? value?.duration);
      return `<span class="status-tag">${escHtml(STATUS_LABELS[name] || name)}${rounds !== null && rounds > 0 ? ` · ${rounds}回合` : ''}</span>`;
    }).filter(Boolean);
    return `<div class="status-row">${statuses.join('') || '<span class="status-tag muted">暂无附加状态</span>'}</div>`;
  }
  _fighter(state, combat, enemy, concealed) {
    const name = text(enemy ? combat.enemy_name : state['玩家·姓名']) || (enemy ? '未知对手' : '你');
    const rank = enemy ? (concealed ? '实力尚未探明' : combat.enemy_rank || '对手') : state['玩家·忍阶'] || '我方';
    const status = enemy ? combat.enemy_statuses || [...array(combat.enemy_status), ...array(combat.enemy_buffs), ...array(combat.enemy_debuffs)] : combat.player_statuses || [...array(combat.player_status), ...array(combat.player_buffs), ...array(combat.player_debuffs)];
    const resource = (label, suffix, field, color) => this._resource(label, enemy ? combat[`enemy_${suffix}`] : state[`属性·当前${field}`], enemy ? combat[`enemy_${suffix}_max`] : state[`属性·${field}`], color, enemy && concealed);
    return `<section class="fighter${enemy ? ' enemy' : ''}" aria-label="${enemy ? '敌方' : '我方'}状态"><div class="fighter-top"><span class="fighter-side">${enemy ? '敵' : '我'}</span><div><div class="fighter-name">${escHtml(name)}</div><div class="fighter-rank">${escHtml(rank)}</div></div></div>${resource('生命', 'vitality', '生命力', enemy ? '#d99d8d' : '#96c8b5')}<div class="minor-resources">${resource('查克拉', 'chakra', '查克拉', '#91bbcf')}${resource('体力', 'stamina', '体力', '#bdc58d')}${resource('精神', 'spirit', '精神力', '#b7abce')}</div>${this._statuses(status)}</section>`;
  }
  _glyph(move, size = 28) {
    const key = move?.kind === 'clone' ? '分身' : move?.element && move.element !== '无' ? move.element : move?.category;
    const paths = {
      火: '<path d="M13 3c1 6-5 7-5 12a5 5 0 0 0 10 0c0-3-1-5-3-7 0 3-1 4-2 5 1-4 2-6 0-10Z"/><path d="M12 15c-2 3-2 5 1 6"/>',
      水: '<path d="M12 3c-2 5-7 8-7 12a7 7 0 0 0 14 0c0-4-5-7-7-12Z"/><path d="M9 16c0 2 1 3 3 3"/>',
      风: '<path d="M3 8h12c5 0 5-6 1-6M3 12h16M3 16h9c5 0 5 6 1 6"/><path d="m18 9 3 3-3 3"/>',
      雷: '<path d="m14 2-9 12h6l-1 8 9-13h-6l1-7Z"/>',
      土: '<path d="m3 18 6-12 4 7 3-5 5 10H3Z"/><path d="M5 22h14M9 6l2 4"/>',
      体术: '<path d="m6 4 6 3 6-3-3 7 6 4-8 1-3 6-2-8-6-3 6-2-2-5Z"/>',
      幻术: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3"/>',
      忍具: '<path d="m15 3 6 6-10 8-4-4 8-10Z"/><path d="m7 13-3 4 3 3 4-3M5 19l-2 3"/>',
      分身: '<circle cx="9" cy="7" r="3"/><path d="M3 21v-4a6 6 0 0 1 12 0v4H3Z"/><path d="M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 4 5v2h-4"/>',
      default: '<path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z"/><circle cx="12" cy="12" r="2"/>'
    };
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[key] || paths.default}</svg>`;
  }
  _message(move) {
    if (move.kind === 'retreat') return `我使用${move.name}，寻找掩护与退路，尝试脱离这场战斗。`;
    if (move.kind === 'observe') return `我使用${move.name}，保持警戒，留意对手的招式与周围地形。`;
    if (move.kind === 'feint') return `我使用${move.name}，试探对手的反应，争取下一步的有利位置。`;
    if (move.kind === 'guard') return `我使用${move.name}，稳住架势，防备对手的攻击。`;
    return move.kind === 'item' ? `我使用${move.name}。` : `我使出${move.name}。`;
  }
  _moveCard(move, index, busy) {
    return `<button type="button" class="move ${this._selected === move.id ? 'selected' : ''} ${move.available === false ? 'unavailable' : ''}" data-element="${escHtml(move.element || move.category)}" data-move="${escHtml(move.id)}" data-focus="move:${escHtml(move.id)}" aria-pressed="${this._selected === move.id}" ${busy ? 'disabled' : ''}><span class="move-glyph">${this._glyph(move)}</span><span class="slot" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span><span class="move-name">${escHtml(move.name)}</span><span class="move-tags"><span class="element">${escHtml(move.element && move.element !== '无' ? move.element + '遁' : move.category || '变化')}</span><span>${(move.kind === 'attack' || move.itemKind === 'attack') ? `威力 ${finite(move.power) ?? '—'}` : move.kind === 'item' ? '忍具' : '变化'}</span></span><span class="move-cost">${move.kind === 'item' ? '消耗 1 个' : Number(move.cost) > 0 ? `${escHtml(move.resource || '资源')} ${Math.round(move.cost)}` : '无消耗'}</span></button>`;
  }
  _selection(state, move, busy) {
    if (!move) return `<div class="selection selection-idle" aria-label="行动准备"><span class="idle-glyph">${this._glyph(null, 52)}</span><span class="detail-kicker">YOUR NEXT MOVE</span><h3>下一步，由你决定</h3><p>选择一式，查看攻防预估。<br>也可以在正文输入框自由谋划。</p><div class="idle-rule"></div><span class="hint">选招不会消耗资源</span></div>`;
    const preview = previewTacticalAction(state, move.id) || {};
    const accuracy = preview.accuracy != null ? `${Math.round(preview.accuracy)}%` : rangeText(preview.accuracyRange, '%') || '尚未探明';
    const damage = preview.approaching ? '先接近目标' : move.available === false && move.kind !== 'item' ? '效果减弱' : rangeText(preview.damageRange) || ((move.kind === 'attack' || move.itemKind === 'attack') ? '尚未探明' : '战术效果');
    const effects = array(move.effects).map(item => {
      if (typeof item === 'string') return STATUS_LABELS[item] || item;
      const name = item?.label || item?.name || STATUS_LABELS[item?.type || item?.id] || '';
      return name ? `${name}${finite(item.chance) !== null ? ` ${item.chance}%` : ''}${finite(item.turns) > 0 ? ` · ${item.turns}回合` : ''}` : '';
    }).filter(Boolean).join('、');
    return `<div class="selection" aria-label="招式详情" data-element="${escHtml(move.element || '')}">
      <div class="selection-main">
        <div class="selection-title"><div><span class="detail-kicker">TACTICAL BRIEF</span><strong>${escHtml(move.name)}</strong></div><button class="quiet clear-selection" type="button" data-clear data-focus="clear" aria-label="取消招式选择" ${busy ? 'disabled' : ''}>${icon('close', 16)}</button></div>
        <p class="move-description">${escHtml(move.description || preview.summary || '选择时不会消耗资源。')}</p>
        <div class="metrics"><div class="metric"><span>${(move.kind === 'attack' || move.itemKind === 'attack') ? '预估命中' : '成功预估'}</span><strong>${accuracy}</strong></div><div class="metric"><span>${(move.kind === 'attack' || move.itemKind === 'attack') ? '预估伤害' : '作用'}</span><strong>${damage}</strong></div><div class="metric"><span>消耗</span><strong>${move.kind === 'item' ? '1 个' : Number(move.cost) > 0 ? `${Math.round(move.cost)}<small>${escHtml(move.resource || '')}</small>` : '无消耗'}</strong></div></div>
        ${effects ? `<p class="effect-note">${escHtml(effects)}</p>` : ''}
        ${preview.reason || move.available === false || preview.known === false || preview.approaching ? `<p class="preview-note">${escHtml(move.reason || preview.reason || preview.summary || '当前条件不足，可改换招式。')}</p>` : ''}
      </div>
      <div class="selection-footer"><button type="button" class="primary" data-submit data-focus="submit" ${busy || (move.kind === 'item' && move.available === false) ? 'disabled' : ''}><span>${busy ? '回合处理中…' : '确认行动'}</span>${icon('send', 16)}</button>${this._pinControls(move, busy)}</div>
    </div>`;
  }
  render() {
    const state = stateManager.get();
    const combat = state._combat;
    const busy = this._busy || this.hasAttribute('data-disabled');
    if (!combat || typeof combat !== 'object' || (!combat.is_active && !combat.result)) {
      this.shadowRoot.innerHTML = `<style>${combatStyles}</style><section class="scene waiting-scene" aria-label="战斗面板"><div class="panel-controls"><span>战斗面板已开启</span><button type="button" class="close-panel" data-close-panel aria-label="关闭战斗面板" ${busy ? 'disabled' : ''}>${icon('close', 16)}<span>关闭面板</span></button></div><div class="hero"><div class="waiting-copy"><div class="eyebrow"><span></span> SHINOBI TACTICS</div><h2>静候交锋</h2><p>故事还在继续，下一步由你决定。</p></div></div><div class="waiting-note" role="status">${busy ? '正在生成正文，等待本回合战况。' : '在正文中继续行动。真正交锋后，这里会显示对手、招式与战报。'}<span>关闭面板即可回到普通叙事。</span></div></section>`;
      this._bind([], busy);
      return;
    }
    const focusKey = this.shadowRoot.activeElement?.getAttribute('data-focus');
    const existingReport = this.shadowRoot.querySelector('.report details');
    if (existingReport) this._reportOpen = existingReport.open;
    const active = combat.is_active === true;
    const moves = active ? listTacticalMoves(state) : [];
    this._currentQuick = active ? this._quickMoves(moves) : [];
    const selected = moves.find(move => move.id === this._selected);
    if (!selected) this._selected = null;
    const concealed = !(['known', 'full'].includes(combat.enemy_intel) || combat.enemy_known === true);
    const skills = moves.filter(move => !BASIC_KINDS.has(move.kind));
    const categories = ['全部', ...new Set(skills.map(move => move.category).filter(Boolean))];
    if (!categories.includes(this._filter)) this._filter = '全部';
    const filtered = this._filter === '全部' ? skills : skills.filter(move => move.category === this._filter);
    const visible = this._expanded ? filtered : this._currentQuick;
    const tactics = moves.filter(move => BASIC_KINDS.has(move.kind));
    const round = Math.max(1, Number(combat.turn) || 1);
    const result = RESULT_LABELS[combat.result] || '战斗结束';
    const environment = typeof combat.environment === 'string' ? combat.environment : ['terrain', 'weather', 'cover', 'description'].map(key => text(combat.environment?.[key])).filter(Boolean).join(' · ');
    const distance = ({ close: '近身', near: '近身', medium: '中距', mid: '中距', far: '远距', long: '远距', 近: '近身', 中: '中距', 远: '远距' })[combat.distance] || text(combat.distance) || '中距';
    const objective = text(combat.objective?.label || combat.objective?.description || combat.objective) || '击退对手';
    const events = Array.isArray(combat.last_round?.events) ? combat.last_round.events : array(combat.log).slice(-6);
    const phaseTitle = busy ? this._phase || '正在演绎本回合' : this._error ? '本回合需要重试' : active ? '轮到你行动' : result;
    const phaseNote = busy ? COMBAT_PHASES[this._combatPhase]?.[1] || '已提交行动，等待本回合正文与战报。' : this._phase || (active ? '先选择招式，或在正文输入框写下自己的战术。' : '战报已保留，可以继续接下来的故事。');
    this.shadowRoot.innerHTML = `<style>${combatStyles}</style>
      <section class="scene" aria-label="战斗面板">
        <div class="panel-controls"><span>战术回合</span><button type="button" class="close-panel" data-close-panel aria-label="关闭战斗面板" ${busy ? 'disabled' : ''}>${icon('close', 16)}<span>关闭面板</span></button></div>
        <div class="hero">
          <header class="masthead"><div class="hero-title"><div class="eyebrow"><span></span> SHINOBI TACTICS</div><h2>${active ? '交锋' : result}</h2><p class="hero-caption">${active ? '一瞬判断，改写战局。' : '胜负已定，故事未完。'}</p></div><div class="round"><span>ROUND</span><strong>${String(round).padStart(2, '0')}</strong><small>第 ${round} 回合</small></div></header>
          <div class="battlefield">${this._fighter(state, combat, false, false)}<div class="versus" aria-hidden="true"><span>対</span><i></i></div>${this._fighter(state, combat, true, concealed)}</div>
          <div class="context"><span><b>目标</b>${escHtml(objective)}</span><span><b>间距</b>${escHtml(distance)}</span>${environment ? `<span class="environment"><b>战场</b>${escHtml(environment)}</span>` : ''}</div>
        </div>
        <div class="phase ${busy ? 'busy' : ''} ${this._error ? 'error' : ''}" role="status" aria-live="polite"><span class="phase-dot" aria-hidden="true"></span><strong>${escHtml(phaseTitle)}</strong>${busy || this._error || this._phase ? `<p>${escHtml(phaseNote)}</p>` : '<span class="phase-guide">选择招式 · 布置战术</span>'}</div>
        ${active ? `<div class="command"><div class="command-board"><div class="move-deck">
          <div class="section-heading"><div><span class="section-index">01 / ACTION</span><h3>${this._expanded ? '招式一览' : '选择招式'}</h3></div>${skills.length > 0 ? `<button type="button" class="quiet expand-moves" data-expand data-focus="expand" ${busy ? 'disabled' : ''} aria-expanded="${this._expanded}">${this._expanded ? '返回快捷栏' : `全部招式 <span>${skills.length}</span>`}${icon('chevron-down', 13)}</button>` : ''}</div>
          ${this._expanded ? `<div class="filters" role="group" aria-label="招式分类">${categories.map(category => `<button type="button" class="filter ${category === this._filter ? 'active' : ''}" data-filter="${escHtml(category)}" data-focus="filter:${escHtml(category)}" ${busy ? 'disabled' : ''} aria-pressed="${category === this._filter}">${escHtml(category)}</button>`).join('')}</div>` : ''}
          <div class="move-grid ${this._expanded ? 'expanded' : ''}">${visible.map((move, index) => this._moveCard(move, index, busy)).join('')}</div>${!visible.length ? '<div class="empty">暂无固定招式，打开全部招式挑选。</div>' : ''}
          <div class="tactics" role="group" aria-label="基础战术">${tactics.map(move => `<button type="button" class="tactic ${this._selected === move.id ? 'selected' : ''}" data-move="${escHtml(move.id)}" data-focus="move:${escHtml(move.id)}" aria-pressed="${this._selected === move.id}" ${busy ? 'disabled' : ''}>${icon(move.kind === 'guard' ? 'settings' : move.kind === 'observe' ? 'zen' : move.kind === 'retreat' ? 'log-in' : 'zap', 15)}<span>${escHtml(move.name)}</span></button>`).join('')}</div>
          </div><aside class="command-detail">${this._selection(state, selected, busy)}</aside></div><p class="freeform">${icon('pencil', 12)} 可在正文输入框补充目标，或写下自己的战术。</p></div>` : '<p class="finished-note">本场交锋已结束。末次战报为你保留。</p>'}
        ${events.length ? `<div class="report"><details ${this._reportOpen || !active ? 'open' : ''}><summary>末次战报<span>ROUND ${String(Math.max(1, Number(combat.last_round?.turn) || round)).padStart(2, '0')} · ${events.length} 条记录</span></summary><ol class="report-list">${events.map(entry => `<li>${escHtml(entry.message || entry.log || [entry.actor === 'player' ? '我方' : combat.enemy_name, entry.action_name || entry.action_type, entry.result].filter(Boolean).join(' · '))}</li>`).join('')}</ol></details></div>` : ''}
      </section>`;
    this._bind(moves, busy);
    if (focusKey) [...this.shadowRoot.querySelectorAll('[data-focus]')].find(el => el.dataset.focus === focusKey)?.focus({ preventScroll: true });
  }
  _bind(moves, busy) {
    this.shadowRoot.querySelector('[data-close-panel]')?.addEventListener('click', () => {
      if (!this._busy && !this.hasAttribute('data-disabled')) eventBus.emit('combat:panel-close');
    });
    this.shadowRoot.querySelector('[data-expand]')?.addEventListener('click', () => { if (busy) return; this._expanded = !this._expanded; this.render(); });
    this.shadowRoot.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { if (busy) return; this._filter = button.dataset.filter; this.render(); }));
    this.shadowRoot.querySelectorAll('[data-move]').forEach(button => button.addEventListener('click', () => {
      if (busy) return;
      const move = moves.find(item => item.id === button.dataset.move);
      if (!move) return;
      this._pinPicker = false;
      this._selected = move.id;
      eventBus.emit('combat:select-action', { moveId: move.id, message: this._message(move) });
      this.render();
    }));
    this.shadowRoot.querySelector('[data-pin]')?.addEventListener('click', () => {
      if (busy || this._shortcutLoading) return;
      const ids = this._currentQuick.map(move => move.id);
      if (ids.includes(this._selected)) this._saveShortcuts(ids.filter(id => id !== this._selected));
      else if (ids.length < 4) this._saveShortcuts([...ids, this._selected]);
      else this._pinPicker = !this._pinPicker;
      this.render();
    });
    this.shadowRoot.querySelectorAll('[data-replace]').forEach(button => button.addEventListener('click', () => {
      if (busy || this._shortcutLoading) return;
      const ids = this._currentQuick.map(move => move.id);
      const index = Number(button.dataset.replace);
      if (index >= 0 && index < ids.length && this._selected) {
        ids[index] = this._selected;
        this._saveShortcuts(ids); this._pinPicker = false; this.render();
        this.shadowRoot.querySelector('[data-pin]')?.focus({ preventScroll: true });
      }
    }));
    this.shadowRoot.querySelector('[data-clear]')?.addEventListener('click', () => {
      const previous = this._selected;
      this._selected = null;
      eventBus.emit('combat:select-action', { moveId: null, message: '' });
      this.render();
      [...this.shadowRoot.querySelectorAll('[data-move]')].find(button => button.dataset.move === previous)?.focus({ preventScroll: true });
    });
    this.shadowRoot.querySelector('[data-submit]')?.addEventListener('click', () => {
      if (this._busy || this.hasAttribute('data-disabled')) return;
      const move = moves.find(item => item.id === this._selected);
      if (!move || (move.kind === 'item' && move.available === false)) return;
      eventBus.emit('combat:submit-action', { moveId: move.id, message: this._message(move) });
    });
  }
  setActionDisabled(disabled) { this.toggleAttribute('data-disabled', Boolean(disabled)); }
}

customElements.define('combat-arena', CombatArena);
export default CombatArena;


