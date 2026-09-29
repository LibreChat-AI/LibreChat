/**
 * @jest-environment jsdom
 */
import {
  agentQueuedTurn,
  buildLoginRedirectUrl,
  getSharedLinks,
  agentQueuedTurnsByConversation,
} from '../src/api-endpoints';

describe('buildLoginRedirectUrl', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('builds a login URL from explicit args', () => {
    const result = buildLoginRedirectUrl('/c/new', '?q=hello', '');
    expect(result).toBe('/login?redirect_to=%2Fc%2Fnew%3Fq%3Dhello');
  });

  it('encodes complex paths with query and hash', () => {
    const result = buildLoginRedirectUrl('/c/new', '?q=hello&submit=true', '#section');
    expect(result).toContain('redirect_to=');
    const encoded = result.split('redirect_to=')[1];
    expect(decodeURIComponent(encoded)).toBe('/c/new?q=hello&submit=true#section');
  });

  it('falls back to window.location when no args provided', () => {
    window.history.replaceState({}, '', '/c/abc123?model=gpt-4#msg-5');
    const result = buildLoginRedirectUrl();
    const encoded = result.split('redirect_to=')[1];
    expect(decodeURIComponent(encoded)).toBe('/c/abc123?model=gpt-4#msg-5');
  });

  it('returns plain /login when all location parts are empty (root)', () => {
    window.history.replaceState({}, '', '/');
    const result = buildLoginRedirectUrl();
    expect(result).toBe('/login');
  });

  it('returns plain /login when pathname is /login (prevents recursive redirect)', () => {
    const result = buildLoginRedirectUrl('/login', '?redirect_to=%2Fc%2Fnew', '');
    expect(result).toBe('/login');
  });

  it('returns plain /login when window.location is already /login', () => {
    window.history.replaceState({}, '', '/login?redirect_to=%2Fc%2Fabc');
    const result = buildLoginRedirectUrl();
    expect(result).toBe('/login');
  });

  it('returns plain /login for /login sub-paths', () => {
    const result = buildLoginRedirectUrl('/login/2fa', '', '');
    expect(result).toBe('/login');
  });

  it('returns plain /login for basename-prefixed /login (e.g. /librechat/login)', () => {
    window.history.replaceState({}, '', '/librechat/login?redirect_to=%2Fc%2Fabc');
    const result = buildLoginRedirectUrl();
    expect(result).toBe('/login');
  });

  it('returns plain /login for basename-prefixed /login sub-paths', () => {
    const result = buildLoginRedirectUrl('/librechat/login/2fa', '', '');
    expect(result).toBe('/login');
  });

  it('returns plain /login for root path (no pointless redirect_to=/)', () => {
    const result = buildLoginRedirectUrl('/', '', '');
    expect(result).toBe('/login');
    expect(result).not.toContain('redirect_to');
  });

  it('does NOT match paths where "login" is a substring of a segment', () => {
    const result = buildLoginRedirectUrl('/c/loginhistory', '', '');
    expect(result).toContain('redirect_to=');
    expect(decodeURIComponent(result.split('redirect_to=')[1])).toBe('/c/loginhistory');
  });
});

describe('getSharedLinks', () => {
  it('encodes search and cursor values exactly once', () => {
    const result = getSharedLinks(
      25,
      'createdAt',
      'desc',
      '100% ready & waiting',
      '2030-01-01T00:00:00.000Z',
    );

    expect(result).toBe(
      '/api/share?pageSize=25&sortBy=createdAt&sortDirection=desc&search=100%25%20ready%20%26%20waiting&cursor=2030-01-01T00%3A00%3A00.000Z',
    );
  });
});

describe('agent queued turns', () => {
  it('encodes conversation identity exactly once', () => {
    expect(agentQueuedTurnsByConversation('conversation/a b')).toBe(
      '/api/agents/chat/queued-turns?conversationId=conversation%2Fa%20b',
    );
  });

  it('encodes deduplicated known request identities as repeated bounded query values', () => {
    expect(
      agentQueuedTurnsByConversation('conversation/one', [
        'request/one',
        'request,two',
        'request/one',
      ]),
    ).toBe(
      '/api/agents/chat/queued-turns?conversationId=conversation%2Fone&clientRequestIds=request%2Fone&clientRequestIds=request%2Ctwo',
    );
  });

  it('encodes queued-turn identity as one path segment', () => {
    expect(agentQueuedTurn('turn/a b')).toBe('/api/agents/chat/queued-turns/turn%2Fa%20b');
  });
});
