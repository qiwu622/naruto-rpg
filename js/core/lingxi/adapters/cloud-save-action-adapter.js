import { stateManager as defaultStateManager } from '../../state-manager.js';
import { cloudSave as defaultCloudSave } from '../../cloud-save.js';
import { timelineSystem as defaultTimelineSystem } from '../../../systems/timeline-system.js';
import { decodeTimelineSaveFile } from '../../timeline-file-codec.js';
import {
  LingXiActionError,
  canonicalStringify,
  createActionProposal,
  fingerprintValue,
  hashCanonical,
  verifyActionProposal
} from '../action-proposal.js';
import { consumeBrokerApprovedProposal } from '../approval-broker.js';
import { LINGXI_ACTION_IMPACT_SCHEMA } from './project-write-adapters.js';

export const LINGXI_CLOUD_SAVE_ACTION_TOOL = 'stage_cloud_save_action';
export const LINGXI_CLOUD_SAVE_IMPACT_KIND = 'cloud-save';

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ACTIONS = new Set(['upload', 'overwrite', 'delete', 'restore']);
const MAX_SLOT_NAME = 80;
const MAX_SAVE_ID = 240;
const MAX_REASON = 500;

function fail(code, message, details = null) {
  throw new LingXiActionError(code, message, details);
}

