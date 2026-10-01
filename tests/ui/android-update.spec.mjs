import { test, expect } from '@playwright/test';

test('Android automatic check displays release notes and announcement, and later keeps manual checks available', async ({ page }) => {
  await page.addInitScript(() => {
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
    localStorage.setItem('naruto_android_update_auto_prompt_disabled', 'true');
  });
  await page.goto('/tests/fixtures/app-settings-routing-harness.html');
  await page.waitForFunction(() => window.__APP_SETTINGS_HARNESS_READY__);
  await page.evaluate(async () => {
    const { appUpdateService, ANDROID_APP_DOWNLOAD_URL } = await import('/js/core/app-update.js');
    appUpdateService.fetchImpl = async () => ({ ok: true, json: async () => ({
      version: '9.0.0', versionCode: 90000, apkUrl: ANDROID_APP_DOWNLOAD_URL,
      releaseNotes: ['修复安卓设置滚动', '角色子代理按需调用'], announcement: '覆盖安装即可保留存档。<b>公告文本</b>'
    }) });
    appUpdateService.openDownload = async () => { window.__UPDATE_DOWNLOAD__ = ANDROID_APP_DOWNLOAD_URL; };
    window.__APP__._scheduleAppUpdateCheck();
  });
  const modal = page.locator('game-modal');
  await expect(modal).toContainText('9.0.0 更新公告');
  await expect(modal).toContainText('修复安卓设置滚动');
  await expect(modal).toContainText('覆盖安装即可保留存档。<b>公告文本</b>');
  await expect(modal.locator('b')).toHaveCount(0);
  await modal.getByRole('button', { name: '稍后提醒', exact: true }).click();
  await expect(modal).toHaveCount(0);
  await page.evaluate(() => { void window.__APP__._checkAppUpdate(); });
  await expect(modal).toContainText('9.0.0 更新公告');
  await modal.getByRole('button', { name: '下载更新', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__UPDATE_DOWNLOAD__)).toBe('https://www.qiwu.asia/app/android/naruto-rpg.apk');
});
