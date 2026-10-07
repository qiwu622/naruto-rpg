import { test, expect } from '@playwright/test';

test.use({ channel: 'chromium' });
async function open(page) {
  await page.goto('/tests/fixtures/turn-receipt-harness.html');
  await page.waitForFunction(() => window.__TURN_RECEIPT_READY__ === true);
  return page.locator('turn-receipt-card');
}

test('receipt follows narrative, starts folded and opens with a keyboard', async ({ page }) => {
  const card = await open(page);
  await expect(card.locator('details')).not.toHaveAttribute('open', '');
  const [storyBox, cardBox] = await Promise.all([page.locator('#narrative').boundingBox(), card.boundingBox()]);
  expect(cardBox.y).toBeGreaterThan(storyBox.y + storyBox.height);
  await card.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(card.locator('[data-section="variables"]')).toBeVisible();
  await expect(card).toContainText('当前查克拉');
  await expect(card).toContainText('重试 1 次');
  await expect(card.locator('[data-section="memory"]')).toContainText('新增');
  await expect(card.locator('[data-section="memory"]')).toContainText('变更');
  await page.screenshot({ path: '.codex-tmp/turn-receipt-standard-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 360, height: 900 });
  await page.screenshot({ path: '.codex-tmp/turn-receipt-standard-mobile.png', fullPage: true });
  await card.locator('summary').click();
  await expect(card.locator('[data-section="variables"]')).not.toBeVisible();
});

test('stored receipt restores after reload and a legacy turn stays unknown', async ({ page }) => {
  let card = await open(page);
  await page.evaluate(() => window.setReceiptFixture({ ...window.receiptFixture, save: { status: 'failed', reasonCode: 'quota' } }, true));
  await page.reload(); await page.waitForFunction(() => window.__TURN_RECEIPT_READY__ === true);
  card = page.locator('turn-receipt-card');
  await expect(card.locator('summary')).toContainText('本地保存未完成');
  await card.locator('summary').click();
  await expect(card.locator('[data-section="save"]')).toContainText('本机存储空间不足');
  await page.evaluate(() => window.setReceiptFixture(null));
  await expect(card).toContainText('无法确认当时的变量、记忆、日报及保存状态');
  await expect(card).not.toContainText('已保存到本机');
  await expect(page.locator('#narrative')).toBeVisible();
});

test('partial and skipped outcomes show real failures while preserving the narrative', async ({ page }) => {
  const card = await open(page);
  await page.evaluate(() => window.setReceiptFixture({ ...window.receiptFixture,
    variables: { ...window.receiptFixture.variables, status: 'skipped' },
    memory: { ...window.receiptFixture.memory, status: 'partial' },
    daily: { status: 'failed' }, save: { status: 'success' },
    stages: [{ key: 'variables', status: 'skipped', durationMs: 5200, retries: 2 }, { key: 'narrative', status: 'success' }]
  }));
  await card.locator('summary').click();
  await expect(card.locator('summary')).toContainText('有项目未完成');
  await expect(card).toContainText('跳过变量更新');
  await expect(card).toContainText('记忆仅部分更新');
  await expect(card).toContainText('日报生成未完成');
  await expect(card).toContainText('耗时未记录 · 重试未记录');
  await expect(card).toContainText('重试 2 次');
  await expect(page.locator('#narrative')).toHaveText(/夕光落在训练场上/);
});

test('untrusted receipt text is inert and private runtime fields are absent', async ({ page }) => {
  const card = await open(page);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => window.setReceiptFixture({ ...window.receiptFixture,
    rawPrompt: 'RAW_PROMPT_PRIVATE',
    variables: { status: 'success', changes: [{ label: '<img src=x onerror="window.hacked=1">查克拉', before: '<script>window.hacked=2<\/script>', after: '20' }] },
    memory: { status: 'success', changes: [{ label: '事实记忆', kind: 'added', text: '<think>PRIVATE_NPC_REASONING</think>已完成训练 <img src=x onerror="window.hacked=3">' }] },
    stages: [{ key: 'narrative', status: 'success', prompt: 'PRIVATE_STAGE', error: 'sk-1234567890123456' }]
  }));
  await card.locator('summary').click();
  expect(await card.locator('img,script,iframe').count()).toBe(0);
  expect(await page.evaluate(() => window.hacked)).toBeUndefined();
  await expect(card).not.toContainText('PRIVATE');
  await expect(card).not.toContainText('sk-');
  expect(errors).toEqual([]);
});

for (const width of [360, 1280]) test(`receipt fits ${width}px with long content and has bounded sections`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const card = await open(page);
  await page.evaluate(() => window.setReceiptFixture({ ...window.receiptFixture,
    variables: { status: 'partial', total: 90, changes: Array.from({ length: 90 }, () => ({ label: '很长的装备名称'.repeat(30), before: '旧状态'.repeat(100), after: '新状态'.repeat(100) })) },
    memory: { status: 'success', total: 70, changes: Array.from({ length: 70 }, () => ({ label: '事实记忆', kind: 'added', text: '长记忆内容'.repeat(100) })) }
  }));
  await card.locator('summary').click();
  expect(await card.locator('[data-section="variables"] li').count()).toBe(12);
  expect(await card.locator('[data-section="memory"] li').count()).toBe(8);
  const box = await card.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(await card.evaluate(node => [...node.shadowRoot.querySelectorAll('details,.body,.section,li')].every(item => item.scrollWidth <= item.clientWidth + 1))).toBe(true);
  await page.screenshot({ path: `.codex-tmp/turn-receipt-${width}.png`, fullPage: true });
});
