import { cloudSave } from '../core/cloud-save.js';
import { icon } from '../utils/icons.js';

const glyph = name => icon(name, 16).replace('<svg', '<svg aria-hidden="true" focusable="false"');
const stateIcons = { local: 'database', uploading: 'refresh-cw', synced: 'check', retry: 'cloud', conflict: 'git-branch' };

// Optional scope allows archive cards to show their own upload status. With no
// scope this follows the current account/game selected by the app shell.
export class CloudSyncStatus extends (globalThis.HTMLElement ?? class {}) {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._scope = null;
  }

  set scope(value) { this._scope = value; this.render(); }
  get scope() { return this._scope; }
  connectedCallback() { this._unsubscribe = cloudSave.subscribeSync(() => this.render()); }
  disconnectedCallback() { this._unsubscribe?.(); }

  render() {
    const state = cloudSave.getSyncState(this._scope || undefined);
    this.hidden = !state.saveKey;
    const root = this.shadowRoot;
    root.innerHTML = `<style>
      :host{display:block;container-type:inline-size;max-width:100%;min-width:0;font:inherit;color:#e8e4d9}:host([hidden]){display:none}
      *{box-sizing:border-box}.status{--tone:#a6afb6;--edge:#a6afb622;--wash:#a6afb609;display:grid;grid-template-columns:28px minmax(0,1fr);align-items:center;gap:0 10px;padding:11px 13px;border:1px solid var(--edge);border-radius:10px;background:linear-gradient(110deg,var(--wash),#10161d40);font-size:12px;line-height:1.65}
      .synced{--tone:#b0cbb8;--edge:#8cac9630;--wash:#8cac960c}.uploading{--tone:#b8cbd6;--edge:#94aebf38;--wash:#94aebf10}.retry{--tone:#dbc398;--edge:#d8b47740;--wash:#d8b4770d}.conflict{--tone:#e6c48e;--edge:#d8b47750;--wash:#d8b47715}
      .dot{grid-column:1;align-self:start;width:28px;height:28px;display:grid;place-items:center;border:1px solid var(--edge);border-radius:8px;color:var(--tone);background:var(--wash)}svg{display:block;flex-shrink:0}.message{grid-column:2;min-width:0;color:var(--tone);overflow-wrap:anywhere;font-weight:500}.detail{grid-column:2;margin:6px 0 0;color:#b6b2a7;font-size:11px;line-height:1.8;overflow-wrap:anywhere}
      button{grid-column:2;justify-self:start;display:inline-flex;align-items:center;justify-content:center;gap:7px;min-width:0;min-height:44px;max-width:100%;margin:11px 0 0;padding:9px 13px;border:1px solid #d8b47759;border-radius:8px;background:#d8b47708;color:#e2c79d;font:inherit;font-size:12px;font-weight:500;line-height:1.5;cursor:pointer;transition:background .15s,border-color .15s}button:hover{background:#d8b47718;border-color:#d8b47799}button:focus-visible{outline:2px solid #e6c48e;outline-offset:3px}button:disabled{opacity:.55;cursor:wait}button span{overflow-wrap:anywhere}.conflict button{background:#d8b477;color:#201d17;border-color:#d8b477}.conflict button:hover{background:#e3c48f;border-color:#e3c48f}
      .uploading .dot svg{animation:sync-turn 2.8s linear infinite}@keyframes sync-turn{to{transform:rotate(360deg)}}
      @container(min-width:480px){.status{grid-template-columns:28px minmax(0,1fr) auto}.detail{grid-column:2}button{grid-column:3;grid-row:1/span 2;margin:0 0 0 10px}}
      @media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
    </style><div class="status" role="status" aria-live="polite" aria-atomic="true"><span class="dot" aria-hidden="true">${glyph(stateIcons[state.status] || 'cloud')}</span><span class="message"></span></div>`;
    const box = root.querySelector('.status');
    box.classList.add(state.status);
    root.querySelector('.message').textContent = state.message;
    if (state.status === 'conflict') {
      const note = document.createElement('p');
      note.id = 'sync-detail';
      note.className = 'detail';
      note.textContent = '本机进度仍在。保留后会新增一份云档，原来的云端进度也会留下。';
      box.append(note);
    }
    if (state.canRetry || state.canKeepBoth) {
      const button = document.createElement('button');
      button.type = 'button';
      button.innerHTML = `${glyph(state.canKeepBoth ? 'copy' : 'refresh-cw')}<span>${state.canKeepBoth ? '保留双方副本' : '重试同步'}</span>`;
      if (state.status === 'conflict') button.setAttribute('aria-describedby', 'sync-detail');
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const result = state.canKeepBoth
            ? await cloudSave.keepBothCopies(this._scope || {})
            : await cloudSave.retrySync(this._scope || {});
          this.dispatchEvent(new CustomEvent('cloud-sync-complete', { bubbles: true, composed: true, detail: result }));
        } catch { this.render(); }
      });
      box.append(button);
    }
  }
}

if (globalThis.customElements && !customElements.get('cloud-sync-status')) customElements.define('cloud-sync-status', CloudSyncStatus);
