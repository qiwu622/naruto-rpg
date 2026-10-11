// Service Worker 通知管理器
class SWNotifier {
  constructor() {
    this._init();
  }

  _init() {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      this._showUpdateNotification();
    });

    // 监听 SW 安装成功
    navigator.serviceWorker.ready.then(() => {
      const hasSeenOfflineNotice = localStorage.getItem('naruto_seen_offline_notice');
      if (!hasSeenOfflineNotice) {
        setTimeout(() => {
          this._showOfflineNotification();
          localStorage.setItem('naruto_seen_offline_notice', 'true');
        }, 3000);
      }
    });

    // 检查更新
    this._checkForUpdates();
  }

  async _checkForUpdates() {
    if (!('serviceWorker' in navigator)) return;

    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) return;

      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            this._showUpdateAvailableNotification();
          }
        });
      });

      // 每小时检查一次更新
      setInterval(() => {
        registration.update();
      }, 3600000);
    } catch (e) {
      console.warn('[SWNotifier] 检查更新失败:', e.message);
    }
  }

  _showOfflineNotification() {
    this._showToast({
      icon: '✅',
      title: '已可离线使用',
      message: '游戏资源已缓存，现在可以离线运行',
      duration: 5000,
      type: 'success'
    });
  }

  _showUpdateAvailableNotification() {
    this._showToast({
      icon: '🔄',
      title: '发现新版本',
      message: '点击刷新页面以更新到最新版本',
      duration: 0,
      type: 'info',
      actions: [
        { label: '刷新', onClick: () => window.location.reload() },
        { label: '稍后', onClick: null }
      ]
    });
  }

  _showUpdateNotification() {
    this._showToast({
      icon: '✨',
      title: '更新已就绪',
      message: '保存当前进度后手动刷新，即可使用新版本',
      duration: 3000,
      type: 'success'
    });
  }

  _showToast({ icon, title, message, duration, type, actions }) {
    const existingToast = document.querySelector('.sw-toast');
    if (existingToast) {
      existingToast.remove();
    }

    const toast = document.createElement('div');
    toast.className = `sw-toast sw-toast-${type}`;

    let actionsHtml = '';
    if (actions && actions.length) {
      actionsHtml = `
        <div class="sw-toast-actions">
          ${actions.map((action, i) => `
            <button class="sw-toast-btn" data-action="${i}">${action.label}</button>
          `).join('')}
        </div>
      `;
    }

    toast.innerHTML = `
      <div class="sw-toast-content">
        <div class="sw-toast-icon">${icon}</div>
        <div class="sw-toast-body">
          <div class="sw-toast-title">${title}</div>
          <div class="sw-toast-message">${message}</div>
        </div>
        ${!actions ? '<button class="sw-toast-close" aria-label="关闭">×</button>' : ''}
      </div>
      ${actionsHtml}
    `;

    this._injectStyles();
    document.body.appendChild(toast);

    if (actions) {
      actions.forEach((action, i) => {
        const btn = toast.querySelector(`[data-action="${i}"]`);
        if (btn) {
          btn.addEventListener('click', () => {
            if (action.onClick) action.onClick();
            toast.remove();
          });
        }
      });
    } else {
      const closeBtn = toast.querySelector('.sw-toast-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => toast.remove());
      }
    }

    if (duration > 0) {
      setTimeout(() => {
        if (toast.parentNode) toast.remove();
      }, duration);
    }
  }

  _injectStyles() {
    if (document.getElementById('sw-notifier-styles')) return;

    const style = document.createElement('style');
    style.id = 'sw-notifier-styles';
    style.textContent = `
      .sw-toast {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 10001;
        max-width: 380px;
        background: rgba(15, 13, 12, 0.95);
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        animation: slideIn 0.3s ease;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        border: 1px solid rgba(235, 97, 63, 0.3);
      }
      .sw-toast-success {
        border-color: rgba(76, 175, 80, 0.5);
      }
      .sw-toast-info {
        border-color: rgba(33, 150, 243, 0.5);
      }
      @keyframes slideIn {
        from { transform: translateX(400px); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
      }
      .sw-toast-content {
        display: flex;
        align-items: flex-start;
        padding: 16px;
        gap: 12px;
      }
      .sw-toast-icon {
        font-size: 24px;
        flex-shrink: 0;
      }
      .sw-toast-body {
        flex: 1;
        min-width: 0;
        color: #e8e4d9;
      }
      .sw-toast-title {
        font-weight: 600;
        font-size: 14px;
        margin-bottom: 4px;
      }
      .sw-toast-message {
        font-size: 13px;
        opacity: 0.9;
        line-height: 1.4;
      }
      .sw-toast-close {
        background: none;
        border: none;
        color: #e8e4d9;
        font-size: 24px;
        cursor: pointer;
        padding: 0;
        width: 24px;
        height: 24px;
        line-height: 20px;
        flex-shrink: 0;
        opacity: 0.7;
        transition: opacity 0.2s;
      }
      .sw-toast-close:hover {
        opacity: 1;
      }
      .sw-toast-actions {
        display: flex;
        gap: 8px;
        padding: 0 16px 16px;
        justify-content: flex-end;
      }
      .sw-toast-btn {
        background: rgba(235, 97, 63, 0.15);
        border: 1px solid rgba(235, 97, 63, 0.3);
        color: #eb613f;
        padding: 6px 16px;
        border-radius: 4px;
        font-size: 13px;
        cursor: pointer;
        transition: all 0.2s;
      }
      .sw-toast-btn:hover {
        background: rgba(235, 97, 63, 0.25);
        border-color: rgba(235, 97, 63, 0.5);
      }
      @media (max-width: 600px) {
        .sw-toast {
          top: 10px;
          right: 10px;
          left: 10px;
          max-width: none;
        }
      }
    `;
    document.head.appendChild(style);
  }
}

export const swNotifier = new SWNotifier();
export default swNotifier;
