// Start at one pixel so imported `100vh`/`height: 100%` rules resolve against
// the embedded card's real content instead of feeding a large initial viewport
// back into the resize loop. The bridge immediately reports the natural size.
const MIN_FRAME_HEIGHT = 1;
const MAX_FRAME_HEIGHT = 2400;
const MAX_ACTION_LENGTH = 1000;
const INTERACTION_SETTLE_MS = 120;
const interactionSettleTimers = new WeakMap();

function createNonce() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
}

function sandboxCsp(nonce) {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    'media-src data: blob:',
    "connect-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'"
  ].join('; ');
}

function bridgeScript(nonce) {
  return `
<script nonce="${nonce}">
(() => {
  const post = payload => {
    try { window.parent.postMessage(payload, '*'); } catch (_) {}
  };
  const NON_VISUAL_TAGS = new Set(['STYLE', 'SCRIPT', 'TEMPLATE', 'NOSCRIPT', 'META', 'LINK', 'BASE']);
  const REPLACED_TAGS = new Set(['IMG', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'HR', 'INPUT', 'TEXTAREA', 'SELECT', 'TABLE']);
  let lastHeight = 0;
  let scheduled = false;
  const number = value => Number.parseFloat(value) || 0;
  const hiddenByClosedDetails = element => {
    const details = element?.closest?.('details:not([open])');
    if (!details) return false;
    const summary = details.querySelector(':scope > summary');
    return !summary || (element !== summary && !summary.contains(element));
  };
  const visible = element => {
    if (!element || NON_VISUAL_TAGS.has(element.tagName) || element.hidden || hiddenByClosedDetails(element)) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.contentVisibility !== 'hidden';
  };
  const trailingSpace = element => {
    let total = 0;
    let current = element;
    let depth = 0;
    while (current && current !== document.body && depth < 12) {
      if (!visible(current)) return 0;
      const style = getComputedStyle(current);
      total += number(style.paddingBottom) + number(style.borderBottomWidth) + number(style.marginBottom);
      current = current.parentElement;
      depth++;
    }
    if (document.body) {
      const bodyStyle = getComputedStyle(document.body);
      total += number(bodyStyle.paddingBottom) + number(bodyStyle.borderBottomWidth);
    }
    return total;
  };
  const naturalHeight = () => {
    const body = document.body;
    if (!body) return 1;
    const bodyTop = body.getBoundingClientRect().top;
    let bottom = 0;
    let visited = 0;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node = walker.currentNode;
    while ((node = walker.nextNode()) && visited < 12000) {
      visited++;
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node;
        if (!visible(element)) {
          walker.currentNode = element;
          continue;
        }
        if (!REPLACED_TAGS.has(element.tagName)) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          bottom = Math.max(bottom, rect.bottom - bodyTop + trailingSpace(element));
        }
        continue;
      }
      const parent = node.parentElement;
      if (!parent || !visible(parent) || !String(node.nodeValue || '').trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = range.getBoundingClientRect();
      range.detach?.();
      if (rect.width > 0 || rect.height > 0) {
        bottom = Math.max(bottom, rect.bottom - bodyTop + trailingSpace(parent));
      }
    }
    return Math.max(1, Math.ceil(bottom));
  };
  const resize = () => {
    scheduled = false;
    const height = naturalHeight();
    if (height && Math.abs(height - lastHeight) > 1) {
      lastHeight = height;
      post({ type: 'naruto:preset-resize', height });
    }
  };
  const blockedControl = value => /(?:theme|skin|mode|toggle|expand|collapse|setting|close|copy|tab)/i.test(value);
  const actionControl = value => /(?:option|choice|action|select|reply|answer|fox[_-]?(?:item|card)|dream[_-]?option)/i.test(value);
  addEventListener('message', event => {
    if (event.source !== window.parent || !event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'naruto:preset-enable') {
      document.documentElement.dataset.narutoPresetInteractive = 'true';
      post({ type: 'naruto:preset-interactive' });
    } else if (event.data.type === 'naruto:preset-disable') {
      delete document.documentElement.dataset.narutoPresetInteractive;
    }
  });
  document.addEventListener('click', event => {
    const target = event.target && event.target.closest
      ? event.target.closest('button, [role="button"], a, [data-option], [data-option-text], [data-choice], [data-action]')
      : null;
    if (!target) return;
    const identity = [
      target.id || '',
      typeof target.className === 'string' ? target.className : '',
      target.getAttribute('role') || '',
      target.getAttribute('onclick') || ''
    ].join(' ');
    const direct = target.getAttribute('data-option-text')
      || target.getAttribute('data-option')
      || target.getAttribute('data-choice')
      || target.getAttribute('data-action')
      || '';
    if (blockedControl(identity + ' ' + direct)) return;
    if (!direct && !actionControl(identity)) return;
    const action = String(direct || target.textContent || '').replace(/\s+/g, ' ').trim();
    if (!action || action.length > ${MAX_ACTION_LENGTH}) return;
    post({ type: 'naruto:preset-action', action, append: event.shiftKey === true });
  }, true);
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(resize);
  };
  addEventListener('load', schedule);
  addEventListener('resize', schedule);
  document.addEventListener('toggle', schedule, true);
  document.addEventListener('input', schedule, true);
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(schedule);
    observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
  }
  if ('MutationObserver' in window) new MutationObserver(schedule).observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, characterData: true
  });
  // The host keeps pointer input disabled until this acknowledgement arrives.
  // This prevents a very fast click from landing after imported markup exists
  // but before Chromium has finished installing this delegated listener.
  post({ type: 'naruto:preset-ready' });
  schedule();
  setTimeout(resize, 80);
  setTimeout(resize, 400);
})();
</script>`;
}

