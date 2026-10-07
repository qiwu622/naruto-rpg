import { test, expect } from '@playwright/test';

async function openLingXi(page) {
  await page.goto('/tests/fixtures/lingxi-companion-harness.html');
  await page.waitForFunction(() => window.__LINGXI_HARNESS_READY__ === true);
  const companion = page.locator('lingxi-companion');
  await companion.locator('.pet-button').click();
  const panel = companion.locator('.panel');
  await expect(panel).toBeVisible();
  await panel.evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished));
  });
  return companion;
}

async function loadLingXi(page) {
  await page.goto('/tests/fixtures/lingxi-companion-harness.html');
  await page.waitForFunction(() => window.__LINGXI_HARNESS_READY__ === true);
  return page.locator('lingxi-companion');
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 }
]) {
  test(`desktop companion stays clear of primary controls at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const companion = await openLingXi(page);
    const bounds = await page.evaluate(() => {
      const host = document.querySelector('lingxi-companion');
      const panel = host.shadowRoot.querySelector('.panel').getBoundingClientRect();
      const input = document.querySelector('.chat-input-area').getBoundingClientRect();
      const status = document.querySelector('.app-statusbar').getBoundingClientRect();
      return {
        panel: { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom },
        input: { left: input.left, right: input.right, top: input.top, bottom: input.bottom },
        status: { left: status.left, right: status.right, top: status.top, bottom: status.bottom },
        viewport: { width: innerWidth, height: innerHeight },
        overflow: document.documentElement.scrollWidth - innerWidth
      };
    });
    expect(bounds.panel.left).toBeGreaterThanOrEqual(0);
    expect(bounds.panel.right).toBeLessThanOrEqual(bounds.viewport.width);
    expect(bounds.panel.top).toBeGreaterThanOrEqual(0);
    expect(bounds.panel.bottom).toBeLessThanOrEqual(bounds.input.top);
    expect(bounds.panel.bottom).toBeLessThanOrEqual(bounds.status.top);
    expect(bounds.overflow).toBeLessThanOrEqual(0);
    await expect(companion.locator('.profile-button img')).toHaveJSProperty('complete', true);
  });
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 360, height: 800 }
]) {
  test(`mobile companion owns a non-overlapping tool surface at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const companion = await openLingXi(page);
    await expect(page.locator('.chat-input-area')).toBeHidden();
    const bounds = await companion.locator('.panel').boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    await expect(companion.locator('.composer textarea')).toBeFocused();
  });
}

test('cancelling a new chat keeps the full conversation', async ({ page }) => {
  const companion = await openLingXi(page);
  await page.evaluate(() => window.__LINGXI_HARNESS__.seedHistory());
  const before = await page.evaluate(() => structuredClone(window.__LINGXI_HARNESS__.history));

  const newChatButton = companion.locator('.clear-button');
  await newChatButton.click();
  await expect(companion.locator('.new-chat-overlay')).toBeVisible();
  await expect(companion.locator('.new-chat-cancel')).toBeFocused();
  await companion.locator('.new-chat-cancel').click();

  await expect(companion.locator('.new-chat-overlay')).toBeHidden();
  expect(await page.evaluate(() => structuredClone(window.__LINGXI_HARNESS__.history))).toEqual(before);
  await expect(companion.locator('.messages .message')).toHaveCount(before.length);
  await expect(newChatButton).toBeFocused();
});

