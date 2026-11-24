import '@testing-library/jest-dom';
import * as React from 'react';
import userEvent from '@testing-library/user-event';
import * as RadixToast from '@radix-ui/react-toast';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { OGDialog, OGDialogTitle, OGDialogContent, OGDialogTrigger } from '../OriginalDialog';

/**
 * A dialog takes Escape back from a toast through a `keydown` listener on the document. Every
 * mounted dialog used to add its own, closed or open, so a page with a dialog in each message
 * row ran one per row on every key press. They now share one, and what it does for the dialog
 * in front is unchanged.
 */

type Options = boolean | AddEventListenerOptions | undefined;

let added: jest.SpyInstance;
let removed: jest.SpyInstance;

/**
 * How many bubble-phase `keydown` listeners the document holds, from the calls that added and
 * removed them. Radix listens for Escape in the capture phase, which is left out.
 */
function held(): number {
  const calls = [
    ...added.mock.calls.map((call, index) => ({
      call,
      add: true,
      order: added.mock.invocationCallOrder[index],
    })),
    ...removed.mock.calls.map((call, index) => ({
      call,
      add: false,
      order: removed.mock.invocationCallOrder[index],
    })),
  ].sort((first, second) => first.order - second.order);
  const listeners = new Set<unknown>();
  for (const { call, add } of calls) {
    const [type, listener, options] = call as [string, unknown, Options];
    const capture = typeof options === 'boolean' ? options : options?.capture === true;
    if (type !== 'keydown' || capture) continue;
    if (add) listeners.add(listener);
    else listeners.delete(listener);
  }
  return listeners.size;
}

