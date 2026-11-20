import { timelineStorageTask } from '../core/timeline-storage-client.js';
import { personalSaveLibrary } from '../core/personal-save-library.js';
import { inspectSaveHealth, requestPersistentStorage } from '../core/save-health.js';
import {
  getExternalBackupStatus,
  chooseBackupDirectory,
  clearBackupDirectory,
  setAutoBackupEnabled,
  backupCurrentToExternal,
  listNativeBackups,
  exportNativeBackup,
  restoreNativeBackup,
  exportEmergencyBundle
} from '../core/external-backup.js';
import { isNativeAndroidApp } from '../core/runtime-platform.js';
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
      .actions{display:flex;gap:10px;flex-wrap:wrap;margin:18px 0}.status{white-space:pre-wrap;overflow-wrap:anywhere;color:#d7c3a6;min-height:24px}.job{border:1px solid #c1956633;border-radius:12px;padding:15px;margin:10px 0}.job strong{overflow-wrap:anywhere}.job p{margin:6px 0 10px}.job button{margin-right:8px}h3{font-size:14px;margin-top:24px}progress{width:100%;accent-color:#d8a173}#pause{border-color:#d8a17380}
      .health{border:1px solid #ffffff1f;border-radius:12px;padding:14px 16px;margin:0 0 16px;background:#ffffff06}.health.warn{border-color:#d8a17380;background:#d8a17314}.health.danger{border-color:#e07a6e88;background:#e07a6e18}
      .ext-box{border:1px solid #ffffff1f;border-radius:12px;padding:16px;margin:16px 0;background:#ffffff04}.ext-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:8px 0}.ext-toggle{display:flex;align-items:center;gap:8px;cursor:pointer;color:#e8e4d9;font-size:13px}.ext-backup-item{border-top:1px solid #ffffff16;padding:10px 0;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center}
      [hidden]{display:none!important}
      @media(max-width:420px){.grid{gap:8px}.tile{padding:12px}.tile strong{font-size:19px}}
    </style>
    <p>数据大小为估算值，共享内容只统计一次。完整原档不会自动删除。</p>
    <div id="health" class="health" hidden></div>
    <div class="grid" id="usage"></div><p id="site"></p>
    <div class="actions"><button id="refresh">重新统计</button><button id="clean">清理未引用数据</button><button id="persist" hidden>申请持久存储保护</button><button id="pause" hidden>暂停整理</button></div>
    <div id="status" class="status" role="status" aria-live="polite"></div>
    <section id="external" class="ext-box" hidden>
      <h3 style="margin-top:0">外部可见备份（防崩溃丢失）</h3>
      <p id="ext-desc"></p>
      <label class="ext-toggle"><input id="ext-auto" type="checkbox"> <span>每回合自动滚动备份到外部目录（保留最近 3 份）</span></label>
      <div class="actions" style="margin:12px 0">
        <button id="ext-backup">立即备份到外部目录 (v2)</button>
        <button id="ext-choose">选择备份文件夹</button>
        <button id="ext-clear" hidden>恢复默认目录</button>
        <button id="ext-emergency" hidden>导出全部急救数据包 (.zip)</button>
      </div>
      <div id="ext-list"></div>
    </section>
    <div id="jobs"></div>
    <p>无损整理保留全部回合、变量、记忆和 IF 线。读取整理副本确认无误后，可自行导出并管理原档；保留原档期间，总占用不会立即下降。</p>`;
    this.$('#refresh').onclick = () => this.refresh();
    this.$('#persist').onclick = () => this.run(async context => {
      const res = await requestPersistentStorage();
      await this.load(context);
      this.message(res.persisted ? '已授予持久存储保护，浏览器不会随意回收本地存档。' : '浏览器暂未授予自动持久保护，建议定期开启外部备份或导出文件。');
    });
    this.$('#clean').onclick = () => this.run(async context => {
      const result = await personalSaveLibrary.exclusive(() => timelineStorageTask('cleanup', {}, context));
      await this.load(context); this.message(`已清理 ${result.removedChunks} 个未引用数据块（${size(result.freedBytes)}）。完整存档和未完成任务均保留。`);
    });
    this.$('#pause').onclick = () => this.controller?.abort();
    this.$('#ext-auto').onchange = () => this.run(async context => {
      const checked = this.$('#ext-auto').checked;
      await setAutoBackupEnabled(checked);
      await this.loadExternal(context);
      this.message(checked ? '已开启自动外部备份（滚动保留最近 3 份）。' : '已暂停自动外部备份；您仍可随时手动点击立即备份。');
    });
    this.$('#ext-backup').onclick = () => this.run(async context => {
      this.message('正在生成去重紧凑 v2 备份并写入外部目录…');
      const res = await backupCurrentToExternal({ reason: 'manual', ...context });
      await this.loadExternal(context);
      this.message(`外部备份完成：${res.fileName || '已写入'}（${size(res.bytes || 0)}）。`);
    });
    this.$('#ext-choose').onclick = () => this.run(async context => {
      const res = await chooseBackupDirectory();
      if (res?.cancelled) { this.message('已取消更改目录。'); return; }
      await this.loadExternal(context);
      this.message(`已绑定外部备份目录：${res?.label || '自定义目录'}。`);
    });
    this.$('#ext-clear').onclick = () => this.run(async context => {
      await clearBackupDirectory();
      await this.loadExternal(context);
      this.message('已恢复使用默认备份位置。');
    });
    this.$('#ext-emergency').onclick = () => this.run(async () => {
      this.message('正在打包本机 WebView 与备份保险箱数据 (.zip)…');
      const res = await exportEmergencyBundle();
      this.message(res?.cancelled ? '已取消急救导出。' : `急救数据包已保存：${res?.fileName || '完成'}`);
    });
    this.$('#ext-list').onclick = event => {
      const button = event.target.closest('button[data-vault-action]');
      if (!button || button.disabled) return;
      const action = button.dataset.vaultAction;
      const id = button.dataset.id;
      void this.run(async context => {
        if (action === 'export') {
          const res = await exportNativeBackup(id);
          this.message(res?.cancelled ? '已取消导出。' : `已另存副本：${res?.fileName || '完成'}`);
        } else if (action === 'restore') {
          const confirmed = await customElements.get('game-modal').confirm({
            title: '从外部保险箱恢复',
            message: '将从此外部备份导入并恢复为当前进度（恢复前会自动备份当前状态）。继续吗？',
            okLabel: '恢复此备份',
            cancelLabel: '取消'
          });
          if (!confirmed) return;
          const res = await restoreNativeBackup(id, context);
          this.message(`已恢复到第 ${res.current?.turn_number ?? 0} 回合。建议刷新游戏页面以同步显示。`);
          await this.onChanged?.();
        }
      });
    };
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
    this.shadowRoot.querySelectorAll('button,input').forEach(element => { element.disabled = busy && element.id !== 'pause'; });
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
  async loadExternal() {
    const ext = await getExternalBackupStatus().catch(() => ({ supported: false }));
    const box = this.$('#external');
    if (!box) return;
    if (!ext.supported) { box.hidden = true; return; }
    box.hidden = false;
    this.$('#ext-auto').checked = Boolean(ext.autoEnabled);
    this.$('#ext-choose').textContent = ext.mode === 'android-vault' ? '自定义额外目录 (SAF)' : '选择本机备份文件夹';
    this.$('#ext-clear').hidden = !ext.customDirectoryLabel;
    this.$('#ext-emergency').hidden = ext.mode !== 'android-vault';
    this.$('#ext-desc').textContent = ext.mode === 'android-vault'
      ? `默认写入手机「${ext.defaultPath}」（系统相册/文件管理器“文档”目录可见，App 崩溃/闪退不丢失）${ext.customDirectoryLabel ? `；已附加同步至：${ext.customDirectoryLabel}` : ''}。`
      : `将紧缩去重备份直接写入本机文件夹：${ext.customDirectoryLabel || '尚未选择（仅授权桌面 Chrome / Edge 使用）'}。`;
    const listEl = this.$('#ext-list');
    if (ext.mode === 'android-vault' || isNativeAndroidApp()) {
      const backups = await listNativeBackups().catch(() => []);
      if (!backups.length) {
        listEl.innerHTML = '<p>尚无原生保险箱备份。点击上方“立即备份”或在游戏回合后自动生成。</p>';
      } else {
        listEl.innerHTML = backups.map(b => `
          <div class="ext-backup-item">
            <div>
              <strong>${escHtml(b.fileName || b.id)}</strong>
              <p style="margin:2px 0">${b.kind === 'auto' ? '自动滚动备份' : '手动备份'} · 第 ${Number(b.turn) || 0} 回合 · ${size(b.bytes)} · ${escHtml(new Date(b.createdAt || Date.now()).toLocaleString())}</p>
            </div>
            <div>
              <button data-vault-action="export" data-id="${escAttr(b.id)}">另存</button>
              <button data-vault-action="restore" data-id="${escAttr(b.id)}">恢复</button>
            </div>
          </div>`).join('');
      }
    } else {
      listEl.innerHTML = '';
    }
  }
  async load(context) {
    this.message('正在统计本机存档空间…');
    const [stats, quota] = await Promise.all([
      timelineStorageTask('storage-stats', {}, context),
      navigator.storage?.estimate?.().catch(() => null)
    ]);
    const health = await inspectSaveHealth({ storageStats: stats, quota }).catch(() => null);
    const healthEl = this.$('#health');
    if (health && healthEl) {
      healthEl.hidden = false;
      healthEl.className = `health ${health.level}`;
      healthEl.innerHTML = `<strong>存档健康状态：${health.level === 'danger' ? '需要关注' : health.level === 'warn' ? '建议备份' : '良好'}</strong>
        <p style="margin:4px 0 0">共 ${health.totalNodes} 个回合（已后台分块压缩 ${health.compressedNodes} 个）· 持久存储：${health.persisted ? '已受保护' : '未开启'}。${health.reasons.length ? health.reasons.join('；') + '。' : ''}${health.recommendation}</p>`;
      this.$('#persist').hidden = health.persisted;
    }
    const entries = [['当前冒险', stats.currentBytes], ['存档库 · 回合记录', stats.archiveBytes], ['共用状态与记忆', stats.sharedBytes], ['未完成副本', stats.temporaryBytes], ['可清理数据', stats.unusedBytes]];
    this.$('#usage').innerHTML = entries.map(([label, bytes]) => `<div class="tile"><span>${label}</span><strong>${size(bytes)}</strong></div>`).join('');
    this.$('#site').textContent = quota ? `本站点总占用 ${size(quota.usage)} · 浏览器可用配额 ${size(quota.quota)}。包含旧格式存档、联机档、图片缓存等其他站点数据。` : '浏览器未提供站点总占用信息。';
    await this.loadExternal(context);
    this.$('#jobs').innerHTML = `<h3>未完成任务 · ${stats.jobs.length}</h3>${stats.jobs.length ? stats.jobs.map(job => `<section class="job"><strong>${escHtml(job.label)}</strong><p>${job.resumable ? `已校验 ${job.completed} / ${job.total} 个回合，续做会从上次位置开始。` : '旧版遗留任务，可清理临时副本后重新生成。'}</p>${job.resumable ? `<progress max="${job.total || 1}" value="${job.completed}" aria-label="已校验回合数"></progress><button data-action="resume" data-id="${escAttr(job.id)}">继续整理</button>` : ''}<button data-action="discard" data-id="${escAttr(job.id)}">清理副本</button></section>`).join('') : '<p>没有未完成任务。</p>'}`;
    this.message('统计完成。'); this.disabled(this.busy);
  }
}
customElements.define('storage-manager-panel', StorageManagerPanel);
