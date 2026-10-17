import { COLOR_MODE_FROM_URL_ATTRIBUTE, injectColorModeHandoff } from './handoff';

const SHELL =
  '<!DOCTYPE html><html lang="en-US"><head><title>LibreChat</title>' +
  `<script>if (document.documentElement.hasAttribute('${COLOR_MODE_FROM_URL_ATTRIBUTE}')) {}</script>` +
  '</head><body><div id="root"></div></body></html>';

describe('injectColorModeHandoff', () => {
  it('marks the root element when the deployment enables the handoff', () => {
    const html = injectColorModeHandoff(SHELL, true);

    expect(html).toContain(`<html ${COLOR_MODE_FROM_URL_ATTRIBUTE} lang="en-US">`);
  });

  it('leaves the shell untouched when the handoff is off or unset', () => {
    expect(injectColorModeHandoff(SHELL, false)).toBe(SHELL);
    expect(injectColorModeHandoff(SHELL, undefined)).toBe(SHELL);
    expect(injectColorModeHandoff(SHELL, null)).toBe(SHELL);
  });

  it('marks the shell once when served through the injector twice', () => {
    const html = injectColorModeHandoff(injectColorModeHandoff(SHELL, true), true);

    expect(html.split(COLOR_MODE_FROM_URL_ATTRIBUTE)).toHaveLength(3);
    expect(html).toContain(`<html ${COLOR_MODE_FROM_URL_ATTRIBUTE} lang="en-US">`);
  });

  it('keeps the per-request language rewrite matching the marked tag', () => {
    const html = injectColorModeHandoff(SHELL, true).replace(/lang="en-US"/g, 'lang="de"');

    expect(html).toContain(`<html ${COLOR_MODE_FROM_URL_ATTRIBUTE} lang="de">`);
  });
});
