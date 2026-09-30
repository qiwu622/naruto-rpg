import { escHtml, escAttr } from '../utils/format.js';
import { icon } from '../utils/icons.js';
import { eventBus } from '../core/event-bus.js';
import { stateManager } from '../core/state-manager.js';
import { timelineSystem } from '../systems/timeline-system.js';
import { decodeTimelineSaveFile, TIMELINE_FILE_ACCEPT } from '../core/timeline-file-codec.js';
import { localSaveLibrary, PERSONAL_SAVE_KIND, ROOM_SAVE_KIND } from '../core/save-library.js';
import { personalSaveLibrary } from '../core/personal-save-library.js';
import { saveLibraryCloud } from '../core/save-library-cloud.js';
import { usesProjectServerFeatures, isMultiplayerEntryVisible } from '../core/runtime-platform.js';
import { localRoomHistory } from '../multiplayer/local-room-history.js';
import { saveLibraryStyles, saveLibraryModalStyles } from '../../css/components/save-library-panel.css.js';

export const IF_LINES_KIND = 'if_lines';
const glyph = (name, size = 16) => icon(name, size).replace('<svg', '<svg aria-hidden="true" focusable="false"');
const date = value => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', year: 'numeric' }) : '尚未保存快照';
const size = value => value == null ? '房间记录' : value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(2)} MB`;
const color = value => /^#[\da-f]{3,8}$/i.test(value || '') ? value : '#aab8e7';
let activeModal = null;

function dailyText(value) {
  const daily = Array.isArray(value) ? value.at(-1)?.daily : (value?.daily ?? value);
  if (!daily) return '保存时没有日报。';
  return [daily.date, daily.issue, daily.headline?.title ?? daily.title, daily.headline?.body,
    ...(daily.world ?? []).map(item => `${item.title}\n${item.text}`),
    ...(daily.flavor ?? []).map(item => `${item.title}\n${item.text}`),
    ...(daily.missions ?? []).map(item => `${item.rank} 级 · ${item.task} · ${item.pay} · ${item.status}`), daily.quote?.text
  ].filter(Boolean).join('\n\n') || '保存时没有可显示的日报。';
}

export async function chooseRoomExit() {
  await import('./modal.js');
  return new Promise(resolve => {
    const modal = document.createElement('game-modal');
    document.body.append(modal);
    modal.show({
      title: '退出联机房间',
      content: '<p>保存后可在本机房间历史中查看快照并重新进入。仅退出会保留之前的存档和房间记录。房间进度仍由服务器保存，对方可以继续保持连接。</p>',
      onDismiss: () => resolve('cancel'),
      buttons: [
        { label: '取消', onClick: () => resolve('cancel') },
        { label: '仅退出', onClick: () => resolve('exit') },
        { label: '保存并退出', primary: true, autofocus: true, onClick: () => resolve('save') }
      ]
    });
  });
}

export async function openSaveLibrary(options = {}) {
  await import('./modal.js');
  if (activeModal?.isConnected) {
    const panel = activeModal.shadowRoot.querySelector('naruto-save-library');
    if (!panel.busy) panel.configure(options);
    return activeModal;
  }
  const modal = document.createElement('game-modal');
  document.body.append(modal);
  modal.show({ title: '存档库', wide: true, content: '<naruto-save-library></naruto-save-library>', onDismiss: () => { if (activeModal === modal) activeModal = null; } });
  const style = document.createElement('style');
  style.textContent = saveLibraryModalStyles;
  modal.shadowRoot.append(style);
  activeModal = modal;
  modal.shadowRoot.querySelector('naruto-save-library').configure({ ...options, onLoaded: () => modal.close(), onClose: () => modal.close() });
  return modal;
}

class SaveLibraryPanel extends (globalThis.HTMLElement ?? class {}) {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.kind = PERSONAL_SAVE_KIND;
    this.busy = false;
    this.entries = [];
    this.branches = [];
    this.nodes = [];
  }

  configure({ kind = PERSONAL_SAVE_KIND, roomsOnly = false, connectRoom = null, fromNodeId = null, cloud = false, onLoaded, onClose } = {}) {
    Object.assign(this, { kind: roomsOnly ? ROOM_SAVE_KIND : kind, roomsOnly, connectRoom, fromNodeId });
    this.cloudView = cloud && usesProjectServerFeatures() && this.kind === PERSONAL_SAVE_KIND;
    if (onLoaded) this.onLoaded = onLoaded;
    if (onClose) this.onClose = onClose;
    if (![PERSONAL_SAVE_KIND, ROOM_SAVE_KIND, IF_LINES_KIND].includes(this.kind)) this.kind = PERSONAL_SAVE_KIND;
    this.render();
    void this.run(async () => {
      await this.refresh();
      if (this.fromNodeId && this.kind === IF_LINES_KIND) await this.createLine(this.fromNodeId);
    });
  }

  get owner() { return this.kind === ROOM_SAVE_KIND ? localRoomHistory.owner : 'device'; }
  $(selector) { return this.shadowRoot.querySelector(selector); }
  $$(selector) { return [...this.shadowRoot.querySelectorAll(selector)]; }

  render() {
    this.shadowRoot.innerHTML = `<style>${saveLibraryStyles}</style>
      <div class="library">
        <header class="header"><div class="seal">${glyph('archive', 27)}</div><div><div class="eyebrow">SHINOBI ARCHIVE</div><h2>存档库</h2><p>收好每段冒险，也留住另一种可能。</p></div><button id="close" class="icon-button close" aria-label="关闭" title="关闭">${glyph('close', 20)}</button></header>
        <nav class="tabs" role="tablist" aria-label="存档分区" ${this.roomsOnly ? 'hidden' : ''}>
          ${[[PERSONAL_SAVE_KIND, 'user', '个人存档'], [IF_LINES_KIND, 'git-branch', 'IF 线'], [ROOM_SAVE_KIND, 'users', '联机房间']].map(([kind, image, text]) => `<button id="tab-${kind}" role="tab" data-kind="${kind}" aria-controls="workspace">${glyph(image)}${text}<span class="count" data-count="${kind}">0</span></button>`).join('')}
        </nav>
        <div id="workspace" class="workspace" role="tabpanel">
          <section id="current" class="current"><div id="current-badge" class="current-badge">忍</div><div id="current-info" class="current-info"></div><div class="current-actions">
            <button id="capture" class="button primary">${glyph('archive')}保存当前个人档</button><button id="create-line" class="button primary">${glyph('plus')}创建 IF 线</button><button id="new-game" class="button quiet">${glyph('plus')}保留旧档并开新档</button><button id="cloud-current" class="button primary" hidden>${glyph('cloud')}上传当前进度</button>
          </div></section>
          <div class="toolbar"><label class="search">${glyph('search')}<input id="search" type="search" aria-label="搜索存档" placeholder="搜索名称、角色或地点…"></label><select id="sort" aria-label="排序"><option value="newest">最近更新</option><option value="oldest">最早创建</option><option value="turn">回合进度</option></select><button id="import" class="button quiet">${glyph('download')}导入到存档库</button><button id="cloud-manager" class="button quiet">${glyph('cloud')}<span>云端管理</span></button><button id="refresh" class="icon-button" aria-label="刷新" title="刷新">${glyph('refresh-cw')}</button><input id="file" type="file" accept="${TIMELINE_FILE_ACCEPT}" hidden></div>
          <p id="hint" class="hint"></p><p id="status" class="status" role="status" aria-live="polite"></p><div id="list" class="list"></div>
          <section id="preview" class="preview" hidden><div class="preview-heading"><h3>本地快照 · 只读</h3><button id="close-preview" class="button quiet small">收起快照</button></div><pre id="snapshot-story"></pre><h4>当时的日报</h4><pre id="snapshot-daily"></pre><details><summary>查看存档中的变量</summary><pre id="snapshot-vars"></pre></details></section>
        </div>
        <footer class="footer"><span id="storage-place">${glyph('database', 13)}保存在当前浏览器与站点</span><span id="storage-note">清除网站数据会删除本机存档，请定期导出备份。</span></footer>
      </div>`;
    this.$('#close').onclick = () => this.onClose?.();
    this.$$('.tabs button').forEach(button => button.onclick = () => this.run(async () => {
      this.kind = button.dataset.kind; this.cloudView = false; this.$('#search').value = ''; this.$('#preview').hidden = true; await this.refresh();
    }));
    this.$('.tabs').onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || this.busy) return;
      const tabs = this.$$('.tabs button');
      const current = tabs.indexOf(this.shadowRoot.activeElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault(); tabs[index].click(); tabs[index].focus();
    };
    this.$('#refresh').onclick = () => this.run(() => this.refresh());
    this.$('#search').oninput = () => this.renderList();
    this.$('#sort').onchange = () => this.renderList();
    this.$('#capture').onclick = () => this.run(async () => {
      const entry = await eventBus.request('app:save-personal');
      if (!entry) throw new Error('当前还没有可保存的个人进度');
      await this.refresh(); this.status('个人档已保存，包含全部 IF 线，可随时读取。');
    });
    this.$('#create-line').onclick = () => this.run(() => this.createLine());
    this.$('#new-game').onclick = () => this.run(async () => { if (await eventBus.request('app:new-personal-save')) this.onLoaded?.(); });
    this.$('#cloud-manager').onclick = () => this.run(async () => {
      this.cloudView = !this.cloudView; this.$('#search').value = ''; this.$('#preview').hidden = true; await this.refresh();
    });
    this.$('#cloud-current').onclick = () => this.run(async () => {
      const entry = await eventBus.request('app:save-personal');
      if (!entry) throw new Error('当前还没有可上传的个人进度');
      await this.uploadCloud(entry);
    });
    this.$('#import').onclick = () => this.$('#file').click();
    this.$('#file').onchange = () => this.run(async () => {
      const file = this.$('#file').files?.[0]; this.$('#file').value = '';
      if (!file) return;
      const data = await decodeTimelineSaveFile(file);
      if (this.kind === ROOM_SAVE_KIND) await localRoomHistory.importPackage(data);
      else { await personalSaveLibrary.importData(data); this.kind = PERSONAL_SAVE_KIND; }
      await this.refresh(); this.status('导入成功，已新增存档，当前进度没有改变。');
    });
    this.$('#list').onclick = event => {
      const button = event.target.closest('button[data-action]');
      if (button && !button.disabled) void this.run(() => this.act(button.dataset.action, button.dataset.id));
    };
    this.$('#close-preview').onclick = () => { this.$('#preview').hidden = true; this.$('#workspace').scrollTop = this.previewScroll || 0; };
  }

  status(message, error = false) { this.$('#status').textContent = message; this.$('#status').dataset.error = String(error); }
  updateDisabled() { this.$$('button,input,select').forEach(element => { element.disabled = this.busy || element.dataset.disabled === 'true'; }); }
  async run(operation) {
    if (this.busy) return;
    this.busy = true; this.status('正在处理…'); this.updateDisabled();
    try { await operation(); if (this.$('#status')?.textContent === '正在处理…') this.status(''); }
    catch (error) { if (this.isConnected) this.status(error.message || String(error), true); }
    finally { this.busy = false; this.updateDisabled(); }
  }

  async refresh() {
    const [personal, rooms, branches, nodes, current] = await Promise.all([
      localSaveLibrary.list(PERSONAL_SAVE_KIND), localRoomHistory.list(), timelineSystem.getAllBranches(), timelineSystem.getAllNodes(), timelineSystem.getCurrentNode()
    ]);
    Object.assign(this, { personal, rooms, branches, nodes, current });
    this.meta = { ...(stateManager.getSub('_meta') || {}) };
    const lines = this.kind === IF_LINES_KIND;
    const inRoom = this.kind === ROOM_SAVE_KIND;
    const cloud = this.cloudView && this.kind === PERSONAL_SAVE_KIND;
    const localApp = !usesProjectServerFeatures();
    this.$('#storage-place').innerHTML = `${glyph(cloud ? 'cloud' : 'database', 13)}${cloud ? '云端副本属于当前登录账号' : localApp ? '保存在本机 App 中' : '保存在当前浏览器与站点'}`;
    this.$('#storage-note').textContent = cloud ? '下载后保存在本机；清除网站数据不会删除云端副本。' : localApp ? '卸载 App 或清除应用数据会删除本地存档，请定期导出备份。' : '清除网站数据会删除本机存档，请定期导出备份。';
    this.entries = lines ? branches : inRoom ? rooms : personal;
    this.$$('.tabs button').forEach(button => {
      const selected = button.dataset.kind === this.kind;
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
    });
    this.$('#workspace').setAttribute('aria-labelledby', `tab-${this.kind}`);
    for (const [kind, count] of [[PERSONAL_SAVE_KIND, personal.length], [IF_LINES_KIND, branches.filter(branch => branch.id !== 'branch_main').length], [ROOM_SAVE_KIND, rooms.length]]) this.$(`[data-count="${kind}"]`).textContent = count;
    this.$('#capture').hidden = inRoom || cloud; this.$('#capture').classList.toggle('primary', !lines);
    this.$('#capture').dataset.disabled = String(!current);
    this.$('#create-line').hidden = !lines; this.$('#create-line').dataset.disabled = String(!current);
    this.$('#new-game').hidden = inRoom || lines || cloud;
    this.$('#cloud-current').hidden = !cloud; this.$('#cloud-current').dataset.disabled = String(!current);
    this.$('#cloud-manager').hidden = inRoom || lines || !usesProjectServerFeatures();
    this.$('#cloud-manager span').textContent = cloud ? '返回本机' : '云端管理';
    this.$('#cloud-manager').setAttribute('aria-pressed', String(cloud));
    this.$('#import').hidden = lines || cloud;
    this.$('#search').placeholder = lines ? '搜索线路名称或备注…' : inRoom ? '搜索房间名称或房间号…' : '搜索名称、角色或地点…';
    const branch = branches.find(item => item.id === this.meta.active_branch);
    const snapshot = current?.state_snapshot ?? {};
    const name = snapshot.player?.name || snapshot['玩家·姓名'] || '忍者冒险';
    const location = snapshot.world_state?.current_location || snapshot['世界·地点'] || '';
    this.$('#current-badge').innerHTML = inRoom ? glyph('users', 22) : lines ? glyph('git-branch', 22) : escHtml(name.slice(0, 1));
    this.$('#current-info').innerHTML = inRoom
      ? `<div class="overline">本账号的联机记录</div><h3>与同伴走过的冒险</h3><p>${rooms.length} 条本机记录 · 保存的快照可离线查看</p>`
      : `<div class="overline"><span class="live-dot"></span>${lines ? '当前个人档 · 线路管理' : '当前冒险'}</div><h3>${current ? escHtml(name) : '新的故事，等待开始'}</h3><p>${current ? `第 ${Number(current.turn_number) || 0} 回合 · ${escHtml(branch?.name || '主线')}${location ? ` · ${escHtml(location)}` : ''}` : '创建角色，或读取已有的个人存档。'}</p>`;
    this.$('#hint').textContent = lines
      ? 'IF 线属于当前个人档，随完整存档一起保存和导出。可从历史回合分叉；切换不会覆盖其他线路，删除或设为主线前自动备份。'
      : inRoom ? (isMultiplayerEntryVisible() ? '仅显示当前账号的房间。快照可离线查看；重新进入需要原站点、原账号和服务器上的房间。' : '联机入口暂时隐藏。已有房间记录仍可查看快照、导出和管理。')
      : '读取或开新档前自动保存当前进度。每份个人档包含完整时间线与 IF 线；读取某份存档后，可在 IF 线页管理其中的线路。';
    if (cloud) {
      this.entries = []; this.renderList();
      this.$('#hint').textContent = '正在获取当前账号的云存档…';
      const remote = await saveLibraryCloud.list();
      this.cloudRecords = remote.saves;
      this.entries = remote.saves.map(entry => ({ ...entry, _cloud: true, label: entry.slot_name, character: entry.preview_data?.name, location: entry.preview_data?.location, turn: entry.preview_data?.turn, branchCount: entry.preview_data?.branch_count, createdAt: Date.parse(entry.created_at) || 0, updatedAt: Date.parse(entry.updated_at) || 0 }));
      this.$('#current-badge').innerHTML = glyph('cloud', 22);
      this.$('#current-info').innerHTML = `<div class="overline">当前账号 · 云端存档</div><h3>${escHtml(remote.user.global_name || remote.user.username || '我的云存档')}</h3><p>${remote.storage ? `${remote.storage.used_slots} / ${remote.storage.max_slots} 个槽位 · 已用 ${size(remote.storage.used_uncompressed_bytes)} · 单份上限 ${size(remote.storage.max_save_bytes)}` : `${remote.saves.length} 份云存档`} · 每份包含全部 IF 线</p>`;
      this.$('#hint').textContent = '云档按登录账号保存。下载先加入本地库，读取前保留当前进度；覆盖或删除云档前，会先保存一份完整本机副本。自动同步继续使用「默认云存档」槽位。';
    }
    this.renderList(); this.updateDisabled();
  }

  actionButton(action, id, label, { image, primary = false, disabled = false, title = label } = {}) {
    const classes = image && !primary ? 'icon-button' : `button small${primary ? ' primary' : ''}`;
    return `<button class="${classes}${action === 'delete' ? ' danger' : ''}" data-action="${action}" data-id="${escAttr(id)}" data-disabled="${disabled}" ${disabled || this.busy ? 'disabled' : ''} aria-label="${escAttr(label)}" title="${escAttr(title)}">${image ? glyph(image) : ''}${image && !primary ? '' : escHtml(label)}</button>`;
  }

  renderList() {
    const query = (this.$('#search').value || '').trim().toLocaleLowerCase();
    const lines = this.kind === IF_LINES_KIND;
    const entries = this.entries.filter(entry => [entry.label, entry.name, entry.description, entry.character, entry.location, entry.roomCode].filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
    const sort = this.$('#sort').value;
    entries.sort((a, b) => sort === 'turn' ? (Number(b.turn ?? this.nodeFor(b)?.turn_number) || 0) - (Number(a.turn ?? this.nodeFor(a)?.turn_number) || 0)
      : sort === 'oldest' ? (a.createdAt ?? a.created_at ?? 0) - (b.createdAt ?? b.created_at ?? 0) : (b.updatedAt ?? b.created_at ?? 0) - (a.updatedAt ?? a.created_at ?? 0));
    if (lines) entries.sort((a, b) => Number(b.id === 'branch_main') - Number(a.id === 'branch_main'));
    this.$('#list').innerHTML = entries.length ? entries.map(entry => lines ? this.lineCard(entry) : this.saveCard(entry)).join('')
      : `<div class="empty"><div class="empty-mark">${glyph(lines ? 'git-branch' : this.cloudView ? 'cloud' : 'archive', 30)}</div><h3>${query ? '没有找到匹配记录' : this.cloudView && this.kind === PERSONAL_SAVE_KIND ? '云端还没有收藏' : lines ? '故事还没有分歧' : this.kind === ROOM_SAVE_KIND ? '还没有房间记录' : '收藏你的第一段冒险'}</h3><p>${query ? '换一个名称、角色或地点再试试。' : this.cloudView && this.kind === PERSONAL_SAVE_KIND ? '上传当前进度，或返回本机，在已有个人存档卡片上选择「上传到云端」。' : lines ? '先创建角色或读取个人存档，即可从任意历史回合开辟 IF 线。' : this.kind === ROOM_SAVE_KIND ? '加入联机房间后，这里会留下本账号的记录。保存并退出，还能留住当时的正文、日报与变量。' : '保存当前进度，或导入旧 JSON / gzip 存档。过去的故事和新的开局可以同时保留。'}</p></div>`;
  }

  nodeFor(branch) { return this.nodes.find(node => node.id === branch.head_node_id); }
  lineCard(branch) {
    const main = branch.id === 'branch_main';
    const active = branch.id === this.meta.active_branch;
    const head = this.nodeFor(branch);
    const origin = this.nodes.find(node => node.id === branch.diverged_from);
    const parent = this.branches.find(item => item.id === origin?.branch_id);
    const latest = active && branch.head_node_id === this.meta.current_node_id;
    const nodeCount = this.nodes.filter(node => node.branch_id === branch.id && !node.branch_anchor).length;
    const button = (action, label, options = {}) => this.actionButton(action, branch.id, label, options);
    return `<article class="entry${active ? ' current-line' : ''}" data-branch-id="${escAttr(branch.id)}" style="--entry-color:${color(branch.color)}">
      <div class="entry-head"><h3>${escHtml(branch.name)}</h3><span class="tag${active ? ' active' : main ? '' : ' if'}">${active ? '当前线路' : main ? '主线' : 'IF 线'}</span></div>
      <div class="metadata"><span>${glyph('timeline', 13)}第 ${Number(head?.turn_number) || 0} 回合</span><span>${nodeCount} 个剧情回合</span></div>
      <div class="branch-route">${glyph('git-branch', 14)}<span title="${escAttr(origin?.summary || '')}">${main ? '故事的主线' : `从「${escHtml(parent?.name || '原线路')}」第 ${Number(branch.diverged_at_turn ?? origin?.turn_number) || 0} 回合分出`}</span></div>
      <p class="excerpt">${escHtml(branch.description || head?.summary || '在这里继续你的另一种选择。')}</p>
      <div class="entry-actions">${button('fork', '从此分叉', { disabled: !head })}${!main ? button('promote', '设为主线', { disabled: origin?.branch_id !== 'branch_main', title: origin?.branch_id === 'branch_main' ? '设为主线' : '请先将上级 IF 线设为主线' }) : ''}</div>
      <div class="entry-footer">${button('switch', latest ? '当前线路' : active ? '回到最新进度' : '切换', { primary: true, disabled: latest || !head })}<div class="entry-ops">${button('rename', '编辑线路', { image: 'pencil' })}${!main ? button('delete', '删除 IF 线', { image: 'trash' }) : ''}</div></div><p class="entry-time">创建于 ${escHtml(date(branch.created_at))}</p></article>`;
  }

  saveCard(entry) {
    if (entry._cloud) return this.cloudCard(entry);
    const rooms = this.kind === ROOM_SAVE_KIND;
    const button = (action, label, options = {}) => this.actionButton(action, entry.id, label, options);
    const backup = String(entry.reason || '').startsWith('before-') || entry.reason === 'library-open';
    return `<article class="entry" data-save-id="${escAttr(entry.id)}"${rooms ? ' style="--entry-color:#77bca6"' : ''}>
      <div class="entry-head"><h3>${escHtml(entry.label)}</h3><span class="tag">${rooms ? '联机' : backup ? '自动备份' : '个人档'}</span></div>
      <div class="metadata"><span>${glyph(rooms ? 'users' : 'user', 13)}${rooms ? `玩家 ${escHtml(entry.seat || '—')}` : escHtml(entry.character || '忍者冒险')}</span><span>第 ${Number(entry.turn) || 0} 回合</span>${rooms ? '' : `<span>${entry.branchCount == null ? '完整时间线' : `${Number(entry.branchCount) || 0} 条 IF 线`}</span>`}</div>
      <p class="excerpt">${rooms ? `${escHtml(entry.roomCode || '')} · ${entry.snapshotAt ? '已保存正文、日报与可见变量快照' : '仅房间历史，尚未保存快照'}` : [entry.location, entry.branchName, entry.summary].filter(Boolean).map(escHtml).join(' · ') || '完整时间线已保存，可读取后继续冒险。'}</p>
      <div class="entry-footer">${!rooms || isMultiplayerEntryVisible() ? button('load', rooms ? '重新进入' : '读取', { primary: true, image: rooms ? 'users' : 'archive' }) : ''}<div class="entry-ops">${entry.snapshotAt ? button('preview', '查看快照', { image: 'zen' }) : ''}${button('rename', '改名', { image: 'pencil' })}${entry.snapshotAt ? button('export', '导出', { image: 'export' }) : ''}${!rooms && usesProjectServerFeatures() ? button('cloud', '上传到云端', { image: 'cloud' }) : ''}${button('delete', '删除本地记录', { image: 'trash' })}</div></div>
      <p class="entry-time">${escHtml(date(entry.snapshotAt || entry.updatedAt))} · ${size(entry.bytes)}</p></article>`;
  }

  async act(action, id) {
    if (this.cloudView && this.kind === PERSONAL_SAVE_KIND) return this.actCloud(action, id);
    if (this.kind === IF_LINES_KIND) {
      const branch = this.branches.find(item => item.id === id);
      if (!branch) throw new Error('线路不存在，请刷新后重试');
      if (action === 'fork') return this.createLine(branch.head_node_id);
      let fields = {};
      if (action === 'rename') { fields = await this.editLine(branch); if (!fields) return; }
      const changed = await eventBus.request('app:if-line-action', { action, branchId: id, ...fields });
      await this.refresh();
      if (changed !== false) this.status(action === 'delete' || action === 'promote' ? '线路已更新。操作前的完整备份保存在个人存档中。' : action === 'rename' ? '线路名称和备注已保存。' : '已切换线路，可关闭存档库继续冒险。');
      return;
    }
    const entry = await localSaveLibrary.get(id, this.kind, this.owner);
    if (action === 'cloud') return this.uploadCloud(entry);
    if (action === 'load') {
      if (this.kind === ROOM_SAVE_KIND && !isMultiplayerEntryVisible()) return;
      if (this.kind === ROOM_SAVE_KIND) await localRoomHistory.resume(id, this.connectRoom || (roomId => eventBus.request('app:open-multiplayer', { roomId })));
      else await eventBus.request('app:load-personal-save', { id });
      this.onLoaded?.();
    } else if (action === 'preview') {
      const pack = await localSaveLibrary.readPackage(id, this.kind, this.owner);
      const room = this.kind === ROOM_SAVE_KIND;
      const node = room ? null : pack.payload.nodes.find(item => item.id === pack.payload.meta.value.current_id);
      const publication = room ? pack.payload.publication : null;
      this.$('#snapshot-story').textContent = room ? publication?.narratives?.map(item => item.text).join('\n\n') || '保存时尚未发布正文。' : node?.clean_response || node?.ai_response_summary || node?.summary || '这个检查点未保存正文。';
      this.$('#snapshot-daily').textContent = dailyText(room ? publication?.daily : node?.shinobi_daily);
      this.$('#snapshot-vars').textContent = JSON.stringify(room ? publication?.state ?? {} : node?.state_snapshot ?? {}, null, 2);
      this.previewScroll = this.$('#workspace').scrollTop;
      this.$('#preview').hidden = false; this.$('#preview').scrollIntoView({ block: 'nearest' });
    } else if (action === 'rename') {
      const label = await this.editName(entry.label);
      if (label !== null) await localSaveLibrary.rename(id, this.kind, this.owner, label);
      await this.refresh();
    } else if (action === 'export') { const result = await localSaveLibrary.export(id, this.kind, this.owner); this.status(result.cancelled ? '已取消导出，原存档仍保留。' : '已导出完整存档文件。'); }
    else if (action === 'delete') {
      const confirmed = await customElements.get('game-modal').confirm({ title: '删除本地存档', message: `删除「${entry.label}」？这不会删除服务器房间、当前游戏进度或其他存档。`, okLabel: '删除', cancelLabel: '取消' });
      if (confirmed) { await localSaveLibrary.remove(id, this.kind, this.owner); await this.refresh(); }
    }
  }

  async createLine(fromNodeId = this.meta.current_node_id) {
    const fields = await this.editLine(null, fromNodeId);
    if (!fields) return;
    await eventBus.request('app:if-line-action', { action: 'create', ...fields });
    await this.refresh(); this.status('IF 线已创建并切换到分歧起点，可关闭存档库继续冒险。');
  }

  editLine(branch, fromNodeId) {
    const ordered = [...this.nodes].sort((a, b) => a.turn_number - b.turn_number || a.created_at - b.created_at);
    const choices = ordered.filter(node => !node.branch_anchor).map(node => {
      const line = this.branches.find(item => item.id === node.branch_id);
      return `<option value="${escAttr(node.id)}"${node.id === fromNodeId ? ' selected' : ''}>第 ${Number(node.turn_number) || 0} 回合 · ${escHtml(line?.name || '主线')} · ${escHtml(String(node.summary || '').slice(0, 70))}</option>`;
    });
    const anchor = ordered.find(node => node.id === fromNodeId && node.branch_anchor);
    if (anchor) choices.push(`<option value="${escAttr(anchor.id)}" selected>第 ${Number(anchor.turn_number) || 0} 回合 · 当前 IF 起点</option>`);
    return this.form({ title: branch ? '编辑线路' : '创建 IF 线', label: branch ? '保存' : '创建并切换', content: `
      <label>线路名称<input id="line-name" required maxlength="80" value="${escAttr(branch?.name || '')}" placeholder="例如：留在木叶的那条路"></label>
      ${branch ? '' : `<label>分歧起点<select id="line-origin">${choices.join('')}</select></label>`}
      <label>备注 <span>（选填）</span><textarea id="line-description" rows="3" maxlength="500" placeholder="记下这条线想尝试的选择…">${escHtml(branch?.description || '')}</textarea></label>
      ${branch ? '' : '<p>从所选回合的状态继续，不新增剧情回合，原线路的后续进度会保留。</p>'}`, read: root => ({ name: root.querySelector('#line-name').value.trim(), description: root.querySelector('#line-description').value.trim(), ...(branch ? {} : { fromNodeId: root.querySelector('#line-origin').value }) }) });
  }

  editName(value, maxLength = 100) {
    return this.form({ title: '存档名称', label: '保存', content: `<label>名称<input id="save-name" required maxlength="${maxLength}" value="${escAttr(value)}"></label>`, read: root => root.querySelector('#save-name').value.trim() });
  }

  cloudCard(entry) {
    const button = (action, label, options = {}) => this.actionButton(action, entry.id, label, options);
    return `<article class="entry" data-cloud-id="${escAttr(entry.id)}" style="--entry-color:#83b6d4"><div class="entry-head"><h3>${escHtml(entry.label)}</h3><span class="tag">${entry.slot_name === '默认云存档' ? '自动同步' : '云端'}</span></div><div class="metadata"><span>${glyph('user', 13)}${escHtml(entry.character || '忍者冒险')}</span><span>${entry.turn == null ? '已保存进度' : `第 ${Number(entry.turn) || 0} 回合`}</span>${entry.branchCount == null ? '' : `<span>${Number(entry.branchCount) || 0} 条 IF 线</span>`}</div><p class="excerpt">${escHtml(entry.location || '完整个人时间线')} · ${escHtml(entry.preview_data?.branch_name || '下载后可管理其中的 IF 线')}</p><div class="entry-footer">${button('load', '读取云档', { primary: true, image: 'cloud' })}<div class="entry-ops">${button('download', '下载到本地存档库', { image: 'download' })}${button('rename', '云档改名', { image: 'pencil' })}${button('delete', '删除云档', { image: 'trash' })}</div></div><p class="entry-time">${escHtml(date(entry.updated_at))} · ${size(entry.compressed_size_bytes || entry.size_bytes)}</p></article>`;
  }

  async uploadCloud(entry) {
    this.status('正在获取云端槽位…');
    const remote = await saveLibraryCloud.list();
    const choices = remote.saves.map(save => `<option value="${escAttr(save.id)}">覆盖「${escHtml(save.slot_name)}」</option>`).join('');
    const fields = await this.form({ title: '上传个人存档到云端', label: '上传', content: `<label>云端名称<input id="cloud-name" required maxlength="50" value="${escAttr(entry.label.slice(0, 50))}"></label><label>保存位置<select id="cloud-target"><option value="">新建云端槽位</option>${choices}</select></label><p>包含此档全部 IF 线。选择覆盖已有槽位时，会先将旧云档保存到本机；备份失败将停止上传。</p>`, read: root => ({ slotName: root.querySelector('#cloud-name').value.trim(), saveId: root.querySelector('#cloud-target').value }) });
    if (!fields) { this.status(''); return; }
    this.status('正在上传完整存档到云端…');
    await saveLibraryCloud.upload(entry.id, fields);
    await this.refresh(); this.status(`「${fields.slotName}」已上传，全部 IF 线一同保留。`);
  }

  async actCloud(action, id) {
    const entry = this.entries.find(item => item.id === id);
    if (!entry) throw new Error('云档列表已变化，请刷新后重试');
    if (action === 'load' || action === 'download') {
      this.status('正在下载并校验云存档…');
      const local = await saveLibraryCloud.download(id);
      if (action === 'load') { await eventBus.request('app:load-personal-save', { id: local.id }); this.onLoaded?.(); }
      else { this.cloudView = false; await this.refresh(); this.status(`「${entry.label}」已加入本地存档库，当前游戏进度没有改变。`); }
    } else if (action === 'rename') {
      const name = await this.editName(entry.label, 50);
      if (name !== null) { await saveLibraryCloud.rename(id, name); await this.refresh(); this.status('云存档名称已更新，正文与 IF 线没有改变。'); }
    } else if (action === 'delete') {
      const confirmed = await customElements.get('game-modal').confirm({ title: '删除云存档', message: `删除「${entry.label}」？将先下载完整副本到本地存档库，再删除云端副本。备份失败时保留云档。`, okLabel: '备份并删除云档', cancelLabel: '取消' });
      if (confirmed) { this.status('正在备份云档到本机…'); await saveLibraryCloud.remove(id); await this.refresh(); this.status('云端副本已删除，完整备份保留在本地存档库。'); }
    }
  }

  form({ title, label, content, read }) {
    return new Promise(resolve => {
      const modal = document.createElement('game-modal');
      let settled = false;
      const finish = result => { if (!settled) { settled = true; resolve(result); } };
      document.body.append(modal);
      modal.show({ title, content: `<style>.save-form{display:grid;gap:16px}.save-form label{display:grid;gap:6px;color:#d8d2c7}.save-form input,.save-form select,.save-form textarea{width:100%;box-sizing:border-box;background:#0b1118;color:#e8e4d9;border:1px solid #ffffff24;border-radius:7px;padding:10px;font:inherit}.save-form p,.save-form span{color:#999fA7;font-size:12px}.save-form textarea{resize:vertical}</style><form class="save-form">${content}</form>`, onDismiss: () => finish(null), buttons: [
        { label: '取消', onClick: () => finish(null) },
        { label, primary: true, close: false, onClick: () => {
          const input = modal.shadowRoot.querySelector('input');
          input.setCustomValidity(input.value.trim() ? '' : '请输入名称');
          if (!modal.shadowRoot.querySelector('form').reportValidity()) return;
          finish(read(modal.shadowRoot)); modal.close();
        } }
      ] });
      modal.shadowRoot.querySelector('form').onsubmit = event => { event.preventDefault(); modal.shadowRoot.querySelector('.btn-p').click(); };
      requestAnimationFrame(() => modal.shadowRoot.querySelector('input')?.focus());
    });
  }
}

if (globalThis.customElements && !customElements.get('naruto-save-library')) customElements.define('naruto-save-library', SaveLibraryPanel);
