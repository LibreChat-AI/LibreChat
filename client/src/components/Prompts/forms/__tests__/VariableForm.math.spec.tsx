import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TPromptGroup } from 'librechat-data-provider';
import VariableForm from '../VariableForm';

const mockSubmitPrompt = jest.fn();
const mockTrack = jest.fn();
jest.mock('~/Providers/TrackingContext', () => ({
  useProductTracking: () => mockTrack,
  useProductTrackingContext: () => () => undefined,
}));
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
  beforeEach(() => {
    jest.clearAllMocks();
  });
  it('records resolution only after variables are confirmed and excludes their values', async () => {
    const promptReference = { source: 'langfuse' as const, groupId: 'group-1' };
    render(
      <VariableForm
        group={group}
        onClose={jest.fn()}
        promptReference={promptReference}
        entryPoint="picker"
      />,
    );
    expect(mockTrack).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'private value' } });
    expect(mockTrack).not.toHaveBeenCalled();
    fireEvent.submit(screen.getByRole('textbox').closest('form')!);
    await waitFor(() =>
      expect(mockTrack).toHaveBeenCalledWith({
        name: 'librechat.prompts.resolved',
        feature: 'prompts',
        entryPoint: 'picker',
        prompt: promptReference,
        variables: true,
      }),
    );
    expect(mockTrack.mock.invocationCallOrder[0]).toBeLessThan(
      mockSubmitPrompt.mock.invocationCallOrder[0],
    );
  });
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

it('does not count a variable expansion that only produces whitespace', async () => {
  mockTrack.mockClear();
  mockSubmitPrompt.mockClear();
  render(
    <VariableForm
      group={group}
      promptText="{{expression}}"
      onClose={jest.fn()}
      promptReference={{ source: 'langfuse', groupId: 'group-1' }}
    />,
  );
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } });
  fireEvent.submit(screen.getByRole('textbox').closest('form')!);
  await waitFor(() => expect(mockSubmitPrompt).toHaveBeenCalledWith('   '));
  expect(mockTrack).not.toHaveBeenCalled();
});
