// Unmock react-i18next for this test file since we're testing actual i18n functionality
jest.unmock('react-i18next');

import i18n from './i18n';
import English from './en/translation.json';
import French from './fr/translation.json';
import Spanish from './es/translation.json';

describe('i18next translation tests', () => {
  // Ensure i18next is initialized before any tests run
  beforeAll(async () => {
    if (!i18n.isInitialized) {
      await i18n.init();
    }
  });

  it('should return the correct translation for a valid key in English', () => {
    i18n.changeLanguage('en');
    expect(i18n.t('com_ui_cancel')).toBe(English.com_ui_cancel);
  });

  it('should return the correct translation for a valid key in French', () => {
    i18n.changeLanguage('fr');
    expect(i18n.t('com_ui_cancel')).toBe(French.com_ui_cancel);
  });

  it('should return the correct translation for a valid key in Spanish', () => {
    i18n.changeLanguage('es');
    expect(i18n.t('com_ui_cancel')).toBe(Spanish.com_ui_cancel);
  });

  it('should fallback to English for an invalid language code', () => {
    // When an invalid language is provided, i18next should fallback to English
    i18n.changeLanguage('invalid-code');
    expect(i18n.t('com_ui_cancel')).toBe(English.com_ui_cancel);
  });

  it('should return the key itself for an invalid key', () => {
    i18n.changeLanguage('en');
    expect(i18n.t('invalid-key')).toBe('invalid-key'); // Returns the key itself
  });

  it('should correctly format placeholders in the translation', () => {
    i18n.changeLanguage('en');
    // The key uses standard i18next {{count}} interpolation, so t() substitutes the value
    expect(i18n.t('com_ui_selected_count', { count: 5 })).toBe('5 selected');
  });
});
