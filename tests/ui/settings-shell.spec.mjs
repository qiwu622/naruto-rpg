import { test, expect } from '@playwright/test';

test('player settings exposes five focused pages and one AI connection owner', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto('/tests/fixtures/settings-panel-harness.html');
  await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__ === true);

  const settings = page.locator('settings-panel');
  const navigation = settings.locator('.tab-btn');
  await expect(navigation).toHaveCount(5);
  await expect(navigation).toHaveText([
    '外观与阅读',
    '游玩与输出',
    'AI 连接',
    '声音与画面',
    '支持项目'
  ]);

  await settings.locator('[data-section="connection"]').click();
  await expect(settings.locator('api-config-form')).toBeVisible();
  await expect(settings.locator('[data-action="api-settings"]')).toHaveCount(0);
  await expect(settings.locator('[data-action="reset"]')).toHaveCount(0);
  await expect(settings.locator('[data-action="export"]')).toHaveCount(0);
  await expect(settings.locator('[data-action="import"]')).toHaveCount(0);
  await expect(settings.locator('[data-action="open-creator-workbench"]')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('API schemes visibly stay selected, update in place and can be deleted', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/tests/fixtures/settings-panel-harness.html');
  await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__ === true);

  const settings = page.locator('settings-panel');
  await settings.locator('[data-section="connection"]').click();
  const form = settings.locator('api-config-form');
  const select = form.locator('#scheme-select');
  const trigger = form.locator('.scheme-row .ns-select-trigger');

  await form.locator('#settings-api-url').fill('https://one.example/v1');
  await form.locator('#settings-api-key').fill('reload-secret');
  await form.locator('#settings-api-model').fill('model-one');
  const backendSelect = form.locator('#settings-api-backend').locator('..');
  await backendSelect.locator('.ns-select-trigger').click();
  await backendSelect.locator('.ns-select-option').filter({ hasText: 'DeepSeek' }).click();
  await form.locator('#settings-disable-streaming').setChecked(true);
  await form.locator('#scheme-name').fill('主方案');
  await form.locator('#scheme-save').click();
  await expect(select.locator('option')).toHaveCount(2);

  const schemeId = await select.locator('option').nth(1).getAttribute('value');
  expect(schemeId).toBeTruthy();
  await expect(select).toHaveValue(schemeId);
  await expect(trigger).toContainText('主方案');
  await expect(form.locator('#scheme-name')).toHaveValue('主方案');
  await expect(form.locator('#settings-api-url')).toHaveValue('https://one.example/v1');
  await expect(form.locator('#settings-api-key')).toHaveValue('reload-secret');
  await expect(form.locator('#settings-api-model')).toHaveValue('model-one');
  await expect(form.locator('#settings-api-backend')).toHaveValue('deepseek');
  await expect(form.locator('#settings-disable-streaming')).toBeChecked();
  await expect(form.locator('#scheme-save')).toHaveText('更新当前方案');

  await page.reload();
  await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__ === true);
  await settings.locator('[data-section="connection"]').click();
  await expect(select).toHaveValue(schemeId);
  await expect(trigger).toContainText('主方案');
  await expect(form.locator('#scheme-name')).toHaveValue('主方案');
  await expect(form.locator('#settings-api-url')).toHaveValue('https://one.example/v1');
  await expect(form.locator('#settings-api-key')).toHaveValue('reload-secret');
  await expect(form.locator('#settings-api-model')).toHaveValue('model-one');
  await expect(form.locator('#settings-api-backend')).toHaveValue('deepseek');
  await expect(form.locator('#settings-disable-streaming')).toBeChecked();

  await form.locator('#settings-api-url').fill('https://two.example/v1');
  await form.locator('#settings-api-model').fill('model-two');
  await form.locator('#scheme-name').fill('主方案·更新');
  await form.locator('#scheme-save').click();
  await expect(select.locator('option')).toHaveCount(2);
  await expect(select.locator('option').nth(1)).toContainText('主方案·更新');
  await expect(trigger).toContainText('主方案·更新');

  const stored = await page.evaluate(async id => {
    const { getApiScheme } = await import('/js/core/api-schemes.js');
    return getApiScheme(id);
  }, schemeId);
  expect(stored).toMatchObject({
    id: schemeId,
    name: '主方案·更新',
    apiUrl: 'https://two.example/v1',
    apiKey: 'reload-secret',
    model: 'model-two',
    backend: 'deepseek',
    disableStreaming: true
  });

  await form.locator('#scheme-delete').click();
  await expect(select.locator('option')).toHaveCount(1);
  await expect(select).toHaveValue('');
  await expect(trigger).toContainText('选择已保存方案');
  await expect(form.locator('#scheme-name')).toHaveValue('');
  await expect(form.locator('#scheme-delete')).toBeDisabled();
  expect(pageErrors).toEqual([]);
});

