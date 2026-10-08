import { join } from 'path';
import { readFileSync } from 'fs';

const css = readFileSync(join(__dirname, 'Field.css'), 'utf8');

describe('Field.css pointer and contrast coverage', () => {
  it('clears the ring and outline on pointer focus for fields and own-focus editors alike', () => {
    expect(css).toContain(':is(.lc-field, .lc-own-focus):focus-visible {\n  box-shadow: none;');
  });

  it('leaves the contrast modes their enlarged outline', () => {
    expect(css).toContain('html:not(.high-contrast) .lc-field:focus-visible');
    expect(css).toContain('html:root:not(.high-contrast) textarea.lc-own-focus:focus-visible');
  });
});
