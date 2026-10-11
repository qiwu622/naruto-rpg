import { test, expect } from '@playwright/test';

const story = count => Array.from({ length: count }, (_, index) => `第 ${index + 1} 段：风吹过木叶的街道，同伴在任务所等待。`.repeat(5)).join('\n\n');

async function openReader(page) {
  await page.goto('/tests/fixtures/preset-output-app-shell-harness.html?mode=fallback');
  await page.waitForFunction(() => window.__PRESET_OUTPUT_HARNESS_READY__);
  await page.addStyleTag({ content: '#app-shell{height:100dvh;min-height:0}.chat-container{min-height:0}' });
  await page.evaluate(async () => {
    const { appShell } = await import('/js/ui/app-shell.js');
    const { stateManager } = await import('/js/core/state-manager.js');
    const { eventBus } = await import('/js/core/event-bus.js');
    Object.assign(window, { reading: { appShell, stateManager, eventBus } });
  });
}

async function stream(page, text, agent = false) {
  await page.evaluate(({ text, agent }) => {
    reading.eventBus.emit(agent ? 'agent:stream' : 'pipeline:chunk', agent
      ? { agent: 'final-writer', chunk: text } : { response: text });
  }, { text, agent });
  // Include the animation frames in which the old forced smooth scroll ran.
  await page.waitForTimeout(450);
}

