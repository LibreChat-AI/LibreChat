import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { Label, labelVariants } from './Label';

describe('Label', () => {
  it('keeps the default appearance when no variant is selected', () => {
    render(<Label htmlFor="field">Name</Label>);
    const label = screen.getByText('Name');

    /** The theme's label roles, which default to `text-sm`, leading 1 and the surrounding weight. */
    expect(label).toHaveClass(
      'block',
      'w-full',
      'break-all',
      'text-(length:--theme-label-size)',
      'leading-(--theme-label-leading)',
      'font-theme-label',
    );
    expect(label).toHaveClass('text-text-primary', 'peer-disabled:opacity-70');
  });

  it('renders the secondary ink at the default label metrics', () => {
    render(
      <Label htmlFor="field" variant="secondary">
        Hint
      </Label>,
    );

    expect(screen.getByText('Hint')).toHaveClass(
      'text-(length:--theme-label-size)',
      'leading-(--theme-label-leading)',
      'font-theme-label',
      'text-text-secondary',
    );
    expect(screen.getByText('Hint')).not.toHaveClass('text-text-primary');
  });

  it('renders the section eyebrow from the shared variant', () => {
    render(
      <Label htmlFor="field" variant="section">
        Endpoint
      </Label>,
    );
    const label = screen.getByText('Endpoint');

    expect(label).toHaveClass(
      'text-[11px]',
      'font-medium',
      'uppercase',
      'tracking-wide',
      'text-text-secondary',
    );
    /** The variant owns size, leading and color outright: an arbitrary font size
     *  also clears `leading-none`, which is what the label read before. */
    expect(label).not.toHaveClass('text-sm', 'text-text-primary', 'leading-none');
  });

  /**
   * A settings row heads its value with this appearance on a non-label element,
   * so the recipe has to stay free of the label's block layout: `block w-full`
   * would break the row's `justify-between`.
   */
  it('exposes the eyebrow to non-label elements without layout', () => {
    const section = labelVariants({ variant: 'section' });

    expect(section).toContain('text-[11px]');
    expect(section).toContain('text-text-secondary');
    expect(section).not.toContain('block');
    expect(section).not.toContain('w-full');
    /** Unmerged recipe output, so a conflicting base color would survive it. */
    expect(section).not.toContain('text-text-primary');
  });
});
