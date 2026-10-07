import { authClient } from '../core/auth-client.js';
import { eventBus } from '../core/event-bus.js';
import { cloudConnectionEnabled, enableCloudConnection, getCloudConnection, nativeCloudPlugin } from '../core/project-server.js';

class AppCloudPanel extends (globalThis.HTMLElement ?? class {}) {
  constructor() { super(); this.attachShadow({ mode: 'open' }); }
  connectedCallback() {
    this.shadowRoot.innerHTML = `<style>
      :host{display:block;margin:0 0 16px}*{box-sizing:border-box}.cloud{padding:16px;border:1px solid #cba16a2b;border-radius:12px;background:linear-gradient(125deg,#cba16a09,#10161f80);color:var(--text-primary,#e5dfd3);font:13px/1.7 system-ui}.head{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}.head strong{font-size:14px}.toggle{color:var(--text-muted,#9ca7b4);font-size:12px;display:flex;align-items:center;gap:7px}input{accent-color:#ca7854}.state{color:#99a8b8;margin:8px 0}.state[data-status=connected]{color:#9bcbb0}.state[data-status=offline]{color:#e6b37a}.buttons{display:flex;flex-wrap:wrap;gap:7px}button{font:inherit;color:inherit;background:#ffffff06;border:1px solid #ffffff20;border-radius:7px;padding:7px 10px;min-height:36px;cursor:pointer}button.primary{background:#b85a3d;color:#fff2e6;border-color:#cb7153}button:disabled{opacity:.45;cursor:wait}button:focus-visible{outline:2px solid #dca878;outline-offset:2px}.note{font-size:11px;color:#8c99a7;margin:10px 0 0}.message{color:#e6b37a;overflow-wrap:anywhere;margin:8px 0 0}.code{color:#e9c698;letter-spacing:3px;font-size:20px;margin:6px 0}[hidden]{display:none!important}
    </style><section class="cloud" aria-label="App 云端连接"><div class="head"><strong>云端连接</strong><label class="toggle"><input id="enabled" type="checkbox">启用云端</label></div><p id="state" class="state" role="status" aria-live="polite"></p><div id="code" class="code" hidden></div><div class="buttons"><button id="login" class="primary">连接云端账号</button><button id="retry">重新连接</button><button id="logout" hidden>退出云端账号</button><button id="cancel" hidden>取消授权</button><button id="local"></button></div><p id="message" class="message" role="status"></p><p class="note">本地进度始终保存在 App 内。云端连接失败时仍可游玩、存档及导入导出；联网生成正文继续使用你配置的模型接口。</p></section>`;
    const $ = selector => this.shadowRoot.querySelector(selector);
    $('#enabled').onchange = event => { authClient.cancelAppLogin(); enableCloudConnection(event.target.checked); this.notice = ''; this.refresh(); if (event.target.checked) void this.run(() => authClient.checkAuth(true)); };
    $('#login').onclick = () => this.run(async () => {
      const pending = authClient.getPendingLogin();
      if (pending) await nativeCloudPlugin().openLogin({ code: pending.code });
      else await authClient.beginAppLogin();
      this.notice = '在浏览器核对连接码并确认授权，返回 App 后会自动连接。';
    });
    $('#retry').onclick = () => this.run(() => authClient.getPendingLogin() ? authClient.pollAppLogin() : authClient.checkAuth(true));
    $('#logout').onclick = () => this.run(() => authClient.logout());
    $('#cancel').onclick = () => { authClient.cancelAppLogin(); this.notice = '已取消授权，本地进度仍保留。'; this.refresh(); };
    $('#local').textContent = this.getAttribute('local-label') || '继续本地游玩';
    $('#local').onclick = () => this.dispatchEvent(new CustomEvent('cloud-local', { bubbles: true, composed: true }));
    this.unsubscribe = ['auth:changed', 'cloud:connection'].map(name => eventBus.on(name, () => this.refresh()));
    this.refresh();
  }
  disconnectedCallback() { this.unsubscribe?.forEach(stop => stop()); }
  refresh() {
    const $ = selector => this.shadowRoot.querySelector(selector);
    if (!$('#state')) return;
    const enabled = cloudConnectionEnabled(), user = authClient.getUser(), login = authClient.getPendingLogin(), connection = getCloudConnection();
    $('#enabled').checked = enabled;
    $('#state').dataset.status = connection.status;
    $('#state').textContent = login ? '等待浏览器授权，可以先继续游玩' : `${connection.message}${user ? ` · ${authClient.getDisplayName(user)}` : ''}`;
    $('#code').hidden = !login; $('#code').textContent = login?.code || '';
    $('#login').textContent = login ? '打开授权页面' : user ? '更换云端账号' : '连接云端账号';
    $('#logout').hidden = !user; $('#cancel').hidden = !login;
    for (const id of ['login', 'retry', 'logout']) $(`#${id}`).disabled = this.busy || (!enabled && id !== 'logout');
    $('#message').textContent = this.notice || '';
  }
  async run(operation) {
    if (this.busy) return;
    this.busy = true; this.notice = '正在连接，仍可关闭此面板继续游玩…'; this.refresh();
    try { await operation(); if (authClient.getCloudError()) throw authClient.getCloudError(); if (!authClient.getPendingLogin()) this.notice = ''; }
    catch (error) { this.notice = error.message; }
    finally { this.busy = false; this.refresh(); }
  }
}
if (globalThis.customElements && !customElements.get('app-cloud-panel')) customElements.define('app-cloud-panel', AppCloudPanel);
