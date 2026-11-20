import { buttonVariants } from '@librechat/client';
import cn from '../cn';

/**
 * The button's default size utilities are theme tokens tailwind-merge cannot classify unless they
 * are registered. Unregistered, a variant's own padding and the default both survive and the
 * stylesheet order picks the default, which pushed the sidebar's section headings 12px right.
 */
describe('cn', () => {
  it("lets the section-header variant's padding and height replace the default size", () => {
    const header = cn(buttonVariants({ variant: 'section-header' }));
    expect(header.split(' ')).toEqual(expect.arrayContaining(['px-1', 'h-auto']));
    expect(header).not.toContain('px-theme-button-x');
    expect(header).not.toContain('h-theme-button');
  });

  it("lets a caller's padding and height replace the default size", () => {
    const button = cn(buttonVariants({ variant: 'ghost' }), 'h-10 px-2');
    expect(button.split(' ')).toEqual(expect.arrayContaining(['h-10', 'px-2']));
    expect(button).not.toContain('px-theme-button-x');
    expect(button).not.toContain('h-theme-button');
  });
});
