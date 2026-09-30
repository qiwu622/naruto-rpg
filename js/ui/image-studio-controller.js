import { NOVELAI_IMAGE_MODELS, NOVELAI_PROVIDER_DEFAULTS } from '../core/image-studio/settings.js';

export { NOVELAI_IMAGE_MODELS };

const PROVIDER_ALIASES = Object.freeze({
  openai: 'openai-compatible',
  openai_compatible: 'openai-compatible',
  'openai-compatible': 'openai-compatible',
  novelai: 'novelai',
  'novel-ai': 'novelai',
  nai: 'novelai',
  comfy: 'comfyui',
  comfyui: 'comfyui',
  automatic1111: 'a1111',
  forge: 'a1111',
  a1111: 'a1111'
});

export const IMAGE_PROVIDER_IDS = Object.freeze(['openai-compatible', 'novelai', 'comfyui', 'a1111']);

export const DEFAULT_IMAGE_SETTINGS = Object.freeze({
  enabled: false,
  turnMode: 'manual',
  promptMode: 'main-contract',
  activeProviderId: 'openai-compatible',
  autoEviction: false,
  separatePromptModel: {
    apiUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.25
  },
  providers: {
    'openai-compatible': {
      label: 'OpenAI 兼容图像接口',
      apiUrl: 'https://api.openai.com/v1',
      apiKey: '',
      apiKeyHeader: 'Authorization',
      model: 'gpt-image-1',
      size: '1024x1024'
    },
    novelai: {
      label: 'NovelAI Diffusion',
      ...NOVELAI_PROVIDER_DEFAULTS
    },
    comfyui: {
      label: '本地 ComfyUI',
      apiUrl: 'http://127.0.0.1:8188',
      workflow: '',
      mapping: {
        positive: '', negative: '', seed: '', width: '', height: '', output: '', reference: ''
      }
    },
    a1111: {
      label: '本地 A1111 / Forge',
      apiUrl: 'http://127.0.0.1:7860',
      model: '',
      sampler: 'DPM++ 2M Karras',
      steps: 28,
      width: 768,
      height: 1024
    }
  }
});

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch (_) { /* JSON fallback */ }
  }
  return JSON.parse(JSON.stringify(value));
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function mergeObject(base, value) {
  const next = { ...asObject(base), ...asObject(value) };
  for (const key of Object.keys(next)) {
    if (asObject(base)[key] && asObject(value)[key]
      && typeof base[key] === 'object' && typeof value[key] === 'object'
      && !Array.isArray(base[key]) && !Array.isArray(value[key])) {
      next[key] = mergeObject(base[key], value[key]);
    }
  }
  return next;
}

const IMAGE_MODEL_NAME_HINT = /(?:^|[-_.\/])(gpt[-_.]?image|dall[-_.]?e|flux|sdxl|stable[-_.]?diffusion|imagen(?:[-_.]|$)|ideogram|recraft|qwen[-_.]?image|seedream|kolors|playground|kandinsky)(?:[-_.\/]|$)/i;
const API_KEY_HEADERS = Object.freeze(['Authorization', 'x-api-key', 'api-key']);
const MAX_MODEL_ID_LENGTH = 512;
const MAX_MODEL_CATALOG_SIZE = 5000;

function modelId(value) {
  const id = typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : (!value || typeof value !== 'object'
        ? ''
        : String(value.id ?? value.name ?? value.model ?? '').trim());
  return id.length <= MAX_MODEL_ID_LENGTH ? id : '';
}

function uniqueModelIds(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const id = modelId(value);
    const key = id.toLocaleLowerCase();
    if (!id || seen.has(key)) continue;
    seen.add(key);
    result.push(id);
    if (result.length >= MAX_MODEL_CATALOG_SIZE) break;
  }
  return result;
}

export function normalizeImageModelCatalog(value = {}, currentModel = '') {
  const source = asObject(value.result || value);
  const discovered = uniqueModelIds(source.models || source.data || []);
  const hinted = uniqueModelIds(source.imageModels || source.image_models || []);
  const imageModels = hinted.length
    ? hinted
    : discovered.filter(id => IMAGE_MODEL_NAME_HINT.test(id));
  const models = uniqueModelIds([...discovered, ...imageModels, currentModel]);
  return { models, imageModels: imageModels.filter(id => models.includes(id)) };
}

