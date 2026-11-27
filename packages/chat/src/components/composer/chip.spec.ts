import { composerChipClasses } from './chip';

describe('composerChipClasses', () => {
  it('replaces the control recipe height, gap, and type on the rail pill', () => {
    const { chipClasses } = composerChipClasses();

    expect(chipClasses).toContain('h-8');
    expect(chipClasses).toContain('gap-1.5');
    expect(chipClasses).toContain('text-xs');
    expect(chipClasses).not.toContain('h-theme-control');
    expect(chipClasses).not.toContain('gap-theme-control-gap');
    expect(chipClasses).not.toContain('text-sm');
    expect(chipClasses).toContain('rounded-theme-control-round');
  });

  it('keeps a read-only chip quiet by replacing the pressable border and fill', () => {
    const { infoChipClasses } = composerChipClasses();

    expect(infoChipClasses).toContain('border-transparent');
    expect(infoChipClasses).toContain('bg-surface-tertiary');
    expect(infoChipClasses).toContain('text-text-secondary');
    expect(infoChipClasses).toContain('hover:bg-surface-tertiary');
    expect(infoChipClasses).not.toContain('border-border-medium');
    expect(infoChipClasses).not.toContain('bg-transparent');
    expect(infoChipClasses).not.toContain('text-text-primary');
    expect(infoChipClasses).not.toContain('hover:bg-surface-hover');
  });

  it('dims a disabled menu row with the shared ink recipe', () => {
    const { chipMenuItemClasses } = composerChipClasses();
    const classes = chipMenuItemClasses(true);

    expect(classes).toContain('aria-disabled:opacity-50');
    expect(classes).toContain('theme-disabled:opacity-100');
    expect(classes).toContain('bg-surface-active-alt');
    expect(chipMenuItemClasses()).not.toContain('bg-surface-active-alt');
  });
});
