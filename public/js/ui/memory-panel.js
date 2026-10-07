// 记忆编年面板 — 独立 Web Component,挂载在设置面板 tab-memory 内
import { stateManager } from '../core/state-manager.js';
import { eventBus } from '../core/event-bus.js';
import { memorySystem } from '../systems/memory-system.js';
import { getMemoryConfig, saveMemoryConfig } from '../data/memory-config.js';
import { icon } from '../utils/icons.js';
import './memory-facts-editor.js';
import { projectCorrectedMemory } from '../core/memory-corrections.js';

class MemoryPanel extends HTMLElement {
  connectedCallback() {
    this._subscriptions?.dispose();
    this._subscriptions = eventBus.createDisposeBag();
    for (const event of ['memory:corrected', 'state:restored']) this._subscriptions.on(event, () => this.refreshStats());
    this._render();
  }

  disconnectedCallback() { this._subscriptions?.dispose(); }

  /* ────────── 渲染 ────────── */

  _render() {
    const cfg = getMemoryConfig();
    this.innerHTML = `
      <memory-facts-editor></memory-facts-editor>
      <div class="pane-grid">
        <section>
          <h3>深度整理</h3>
          <div class="grid">
            <label>启用 AI 滚动压缩</label>
            <div>
              <input type="checkbox" name="memAiCompressionEnabled" ${cfg.aiCompressionEnabled ? 'checked' : ''}>
              <div class="hint" style="font-size:10px;color:var(--c-text-muted);margin-top:2px;">默认关闭。达到压缩阈值时会产生额外后台模型调用；关闭后仍会使用本地无 API 压缩。</div>
            </div>
            <label>启用深度整理</label>
            <div>
              <input type="checkbox" name="memDeepEnabled" ${cfg.deepEnabled ? 'checked' : ''}>
              <div class="hint" style="font-size:10px;color:var(--c-text-muted);margin-top:2px;">默认关闭。开启后系统会在后台定期调用模型清理旧记忆，固化重要情节。</div>
            </div>
            <label>整理周期(回合)</label>
            <div>
              <input type="number" name="memDeepCycle" min="12" max="100" value="${cfg.deepCycle}">
              <div class="hint" style="font-size:10px;color:var(--c-text-muted);margin-top:2px;">每隔多少回合触发一次整理，建议30-50。</div>
            </div>
            <label>使用模型</label>
            <div>
              <select name="memDeepModel">
                <option value="main" ${cfg.deepModel === 'main' ? 'selected' : ''}>主模型</option>
                <option value="updater" ${cfg.deepModel === 'updater' ? 'selected' : ''}>二次变量模型</option>
              </select>
              <div class="hint" style="font-size:10px;color:var(--c-text-muted);margin-top:2px;">指定哪一个模型进行清洗，二次模型能节约主模型的开销。</div>
            </div>
          </div>
          <div style="margin-top:12px;">
            <button type="button" class="btn ghost btn-xs" data-action="mem-deep-now">立即整理</button>
            <span class="hint" style="margin-left:8px;font-size:11px;color:var(--c-text-muted);">不阻塞游戏,失败静默放弃</span>
          </div>
        </section>
        <section>
          <h3>分层与检索</h3>
          <div class="grid">
            <label>章节窗口(回合)</label>
            <div>
              <input type="number" name="memChapterWindow" min="5" max="30" value="${cfg.chapterWindow}">
              <div class="hint" style="font-size:10px;color:var(--c-text-muted);margin-top:2px;">每次整合历史摘要所涉及的最小回合跨度。</div>
            </div>
            <label>回合小结上限</label>
            <div>
              <input type="number" name="memMaxTurnSummaries" min="4" max="20" value="${cfg.maxTurnSummaries}">
              <div class="hint" style="font-size:10px;color:var(--c-text-muted);margin-top:2px;">未固化的零散回合小结允许保留的最大条数。</div>
            </div>
            <label>注入预算(字符)</label>
            <div>
              <input type="number" name="memPromptBudget" min="3000" max="20000" value="${cfg.promptBudget}">
              <div class="hint" style="font-size:10px;color:var(--c-text-muted);margin-top:2px;">提供给 AI 的记忆上下文最大字符数(Token容量保护)。</div>
            </div>
            <label>facts 上限</label>
            <div>
              <input type="number" name="memFactsLimit" min="30" max="300" value="${cfg.factsLimit}">
              <div class="hint" style="font-size:10px;color:var(--c-text-muted);margin-top:2px;">“事实碎片”的最大条数，超出后旧碎片会被打包压缩。</div>
            </div>
            <label>归档上限</label>
            <div>
              <input type="number" name="memArchivedLimit" min="100" max="2000" value="${cfg.archivedLimit}">
              <div class="hint" style="font-size:10px;color:var(--c-text-muted);margin-top:2px;">历史存档区最大容纳的记录量。</div>
            </div>
            <label>启用 &lt;recall&gt; 协议</label>
            <div>
              <input type="checkbox" name="memRecallEnabled" ${cfg.recallEnabled ? 'checked' : ''}>
              <div class="hint" style="font-size:10px;color:var(--c-text-muted);margin-top:2px;">开启后允许 AI 在交互中主动请求召回特定人物或地点的历史记忆。</div>
            </div>
            <label>召回有效期(回合)</label>
            <div>
              <input type="number" name="memRecallLifetime" min="1" max="10" value="${cfg.recallLifetime}">
              <div class="hint" style="font-size:10px;color:var(--c-text-muted);margin-top:2px;">召回内容的生效时限，超时将自动从上下文中卸载。</div>
            </div>
          </div>
        </section>
      </div>
      <div class="pane-grid" style="margin-top:18px;">
        <section>
          <h3>置顶角色记忆</h3>
          <div class="grid">
            <label>启用自动总结</label>
            <div>
              <input type="checkbox" name="memNpcSummaryEnabled" ${cfg.npcSummaryEnabled ? 'checked' : ''}>
              <div class="hint" style="font-size:10px;color:var(--c-text-muted);margin-top:2px;">开启后，置顶(📌)的重要角色会自动在后台调用主模型总结互动历史，防止长期遗忘。</div>
            </div>
            <label>总结频率(互动次)</label>
            <div>
              <input type="number" name="memNpcSummaryFrequency" min="5" max="30" value="${cfg.npcSummaryFrequency || 10}">
              <div class="hint" style="font-size:10px;color:var(--c-text-muted);margin-top:2px;">每累计N次有效互动(产生历史/心声)后触发一次小结，10次小结后自动大总结。</div>
            </div>
          </div>
        </section>
        <section>
          <h3>体积统计</h3>
          <div class="mem-stats" data-mem-stats>计算中…</div>
        </section>
        <section>
          <h3 style="display:flex;align-items:center;gap:6px;color:var(--c-accent);">${icon('database', 18)} 动态记忆库 (Memory Bank)</h3>
          <div class="mem-chapters" data-mem-chapters style="max-height:400px;overflow:auto;font-size:12px;padding-right:8px;">加载中…</div>
        </section>
      </div>`;

    // 字段变更即时保存
    const memFields = ['memAiCompressionEnabled','memDeepEnabled','memDeepCycle','memDeepModel','memChapterWindow',
      'memMaxTurnSummaries','memPromptBudget','memFactsLimit','memArchivedLimit',
      'memRecallEnabled','memRecallLifetime','memNpcSummaryEnabled','memNpcSummaryFrequency'];
    for (const f of memFields) {
      const el = this.querySelector(`[name="${f}"]`);
      if (el) el.addEventListener('change', () => this._onFieldChange());
    }

    // 立即整理按钮
    const deepBtn = this.querySelector('[data-action="mem-deep-now"]');
    if (deepBtn) deepBtn.addEventListener('click', () => this._runDeepConsolidateNow());

    this.refreshStats();
  }

