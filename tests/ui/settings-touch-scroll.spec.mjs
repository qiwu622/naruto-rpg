import { test, expect } from '@playwright/test';

test.use({ hasTouch: true, isMobile: true });

async function swipe(page, box, upwards = true) {
  const session = await page.context().newCDPSession(page);
  const x = box.x + box.width * .8;
  const bottom = box.y + box.height - 12;
  const top = box.y + 12;
  const start = upwards ? bottom : top;
  const end = upwards ? top : bottom;
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] });
    for (let i = 1; i <= 10; i++) {
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start + (end - start) * i / 10 }] });
      await page.waitForTimeout(25);
    }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally { await session.detach(); }
}

for (const mode of ['player', 'creator']) {
  for (const viewport of [{ width: 360, height: 544 }, { width: 640, height: 288 }, { width: 360, height: 281 }]) {
    test(`${mode} settings scroll by touch at ${viewport.width}x${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/tests/fixtures/settings-panel-harness.html?mode=${mode}`);
      await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__);
      const settings = page.locator('settings-panel');
      const body = settings.locator('.layout');
      const box = await body.boundingBox();
      const actions = await settings.locator('.actions').boundingBox();
      expect(box.y + box.height).toBeLessThanOrEqual(actions.y + 1);
      await swipe(page, box);
      await expect.poll(() => body.evaluate(e => e.scrollTop)).toBeGreaterThan(40);
      await expect(settings.locator('.actions')).toBeInViewport();
      // The navigation is part of the same scroll area, so a short WebView can
      // still reach the settings content without dragging a covered inner box.
      expect(await settings.locator('.content').evaluate(e => getComputedStyle(e).overflowY)).toBe('visible');
      await swipe(page, box, false);
      await expect.poll(() => body.evaluate(e => e.scrollTop)).toBeLessThan(10);
    });
  }
}

test('switching sections and returning from an embedded editor use the active mobile scroll area', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 544 });
  await page.goto('/tests/fixtures/settings-panel-harness.html?mode=creator');
  await page.waitForFunction(() => window.__SETTINGS_HARNESS_READY__);
  const settings = page.locator('settings-panel');
  await settings.locator('[data-tool="canon"]').click();
  await settings.locator('[data-action="open-canon-plot-editor"]').click();
  const layer = settings.locator('.workbench-editor-layer.active');
  await expect(layer).toBeVisible();
  const layoutBox = await settings.locator('.layout').boundingBox();
  const layerBox = await layer.boundingBox();
  expect(layerBox.y).toBeGreaterThanOrEqual(layoutBox.y - 1);
  expect(layerBox.y + layerBox.height).toBeLessThanOrEqual(layoutBox.y + layoutBox.height + 1);
  await layer.locator('canon-database-editor').evaluate(e => e.remove());
  await expect(layer).toHaveCount(0);
  await expect.poll(() => settings.locator('.layout').evaluate(e => getComputedStyle(e).overflowY)).toBe('auto');
});