test('deleting a scheme invalidates an in-flight encrypted scheme selection', async ({ page }) => {
  await page.goto('/tests/fixtures/settings-panel-harness.html');
  await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__ === true);

  const settings = page.locator('settings-panel');
  await settings.locator('[data-section="connection"]').click();
  const form = settings.locator('api-config-form');
  await form.locator('#settings-api-url').fill('https://race.example/v1');
  await form.locator('#settings-api-key').fill('secret-for-race');
  await form.locator('#settings-api-model').fill('race-model');
  await form.locator('#scheme-name').fill('竞态方案');
  await form.locator('#scheme-save').click();
  await expect(form.locator('#scheme-select option')).toHaveCount(2);

  const outcome = await form.evaluate(async host => {
    const select = host.shadowRoot.querySelector('#scheme-select');
    const id = select.value;
    await Promise.all([host._applyScheme(id), host._deleteScheme()]);
    const { getActiveApiSchemeId, listApiSchemes } = await import('/js/core/api-schemes.js');
    return {
      activeId: getActiveApiSchemeId(),
      schemes: await listApiSchemes(),
      selectedId: select.value,
      name: host.shadowRoot.querySelector('#scheme-name').value
    };
  });

  expect(outcome).toEqual({ activeId: null, schemes: [], selectedId: '', name: '' });
});

test('custom selects reopen immediately after another select was opened', async ({ page }) => {
  await page.goto('/tests/fixtures/settings-panel-harness.html');
  await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__ === true);

  const settings = page.locator('settings-panel');
  await settings.locator('[data-section="connection"]').click();
  const wrappers = settings.locator('api-config-form .ns-select-wrapper:has(#scheme-select), api-config-form .ns-select-wrapper:has(#settings-api-backend)');
  await expect(wrappers).toHaveCount(2);

  await wrappers.nth(0).locator('.ns-select-trigger').click();
  await expect(wrappers.nth(0)).toHaveClass(/open/);
  await wrappers.nth(1).locator('.ns-select-trigger').click();
  await expect(wrappers.nth(0)).not.toHaveClass(/open/);
  await expect(wrappers.nth(1)).toHaveClass(/open/);
  await wrappers.nth(0).locator('.ns-select-trigger').click();
  await expect(wrappers.nth(0)).toHaveClass(/open/);
  await expect(wrappers.nth(1)).not.toHaveClass(/open/);
});

