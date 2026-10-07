import { encryptApiKey, decryptApiKey } from '../utils/api-crypto.js';

/**
 * API 方案存储：一组可命名的「主 AI 连接」预设（地址/密钥/模型/后端/流式开关）。
 * 与主配置一致，apiKey 使用 AES-GCM 加密后落库；密钥派生自固定种子，跨会话可解密。
 */

const SCHEMES_KEY = 'naruto_api_schemes';
const ACTIVE_KEY = 'naruto_api_active_scheme';

function readRaw(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeRaw(key, value) {
  try {
    globalThis.localStorage?.setItem(key, value);
    return true;
  } catch (error) {
    console.warn('[ApiSchemes] 持久化失败，本次会话仍可用:', error?.message || error);
    return false;
  }
}

function readSchemes() {
  const raw = readRaw(SCHEMES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.warn('[ApiSchemes] 方案数据损坏，忽略');
    return [];
  }
}

function writeSchemes(schemes) {
  writeRaw(SCHEMES_KEY, JSON.stringify(schemes));
}

function generateSchemeId() {
  const suffix = globalThis.crypto?.randomUUID?.()
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `scheme-${suffix}`;
}

/**
 * 列出方案摘要（不含明文 apiKey）。
 * @returns {Promise<Array<{id:string,name:string,backend:string,apiUrl:string,model:string,disableStreaming:boolean,hasKey:boolean}>>}
 */
export async function listApiSchemes() {
  return readSchemes().map(({ id, name, backend, apiUrl, model, disableStreaming, apiKey }) => ({
    id: String(id || ''),
    name: String(name || '未命名方案'),
    backend: String(backend || 'openai'),
    apiUrl: String(apiUrl || ''),
    model: String(model || ''),
    disableStreaming: Boolean(disableStreaming),
    hasKey: Boolean(apiKey)
  }));
}

/** 取完整方案（apiKey 已解密）；不存在返回 null。 */
export async function getApiScheme(id) {
  const scheme = readSchemes().find(item => item.id === id);
  if (!scheme) return null;
  const copy = { ...scheme };
  if (copy.apiKey) copy.apiKey = await decryptApiKey(copy.apiKey);
  return copy;
}

/**
 * 新建或更新方案。
 * @param {{id?:string,name:string,apiUrl:string,apiKey?:string,model:string,backend:string,disableStreaming?:boolean}} input
 * @returns {Promise<string|null>} 方案 id；未知 id 更新返回 null。
 */
export async function saveApiScheme({ id, name, apiUrl, apiKey, model, backend, disableStreaming, adaptationMode, deepseekThinking } = {}) {
  const createdAt = Date.now();
  const encryptedKey = apiKey !== undefined ? await encryptApiKey(apiKey) : undefined;
  // Keep the storage read/write section synchronous so a completed delete cannot
  // be overwritten by a save that was still waiting for key encryption.
  const schemes = readSchemes();

  if (id) {
    const index = schemes.findIndex(item => item.id === id);
    if (index === -1) return null;
    const existing = schemes[index];
    schemes[index] = {
      ...existing,
      name: String(name ?? existing.name ?? '未命名方案'),
      apiUrl: String(apiUrl ?? existing.apiUrl ?? ''),
      model: String(model ?? existing.model ?? ''),
      backend: String(backend ?? existing.backend ?? 'openai'),
      disableStreaming: Boolean(disableStreaming ?? existing.disableStreaming),
      adaptationMode: adaptationMode ?? existing.adaptationMode ?? 'standard',
      deepseekThinking: deepseekThinking ?? existing.deepseekThinking ?? 'disabled',
      apiKey: encryptedKey !== undefined ? encryptedKey : existing.apiKey
    };
    writeSchemes(schemes);
    return id;
  }

  const scheme = {
    id: generateSchemeId(),
    name: String(name || '未命名方案'),
    apiUrl: String(apiUrl || ''),
    model: String(model || ''),
    backend: String(backend || 'openai'),
    disableStreaming: Boolean(disableStreaming),
    adaptationMode: adaptationMode || 'standard',
    deepseekThinking: deepseekThinking || 'disabled',
    apiKey: encryptedKey || '',
    createdAt
  };
  schemes.push(scheme);
  writeSchemes(schemes);
  return scheme.id;
}

/** 删除方案；若删除的是活动方案则清空活动标记。 */
export async function deleteApiScheme(id) {
  const schemes = readSchemes();
  const next = schemes.filter(item => item.id !== id);
  if (next.length === schemes.length) return false;
  writeSchemes(next);
  if (getActiveApiSchemeId() === id) setActiveApiScheme(null);
  return true;
}

/** 设置活动方案；传 null/undefined 清除标记。 */
export function setActiveApiScheme(id) {
  writeRaw(ACTIVE_KEY, id || '');
}

/** 当前活动方案 id；无则返回 null。 */
export function getActiveApiSchemeId() {
  const raw = readRaw(ACTIVE_KEY);
  return raw ? raw : null;
}
