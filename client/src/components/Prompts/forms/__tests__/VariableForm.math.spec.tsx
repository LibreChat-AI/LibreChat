import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TPromptGroup } from 'librechat-data-provider';
import VariableForm from '../VariableForm';

const mockSubmitPrompt = jest.fn();
jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: { id: 'user-1', name: 'Tester' } }),
  useLocalize: () => (key: string) => key,
  useSubmitMessage: () => ({ submitPrompt: mockSubmitPrompt }),
}));

jest.mock('~/data-provider', () => ({
  useRecordPromptUsage: () => ({ mutate: jest.fn() }),
}));

const group = {
  _id: 'group-1',
  name: 'Explain',
  productionPrompt: { prompt: 'Explain {{expression}}' },
} as unknown as TPromptGroup;

describe('VariableForm preview', () => {
  it('renders math typed into a variable of a template that has none', async () => {
    const { container } = render(<VariableForm group={group} onClose={jest.fn()} />);
    expect(container.querySelector('.katex')).toBeNull();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '$$E=mc^2$$' } });

    await waitFor(() => expect(container.querySelector('.katex')).not.toBeNull());
  });

  it('submits the typed value literally, dollar signs included', async () => {
    render(<VariableForm group={group} onClose={jest.fn()} />);
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: "$$E=mc^2$$ and $& and $'" },
    });
    fireEvent.submit(screen.getByRole('textbox').closest('form')!);

    await waitFor(() =>
      expect(mockSubmitPrompt).toHaveBeenCalledWith("Explain $$E=mc^2$$ and $& and $'"),
    );
  });
});
