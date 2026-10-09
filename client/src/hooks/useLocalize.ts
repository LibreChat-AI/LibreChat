import { useCallback } from 'react';
import { TOptions } from 'i18next';
import { useTranslation } from 'react-i18next';
import translationEn from '~/locales/en/translation.json';

export type TranslationKeys = keyof typeof translationEn;

export default function useLocalize() {
  const { t } = useTranslation();

  return useCallback(
    (phraseKey: TranslationKeys, options?: TOptions) => t(phraseKey, options),
    [t],
  );
}
