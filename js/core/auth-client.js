// auth-client.js — 前端认证管理
// ES Module — Discord OAuth 客户端状态管理

import { eventBus } from './event-bus.js';
import { isNativeAndroidApp } from './runtime-platform.js';
import { fetchProjectServer, nativeCloudPlugin, cloudConnectionEnabled, getCloudConnection, setCloudConnection } from './project-server.js';

export class AuthClient {
  constructor() {
    /** @type {object|null} 当前用户对象 */
    this._user = null;
    /** @type {boolean} 是否已执行过认证检查 */
    this._checked = false;
    /** @type {Promise|null} 防止并发 checkAuth 请求 */
    this._pending = null;
    this._epoch = 0;
    this._sessionLoaded = false;
    this._authError = null;
    this._login = null;
  }

  /**
   * 检查当前用户是否已登录。
   * 首次调用会发起 /auth/me 请求，后续调用返回缓存结果。
   * @param {boolean} [force=false] - 强制重新请求（忽略缓存）
   * @returns {Promise<object|null>} 用户对象或 null
   */
  async checkAuth(force = false) {
    if (this._checked && !force) return this._user;

    // 防止多个组件同时触发重复请求
    if (this._pending) return this._pending;

    this._pending = (async () => {
      const epoch = this._epoch;
      const previousUserId = this._user?.id || '';
      const native = isNativeAndroidApp();
      const previousConnection = getCloudConnection().status;
      try {
        if (native && !this._sessionLoaded) {
          const session = await nativeCloudPlugin()?.getSession();
          if (epoch !== this._epoch) return this._user;
          this._user = session?.user || null;
          this._sessionLoaded = true;
        }
        if (native && (!cloudConnectionEnabled() || !this._user)) {
          this._authError = null;
          if (!this._user) setCloudConnection('local', '尚未登录云端，可继续本地游玩');
          return this._user;
        }
        if (native) setCloudConnection('checking', '正在检查云端连接，本地游玩可用');
        const res = await fetchProjectServer('/auth/me', { timeoutMs: 5000 });
        if (epoch !== this._epoch) return this._user;
        if (res.ok) {
          this._user = await res.json();
          this._authError = null;
          if (native && previousUserId && previousConnection !== 'connected') eventBus.emit('auth:cloud-ready', { user: this._user });
        } else if (res.status === 401 || res.status === 403) {
          this._user = null;
          this._authError = new Error('云端登录已失效，请重新连接；本地进度仍保留');
          if (native) { await nativeCloudPlugin()?.clearSession(); setCloudConnection('local', this._authError.message); }
        } else {
          throw new Error('云端服务暂不可用，本地游玩不受影响');
        }
      } catch (error) {
        if (epoch !== this._epoch) return this._user;
        this._authError = error;
        if (native) setCloudConnection('offline', error.message);
        // A transport failure does not mean that the account changed.
      } finally {
        if (epoch === this._epoch) {
          this._checked = true;
          this._pending = null;
          if (previousUserId !== (this._user?.id || '')) eventBus.emit('auth:changed', { user: this._user });
        }
      }
      return this._user;
    })();

    return this._pending;
  }

  /**
   * 获取缓存的用户对象（同步）。
   * 必须在 checkAuth() 之后调用才有值。
   * @returns {object|null}
   */
  getUser() {
    return this._user;
  }

  /**
   * 用户是否已通过认证（同步检查缓存）。
   * @returns {boolean}
   */
  isAuthenticated() {
    return this._user !== null;
  }

  getCloudError() { return this._authError; }
  getPendingLogin() { return this._login; }