test('confirming a new chat resets history and discards pending proposals', async ({ page }) => {
  const companion = await openLingXi(page);
  await page.evaluate(() => {
    window.__LINGXI_HARNESS__.seedHistory();
    window.__LINGXI_HARNESS__.stageProposal();
  });
  await expect(companion.locator('.messages .message')).toHaveCount(3);
  await expect(companion.locator('.proposal-band')).toBeVisible();

  await companion.locator('.clear-button').click();
  await expect(companion.locator('.new-chat-overlay')).toBeVisible();
  await expect(companion.locator('.new-chat-pending')).toBeVisible();
  await companion.locator('.new-chat-confirm').click();

  await expect(companion.locator('.new-chat-overlay')).toBeHidden();
  await expect(companion.locator('.messages .message')).toHaveCount(1);
  await expect(companion.locator('.messages .message.assistant')).toContainText('新的卷轴已经展开');
  await expect(companion.locator('.proposal-band')).toBeHidden();
  await expect(companion.locator('.composer textarea')).toBeFocused();
  const state = await page.evaluate(() => ({
    history: structuredClone(window.__LINGXI_HARNESS__.history),
    pending: window.__LINGXI_HARNESS__.getPendingProposal(),
    proposalCount: window.__LINGXI_HARNESS__.getProposalCount(),
    discarded: [...window.__LINGXI_HARNESS__.discarded]
  }));
  expect(state.history).toEqual([{ role: 'assistant', content: '新的卷轴已经展开。' }]);
  expect(state.pending).toBeNull();
  expect(state.proposalCount).toBe(0);
  expect(state.discarded).toContain('lingxi_action_test');
});

test('new chat is disabled while Ling Xi is answering', async ({ page }) => {
  const companion = await openLingXi(page);
  await page.evaluate(() => window.__LINGXI_HARNESS__.setSendHold(true));
  await companion.locator('.composer textarea').fill('先完成当前消息');
  await companion.locator('.composer-send').click();
  await page.waitForFunction(() => window.__LINGXI_HARNESS__.getSendStarted());

  const newChatButton = companion.locator('.clear-button');
  await expect(newChatButton).toBeDisabled();
  await expect(companion.locator('.new-chat-overlay')).toBeHidden();

  await page.evaluate(() => window.__LINGXI_HARNESS__.releaseSend());
  await expect(newChatButton).toBeEnabled();
  await expect(companion.locator('.message.assistant').last()).toContainText('查克拉状态正常');
});

test('new chat dialog traps focus and Escape restores the trigger', async ({ page }) => {
  const companion = await openLingXi(page);
  const newChatButton = companion.locator('.clear-button');
  const closeButton = companion.locator('.new-chat-close');
  const confirmButton = companion.locator('.new-chat-confirm');

  await newChatButton.click();
  await expect(companion.locator('.new-chat-overlay')).toBeVisible();
  await expect(companion.locator('.new-chat-cancel')).toBeFocused();

  await closeButton.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(confirmButton).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(closeButton).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(companion.locator('.new-chat-overlay')).toBeHidden();
  await expect(newChatButton).toBeFocused();
});

test('approval requires one trusted confirmation click and no typed phrase', async ({ page }) => {
  const companion = await openLingXi(page);
  await page.evaluate(() => window.__LINGXI_HARNESS__.stageProposal());
  await expect(companion.locator('.proposal-band')).toBeVisible();
  await companion.locator('.proposal-review').click();
  await expect(companion.locator('.approval-overlay')).toBeVisible();
  await expect(companion.locator('.diff-path')).toContainText('属性·当前查克拉');
  await expect(companion.locator('.impact-checkpoint')).toContainText('node_7');
  await expect(companion.locator('.impact-branch')).toContainText('维护记录将原地附加');

  await expect(companion.locator('.approval-input')).toHaveCount(0);
  await companion.locator('.approval-dialog .approval-confirm').click();
  await expect(companion.locator('.approval-overlay')).toBeHidden();
  expect(await page.evaluate(() => window.__LINGXI_HARNESS__.approvals.length)).toBe(1);
  await expect(companion.locator('.receipt')).toContainText('node_lingxi_8');
  await expect(companion.locator('.composer textarea')).toBeFocused();
});

