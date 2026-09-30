import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as imageStudioController from '../js/ui/image-studio-controller.js';
import {
  ImageSettingsStore,
  normalizeImageSettings as normalizeCoreImageSettings
} from '../js/core/image-studio/settings.js';
import { ImageStudioSettings } from '../js/ui/image-studio.js';

const uiSource = readFileSync(new URL('../js/ui/image-studio.js', import.meta.url), 'utf8');

const failures = [];
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(new Error(`${name}: ${error.message}`, { cause: error }));
    console.error(`FAIL ${name}: ${error.stack || error.message}`);
  }
}

await test('OpenAI-compatible settings keep manual model entry and expose explicit model discovery', () => {
  assert.match(uiSource, /name="openai\.model"/);
  assert.match(uiSource, /data-action="fetch-image-models"/);
});

await test('mixed model catalogs keep the manual value without auto-selecting a language model', () => {
  assert.equal(typeof imageStudioController.normalizeImageModelCatalog, 'function');
  const catalog = imageStudioController.normalizeImageModelCatalog({
    models: ['gpt-4.1', 'flux-pro', 'gpt-image-1', 'flux-pro'],
    imageModels: ['flux-pro', 'gpt-image-1']
  }, 'my-private-image-model');

  assert.equal(catalog.models.filter(model => model === 'flux-pro').length, 1);
  assert.ok(catalog.models.includes('gpt-4.1'));
  assert.ok(catalog.models.includes('my-private-image-model'));
  assert.deepEqual(catalog.imageModels, ['flux-pro', 'gpt-image-1']);
  assert.equal(Object.hasOwn(catalog, 'selectedModel'), false);
});

await test('model catalogs bound pathological entry counts and identifiers', () => {
  const catalog = imageStudioController.normalizeImageModelCatalog({
    models: [
      ...Array.from({ length: 5200 }, (_, index) => `model-${String(index).padStart(4, '0')}`),
      'x'.repeat(513)
    ]
  });
  assert.equal(catalog.models.length, 5000);
  assert.equal(catalog.models.some(model => model.length > 512), false);
});

await test('main API reuse exposes only connection fields and derives an allowed key header', async () => {
  const reused = imageStudioController.reusableMainApiConfig({
    apiUrl: 'https://relay.example/v1', apiKey: 'secret', model: 'language-model', backend: 'claude'
  });
  assert.deepEqual(reused, {
    apiUrl: 'https://relay.example/v1', apiKey: 'secret', apiKeyHeader: 'x-api-key'
  });
  assert.equal(Object.hasOwn(reused, 'model'), false);

  const controller = new imageStudioController.ImageStudioUIController(null, {
    readMainApiConfig: () => ({
      apiUrl: 'https://relay.example/v1', apiKey: 'secret', model: 'do-not-copy', backend: 'custom',
      apiKeyHeader: 'api-key'
    })
  });
  assert.deepEqual(await controller.mainApiConfig(), {
    apiUrl: 'https://relay.example/v1', apiKey: 'secret', apiKeyHeader: 'api-key'
  });
});

await test('main API reuse can read the application state manager without a UI-only adapter', async () => {
  const controller = imageStudioController.createImageStudioUIController(null, {
    stateManager: {
      getAPIConfig() {
        return {
          apiUrl: 'https://relay.example/v1/chat/completions',
          apiKey: 'fixture-secret',
          backend: 'claude',
          model: 'language-only-model'
        };
      }
    }
  });
  assert.deepEqual(await controller.mainApiConfig(), {
    apiUrl: 'https://relay.example/v1/chat/completions',
    apiKey: 'fixture-secret',
    apiKeyHeader: 'x-api-key'
  });
});

await test('OpenAI-compatible UI exposes the three proxy-supported API key headers', () => {
  assert.match(uiSource, /name="openai\.apiKeyHeader"/);
  for (const header of ['Authorization', 'x-api-key', 'api-key']) {
    assert.match(uiSource, new RegExp(`['"]${header}['"]`));
  }
  assert.match(uiSource, /data-action="use-main-api"/);
});

await test('NovelAI UI exposes token, model, sampler, scheduler, dimensions, and quality controls', () => {
  assert.ok(imageStudioController.IMAGE_PROVIDER_IDS.includes('novelai'));
  assert.equal(imageStudioController.normalizeProviderId('nai'), 'novelai');
  assert.equal(imageStudioController.normalizeProviderId('novel-ai'), 'novelai');
  for (const field of [
    'novelai.apiUrl', 'novelai.apiKey', 'novelai.model', 'novelai.sampler',
    'novelai.noiseSchedule', 'novelai.steps', 'novelai.width', 'novelai.height',
    'novelai.scale', 'novelai.cfgRescale', 'novelai.qualityToggle', 'novelai.artistPrompt'
  ]) {
    assert.match(uiSource, new RegExp(`name=["']${field.replace('.', '\\.')}`));
  }
  assert.match(uiSource, /nai-diffusion-4-5-full/);
  assert.match(uiSource, /NovelAI/);
});

