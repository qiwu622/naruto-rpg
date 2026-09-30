import assert from 'node:assert/strict';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

globalThis.localStorage = new MemoryStorage();

const {
  saveApiScheme,
  setActiveApiScheme
} = await import('../js/core/api-schemes.js');
const {
  discoverMainPanelApiSchemeModels,
  listMainPanelApiSchemes,
  loadMainPanelApiScheme,
  normalizeMainPanelApiScheme
} = await import('../js/multiplayer/main-api-scheme-bridge.js');

const schemeId = await saveApiScheme({
  name: 'Claude 主方案',
  backend: 'claude',
  apiUrl: 'https://api.anthropic.com/v1/messages',
  apiKey: 'scheme-secret',
  model: 'claude-sonnet-default',
  disableStreaming: false
});
setActiveApiScheme(schemeId);

const summaries = await listMainPanelApiSchemes();
assert.equal(summaries.activeId, schemeId);
assert.equal(summaries.schemes.length, 1);
assert.equal(summaries.schemes[0].hasKey, true);
assert.equal(summaries.schemes[0].apiKey, undefined, 'summary must never decrypt the Key');

const loaded = await loadMainPanelApiScheme(schemeId);
assert.equal(loaded.name, 'Claude 主方案');
assert.equal(loaded.adapter, 'anthropic');
assert.equal(loaded.clientBackend, 'claude');
assert.equal(loaded.baseUrl, 'https://api.anthropic.com/v1');
assert.equal(loaded.endpointOrigin, 'https://api.anthropic.com');
assert.equal(loaded.authScheme, 'x-api-key');
assert.equal(loaded.apiKey, 'scheme-secret');
assert.equal(loaded.model, 'claude-sonnet-default');

const discoveryCalls = [];
const models = await discoverMainPanelApiSchemeModels({
  name: 'Claude 主方案',
  backend: 'claude',
  apiUrl: 'https://api.anthropic.com/v1',
  apiKey: 'scheme-secret',
  model: 'claude-sonnet-default'
}, {
  client: {
    async listModels(config) {
      discoveryCalls.push(config);
      return ['claude-opus', 'claude-sonnet-default', 'claude-haiku', 'claude-opus'];
    }
  }
});
assert.deepEqual(models, [
  'claude-sonnet-default',
  'claude-opus',
  'claude-haiku'
]);
assert.deepEqual(discoveryCalls, [{
  apiUrl: 'https://api.anthropic.com/v1',
  apiKey: 'scheme-secret',
  backend: 'claude',
  model: 'claude-sonnet-default'
}]);

const keyless = normalizeMainPanelApiScheme({
  name: 'DeepSeek 免密代理',
  backend: 'deepseek',
  apiUrl: '',
  apiKey: '',
  model: 'deepseek-chat'
});
assert.equal(keyless.baseUrl, 'https://api.deepseek.com/v1');
assert.equal(keyless.adapter, 'openai_compatible');
assert.equal(keyless.authScheme, 'none');

assert.throws(
  () => normalizeMainPanelApiScheme({ backend: 'tavern', model: 'tavern-default' }),
  error => error.code === 'MULTIPLAYER_API_SCHEME_UNSUPPORTED'
);
assert.throws(
  () => normalizeMainPanelApiScheme({
    backend: 'custom',
    apiUrl: 'http://127.0.0.1:11434/v1',
    model: 'local-model'
  }),
  error => error.code === 'MULTIPLAYER_API_SCHEME_URL_FORBIDDEN'
);
await assert.rejects(
  loadMainPanelApiScheme('scheme-missing'),
  error => error.code === 'MULTIPLAYER_API_SCHEME_NOT_FOUND'
);

console.log('multiplayer main-panel API scheme bridge regression: 20 passed');
