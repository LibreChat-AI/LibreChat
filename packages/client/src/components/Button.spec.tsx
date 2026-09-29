import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { Button, buttonVariants } from './Button';
import { cn } from '~/utils';

describe('Button', () => {
  it('exposes theme-owned shape and density recipes', () => {
    render(
      <Button size="theme" shape="theme">
        Continue
      </Button>,
    );

    expect(screen.getByRole('button', { name: 'Continue' })).toHaveClass(
      'h-theme-control',
      'rounded-theme-control',
      'gap-theme-compact',
    );
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
    expect(button).toHaveClass('rounded-xl', 'h-9', 'bg-presentation');
    expect(button).not.toHaveClass('rounded-lg');

    rerender(
      <Button variant="header-action" size="sm" shape="theme">
        Back
      </Button>,
    );

    expect(button).toHaveClass('rounded-theme-control', 'h-9');
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

    expect(button).toHaveClass('size-8', 'p-0', 'rounded-md', 'hover:bg-surface-hover-alt');
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

    expect(button).toHaveClass('size-7', 'rounded-md', 'focus-visible:ring-inset');
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
    expect(header).not.toContain('h-10');
    expect(header).not.toContain('px-4');
    /** A heading is not a control: nothing fills under the pointer. */
    expect(header).not.toContain('hover:bg-');
  });

  it('still takes a size when a caller asks for one', () => {
    expect(cn(buttonVariants({ variant: 'section-header', size: 'sm' }))).toContain('h-9');
  });
});
