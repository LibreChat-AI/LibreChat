import React from 'react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { MessagePartsHostProvider, appMessagePartsHost } from '~/Providers/MessagePartsHostContext';
import Markdown from '~/components/Chat/Messages/Content/Markdown';
import { MessageContext } from '~/Providers';
import { visualFileName } from '../Visual';

jest.mock('../Frame', () => {
  const { useEffect } = jest.requireActual('react');
  return {
    __esModule: true,
    VISUAL_MAX_HEIGHT: 2000,
    default: function MockVisualFrame({
      html,
      title,
      maxHeight,
      onContentHeight,
    }: {
      html: string;
      title: string;
      maxHeight: number;
      onContentHeight?: (height: number) => void;
    }) {
      useEffect(
        () => onContentHeight?.(html.includes('TALL') ? 1200 : 300),
        [html, onContentHeight],
      );
      return (
        <div data-testid="visual-frame" data-title={title} data-max-height={maxHeight}>
          {html}
        </div>
      );
    },
  };
});

const PAGE = '<!doctype html><html><body><p>chart</p></body></html>';
const visual = (closed = true) =>
  `Here it is.\n\n:::visual{title="Revenue by region"}\n\`\`\`html\n${PAGE}\n\`\`\`\n${closed ? ':::\n\nAfter.' : ''}`;

const view = (
  content: string,
  {
    submitting = false,
    path = '/c/convo-1',
    allowed = true,
  }: { submitting?: boolean; path?: string; allowed?: boolean | null } = {},
) => (
  <MemoryRouter initialEntries={[path]}>
    <RecoilRoot>
      <MessagePartsHostProvider
        host={{ ...appMessagePartsHost, useVisualsAllowed: () => allowed ?? undefined }}
      >
        <MessageContext.Provider
          value={{
            messageId: 'm1',
            isExpanded: true,
            isSubmitting: submitting,
            isLatestMessage: true,
          }}
        >
          <Markdown content={content} isLatestMessage={true} />
        </MessageContext.Provider>
      </MessagePartsHostProvider>
    </RecoilRoot>
  </MemoryRouter>
);

describe('Visual', () => {
  it('renders the page inline under its title, without a code block', () => {
    const { container } = render(view(visual()));
    const frame = screen.getByTestId('visual-frame');
    expect(frame).toHaveTextContent('<p>chart</p>');
    expect(frame).toHaveAttribute('data-title', 'Revenue by region');
    expect(screen.getByText('Revenue by region').tagName).toBe('FIGCAPTION');
    expect(container.querySelector('pre')).toBeNull();
    expect(screen.getByText('After.')).toBeInTheDocument();
  });

  it('holds a placeholder while the container is still streaming', () => {
    render(view(visual(false), { submitting: true }));
    expect(screen.queryByTestId('visual-frame')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Building visual…');
  });

  it('renders the page as soon as the closing fence streams in', () => {
    render(view(`${visual()} and more`, { submitting: true }));
    expect(screen.getByTestId('visual-frame')).toBeInTheDocument();
  });

  it('renders what arrived when a reply ends without closing the container', () => {
    render(view(visual(false), { submitting: false }));
    expect(screen.getByTestId('visual-frame')).toHaveTextContent('<p>chart</p>');
  });

  it('keeps the prose that follows a container the model never closed', () => {
    render(view(`${visual(false)}\n\nThe rest of the answer.`, { submitting: false }));
    expect(screen.getByTestId('visual-frame')).toBeInTheDocument();
    expect(screen.getByText('The rest of the answer.')).toBeInTheDocument();
  });

  it('opens the visual in the artifacts panel and closes it again', () => {
    render(view(visual()));
    fireEvent.click(screen.getByRole('button', { name: 'Open in panel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(screen.getByRole('button', { name: 'Open in panel' })).toBeInTheDocument();
  });

  it('caps a tall visual inline and lets the reader expand it', () => {
    render(view(visual().replace('chart', 'TALL chart')));
    const frame = screen.getByTestId('visual-frame');
    expect(frame).toHaveAttribute('data-max-height', '640');
    expect(screen.getByTestId('visual-fade')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(frame).toHaveAttribute('data-max-height', '2000');
    expect(screen.queryByTestId('visual-fade')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('offers no expand control for a visual that fits', () => {
    render(view(visual()));
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('holds the placeholder until the deployment says whether visuals are allowed', () => {
    render(view(visual(), { allowed: null }));
    expect(screen.queryByTestId('visual-frame')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Building visual…');
  });

  it('shows a notice instead of the page when the deployment turned visuals off', () => {
    render(view(visual(), { allowed: false }));
    expect(screen.queryByTestId('visual-frame')).toBeNull();
    expect(screen.getByText('Visuals are turned off for this app.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open in panel' })).toBeNull();
    expect(screen.getByText('After.')).toBeInTheDocument();
  });

  it('offers no panel outside a conversation route', () => {
    render(view(visual(), { path: '/search' }));
    expect(screen.queryByRole('button', { name: 'Open in panel' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });
});

describe('visualFileName', () => {
  it('sanitizes a title the way artifact downloads are', () => {
    expect(visualFileName('Revenue: Q1/Q2 <draft>')).toBe('Revenue_ Q1_Q2 _draft_.html');
    expect(visualFileName('   ')).toBe('visual.html');
  });
});
