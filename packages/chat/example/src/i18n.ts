import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

/**
 * `useLocalize` reads react-i18next. A real app loads its translations here; the example has
 * none, so the few labels the parts draw show their keys.
 */
void i18n.use(initReactI18next).init({
  lng: 'en',
  resources: { en: { translation: {} } },
  interpolation: { escapeValue: false },
});

export default i18n;
