import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';

import {
  A1111ImageAdapter,
  ComfyUIImageAdapter,
  ImageAdapterRegistry,
  ImageContractStreamFilter,
  ImageSettingsStore,
  ImageTransport,
  ImageWorldbookStore,
  MemoryImageStore,
  NovelAIImageAdapter,
  OpenAIImageAdapter,
  contractToPrompt,
  createImageStudio,
  exportImageWorldbook,
  extractImageContract,
  importImageWorldbook,
  matchImageWorldbook,
  mergeImageWorldbooks,
  normalizeImageSettings,
  normalizeImageApiBaseUrl,
  renderImageWorldbook,
  renderImageWorldbookPrompts,
  extractFirstImageFromZip,
  stripImageContracts,
  validateImageContract
} from '../js/core/image-studio/index.js';
import { instructionParser } from '../js/core/instruction-parser.js';
import { stateManager } from '../js/core/state-manager.js';

const failures = [];
let passed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(new Error(`${name}: ${error.message}`, { cause: error }));
    console.error(`FAIL ${name}: ${error.stack || error.message}`);
  }
}

function visualContract(overrides = {}) {
  return {
    schema: 'naruto.visual-contract/v1',
    purpose: 'turn_illustration',
    scene: {
      summary: '鸣人在终结谷接住一枚发光卷轴',
      location: '终结谷瀑布前',
      action: '鸣人跃起伸手接住卷轴',
      mood: '紧张而明亮'
    },
    shot: {
      framing: '中远景',
      viewpoint: '低机位',
      composition: '人物位于画面中央',
      lighting: '夕阳逆光'
    },
    subjects: [{
      id: 'subject-naruto',
      name: '漩涡鸣人',
      appearance: ['金色短发', '蓝色眼睛'],
      pose: '跃起',
      expression: '专注'
    }],
    style: {
      positive: ['高质量动画插画'],
      negative: ['水印']
    },
    continuity: {
      keep: ['木叶护额'],
      avoid: ['剧透', '文字']
    },
    ...overrides
  };
}

function pngBlob(width = 2, height = 3) {
  // dimensionsOf only needs the PNG signature and IHDR dimensions. Keeping
  // this fixture tiny also makes accidental base64 persistence easy to spot.
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new Blob([bytes], { type: 'image/png' });
}

async function blobBase64(blob) {
  return Buffer.from(await blob.arrayBuffer()).toString('base64');
}

