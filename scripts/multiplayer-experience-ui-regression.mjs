import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harness = `
import { openMultiplayerOverlay } from '/js/ui/multiplayer-overlay.js';
import { appShell } from '/js/ui/app-shell.js';
import { stateManager } from '/js/core/state-manager.js';
import { eventBus } from '/js/core/event-bus.js';
import { SHINOBI_DAILY_EXAMPLE } from '/js/core/shinobi-daily.js';
import { createOpeningDraft } from '/js/systems/opening-draft.js';
import { multiplayerOpeningDraft } from '/js/multiplayer/opening-draft-bridge.js';
import '/js/ui/character-creator.js';
appShell.init(document.querySelector('main'));
window.created = 0; eventBus.on('character:created', () => window.created++);
window.savedDraft = null;
window.beforeSolo = JSON.stringify(stateManager.get());
const handle = openMultiplayerOverlay({ host: document.body });
window.handle = handle;
const store = handle.panel.controller.store;
store.patch({roomId:'room:demo',room:{room_id:'room:demo',room_code:'DEMO',viewer_seat:'A',lifecycle:'ACTIVE',active_epoch_id:'epoch:demo',origin_type:'new_multiplayer_save',state_revision:1,members:[{seat:'A',status:'ACTIVE'},{seat:'B',status:'ACTIVE'}]},connection:{status:'open',lastEventSeq:1}});
const turn = { turn_id:'turn:one',epoch_id:'epoch:demo',turn_no:1,status:'COMMITTED',commit:{
  checkpoint:{checkpoint_id:'checkpoint:one'}, narratives:[{audience:'shared',text:'晨风拂过村口的树梢。信使停在门边，等候回应。'}],
  shinobi_daily:[{daily_id:'daily:one',source_turn_id:'turn:one',daily:SHINOBI_DAILY_EXAMPLE}],
  state:{viewer_seat:'A',state_revision:1,actors:{A:{player:{display_name:'测试凛',rank:'中忍',status:'ACTIVE'},attributes:{resources:[{resource_id:'chakra',current:321,maximum:400},{resource_id:'money',current:1234,maximum:1000000}]}}},shared_world:{calendar:{display_date:'木叶52年1月1日'}}}
}};
store.setTurn(turn);
appShell.renderMultiplayerPublication(turn); appShell.setMultiplayerSessionState(store.state);
store.setTurn({turn_id:'turn:two',epoch_id:'epoch:demo',turn_no:2,status:'COLLECTING_ACTIONS',actions:{A:{locked:false},B:{locked:false}}});
appShell.setMultiplayerSessionState(store.state);
window.setupLobby=()=>{
  const draft=multiplayerOpeningDraft(createOpeningDraft('chunin',{identity:{name:'测试凛'}}));
  store.setRoom({...store.state.room,lifecycle:'LOBBY',active_epoch_id:null,narrative_preset:{source_seat:'A',bindings:{A:{name:'甲的预设'},B:{name:'乙的预设'}}},opening:{drafts:{A:{draft,revision:1},B:{draft:{...draft,display_name:'测试陆'},revision:1}},conflicts:[]}});
  handle.panel.controller.changeNarrativePreset=async seat=>{window.selectedSeat=seat;store.setRoom({...store.state.room,narrative_preset:{...store.state.room.narrative_preset,source_seat:seat}})};
  handle.panel.controller.syncNarrativePreset=async()=>{window.syncedPreset=true};
  handle.panel.controller.saveOpening=async draft=>{window.savedDraft=draft.detailed_draft};
  handle.show({presentation:'full'});
};
window.mountCreator=()=>{
 const editor=document.createElement('character-creator');editor.id='fixture-creator';
 editor.setDraftMode(createOpeningDraft('chunin',{identity:{name:'测试凛'}}));
 editor.addEventListener('opening-draft-saved',event=>window.savedDraft=event.detail.draft);
 document.body.append(editor);return editor;
};
window.ready=true;
`;
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') return res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}).end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/components.css"><style>body{background:#15171b;color:#eee;margin:0}main{min-height:100vh}button{cursor:pointer}</style><main></main><script type="module" src="/fixture.js"></script>');
    if (pathname === '/fixture.js') return res.writeHead(200, {'Content-Type':'text/javascript'}).end(harness);
    const target = path.resolve(root, '.' + decodeURIComponent(pathname));
    if (!target.startsWith(root+path.sep) || !/\.(?:js|css|json|png|webp|jpg|svg|woff2?)$/u.test(target)) throw new Error('unavailable');
    res.writeHead(200, {'Content-Type':target.endsWith('.js')?'text/javascript':target.endsWith('.css')?'text/css':'application/octet-stream'}).end(await readFile(target));
  } catch {res.writeHead(404).end();}
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1400,height:950}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.waitForFunction(()=>window.ready===true);
  const panel=page.locator('naruto-multiplayer-panel');
  await page.evaluate(()=>window.handle.minimize());
  assert.equal(await panel.isVisible(),false,'minimizing must actually hide the panel despite inline display');
  await page.getByRole('button',{name:'展开联机状态悬浮窗'}).click();
  assert.equal(await panel.isVisible(),true);
  const drag=page.locator('[data-multiplayer-drag]');
  const box=await drag.boundingBox();
  const before=await page.locator('[data-multiplayer-overlay]').boundingBox();
  await page.mouse.move(box.x+35,box.y+15);await page.mouse.down();await page.mouse.move(box.x-200,box.y-100,{steps:6});await page.mouse.up();
  const after=await page.locator('[data-multiplayer-overlay]').boundingBox();
  assert.ok(after.x<before.x-100 && after.y<before.y-30,'drag must move the overlay');
  const resize=await page.locator('[data-multiplayer-resize]').boundingBox();
  await page.mouse.move(resize.x+5,resize.y+5);await page.mouse.down();await page.mouse.move(resize.x-65,resize.y-80,{steps:6});await page.mouse.up();
  assert.ok((await page.locator('[data-multiplayer-overlay]').boundingBox()).width<after.width-30);
  await page.evaluate(()=>window.handle.minimize());
  assert.equal(await page.locator('[data-shinobi-daily-host]').count(),1,'committed daily must be mounted from its publication envelope');
  assert.match(await page.locator('[data-multiplayer-publication]').innerText(),/321.*400/u);
  await page.locator('[data-multiplayer-variables]').click();
  assert.match(await page.locator('multiplayer-character-panel').evaluate(e=>e.shadowRoot.textContent),/321/u);
  await page.locator('[data-shinobi-daily-host]').click();
  assert.equal(await page.locator('shinobi-daily-modal dialog').isVisible(),true);
  await page.keyboard.press('Escape');
  await page.evaluate(()=>window.setupLobby());
  await panel.locator('#preset-seat-b').click();
  assert.equal(await page.evaluate(()=>window.selectedSeat),'B');
  assert.match(await panel.locator('#narrative-preset-note').innerText(),/下一次生成使用 B/u);
  await panel.locator('#sync-narrative-preset').click();
  assert.equal(await page.evaluate(()=>window.syncedPreset),true);
  await panel.getByRole('button',{name:'详细开局 · 使用单人配置'}).click();
  const dialog=panel.getByRole('dialog',{name:'详细联机开局'});
  await dialog.waitFor({state:'visible'});
  assert.equal(await dialog.isVisible(),true);
  await dialog.locator('character-creator').evaluate(e=>e._finish());
  await dialog.waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>window.savedDraft.identity.name),'测试凛');
  assert.equal(await page.evaluate(()=>window.created),0,'saving a multiplayer draft must not create a solo game');
  assert.equal(await page.evaluate(async()=>JSON.stringify((await import('/js/core/state-manager.js')).stateManager.get())===window.beforeSolo),true);
  await page.evaluate(()=>{const s=window.handle.panel.controller.store;s.setRoom({...s.state.room,lifecycle:'ACTIVE',active_epoch_id:'epoch:demo'});window.handle.panel.showCompactSession();});
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>window.handle.show());
  await page.waitForTimeout(200);
  const mobile=await page.locator('[data-multiplayer-overlay]').boundingBox();
  assert.ok(mobile.x>=0 && mobile.y>=0 && mobile.x+mobile.width<=391 && mobile.y+mobile.height<=845);
  if(process.env.MULTIPLAYER_UI_SCREENSHOT_DIR){await mkdir(process.env.MULTIPLAYER_UI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.MULTIPLAYER_UI_SCREENSHOT_DIR,'multiplayer-experience-mobile.png')});}
  assert.deepEqual(errors,[]);
  console.log('Multiplayer overlay drag/resize/minimize, committed daily/variables and shared opening editor passed');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
