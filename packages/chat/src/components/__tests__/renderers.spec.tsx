/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import type { TFile } from 'librechat-data-provider';
import type { MessagePartsHost } from '../../react/host';
import { createMessagePartsHost } from '../../__fixtures__/partsHost';
import { MessagePartsHostProvider } from '../../react/host';
import { initEnglish } from '../../__fixtures__/i18n';
import MessageFiles from '../messages/Files';
import TextPart from '../Text';

beforeAll(initEnglish);

const image: TFile = {
  user: 'owner',
  bytes: 1024,
  embedded: false,
  object: 'file',
  usage: 0,
  file_id: 'image',
  filename: 'screenshot.png',
  type: 'image/png',
  filepath: '/images/screenshot.png',
  width: 1024,
  height: 768,
};

/** A host that names no markdown or image renderer of its own. */
const bare = (overrides: Partial<MessagePartsHost> = {}) =>
  createMessagePartsHost({ renderMarkdown: undefined, renderImage: undefined, ...overrides });

const under = (host: MessagePartsHost, children: React.ReactNode) => (
  <MessagePartsHostProvider host={host}>{children}</MessagePartsHostProvider>
);

describe('a part’s markdown', () => {
  it('is drawn by the package’s reply renderer when the host names none', () => {
    render(
      under(bare(), <TextPart text="Some **bold** text." isCreatedByUser={false} showCursor />),
    );
    expect(screen.getByText('bold').tagName).toBe('STRONG');
  });

  it('is drawn by the package’s lite renderer for a user’s text shown as markdown', () => {
    const host = bare({
      useUserTextPreferences: () => ({
        enableUserMsgMarkdown: true,
        collapseLongUserMessages: false,
        usernameDisplay: false,
      }),
    });
    render(under(host, <TextPart text="A *note* of mine." isCreatedByUser={true} showCursor />));
    expect(screen.getByText('note').tagName).toBe('EM');
  });

  it('is the host’s to draw when it names a renderer', () => {
    const renderMarkdown = jest.fn(() => <span data-testid="own" />);
    render(
      under(
        bare({ renderMarkdown }),
        <TextPart text="Some **bold** text." isCreatedByUser={false} showCursor />,
      ),
    );
    expect(screen.getByTestId('own')).toBeInTheDocument();
    expect(renderMarkdown).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Some **bold** text.', variant: 'full' }),
    );
  });
});

describe('a message’s attached image', () => {
  it('is drawn by the package’s image card when the host names none', () => {
    render(under(bare(), <MessageFiles files={[image]} />));
    const button = screen.getByRole('button', { name: 'View screenshot.png in dialog' });
    expect(button).toHaveClass('chat-image-sized');
    expect(screen.getByRole('img', { name: 'screenshot.png' })).toHaveAttribute(
      'src',
      '/images/screenshot.png',
    );
  });

  it('is the host’s to draw when it names a renderer', () => {
    const renderImage = jest.fn(() => <span data-testid="own" />);
    render(under(bare({ renderImage }), <MessageFiles files={[image]} />));
    expect(screen.getByTestId('own')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /in dialog/ })).not.toBeInTheDocument();
  });
});
