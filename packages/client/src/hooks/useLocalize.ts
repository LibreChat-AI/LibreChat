import { useCallback } from 'react';
import { TOptions } from 'i18next';
import { useTranslation } from 'react-i18next';

export type TranslationKeys = string;

/** Language lifecycle is managed by the host app — do not add i18n.changeLanguage() calls here. */
export default function useLocalize(): (phraseKey: TranslationKeys, options?: TOptions) => string {
  const { t } = useTranslation();

  return useCallback(
    (phraseKey: TranslationKeys, options?: TOptions) => t(phraseKey, options),
    [t],
  );
}
