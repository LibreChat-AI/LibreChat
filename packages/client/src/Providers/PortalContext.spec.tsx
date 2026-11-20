import React from 'react';
import * as Ariakit from '@ariakit/react';
import { cleanup, render, screen } from '@testing-library/react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '~/components/AlertDialog';
import {
  HoverCard,
  HoverCardContent,
  HoverCardPortal,
  HoverCardTrigger,
} from '~/components/HoverCard';
import { Popover, PopoverContent, PopoverPortal, PopoverTrigger } from '~/components/Popover';
import { OGDialog, OGDialogContent, OGDialogTitle } from '~/components/OriginalDialog';
import { PortalProvider } from './PortalContext';

/** One of each kind of surface that leaves the document flow, all open. */
function Surfaces({ popover }: { popover?: HTMLElement }) {
  return (
    <>
      <Popover open>
        <PopoverTrigger>Anchor</PopoverTrigger>
        <PopoverPortal container={popover}>
          <PopoverContent>Popover</PopoverContent>
        </PopoverPortal>
      </Popover>
      <HoverCard open>
        <HoverCardTrigger asChild>
          <button type="button">Trigger</button>
        </HoverCardTrigger>
        <HoverCardPortal>
          <HoverCardContent>Hover card</HoverCardContent>
        </HoverCardPortal>
      </HoverCard>
      <OGDialog open>
        <OGDialogContent>
          <OGDialogTitle>Dialog</OGDialogTitle>
        </OGDialogContent>
      </OGDialog>
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Alert</AlertDialogTitle>
          <AlertDialogDescription>Confirm</AlertDialogDescription>
        </AlertDialogContent>
      </AlertDialog>
      <Ariakit.MenuProvider open>
        <Ariakit.Menu portal>
          <Ariakit.MenuItem>Menu item</Ariakit.MenuItem>
        </Ariakit.Menu>
      </Ariakit.MenuProvider>
    </>
  );
}

const SURFACES = ['Popover', 'Hover card', 'Dialog', 'Alert', 'Menu item'];

const made: HTMLElement[] = [];

function element(className: string): HTMLElement {
  const node = document.createElement('div');
  node.className = className;
  document.body.appendChild(node);
  made.push(node);
  return node;
}

describe('PortalProvider', () => {
  afterEach(() => {
    cleanup();
    made.splice(0).forEach((node) => node.remove());
  });

  it('leaves every surface on the body where no provider names an element', async () => {
    const { container } = render(<Surfaces />);
    for (const name of SURFACES) {
      const surface = await screen.findByText(name);
      expect(container).not.toContainElement(surface);
      expect(surface.closest('.scope')).toBeNull();
    }
  });

  it('renders every surface into the element it is given', async () => {
    const scope = element('scope');
    render(
      <PortalProvider container={scope}>
        <Surfaces />
      </PortalProvider>,
    );
    for (const name of SURFACES) {
      expect(scope).toContainElement(await screen.findByText(name));
    }
  });

  it('keeps an element of its own at the end of the body where it is given none', async () => {
    const { container } = render(
      <PortalProvider className="scope">
        <Surfaces />
      </PortalProvider>,
    );
    const scope = document.body.querySelector<HTMLElement>(':scope > .scope');
    expect(scope).not.toBeNull();
    expect(container).not.toContainElement(scope);
    for (const name of SURFACES) {
      expect(scope).toContainElement(await screen.findByText(name));
    }
  });

  it('lets a surface that names its own element keep it', async () => {
    const scope = element('scope');
    const other = element('other');
    render(
      <PortalProvider container={scope}>
        <Surfaces popover={other} />
      </PortalProvider>,
    );
    expect(other).toContainElement(await screen.findByText('Popover'));
    expect(scope).toContainElement(await screen.findByText('Dialog'));
  });

  it('takes its element away with it', () => {
    const { unmount } = render(
      <PortalProvider className="scope">
        <span>Chat</span>
      </PortalProvider>,
    );
    expect(document.body.querySelector('.scope')).not.toBeNull();
    unmount();
    expect(document.body.querySelector('.scope')).toBeNull();
  });
});