export function deriveImageApiKeyHeader(value = {}) {
  const config = asObject(value);
  const explicit = String(config.apiKeyHeader || config.keyHeader || '').trim();
  const allowed = API_KEY_HEADERS.find(header => header.toLowerCase() === explicit.toLowerCase());
  if (allowed) return allowed;
  const backend = String(config.backend || '').trim().toLowerCase();
  return backend === 'claude' || backend === 'anthropic' ? 'x-api-key' : 'Authorization';
}

export function reusableMainApiConfig(value = {}) {
  const config = asObject(value);
  return {
    apiUrl: String(config.apiUrl || '').trim(),
    apiKey: String(config.apiKey || ''),
    apiKeyHeader: deriveImageApiKeyHeader(config)
  };
}

export function applyMainApiConfigToImageProvider(provider = {}, mainConfig = {}) {
  return { ...asObject(provider), ...reusableMainApiConfig(mainConfig) };
}

function id(prefix = 'image') {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeProviderId(value) {
  return PROVIDER_ALIASES[String(value || '').trim().toLowerCase()] || 'openai-compatible';
}

export function normalizeImageSettings(value = {}) {
  const input = asObject(value.settings || value);
  const merged = mergeObject(DEFAULT_IMAGE_SETTINGS, input);
  merged.enabled = Boolean(input.enabled ?? merged.enabled);
  merged.turnMode = input.turnMode === 'automatic' || input.turnMode === 'auto' ? 'automatic' : 'manual';
  merged.promptMode = input.promptMode === 'separate-model' || input.promptMode === 'separate'
    ? 'separate-model'
    : 'main-contract';
  merged.separatePromptModel = mergeObject(
    DEFAULT_IMAGE_SETTINGS.separatePromptModel,
    input.separatePromptModel
  );
  merged.activeProviderId = normalizeProviderId(input.activeProviderId || input.providerId);
  delete merged.providerId;
  merged.autoEviction = Boolean(input.autoEviction);
  const inputProviders = asObject(input.providers);
  merged.providers = {
    'openai-compatible': mergeObject(
      DEFAULT_IMAGE_SETTINGS.providers['openai-compatible'],
      mergeObject(mergeObject(inputProviders.openai, inputProviders.openai_compatible), inputProviders['openai-compatible'])
    ),
    novelai: mergeObject(
      DEFAULT_IMAGE_SETTINGS.providers.novelai,
      mergeObject(mergeObject(inputProviders.nai, inputProviders['novel-ai']), inputProviders.novelai)
    ),
    comfyui: mergeObject(
      DEFAULT_IMAGE_SETTINGS.providers.comfyui,
      mergeObject(inputProviders.comfy, inputProviders.comfyui)
    ),
    a1111: mergeObject(
      DEFAULT_IMAGE_SETTINGS.providers.a1111,
      mergeObject(mergeObject(inputProviders.automatic1111, inputProviders.forge), inputProviders.a1111)
    )
  };
  merged.providers['openai-compatible'].apiKeyHeader = deriveImageApiKeyHeader(
    merged.providers['openai-compatible']
  );
  merged.providers.novelai.artistPrompt = typeof merged.providers.novelai.artistPrompt === 'string'
    ? merged.providers.novelai.artistPrompt : '';
  return merged;
}

function normalizeKeywords(value) {
  if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean);
  return String(value || '').split(/[,，\n]/).map(item => item.trim()).filter(Boolean);
}

function normalizeEntryPrompts(entry) {
  const prompt = String(entry.prompt ?? entry.content ?? entry.text ?? '');
  const explicitNegative = String(entry.negativePrompt ?? entry.negative_prompt ?? '');
  if (explicitNegative) return { prompt, negativePrompt: explicitNegative };
  const marker = /(?:^|\n)\s*Negative prompt:\s*/i.exec(prompt);
  if (!marker) return { prompt, negativePrompt: '' };
  return {
    prompt: prompt.slice(0, marker.index).trimEnd(),
    negativePrompt: prompt.slice(marker.index + marker[0].length).trim()
  };
}

