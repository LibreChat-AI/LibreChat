import React from 'react';
import { RecoilRoot } from 'recoil';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import BadgeRowProvider, { useBadgeRowContext } from '../BadgeRowContext';

/**
 * `BadgeRowProvider` is an inline child of `ChatForm`, which re-renders on every
 * keystroke in the composer. Its context value is memoized for exactly that
 * reason, but a memo is only worth as much as its dependencies, and two of them
 * were hooks handing back a fresh object literal every render. The value changed
 * on each character typed, and every consumer of it rebuilt: the palette's whole
 * tool, skill and MCP server catalog, per keystroke.
 */

/* Held outside the factory so it is one function for the whole test, the way
   the real `ToastProvider` sits above the composer and does not re-render with
   it. A fresh `showToast` per render would be the mock's instability, not the
   provider's. */
const mockShowToast = jest.fn();
jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));

/* The suite-wide `react-i18next` stub builds a new `t` on every render, which
   the real one does not: it holds `t` in state and replaces it only when the
   language or namespace changes. Left as-is, every `useLocalize` consumer here
   would look unstable for a reason that does not exist outside the tests. */
const mockTranslate = (key: string) => key;
const mockToolAuth = { authenticated: false };
jest.mock('react-i18next', () => ({
  ...jest.requireActual('react-i18next'),
  useTranslation: () => ({ t: mockTranslate, i18n: { changeLanguage: jest.fn() } }),
}));

/* Startup config and the server catalog are external HTTP queries. Their
   contents do not matter to this identity test, and leaving them live lets a
   rejected `/api/config` request report after Jest has torn the test down. */
jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useGetEndpointsQuery: () => ({ data: undefined }),
  useGetStartupConfig: () => ({ data: undefined }),
  useMCPServersQuery: () => ({ data: undefined, isLoading: false }),
  useVerifyAgentToolAuth: () => ({ data: mockToolAuth }),
}));

function renderProvider() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: 0 } },
  });
  let value: ReturnType<typeof useBadgeRowContext>;
  const Consumer = () => {
    value = useBadgeRowContext();
    return null;
  };
  const Tree = ({ marker }: { marker: number }) => (
    <QueryClientProvider client={client}>
      <RecoilRoot>
        <BadgeRowProvider conversationId="convo-badge-row">
          {/* Re-rendered along with the provider, the way `Bar` is. */}
          <span>{marker}</span>
          <Consumer />
        </BadgeRowProvider>
      </RecoilRoot>
    </QueryClientProvider>
  );
  const { rerender } = render(<Tree marker={0} />);
  return {
    getValue: () => value,
    retype: (marker: number) => rerender(<Tree marker={marker} />),
  };
}

describe('BadgeRowProvider', () => {
  it('hands consumers the same value across a parent re-render', () => {
    const { getValue, retype } = renderProvider();
    const first = getValue();
    retype(1);
    expect(getValue()).toBe(first);
    retype(2);
    expect(getValue()).toBe(first);
  });

  /* The two that were rebuilding: both are carried into the context value
     whole, so an unstable reference from either defeats the memo by itself. */
  it('keeps the search form and MCP manager referentially stable', () => {
    const { getValue, retype } = renderProvider();
    const first = getValue();
    retype(1);

    const last = getValue();
    expect(last?.searchApiKeyForm).toBe(first?.searchApiKeyForm);
    expect(last?.mcpServerManager).toBe(first?.mcpServerManager);
  });

  /* Without this the cases above would still pass against a provider that had
     stopped providing: every value would be `undefined`, and identical. */
  it('is undefined outside the provider, and an object inside it', () => {
    let outside: unknown = 'unset';
    const Consumer = () => {
      outside = useBadgeRowContext();
      return null;
    };
    render(<Consumer />);
    expect(outside).toBeUndefined();

    const { getValue } = renderProvider();
    expect(getValue()).toEqual(expect.objectContaining({ conversationId: 'convo-badge-row' }));
  });
});
