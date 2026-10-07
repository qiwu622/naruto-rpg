import '../multiplayer/multiplayer-panel.js';
import { icon } from '../utils/icons.js';
import { projectedGenerationProgress } from '../multiplayer/ui-projection.js';
import { localRoomHistory } from '../multiplayer/local-room-history.js';
import { multiplayerOverlayStyles } from '../../css/components/multiplayer-overlay.css.js';

const PANEL_TAG = 'naruto-multiplayer-panel';

function applyOverlayStyle(element) {
  element.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:var(--z-overlay-top)',
    'overflow:auto',
    'background:rgba(8,11,15,0.91)',
    'backdrop-filter:blur(10px) saturate(120%)',
    '-webkit-backdrop-filter:blur(10px) saturate(120%)',
    'padding:max(clamp(10px,2vw,24px),env(safe-area-inset-top)) max(clamp(10px,2vw,24px),env(safe-area-inset-right)) max(clamp(10px,2vw,24px),env(safe-area-inset-bottom)) max(clamp(10px,2vw,24px),env(safe-area-inset-left))',
    'overscroll-behavior:contain'
  ].join(';');
}

function applyCompactOverlayStyle(element) {
  element.style.cssText = [
    'position:fixed',
    'inset:auto clamp(10px,2vw,22px) clamp(10px,2vw,22px) auto',
    'z-index:var(--z-overlay-top)',
    'width:min(410px,calc(100vw - 20px))',
    'max-height:calc(100dvh - 20px)',
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
    'max-width:1280px',
    'margin:0 auto 12px'
  ].join(';');
}

function applyCloseButtonStyle(element) {
  element.classList.add('mp-overlay-button');
}

