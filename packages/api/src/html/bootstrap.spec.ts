import { injectBootstrapConfig } from './bootstrap';

const SHELL = '<html><head></head><body></body></html>';

/** Every value these tests inject, as the client reads it back off the global. */
interface TestBootstrap {
  first?: boolean;
  second?: number;
  note?: string;
  flag?: boolean;
}

/** Runs the shell's injected scripts the way a browser would, so the assertions
 *  are about what the client receives rather than about the markup's spelling. */
const bootstrapOf = (html: string): TestBootstrap => {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(
    (match) => match[1],
  );
  return new Function('window', `${scripts.join('\n')}\nreturn window.__LIBRECHAT_CONFIG__;`)(
    {},
  ) as TestBootstrap;
};

describe('injectBootstrapConfig', () => {
  it('merges answers so one injection does not drop another', () => {
    const html = injectBootstrapConfig(
      injectBootstrapConfig(SHELL, {
        sentinel: 'data-librechat-first="true"',
        values: { first: true },
      }),
      { sentinel: 'data-librechat-second="true"', values: { second: 2 } },
    );

    expect(bootstrapOf(html)).toEqual({ first: true, second: 2 });
  });

  it('escapes markup in a value so it cannot close the script', () => {
    const note = '</script><script>alert(1)</script>';
    const html = injectBootstrapConfig(SHELL, {
      sentinel: 'data-librechat-test="true"',
      values: { note },
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(bootstrapOf(html)).toEqual({ note });
  });

  it('keeps `$` sequences in a value literal instead of expanding them', () => {
    const note = "$& $` $' $1 $$";

    expect(
      bootstrapOf(
        injectBootstrapConfig(SHELL, { sentinel: 'data-librechat-test="true"', values: { note } }),
      ).note,
    ).toBe(note);
    expect(
      bootstrapOf(
        injectBootstrapConfig('<html><body class="x"></body></html>', {
          sentinel: 'data-librechat-test="true"',
          values: { note },
        }),
      ).note,
    ).toBe(note);
  });

  it('lands ahead of the app in a document with no head at all', () => {
    const html = injectBootstrapConfig('<html><body class="x"><script></script></body></html>', {
      sentinel: 'data-librechat-test="true"',
      values: { flag: true },
    });

    expect(html).toContain('<body class="x"><script data-librechat-test="true">');
  });
});
