import { aiClient, normalizeApiBaseUrl } from '../core/ai-client.js';
import {
  getActiveApiSchemeId,
  getApiScheme,
  listApiSchemes
} from '../core/api-schemes.js';

const DEFAULT_API_URLS = Object.freeze({
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  claude: 'https://api.anthropic.com/v1'
});

function bridgeError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function backendDetails(value) {
  const backend = String(value || 'openai').trim().toLowerCase();
  if (backend === 'tavern') {
    throw bridgeError(
      'MULTIPLAYER_API_SCHEME_UNSUPPORTED',
      '酒馆方案不能用于服务端联机模型，请选择公网 HTTPS API 方案'
    );
  }
  if (backend === 'claude' || backend === 'anthropic') {
    return Object.freeze({
      backend,
      clientBackend: 'claude',
      adapter: 'anthropic',
      authenticatedScheme: 'x-api-key'
    });
  }
  return Object.freeze({
    backend,
    clientBackend: backend === 'deepseek' ? 'deepseek' : (backend === 'openai' ? 'openai' : 'custom'),
    adapter: 'openai_compatible',
    authenticatedScheme: 'bearer'
  });
}

/**
 * Converts a browser-side main-panel API scheme into the exact editable fields
 * used to create a server-side multiplayer credential and endpoint profile.
 * The server remains authoritative and repeats URL/origin validation on save.
 */
export function normalizeMainPanelApiScheme(scheme) {
  if (!scheme || typeof scheme !== 'object' || Array.isArray(scheme)) {
    throw bridgeError('MULTIPLAYER_API_SCHEME_INVALID', '主面板 API 方案无效');
  }
  const details = backendDetails(scheme.backend);
  const rawApiUrl = String(scheme.apiUrl || '').trim()
    || DEFAULT_API_URLS[details.clientBackend]
    || '';
  const baseUrl = normalizeApiBaseUrl(rawApiUrl, details.clientBackend);
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw bridgeError('MULTIPLAYER_API_SCHEME_URL_INVALID', '所选方案没有有效的 API 地址');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw bridgeError(
      'MULTIPLAYER_API_SCHEME_URL_FORBIDDEN',
      '联机模型只接受不含账号信息的公网 HTTPS API 地址'
    );
  }

  const apiKey = typeof scheme.apiKey === 'string' ? scheme.apiKey : '';
  return Object.freeze({
    id: String(scheme.id || ''),
    name: String(scheme.name || '未命名方案'),
    backend: details.backend,
    clientBackend: details.clientBackend,
    adapter: details.adapter,
    baseUrl,
    endpointOrigin: parsed.origin,
    apiKey,
    model: String(scheme.model || '').trim(),
    authScheme: apiKey ? details.authenticatedScheme : 'none'
  });
}

/** Lists safe summaries only; plaintext keys remain encrypted until explicit load. */
export async function listMainPanelApiSchemes() {
  const schemes = await listApiSchemes();
  return Object.freeze({
    activeId: getActiveApiSchemeId(),
    schemes: Object.freeze(schemes.map(scheme => Object.freeze({ ...scheme })))
  });
}

/** Decrypts one explicitly selected scheme for immediate form use only. */
export async function loadMainPanelApiScheme(id) {
  const schemeId = String(id || '').trim();
  if (!schemeId) {
    throw bridgeError('MULTIPLAYER_API_SCHEME_REQUIRED', '请先选择主面板中已保存的 API 方案');
  }
  const scheme = await getApiScheme(schemeId);
  if (!scheme) {
    throw bridgeError('MULTIPLAYER_API_SCHEME_NOT_FOUND', '所选 API 方案已不存在，请刷新列表');
  }
  return normalizeMainPanelApiScheme(scheme);
}

/**
 * Uses the existing same-origin AI proxy to discover model IDs without sending
 * any Room, action, memory, or other player data to the provider.
 */
export async function discoverMainPanelApiSchemeModels(scheme, { client = aiClient } = {}) {
  if (!client || typeof client.listModels !== 'function') {
    throw bridgeError('MULTIPLAYER_MODEL_DISCOVERY_INVALID', '模型列表客户端不可用');
  }
  const connection = normalizeMainPanelApiScheme(scheme);
  const discovered = await client.listModels({
    apiUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    backend: connection.clientBackend,
    model: connection.model
  });
  const unique = [];
  const seen = new Set();
  for (const value of [connection.model, ...(Array.isArray(discovered) ? discovered : [])]) {
    const model = String(value || '').trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    unique.push(model);
  }
  return Object.freeze(unique);
}

export async function loadMainPanelApiSchemeModels(id, options) {
  const schemeId = String(id || '').trim();
  if (!schemeId) {
    throw bridgeError('MULTIPLAYER_API_SCHEME_REQUIRED', '请先选择一个主面板 API 方案');
  }
  const scheme = await getApiScheme(schemeId);
  if (!scheme) {
    throw bridgeError('MULTIPLAYER_API_SCHEME_NOT_FOUND', '所选 API 方案已不存在，请刷新列表');
  }
  return discoverMainPanelApiSchemeModels(scheme, options);
}
