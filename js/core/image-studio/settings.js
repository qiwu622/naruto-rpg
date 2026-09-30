export const IMAGE_SETTINGS_STORAGE_KEY = 'naruto_rpg_image_settings_v1';

export const NOVELAI_IMAGE_MODELS = Object.freeze([
  Object.freeze({ id: 'nai-diffusion-4-5-full', label: 'NAI Diffusion Anime V4.5 (Full)' }),
  Object.freeze({ id: 'nai-diffusion-4-5-curated', label: 'NAI Diffusion Anime V4.5 (Curated)' }),
  Object.freeze({ id: 'nai-diffusion-4-full', label: 'NAI Diffusion Anime V4 (Full)' }),
  Object.freeze({ id: 'nai-diffusion-4-curated-preview', label: 'NAI Diffusion Anime V4 (Curated)' }),
  Object.freeze({ id: 'nai-diffusion-3', label: 'NAI Diffusion Anime V3' }),
  Object.freeze({ id: 'nai-diffusion-furry-3', label: 'NAI Diffusion Furry V3' })
]);

// NovelAI 生成参数默认值的唯一事实来源；核心 settings 与 UI controller 共用，避免两份漂移。
export const NOVELAI_PROVIDER_DEFAULTS = Object.freeze({
  apiUrl: 'https://image.novelai.net',
  apiKey: '',
  apiKeyHeader: 'Authorization',
  model: NOVELAI_IMAGE_MODELS[0].id,
  artistPrompt: '',
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  steps: 28,
  width: 832,
  height: 1216,
  scale: 5,
  qualityToggle: true,
  cfgRescale: 0
});

export const DEFAULT_IMAGE_SETTINGS = Object.freeze({
  version: 1,
  enabled: false,
  turnMode: 'manual',
  promptMode: 'main-contract',
  providerId: 'openai-compatible',
  concurrency: 1,
  autoEviction: false,
  allowedPrivateOrigins: [],
  allowedPublicHttpOrigins: [],
  providers: {
    'openai-compatible': {
      type: 'openai-compatible',
      apiUrl: 'https://api.openai.com/v1',
      apiKey: '',
      apiKeyHeader: 'Authorization',
      model: 'gpt-image-1',
      size: '1024x1024',
      quality: 'auto'
    },
    novelai: {
      type: 'novelai',
      ...NOVELAI_PROVIDER_DEFAULTS
    },
    comfyui: {
      type: 'comfyui',
      apiUrl: 'http://127.0.0.1:8188',
      workflow: null,
      mapping: {},
      pollIntervalMs: 1000,
      timeoutMs: 300000
    },
    a1111: {
      type: 'a1111',
      apiUrl: 'http://127.0.0.1:7860',
      model: '',
      sampler: 'Euler a',
      steps: 24,
      width: 768,
      height: 1024,
      cfgScale: 7
    }
  },
  separatePromptModel: null
});

const TURN_MODES = new Set(['manual', 'auto']);
const PROMPT_MODES = new Set(['main-contract', 'separate-model']);
const API_KEY_HEADERS = new Set(['authorization', 'x-api-key', 'api-key']);
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

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function copyDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_IMAGE_SETTINGS));
}

export function normalizeImageProviderId(value, fallback = 'openai-compatible') {
  const id = String(value || '').trim().toLowerCase();
  return PROVIDER_ALIASES[id] || id || fallback;
}