await test('NovelAI UI settings preserve manual future model IDs and generation controls', () => {
  const normalized = imageStudioController.normalizeImageSettings({
    activeProviderId: 'nai',
    providers: {
      'novel-ai': {
        apiUrl: 'https://image.novelai.net', apiKey: 'fixture-token', model: 'nai-future-model',
        sampler: 'k_dpmpp_2m', noiseSchedule: 'exponential', steps: 31,
        width: 1024, height: 1024, scale: 6.5, cfgRescale: 0.25, qualityToggle: false
      }
    }
  });
  assert.equal(normalized.activeProviderId, 'novelai');
  assert.equal(normalized.providers.novelai.model, 'nai-future-model');
  assert.equal(normalized.providers.novelai.noiseSchedule, 'exponential');
  assert.equal(normalized.providers.novelai.qualityToggle, false);
  assert.equal(normalized.providers.novelai.cfgRescale, 0.25);
});

await test('NovelAI artist tags preserve weights and line breaks through both settings normalizers', () => {
  const artistPrompt = '  {artist:sample_one}, [artist:sample_two]\n1.2::artist:sample_three::  ';
  for (const normalize of [imageStudioController.normalizeImageSettings, normalizeCoreImageSettings]) {
    assert.equal(normalize({}).providers.novelai.artistPrompt, '');
    assert.equal(normalize({ providers: { nai: { artistPrompt } } }).providers.novelai.artistPrompt, artistPrompt);
    assert.equal(normalize({ providers: { nai: { artistPrompt }, novelai: { artistPrompt: '' } } })
      .providers.novelai.artistPrompt, '', 'clearing the canonical field must override an old alias profile');
    for (const invalid of [null, 17, ['artist:sample'], { artist: 'sample' }]) {
      assert.equal(normalize({ providers: { novelai: { artistPrompt: invalid } } })
        .providers.novelai.artistPrompt, '');
    }
  }
});

await test('NovelAI artist textarea escapes content and explains when it is appended', () => {
  const element = new ImageStudioSettings();
  element._settings.providers.novelai.artistPrompt = '{artist:sample}\n</textarea><script>injected()</script>';
  const markup = element._providerHtml('novelai');
  assert.match(markup, /<textarea[^>]*name="novelai\.artistPrompt"[^>]*rows="3"/);
  assert.match(markup, /\{artist:sample\}\n&lt;\/textarea&gt;&lt;script&gt;injected\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(markup, /<script>/);
  assert.match(markup, /自动追加到正向提示词，留空不追加/);
});

await test('NovelAI artist textarea saves, reloads and clears through the UI controller and settings store', async () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value))
  };
  const store = new ImageSettingsStore({ storage });
  const element = new ImageStudioSettings();
  element._settings.activeProviderId = 'novelai';
  const fields = new Map([
    ['activeProviderId', { value: 'novelai' }],
    ['turnMode', { value: 'manual' }],
    ['promptMode', { value: 'main-contract' }]
  ]);
  for (const [id, prefix] of [
    ['openai-compatible', 'openai'], ['novelai', 'novelai'], ['comfyui', 'comfy'], ['a1111', 'a1111']
  ]) {
    for (const [key, value] of Object.entries(element._settings.providers[id])) {
      fields.set(`${prefix}.${key}`, { value: typeof value === 'string' ? value : String(value), checked: value === true });
    }
  }
  element.shadowRoot = {
    querySelector: selector => fields.get(selector.match(/^\[name="([^"]+)"\]$/)?.[1]) || null,
    querySelectorAll: () => []
  };
  const commands = [];
  element.controller = new imageStudioController.ImageStudioUIController({
    read(query) { assert.equal(query.type, 'settings'); return store.load(); },
    execute(command) {
      commands.push(command.type);
      assert.equal(command.type, 'configure');
      return store.save(command.settings);
    }
  }, { saveWorldbook: () => {} });
  const artistPrompt = '{artist:sample_one}, 0.8::artist:sample_two::\n[artist:sample_three]';
  fields.get('novelai.artistPrompt').value = artistPrompt;
  await element._save();
  assert.equal(element._tone, 'success');
  assert.equal((await element.controller.settings()).providers.novelai.artistPrompt, artistPrompt);
  assert.equal(new ImageSettingsStore({ storage }).load().providers.novelai.artistPrompt, artistPrompt);

  fields.get('novelai.artistPrompt').value = '';
  await element._save();
  assert.equal(element._tone, 'success');
  assert.equal((await element.controller.settings()).providers.novelai.artistPrompt, '');
  assert.equal(new ImageSettingsStore({ storage }).load().providers.novelai.artistPrompt, '');
  assert.deepEqual(commands, ['configure', 'configure']);
});

if (failures.length) {
  throw new AggregateError(failures, `${failures.length} image studio UI regression test(s) failed`);
}

console.log(`\n${passed} image studio UI regression tests passed.`);
