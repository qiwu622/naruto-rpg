import { timelineStorageTask } from '../core/timeline-storage-client.js';
import { personalSaveLibrary } from '../core/personal-save-library.js';
import { escHtml, escAttr } from '../utils/format.js';

const size = bytes => `${((bytes || 0) / 1024 / 1024).toFixed(2)} MB`;

export async function openStorageManager({ onChanged = () => {} } = {}) {
  await import('./modal.js');
  const modal = document.createElement('game-modal'); document.body.append(modal);
  modal.show({ title: '本机空间管理', wide: true, content: '<storage-manager-panel></storage-manager-panel>' });
  const panel = modal.shadowRoot.querySelector('storage-manager-panel'); panel.onChanged = onChanged;
  await panel.refresh();
  return modal;
}

class StorageManagerPanel extends HTMLElement {
  constructor() {
    super(); this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `<style>
      :host{display:block;color:#e8e4d9;font:14px/1.7 system-ui}*{box-sizing:border-box}
      p{color:#a6adb7;font-size:12px}button{font:inherit;cursor:pointer;padding:9px 13px;color:#e8e4d9;border:1px solid #ffffff24;border-radius:9px;background:#ffffff08;min-height:40px}button:hover{background:#ffffff14}button:disabled{opacity:.5;cursor:default}button:focus-visible{outline:2px solid #efaa78;outline-offset:3px}
      .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.tile{padding:17px;border:1px solid #ffffff18;border-radius:12px;background:#ffffff04}.tile span{display:block;color:#a6adb7;font-size:12px}.tile strong{display:block;font-size:23px;margin-top:5px;font-weight:500}
      .actions{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}.status{white-space:pre-wrap;overflow-wrap:anywhere;color:#d7c3a6;min-height:24px}.job{border:1px solid #c1956633;border-radius:12px;padding:15px;margin:10px 0}.job strong{overflow-wrap:anywhere}.job p{margin:6px 0 10px}.job button{margin-right:8px}h3{font-size:14px;margin-top:24px}progress{width:100%;accent-color:#d8a173}#pause{border-color:#d8a17380}[hidden]{display:none!important}
      @media(max-width:420px){.grid{gap:8px}.tile{padding:12px}.tile strong{font-size:19px}}
    </style>
    <p>数据大小为估算值，共享内容只统计一次。完整原档不会自动删除。</p>
    <div class="grid" id="usage"></div><p id="site"></p>
    <div class="actions"><button id="refresh">重新统计</button><button id="clean">清理未引用数据</button><button id="pause" hidden>暂停整理</button></div>
    <div id="status" class="status" role="status" aria-live="polite"></div><div id="jobs"></div>
    <p>无损整理保留全部回合、变量、记忆和 IF 线。读取整理副本确认无误后，可自行导出并管理原档；保留原档期间，总占用不会立即下降。</p>`;
    this.$('#refresh').onclick = () => this.refresh();
    this.$('#clean').onclick = () => this.run(async context => {
      const result = await personalSaveLibrary.exclusive(() => timelineStorageTask('cleanup', {}, context));
      await this.load(context); this.message(`已清理 ${result.removedChunks} 个未引用数据块（${size(result.freedBytes)}）。完整存档和未完成任务均保留。`);
    });
    this.$('#pause').onclick = () => this.controller?.abort();
    this.$('#jobs').onclick = event => {
      const button = event.target.closest('button[data-action]');
      if (!button || button.disabled) return;
      void this.run(async context => {
        if (button.dataset.action === 'resume') {
          const result = await personalSaveLibrary.exclusive(() => timelineStorageTask('resume-compaction', { id: button.dataset.id }, context));
          await this.load(context); this.message(`「${result.label}」已完成，可回到存档库读取；原档保留。`);
        } else {
          const confirmed = await customElements.get('game-modal').confirm({ title: '清理未完成任务', message: '删除这个尚未完成的副本？原存档和当前进度都会保留。', okLabel: '清理副本', cancelLabel: '取消' });
          if (!confirmed) return;
          await personalSaveLibrary.exclusive(() => timelineStorageTask('discard-job', { id: button.dataset.id }, context));
          await this.load(context); this.message('未完成的副本已清理，原档保留。');
        }
        await this.onChanged?.();
      });
    };
  }
  disconnectedCallback() { this.controller?.abort(); }
  $(selector) { return this.shadowRoot.querySelector(selector); }
  message(text) { this.$('#status').textContent = text; }
  disabled(busy) {
    this.shadowRoot.querySelectorAll('button').forEach(button => { button.disabled = busy && button.id !== 'pause'; });
    this.$('#pause').hidden = !busy;
  }
  async run(operation) {
    if (this.busy) return;
    this.busy = true; this.controller = new AbortController(); this.disabled(true);
    try { await operation({ signal: this.controller.signal, onProgress: text => this.message(text) }); }
    catch (error) { this.message(error.name === 'AbortError' ? '操作已暂停，原档保留。点击重新统计后可继续整理。' : error.message); }
    finally { this.busy = false; this.controller = null; this.disabled(false); }
  }
  async refresh() { return this.run(context => this.load(context)); }
  async load(context) {
    this.message('正在统计本机存档空间…');
    const stats = await timelineStorageTask('storage-stats', {}, context);
    const entries = [['当前冒险', stats.currentBytes], ['存档库 · 回合记录', stats.archiveBytes], ['共用状态与记忆', stats.sharedBytes], ['未完成副本', stats.temporaryBytes], ['可清理数据', stats.unusedBytes]];
    this.$('#usage').innerHTML = entries.map(([label, bytes]) => `<div class="tile"><span>${label}</span><strong>${size(bytes)}</strong></div>`).join('');
    const quota = await navigator.storage?.estimate?.().catch(() => null);
    this.$('#site').textContent = quota ? `本站点总占用 ${size(quota.usage)} · 浏览器可用配额 ${size(quota.quota)}。包含旧格式存档、联机档、图片缓存等其他站点数据。` : '浏览器未提供站点总占用信息。';
    this.$('#jobs').innerHTML = `<h3>未完成任务 · ${stats.jobs.length}</h3>${stats.jobs.length ? stats.jobs.map(job => `<section class="job"><strong>${escHtml(job.label)}</strong><p>${job.resumable ? `已校验 ${job.completed} / ${job.total} 个回合，续做会从上次位置开始。` : '旧版遗留任务，可清理临时副本后重新生成。'}</p>${job.resumable ? `<progress max="${job.total || 1}" value="${job.completed}" aria-label="已校验回合数"></progress><button data-action="resume" data-id="${escAttr(job.id)}">继续整理</button>` : ''}<button data-action="discard" data-id="${escAttr(job.id)}">清理副本</button></section>`).join('') : '<p>没有未完成任务。</p>'}`;
    this.message('统计完成。'); this.disabled(this.busy);
  }
}
customElements.define('storage-manager-panel', StorageManagerPanel);
