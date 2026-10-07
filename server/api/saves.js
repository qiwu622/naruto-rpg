import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Router, json } from 'express';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

import { config } from '../config.js';
import * as db from '../db/index.js';
import { SaveRevisionConflict } from '../db/save-repository.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncRoute } from '../middleware/async-route.js';
import { inspectTimelineSave } from '../../js/core/timeline-save-schema.js';
import {
  SaveUploadError,
  acquireSaveUpload,
  receiveMultipartSave,
  removeUploadTemp,
  validateCompressedTimeline
} from '../save/stream-upload.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const router = Router();
const MiB = 1024 * 1024;

router.use(requireAuth);
router.use((req, res, next) => {
  // A cookie can change while compression or a retry is waiting in the browser.
  const expectedUser = req.get('X-Cloud-User-Id');
  if (expectedUser && expectedUser !== req.user.id) {
    req.resume();
    return res.status(409).json({ error: '登录账号已改变，请在当前账号重新选择存档', code: 'CLOUD_ACCOUNT_CHANGED' });
  }
  next();
});
router.use(saveMutationAdmission);
router.use(json({
  limit: `${config.saves.legacyMaxSizeMb}mb`,
  type: ['application/json', 'application/*+json']
}));

function validateSaveId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id) && id.length <= 64 && !id.includes('..');
}

function isMultipartRequest(req) {
  return /^multipart\/form-data(?:;|$)/i.test(req.headers['content-type'] || '');
}

function getPreviewDataError(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return '存档预览数据必须是 JSON 对象';
  }
  let sizeBytes;
  try {
    sizeBytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return '存档预览数据嵌套过深或无法安全序列化';
  }
  if (sizeBytes > config.saves.maxPreviewSizeKb * 1024) {
    return `存档预览数据过大，最大允许 ${config.saves.maxPreviewSizeKb} KiB`;
  }
  return null;
}

function safelyInspectTimelineSave(saveData) {
  try {
    return inspectTimelineSave(saveData);
  } catch {
    return { valid: false, errors: ['存档时间线结构无法安全校验'] };
  }
}

function normalizeMetadata(metadata, { requireSlotName }) {
  const { slot_name, preview_data, expected_revision } = metadata;
  if (expected_revision !== undefined && (!Number.isSafeInteger(expected_revision) || expected_revision < 0)) {
    throw new SaveUploadError('INVALID_SAVE_REVISION', '存档版本无效，请刷新后重试', 400);
  }
  if ((requireSlotName || slot_name !== undefined)
      && (typeof slot_name !== 'string' || !slot_name.trim())) {
    throw new SaveUploadError('INVALID_SLOT_NAME', '存档名称必须为非空字符串', 400);
  }
  const previewError = getPreviewDataError(preview_data);
  if (previewError) throw new SaveUploadError('INVALID_PREVIEW_DATA', previewError, 400);
  return {
    slot_name: slot_name === undefined ? undefined : slot_name.trim().substring(0, 50),
    preview_data,
    expected_revision
  };
}

function sendUploadError(res, error) {
  if (!(error instanceof SaveUploadError) && !(error instanceof SaveRevisionConflict)) return false;
  if (error.status === 429 || error.status === 503) res.setHeader('Retry-After', '5');
  res.status(error.status).json({
    error: error.message,
    code: error.code,
    ...(error.details ? { details: error.details } : {})
  });
  return true;
}

function saveMutationAdmission(req, res, next) {
  if (!['POST', 'PUT'].includes(req.method)) return next();

  let release;
  try {
    release = acquireSaveUpload(req.user.id);
  } catch (error) {
    req.resume();
    if (sendUploadError(res, error)) return;
    return next(error);
  }

  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    res.off('finish', releaseOnce);
    res.off('close', releaseOnce);
    release();
  };
  res.once('finish', releaseOnce);
  res.once('close', releaseOnce);
  next();
}

function rejectFullSlot(req, res) {
  req.resume();
  res.status(400).json({
    error: `云存档已满！每个用户最多允许创建 ${config.saves.maxSlots} 个存档。请先删除部分旧存档。`,
    code: 'SAVE_SLOT_LIMIT_REACHED'
  });
}