function crc32(value) {
  const bytes = Buffer.from(value);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipBlob(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const source = Buffer.from(entry.data);
    const method = entry.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(source) : source;
    const checksum = entry.crc ?? crc32(source);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return new Blob([...localParts, centralDirectory, end], { type: 'application/zip' });
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class RecordingTransport {
  constructor(handler = async () => ({})) {
    this.calls = [];
    this.handler = handler;
    this.fetchImpl = async () => { throw new Error('unexpected direct download'); };
  }

  async json(provider, path, options = {}) {
    const call = { kind: 'json', provider: clone(provider), path, options: clone(options) };
    this.calls.push(call);
    return this.handler(call);
  }

  async blob(provider, path, options = {}) {
    const call = { kind: 'blob', provider: clone(provider), path, options: clone(options) };
    this.calls.push(call);
    return this.handler(call);
  }

  async downloadPublicUrl(url, options = {}) {
    const call = { kind: 'download', url, options: clone(options) };
    this.calls.push(call);
    return this.handler(call);
  }
}

function memorySettings(settings = {}) {
  const store = new ImageSettingsStore({ storage: null });
  store.save(normalizeImageSettings({
    enabled: true,
    providerId: 'openai',
    providers: {
      openai: {
        type: 'openai',
        apiUrl: 'https://images.example.test/v1',
        model: 'fixture-image-model'
      }
    },
    ...settings
  }));
  return store;
}

function offlineCloud() {
  return {
    async upload() {
      const error = new Error('offline fixture');
      error.code = 'CLOUD_OFFLINE';
      throw error;
    },
    async list() { throw new Error('offline fixture'); },
    async quota() { throw new Error('offline fixture'); },
    async select() {},
    async protect() {},
    async delete() {},
    async setActiveJobReference() {},
    async content() { throw new Error('missing fixture'); }
  };
}

function studioWithAdapter(adapter, {
  store = new MemoryImageStore(),
  settingsStore = memorySettings(),
  cloudGallery = offlineCloud(),
  autoStart = true
} = {}) {
  const adapterRegistry = {
    transport: { allowedPrivateOrigins: [] },
    get() { return adapter; }
  };
  return createImageStudio({
    store,
    settingsStore,
    worldbookStore: new ImageWorldbookStore({ storage: null }),
    adapterRegistry,
    cloudGallery,
    autoStart
  });
}

async function waitForJob(studio, jobId, predicate, label = 'job state', timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let job;
  while (Date.now() < deadline) {
    job = await studio.read({ type: 'job', jobId });
    if (predicate(job)) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`${label} timed out; last state was ${job?.state || 'missing'}`);
}

await test('visual contract validation, extraction, and prompt compilation use the public schema', () => {
  const contract = visualContract();
  assert.deepEqual(validateImageContract(contract), { valid: true, errors: [], value: contract });

  const source = `回合正文。\n<image_contract version="1">${JSON.stringify(contract)}</image_contract>\n收束句。`;
  const extracted = extractImageContract(source);
  assert.equal(extracted.error, null);
  assert.deepEqual(extracted.contract, contract);
  assert.equal(extracted.cleanText, '回合正文。\n\n收束句。');
  assert.doesNotMatch(extracted.cleanText, /image_contract|naruto\.visual-contract|subject-naruto/);

  const compiled = contractToPrompt(contract, {
    worldbookText: '角色服装必须符合当前时代。',
    visualProfiles: { 'subject-naruto': { canonical: '脸颊各有三道胡须状纹理' } }
  });
  assert.match(compiled.prompt, /终结谷瀑布前/);
  assert.match(compiled.prompt, /脸颊各有三道胡须状纹理/);
  assert.match(compiled.prompt, /当前时代/);
  assert.doesNotMatch(compiled.prompt, /水印|剧透|文字/);
  assert.equal(compiled.negativePrompt, '水印, 剧透, 文字');
});

await test('bare visual contract JSON is extracted and never shown as narrative text', () => {
  const contract = visualContract({
    scene: { summary: 'BARE_CONTRACT_SECRET', location: '禁区', action: '隐藏动作', mood: '未知' }
  });
  const rawContract = JSON.stringify(contract);
  const source = `公开正文。\n${rawContract}\n公开结尾。`;
  const extracted = extractImageContract(source);

  assert.equal(extracted.error, null);
  assert.deepEqual(extracted.contract, contract);
  assert.equal(extracted.rawContract, rawContract);
  assert.equal(extracted.cleanText, '公开正文。\n\n公开结尾。');
  assert.doesNotMatch(extracted.cleanText, /BARE_CONTRACT_SECRET|naruto\.visual-contract|"schema"/);
  assert.equal(instructionParser.cleanupResponse(source), '公开正文。\n\n公开结尾。');

  const unmatchedQuoteSource = `正文中的 ASCII 引号 \" 尚未闭合。\n${rawContract}`;
  const unmatchedQuoteResult = extractImageContract(unmatchedQuoteSource);
  assert.deepEqual(unmatchedQuoteResult.contract, contract);
  assert.equal(unmatchedQuoteResult.cleanText, '正文中的 ASCII 引号 \" 尚未闭合。');
  assert.doesNotMatch(instructionParser.cleanupResponse(unmatchedQuoteSource), /BARE_CONTRACT_SECRET|naruto\.visual-contract|"schema"/);

  const ordinaryJson = '公开正文。\n{"schema":"ordinary.example/v1","message":"应当保留"}\n公开结尾。';
  assert.equal(stripImageContracts(ordinaryJson), ordinaryJson);
  assert.match(instructionParser.cleanupResponse(ordinaryJson), /ordinary\.example\/v1|应当保留/);
});

await test('bare visual contract stream leaks no byte across any chunk boundary', () => {
  const contract = visualContract({
    scene: { summary: 'BARE_STREAM_SECRET', location: '禁区', action: '隐藏动作', mood: '未知' }
  });
  const rawContract = JSON.stringify(contract);
  const source = `可见开头。${rawContract}可见结尾。`;
  const expected = '可见开头。可见结尾。';

  for (let split = 0; split <= source.length; split++) {
    const filter = new ImageContractStreamFilter();
    let visible = filter.push(source.slice(0, split));
    assert.doesNotMatch(visible, /[{}]|BARE_STREAM_SECRET|naruto\.visual-contract|"schema"/);
    visible += filter.push(source.slice(split));
    assert.doesNotMatch(visible, /[{}]|BARE_STREAM_SECRET|naruto\.visual-contract|"schema"/);
    const final = filter.finish();
    visible += final.delta;
    assert.equal(visible, expected, `bare split offset ${split}`);
    assert.deepEqual(final.contract, contract);
  }

  const bytewise = new ImageContractStreamFilter();
  let visible = '';
  for (const char of source) {
    visible += bytewise.push(char);
    assert.doesNotMatch(visible, /[{}]|BARE_STREAM_SECRET|naruto\.visual-contract|"schema"/);
  }
  visible += bytewise.finish().delta;
  assert.equal(visible, expected);
});

await test('truncated bare visual contract stays hidden while ordinary JSON streams normally', () => {
  const truncated = '安全正文。\n{"schema":"naruto.visual-contract/v1","purpose":"turn_illustration","scene":{"summary":"TRUNCATED_SECRET"';
  assert.equal(stripImageContracts(truncated, { streaming: true }), '安全正文。\n');
  assert.equal(instructionParser.cleanupResponse(truncated), '安全正文。');
  assert.equal(instructionParser.cleanupPartialResponse(truncated), '安全正文。');

  const filter = new ImageContractStreamFilter();
  let visible = '';
  for (const char of truncated) {
    visible += filter.push(char);
    assert.doesNotMatch(visible, /[{}]|TRUNCATED_SECRET|naruto\.visual-contract|"schema"/);
  }
  const final = filter.finish();
  visible += final.delta;
  assert.equal(visible, '安全正文。\n');
  assert.equal(final.contract, null);

  const ordinaryJson = '普通数据：{"message":"VISIBLE_JSON"}。';
  const ordinaryFilter = new ImageContractStreamFilter();
  let ordinaryVisible = '';
  for (const char of ordinaryJson) ordinaryVisible += ordinaryFilter.push(char);
  ordinaryVisible += ordinaryFilter.finish().delta;
  assert.equal(ordinaryVisible, ordinaryJson);
});

await test('streaming JSON that opens at index 0 terminates and stays visible', () => {
  // Outliner/critic agents stream bare JSON ("{\"beats\":..."). The brace-hold
  // scan must terminate when the candidate brace sits at index 0; a regression
  // here freezes the page inside eventBus agent:stream handlers.
  const outlineJson = '{"beats": [{"id": 1, "summary": "旅程开始"}], "estimatedLength": 800}';
  assert.equal(stripImageContracts(outlineJson, { streaming: true }), outlineJson);

  const filter = new ImageContractStreamFilter();
  let visible = '';
  for (const char of outlineJson) visible += filter.push(char);
  visible += filter.finish().delta;
  assert.equal(visible, outlineJson);

  // A bare schema-first prefix at index 0 must still be withheld, not shown.
  const contractPrefix = '{"schema":"naruto.visual-contract/v1","purpose":"turn_illustration"';
  assert.equal(stripImageContracts(contractPrefix, { streaming: true }), '');
});

await test('invalid and truncated contracts stay hidden without failing narrative cleanup', () => {
  const invalid = '<image_contract version="1">{"schema":"wrong","secret":"NEVER_SHOW"}</image_contract>';
  const extracted = extractImageContract(`安全正文${invalid}结尾`);
  assert.equal(extracted.contract, null);
  assert.ok(extracted.error instanceof Error);
  assert.equal(extracted.cleanText, '安全正文结尾');
  assert.equal(stripImageContracts(`安全正文${invalid}结尾`), '安全正文结尾');

  const truncated = '安全正文<image_contract version="1">{"secret":"NEVER_SHOW"';
  assert.equal(stripImageContracts(truncated, { streaming: true }), '安全正文');
  const finished = new ImageContractStreamFilter();
  assert.equal(finished.push(truncated), '安全正文');
  const result = finished.finish();
  assert.equal(result.cleanText, '安全正文');
  assert.equal(result.contract, null);
  assert.doesNotMatch(`${result.cleanText}${result.delta}`, /NEVER_SHOW|secret|image_contract/);

  assert.equal(instructionParser.cleanupResponse(`安全正文${invalid}结尾`), '安全正文结尾');
  assert.equal(instructionParser.cleanupPartialResponse(truncated), '安全正文');
});

await test('stream filter leaks no contract byte across every two-chunk boundary', () => {
  const contract = visualContract({
    scene: { summary: 'SPLIT_SECRET', location: '禁区', action: '隐藏动作', mood: '未知' }
  });
  const source = `可见开头。<image_contract version="1">${JSON.stringify(contract)}</image_contract>可见结尾。`;
  const expected = '可见开头。可见结尾。';

  for (let split = 0; split <= source.length; split++) {
    const filter = new ImageContractStreamFilter();
    let visible = filter.push(source.slice(0, split));
    assert.doesNotMatch(visible, /SPLIT_SECRET|naruto\.visual-contract|image_contract/);
    visible += filter.push(source.slice(split));
    assert.doesNotMatch(visible, /SPLIT_SECRET|naruto\.visual-contract|image_contract/);
    const final = filter.finish();
    visible += final.delta;
    assert.equal(visible, expected, `split offset ${split}`);
    assert.deepEqual(final.contract, contract);
  }

  const bytewise = new ImageContractStreamFilter();
  let visible = '';
  for (const char of source) {
    visible += bytewise.push(char);
    assert.doesNotMatch(visible, /SPLIT_SECRET|naruto\.visual-contract|image_contract/);
  }
  visible += bytewise.finish().delta;
  assert.equal(visible, expected);
});

await test('agent progress never renders an image contract across chunk boundaries', async () => {
  const previousHTMLElement = globalThis.HTMLElement;
  const previousCustomElements = globalThis.customElements;
  class FakeHTMLElement {
    attachShadow() {
      this.shadowRoot = {};
      return this.shadowRoot;
    }
  }
  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.customElements = { define() {}, get() { return undefined; } };
  try {
    const { default: AgentProgress } = await import(`../js/ui/agent-progress.js?image-contract-regression=${Date.now()}`);
    const contract = visualContract({ scene: { summary: 'AGENT_STREAM_SECRET' } });
    const source = `可见正文。<image_contract version="1">${JSON.stringify(contract)}</image_contract>可见结尾。`;
    for (let split = 0; split <= source.length; split++) {
      const progress = new AgentProgress();
      progress._streamEl = { textContent: '', scrollTop: 0, scrollHeight: 0 };
      progress._onStream('writer', source.slice(0, split));
      assert.doesNotMatch(progress._streamEl.textContent, /AGENT_STREAM_SECRET|image_contract|naruto\.visual-contract/);
      progress._onStream('writer', source.slice(split));
      assert.equal(progress._streamEl.textContent, '可见正文。可见结尾。', `split offset ${split}`);
    }
  } finally {
    if (previousHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previousHTMLElement;
    if (previousCustomElements === undefined) delete globalThis.customElements;
    else globalThis.customElements = previousCustomElements;
  }
});

await test('image worldbook imports SillyTavern data and resolves constant, keyed, and secondary entries', () => {
  const book = importImageWorldbook({
    entries: {
      0: {
        uid: 'always', comment: '全局画风', key: [], content: '统一动画赛璐璐画风',
        constant: true, order: 5
      },
      1: {
        uid: 'naruto-rain', comment: '鸣人雨景', key: ['鸣人'], keysecondary: ['雨'],
        content: '雨水打湿鸣人的金发', order: 50
      },
      2: {
        uid: 'disabled', key: ['鸣人'], content: '不应命中', disable: true, order: 999
      }
    }
  });

  assert.deepEqual(
    matchImageWorldbook(book, { summary: '鸣人在雨中奔跑' }).map(entry => entry.id),
    ['naruto-rain', 'always']
  );
  assert.deepEqual(
    matchImageWorldbook(book, '鸣人在晴天奔跑').map(entry => entry.id),
    ['always']
  );
  assert.equal(renderImageWorldbook(book, '鸣人在雨中奔跑'), '雨水打湿鸣人的金发\n统一动画赛璐璐画风');
});

await test('worldbook overlay replaces, deletes, and adds entries without mutating the global book', () => {
  const globalBook = importImageWorldbook({ entries: [
    { id: 'style', key: ['忍者'], content: '旧画风', negativePrompt: '旧负向词', order: 10 },
    { id: 'remove-me', constant: true, content: '待删除规则', order: 20 }
  ] });
  const overlay = importImageWorldbook({ entries: [
    { id: 'style', key: ['忍者'], content: '存档专属新画风', negativePrompt: '现代服装, 水印', order: 100 },
    { id: 'remove-me', deleted: true },
    { id: 'save-only', constant: true, content: '仅本存档生效', order: 50 }
  ] });
  const globalBefore = structuredClone(globalBook);
  const merged = mergeImageWorldbooks(globalBook, overlay);

  assert.deepEqual(globalBook, globalBefore);
  assert.deepEqual(merged.entries.map(entry => entry.id), ['style', 'save-only']);
  assert.equal(renderImageWorldbook(merged, '忍者交战'), '存档专属新画风\n仅本存档生效');
  assert.deepEqual(renderImageWorldbookPrompts(merged, '忍者交战'), {
    prompt: '存档专属新画风\n仅本存档生效',
    negativePrompt: '现代服装, 水印'
  });

  const native = exportImageWorldbook(merged, 'native');
  assert.deepEqual(importImageWorldbook(JSON.stringify(native)), native);
  const sillyTavern = exportImageWorldbook(merged, 'sillytavern');
  assert.equal(Object.keys(sillyTavern.entries).length, 2);
  assert.equal(sillyTavern.entries['0'].content, '存档专属新画风\n\nNegative prompt: 现代服装, 水印');
});

await test('ImageStudio worldbook UI round-trip preserves global/overlay scope and negative prompts', async () => {
  const previousOverlay = stateManager.getSub('_image_worldbook_overlay');
  const studio = studioWithAdapter({ async generate() {} }, { autoStart: false });
  try {
    const saved = await studio.execute({
      type: 'worldbook:update',
      worldbook: {
        global: [{
          id: 'global-style', name: '全局风格', keywords: ['木叶'], secondaryKeywords: ['夜晚'],
          enabled: true, constant: false, priority: 80,
          prompt: '木叶夜景使用蓝紫色调', negativePrompt: '白昼, 现代路灯'
        }],
        overlay: [{
          id: 'save-character', name: '本存档角色', keywords: ['自来也'], secondaryKeywords: [],
          enabled: true, constant: false, priority: 120,
          prompt: '保持白色长发与红色眼线', negativePrompt: '短发'
        }]
      }
    });
    const loaded = await studio.read({ type: 'worldbook' });
    assert.deepEqual(loaded, saved);
    assert.deepEqual(loaded.global[0], {
      id: 'global-style', name: '全局风格', keywords: ['木叶'], enabled: true,
      secondaryKeywords: ['夜晚'], constant: false, priority: 80,
      prompt: '木叶夜景使用蓝紫色调', negativePrompt: '白昼, 现代路灯'
    });
    assert.deepEqual(loaded.overlay[0], {
      id: 'save-character', name: '本存档角色', keywords: ['自来也'], enabled: true,
      secondaryKeywords: [], constant: false, priority: 120,
      prompt: '保持白色长发与红色眼线', negativePrompt: '短发'
    });
  } finally {
    stateManager.setSub('_image_worldbook_overlay', previousOverlay);
  }
});

await test('settings normalize UI aliases and reject unknown provider types', () => {
  const normalized = normalizeImageSettings({
    enabled: true,
    turnMode: 'automatic',
    activeProviderId: 'custom-openai',
    concurrency: 99,
    allowedPrivateOrigins: ['http://192.168.1.9:8188/path', 'http://192.168.1.9:8188'],
    allowedPublicHttpOrigins: ['http://new.fangxiaobai.store:8050/v1', 'HTTP://new.fangxiaobai.store:8050'],
    providers: {
      'custom-openai': {
        type: 'openai-compatible', apiUrl: 'https://images.example.test/v1', model: 'local-image',
        apiKeyHeader: 'Cookie'
      }
    }
  });
  assert.equal(normalized.turnMode, 'auto');
  assert.equal(normalized.providerId, 'custom-openai');
  assert.equal(normalized.concurrency, 4);
  assert.deepEqual(normalized.allowedPrivateOrigins, ['http://192.168.1.9:8188']);
  assert.deepEqual(normalized.allowedPublicHttpOrigins, ['http://new.fangxiaobai.store:8050']);
  assert.equal(normalized.providers['custom-openai'].type, 'openai-compatible');
  assert.equal(normalized.providers['custom-openai'].apiKeyHeader, 'Authorization');

  const migrated = normalizeImageSettings({
    providerId: 'forge',
    providers: {
      openai: { type: 'openai', apiUrl: 'https://legacy.example.test/v1', model: 'legacy-model' },
      'openai-compatible': {
        type: 'openai-compatible', apiUrl: 'https://canonical.example.test/v1', model: 'canonical-model',
        apiKeyHeader: 'api-key'
      },
      forge: { type: 'forge', apiUrl: 'http://127.0.0.1:7861', sampler: 'DPM++' }
    }
  });
  assert.equal(migrated.providerId, 'a1111');
  assert.equal(migrated.providers.a1111.apiUrl, 'http://127.0.0.1:7861');
  assert.equal(migrated.providers.a1111.type, 'a1111');
  assert.equal(migrated.providers['openai-compatible'].apiUrl, 'https://canonical.example.test/v1');
  assert.equal(migrated.providers['openai-compatible'].model, 'canonical-model');
  assert.equal(migrated.providers['openai-compatible'].apiKeyHeader, 'api-key');
  assert.equal('openai' in migrated.providers, false);
  assert.equal('forge' in migrated.providers, false);

  const store = new ImageSettingsStore({ storage: null });
  assert.throws(() => store.save({
    ...normalized,
    providers: { broken: { type: 'unknown', apiUrl: 'https://example.test' } },
    providerId: 'broken'
  }), /unsupported type/);
});

await test('NovelAI settings preserve generation controls and normalize provider aliases', () => {
  const normalized = normalizeImageSettings({
    activeProviderId: 'nai',
    providers: {
      'novel-ai': {
        type: 'nai', apiUrl: 'https://image.novelai.net/ai/generate-image', apiKey: 'fixture-token',
        model: 'nai-diffusion-4-5-curated', sampler: 'k_dpmpp_2m', noiseSchedule: 'exponential',
        steps: 32, width: 1024, height: 1024, scale: 6, qualityToggle: false, cfgRescale: 0.25
      }
    }
  });

  assert.equal(normalized.providerId, 'novelai');
  assert.equal(normalized.providers.novelai.type, 'novelai');
  assert.equal(normalized.providers.novelai.model, 'nai-diffusion-4-5-curated');
  assert.equal(normalized.providers.novelai.noiseSchedule, 'exponential');
  assert.equal(normalized.providers.novelai.qualityToggle, false);
  assert.equal(normalized.providers.novelai.cfgRescale, 0.25);
  assert.equal(normalized.providers.novelai.apiKeyHeader, 'Authorization');
  assert.equal(
    normalizeImageApiBaseUrl(normalized.providers.novelai.apiUrl, 'novelai'),
    'https://image.novelai.net'
  );
});

await test('public probe and generate commands normalize legacy provider aliases', async () => {
  let probedProvider = null;
  let generatedProvider = null;
  const adapter = {
    async probe(provider) {
      probedProvider = clone(provider);
      return { status: 'ready' };
    },
    async generate({ provider }) {
      generatedProvider = clone(provider);
      return { images: [{ blob: pngBlob(512, 512), mimeType: 'image/png', width: 512, height: 512 }] };
    }
  };
  const studio = studioWithAdapter(adapter);
  const probe = await studio.execute({ type: 'probe', providerId: 'forge' });
  assert.equal(probe.status, 'ready');
  assert.equal(probedProvider.type, 'a1111');

  const created = await studio.execute({
    type: 'generate', providerId: 'automatic1111', mode: 'manual',
    target: { kind: 'turn', nodeId: 'node-provider-alias' }, prompt: '别名后端测试'
  });
  assert.equal(created.snapshot.providerId, 'a1111');
  await waitForJob(studio, created.jobId, job => job?.state === 'succeeded', 'provider alias generation');
  assert.equal(generatedProvider.type, 'a1111');
});

await test('allowlisted 192.168 image URL downloads directly with browser credentials omitted', async () => {
  const expected = pngBlob(320, 240);
  const calls = [];
  const transport = new ImageTransport({
    allowedPrivateOrigins: ['http://192.168.50.12:8188'],
    async fetchImpl(url, options) {
      calls.push({ url: String(url), options: clone(options) });
      return new Response(expected, { status: 200, headers: { 'Content-Type': 'image/png' } });
    }
  });
  const downloaded = await transport.downloadUrl(
    'http://192.168.50.12:8188/view?filename=naruto.png&type=output'
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://192.168.50.12:8188/view?filename=naruto.png&type=output');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.headers.Accept, 'image/*');
  assert.deepEqual(
    Buffer.from(await downloaded.arrayBuffer()),
    Buffer.from(await expected.arrayBuffer())
  );
});

await test('unapproved private-LAN image URL is rejected before any fetch is sent', async () => {
  let fetchCalls = 0;
  const transport = new ImageTransport({
    allowedPrivateOrigins: [],
    async fetchImpl() {
      fetchCalls++;
      throw new Error('fetch must not run');
    }
  });
  await assert.rejects(
    () => transport.downloadUrl('http://192.168.50.12:8188/view?filename=secret.png'),
    error => {
      assert.equal(error.code, 'PROVIDER_POLICY');
      assert.match(error.message, /192\.168\.50\.12:8188/);
      return true;
    }
  );
  assert.equal(fetchCalls, 0);
});

await test('public plain-HTTP image origin is rejected unless explicitly allowlisted', async () => {
  let fetchCalls = 0;
  const blocked = new ImageTransport({
    allowedPublicHttpOrigins: [],
    async fetchImpl() {
      fetchCalls++;
      throw new Error('fetch must not run');
    }
  });
  await assert.rejects(
    () => blocked.json(
      { type: 'openai-compatible', apiUrl: 'http://new.fangxiaobai.store:8050/v1' }, '/models'
    ),
    error => {
      assert.equal(error.code, 'PROVIDER_POLICY');
      assert.match(error.message, /HTTPS/);
      return true;
    }
  );
  assert.equal(fetchCalls, 0);

  let allowedCalls = 0;
  const allowed = new ImageTransport({
    allowedPublicHttpOrigins: ['http://new.fangxiaobai.store:8050'],
    async fetchImpl(url, init) {
      allowedCalls++;
      assert.equal(url, '/api/ai-proxy');
      assert.equal(init.headers['x-target-url'], 'http://new.fangxiaobai.store:8050/v1/models');
      assert.equal(init.headers['x-proxy-purpose'], 'models');
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });
  await allowed.json(
    { type: 'openai-compatible', apiUrl: 'http://new.fangxiaobai.store:8050/v1' }, '/models'
  );
  assert.equal(allowedCalls, 1);

  // 非同源 http 仍被拒绝（白名单只对该 origin 放行）
  let otherCalls = 0;
  const other = new ImageTransport({
    allowedPublicHttpOrigins: ['http://new.fangxiaobai.store:8050'],
    async fetchImpl() { otherCalls++; throw new Error('fetch must not run'); }
  });
  await assert.rejects(
    () => other.json(
      { type: 'openai-compatible', apiUrl: 'http://other.example.test:8050/v1' }, '/models'
    ),
    error => error.code === 'PROVIDER_POLICY'
  );
  assert.equal(otherCalls, 0);
});

await test('public HTTPS image origin bypasses the plain-HTTP allowlist', async () => {
  const transport = new ImageTransport({
    allowedPublicHttpOrigins: [],
    async fetchImpl() {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  });
  // HTTPS 公网地址不要求白名单
  await transport.json(
    { type: 'openai-compatible', apiUrl: 'https://new.fangxiaobai.store/v1' }, '/models'
  );
});

await test('default image transport invokes browser fetch with the global receiver', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = function browserFetch(url) {
    assert.equal(this, globalThis, 'native browser fetch must not receive the ImageTransport instance');
    fetchCalls++;
    return Promise.resolve(new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
  };

  try {
    const transport = new ImageTransport();
    await transport.json({
      type: 'openai-compatible',
      apiUrl: 'https://relay.example.test/v1'
    }, '/models');
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('image transport normalizes pasted endpoints and labels public proxy requests by purpose', async () => {
  const publicCalls = [];
  const publicTransport = new ImageTransport({
    async fetchImpl(url, options) {
      publicCalls.push({ url: String(url), options: clone(options) });
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });

  await publicTransport.json({
    type: 'openai-compatible',
    apiUrl: 'https://relay.example.test/v1/models?source=settings#models',
    apiKey: 'fixture-key'
  }, '/models');
  await publicTransport.json({
    type: 'openai-compatible',
    apiUrl: 'https://relay.example.test/v1/images/generations',
    apiKey: 'fixture-key'
  }, '/images/generations', { method: 'POST', body: { prompt: 'fixture' } });
  await publicTransport.json({
    type: 'openai-compatible',
    apiUrl: 'https://origin.example.test/responses?source=settings'
  }, '/models');

  assert.deepEqual(publicCalls.map(call => ({
    url: call.url,
    target: call.options.headers['x-target-url'],
    purpose: call.options.headers['x-proxy-purpose']
  })), [
    {
      url: '/api/ai-proxy',
      target: 'https://relay.example.test/v1/models?source=settings',
      purpose: 'models'
    },
    {
      url: '/api/ai-proxy',
      target: 'https://relay.example.test/v1/images/generations',
      purpose: 'image-generation'
    },
    {
      url: '/api/ai-proxy',
      target: 'https://origin.example.test/v1/models?source=settings',
      purpose: 'models'
    }
  ]);

  const localCalls = [];
  const localTransport = new ImageTransport({
    async fetchImpl(url) {
      localCalls.push(String(url));
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  });
  await localTransport.json({
    type: 'openai-compatible', apiUrl: '127.0.0.1:1234'
  }, '/models');
  await localTransport.json({
    type: 'a1111', apiUrl: 'localhost:7860'
  }, '/sdapi/v1/sd-models');

  assert.deepEqual(localCalls, [
    'http://127.0.0.1:1234/v1/models',
    'http://localhost:7860/sdapi/v1/sd-models'
  ]);
});

await test('OpenAI-compatible URL images reuse credentials only for the configured API origin', async () => {
  const calls = [];
  let returnedImageUrl = 'https://relay.example.test/generated/same-origin.png';
  const provider = {
    type: 'openai-compatible',
    apiUrl: 'https://relay.example.test/v1/images/generations?api-version=2025-04-01-preview',
    apiKey: 'fixture-secret',
    apiKeyHeader: 'api-key',
    model: 'fixture-image-model'
  };
  const transport = new ImageTransport({
    async fetchImpl(url, options) {
      calls.push({ url: String(url), options: clone(options) });
      const target = options.headers['x-target-url'];
      if (new URL(target).pathname.endsWith('/images/generations')) {
        return new Response(JSON.stringify({ data: [{ url: returnedImageUrl }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(pngBlob(64, 64), {
        status: 200,
        headers: { 'Content-Type': 'image/png' }
      });
    }
  });
  const adapter = new OpenAIImageAdapter(transport);

  await adapter.generate({ provider, prompt: 'same origin', parameters: {} });
  returnedImageUrl = 'https://cdn.example.test/generated/cross-origin.png';
  await adapter.generate({ provider, prompt: 'cross origin', parameters: {} });

  const generationCalls = calls.filter(call => new URL(call.options.headers['x-target-url']).pathname.endsWith('/images/generations'));
  assert.equal(generationCalls.length, 2);
  assert.equal(
    generationCalls[0].options.headers['x-target-url'],
    'https://relay.example.test/v1/images/generations?api-version=2025-04-01-preview'
  );

  const downloadCalls = calls.filter(call => call.options.headers['x-proxy-purpose'] === 'image-download');
  assert.equal(downloadCalls.length, 2);
  assert.equal(downloadCalls[0].options.headers['x-user-api-key'], 'fixture-secret');
  assert.equal(downloadCalls[0].options.headers['x-api-key-header'], 'api-key');
  assert.equal('x-user-api-key' in downloadCalls[1].options.headers, false);
  assert.equal('x-api-key-header' in downloadCalls[1].options.headers, false);
});

await test('OpenAI-compatible probe normalizes mixed model catalog shapes without auto-selecting a language model', async () => {
  async function probe(payload, model = '') {
    const transport = new ImageTransport({
      async fetchImpl() {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    });
    return new OpenAIImageAdapter(transport).probe({
      type: 'openai-compatible',
      apiUrl: 'https://relay.example.test/v1',
      model
    });
  }

  const dataShape = await probe({ data: [
    { id: 'gpt-4o' },
    { id: 'art-pro', type: 'image' },
    { name: 'dall-e-3' },
    { id: 'gpt-4o' }
  ] });
  assert.deepEqual(dataShape.models, ['art-pro', 'dall-e-3', 'gpt-4o']);
  assert.deepEqual(dataShape.imageModels, ['art-pro', 'dall-e-3']);
  assert.equal(dataShape.model, '');
  assert.equal(dataShape.recommendedModel, 'art-pro');

  const modelsShape = await probe({ models: [
    { name: 'imagen-3' }, 'claude-3.5-sonnet', { id: 'imagen-3' }
  ] }, 'imagen-3');
  assert.deepEqual(modelsShape.models, ['claude-3.5-sonnet', 'imagen-3']);
  assert.deepEqual(modelsShape.imageModels, ['imagen-3']);
  assert.equal(modelsShape.model, 'imagen-3');

  const customModel = await probe({ data: [{ id: 'gpt-4.1' }] }, 'my-private-image-model');
  assert.deepEqual(customModel.models, ['gpt-4.1', 'my-private-image-model']);
  assert.deepEqual(customModel.imageModels, ['my-private-image-model']);
  assert.equal(customModel.model, 'my-private-image-model');

  const arrayShape = await probe([
    'sdxl-turbo', { id: 'gpt-4.1' }, 'sdxl-turbo',
    { name: 'gemini-3-pro-image-preview' }, 'nano-banana-pro'
  ]);
  assert.deepEqual(arrayShape.models, [
    'gemini-3-pro-image-preview', 'gpt-4.1', 'nano-banana-pro', 'sdxl-turbo'
  ]);
  assert.deepEqual(arrayShape.imageModels, [
    'gemini-3-pro-image-preview', 'nano-banana-pro', 'sdxl-turbo'
  ]);
  assert.equal(arrayShape.model, '');

  const bounded = await probe([
    ...Array.from({ length: 5200 }, (_, index) => `model-${String(index).padStart(4, '0')}`),
    'x'.repeat(513)
  ]);
  assert.equal(bounded.models.length, 5000);
  assert.equal(bounded.models.some(model => model.length > 512), false);
});

await test('NovelAI probe checks connectivity without claiming token verification or spending credits', async () => {
  const transport = new RecordingTransport(async () => ({ tags: [] }));
  const registry = new ImageAdapterRegistry({ transport });
  const adapter = registry.get('nai');
  assert.ok(adapter instanceof NovelAIImageAdapter);
  assert.equal(registry.get('novel-ai'), adapter);

  await assert.rejects(
    () => adapter.probe({ apiUrl: 'https://image.novelai.net', apiKey: '' }),
    /Token/
  );
  const probe = await adapter.probe({
    apiUrl: 'https://image.novelai.net', apiKey: 'fixture-token', model: 'nai-diffusion-4-5-full'
  });
  assert.equal(probe.status, 'connected');
  assert.equal(probe.verified, false);
  assert.ok(probe.models.includes('nai-diffusion-4-5-full'));
  assert.ok(probe.models.includes('nai-diffusion-furry-3'));
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].kind, 'json');
  assert.match(transport.calls[0].path, /^\/ai\/generate-image\/suggest-tags\?/);
  assert.match(probe.message, /Token.*生成时验证/);
  const offline = new NovelAIImageAdapter(new RecordingTransport(async () => { throw new Error('offline'); }));
  await assert.rejects(() => offline.probe({ apiUrl: 'https://image.novelai.net', apiKey: 'fixture' }), /offline/);
});

await test('NovelAI artist prompt reaches both positive captions once and can be cleared', async () => {
  const archive = zipBlob([{ name: 'image.png', data: Buffer.from(await pngBlob().arrayBuffer()) }]);
  const transport = new RecordingTransport(async () => archive);
  const adapter = new NovelAIImageAdapter(transport);
  const artistPrompt = '  1.2::artist:fixture_a::,\n{artist:fixture_b}  ';
  const provider = { type: 'novelai', apiUrl: 'https://image.novelai.net', apiKey: 'fixture', artistPrompt };
  for (let i = 0; i < 2; i++) await adapter.generate({ provider, prompt: 'landscape,', negativePrompt: 'text' });
  for (const call of transport.calls) {
    assert.equal(call.options.body.input, 'landscape, 1.2::artist:fixture_a::,\n{artist:fixture_b}');
    assert.equal(call.options.body.parameters.v4_prompt.caption.base_caption, call.options.body.input);
    assert.equal(call.options.body.parameters.negative_prompt, 'text');
  }
  assert.equal(provider.artistPrompt, artistPrompt);
  await adapter.generate({ provider: { ...provider, artistPrompt: '' }, prompt: 'landscape' });
  assert.equal(transport.calls[2].options.body.input, 'landscape');
});

await test('NovelAI transport normalizes pasted tokens without changing other provider credentials', async () => {
  const calls = [];
  const transport = new ImageTransport({ async fetchImpl(url, options) {
    calls.push({ url, options });
    return new Response('{}');
  } });
  for (const apiUrl of ['https://image.novelai.net', 'http://127.0.0.1:8000']) {
    await transport.json({ type: 'novelai', apiUrl, apiKey: '  Bearer pst-fixture\\_token  ' }, '/ai/generate-image');
  }
  assert.equal(calls[0].options.headers['x-user-api-key'], 'pst-fixture_token');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer pst-fixture_token');
  await transport.json({ type: 'a1111', apiUrl: 'http://127.0.0.1:8000', apiKey: 'raw_fixture', apiKeyHeader: 'x-api-key' }, '/test');
  assert.equal(calls[2].options.headers['x-api-key'], 'raw_fixture');
});

await test('image errors retain actionable detail and distinguish proxy network failures', async () => {
  const provider = { type: 'novelai', apiUrl: 'https://image.novelai.net', apiKey: 'fixture' };
  const failure = (status, body) => new ImageTransport({ async fetchImpl() {
    return new Response(JSON.stringify(body), { status });
  } }).json(provider, '/test');
  await assert.rejects(() => failure(400, { error: 'Bad Request', message: ['unsupported sampler', 'invalid noise_schedule'] }), e =>
    e.code === 'PROVIDER_ERROR' && /unsupported sampler.*invalid noise_schedule/.test(e.message));
  await assert.rejects(() => failure(403, { error: '目标域名解析到受限地址' }), e => e.code === 'PROVIDER_POLICY');
  await assert.rejects(() => failure(401, { error: '登录会话已过期，请重新登录' }), e => e.code === 'SESSION_AUTH');
  await assert.rejects(() => failure(401, { message: 'Invalid access token' }), e => e.code === 'AUTH');
  await assert.rejects(() => failure(504, { error: 'AI 上游请求超时' }), e => e.code === 'UPSTREAM_TIMEOUT' && /服务器.*代理/.test(e.message));
  const offline = new ImageTransport({ async fetchImpl() { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(() => offline.json(provider, '/test'), e => e.code === 'PROXY_NETWORK' && /网站.*代理/.test(e.message));
});

await test('NovelAI adapter sends V4-compatible parameters and extracts a deflated ZIP image', async () => {
  const archive = zipBlob([{
    name: 'image_0.png', method: 8,
    data: Buffer.from(await pngBlob(832, 1216).arrayBuffer())
  }]);
  const transport = new RecordingTransport(async call => {
    assert.equal(call.kind, 'blob');
    assert.equal(call.path, '/ai/generate-image');
    assert.equal(call.options.accept, 'application/zip');
    return archive;
  });
  const adapter = new NovelAIImageAdapter(transport);
  const result = await adapter.generate({
    provider: {
      type: 'novelai', apiUrl: 'https://image.novelai.net', apiKey: 'fixture-token',
      model: 'nai-diffusion-4-5-full', sampler: 'k_euler_ancestral', noiseSchedule: 'karras',
      steps: 28, width: 832, height: 1216, scale: 5, qualityToggle: true, cfgRescale: 0
    },
    prompt: '1girl, pink hair, punching', negativePrompt: 'text, watermark',
    parameters: { seed: 123456, width: 832, height: 1216, steps: 30, scale: 6, cfgRescale: 0.2 }
  });

  const body = transport.calls[0].options.body;
  assert.equal(body.action, 'generate');
  assert.equal(body.input, '1girl, pink hair, punching');
  assert.equal(body.model, 'nai-diffusion-4-5-full');
  assert.equal(body.parameters.params_version, 3);
  assert.equal(body.parameters.negative_prompt, 'text, watermark');
  assert.equal(body.parameters.seed, 123456);
  assert.equal(body.parameters.width, 832);
  assert.equal(body.parameters.height, 1216);
  assert.equal(body.parameters.steps, 30);
  assert.equal(body.parameters.scale, 6);
  assert.equal(body.parameters.cfg_rescale, 0.2);
  assert.equal(body.parameters.qualityToggle, true);
  assert.equal(body.parameters.noise_schedule, 'karras');
  assert.equal(body.parameters.n_samples, 1);
  assert.equal(body.parameters.v4_prompt.caption.base_caption, body.input);
  assert.equal(body.parameters.v4_negative_prompt.caption.base_caption, 'text, watermark');
  assert.equal(result.images[0].width, 832);
  assert.equal(result.images[0].height, 1216);
  assert.equal(result.images[0].mimeType, 'image/png');
  assert.equal(result.metadata.seed, 123456);
});

await test('NovelAI public transport preserves ZIP accept headers and avoids duplicating a pasted endpoint', async () => {
  const archive = zipBlob([{
    name: 'image.png', method: 8,
    data: Buffer.from(await pngBlob(1024, 1024).arrayBuffer())
  }]);
  const calls = [];
  const transport = new ImageTransport({
    async fetchImpl(url, options) {
      calls.push({ url: String(url), options: clone(options) });
      return new Response(archive, { status: 200, headers: { 'Content-Type': 'application/zip' } });
    }
  });
  const adapter = new NovelAIImageAdapter(transport);
  const result = await adapter.generate({
    provider: {
      type: 'novelai', apiUrl: 'https://image.novelai.net/ai/generate-image',
      apiKey: 'fixture-token', apiKeyHeader: 'Authorization', model: 'nai-diffusion-4-5-full'
    },
    prompt: '1girl', parameters: { seed: 7, width: 1024, height: 1024 }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/ai-proxy');
  assert.equal(calls[0].options.headers.Accept, 'application/zip');
  assert.equal(calls[0].options.headers['x-target-url'], 'https://image.novelai.net/ai/generate-image');
  assert.equal(calls[0].options.headers['x-proxy-purpose'], 'image-generation');
  assert.equal(calls[0].options.headers['x-user-api-key'], 'fixture-token');
  assert.equal(JSON.parse(calls[0].options.body).parameters.seed, 7);
  assert.equal(result.images[0].width, 1024);
  assert.equal(result.images[0].height, 1024);
});

await test('NovelAI ZIP extraction accepts stored images and rejects unsafe or invalid archives', async () => {
  const source = Buffer.from(await pngBlob(512, 768).arrayBuffer());
  const extracted = await extractFirstImageFromZip(zipBlob([
    { name: 'metadata.json', data: Buffer.from('{}') },
    { name: 'nested/', data: Buffer.alloc(0) },
    { name: 'nested/image.png', data: source }
  ]));
  assert.equal(extracted.type, 'image/png');
  assert.deepEqual(Buffer.from(await extracted.arrayBuffer()), source);

  await assert.rejects(
    () => extractFirstImageFromZip(zipBlob([{ name: '../image.png', data: source }])),
    /路径|不安全/
  );
  await assert.rejects(
    () => extractFirstImageFromZip(zipBlob([{ name: 'metadata.json', data: Buffer.from('{}') }])),
    /图片/
  );
  await assert.rejects(
    () => extractFirstImageFromZip(zipBlob([{ name: 'image.png', data: source, crc: 0 }])),
    /校验|损坏/
  );
  await assert.rejects(
    () => extractFirstImageFromZip(zipBlob([{ name: 'image.png', data: source }]), { maxImageBytes: 16 }),
    /过大|限制/
  );
  await assert.rejects(
    () => extractFirstImageFromZip(new Blob([Buffer.from('not a zip')], { type: 'application/zip' })),
    /ZIP|压缩包/
  );
});

await test('OpenAI-compatible adapter retries a 400 without response_format and decodes image dimensions', async () => {
  const fixture = pngBlob(640, 480);
  const encoded = await blobBase64(fixture);
  let generationCalls = 0;
  const transport = new RecordingTransport(async call => {
    assert.equal(call.path, '/images/generations');
    generationCalls++;
    if (generationCalls === 1) {
      assert.equal(call.options.body.response_format, 'b64_json');
      const error = new Error('response_format unsupported');
      error.status = 400;
      throw error;
    }
    assert.equal('response_format' in call.options.body, false);
    return { data: [{ b64_json: encoded, revised_prompt: 'provider revision' }] };
  });
  const adapter = new OpenAIImageAdapter(transport);
  const result = await adapter.generate({
    provider: { apiUrl: 'https://images.example.test/v1', model: 'image-model', size: '1024x1024' },
    prompt: '鸣人在训练',
    negativePrompt: '水印',
    parameters: { size: '640x480', quality: 'high' }
  });

  assert.equal(generationCalls, 2);
  assert.match(transport.calls[0].options.body.prompt, /Avoid: 水印/);
  assert.equal(transport.calls[0].options.body.size, '640x480');
  assert.equal(result.images[0].width, 640);
  assert.equal(result.images[0].height, 480);
  assert.equal(result.images[0].mimeType, 'image/png');
  assert.equal(result.metadata.revisedPrompt, 'provider revision');
});

await test('A1111 and Forge adapter sends isolated txt2img settings and decodes its image', async () => {
  const encoded = await blobBase64(pngBlob(768, 1024));
  const transport = new RecordingTransport(async call => {
    assert.equal(call.path, '/sdapi/v1/txt2img');
    assert.equal(call.options.body.prompt, '佐助拔刀');
    assert.equal(call.options.body.negative_prompt, '多余手指');
    assert.equal(call.options.body.seed, 12345);
    assert.equal(call.options.body.override_settings.sd_model_checkpoint, 'anime-model');
    assert.equal(call.options.body.override_settings_restore_afterwards, true);
    return { images: [encoded], info: '{"seed":12345}' };
  });
  const adapter = new A1111ImageAdapter(transport);
  const result = await adapter.generate({
    provider: {
      apiUrl: 'http://127.0.0.1:7860', model: 'anime-model', sampler: 'Euler a',
      steps: 24, width: 512, height: 768, cfgScale: 7
    },
    prompt: '佐助拔刀', negativePrompt: '多余手指',
    parameters: { seed: 12345, sampler: 'DPM++ 2M', steps: 30, width: 768, height: 1024, cfgScale: 8 }
  });

  assert.equal(transport.calls[0].options.body.sampler_name, 'DPM++ 2M');
  assert.equal(transport.calls[0].options.body.steps, 30);
  assert.equal(result.images[0].width, 768);
  assert.equal(result.images[0].height, 1024);
  assert.equal(result.metadata.seed, 12345);
});

await test('ComfyUI adapter probes, patches, checkpoints, resumes, downloads, and cancels one job', async () => {
  const workflow = {
    1: { class_type: 'CLIPTextEncode', inputs: { text: '' } },
    2: { class_type: 'CLIPTextEncode', inputs: { text: '' } },
    3: { class_type: 'KSampler', inputs: { seed: 0 } },
    4: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
    5: { class_type: 'SaveImage', inputs: { filename_prefix: 'naruto' } }
  };
  const provider = {
    type: 'comfyui', apiUrl: 'http://127.0.0.1:8188', workflow,
    mapping: {
      positive: '1.text', negative: '2.inputs.text', seed: '3.seed',
      width: '4.width', height: '4.height', output: '5'
    }
  };
  let submittedWorkflow;
  let historyCalls = 0;
  const transport = new RecordingTransport(async call => {
    if (call.path === '/object_info') {
      return Object.fromEntries(Object.values(workflow).map(node => [node.class_type, {}]));
    }
    if (call.path === '/prompt') {
      submittedWorkflow = call.options.body.prompt;
      return { prompt_id: 'prompt-fixture' };
    }
    if (call.path === '/history/prompt-fixture') {
      historyCalls++;
      return {
        'prompt-fixture': {
          status: { completed: true },
          outputs: { 5: { images: [{ filename: 'result.png', subfolder: 'naruto', type: 'output' }] } }
        }
      };
    }
    if (call.kind === 'blob' && call.path.startsWith('/view?')) return pngBlob(832, 1216);
    if (call.path === '/queue') {
      assert.deepEqual(call.options.body, { delete: ['prompt-fixture'] });
      return {};
    }
    throw new Error(`unexpected ComfyUI call ${call.kind} ${call.path}`);
  });
  const adapter = new ComfyUIImageAdapter(transport);
  const probe = await adapter.probe(provider);
  assert.equal(probe.capabilities.resumable, true);
  assert.equal(probe.workflowNodes, 5);

  let checkpoint;
  const result = await adapter.generate({
    provider, prompt: '小樱挥拳', negativePrompt: '文字',
    parameters: { seed: 77, width: 832, height: 1216 },
    onCheckpoint(value) { checkpoint = value; }
  });
  assert.deepEqual(checkpoint, { promptId: 'prompt-fixture' });
  assert.equal(submittedWorkflow['1'].inputs.text, '小樱挥拳');
  assert.equal(submittedWorkflow['2'].inputs.text, '文字');
  assert.equal(submittedWorkflow['3'].inputs.seed, 77);
  assert.equal(submittedWorkflow['4'].inputs.width, 832);
  assert.equal(submittedWorkflow['4'].inputs.height, 1216);
  assert.equal(result.images[0].width, 832);
  assert.equal(result.images[0].height, 1216);
  assert.deepEqual(result.resumeToken, { promptId: 'prompt-fixture' });

  const promptCallsBeforeResume = transport.calls.filter(call => call.path === '/prompt').length;
  await adapter.generate({ provider, prompt: 'ignored during resume', resumeToken: { promptId: 'prompt-fixture' } });
  assert.equal(transport.calls.filter(call => call.path === '/prompt').length, promptCallsBeforeResume);
  assert.equal(historyCalls, 2);
  assert.equal(await adapter.cancel(provider, { promptId: 'prompt-fixture' }), true);
});

await test('memory queue claims manual work first and compare-and-swap rejects stale binding revisions', async () => {
  const store = new MemoryImageStore();
  const createdAt = '2026-01-01T00:00:00.000Z';
  await store.put('jobs', { id: 'auto-job', state: 'queued', priority: 10, createdAt, revision: 0 });
  await store.put('jobs', { id: 'manual-job', state: 'queued', priority: 100, createdAt, revision: 0 });

  const first = await store.claimNextJob('executor-a');
  const second = await store.claimNextJob('executor-b');
  assert.equal(first.id, 'manual-job');
  assert.equal(second.id, 'auto-job');
  assert.equal(first.state, 'planning');
  assert.equal(second.state, 'planning');

  const initial = await store.compareAndSwap('asset_cache', 'binding:turn:node-1', 0, {
    id: 'binding:turn:node-1', kind: 'binding', assetId: 'asset-first'
  });
  assert.equal(initial.ok, true);
  assert.equal(initial.current.revision, 1);
  const stale = await store.compareAndSwap('asset_cache', 'binding:turn:node-1', 0, {
    id: 'binding:turn:node-1', kind: 'binding', assetId: 'asset-stale'
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.current.assetId, 'asset-first');
  assert.equal((await store.get('asset_cache', 'binding:turn:node-1')).assetId, 'asset-first');
});

await test('ImageStudio auto generation is idempotent and an offline cloud keeps the local asset bindable', async () => {
  let generateCalls = 0;
  const adapter = {
    async generate() {
      generateCalls++;
      return { images: [{ blob: pngBlob(1024, 768), mimeType: 'image/png', width: 1024, height: 768 }] };
    }
  };
  const studio = studioWithAdapter(adapter);
  const target = { kind: 'turn', nodeId: 'node-auto-idempotent' };
  const first = await studio.execute({ type: 'generate', target, mode: 'automatic', prompt: '鸣人站在火影岩前' });
  const duplicate = await studio.execute({ type: 'generate', target, mode: 'auto', prompt: '不应生成第二次' });
  assert.equal(duplicate.reused, true);
  assert.equal(duplicate.jobId, first.jobId);

  const job = await waitForJob(studio, first.jobId, value => value?.state === 'succeeded', 'automatic generation');
  const result = await studio.read({ type: 'target', target });
  assert.equal(generateCalls, 1);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.assets.length, 1);
  assert.equal(result.assets[0].cloudState, 'upload-blocked');
  assert.equal(result.binding.assetId, result.assets[0].id);
  assert.equal(job.output.binding, 'selected');
  assert.ok(job.warnings.some(warning => warning.code === 'CLOUD_OFFLINE'));
  assert.ok((await studio.read({ type: 'asset-content', assetId: result.assets[0].id })) instanceof Blob);

  const metadataJson = JSON.stringify({ job, asset: result.assets[0], binding: result.binding });
  assert.doesNotMatch(metadataJson, /iVBOR|base64|data:image/i);
});

await test('a stale generation completes as a detached version and cannot overwrite the current selection', async () => {
  let generation = 0;
  const adapter = {
    async generate() {
      generation++;
      return {
        images: [{ blob: pngBlob(500 + generation, 700), mimeType: 'image/png', width: 500 + generation, height: 700 }]
      };
    }
  };
  const studio = studioWithAdapter(adapter);
  const target = { kind: 'portrait', subjectId: 'subject-cas' };
  const first = await studio.execute({
    type: 'generate', target, mode: 'manual', profile: { appearance: '黑色短发' }, bindingRevision: 0
  });
  await waitForJob(studio, first.jobId, value => value?.state === 'succeeded', 'first portrait');
  const selectedBefore = await studio.read({ type: 'target', target });
  assert.equal(selectedBefore.binding.revision, 1);

  const stale = await studio.execute({
    type: 'generate', target, mode: 'manual', reroll: true,
    profile: { appearance: '黑色短发' }, bindingRevision: 0
  });
  const staleJob = await waitForJob(studio, stale.jobId, value => value?.state === 'succeeded', 'stale portrait');
  const selectedAfter = await studio.read({ type: 'target', target });

  assert.equal(staleJob.output.binding, 'detached');
  assert.equal(selectedAfter.assets.length, 2);
  assert.equal(selectedAfter.binding.assetId, selectedBefore.binding.assetId);
  assert.equal(selectedAfter.binding.revision, 1);
  assert.notEqual(staleJob.output.assetId, selectedAfter.binding.assetId);
});

await test('active generation cancellation reaches a terminal state and retry creates a fresh successful job', async () => {
  let attempts = 0;
  const adapter = {
    async generate({ signal }) {
      attempts++;
      if (attempts > 1) {
        return { images: [{ blob: pngBlob(400, 400), mimeType: 'image/png', width: 400, height: 400 }] };
      }
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    }
  };
  const studio = studioWithAdapter(adapter);
  const target = { kind: 'turn', nodeId: 'node-cancel-retry' };
  const created = await studio.execute({ type: 'generate', target, mode: 'manual', prompt: '等待取消的画面' });
  await waitForJob(studio, created.jobId, value => value?.state === 'generating', 'generation start');
  await studio.execute({ type: 'cancel', jobId: created.jobId });
  const cancelled = await waitForJob(studio, created.jobId, value => value?.state === 'cancelled', 'generation cancellation');
  assert.equal(cancelled.error, null);

  const retried = await studio.execute({ type: 'retry', jobId: created.jobId });
  assert.notEqual(retried.jobId, created.jobId);
  const succeeded = await waitForJob(studio, retried.jobId, value => value?.state === 'succeeded', 'generation retry');
  assert.equal(succeeded.attempt, 1);
  assert.equal(attempts, 2);
});

await test('cancelling while cloud binding is in flight ends cancelled and safely detaches its output', async () => {
  const assetId = '70000000-0000-4000-8000-000000000001';
  let releaseSelection;
  let markSelectionStarted;
  const selectionStarted = new Promise(resolve => { markSelectionStarted = resolve; });
  const selectCalls = [];
  const cloud = {
    async upload({ metadata }) {
      return {
        asset: {
          id: assetId, metadata, contentUrl: `/api/image-assets/${assetId}/content`,
          thumbnailUrl: `/api/image-assets/${assetId}/thumbnail`
        }
      };
    },
    async select(target, selectedAssetId, expectedRevision) {
      selectCalls.push({ target: clone(target), assetId: selectedAssetId, expectedRevision });
      if (selectedAssetId) {
        markSelectionStarted();
        await new Promise(resolve => { releaseSelection = resolve; });
      }
      return { selection: { target, asset_id: selectedAssetId, revision: expectedRevision + 1 } };
    },
    async setActiveJobReference() {},
    async list() { return { items: [], selections: [], total: 0 }; },
    async resolve() { return { assets: [], missing: [] }; },
    async quota() { throw new Error('offline fixture'); },
    async protect() {}, async delete() {}, async content() { throw new Error('not needed'); }
  };
  const adapter = {
    async generate() {
      return { images: [{ blob: pngBlob(640, 480), mimeType: 'image/png', width: 640, height: 480 }] };
    }
  };
  const studio = studioWithAdapter(adapter, { cloudGallery: cloud });
  const target = { kind: 'turn', nodeId: 'node-cancel-during-binding' };
  const created = await studio.execute({ type: 'generate', target, mode: 'manual', prompt: '绑定取消测试' });
  await selectionStarted;
  const atBinding = await studio.read({ type: 'job', jobId: created.jobId });
  assert.equal(atBinding.state, 'binding');
  await studio.execute({ type: 'cancel', jobId: created.jobId });
  releaseSelection();

  const terminal = await waitForJob(
    studio, created.jobId,
    job => ['cancelled', 'succeeded', 'failed'].includes(job?.state),
    'binding cancellation'
  );
  assert.equal(terminal.state, 'cancelled');
  assert.equal(terminal.error, null);
  const binding = await studio.store.get('asset_cache', `binding:turn:${target.nodeId}`);
  assert.equal(binding?.assetId || null, null);
  assert.equal(selectCalls[0].assetId, assetId);
  assert.ok(selectCalls.some(call => call.assetId === null), 'cancelled binding should be detached in cloud selection');
});

await test('startup recovery resumes ComfyUI checkpoints and marks unknown non-resumable outcomes interrupted', async () => {
  const store = new MemoryImageStore();
  const common = {
    revision: 2,
    target: { kind: 'turn', nodeId: 'node-recovery' },
    targetKey: 'turn:node-recovery',
    providerId: 'openai',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z'
  };
  await store.put('jobs', { ...common, id: 'planning', state: 'planning', providerType: 'openai' });
  await store.put('jobs', { ...common, id: 'unknown', state: 'generating', providerType: 'openai' });
  await store.put('jobs', {
    ...common, id: 'comfy-resume', state: 'generating', providerId: 'comfyui', providerType: 'comfyui',
    resumeToken: { promptId: 'prompt-recoverable' }
  });
  const settingsStore = memorySettings({
    providers: {
      comfyui: {
        type: 'comfyui', apiUrl: 'http://127.0.0.1:8188', workflow: {}, mapping: {}
      }
    }
  });
  const studio = studioWithAdapter({ async generate() {} }, { store, settingsStore, autoStart: false });
  await studio.ready();

  assert.equal((await studio.read({ type: 'job', jobId: 'planning' })).state, 'queued');
  const unknown = await studio.read({ type: 'job', jobId: 'unknown' });
  assert.equal(unknown.state, 'interrupted');
  assert.equal(unknown.error.code, 'OUTCOME_UNKNOWN');
  assert.equal(unknown.error.outcomeKnown, false);
  const resumable = await studio.read({ type: 'job', jobId: 'comfy-resume' });
  assert.equal(resumable.state, 'queued');
  assert.equal(resumable.resumeOnly, true);
  assert.deepEqual(resumable.resumeToken, { promptId: 'prompt-recoverable' });
});

await test('target read hydrates cloud-only versions and the newer cross-device selection revision', async () => {
  const target = { kind: 'turn', nodeId: 'node-cross-device' };
  const assetId = '10000000-0000-4000-8000-000000000001';
  const cloudAsset = {
    id: assetId,
    mimeType: 'image/png', width: 1280, height: 720, sizeBytes: 1234,
    createdAt: '2026-02-01T00:00:00.000Z',
    contentUrl: `/api/image-assets/${assetId}/content`,
    thumbnailUrl: `/api/image-assets/${assetId}/thumbnail`,
    metadata: {
      purpose: 'turn-illustration', turn_node_id: target.nodeId,
      version_group_id: `turn:${target.nodeId}:versions`
    }
  };
  const listCalls = [];
  let online = true;
  const cloud = {
    async list(filters) {
      listCalls.push(clone(filters));
      if (!online) throw new Error('offline fixture');
      return {
        items: [cloudAsset], total: 1,
        selections: [{
          target, asset_id: assetId, revision: 4,
          updated_at: '2026-02-02T00:00:00.000Z'
        }]
      };
    },
    async resolve() { return { assets: [], missing: [] }; },
    async upload() { throw new Error('unexpected upload'); },
    async quota() { throw new Error('offline fixture'); },
    async select() {}, async protect() {}, async delete() {},
    async setActiveJobReference() {}, async content() { throw new Error('not needed'); }
  };
  const studio = studioWithAdapter({ async generate() {} }, { cloudGallery: cloud, autoStart: false });
  const bindingEvents = [];
  studio.subscribe(event => {
    if (event.type === 'binding.changed' || event.type === 'binding.detached') bindingEvents.push(event);
  });

  const hydrated = await studio.read({ type: 'target', target });
  assert.deepEqual(listCalls[0], { turnNodeId: target.nodeId, limit: 500 });
  assert.equal(hydrated.assets.length, 1);
  assert.equal(hydrated.assets[0].id, assetId);
  assert.deepEqual(hydrated.assets[0].target, target);
  assert.equal(hydrated.assets[0].targetKey, `turn:${target.nodeId}`);
  assert.equal(hydrated.assets[0].cloudAssetId, assetId);
  assert.equal(hydrated.binding.assetId, assetId);
  assert.equal(hydrated.binding.revision, 4);
  assert.equal(hydrated.binding.hydratedFromCloud, true);
  assert.equal(bindingEvents.length, 1);
  assert.equal(bindingEvents[0].authoritative, true);
  assert.equal(bindingEvents[0].source, 'cloud-hydration');
  assert.equal(bindingEvents[0].binding.assetId, assetId);

  online = false;
  const offlineAgain = await studio.read({ type: 'target', target });
  assert.equal(offlineAgain.assets[0].id, assetId);
  assert.equal(offlineAgain.binding.assetId, assetId);
  assert.equal(offlineAgain.binding.revision, 4);
  assert.equal(bindingEvents.length, 1, 'offline cache reads must not repeat authoritative events');
});

await test('pending cloud selections retry through reconcile and converge after connectivity returns', async () => {
  const target = { kind: 'turn', nodeId: 'node-selection-outbox' };
  const key = `turn:${target.nodeId}`;
  const assetId = '11000000-0000-4000-8000-000000000011';
  const store = new MemoryImageStore();
  await store.put('asset_cache', {
    id: assetId, kind: 'asset', target, targetKey: key,
    cloudAssetId: assetId, cloudState: 'synced', createdAt: '2026-02-03T00:00:00.000Z',
    metadata: { purpose: 'turn-illustration', turn_node_id: target.nodeId }
  });
  await store.put('asset_cache', {
    id: `binding:${key}`, kind: 'binding', target, targetKey: key,
    assetId, revision: 1, versionGroupId: `${key}:versions`,
    cloudSelectionState: 'pending', cloudSelectionError: 'offline'
  });
  let online = false;
  const reconcileCalls = [];
  const cloud = {
    async reconcileSelections(items) {
      reconcileCalls.push(clone(items));
      if (!online) throw new Error('offline fixture');
      return { applied: [{ target, asset_id: assetId, revision: 1 }], conflicts: [], missing: [] };
    },
    async list() {
      if (!online) throw new Error('offline fixture');
      return {
        items: [{
          id: assetId, createdAt: '2026-02-03T00:00:00.000Z',
          metadata: { purpose: 'turn-illustration', turn_node_id: target.nodeId }
        }],
        total: 1,
        selections: [{ target, asset_id: assetId, revision: 1 }]
      };
    },
    async resolve() { return { assets: [], missing: [] }; },
    async upload() { throw new Error('unexpected upload'); },
    async quota() { throw new Error('not needed'); },
    async select() {}, async protect() {}, async delete() {},
    async setActiveJobReference() {}, async content() { throw new Error('not needed'); }
  };
  const studio = studioWithAdapter({ async generate() {} }, { store, cloudGallery: cloud, autoStart: false });

  const offline = await studio.read({ type: 'target', target });
  assert.equal(offline.binding.cloudSelectionState, 'pending');
  assert.equal(reconcileCalls.length, 1);

  online = true;
  const recovered = await studio.read({ type: 'target', target });
  assert.equal(reconcileCalls.length, 2);
  assert.deepEqual(reconcileCalls[1], [{ target, assetId, expectedRevision: 0 }]);
  assert.equal(recovered.binding.assetId, assetId);
  assert.equal(recovered.binding.revision, 1);
  assert.equal(recovered.binding.cloudSelectionState, 'synced');
  assert.equal(recovered.binding.cloudSelectionError, null);
});

await test('a delayed cloud selection result cannot overwrite a newer local binding', async () => {
  const target = { kind: 'portrait', subjectId: 'subject-delayed-selection' };
  const key = `portrait:${target.subjectId}`;
  const firstId = '12000000-0000-4000-8000-000000000012';
  const secondId = '12000000-0000-4000-8000-000000000013';
  const store = new MemoryImageStore();
  for (const assetId of [firstId, secondId]) {
    await store.put('asset_cache', {
      id: assetId, kind: 'asset', target, targetKey: key,
      cloudAssetId: assetId, cloudState: 'synced', createdAt: new Date().toISOString(),
      metadata: { purpose: 'portrait', subject_id: target.subjectId }
    });
  }
  let releaseFirst;
  let firstStartedResolve;
  const firstStarted = new Promise(resolve => { firstStartedResolve = resolve; });
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const cloud = {
    async select(_target, assetId) {
      if (assetId === firstId) {
        firstStartedResolve();
        await firstGate;
      }
      return { selection: { target, asset_id: assetId } };
    },
    async list() { return { items: [], selections: [], total: 0 }; },
    async resolve() { return { assets: [], missing: [] }; },
    async upload() { throw new Error('unexpected upload'); },
    async quota() { throw new Error('not needed'); },
    async protect() {}, async delete() {}, async setActiveJobReference() {},
    async content() { throw new Error('not needed'); }
  };
  const studio = studioWithAdapter({ async generate() {} }, { store, cloudGallery: cloud, autoStart: false });

  const first = studio.execute({ type: 'select', target, assetId: firstId, expectedRevision: 0 });
  await firstStarted;
  const second = await studio.execute({ type: 'select', target, assetId: secondId, expectedRevision: 1 });
  releaseFirst();
  const delayed = await first;

  assert.equal(second.status, 'updated');
  assert.equal(delayed.status, 'stale');
  const binding = await store.get('asset_cache', `binding:${key}`);
  assert.equal(binding.assetId, secondId);
  assert.equal(binding.revision, 2);
  assert.equal(binding.cloudSelectionState, 'synced');
});

await test('cloud-only asset can be selected lazily while an asset owned by another target is rejected', async () => {
  const owner = { kind: 'portrait', subjectId: 'subject-cloud-owner' };
  const other = { kind: 'portrait', subjectId: 'subject-cloud-other' };
  const assetId = '20000000-0000-4000-8000-000000000002';
  const resolveCalls = [];
  const selectCalls = [];
  const cloud = {
    async resolve(ids) {
      resolveCalls.push([...ids]);
      return {
        assets: [{
          id: assetId, mimeType: 'image/png', createdAt: '2026-03-01T00:00:00.000Z',
          metadata: {
            purpose: 'portrait', subject_id: owner.subjectId,
            version_group_id: `portrait:${owner.subjectId}:versions`
          }
        }],
        missing: []
      };
    },
    async select(target, selectedAssetId, expectedRevision) {
      selectCalls.push({ target: clone(target), assetId: selectedAssetId, expectedRevision });
      return { selection: { target, asset_id: selectedAssetId, revision: expectedRevision + 1 } };
    },
    async list() { return { items: [], selections: [], total: 0 }; },
    async upload() { throw new Error('unexpected upload'); },
    async quota() { throw new Error('offline fixture'); },
    async protect() {}, async delete() {}, async setActiveJobReference() {},
    async content() { throw new Error('not needed'); }
  };
  const studio = studioWithAdapter({ async generate() {} }, { cloudGallery: cloud, autoStart: false });

  const selected = await studio.execute({
    type: 'select', target: owner, assetId, expectedRevision: 0
  });
  assert.equal(selected.status, 'updated');
  assert.deepEqual(resolveCalls, [[assetId]]);
  assert.deepEqual(selectCalls, [{ target: owner, assetId, expectedRevision: 0 }]);
  assert.equal((await studio.store.get('asset_cache', `binding:portrait:${owner.subjectId}`)).assetId, assetId);

  await assert.rejects(
    () => studio.execute({ type: 'select', target: other, assetId, expectedRevision: 0 }),
    /不属于此目标/
  );
  assert.equal(selectCalls.length, 1, 'wrong-target selection must not reach the cloud API');
});

await test('gallery maps legacy UI filter names to canonical cloud and local metadata fields', async () => {
  const store = new MemoryImageStore();
  await store.put('asset_cache', {
    id: 'local-turn-filter', kind: 'asset', target: { kind: 'turn', nodeId: 'node-filter' },
    targetKey: 'turn:node-filter', createdAt: '2026-04-01T00:00:00.000Z',
    metadata: { campaign_id: 'campaign-filter', turn_node_id: 'node-filter', purpose: 'turn-illustration' }
  });
  await store.put('asset_cache', {
    id: 'local-portrait-filter', kind: 'asset', target: { kind: 'portrait', subjectId: 'subject-filter' },
    targetKey: 'portrait:subject-filter', createdAt: '2026-04-02T00:00:00.000Z',
    metadata: { campaign_id: 'campaign-filter', subject_id: 'subject-filter', purpose: 'portrait' }
  });
  const listCalls = [];
  const cloud = {
    async list(filters) { listCalls.push(clone(filters)); return { items: [], selections: [], total: 0 }; },
    async resolve() { return { assets: [], missing: [] }; },
    async upload() { throw new Error('unexpected upload'); },
    async quota() { throw new Error('offline fixture'); },
    async select() {}, async protect() {}, async delete() {},
    async setActiveJobReference() {}, async content() { throw new Error('not needed'); }
  };
  const studio = studioWithAdapter({ async generate() {} }, {
    store, cloudGallery: cloud, autoStart: false
  });

  const campaign = await studio.read({ type: 'gallery', filters: { campaign: 'campaign-filter' } });
  const turn = await studio.read({ type: 'gallery', filters: { turn: 'node-filter' } });
  const portrait = await studio.read({ type: 'gallery', filters: { character: 'subject-filter' } });
  assert.deepEqual(campaign.items.map(asset => asset.id).sort(), ['local-portrait-filter', 'local-turn-filter']);
  assert.deepEqual(turn.items.map(asset => asset.id), ['local-turn-filter']);
  assert.deepEqual(portrait.items.map(asset => asset.id), ['local-portrait-filter']);
  assert.equal(listCalls[0].campaignId, 'campaign-filter');
  assert.equal(listCalls[1].turnNodeId, 'node-filter');
  assert.equal(listCalls[2].subjectId, 'subject-filter');
});

await test('equal-revision cloud conflict converges a failed optimistic binding to the server selection', async () => {
  const target = { kind: 'turn', nodeId: 'node-equal-revision-conflict' };
  const key = `turn:${target.nodeId}`;
  const serverAssetId = '30000000-0000-4000-8000-000000000003';
  const optimisticAssetId = '30000000-0000-4000-8000-000000000004';
  const store = new MemoryImageStore();
  await store.put('asset_cache', {
    id: `binding:${key}`, kind: 'binding', target, targetKey: key,
    assetId: '30000000-0000-4000-8000-000000000000', revision: 4,
    versionGroupId: `${key}:versions`, cloudSelectionState: 'synced'
  });
  await store.put('asset_cache', {
    id: optimisticAssetId, kind: 'asset', target, targetKey: key,
    cloudAssetId: optimisticAssetId, cloudState: 'synced',
    versionGroupId: `${key}:versions`, createdAt: '2026-05-01T00:00:00.000Z',
    metadata: { purpose: 'turn-illustration', turn_node_id: target.nodeId }
  });
  const cloudAssets = [serverAssetId, optimisticAssetId].map((id, index) => ({
    id, mimeType: 'image/png', createdAt: `2026-05-0${index + 1}T00:00:00.000Z`,
    metadata: {
      purpose: 'turn-illustration', turn_node_id: target.nodeId,
      version_group_id: `${key}:versions`
    }
  }));
  let selectCalls = 0;
  const cloud = {
    async select() {
      selectCalls++;
      const error = new Error('selection changed on another device');
      error.status = 409;
      error.code = 'SELECTION_CONFLICT';
      throw error;
    },
    async list() {
      return {
        items: cloudAssets, total: cloudAssets.length,
        selections: [{
          target, asset_id: serverAssetId, revision: 5,
          updated_at: '2026-05-03T00:00:00.000Z'
        }]
      };
    },
    async resolve() { return { assets: [], missing: [] }; },
    async upload() { throw new Error('unexpected upload'); },
    async quota() { throw new Error('offline fixture'); },
    async protect() {}, async delete() {}, async setActiveJobReference() {},
    async content() { throw new Error('not needed'); }
  };
  const studio = studioWithAdapter({ async generate() {} }, {
    store, cloudGallery: cloud, autoStart: false
  });

  const optimistic = await studio.execute({
    type: 'select', target, assetId: optimisticAssetId, expectedRevision: 4
  });
  assert.equal(selectCalls, 1);
  assert.equal(optimistic.binding.assetId, optimisticAssetId);
  assert.equal(optimistic.binding.revision, 5);
  assert.equal(optimistic.binding.cloudSelectionState, 'conflict');

  const converged = await studio.read({ type: 'target', target });
  assert.equal(converged.binding.assetId, serverAssetId);
  assert.equal(converged.binding.revision, 5);
  assert.equal(converged.binding.cloudSelectionState, 'synced');
  assert.equal(converged.binding.cloudSelectionError, null);
  assert.equal(converged.binding.hydratedFromCloud, true);
});

await test('gallery preserves the cloud total when the fetched page contains fewer items', async () => {
  const target = { kind: 'portrait', subjectId: 'subject-gallery-total' };
  const items = [
    '40000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000002'
  ].map((id, index) => ({
    id, mimeType: 'image/png', createdAt: `2026-06-0${index + 1}T00:00:00.000Z`,
    metadata: { purpose: 'portrait', subject_id: target.subjectId }
  }));
  const listCalls = [];
  const cloud = {
    async list(filters) { listCalls.push(clone(filters)); return { items, selections: [], total: 100 }; },
    async resolve() { return { assets: [], missing: [] }; },
    async upload() { throw new Error('unexpected upload'); },
    async quota() { throw new Error('offline fixture'); },
    async select() {}, async protect() {}, async delete() {},
    async setActiveJobReference() {}, async content() { throw new Error('not needed'); }
  };
  const studio = studioWithAdapter({ async generate() {} }, { cloudGallery: cloud, autoStart: false });
  const gallery = await studio.read({
    type: 'gallery', filters: { subjectId: target.subjectId }, offset: 0, limit: 2
  });
  assert.equal(gallery.items.length, 2);
  assert.equal(gallery.total, 100);
  assert.equal(listCalls[0].limit, 2);
});

await test('exhaustive target cloud refresh prunes remotely deleted synced cache but keeps local upload-blocked data', async () => {
  const target = { kind: 'portrait', subjectId: 'subject-prune' };
  const key = `portrait:${target.subjectId}`;
  const staleId = '50000000-0000-4000-8000-000000000001';
  const retainedCloudId = '50000000-0000-4000-8000-000000000002';
  const localOnlyId = 'local-upload-blocked-prune-fixture';
  const store = new MemoryImageStore();
  await store.put('asset_cache', {
    id: staleId, kind: 'asset', target, targetKey: key,
    cloudAssetId: staleId, cloudState: 'synced', createdAt: '2026-07-01T00:00:00.000Z',
    metadata: { purpose: 'portrait', subject_id: target.subjectId }
  });
  await store.put('blobs', { id: staleId, blob: pngBlob(10, 10) });
  await store.put('asset_cache', {
    id: localOnlyId, kind: 'asset', target, targetKey: key,
    cloudAssetId: null, cloudState: 'upload-blocked', createdAt: '2026-07-02T00:00:00.000Z',
    metadata: { purpose: 'portrait', subject_id: target.subjectId }
  });
  await store.put('blobs', { id: localOnlyId, blob: pngBlob(11, 11) });
  const cloud = {
    async list() {
      return {
        items: [{
          id: retainedCloudId, mimeType: 'image/png', createdAt: '2026-07-03T00:00:00.000Z',
          metadata: { purpose: 'portrait', subject_id: target.subjectId }
        }],
        selections: [], total: 1
      };
    },
    async resolve() { return { assets: [], missing: [] }; },
    async upload() { throw new Error('unexpected upload'); },
    async quota() { throw new Error('offline fixture'); },
    async select() {}, async protect() {}, async delete() {},
    async setActiveJobReference() {}, async content() { throw new Error('not needed'); }
  };
  const studio = studioWithAdapter({ async generate() {} }, {
    store, cloudGallery: cloud, autoStart: false
  });

  const refreshed = await studio.read({ type: 'target', target });
  assert.deepEqual(
    refreshed.assets.map(asset => asset.id).sort(),
    [localOnlyId, retainedCloudId].sort()
  );
  assert.equal(await store.get('asset_cache', staleId), undefined);
  assert.equal(await store.get('blobs', staleId), undefined);
  assert.ok((await store.get('asset_cache', localOnlyId))?.cloudState === 'upload-blocked');
  assert.ok((await store.get('blobs', localOnlyId))?.blob instanceof Blob);
});

if (failures.length) {
  console.error(`\n${failures.length} of ${passed + failures.length} image studio regression tests failed.`);
  for (const failure of failures) console.error(`- ${failure.message}`);
  process.exitCode = 1;
} else {
  console.log(`\n${passed} image studio regression tests passed.`);
}