test('approval pins the visible proposal when a newer proposal arrives', async ({ page }) => {
  const companion = await openLingXi(page);
  await page.evaluate(() => window.__LINGXI_HARNESS__.stageProposal());
  await companion.locator('.proposal-review').click();
  await expect(companion.locator('.diff-path')).toContainText('属性·当前查克拉');

  await page.evaluate(() => window.__LINGXI_HARNESS__.stageSettingsProposal());
  await companion.locator('.approval-dialog .approval-confirm').click();

  expect(await page.evaluate(() => window.__LINGXI_HARNESS__.approvals.at(-1)?.proposalId))
    .toBe('lingxi_action_test');
  await expect(companion.locator('.proposal-band')).toBeVisible();
  await companion.locator('.proposal-review').click();
  await expect(companion.locator('.impact-title')).toHaveText('设置影响');
});

test('requestSubmit cannot replace a trusted confirmation click', async ({ page }) => {
  const companion = await openLingXi(page);
  await page.evaluate(() => window.__LINGXI_HARNESS__.stageProposal());
  await companion.locator('.proposal-review').click();
  await companion.locator('.approval-dialog').evaluate(form => {
    form.requestSubmit(form.querySelector('.approval-confirm'));
  });
  await expect(companion.locator('.approval-error')).toContainText('trusted confirmation');
  expect(await page.evaluate(() => window.__LINGXI_HARNESS__.approvals.length)).toBe(0);

  await companion.locator('.approval-dialog .approval-confirm').click();
  expect(await page.evaluate(() => window.__LINGXI_HARNESS__.approvals.length)).toBe(1);
});

test('approval and profile dialogs trap focus and restore it when closed', async ({ page }) => {
  const companion = await openLingXi(page);
  await page.evaluate(() => window.__LINGXI_HARNESS__.stageProposal());
  const review = companion.locator('.proposal-review');
  await review.click();

  const approvalClose = companion.locator('.approval-close');
  const approvalConfirm = companion.locator('.approval-dialog .approval-confirm');
  await approvalClose.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(approvalConfirm).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(approvalClose).toBeFocused();
  await approvalClose.click();
  await expect(companion.locator('.approval-overlay')).toBeHidden();
  await expect(companion.locator('.composer textarea')).toBeFocused();

  const profileButton = companion.locator('.profile-button');
  const profileClose = companion.locator('.profile-close');
  await profileButton.click();
  await expect(profileClose).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(profileClose).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(profileClose).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(companion.locator('.profile-overlay')).toBeHidden();
  await expect(profileButton).toBeFocused();
});

test('non-variable proposals show their signed impact and can be approved', async ({ page }) => {
  const companion = await openLingXi(page);
  await page.evaluate(() => window.__LINGXI_HARNESS__.stageSettingsProposal());
  await companion.locator('.proposal-review').click();
  await expect(companion.locator('.impact-title')).toHaveText('设置影响');
  await expect(companion.locator('.impact-checkpoint')).toHaveText('保存 1 项界面设置');
  await expect(companion.locator('.impact-branch')).toContainText('fontSize: 16 -> 18');
  await companion.locator('.approval-dialog .approval-confirm').click();
  await expect(companion.locator('.approval-overlay')).toBeHidden();
  await expect(companion.locator('.receipt')).toContainText('字体大小设置已经应用好啦');
});

test('timeline proposals show destructive impact and keep approval available', async ({ page }) => {
  const companion = await openLingXi(page);
  await page.evaluate(() => window.__LINGXI_HARNESS__.stageTimelineProposal());
  await companion.locator('.proposal-review').click();
  await expect(companion.locator('.impact-title')).toHaveText('时间线操作影响');
  await expect(companion.locator('.impact-checkpoint')).toHaveText('永久逆转到节点 node_4');
  await expect(companion.locator('.impact-branch')).toContainText('永久删除后续 3 个节点');
  await expect(companion.locator('.approval-input')).toHaveCount(0);
  await companion.locator('.approval-dialog .approval-confirm').click();
  await expect(companion.locator('.approval-overlay')).toBeHidden();
});

