/**
 * @jest-environment @happy-dom/jest-environment
 */
import axios from 'axios';
import { setTokenHeader } from '../src/headers-helpers';

const mockAdapter = jest.fn();
let originalAdapter: typeof axios.defaults.adapter;
let savedLocation: Location;
let baseElement: HTMLBaseElement;
let originalProcessBrowser: boolean | undefined;

beforeAll(async () => {
  originalAdapter = axios.defaults.adapter;
  axios.defaults.adapter = mockAdapter;

  baseElement = document.createElement('base');
  baseElement.setAttribute('href', '/chat/');
  document.head.appendChild(baseElement);

  const proc = process as typeof process & { browser?: boolean };
  originalProcessBrowser = proc.browser;
  proc.browser = true;

  await import('../src/request');
});

beforeEach(() => {
  mockAdapter.mockReset();
  savedLocation = window.location;
});

afterAll(() => {
  axios.defaults.adapter = originalAdapter;
  document.head.removeChild(baseElement);

  const proc = process as typeof process & { browser?: boolean };
  if (originalProcessBrowser === undefined) {
    delete proc.browser;
  } else {
    proc.browser = originalProcessBrowser;
  }
});

afterEach(() => {
  delete axios.defaults.headers.common['Authorization'];
  window.localStorage.clear();
  delete (window as Window & { __librechatAuthRecovery?: unknown }).__librechatAuthRecovery;
  Object.defineProperty(window, 'location', {
    value: savedLocation,
    writable: true,
    configurable: true,
  });
});

function setWindowLocation(overrides: Partial<Location>) {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, ...overrides },
    writable: true,
    configurable: true,
  });
}

describe('axios 401 interceptor — subdirectory shared link guard', () => {
  it('recognizes base-prefixed shared link data requests', async () => {
    expect.assertions(2);
    setTokenHeader(undefined);

    setWindowLocation({
      href: 'http://localhost/chat/share/abc123',
      pathname: '/chat/share/abc123',
      search: '',
      hash: '',
      origin: 'http://localhost',
    } as Partial<Location>);

    mockAdapter.mockRejectedValueOnce({
      response: { status: 401 },
      config: { url: '/chat/api/share/abc123', method: 'get', headers: {} },
    });

    mockAdapter.mockResolvedValueOnce({
      data: { token: 'new-token' },
      status: 200,
      headers: {},
      config: {},
    });

    mockAdapter.mockResolvedValueOnce({
      data: { sharedLink: {} },
      status: 200,
      headers: {},
      config: {},
    });

    try {
      await axios.get('/chat/api/share/abc123');
    } catch {
      // may reject depending on exact flow
    }

    expect(mockAdapter.mock.calls.length).toBe(3);

    const refreshCall = mockAdapter.mock.calls[1];
    expect(refreshCall[0].url).toBe('/chat/api/auth/refresh');
  });

  it('does not refresh or redirect for unrelated base-prefixed 401s on public shared links', async () => {
    expect.assertions(2);
    setTokenHeader(undefined);

    setWindowLocation({
      href: 'http://localhost/chat/share/abc123',
      pathname: '/chat/share/abc123',
      search: '',
      hash: '',
    } as Partial<Location>);

    mockAdapter.mockRejectedValueOnce({
      response: { status: 401 },
      config: { url: '/chat/api/mcp/servers', method: 'get', headers: {} },
    });

    try {
      await axios.get('/chat/api/mcp/servers');
    } catch {
      // expected rejection
    }

    expect(mockAdapter).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe('http://localhost/chat/share/abc123');
  });

  it('does not strip paths that only share the base prefix', async () => {
    expect.assertions(1);
    setTokenHeader(undefined);

    setWindowLocation({
      href: 'http://localhost/chatroom/share/abc123',
      pathname: '/chatroom/share/abc123',
      search: '',
      hash: '',
    } as Partial<Location>);

    mockAdapter.mockRejectedValueOnce({
      response: { status: 401 },
      config: { url: '/chatroom/api/share/abc123', method: 'get', headers: {} },
    });

    try {
      await axios.get('/chatroom/api/share/abc123');
    } catch {
      // expected rejection
    }

    expect(mockAdapter).toHaveBeenCalledTimes(1);
  });
});
