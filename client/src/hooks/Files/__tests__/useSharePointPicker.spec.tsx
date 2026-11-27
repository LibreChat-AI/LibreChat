import React from 'react';
import { RecoilRoot } from 'recoil';
import { dataService } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GraphTokenResponse } from 'librechat-data-provider';
import useSharePointPicker from '../useSharePointPicker';

/**
 * The server mints the Graph token and it dies an hour later, but the picker is mounted for as
 * long as the page is open. It used to read the token cached at page load whenever it opened the
 * picker or answered the picker's `authenticate` command, so a page left open past the token's
 * lifetime handed SharePoint a dead token until it was reloaded.
 *
 * The server is stubbed as the token authority: every call issues the next token, which stands
 * for the first one having expired by the time the user comes back.
 */

const configured = {
  sharePointFilePickerEnabled: true,
  sharePointBaseUrl: 'https://contoso.sharepoint.example' as string | undefined,
  sharePointPickerSharePointScope: 'https://contoso.sharepoint.example/.default',
};
const mockShowToast = jest.fn();
let mockConfig = configured;

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockShowToast }),
}));

/** The built package exports `dataService` as a frozen namespace; a plain copy can be spied on. */
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ user: { provider: 'openid' } }),
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ user: { provider: 'openid' } }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockConfig }),
  useGraphTokenQuery: jest.requireActual('~/data-provider/Auth/queries').useGraphTokenQuery,
}));

type Message = Record<string, any>;

let minted = 0;
let outage = false;
let getGraphApiToken: jest.SpiedFunction<typeof dataService.getGraphApiToken>;

const issue = (): GraphTokenResponse => ({
  access_token: `token-${++minted}`,
  token_type: 'Bearer',
  expires_in: 3600,
  scope: mockConfig.sharePointPickerSharePointScope,
});

beforeEach(() => {
  minted = 0;
  outage = false;
  mockConfig = configured;
  getGraphApiToken = jest.spyOn(dataService, 'getGraphApiToken').mockImplementation(async () => {
    if (outage) {
      throw new Error('Request failed with status code 503');
    }
    return issue();
  });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  document.body.innerHTML = '';
});

function mount(options: { disabled?: boolean } = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  const view = renderHook(() => useSharePointPicker({ containerNode: container, ...options }), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>
        <RecoilRoot>{children}</RecoilRoot>
      </QueryClientProvider>
    ),
  });
  return { ...view, container };
}

/** The page after it has loaded: the hook mounted and the token it prefetched cached. */
async function loadPage() {
  const page = mount();
  await waitFor(() => expect(page.result.current.isTokenLoading).toBe(false));
  expect(getGraphApiToken).toHaveBeenCalledTimes(1);
  return page;
}

type Page = ReturnType<typeof mount>;

const open = (page: Page) =>
  act(async () => {
    await page.result.current.openSharePointPicker();
  });

/** The form the app submits into the picker iframe, which is where SharePoint reads the token. */
async function pickerForm(page: Page) {
  const frame = page.container.querySelector('iframe') as HTMLIFrameElement;
  await waitFor(() => expect(frame.contentDocument?.querySelector('form')).not.toBeNull());
  const form = frame.contentDocument?.querySelector('form') as HTMLFormElement;
  const options = JSON.parse(new URL(form.action).searchParams.get('filePicker') as string);
  return {
    frame,
    channelId: options.messaging.channelId as string,
    token: (form.querySelector('input[name="access_token"]') as HTMLInputElement).value,
  };
}

/** The iframe's side of the picker protocol: the MessagePort it hands over, and what the host sends. */
function connect(frame: HTMLIFrameElement, channelId: string) {
  const handlers = new Set<(event: MessageEvent) => void>();
  const sent: Message[] = [];
  const port = {
    start: jest.fn(),
    close: jest.fn(),
    addEventListener: (_type: string, handler: (event: MessageEvent) => void) =>
      handlers.add(handler),
    removeEventListener: (_type: string, handler: (event: MessageEvent) => void) =>
      handlers.delete(handler),
    postMessage: (message: Message) => sent.push(message),
  };
  act(() => {
    window.dispatchEvent(
      Object.assign(new Event('message'), {
        data: { type: 'initialize', channelId },
        source: frame.contentWindow,
        ports: [port],
      }),
    );
  });
  expect(sent).toContainEqual({ type: 'activate' });

  return {
    /** Sends the host `authenticate` and resolves with the host's answer to it. */
    async authenticate(id: string): Promise<Message> {
      handlers.forEach((handler) =>
        handler({
          data: { type: 'command', id, data: { command: 'authenticate' } },
        } as MessageEvent),
      );
      await waitFor(() => expect(sent.some((m) => m.type === 'result' && m.id === id)).toBe(true));
      return sent.find((m) => m.type === 'result' && m.id === id) as Message;
    },
  };
}

describe('useSharePointPicker token', () => {
  it('opens the picker with a token issued now, not the one cached at page load', async () => {
    const page = await loadPage();
    await open(page);

    expect(getGraphApiToken).toHaveBeenCalledTimes(2);
    expect((await pickerForm(page)).token).toBe('token-2');
  });

  it('answers authenticate with a token issued now, not the one the picker opened with', async () => {
    const page = await loadPage();
    await open(page);
    const { frame, channelId } = await pickerForm(page);
    const picker = connect(frame, channelId);

    const answer = await picker.authenticate('1');

    expect(answer.data).toEqual({ result: 'token', token: 'token-3' });
  });

  it('refuses to open on the cached token when the server cannot issue a new one', async () => {
    const page = await loadPage();
    outage = true;
    await open(page);

    expect(page.container.querySelector('iframe')).toBeNull();
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', message: expect.stringContaining('SharePoint') }),
    );
  });

  it('opens on the next attempt once the server can issue a token again', async () => {
    const page = await loadPage();
    outage = true;
    await open(page);
    outage = false;
    await open(page);

    expect((await pickerForm(page)).token).toBe('token-2');
  });

  it('answers authenticate with an error rather than the cached token when no new one can be issued', async () => {
    const page = await loadPage();
    await open(page);
    const { frame, channelId } = await pickerForm(page);
    const picker = connect(frame, channelId);
    outage = true;

    const answer = await picker.authenticate('1');

    expect(answer.data).toEqual({
      result: 'error',
      error: { code: 'noToken', message: 'No authentication token available' },
    });
  });

  it('does not open a picker the user already closed while the token was loading', async () => {
    const page = await loadPage();
    let release: (token: GraphTokenResponse) => void = () => undefined;
    getGraphApiToken.mockImplementationOnce(
      () => new Promise<GraphTokenResponse>((resolve) => (release = resolve)),
    );

    let opening: Promise<void> = Promise.resolve();
    act(() => {
      opening = Promise.resolve(page.result.current.openSharePointPicker());
    });
    act(() => page.result.current.closeSharePointPicker());
    await act(async () => {
      release(issue());
      await opening;
    });

    expect(page.container.querySelector('iframe')).toBeNull();
  });

  it('neither asks for a token nor opens while the picker is disabled', async () => {
    const page = mount({ disabled: true });
    await open(page);

    expect(getGraphApiToken).not.toHaveBeenCalled();
    expect(page.container.querySelector('iframe')).toBeNull();
  });

  it('neither asks for a token nor opens when no SharePoint site is configured', async () => {
    mockConfig = { ...configured, sharePointBaseUrl: undefined };
    const page = mount();
    await open(page);

    expect(getGraphApiToken).not.toHaveBeenCalled();
    expect(page.container.querySelector('iframe')).toBeNull();
  });
});