router.get('/capabilities', (_req, res) => {
  res.json({
    preferred_upload_protocol: 'gzip-multipart-v1',
    upload_protocols: ['gzip-multipart-v1', 'legacy-json-v1'],
    revision_conflicts: true,
    limits: {
      max_uncompressed_bytes: config.saves.maxSizeMb * MiB,
      max_compressed_bytes: config.saves.maxCompressedSizeMb * MiB,
      max_legacy_json_bytes: config.saves.legacyMaxSizeMb * MiB,
      max_metadata_bytes: config.saves.maxPreviewSizeKb * 1024,
      max_slots: config.saves.maxSlots
    }
  });
});

router.get('/', asyncRoute(async (req, res) => {
  try {
    res.json(await db.getUserSaves(req.user.id));
  } catch (error) {
    console.error('[API SAVES] Get list error:', error);
    res.status(500).json({ error: '获取存档列表失败', code: 'SAVE_LIST_FAILED' });
  }
}));

// Player management needs only this account's metadata, never save contents.
router.get('/storage', asyncRoute(async (req, res) => {
  const saves = await db.getUserSaves(req.user.id);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({
    used_slots: saves.length,
    max_slots: config.saves.maxSlots,
    remaining_slots: Math.max(0, config.saves.maxSlots - saves.length),
    used_uncompressed_bytes: saves.reduce((sum, save) => sum + (Number(save.size_bytes) || 0), 0),
    used_compressed_bytes: saves.reduce((sum, save) => sum + (Number(save.compressed_size_bytes) || 0), 0),
    max_save_bytes: config.saves.maxSizeMb * MiB,
    max_upload_bytes: config.saves.maxCompressedSizeMb * MiB
  });
}));

router.patch('/:id/metadata', asyncRoute(async (req, res) => {
  const { id } = req.params;
  if (!validateSaveId(id)) return res.status(400).json({ error: '无效的存档 ID', code: 'INVALID_SAVE_ID' });
  if (!req.is('application/json') && !req.is('application/*+json')) return res.status(415).json({ error: '改名接口需要 application/json', code: 'UNSUPPORTED_SAVE_MEDIA_TYPE' });
  const body = req.body;
  if (!body || Array.isArray(body) || Object.keys(body).some(key => key !== 'slot_name') || typeof body.slot_name !== 'string' || !body.slot_name.trim() || body.slot_name.trim().length > 50) {
    return res.status(400).json({ error: '仅接受 1 至 50 个字的 slot_name', code: 'INVALID_SAVE_METADATA' });
  }
  const existing = await db.getSaveMetaById(id);
  if (!existing) return res.status(404).json({ error: '未找到指定存档', code: 'SAVE_NOT_FOUND' });
  if (existing.user_id !== req.user.id) return res.status(403).json({ error: '无权操作此存档', code: 'SAVE_FORBIDDEN' });
  const updated = await db.updateSaveFile(id, { slot_name: body.slot_name.trim() });
  if (!updated) return res.status(404).json({ error: '未找到指定存档', code: 'SAVE_NOT_FOUND' });
  res.json({ id, slot_name: body.slot_name.trim(), message: '云存档名称已更新' });
}));

