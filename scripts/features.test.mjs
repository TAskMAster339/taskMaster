// Run against Vite. Playwright and @axe-core/playwright may be installed outside the repo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(process.env.TASKMASTER_BROWSER_MODULES ? path.join(process.env.TASKMASTER_BROWSER_MODULES, 'package.json') : import.meta.url);
const { chromium } = require('playwright');
const { default: AxeBuilder } = require('@axe-core/playwright');
const base = process.env.TASKMASTER_DEV_URL || 'http://127.0.0.1:1420';
let browser;
before(async () => { browser = await chromium.launch({ channel: 'msedge', headless: true }); });
after(async () => { await browser?.close(); });
async function fixture(options = {}) {
 const context = await browser.newContext({ viewport: { width: 920, height: 700 }, reducedMotion: 'reduce', ...options });
 const page = await context.newPage();
 const errors = [];
 page.on('pageerror', error => errors.push(error.message));
 await page.goto(`${base}/scripts/feature-check.html`);
 await page.waitForFunction(() => window.featureFixture?.ready);
 await page.waitForFunction(() => document.querySelectorAll('.task-row').length === 100);
 return { context, page, errors };
}
test('Japanese default, live language change, persistence, user content and errors', async () => {
 const { context, page, errors } = await fixture();
 try {
  assert.equal(await page.locator('html').getAttribute('lang'), 'ja');
  assert.equal(await page.locator('[data-task-id="fixture-0"] .task-title').innerText(), 'Настройки');
  await page.locator('[data-view="settings"]').click();
  for (const [lang, heading] of [['ru', 'НАСТРОЙКИ.'], ['en', 'SETTINGS.'], ['ja', '設定.']]) {
   await page.locator('[data-language-select]').selectOption(lang);
   await page.waitForFunction(value => document.documentElement.lang === value, lang);
   assert.equal(await page.locator('h1').innerText(), heading);
   const text = await page.locator('main').innerText();
   if (lang !== 'ru') assert.ok(!/[А-Яа-яЁё]/.test(text.replace('Русский', '')), text);
  }
  await page.locator('[data-language-select]').selectOption('en');
  await page.reload(); await page.waitForFunction(() => window.featureFixture?.ready);
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  await page.locator('[data-view="settings"]').click();
  await page.evaluate(() => window.featureFixture.setDisplayError(true));
  await page.locator('[data-language-select]').selectOption('ru');
  await page.waitForFunction(() => document.querySelector('[data-settings-error]').textContent.includes('Could not save'));
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.equal(await page.locator('[data-language-select]').inputValue(), 'en');
  assert.deepEqual(errors, []);
 } finally { await context.close(); }
});
test('settings synchronize with the overlay, including existing timer controls', async () => {
 const { context, page, errors } = await fixture();
 try {
  const overlay = await context.newPage();
  await overlay.goto(`${base}/scripts/feature-check.html?window=overlay&running=1`);
  await overlay.waitForFunction(() => window.featureFixture?.ready);
  await page.locator('[data-view="settings"]').click();
  await page.locator('[data-language-select]').selectOption('en');
  await page.locator('[data-high-contrast]').check();
  await overlay.waitForFunction(() => document.documentElement.lang === 'en' && document.documentElement.dataset.contrast === 'high');
  await overlay.waitForFunction(() => document.querySelector('[data-timer-action="pause"]')?.getAttribute('aria-label') === 'Pause');
  assert.equal(await overlay.locator('[data-overlay-open]').innerText(), 'Open list');
  assert.deepEqual(errors, []);
 } finally { await context.close(); }
});
test('contrast, forced colors, responsive language layouts and 200 percent zoom', async () => {
 const { context, page, errors } = await fixture();
 try {
  await page.locator('[data-view="settings"]').click();
  await page.locator('[data-high-contrast]').check();
  for (const theme of ['light', 'dark']) {
   await page.waitForFunction(() => !document.querySelector('[data-high-contrast]').disabled);
   await page.locator('[data-theme-select]').selectOption(theme);
   await page.waitForFunction(value => document.documentElement.dataset.themeMode === value, theme);
   const color = await page.locator('main').evaluate(el => getComputedStyle(el).color);
   assert.equal(color, theme === 'light' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)');
   const scan = await new AxeBuilder({ page }).analyze();
   assert.deepEqual(scan.violations.map(v => v.id), []);
  }
  for (const lang of ['ja', 'ru', 'en']) {
   await page.locator('[data-language-select]').selectOption(lang);
   await page.setViewportSize({ width: 360, height: 480 });
   assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('main').scrollWidth <= document.querySelector('main').clientWidth));
   await page.setViewportSize({ width: 920, height: 700 });
   await page.evaluate(() => { document.documentElement.style.zoom = '2'; });
   assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('main').scrollWidth <= document.querySelector('main').clientWidth));
   await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  }
  await page.emulateMedia({ forcedColors: 'active' });
  assert.equal(await page.locator('main').evaluate(el => getComputedStyle(el).forcedColorAdjust), 'auto');
  assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations.map(v => v.id), []);
  assert.deepEqual(errors, []);
 } finally { await context.close(); }
});
test('semantic screens, named dialogs, cancel focus and stable timer announcements', async () => {
 const { context, page, errors } = await fixture();
 try {
  for (const view of ['settings', 'history', 'today', 'timers']) {
   await page.locator(`[data-view="${view}"]`).click();
   await page.waitForTimeout(60);
   assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations.map(v => v.id), [], view);
  }
  await page.locator('[data-timer-action="start"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-timer-action') === 'pause');
  const status = await page.locator('#app-status').innerText();
  assert.equal(status, 'タイマーを開始しました');
  await page.waitForTimeout(1200);
  assert.equal(await page.locator('#app-status').innerText(), status);
  assert.equal(await page.locator('#app').getAttribute('aria-live'), null);
  await page.locator('[data-add-timer]').first().click();
  assert.ok(await page.locator('dialog').getAttribute('aria-labelledby'));
  assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations.map(v => v.id), []);
  await page.keyboard.press('Escape');
  assert.ok(await page.locator('[data-add-timer]').first().evaluate(el => el === document.activeElement));
  await page.locator('[data-view="settings"]').click();
  await page.locator('[data-clear-data="tasks"]').click();
  assert.ok(await page.locator('[data-clear-cancel]').evaluate(el => el === document.activeElement));
  assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations.map(v => v.id), []);
  await page.keyboard.press('Escape');
  for (const url of ['https://taskmaster339.github.io/', 'https://github.com/TAskMAster339/taskMaster']) {
   await page.locator(`a[data-about-link][href="${url}"]`).click();
  }
  assert.equal(await page.evaluate(() => window.featureFixture.calls.filter(c => c.command === 'open_about_link').length), 2);
  assert.deepEqual(errors, []);
 } finally { await context.close(); }
});
