import { useEffect } from 'react';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import i18n, { changeLanguageSafely, normalizeLocale } from '~/locales/i18n';
import store from '~/store';

export default function LanguageSync() {
  const lang = useRecoilValue(store.lang);
  const setLanguageLoading = useSetRecoilState(store.languageLoading);

  useEffect(() => {
    if (i18n.language === normalizeLocale(lang)) {
      setLanguageLoading(false);
      return;
    }

    let isCurrentRequest = true;
    setLanguageLoading(true);

    changeLanguageSafely(lang)
      .catch((error) => {
        console.error('[i18n] Failed to change language', error);
      })
      .finally(() => {
        if (isCurrentRequest) {
          setLanguageLoading(false);
        }
      });

    return () => {
      isCurrentRequest = false;
    };
  }, [lang, setLanguageLoading]);

  return null;
}