export function normalizeImageWorldbookEntry(value = {}, fallbackId = '') {
  const entry = asObject(value);
  const keys = entry.key ?? entry.keys ?? entry.keywords ?? entry.triggers ?? [];
  const secondaryKeys = entry.keysecondary ?? entry.secondaryKeys ?? entry.secondaryKeywords ?? [];
  const prompts = normalizeEntryPrompts(entry);
  return {
    id: String(entry.id ?? entry.uid ?? fallbackId ?? id('iwb')) || id('iwb'),
    name: String(entry.name ?? entry.comment ?? entry.title ?? '').trim(),
    keywords: normalizeKeywords(keys),
    secondaryKeywords: normalizeKeywords(secondaryKeys),
    prompt: prompts.prompt,
    negativePrompt: prompts.negativePrompt,
    priority: Number.isFinite(Number(entry.priority ?? entry.order)) ? Number(entry.priority ?? entry.order) : 100,
    enabled: entry.enabled !== false && entry.disable !== true,
    constant: Boolean(entry.constant)
  };
}

function entriesFromLayer(value) {
  if (Array.isArray(value)) return value.map((entry, index) => normalizeImageWorldbookEntry(entry, `iwb-${index}`));
  const source = asObject(value);
  if (Array.isArray(source.entries)) return entriesFromLayer(source.entries);
  return Object.entries(asObject(source.entries || source)).map(([entryId, entry]) => (
    normalizeImageWorldbookEntry(entry, entryId)
  ));
}

export function normalizeImageWorldbook(value = {}, { importScope = 'global' } = {}) {
  const source = asObject(value.worldbook || value);
  // The runtime's native single-layer format also uses this schema name with
  // an `entries` field. Only treat documents with explicit layer keys as the
  // UI's global/save-overlay container, otherwise import the entries into the
  // layer selected by the caller.
  if (Object.prototype.hasOwnProperty.call(source, 'global')
    || Object.prototype.hasOwnProperty.call(source, 'overlay')
    || Object.prototype.hasOwnProperty.call(source, 'save')) {
    return {
      schema: 'naruto.image-worldbook/v1',
      global: entriesFromLayer(source.global || []),
      overlay: entriesFromLayer(source.overlay || source.save || [])
    };
  }

  // SillyTavern lorebooks store entries as an object indexed by uid.
  const imported = Array.isArray(value)
    ? entriesFromLayer(value)
    : entriesFromLayer(source.entries || source);
  return {
    schema: 'naruto.image-worldbook/v1',
    global: importScope === 'global' ? imported : [],
    overlay: importScope === 'overlay' ? imported : []
  };
}

function entryIdentity(entry) {
  if (entry.id) return `id:${entry.id}`;
  return `name:${entry.name.toLowerCase()}|${entry.keywords.join('|').toLowerCase()}`;
}

function mergeEntries(current, incoming, replace) {
  if (replace) return incoming.map(entry => ({ ...entry }));
  const result = current.map(entry => ({ ...entry }));
  const positions = new Map(result.map((entry, index) => [entryIdentity(entry), index]));
  for (const entry of incoming) {
    const key = entryIdentity(entry);
    if (positions.has(key)) result[positions.get(key)] = { ...result[positions.get(key)], ...entry };
    else {
      positions.set(key, result.length);
      result.push({ ...entry });
    }
  }
  return result;
}

export function mergeImageWorldbooks(current, incoming, { scope = null, replace = false } = {}) {
  const base = normalizeImageWorldbook(current);
  const added = normalizeImageWorldbook(incoming, { importScope: scope || 'global' });
  const next = clone(base);
  if (scope) {
    // Import buttons have an explicit destination layer. Funnel both layers
    // from a layered native file into that destination so importing a global
    // export into a save overlay never appears to succeed while adding zero
    // entries. Overlay entries come last and therefore retain precedence.
    next[scope] = mergeEntries(base[scope], [...added.global, ...added.overlay], replace);
  } else {
    for (const key of ['global', 'overlay']) next[key] = mergeEntries(base[key], added[key], replace);
  }
  return next;
}

