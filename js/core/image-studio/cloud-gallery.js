import { fetchProjectServer } from '../project-server.js';

function mapAsset(asset = {}) {
  return {
    ...asset,
    id: asset.id,
    mimeType: asset.mime_type || asset.mimeType,
    sizeBytes: asset.size_bytes ?? asset.sizeBytes ?? 0,
    thumbnailMimeType: asset.thumbnail_mime_type || asset.thumbnailMimeType,
    thumbnailSizeBytes: asset.thumbnail_size_bytes ?? asset.thumbnailSizeBytes ?? 0,
    contentUrl: asset.content_url || asset.contentUrl,
    thumbnailUrl: asset.thumbnail_url || asset.thumbnailUrl,
    createdAt: asset.created_at || asset.createdAt,
    updatedAt: asset.updated_at || asset.updatedAt,
    protected: asset.protected === true,
    selectedTargets: asset.selected_targets || asset.selectedTargets || []
  };
}

async function responseError(response, fallback) {
  const body = await response.json().catch(() => ({}));
  const error = new Error(body.error || fallback);
  error.code = body.code || 'GALLERY_ERROR';
  error.status = response.status;
  error.details = body.details;
  return error;
}

async function canvasThumbnail(blob, maxSide = 512) {
  if (!globalThis.createImageBitmap) {
    if (blob.size <= 512 * 1024) return blob;
    throw new Error('当前浏览器无法生成缩略图');
  }
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  let canvas;
  if (globalThis.OffscreenCanvas) canvas = new OffscreenCanvas(width, height);
  else {
    canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
  }
  const context = canvas.getContext('2d', { alpha: false });
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const toBlob = async (quality) => {
    if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/jpeg', quality });
    return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  };
  for (const quality of [0.84, 0.7, 0.55]) {
    const result = await toBlob(quality);
    if (result && result.size <= 512 * 1024) return result;
  }
  throw new Error('缩略图仍超过 512 KiB');
}

export class CloudImageGalleryClient {
  constructor({ fetchImpl = fetchProjectServer } = {}) {
    this.fetchImpl = fetchImpl;
  }

  async request(path = '', options = {}) {
    const response = await this.fetchImpl(`/api/image-assets${path}`, {
      credentials: 'same-origin', ...options,
      timeoutMs: options.body || /\/(content|thumbnail)$/.test(path) ? 90_000 : 15_000
    });
    if (!response.ok) throw await responseError(response, '图库请求失败');
    const type = response.headers.get('content-type') || '';
    return type.includes('application/json') ? response.json() : response.blob();
  }

  async upload({ blob, thumbnail = null, metadata = {}, autoEvict = false, signal } = {}) {
    const preview = thumbnail || await canvasThumbnail(blob);
    const form = new FormData();
    form.append('original', blob, `image.${(blob.type || 'image/png').split('/')[1] || 'png'}`);
    form.append('thumbnail', preview, 'thumbnail.jpg');
    form.append('metadata', JSON.stringify(metadata));
    form.append('auto_evict', String(autoEvict));
    const result = await this.request('', { method: 'POST', body: form, signal });
    return { ...result, asset: mapAsset(result.asset) };
  }

  async list(filters = {}) {
    const query = new URLSearchParams();
    const mapping = {
      campaignId: 'campaign_id', turnNodeId: 'turn_node_id', subjectId: 'subject_id',
      purpose: 'purpose', cursor: 'cursor', limit: 'limit'
    };
    for (const [key, name] of Object.entries(mapping)) {
      if (filters[key] !== undefined && filters[key] !== '') query.set(name, filters[key]);
    }
    const result = await this.request(query.size ? `?${query}` : '');
    return { ...result, items: (result.assets || []).map(mapAsset), assets: (result.assets || []).map(mapAsset) };
  }

  async quota() {
    const value = await this.request('/quota');
    return {
      usedBytes: value.used_bytes || 0, limitBytes: value.max_bytes || 0,
      assetCount: value.asset_count || 0, assetLimit: value.max_assets || 0,
      remainingBytes: value.remaining_bytes || 0
    };
  }

  async resolve(ids) {
    const result = await this.request('/resolve', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids })
    });
    return { assets: (result.assets || []).map(mapAsset), missing: result.missing || [] };
  }

  async select(target, assetId, expectedRevision) {
    return this.request('/selection', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, asset_id: assetId, expected_revision: expectedRevision })
    });
  }

  async reconcileSelections(selections = []) {
    return this.request('/selections/reconcile', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selections: selections.slice(0, 500).map(selection => ({
          target: selection.target,
          asset_id: selection.assetId ?? selection.asset_id ?? null,
          expected_revision: selection.expectedRevision ?? selection.expected_revision ?? 0
        }))
      })
    });
  }

  async protect(assetId, protectedValue) {
    const result = await this.request(`/${encodeURIComponent(assetId)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ protected: protectedValue })
    });
    return mapAsset(result.asset);
  }

  async setActiveJobReference(assetId, active) {
    const result = await this.request(`/${encodeURIComponent(assetId)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active_job_referenced: active === true })
    });
    return mapAsset(result.asset);
  }

  delete(assetId) { return this.request(`/${encodeURIComponent(assetId)}`, { method: 'DELETE' }); }
  content(assetId, variant = 'content') { return this.request(`/${encodeURIComponent(assetId)}/${variant}`); }
}

export { canvasThumbnail, mapAsset };