  /* ────────── 表单读写 ────────── */

  _getVal(name) {
    const el = this.querySelector(`[name="${name}"]`);
    if (!el) return undefined;
    return el.type === 'checkbox' ? el.checked : el.value;
  }

  _onFieldChange() {
    const config = saveMemoryConfig({
      aiCompressionEnabled: this._getVal('memAiCompressionEnabled'),
      deepEnabled: this._getVal('memDeepEnabled'),
      deepCycle: Number(this._getVal('memDeepCycle')) || 36,
      deepModel: this._getVal('memDeepModel') === 'updater' ? 'updater' : 'main',
      chapterWindow: Number(this._getVal('memChapterWindow')) || 10,
      maxTurnSummaries: Number(this._getVal('memMaxTurnSummaries')) || 8,
      promptBudget: Number(this._getVal('memPromptBudget')) || 7200,
      factsLimit: Number(this._getVal('memFactsLimit')) || 90,
      archivedLimit: Number(this._getVal('memArchivedLimit')) || 600,
      recallEnabled: this._getVal('memRecallEnabled'),
      recallLifetime: Number(this._getVal('memRecallLifetime')) || 3,
      npcSummaryEnabled: this._getVal('memNpcSummaryEnabled'),
      npcSummaryFrequency: Number(this._getVal('memNpcSummaryFrequency')) || 10
    });
    this.dispatchEvent(new CustomEvent('memory-config:changed', {
      bubbles: true,
      composed: true,
      detail: { config }
    }));
  }

  /* ────────── 统计与浏览 ────────── */

