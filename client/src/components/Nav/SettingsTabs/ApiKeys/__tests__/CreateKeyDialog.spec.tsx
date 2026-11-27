import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { useCreateAgentApiKeyMutation } from 'librechat-data-provider/react-query';
import { render, fireEvent, waitFor } from 'test/layout-test-utils';
import CreateKeyDialog from '../CreateKeyDialog';

jest.mock('librechat-data-provider/react-query', () => ({
  ...jest.requireActual('librechat-data-provider/react-query'),
  useCreateAgentApiKeyMutation: jest.fn(),
}));

const mockCreate = useCreateAgentApiKeyMutation as jest.Mock;

const createdKey = {
  id: 'new-1',
  name: 'CI key',
  key: 'lc-secret-full-key',
  keyPrefix: 'lc-secret',
  createdAt: '2026-06-13T00:00:00Z',
};

describe('CreateKeyDialog', () => {
  let mutateAsync: jest.Mock;

  beforeEach(() => {
    mutateAsync = jest.fn().mockResolvedValue(createdKey);
    mockCreate.mockReturnValue({ mutateAsync, isLoading: false });
  });

  it('renders nothing when closed', () => {
    const { queryByRole } = render(<CreateKeyDialog open={false} onOpenChange={jest.fn()} />);
    expect(queryByRole('heading', { name: 'Create API Key' })).not.toBeInTheDocument();
  });

  it('creates a key, reveals it, and closes on done', async () => {
    const onOpenChange = jest.fn();
    const { getByRole, getByLabelText, getByDisplayValue } = render(
      <CreateKeyDialog open onOpenChange={onOpenChange} />,
    );

    expect(getByRole('heading', { name: 'Create API Key' })).toBeInTheDocument();

    fireEvent.change(getByLabelText('Key Name'), { target: { value: 'CI key' } });
    fireEvent.click(getByRole('button', { name: 'Create' }));

    await waitFor(() =>
      expect(getByRole('heading', { name: 'API key created successfully' })).toBeInTheDocument(),
    );
    expect(getByDisplayValue('lc-secret-full-key')).toBeInTheDocument();

    fireEvent.click(getByRole('button', { name: 'Done' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cancels without creating', () => {
    const onOpenChange = jest.fn();
    const { getByRole } = render(<CreateKeyDialog open onOpenChange={onOpenChange} />);
    fireEvent.click(getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
