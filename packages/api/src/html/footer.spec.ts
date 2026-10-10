import { injectConfiguredFooterBootstrap } from './footer';
import { applyCspNonce } from '~/security/csp';

const SHELL =
  '<!DOCTYPE html><html><head><title>LibreChat</title></head>' +
  '<body><div id="root"></div><script type="module" src="/assets/index.js"></script></body></html>';

const flagOf = (html: string): boolean | undefined => {
  const match = /"hasConfiguredFooter":(true|false)/.exec(html);
  return match == null ? undefined : match[1] === 'true';
};

describe('injectConfiguredFooterBootstrap', () => {
  it('answers yes for the footer the deployment configured', () => {
    expect(flagOf(injectConfiguredFooterBootstrap(SHELL, { customFooter: 'Operator' }))).toBe(true);
    expect(flagOf(injectConfiguredFooterBootstrap(SHELL, { customFooter: 'A | B' }))).toBe(true);
  });

  it('answers no for a deployment that configured nothing', () => {
    expect(flagOf(injectConfiguredFooterBootstrap(SHELL, {}))).toBe(false);
    expect(flagOf(injectConfiguredFooterBootstrap(SHELL))).toBe(false);
    expect(flagOf(injectConfiguredFooterBootstrap(SHELL, { customFooter: undefined }))).toBe(false);
    expect(flagOf(injectConfiguredFooterBootstrap(SHELL, { customFooter: null }))).toBe(false);
    /** Set to nothing: the welcome screen's disclaimer is suppressed, and a
     *  conversation renders no bar to reserve a band for. */
    expect(flagOf(injectConfiguredFooterBootstrap(SHELL, { customFooter: '' }))).toBe(false);
    expect(flagOf(injectConfiguredFooterBootstrap(SHELL, { customFooter: '  ' }))).toBe(false);
  });

  it('places the answer ahead of the app that reads it', () => {
    const html = injectConfiguredFooterBootstrap(SHELL, { customFooter: 'Operator' });

    expect(html).toContain('window.__LIBRECHAT_CONFIG__');
    expect(html.indexOf('hasConfiguredFooter')).toBeLessThan(html.indexOf('/assets/index.js'));
  });

  it('takes the nonce a strict CSP requires to run it', () => {
    const html = applyCspNonce(
      injectConfiguredFooterBootstrap(SHELL, { customFooter: 'Operator' }),
      'abc123',
    );

    expect(html).toContain('<script nonce="abc123" data-librechat-configured-footer="true">');
  });

  it('does not stack a second copy on a shell that already carries the answer', () => {
    const once = injectConfiguredFooterBootstrap(SHELL, { customFooter: 'Operator' });

    expect(injectConfiguredFooterBootstrap(once, { customFooter: 'Operator' })).toBe(once);
  });
});
