import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { Button, buttonVariants } from './Button';
import OGDialogTemplate from './OGDialogTemplate';
import { OGDialog } from './OriginalDialog';
import { cn } from '~/utils';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('Button', () => {
  it('owns dense action padding without changing the default-height recipe', () => {
    render(
      <Button variant="outline" size="dense">
        Copy link
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Copy link' });
    expect(button).toHaveClass('h-theme-button', 'px-3', 'py-2');
    expect(button).not.toHaveClass('px-4');
  });

  it('owns compact filter geometry, immediate motion and semantic pressed-state fills', () => {
    const { rerender } = render(
      <Button variant="outline-toggle" size="compact" aria-pressed={false}>
        My agents
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'My agents' });
    expect(button).toHaveClass(
      'h-8',
      'gap-1.5',
      'px-2.5',
      'text-xs',
      'transition-none',
      'aria-pressed:border-border-heavy',
      'aria-pressed:bg-surface-active-alt',
      'aria-pressed:hover:bg-surface-active-alt',
    );
    expect(button).not.toHaveClass('gap-2', 'px-4', 'text-sm', 'h-theme-button');
    expect(button).toHaveAttribute('aria-pressed', 'false');

    rerender(
      <Button variant="outline-toggle" size="compact" aria-pressed>
        My agents
      </Button>,
    );
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('exposes theme-owned shape and density recipes', () => {
    render(
      <Button size="theme" shape="theme">
        Continue
      </Button>,
    );

    expect(screen.getByRole('button', { name: 'Continue' })).toHaveClass(
      'h-theme-control',
      'rounded-theme-control',
      'gap-theme-control-gap',
      'px-theme-control-x',
    );
  });

  it('draws its label, height, fills, focus and states from theme roles', () => {
    render(<Button>Save</Button>);

    expect(screen.getByRole('button', { name: 'Save' })).toHaveClass(
      'font-theme-control',
      'h-theme-button',
      'bg-button-primary',
      'hover:bg-button-primary-hover',
      'hover:active:bg-surface-inverted-pressed',
      'focus-visible:ring-focus-control',
      'disabled:opacity-50',
      'theme-disabled:bg-surface-disabled',
    );
    expect(cn(buttonVariants({ size: 'sm' }))).toContain('h-theme-button-sm');
    expect(cn(buttonVariants({ variant: 'outline' }))).toContain('hover:active:bg-surface-pressed');
  });

  it('lets a caller replace the themed label weight and height', () => {
    const classes = cn(buttonVariants({ size: 'sm' }), 'h-9 font-semibold');

    expect(classes).not.toContain('h-theme-button-sm');
    expect(classes).not.toContain('font-theme-control');
  });

  /** The base `gap-2` and the default size's `px-4` would otherwise survive beside the roles and
   *  leave the winner to stylesheet order, and a caller's own padding must still win. */
  it('lets the control spacing roles replace the base gap and a caller replace them', () => {
    const themed = cn(buttonVariants({ size: 'theme' }));
    expect(themed).not.toMatch(/(^|\s)gap-2(\s|$)/);
    expect(cn(themed, 'px-2')).not.toContain('px-theme-control-x');
    expect(cn(themed, 'gap-1')).not.toContain('gap-theme-control-gap');
  });

  it('offers the composer action row geometry as a size and a shape', () => {
    render(
      <Button size="icon-theme" shape="round" aria-label="Scroll to bottom">
        v
      </Button>,
    );

    expect(screen.getByRole('button', { name: 'Scroll to bottom' })).toHaveClass(
      'size-theme-control',
      'p-0',
      'rounded-theme-control-round',
    );
  });

  it('renders the header-action toggle from semantic tokens', () => {
    render(<Button variant="header-action">Toggle</Button>);

    /** Opaque: the chat header is a gradient that fades to nothing with the
     *  conversation scrolling under it, so a transparent toggle shows message
     *  text through itself while every neighbour sits on `bg-presentation`. */
    expect(screen.getByRole('button', { name: 'Toggle' })).toHaveClass(
      'bg-presentation',
      'border-border-light',
      'rounded-xl',
      'duration-0',
      'hover:bg-surface-active-alt',
    );
  });

  /** `size: 'sm'` carries `rounded-lg`, which is emitted after the variant and
   *  would otherwise win the merge, squaring off a text-bearing header control
   *  next to the icon-sized ones sharing its row. A caller that names a shape
   *  still outranks that repair, the way it does for `subtle`. */
  it('keeps the header-action corner at every size', () => {
    const { rerender } = render(
      <Button variant="header-action" size="sm">
        Back
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Back' });
    expect(button).toHaveClass('rounded-xl', 'h-theme-button-sm', 'bg-presentation');
    expect(button).not.toHaveClass('rounded-lg');

    rerender(
      <Button variant="header-action" size="sm" shape="theme">
        Back
      </Button>,
    );

    expect(button).toHaveClass('rounded-theme-control', 'h-theme-button-sm');
    expect(button).not.toHaveClass('rounded-xl');
  });

  it('preserves variant geometry until a shape is explicitly selected', () => {
    const { rerender } = render(<Button variant="subtle">Subtle</Button>);
    const button = screen.getByRole('button', { name: 'Subtle' });

    expect(button).toHaveClass('rounded-xl');
    expect(button).not.toHaveClass('rounded-lg');

    rerender(
      <Button variant="subtle" shape="theme">
        Subtle
      </Button>,
    );

    expect(button).toHaveClass('rounded-theme-control');
    expect(button).not.toHaveClass('rounded-xl');
  });

  it('preserves subtle geometry through the exported variant helper', () => {
    expect(buttonVariants({ variant: 'subtle' })).toContain('rounded-xl');
    expect(buttonVariants({ variant: 'subtle', shape: null })).toContain('rounded-xl');

    const themedSubtle = buttonVariants({ variant: 'subtle', shape: 'theme' });
    expect(themedSubtle).toContain('rounded-theme-control');
    expect(themedSubtle).not.toContain('rounded-xl');
  });

  it('provides compact row actions with a distinct hover surface', () => {
    render(
      <Button variant="row-action" size="icon-sm">
        Open
      </Button>,
    );

    const button = screen.getByRole('button', { name: 'Open' });

    expect(button).toHaveClass(
      'size-theme-icon-button-sm',
      'p-0',
      'rounded-md',
      'hover:bg-surface-hover-alt',
    );
    expect(button).not.toHaveClass('rounded-lg');
  });

  /**
   * Section actions sit close enough to their heading and to each other that
   * the default offset ring crosses a neighbour, so this variant has to win
   * both radius and ring.
   */
  it('gives section actions an inset ring and a tighter radius', () => {
    render(
      <Button variant="section-action" size="icon-xs" aria-label="Filter">
        <span />
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Filter' });

    expect(button).toHaveClass('size-theme-button-xs', 'rounded-md', 'focus-visible:ring-inset');
    expect(button).not.toHaveClass('rounded-lg', 'focus-visible:ring-offset-2');
  });

  /**
   * `buttonVariants` returns raw recipe output, so conflicting utilities from
   * the base survive it. Call sites applying the recipe to a non-Button element
   * have to merge it themselves, and this is what breaks if they forget.
   */
  it('leaves overridden base utilities in the unmerged variant helper', () => {
    const sectionAction = buttonVariants({ variant: 'section-action', size: 'icon-xs' });

    expect(sectionAction).toContain('rounded-md');
    expect(sectionAction).toContain('rounded-lg');
    expect(cn(sectionAction)).not.toContain('rounded-lg');
  });

  /**
   * Every other variant is given a size by its call sites, but a section
   * heading is sized by its own text and all three headers ask for the recipe
   * alone. The default size recipe is emitted after the variant, so without an
   * opt out it wins the merge and puts a 40px control in a 32px header row.
   */
  it('keeps section headers out of the default size recipe', () => {
    const header = cn(buttonVariants({ variant: 'section-header' }));

    expect(header).toContain('px-1');
    expect(header).toContain('h-auto');
    expect(header).not.toContain('h-theme-button');
    expect(header).not.toContain('px-4');
    /** A heading is not a control: nothing fills under the pointer. */
    /** Only the disabled recipe's `theme-disabled:hover:` pin may name a hover fill. */
    expect(header).not.toMatch(/(^|\s)hover:bg-/);
  });

  it('still takes a size when a caller asks for one', () => {
    expect(cn(buttonVariants({ variant: 'section-header', size: 'sm' }))).toContain(
      'h-theme-button-sm',
    );
  });

  /** A templated dialog's legacy `selection` action sits beside the shared cancel Button, so it
   *  has to take the same height and primary fill roles or the two part under a theme. */
  it('draws a templated dialog’s legacy confirm action from the Button roles', () => {
    render(
      <OGDialog open={true}>
        <OGDialogTemplate
          title="Delete"
          selection={{ selectHandler: jest.fn(), selectText: 'Delete' }}
        />
      </OGDialog>,
    );

    const cancel = screen.getByRole('button', { name: 'com_ui_cancel' });
    const confirm = screen.getByRole('button', { name: 'Delete' });
    expect(cancel).toHaveClass('h-theme-button');
    expect(confirm).toHaveClass(
      'h-theme-button',
      'bg-button-primary',
      'hover:bg-button-primary-hover',
    );
    expect(confirm).not.toHaveClass('h-10');
  });

  /** The spinner stood in text-primary on the primary fill, dark on dark; it now paints in the
   *  action's own foreground, whatever fill the caller gives it. */
  it('draws a templated dialog’s legacy loading spinner in the action’s own ink', () => {
    render(
      <OGDialog open={true}>
        <OGDialogTemplate
          title="Delete"
          selection={{ selectHandler: jest.fn(), selectText: 'Delete', isLoading: true }}
        />
      </OGDialog>,
    );

    const spinner = document.querySelector('svg.spinner');
    expect(spinner).not.toBeNull();
    expect(spinner?.getAttribute('class')).not.toMatch(/\btext-/);
    expect(spinner?.closest('button')).toHaveClass('text-text-inverted');
    spinner
      ?.querySelectorAll('circle')
      .forEach((circle) => expect(circle).toHaveAttribute('stroke', 'currentColor'));
  });
});
