'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { isolated, PROJECT, TEST_PASSWORD } = require('../../tests/helpers/runtime');
const { createAdmin } = require('../../backend/auth');
async function main() {
  const runtime = await isolated(), output = path.join(PROJECT, 'docs/verification/A/browser');
  await fs.mkdir(output, { recursive: true }); let browser;
  const errors = [], checks = [];
  try {
    // Uses installed Chrome/Edge in headless mode. No browser installation, user profile or real identities.
    browser = await chromium.launch(process.env.CP_TEST_BROWSER_PATH ? { executablePath: process.env.CP_TEST_BROWSER_PATH, headless: true } : { channel: 'msedge', headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' }), page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(runtime.url); await page.locator('[data-account]').waitFor();
    assert.equal(await page.getByText('尚未配置收款信息', { exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); checks.push('390px: no horizontal overflow, empty payment information');
    await page.locator('input[type=file]').setInputFiles(path.join(PROJECT, 'tests/fixtures/source-100-pages.pdf'));
    await page.locator('#upload').click(); await page.locator('dialog[open]').waitFor();
    await page.locator('dialog [data-mode]').click();
    await page.locator('dialog [name=username]').fill('browser_test_student'); await page.locator('dialog [name=password]').fill(TEST_PASSWORD);
    await page.locator('dialog [data-submit]').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('源页数: 100'), { timeout: 20000 });
    await page.locator('#page').fill('100'); await page.locator('#preview').click(); await page.locator('#preview-image').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#preview-image').complete && document.querySelector('#preview-image').naturalWidth > 0);
    await page.screenshot({ path: path.join(output, 'student-390-light.png'), fullPage: true }); checks.push('registration returns to retained upload; source page 100 preview works');
    await page.locator('[data-theme-control]').selectOption('dark'); await page.locator('[data-language-control]').selectOption('en');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('Source pages: 100'));
    await page.screenshot({ path: path.join(output, 'student-390-dark-en.png'), fullPage: true });
    assert.equal(await page.getByRole('button', { name: 'View preview', exact: true }).count(), 1); checks.push('dark theme and English strings');
    await page.setViewportSize({ width: 1440, height: 1000 }); await page.screenshot({ path: path.join(output, 'student-1440-dark-en.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); checks.push('1440px: no horizontal overflow');
    await page.locator('[data-logout]').click(); assert.equal(await page.locator('#preview-image').getAttribute('src'), null); checks.push('logout releases preview');
    await createAdmin(runtime.db, runtime.config, { username: 'browser_test_admin', password: TEST_PASSWORD, nickname: '经营基础测试' });
    await page.goto(runtime.url + '/admin/'); await page.locator('#cleanup-status').click(); await page.locator('dialog[open]').waitFor();
    await page.locator('dialog [name=username]').fill('browser_test_admin'); await page.locator('dialog [name=password]').fill(TEST_PASSWORD); await page.locator('dialog [data-submit]').click();
    await page.waitForFunction(() => document.querySelector('#result').textContent.includes('intervalMs'));
    await page.screenshot({ path: path.join(output, 'admin-1440-dark-en.png'), fullPage: true }); checks.push('independent admin login and cleanup status');
    assert.deepEqual(errors, []);
    const report = { kind: 'A-foundation-browser-viewport-software-test', browser: browser.version(), viewports: [390, 1440], checks, pageErrors: errors, realMobileDevice: false };
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
  } finally { await browser?.close(); await runtime.destroy(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
