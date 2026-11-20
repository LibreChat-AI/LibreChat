import { getOAuthCallbackUrl } from './url';

describe('getOAuthCallbackUrl', () => {
  it.each([
    ['https://server.example', 'https://server.example'],
    ['https://server.example/', 'https://server.example'],
    ['https://server.example///', 'https://server.example'],
    ['https://server.example/chat', 'https://server.example/chat'],
    ['https://server.example/chat/', 'https://server.example/chat'],
    ['https://server.example/chat///', 'https://server.example/chat'],
    ['https://server.example/apps/librechat/', 'https://server.example/apps/librechat'],
  ])('joins %s to callback paths without duplicate slashes', (baseUrl, expected) => {
    for (const callbackPath of [
      '/api/mcp/test-server/oauth/callback',
      '/api/mcp/oauth/callback',
      '/api/actions/test-action/oauth/callback',
    ]) {
      expect(getOAuthCallbackUrl(baseUrl, callbackPath)).toBe(`${expected}${callbackPath}`);
    }
  });
});
