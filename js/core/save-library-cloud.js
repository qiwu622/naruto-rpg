import { cloudSave } from './cloud-save.js';
import { authClient } from './auth-client.js';
import { usesProjectServerFeatures } from './runtime-platform.js';
import { localSaveLibrary, PERSONAL_SAVE_KIND } from './save-library.js';
import { personalSaveLibrary } from './personal-save-library.js';
import { decodeTimelineSaveFile } from './timeline-file-codec.js';

export class SaveLibraryCloud {
  constructor({ client = cloudSave, auth = authClient, library = localSaveLibrary, personal = personalSaveLibrary } = {}) {
    Object.assign(this, { client, auth, library, personal });
  }

  async requireUser() {
    if (!usesProjectServerFeatures()) throw new Error('当前 App 使用本地存档，云端管理请在网页版打开');
    const user = await this.auth.checkAuth(true);
    if (!user?.id) throw new Error('请先登录，再管理当前账号的云存档');
    return user;
  }

  async list() {
    const user = await this.requireUser();
    const [saves, storage] = await Promise.all([this.client.listSaves(), this.client.getStorage()]);
    return { user, saves, storage };
  }

  async owned(saveId) {
    await this.requireUser();
    const saves = await this.client.listSaves();
    const entry = saves.find(item => item.id === saveId);
    if (!entry) throw new Error('当前账号找不到这份云档，请刷新后重试');
    return entry;
  }

  async download(saveId) {
    const entry = await this.owned(saveId);
    const data = await decodeTimelineSaveFile(await this.client.downloadSave(saveId));
    // Cloud APIs accept a raw timeline. The local library supplies its checked
    // package/checksum and validates the restore before it accepts that data.
    return this.personal.importData(data, entry.slot_name);
  }

  async upload(localId, { saveId = '', slotName } = {}) {
    const name = String(slotName || '').trim();
    if (!name || name.length > 50) throw new Error('云存档名称需要 1 至 50 个字');
    await this.requireUser();
    const entry = await this.library.get(localId, PERSONAL_SAVE_KIND);
    const pack = await this.library.readPackage(localId, PERSONAL_SAVE_KIND);
    const data = this.personal.normalize(pack.payload);
    const preview = { name: entry.character || '', location: entry.location || '', time: Date.now(), turn: entry.turn, branch_count: data.branches.filter(branch => branch.id !== 'branch_main').length, branch_name: entry.branchName || '', source_save_id: localId };
    if (saveId) {
      await this.owned(saveId);
      // An old cloud version must reach the local library before overwrite.
      // Network, corruption or disk-full failures stop here and keep cloud data.
      await this.download(saveId);
      return this.client.updateSave(saveId, name, data, preview);
    }
    return this.client.uploadSave(name, data, preview);
  }

  async rename(saveId, slotName) {
    await this.owned(saveId);
    const name = String(slotName || '').trim();
    if (!name || name.length > 50) throw new Error('云存档名称需要 1 至 50 个字');
    return this.client.renameSave(saveId, name);
  }

  async remove(saveId) {
    await this.download(saveId); // preserve a validated local copy first
    return this.client.deleteSave(saveId);
  }
}

export const saveLibraryCloud = new SaveLibraryCloud();