export function toSillyTavernImageWorldbook(value, { scope = 'all' } = {}) {
  const worldbook = normalizeImageWorldbook(value);
  const selected = scope === 'all' ? [...worldbook.global, ...worldbook.overlay] : worldbook[scope] || [];
  return {
    entries: Object.fromEntries(selected.map((entry, index) => [String(index), {
      uid: index,
      key: entry.keywords,
      keysecondary: entry.secondaryKeywords || [],
      comment: entry.name,
      content: entry.negativePrompt
        ? `${entry.prompt}\n\nNegative prompt: ${entry.negativePrompt}`
        : entry.prompt,
      constant: entry.constant,
      selective: entry.keywords.length > 0,
      order: entry.priority,
      position: 0,
      disable: !entry.enabled
    }]))
  };
}

export function normalizeTargetState(value = {}) {
  const source = asObject(value.result || value);
  const binding = source.binding || null;
  const assets = Array.isArray(source.assets) ? source.assets
    : Array.isArray(source.items) ? source.items
      : binding?.asset ? [binding.asset] : [];
  const jobs = Array.isArray(source.jobs) ? source.jobs : source.job ? [source.job] : [];
  return { binding, assets, jobs };
}

export function normalizeGalleryResult(value = {}) {
  if (Array.isArray(value)) return { items: value, total: value.length };
  const source = asObject(value.result || value);
  const items = Array.isArray(source.items) ? source.items : Array.isArray(source.assets) ? source.assets : [];
  return { ...source, items, total: Number(source.total ?? items.length) };
}

export function normalizeQuota(value = {}) {
  const source = asObject(value.result || value);
  return {
    usedBytes: Math.max(0, Number(source.usedBytes ?? source.bytesUsed ?? 0) || 0),
    limitBytes: Math.max(0, Number(source.limitBytes ?? source.maxBytes ?? 1024 ** 3) || 0),
    assetCount: Math.max(0, Number(source.assetCount ?? source.count ?? 0) || 0),
    assetLimit: Math.max(0, Number(source.assetLimit ?? source.maxAssets ?? 500) || 0)
  };
}

