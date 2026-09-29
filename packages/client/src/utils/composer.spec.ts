import { composerControlClasses, composerSubmitClasses, composerSurfaceClasses } from './composer';

describe('composerSurfaceClasses', () => {
  it('draws the composer surface from semantic roles', () => {
    const classes = composerSurfaceClasses();

    expect(classes).toContain('border-border-light');
    expect(classes).toContain('bg-surface-chat');
    expect(classes).toContain('text-text-primary');
  });
});

describe('composerSubmitClasses', () => {
  it('owns the send/stop geometry from the shared tokens', () => {
    const classes = composerSubmitClasses();

    expect(classes).toContain('size-theme-control');
    expect(classes).toContain('rounded-theme-control-round');
    expect(classes).toContain('p-theme-compact');
  });

  it('floors the tap target wherever touch is reachable, and centers the icon', () => {
    const classes = composerSubmitClasses();

    expect(classes).toContain('touch:size-theme-control-touch');
    expect(classes).toContain('items-center');
    expect(classes).toContain('justify-center');
  });

  it('draws its fill and disabled state from semantic roles', () => {
    const classes = composerSubmitClasses();

    expect(classes).toContain('bg-text-primary');
    expect(classes).toContain('disabled:text-text-secondary');
    expect(classes).not.toMatch(/#[0-9a-f]{3,6}|rgb\(|hsl\(/i);
  });
});

describe('composerControlClasses', () => {
  it('owns the geometry every labeled composer control shares', () => {
    const classes = composerControlClasses();

    expect(classes).toContain('h-theme-control');
    expect(classes).toContain('rounded-theme-control-round');
    expect(classes).toContain('gap-theme-compact');
  });

  it('draws its border and fills from semantic roles', () => {
    const classes = composerControlClasses();

    expect(classes).toContain('border-border-medium');
    expect(classes).toContain('text-text-primary');
    expect(classes).toContain('hover:bg-surface-hover');
    expect(classes).not.toMatch(/#[0-9a-f]{3,6}|rgb\(|hsl\(/i);
  });
});
