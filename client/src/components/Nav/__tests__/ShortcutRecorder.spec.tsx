import { fireEvent, render, screen } from '@testing-library/react';
import { RecorderInfo, RecorderPill, useShortcutRecorder } from '../ShortcutRecorder';
import { bindingHash } from '~/utils/shortcuts';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

function Harness({ bindingMap = new Map() }: { bindingMap?: Map<string, string> }) {
  const state = useShortcutRecorder({
    initial: null,
    bindingMap,
    ownerId: 'test-action',
    getActionLabel: (id) => id,
    onSave: jest.fn(),
    onCancel: jest.fn(),
  });

  return (
    <>
      <RecorderPill state={state} ariaLabel="Shortcut recorder" ownerId="test-action" />
      <RecorderInfo
        state={state}
        ownerId="test-action"
        onCancel={jest.fn()}
        onSaveReplacing={jest.fn()}
      />
    </>
  );
}

describe('ShortcutRecorder', () => {
  it('uses semantic destructive roles when a shortcut has no modifier', () => {
    render(<Harness />);

    const recorder = screen.getByRole('textbox', { name: 'Shortcut recorder' });
    fireEvent.keyDown(recorder, { key: 'a' });

    expect(recorder).toHaveClass('border-border-destructive');
    expect(screen.getByText('com_shortcut_recorder_needs_modifier')).toHaveClass(
      'text-text-destructive',
    );
  });

  it('uses the semantic warning border when a shortcut conflicts', () => {
    const binding = { meta: false, ctrl: true, alt: false, shift: false, key: 'A' };
    render(<Harness bindingMap={new Map([[bindingHash(binding), 'other-action']])} />);

    const recorder = screen.getByRole('textbox', { name: 'Shortcut recorder' });
    fireEvent.keyDown(recorder, { key: 'a', ctrlKey: true });

    expect(recorder).toHaveClass('border-status-warning-border');
  });
});
