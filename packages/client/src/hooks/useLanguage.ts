import { useTranslation } from 'react-i18next';

/** The language the host app's i18next instance is rendering in, for locale-aware formatting. */
export default function useLanguage(): string {
  const { i18n } = useTranslation();
  return i18n.language;
}