const scrollTop = page => page.locator('.chat-container').evaluate(element => element.scrollTop);
const moveTo = (page, top) => page.locator('.chat-container').evaluate((element, top) => {
  element.scrollTo({ top, behavior: 'instant' });
  return element.scrollTop;
}, top);

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`streaming keeps the reader's chosen position at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openReader(page);
    await stream(page, story(45));
    const chosen = await moveTo(page, 360);
    await stream(page, story(55));
    expect(Math.abs(await scrollTop(page) - chosen)).toBeLessThanOrEqual(2);
    // Scrolling during generation remains usable in both directions.
    const area = await page.locator('.chat-container').boundingBox();
    await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
    await page.mouse.wheel(0, 280);
    await expect.poll(() => scrollTop(page)).toBeGreaterThan(chosen + 100);
    const afterWheel = await scrollTop(page);
    await stream(page, story(65));
    expect(Math.abs(await scrollTop(page) - afterWheel)).toBeLessThanOrEqual(2);
    await moveTo(page, 0);
    await stream(page, '\n\n' + story(8), true);
    expect(await scrollTop(page)).toBeLessThanOrEqual(2);
  });
}

test('new reasoning and agent details start collapsed, remain manually expandable', async ({ page }) => {
  await openReader(page);
  expect(await page.evaluate(() => reading.stateManager.getDefaultState()._ui.settings.reasoningOpen)).toBe(false);
  await page.evaluate(() => window.__PRESET_OUTPUT_HARNESS__.finish('本回合的正文。', '本回合的正文。'));
  const block = page.locator('.think-block');
  await expect(block).toHaveClass(/think-collapsed/);
  await expect(block.locator('.think-body')).toBeHidden();
  await block.locator('.think-toggle').click();
  await expect(block.locator('.think-body')).toBeVisible();
  await block.locator('.think-toggle').click();
  await expect(block.locator('.think-body')).toBeHidden();
  await page.evaluate(async () => {
    await import('/js/ui/agent-progress.js');
    document.querySelector('#chat-messages').append(document.createElement('agent-progress'));
    reading.eventBus.emit('agent:reasoning', { agent: 'critic-realism', chunk: '可手动查看的子代理推演。' });
  });
  const progress = page.locator('agent-progress');
  await expect(progress.locator('#detail-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(progress.locator('#detail-panel')).toBeHidden();
  await progress.locator('#detail-toggle').click();
  await expect(progress.locator('#detail-panel')).toBeVisible();
  await expect(progress.locator('.agent-detail')).not.toHaveAttribute('open', '');
  await progress.locator('.agent-detail summary').click();
  await expect(progress.locator('.agent-detail pre')).toBeVisible();
});

test('saving the reasoning switch applies to displayed blocks and survives an old snapshot', async ({ page }) => {
  await openReader(page);
  await page.evaluate(async () => {
    const ui = reading.stateManager.getSub('_ui');
    reading.stateManager.setSub('_ui', { ...ui, settings: { ...ui.settings, reasoningOpen: true } });
    window.oldReadingSnapshot = reading.stateManager.snapshot();
    await window.__PRESET_OUTPUT_HARNESS__.finish('正文', '正文');
    await import('/js/ui/agent-progress.js');
    document.querySelector('#chat-messages').append(document.createElement('agent-progress'));
    await import('/js/ui/settings-panel.js');
    const settings = document.createElement('settings-panel');
    document.body.append(settings);
    settings.shadowRoot.querySelector('[name="reasoningOpen"]').checked = false;
    if (!await settings._save({ section: 'gameplay', announce: false })) throw new Error('settings save failed');
    settings.remove();
  });
  await expect(page.locator('.think-body')).toBeHidden();
  await expect(page.locator('agent-progress #detail-panel')).toBeHidden();
  const preference = await page.evaluate(() => {
    reading.stateManager.restore(oldReadingSnapshot);
    return reading.stateManager.getSub('_ui').settings.reasoningOpen;
  });
  expect(preference).toBe(false);
  await page.evaluate(() => window.__PRESET_OUTPUT_HARNESS__.finish('下一回正文', '下一回正文'));
  await expect(page.locator('.think-block').last()).toHaveClass(/think-collapsed/);
});

test('completion, variable results and failure notices do not move the reading position', async ({ page }) => {
  await openReader(page);
  await page.evaluate(() => {
    const ui = reading.stateManager.getSub('_ui');
    reading.stateManager.setSub('_ui', { ...ui, settings: { ...ui.settings, reasoningOpen: false } });
  });
  await stream(page, story(55));
  const chosen = await moveTo(page, 420);
  await page.evaluate(text => window.__PRESET_OUTPUT_HARNESS__.finish(text, text), story(55));
  await page.waitForTimeout(450);
  expect(Math.abs(await scrollTop(page) - chosen)).toBeLessThanOrEqual(2);
  await expect(page.locator('[data-shinobi-daily-host]')).toHaveCount(1);
  await page.evaluate(() => reading.eventBus.emit('pipeline:error', { error: '测试失败提示', lastUserInput: '继续' }));
  await page.waitForTimeout(450);
  expect(Math.abs(await scrollTop(page) - chosen)).toBeLessThanOrEqual(2);
});

test('preset iframe expansion leaves a reader near the bottom in control', async ({ page }) => {
  await openReader(page);
  await page.evaluate(async () => {
    const { mountPresetOutputSandbox } = await import('/js/ui/preset-output-sandbox.js');
    mountPresetOutputSandbox(document.querySelector('#chat-messages'), '<section id="resize-test">' + '<p>预设正文</p>'.repeat(75) + '</section>');
  });
  const frame = page.locator('.preset-output-sandbox');
  await expect(frame).not.toHaveAttribute('aria-busy', 'true');
  await expect.poll(() => frame.evaluate(element => element.clientHeight)).toBeGreaterThan(1000);
  const chosen = await page.locator('.chat-container').evaluate(element => {
    element.scrollTo({ top: element.scrollHeight - element.clientHeight - 60, behavior: 'instant' });
    return element.scrollTop;
  });
  await frame.contentFrame().locator('#resize-test').evaluate(element => {
    for (let index = 0; index < 100; index++) {
      const paragraph = document.createElement('p'); paragraph.textContent = '追加的预设正文'; element.append(paragraph);
    }
  });
  await expect.poll(() => frame.evaluate(element => element.clientHeight)).toBeGreaterThan(2000);
  await page.waitForTimeout(450);
  expect(Math.abs(await scrollTop(page) - chosen)).toBeLessThanOrEqual(2);
});

test('opened agent reasoning retains its own scroll position across streamed updates', async ({ page }) => {
  await openReader(page);
  await page.evaluate(async () => {
    await import('/js/ui/agent-progress.js');
    document.querySelector('#chat-messages').append(document.createElement('agent-progress'));
    reading.eventBus.emit('agent:reasoning', { agent: 'critic-realism', chunk: '推演内容\n'.repeat(150) });
  });
  const progress = page.locator('agent-progress');
  if (await progress.locator('#detail-toggle').getAttribute('aria-expanded') !== 'true') await progress.locator('#detail-toggle').click();
  await progress.locator('.agent-detail summary').click();
  await expect(progress.locator('.agent-detail')).toHaveAttribute('open', '');
  const chosen = await progress.locator('.agent-detail pre').evaluate(element => { element.scrollTop = 160; return element.scrollTop; });
  await page.evaluate(() => reading.eventBus.emit('agent:reasoning', { agent: 'critic-realism', chunk: '追加推演内容\n'.repeat(20) }));
  await expect(progress.locator('.agent-detail pre')).toContainText('追加推演内容');
  expect(await progress.locator('.agent-detail pre').evaluate(element => element.scrollTop)).toBe(chosen);
});

test('agent stream previews retain earlier text and do not pin their own scrollbar', async ({ page }) => {
  await openReader(page);
  await page.evaluate(async () => {
    await import('/js/ui/agent-progress.js');
    document.querySelector('#chat-messages').append(document.createElement('agent-progress'));
    reading.eventBus.emit('agent:stream', { agent: 'outliner', chunk: '最早的推演内容\n' + '这一段需要慢慢阅读。\n'.repeat(200) });
  });
  const progress = page.locator('agent-progress');
  await progress.locator('#detail-toggle').click();
  const preview = progress.locator('#stream');
  const chosen = await preview.evaluate(element => { element.scrollTop = 90; return element.scrollTop; });
  expect(chosen).toBeGreaterThan(0);
  await page.evaluate(() => reading.eventBus.emit('agent:stream', { agent: 'outliner', chunk: '新补充的内容。\n'.repeat(80) }));
  await expect(preview).toContainText('最早的推演内容');
  await expect(preview).toContainText('新补充的内容');
  expect(await preview.evaluate(element => element.scrollTop)).toBe(chosen);
});
