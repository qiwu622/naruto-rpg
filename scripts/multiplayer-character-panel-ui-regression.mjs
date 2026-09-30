import assert from 'node:assert/strict';
import { mkdir, readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const captureDirectory = process.env.MULTIPLAYER_UI_SCREENSHOT_DIR || '';

const opening = {
  start_time: { year: 52, month: 4, day: 12, phase: 'DUSK' },
  display_name: '漩涡遥',
  rank: '中忍',
  affiliation: '木叶隐村',
  background: '结界班出身，擅长感知。',
  location: '木叶东门',
  goal: '追查失踪的边境信使。',
  opening_hook: '黄昏时收到一封染血的急信。'
};

const projection = {
  schema: 'naruto.multiplayer-member-state-projection/v1',
  viewer_seat: 'A',
  state_revision: 3,
  shared_world: {
    world_state: {
      locations: [{ entity_id: 'actor:A', location_id: 'location:forest' }]
    },
    calendar: { display_date: '木叶52年4月13日', phase: 'NIGHT' },
    map: { markers: [{ location_id: 'location:forest', label: '火之国北部森林' }] },
    shared_missions: {
      entries: [{
        mission_id: 'mission:messenger',
        title: '失踪的信使',
        status: 'ACTIVE',
        progress_current: 1,
        progress_total: 4
      }]
    },
    shared_combat: { entries: [] }
  },
  actors: {
    A: {
      room_actor_id: 'actor:A',
      player: {
        display_name: '漩涡遥', rank: '中忍', goal: '找到信使并带回情报', status: 'ACTIVE'
      },
      attributes: {
        resources: [
          { resource_id: 'chakra', current: 37, maximum: 50 },
          { resource_id: 'mental', current: 43, maximum: 50 },
          { resource_id: 'money', current: 840, maximum: 1000000 },
          { resource_id: 'stamina', current: 31, maximum: 50 },
          { resource_id: 'vitality', current: 92, maximum: 100 }
        ]
      },
      progression: { level: 6, experience: 420, reputation: 18 },
      skills: {
        entries: [{ display_name: '感知结界', category: 'NINJUTSU', rank: 'B', mastery: 64 }]
      },
      equipment: {
        entries: [{ display_name: '结界钉', category: 'EQUIPMENT', quantity: 6, equipped_slot: 'tool' }]
      },
      missions: { entries: [] },
      private_knowledge: { facts: [{ kind: '线索', summary: '信使最后在北部森林出现。' }] }
    },
    B: {
      room_actor_id: 'actor:B',
      player: { display_name: '奈良澄', rank: '中忍', status: 'ACTIVE' },
      attributes: {}, progression: {}, skills: { entries: [] }, equipment: { entries: [] },
      missions: { entries: [] }, private_knowledge: {}
    }
  },
  relationships: [{
    edge_id: 'relationship:a:b',
    source_actor_id: 'actor:A',
    target_actor_id: 'actor:B',
    data: { target_display_name: '奈良澄', label: '可靠队友', score: 28 }
  }],
  memories: { shared: { entries: [] }, personal: { entries: [] } }
};

const browserEntry = `
  import '/js/ui/multiplayer-character-panel.js';

  const opening = ${JSON.stringify(opening)};
  const projection = ${JSON.stringify(projection)};
  const panel = document.createElement('multiplayer-character-panel');
  document.querySelector('main').append(panel);

  const room = {
    room_id: 'room_panel_demo', viewer_seat: 'A', lifecycle: 'ACTIVE',
    opening: { drafts: { A: { draft: opening, confirmed: true } } }
  };
  const collecting = {
    roomId: room.room_id, room,
    turn: { turn_id: 'turn_1', turn_no: 1, status: 'COLLECTING_ACTIONS', actions: {} }
  };
  panel.setSessionState(collecting);

  window.__panel = panel;
  window.__collecting = collecting;
  window.__commit = () => panel.setSessionState({
    ...collecting,
    turn: {
      turn_id: 'turn_1', turn_no: 1, status: 'COMMITTED', actions: {},
      commit: { state: projection }
    }
  });
  window.__nextTurn = () => panel.setSessionState({
    ...collecting,
    turn: { turn_id: 'turn_2', turn_no: 2, status: 'COLLECTING_ACTIONS', actions: {} }
  });
  window.__changeRoom = () => panel.setSessionState({
    roomId: 'room_other',
    room: { ...room, room_id: 'room_other' },
    turn: { turn_id: 'turn_other', turn_no: 1, status: 'COLLECTING_ACTIONS', actions: {} }
  });
  window.__ready = true;
`;

const mimeTypes = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
});

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': mimeTypes['.html'], 'Cache-Control': 'no-store' });
      response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <link rel="stylesheet" href="/css/tokens.css">
        <style>html,body{height:100%;background:#08090b;color:#f5f5f7}body{margin:0;font-family:system-ui,sans-serif}main{width:320px;height:100vh;margin:auto;border-left:1px solid #282828;border-right:1px solid #282828}</style>
        </head><body><main></main><script type="module" src="/harness.js"></script></body></html>`);
      return;
    }
    if (url.pathname === '/harness.js') {
      response.writeHead(200, { 'Content-Type': mimeTypes['.js'], 'Cache-Control': 'no-store' });
      response.end(browserEntry);
      return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const target = path.resolve(projectRoot, relative);
    if (target !== projectRoot && !target.startsWith(`${projectRoot}${path.sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    response.end(await readFile(target));
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error));
  await page.goto(origin);
  await page.waitForFunction(() => window.__ready === true);

  const panel = page.locator('multiplayer-character-panel');
  assert.match(await panel.evaluate(element => element.shadowRoot.textContent), /漩涡遥/u);
  assert.match(await panel.evaluate(element => element.shadowRoot.textContent), /木叶东门/u);
  assert.match(await panel.evaluate(element => element.shadowRoot.textContent), /等待首次结算/u);

  await panel.locator('[data-tab="skills"]').click();
  assert.match(await panel.evaluate(element => element.shadowRoot.textContent), /首回合尚未完成/u);
  await panel.locator('[data-tab="attributes"]').click();

  await page.evaluate(() => window.__commit());
  await page.waitForFunction(() => document.querySelector('multiplayer-character-panel')
    .shadowRoot.textContent.includes('修订 3'));
  const committedText = await panel.evaluate(element => element.shadowRoot.textContent);
  for (const visible of ['火之国北部森林', '木叶52年4月13日', '37 / 50', '840']) {
    assert.match(committedText, new RegExp(visible, 'u'));
  }

  for (const [tab, expected] of [
    ['skills', '感知结界'],
    ['equipment', '结界钉'],
    ['missions', '失踪的信使'],
    ['relations', '奈良澄']
  ]) {
    await panel.locator(`[data-tab="${tab}"]`).click();
    assert.match(await panel.evaluate(element => element.shadowRoot.textContent), new RegExp(expected, 'u'));
  }

  await page.evaluate(() => window.__nextTurn());
  assert.match(
    await panel.evaluate(element => element.shadowRoot.textContent),
    /奈良澄/u,
    'the most recent committed member projection survives the next turn opening'
  );

  await page.evaluate(() => window.__changeRoom());
  assert.doesNotMatch(
    await panel.evaluate(element => element.shadowRoot.textContent),
    /奈良澄/u,
    'a different room cannot inherit the previous room projection'
  );
  await panel.locator('[data-tab="attributes"]').click();

  const fit = await panel.evaluate(element => {
    const host = element.getBoundingClientRect();
    const root = element.shadowRoot;
    const content = root.querySelector('.content').getBoundingClientRect();
    const tabs = root.querySelector('.tabs').getBoundingClientRect();
    return {
      documentOverflowX: document.documentElement.scrollWidth > window.innerWidth,
      hostWithinViewport: host.top >= 0 && host.bottom <= window.innerHeight,
      contentWithinHost: content.left >= host.left && content.right <= host.right,
      tabsWithinHost: tabs.left >= host.left && tabs.right <= host.right
    };
  });
  assert.deepEqual(fit, {
    documentOverflowX: false,
    hostWithinViewport: true,
    contentWithinHost: true,
    tabsWithinHost: true
  });

  if (captureDirectory) {
    await mkdir(captureDirectory, { recursive: true });
    await panel.screenshot({ path: path.join(captureDirectory, 'multiplayer-character-panel-desktop.png') });
  }

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto(origin);
  await mobilePage.waitForFunction(() => window.__ready === true);
  const mobilePanel = mobilePage.locator('multiplayer-character-panel');
  const mobileFit = await mobilePanel.evaluate(element => ({
    documentOverflowX: document.documentElement.scrollWidth > window.innerWidth,
    hostWidth: Math.round(element.getBoundingClientRect().width),
    viewportWidth: window.innerWidth
  }));
  assert.equal(mobileFit.documentOverflowX, false);
  assert.ok(mobileFit.hostWidth <= mobileFit.viewportWidth);
  await mobileContext.close();
  await context.close();
  assert.deepEqual(pageErrors, []);
  console.log('multiplayer character projection panel browser regression passed');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
