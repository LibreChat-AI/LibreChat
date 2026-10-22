import type { OpenIDSessionCheckResponse } from 'librechat-data-provider';
import { createOpenIDDocumentCheck } from '../openidCheck';

function fixture(href = 'https://app.test/c/123?q=1#message') {
  let url = new URL(href);
  const start = jest.fn<Promise<OpenIDSessionCheckResponse>, [string]>(async () => ({
    status: 'verified',
  }));
  const complete = jest.fn<Promise<OpenIDSessionCheckResponse>, [string]>(async () => ({
    status: 'verified',
  }));
  const replaceUrl = jest.fn((next: URL) => {
    url = next;
  });
  const dependencies = { start, complete, replaceUrl, currentUrl: () => new URL(url) };
  return { ...dependencies, check: createOpenIDDocumentCheck(dependencies) };
}

describe('OpenID verification for one document', () => {
  it('shares one request across remounts and keeps the direct link', async () => {
    const f = fixture();
    await Promise.all([f.check.run(), f.check.run()]);
    await f.check.run();
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledWith('/c/123?q=1#message');
  });

  it('consumes the callback receipt instead of starting another redirect', async () => {
    const f = fixture('https://app.test/c/123?openid_check=receipt&q=1#message');
    await Promise.all([f.check.run(), f.check.run()]);
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.complete).toHaveBeenCalledWith('receipt');
    expect(f.start).not.toHaveBeenCalled();
    expect(f.currentUrl().href).toBe('https://app.test/c/123?q=1#message');
  });

  it('requires another check in a new document', async () => {
    const f = fixture('https://app.test/c/123?openid_check=receipt');
    await f.check.run();
    await createOpenIDDocumentCheck(f).run();
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(f.complete).toHaveBeenCalledTimes(1);
  });

  it('blocks a failed request and retries without replaying a consumed receipt', async () => {
    const f = fixture('https://app.test/c/123?openid_check=receipt');
    f.complete.mockRejectedValueOnce(new Error('network unavailable'));
    expect(await f.check.run()).toEqual({ status: 'unavailable' });
    expect(await f.check.retry()).toEqual({ status: 'verified' });
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
});
