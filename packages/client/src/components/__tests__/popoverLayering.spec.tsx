import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { HoverCard, HoverCardContent, HoverCardPortal, HoverCardTrigger } from '../HoverCard';
import { DialogLayer, OGDialog, OGDialogContent } from '../OriginalDialog';
import Dropdown from '../Dropdown';

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
    <Dropdown
      value="attached"
      onChange={() => undefined}
      ariaLabel="Execution environment"
      options={[{ value: 'attached', label: 'Attached VM' }]}
    />
  );
}

/** The Ariakit select opens from its trigger rather than a controlled `open` prop. */
async function openSelect() {
  await act(async () => {
    fireEvent.click(screen.getByRole('combobox', { name: 'Execution environment' }));
  });
  return screen.findByRole('listbox');
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
  it('opens a select above the dialog content it belongs to', async () => {
    render(
      <OGDialog open>
        <OGDialogContent>
          <EnvironmentSelect />
        </OGDialogContent>
      </OGDialog>,
    );

    const listbox = await openSelect();
    expect(zIndexOf(listbox)).toBeGreaterThan(DIALOG_CONTENT_Z_INDEX);
    expect(listbox).toHaveClass('[pointer-events:auto]');
  });

  /** The Settings dialog is a Headless UI panel at z-50, not an OGDialog, so it declares its own
   *  dialog level (berry-13/LibreChat#249). */
  it('opens a select above a non-OGDialog panel that declares a dialog layer', async () => {
    render(
      <DialogLayer>
        <EnvironmentSelect />
      </DialogLayer>,
    );

    const listbox = await openSelect();
    expect(zIndexOf(listbox)).toBeGreaterThan(50);
    expect(listbox).toHaveClass('[pointer-events:auto]');
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
   *  by class keeps that override.
   *
   *  Only the absence of OUR inline z-index is asserted; the list keeps its
   *  `z-40` class, which a consumer can still raise. */
  it('leaves the CSS layer alone outside any dialog', async () => {
    render(
      <>
        <EnvironmentSelect />
        <HelpHoverCard />
      </>,
    );

    const listbox = await openSelect();
    const card = screen.getByText('What stateful sessions do');
    expect(listbox.style.zIndex).toBe('');
    expect(listbox).toHaveClass('z-40');
    expect(card.style.zIndex).toBe('');
    expect(card).toHaveClass('z-50');
  });
});
