import React from 'react';
import '@testing-library/jest-dom/extend-expect';
import { useCreateAgentApiKeyMutation } from 'librechat-data-provider/react-query';
import { render, fireEvent, waitFor } from 'test/layout-test-utils';
import Create from '../Create';

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

describe('Create', () => {
  let mutateAsync: jest.Mock;

  beforeEach(() => {
    mutateAsync = jest.fn().mockResolvedValue(createdKey);
    mockCreate.mockReturnValue({ mutateAsync, isLoading: false });
  });

  it('keeps Create disabled until a non-empty name is entered', () => {
    const { getByRole, getByLabelText } = render(
      <Create onCreated={jest.fn()} onCancel={jest.fn()} />,
    );
    expect(getByRole('button', { name: 'Create' })).toBeDisabled();

    fireEvent.change(getByLabelText('Key Name'), { target: { value: '   ' } });
    expect(getByRole('button', { name: 'Create' })).toBeDisabled();

    fireEvent.change(getByLabelText('Key Name'), { target: { value: 'CI key' } });
    expect(getByRole('button', { name: 'Create' })).toBeEnabled();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('submits the trimmed name with the default 30-day expiration', async () => {
    const onCreated = jest.fn();
    const { getByRole, getByLabelText } = render(
      <Create onCreated={onCreated} onCancel={jest.fn()} />,
    );

    fireEvent.change(getByLabelText('Key Name'), { target: { value: '  CI key  ' } });
    fireEvent.click(getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(createdKey));

    const payload = mutateAsync.mock.calls[0][0];
    expect(payload.name).toBe('CI key');
    const diffDays = (new Date(payload.expiresAt).getTime() - Date.now()) / 86400000;
    expect(diffDays).toBeGreaterThan(29.9);
    expect(diffDays).toBeLessThanOrEqual(30.1);
  });

  it('calls onCancel from the cancel button', () => {
    const onCancel = jest.fn();
    const { getByRole } = render(<Create onCreated={jest.fn()} onCancel={onCancel} />);
    fireEvent.click(getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not call onCreated when creation fails', async () => {
    mutateAsync.mockRejectedValue(new Error('boom'));
    const onCreated = jest.fn();
    const { getByRole, getByLabelText } = render(
      <Create onCreated={onCreated} onCancel={jest.fn()} />,
    );
    fireEvent.change(getByLabelText('Key Name'), { target: { value: 'CI key' } });
    fireEvent.click(getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('disables actions while creating', () => {
    mockCreate.mockReturnValue({ mutateAsync, isLoading: true });
    const { getByRole } = render(<Create onCreated={jest.fn()} onCancel={jest.fn()} />);
    expect(getByRole('button', { name: 'Create' })).toBeDisabled();
    expect(getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });
});
