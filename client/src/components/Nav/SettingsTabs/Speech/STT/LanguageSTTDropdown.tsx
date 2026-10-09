import { Dropdown } from '@librechat/client';
import { useRecoilState, useRecoilValue } from 'recoil';
import { useLocalize } from '~/hooks';
import store from '~/store';

export default function LanguageSTTDropdown() {
  const localize = useLocalize();
  const [languageSTT, setLanguageSTT] = useRecoilState<string>(store.languageSTT);
  const speechToText = useRecoilValue(store.speechToText);

  const languageOptions = [
    { value: 'af', label: 'Afrikaans' },
    { value: 'eu', label: 'Basque' },
    { value: 'bg', label: 'Bulgarian' },
    { value: 'ca', label: 'Catalan' },
    { value: 'ar-EG', label: 'Arabic (Egypt)' },
    { value: 'ar-JO', label: 'Arabic (Jordan)' },
    { value: 'ar-KW', label: 'Arabic (Kuwait)' },
    { value: 'ar-LB', label: 'Arabic (Lebanon)' },
    { value: 'ar-QA', label: 'Arabic (Qatar)' },
    { value: 'ar-AE', label: 'Arabic (UAE)' },
    { value: 'ar-MA', label: 'Arabic (Morocco)' },
    { value: 'ar-IQ', label: 'Arabic (Iraq)' },
    { value: 'ar-DZ', label: 'Arabic (Algeria)' },
    { value: 'ar-BH', label: 'Arabic (Bahrain)' },
    { value: 'ar-LY', label: 'Arabic (Libya)' },
    { value: 'ar-OM', label: 'Arabic (Oman)' },
    { value: 'ar-SA', label: 'Arabic (Saudi Arabia)' },
    { value: 'ar-TN', label: 'Arabic (Tunisia)' },
    { value: 'ar-YE', label: 'Arabic (Yemen)' },
    { value: 'cs', label: 'Czech' },
    { value: 'nl-NL', label: 'Dutch' },
    { value: 'en-AU', label: 'English (Australia)' },
    { value: 'en-CA', label: 'English (Canada)' },
    { value: 'en-IN', label: 'English (India)' },
    { value: 'en-NZ', label: 'English (New Zealand)' },
    { value: 'en-ZA', label: 'English (South Africa)' },
    { value: 'en-GB', label: 'English (UK)' },
    { value: 'en-US', label: 'English (US)' },
    { value: 'et-EE', label: 'Estonian' },
    { value: 'fi', label: 'Finnish' },
    { value: 'fr-FR', label: 'French' },
    { value: 'gl', label: 'Galician' },
    { value: 'de-DE', label: 'German' },
    { value: 'el-GR', label: 'Greek' },
    { value: 'he', label: 'Hebrew' },
    { value: 'hu', label: 'Hungarian' },
    { value: 'is', label: 'Icelandic' },
    { value: 'it-IT', label: 'Italian' },
    { value: 'id', label: 'Indonesian' },
    { value: 'ja', label: 'Japanese' },
    { value: 'ko', label: 'Korean' },
    { value: 'la', label: 'Latin' },
    { value: 'lv-LV', label: 'Latvian' },
    { value: 'lt-LT', label: 'Lithuanian' },
    { value: 'zh-CN', label: 'Mandarin Chinese' },
    { value: 'zh-TW', label: 'Taiwanese' },
    { value: 'zh-HK', label: 'Cantonese' },
    { value: 'ms-MY', label: 'Malaysian' },
    { value: 'no-NO', label: 'Norwegian' },
    { value: 'pl', label: 'Polish' },
    { value: 'xx-piglatin', label: 'Pig Latin' },
    { value: 'pt-PT', label: 'Portuguese' },
    { value: 'pt-br', label: 'Portuguese (Brasil)' },
    { value: 'ro-RO', label: 'Romanian' },
    { value: 'ru', label: 'Russian' },
    { value: 'sr-SP', label: 'Serbian' },
    { value: 'sk', label: 'Slovak' },
    { value: 'es-AR', label: 'Spanish (Argentina)' },
    { value: 'es-BO', label: 'Spanish (Bolivia)' },
    { value: 'es-CL', label: 'Spanish (Chile)' },
    { value: 'es-CO', label: 'Spanish (Colombia)' },
    { value: 'es-CR', label: 'Spanish (Costa Rica)' },
    { value: 'es-DO', label: 'Spanish (Dominican Republic)' },
    { value: 'es-EC', label: 'Spanish (Ecuador)' },
    { value: 'es-SV', label: 'Spanish (El Salvador)' },
    { value: 'es-GT', label: 'Spanish (Guatemala)' },
    { value: 'es-HN', label: 'Spanish (Honduras)' },
    { value: 'es-MX', label: 'Spanish (Mexico)' },
    { value: 'es-NI', label: 'Spanish (Nicaragua)' },
    { value: 'es-PA', label: 'Spanish (Panama)' },
    { value: 'es-PY', label: 'Spanish (Paraguay)' },
    { value: 'es-PE', label: 'Spanish (Peru)' },
    { value: 'es-PR', label: 'Spanish (Puerto Rico)' },
    { value: 'es-ES', label: 'Spanish (Spain)' },
    { value: 'es-US', label: 'Spanish (US)' },
    { value: 'es-UY', label: 'Spanish (Uruguay)' },
    { value: 'es-VE', label: 'Spanish (Venezuela)' },
    { value: 'sv-SE', label: 'Swedish' },
    { value: 'tr', label: 'Turkish' },
    { value: 'zu', label: 'Zulu' },
  ];

  const handleSelect = (value: string) => {
    setLanguageSTT(value);
  };

  const labelId = 'language-stt-dropdown-label';

  return (
    <div className="flex items-center justify-between">
      <div id={labelId}>{localize('com_nav_language')}</div>
      <Dropdown
        value={languageSTT}
        onChange={handleSelect}
        options={languageOptions}
        testId="LanguageSTTDropdown"
        sizeClasses="z-50"
        className="z-50"
        aria-labelledby={labelId}
        disabled={!speechToText}
      />
    </div>
  );
}
