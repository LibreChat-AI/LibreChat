import { useRecoilValue } from 'recoil';
import { Dropdown, Spinner } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import store from '~/store';

type PortalElement = ((element: HTMLElement) => HTMLElement | null) | HTMLElement | null;

export const ThemeSelector = ({
  theme,
  onChange,
  portal = true,
  portalElement,
  popoverClassName,
}: {
  theme: string;
  onChange: (value: string) => void;
  portal?: boolean;
  portalElement?: PortalElement;
  popoverClassName?: string;
}) => {
  const localize = useLocalize();

  const themeOptions = [
    { value: 'system', label: localize('com_nav_theme_system') },
    { value: 'dark', label: localize('com_nav_theme_dark') },
    { value: 'light', label: localize('com_nav_theme_light') },
    { value: 'high-contrast-light', label: localize('com_nav_theme_high_contrast_light') },
    { value: 'high-contrast-dark', label: localize('com_nav_theme_high_contrast_dark') },
  ];

  const labelId = 'theme-selector-label';

  return (
    <div className="flex items-center justify-between">
      <div id={labelId}>{localize('com_nav_theme')}</div>

      <Dropdown
        value={theme}
        onChange={onChange}
        options={themeOptions}
        sizeClasses={cn('z-50 w-[180px]', popoverClassName)}
        testId="theme-selector"
        aria-labelledby={labelId}
        portal={portal}
        portalElement={portalElement}
      />
    </div>
  );
};

export const LangSelector = ({
  langcode,
  onChange,
  portal = true,
  portalElement,
  popoverClassName,
}: {
  langcode: string;
  onChange: (value: string) => void;
  portal?: boolean;
  portalElement?: PortalElement;
  popoverClassName?: string;
}) => {
  const localize = useLocalize();
  const isLanguageLoading = useRecoilValue(store.languageLoading);

  const languageOptions = [
    { value: 'auto', label: localize('com_nav_lang_auto') },
    { value: 'en-US', label: localize('com_nav_lang_english') },
    { value: 'zh-Hans', label: localize('com_nav_lang_chinese') },
    { value: 'zh-Hant', label: localize('com_nav_lang_traditional_chinese') },
    { value: 'ar-EG', label: localize('com_nav_lang_arabic') },
    { value: 'bs', label: localize('com_nav_lang_bosnian') },
    { value: 'da-DK', label: localize('com_nav_lang_danish') },
    { value: 'de-DE', label: localize('com_nav_lang_german') },
    { value: 'es-ES', label: localize('com_nav_lang_spanish') },
    { value: 'ca-ES', label: localize('com_nav_lang_catalan') },
    { value: 'et-EE', label: localize('com_nav_lang_estonian') },
    { value: 'fa-IR', label: localize('com_nav_lang_persian') },
    { value: 'fr-FR', label: localize('com_nav_lang_french') },
    { value: 'he-HE', label: localize('com_nav_lang_hebrew') },
    { value: 'hu-HU', label: localize('com_nav_lang_hungarian') },
    { value: 'hy-AM', label: localize('com_nav_lang_armenian') },
    { value: 'is', label: localize('com_nav_lang_icelandic') },
    { value: 'it-IT', label: localize('com_nav_lang_italian') },
    { value: 'nb', label: localize('com_nav_lang_norwegian_bokmal') },
    { value: 'nn', label: localize('com_nav_lang_norwegian_nynorsk') },
    { value: 'pl-PL', label: localize('com_nav_lang_polish') },
    { value: 'pt-BR', label: localize('com_nav_lang_brazilian_portuguese') },
    { value: 'pt-PT', label: localize('com_nav_lang_portuguese') },
    { value: 'ru-RU', label: localize('com_nav_lang_russian') },
    { value: 'sk', label: localize('com_nav_lang_slovak') },
    { value: 'ja-JP', label: localize('com_nav_lang_japanese') },
    { value: 'ka-GE', label: localize('com_nav_lang_georgian') },
    { value: 'cs-CZ', label: localize('com_nav_lang_czech') },
    { value: 'sv-SE', label: localize('com_nav_lang_swedish') },
    { value: 'ko-KR', label: localize('com_nav_lang_korean') },
    { value: 'lt-LT', label: localize('com_nav_lang_lithuanian') },
    { value: 'lv-LV', label: localize('com_nav_lang_latvian') },
    { value: 'vi-VN', label: localize('com_nav_lang_vietnamese') },
    { value: 'th-TH', label: localize('com_nav_lang_thai') },
    { value: 'tr-TR', label: localize('com_nav_lang_turkish') },
    { value: 'ug', label: localize('com_nav_lang_uyghur') },
    { value: 'nl-NL', label: localize('com_nav_lang_dutch') },
    { value: 'id-ID', label: localize('com_nav_lang_indonesia') },
    { value: 'fi-FI', label: localize('com_nav_lang_finnish') },
    { value: 'sl', label: localize('com_nav_lang_slovenian') },
    { value: 'bo', label: localize('com_nav_lang_tibetan') },
    { value: 'uk-UA', label: localize('com_nav_lang_ukrainian') },
  ];

  const labelId = 'language-selector-label';

  return (
    <div className="flex items-center justify-between">
      <div id={labelId}>{localize('com_nav_language')}</div>

      <div className="flex items-center gap-2">
        {isLanguageLoading && (
          <span
            role="status"
            aria-label={localize('com_ui_loading')}
            className="flex size-5 items-center justify-center text-text-secondary"
          >
            <Spinner className="size-4" />
          </span>
        )}
        <Dropdown
          value={langcode}
          onChange={onChange}
          sizeClasses={cn('z-50 w-[220px]', popoverClassName)}
          options={languageOptions}
          aria-labelledby={labelId}
          portal={portal}
          portalElement={portalElement}
          searchable
          searchPlaceholder={localize('com_ui_search_language')}
          searchEmptyText={localize('com_ui_no_results_found')}
        />
      </div>
    </div>
  );
};
