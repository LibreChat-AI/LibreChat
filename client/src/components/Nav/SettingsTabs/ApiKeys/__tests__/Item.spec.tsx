import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { useDeleteAgentApiKeyMutation } from 'librechat-data-provider/react-query';
import type { TAgentApiKeyListItem } from 'librechat-data-provider';
import { render, fireEvent } from 'test/layout-test-utils';
import Item from '../Item';

jest.mock('librechat-data-provider/react-query', () => ({
  ...jest.requireActual('librechat-data-provider/react-query'),
  useDeleteAgentApiKeyMutation: jest.fn(),
}));

/** The dialog is covered by its own spec; here only how a key row opens it. */
jest.mock('../KeyGrant', () => ({
  __esModule: true,
  default: ({ id, name }: { id: string; name: string }) => (
    <div data-testid="key-grant">{`${id}:${name}`}</div>
  ),
}));

const mockDelete = useDeleteAgentApiKeyMutation as jest.Mock;

const baseKey: TAgentApiKeyListItem = {
  id: 'key-1',
  name: 'CI Pipeline',
  keyPrefix: 'lc-abc123',
  createdAt: '2026-06-01T00:00:00Z',
};

function renderItem(apiKey = baseKey, grants?: boolean) {
  return render(
    <ul>
      <Item apiKey={apiKey} grants={grants} />
    </ul>,
  );
}

beforeEach(() => {
  mockDelete.mockReturnValue({ mutate: jest.fn(), isLoading: false });
});

describe('Item', () => {
  it('renders the name, prefix, and readable metadata', () => {
    const { getByText } = renderItem();
    expect(getByText('CI Pipeline')).toBeInTheDocument();
    expect(getByText(/lc-abc123/)).toBeInTheDocument();
    expect(getByText(/Never used/)).toBeInTheDocument();
    expect(getByText(/No expiration/)).toBeInTheDocument();
  });

  it('shows the expiring badge within 14 days', () => {
    const expiresAt = new Date(Date.now() + 5 * 86400000).toISOString();
    const { getByText } = renderItem({ ...baseKey, expiresAt });
    expect(getByText(/Expires in \d+ days/)).toBeInTheDocument();
  });

  it('uses the singular badge at exactly 1 day', () => {
    const expiresAt = new Date(Date.now() + 12 * 3600000).toISOString();
    const { getByText } = renderItem({ ...baseKey, expiresAt });
    expect(getByText('Expires in 1 day')).toBeInTheDocument();
  });

  it('shows the expired badge for past expiry', () => {
    const { getByText } = renderItem({ ...baseKey, expiresAt: '2020-01-01T00:00:00Z' });
    expect(getByText('Expired')).toBeInTheDocument();
  });

  it('exposes a labelled delete button that opens the delete dialog', async () => {
    const { getByRole, findByText } = renderItem();
    const deleteButton = getByRole('button', { name: 'Delete API key CI Pipeline' });
    expect(deleteButton).toBeInTheDocument();

    fireEvent.click(deleteButton);
    expect(await findByText(/This action cannot be undone/)).toBeInTheDocument();
  });

  it('offers no MCP access button where key runs are not limited by grants', () => {
    const { queryByRole, queryByTestId } = renderItem();
    expect(queryByRole('button', { name: /MCP access/ })).not.toBeInTheDocument();
    expect(queryByTestId('key-grant')).not.toBeInTheDocument();
  });

  it('offers no MCP access button for a key issued to an integration, which holds no grants', () => {
    const { queryByRole } = renderItem({ ...baseKey, bound: true }, true);
    expect(queryByRole('button', { name: /MCP access/ })).not.toBeInTheDocument();
  });

  it('opens the MCP access dialog for this key where grants are in use', () => {
    const { getByRole, getByTestId, queryByTestId } = renderItem(baseKey, true);
    const button = getByRole('button', { name: 'MCP access for API key CI Pipeline' });
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    expect(queryByTestId('key-grant')).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(getByTestId('key-grant')).toHaveTextContent('key-1:CI Pipeline');
  });
});
