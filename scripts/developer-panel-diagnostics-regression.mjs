import assert from 'node:assert/strict';

const stored = new Map();
globalThis.localStorage = {
  getItem: key => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: key => stored.delete(key)
};
globalThis.HTMLElement = class {
  attachShadow() {
    const actions = new Map();
    this.shadowRoot = {
      innerHTML: '',
      querySelector(selector) {
        if (!actions.has(selector)) actions.set(selector, {
          addEventListener(type, callback) { this[type] = callback; }
        });
        return actions.get(selector);
      },
      querySelectorAll: () => []
    };
    return this.shadowRoot;
  }
};
const components = new Map();
globalThis.customElements = {
  get: name => components.get(name),
  define: (name, component) => components.set(name, component)
};

const { getVariableUpdaterAttempts, recordVariableUpdaterAttempt } = await import('../js/core/variable-updater-diagnostics.js');
const { default: DeveloperPanel } = await import('../js/ui/developer-panel.js');
const { default: GameModal } = await import('../js/ui/modal.js');
GameModal.alert = () => {};
let copied = '';
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { async writeText(text) { copied = text; } } }
});

const error = Object.assign(new Error('变量校验失败'), {
  failureKind: 'invalid_protocol',
  validation: { errors: ['不支持路径 <unsafe>'] }
});
const rawOutput = '<script>alert("诊断原文")</script>';
recordVariableUpdaterAttempt({
  stage: 'initial', model: 'test-model', rawOutput, error,
  warnings: ['缺少 <update_manifest>'], finishReason: 'length'
});
const panel = new DeveloperPanel();
panel.connectedCallback();
assert.ok(panel.shadowRoot.innerHTML.includes('变量更新结果'), 'failed results need their own visible section');
assert.ok(panel.shadowRoot.innerHTML.includes('invalid_protocol'));
assert.ok(panel.shadowRoot.innerHTML.includes('test-model'));
assert.ok(panel.shadowRoot.innerHTML.includes('length'));
assert.ok(panel.shadowRoot.innerHTML.includes('&lt;unsafe&gt;'));
assert.ok(panel.shadowRoot.innerHTML.includes('&lt;update_manifest&gt;'));
assert.ok(panel.shadowRoot.innerHTML.includes('&lt;script&gt;'));
assert.equal(panel.shadowRoot.innerHTML.includes('<script>'), false);
console.log('PASS failed updater results render their type, errors, warnings and escaped original output');

await panel.shadowRoot.querySelector('[data-action="copy"]').click();
assert.ok(copied.includes('invalid_protocol'));
assert.ok(copied.includes(rawOutput), 'plain-text export preserves original model output');
assert.ok(copied.includes('finishReason: length'));
console.log('PASS existing copy action exports updater diagnostics with the original response');

recordVariableUpdaterAttempt({ stage: 'repair', model: 'repair-model', rawOutput: '修复后的变量' });
assert.ok(panel.shadowRoot.innerHTML.includes('repair-model'), 'attempt events refresh the mounted panel');
panel.disconnectedCallback();
const disconnectedHtml = panel.shadowRoot.innerHTML;
recordVariableUpdaterAttempt({ stage: 'repair', model: 'after-disconnect', rawOutput: '稍后记录' });
assert.equal(panel.shadowRoot.innerHTML, disconnectedHtml);
console.log('PASS updater diagnostics refresh while mounted and unsubscribe after disconnect');

recordVariableUpdaterAttempt({ stage: 'repair', model: 'long-output-model', rawOutput: 'x'.repeat(40001) });
const latestPanel = new DeveloperPanel();
latestPanel.connectedCallback();
assert.ok(latestPanel.shadowRoot.innerHTML.includes('已截断'));
await latestPanel.shadowRoot.querySelector('[data-action="copy"]').click();
assert.ok(copied.includes('truncated: true'));
console.log('PASS truncated diagnostics are explicitly marked in the panel and text export');

latestPanel.shadowRoot.querySelector('[data-action="clear"]').click();
assert.deepEqual(getVariableUpdaterAttempts(), []);
assert.ok(latestPanel.shadowRoot.innerHTML.includes('暂无请求记录'));
latestPanel.disconnectedCallback();
console.log('PASS the existing clear action also clears updater diagnostics');

console.log('\n5 developer panel diagnostics regression tests passed.');
