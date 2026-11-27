import { render } from '@testing-library/react';
import { OGDialog, OGDialogContent, OGDialogTitle } from '@librechat/client';
import SharePointPickerDialog from '../SharePointPickerDialog';

/**
 * The picker used to render an overlay of its own, beside the one
 * `OGDialogContent` portals anyway, asking for a lighter black backdrop. Both
 * sat at the same depth, so the primitive's — mounted second — painted over it
 * and the requested color never reached the screen. The dialog itself is
 * opaque, so it needs no backdrop of its own: it scrims with the theme's
 * overlay role like every other OGDialog, and exactly once.
 */

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useSharePointPicker: () => ({
    openSharePointPicker: jest.fn(),
    closeSharePointPicker: jest.fn(),
    cleanup: jest.fn(),
  }),
}));

/** The overlay is the only full-bleed layer while no download is in flight. */
const scrims = () => Array.from(document.querySelectorAll<HTMLElement>('div.inset-0'));

/** What any OGDialog scrims with, read from the primitive rather than pinned. */
const REFERENCE_TITLE = 'reference dialog';

function appScrim(): string {
  const { unmount } = render(
    <OGDialog open={true}>
      <OGDialogContent>
        <OGDialogTitle>{REFERENCE_TITLE}</OGDialogTitle>
      </OGDialogContent>
    </OGDialog>,
  );
  const [scrim, ...extra] = scrims();
  expect(extra).toEqual([]);
  const painted = scrim.className;
  unmount();
  return painted;
}

describe('SharePoint picker dialog', () => {
  it('paints the app scrim once, and none of its own', () => {
    const expected = appScrim();
    render(<SharePointPickerDialog isOpen={true} onOpenChange={jest.fn()} />);

    const [scrim, ...extra] = scrims();
    expect(extra).toEqual([]);
    expect(scrim.className).toBe(expected);
  });

  it('paints no backdrop while closed', () => {
    render(<SharePointPickerDialog isOpen={false} onOpenChange={jest.fn()} />);

    expect(scrims()).toEqual([]);
  });
});
