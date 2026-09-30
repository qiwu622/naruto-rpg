import '../multiplayer/multiplayer-panel.js';
import { icon } from '../utils/icons.js';
import { projectedGenerationProgress } from '../multiplayer/ui-projection.js';
import { localRoomHistory } from '../multiplayer/local-room-history.js';

const PANEL_TAG = 'naruto-multiplayer-panel';

function applyOverlayStyle(element) {
  element.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:var(--z-overlay-top)',
    'overflow:auto',
    'background:rgba(10,10,12,0.86)',
    'backdrop-filter:blur(10px) saturate(120%)',
    '-webkit-backdrop-filter:blur(10px) saturate(120%)',
    'padding:clamp(10px,2vw,24px)',
    'overscroll-behavior:contain'
  ].join(';');
}

function applyCompactOverlayStyle(element) {
  element.style.cssText = [
    'position:fixed',
    'inset:auto clamp(10px,2vw,22px) clamp(10px,2vw,22px) auto',
    'z-index:var(--z-overlay-top)',
    'width:min(410px,calc(100vw - 20px))',
    'max-height:calc(100vh - 20px)',
    'overflow:auto',
    'background:transparent',
    'padding:0',
    'pointer-events:none',
    'overscroll-behavior:contain'
  ].join(';');
}

function applyToolbarStyle(element) {
  element.style.cssText = [
    'position:sticky',
    'top:0',
    'z-index:2',
    'display:flex',
    'justify-content:flex-end',
    'max-width:1480px',
    'margin:0 auto 8px'
  ].join(';');
}

function applyCloseButtonStyle(element) {
  element.style.cssText = [
    'display:inline-flex',
    'align-items:center',
    'gap:8px',
    'border:1px solid rgba(255,255,255,0.14)',
    'border-radius:10px',
    'background:rgba(11,14,19,0.6)',
    'color:#f4f1eb',
    'padding:9px 14px',
    'font:600 14px/1 var(--font-body, system-ui, sans-serif)',
    'cursor:pointer',
    'backdrop-filter:blur(8px)',
    'transition:background 0.15s ease,border-color 0.15s ease'
  ].join(';');
}

function applyLauncherStyle(element) {
  element.style.cssText = [
    'pointer-events:auto',
    'display:none',
    'align-items:center',
    'gap:9px',
    'border:1px solid rgba(255,255,255,.16)',
    'border-radius:999px',
    'background:#eb613f',
    'color:white',
    'padding:11px 16px',
    'font:700 14px/1 var(--font-body,system-ui,sans-serif)',
    'box-shadow:0 12px 36px rgba(0,0,0,.45)',
    'cursor:pointer'
  ].join(';');
}

/**
 * Mounts the server-authoritative multiplayer client as an isolated overlay.
 * Removing the panel triggers its disconnectedCallback, which closes the SSE
 * stream and drops all in-memory projections and secret form values.
 */
