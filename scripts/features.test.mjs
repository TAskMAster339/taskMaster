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
async function fixture(options = {}, count = 100) {
 const context = await browser.newContext({ viewport: { width: 920, height: 700 }, reducedMotion: 'reduce', ...options });
 const page = await context.newPage();
 const errors = [];
 page.on('pageerror', error => errors.push(error.message));
 await page.goto(`${base}/scripts/feature-check.html?count=${count}`);
 await page.waitForFunction(() => window.featureFixture?.ready);
 await page.evaluate(() => document.fonts.ready);
 await page.waitForFunction(value => document.querySelectorAll('.task-row').length === value, count);
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
   await page.waitForFunction(value => getComputedStyle(document.querySelector('main')).color === value, theme === 'light' ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)');
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

test('reminder preserves list position and focus beyond the first batch', async () => {
 const { context, page, errors } = await fixture();
 try {
  const last = page.locator('[data-edit-reminder="fixture-99"]');
  await last.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const before = await page.locator('.task-list').evaluate(el => el.scrollTop);
  assert.ok(before > 1000);
  await last.click();
  await page.locator('[data-reminder-dialog]').waitFor({ state: 'visible' });
  assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations.map(v => v.id), []);
  await page.locator('[data-close-reminder]').click();
  await page.waitForFunction(() => document.querySelectorAll('.task-row').length === 100);
  const position = await page.locator('.task-list').evaluate(el => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
  assert.ok(Math.abs(position.top - Math.min(before, position.max)) <= 1);
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-edit-reminder')), 'fixture-99');
  assert.deepEqual(errors, []);
 } finally { await context.close(); }
});

for (const count of [100, 5000]) test(`reminder save, clear, Escape, failure and missing task with ${count} rows`, async () => {
 const { context, page, errors } = await fixture({}, count);
 try {
  const id = `fixture-${count - 1}`;
  const button = () => page.locator(`[data-edit-reminder="${id}"]`);
  await button().scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const top = await page.locator('.task-list').evaluate(el => el.scrollTop);
  const assertPosition = async () => {
   await page.waitForFunction(value => document.querySelectorAll('.task-row').length === value, count);
   const actual = await page.locator('.task-list').evaluate(el => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
   assert.ok(Math.abs(actual.top - Math.min(top, actual.max)) <= 1, JSON.stringify({ top, actual }));
   assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-edit-reminder')), id);
  };
  await button().click(); await page.keyboard.press('Escape'); await assertPosition();
  await button().click(); await page.locator('#reminder-time').fill('23:59');
  await page.locator('[data-reminder-form] button[type="submit"]').click();
  await page.locator('[data-reminder-dialog]').waitFor({ state: 'detached' });
  await assertPosition();
  assert.equal(await button().locator('time').count(), 1);
  await button().click(); await page.locator('[data-clear-reminder]').click();
  await page.locator('[data-reminder-dialog]').waitFor({ state: 'detached' });
  await assertPosition(); assert.equal(await button().locator('time').count(), 0);
  await page.evaluate(() => window.featureFixture.setReminderError(true));
  await button().click(); await page.locator('#reminder-time').fill('22:22');
  await page.locator('[data-reminder-form] button[type="submit"]').click();
  await page.waitForFunction(() => document.querySelector('#reminder-time')?.getAttribute('aria-invalid') === 'true');
  assert.equal(await page.locator('#reminder-time').inputValue(), '22:22');
  assert.ok(await page.locator('[data-reminder-dialog]').isVisible());
  await page.locator('[data-close-reminder]').click(); await assertPosition();
  assert.equal(await page.evaluate(() => window.featureFixture.calls.filter(c => c.command === 'set_task_reminder').length), 2);
  await button().click();
  await page.evaluate(id => window.featureFixture.removeTask(id), id);
  await page.locator('[data-reminder-dialog]').waitFor({ state: 'detached' });
  await page.waitForFunction(value => document.querySelectorAll('.task-row').length === value, count - 1);
  assert.ok(await page.evaluate(() => document.activeElement?.classList.contains('task-list')));
  assert.ok(await page.locator('.task-list').evaluate(el => el.scrollTop > 1000));
  assert.deepEqual(errors, []);
 } finally { await context.close(); }
});

test('new scroll input cancels deferred reminder restoration', async () => {
 const { context, page, errors } = await fixture({}, 5000);
 try {
  await page.locator('[data-edit-reminder="fixture-4999"]').scrollIntoViewIfNeeded();
  await page.locator('[data-edit-reminder="fixture-4999"]').click();
  await page.evaluate(async () => {
   await window.featureFixture.removeTask('fixture-4999');
   await new Promise(requestAnimationFrame);
   const list = document.querySelector('.task-list');
   list.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1000 }));
   list.scrollTop = 0;
  });
  await page.waitForFunction(() => document.querySelectorAll('.task-row').length === 4999);
  assert.equal(await page.locator('.task-list').evaluate(el => el.scrollTop), 0);
  assert.deepEqual(errors, []);
 } finally { await context.close(); }
});
