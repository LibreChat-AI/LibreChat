import type { IUser } from '@librechat/data-schemas';
import type { ParsedServerConfig } from '../mcp/types';
import { resolveScheduledOboServer } from './target';
import { processMCPEnv } from '../utils/env';

const user = { id: 'owner', email: 'owner@example.test' } as IUser;
const server: ParsedServerConfig = {
  type: 'streamable-http',
  url: 'https://mcp.test/{{REGION}}/{{LIBRECHAT_USER_ID}}',
  obo: { scopes: 'read' },
  source: 'yaml',
};
it('previews exactly the destination the runtime will use without mutating its template', () => {
  const customUserVars = { REGION: 'europe' };
  const actual = resolveScheduledOboServer(server, user, customUserVars);
  const runtime = processMCPEnv({ options: server, user, customUserVars });
  expect(actual.url).toBe('url' in runtime ? runtime.url : undefined);
  expect(actual.url).toBe('https://mcp.test/europe/owner');
  expect(server.url).toContain('{{REGION}}');
});
it.each([
  'LIBRECHAT_BODY_CONVERSATIONID',
  'LIBRECHAT_OPENID_ACCESS_TOKEN',
  'LIBRECHAT_GRAPH_ACCESS_TOKEN',
  'MISSING',
])('rejects non-stable or unresolved target %s', (key) => {
  expect(() =>
    resolveScheduledOboServer({ ...server, url: `https://mcp.test/{{${key}}}` }, user),
  ).toThrow();
});
it('does not process headers or expose credentials during target inspection', () => {
  const actual = resolveScheduledOboServer(
    {
      ...server,
      url: 'https://mcp.test',
      headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
    },
    user,
  );
  expect('headers' in actual ? actual.headers?.Authorization : undefined).toBe(
    'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
  );
});

it('preserves remote WebSocket URL resolution and denies malformed URLs as missing configuration', () => {
  expect(
    resolveScheduledOboServer(
      { type: 'websocket', url: 'wss://mcp.test/{{LIBRECHAT_USER_ID}}', source: 'yaml' },
      user,
    ).url,
  ).toBe('wss://mcp.test/owner');
  expect(() => resolveScheduledOboServer({ ...server, url: 'not a URL' }, user)).toThrow(
    'no supported unattended destination',
  );
});

it.each([undefined, true])(
  'redacts sensitive custom variables by default, including hostname and path (%s)',
  (sensitive) => {
    const resolved = resolveScheduledOboServer(
      {
        ...server,
        url: 'https://{{KEY}}.example.test/{{KEY}}?secret=static-key#static-secret',
        customUserVars: { KEY: { title: 'Key', description: 'Credential', sensitive } },
      },
      user,
      { KEY: 'private-value' },
      true,
    );
    expect(resolved.url).toContain('private-value');
    expect(resolved.displayUrl).not.toContain('private-value');
    expect(resolved.displayUrl).not.toContain('static-key');
    expect(resolved.displayUrl).not.toContain('static-secret');
  },
);
it('retains explicitly non-sensitive routing values in the display URL', () => {
  const resolved = resolveScheduledOboServer(
    {
      ...server,
      customUserVars: { REGION: { title: 'Region', description: 'Region', sensitive: false } },
    },
    user,
    { REGION: 'europe' },
    true,
  );
  expect(resolved.displayUrl).toBe(resolved.url);
});
