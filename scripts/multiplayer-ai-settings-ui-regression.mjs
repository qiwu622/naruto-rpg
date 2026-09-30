import assert from 'node:assert/strict';
import { mkdir, readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const captureDirectory = process.env.MULTIPLAYER_UI_SCREENSHOT_DIR || '';

const browserEntry = `
  import { NarutoMultiplayerPanel } from '/js/multiplayer/multiplayer-panel.js';
  import { MultiplayerRoomStore } from '/js/multiplayer/room-store.js';
  import { saveApiScheme, setActiveApiScheme } from '/js/core/api-schemes.js';

  const importedSchemeId = await saveApiScheme({
    name: '主设置联机方案',
    apiUrl: 'https://relay.example/v1',
    apiKey: 'sk-import-demo',
    model: 'relay-model-v1',
    backend: 'openai'
  });
  setActiveApiScheme(importedSchemeId);

  const store = new MultiplayerRoomStore();
  const calls = [];
  const profile = {
    profile_id: 'profile_demo_a',
    config_revision: 1,
    adapter: 'openai_compatible',
    model: 'deepseek-v4-flash',
    endpoint: {
      normalized_origin: 'https://api.deepseek.com',
      normalized_base_url: 'https://api.deepseek.com'
    },
    credential_ref: { credential_id: 'credential_demo_a', credential_revision: 1 },
    capabilities: { strict_json: true, error_correction_continuation: true },
    recommended_continuity_transport: 'json_protocol'
  };
  const room = {
    room_id: 'room_demo',
    viewer_seat: 'A',
    lifecycle: 'ACTIVE',
    origin_type: 'new_multiplayer_save',
    control_revision: 1,
    active_narrative_mode: 'shared',
    queued_narrative_mode: null,
    members: [
      { seat: 'A', ready_at: '2026-08-23T00:00:00.000Z' },
      { seat: 'B', ready_at: '2026-08-23T00:00:00.000Z' }
    ],
    credential_policy: {
      policy: 'ALTERNATE',
      policy_revision: 0,
      accepted_by: { A: false, B: false },
      viewer_accepted: false,
      fully_accepted: false,
      bindings_ready: false,
      ready: false,
      bindings: { A: null, B: null },
      current_turn_payer_seat: null,
      current_turn_id: 'turn_demo_3',
      current_turn_no: 3
    }
  };
  store.patch({
    roomId: room.room_id,
    room,
    modelProfiles: [{ profile, status: 'ACTIVE' }],
    credentials: [],
    connection: { status: 'open', lastEventSeq: 12 },
    presence: { A: { online: true }, B: { online: true } },
    turnContext: { epochId: 'epoch_demo', epochNo: 1, turnId: 'turn_demo_3', turnNo: 3 },
    turn: {
      turn_id: 'turn_demo_3',
      turn_no: 3,
      viewer_seat: 'A',
      status: 'COLLECTING_ACTIONS',
      narrative_mode: 'shared',
      actions: {}
    },
    progress: {
      status: 'COLLECTING_ACTIONS',
      label: '等待双方提交行动',
      resumeStage: null,
      detail: null
    },
    lineage: { origin_type: 'new_multiplayer_save', checkpoints: [], source_imports: [] }
  });

  function updatePolicy(changes) {
    const currentRoom = store.state.room;
    store.patch({
      room: {
        ...currentRoom,
        control_revision: currentRoom.control_revision + 1,
        credential_policy: { ...currentRoom.credential_policy, ...changes }
      }
    });
  }

  const controller = {
    store,
    get state() { return store.state; },
    subscribe(listener) { return store.subscribe(listener); },
    disconnect() {},
    async createCredential({ endpointOrigin, plaintext }) {
      calls.push('credential:' + endpointOrigin + ':' + plaintext);
      const credential = {
        credential_id: 'credential_imported', credential_revision: 1,
        endpoint_origin: endpointOrigin, state: 'ACTIVE', fingerprint_suffix: 'demo'
      };
      store.patch({ credentials: [credential] });
      return { credential };
    },
    async createProfile(request) {
      calls.push('profile:' + request.model);
      const importedProfile = {
        profile_id: 'profile_imported', config_revision: 1,
        adapter: request.adapter, model: request.model, auth_scheme: request.auth_scheme,
        endpoint: {
          normalized_origin: 'https://relay.example',
          normalized_base_url: request.base_url
        },
        credential_ref: request.credential_ref,
        capabilities: {}, recommended_continuity_transport: null
      };
      store.patch({
        modelProfiles: [...store.state.modelProfiles, { profile: importedProfile, status: 'ACTIVE' }]
      });
      return { profile: importedProfile };
    },
    async bindRoomModelProfile(profileId) {
      calls.push('bind:' + profileId);
      const policy = store.state.room.credential_policy;
      const selected = store.state.modelProfiles
        .map(item => item?.profile ?? item)
        .find(item => item.profile_id === profileId) ?? profile;
      updatePolicy({
        policy_revision: Math.max(1, policy.policy_revision + 1),
        accepted_by: { A: false, B: false },
        viewer_accepted: false,
        fully_accepted: false,
        ready: false,
        bindings: {
          ...policy.bindings,
          A: {
            binding_revision: 1,
            profile_revision: selected.config_revision,
            adapter: selected.adapter,
            model: selected.model,
            configured: true
          }
        }
      });
      return { configured: true };
    },
    async chooseCredentialUsagePolicy(nextPolicy) {
      calls.push('policy:' + nextPolicy);
      const policy = store.state.room.credential_policy;
      const changed = policy.policy_revision < 1 || policy.policy !== nextPolicy;
      const accepted = changed ? { A: true, B: false } : { ...policy.accepted_by, A: true };
      const required = nextPolicy === 'A_ONLY' ? ['A'] : (nextPolicy === 'B_ONLY' ? ['B'] : ['A', 'B']);
      const bindingsReady = required.every(seat => policy.bindings[seat]?.configured === true);
      updatePolicy({
        policy: nextPolicy,
        policy_revision: changed ? policy.policy_revision + 1 : policy.policy_revision,
        accepted_by: accepted,
        viewer_accepted: true,
        fully_accepted: accepted.A && accepted.B,
        bindings_ready: bindingsReady,
        ready: accepted.A && accepted.B && bindingsReady,
        current_turn_payer_seat: nextPolicy === 'B_ONLY' ? 'B' : 'A'
      });
      return { policy: nextPolicy };
    }
  };

  const panel = new NarutoMultiplayerPanel();
  panel.controller = controller;
  document.querySelector('main').append(panel);
  panel.showFullSession();

  window.__aiSettingsCalls = calls;
  window.__acceptOther = () => {
    const policy = store.state.room.credential_policy;
    updatePolicy({
      policy_revision: policy.policy_revision + 1,
      accepted_by: { A: false, B: true },
      viewer_accepted: false,
      fully_accepted: false,
      bindings_ready: true,
      ready: false,
      bindings: {
        ...policy.bindings,
        B: policy.bindings.B ?? {
          binding_revision: 1,
          profile_revision: 1,
          adapter: 'openai_compatible',
          model: 'deepseek-v4-flash',
          configured: true
        }
      }
    });
  };
  window.__aiSettingsReady = true;
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
      response.end(`<!doctype html>
        <html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>html{background:#08080a;color:#f5f5f7}body{margin:0;padding:24px;font-family:system-ui,sans-serif}main{max-width:1440px;margin:auto}</style>
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error));
  await page.goto(origin);
  await page.waitForFunction(() => window.__aiSettingsReady === true);

  const panel = page.locator('naruto-multiplayer-panel');
  const aiCard = panel.locator('.ai-settings-card');
  const profileField = panel.locator('#room-profile-field');
  const confirm = panel.locator('#confirm-ai-settings');
  assert.equal(await profileField.isVisible(), true, 'the default alternate policy requires the viewer profile');
  assert.equal(
    await panel.locator('[data-credential-policy="ALTERNATE"]').getAttribute('aria-checked'),
    'true'
  );
  assert.equal(await confirm.textContent(), '保存方案并确认');

  const visibleText = await panel.evaluate(element => element.shadowRoot.textContent);
  for (const internalText of ['selection hash', 'future_stage_changes', 'grant ID', 'grant revision']) {
    assert.equal(visibleText.includes(internalText), false, `${internalText} must not be player-visible`);
  }

  await panel.locator('[data-credential-policy="B_ONLY"]').click();
  assert.equal(
    await panel.locator('[data-credential-policy="B_ONLY"]').getAttribute('aria-checked'),
    'true'
  );
  assert.equal(
    await panel.locator('[data-credential-policy="A_ONLY"]').getAttribute('aria-checked'),
    'false'
  );
  assert.equal(await profileField.isHidden(), true, 'seat A does not bind a profile for the B-only policy');
  assert.match(await panel.locator('#credential-current-turn').textContent(), /确认后本回合使用席位 B/u);
  assert.equal(await confirm.isDisabled(), true);
  assert.equal(await confirm.textContent(), '等待席位 B 配置 API');

  await panel.locator('[data-credential-policy="ALTERNATE"]').click();
  assert.equal(
    await panel.locator('[data-credential-policy="B_ONLY"]').getAttribute('aria-checked'),
    'false'
  );
  assert.equal(
    await panel.locator('[data-credential-policy="ALTERNATE"]').getAttribute('aria-checked'),
    'true'
  );
  assert.equal(await profileField.isVisible(), true, 'alternate policy requires the viewer profile');
  assert.equal(await panel.locator('#room-profile').inputValue(), 'profile_demo_a');
  assert.match(await panel.locator('#credential-current-turn').textContent(), /确认后本回合使用席位 A/u);
  assert.equal(await confirm.isEnabled(), true);
  assert.equal(await confirm.textContent(), '保存方案并确认');
  assert.equal(await panel.locator('#main-api-scheme').isVisible(), true);
  assert.equal(await panel.locator('#import-main-api-scheme').isVisible(), true);
  await page.waitForFunction(() => document.querySelector('naruto-multiplayer-panel')
    .shadowRoot.querySelector('#main-api-scheme').value !== '');
  await panel.locator('#import-main-api-scheme').click();
  await page.waitForFunction(() => document.querySelector('naruto-multiplayer-panel')
    .shadowRoot.querySelector('#room-profile').value === 'profile_imported');
  assert.equal(await panel.locator('#room-profile').inputValue(), 'profile_imported');
  assert.match(await panel.locator('#main-api-scheme-status').textContent(), /已添加.*relay-model-v1/u);
  assert.deepEqual(
    await page.evaluate(() => window.__aiSettingsCalls.slice()),
    [
      'credential:https://relay.example:sk-import-demo',
      'profile:relay-model-v1'
    ]
  );
  for (const removedControl of [
    '#open-api-settings',
    '#api-profile-management',
    '#credential-form',
    '#credential-rotate-form',
    '#profile-form',
    '#probe-output'
  ]) {
    assert.equal(await panel.locator(removedControl).count(), 0);
  }
  assert.equal(await panel.locator('[data-tab="advanced"]').count(), 0);

  await confirm.click();
  await page.waitForFunction(() => window.__aiSettingsCalls.includes('policy:ALTERNATE'));
  assert.deepEqual(
    await page.evaluate(() => window.__aiSettingsCalls.slice()),
    [
      'credential:https://relay.example:sk-import-demo',
      'profile:relay-model-v1',
      'bind:profile_imported',
      'policy:ALTERNATE'
    ]
  );
  assert.equal(await confirm.textContent(), '等待席位 B 配置 API');
  assert.equal(await confirm.isDisabled(), true);

  await page.evaluate(() => window.__acceptOther());
  await page.waitForFunction(() => document.querySelector('naruto-multiplayer-panel')
    .shadowRoot.querySelector('#confirm-ai-settings').textContent === '确认联机设置');
  assert.equal(await confirm.isEnabled(), true);
  await confirm.click();
  await page.waitForFunction(() => document.querySelector('naruto-multiplayer-panel')
    .shadowRoot.querySelector('#confirm-ai-settings').textContent === '设置已生效');
  assert.deepEqual(
    await page.evaluate(() => window.__aiSettingsCalls.slice()),
    [
      'credential:https://relay.example:sk-import-demo',
      'profile:relay-model-v1',
      'bind:profile_imported',
      'policy:ALTERNATE',
      'policy:ALTERNATE'
    ]
  );
  assert.match(await panel.locator('#credential-current-turn').textContent(), /本回合使用席位 A.*relay-model-v1/u);
  assert.equal(await panel.locator('#ai-settings-summary').isVisible(), true);
  assert.equal(await panel.locator('#ai-settings-editor').isHidden(), true);

  await panel.evaluate(element => {
    element.controller.store.setError(new ReferenceError('profileValue is not defined'));
  });
  assert.equal(await panel.locator('#error-output').textContent(), '界面操作失败，请刷新页面后重试');
  await panel.evaluate(element => element.controller.store.setError(null));

  if (captureDirectory) {
    await mkdir(captureDirectory, { recursive: true });
    await aiCard.screenshot({ path: path.join(captureDirectory, 'multiplayer-ai-settings-desktop.png') });
  }

  await panel.locator('#edit-ai-settings').click();
  assert.equal(await panel.locator('#ai-settings-editor').isVisible(), true);
  assert.equal(await panel.locator('#edit-ai-settings').textContent(), '收起');
  await panel.locator('#edit-ai-settings').click();
  assert.equal(await panel.locator('#ai-settings-editor').isHidden(), true);

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto(origin);
  await mobilePage.waitForFunction(() => window.__aiSettingsReady === true);
  const mobilePanel = mobilePage.locator('naruto-multiplayer-panel');
  await mobilePanel.locator('[data-credential-policy="ALTERNATE"]').click();
  await mobilePage.waitForFunction(() => document.querySelector('naruto-multiplayer-panel')
    .shadowRoot.querySelector('#main-api-scheme').value !== '');
  await mobilePanel.locator('#import-main-api-scheme').click();
  await mobilePage.waitForFunction(() => document.querySelector('naruto-multiplayer-panel')
    .shadowRoot.querySelector('#room-profile').value === 'profile_imported');
  assert.match(
    await mobilePanel.locator('#main-api-scheme-status').textContent(),
    /已添加.*relay-model-v1/u
  );
  assert.equal(
    await mobilePage.evaluate(() => window.__aiSettingsCalls.some(call => call.startsWith('probe:'))),
    false,
    'importing an API scheme must not send a capability-probe request'
  );
  assert.equal(
    await mobilePage.evaluate(() => window.__aiSettingsCalls.some(call => call.startsWith('bind:'))),
    false,
    'import alone must wait for explicit confirmation before binding the profile'
  );
  const fit = await mobilePanel.evaluate(element => {
    const root = element.shadowRoot;
    const host = element.getBoundingClientRect();
    const card = root.querySelector('.ai-settings-card').getBoundingClientRect();
    const controls = [...root.querySelectorAll('.ai-settings-card button, .ai-settings-card select')]
      .map(control => control.getBoundingClientRect())
      .filter(box => box.width > 0 && box.height > 0);
    return {
      documentOverflow: document.documentElement.scrollWidth > window.innerWidth,
      hostOverflow: element.scrollWidth > element.clientWidth,
      cardWithinHost: card.left >= host.left - 1 && card.right <= host.right + 1,
      controlsWithinCard: controls.every(box => box.left >= card.left - 1 && box.right <= card.right + 1)
    };
  });
  assert.deepEqual(fit, {
    documentOverflow: false,
    hostOverflow: false,
    cardWithinHost: true,
    controlsWithinCard: true
  });
  if (captureDirectory) {
    await mkdir(captureDirectory, { recursive: true });
    await mobilePanel.locator('.ai-settings-card').screenshot({
      path: path.join(captureDirectory, 'multiplayer-ai-settings-mobile.png')
    });
  }
  await mobileContext.close();
  await context.close();
  assert.deepEqual(pageErrors, []);
  console.log('multiplayer simplified AI settings browser regression passed');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
