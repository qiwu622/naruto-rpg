import { test, expect } from '@playwright/test';
test.use({ channel: 'chromium' });
async function open(page) {
  await page.goto('/tests/fixtures/turn-receipt-app-shell-harness.html');
  await page.waitForFunction(() => window.__RECEIPT_SHELL_READY__);
}

test('real AppShell mounts a completed receipt after narrative and retains it while editing', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.fixture.complete());
  const content = page.locator('#chat-messages .chat-content').last();
  await expect(content.locator('turn-receipt-card')).toHaveCount(1);
  await expect(content).toContainText('夕光落在训练场上');
  expect(await content.evaluate(node => node.lastElementChild.tagName)).toBe('TURN-RECEIPT-CARD');
  await content.locator('turn-receipt-card summary').click();
  await expect(content.locator('turn-receipt-card')).toContainText('重试 1 次');
  await content.locator('.edit-ai-btn').click();
  await content.locator('button').filter({ hasText: '取消' }).click();
  await expect(content.locator('turn-receipt-card')).toHaveCount(1);
  await expect(content.locator('turn-receipt-card summary')).toContainText('第 8 回合');
  await content.locator('turn-receipt-card summary').click();
  await page.screenshot({ path: '.codex-tmp/turn-receipt-app-shell.png', fullPage: true });
});

test('actual timeline transaction and IndexedDB reload restore receipt; legacy node stays unknown', async ({ page }) => {
  await open(page);
  await page.evaluate(() => window.fixture.persist());
  await page.reload(); await page.waitForFunction(() => window.__RECEIPT_SHELL_READY__);
  const card = page.locator('#chat-messages turn-receipt-card');
  await expect(card.locator('summary')).toContainText('第 8 回合');
  await card.locator('summary').click();
  await expect(card).toContainText('本回合已保存到本机');
  await expect(card.locator('[data-section="stages"]')).toContainText('耗时未记录');
  await page.evaluate(async () => {
    const { stateManager, appShell } = window.fixture;
    const id = await window.fixture.persist(null);
    const node = await stateManager.dbGet('timeline_nodes', id);
    appShell.restoreChatHistory([], node.clean_response, { timelineNodeId: id });
  });
  await expect(card.locator('summary')).toContainText('此回合未记录结果');
  await card.locator('summary').click();
  await expect(card).not.toContainText('本回合已保存到本机');
  await expect(page.locator('#chat-messages')).toContainText('夕光落在训练场上');
});

test('stale asynchronous node read cannot replace the newly navigated receipt', async ({ page }) => {
  await open(page);
  await page.evaluate(async () => {
    const { appShell, stateManager, receipt } = window.fixture;
    const original = stateManager.dbGet.bind(stateManager);
    let resolveOld;
    stateManager.dbGet = async (store, id) => id === 'slow-old' ? new Promise(resolve => { resolveOld = resolve; }) : original(store, id);
    const oldHost = document.querySelector('#chat-messages .chat-content');
    const pending = appShell._mountStoredTurnReceipt('slow-old', oldHost, appShell._receiptViewRevision);
    appShell.renderSinglePage('新节点正文');
    resolveOld({ turn_receipt: receipt });
    await pending;
    stateManager.dbGet = original;
  });
  await expect(page.locator('#chat-messages')).toContainText('新节点正文');
  await expect(page.locator('turn-receipt-card summary')).toContainText('此回合未记录结果');
  await expect(page.locator('turn-receipt-card summary')).not.toContainText('第 8 回合');
});

test('failed request receipt never overwrites the preceding completed turn', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.fixture.complete();
    window.fixture.eventBus.emit('pipeline:processing', { userInput: '继续训练' });
    window.fixture.fail();
  });
  const previous = page.locator('.chat-message--ai turn-receipt-card').last();
  const failed = page.locator('.chat-message--error turn-receipt-card');
  await expect(previous.locator('summary')).toContainText('第 8 回合');
  await expect(previous.locator('summary')).not.toContainText('本地保存未完成');
  await expect(failed.locator('summary')).toContainText('第 9 回合');
  await expect(failed.locator('summary')).toContainText('本地保存未完成');
});

test('receipt render failure is isolated from completed story and input readiness', async ({ page }) => {
  await open(page);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => {
    const original = document.createElement.bind(document);
    document.createElement = function(name, ...args) {
      if (name === 'turn-receipt-card') throw new Error('forced receipt render failure');
      return original(name, ...args);
    };
    try { window.fixture.complete(); } finally { document.createElement = original; }
  });
  await expect(page.locator('#chat-messages')).toContainText('夕光落在训练场上');
  await expect(page.locator('#btn-send')).toBeEnabled();
  expect(await page.evaluate(() => window.fixture.appShell._isProcessing)).toBe(false);
  expect(errors).toEqual([]);
});
