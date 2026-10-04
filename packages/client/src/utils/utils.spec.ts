import { cn } from './utils';

describe('cn', () => {
  /** A caller's own size replaces the role a primitive draws, so the two never both survive and
   *  leave the winner to stylesheet order. */
  it.each([
    ['h-theme-control', 'h-9'],
    ['h-theme-button-xs', 'h-8'],
    ['size-theme-button', 'size-9'],
    ['h-theme-control', 'size-theme-control'],
    ['min-w-theme-target', 'min-w-0'],
    ['min-h-theme-target', 'min-h-0'],
    ['min-w-theme-list', 'min-w-48'],
    ['max-h-theme-list', 'max-h-60'],
  ])('lets a caller size replace %s', (role, caller) => {
    expect(cn(role, caller)).toBe(caller);
  });
});
