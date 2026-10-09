import { render, screen } from '@testing-library/react';
import ScrollToBottom from '../ScrollToBottom';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const renderButton = ({
  maximizeChatSpace = false,
  overlayHeight,
  interactive,
}: {
  maximizeChatSpace?: boolean;
  overlayHeight?: number;
  interactive?: boolean;
} = {}) =>
  render(
    <ScrollToBottom
      scrollHandler={jest.fn()}
      maximizeChatSpace={maximizeChatSpace}
      overlayHeight={overlayHeight}
      interactive={interactive}
    />,
  );

describe('ScrollToBottom', () => {
  it('sits in the same padded column as the composer', () => {
    const { container } = renderButton();
    const column = container.querySelector('.sm\\:px-2');

    expect(column).toHaveClass('md:max-w-3xl', 'xl:max-w-4xl');
    expect(column).not.toHaveClass('px-4');
    expect(container.firstChild).toHaveClass('scrollbar-gutter-spacer');
  });

  /* The send button sits one row below at the composer's `mr-2`. Sharing its
     end inset and control geometry is what makes the two read as one rail
     instead of a stagger: the column edge is 8px out, and `size-10` is 4px
     larger than every other control in the band. */
  it('stacks over the send button on the composer rail', () => {
    renderButton();
    const button = screen.getByRole('button');

    expect(button).toHaveClass('me-2', 'size-theme-control', 'rounded-theme-control-round');
    expect(button).not.toHaveClass('size-10');
  });

  /* The gutter has to be reserved with padding rather than by reserving a real
     one: a scroll container clips, and the button's focus ring is painted
     outside its box. */
  it('reserves the gutter without becoming a scroll container', () => {
    const { container } = renderButton();

    expect(container.firstChild).not.toHaveClass('overflow-y-auto');
    expect(container.firstChild).not.toHaveClass('scrollbar-gutter-stable');
  });

  /* The wrapper is inert so it never swallows clicks meant for the thread, and
     the button opts back in. A descendant that opts in stays hit-testable while
     its parent fades, so the opt-in waits for the enter transition to settle. */
  it('does not take clicks until the enter transition has settled', () => {
    renderButton();

    expect(screen.getByRole('button')).toHaveClass('pointer-events-none');
  });

  it('takes clicks once settled', () => {
    renderButton({ interactive: true });

    expect(screen.getByRole('button')).toHaveClass('pointer-events-auto');
  });

  /* Pointer events say nothing about the keyboard: an enabled button keeps its
     place in the tab order and answers Enter however faint it is painted. */
  it('stays out of reach of the keyboard until settled', () => {
    renderButton();

    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('answers the keyboard once settled', () => {
    renderButton({ interactive: true });

    expect(screen.getByRole('button')).toBeEnabled();
  });

  /* The wrapper already fades the control in, so the disabled state must not
     dim it a second time on the way. */
  it('does not dim while it is unreachable', () => {
    renderButton();

    expect(screen.getByRole('button')).toHaveClass('disabled:opacity-100');
    expect(screen.getByRole('button')).not.toHaveClass('disabled:opacity-50');
  });

  it('rests just above the composer when nothing is queued', () => {
    const { container } = renderButton();

    expect(container.firstChild).toHaveStyle({ bottom: 'calc(1.25rem + 0px)' });
  });

  it('lifts clear of the in-flight steer overlay', () => {
    const { container } = renderButton({ overlayHeight: 96 });

    expect(container.firstChild).toHaveStyle({ bottom: 'calc(1.25rem + 96px)' });
  });

  it('names the control for assistive tech', () => {
    renderButton();

    expect(screen.getByRole('button', { name: 'com_ui_scroll_to_bottom' })).toHaveAttribute(
      'type',
      'button',
    );
  });

  it('uses the full conversation width when the preference is on', () => {
    const { container } = renderButton({ maximizeChatSpace: true });
    const column = container.querySelector('.sm\\:px-2');

    expect(column).toHaveClass('max-w-full');
    expect(column).not.toHaveClass('md:max-w-3xl');
  });
});