test('chat yes cannot approve and Escape returns focus to the pet', async ({ page }) => {
  const companion = await openLingXi(page);
  await page.evaluate(() => window.__LINGXI_HARNESS__.stageProposal());
  await companion.locator('.composer textarea').fill('yes');
  await companion.locator('.composer-send').click();
  await expect(companion.locator('.messages')).toContainText('聊天中的 yes 不能授权');
  expect(await page.evaluate(() => window.__LINGXI_HARNESS__.approvals.length)).toBe(0);

  await page.keyboard.press('Escape');
  await expect(companion.locator('.panel')).toBeHidden();
  await expect(companion.locator('.pet-button')).toBeFocused();
});

test('reduced-motion preference disables companion animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const companion = await openLingXi(page);
  const animationName = await companion.locator('.panel').evaluate(element => getComputedStyle(element).animationName);
  expect(animationName).toBe('none');
});

test('shows the live tool flow and streams the answer before completion', async ({ page }) => {
  const companion = await openLingXi(page);
  await page.evaluate(() => window.__LINGXI_HARNESS__.setStreamHold(true));
  await companion.locator('.composer textarea').fill('帮我检查查克拉');
  await companion.locator('.composer-send').click();

  await expect(companion.locator('.messages')).toContainText('帮我检查查克拉');
  await expect(companion.locator('.live-activity')).toBeVisible();
  await expect(companion.locator('.live-activity')).toContainText('检查当前变量');
  await expect(companion.locator('.streaming-bubble')).toContainText('找到啦');

  await page.evaluate(() => window.__LINGXI_HARNESS__.releaseStream());
  await expect(companion.locator('.composer-send')).toBeEnabled();
  await expect(companion.locator('.activity-trace').last()).toContainText('检查当前变量');
  await expect(companion.locator('.message.assistant').last().locator('strong')).toHaveText('查克拉状态正常');
});

test('Chinese IME confirmation does not send until composition has finished', async ({ page }) => {
  const companion = await openLingXi(page);
  const input = companion.locator('.composer textarea');
  await input.fill('你好灵希');
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true });
  expect(await page.evaluate(() => window.__LINGXI_HARNESS__.getSendStarted())).toBe(false);
  await expect(input).toHaveValue('你好灵希');
  await input.press('Enter');
  await expect(companion.locator('.message.user').last()).toContainText('你好灵希');
});

test('reattaching the companion restores message and proposal subscriptions', async ({ page }) => {
  const companion = await openLingXi(page);
  await page.evaluate(() => {
    const harness = window.__LINGXI_HARNESS__;
    for (let i = 0; i < 2; i++) {
      harness.companion.remove();
      document.body.append(harness.companion);
    }
    harness.seedHistory();
    harness.stageProposal();
  });
  await expect(companion.locator('.messages')).toContainText('好的，我会保留这条上下文。');
  await expect(companion.locator('.proposal-review')).toBeVisible();
  await expect(page.locator('body')).toHaveClass(/lingxi-companion-open/);
  await companion.locator('.composer textarea').fill('重新挂载后继续');
  await companion.locator('.composer textarea').press('Enter');
  await expect(companion.locator('.message.user').filter({ hasText: '重新挂载后继续' })).toHaveCount(1);
});

test('reattaching with a pending animation frame resumes streamed replies', async ({ page }) => {
  const companion = await openLingXi(page);
  await page.evaluate(() => {
    const host = window.__LINGXI_HARNESS__.companion;
    host._busy = true;
    host._handleAgentEvent({ type: 'text-delta', delta: '第一段' });
    host.remove();
    document.body.append(host);
    host._handleAgentEvent({ type: 'text-delta', delta: '，重新挂载后的第二段' });
  });
  await expect(companion.locator('.streaming-bubble')).toContainText('第一段，重新挂载后的第二段');
});

