import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t, setLanguage, locale, language, backendText } from '../src/i18n.ts';
import messages from '../src/messages.json' with { type: 'json' };
import { shortcutLabels, displayShortcut } from '../src/shortcuts.ts';
test('Japanese default, language switching and user placeholders', () => {
 assert.equal(language(), 'ja'); assert.equal(t('Настройки'), '設定');
 setLanguage('en'); assert.equal(t('Настройки'), 'Settings'); assert.equal(locale(), 'en-US');
 setLanguage('ru'); assert.equal(t('Настройки'), 'Настройки'); assert.equal(locale(), 'ru-RU');
 assert.throws(() => setLanguage('xx'));
 setLanguage('ja');
});
test('all bundled messages cover the three locales and preserve backend parameters', () => {
 for (const [key, translations] of Object.entries(messages)) {
  assert.deepEqual(Object.keys(translations).sort(), ['en', 'ja', 'ru']);
  assert.equal(translations.ru, key);
  for (const lang of ['ja', 'en']) {
   assert.ok(translations[lang].trim(), key);
   assert.ok(!/[А-Яа-яЁё]/.test(translations[lang]), key);
   assert.deepEqual(translations[lang].match(/\{[^}]*\}/g), key.match(/\{[^}]*\}/g));
  }
 }
 setLanguage('en');
 assert.equal(shortcutLabels.settings, 'Settings');
 assert.equal(displayShortcut('Ctrl+Space'), 'Ctrl+Space');
 assert.equal(backendText('Не удалось зарегистрировать Ctrl+Alt+Space.'), 'Could not register Ctrl+Alt+Space.');
 assert.equal(backendText('Не удалось восстановить рабочий файл. Исходные данные сохранены: C:\\Задача\\original.sqlite3'), 'Could not restore the live file. Original data kept: C:\\Задача\\original.sqlite3');
 setLanguage('ru'); assert.equal(shortcutLabels.settings, 'Настройки');
 setLanguage('ja'); assert.equal(shortcutLabels.settings, '設定');
});
