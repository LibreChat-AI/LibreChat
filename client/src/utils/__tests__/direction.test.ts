import { strongDirection } from '../direction';

describe('strongDirection', () => {
  it('resolves Arabic and Hebrew letters to rtl', () => {
    expect(strongDirection('\u0645\u0631\u062D\u0628\u0627 hello')).toBe('rtl');
    expect(strongDirection('\u05E9\u05DC\u05D5\u05DD hello')).toBe('rtl');
  });

  it('resolves Latin letters to ltr', () => {
    expect(strongDirection('hello \u0645\u0631\u062D\u0628\u0627')).toBe('ltr');
  });

  it('treats Devanagari and Thai letters as strong ltr characters', () => {
    expect(strongDirection('\u0928\u093E\u092E \u0645\u0631\u062D\u0628\u0627')).toBe('ltr');
    expect(strongDirection('\u0E2A\u0E27\u0E31\u0E2A\u0E14\u0E35 \u05E9\u05DC\u05D5\u05DD')).toBe(
      'ltr',
    );
  });

  it('treats digits of scripts with their own numerals as strong', () => {
    expect(strongDirection('\u0967 \u0645\u0631\u062D\u0628\u0627')).toBe('ltr');
    expect(strongDirection('\u0E51 \u05E9\u05DC\u05D5\u05DD')).toBe('ltr');
    expect(strongDirection('\u07C1 hello')).toBe('rtl');
  });

  it('reads strong characters outside letters and digits', () => {
    expect(strongDirection('\u2160 \u0645\u0631\u062D\u0628\u0627')).toBe('ltr');
    expect(strongDirection('\u05BE hello')).toBe('rtl');
    expect(strongDirection('\u061F hello')).toBe('rtl');
  });

  it('skips combining marks and Arabic separators inside RTL blocks', () => {
    expect(strongDirection('\u0651 hello')).toBe('ltr');
    expect(strongDirection('\u060C\u066B hello')).toBe('ltr');
  });

  it('reads strong symbols outside letter categories', () => {
    expect(strongDirection('\u{1F1FA}\u{1F1F8} \u0645\u0631\u062D\u0628\u0627')).toBe('ltr');
    expect(strongDirection('\u2801')).toBe('ltr');
    expect(strongDirection('\u0964 \u0645\u0631\u062D\u0628\u0627')).toBe('ltr');
  });

  it('covers scripts added after Unicode 15.1', () => {
    expect(strongDirection('\u{10D50} hello')).toBe('rtl');
  });

  it('reads nonspacing marks of bidi class L as strong', () => {
    expect(strongDirection('\u0CBF \u05E9\u05DC\u05D5\u05DD')).toBe('ltr');
    expect(strongDirection('\u0651 hello')).toBe('ltr');
  });

  it('honors explicit direction marks', () => {
    expect(strongDirection('\u200F hello')).toBe('rtl');
    expect(strongDirection('\u061C hello')).toBe('rtl');
    expect(strongDirection('\u200E \u0645\u0631\u062D\u0628\u0627')).toBe('ltr');
  });

  it('skips digits and punctuation before the first letter', () => {
    expect(strongDirection('1. \u0661\u0662 (\u0645\u0631\u062D\u0628\u0627)')).toBe('rtl');
    expect(strongDirection('42 - \u2022 hello')).toBe('ltr');
  });

  it('returns null when the text has only digits and punctuation', () => {
    expect(strongDirection('123 \u0661\u0662 \u00D7 ...')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(strongDirection('')).toBeNull();
  });
});