  async beginAppLogin() {
    if (!isNativeAndroidApp()) { window.location.href = '/auth/discord'; return null; }
    if (!cloudConnectionEnabled()) throw new Error('请先启用云端连接');
    this.cancelAppLogin();
    const epoch = this._epoch;
    const bytes = crypto.getRandomValues(new Uint8Array(48));
    const verifier = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...hash)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const response = await fetchProjectServer('/auth/app/start', { method: 'POST', anonymous: true, timeoutMs: 8000,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge }) });
    if (epoch !== this._epoch) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(response.status === 404 ? '云端尚未更新 App 连接接口，可以继续本地游玩' : data.error || '无法发起云端连接');
    this._authError = null;
    this._login = { deviceCode: data.device_code, code: data.user_code, verifier, expiresAt: Date.now() + data.expires_in * 1000 };
    try { await nativeCloudPlugin().openLogin({ code: data.user_code }); }
    catch (error) { this.cancelAppLogin(); throw error; }
    return this._login;
  }

  cancelAppLogin() { this._login = null; this._epoch++; this._pending = null; }

  async pollAppLogin() {
    const login = this._login;
    if (!login) return null;
    if (this._loginPolling) return this._loginPolling;
    this._loginPolling = (async () => {
      if (Date.now() >= login.expiresAt) { this.cancelAppLogin(); throw new Error('连接码已过期，请重新登录'); }
      const response = await fetchProjectServer('/auth/app/poll', { method: 'POST', anonymous: true, timeoutMs: 8000,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_code: login.deviceCode, verifier: login.verifier }) });
      if (this._login !== login) return null;
      if (response.status === 202) return null;
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if ([403, 410].includes(response.status)) this.cancelAppLogin();
        throw new Error(data.error || '授权未完成，请稍后重试');
      }
      await nativeCloudPlugin().storeSession({ token: data.token, user: data.user });
      if (this._login !== login) { await nativeCloudPlugin().clearSession(); return null; }
      this._login = null; this._user = data.user; this._checked = true; this._sessionLoaded = true; this._authError = null;
      setCloudConnection('connected', '已连接云端账号');
      eventBus.emit('auth:changed', { user: this._user });
      return this._user;
    })();
    try { return await this._loginPolling; } finally { this._loginPolling = null; }
  }

  /**
   * 登出当前用户并重定向到登录页。
   * @returns {Promise<void>}
   */
  async logout() {
    this.cancelAppLogin();
    if (isNativeAndroidApp()) {
      await nativeCloudPlugin()?.clearSession();
      this._user = null; this._checked = true; this._authError = null;
      setCloudConnection('local', '已退出云端账号，本地进度仍保留');
      eventBus.emit('auth:changed', { user: null });
      return;
    }
    try {
      await fetchProjectServer('/auth/logout', { method: 'POST', timeoutMs: 5000 });
    } catch {
      // 即使请求失败也清理本地状态并跳转
    }
    this._user = null;
    this._checked = false;
    this._pending = null;
    eventBus.emit('auth:changed', { user: null });
    window.location.href = '/login.html';
  }

  /**
   * 生成用户头像 URL。
   * @param {object} [user=this._user] - 用户对象（需包含 id 和可选的 avatar 字段）
   * @param {number} [size=128] - 头像尺寸（像素）
   * @returns {string|null} 头像 URL 或 null
   */
  getAvatarUrl(user = this._user, size = 128) {
    if (!user) return null;

    if (user.avatar) {
      // 支持动态头像（GIF）
      const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
      return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=${size}`;
    }

    // Discord 默认头像计算方式（2023+ 规则）
    const defaultIndex = /^\d+$/.test(user.id) ? (BigInt(user.id) >> 22n) % 6n : 0;
    return `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
  }

  /**
   * 获取用户的显示名称。
   * 优先使用 global_name，否则 username。
   * @param {object} [user=this._user]
   * @returns {string|null}
   */
  getDisplayName(user = this._user) {
    if (!user) return null;
    return user.global_name || user.username || null;
  }

  /**
   * 如果未登录则跳转到登录页。
   * 适用于需要认证保护的页面。
   * @returns {Promise<object>} 已登录的用户对象
   */
  async requireAuth() {
    const user = await this.checkAuth();
    if (!user) {
      if (isNativeAndroidApp()) throw new Error('请在个人中心连接云端账号，本地游玩不受影响');
      window.location.href = '/login.html';
      // 返回一个永远不会 resolve 的 promise，防止后续代码执行
      return new Promise(() => {});
    }
    return user;
  }
}

export const authClient = new AuthClient();
