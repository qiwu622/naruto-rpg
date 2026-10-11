import GameModal from './modal.js';
import { appUpdateService, formatAndroidUpdateMessage } from '../core/app-update.js';
import { escHtml } from '../utils/format.js';

const size = bytes => `${(Math.max(0, Number(bytes) || 0) / 1024 / 1024).toFixed(1)} MB`;

export function openAndroidUpdatePanel(result, { service = appUpdateService, canInstall = () => true } = {}) {
  return new Promise(resolve => {
    const modal = new GameModal();
    document.body.append(modal);
    let state = { status: 'idle' }, busy = false, polling = false, closed = false, timer, notice = '';
    const finish = () => {
      closed = true; clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      service.snoozeAutomaticPrompt(result);
      resolve();
    };
    const render = () => {
      if (closed) return;
      const root = modal.shadowRoot;
      const primary = root.querySelector('[data-idx="2"]');
      const cancel = root.querySelector('[data-idx="1"]');
      const bar = root.querySelector('progress');
      const status = root.querySelector('[role="status"]');
      const active = ['downloading', 'paused'].includes(state.status);
      const ready = state.status === 'ready';
      primary.disabled = busy || active || (ready && !canInstall());
      primary.textContent = busy ? '正在处理…' : ready ? canInstall() ? '立即安装' : '等待当前回合保存' : active ? '下载中…' : state.status === 'failed' ? '重新下载' : '下载更新';
      cancel.hidden = !active && !ready; cancel.disabled = busy;
      bar.hidden = !active && !ready;
      bar.value = ready ? 1 : Math.min(1, state.receivedBytes / (state.totalBytes || 1)) || 0;
      status.textContent = notice || (ready ? '下载和校验完成。安装由安卓系统确认，本地存档会保留。'
        : active ? `${state.message || '正在下载更新'} · ${size(state.receivedBytes)} / ${size(state.totalBytes)}`
          : state.message || '下载在后台进行，关闭此窗口后可继续游玩。');
      status.classList.toggle('error', state.status === 'failed');
    };
    const operate = async action => {
      if (busy) return;
      busy = true; notice = ''; render();
      try { await action(); }
      catch (error) { notice = error.message || '更新操作失败，请重试'; }
      finally { busy = false; render(); }
    };
    async function refresh() {
      if (closed || polling || busy || document.visibilityState === 'hidden') return;
      polling = true;
      try {
        const next = await service.getDownloadStatus();
        state = next.versionCode && next.versionCode !== result.latestVersionCode
          ? { status: 'idle', message: '发现更新的安装包，点击下载更新。' } : next;
        render();
      } catch (error) { notice = error.message; render(); }
      finally { polling = false; }
    }
    modal.show({ title: `Android ${result.latestVersion} 更新公告`, onDismiss: finish,
      content: `<style>.app-update-notes{white-space:pre-wrap;overflow-wrap:anywhere}.app-update-progress{width:100%;height:8px;accent-color:var(--c-shuiro,#eb613f);margin-top:20px}.app-update-status{margin-top:12px!important;min-height:42px}.app-update-status.error{color:#ff9b83}</style>
        <div class="app-update-notes">${escHtml(formatAndroidUpdateMessage(result))}</div>
        <progress class="app-update-progress" max="1" value="0" aria-label="更新下载进度" hidden></progress>
        <p class="app-update-status" role="status" aria-live="polite"></p>`,
      buttons: [
        { label: '稍后 / 继续游玩', onClick: () => {} },
        { label: '取消下载', close: false, onClick: () => operate(async () => { state = await service.cancelDownload(); }) },
        { label: '下载更新', primary: true, close: false, onClick: () => operate(async () => {
          if (state.status === 'ready') {
            if (!canInstall()) { notice = '请等待当前回合生成与保存完成后安装'; return; }
            const installed = await service.installUpdate();
            notice = installed.requiresPermission
              ? '请在系统页面允许此 App 安装更新，返回后点击“立即安装”。'
              : '已打开系统安装页面；如果取消安装，可再次点击“立即安装”。';
          } else {
            state = await service.downloadUpdate();
            result = service.getLastResult() || result;
            modal.shadowRoot.querySelector('.title').textContent = `Android ${result.latestVersion} 更新公告`;
            modal.shadowRoot.querySelector('.app-update-notes').textContent = formatAndroidUpdateMessage(result);
          }
        }) }
      ]
    });
    render(); void refresh();
    document.addEventListener('visibilitychange', refresh);
    timer = setInterval(refresh, 1000);
  });
}