function applyLauncherStyle(element) {
  element.classList.add('mp-overlay-launcher');
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
  const style = document.createElement('style');
  style.textContent = multiplayerOverlayStyles;
  const safeArea = document.createElement('span');
  safeArea.setAttribute('aria-hidden', 'true');
  safeArea.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';

  const toolbar = document.createElement('div');
  toolbar.className = 'mp-overlay-toolbar';
  toolbar.setAttribute('aria-label', '联机面板工具栏');
  applyToolbarStyle(toolbar);
  const heading = document.createElement('span');
  heading.className = 'mp-overlay-heading';
  heading.innerHTML = `${icon('users', 16)}联机空间`;
  const dragHandle = document.createElement('button');
  dragHandle.type = 'button'; dragHandle.dataset.multiplayerDrag = '';
  dragHandle.innerHTML = '<svg class="mp-grip" aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="5" cy="3" r="1"/><circle cx="11" cy="3" r="1"/><circle cx="5" cy="8" r="1"/><circle cx="11" cy="8" r="1"/><circle cx="5" cy="13" r="1"/><circle cx="11" cy="13" r="1"/></svg><span>联机状态</span>';
  dragHandle.setAttribute('aria-label', '拖动联机悬浮窗');
  dragHandle.title = '拖动移动位置 · 聚焦后可使用方向键';
  applyCloseButtonStyle(dragHandle);
  const resizeHandle = document.createElement('button');
  resizeHandle.type = 'button'; resizeHandle.dataset.multiplayerResize = '';
  resizeHandle.innerHTML = icon('fullscreen', 16); resizeHandle.setAttribute('aria-label', '拖动调整联机悬浮窗大小');
  resizeHandle.title = '拖动缩放 · 聚焦后可使用方向键'; applyCloseButtonStyle(resizeHandle);
  resizeHandle.classList.add('mp-icon-button');
  const resetButton = document.createElement('button');
  resetButton.type = 'button'; resetButton.dataset.multiplayerReset = '';
  resetButton.innerHTML = icon('refresh-cw', 15);
  resetButton.setAttribute('aria-label', '重置联机悬浮窗位置与大小');
  resetButton.title = '恢复默认位置与大小';
  applyCloseButtonStyle(resetButton); resetButton.classList.add('mp-icon-button');
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'mp-overlay-close';
  closeButton.innerHTML = `${icon('close', 16)}关闭联机面板`;
  closeButton.setAttribute('aria-label', '关闭联机面板并断开实时连接');
  applyCloseButtonStyle(closeButton);
  toolbar.append(heading, dragHandle, resizeHandle, resetButton, closeButton);

  const panel = document.createElement(PANEL_TAG);
  panel.style.cssText = 'display:block;max-width:1280px;margin:0 auto 32px;';
  const launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.innerHTML = '<span class="mp-launcher-dot" aria-hidden="true"></span>联机状态';
  launcher.setAttribute('aria-label', '展开联机状态悬浮窗');
  applyLauncherStyle(launcher);
  overlay.append(style, safeArea, toolbar, panel, launcher);

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
  const viewportBounds = () => {
    const style = getComputedStyle(safeArea);
    const viewport = globalThis.visualViewport;
    const left = (viewport?.offsetLeft ?? 0) + Math.max(10, parseFloat(style.paddingLeft) || 0);
    const top = (viewport?.offsetTop ?? 0) + Math.max(10, parseFloat(style.paddingTop) || 0);
    const right = (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth) - Math.max(10, parseFloat(style.paddingRight) || 0);
    const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight) - Math.max(10, parseFloat(style.paddingBottom) || 0);
    return { left, top, right, bottom, width: Math.max(1, right-left), height: Math.max(1, bottom-top) };
  };
  const place = () => {
    if (!compact()) return;
    const bounds = viewportBounds();
    const width = Math.min(bounds.width, clamp(layout.width, 280, 680));
    const height = Math.min(bounds.height, clamp(layout.height, 220, bounds.height));
    overlay.style.inset = 'auto';
    overlay.style.width = minimized ? 'max-content' : `${width}px`;
    overlay.style.height = minimized ? 'auto' : `${height}px`;
    overlay.style.maxWidth = `${bounds.width}px`;
    overlay.style.maxHeight = `${bounds.height}px`;
    const rect = overlay.getBoundingClientRect();
    overlay.style.left = `${clamp(layout.left ?? bounds.right-width-12, bounds.left, bounds.right-rect.width)}px`;
    overlay.style.top = `${clamp(layout.top ?? bounds.bottom-height-12, bounds.top, bounds.bottom-rect.height)}px`;
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
    launcher.setAttribute('aria-expanded', String(expanded));
    place();
    if (expanded) closeButton.focus();
  };

  // Keep the shared action composer usable when a moved window or a collapsed
  // character sidebar puts Send underneath the floating panel.
  const revealActionComposer = event => {
    if (!compact() || minimized || !(event.target instanceof Element)) return;
    const composer = event.target.closest('#chat-input-area .input-wrapper');
    if (!composer) return;
    const action = composer.getBoundingClientRect();
    const floating = overlay.getBoundingClientRect();
    if (floating.left < action.right && floating.right > action.left
      && floating.top < action.bottom && floating.bottom > action.top) {
      setExpanded(false);
    }
  };
  document.addEventListener('focusin', revealActionComposer, { signal: controller.signal });
  document.addEventListener('input', revealActionComposer, { signal: controller.signal });

  const applyMode = (nextPhase, activeLayout = 'compact') => {
    const previousPhase = phase;
    const previousPresentation = overlay.dataset.presentation;
    phase = nextPhase;
    const active = phase === 'active';
    const full = active && activeLayout === 'full';
    overlay.dataset.presentation = active && !full ? 'compact' : 'full';
    heading.style.display = active && !full ? 'none' : 'flex';
    dragHandle.style.display = resizeHandle.style.display = resetButton.style.display = active && !full ? 'inline-flex' : 'none';
    if (active && !full) {
      applyCompactOverlayStyle(overlay);
      toolbar.style.cssText = 'pointer-events:auto;position:sticky;top:0;z-index:3;display:flex;background:var(--mp-card);justify-content:flex-end;margin:0 0 8px;';
      panel.style.cssText = 'pointer-events:auto;display:block;width:100%;margin:0;';
      closeButton.innerHTML = `${icon('chevron-down', 16)}收起`;
      closeButton.setAttribute('aria-label', '收起联机状态悬浮窗');
      overlay.setAttribute('role', 'region');
      overlay.setAttribute('aria-modal', 'false');
    } else {
      applyOverlayStyle(overlay);
      applyToolbarStyle(toolbar);
      panel.style.cssText = 'display:block;max-width:1280px;margin:0 auto 32px;';
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
    if (overlay.dataset.presentation === 'full'
      && (previousPhase !== phase || previousPresentation !== 'full')) overlay.scrollTop = 0;
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
  resetButton.addEventListener('click', () => {
    layout = { left: null, top: null, width: 410, height: 620 };
    place(); remember();
  }, { signal: controller.signal });
  globalThis.addEventListener('resize', place, { signal: controller.signal });
  globalThis.visualViewport?.addEventListener('resize', place, { signal: controller.signal });
  globalThis.visualViewport?.addEventListener('scroll', place, { signal: controller.signal });

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
    launcher.dataset.tone = progress.tone;
    launcher.dataset.running = String(progress.running);
    launcher.innerHTML = `<span class="mp-launcher-dot" aria-hidden="true"></span>${label}${unread && !unread.hidden
      ? `<span class="mp-unread">${unread.textContent}</span>`
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
