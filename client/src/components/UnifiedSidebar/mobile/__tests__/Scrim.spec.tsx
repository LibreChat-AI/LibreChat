import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import Scrim from '../Scrim';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

function setup({
  expanded,
  isSliding = false,
  prefersReducedMotion = false,
}: {
  expanded: boolean;
  isSliding?: boolean;
  prefersReducedMotion?: boolean;
}) {
  const onClick = jest.fn();
  render(
    <Scrim
      expanded={expanded}
      isSliding={isSliding}
      prefersReducedMotion={prefersReducedMotion}
      onClick={onClick}
    />,
  );
  return { scrim: screen.getByRole('button', { hidden: true }), onClick };
}

describe('mobile drawer Scrim', () => {
  it('is a reachable dismiss target while the drawer is open', () => {
    const { scrim } = setup({ expanded: true });

    expect(scrim).toHaveAttribute('tabindex', '0');
    expect(scrim).not.toHaveAttribute('aria-hidden');
    expect(scrim.style.opacity).toBe('1');
    expect(scrim).not.toHaveClass('pointer-events-none');
  });

  it('leaves the tab order and the accessibility tree once closed', () => {
    const { scrim } = setup({ expanded: false });

    expect(scrim).toHaveAttribute('tabindex', '-1');
    expect(scrim).toHaveAttribute('aria-hidden', 'true');
    expect(scrim.style.opacity).toBe('0');
    expect(scrim).toHaveClass('pointer-events-none');
  });

  /**
   * The parent shell is overflow-hidden and the global :focus-visible outline
   * sits 2px outside the box, so an inset ring is the only indicator that
   * actually paints.
   */
  it('keeps the focus ring inside the overflow-hidden shell', () => {
    const { scrim } = setup({ expanded: true });

    expect(scrim).toHaveClass(
      'focus-visible:outline-hidden',
      'focus-visible:ring-2',
      'focus-visible:ring-inset',
      'focus-visible:ring-focus-control',
    );
  });

  /**
   * The state commits before the drawer and pane finish moving, so releasing
   * the pointer target early lets a tap through to a control sliding by
   * underneath.
   */
  it('stays the pointer target while the close is still animating', () => {
    const { scrim } = setup({ expanded: false, isSliding: true });

    expect(scrim).not.toHaveClass('pointer-events-none');
  });

  it('drops the fade under reduced motion, where both surfaces snap', () => {
    const { scrim } = setup({ expanded: true, prefersReducedMotion: true });

    expect(scrim.style.transition).toBe('');
  });

  it('reports taps to its owner', async () => {
    const user = userEvent.setup();
    const { scrim, onClick } = setup({ expanded: true });

    await user.click(scrim);

    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