export function normalizeImageSettings(input = {}) {
  const source = object(input);
  const defaults = copyDefaults();
  const providers = object(source.providers);
  const normalized = {
    ...defaults,
    ...source,
    version: 1,
    enabled: source.enabled === true,
    turnMode: source.turnMode === 'automatic' ? 'auto'
      : (TURN_MODES.has(source.turnMode) ? source.turnMode : defaults.turnMode),
    promptMode: PROMPT_MODES.has(source.promptMode) ? source.promptMode : defaults.promptMode,
    // Public/UI settings can carry the previous runtime `providerId` beside a
    // newly selected `activeProviderId`; the explicit UI field must win.
    providerId: normalizeImageProviderId(source.activeProviderId || source.providerId || defaults.providerId),
    concurrency: Math.max(1, Math.min(4, Math.trunc(Number(source.concurrency) || 1))),
    autoEviction: source.autoEviction === true,
    allowedPrivateOrigins: [...new Set((Array.isArray(source.allowedPrivateOrigins)
      ? source.allowedPrivateOrigins : []).map(value => {
        try { return new URL(String(value)).origin; } catch { return ''; }
      }).filter(Boolean))],
    // 公网明文 HTTP 白名单：允许显式声明的公网地址走 http://（与 AI 代理的
    // AI_PROXY_ALLOW_HTTP_TARGETS 服务端白名单对应，需在两端同时放行）。
    allowedPublicHttpOrigins: [...new Set((Array.isArray(source.allowedPublicHttpOrigins)
      ? source.allowedPublicHttpOrigins : []).map(value => {
        try { return new URL(String(value)).origin; } catch { return ''; }
      }).filter(Boolean))],
    providers: {}
  };
  for (const [id, config] of Object.entries(defaults.providers)) {
    normalized.providers[id] = { ...object(config) };
  }
  // Alias profiles are applied first; an explicitly canonical profile wins
  // when both old and new keys are present during migration.
  const providerEntries = Object.entries(providers).sort(([left], [right]) => {
    const leftCanonical = normalizeImageProviderId(left) === left.toLowerCase();
    const rightCanonical = normalizeImageProviderId(right) === right.toLowerCase();
    return Number(leftCanonical) - Number(rightCanonical);
  });
  for (const [rawId, config] of providerEntries) {
    const id = normalizeImageProviderId(rawId);
    const previous = object(normalized.providers[id]);
    normalized.providers[id] = {
      ...previous,
      ...object(config),
      type: normalizeImageProviderId(config?.type || previous.type || id, id)
    };
  }
  for (const provider of Object.values(normalized.providers)) {
    if (provider.type === 'novelai') {
      provider.apiKeyHeader = 'Authorization';
      provider.artistPrompt = typeof provider.artistPrompt === 'string' ? provider.artistPrompt : '';
      continue;
    }
    if (!['openai', 'openai-compatible'].includes(provider.type)) continue;
    const header = String(provider.apiKeyHeader || 'Authorization').trim();
    provider.apiKeyHeader = API_KEY_HEADERS.has(header.toLowerCase())
      ? (header.toLowerCase() === 'authorization' ? 'Authorization' : header.toLowerCase())
      : 'Authorization';
  }
  normalized.separatePromptModel = source.separatePromptModel
    ? { ...object(source.separatePromptModel) }
    : null;
  return normalized;
}

export function validateImageSettings(input) {
  const settings = normalizeImageSettings(input);
  const errors = [];
  if (!settings.providers[settings.providerId]) {
    errors.push(`Unknown image provider: ${settings.providerId}`);
  }
  for (const [id, provider] of Object.entries(settings.providers)) {
    if (!provider.apiUrl) errors.push(`Provider ${id} requires apiUrl`);
    if (!['openai', 'openai-compatible', 'novelai', 'comfyui', 'a1111', 'forge'].includes(provider.type)) {
      errors.push(`Provider ${id} has unsupported type: ${provider.type}`);
    }
  }
  return { valid: errors.length === 0, errors, value: settings };
}

export class ImageSettingsStore {
  constructor({ storage = globalThis.localStorage, key = IMAGE_SETTINGS_STORAGE_KEY } = {}) {
    this.storage = storage;
    this.key = key;
    this.memoryValue = null;
  }

  load() {
    let parsed = this.memoryValue;
    try {
      const raw = this.storage?.getItem(this.key);
      if (raw) parsed = JSON.parse(raw);
    } catch { /* localStorage can be blocked in private/sandboxed contexts */ }
    return normalizeImageSettings(parsed || {});
  }

  save(value) {
    const result = validateImageSettings(value);
    if (!result.valid) throw new TypeError(result.errors.join('; '));
    this.memoryValue = result.value;
    try { this.storage?.setItem(this.key, JSON.stringify(result.value)); } catch { /* memory fallback */ }
    return result.value;
  }

  update(patch) {
    return this.save({ ...this.load(), ...object(patch) });
  }
}
