import assert from 'node:assert/strict';
import express from 'express';
import { chromium } from 'playwright';
import { makeContinuationFixture } from './helpers/continuation-save-fixture.mjs';

const app = express();
app.get('/', (_req, res) => res.type('html').send('<!doctype html><meta charset="utf-8">'));
app.use(express.static(process.cwd()));
const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const sharedEnabled = !process.argv.includes('--published-baseline');
  const result = await page.evaluate(async ({ fixture, sharedEnabled }) => {
    const { stateManager: sm } = await import('/js/core/state-manager.js');
    const { timelineSystem: timeline } = await import('/js/systems/timeline-system.js');
    const { timelineStorageTask: task } = await import('/js/core/timeline-storage-client.js');
    const { compressTimelineNode, decompressTimelineNode } = await import('/js/core/timeline-node-codec.js');
    const { checksumSaveJson } = await import('/js/core/save-json-stream.js');
    const { decodeTimelineSaveFile } = await import('/js/core/timeline-file-codec.js');
    const { validateSavePackage } = await import('/js/core/save-library.js');
    const check = (value, message) => { if (!value) throw new Error(message); };
    const memory = '记忆'.repeat(3 * 1024 * 1024);
    const head = fixture.nodes.at(-1);
    head.state_snapshot._memory.facts = memory;
    head.state_snapshot._memory.archived = memory;
    fixture.nodes[fixture.nodes.length - 1] = await compressTimelineNode(head);
    const rawHead = fixture.nodes.at(-1);
    const originalDigest = await checksumSaveJson(rawHead);
    await sm.initDB();
    await sm.dbReplaceTimeline(fixture);
    sm.setSub('_meta', { current_node_id: head.id, active_branch: head.branch_id });
    const original = await task('capture', { label: '超过32MiB的原始档' });
    const originalUnchanged = async () => check(await checksumSaveJson((await sm.dbGet('timeline_archive_nodes', [original.id, head.id])).node) === originalDigest, 'original archive changed');
    const current = await timeline.getCurrentNode();
    check(current.state_snapshot._memory.facts === memory, 'current large node cannot hydrate');
    const preview = await task('preview', { id: original.id });
    check(preview.state_snapshot._memory.archived === memory, 'worker cannot read large legacy node');
    const encoded = await task('export', { id: original.id });
    const exported = await validateSavePackage(await decodeTimelineSaveFile(encoded.blob));
    check(exported.payload.nodes.find(node => node.id === head.id).state_snapshot._memory.facts === memory, 'export lost large memory');
    await originalUnchanged();
    let largeBytes = 36 * 1024 * 1024;
    let restoreId = original.id;
    if (sharedEnabled) {
      const compacted = await task('compact', { id: original.id });
      const shared = (await sm.dbGet('timeline_archive_nodes', [compacted.id, head.id])).node;
      largeBytes = shared.payload.byteLength;
      check(largeBytes > 32 * 1024 * 1024, 'fixture is below the old limit');
      check((await decompressTimelineNode(shared, { db: sm.getDB() })).state_snapshot._memory.facts === memory, 'large shared node unreadable');
      let bounded = false;
      try { await decompressTimelineNode(shared, { db: sm.getDB(), maxDecompressedBytes: 32 * 1024 * 1024 }); }
      catch (error) { bounded = error.message.includes('单个回合状态过大'); }
      check(bounded, 'explicit shared node limit no longer works');
      restoreId = compacted.id;
    }
    await timeline.restoreArchive(restoreId);
    check(sm.getSub('_memory').facts === memory, 'shared archive restore lost memory');
    const rescued = await task('rescue', { id: original.id, keepTurns: 1 });
    const saved = await sm.dbGet('timeline_nodes', head.id);
    check((await decompressTimelineNode(saved, { db: sm.getDB() })).state_snapshot._memory.archived === memory, 'large node rescue lost memory');
    await originalUnchanged();
    return { archiveId: original.id, nodeId: head.id, originalDigest, largeBytes,
      exportedNodes: exported.payload.nodes.length, rescuedNodes: rescued.nodeCount,
      legacyRead: true, workerPreview: true, exportRoundtrip: true, sharedRead: sharedEnabled, originalPreserved: true };
  }, { fixture: makeContinuationFixture(4), sharedEnabled });
  await page.reload();
  const afterReload = await page.evaluate(async ({ archiveId, nodeId, originalDigest }) => {
    const { stateManager: sm } = await import('/js/core/state-manager.js');
    const { timelineSystem: timeline } = await import('/js/systems/timeline-system.js');
    const { checksumSaveJson } = await import('/js/core/save-json-stream.js');
    await sm.initDB();
    const node = await timeline._hydrateNode(await sm.dbGet('timeline_nodes', nodeId));
    return node.state_snapshot._memory.facts.length === 6 * 1024 * 1024
      && await checksumSaveJson((await sm.dbGet('timeline_archive_nodes', [archiveId, nodeId])).node) === originalDigest;
  }, result);
  assert.equal(afterReload, true, 'reload cannot read rescue or changed original');
  assert.deepEqual(errors, []);
  await page.goto(`http://127.0.0.1:${server.address().port}/announcements.html`);
  const releaseVersion = await page.locator('html').getAttribute('data-release-version');
  assert.match(releaseVersion, /^\d+\.\d+\.\d+$/);
  await page.getByRole('heading', { name: `v${releaseVersion} · 更新公告`, exact: true }).waitFor();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  console.log({ ...result, archiveId: undefined, originalDigest: undefined, reload: afterReload });
  console.log(`PASS >32 MiB legacy${sharedEnabled ? '/shared' : ' published-baseline'} reads, worker preview, export, restore, rescue, reload and original preservation`);
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