router.get('/:id/content', asyncRoute(async (req, res) => {
  const { id } = req.params;
  if (!validateSaveId(id)) return res.status(400).json({ error: '无效的存档 ID', code: 'INVALID_SAVE_ID' });
  try {
    const save = await db.getSaveContentById(id);
    if (!save) return res.status(404).json({ error: '未找到指定存档', code: 'SAVE_NOT_FOUND' });
    if (save.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权访问此存档', code: 'SAVE_FORBIDDEN' });
    }

    const compressedSize = save.compressed_size_bytes || (await fsp.stat(save.file_path)).size;
    res.status(200);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Length', String(compressedSize));
    res.setHeader('Content-Disposition', `attachment; filename="${id}.json.gz"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Save-Revision', String(save.revision));
    if (save.content_sha256) res.setHeader('ETag', `"sha256-${save.content_sha256}"`);
    await pipeline(fs.createReadStream(save.file_path), res);
  } catch (error) {
    if (res.headersSent) {
      if (!res.destroyed) res.destroy(error);
      return;
    }
    console.error('[API SAVES] Stream save error:', error);
    res.status(500).json({ error: '读取云存档失败', code: 'SAVE_STREAM_FAILED' });
  }
}));

// 旧客户端兼容下载。大型存档必须使用 /content，避免服务端完整解压和解析。
router.get('/:id', asyncRoute(async (req, res) => {
  const { id } = req.params;
  if (!validateSaveId(id)) return res.status(400).json({ error: '无效的存档 ID', code: 'INVALID_SAVE_ID' });
  try {
    const meta = await db.getSaveMetaById(id);
    if (!meta) return res.status(404).json({ error: '未找到指定存档', code: 'SAVE_NOT_FOUND' });
    if (meta.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权访问此存档', code: 'SAVE_FORBIDDEN' });
    }
    if (!Number.isFinite(meta.size_bytes)
        || meta.size_bytes > config.saves.legacyMaxSizeMb * MiB) {
      return res.status(413).json({
        error: '该存档必须使用 gzip 流式下载',
        code: 'GZIP_DOWNLOAD_REQUIRED'
      });
    }

    const save = await db.getSaveById(id);
    if (!save) return res.status(404).json({ error: '未找到指定存档', code: 'SAVE_NOT_FOUND' });
    const saveData = JSON.parse((await gunzip(save.save_data)).toString('utf8'));
    res.json({
      id: save.id,
      slot_name: save.slot_name,
      preview_data: save.preview_data,
      save_data: saveData,
      created_at: save.created_at,
      updated_at: save.updated_at,
      revision: save.revision
    });
  } catch (error) {
    console.error('[API SAVES] Legacy download error:', error);
    res.status(500).json({ error: '读取并解压存档失败', code: 'LEGACY_SAVE_READ_FAILED' });
  }
}));

async function createMultipartSave(req, res) {
  const userId = req.user.id;
  let upload;
  try {
    const currentCount = await db.getUserSaveCount(userId);
    if (currentCount >= config.saves.maxSlots) return rejectFullSlot(req, res);

    upload = await receiveMultipartSave(req);
    const metadata = normalizeMetadata(upload.metadata, { requireSlotName: true });
    const validation = await validateCompressedTimeline(upload.tempPath);
    const saveId = randomUUID();
    const inserted = await db.insertSaveFileWithinUserLimit({
      id: saveId,
      user_id: userId,
      slot_name: metadata.slot_name,
      preview_data: metadata.preview_data || {},
      source_path: upload.tempPath,
      size_bytes: validation.sizeBytes,
      compressed_size_bytes: upload.compressedBytes,
      content_sha256: validation.contentSha256
    }, config.saves.maxSlots);
    if (!inserted) return rejectFullSlot(req, res);

    console.log(`[API SAVES] User ${req.user.username} created save ${saveId}`);
    res.status(201).json({
      id: saveId,
      slot_name: metadata.slot_name,
      revision: 1,
      message: '存档成功保存至云端'
    });
  } catch (error) {
    if (!req.readableEnded && !req.destroyed) req.resume();
    await removeUploadTemp(upload?.tempPath);
    upload = undefined;
    if (sendUploadError(res, error)) return;
    console.error('[API SAVES] Multipart create error:', error);
    res.status(500).json({ error: '保存存档到云端失败', code: 'SAVE_CREATE_FAILED' });
  } finally {
    await removeUploadTemp(upload?.tempPath);
  }
}

async function createLegacySave(req, res) {
  const { slot_name, save_data, preview_data } = req.body || {};
  const userId = req.user.id;
  if (typeof slot_name !== 'string' || !slot_name.trim()) {
    return res.status(400).json({ error: '存档名称必须为非空字符串', code: 'INVALID_SLOT_NAME' });
  }
  const previewError = getPreviewDataError(preview_data);
  if (previewError) return res.status(400).json({ error: previewError, code: 'INVALID_PREVIEW_DATA' });
  const inspection = safelyInspectTimelineSave(save_data);
  if (!inspection.valid) {
    return res.status(400).json({
      error: '存档数据不是有效的时间线存档',
      code: 'INVALID_SAVE_STRUCTURE',
      details: inspection.errors.slice(0, 4)
    });
  }

  try {
    const currentCount = await db.getUserSaveCount(userId);
    if (currentCount >= config.saves.maxSlots) return rejectFullSlot(req, res);
    const jsonString = JSON.stringify(save_data);
    const sizeBytes = Buffer.byteLength(jsonString, 'utf8');
    if (sizeBytes > config.saves.legacyMaxSizeMb * MiB) {
      return res.status(413).json({
        error: `旧版 JSON 上传不得超过 ${config.saves.legacyMaxSizeMb} MiB，请改用 gzip 上传`,
        code: 'GZIP_UPLOAD_REQUIRED'
      });
    }
    const compressedData = await gzip(jsonString);
    const saveId = randomUUID();
    const inserted = await db.insertSaveWithinUserLimit({
      id: saveId,
      user_id: userId,
      slot_name: slot_name.trim().substring(0, 50),
      preview_data: preview_data || {},
      save_data: compressedData,
      size_bytes: sizeBytes,
      content_sha256: createHash('sha256').update(jsonString).digest('hex')
    }, config.saves.maxSlots);
    if (!inserted) return rejectFullSlot(req, res);
    res.status(201).json({ id: saveId, slot_name: slot_name.trim().substring(0, 50), revision: 1, message: '存档成功保存至云端' });
  } catch (error) {
    console.error('[API SAVES] Legacy create error:', error);
    res.status(500).json({ error: '保存存档到云端失败', code: 'SAVE_CREATE_FAILED' });
  }
}

router.post('/', asyncRoute(async (req, res) => {
  if (isMultipartRequest(req)) return createMultipartSave(req, res);
  if (req.is('application/json') || req.is('application/*+json')) return createLegacySave(req, res);
  req.resume();
  return res.status(415).json({ error: '仅支持 multipart/form-data 或 application/json', code: 'UNSUPPORTED_SAVE_MEDIA_TYPE' });
}));

async function updateMultipartSave(req, res, id) {
  let upload;
  try {
    upload = await receiveMultipartSave(req);
    const metadata = normalizeMetadata(upload.metadata, { requireSlotName: false });
    const validation = await validateCompressedTimeline(upload.tempPath);
    const updated = await db.updateSaveFile(id, {
      slot_name: metadata.slot_name,
      preview_data: metadata.preview_data,
      source_path: upload.tempPath,
      size_bytes: validation.sizeBytes,
      compressed_size_bytes: upload.compressedBytes,
      content_sha256: validation.contentSha256,
      expected_revision: metadata.expected_revision
    });
    if (!updated) return res.status(404).json({ error: '未找到指定存档', code: 'SAVE_NOT_FOUND' });
    res.json({ id, revision: updated.revision, message: '云存档已成功覆盖更新' });
  } catch (error) {
    if (!req.readableEnded && !req.destroyed) req.resume();
    await removeUploadTemp(upload?.tempPath);
    upload = undefined;
    if (sendUploadError(res, error)) return;
    console.error('[API SAVES] Multipart update error:', error);
    res.status(500).json({ error: '更新云存档失败', code: 'SAVE_UPDATE_FAILED' });
  } finally {
    await removeUploadTemp(upload?.tempPath);
  }
}

async function updateLegacySave(req, res, id) {
  const { slot_name, save_data, preview_data, expected_revision } = req.body || {};
  if (expected_revision !== undefined && (!Number.isSafeInteger(expected_revision) || expected_revision < 0)) {
    return res.status(400).json({ error: '存档版本无效，请刷新后重试', code: 'INVALID_SAVE_REVISION' });
  }
  if (slot_name !== undefined && (typeof slot_name !== 'string' || !slot_name.trim())) {
    return res.status(400).json({ error: '存档名称必须为非空字符串', code: 'INVALID_SLOT_NAME' });
  }
  const previewError = getPreviewDataError(preview_data);
  if (previewError) return res.status(400).json({ error: previewError, code: 'INVALID_PREVIEW_DATA' });
  if (save_data !== undefined) {
    const inspection = safelyInspectTimelineSave(save_data);
    if (!inspection.valid) {
      return res.status(400).json({
        error: '存档数据不是有效的时间线存档',
        code: 'INVALID_SAVE_STRUCTURE',
        details: inspection.errors.slice(0, 4)
      });
    }
  }

  try {
    const updates = { expected_revision };
    if (slot_name !== undefined) updates.slot_name = slot_name.trim().substring(0, 50);
    if (preview_data !== undefined) updates.preview_data = preview_data;
    if (save_data !== undefined) {
      const jsonString = JSON.stringify(save_data);
      const sizeBytes = Buffer.byteLength(jsonString, 'utf8');
      if (sizeBytes > config.saves.legacyMaxSizeMb * MiB) {
        return res.status(413).json({
          error: `旧版 JSON 上传不得超过 ${config.saves.legacyMaxSizeMb} MiB，请改用 gzip 上传`,
          code: 'GZIP_UPLOAD_REQUIRED'
        });
      }
      updates.save_data = await gzip(jsonString);
      updates.size_bytes = sizeBytes;
      updates.content_sha256 = createHash('sha256').update(jsonString).digest('hex');
    }
    const updated = await db.updateSave(id, updates);
    if (!updated) return res.status(404).json({ error: '未找到指定存档', code: 'SAVE_NOT_FOUND' });
    res.json({ id, revision: updated.revision, message: '云存档已成功覆盖更新' });
  } catch (error) {
    if (sendUploadError(res, error)) return;
    console.error('[API SAVES] Legacy update error:', error);
    res.status(500).json({ error: '更新云存档失败', code: 'SAVE_UPDATE_FAILED' });
  }
}

router.put('/:id', asyncRoute(async (req, res) => {
  const { id } = req.params;
  if (!validateSaveId(id)) return res.status(400).json({ error: '无效的存档 ID', code: 'INVALID_SAVE_ID' });
  let existing;
  try {
    existing = await db.getSaveMetaById(id);
  } catch (error) {
    console.error('[API SAVES] Read update metadata error:', error);
    return res.status(500).json({ error: '更新云存档失败', code: 'SAVE_UPDATE_FAILED' });
  }
  if (!existing) {
    req.resume();
    return res.status(404).json({ error: '未找到指定存档', code: 'SAVE_NOT_FOUND' });
  }
  if (existing.user_id !== req.user.id) {
    req.resume();
    return res.status(403).json({ error: '无权操作此存档', code: 'SAVE_FORBIDDEN' });
  }
  if (isMultipartRequest(req)) return updateMultipartSave(req, res, id);
  if (req.is('application/json') || req.is('application/*+json')) return updateLegacySave(req, res, id);
  req.resume();
  return res.status(415).json({ error: '仅支持 multipart/form-data 或 application/json', code: 'UNSUPPORTED_SAVE_MEDIA_TYPE' });
}));

router.delete('/:id', asyncRoute(async (req, res) => {
  const { id } = req.params;
  if (!validateSaveId(id)) return res.status(400).json({ error: '无效的存档 ID', code: 'INVALID_SAVE_ID' });
  try {
    const save = await db.getSaveMetaById(id);
    if (!save) return res.status(404).json({ error: '未找到指定存档', code: 'SAVE_NOT_FOUND' });
    if (save.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权删除此存档', code: 'SAVE_FORBIDDEN' });
    }
    await db.deleteSave(id);
    res.json({ message: '云存档已成功删除' });
  } catch (error) {
    console.error('[API SAVES] Delete error:', error);
    res.status(500).json({ error: '删除云存档失败', code: 'SAVE_DELETE_FAILED' });
  }
}));

router.use((error, _req, res, next) => {
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({
      error: `旧版 JSON 请求不得超过 ${config.saves.legacyMaxSizeMb} MiB，请改用 gzip 上传`,
      code: 'GZIP_UPLOAD_REQUIRED'
    });
  }
  if (error instanceof SyntaxError && error?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求 JSON 格式无效', code: 'INVALID_JSON' });
  }
  next(error);
});

export default router;