export function formatImageBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let index = -1;
  do { amount /= 1024; index += 1; } while (amount >= 1024 && index < units.length - 1);
  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${units[index]}`;
}

export function targetsEqual(left, right) {
  if (!left || !right || left.kind !== right.kind) return false;
  return left.kind === 'turn'
    ? String(left.nodeId) === String(right.nodeId)
    : String(left.subjectId) === String(right.subjectId);
}

export function eventTouchesImageTarget(event, target) {
  if (!event || !target) return false;
  return [event.target, event.job?.target, event.binding?.target, event.asset?.target]
    .some(candidate => targetsEqual(candidate, target));
}

export class ImageStudioUIController {
  constructor(imageStudio = null, overrides = {}) {
    this.imageStudio = imageStudio;
    this.overrides = overrides || {};
  }

  get available() {
    return Boolean(this.imageStudio
      && typeof this.imageStudio.execute === 'function'
      && typeof this.imageStudio.read === 'function');
  }

  async read(query) {
    if (!this.available) throw new Error('文生图服务尚未初始化');
    return this.imageStudio.read(query);
  }

  async execute(command) {
    if (!this.available) throw new Error('文生图服务尚未初始化');
    return this.imageStudio.execute(command);
  }

  subscribe(listener) {
    if (!this.imageStudio || typeof this.imageStudio.subscribe !== 'function') return () => {};
    const unsubscribe = this.imageStudio.subscribe(listener);
    return typeof unsubscribe === 'function' ? unsubscribe : () => {};
  }

  async settings() {
    if (typeof this.overrides.readSettings === 'function') {
      return normalizeImageSettings(await this.overrides.readSettings(this.imageStudio));
    }
    return normalizeImageSettings(await this.read({ type: 'settings' }));
  }

  async saveSettings(settings) {
    const normalized = normalizeImageSettings(settings);
    if (typeof this.overrides.saveSettings === 'function') {
      return this.overrides.saveSettings(normalized, this.imageStudio);
    }
    return this.execute({ type: 'configure', settings: normalized });
  }

  async probeProvider(providerId, config) {
    if (typeof this.overrides.probeProvider === 'function') {
      return this.overrides.probeProvider(providerId, config, this.imageStudio);
    }
    return this.execute({ type: 'probe', providerId: normalizeProviderId(providerId), config });
  }

  async mainApiConfig() {
    let config;
    if (typeof this.overrides.readMainApiConfig === 'function') {
      config = await this.overrides.readMainApiConfig(this.imageStudio);
    } else {
      const manager = this.overrides.stateManager
        || (await import('../core/state-manager.js')).stateManager;
      config = typeof manager?.getAPIConfigAsync === 'function'
        ? await manager.getAPIConfigAsync()
        : manager?.getAPIConfig?.();
    }
    return reusableMainApiConfig(config);
  }

  async worldbook() {
    if (typeof this.overrides.readWorldbook === 'function') {
      return normalizeImageWorldbook(await this.overrides.readWorldbook(this.imageStudio));
    }
    return normalizeImageWorldbook(await this.read({ type: 'worldbook' }));
  }

  async saveWorldbook(worldbook) {
    const normalized = normalizeImageWorldbook(worldbook);
    if (typeof this.overrides.saveWorldbook === 'function') {
      return this.overrides.saveWorldbook(normalized, this.imageStudio);
    }
    return this.execute({ type: 'worldbook:update', worldbook: normalized });
  }

  async quota() {
    if (typeof this.overrides.readQuota === 'function') {
      return normalizeQuota(await this.overrides.readQuota(this.imageStudio));
    }
    return normalizeQuota(await this.read({ type: 'quota' }));
  }

  async target(target) {
    if (typeof this.overrides.readTarget === 'function') {
      return normalizeTargetState(await this.overrides.readTarget(target, this.imageStudio));
    }
    return normalizeTargetState(await this.read({ type: 'target', target }));
  }

  async gallery(filters = {}, offset = 0, limit = 40) {
    if (typeof this.overrides.readGallery === 'function') {
      return normalizeGalleryResult(await this.overrides.readGallery({ filters, offset, limit }, this.imageStudio));
    }
    return normalizeGalleryResult(await this.read({ type: 'gallery', filters, offset, limit }));
  }

  async assetUrl(asset, variant = 'thumbnail') {
    if (!asset) return null;
    if (typeof this.overrides.assetUrl === 'function') {
      return this.overrides.assetUrl(asset, variant, this.imageStudio);
    }
    const urlKeys = variant === 'content'
      ? ['contentUrl', 'url', 'originalUrl', 'objectUrl']
      : ['thumbnailUrl', 'previewUrl', 'url', 'objectUrl', 'contentUrl'];
    for (const key of urlKeys) if (typeof asset[key] === 'string' && asset[key]) return asset[key];
    const blob = variant === 'content' ? (asset.blob || asset.contentBlob) : (asset.thumbnailBlob || asset.blob);
    if (typeof Blob !== 'undefined' && blob instanceof Blob && globalThis.URL?.createObjectURL) {
      return URL.createObjectURL(blob);
    }
    try {
      const result = await this.read({ type: 'asset-content', assetId: asset.id, variant });
      if (typeof result === 'string') return result;
      if (typeof Blob !== 'undefined' && result instanceof Blob && globalThis.URL?.createObjectURL) {
        return URL.createObjectURL(result);
      }
      if (result?.url) return result.url;
      if (typeof Blob !== 'undefined' && result?.blob instanceof Blob && globalThis.URL?.createObjectURL) {
        return URL.createObjectURL(result.blob);
      }
    } catch (_) {
      // A cloud asset can still be rendered through the authenticated content endpoint.
    }
    if (!asset.id) return null;
    const suffix = variant === 'content' ? 'content' : 'thumbnail';
    return `/api/image-assets/${encodeURIComponent(asset.id)}/${suffix}`;
  }
}

export function createImageStudioUIController(imageStudio, overrides) {
  return imageStudio instanceof ImageStudioUIController
    ? imageStudio
    : new ImageStudioUIController(imageStudio, overrides);
}

export default createImageStudioUIController;