export function openMultiplayerOverlay({
  host = document.getElementById('app') || document.body,
  onStateChange = () => {},
  onPhaseChange = () => {},
  onClose = () => {}
} = {}) {
  if (!(host instanceof Element)) {
    throw new TypeError('multiplayer overlay host must be a DOM element');
  }
  const existing = host.querySelector(':scope > [data-multiplayer-overlay]');
  if (existing?._multiplayerOverlayHandle) {
    existing._multiplayerOverlayHandle.show();
    return existing._multiplayerOverlayHandle;
  }

  const previousFocus = document.activeElement;
  const overlay = document.createElement('div');
  overlay.dataset.multiplayerOverlay = 'true';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '双人联机跑团');
  applyOverlayStyle(overlay);

  const toolbar = document.createElement('div');
  applyToolbarStyle(toolbar);
  const dragHandle = document.createElement('button');
  dragHandle.type = 'button'; dragHandle.dataset.multiplayerDrag = '';
  dragHandle.textContent = '⠿ 联机状态'; dragHandle.setAttribute('aria-label', '拖动联机悬浮窗');
  applyCloseButtonStyle(dragHandle);
  dragHandle.style.cssText += ';flex:1;cursor:move;touch-action:none;user-select:none';
  const resizeHandle = document.createElement('button');
  resizeHandle.type = 'button'; resizeHandle.dataset.multiplayerResize = '';
  resizeHandle.textContent = '↔'; resizeHandle.setAttribute('aria-label', '拖动调整联机悬浮窗大小');
  resizeHandle.title = '拖动调整大小'; applyCloseButtonStyle(resizeHandle);
  resizeHandle.style.cssText += ';cursor:nwse-resize;touch-action:none';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.innerHTML = `${icon('close', 16)}关闭联机面板`;
  closeButton.setAttribute('aria-label', '关闭联机面板并断开实时连接');
  applyCloseButtonStyle(closeButton);
  toolbar.append(dragHandle, resizeHandle, closeButton);

  const panel = document.createElement(PANEL_TAG);
  panel.style.cssText = 'display:block;max-width:1480px;margin:0 auto 32px;';
  const launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.innerHTML = `${icon('users', 16)}联机状态`;
  launcher.setAttribute('aria-label', '展开联机状态悬浮窗');
  applyLauncherStyle(launcher);
  overlay.append(toolbar, panel, launcher);

  const controller = new AbortController();
  let closed = false;
  let phase = 'setup';
  let minimized = false;
  const layoutKey = 'naruto_multiplayer_float_layout_v1';
  let layout = { left: null, top: null, width: 410, height: 620 };
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(layoutKey) ?? 'null');
    if (saved && ['left','top','width','height'].every(key => Number.isFinite(saved[key]))) layout = saved;
  } catch { /* The floating window also works without browser storage. */ }
  const compact = () => phase === 'active' && panel.dataset.activeLayout !== 'full';
  const clamp = (value, min, max) => Math.max(min, Math.min(Math.max(min, max), value));
  const place = () => {
    if (!compact()) return;
    const width = Math.min(innerWidth - 20, clamp(layout.width, 280, 680));
    const height = clamp(layout.height, 220, innerHeight - 20);
    overlay.style.inset = 'auto';
    overlay.style.width = minimized ? 'max-content' : `${width}px`;
    overlay.style.height = minimized ? 'auto' : `${height}px`;
    overlay.style.maxWidth = 'calc(100vw - 20px)';
    const rect = overlay.getBoundingClientRect();
    overlay.style.left = `${clamp(layout.left ?? innerWidth-width-22, 10, innerWidth-rect.width-10)}px`;
    overlay.style.top = `${clamp(layout.top ?? innerHeight-height-22, 10, innerHeight-rect.height-10)}px`;
  };
  const remember = () => {
    try { globalThis.localStorage?.setItem(layoutKey, JSON.stringify(layout)); } catch { /* optional */ }
  };

  const setExpanded = expanded => {
    minimized = !expanded;
    toolbar.hidden = minimized;
    panel.hidden = minimized;
    toolbar.style.display = minimized ? 'none' : 'flex';
    panel.style.display = minimized ? 'none' : 'block';
    launcher.style.display = minimized ? 'inline-flex' : 'none';
    place();
    if (expanded) closeButton.focus();
  };

  const applyMode = (nextPhase, activeLayout = 'compact') => {
    phase = nextPhase;
    const active = phase === 'active';
    const full = active && activeLayout === 'full';
    dragHandle.style.display = resizeHandle.style.display = active && !full ? 'inline-flex' : 'none';
    if (active && !full) {
      applyCompactOverlayStyle(overlay);
      toolbar.style.cssText = 'pointer-events:auto;position:sticky;top:0;z-index:3;display:flex;gap:5px;background:#11151b;justify-content:flex-end;margin:0 0 7px;';
      panel.style.cssText = 'pointer-events:auto;display:block;width:100%;margin:0;';
      closeButton.innerHTML = `${icon('chevron-down', 16)}收起`;
      closeButton.setAttribute('aria-label', '收起联机状态悬浮窗');
      overlay.setAttribute('role', 'region');
      overlay.setAttribute('aria-modal', 'false');
    } else {
      applyOverlayStyle(overlay);
      applyToolbarStyle(toolbar);
      panel.style.cssText = 'display:block;max-width:1480px;margin:0 auto 32px;';
      closeButton.innerHTML = active
        ? `${icon('chevron-down', 16)}返回悬浮窗`
        : `${icon('close', 16)}关闭联机面板`;
      closeButton.setAttribute('aria-label', active
        ? '收起完整设置并返回联机悬浮窗'
        : '关闭联机面板并断开实时连接');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
    }
    setExpanded(!minimized);
  };

  const bindPointer = (element, resizing) => {
    let start = null;
    element.addEventListener('pointerdown', event => {
      if (!compact() || minimized || event.button !== 0) return;
      event.preventDefault();
      const rect = overlay.getBoundingClientRect();
      start = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.x, top: rect.y, width: rect.width, height: rect.height };
      element.setPointerCapture(event.pointerId);
    }, { signal: controller.signal });
    element.addEventListener('pointermove', event => {
      if (!start || event.pointerId !== start.id) return;
      const dx = event.clientX-start.x, dy = event.clientY-start.y;
      layout = resizing
        ? { left: start.left, top: start.top, width: clamp(start.width+dx,280,innerWidth-start.left-10), height: clamp(start.height+dy,220,innerHeight-start.top-10) }
        : { ...layout, left: clamp(start.left+dx,10,innerWidth-start.width-10), top: clamp(start.top+dy,10,innerHeight-start.height-10) };
      place();
    }, { signal: controller.signal });
    const finish = () => { if (start) { start = null; remember(); } };
    element.addEventListener('pointerup', finish, { signal: controller.signal });
    element.addEventListener('pointercancel', finish, { signal: controller.signal });
    element.addEventListener('lostpointercapture', finish, { signal: controller.signal });
    element.addEventListener('keydown', event => {
      const delta = { ArrowLeft: [-20,0], ArrowRight:[20,0], ArrowUp:[0,-20], ArrowDown:[0,20] }[event.key];
      if (!delta || !compact()) return;
      event.preventDefault(); const rect = overlay.getBoundingClientRect();
      layout = resizing ? { ...layout, width: rect.width+delta[0], height: rect.height+delta[1] }
        : { ...layout, left: rect.x+delta[0], top: rect.y+delta[1] };
      place(); remember();
    }, { signal: controller.signal });
  };
  bindPointer(dragHandle, false); bindPointer(resizeHandle, true);
  globalThis.addEventListener('resize', place, { signal: controller.signal });

  const destroy = ({ forgetSession = false, savedRoom = false } = {}) => {
    if (closed) return false;
    closed = true;
    controller.abort();
    // Explicitly disconnect before removal as well as relying on the custom
    // element lifecycle, so a future host implementation cannot retain SSE.
    panel.controller?.disconnect?.({ reset: true });
    overlay.remove();
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
      previousFocus.focus();
    }
    onClose({ forgetSession, savedRoom });
    return true;
  };
  const minimize = () => {
    if (closed || phase !== 'active') return false;
    if (panel.dataset.activeLayout === 'full') {
      panel.showCompactSession?.();
      return true;
    }
    setExpanded(false);
    return true;
  };
  const show = () => {
    if (closed) return false;
    setExpanded(true);
    return true;
  };
  let exiting = false;
  const exit = async () => {
    if (closed || exiting) return false;
    if (!panel.controller?.state?.room) return destroy({ forgetSession: true });
    exiting = true;
    try {
      const { chooseRoomExit } = await import('./save-library-panel.js');
      const choice = await chooseRoomExit();
      if (choice === 'cancel' || closed) return false;
      if (choice === 'save') await localRoomHistory.remember(panel.controller.state, { snapshot: true });
      return destroy({ forgetSession: true, savedRoom: choice === 'save' });
    } catch (error) {
      panel.controller?.store?.setError(error);
      // Keep the room connected when local persistence fails.
      await customElements.get('game-modal').alert({ title: '保存失败，尚未退出', message: error.message });
      return false;
    } finally { exiting = false; }
  };
  const close = () => (phase === 'active' ? minimize() : (panel.controller?.state?.room ? exit() : destroy()));
  const handle = Object.freeze({ element: overlay, panel, close, destroy, exit, minimize, show });
  overlay._multiplayerOverlayHandle = handle;
  closeButton.addEventListener('click', close, { signal: controller.signal });
  launcher.addEventListener('click', show, { signal: controller.signal });
  panel.addEventListener('multiplayer-phase-change', event => {
    const nextPhase = event.detail?.phase ?? 'setup';
    if (nextPhase === 'active') panel.showCompactSession?.();
    applyMode(nextPhase, panel.dataset.activeLayout);
    onPhaseChange(event.detail ?? { phase: nextPhase });
  }, { signal: controller.signal });
  panel.addEventListener('multiplayer-state-change', event => {
    const nextPhase = event.detail?.state?.room?.lifecycle === 'ACTIVE'
      ? 'active'
      : (event.detail?.state?.roomId ? 'lobby' : 'setup');
    if (nextPhase !== phase || (nextPhase === 'active'
      && panel.dataset.activeLayout === 'full'
      && !overlay.style.inset.startsWith('0'))) {
      applyMode(nextPhase, panel.dataset.activeLayout);
    } else if (nextPhase === 'active' && panel.dataset.activeLayout === 'compact'
      && overlay.style.pointerEvents !== 'none') {
      applyMode(nextPhase, panel.dataset.activeLayout);
    }
    const unread = panel.shadowRoot?.querySelector('#active-chat-unread');
    const progress = projectedGenerationProgress(event.detail?.state);
    const label = progress.tone === 'error' ? '联机 · 生成已暂停'
      : progress.running ? '联机 · 正在生成'
      : progress.tone === 'warning' ? '联机 · 状态待确认' : '联机状态';
    launcher.style.background = progress.tone === 'error' ? '#b43838' : '#eb613f';
    launcher.innerHTML = `${icon('users', 16)}${label}${unread && !unread.hidden
      ? `<span style="display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:#d9272e;color:#fff;font-size:11px">${unread.textContent}</span>`
      : ''}`;
    onStateChange(event.detail?.state ?? null, panel);
  }, { signal: controller.signal });
  panel.addEventListener('multiplayer-exit-request', exit, { signal: controller.signal });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (event.composedPath().some(node => node instanceof HTMLDialogElement && node.open)) return;
    event.preventDefault();
    if (phase === 'active') minimize();
    else close();
  }, { signal: controller.signal });

  host.append(overlay);
  applyMode('setup');
  closeButton.focus();
  return handle;
}
