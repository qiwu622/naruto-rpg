import { ImageAdapterRegistry, nowSeed } from './adapters.js';
import { CloudImageGalleryClient } from './cloud-gallery.js';
import { contractToPrompt } from './contracts.js';
import { ImageSettingsStore, normalizeImageProviderId, validateImageSettings } from './settings.js';
import { createImageStore } from './storage.js';
import { ImageWorldbookStore, mergeImageWorldbooks, renderImageWorldbookPrompts } from './worldbook.js';
import { decryptApiKey, encryptApiKey } from '../../utils/api-crypto.js';
import { stateManager } from '../state-manager.js';
import { usesProjectServerFeatures } from '../runtime-platform.js';

const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'blocked']);
const ACTIVE_STATES = new Set(['queued', 'planning', 'generating', 'staging', 'uploading', 'binding']);

function id(prefix) {
  return globalThis.crypto?.randomUUID
    ? `${prefix}-${globalThis.crypto.randomUUID()}`
    : `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function assetUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, char => {
    const value = Math.floor(Math.random() * 16);
    return (char === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
}

export function imageTargetKey(target) {
  if (target?.kind === 'turn' && target.nodeId) return `turn:${target.nodeId}`;
  if (target?.kind === 'portrait' && target.subjectId) return `portrait:${target.subjectId}`;
  throw new TypeError('图片目标必须是 turn/nodeId 或 portrait/subjectId');
}

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function warnListenerFailure(error) {
  console.warn('[ImageStudio] listener failed:', error);
}

function toPublicSettings(settings) {
  const providers = { ...settings.providers };
  if (!providers['openai-compatible'] && providers.openai) providers['openai-compatible'] = { ...providers.openai };
  return {
    ...settings,
    turnMode: settings.turnMode === 'auto' ? 'automatic' : 'manual',
    activeProviderId: settings.providerId === 'openai' ? 'openai-compatible'
      : (settings.providerId === 'forge' || settings.providerId === 'automatic1111' ? 'a1111' : settings.providerId),
    providers
  };
}

function fromUiWorldbook(value = {}) {
  if (!value.global && !value.overlay) return value;
  const convert = entry => ({
    id: entry.id, name: entry.name, keys: entry.keywords || entry.keys || [], enabled: entry.enabled,
    secondaryKeys: entry.secondaryKeywords || entry.secondaryKeys || [],
    constant: entry.constant, priority: entry.priority,
    content: entry.prompt || entry.content || '',
    negativePrompt: entry.negativePrompt || entry.negative_prompt || ''
  });
  const globalBook = { entries: (value.global || []).map(convert) };
  const overlayBook = { entries: (value.overlay || []).map(convert) };
  return mergeImageWorldbooks(globalBook, overlayBook);
}

function uiEntries(value = {}) {
  return (value.entries || []).map(entry => ({
    id: entry.id, name: entry.name, keywords: entry.keys || [], enabled: entry.enabled,
    secondaryKeywords: entry.secondaryKeys || [], constant: entry.constant, priority: entry.priority,
    prompt: entry.content || '', negativePrompt: entry.negativePrompt || ''
  }));
}

function toUiWorldbook(globalBook = {}, overlayBook = {}) {
  return { schema: 'naruto.image-worldbook/v1', global: uiEntries(globalBook), overlay: uiEntries(overlayBook) };
}

function assetMatches(asset, filters = {}) {
  const metadata = asset.metadata || {};
  if (filters.campaignId && metadata.campaign_id !== filters.campaignId) return false;
  if (filters.turnNodeId && metadata.turn_node_id !== filters.turnNodeId && asset.target?.nodeId !== filters.turnNodeId) return false;
  if (filters.subjectId && metadata.subject_id !== filters.subjectId && asset.target?.subjectId !== filters.subjectId) return false;
  if (filters.purpose && metadata.purpose !== filters.purpose && asset.purpose !== filters.purpose) return false;
  return true;
}

function targetsEqual(left, right) {
  if (!left || !right || left.kind !== right.kind) return false;
  return left.kind === 'turn'
    ? String(left.nodeId) === String(right.nodeId)
    : String(left.subjectId) === String(right.subjectId);
}

function targetFromAsset(asset) {
  if (asset?.target?.kind === 'turn' && asset.target.nodeId) return clone(asset.target);
  if (asset?.target?.kind === 'portrait' && asset.target.subjectId) return clone(asset.target);
  const metadata = asset?.metadata || {};
  if (metadata.turn_node_id || metadata.node_id) {
    return { kind: 'turn', nodeId: String(metadata.turn_node_id || metadata.node_id) };
  }
  if (metadata.subject_id) return { kind: 'portrait', subjectId: String(metadata.subject_id) };
  return null;
}

function normalizeCloudAsset(asset, fallbackTarget = null) {
  if (!asset?.id) return null;
  const target = targetFromAsset(asset) || (fallbackTarget ? clone(fallbackTarget) : null);
  let targetKey = null;
  try { if (target) targetKey = imageTargetKey(target); } catch { /* unbound legacy asset */ }
  return {
    ...asset,
    id: asset.id,
    kind: 'asset',
    target,
    targetKey,
    purpose: asset.purpose || asset.metadata?.purpose || null,
    campaignId: asset.campaignId || asset.metadata?.campaign_id || null,
    subjectName: asset.subjectName || asset.metadata?.subject_name || null,
    versionGroupId: asset.versionGroupId || asset.metadata?.version_group_id || targetKey && `${targetKey}:versions`,
    cloudState: 'synced',
    cloudAssetId: asset.cloudAssetId || asset.id
  };
}

function normalizeGalleryFilters(filters = {}) {
  return {
    ...filters,
    campaignId: filters.campaignId || filters.campaign || '',
    turnNodeId: filters.turnNodeId || filters.turn || '',
    subjectId: filters.subjectId || filters.character || ''
  };
}

function filtersForTarget(target) {
  if (target?.kind === 'turn') return { turnNodeId: String(target.nodeId) };
  if (target?.kind === 'portrait') return { subjectId: String(target.subjectId) };
  return {};
}

export class ImageStudio {
  constructor({
    store = createImageStore(), settingsStore = new ImageSettingsStore(),
    worldbookStore = new ImageWorldbookStore(), adapterRegistry = new ImageAdapterRegistry(),
    cloudGallery = new CloudImageGalleryClient(), autoStart = true
  } = {}) {
    this.store = store;
    this.settingsStore = settingsStore;
    this.worldbookStore = worldbookStore;
    this.adapters = adapterRegistry;
    this.cloud = cloudGallery;
    this.cloudEnabled = usesProjectServerFeatures();
    this.autoStart = autoStart;
    this.listeners = new Set();
    this.controllers = new Map();
    this._running = false;
    this._scheduled = false;
    this._readyPromise = null;
  }

  ready() {
    if (!this._readyPromise) this._readyPromise = this._initialize();
    return this._readyPromise;
  }

  async _initialize() {
    await this.store.ready();
    this.runtimeSettings = await this._decryptSettings(this.settingsStore.load());
    this.adapters.transport.allowedPrivateOrigins = this.runtimeSettings.allowedPrivateOrigins;
    this.adapters.transport.allowedPublicHttpOrigins = this.runtimeSettings.allowedPublicHttpOrigins;
    const jobs = await this.store.getAll('jobs');
    for (const job of jobs) {
      if (!ACTIVE_STATES.has(job.state)) continue;
      if (job.state === 'queued' || job.state === 'planning') {
        await this.store.put('jobs', { ...job, state: 'queued', executorId: null, updatedAt: new Date().toISOString() });
      } else if (job.providerType === 'comfyui' && job.resumeToken?.promptId) {
        await this.store.put('jobs', { ...job, state: 'queued', resumeOnly: true, executorId: null, updatedAt: new Date().toISOString() });
      } else {
        await this.store.put('jobs', {
          ...job, state: 'interrupted', executorId: null, updatedAt: new Date().toISOString(),
          error: { code: 'OUTCOME_UNKNOWN', message: '页面关闭时供应商结果未知，请确认后手动重试', retryable: true, outcomeKnown: false }
        });
      }
    }
    // Best-effort replay for references that could not be released while the
    // browser was offline or closing. It must never block the image feature.
    if (this.cloudEnabled) void this._flushCloudReferenceOutbox();
    if (this.autoStart) this._schedule();
    return this;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _emit(event) {
    const pending = [];
    for (const listener of this.listeners) {
      try {
        const result = listener(clone(event));
        if (result && typeof result.then === 'function') {
          pending.push(Promise.resolve(result).catch(error => {
            warnListenerFailure(error);
            return undefined;
          }));
        }
      } catch (error) {
        warnListenerFailure(error);
      }
    }
    return Promise.allSettled(pending);
  }

  _settings() { return this.runtimeSettings || this.settingsStore.load(); }

  async _decryptSettings(settings) {
    const next = clone(settings);
    for (const provider of Object.values(next.providers || {})) {
      if (provider.apiKey) provider.apiKey = await decryptApiKey(provider.apiKey);
    }
    if (next.separatePromptModel?.apiKey) {
      next.separatePromptModel.apiKey = await decryptApiKey(next.separatePromptModel.apiKey);
    }
    return next;
  }

  async _saveSettings(settings) {
    const checked = validateImageSettings(settings);
    if (!checked.valid) throw new TypeError(checked.errors.join('; '));
    const runtime = checked.value;
    const persisted = clone(runtime);
    for (const provider of Object.values(persisted.providers || {})) {
      if (provider.apiKey) provider.apiKey = await encryptApiKey(provider.apiKey);
    }
    if (persisted.separatePromptModel?.apiKey) {
      persisted.separatePromptModel.apiKey = await encryptApiKey(persisted.separatePromptModel.apiKey);
    }
    this.settingsStore.save(persisted);
    this.runtimeSettings = runtime;
    return runtime;
  }

  async execute(command = {}) {
    await this.ready();
    switch (command.type) {
      case 'generate': return this._enqueue(command);
      case 'cancel': return this._cancel(command.jobId);
      case 'retry': return this._retry(command.jobId);
      case 'select': return this._select(command);
      case 'detach': return this._detach(command.target, command.expectedRevision);
      case 'delete': return this._delete(command.assetId);
      case 'protect': return this._protect(command.assetId, command.protected !== false);
      case 'configure': {
        const settings = await this._saveSettings(command.settings || command.patch || {});
        this.adapters.transport.allowedPrivateOrigins = settings.allowedPrivateOrigins;
        this.adapters.transport.allowedPublicHttpOrigins = settings.allowedPublicHttpOrigins;
        this._emit({ type: 'settings.changed', settings: toPublicSettings(settings) });
        return toPublicSettings(settings);
      }
      case 'probe': return this._probe(command);
      case 'worldbook:update': {
        const globalBook = this.worldbookStore.save(fromUiWorldbook({ global: command.worldbook?.global || [] }));
        const overlayBook = fromUiWorldbook({ global: command.worldbook?.overlay || [] });
        stateManager.setSub('_image_worldbook_overlay', overlayBook);
        const worldbook = toUiWorldbook(globalBook, overlayBook);
        this._emit({ type: 'worldbook.changed', worldbook });
        return worldbook;
      }
      default: throw new TypeError(`未知的 ImageStudio 命令: ${command.type}`);
    }
  }

  async read(query = {}) {
    await this.ready();
    switch (query.type) {
      case 'settings': return toPublicSettings(this._settings());
      case 'worldbook': return toUiWorldbook(
        this.worldbookStore.load(), stateManager.getSub('_image_worldbook_overlay') || { entries: [] }
      );
      case 'job': return this.store.get('jobs', query.jobId);
      case 'target': return this._readTarget(query.target);
      case 'gallery': return this._gallery(query.filters || {}, query.offset || 0, query.limit || 40);
      case 'quota': return this._quota();
      case 'providers': return toPublicSettings(this._settings()).providers;
      case 'asset-content': return this._assetContent(query.assetId, query.variant || 'content');
      default: throw new TypeError(`未知的 ImageStudio 查询: ${query.type}`);
    }
  }

  async _probe(command) {
    const settings = this._settings();
    const providerId = normalizeImageProviderId(command.providerId || settings.providerId);
    const provider = { ...(settings.providers[providerId] || {}), ...(command.config || {}) };
    const adapter = this.adapters.get(provider.type || providerId);
    const result = await adapter.probe(provider);
    this._emit({ type: 'provider.probed', providerId, result });
    return result;
  }

  async _enqueue(command) {
    const settings = this._settings();
    if (!settings.enabled) {
      const error = new Error('请先在设置中启用文生图'); error.code = 'FEATURE_DISABLED'; throw error;
    }
    const targetKey = imageTargetKey(command.target);
    const mode = command.mode === 'auto' || command.mode === 'automatic' ? 'auto' : 'manual';
    const jobs = await this.store.getAll('jobs');
    const idempotencyKey = mode === 'auto' && command.target.kind === 'turn'
      ? `turn:${command.target.nodeId}:illustration:auto:v1` : null;
    if (idempotencyKey) {
      const existing = jobs.find(job => job.idempotencyKey === idempotencyKey && job.state !== 'cancelled');
      if (existing) return { jobId: existing.id, reused: true, snapshot: existing };
    }
    const active = jobs.find(job => job.targetKey === targetKey && ACTIVE_STATES.has(job.state));
    if (active && !command.reroll) return { jobId: active.id, reused: true, snapshot: active };
    const binding = await this.store.get('asset_cache', `binding:${targetKey}`);
    const providerId = normalizeImageProviderId(command.providerId || settings.providerId);
    const provider = settings.providers[providerId];
    if (!provider) throw new Error(`绘图后端不存在: ${providerId}`);
    const timestamp = new Date().toISOString();
    const job = {
      id: id('job'), revision: 0, state: 'queued', target: clone(command.target), targetKey,
      mode, priority: mode === 'manual' ? 100 : 10, idempotencyKey,
      contract: command.contract || null, prompt: command.prompt || '', negativePrompt: command.negativePrompt || '',
      profile: command.profile || null, parameters: command.parameters || {}, providerId,
      providerType: provider.type || providerId,
      expectedBindingRevision: command.bindingRevision ?? command.expectedRevision ?? Number(binding?.revision || 0),
      versionGroupId: binding?.versionGroupId || `${targetKey}:versions`,
      createdAt: timestamp, updatedAt: timestamp, attempt: 0, warnings: []
    };
    await this.store.put('jobs', job);
    this._emit({ type: 'job.changed', job });
    this._schedule();
    return { jobId: job.id, reused: false, snapshot: job };
  }

  async _updateJob(job, patch) {
    const next = { ...job, ...patch, revision: (Number(job.revision) || 0) + 1, updatedAt: new Date().toISOString() };
    await this.store.put('jobs', next);
    this._emit({ type: 'job.changed', job: next, target: next.target });
    return next;
  }

  async _compareAndUpdateJob(jobId, expectedRevision, updater) {
    const result = await this.store.compareAndSwap('jobs', jobId, Number(expectedRevision) || 0, current => {
      if (!current) return undefined;
      const patch = updater(current);
      if (patch === undefined) return undefined;
      return { ...current, ...patch, updatedAt: new Date().toISOString() };
    });
    if (result.ok && result.current) {
      this._emit({ type: 'job.changed', job: result.current, target: result.current.target });
    }
    return result;
  }

  _cloudReferenceOutboxId(assetId) {
    return `cloud-active-reference:${assetId}`;
  }

  async _rememberCloudReference(assetId, jobId) {
    const id = this._cloudReferenceOutboxId(assetId);
    const previous = await this.store.get('outbox', id);
    await this.store.put('outbox', {
      id, type: 'release-cloud-active-reference', assetId, jobId: jobId || previous?.jobId || null,
      attempts: Number(previous?.attempts) || 0,
      createdAt: previous?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  async _releaseCloudReference(assetId, jobId = null) {
    const id = this._cloudReferenceOutboxId(assetId);
    if (!this.cloudEnabled) {
      await this.store.delete('outbox', id).catch(() => {});
      return null;
    }
    try {
      await this.cloud.setActiveJobReference(assetId, false);
      await this.store.delete('outbox', id);
      return null;
    } catch (error) {
      const previous = await this.store.get('outbox', id).catch(() => null);
      await this.store.put('outbox', {
        id, type: 'release-cloud-active-reference', assetId, jobId: jobId || previous?.jobId || null,
        attempts: (Number(previous?.attempts) || 0) + 1,
        createdAt: previous?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(), lastError: error?.message || String(error)
      }).catch(() => {});
      return error;
    }
  }

  async _flushCloudReferenceOutbox() {
    try {
      const records = await this.store.getAll('outbox');
      for (const record of records) {
        if (record?.type !== 'release-cloud-active-reference' || !record.assetId) continue;
        await this._releaseCloudReference(record.assetId, record.jobId);
      }
    } catch (error) {
      console.warn('[ImageStudio] cloud reference outbox replay failed:', error);
    }
  }

  async _appendJobWarning(jobId, warning) {
    const current = await this.store.get('jobs', jobId);
    if (!current) return;
    const warnings = current.warnings || [];
    if (warnings.some(item => item.code === warning.code && item.message === warning.message)) return;
    await this._updateJob(current, { warnings: [...warnings, warning] });
  }

  _schedule() {
    if (this._scheduled) return;
    if (this._running) {
      // Remember the wake-up. _drain() will schedule another pass after the
      // current claim loop releases its runner flag.
      this._scheduled = true;
      return;
    }
    this._scheduled = true;
    queueMicrotask(async () => {
      this._scheduled = false;
      try {
        const run = async () => this._drain();
        if (globalThis.navigator?.locks?.request) {
          let acquired = false;
          await navigator.locks.request('naruto-rpg-image-runner', { ifAvailable: true }, lock => {
            if (!lock) return undefined;
            acquired = true;
            return run();
          });
          // Another tab can finish between our enqueue and its final claim. Try
          // once more after the lock becomes available instead of losing wakeup.
          if (!acquired) setTimeout(() => this._schedule(), 150);
        } else await run();
      } catch (error) {
        console.warn('[ImageStudio] queue runner failed:', error);
        setTimeout(() => this._schedule(), 250);
      }
    });
  }

  async _drain() {
    if (this._running) return;
    this._running = true;
    const executorId = id('executor');
    try {
      while (true) {
        const job = await this.store.claimNextJob(executorId);
        if (!job) break;
        await this._runJob(job);
      }
    } finally {
      this._running = false;
      if (this._scheduled) {
        this._scheduled = false;
        this._schedule();
      }
    }
  }

  _compilePrompt(job) {
    const effectiveWorldbook = mergeImageWorldbooks(
      this.worldbookStore.load(), stateManager.getSub('_image_worldbook_overlay') || { entries: [] }
    );
    const worldbookPrompts = renderImageWorldbookPrompts(effectiveWorldbook, {
      target: job.target, prompt: job.prompt, contract: job.contract, profile: job.profile
    });
    const worldbookText = worldbookPrompts.prompt;
    const worldbookNegative = worldbookPrompts.negativePrompt;
    if (job.contract) {
      const compiled = contractToPrompt(job.contract, { worldbookText });
      return {
        ...compiled,
        negativePrompt: [compiled.negativePrompt, worldbookNegative].filter(Boolean).join(', ')
      };
    }
    if (job.target.kind === 'portrait') {
      const profile = job.profile || {};
      return {
        prompt: [job.prompt || `character portrait of ${job.target.subjectId}`, profile.appearance,
          profile.outfit, profile.style, ...(profile.lockedTraits || []), worldbookText].filter(Boolean).join(', '),
        negativePrompt: [job.negativePrompt, profile.negativePrompt, worldbookNegative].filter(Boolean).join(', ')
      };
    }
    return {
      prompt: [job.prompt, worldbookText].filter(Boolean).join('\n'),
      negativePrompt: [job.negativePrompt, worldbookNegative].filter(Boolean).join(', ')
    };
  }

  async _runJob(initialJob) {
    let job = initialJob;
    const settings = this._settings();
    const provider = settings.providers[job.providerId];
    const adapter = this.adapters.get(provider?.type || job.providerType);
    const controller = new AbortController();
    let activeCloudAssetId = null;
    this.controllers.set(job.id, controller);
    try {
      const latest = await this.store.get('jobs', job.id);
      if (latest?.cancelRequested || TERMINAL_STATES.has(latest?.state)) {
        if (!TERMINAL_STATES.has(latest?.state)) {
          await this._updateJob(latest, { state: 'cancelled', completedAt: new Date().toISOString(), error: null });
        }
        return;
      }
      if (latest) job = latest;
      const compiled = this._compilePrompt(job);
      if (!compiled.prompt.trim()) throw Object.assign(new Error('没有可用的画面提示词'), { code: 'CONTRACT_INVALID' });
      const parameters = { ...job.parameters };
      if (!Number.isInteger(parameters.seed)) {
        parameters.seed = job.target.kind === 'portrait' && Number.isInteger(job.profile?.identitySeed)
          ? job.profile.identitySeed
          : nowSeed(`${job.targetKey}:${job.providerId}`);
      }
      let referenceBlob = null;
      if (job.target.kind === 'portrait') {
        parameters.width ||= 1024; parameters.height ||= 1024;
        const previousBinding = await this.store.get('asset_cache', `binding:${job.targetKey}`);
        const previousBlob = previousBinding?.assetId
          ? await this.store.get('blobs', previousBinding.assetId) : null;
        if (previousBlob?.blob && job.providerType === 'comfyui' && provider.mapping?.reference) {
          referenceBlob = previousBlob.blob;
        } else if (previousBinding?.assetId) {
          job.warnings = [...(job.warnings || []), {
            code: 'REFERENCE_UNSUPPORTED', message: '当前后端不支持参考肖像，已使用视觉档案与固定 seed 保持一致性'
          }];
        }
      }
      job = await this._updateJob(job, { state: 'generating', attempt: (job.attempt || 0) + 1, effectiveParameters: parameters });
      const result = await adapter.generate({
        provider, ...compiled, parameters, referenceBlob, signal: controller.signal, resumeToken: job.resumeToken,
        onCheckpoint: async resumeToken => { job = await this._updateJob(job, { resumeToken }); },
        onProgress: progress => this._emit({ type: 'job.progress', jobId: job.id, target: job.target, progress })
      });
      const afterGeneration = await this.store.get('jobs', job.id);
      if (controller.signal.aborted || afterGeneration?.cancelRequested) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (afterGeneration) job = afterGeneration;
      job = await this._updateJob(job, { state: 'staging', resumeToken: result.resumeToken || job.resumeToken });
      const generated = result.images?.[0];
      if (!generated?.blob) throw new Error('绘图后端没有返回图片');
      let assetId = assetUuid();
      let cloudAsset = null;
      let cloudError = null;
      const campaignId = await stateManager.dbGet('timeline_meta', 'root')
        .then(meta => meta?.value?.root_id || null, () => null);
      const assetMetadata = {
        local_asset_id: assetId, purpose: job.target.kind === 'turn' ? 'turn-illustration' : 'portrait',
        campaign_id: campaignId || undefined,
        turn_node_id: job.target.nodeId || undefined, subject_id: job.target.subjectId || undefined,
        subject_name: job.profile?.displayName || job.profile?.name || undefined,
        version_group_id: job.versionGroupId, source_job_id: job.id,
        provider: job.providerType, model: provider.model || '', active_job_referenced: true
      };
      if (this.cloudEnabled) {
        job = await this._updateJob(job, { state: 'uploading' });
        try {
          const uploaded = await this.cloud.upload({
            blob: generated.blob, autoEvict: settings.autoEviction, signal: controller.signal,
            metadata: assetMetadata
          });
          cloudAsset = uploaded.asset;
          assetId = cloudAsset.id;
          activeCloudAssetId = cloudAsset.id;
          await this._rememberCloudReference(activeCloudAssetId, job.id);
        } catch (error) {
          if (error?.name === 'AbortError' || controller.signal.aborted) throw error;
          cloudError = error;
        }
      }
      const beforeStaging = await this.store.get('jobs', job.id);
      if (controller.signal.aborted || beforeStaging?.cancelRequested) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (beforeStaging) job = beforeStaging;
      const asset = {
        id: assetId, kind: 'asset', target: job.target, targetKey: job.targetKey,
        versionGroupId: job.versionGroupId, purpose: job.target.kind === 'turn' ? 'turn-illustration' : 'portrait',
        mimeType: generated.mimeType, width: generated.width, height: generated.height,
        sizeBytes: generated.blob.size, createdAt: new Date().toISOString(), protected: false,
        cloudState: cloudAsset ? 'synced' : (this.cloudEnabled ? 'upload-blocked' : 'local-only'), cloudAssetId: cloudAsset?.id || null,
        contentUrl: cloudAsset?.contentUrl || null, thumbnailUrl: cloudAsset?.thumbnailUrl || null,
        metadata: cloudAsset?.metadata || assetMetadata, provenance: {
          adapter: job.providerType, model: provider.model || '', parameters,
          promptId: result.metadata?.promptId || null
        }
      };
      await this.store.put('blobs', { id: assetId, blob: generated.blob });
      await this.store.put('asset_cache', asset);
      job = await this._updateJob(job, {
        state: 'binding', outputAssetId: assetId,
        warnings: cloudError ? [...(job.warnings || []), { code: cloudError.code || 'CLOUD_UPLOAD_BLOCKED', message: cloudError.message }] : job.warnings
      });
      const beforeBinding = await this.store.get('jobs', job.id);
      if (controller.signal.aborted || beforeBinding?.cancelRequested) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (beforeBinding) job = beforeBinding;
      const bindingResult = await this._bind(job.target, asset, job.expectedBindingRevision, job);
      let completionBase = job;
      let completion = null;
      for (let attempt = 0; attempt < 3 && !completion; attempt++) {
        const completed = await this._compareAndUpdateJob(job.id, completionBase.revision, current => {
          if (current.cancelRequested || TERMINAL_STATES.has(current.state)) return undefined;
          return {
            state: 'succeeded', completedAt: new Date().toISOString(),
            output: { assetId, binding: bindingResult.status === 'updated' ? 'selected' : 'detached' }
          };
        });
        if (completed.ok) {
          completion = completed.current;
          break;
        }
        const current = completed.current || await this.store.get('jobs', job.id);
        if (controller.signal.aborted || current?.cancelRequested || current?.state === 'cancelled') {
          await this._detachCancelledJobBinding(job, asset, bindingResult);
          throw new DOMException('Aborted', 'AbortError');
        }
        if (TERMINAL_STATES.has(current?.state)) {
          completion = current;
          break;
        }
        if (!current) throw new Error('图片任务在完成前丢失');
        completionBase = current;
      }
      if (!completion) throw new Error('图片任务完成状态发生并发冲突');
      job = completion;
      if (job.state !== 'succeeded') return;
      this._emit({ type: 'asset.ready', job, asset, target: job.target });
    } catch (error) {
      const current = await this.store.get('jobs', job.id) || job;
      const cancelled = current.cancelRequested || error?.name === 'AbortError';
      const state = cancelled ? 'cancelled' : 'failed';
      const retryable = cancelled || error?.retryable !== false;
      await this._updateJob(current, {
        state, completedAt: new Date().toISOString(),
        error: cancelled ? null : {
          code: error?.code || 'IMAGE_GENERATION_FAILED', message: error?.message || '图片生成失败',
          retryable, outcomeKnown: current.providerType === 'comfyui' || current.state !== 'generating'
        }
      });
    } finally {
      if (activeCloudAssetId) {
        const cleanupError = await this._releaseCloudReference(activeCloudAssetId, job.id);
        if (cleanupError) {
          await this._appendJobWarning(job.id, {
            code: 'CLOUD_REFERENCE_CLEANUP',
            message: cleanupError?.message || '云端活跃任务引用清理失败，稍后会自动重试'
          }).catch(() => {});
        }
      }
      this.controllers.delete(job.id);
    }
  }

  async _detachCancelledJobBinding(job, asset, bindingResult) {
    if (bindingResult?.status !== 'updated') return { status: 'unchanged' };
    const bindingId = `binding:${imageTargetKey(job.target)}`;
    const current = await this.store.get('asset_cache', bindingId);
    if (!current || current.jobId !== job.id || current.assetId !== asset.id) {
      return { status: 'stale', binding: current || null };
    }
    return this._detach(job.target, current.revision);
  }

  async _bind(target, asset, expectedRevision, job = null) {
    const key = imageTargetKey(target);
    const bindingId = `binding:${key}`;
    const result = await this.store.compareAndSwap('asset_cache', bindingId, Number(expectedRevision) || 0, current => ({
      id: bindingId, kind: 'binding', target, targetKey: key, assetId: asset.id,
      versionGroupId: asset.versionGroupId, updatedAt: new Date().toISOString(),
      jobId: job?.id || null, revision: Number(current?.revision) || 0
    }));
    if (!result.ok) return { status: 'stale', binding: result.current };
    const jobId = job?.id || null;
    const staged = await this.store.updateIfRevision('asset_cache', bindingId, result.current.revision, current => (
      current?.assetId === asset.id && (current?.jobId || null) === jobId
        ? {
            ...current,
            cloudSelectionState: asset.cloudAssetId ? 'syncing' : 'local-only',
            cloudSelectionError: null
          }
        : undefined
    ));
    if (!staged.ok) return { status: 'stale', binding: staged.current };
    let binding = staged.current;
    if (this.cloudEnabled && asset.cloudAssetId) {
      let cloudSelectionState = 'synced';
      let cloudSelectionError = null;
      let selectionFailure = null;
      try {
        await this.cloud.select(target, asset.cloudAssetId, Math.max(0, Number(binding.revision) - 1));
      } catch (error) {
        cloudSelectionState = error?.status === 409 ? 'conflict' : 'pending';
        cloudSelectionError = error?.message || '云端图片选择同步失败';
        selectionFailure = error;
      }
      const finalized = await this.store.updateIfRevision('asset_cache', bindingId, binding.revision, current => (
        current?.assetId === asset.id && (current?.jobId || null) === jobId
          ? { ...current, cloudSelectionState, cloudSelectionError }
          : undefined
      ));
      if (!finalized.ok) return { status: 'stale', binding: finalized.current };
      binding = finalized.current;
      if (selectionFailure) {
        this._emit({ type: 'cloud.selection-failed', target, asset, error: selectionFailure.message });
      }
    }
    this._emit({ type: 'binding.changed', target, binding, asset, job });
    return { status: 'updated', binding };
  }

  async _select(command) {
    let asset = await this.store.get('asset_cache', command.assetId);
    if (!asset && this.cloudEnabled) {
      const resolved = await this.cloud.resolve([command.assetId]);
      asset = normalizeCloudAsset(resolved.assets?.[0]);
      if (asset) await this.store.put('asset_cache', asset);
    }
    if (!asset || asset.kind !== 'asset') throw new Error('图片版本不存在');
    if (asset.targetKey !== imageTargetKey(command.target)) throw new Error('图片版本不属于此目标');
    return this._bind(command.target, asset, command.expectedRevision ?? 0, null);
  }

  async _detach(target, expectedRevision = null) {
    const key = imageTargetKey(target);
    const bindingId = `binding:${key}`;
    const binding = await this.store.get('asset_cache', bindingId);
    if (!binding) return { status: 'missing', target };
    if (!binding.assetId) return { status: 'detached', target, binding };
    const expected = expectedRevision === null || expectedRevision === undefined
      ? Number(binding.revision) || 0
      : Number(expectedRevision) || 0;
    const result = await this.store.compareAndSwap('asset_cache', bindingId, expected, current => ({
      ...current,
      id: bindingId,
      kind: 'binding',
      target: current?.target || target,
      targetKey: current?.targetKey || key,
      assetId: null,
      updatedAt: new Date().toISOString(),
      revision: Number(current?.revision) || 0
    }));
    if (!result.ok) return { status: 'stale', target, binding: result.current };
    const detachedAsset = binding.assetId
      ? await this.store.get('asset_cache', binding.assetId)
      : null;
    const staged = await this.store.updateIfRevision('asset_cache', bindingId, result.current.revision, current => (
      current && !current.assetId
        ? {
            ...current,
            cloudSelectionState: detachedAsset?.cloudAssetId ? 'syncing' : 'local-only',
            cloudSelectionError: null
          }
        : undefined
    ));
    if (!staged.ok) return { status: 'stale', target, binding: staged.current };
    let tombstone = staged.current;
    if (this.cloudEnabled && detachedAsset?.cloudAssetId) {
        let cloudSelectionState = 'synced';
        let cloudSelectionError = null;
        let selectionFailure = null;
        try {
          await this.cloud.select(target, null, expected);
        } catch (error) {
          cloudSelectionState = error?.status === 409 ? 'conflict' : 'pending';
          cloudSelectionError = error?.message || '云端图片选择同步失败';
          selectionFailure = error;
        }
        const finalized = await this.store.updateIfRevision('asset_cache', bindingId, tombstone.revision, current => (
          current && !current.assetId
            ? { ...current, cloudSelectionState, cloudSelectionError }
            : undefined
        ));
        if (!finalized.ok) return { status: 'stale', target, binding: finalized.current };
        tombstone = finalized.current;
        if (selectionFailure) {
          this._emit({ type: 'cloud.selection-failed', target, asset: detachedAsset, error: selectionFailure.message });
        }
    }
    this._emit({ type: 'binding.detached', target, binding: tombstone, previousBinding: binding, asset: null });
    return { status: 'detached', target, binding: tombstone };
  }

  async _cancel(jobId) {
    let job = await this.store.get('jobs', jobId);
    if (!job) throw new Error('图片任务不存在');
    if (TERMINAL_STATES.has(job.state)) return job;

    let next = null;
    for (let attempt = 0; attempt < 8 && !next; attempt++) {
      if (TERMINAL_STATES.has(job.state)) return job;
      if (job.cancelRequested) {
        next = job;
        break;
      }
      const requested = await this._compareAndUpdateJob(jobId, job.revision, current => {
        if (TERMINAL_STATES.has(current.state)) return undefined;
        return { cancelRequested: true };
      });
      if (requested.ok) {
        next = requested.current;
        break;
      }
      job = requested.current || await this.store.get('jobs', jobId);
      if (!job) throw new Error('图片任务不存在');
    }
    if (!next) next = await this.store.get('jobs', jobId);
    if (!next || TERMINAL_STATES.has(next.state)) return next || job;

    this.controllers.get(jobId)?.abort();
    if (next.providerType === 'comfyui' && next.resumeToken) {
      const settings = this._settings();
      const provider = settings.providers[next.providerId];
      this.adapters.get('comfyui').cancel(provider, next.resumeToken).catch(() => {});
    }
    if (next.state === 'queued' || next.state === 'planning') {
      const cancelled = await this._compareAndUpdateJob(jobId, next.revision, current => {
        if (TERMINAL_STATES.has(current.state)
          || !current.cancelRequested
          || !['queued', 'planning'].includes(current.state)) return undefined;
        return { state: 'cancelled', completedAt: new Date().toISOString(), error: null };
      });
      return cancelled.ok ? cancelled.current : (cancelled.current || next);
    }
    return next;
  }

  async _retry(jobId) {
    const old = await this.store.get('jobs', jobId);
    if (!old || !TERMINAL_STATES.has(old.state)) throw new Error('此任务当前不能重试');
    return this._enqueue({
      type: 'generate', target: old.target, contract: old.contract, prompt: old.prompt,
      negativePrompt: old.negativePrompt, profile: old.profile, parameters: old.parameters,
      providerId: old.providerId, mode: 'manual', reroll: true
    });
  }

  async _protect(assetId, protectedValue) {
    const asset = await this.store.get('asset_cache', assetId);
    if (!asset || asset.kind !== 'asset') throw new Error('图片不存在');
    const next = { ...asset, protected: protectedValue };
    if (this.cloudEnabled && asset.cloudAssetId) await this.cloud.protect(asset.cloudAssetId, protectedValue);
    await this.store.put('asset_cache', next);
    this._emit({ type: 'asset.changed', asset: next });
    return next;
  }

  async _delete(assetId) {
    const asset = await this.store.get('asset_cache', assetId);
    if (!asset || asset.kind !== 'asset') throw new Error('图片不存在');
    if (asset.protected) throw new Error('请先取消图片保护');
    const records = await this.store.getAll('asset_cache');
    for (const binding of records.filter(record => record.kind === 'binding' && record.assetId === assetId)) {
      const detached = await this._detach(binding.target, binding.revision);
      if (detached.status === 'stale') {
        const error = new Error('图片绑定已被其他操作更新，请刷新后重试删除');
        error.code = 'BINDING_CONFLICT';
        throw error;
      }
    }
    if (this.cloudEnabled && asset.cloudAssetId) await this.cloud.delete(asset.cloudAssetId);
    await this.store.delete('asset_cache', assetId);
    await this.store.delete('blobs', assetId);
    this._emit({ type: 'asset.deleted', assetId, asset });
    return { id: assetId };
  }

  async _retryPendingCloudSelection(target, records) {
    if (!this.cloudEnabled) return null;
    if (typeof this.cloud.reconcileSelections !== 'function') return null;
    const key = imageTargetKey(target);
    const binding = records.find(record => record.kind === 'binding' && record.targetKey === key);
    if (!binding || !['pending', 'syncing'].includes(binding.cloudSelectionState)) return null;
    const asset = binding.assetId
      ? records.find(record => record.kind === 'asset' && record.id === binding.assetId)
      : null;
    if (binding.assetId && !asset?.cloudAssetId) return null;

    let result;
    try {
      result = await this.cloud.reconcileSelections([{
        target,
        assetId: asset?.cloudAssetId || null,
        expectedRevision: Math.max(0, Number(binding.revision) - 1)
      }]);
    } catch {
      return null;
    }

    const applied = (result?.applied || []).find(item => targetsEqual(item?.target, target));
    const conflict = (result?.conflicts || []).find(item => targetsEqual(item?.target, target));
    const missing = (result?.missing || []).find(item => targetsEqual(item?.target, target));
    const updated = await this.store.updateIfRevision(
      'asset_cache', binding.id, binding.revision,
      current => (current?.assetId || null) === (binding.assetId || null)
        ? {
            ...current,
            cloudSelectionState: applied ? 'synced' : (conflict ? 'conflict' : 'pending'),
            cloudSelectionError: applied
              ? null
              : (missing ? '云端图片已不存在' : (conflict ? '云端图片选择已在其他设备更新' : current.cloudSelectionError))
          }
        : undefined
    );
    return { applied, conflict, missing, binding: updated.current || binding };
  }

  async _readTarget(target) {
    const key = imageTargetKey(target);
    let [records, jobs] = await Promise.all([this.store.getAll('asset_cache'), this.store.getAll('jobs')]);
    let cloudResult = null;
    try {
      if (!this.cloudEnabled) throw null;
      await this._retryPendingCloudSelection(target, records);
      records = await this.store.getAll('asset_cache');
      cloudResult = await this.cloud.list({ ...filtersForTarget(target), limit: 500 });
      const cloudAssets = (cloudResult.items || []).map(asset => normalizeCloudAsset(asset, target))
        .filter(asset => asset?.targetKey === key);
      const cloudAssetIds = new Set(cloudAssets.map(asset => asset.id));
      if (Number(cloudResult.total) <= cloudAssets.length) {
        for (const localAsset of records.filter(record => record.kind === 'asset'
          && record.targetKey === key && record.cloudState === 'synced' && record.cloudAssetId
          && !cloudAssetIds.has(record.id))) {
          await this.store.delete('asset_cache', localAsset.id);
          await this.store.delete('blobs', localAsset.id);
        }
      }
      for (const asset of cloudAssets) await this.store.put('asset_cache', asset);

      const cloudSelection = (cloudResult.selections || []).find(selection => targetsEqual(selection?.target, target));
      const localBinding = records.find(record => record.kind === 'binding' && record.targetKey === key) || null;
      const cloudRevision = Number(cloudSelection?.revision) || 0;
      const localRevision = Number(localBinding?.revision) || 0;
      const cloudAssetId = cloudSelection?.asset_id || null;
      const equalRevisionConflict = cloudSelection && cloudRevision === localRevision
        && cloudAssetId !== (localBinding?.assetId || null)
        && localBinding?.cloudSelectionState !== 'local-only';
      const confirmsPendingBinding = cloudSelection && cloudRevision === localRevision
        && cloudAssetId === (localBinding?.assetId || null)
        && ['pending', 'syncing', 'conflict'].includes(localBinding?.cloudSelectionState);
      if (cloudSelection && (cloudRevision > localRevision || equalRevisionConflict || confirmsPendingBinding)) {
        const selectedCloudAsset = cloudAssets.find(asset => asset.id === cloudAssetId) || null;
        const nextBinding = {
          id: `binding:${key}`, kind: 'binding', target: clone(target), targetKey: key,
          assetId: cloudAssetId,
          versionGroupId: selectedCloudAsset?.versionGroupId || localBinding?.versionGroupId || `${key}:versions`,
          jobId: null, revision: cloudRevision,
          updatedAt: cloudSelection.updated_at || new Date().toISOString(), hydratedFromCloud: true,
          cloudSelectionState: 'synced', cloudSelectionError: null
        };
        const hydrated = await this.store.updateIfRevision(
          'asset_cache', nextBinding.id, localRevision, nextBinding
        );
        const selectionChanged = cloudRevision > localRevision || equalRevisionConflict;
        if (hydrated.ok && selectionChanged) {
          const binding = hydrated.current;
          await this._emit({
            type: binding.assetId ? 'binding.changed' : 'binding.detached',
            target: clone(target), binding, previousBinding: localBinding,
            asset: selectedCloudAsset, job: null,
            authoritative: true, source: 'cloud-hydration'
          });
        }
      }
      records = await this.store.getAll('asset_cache');
    } catch { /* local target state remains available offline */ }
    return {
      binding: records.find(record => record.kind === 'binding' && record.targetKey === key) || null,
      assets: records.filter(record => record.kind === 'asset' && record.targetKey === key)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
      jobs: jobs.filter(job => job.targetKey === key).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    };
  }

  async _gallery(filters, offset, limit) {
    const normalizedFilters = normalizeGalleryFilters(filters);
    const local = (await this.store.getAll('asset_cache'))
      .filter(record => record.kind === 'asset' && assetMatches(record, normalizedFilters));
    let cloud = [];
    let cloudTotal = 0;
    try {
      if (!this.cloudEnabled) throw null;
      const result = await this.cloud.list({ ...normalizedFilters, limit: Math.min(500, offset + limit) });
      cloud = result.items.map(asset => normalizeCloudAsset(asset)).filter(Boolean);
      cloudTotal = Math.max(cloud.length, Number(result.total) || 0);
      for (const asset of cloud) await this.store.put('asset_cache', asset);
    } catch { /* offline gallery */ }
    const merged = new Map(cloud.map(asset => [asset.id, asset]));
    for (const asset of local) merged.set(asset.id, { ...merged.get(asset.id), ...asset });
    const items = [...merged.values()].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(offset, offset + limit);
    const localOnlyCount = local.filter(asset => !asset.cloudAssetId || asset.cloudState !== 'synced').length;
    return { items, total: Math.max(merged.size, cloudTotal + localOnlyCount), offset, limit };
  }

  async _quota() {
    try {
      if (!this.cloudEnabled) throw null;
      return await this.cloud.quota();
    }
    catch {
      const assets = (await this.store.getAll('asset_cache')).filter(record => record.kind === 'asset');
      return {
        usedBytes: assets.reduce((sum, asset) => sum + Number(asset.sizeBytes || 0), 0), limitBytes: 1024 ** 3,
        assetCount: assets.length, assetLimit: 500
      };
    }
  }

  async _assetContent(assetId, variant) {
    const record = await this.store.get('blobs', assetId);
    if (record?.blob) return record.blob;
    const asset = await this.store.get('asset_cache', assetId);
    if (!this.cloudEnabled) throw new Error('本地图片内容不存在');
    if (asset?.cloudAssetId || asset?.contentUrl) return this.cloud.content(asset.cloudAssetId || assetId, variant);
    return this.cloud.content(assetId, variant);
  }
}

export function createImageStudio(options) { return new ImageStudio(options); }
export const imageStudio = createImageStudio();

export * from './adapters.js';
export * from './cloud-gallery.js';
export * from './contracts.js';
export * from './settings.js';
export * from './storage.js';
export * from './transport.js';
export * from './worldbook.js';
export * from './zip.js';

export default imageStudio;