test('renders assistant markdown without exposing raw markers', async ({ page }) => {
  const companion = await openLingXi(page);
  await page.evaluate(() => window.__LINGXI_HARNESS__.pushMarkdown());
  const last = companion.locator('.message.assistant').last();
  await expect(last.locator('h3')).toHaveText('小结');
  await expect(last.locator('strong')).toHaveText('已经检查好啦');
  await expect(last.locator('li')).toHaveCount(2);
  await expect(last.locator('.bubble')).not.toContainText('###');
  await expect(last.locator('.bubble')).not.toContainText('**');
});

test('pet can be dragged and restores its saved position', async ({ page }) => {
  const companion = await loadLingXi(page);
  const pet = companion.locator('.pet-button');
  // The button lifts 3px on hover; compare the actual dock position instead.
  const before = await companion.boundingBox();
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x - 150, before.y - 120, { steps: 8 });
  await page.mouse.up();
  const moved = await companion.boundingBox();
  expect(Math.abs(moved.x - before.x)).toBeGreaterThan(80);
  expect(Math.abs(moved.y - before.y)).toBeGreaterThan(60);
  expect(await page.evaluate(() => localStorage.getItem('naruto_lingxi_position_v1'))).toBeTruthy();

  await page.reload();
  await page.waitForFunction(() => window.__LINGXI_HARNESS_READY__ === true);
  const restored = await page.locator('lingxi-companion').boundingBox();
  expect(Math.abs(restored.x - moved.x)).toBeLessThan(3);
  expect(Math.abs(restored.y - moved.y)).toBeLessThan(3);
});

test('desktop conversation panel can be dragged, clamped, and restored independently', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const companion = await openLingXi(page);
  const panel = companion.locator('.panel');
  const handle = companion.locator('.panel-header .identity');
  const before = await panel.boundingBox();
  const handleBox = await handle.boundingBox();

  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x - 180, before.y - 110, { steps: 8 });
  await page.mouse.up();

  const moved = await panel.boundingBox();
  expect(Math.abs(moved.x - before.x)).toBeGreaterThan(100);
  expect(Math.abs(moved.y - before.y)).toBeGreaterThan(30);
  expect(moved.x).toBeGreaterThanOrEqual(8);
  expect(moved.y).toBeGreaterThanOrEqual(8);
  expect(moved.x + moved.width).toBeLessThanOrEqual(1432);
  expect(moved.y + moved.height).toBeLessThanOrEqual(892);
  expect(await page.evaluate(() => localStorage.getItem('naruto_lingxi_panel_position_v1'))).toBeTruthy();

  await companion.locator('.clear-button').click();
  await expect(companion.locator('.new-chat-overlay')).toBeVisible();
  const afterButton = await panel.boundingBox();
  expect(Math.abs(afterButton.x - moved.x)).toBeLessThan(2);
  expect(Math.abs(afterButton.y - moved.y)).toBeLessThan(2);
  await companion.locator('.new-chat-cancel').click();

  await page.reload();
  await page.waitForFunction(() => window.__LINGXI_HARNESS_READY__ === true);
  const restoredCompanion = page.locator('lingxi-companion');
  await restoredCompanion.locator('.pet-button').click();
  const restoredPanel = restoredCompanion.locator('.panel');
  await restoredPanel.evaluate(async element => {
    await Promise.all(element.getAnimations().map(animation => animation.finished));
  });
  const restored = await restoredPanel.boundingBox();
  expect(Math.abs(restored.x - moved.x)).toBeLessThan(3);
  expect(Math.abs(restored.y - moved.y)).toBeLessThan(3);
});

test('Ling Xi can use a dedicated saved API scheme', async ({ page }) => {
  const companion = await openLingXi(page);
  const select = companion.locator('.api-choice-select');
  await expect(select).toBeVisible();
  await expect(select.locator('option')).toHaveCount(2);
  await select.selectOption('scheme-lingxi');
  expect(await page.evaluate(() => window.__LINGXI_HARNESS__.companion.controller.getSelectedApiChoice())).toBe('scheme-lingxi');
});