test('project support stays optional and exposes safe Afdian and WeChat methods', async ({ page }) => {
  await page.goto('/tests/fixtures/settings-panel-harness.html');
  await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__ === true);

  const settings = page.locator('settings-panel');
  await settings.locator('[data-section="support"]').click();
  await expect(settings.locator('#tab-support')).toBeVisible();
  await expect(settings.locator('#tab-support h3')).toHaveText('支持忍者手记持续开发');
  await expect(settings.locator('.save-state')).toHaveText('赞助完全自愿，不影响游戏功能');
  await expect(settings.locator('.actions > [data-action="save"]')).toBeHidden();
  await expect(settings.locator('.actions > [data-action="close"]')).toHaveText('关闭');
  await expect(settings.locator('.support-story')).toContainText('忍者手记是一款由个人独立开发并持续维护的开源 RPG 项目');
  await expect(settings.locator('.support-story')).toContainText('注册用户');
  await expect(settings.locator('.support-use-list li')).toHaveText([
    '项目服务器及运行环境维护',
    '新玩法与功能开发',
    '游戏体验优化',
    '项目长期维护与更新'
  ]);
  await expect(settings.locator('.support-community')).toContainText('即使不进行赞助');
  await expect(settings.locator('.support-gratitude')).toHaveText('感谢每一位参与忍者手记成长过程的玩家。');

  const afdian = settings.locator('.support-primary-link');
  await expect(afdian).toHaveAttribute('href', 'https://www.ifdian.net/a/2608_1?utm_source=copylink&utm_medium=link');
  await expect(afdian).toHaveAttribute('target', '_blank');
  await expect(afdian).toHaveAttribute('rel', 'noopener noreferrer');

  const qr = settings.locator('.support-qr-frame img');
  await expect(qr).toHaveAttribute('alt', '微信赞赏码');
  await expect(qr).toHaveJSProperty('complete', true);
  expect(await qr.evaluate(image => image.naturalWidth)).toBe(1210);

  const communityLinks = settings.locator('.support-community-link');
  await expect(communityLinks).toHaveCount(3);
  await expect(communityLinks.nth(0)).toHaveAttribute('href', 'https://www.qiwu.asia/announcements.html');
  await expect(communityLinks.nth(1)).toHaveAttribute('href', 'https://github.com/qiwu622/naruto-rpg');
  await expect(communityLinks.nth(2)).toHaveAttribute('href', 'https://github.com/qiwu622/naruto-rpg/issues');
  for (const link of await communityLinks.all()) {
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  }

  await settings.locator('[data-section="appearance"]').click();
  await expect(settings.locator('.actions > [data-action="save"]')).toBeVisible();
  await expect(settings.locator('.actions > [data-action="close"]')).toHaveText('放弃');
});

test('player settings keeps a page draft and applies only when requested', async ({ page }) => {
  await page.goto('/tests/fixtures/settings-panel-harness.html');
  await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__ === true);
  await page.evaluate(() => window.__SETTINGS_PANEL__.open({ section: 'gameplay' }));

  const settings = page.locator('settings-panel');
  await expect(settings.locator('[data-section="gameplay"]')).toHaveClass(/active/);
  await expect(settings.locator('#tab-system')).toBeVisible();

  const toggle = settings.locator('[name="showVariableSummary"]');
  const original = await toggle.isChecked();
  await toggle.setChecked(!original);
  await settings.locator('[data-section="appearance"]').click();
  await settings.locator('[data-section="gameplay"]').click();
  expect(await toggle.isChecked()).toBe(!original);

  await settings.locator('.actions > [data-action="save"]').click();
  await expect(settings.locator('.save-state')).toContainText('已应用');
  await expect(settings).toHaveCount(1);

  const persisted = await page.evaluate(async () => {
    const { stateManager } = await import('/js/core/state-manager.js');
    return stateManager.getSub('_ui').settings.showVariableSummary;
  });
  expect(persisted).toBe(!original);
});

test('reopening the active settings page preserves its scroll position and focused field', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 500 });
  await page.goto('/tests/fixtures/settings-panel-harness.html');
  await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__ === true);

  const settings = page.locator('settings-panel');
  await settings.locator('[data-section="media"]').click();
  const search = settings.locator('[name="musicSearch"]');
  await search.scrollIntoViewIfNeeded();
  await search.focus();
  const beforeScroll = await settings.locator('.content').evaluate(element => element.scrollTop);
  expect(beforeScroll).toBeGreaterThan(0);

  await page.evaluate(() => window.__SETTINGS_PANEL__.open({ section: 'media' }));
  const state = await settings.evaluate((host, expectedScroll) => {
    const root = host.shadowRoot;
    return {
      scrollTop: root.querySelector('.content').scrollTop,
      expectedScroll,
      searchFocused: root.activeElement === root.querySelector('[name="musicSearch"]')
    };
  }, beforeScroll);
  expect(Math.abs(state.scrollTop - state.expectedScroll)).toBeLessThanOrEqual(1);
  expect(state.searchFocused).toBe(true);
});

