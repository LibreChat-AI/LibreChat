import React from 'react';
import { dataService } from 'librechat-data-provider';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { GraphTokenResponse } from 'librechat-data-provider';
import type { SharePointFile } from '~/data-provider/Files';
import useSharePointDownload from '../useSharePointDownload';

/**
 * A download reads the same Graph token the picker does. It used to keep the first token it
 * fetched for as long as the page stayed open and send it to Graph with every later batch, so
 * the first download after the token's hour was up failed until the page was reloaded.
 *
 * The server is stubbed as the token authority: every call issues the next token, which stands
 * for the previous one having expired.
 */

const mockConfig = {
  sharePointFilePickerEnabled: true,
  sharePointBaseUrl: 'https://contoso.sharepoint.example',
  sharePointPickerGraphScope: 'Files.Read.All',
};

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: jest.fn() }),
}));

/** The built package exports `dataService` as a frozen namespace; a plain copy can be spied on. */
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ user: { provider: 'openid' } }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockConfig }),
  useGraphTokenQuery: jest.requireActual('~/data-provider/Auth/queries').useGraphTokenQuery,
}));

let minted = 0;
let outage = false;
let download: jest.Mock;

const attachment: SharePointFile = {
  id: 'item-1',
  name: 'notes.txt',
  size: 5,
  webUrl: 'https://contoso.sharepoint.example/notes.txt',
  downloadUrl: 'https://download.example.test/notes.txt',
  driveId: 'drive-1',
  itemId: 'item-1',
  sharePointItem: {},
};

beforeEach(() => {
  minted = 0;
  outage = false;
  jest.spyOn(dataService, 'getGraphApiToken').mockImplementation(async () => {
    if (outage) {
      throw new Error('Request failed with status code 503');
    }
    return {
      access_token: `token-${++minted}`,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: mockConfig.sharePointPickerGraphScope,
    } as GraphTokenResponse;
  });
  download = jest.fn(async () => ({
    ok: true,
    headers: { get: () => 'text/plain' },
    blob: async () => new Blob(['hello']),
  }));
  Object.defineProperty(global, 'fetch', { value: download, writable: true, configurable: true });
});

afterEach(() => {
  Reflect.deleteProperty(global, 'fetch');
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  return renderHook(() => useSharePointDownload(), {
    wrapper: ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

/** The bearer token each file request went out with. */
const sentWith = () =>
  download.mock.calls.map(
    ([, init]) => (init as { headers: { Authorization: string } }).headers.Authorization,
  );

describe('useSharePointDownload token', () => {
  it('downloads each batch with a token issued now, not the one from an earlier download', async () => {
    const { result } = setup();

    await act(async () => {
      await result.current.downloadSharePointFiles([attachment]);
    });
    await act(async () => {
      await result.current.downloadSharePointFiles([attachment]);
    });

    expect(sentWith()).toEqual(['Bearer token-1', 'Bearer token-2']);
  });

  it('fails the download rather than sending the earlier token when no new one can be issued', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result } = setup();
    await act(async () => {
      await result.current.downloadSharePointFiles([attachment]);
    });
    outage = true;

    await act(async () => {
      await expect(result.current.downloadSharePointFiles([attachment])).rejects.toThrow(
        'Failed to obtain SharePoint access token',
      );
    });

    expect(sentWith()).toEqual(['Bearer token-1']);
  });
});
