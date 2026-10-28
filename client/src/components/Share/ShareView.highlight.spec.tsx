import React, { useContext } from 'react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { act, render, screen } from '@testing-library/react';
import type { TSharedLinkStartupConfig } from 'librechat-data-provider';
import { CodeHighlightThrottleContext } from '~/components/Chat/Messages/Content/Parts/useLazyHighlight';
import ShareView from './ShareView';

let mockConfig: TSharedLinkStartupConfig | undefined;
const mockStartupQuery = jest.fn();
const mockConfigListeners = new Set<() => void>();
jest.mock('~/data-provider', () => ({
  useGetSharedStartupConfig: (...args: unknown[]) => {
    mockStartupQuery(...args);
    const { useSyncExternalStore } = jest.requireActual('react');
    const data = useSyncExternalStore(
      (listener: () => void) => {
        mockConfigListeners.add(listener);
        return () => mockConfigListeners.delete(listener);
      },
      () => mockConfig,
    );
    return { data };
  },
  useForkSharedConvoMutation: () => ({ mutate: jest.fn(), isLoading: false }),
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ isAuthReady: true }),
  useDocumentTitle: jest.fn(),
}));
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ shareId: 'shared-link' }),
}));
jest.mock('librechat-data-provider/react-query', () => ({
  ...jest.requireActual('librechat-data-provider/react-query'),
  useGetSharedMessages: () => ({
    data: {
      messages: [{ messageId: 'shared-message', parentMessageId: null, text: 'hello' }],
      title: 'Shared chat',
    },
    isLoading: false,
    isFetching: false,
  }),
}));

function MockCadence({ name }: { name: string }) {
  return <output data-testid={name}>{useContext(CodeHighlightThrottleContext)}</output>;
}
jest.mock('./MessagesView', () => ({
  __esModule: true,
  default: () => <MockCadence name="message-cadence" />,
}));
jest.mock('~/components/Chat/Subagents/SharedSubagentActivityDialog', () => ({
  __esModule: true,
  default: () => <MockCadence name="subagent-cadence" />,
}));
jest.mock('./ShareArtifacts', () => ({
  ShareArtifactsContainer: ({ mainContent }: { mainContent: React.ReactNode }) => mainContent,
}));
jest.mock('../Chat/Surface', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../Chat/Footer', () => ({ __esModule: true, default: () => null }));

const frame = () => (
  <RecoilRoot>
    <MemoryRouter>
      <ShareView />
    </MemoryRouter>
  </RecoilRoot>
);

describe('shared code highlighting configuration', () => {
  it.each([0, 100, 60000])(
    'passes the share payload cadence %i to both content surfaces',
    (cadence) => {
      mockConfig = { appTitle: 'Share', interface: { codeHighlightThrottleMs: cadence } };
      render(frame());
      expect(screen.getByTestId('message-cadence').textContent).toBe(String(cadence));
      expect(screen.getByTestId('subagent-cadence').textContent).toBe(String(cadence));
      expect(mockStartupQuery).toHaveBeenCalledWith('shared-link', { enabled: true });
    },
  );

  it('uses the default while loading, then applies config without waiting on messages', () => {
    mockConfig = undefined;
    render(frame());
    expect(screen.getByTestId('message-cadence').textContent).toBe('300');
    act(() => {
      mockConfig = { appTitle: 'Share', interface: { codeHighlightThrottleMs: 0 } };
      mockConfigListeners.forEach((listener) => listener());
    });
    expect(screen.getByTestId('message-cadence').textContent).toBe('0');
  });

  it.each([undefined, -1, NaN, 60001])('normalizes absent or invalid cadence %s', (cadence) => {
    mockConfig = { appTitle: 'Share', interface: { codeHighlightThrottleMs: cadence } };
    render(frame());
    expect(screen.getByTestId('message-cadence').textContent).toBe('300');
  });
});
