import fs from 'node:fs';
import path from 'node:path';

const SOURCE_ROOT = path.resolve(__dirname, '..');
const TRANSLATION = path.resolve(__dirname, '../../../../client/src/locales/en/translation.json');
const KEY = /['"`](com_[a-z0-9_]+)['"`]/g;

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sources(full);
    }
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** `TranslationKeys` is `string` in the component library, so this is the type check for the keys
 *  the package localizes through the app's shared i18next instance. */
describe('@librechat/chat localization keys', () => {
  it('names only keys the app defines in its English translations', () => {
    const translations: Record<string, string> = JSON.parse(fs.readFileSync(TRANSLATION, 'utf8'));
    const used = new Set(
      sources(SOURCE_ROOT).flatMap((file) =>
        Array.from(fs.readFileSync(file, 'utf8').matchAll(KEY), (match) => match[1]),
      ),
    );
    expect(used.size).toBeGreaterThan(0);
    expect([...used].filter((key) => !(key in translations))).toEqual([]);
  });
});