export function sanitizePresetSandboxSource(source) {
  return String(source || '')
    // Imported regex replacements are presentation assets, not trusted code.
    // The project bridge below provides the only executable behaviour.
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?\s*>/gi, '')
    .replace(/<\/?(?:iframe|object|embed|base|link|meta)\b[^>]*>/gi, '')
    .replace(/<\/?(?:html|head|body)\b[^>]*>/gi, '')
    .replace(/\s+on[a-z][\w:-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(?:href|src|action|formaction)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, '');
}

export function buildPresetSandboxDocument(source) {
  const nonce = createNonce();
  const safeSource = sanitizePresetSandboxSource(source);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${sandboxCsp(nonce)}">
  <style>
    :root { color-scheme: dark; background: transparent; }
    * { box-sizing: border-box; }
    html, body { width: 100%; min-height: 0; margin: 0; overflow-x: hidden; background: transparent; }
    html:not([data-naruto-preset-interactive="true"]) body { pointer-events: none !important; }
    body { color: #e8e4d9; font: 14px/1.75 'Noto Sans SC', 'Microsoft YaHei UI', system-ui, sans-serif; }
    img, svg, video, canvas { max-width: 100%; }
  </style>
${bridgeScript(nonce)}
</head>
<body>
${safeSource}
  <style id="naruto-preset-embed-reset">
    html, body {
      height: auto !important;
      min-height: 0 !important;
      max-height: none !important;
      overflow-x: hidden !important;
    }
    [hidden] { display: none !important; }
  </style>
</body>
</html>`;
}

function clampHeight(value) {
  const height = Number(value);
  if (!Number.isFinite(height)) return MIN_FRAME_HEIGHT;
  return Math.max(MIN_FRAME_HEIGHT, Math.min(MAX_FRAME_HEIGHT, Math.ceil(height)));
}

function scheduleSandboxInteractionReady(iframe) {
  const root = iframe.closest?.('.preset-output-presentation') || iframe.parentElement || iframe;
  const frames = () => {
    const rows = [...(root.querySelectorAll?.('iframe.preset-output-sandbox') || [])];
    if (root.matches?.('iframe.preset-output-sandbox')) rows.unshift(root);
    return rows;
  };
  for (const frame of frames()) {
    frame.style.pointerEvents = 'none';
    frame.setAttribute('aria-busy', 'true');
    frame.contentWindow?.postMessage({ type: 'naruto:preset-disable' }, '*');
  }
  const previous = interactionSettleTimers.get(root);
  if (previous) clearTimeout(previous);
  interactionSettleTimers.set(root, setTimeout(() => {
    interactionSettleTimers.delete(root);
    for (const frame of frames()) {
      if (frame.dataset.narutoPresetBridgeReady !== 'true') continue;
      frame.contentWindow?.postMessage({ type: 'naruto:preset-enable' }, '*');
    }
  }, INTERACTION_SETTLE_MS));
}

export function mountPresetOutputSandbox(container, source, {
  onAction,
  title = '导入预设美化输出'
} = {}) {
  if (!container) throw new TypeError('缺少预设输出容器');
  const iframe = document.createElement('iframe');
  iframe.className = 'preset-output-sandbox';
  iframe.title = title;
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('scrolling', 'auto');
  iframe.setAttribute('aria-busy', 'true');
  iframe.style.cssText = [
    'display:block',
    'width:100%',
    `height:${MIN_FRAME_HEIGHT}px`,
    'border:0',
    'background:transparent',
    'overflow:auto',
    'max-width:100%',
    'pointer-events:none'
  ].join(';');

  let lastActionAt = 0;
  const handleMessage = event => {
    if (event.source !== iframe.contentWindow || !event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'naruto:preset-ready') {
      iframe.dataset.narutoPresetBridgeReady = 'true';
      scheduleSandboxInteractionReady(iframe);
      return;
    }
    if (event.data.type === 'naruto:preset-interactive') {
      iframe.style.pointerEvents = 'auto';
      iframe.removeAttribute('aria-busy');
      return;
    }
    if (event.data.type === 'naruto:preset-resize' || event.data.type === 'resizeIframe') {
      iframe.style.height = `${clampHeight(event.data.height)}px`;
      scheduleSandboxInteractionReady(iframe);
      return;
    }
    if (event.data.type !== 'naruto:preset-action') return;
    const now = Date.now();
    if (now - lastActionAt < 120) return;
    lastActionAt = now;
    const action = String(event.data.action || '').replace(/\s+/g, ' ').trim().slice(0, MAX_ACTION_LENGTH);
    if (action) onAction?.(action, { append: event.data.append === true });
  };

  window.addEventListener('message', handleMessage);
  const observer = new MutationObserver(() => {
    if (iframe.isConnected) return;
    window.removeEventListener('message', handleMessage);
    observer.disconnect();
  });
  observer.observe(container.ownerDocument || document, { childList: true, subtree: true });

  iframe.srcdoc = buildPresetSandboxDocument(source);
  container.replaceChildren(iframe);
  return iframe;
}

export default mountPresetOutputSandbox;
