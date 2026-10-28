/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ComposerHost } from '../../../react/input';
import { ComposerHostProvider } from '../../../react/input';
import { NO_HOST_BINDINGS } from '../../../core/shortcuts';
import EscalateNowButton from '../EscalateNowButton';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

const host: ComposerHost = {
  useComposerBindings: () => NO_HOST_BINDINGS,
  useShortcutDisplay: () => 'Ctrl+Shift+.',
  useShortcutAriaKey: () => 'Control+Shift+.',
};

function Pane({ index }: { index: number }) {
  return (
    <ComposerHostProvider host={host}>
      <section data-chat-pane={index}>
        <textarea aria-label={`composer ${index}`} />
        <EscalateNowButton
          surface="bubble"
          disabled={false}
          messageText={`waiting ${index}`}
          onClick={jest.fn()}
        />
      </section>
    </ComposerHostProvider>
  );
}

const escalation = (index: number) =>
  screen.getByRole('button', { name: `com_ui_interrupt_steer_now: waiting ${index}` });

describe('EscalateNowButton', () => {
  it('advertises a hovered button as the shortcut target only in the focused pane', () => {
    render(
      <>
        <Pane index={0} />
        <Pane index={1} />
      </>,
    );
    act(() => screen.getByLabelText('composer 0').focus());

    fireEvent.pointerEnter(escalation(1));
    expect(escalation(1)).not.toHaveAttribute('data-escalate-steer-active');
    expect(escalation(1)).not.toHaveAttribute('aria-keyshortcuts');

    act(() => screen.getByLabelText('composer 1').focus());
    expect(escalation(1)).toHaveAttribute('data-escalate-steer-active', 'true');
    expect(escalation(1)).toHaveAttribute('aria-keyshortcuts', 'Control+Shift+.');

    fireEvent.pointerLeave(escalation(1));
    expect(escalation(1)).not.toHaveAttribute('data-escalate-steer-active');
  });

  it('advertises a hovered button while focus sits outside every pane', () => {
    render(<Pane index={0} />);

    fireEvent.pointerEnter(escalation(0));

    expect(escalation(0)).toHaveAttribute('data-escalate-steer-active', 'true');
    fireEvent.pointerLeave(escalation(0));
  });
});
