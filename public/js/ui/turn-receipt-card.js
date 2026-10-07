import { normalizeTurnReceipt, TURN_STAGE_LABELS } from '../core/turn-receipt.js';
import { turnReceiptCardStyles } from '../../css/components/turn-receipt-card.css.js';

const STATUS_LABELS = Object.freeze({ success: '已完成', partial: '部分完成', skipped: '已跳过', failed: '未完成', pending: '处理中', unknown: '未记录' });
const SAVE_REASONS = Object.freeze({ quota: '本机存储空间不足，本回合未保存。', unavailable: '本地存储暂时不可用，本回合未保存。', write_failed: '本地写入失败，本回合未保存。', receipt_failed: '结果记录未能保存，请以实际存档为准。' });
const KIND_LABELS = Object.freeze({ added: '新增', updated: '变更', removed: '移除' });

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function badge(status) {
  const node = element('span', STATUS_LABELS[status] || STATUS_LABELS.unknown, 'badge');
  node.dataset.status = status;
  return node;
}

function duration(ms) {
  if (ms == null) return '耗时未记录';
  if (ms < 1000) return '不足 1 秒';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function headline(receipt) {
  if (!receipt) return { status: 'unknown', text: '此回合未记录结果' };
  if (receipt.save.status === 'failed') return { status: 'failed', text: '本地保存未完成' };
  const statuses = [receipt.variables.status, receipt.memory.status, receipt.daily.status, receipt.save.status];
  if (statuses.some(status => ['failed', 'partial', 'skipped'].includes(status))) return { status: 'partial', text: '有项目未完成' };
  if (statuses.includes('pending')) return { status: 'pending', text: '有项目仍在处理' };
  if (statuses.includes('unknown')) return { status: 'unknown', text: '部分结果未记录' };
  return { status: 'success', text: '本回合已完成' };
}

function section(title, status, name) {
  const node = element('section', null, 'section');
  node.dataset.section = name;
  const heading = element('h3', title);
  heading.append(badge(status));
  node.append(heading);
  return node;
}

function overviewItem(label, value, changes = false) {
  const status = value?.status || 'unknown';
  const node = element('span', null, 'overview-item');
  node.dataset.status = status;
  let text = STATUS_LABELS[status] || STATUS_LABELS.unknown;
  if (changes && status === 'success') {
    if (value.total > 0) text = `${value.total} 项变化`;
    else if (value.comparisonKnown) text = '无变化';
  }
  node.append(element('span', label, 'overview-label'), element('span', text, 'overview-value'));
  return node;
}

export class TurnReceiptCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._receipt = null;
  }

  set receipt(value) {
    this._receipt = normalizeTurnReceipt(value);
    this._render();
  }

  get receipt() { return normalizeTurnReceipt(this._receipt); }
  connectedCallback() { this._render(); }

  _render() {
    const wasOpen = Boolean(this.shadowRoot.querySelector('details')?.open);
    const receipt = this._receipt;
    const style = element('style', turnReceiptCardStyles);
    const details = element('details');
    details.open = wasOpen;
    const summary = element('summary');
    const identity = element('span', null, 'summary-heading');
    identity.append(element('span', '回合结果', 'title'));
    if (receipt?.turnNumber != null) identity.append(element('span', `第 ${receipt.turnNumber} 回合`, 'turn'));
    const outcome = headline(receipt);
    details.dataset.status = outcome.status;
    const heading = element('span', outcome.text, 'headline');
    heading.dataset.status = outcome.status;
    const chevron = element('span', null, 'chevron');
    chevron.setAttribute('aria-hidden', 'true');
    const overview = element('span', null, 'overview');
    overview.append(overviewItem('变量', receipt?.variables, true), overviewItem('记忆', receipt?.memory, true),
      overviewItem('日报', receipt?.daily), overviewItem('本地保存', receipt?.save));
    summary.append(identity, heading, chevron, overview);
    details.append(summary);
    const body = element('div', null, 'body');
    details.append(body);
    if (!receipt) {
      body.append(element('p', '此回合未记录结果，无法确认当时的变量、记忆、日报及保存状态。正文仍可正常回看。', 'missing'));
    } else {
      body.append(this._variables(receipt.variables), this._memories(receipt.memory));
      const daily = section('忍界日报', receipt.daily.status, 'daily');
      daily.append(element('p', receipt.daily.status === 'success' ? `已生成${receipt.daily.issue ? ` · ${receipt.daily.issue}` : ''}`
        : receipt.daily.status === 'partial' ? '日报尚未完整生成。'
          : receipt.daily.status === 'skipped' ? '本回合未生成日报。'
            : receipt.daily.status === 'failed' ? '日报生成未完成。'
              : receipt.daily.status === 'pending' ? '日报正在生成。' : '此回合未记录日报结果。'));
      const save = section('本地保存', receipt.save.status, 'save');
      save.append(element('p', receipt.save.status === 'success' ? '本回合已保存到本机。'
        : receipt.save.status === 'failed' ? SAVE_REASONS[receipt.save.reasonCode] || SAVE_REASONS.write_failed
          : receipt.save.status === 'partial' ? '本地保存未完整完成，请以实际存档为准。'
            : receipt.save.status === 'pending' ? '正在保存到本机。'
              : receipt.save.status === 'skipped' ? '本回合未写入本地存档。' : '此回合未记录本地保存结果。'));
      body.append(daily, save, this._stages(receipt));
    }
    this.shadowRoot.replaceChildren(style, details);
  }

  _variables(value) {
    const node = section('变量变化', value.status, 'variables');
    if (value.status === 'skipped') node.append(element('p', '本回合跳过变量更新；已记录的变化会列在下方。'));
    else if (value.status === 'partial') node.append(element('p', '仅部分变量更新完成，下方为实际记录的变化。'));
    else if (value.status === 'failed') node.append(element('p', '变量更新未完成。'));
    const list = element('ul');
    for (const change of value.changes) {
      const row = element('li', null, 'change');
      const values = element('span', null, 'values');
      values.append(element('span', change.before, 'value-before'), element('span', '→', 'arrow'), element('span', change.after, 'value-after'));
      if (change.delta != null && change.delta !== 0) values.append(element('span', `(${change.delta > 0 ? '+' : ''}${change.delta})`, `delta${change.delta < 0 ? ' negative' : ''}`));
      row.append(element('span', change.label, 'label'), values);
      list.append(row);
    }
    node.append(list);
    if (!value.changes.length) node.append(element('p', value.status === 'success' && value.comparisonKnown ? '没有玩家可见的变量变化。' : '没有可展示的变化记录。', 'empty'));
    if (value.total > value.changes.length) node.append(element('p', `另有 ${value.total - value.changes.length} 项变化未在摘要中展开。`, 'more'));
    return node;
  }

  _memories(value) {
    const node = section('记忆变化', value.status, 'memory');
    if (value.status === 'partial') node.append(element('p', '记忆仅部分更新。'));
    if (value.status === 'skipped') node.append(element('p', '本回合跳过记忆更新。'));
    if (value.status === 'failed') node.append(element('p', '记忆更新未完成。'));
    const list = element('ul');
    for (const change of value.changes) {
      const row = element('li', null, 'memory-change');
      row.dataset.kind = change.kind;
      const meta = element('span', null, 'memory-meta');
      meta.append(element('span', KIND_LABELS[change.kind], 'kind'), element('span', change.label, 'memory-label'));
      row.append(meta, element('span', change.text, 'memory-text'));
      list.append(row);
    }
    node.append(list);
    if (!value.changes.length) node.append(element('p', value.status === 'success' && value.comparisonKnown ? '没有玩家可见的记忆变化。' : '没有可展示的记忆记录。', 'empty'));
    if (value.total > value.changes.length) node.append(element('p', `另有 ${value.total - value.changes.length} 项记忆变化未在摘要中展开。`, 'more'));
    return node;
  }

  _stages(receipt) {
    const node = element('section', null, 'section');
    node.dataset.section = 'stages';
    node.append(element('h3', '处理过程'));
    if (!receipt.stages.length) node.append(element('p', '此回合未记录各阶段耗时与重试次数。', 'empty'));
    else {
      const list = element('ul', null, 'stages');
      for (const stage of receipt.stages) {
        const row = element('li');
        row.append(element('span', TURN_STAGE_LABELS[stage.key]), badge(stage.status), element('span', `${duration(stage.durationMs)} · ${stage.retries == null ? '重试未记录' : `阶段重试 ${stage.retries} 次`}`, 'timing'));
        list.append(row);
      }
      node.append(list);
    }
    if (receipt.durationMs != null) node.append(element('p', `本回合用时 ${duration(receipt.durationMs)}`, 'footnote'));
    return node;
  }
}

if (!customElements.get('turn-receipt-card')) customElements.define('turn-receipt-card', TurnReceiptCard);

export function createTurnReceiptCard(receipt = null) {
  const node = document.createElement('turn-receipt-card');
  node.dataset.turnReceiptHost = '';
  node.receipt = receipt;
  return node;
}
