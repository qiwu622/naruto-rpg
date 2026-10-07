import assert from 'node:assert/strict';

// app-shell imports the multiplayer custom element. Keep this regression test
// browser-free while still allowing custom-element modules to register.
globalThis.HTMLElement = class {
  attachShadow() {
    this.shadowRoot = {};
    return this.shadowRoot;
  }
};
globalThis.customElements = {
  registry: new Map(),
  define(name, value) {
    this.registry.set(name, value);
  },
  get(name) {
    return this.registry.get(name);
  }
};

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null; }
  setItem(key, value) { this.values.set(String(key), String(value)); }
  removeItem(key) { this.values.delete(String(key)); }
  clear() { this.values.clear(); }
}

globalThis.localStorage = new MemoryStorage();

const [{ appShell }, presetModule, { eventBus }] = await Promise.all([
  import('../js/ui/app-shell.js'),
  import('../js/data/default-preset.js'),
  import('../js/core/event-bus.js')
]);

function installPreset(regexScripts = []) {
  localStorage.setItem(presetModule.MAIN_PRESET_STORAGE_KEY, JSON.stringify({
    name: 'Synthetic imported preset',
    _version: presetModule.DEFAULT_MAIN_PRESET_VERSION,
    _importMode: 'replace',
    entries: [{ id: 'fixture', name: 'fixture', enabled: true, role: 'system', content: 'fixture' }],
    regexScripts
  }));
  presetModule.invalidateMainPresetCache();
}

installPreset([{
  id: 'markdown-fixture', enabled: true, placement: [2], markdownOnly: true,
  findRegex: '/<story_scene>([\\s\\S]*?)<\\/story_scene>/',
  replaceString: '**卷轴美化**\n$1'
}]);
const markdown = appShell._buildPresetPresentation([
  '<reasoning>PRIVATE_REASONING</reasoning>',
  '<story_scene>可见剧情</story_scene>',
  '<audit>PRIVATE_AUDIT</audit>'
].join('\n'), '安全正文');
assert.equal(markdown.kind, 'markdown');
assert.match(markdown.text, /卷轴美化/);
assert.match(markdown.text, /可见剧情/);
assert.doesNotMatch(markdown.text, /PRIVATE_REASONING|PRIVATE_AUDIT/);

installPreset([{
  id: 'sandbox-fixture', enabled: true, placement: [2], markdownOnly: true,
  findRegex: '/<story_scene>[\\s\\S]*?<\\/story_scene>/',
  replaceString: '```html\n<button data-action="向北潜行">选择行动</button>\n```'
}]);
const sandbox = appShell._buildPresetPresentation('<story_scene>剧情</story_scene>', '安全正文');
assert.equal(sandbox.kind, 'sandbox');
assert.match(sandbox.source, /data-action="向北潜行"/);
assert.equal(sandbox.fallbackText, '安全正文');

installPreset([]);
const fallback = appShell._buildPresetPresentation([
  '<planning_driver>PRIVATE_DRIVER</planning_driver>',
  '<story_scene>通用结构正文</story_scene>',
  '<memory_log>可展示记忆</memory_log>',
  '<selection>1. 向北潜行\n2. 留在原地</selection>',
  '<review_audit>PRIVATE_AUDIT</review_audit>'
].join('\n'), '安全正文');
assert.equal(fallback.kind, 'structured');
assert.match(fallback.text, /通用结构正文/);
assert.ok(fallback.blocks.some(block => /可展示记忆/.test(block.text || '')));
assert.deepEqual(fallback.actions, ['向北潜行', '留在原地']);
assert.doesNotMatch(JSON.stringify(fallback), /PRIVATE_DRIVER|PRIVATE_AUDIT/);

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.className = '';
    this.innerHTML = '';
    this.textContent = '';
    this.attributes = {};
    this.listeners = {};
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, listener) { this.listeners[type] = listener; }
}
const previousDocument = globalThis.document;
let hostActionButton = null;
try {
  globalThis.document = { createElement: tagName => new FakeElement(tagName) };
  for (const text of ['', ' \n\t ']) {
    const host = new FakeElement();
    appShell._renderPresetPresentation(host, {
      kind: 'markdown', text, fallbackText: '展示层保存的安全正文。'
    }, '管线安全正文。');
    assert.match(host.innerHTML, /展示层保存的安全正文/);
  }
  const legacyHost = new FakeElement();
  appShell._renderPresetPresentation(legacyHost, { kind: 'markdown', text: '' },
    '<reasoning>PRIVATE_FALLBACK_REASONING</reasoning>管线安全正文。');
  assert.match(legacyHost.innerHTML, /管线安全正文/);
  assert.doesNotMatch(legacyHost.innerHTML, /PRIVATE_FALLBACK_REASONING/);
  const structuredHost = new FakeElement();
  appShell._renderPresetPresentation(structuredHost, fallback, '安全正文');
  assert.equal(structuredHost.children.length, 4);
  assert.equal(structuredHost.children[0].className, 'preset-output-structured-main');
  assert.match(structuredHost.children[0].innerHTML, /通用结构正文/);
  assert.equal(structuredHost.children[1].children[0].textContent, '记忆记录');
  assert.match(structuredHost.children[1].children[1].innerHTML, /可展示记忆/);
  assert.equal(structuredHost.children[3].className, 'preset-output-host-actions');
  hostActionButton = structuredHost.children[3].children[0];
  assert.equal(hostActionButton.textContent, '向北潜行');
} finally {
  if (previousDocument === undefined) delete globalThis.document;
  else globalThis.document = previousDocument;
}

let focusCalls = 0;
let selection = null;
let resizeCalls = 0;
let submitCalls = 0;
const input = {
  value: '既有行动  ',
  focus(options) {
    focusCalls += 1;
    assert.deepEqual(options, { preventScroll: true });
  },
  setSelectionRange(start, end) { selection = [start, end]; }
};
const originalElement = appShell.element;
const originalResizeInput = appShell._resizeInput;
const offSubmit = eventBus.on('user:submit', () => { submitCalls += 1; });
try {
  appShell.element = { querySelector: selector => selector === '#chat-input' ? input : null };
  appShell._resizeInput = () => { resizeCalls += 1; };
  hostActionButton.listeners.click({ shiftKey: true });
  assert.equal(input.value, '既有行动\n向北潜行');
  assert.equal(focusCalls, 1);
  assert.equal(resizeCalls, 1);
  assert.deepEqual(selection, [input.value.length, input.value.length]);
  assert.equal(submitCalls, 0, '预设行动不得触发用户提交');
} finally {
  offSubmit?.();
  appShell.element = originalElement;
  appShell._resizeInput = originalResizeInput;
}

assert.doesNotMatch(appShell.renderSinglePage.toString(), /buildPresetPresentation|_renderPresetPresentation/);
assert.doesNotMatch(appShell.restoreChatHistory.toString(), /rawResponse|buildPresetPresentation/);

console.log('preset output app-shell regression passed');
