/**
 * @jest-environment jsdom
 */
import React from 'react';
import '@testing-library/jest-dom';
import { PortalProvider } from '@librechat/client';
import { render, screen, fireEvent } from '@testing-library/react';
import ImagePreview from '../composer/files/ImagePreview';
import QuoteButton from '../composer/QuoteButton';
import DialogImage from '../parts/DialogImage';

/**
 * What the package renders outside the document flow without one of the client library's
 * surfaces: two lightboxes on Radix's own portal and the quote button on React's. An app that
 * names an element with `PortalProvider` gets all of them inside it, as it gets the library's.
 */
describe('surfaces the package portals itself', () => {
  let scope: HTMLElement;

  beforeEach(() => {
    scope = document.createElement('div');
    document.body.appendChild(scope);
  });
  afterEach(() => scope.remove());

  const named = ({ children }: { children: React.ReactNode }) => (
    <PortalProvider container={scope}>{children}</PortalProvider>
  );

  it('opens the attachment preview on the body where no element is named', () => {
    render(<ImagePreview url="/img.png" />);
    fireEvent.click(screen.getByRole('button', { name: 'View Preview image in full size' }));
    expect(scope).not.toContainElement(screen.getByRole('dialog'));
  });

  it('opens the attachment preview inside the named element', () => {
    render(<ImagePreview url="/img.png" />, { wrapper: named });
    fireEvent.click(screen.getByRole('button', { name: 'View Preview image in full size' }));
    expect(scope).toContainElement(screen.getByRole('dialog'));
  });

  it('opens a message image inside the named element', () => {
    render(
      <DialogImage isOpen onOpenChange={jest.fn()} src="/media.png" downloadImage={jest.fn()} />,
      { wrapper: named },
    );
    expect(scope).toContainElement(screen.getByRole('dialog'));
  });

  it('keeps the quote button inside the named element', () => {
    render(<QuoteButton conversationId="convo-1" />, { wrapper: named });
    expect(scope.querySelector('button')).not.toBeNull();
  });
});
