import assert from 'node:assert/strict';
import { exportFile, openAndroidDownload } from '../js/core/file-export.js';
import { timelineSystem } from '../js/systems/timeline-system.js';
import { eventBus } from '../js/core/event-bus.js';

const previous = globalThis.Capacitor;
let chunks = [], discarded = 0, finish = () => ({ cancelled: false }), pending, opened;
const plugin = {
  async beginSave(options) { chunks = []; assert.ok(options.size > 0); return { id: 'export-session' }; },
  async appendSave({ offset, data }) { assert.equal(offset, chunks.reduce((size, value) => size + value.length, 0)); chunks.push(Buffer.from(data, 'base64')); },
  async finishSave() { return finish(); },
  async cancelSave() { discarded++; },
  async openDownload({ url }) { opened = url; }
};
globalThis.Capacitor = { getPlatform: () => 'android', isNativePlatform: () => true, registerPlugin: name => { assert.equal(name, 'NarutoFiles'); return plugin; } };
let passed = 0;
const ok = text => { passed++; console.log('PASS ' + text); };
try {
  const source = Buffer.concat([Buffer.from('旧存档与 IF 分支\n'), Buffer.from(Array.from({ length: 700000 }, (_, i) => i % 256))]);
  let settled = false;
  finish = () => new Promise(resolve => { pending = resolve; });
  const exporting = exportFile(new Blob([source], { type: 'application/gzip' }), '旧档.json.gz').then(value => { settled = true; return value; });
  while (!pending) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(settled, false); assert.equal(discarded, 0);
  assert.deepEqual(Buffer.concat(chunks), source);
  assert.equal(chunks.length, 3);
  pending({ cancelled: false }); assert.equal((await exporting).cancelled, false); assert.equal(discarded, 1);
  ok('large binary and Unicode archives are chunked without corruption and wait for actual system-file completion');

  finish = () => ({ cancelled: true });
  assert.equal((await exportFile(new Blob(['old save']), 'old.json')).cancelled, true);
  assert.equal(discarded, 2);
  ok('cancelling the picker reports cancellation and discards only the staging export');

  const append = plugin.appendSave;
  plugin.appendSave = async () => { throw new Error('native disk full'); };
  await assert.rejects(exportFile(new Blob(['save']), 'save.json'), /native disk full/);
  assert.equal(discarded, 3); plugin.appendSave = append;
  ok('native write failures reject the export and clean up instead of reporting a download');

  const getData = timelineSystem.getExportData;
  let exportedEvents = 0;
  const listener = () => { exportedEvents++; };
  eventBus.on('timeline:exported', listener);
  timelineSystem.getExportData = async () => ({ nodes: [], branches: [], meta: {} });
  try {
    assert.equal((await timelineSystem.exportTimeline({ compression: 'json' })).cancelled, true);
    assert.equal(exportedEvents, 0);
    finish = () => ({ cancelled: false });
    assert.equal((await timelineSystem.exportTimeline({ compression: 'json' })).cancelled, false);
    assert.equal(exportedEvents, 1);
  } finally { timelineSystem.getExportData = getData; eventBus.off('timeline:exported', listener); }
  ok('the shared timeline export never announces success for a cancelled native save');

  await openAndroidDownload('https://www.qiwu.asia/app/android/naruto-rpg.apk');
  assert.equal(opened, 'https://www.qiwu.asia/app/android/naruto-rpg.apk');
  ok('update downloads use the native browser intent without navigating away from the game');
} finally {
  if (previous === undefined) delete globalThis.Capacitor; else globalThis.Capacitor = previous;
}
console.log('Android file export regression: ' + passed + ' groups passed');
