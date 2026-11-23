import documented from './themedocs.json';
import { themeAppearanceProperties } from '../src/themes/registry';

/**
 * `themedocs.json` lists the appearance keys the librechat.ai theme page documents. A new
 * appearance role fails here until the page has a row for it and the key is added to the list.
 */
describe('appearance keys documented on the theme page', () => {
  const keys = Object.keys(themeAppearanceProperties);

  it('lists every appearance key', () => {
    expect(keys.filter((key) => !documented.includes(key))).toEqual([]);
  });

  it('lists no key the schema dropped', () => {
    expect(documented.filter((key) => !keys.includes(key))).toEqual([]);
  });
});
