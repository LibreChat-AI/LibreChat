import '@testing-library/jest-dom';
import userEvent from '@testing-library/user-event';
import * as RadixToast from '@radix-ui/react-toast';
import { fireEvent, render, screen } from '@testing-library/react';
import { OGDialog, OGDialogContent, OGDialogTitle, DialogLayer } from '../OriginalDialog';

/**
 * Radix hands Escape to the highest dismissable layer only, and a toast
 * registers one above whatever dialog is already open. Sharing a single copy of
 * `react-dismissable-layer` puts both in the same stack, so a status toast on
 * screen swallowed the Escape that should have closed the dialog beneath it.
 */
function Harness({
  onOpenChange,
  toast,
}: {
  onOpenChange: (open: boolean) => void;
  toast: boolean;
}) {
  return (
    <RadixToast.Provider>
      <OGDialog open onOpenChange={onOpenChange}>
        <OGDialogContent>
          <button type="button">inside the dialog</button>
        </OGDialogContent>
      </OGDialog>
      {toast && (
        <RadixToast.Root open duration={Infinity} className="toast-root">
          <RadixToast.Description>Skill created</RadixToast.Description>
        </RadixToast.Root>
      )}
      <RadixToast.Viewport />
    </RadixToast.Provider>
  );
}

describe('dialog Escape', () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('honours combobox expansion (expanded=%s, toast=%s)', async (expanded, toast) => {
    const onOpenChange = jest.fn();
    render(
      <RadixToast.Provider>
        <OGDialog open onOpenChange={onOpenChange}>
          <OGDialogContent>
            <input
              role="combobox"
              aria-label="People"
              aria-expanded={expanded}
              aria-controls="people-results"
            />
            <div id="people-results" role="listbox" hidden={!expanded} />
          </OGDialogContent>
        </OGDialog>
        {toast && (
          <RadixToast.Root open duration={Infinity}>
            <RadixToast.Description>Saved</RadixToast.Description>
          </RadixToast.Root>
        )}
        <RadixToast.Viewport />
      </RadixToast.Provider>,
    );
    screen.getByRole('combobox', { name: 'People' }).focus();
    await userEvent.keyboard('{Escape}');
    if (expanded) expect(onOpenChange).not.toHaveBeenCalled();
    else expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  /** The fallback must not overrule the guards the dialog already honours: a
   *  popup inside it owns the first Escape (WCAG 2.1.1), and a layer that has
   *  already answered the event owns it outright. */
  it('leaves the dialog open when Escape belongs to a popup inside it', async () => {
    const onOpenChange = jest.fn();
    render(
      <RadixToast.Provider>
        <OGDialog open onOpenChange={onOpenChange}>
          <OGDialogContent>
            <div role="listbox" tabIndex={-1}>
              <button type="button">an option</button>
            </div>
          </OGDialogContent>
        </OGDialog>
        <RadixToast.Root open duration={Infinity} className="toast-root">
          <RadixToast.Description>Skill created</RadixToast.Description>
        </RadixToast.Root>
        <RadixToast.Viewport />
      </RadixToast.Provider>,
    );

    screen.getByText('an option').focus();
    await userEvent.keyboard('{Escape}');

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('leaves the dialog open when another layer already answered the Escape', async () => {
    const onOpenChange = jest.fn();
    render(<Harness onOpenChange={onOpenChange} toast />);
    const answerFirst = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener('keydown', answerFirst, { capture: true });

    try {
      screen.getByText('inside the dialog').focus();
      await userEvent.keyboard('{Escape}');
    } finally {
      document.removeEventListener('keydown', answerFirst, { capture: true });
    }

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("respects a consumer's onEscapeKeyDown that cancels the close", async () => {
    const onOpenChange = jest.fn();
    render(
      <RadixToast.Provider>
        <OGDialog open onOpenChange={onOpenChange}>
          <OGDialogContent onEscapeKeyDown={(event) => event.preventDefault()}>
            <button type="button">inside the dialog</button>
          </OGDialogContent>
        </OGDialog>
        <RadixToast.Root open duration={Infinity} className="toast-root">
          <RadixToast.Description>Saved</RadixToast.Description>
        </RadixToast.Root>
        <RadixToast.Viewport />
      </RadixToast.Provider>,
    );

    screen.getByText('inside the dialog').focus();
    await userEvent.keyboard('{Escape}');

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  /** `OGDialogContent` is also used as an alert dialog — the shared-link delete
   *  confirmation — which the frontmost ranking has to see, or its Escape is
   *  dropped instead of closing it. */
  it('closes an alert dialog while a toast is on screen', async () => {
    const onOpenChange = jest.fn();
    render(
      <RadixToast.Provider>
        <OGDialog open onOpenChange={onOpenChange}>
          <OGDialogContent role="alertdialog" showCloseButton={false}>
            <button type="button">delete it</button>
          </OGDialogContent>
        </OGDialog>
        <RadixToast.Root open duration={Infinity} className="toast-root">
          <RadixToast.Description>Link copied</RadixToast.Description>
        </RadixToast.Root>
        <RadixToast.Viewport />
      </RadixToast.Provider>,
    );

    screen.getByText('delete it').focus();
    await userEvent.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  /** Every mounted dialog runs the fallback listener, so one underneath must not
   *  fire its consumer's Escape handler for a keystroke that belongs to the
   *  dialog above it. */
  it("does not run a lower dialog's Escape handler for the frontmost dialog", async () => {
    const lowerEscape = jest.fn();
    const upperOpenChange = jest.fn();
    render(
      <RadixToast.Provider>
        <OGDialog open>
          <OGDialogContent onEscapeKeyDown={lowerEscape}>
            <button type="button">lower</button>
          </OGDialogContent>
        </OGDialog>
        <OGDialog open onOpenChange={upperOpenChange}>
          <OGDialogContent style={{ zIndex: 300 }}>
            <button type="button">upper</button>
          </OGDialogContent>
        </OGDialog>
        <RadixToast.Root open duration={Infinity} className="toast-root">
          <RadixToast.Description>Saved</RadixToast.Description>
        </RadixToast.Root>
        <RadixToast.Viewport />
      </RadixToast.Provider>,
    );

    screen.getByText('upper').focus();
    await userEvent.keyboard('{Escape}');

    expect(lowerEscape).not.toHaveBeenCalled();
    expect(upperOpenChange).toHaveBeenCalledWith(false);
  });

  /** A dialog that carries its z-index in a class — `ImagePreview` is
   *  `z-[250]` — still outranks this one, so Escape there must not close the
   *  dialog underneath it. */
  it.each([false, true])(
    'does not close a dialog under an unregistered preview (toast: %s)',
    async (toast) => {
      const onOpenChange = jest.fn();
      render(
        <RadixToast.Provider>
          <style>{'.on-top { z-index: 250; }'}</style>
          <OGDialog open onOpenChange={onOpenChange}>
            <OGDialogContent>
              <button type="button">under</button>
            </OGDialogContent>
          </OGDialog>
          <div role="dialog" data-state="open" className="on-top">
            <button type="button">preview</button>
          </div>
          {toast && (
            <RadixToast.Root open duration={Infinity} className="toast-root">
              <RadixToast.Description>Saved</RadixToast.Description>
            </RadixToast.Root>
          )}
          <RadixToast.Viewport />
        </RadixToast.Provider>,
      );

      screen.getByText('preview').focus();
      await userEvent.keyboard('{Escape}');

      expect(onOpenChange).not.toHaveBeenCalled();
    },
  );

  it('closes the dialog while a toast is on screen', async () => {
    const onOpenChange = jest.fn();
    render(<Harness onOpenChange={onOpenChange} toast />);

    screen.getByText('inside the dialog').focus();
    await userEvent.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('still closes the dialog with no toast up', async () => {
    const onOpenChange = jest.fn();
    render(<Harness onOpenChange={onOpenChange} toast={false} />);

    screen.getByText('inside the dialog').focus();
    await userEvent.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

it('consumes a fallback Escape before another listener can dismiss the dialog underneath', () => {
  const onOpenChange = jest.fn();
  render(<Harness onOpenChange={onOpenChange} toast />);
  const inside = screen.getByText('inside the dialog');
  inside.focus();
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  fireEvent(inside, escape);
  expect(onOpenChange).toHaveBeenCalledTimes(1);
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(escape.defaultPrevented).toBe(true);
});

it.each([false, true])(
  'routes Escape to the visible top dialog (consumer prevents close: %s)',
  async (preventClose) => {
    const outerClose = jest.fn();
    const innerClose = jest.fn();
    const lowerEscape = jest.fn();
    const upperEscape = jest.fn((event: KeyboardEvent) => {
      if (preventClose) event.preventDefault();
    });
    render(
      <>
        <DialogLayer>
          <OGDialog open onOpenChange={innerClose}>
            <OGDialogContent onEscapeKeyDown={upperEscape}>
              <OGDialogTitle>Document preview</OGDialogTitle>
              <button type="button">nested preview</button>
            </OGDialogContent>
          </OGDialog>
        </DialogLayer>
        <OGDialog open onOpenChange={outerClose}>
          <OGDialogContent onEscapeKeyDown={lowerEscape}>
            <OGDialogTitle>Your files</OGDialogTitle>
            <button type="button">files</button>
          </OGDialogContent>
        </OGDialog>
      </>,
    );
    screen.getByText('nested preview').focus();
    await userEvent.keyboard('{Escape}');
    expect(upperEscape).toHaveBeenCalledTimes(1);
    expect(lowerEscape).not.toHaveBeenCalled();
    if (preventClose) expect(innerClose).not.toHaveBeenCalled();
    else expect(innerClose).toHaveBeenCalledWith(false);
    expect(outerClose).not.toHaveBeenCalled();
  },
);
