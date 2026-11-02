import messages from './messages.json' with { type: 'json' };
export type Language = 'ja' | 'ru' | 'en';
export type MessageKey = keyof typeof messages;
export const languages = ['ja', 'ru', 'en'] as const;
export const languageNames: Record<Language, string> = { ja: '日本語', ru: 'Русский', en: 'English' };
const catalog: Record<MessageKey, Record<Language, string>> = messages;
let current: Language = 'ja';
export function language(): Language { return current; }
export function setLanguage(value: Language): void {
  if (!languages.includes(value)) throw new Error('Unsupported language');
  current = value;
}
export function locale(): string { return { ja: 'ja-JP', ru: 'ru-RU', en: 'en-US' }[current]; }
export function t(key: MessageKey): string { return catalog[key][current]; }
// Only backend-owned messages are translated here. User titles never pass through this function.
export function backendText(message: string): string {
  if (Object.prototype.hasOwnProperty.call(catalog, message)) return t(message as MessageKey);
  for (const key of Object.keys(catalog) as MessageKey[]) {
    const match = key.match(/\{(?:shortcut)?\}/);
    if (!match || match.index === undefined) continue;
    const before = key.slice(0, match.index), after = key.slice(match.index + match[0].length);
    if (message.startsWith(before) && message.endsWith(after)) {
      const value = message.slice(before.length, after.length ? -after.length : undefined);
      return t(key).replace(match[0], value);
    }
  }
  return message;
}