test('player settings deep-links to a visible anchor inside the requested page', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 500 });
  await page.goto('/tests/fixtures/settings-panel-harness.html');
  await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__ === true);

  await page.evaluate(() => window.__SETTINGS_PANEL__.open({ section: 'media', anchor: 'music-library' }));
  const settings = page.locator('settings-panel');
  await expect(settings.locator('[data-section="media"]')).toHaveClass(/active/);
  const position = await settings.evaluate(host => {
    const root = host.shadowRoot;
    const content = root.querySelector('.content').getBoundingClientRect();
    const target = root.querySelector('[data-anchor="music-library"]');
    if (!target) return null;
    const bounds = target.getBoundingClientRect();
    return {
      contentTop: content.top,
      contentBottom: content.bottom,
      targetTop: bounds.top,
      focused: root.activeElement === target
    };
  });
  expect(position).not.toBeNull();
  expect(position.targetTop).toBeGreaterThanOrEqual(position.contentTop - 1);
  expect(position.targetTop).toBeLessThan(position.contentBottom);
  expect(position.focused).toBe(true);
});

test('creator workbench has five tools and references the single main connection', async ({ page }) => {
  await page.goto('/tests/fixtures/settings-panel-harness.html?mode=creator&tool=canon&resourceId=plot');
  await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__ === true);

  const workbench = page.locator('settings-panel');
  await expect(workbench.locator('.panel')).toHaveClass(/creator/);
  await expect(workbench.locator('.title')).toContainText('创作者工作台');
  await expect(workbench.locator('.tab-btn')).toHaveText([
    '生成管线',
    '提示词与知识',
    '原作数据库',
    '画面工坊',
    '记忆运行时'
  ]);
  await expect(workbench.locator('[data-tool="canon"]')).toHaveClass(/active/);
  await expect(workbench.locator('#tab-canon-plot')).toBeVisible();
  await expect(workbench.locator('#tab-canon-techniques')).toBeVisible();
  await expect(workbench.locator('api-config-form')).toBeHidden();
  await expect(workbench.locator('.connection-strip')).toBeVisible();
  await expect(workbench.locator('[data-action="open-player-connection"]')).toBeVisible();
});

test('creator workbench deep-links to the requested resource inside a tool', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 500 });
  await page.goto('/tests/fixtures/settings-panel-harness.html?mode=creator&tool=canon&resourceId=techniques');
  await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__ === true);

  const workbench = page.locator('settings-panel');
  const position = await workbench.evaluate(host => {
    const root = host.shadowRoot;
    const content = root.querySelector('.content').getBoundingClientRect();
    const target = root.querySelector('[data-resource-id="techniques"]');
    if (!target) return null;
    const bounds = target.getBoundingClientRect();
    return {
      contentTop: content.top,
      contentBottom: content.bottom,
      targetTop: bounds.top,
      focused: root.activeElement === target
    };
  });
  expect(position).not.toBeNull();
  expect(position.targetTop).toBeGreaterThanOrEqual(position.contentTop - 1);
  expect(position.targetTop).toBeLessThan(position.contentBottom);
  expect(position.focused).toBe(true);
});

