import * as components from '../index';

/** The canonical `Dialog*` names and the `OG*` names the app imports are one component each, so a
 *  call site can move to the canonical name without any change in behaviour. */
const PARTS = [
  'Dialog',
  'DialogPortal',
  'DialogOverlay',
  'DialogClose',
  'DialogTrigger',
  'DialogContent',
  'DialogHeader',
  'DialogFooter',
  'DialogTitle',
  'DialogDescription',
  'DialogTemplate',
] as const;

describe('dialog export names', () => {
  it.each(PARTS)('exports %s as the same component as its OG name', (name) => {
    const exports = components as Record<string, unknown>;
    expect(exports[name]).toBeDefined();
    expect(exports[name]).toBe(exports[`OG${name}`]);
  });
});
