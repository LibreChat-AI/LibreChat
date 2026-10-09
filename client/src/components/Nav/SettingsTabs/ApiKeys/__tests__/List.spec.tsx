import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import {
  useGetAgentApiKeysQuery,
  useDeleteAgentApiKeyMutation,
} from 'librechat-data-provider/react-query';
import { render, fireEvent } from 'test/layout-test-utils';
import List from '../List';

jest.mock('librechat-data-provider/react-query', () => ({
  ...jest.requireActual('librechat-data-provider/react-query'),
  useGetAgentApiKeysQuery: jest.fn(),
  useDeleteAgentApiKeyMutation: jest.fn(),
}));

const mockQuery = useGetAgentApiKeysQuery as jest.Mock;
const mockDelete = useDeleteAgentApiKeyMutation as jest.Mock;

function renderList(props: Partial<React.ComponentProps<typeof List>> = {}) {
  return render(<List onCreate={jest.fn()} {...props} />);
}

describe('List', () => {
  beforeEach(() => {
    mockDelete.mockReturnValue({ mutateAsync: jest.fn(), isLoading: false });
    mockQuery.mockReturnValue({
      data: { keys: [] },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: jest.fn(),
    });
  });

  it('shows a loading indicator', () => {
    mockQuery.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      refetch: jest.fn(),
    });
    const { getByTestId } = renderList();
    expect(getByTestId('api-keys-loading')).toBeInTheDocument();
  });

  it('shows the error state and retries', () => {
    const refetch = jest.fn();
    mockQuery.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch,
    });
    const { getByText, getByRole } = renderList();
    expect(getByText('Failed to load API keys')).toBeInTheDocument();
    fireEvent.click(getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('shows the onboarding empty state with a create CTA', () => {
    const onCreate = jest.fn();
    const { getByText, getByRole } = renderList({ onCreate });
    expect(getByText('Connect your agents to external apps')).toBeInTheDocument();
    fireEvent.click(getByRole('button', { name: 'Create API Key' }));
    expect(onCreate).toHaveBeenCalled();
  });

  it('renders a semantic list of keys', () => {
    mockQuery.mockReturnValue({
      data: {
        keys: [
          { id: '1', name: 'Alpha', keyPrefix: 'lc-aaa', createdAt: '2026-01-01T00:00:00Z' },
          { id: '2', name: 'Beta', keyPrefix: 'lc-bbb', createdAt: '2026-02-01T00:00:00Z' },
        ],
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: jest.fn(),
    });
    const { getByRole, getByText } = renderList();
    expect(getByRole('list', { name: 'Agent API Keys' })).toBeInTheDocument();
    expect(getByText('Alpha')).toBeInTheDocument();
    expect(getByText('Beta')).toBeInTheDocument();
  });

  it('keeps showing cached keys when a background refetch fails', () => {
    mockQuery.mockReturnValue({
      data: {
        keys: [{ id: '1', name: 'Alpha', keyPrefix: 'lc-aaa', createdAt: '2026-01-01T00:00:00Z' }],
      },
      isLoading: false,
      isError: true,
      isFetching: false,
      refetch: jest.fn(),
    });
    const { getByText, queryByText } = renderList();
    expect(getByText('Alpha')).toBeInTheDocument();
    expect(queryByText('Failed to load API keys')).not.toBeInTheDocument();
  });
});
