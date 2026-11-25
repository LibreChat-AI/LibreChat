import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import translationZh_Hans from './zh-Hans/translation.json';
import translationZh_Hant from './zh-Hant/translation.json';
import translationPt_BR from './pt-BR/translation.json';
import translationPt_PT from './pt-PT/translation.json';
import translationEn from './en/translation.json';
import translationAr from './ar/translation.json';
import translationCa from './ca/translation.json';
import translationCs from './cs/translation.json';
import translationDa from './da/translation.json';
import translationDe from './de/translation.json';
import translationEs from './es/translation.json';
import translationEt from './et/translation.json';
import translationFa from './fa/translation.json';
import translationFr from './fr/translation.json';
import translationIt from './it/translation.json';
import translationPl from './pl/translation.json';
import translationRu from './ru/translation.json';
import translationJa from './ja/translation.json';
import translationKa from './ka/translation.json';
import translationSv from './sv/translation.json';
import translationKo from './ko/translation.json';
import translationTh from './th/translation.json';
import translationTr from './tr/translation.json';
import translationVi from './vi/translation.json';
import translationNl from './nl/translation.json';
import translationId from './id/translation.json';
import translationHe from './he/translation.json';
import translationHu from './hu/translation.json';
import translationFi from './fi/translation.json';

export const defaultNS = 'translation';

export const resources: {
  readonly en: {
    readonly translation: {
      com_ui_cancel: string;
      com_ui_no_options: string;
      com_ui_delete_selected_items: string;
      com_ui_filter_by: string;
      com_ui_cancel_dialog: string;
      com_ui_no_results_found: string;
      com_ui_select_all: string;
      com_ui_no_selection: string;
      com_ui_confirm_bulk_delete: string;
      com_ui_delete_success: string;
      com_ui_retry: string;
      com_ui_selected_count: string;
      com_ui_data_table: string;
      com_ui_no_data: string;
      com_ui_delete_selected: string;
      com_ui_search: string;
      com_ui_search_table: string;
      com_ui_search_table_description: string;
      com_ui_data_table_scroll_area: string;
      com_ui_select_row: string;
      com_ui_loading_more_data: string;
      com_ui_no_search_results: string;
      com_ui_table_error: string;
      com_ui_table_error_description: string;
      com_ui_error_details: string;
      com_ui_enabled: string;
      com_ui_disabled: string;
      com_ui_toggle_theme: string;
      com_ui_dark_theme_enabled: string;
      com_ui_light_theme_enabled: string;
      com_ui_high_contrast_dark_theme_enabled: string;
      com_ui_high_contrast_light_theme_enabled: string;
    };
  };
  readonly ar: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly ca: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly cs: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly 'zh-Hans': {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly 'zh-Hant': {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly da: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly de: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly es: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly et: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly fa: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly fr: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly it: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly pl: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly 'pt-BR': {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly 'pt-PT': {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly ru: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly ja: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly ka: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly sv: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly ko: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly th: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly tr: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly vi: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly nl: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly id: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly he: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly hu: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
  readonly fi: {
    readonly translation: {
      com_ui_cancel: string;
    };
  };
} = {
  en: { translation: translationEn },
  ar: { translation: translationAr },
  ca: { translation: translationCa },
  cs: { translation: translationCs },
  'zh-Hans': { translation: translationZh_Hans },
  'zh-Hant': { translation: translationZh_Hant },
  da: { translation: translationDa },
  de: { translation: translationDe },
  es: { translation: translationEs },
  et: { translation: translationEt },
  fa: { translation: translationFa },
  fr: { translation: translationFr },
  it: { translation: translationIt },
  pl: { translation: translationPl },
  'pt-BR': { translation: translationPt_BR },
  'pt-PT': { translation: translationPt_PT },
  ru: { translation: translationRu },
  ja: { translation: translationJa },
  ka: { translation: translationKa },
  sv: { translation: translationSv },
  ko: { translation: translationKo },
  th: { translation: translationTh },
  tr: { translation: translationTr },
  vi: { translation: translationVi },
  nl: { translation: translationNl },
  id: { translation: translationId },
  he: { translation: translationHe },
  hu: { translation: translationHu },
  fi: { translation: translationFi },
} as const;

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: {
      'zh-TW': ['zh-Hant', 'en'],
      'zh-HK': ['zh-Hant', 'en'],
      zh: ['zh-Hans', 'en'],
      default: ['en'],
    },
    fallbackNS: 'translation',
    ns: ['translation'],
    debug: false,
    defaultNS,
    resources,
    interpolation: { escapeValue: false },
  });

export default i18n;