test('player gameplay restores archive controls, storage stats and both export formats', async ({ page }) => {
  await page.goto('/tests/fixtures/settings-panel-harness.html');
  await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__ === true);
  await page.evaluate(async () => {
    const { timelineSystem } = await import('/js/systems/timeline-system.js');
    const { eventBus } = await import('/js/core/event-bus.js');
    window.__ARCHIVE_STATS_CALLS__ = 0;
    window.__ARCHIVE_RUNS__ = 0;
    window.__EXPORT_REQUESTS__ = [];
    timelineSystem.getStorageStats = async () => {
      window.__ARCHIVE_STATS_CALLS__++;
      return { totalNodes: 120, activeCount: 100, archivedCount: 20, estimatedBytes: 2.5 * 1024 * 1024 };
    };
    timelineSystem.manualArchive = async () => {
      window.__ARCHIVE_RUNS__++;
      return { archived: 12 };
    };
    eventBus.on('timeline:export-request', request => window.__EXPORT_REQUESTS__.push(request));
  });

  const settings = page.locator('settings-panel');
  await settings.locator('[data-section="gameplay"]').click();
  await expect(settings.locator('[name="autoArchive"]')).toBeVisible();
  await expect(settings.locator('[data-action="check-storage"]')).toBeVisible();
  await expect(settings.locator('[data-action="manual-archive"]')).toBeVisible();
  await expect(settings.locator('[data-action="export-save"]')).toBeVisible();
  await expect(settings.locator('[data-action="export-save-json"]')).toBeVisible();
  await expect(settings.locator('#storage-info')).toContainText('节点 120');
  await expect(settings.locator('#storage-info')).toContainText('2.50 MB');

  await settings.locator('[data-action="manual-archive"]').click();
  await page.locator('game-modal').getByRole('button', { name: '确认压缩', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__ARCHIVE_RUNS__)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__ARCHIVE_STATS_CALLS__)).toBeGreaterThanOrEqual(2);

  await settings.locator('[data-action="export-save"]').click();
  await settings.locator('[data-action="export-save-json"]').click();
  await expect.poll(() => page.evaluate(() => window.__EXPORT_REQUESTS__)).toEqual([
    { compression: 'auto' },
    { compression: 'json' }
  ]);

  const autoArchive = settings.locator('[name="autoArchive"]');
  const originalAutoArchive = await autoArchive.isChecked();
  await autoArchive.setChecked(!originalAutoArchive);
  await settings.locator('.actions > [data-action="save"]').click();
  await expect.poll(() => page.evaluate(async () => {
    const { stateManager } = await import('/js/core/state-manager.js');
    return stateManager.getSub('_ui').settings.autoArchive;
  })).toBe(!originalAutoArchive);

  await settings.locator('[data-section="media"]').click();
  await expect(settings.locator('[name="imageEnabled"]')).toBeVisible();
});

test('player media exposes only daily image controls', async ({ page }) => {
  await page.goto('/tests/fixtures/settings-panel-harness.html');
  await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__ === true);

  const settings = page.locator('settings-panel');
  await settings.locator('[data-section="media"]').click();
  await expect(settings.locator('[name="imageEnabled"]')).toBeVisible();
  const imageMode = settings.locator('[name="imageTurnMode"]').locator('..');
  await expect(imageMode.locator('.ns-select-trigger')).toBeVisible();
  await expect(settings.locator('[data-action="open-image-gallery"]')).toBeVisible();
  await expect(settings.locator('[data-action="open-creator-image"]')).toBeVisible();
  await expect(settings.locator('image-studio-settings')).toBeHidden();

  await settings.locator('[name="imageEnabled"]').setChecked(true);
  await imageMode.locator('.ns-select-trigger').click();
  await imageMode.locator('.ns-select-option', { hasText: '每回合自动' }).click();
  await settings.locator('.actions > [data-action="save"]').click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('naruto_rpg_image_settings_v1'))?.enabled)).toBe(true);
  const imageSettings = await page.evaluate(() => JSON.parse(localStorage.getItem('naruto_rpg_image_settings_v1')));
  expect(imageSettings.enabled).toBe(true);
  expect(imageSettings.turnMode).toBe('auto');
});

test('creator workbench opens the worldbook editor inside its tool area', async ({ page }) => {
  await page.goto('/tests/fixtures/settings-panel-harness.html?mode=creator&tool=knowledge');
  await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__ === true);

  const workbench = page.locator('settings-panel');
  await workbench.locator('[data-action="open-worldbook-editor"]').click();
  const embedded = workbench.locator('.workbench-editor-layer.active > worldbook-editor[embedded]');
  await expect(embedded).toBeVisible();

  const bounds = await workbench.evaluate(host => {
    const root = host.shadowRoot;
    const head = root.querySelector('.head').getBoundingClientRect();
    const layer = root.querySelector('.workbench-editor-layer').getBoundingClientRect();
    return { headBottom: head.bottom, layerTop: layer.top };
  });
  expect(bounds.layerTop).toBeGreaterThanOrEqual(bounds.headBottom - 1);

  await embedded.locator('#btn-close').click();
  await expect(workbench.locator('.workbench-editor-layer')).not.toHaveClass(/active/);
  await expect(workbench.locator('#tab-lore')).toBeVisible();
});