function clone(value) {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanText(value, label, max, { required = true } = {}) {
  if (typeof value !== 'string') {
    if (!required && (value === undefined || value === null)) return '';
    fail('LINGXI_CLOUD_SAVE_INVALID', `${label}必须是文本`);
  }
  const result = String(value || '').replace(/\u0000/g, '').trim();
  if ((required && !result) || result.length > max) {
    fail('LINGXI_CLOUD_SAVE_INVALID', `${label}必须是${required ? '非空' : ''}且不超过 ${max} 个字符的文本`);
  }
  return result;
}

function normalizeParams(params) {
  if (!isRecord(params)) fail('LINGXI_CLOUD_SAVE_INVALID', '云存档操作参数必须是对象');
  for (const key of Object.keys(params)) {
    if (FORBIDDEN_KEYS.has(key) || !['action', 'slotName', 'saveId', 'reason'].includes(key)) {
      fail('LINGXI_CLOUD_SAVE_INVALID', `云存档操作包含不支持的字段: ${key}`);
    }
  }
  const action = cleanText(params.action, '云存档操作', 40);
  if (!ACTIONS.has(action)) {
    fail('LINGXI_CLOUD_SAVE_INVALID', `不支持的云存档操作: ${action}`);
  }
  const reason = cleanText(params.reason, '操作原因', MAX_REASON);
  if (action === 'upload') {
    if (params.saveId !== undefined) fail('LINGXI_CLOUD_SAVE_INVALID', 'upload 操作不接受 saveId');
    return { action, slotName: cleanText(params.slotName, '存档槽位名', MAX_SLOT_NAME), reason };
  }
  if (params.slotName !== undefined) fail('LINGXI_CLOUD_SAVE_INVALID', `${action} 操作不接受 slotName`);
  return { action, saveId: cleanText(params.saveId, '云存档 ID', MAX_SAVE_ID), reason };
}

function pointerSegment(value) {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1');
}

function publicSaveMeta(save) {
  if (!save || typeof save !== 'object') return null;
  const preview = save.preview_data && typeof save.preview_data === 'object' ? save.preview_data : {};
  return {
    id: String(save.id || '').slice(0, MAX_SAVE_ID),
    slotName: String(save.slot_name || '').slice(0, MAX_SLOT_NAME),
    sizeBytes: Number.isFinite(Number(save.size_bytes)) ? Math.max(0, Number(save.size_bytes)) : 0,
    revision: Number.isFinite(Number(save.revision)) ? Math.max(0, Number(save.revision)) : 0,
    createdAt: String(save.created_at || '').slice(0, 60),
    updatedAt: String(save.updated_at || '').slice(0, 60),
    preview: {
      name: String(preview.name ?? '').slice(0, 120),
      location: String(preview.location ?? '').slice(0, 120),
      time: Number.isFinite(Number(preview.time)) ? Number(preview.time) : 0
    }
  };
}

async function defaultBuildSaveSnapshot(timelineSystem, stateManager) {
  const data = timelineSystem.supportsArchiveStorage?.()
    ? { timelineGzip: (await timelineSystem.exportCurrentStream({ compression: 'gzip' })).blob }
    : await timelineSystem.getExportData({ includeArchive: false });
  const state = stateManager?.get?.() || {};
  return {
    saveData: data,
    previewData: {
      name: state.player?.name || stateManager?.get?.('玩家·姓名') || '未知',
      location: state.world_state?.current_location || stateManager?.get?.('世界·地点') || '未知',
      time: Date.now()
    }
  };
}

export class CloudSaveActionAdapter {
  #approvalPermit = null;

  constructor({
    cloudSave = defaultCloudSave,
    timelineSystem = defaultTimelineSystem,
    stateManager = defaultStateManager,
    buildSaveSnapshot = null
  } = {}) {
    if (typeof cloudSave?.listSaves !== 'function'
      || typeof cloudSave?.uploadSave !== 'function'
      || typeof cloudSave?.updateSave !== 'function'
      || typeof cloudSave?.deleteSave !== 'function'
      || typeof cloudSave?.downloadSave !== 'function'
      || typeof timelineSystem?.getExportData !== 'function'
      || typeof timelineSystem?.importTimeline !== 'function') {
      fail('LINGXI_ADAPTER_INVALID', '云存档适配器需要云存档客户端与时间线读写能力');
    }
    this.cloudSave = cloudSave;
    this.timelineSystem = timelineSystem;
    this.stateManager = stateManager;
    this.buildSaveSnapshot = typeof buildSaveSnapshot === 'function'
      ? buildSaveSnapshot
      : () => defaultBuildSaveSnapshot(timelineSystem, stateManager);
    this.toolName = LINGXI_CLOUD_SAVE_ACTION_TOOL;
  }

  bindApprovalPermit(permit) {
    if (!permit || typeof permit !== 'object') fail('LINGXI_ADAPTER_INVALID', '审批许可必须是不透明对象');
    if (this.#approvalPermit && this.#approvalPermit !== permit) {
      fail('LINGXI_ADAPTER_INVALID', '云存档适配器已绑定到另一个审批 Broker');
    }
    this.#approvalPermit = permit;
  }

  async _authorize(proposal, approvalPermit) {
    const brokerApproved = consumeBrokerApprovedProposal(proposal);
    const directlyBound = this.#approvalPermit && approvalPermit === this.#approvalPermit;
    if (!brokerApproved || (this.#approvalPermit && !directlyBound)) {
      fail('LINGXI_APPROVAL_REQUIRED', '云存档操作只能由绑定的审批 Broker 执行');
    }
    await verifyActionProposal(proposal);
    if (proposal.tool !== this.toolName) {
      fail('LINGXI_PROPOSAL_INVALID', `云存档适配器不能执行 ${proposal.tool}`);
    }
  }

  async _snapshot() {
    const saves = await this.cloudSave.listSaves();
    const raw = {
      saves: (Array.isArray(saves) ? saves : []).map(publicSaveMeta).filter(Boolean)
    };
    return { ...raw, fingerprint: await fingerprintValue(raw) };
  }

  async inspectSaves({ limit = 20 } = {}) {
    const snapshot = await this._snapshot();
    const max = Math.max(1, Math.min(40, Math.trunc(Number(limit) || 20)));
    return {
      saves: snapshot.saves.slice(0, max),
      count: snapshot.saves.length,
      notice: '仅返回云存档元数据；不包含存档正文、用户标识、校验值或下载地址。'
    };
  }

  _prepare(params, snapshot) {
    if (params.action === 'upload') {
      if (snapshot.saves.some(save => save.slotName === params.slotName)) {
        fail('LINGXI_CLOUD_SAVE_SLOT_EXISTS', `槽位「${params.slotName}」已存在，请改用 overwrite 覆盖该云存档`);
      }
      return { params, save: null };
    }
    const save = snapshot.saves.find(item => item?.id === params.saveId);
    if (!save) {
      fail('LINGXI_CLOUD_SAVE_TARGET_UNAVAILABLE', '云存档不存在，请先 inspect_cloud_saves 核对存档 ID');
    }
    return { params, save };
  }

  _diff(prepared, snapshot) {
    const { params } = prepared;
    if (params.action === 'upload') {
      return [{
        path: `/cloudSaves/${pointerSegment(params.slotName)}`,
        operation: 'add',
        before: null,
        after: { slotName: params.slotName, action: 'upload' }
      }];
    }
    const target = {
      slotName: prepared.save.slotName,
      revision: prepared.save.revision,
      updatedAt: prepared.save.updatedAt
    };
    if (params.action === 'overwrite') {
      return [{
        path: `/cloudSaves/${pointerSegment(prepared.save.id)}`,
        operation: 'replace',
        before: target,
        after: { slotName: prepared.save.slotName, action: 'overwrite' }
      }];
    }
    if (params.action === 'delete') {
      return [{
        path: `/cloudSaves/${pointerSegment(prepared.save.id)}`,
        operation: 'remove',
        before: target,
        after: null
      }];
    }
    return [{
      path: `/cloudSaves/${pointerSegment(prepared.save.id)}`,
      operation: 'restore',
      before: { slotName: prepared.save.slotName, revision: prepared.save.revision },
      after: { restoredIntoLocalTimeline: true }
    }];
  }

  async _impact(prepared) {
    const { params } = prepared;
    if (params.action === 'upload') {
      return {
        schema: LINGXI_ACTION_IMPACT_SCHEMA,
        kind: LINGXI_CLOUD_SAVE_IMPACT_KIND,
        summary: `上传新云存档「${params.slotName}」`,
        details: [
          `槽位: ${params.slotName}`,
          '会把当前本地时间线与存档状态上传到云端，生成一个新的云存档记录。',
          '不会修改本地进度；同名校验在生成提案时已完成。'
        ]
      };
    }
    if (params.action === 'overwrite') {
      return {
        schema: LINGXI_ACTION_IMPACT_SCHEMA,
        kind: LINGXI_CLOUD_SAVE_IMPACT_KIND,
        summary: `覆盖云存档「${prepared.save.slotName}」`,
        details: [
          `云存档 ID: ${prepared.save.id}`,
          `覆盖前版本: 第 ${prepared.save.revision} 版，更新于 ${prepared.save.updatedAt || '未知时间'}`,
          '会以当前本地时间线替换该云端存档内容，旧版本将被覆盖。',
          '不会修改本地进度。'
        ]
      };
    }
    if (params.action === 'delete') {
      return {
        schema: LINGXI_ACTION_IMPACT_SCHEMA,
        kind: LINGXI_CLOUD_SAVE_IMPACT_KIND,
        summary: `永久删除云存档「${prepared.save.slotName}」`,
        details: [
          `云存档 ID: ${prepared.save.id}`,
          '删除后该云端存档会被永久移除，无法撤销或找回。',
          '本地进度不受影响。'
        ]
      };
    }
    return {
      schema: LINGXI_ACTION_IMPACT_SCHEMA,
      kind: LINGXI_CLOUD_SAVE_IMPACT_KIND,
      summary: `从云存档「${prepared.save.slotName}」恢复本地进度`,
      details: [
        `云存档 ID: ${prepared.save.id}`,
        `该存档更新于 ${prepared.save.updatedAt || '未知时间'}`,
        '批准后会下载该云存档并以覆盖模式导入本地时间线。',
        '当前未保存的本地进度会丢失；恢复前请确认不需要保留本地进度。'
      ]
    };
  }

  async stage(params, { now = Date.now(), ttlMs } = {}) {
    const normalized = normalizeParams(params);
    const snapshot = await this._snapshot();
    const prepared = this._prepare(normalized, snapshot);
    const diff = this._diff(prepared, snapshot);
    const proposal = await createActionProposal({
      tool: this.toolName,
      params: normalized,
      stateFingerprint: snapshot.fingerprint,
      context: { actionImpact: await this._impact(prepared) },
      diff,
      ttlMs,
      now
    });
    const current = await this._snapshot();
    if (current.fingerprint !== snapshot.fingerprint) {
      fail('LINGXI_PROPOSAL_STALE', '云存档列表在提案生成期间发生了变化');
    }
    return proposal;
  }

  async apply(proposal, approvalPermit) {
    await this._authorize(proposal, approvalPermit);
    const normalized = normalizeParams(proposal.params);
    const before = await this._snapshot();
    if (before.fingerprint !== proposal.stateFingerprint) {
      fail('LINGXI_PROPOSAL_STALE', '云存档列表已经变化，请重新生成提案');
    }
    const prepared = this._prepare(normalized, before);
    const diff = this._diff(prepared, before);
    if (await hashCanonical(diff) !== proposal.diffHash) {
      fail('LINGXI_PROPOSAL_TAMPERED', '云存档操作的重新计算差异与已批准提案不一致');
    }

    let result;
    let slotName = normalized.action === 'upload' ? normalized.slotName : prepared.save.slotName;
    if (normalized.action === 'upload' || normalized.action === 'overwrite') {
      const { saveData, previewData } = await this.buildSaveSnapshot();
      result = normalized.action === 'upload'
        ? await this.cloudSave.uploadSave(normalized.slotName, saveData, previewData)
        : await this.cloudSave.updateSave(prepared.save.id, prepared.save.slotName, saveData, previewData);
    } else if (normalized.action === 'delete') {
      result = await this.cloudSave.deleteSave(prepared.save.id);
    } else {
      const file = await this.cloudSave.downloadSave(prepared.save.id);
      const data = await decodeTimelineSaveFile(file);
      result = await this.timelineSystem.importTimeline(data, { mode: 'overwrite' });
    }

    const after = await this._snapshot();
    if (normalized.action !== 'restore' && canonicalStringify(after.saves) === canonicalStringify(before.saves)) {
      fail('LINGXI_CLOUD_SAVE_FAILED', '云存档执行后没有产生预期变化');
    }
    const resultSaveId = String(result?.id || (normalized.action === 'restore' ? prepared.save.id : '')).slice(0, MAX_SAVE_ID);
    return {
      schema: 'naruto.lingxi-action-receipt/v1',
      proposalId: proposal.id,
      tool: proposal.tool,
      appliedAt: Date.now(),
      beforeFingerprint: proposal.stateFingerprint,
      afterFingerprint: after.fingerprint,
      diff: clone(diff),
      summary: `云存档操作已完成: ${normalized.action}`,
      result: {
        action: normalized.action,
        slotName: String(slotName || '').slice(0, MAX_SLOT_NAME),
        saveId: resultSaveId
      }
    };
  }
}

export function createCloudSaveActionAdapter(options = {}) {
  return new CloudSaveActionAdapter(options);
}

export default CloudSaveActionAdapter;
