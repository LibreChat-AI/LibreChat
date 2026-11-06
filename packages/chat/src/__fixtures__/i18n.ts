import fs from 'node:fs';
import path from 'node:path';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

const TRANSLATION = path.resolve(__dirname, '../../../../client/src/locales/en/translation.json');

/** Loads the app's English bundle into the shared i18next instance, so a spec reads the copy and
 *  plural forms users see. Call it from a `beforeAll`. */
export async function initEnglish(): Promise<void> {
  await i18next.use(initReactI18next).init({
    lng: 'en',
    resources: { en: { translation: JSON.parse(fs.readFileSync(TRANSLATION, 'utf8')) } },
    interpolation: { escapeValue: false },
  });
}