test('closing the creator workbench returns from an embedded editor before leaving settings', async ({ page }) => {
  await page.goto('/tests/fixtures/settings-panel-harness.html?mode=creator&tool=knowledge');
  await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__ === true);

  const workbench = page.locator('settings-panel');
  await workbench.locator('[data-action="open-worldbook-editor"]').click();
  await expect(workbench.locator('.workbench-editor-layer.active > worldbook-editor[embedded]')).toBeVisible();

  await workbench.locator('.actions > [data-action="close"]').click();
  await expect(workbench).toHaveCount(1);
  await expect(workbench.locator('.workbench-editor-layer')).not.toHaveClass(/active/);
  await expect(workbench.locator('#tab-lore')).toBeVisible();
});

test('an embedded creator editor preserves its launching tool, scroll position and focus', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 500 });
  await page.goto('/tests/fixtures/settings-panel-harness.html?mode=creator&tool=knowledge');
  await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__ === true);

  const workbench = page.locator('settings-panel');
  const opener = workbench.locator('[data-action="open-main-preset-editor"]');
  await opener.scrollIntoViewIfNeeded();
  const beforeScroll = await workbench.locator('.content').evaluate(element => element.scrollTop);
  expect(beforeScroll).toBeGreaterThan(0);

  await opener.click();
  await expect(workbench.locator('.workbench-editor-layer.active > main-preset-editor[embedded]')).toBeVisible();
  await expect(workbench.locator('[data-tool="canon"]')).toBeDisabled();
  await expect(workbench.locator('[data-tool="knowledge"]')).toHaveClass(/active/);

  await workbench.locator('main-preset-editor #mpe-close').click();
  await expect(workbench.locator('.workbench-editor-layer')).not.toHaveClass(/active/);
  const restored = await workbench.evaluate((host, expectedScroll) => {
    const root = host.shadowRoot;
    const content = root.querySelector('.content');
    const opener = root.querySelector('[data-action="open-main-preset-editor"]');
    return {
      scrollTop: content.scrollTop,
      expectedScroll,
      openerFocused: root.activeElement === opener
    };
  }, beforeScroll);
  expect(Math.abs(restored.scrollTop - restored.expectedScroll)).toBeLessThanOrEqual(1);
  expect(restored.openerFocused).toBe(true);
});

test('creator workbench embeds and returns from variable and Canon editors', async ({ page }) => {
  await page.goto('/tests/fixtures/settings-panel-harness.html?mode=creator&tool=pipeline');
  await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__ === true);

  const workbench = page.locator('settings-panel');
  await workbench.locator('[data-action="open-variable-updater-preset-editor"]').click();
  const variableEditor = workbench.locator('.workbench-editor-layer.active > variable-updater-preset-editor[embedded]');
  await expect(variableEditor).toBeVisible();
  await variableEditor.locator('[data-action="close"]').click();
  await expect(workbench.locator('.workbench-editor-layer')).not.toHaveClass(/active/);

  await workbench.locator('[data-tool="canon"]').click();
  await workbench.locator('[data-action="open-canon-plot-editor"]').click();
  const canonEditor = workbench.locator('.workbench-editor-layer.active > canon-database-editor[embedded]');
  await expect(canonEditor).toBeVisible();
  await canonEditor.locator('[data-action="close"]').click();
  await expect(workbench.locator('.workbench-editor-layer')).not.toHaveClass(/active/);
  await expect(workbench.locator('[data-tool="canon"]')).toHaveClass(/active/);
});

test('closing player settings can apply every dirty page before exiting', async ({ page }) => {
  await page.goto('/tests/fixtures/settings-panel-harness.html');
  await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__ === true);

  const original = await page.evaluate(async () => {
    const { stateManager } = await import('/js/core/state-manager.js');
    const saved = stateManager.getSub('_ui').settings;
    return {
      fontSize: saved.fontSize,
      showVariableSummary: saved.showVariableSummary
    };
  });
  const nextFontSize = original.fontSize === 19 ? 18 : 19;
  const settings = page.locator('settings-panel');
  const fontSize = settings.locator('[name="fontSize"]');
  const summaryToggle = settings.locator('[name="showVariableSummary"]');

  await fontSize.fill(String(nextFontSize));
  await settings.locator('[data-section="gameplay"]').click();
  await summaryToggle.setChecked(!original.showVariableSummary);
  await settings.locator('.actions > [data-action="close"]').click();

  const modal = page.locator('game-modal');
  await expect(modal).toBeVisible();
  await expect(modal.getByRole('button')).toHaveText(['放弃并退出', '继续编辑', '应用并退出']);
  await modal.getByRole('button', { name: '应用并退出', exact: true }).click();
  await expect(settings).toHaveCount(0);

  await expect.poll(() => page.evaluate(async () => {
    const { stateManager } = await import('/js/core/state-manager.js');
    const saved = stateManager.getSub('_ui').settings;
    return `${saved.fontSize}:${saved.showVariableSummary}`;
  })).toBe(`${nextFontSize}:${!original.showVariableSummary}`);
});

