import React from 'react';
import copy from 'copy-to-clipboard';
import '@testing-library/jest-dom/extend-expect';
import { render, fireEvent } from 'test/layout-test-utils';
import Reveal from '../Reveal';

const mockUseGetStartupConfig = jest.fn(() => ({ data: { remoteApiModelsEnabled: true } }));
jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useGetStartupConfig: () => mockUseGetStartupConfig(),
}));

/** jsdom has no execCommand, so the real module always reports a failed write */
jest.mock('copy-to-clipboard');
const mockCopy = copy as jest.MockedFunction<typeof copy>;

const createdKey = {
  id: 'new-1',
  name: 'CI key',
  key: 'lc-secret-full-key',
  keyPrefix: 'lc-secret',
  createdAt: '2026-06-13T00:00:00Z',
};

describe('Reveal', () => {
  beforeEach(() => {
    mockCopy.mockReset();
    mockCopy.mockReturnValue(true);
  });

  it('shows the one-time warning and the key value', () => {
    const { getByText, getByDisplayValue } = render(
      <Reveal createdKey={createdKey} onDone={jest.fn()} />,
    );
    expect(getByText(/You won't be able to see it again/)).toBeInTheDocument();
    expect(getByDisplayValue('lc-secret-full-key')).toBeInTheDocument();
  });

  it('hides the key by default behind a password field', () => {
    const { getByDisplayValue } = render(<Reveal createdKey={createdKey} onDone={jest.fn()} />);
    expect(getByDisplayValue('lc-secret-full-key')).toHaveAttribute('type', 'password');
  });

  it('calls onDone', () => {
    const onDone = jest.fn();
    const { getByRole } = render(<Reveal createdKey={createdKey} onDone={onDone} />);
    fireEvent.click(getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalled();
  });

  it('renders the standardized copy control inside the input', () => {
    const { getByRole } = render(<Reveal createdKey={createdKey} onDone={jest.fn()} />);
    expect(getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('shows copied feedback after clicking copy', async () => {
    const { getByRole, findByRole } = render(<Reveal createdKey={createdKey} onDone={jest.fn()} />);
    fireEvent.click(getByRole('button', { name: 'Copy' }));
    expect(mockCopy).toHaveBeenCalledWith('lc-secret-full-key', { format: 'text/plain' });
    expect(await findByRole('button', { name: /Copied/ })).toBeInTheDocument();
  });

  it('keeps the copy control idle when the clipboard write fails', () => {
    mockCopy.mockReturnValue(false);
    const { getByRole, queryByRole } = render(
      <Reveal createdKey={createdKey} onDone={jest.fn()} />,
    );
    fireEvent.click(getByRole('button', { name: 'Copy' }));
    expect(queryByRole('button', { name: /Copied/ })).not.toBeInTheDocument();
  });

  describe('API base URL', () => {
    it('shows where OpenAI-compatible clients connect', () => {
      const { getByLabelText } = render(<Reveal createdKey={createdKey} onDone={jest.fn()} />);
      expect(getByLabelText('API base URL')).toHaveValue(`${window.location.origin}/api/agents/v1`);
      expect(getByLabelText('API base URL')).toHaveAttribute('readonly');
    });

    it('copies the base URL with its own, distinctly named control', () => {
      const { getByRole } = render(<Reveal createdKey={createdKey} onDone={jest.fn()} />);
      fireEvent.click(getByRole('button', { name: 'Copy API base URL' }));
      expect(mockCopy).toHaveBeenCalledWith(`${window.location.origin}/api/agents/v1`, {
        format: 'text/plain',
      });
      expect(mockCopy).not.toHaveBeenCalledWith('lc-secret-full-key', expect.anything());
    });

    it('says the key reaches models when the deployment allows it', () => {
      const { getByText } = render(<Reveal createdKey={createdKey} onDone={jest.fn()} />);
      expect(getByText(/Pass one of your agents or models as the model/)).toBeInTheDocument();
    });

    it('says agents only when the administrator turned model access off', () => {
      mockUseGetStartupConfig.mockReturnValueOnce({ data: { remoteApiModelsEnabled: false } });
      const { getByText, queryByText } = render(
        <Reveal createdKey={createdKey} onDone={jest.fn()} />,
      );
      expect(getByText(/Pass one of your agent IDs as the model/)).toBeInTheDocument();
      expect(queryByText(/agents or models/)).not.toBeInTheDocument();
    });

    it('describes the base URL field with the usage note', () => {
      const { getByLabelText } = render(<Reveal createdKey={createdKey} onDone={jest.fn()} />);
      expect(getByLabelText('API base URL')).toHaveAttribute(
        'aria-describedby',
        'reveal-api-key-usage',
      );
    });
  });
});