beforeEach(() => {
  added = jest.spyOn(document, 'addEventListener');
  removed = jest.spyOn(document, 'removeEventListener');
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

function Closed({ label }: { label: string }) {
  return (
    <OGDialog open={false}>
      <OGDialogContent>
        <button type="button">{label}</button>
      </OGDialogContent>
    </OGDialog>
  );
}

/**
 * A status toast on screen. Its layer is above the dialogs that were open when it arrived, which
 * is when it takes their Escape, so a test that opens a dialog later brings the toast in last.
 */
function Stage({ toast = true, children }: { toast?: boolean; children: React.ReactNode }) {
  return (
    <RadixToast.Provider>
      {children}
      {toast && (
        <RadixToast.Root open duration={Infinity}>
          <RadixToast.Description>Saved</RadixToast.Description>
        </RadixToast.Root>
      )}
      <RadixToast.Viewport />
    </RadixToast.Provider>
  );
}

describe('the document listener', () => {
  it('is one for the page, however many dialogs are mounted closed', () => {
    const view = render(<Closed label="first" />);
    expect(held()).toBe(1);

    view.rerender(
      <>
        <Closed label="first" />
        {Array.from({ length: 9 }, (_, index) => (
          <Closed key={index} label={`row ${index}`} />
        ))}
      </>,
    );
    expect(held()).toBe(1);
  });

  it('is not added to when a dialog opens', () => {
    const view = render(
      <OGDialog open={false}>
        <OGDialogContent>
          <button type="button">inside</button>
        </OGDialogContent>
      </OGDialog>,
    );
    view.rerender(
      <OGDialog open>
        <OGDialogContent>
          <button type="button">inside</button>
        </OGDialogContent>
      </OGDialog>,
    );
    expect(screen.getByText('inside')).toBeInTheDocument();
    expect(held()).toBe(1);
  });

  it('goes with the last dialog and returns with the next', () => {
    const view = render(
      <>
        <Closed label="first" />
        <Closed label="second" />
      </>,
    );
    view.rerender(<Closed label="first" />);
    expect(held()).toBe(1);

    view.rerender(<span />);
    expect(held()).toBe(0);

    view.rerender(<Closed label="third" />);
    expect(held()).toBe(1);
  });

  it('is one under StrictMode, and gone once the dialogs are', () => {
    const view = render(
      <React.StrictMode>
        <Closed label="first" />
        <Closed label="second" />
      </React.StrictMode>,
    );
    expect(held()).toBe(1);

    view.unmount();
    expect(held()).toBe(0);
  });
});

describe('Escape with a toast on screen', () => {
  it('closes a dialog that opened after it mounted', async () => {
    const onOpenChange = jest.fn();
    const dialog = (open: boolean, toast: boolean) => (
      <Stage toast={toast}>
        <OGDialog open={open} onOpenChange={onOpenChange}>
          <OGDialogContent>
            <button type="button">inside</button>
          </OGDialogContent>
        </OGDialog>
      </Stage>
    );
    const view = render(dialog(false, false));
    view.rerender(dialog(true, false));
    view.rerender(dialog(true, true));

    screen.getByText('inside').focus();
    await userEvent.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('closes a dialog under StrictMode once', async () => {
    const onOpenChange = jest.fn();
    render(
      <React.StrictMode>
        <Stage>
          <OGDialog open onOpenChange={onOpenChange}>
            <OGDialogContent>
              <button type="button">inside</button>
            </OGDialogContent>
          </OGDialog>
        </Stage>
      </React.StrictMode>,
    );

    screen.getByText('inside').focus();
    await userEvent.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  /**
   * Radix answers a dialog's Escape before any listener the page has on the document, and the
   * mobile drawer leaves an answered Escape alone. With a toast up the answer comes from this
   * listener, so it has to come first as well.
   */
  it('is answered before a listener the page added once the dialog had mounted', async () => {
    const onOpenChange = jest.fn();
    const dialog = (open: boolean, toast: boolean) => (
      <Stage toast={toast}>
        <OGDialog open={open} onOpenChange={onOpenChange}>
          <OGDialogContent>
            <button type="button">inside</button>
          </OGDialogContent>
        </OGDialog>
      </Stage>
    );
    const view = render(dialog(false, false));
    const answered: boolean[] = [];
    const later = (event: KeyboardEvent) => {
      if (event.key === 'Escape') answered.push(event.defaultPrevented);
    };
    document.addEventListener('keydown', later);

    try {
      view.rerender(dialog(true, false));
      view.rerender(dialog(true, true));
      screen.getByText('inside').focus();
      await userEvent.keyboard('{Escape}');
    } finally {
      document.removeEventListener('keydown', later);
    }

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(answered).toEqual([true]);
  });

  /**
   * A dialog that mounts as it opens used to answer after the listeners the page already had.
   * The listener is the page's now, there since the first dialog mounted.
   */
  it('is answered before a listener the page added before the dialog mounted', async () => {
    const onOpenChange = jest.fn();
    const page = (dialog: boolean, toast: boolean) => (
      <Stage toast={toast}>
        <Closed label="mounted with the page" />
        {dialog && (
          <OGDialog open onOpenChange={onOpenChange}>
            <OGDialogContent>
              <button type="button">inside</button>
            </OGDialogContent>
          </OGDialog>
        )}
      </Stage>
    );
    const view = render(page(false, false));
    const answered: boolean[] = [];
    const later = (event: KeyboardEvent) => {
      if (event.key === 'Escape') answered.push(event.defaultPrevented);
    };
    document.addEventListener('keydown', later);

    try {
      view.rerender(page(true, false));
      view.rerender(page(true, true));
      screen.getByText('inside').focus();
      await userEvent.keyboard('{Escape}');
    } finally {
      document.removeEventListener('keydown', later);
    }

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(answered).toEqual([true]);
  });

  it("does not run the dialog's own handler for an Escape another layer answered", async () => {
    const onOpenChange = jest.fn();
    const onEscapeKeyDown = jest.fn();
    render(
      <Stage>
        <OGDialog open onOpenChange={onOpenChange}>
          <OGDialogContent onEscapeKeyDown={onEscapeKeyDown}>
            <button type="button">inside</button>
          </OGDialogContent>
        </OGDialog>
      </Stage>,
    );
    const answer = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener('keydown', answer, { capture: true });

    try {
      screen.getByText('inside').focus();
      await userEvent.keyboard('{Escape}');
    } finally {
      document.removeEventListener('keydown', answer, { capture: true });
    }

    expect(onEscapeKeyDown).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('still closes a dialog after another one unmounts', async () => {
    const onOpenChange = jest.fn();
    const page = (other: boolean) => (
      <Stage>
        {other && <Closed label="other" />}
        <OGDialog open onOpenChange={onOpenChange}>
          <OGDialogContent>
            <button type="button">inside</button>
          </OGDialogContent>
        </OGDialog>
      </Stage>
    );
    const view = render(page(true));
    view.rerender(page(false));

    screen.getByText('inside').focus();
    await userEvent.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('goes to the dialog underneath once the one in front unmounts while open', async () => {
    const lowerChange = jest.fn();
    const upperChange = jest.fn();
    const upperEscape = jest.fn();
    const page = (upper: boolean) => (
      <Stage>
        <OGDialog open onOpenChange={lowerChange}>
          <OGDialogContent>
            <button type="button">lower</button>
          </OGDialogContent>
        </OGDialog>
        {upper && (
          <OGDialog open onOpenChange={upperChange}>
            <OGDialogContent style={{ zIndex: 300 }} onEscapeKeyDown={upperEscape}>
              <button type="button">upper</button>
            </OGDialogContent>
          </OGDialog>
        )}
      </Stage>
    );
    const view = render(page(true));
    view.rerender(page(false));

    screen.getByText('lower').focus();
    await userEvent.keyboard('{Escape}');

    expect(lowerChange).toHaveBeenCalledWith(false);
    expect(upperEscape).not.toHaveBeenCalled();
    expect(upperChange).not.toHaveBeenCalled();
  });

  it('closes a dialog opened from another, then the one that opened it', async () => {
    function Nested({ toast }: { toast: boolean }) {
      const [open, setOpen] = React.useState(true);
      return (
        <Stage toast={toast}>
          <OGDialog open={open} onOpenChange={setOpen}>
            <OGDialogContent>
              <OGDialogTitle>Files</OGDialogTitle>
              <OGDialog>
                <OGDialogTrigger>rename</OGDialogTrigger>
                <OGDialogContent>
                  <OGDialogTitle>Rename file</OGDialogTitle>
                  <button type="button">inside rename</button>
                </OGDialogContent>
              </OGDialog>
            </OGDialogContent>
          </OGDialog>
        </Stage>
      );
    }
    const view = render(<Nested toast={false} />);
    await userEvent.click(screen.getByText('rename'));
    /** The toast arrives last, so its layer is above both dialogs. */
    view.rerender(<Nested toast />);

    screen.getByText('inside rename').focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByText('Rename file')).not.toBeInTheDocument();
    expect(screen.getByText('Files')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByText('Files')).not.toBeInTheDocument();
  });

  it('closes an uncontrolled dialog and hands focus back to its trigger', async () => {
    const onOpenChange = jest.fn();
    const page = (toast: boolean) => (
      <Stage toast={toast}>
        <OGDialog onOpenChange={onOpenChange}>
          <OGDialogTrigger>share</OGDialogTrigger>
          <OGDialogContent>
            <button type="button">inside</button>
          </OGDialogContent>
        </OGDialog>
      </Stage>
    );
    const view = render(page(false));
    await userEvent.click(screen.getByText('share'));
    view.rerender(page(true));

    screen.getByText('inside').focus();
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByText('inside')).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByText('share')).toHaveFocus();
  });

  it('hands focus back to the trigger a controlled dialog names', async () => {
    function Controlled({ toast }: { toast: boolean }) {
      const [open, setOpen] = React.useState(false);
      const triggerRef = React.useRef<HTMLButtonElement>(null);
      return (
        <Stage toast={toast}>
          <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
            export
          </button>
          <OGDialog open={open} onOpenChange={setOpen} triggerRef={triggerRef}>
            <OGDialogContent>
              <button type="button">inside</button>
            </OGDialogContent>
          </OGDialog>
        </Stage>
      );
    }
    const view = render(<Controlled toast={false} />);
    await userEvent.click(screen.getByText('export'));
    view.rerender(<Controlled toast />);

    screen.getByText('inside').focus();
    await userEvent.keyboard('{Escape}');

    expect(screen.queryByText('inside')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('export')).toHaveFocus());
  });

  it('leaves a dialog that is mounted while closed alone', async () => {
    const onOpenChange = jest.fn();
    const onEscapeKeyDown = jest.fn();
    render(
      <Stage>
        <OGDialog open={false} onOpenChange={onOpenChange}>
          <OGDialogContent forceMount onEscapeKeyDown={onEscapeKeyDown}>
            <button type="button">kept mounted</button>
          </OGDialogContent>
        </OGDialog>
      </Stage>,
    );
    expect(screen.getByText('kept mounted')).toBeInTheDocument();

    await userEvent.keyboard('{Escape}');

    expect(onEscapeKeyDown).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('closes a dialog while the toast is on its way out', async () => {
    const onOpenChange = jest.fn();
    render(
      <RadixToast.Provider>
        <OGDialog open onOpenChange={onOpenChange}>
          <OGDialogContent>
            <button type="button">inside</button>
          </OGDialogContent>
        </OGDialog>
        <RadixToast.Root open={false} forceMount duration={Infinity}>
          <RadixToast.Description>Saved</RadixToast.Description>
        </RadixToast.Root>
        <RadixToast.Viewport />
      </RadixToast.Provider>,
    );

    screen.getByText('inside').focus();
    await userEvent.keyboard('{Escape}');

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('leaves a dialog open while text is being composed', () => {
    const onOpenChange = jest.fn();
    render(
      <Stage>
        <OGDialog open onOpenChange={onOpenChange}>
          <OGDialogContent>
            <input aria-label="Name" />
          </OGDialogContent>
        </OGDialog>
      </Stage>,
    );
    const input = screen.getByLabelText('Name');
    input.focus();
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }),
    );

    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
