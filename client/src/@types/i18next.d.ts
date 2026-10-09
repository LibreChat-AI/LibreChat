import translationEn from '~/locales/en/translation.json';
import { defaultNS } from '~/locales/i18n';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS;
    resources: {
      translation: typeof translationEn;
    };
    strictKeyChecks: true;
  }
}
