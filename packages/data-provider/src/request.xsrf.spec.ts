/**
 * @jest-environment jsdom
 */
import request from './request';

describe('axios requests without an XSRF cookie read', () => {
  let send: jest.SpyInstance;
  let get: jest.Mock;

  beforeEach(() => {
    get = jest.fn(() => new Promise<never>(() => undefined));
    Object.defineProperty(window, 'cookieStore', { value: { get }, configurable: true });
    send = jest.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(() => undefined);
  });

  afterEach(() => {
    send.mockRestore();
    Reflect.deleteProperty(window, 'cookieStore');
  });

  it('dispatches a same-origin request even when the cookie store never answers', async () => {
    void request.get('/api/agents/chat/status/convo-1').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(get).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
