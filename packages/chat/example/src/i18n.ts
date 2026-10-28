import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

/** The example's own copy. */
export const en = {
  example_title: '@librechat/chat example',
  example_messages: 'Messages',
  example_author_user: 'You',
  example_author_assistant: 'Assistant',
  example_composer_label: 'Message',
  example_composer_placeholder: 'Send a message',
  example_send: 'Send',
  example_generating: 'Generating',
  example_send_failed: 'The message was not sent: {{error}}',
};

/**
 * Passed to `I18nextProvider` rather than imported for its side effect: the example sits inside a
 * package marked `sideEffects: false`, so a bare import is dropped from the build.
 *
 * The package's parts localize through `useLocalize`, which reads this react-i18next instance. A
 * real app adds its own translations, including the keys the parts use; the example ships only its
 * own copy, so a part label it has not translated shows its key.
 */
void i18n.use(initReactI18next).init({
  lng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});

export default i18n;
