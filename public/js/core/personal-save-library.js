import { timelineSystem } from '../systems/timeline-system.js';
import { assertTimelineSave } from './timeline-save-schema.js';
import { buildContinuationCopy, continuationSaveScope } from './continuation-save.js';
import {
  localSaveLibrary, PERSONAL_SAVE_KIND, SAVE_PACKAGE_SCHEMA,
  cleanSaveData, createSavePackage, validateSavePackage
} from './save-library.js';

export class PersonalSaveLibrary {
  constructor({ library = localSaveLibrary, timeline = timelineSystem } = {}) {
    this.library = library;
    this.timeline = timeline;
    this._operation = null;
  }

  // A single tab cannot clear/switch while a second library operation is taking
  // a snapshot. Web Locks also serialize cooperating tabs of this origin.
  async exclusive(operation) {
    if (this._operation) throw new Error('另一项存档操作正在进行，请稍候');
    this._operation = Promise.resolve().then(() => globalThis.navigator?.locks
      ? navigator.locks.request('naruto-personal-save-switch', operation) : operation());
    try { return await this._operation; } finally { this._operation = null; }
  }

  normalize(data) {
    const clean = cleanSaveData(data);
    // Validate restore before accepting a file into the library, and keep
    // signed multiplayer lineage outside the agent-visible timeline metadata.
    const normalized = this.timeline.normalizeImportForArchive(clean);
    const result = { ...normalized, export_version: '2.0', include_archive: true };
    delete result.exported_at; // equal snapshots deduplicate across backup operations
    assertTimelineSave(result);
    return result;
  }

  async store(data, { label = '', reason = 'manual' } = {}) {
    const payload = this.normalize(data);
    const current = payload.nodes.find(node => node.id === payload.meta.value.current_id);
    const snapshot = current?.state_snapshot ?? {};
    const name = snapshot.player?.name || snapshot['玩家·姓名'] || '忍者冒险';
    const pack = await createSavePackage(PERSONAL_SAVE_KIND, payload, label || `${name} · 第 ${current?.turn_number ?? 1} 回合`);
    const existing = (await this.library.list(PERSONAL_SAVE_KIND)).find(entry => entry.checksum === pack.checksum.value);
    if (existing && reason !== 'manual') return existing;
    return this.library.put({
      id: `solo:${crypto.randomUUID()}`, kind: PERSONAL_SAVE_KIND, owner: 'device',
      label: pack.label, reason, rootId: payload.meta.value.root_id,
      turn: current?.turn_number ?? 0, character: name,
      location: snapshot.world_state?.current_location || snapshot['世界·地点'] || '',
      nodeCount: payload.nodes.length,
      continuation: continuationSaveScope(payload),
      branchCount: payload.branches.filter(branch => branch.id !== 'branch_main').length,
      branchName: payload.branches.find(branch => branch.id === payload.meta.value.active_branch)?.name || '主线',
      gameTime: current?.game_time || '', summary: String(current?.summary || '').slice(0, 220)
    }, pack);
  }

  async capture({ label = '', reason = 'manual' } = {}) {
    const data = await this.timeline.getExportData({ includeArchive: true });
    if (!data.nodes?.length) return null;
    return this.store(data, { label, reason });
  }

  async createContinuation({ sourceId = '', keepTurns = 50, label = '', onProgress = () => {} } = {}) {
    return this.exclusive(async () => {
      let data, source;
      if (sourceId) {
        onProgress('正在读取并校验原存档…');
        source = await this.library.get(sourceId, PERSONAL_SAVE_KIND);
        data = this.normalize((await this.library.readPackage(sourceId, PERSONAL_SAVE_KIND)).payload);
      } else {
        onProgress('正在保存当前完整时间线与 IF 线…');
        data = await this.timeline.getExportData({ includeArchive: true, onProgress });
        if (!data.nodes?.length) throw new Error('当前还没有可续玩的个人进度');
        // The original must commit before producing a reduced copy. Disk or
        // validation failures propagate and leave the working game untouched.
        source = await this.store(data, { reason: 'before-continuation' });
        data = this.normalize(data);
      }
      onProgress('正在保留近期正文、回退状态与历史记忆…');
      const copy = buildContinuationCopy(data, { keepTurns, sourceId: source.id, sourceLabel: source.label });
      const entry = await this.store(copy, { label: label || `${source.label} · 轻量续玩`, reason: 'continuation' });
      return { entry, source };
    });
  }

  async importData(data, label = '') {
    if (data?.schema === SAVE_PACKAGE_SCHEMA) {
      await validateSavePackage(data);
      if (data.kind !== PERSONAL_SAVE_KIND) throw new Error('这是联机房间档，请在联机房间分区导入');
      return this.store(data.payload, { label: label || data.label, reason: 'import' });
    }
    if (String(data?.schema ?? '').startsWith('naruto.save-package/')) throw new Error('不支持的存档包版本');
    return this.store(data, { label, reason: 'import' });
  }

  async load(id) {
    return this.exclusive(async () => {
      const pack = await this.library.readPackage(id, PERSONAL_SAVE_KIND);
      const data = this.normalize(pack.payload);
      await this.capture({ reason: 'before-load' });
      return this.timeline.importTimeline(data, { mode: 'overwrite' });
    });
  }

  async startNew() {
    return this.exclusive(async () => {
      await this.capture({ reason: 'before-new-game' });
      await this.timeline.emergencyReset();
    });
  }
}

export const personalSaveLibrary = new PersonalSaveLibrary();
