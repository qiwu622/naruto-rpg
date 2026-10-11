import { timelineStorageTask } from './core/timeline-storage-client.js';
import { exportFile } from './core/file-export.js';

const $ = selector => document.querySelector(selector);
let controller;
const progress = message => { $('#status').textContent = message; $('#status').classList.remove('error'); };
function task(action, options = {}) {
  return timelineStorageTask(action, options, { onProgress: progress, signal: controller?.signal });
}
async function refresh() {
  const { meta, archives } = await task('status');
  $('#current').textContent = meta?.value ? `当前档案共 ${meta.value.total_nodes || '—'} 个回合节点。原档的全部线路都将保留。` : '当前没有正在游玩的档案。保留的原档仍可在下方查看。';
  $('#archives').replaceChildren();
  for (const entry of archives.filter(item => item.complete).sort((a, b) => b.createdAt - a.createdAt)) {
    const card = document.createElement('article'); card.className = 'archive';
    const title = document.createElement('h3'); title.textContent = entry.label;
    const detail = document.createElement('p'); detail.textContent = `${entry.nodeCount} 个节点 · ${entry.branchCount} 条 IF 线 · ${new Date(entry.createdAt).toLocaleString()}`;
    const actions = document.createElement('div'); actions.className = 'actions';
    for (const [label, run] of [
      ['导出备份', async () => { const encoded = await task('export', { id: entry.id }); const download = await exportFile(encoded.blob, `原档备份-${entry.id.slice(8, 16)}${encoded.extension}`); progress(download.cancelled ? '已取消导出，原档仍保留。' : '备份文件已准备好，原档仍保留。'); }],
      ['生成续玩副本', () => rescue(entry)],
      ['选择其他恢复点', async () => {
        const candidates = await task('candidates', { id: entry.id });
        const select = document.createElement('select'); select.setAttribute('aria-label', '恢复回合');
        for (const node of candidates) { const option = document.createElement('option'); option.value = node.id; option.textContent = `第 ${node.turn} 回 · ${node.summary || node.branch}`; select.append(option); }
        const button = document.createElement('button'); button.textContent = '从此处生成续玩'; button.onclick = () => operation(() => rescue(entry, select.value));
        const row = document.createElement('div'); row.className = 'actions'; row.append(select, button); card.append(row);
        progress('选择恢复点后生成新副本，原档和其他线路保留。');
      }],
      ['读取原档', async () => { await task('restore', { id: entry.id }); progress('已恢复原档；切换前的进度也已备份。可以返回游戏。'); await refresh(); }]
    ]) { const button = document.createElement('button'); button.textContent = label; button.onclick = () => operation(run); actions.append(button); }
    card.append(title, detail, actions); $('#archives').append(card);
  }
  if (!$('#archives').children.length) $('#archives').textContent = '尚无原档备份。点击上方“保留原档备份”开始。';
}
async function rescue(source, nodeId) {
  const keepTurns = Number($('#keep-turns').value);
  if (!Number.isSafeInteger(keepTurns) || keepTurns < 1) throw new Error('保留回合数请填写大于 0 的整数');
  source ||= await task('capture', { reason: 'before-rescue' });
  if (!source) throw new Error('没有可救援的当前档案');
  await task('rescue', { id: source.id, keepTurns, nodeId });
  progress('续玩副本已建立并切换。全部旧回合和 IF 线保存在原档备份中，可以返回游戏。');
  await refresh();
}
async function operation(run) {
  if (controller) return;
  controller = new AbortController();
  document.querySelectorAll('button,select,input').forEach(el => el.disabled = true);
  $('#cancel').hidden = false; $('#cancel').disabled = false; progress('正在准备…');
  try { await run(); }
  catch (error) { $('#status').textContent = error.message; $('#status').classList.add('error'); }
  finally { controller = null; document.querySelectorAll('button,select,input').forEach(el => el.disabled = false); $('#cancel').hidden = true; }
}
$('#cancel').onclick = () => { controller?.abort(); progress('正在取消，等待当前事务撤销…'); };
$('#backup').onclick = () => operation(async () => { const entry = await task('capture', { reason: 'rescue-backup' }); progress(entry ? '原档备份已保存并校验。' : '当前没有可备份的档案。'); await refresh(); });
$('#rescue').onclick = () => operation(() => rescue());
$('#export-current').onclick = () => operation(async () => {
  const encoded = await task('export-current');
  const download = await exportFile(encoded.blob, `当前档案-${Date.now()}${encoded.extension}`);
  progress(download.cancelled ? '已取消导出，原档仍保留。' : '导出文件已准备好。本次导出不额外复制本地档案。');
});
$('#new-game').onclick = () => operation(async () => { await task('capture', { reason: 'before-new-game', reset: true }); progress('旧档已保留，可以返回游戏创建新角色。'); await refresh(); });
$('#refresh').onclick = () => operation(refresh);
refresh().catch(error => { $('#status').textContent = error.message; $('#status').classList.add('error'); });