test('closing player settings can continue editing without losing every page draft', async ({ page }) => {
  await page.goto('/tests/fixtures/settings-panel-harness.html');
  await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__ === true);

  const original = await page.evaluate(async () => {
    const { stateManager } = await import('/js/core/state-manager.js');
    const saved = stateManager.getSub('_ui').settings;
    return {
      fontSize: saved.fontSize,
      showVariableSummary: saved.showVariableSummary
    };
  });
  const nextFontSize = original.fontSize === 19 ? 18 : 19;
  const settings = page.locator('settings-panel');
  const fontSize = settings.locator('[name="fontSize"]');
  const summaryToggle = settings.locator('[name="showVariableSummary"]');
  await fontSize.fill(String(nextFontSize));
  await settings.locator('[data-section="gameplay"]').click();
  await summaryToggle.setChecked(!original.showVariableSummary);
  await settings.locator('.actions > [data-action="close"]').click();

  const modal = page.locator('game-modal');
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await expect(settings).toHaveCount(1);
  await expect(settings.locator('[data-section="gameplay"]')).toHaveClass(/active/);
  await expect(summaryToggle).toBeChecked({ checked: !original.showVariableSummary });
  await expect(settings.locator('.save-state')).toContainText('未应用');
  await settings.locator('[data-section="appearance"]').click();
  await expect(fontSize).toHaveValue(String(nextFontSize));

  const persisted = await page.evaluate(async () => {
    const { stateManager } = await import('/js/core/state-manager.js');
    const saved = stateManager.getSub('_ui').settings;
    return {
      fontSize: saved.fontSize,
      showVariableSummary: saved.showVariableSummary
    };
  });
  expect(persisted).toEqual(original);
});

test('closing player settings can discard every dirty page before exiting', async ({ page }) => {
  await page.goto('/tests/fixtures/settings-panel-harness.html');
  await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__ === true);

  const original = await page.evaluate(async () => {
    const { stateManager } = await import('/js/core/state-manager.js');
    const saved = stateManager.getSub('_ui').settings;
    return {
      fontSize: saved.fontSize,
      showVariableSummary: saved.showVariableSummary,
      musicLoopStorage: localStorage.getItem('naruto_music_loop')
    };
  });
  const nextFontSize = original.fontSize === 19 ? 18 : 19;
  const settings = page.locator('settings-panel');
  await settings.locator('[name="fontSize"]').fill(String(nextFontSize));
  await settings.locator('[data-section="gameplay"]').click();
  await settings.locator('[name="showVariableSummary"]').setChecked(!original.showVariableSummary);
  await settings.locator('[data-section="media"]').click();
  const musicLoop = settings.locator('[name="musicLoop"]');
  await musicLoop.setChecked(!(await musicLoop.isChecked()));
  await settings.locator('.actions > [data-action="close"]').click();

  const modal = page.locator('game-modal');
  await modal.getByRole('button', { name: '放弃并退出', exact: true }).click();
  await expect(settings).toHaveCount(0);

  const persisted = await page.evaluate(async () => {
    const { stateManager } = await import('/js/core/state-manager.js');
    const saved = stateManager.getSub('_ui').settings;
    return {
      fontSize: saved.fontSize,
      showVariableSummary: saved.showVariableSummary,
      musicLoopStorage: localStorage.getItem('naruto_music_loop')
    };
  });
  expect(persisted).toEqual(original);
});
