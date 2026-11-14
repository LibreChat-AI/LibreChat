import { resolve } from 'path';
import { readFileSync } from 'fs';

/** The inline shell script in `client/index.html` that sets `dir` before first paint. */
const bootScript = (() => {
  const html = readFileSync(resolve(__dirname, '../../../index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const script = scripts.find((source) => source.includes('Direction before first paint'));
  if (!script) {
    throw new Error('client/index.html has no direction boot script');
  }
  return script;
})();

const runBoot = () => new Function(bootScript)();

const clearCookie = () => {
  document.cookie = 'lang=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
};

describe('index.html direction boot', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('dir');
    localStorage.clear();
    clearCookie();
  });

  afterAll(clearCookie);

  it('marks the document right-to-left from the lang cookie', () => {
    document.cookie = 'lang=ar-EG';
    runBoot();
    expect(document.documentElement.dir).toBe('rtl');
  });

  it.each([JSON.stringify('he'), 'fa'])('reads a stored language %s', (stored) => {
    localStorage.setItem('lang', stored);
    runBoot();
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('leaves a left-to-right language alone', () => {
    document.cookie = 'lang=en-US';
    localStorage.setItem('lang', JSON.stringify('ar'));
    runBoot();
    expect(document.documentElement.dir).toBe('');
  });
});