  refreshStats() {
    const statsEl = this.querySelector('[data-mem-stats]');
    const chapEl = this.querySelector('[data-mem-chapters]');
    if (!statsEl || !chapEl) return;
    try {
      const stats = memorySystem.getMemoryStats?.() || null;
      if (!stats) { statsEl.textContent = '记忆系统未就绪'; return; }
      const c = stats.chars;
      statsEl.innerHTML = (
        `<div style="font-size:11px;line-height:1.7;">` +
        `<div>当前回合: <b>${stats.turn}</b> · 上次整理: <b>${stats.lastDeepTurn}</b></div>` +
        `<div>facts: ${stats.factsCount}条 / ${c.facts}字 · 归档: ${stats.archivedCount}条 / ${c.archived}字</div>` +
        `<div>clues: ${stats.cluesCount} · pins: ${stats.pinsCount} · NPC: ${stats.npcCount}</div>` +
        `<div>章节: ${stats.chapterCount} · 卷: ${stats.volumeCount} · 待归章缓冲: ${stats.pendingBuffer}字</div>` +
        `<div>recent: ${c.recent}字 · compressed: ${c.compressed}字</div>` +
        `<div>历史梳理: ${(c.chapters + c.volumes || 0).toLocaleString()}字 (chapters+volumes)</div>` +
        `</div>`
      );
      const mem = projectCorrectedMemory(stateManager.getSub('_memory'));
      let chapters = [];
      try { chapters = JSON.parse(mem?.chapters || '[]'); } catch {}

      // Render Memory Bank (章节与最新记忆)
      let recentFactsHTML = '<div style="opacity:0.6;font-size:11px;">暂无近期事实记忆</div>';
      const facts = mem?.facts ? mem.facts.split('\n').filter(Boolean) : [];
      if (facts.length > 0) {
        const recentFacts = facts.slice(-10).reverse();
        recentFactsHTML = recentFacts.map(fact =>
          `<div style="padding:6px 8px;margin-bottom:6px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.05);border-radius:4px;">
            <span style="color:var(--c-shuiro);margin-right:4px;">✦</span> ${this._esc(fact)}
          </div>`
        ).join('');
      }

      let chaptersHTML = '<div style="opacity:0.6;font-size:11px;">尚无章节(系统将根据周期自动固化)</div>';
      if (chapters.length) {
        chaptersHTML = chapters.slice(-3).reverse().map(ch =>
          `<div style="padding:8px;margin-bottom:8px;background:rgba(235,97,63,0.05);border-left:2px solid var(--c-shuiro);border-radius:0 4px 4px 0;">
            <div style="font-weight:600;margin-bottom:4px;">[第${ch.id}章] ${this._esc(ch.title || '无名章节')} <span style="opacity:0.6;font-size:10px;font-weight:normal;">(${ch.from}-${ch.to}回合)</span></div>
            <div style="font-size:11px;opacity:0.85;line-height:1.5;">${this._esc(ch.summary || '')}</div>
          </div>`
        ).join('');
      }

      chapEl.innerHTML = `
        <div style="margin-bottom:16px;">
          <h4 style="font-size:12px;color:var(--c-text-muted);margin:0 0 8px 0;display:flex;align-items:center;gap:4px;">${icon('file-text', 14)} 近期新增记忆 (Facts)</h4>
          <div id="memory-facts" style="display:flex;flex-direction:column;gap:4px;">
            ${recentFactsHTML}
          </div>
          <h4 style="font-size:12px;color:var(--c-text-muted);margin:0 0 8px 0;display:flex;align-items:center;gap:4px;">${icon('book-open', 14)} 最新大总结 (Chapters)</h4>
          ${chaptersHTML}
        </div>
      `;

    } catch (e) {
      statsEl.textContent = '统计不可用: ' + e.message;
    }
  }

  /* ────────── 操作 ────────── */

  async _runDeepConsolidateNow() {
    const Modal = customElements.get('game-modal');
    if (!Modal) return;
    const ok = await Modal.confirm({
      title: '深度整理',
      message: '将立即调用主模型清洗记忆库(不阻塞游戏,失败静默放弃)。是否继续?',
      okLabel: '开始整理',
      cancelLabel: '取消'
    });
    if (!ok) return;
    const cfg = getMemoryConfig();
    const apiCfg = stateManager.getAPIConfig?.() || {};
    const updater = apiCfg.variableUpdater;
    const useUpdater = cfg.deepModel === 'updater' && updater?.enabled && updater.model;
    const acfg = useUpdater
      ? {
          backend: (updater.backend && updater.backend !== 'inherit') ? updater.backend : apiCfg.backend,
          apiUrl: updater.apiUrl || apiCfg.apiUrl,
          apiKey: updater.apiKey || apiCfg.apiKey,
          model: updater.model || apiCfg.model
        }
      : apiCfg;
    if (!acfg.model) {
      eventBus.emit('pipeline:warning', { warning: 'API 配置不完整,无法整理记忆' });
      return;
    }
    const { AIClient } = await import('../core/ai-client.js');
    const client = new AIClient();
    client.configure(acfg);
    eventBus.emit('pipeline:warning', { warning: '深度整理已启动,完成后通知' });
    memorySystem.deepConsolidate(client, { force: true }).then(did => {
      this.refreshStats();
      eventBus.emit('pipeline:warning', { warning: did ? '记忆深度整理完成' : '整理未执行(内容不足或调用失败)' });
    }).catch((error) => {
      eventBus.emit('pipeline:warning', { warning: `记忆深度整理失败: ${error?.message || '未知错误'}` });
    });
  }

  _esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

customElements.define('memory-panel', MemoryPanel);
export default MemoryPanel;
