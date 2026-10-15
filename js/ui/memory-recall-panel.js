import { eventBus } from '../core/event-bus.js';
import { getMemoryRecallTrace } from '../core/memory-recall-trace.js';
import { escHtml, escAttr } from '../utils/format.js';

class MemoryRecallPanel extends HTMLElement {
  connectedCallback() {
    this.unsubscribe?.(); this.unsubscribe = eventBus.on('memory:recall-trace', () => this.render());
    this.render();
  }
  disconnectedCallback() { this.unsubscribe?.(); }
  render() {
    const trace = getMemoryRecallTrace();
    const editable = new Set(['pins', 'facts', 'long_term', 'clues', 'important_events']);
    this.innerHTML = `<style>
      memory-recall-panel{display:block;margin-bottom:18px}memory-recall-panel>details{border:1px solid #ffffff20;background:#ffffff04;border-radius:12px;padding:16px}memory-recall-panel summary{cursor:pointer;color:var(--c-text,#d9d4c9);font-weight:600}memory-recall-panel p{color:var(--c-text-muted,#9ba5ad);font-size:12px;line-height:1.8}memory-recall-panel article{border-top:1px solid #ffffff14;padding:10px 0}memory-recall-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.8 system-ui;max-height:260px;overflow:auto;color:var(--c-text,#d9d4c9)}memory-recall-panel .source{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;color:var(--c-text-muted,#9ba5ad);font-size:12px;margin:8px 0}memory-recall-panel button{white-space:normal;text-align:left;min-height:34px}
    </style><details><summary>本轮记忆依据${trace ? ` · ${trace.sections.length} 组` : ''}</summary>
      <p>${trace ? `第 ${trace.turn} 回合构建的本地记忆上下文。这里只展示实际纳入预算的内容；后续提示词处理可能继续裁剪。` : '生成下一回合后，可在这里查看本地记忆选中了哪些内容。刷新、读档或修订记忆后会清空。'}</p>
      ${trace?.sections.map((section, index) => `<article><strong>${escHtml(section.title)}</strong><pre>${escHtml(section.text)}</pre>${section.sources.map((source, sourceIndex) => `<div class="source"><span>${source.fromTurn != null ? `来源：第 ${Number(source.fromTurn)}${source.toTurn !== source.fromTurn && source.toTurn != null ? `–${Number(source.toTurn)}` : ''} 回合` : '来源：当前记忆记录，未标注原始回合'}${source.eventId ? ` · ${escHtml(source.eventId)}` : ''}</span>${editable.has(source.field) && source.text ? `<button type="button" class="btn ghost btn-xs" data-trace-section="${index}" data-trace-source="${sourceIndex}" title="查找：${escAttr(source.text.slice(0, 100))}">查找并修订：${escHtml(source.text.slice(0, 28))}${source.text.length > 28 ? '…' : ''}</button>` : ''}</div>`).join('')}</article>`).join('') || ''}
    </details>`;
    this.querySelectorAll('[data-trace-section]').forEach(button => button.onclick = () => {
      const source = trace.sections[Number(button.dataset.traceSection)]?.sources[Number(button.dataset.traceSource)];
      if (source) this.dispatchEvent(new CustomEvent('memory-locate-fact', { bubbles: true, detail: { text: source.text, field: source.field } }));
    });
  }
}
customElements.define('memory-recall-panel', MemoryRecallPanel);
