import { useCallback } from 'react';
import { TOptions } from 'i18next';
import { useTranslation } from 'react-i18next';
import translationEn from '~/locales/en/translation.json';

type TranslationKey = keyof typeof translationEn;
/** A plural family's base key; i18next picks the locale's `_one`, `_other`, `_few`... form from `count`. */
type PluralBaseKey<K> = K extends `${infer Base}_other` ? Base : never;

export type TranslationKeys = TranslationKey | PluralBaseKey<TranslationKey>;

export default function useLocalize() {
  const { t } = useTranslation();

  return useCallback(
    (phraseKey: TranslationKeys, options?: TOptions) => t(phraseKey, options),
    [t],
  );
}
