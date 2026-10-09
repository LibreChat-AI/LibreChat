import { escapeHtmlAttribute } from './html';

describe('escapeHtmlAttribute', () => {
  it('escapes all characters that can alter a quoted attribute', () => {
    expect(escapeHtmlAttribute(`$&<>'"`)).toBe('$&amp;&lt;&gt;&#39;&quot;');
  });
});
