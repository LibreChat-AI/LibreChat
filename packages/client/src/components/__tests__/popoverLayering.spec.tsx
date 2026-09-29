import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { HoverCard, HoverCardContent, HoverCardPortal, HoverCardTrigger } from '../HoverCard';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../Select';
import { OGDialog, OGDialogContent } from '../OriginalDialog';

/**
 * A portaled popover lands beside the dialog in the DOM, not inside it, so its
 * own z-index decides whether it is reachable. `OGDialogContent` sits at 140
 * over an opaque overlay at 130: a popover left on the shadcn default (40, 50)
 * opens *behind* both, invisible and unclickable, while the dialog around it
 * still takes clicks — the shape of the Run Code settings being unusable once
 * danny-avila/LibreChat#15722 moved them into a dialog.
 *
 * The modal dialog also parks `pointer-events: none` on the body, and Radix
 * re-enables it only for layers registered in the same copy of
 * `react-dismissable-layer` — which a popover from another copy is not.
 */
const DIALOG_CONTENT_Z_INDEX = 140;

function zIndexOf(element: HTMLElement): number {
  return Number(element.style.zIndex);
}

function EnvironmentSelect() {
  return (
    <Select open value="attached">
      <SelectTrigger aria-label="Execution environment">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="attached">Attached VM</SelectItem>
      </SelectContent>
    </Select>
  );
}

function HelpHoverCard() {
  return (
    <HoverCard open>
      <HoverCardTrigger>help</HoverCardTrigger>
      <HoverCardPortal>
        <HoverCardContent>What stateful sessions do</HoverCardContent>
      </HoverCardPortal>
    </HoverCard>
  );
}

describe('portaled popovers inside a dialog', () => {
  it('opens a select above the dialog content it belongs to', () => {
    render(
      <OGDialog open>
        <OGDialogContent>
          <EnvironmentSelect />
        </OGDialogContent>
      </OGDialog>,
    );

    const listbox = screen.getByRole('listbox');
    expect(zIndexOf(listbox)).toBeGreaterThan(DIALOG_CONTENT_Z_INDEX);
    expect(listbox.style.pointerEvents).toBe('auto');
  });

  it('opens a hover card above the dialog content it belongs to', () => {
    render(
      <OGDialog open>
        <OGDialogContent>
          <HelpHoverCard />
        </OGDialogContent>
      </OGDialog>,
    );

    const card = screen.getByText('What stateful sessions do');
    expect(zIndexOf(card)).toBeGreaterThan(DIALOG_CONTENT_Z_INDEX);
    expect(card.style.pointerEvents).toBe('auto');
  });

  /** Outside a dialog the CSS layer still decides, so a consumer that raises it
   *  by class — `z-[999]` to clear the legacy `Dialog` — keeps that override.
   *
   *  Only the absence of OUR inline z-index is asserted. `pointer-events` is
   *  Radix's to set out here: a select disables outside pointer events for its
   *  own layer stack, and whether a sibling popover then reads `auto` depends
   *  on whether the two share a copy of `react-dismissable-layer` — which is a
   *  packaging fact, not this hook's contract. */
  it('leaves the CSS layer alone outside any dialog', () => {
    render(
      <>
        <EnvironmentSelect />
        <HelpHoverCard />
      </>,
    );

    const listbox = screen.getByRole('listbox');
    const card = screen.getByText('What stateful sessions do');
    expect(listbox.style.zIndex).toBe('');
    expect(listbox).toHaveClass('z-40');
    expect(card.style.zIndex).toBe('');
    expect(card).toHaveClass('z-50');
  });
});
